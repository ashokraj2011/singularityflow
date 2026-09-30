import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { recordSha256 } from '../src/records.mjs';
import {
  assessAcceptedTestFailure, assessPreStoryRiskForStoryStart, assessPreStoryTestBaseline,
  createPreStoryTestRiskAcceptance,
  listPreStoryTestRiskAcceptances, storePreStoryTestRiskAcceptance
} from '../src/test-baseline-risk.mjs';

const hash = (value) => `sha256:${recordSha256(value)}`;
const argv = ['mvn', 'test'];
const argvSha256 = `sha256:${createHash('sha256').update(JSON.stringify(argv)).digest('hex')}`;
const failedCase = (name = 'existingFailure') => ({
  suite: 'RuleServiceTest', className: 'example.RuleServiceTest', name,
  fullName: null, ancestorTitles: [], identityStatus: 'observed-name-only'
});

function baseline(overrides = {}) {
  const core = {
    schemaVersion: 1, kind: 'repository-test-baseline', scope: 'dependency-test',
    sourceTrackedOnly: true,
    status: 'failing-tests', sourceCommit: 'a'.repeat(40),
    sourceManifestSha256: `sha256:${'b'.repeat(64)}`,
    repositoryFingerprint: 'repo', platform: process.platform, arch: process.arch,
    planId: `sha256:${'c'.repeat(64)}`, workingTree: {},
    testTools: [{ id: 'maven-tests', argvSha256, workingDirectory: '.', affectedRoots: ['.'],
      launcher: 'mvn', adapter: 'junit-xml', reportPath: 'target/surefire-reports', minimumDiscovered: 1 }],
    commandResults: [
      { id: 'maven-install', purpose: 'dependency', status: 'pass' },
      { id: 'maven-tests', purpose: 'test', status: 'failed', reason: 'non-zero-exit', exitCode: 1 }
    ],
    testObservations: [{ commandId: 'maven-tests', adapter: 'junit-xml', status: 'available',
      counts: { discovered: 10, passed: 9, failed: 1, skipped: 0 },
      failingCases: [failedCase()], failingCasesTruncated: false }],
    failedCommandId: 'maven-tests', recordedAt: '2026-10-01T00:00:00.000Z',
    ...overrides
  };
  return { ...core, baselineSha256: hash(core) };
}

const acceptedAt = '2026-10-01T00:00:00.000Z';
const expiresAt = '2026-10-10T00:00:00.000Z';
function accept(record) {
  return createPreStoryTestRiskAcceptance(record, {
    actor: 'reviewer@example.invalid', reason: 'Known failing test predates the Story and is tracked.',
    confirmBaselineSha256: record.baselineSha256, acceptedAt, expiresAt
  });
}

function current(overrides = {}) {
  return {
    command: { id: 'maven-tests', argv, workingDirectory: '.', affectedRoots: ['.'],
      result: { adapter: 'junit-xml' } },
    check: { status: 'failed', exitCode: 1 },
    parsed: {
      adapter: 'junit-xml', tests: { discovered: 10, passed: 9, failed: 1, skipped: 0 },
      testcaseObservation: { occurrences: [
        { ...failedCase(), outcome: 'failed' },
        ...Array.from({ length: 9 }, (_, index) => ({ ...failedCase(`passing${index}`), outcome: 'passed' }))
      ] }
    },
    now: '2026-10-02T00:00:00.000Z',
    ...overrides
  };
}

test('eligible baseline requires complete structured evidence and an explicit human decision', () => {
  const record = baseline();
  assert.equal(assessPreStoryTestBaseline(record).eligible, true);
  assert.throws(() => createPreStoryTestRiskAcceptance(record, {
    actor: 'reviewer', reason: 'I know this fails before the Story.',
    confirmBaselineSha256: `sha256:${'0'.repeat(64)}`, acceptedAt, expiresAt
  }), { code: 'PRE_STORY_TEST_RISK_INELIGIBLE' });
  assert.equal(accept(record).status, 'accepted-known-failures');
  assert.equal(assessAcceptedTestFailure(accept(record), record, current()).accepted, true);
});

test('Story-start exception is exact-base, host-bound, and expires without changing test verdict', () => {
  const record = baseline();
  const decision = accept(record);
  assert.equal(assessPreStoryRiskForStoryStart(decision, record, {
    baseCommit: record.sourceCommit, now: '2026-10-02T00:00:00.000Z'
  }).accepted, true);
  assert.equal(assessPreStoryRiskForStoryStart(decision, record, {
    baseCommit: 'f'.repeat(40), now: '2026-10-02T00:00:00.000Z'
  }).accepted, false);
  assert.equal(assessPreStoryRiskForStoryStart(decision, record, {
    baseCommit: record.sourceCommit, now: '2026-10-11T00:00:00.000Z'
  }).accepted, false);
  assert.equal(assessPreStoryRiskForStoryStart({ ...decision, actor: 'someone else' }, record, {
    baseCommit: record.sourceCommit, now: '2026-10-02T00:00:00.000Z'
  }).accepted, false);
  assert.equal(record.status, 'failing-tests', 'risk acknowledgement never changes the test result');
});

test('Node TAP named failures can be acknowledged only when the complete set is observed', () => {
  const record = baseline({
    testTools: [{ ...baseline().testTools[0], adapter: 'node-tap' }],
    testObservations: [{ ...baseline().testObservations[0], adapter: 'node-tap',
      failingCases: [{ ...failedCase('known failing baseline'), className: null }] }]
  });
  assert.equal(assessPreStoryTestBaseline(record).eligible, true);
  assert.equal(accept(record).status, 'accepted-known-failures');
  const truncated = baseline({
    testTools: record.testTools,
    testObservations: [{ ...record.testObservations[0], failingCasesTruncated: true }]
  });
  assert.equal(assessPreStoryTestBaseline(truncated).eligible, false);
});

test('a failing test run below its required discovery count cannot be accepted', () => {
  const record = baseline({
    testTools: [{ ...baseline().testTools[0], minimumDiscovered: 11 }]
  });
  const assessment = assessPreStoryTestBaseline(record);
  assert.equal(assessment.eligible, false);
  assert.ok(assessment.reasons.includes('test-observation-incomplete:maven-tests'));
  assert.throws(() => accept(record), { code: 'PRE_STORY_TEST_RISK_INELIGIBLE' });
});

test('new failure, increased skips, missing identity, changed command, and expiry block', () => {
  const record = baseline();
  const decision = accept(record);
  const newFailure = current();
  newFailure.parsed.tests = { discovered: 10, passed: 8, failed: 2, skipped: 0 };
  newFailure.parsed.testcaseObservation.occurrences[1] = { ...failedCase('newFailure'), outcome: 'failed' };
  assert.equal(assessAcceptedTestFailure(decision, record, newFailure).accepted, false);
  const skipped = current();
  skipped.parsed.tests = { discovered: 10, passed: 8, failed: 1, skipped: 1 };
  skipped.parsed.testcaseObservation.occurrences[1].outcome = 'skipped';
  assert.equal(assessAcceptedTestFailure(decision, record, skipped).accepted, false);
  const missing = current();
  missing.parsed.testcaseObservation.occurrences[0].identityStatus = 'ambiguous-display-identity';
  assert.equal(assessAcceptedTestFailure(decision, record, missing).accepted, false);
  assert.equal(assessAcceptedTestFailure(decision, record, current({
    command: { id: 'maven-tests', argv: ['mvn', 'test', '-DskipTests'],
      workingDirectory: '.', affectedRoots: ['.'], result: { adapter: 'junit-xml' } }
  })).accepted, false);
  assert.equal(assessAcceptedTestFailure(decision, record, current({
    now: '2026-10-11T00:00:00.000Z'
  })).accepted, false);
});

test('partial baseline, unsupported adapter, infrastructure failure, and tampering block', () => {
  const record = baseline();
  const partial = baseline({
    testTools: [...record.testTools, { ...record.testTools[0], id: 'second' }]
  });
  assert.equal(assessPreStoryTestBaseline(partial).eligible, false);
  const playwright = baseline({
    testTools: [{ ...record.testTools[0], adapter: 'playwright-json' }],
    testObservations: [{ ...record.testObservations[0], adapter: 'playwright-json' }]
  });
  assert.equal(assessPreStoryTestBaseline(playwright).eligible, false);
  const timedOut = baseline({
    commandResults: [record.commandResults[0], { ...record.commandResults[1], reason: 'timeout' }]
  });
  assert.equal(assessPreStoryTestBaseline(timedOut).eligible, false);
  const decision = accept(record);
  assert.equal(assessAcceptedTestFailure({ ...decision, reason: 'tampered' }, record, current()).accepted, false);
});

test('Git-private risk decisions are append-only, discoverable, and integrity checked', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-test-risk-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    const record = baseline();
    const decision = accept(record);
    const saved = await storePreStoryTestRiskAcceptance(root, decision, record);
    assert.equal(saved.created, true);
    assert.equal(saved.file.startsWith(path.join(root, '.git')), true);
    assert.equal((await storePreStoryTestRiskAcceptance(root, decision, record)).created, false);
    const listed = await listPreStoryTestRiskAcceptances(root, record);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].acceptance.acceptanceSha256, decision.acceptanceSha256);
    const altered = { ...decision, reason: 'tampered local record' };
    await writeFile(saved.file, `${JSON.stringify(altered)}\n`);
    await assert.rejects(() => listPreStoryTestRiskAcceptances(root, record), {
      code: 'PRE_STORY_TEST_RISK_DECISION_INVALID'
    });
    assert.match(await readFile(saved.file, 'utf8'), /tampered local record/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
