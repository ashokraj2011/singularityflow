/**
 * A run reused on the same source tree keeps its evidence, through a whole Story on the real CLI [bin-opr2].
 *
 * A real Story's Release marked every clause partial because Verification reused Implementation's runs,
 * as the owner's rule asks ("dont rerun if the code has not changed"), and what Release could read said
 * "no structured counts". So the last step raised a decision, against a step nothing was wrong with.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { completeAgentResult } from '../src/agent-output.mjs';
import { reusedExecutionDetails } from '../src/phase-execution-evidence.mjs';
import { canonicalJson } from '../src/records.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import { conformanceGapDecisions, conformanceGapLine, conformanceGapRefusal } from '../src/upstream-routes.mjs';
import { storyAtVerification, writeVerificationEvidence } from './helpers/story-to-verification.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const W = 'END-1';
const CLI = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const json = (result) => completeAgentResult(JSON.parse(result.stdout.slice(result.stdout.indexOf('{'))));

test('a reused run carries its attempt, counts and tree from Verification to the approved end, with no decision raised', slowLane({ timeout: 480_000 }), async (t) => {
  const story = await storyAtVerification(t, W);
  const { cli, item } = story;
  await writeVerificationEvidence(story);
  cli('phase', 'publish', 'verification', '--authored', 'human', '--channel', 'manual-in-place');
  const submitted = cli('submit', 'verification');
  assert.match(submitted.stderr, /Not run again: node-tests passed on this exact code \(TA-[a-f0-9]{20}, recorded by implementation\)/u);

  const workflow = async () => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  const check = (await workflow()).phases.verification.checks.find((entry) => entry.reusedFrom);
  const attempt = check.reusedFrom.attemptId;
  // The packet itself says which run, how many, and on what tree.
  const packetFile = (await workflow()).lineage.submissions.filter((entry) => entry.phase === 'verification').at(-1).path;
  const packet = JSON.parse(await readFile(path.join(story.root, packetFile), 'utf8'));
  const inPacket = packet.checks.find((entry) => entry.id === check.id);
  assert.equal(inPacket.reusedFrom.attemptId, attempt);
  assert.deepEqual(inPacket.reusedFrom.counts, { discovered: 1, passed: 1, failed: 0, skipped: 0 });
  assert.equal(inPacket.reusedFrom.treeSha256, packet.sourceTreeSha256, 'bound to the same tree');
  assert.match(inPacket.reusedFrom.receiptPath, new RegExp(`context/code-delivery/tests/attempts/implementation/${attempt}\\.json$`, 'u'));

  cli('approve', 'verification', '--yes');
  cli('prepare', 'release');
  const entered = json(cli('phase', 'enter', '--compose', '--for-agent', '--json'));
  const verification = entered.retainedExecutionEvidence.entries.find((entry) => entry.phase === 'verification');
  const run = verification.checks.find((entry) => entry.commandId === check.id);
  assert.equal(run.testResult.status, 'passed');
  assert.deepEqual(run.testResult.counts, { discovered: 1, passed: 1, failed: 0, skipped: 0 });
  assert.equal(run.testResult.reused.recordedBy, 'implementation');
  assert.equal(run.testResult.reused.treeSha256, packet.sourceTreeSha256);
  assert.equal(run.structuredTestsReusable, true);
  assert.equal(verification.executions.find((entry) => entry.commandId === check.id).attemptId, attempt);
  const line = entered.evidenceConsistency.summary.find((entry) => entry.startsWith('verification generation'));
  assert.match(line, new RegExp(`1 passed, 0 failed, 0 skipped; source binding matched; the run ${attempt} that implementation recorded on this same source tree`, 'u'));
  assert.doesNotMatch(line, /no structured counts/u);
  assert.match(entered.context.text, new RegExp(`the run ${attempt} that implementation recorded on this same source tree`, 'u'), 'the author reads it in the prompt');
  assert.doesNotMatch(entered.context.text, /node-tests: passed, no structured counts/u);

  // Release cites it exactly as it would a fresh run, and nothing asks for a decision.
  const report = path.join(item, 'artifacts/release/conformance.md');
  await mkdir(path.join(item, 'artifacts/release/verification'), { recursive: true });
  await writeFile(path.join(item, 'artifacts/release/verification/evidence-index.md'), [`# Release verification evidence index — ${W}`, '',
    `Verification generation 1 is approved. It reused implementation's run ${attempt} on this same source tree (${packet.sourceTreeSha256}): 1 passed, 0 failed, 0 skipped.`, ''].join('\n'));
  const sample = `| \`${W}:REQ-001\` | TODO: exact source/test evidence | TODO: matched/partial/missing/deviated/unplanned |`;
  await writeFile(report, (await readFile(report, 'utf8')).replace(sample, story.clauses.map((clause) => `| \`${clause}\` | \`test/value.test.mjs\`, run ${attempt}: 1 of 1 passed on this source tree | matched |`).join('\n'))
    .replace(/TODO:[^\n]*/gu, `Compared ${story.clauses.join(' and ')} against the recorded run ${attempt}.`).replace(/\bTODO\b/gu, 'none'));
  cli('artifact', 'scan', '--phase', 'release');
  cli('phase', 'publish', 'release', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'release');
  const decisions = json(cli('decisions', W, '--json')).data;
  assert.deepEqual(decisions.items.filter((entry) => entry.kind !== 'approval').map((entry) => entry.title), [], 'nothing to decide');
  cli('approve', 'release', '--yes');
  assert.equal((await workflow()).status, 'closed', 'the Story ends on the one run');
});

test('a fresh run at Verification\'s publication is its own, submission reuses it, and Release reads its counts [CQF:REQ-010, REQ-012]', slowLane({ timeout: 480_000 }), async (t) => {
  const story = await storyAtVerification(t, 'FRESH-1');
  const { cli, item, root } = story;
  await writeVerificationEvidence(story);
  // NODE_OPTIONS is not the environment implementation ran in, so Verification runs the tests itself.
  const elsewhere = (...args) => {
    const result = spawnSync(process.execPath, [CLI, '--no-model', ...args], { cwd: root, encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'History Tester', NODE_OPTIONS: '--max-old-space-size=4096' } });
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const published = elsewhere('phase', 'publish', 'verification', '--authored', 'human', '--channel', 'manual-in-place');
  assert.match(published.stderr, /Running node-tests again: the environment changed since TA-/u, 'it runs at publication');
  const workflow = async () => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  const [run] = (await workflow()).phases.verification.stepTestRuns.preflightAttempts;
  assert.equal(run.status, 'passed');
  assert.deepEqual(run.counts, { discovered: 1, passed: 1, failed: 0, skipped: 0 });
  assert.equal(run.reusedFrom, undefined, 'its own run');
  const review = JSON.parse(cli('phase', 'show', 'verification', '--json').stdout);
  assert.equal(review.stepTestRuns[0].words, `${run.attemptId} by verification: node-tests passed, 1 passed, 0 failed, 0 skipped`, 'the document can cite it');
  const submitted = elsewhere('submit', 'verification');
  assert.match(submitted.stderr, new RegExp(`Not run again: node-tests passed on this exact code \\(${run.attemptId}, recorded by verification\\)`, 'u'), 'submission reuses it');
  const packetFile = (await workflow()).lineage.submissions.filter((entry) => entry.phase === 'verification').at(-1).path;
  const packet = JSON.parse(await readFile(path.join(root, packetFile), 'utf8'));
  assert.deepEqual(packet.submissionEvidence.testExecutions.map((entry) => [entry.commandId, entry.status, entry.path.endsWith(`/attempts/verification/${run.attemptId}.json`)]),
    [['node-tests', 'passed', true]], 'the Story record binds it');
  const summary = JSON.parse(cli('tests', 'summary', '--work-id', 'FRESH-1', '--phase', 'verification', '--json').stdout);
  assert.equal(summary.run.id, run.attemptId);
  assert.equal(summary.run.bound, true);
  const matrix = JSON.parse(cli('evidence', 'matrix', '--json').stdout).data.matrix;
  assert.deepEqual(matrix.evaluation.stepTestRuns.map((entry) => [entry.phaseId, entry.runs[0].attemptId, entry.runs[0].counts.passed]), [['verification', run.attemptId, 1]],
    'the evidence graph reads it');

  cli('approve', 'verification', '--yes');
  cli('prepare', 'release');
  const entered = json(cli('phase', 'enter', '--compose', '--for-agent', '--json'));
  const verification = entered.retainedExecutionEvidence.entries.find((entry) => entry.phase === 'verification');
  const check = verification.checks.find((entry) => entry.commandId === 'node-tests');
  assert.equal(check.testResult.status, 'passed');
  assert.deepEqual(check.testResult.counts, { discovered: 1, passed: 1, failed: 0, skipped: 0 });
  assert.equal(check.testResult.reused, undefined, 'Release reads it as Verification\'s own run');
  assert.equal(check.structuredTestsReusable, true);
  assert.equal(verification.executions[0].attemptId, run.attemptId);
  const line = entered.evidenceConsistency.summary.find((entry) => entry.startsWith('verification generation'));
  assert.match(line, /node-tests: passed, 1 passed, 0 failed, 0 skipped; source binding matched/u);
});

test('a clause that will really end open is said at Verification, with who decides', slowLane({ timeout: 480_000 }), async (t) => {
  const story = await storyAtVerification(t, W, { untested: `${W}:REQ-002` });
  const entered = json(story.cli('phase', 'enter', '--compose', '--for-agent', '--json'));
  const outlook = entered.upstream.clauseOutlook;
  assert.ok(outlook?.length, JSON.stringify(entered.upstream).slice(0, 800));
  assert.equal(outlook[0].clauseId, `${W}:REQ-002`);
  assert.match(outlook[0].words, new RegExp(`${W}:REQ-002 reads (?:missing|pending|failed|inconclusive) in the record, so the last step would mark it partial or missing unless this changes`, 'u'));
  assert.match(outlook[0].words, /decides?\b/u, 'names who decides');
  assert.equal(entered.upstream.attention, true);
  await writeVerificationEvidence(story);
  const prepublish = json(story.cli('phase', 'prepublish', 'verification', '--for-agent', '--json'));
  assert.ok(prepublish.warnings.some((entry) => entry.includes(`${W}:REQ-002 reads`)), 'said at the check too');
  assert.equal(prepublish.status, 'ready', 'it informs, and stops nothing');
});

test('a reused run keeps its evidence only when its own record is that run on this same tree', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-reused-record-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Reuse Tester'); git('config', 'user.email', 'reuse@example.test');
  const relative = `singularity/work-items/${W}/context/code-delivery/tests/attempts/implementation/TA-1.json`;
  const tree = `sha256:${'a'.repeat(64)}`;
  const receipt = { schemaVersion: currentSchemaVersion('test-execution'), attemptId: 'TA-1', workId: W, phase: 'implementation', generation: 1, status: 'passed', exitCode: 0, adapter: 'junit-xml',
    candidate: { commit: 'c1', treeSha256: tree }, tests: { discovered: 2, passed: 2, failed: 0, skipped: 0 }, assurance: 'module-executed' };
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), `${JSON.stringify(receipt, null, 2)}\n`);
  git('add', '.'); git('commit', '-qm', 'A retained run');
  const evidenceCommit = git('rev-parse', 'HEAD').stdout.trim();
  const sha256 = createHash('sha256').update(canonicalJson(receipt)).digest('hex');
  const packetWith = (reusedFrom, check = {}, packet = {}) => ({ workId: W, evidenceCommit, sourceTreeSha256: tree, ...packet,
    checks: [{ id: 'node-tests', kind: 'test', sourceTreeSha256: tree, reusedFrom: { attemptId: 'TA-1', phase: 'implementation', generation: 1, ...reusedFrom }, ...check }] });
  const read = (packet, listed = []) => reusedExecutionDetails(root, packet, { minimumDiscovered: 1, minimumPassed: 1 }, `singularity/work-items/${W}`, listed);

  const [kept] = read(packetWith({ receiptPath: relative, receiptSha256: sha256 }));
  assert.equal(kept.attemptId, 'TA-1');
  assert.deepEqual(kept.counts, receipt.tests);
  assert.deepEqual(kept.reused, { recordedBy: 'implementation', generation: 1, commit: 'c1', treeSha256: tree });
  assert.equal(read(packetWith({})).length, 1, 'a packet from before the path was kept finds it by the attempt ID');
  // Never on less: another tree, another record, another digest, or a record that is not there.
  const other = `sha256:${'b'.repeat(64)}`;
  assert.deepEqual(read(packetWith({}, { sourceTreeSha256: other })), [], 'the check claims another tree');
  assert.deepEqual(read(packetWith({}, {}, { sourceTreeSha256: other })), [], 'the packet is bound to another tree');
  assert.deepEqual(read(packetWith({ attemptId: 'TA-2' })), [], 'no such record');
  assert.deepEqual(read(packetWith({ receiptPath: relative, attemptId: 'TA-2' })), [], 'the record is another run');
  assert.deepEqual(read(packetWith({ receiptPath: relative, receiptSha256: 'f'.repeat(64) })), [], 'the record changed since');
  assert.deepEqual(read(packetWith({}), ['node-tests']), [], 'a run the packet already references is not read twice');
});

test('the refusal says what is true for the state: a report that says less than the record is not a fault of the step before it', () => {
  const workflow = { workItem: { id: W }, currentPhase: 'release', phaseOrder: ['implementation', 'verification', 'release'],
    phases: { implementation: { id: 'implementation', status: 'approved', generation: 1, generationPolicy: { task: 'code' }, writeScope: 'source-and-artifact', requiredArtifact: { kind: 'implementation-summary' } },
      verification: { id: 'verification', status: 'approved', generation: 1, requiredArtifact: { kind: 'test-evidence' } },
      release: { id: 'release', status: 'awaiting_approval', generation: 1, requiredArtifact: { kind: 'conformance-report' }, approvalPolicy: { rejectTo: ['implementation', 'verification', 'release'] } } } };
  const gap = { clauseId: `${W}:AC-001`, verdict: 'partial' };
  const now = '2026-11-06T10:00:00.000Z';
  const real = conformanceGapRefusal(workflow, 'release', [gap], { now });
  assert.match(real.lines[0], /no linked issue; raise one against implementation/u, 'a real gap keeps its route');
  assert.equal(real.gaps[0].choices[0].kind, 'raise-upstream-issue');
  const readsFine = conformanceGapRefusal(workflow, 'release', [gap], { now, satisfied: [`${W}:AC-001`] });
  assert.doesNotMatch(readsFine.lines[0], /raise one against/u);
  assert.match(readsFine.lines[0], /no linked issue, and the recorded evidence reads it satisfied, so nothing shows implementation at fault/u);
  assert.equal(readsFine.gaps[0].choices[0].kind, 'correct-report');
  assert.match(readsFine.gaps[0].choices[0].command, new RegExp(`^singularity-flow reject release --work-id ${W} --to release --reason`, 'u'));
  assert.ok(readsFine.gaps[0].choices.some((choice) => choice.kind === 'raise-upstream-issue'), 'a person may still raise it');
  // The verdict is never edited, and evidence reading fine decides nothing by itself.
  assert.equal(conformanceGapDecisions(workflow, 'release', [gap], { now, satisfied: [`${W}:AC-001`] })[0].status, 'unraised');
  assert.equal(conformanceGapLine({ ...gap, status: 'undecided', issue: 'UPI-001', owner: 'implementation', evidenceSatisfied: true }), `${W}:AC-001 remains partial: UPI-001 awaits implementation's approvers`);
});
