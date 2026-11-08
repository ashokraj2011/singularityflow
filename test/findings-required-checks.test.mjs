/**
 * A capability's GitHub required checks as evidence in a step's review [CQF:REQ-055]: each check
 * run's result on the submitted commit, read through gh, shown in the review data every approval
 * surface reads and in the CLI's review and approval text. It never blocks. gh's answers here are
 * recorded in the shape GitHub's check-runs API documents; nothing is asked of a live server.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { requiredCheckEvidence, requiredCheckWords, storyRequiredChecks } from '../src/findings/required-checks.mjs';
import { printPhaseReview } from '../src/commands/shared/print-phase-review.mjs';

const COMMIT = '3f6c9a1e2b4d5c6e7f8091a2b3c4d5e6f7a8b9c0';
const RUNS = JSON.stringify({ total_count: 3, check_runs: [
  { id: 11, name: 'CodeQL', status: 'completed', conclusion: 'success', html_url: 'https://ghe.example.test/example-org/payments-api/runs/11', app: { name: 'GitHub Code Scanning' }, head_sha: COMMIT },
  { id: 12, name: 'SonarCloud Code Analysis', status: 'completed', conclusion: 'failure', html_url: 'https://ghe.example.test/example-org/payments-api/runs/12', app: { name: 'SonarCloud' }, head_sha: COMMIT },
  { id: 13, name: 'build', status: 'in_progress', conclusion: null, html_url: 'https://ghe.example.test/example-org/payments-api/runs/13', app: { name: 'GitHub Actions' }, head_sha: COMMIT }] });

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-required-checks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root }).status, 0);
  return root;
}

/** gh and git as the evidence read asks them, answering from `runs`. */
function answers(runs, remote = 'https://ghe.example.test/example-org/payments-api.git') {
  const calls = [];
  return { calls, runCommand: (command, args) => {
    calls.push([command, ...args]);
    if (command === 'git') return { status: 0, stdout: `${remote}\n` };
    if (args[0] === 'auth') return { status: 0, stdout: '' };
    if (args.at(-1).includes('/check-runs')) return { status: 0, stdout: runs };
    return { status: 1, stderr: 'HTTP 404: Not Found' };
  } };
}

const story = (requiredChecks) => ({ workItem: { id: 'PAY-12' }, lineage: { requiredChecks } });

test("each required check's result on the submitted commit is read through gh, as evidence [CQF:REQ-055]", async (t) => {
  const root = await repository(t);
  const gh = answers(RUNS);
  const workflow = story(['CodeQL', 'SonarCloud Code Analysis', 'build', 'lint']);
  const evidence = await requiredCheckEvidence(root, {}, workflow, { commit: COMMIT, runCommand: gh.runCommand });
  assert.deepEqual(gh.calls.find((call) => call[0] === 'gh' && call[1] === 'api').slice(0, 5),
    ['gh', 'api', '--hostname', 'ghe.example.test', `repos/example-org/payments-api/commits/${COMMIT}/check-runs?per_page=100`]);
  assert.deepEqual([evidence.status, evidence.commit, evidence.repository], ['read', COMMIT, 'example-org/payments-api']);
  assert.deepEqual(evidence.checks.map((check) => [check.name, check.status, check.app]), [
    ['CodeQL', 'passed', 'GitHub Code Scanning'], ['SonarCloud Code Analysis', 'failed', 'SonarCloud'], ['build', 'pending', 'GitHub Actions'], ['lint', 'missing', null]]);
  assert.equal(requiredCheckWords(evidence),
    'Required checks on 3f6c9a1e2b4d: CodeQL passed · SonarCloud Code Analysis failed · build pending · lint missing. They are evidence for the reviewer; approval does not wait on them.');
  // Read again within the minute: kept, so a review shown again asks GitHub once.
  const before = gh.calls.length;
  assert.deepEqual(await requiredCheckEvidence(root, {}, workflow, { commit: COMMIT, runCommand: gh.runCommand }), evidence);
  assert.equal(gh.calls.length, before);
  // A minute later a pending check is read again; once every check has completed, the read is kept.
  const later = new Date(Date.now() + 2 * 60_000).toISOString();
  await requiredCheckEvidence(root, {}, workflow, { commit: COMMIT, runCommand: gh.runCommand, at: later });
  assert.ok(gh.calls.length > before, 'a pending check is asked again');
  const settled = story(['CodeQL', 'SonarCloud Code Analysis']);
  await requiredCheckEvidence(root, {}, settled, { commit: COMMIT, runCommand: gh.runCommand });
  const asked = gh.calls.length;
  await requiredCheckEvidence(root, {}, settled, { commit: COMMIT, runCommand: gh.runCommand, at: new Date(Date.now() + 3_600_000).toISOString() });
  assert.equal(gh.calls.length, asked, 'completed runs do not change');
  await requiredCheckEvidence(root, {}, settled, { commit: COMMIT, runCommand: gh.runCommand, refresh: true });
  assert.ok(gh.calls.length > asked, 'refresh asks anyway');
});

test('a required check that cannot be read is said, and blocks nothing; no required checks, nothing to say', async (t) => {
  const root = await repository(t);
  assert.deepEqual(storyRequiredChecks(story(['CodeQL', 'CodeQL', ''])), ['CodeQL']);
  assert.deepEqual(await requiredCheckEvidence(root, {}, story([]), { commit: COMMIT }), { status: 'not-required', commit: COMMIT, checks: [] });
  assert.equal(requiredCheckWords({ status: 'not-required' }), null);
  const other = await requiredCheckEvidence(root, {}, story(['CodeQL']), { commit: COMMIT, runCommand: answers(RUNS, 'https://gitlab.example.test/example-org/payments-api.git').runCommand });
  assert.equal(other.status, 'unavailable');
  const signedOut = await requiredCheckEvidence(root, {}, story(['SonarCloud Code Analysis']), { commit: COMMIT,
    runCommand: (command) => (command === 'git' ? { status: 0, stdout: 'https://ghe.example.test/example-org/payments-api.git\n' } : { status: 1, stderr: 'not logged in' }) });
  assert.deepEqual([signedOut.status, signedOut.checks], ['unavailable', [{ name: 'SonarCloud Code Analysis', status: 'unread' }]]);
  assert.match(signedOut.reason, /not authenticated/u);
  assert.match(requiredCheckWords(signedOut), /^Required checks on 3f6c9a1e2b4d could not be read \(.+\); they are evidence only and block nothing\.$/u);
  assert.equal((await requiredCheckEvidence(root, {}, story(['CodeQL']), { commit: null })).status, 'unavailable', 'nothing submitted, nothing to read');
});

test("the CLI's review and approval text shows the findings and the required checks beside the test evidence", (t) => {
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(String(line)));
  t.mock.method(console, 'warn', (line) => lines.push(String(line)));
  printPhaseReview({ workId: 'PAY-12', phase: 'implementation', generation: 1, documents: [],
    qualityFindings: { words: '1 known vulnerability in packages this Story added or upgraded holds the step\'s approval until upgraded or accepted by a person (minimist@1.2.5 GHSA-xvch-5gv4-984h).' },
    requiredChecks: { words: 'Required checks on 3f6c9a1e2b4d: CodeQL passed · SonarCloud Code Analysis failed. They are evidence for the reviewer; approval does not wait on them.' } });
  assert.ok(lines.includes('Findings: 1 known vulnerability in packages this Story added or upgraded holds the step\'s approval until upgraded or accepted by a person (minimist@1.2.5 GHSA-xvch-5gv4-984h).'), lines.join('\n'));
  assert.ok(lines.includes('Required checks on 3f6c9a1e2b4d: CodeQL passed · SonarCloud Code Analysis failed. They are evidence for the reviewer; approval does not wait on them.'));
});
