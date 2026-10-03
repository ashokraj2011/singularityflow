import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { replayTestReports, testReceiptPassing } from '../src/code-delivery-tests.mjs';
import { readRecord } from '../src/schema-migrations.mjs';
import { admitTestAttempts, attemptSha256, recordTestAttempt } from '../src/verification/attempts.mjs';

const ITEM = 'singularity/work-items/PAY-1';
const command = {
  id: 'web-node-tests', kind: 'test', argv: ['npm', 'test', '--', '--json', '--outputFile', '.sflow/results/node-tests.json'],
  workingDirectory: '.', affectedRoots: ['.'], modelPolicy: 'never',
  result: { adapter: 'jest-json', path: '.sflow/results/node-tests.json', minimumDiscovered: 1, minimumPassed: 1 }
};

function jestReport(assertions) {
  const count = (status) => assertions.filter((entry) => entry.status === status).length;
  return {
    numTotalTests: assertions.length, numPassedTests: count('passed'), numFailedTests: count('failed'),
    numPendingTests: count('pending'),
    testResults: [{ name: '/repo/test/pay.test.js', assertionResults: assertions.map((entry) => ({
      ancestorTitles: entry.ancestors ?? [], title: entry.title, fullName: [...(entry.ancestors ?? []), entry.title].join(' '),
      status: entry.status, duration: 1, ...(entry.invocations ? { invocations: entry.invocations } : {})
    })) }]
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-verification-attempts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.sflow', 'results'), { recursive: true });
  await mkdir(path.join(root, ITEM), { recursive: true });
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
  return root;
}

function check(status, exitCode, startedAt) {
  return {
    id: command.id, status, exitCode, signal: null, startedAt, completedAt: new Date().toISOString(),
    sourceCommit: 'a'.repeat(40), sourceTreeSha256: 'b'.repeat(64), resultIsolated: true, stderr: ''
  };
}

test('every run is one immutable attempt with lineage, occurrences and content-addressed reports', async (t) => {
  const root = await fixture(t);
  const startedAt = new Date(Date.now() - 1000).toISOString();
  await writeFile(path.join(root, '.sflow/results/node-tests.json'), JSON.stringify(jestReport([
    { title: 'pays the balance', status: 'passed' }, { title: 'the real AC test', status: 'pending' }
  ])));
  const options = { command, purpose: 'preflight', workId: 'PAY-1', phaseId: 'implementation', generation: 1 };
  const first = await recordTestAttempt(root, ITEM, { ...options, check: check('passed', 0, startedAt) });
  assert.match(first.attempt.attemptId, /^TA-[a-f0-9]{20}$/);
  assert.equal(first.attempt.schemaVersion, 5);
  assert.equal(first.attempt.parentAttemptId, null);
  assert.equal(first.attempt.purpose, 'preflight');
  assert.equal(first.attempt.status, 'passed');
  assert.equal(first.attempt.candidate.treeSha256, 'b'.repeat(64));
  assert.equal(first.attempt.profile, 'jest-static-v2');
  assert.deepEqual(first.attempt.occurrences.map((entry) => [entry.suitePath, entry.name, entry.outcome]), [
    [[], 'pays the balance', 'passed'], [[], 'the real AC test', 'skipped']
  ]);
  assert.equal(first.path, `${ITEM}/context/code-delivery/tests/attempts/implementation/${first.attempt.attemptId}.json`);
  assert.equal(first.sha256, attemptSha256(first.attempt));
  const [report] = first.attempt.rawReports;
  assert.match(report.path, /\/context\/code-delivery\/tests\/raw\/[a-f0-9]{64}\.bin$/);
  // A kept attempt changes none of the Story's files until a successful step admits it.
  await assert.rejects(access(path.join(root, first.path)), { code: 'ENOENT' });

  // A later failing run is its own attempt, names its parent, and keeps its occurrences.
  await writeFile(path.join(root, '.sflow/results/node-tests.json'), JSON.stringify(jestReport([
    { title: 'pays the balance', status: 'failed' }
  ])));
  const second = await recordTestAttempt(root, ITEM, { ...options, purpose: 'submission', check: check('failed', 1, startedAt) });
  assert.notEqual(second.attempt.attemptId, first.attempt.attemptId);
  assert.equal(second.attempt.parentAttemptId, first.attempt.attemptId);
  assert.equal(second.attempt.status, 'failed');
  assert.equal(testReceiptPassing(second.attempt), false);
  assert.equal(second.attempt.occurrences[0].outcome, 'failed');
  // Admission commits every kept attempt of the step, the failed one included, with its reports.
  const admitted = await admitTestAttempts(root, ITEM, 'PAY-1', 'implementation');
  assert.deepEqual(admitted.map((entry) => [entry.attemptId, entry.status]).sort(), [
    [first.attempt.attemptId, 'passed'], [second.attempt.attemptId, 'failed']
  ].sort());
  assert.deepEqual(readRecord('test-execution', await readFile(path.join(root, first.path))).record, first.attempt);
  assert.deepEqual(readRecord('test-execution', await readFile(path.join(root, second.path))).record, second.attempt);
  await access(path.join(root, report.path));
  // Admitting again changes nothing: a record is never rewritten.
  await admitTestAttempts(root, ITEM, 'PAY-1', 'implementation');

  // A passing process that left no usable report is recorded as unavailable, with the reason.
  await rm(path.join(root, '.sflow/results/node-tests.json'));
  const third = await recordTestAttempt(root, ITEM, { ...options, purpose: 'submission', check: check('passed', 0, startedAt) });
  assert.equal(third.attempt.status, 'unavailable');
  assert.match(third.attempt.reportError, /does not exist/);
  assert.equal(third.attempt.parentAttemptId, second.attempt.attemptId);
});

test('a retained report replays to exactly the counts and occurrences its attempt recorded', async (t) => {
  const root = await fixture(t);
  const startedAt = new Date(Date.now() - 1000).toISOString();
  const bytes = Buffer.from(JSON.stringify(jestReport([
    { title: 'pays the balance', status: 'passed', invocations: 2 }, { title: 'refunds', status: 'passed' }
  ])));
  await writeFile(path.join(root, '.sflow/results/node-tests.json'), bytes);
  const recorded = await recordTestAttempt(root, ITEM, {
    command, check: check('passed', 0, startedAt), purpose: 'submission', workId: 'PAY-1', phaseId: 'implementation', generation: 1
  });
  assert.equal(recorded.attempt.occurrences[0].flaky, true);
  const replay = replayTestReports('jest-json', [{ contents: bytes }]);
  assert.deepEqual(replay.tests, recorded.attempt.tests);
  assert.equal(replay.result.sha256, recorded.attempt.result.sha256);
  assert.throws(() => replayTestReports('jest-json', []), /non-empty raw report set/);
});
