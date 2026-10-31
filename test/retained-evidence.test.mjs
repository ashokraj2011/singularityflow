/**
 * Retained evidence a step published keeps its bytes through every later step (ws-graph AC-001,
 * 2026-10-27): a test saved its Playwright capture straight to the evidence path, the verification
 * step's submission committed the re-capture, and the witness was refused at release by a message
 * that named no published digest and a correction no command makes.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { retainedEvidenceChangedRefusal, retainedEvidenceChanges, retainedEvidenceGuard } from '../src/evidence/retained-evidence.mjs';
import { loadTopics } from '../src/docs-topics.mjs';
import { phaseResolutionChoices } from '../src/phase-resolution.mjs';
import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';
import { phasePromptExecutionContract } from '../src/worldmodel.mjs';
import { publishedRetainedEvidence, recordWitness, WITNESS_CHECKLIST } from '../src/verification/witness-records.mjs';

const W = 'ws-graph';
const AC = 'WS-GRAPH:AC-001';
const FILE = `singularity/work-items/${W}/evidence/graph-tool.png`;
const PUBLISHED = Buffer.from('the image implementation published');
const RECAPTURED = Buffer.from('the same screen, captured again');
const hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const GENERATION = '6b9fd4919d9405b02264f6c41934c1e399cdde5b';

function story({ implementation = 'approved', verification = 'in_progress', current = 'verification', sha256 = hex(PUBLISHED),
  shape = 'list', generationCommit = GENERATION } = {}) {
  const entries = [{ clauseId: AC, fulfillment: 'evidence', paths: [{ path: FILE, state: 'present', sha256 }] },
    { clauseId: 'WS-GRAPH:AC-002', fulfillment: 'existing', paths: [{ path: 'src/graph.js', state: 'present', sha256: 'f'.repeat(64) }] }];
  return {
    workItem: { id: W }, status: 'in_progress', currentPhase: current,
    phaseOrder: ['planning', 'implementation', 'verification', 'release'],
    phases: {
      planning: { id: 'planning', status: 'approved', generation: 1, generationCommit: 'a'.repeat(40) },
      implementation: { id: 'implementation', status: implementation, generation: 1, generationCommit,
        approvalPolicy: { rejectTo: ['planning', 'implementation'] },
        deliveryEvidence: { fulfillment: shape === 'list' ? entries : { obligations: entries } } },
      verification: { id: 'verification', status: verification, generation: 1, generationCommit: 'c'.repeat(40),
        approvalPolicy: { rejectTo: ['implementation', 'verification'] } },
      release: { id: 'release', status: 'not_started', generation: 0, approvalPolicy: { rejectTo: ['implementation', 'release'] } }
    }
  };
}

test('the published retained evidence is each present evidence file of a published delivery, in either record shape', () => {
  for (const shape of ['list', 'obligations']) {
    assert.deepEqual(publishedRetainedEvidence(story({ shape })), [{ phase: 'implementation', generation: 1, generationCommit: GENERATION,
      clauseId: AC, path: FILE, sha256: `sha256:${hex(PUBLISHED)}` }]);
  }
  assert.deepEqual(publishedRetainedEvidence(story({ implementation: 'in_progress' }), { approvedOnly: true }), []);
  assert.deepEqual(publishedRetainedEvidence(story(), { except: 'implementation' }), []);
  assert.deepEqual(publishedRetainedEvidence(story({ generationCommit: null })), [], 'an unpublished delivery published nothing');
});

test('a later step may not change an approved step\'s evidence; the owning step publishes a new image in its own generation', () => {
  const committed = (bytes) => new Map(bytes ? [[FILE, hex(bytes)]] : []);
  assert.deepEqual(retainedEvidenceChanges(story(), 'verification', committed(PUBLISHED)), []);
  const [changed] = retainedEvidenceChanges(story(), 'verification', committed(RECAPTURED));
  assert.deepEqual([changed.entry.phase, changed.entry.path, changed.entry.sha256, changed.current, changed.during, changed.restore],
    ['implementation', FILE, `sha256:${hex(PUBLISHED)}`, `sha256:${hex(RECAPTURED)}`, false, true]);
  assert.equal(retainedEvidenceChanges(story(), 'verification', committed(null))[0].current, null, 'a deleted file is a change');
  // The owning step's rework: it is not approved while it is returned, and its next publication
  // records the new bytes as its own evidence, in the same commit.
  assert.deepEqual(retainedEvidenceChanges(story({ implementation: 'in_progress', current: 'implementation' }), 'implementation', committed(RECAPTURED)), []);
  assert.deepEqual(retainedEvidenceChanges(story({ sha256: hex(RECAPTURED) }), 'verification', committed(RECAPTURED)), []);
  // A step completed by its own submission (no approval) is the step being committed, never protected from itself.
  assert.deepEqual(retainedEvidenceChanges(story(), 'implementation', committed(RECAPTURED)), []);
  // Changed while the command ran (its own test run) against changed before it.
  const during = retainedEvidenceChanges(story(), 'verification', committed(RECAPTURED), new Map([[FILE, `sha256:${hex(PUBLISHED)}`]]))[0];
  assert.deepEqual([during.during, during.restore], [true, false]);
  const earlier = retainedEvidenceChanges(story(), 'verification', committed(RECAPTURED), new Map([[FILE, `sha256:${hex(RECAPTURED)}`]]))[0];
  assert.deepEqual([earlier.during, earlier.restore], [false, true]);
});

test('the refusal names the file, its publisher, both digests, the generation commit and both ways on', () => {
  const workflow = story();
  const changes = retainedEvidenceChanges(workflow, 'verification', new Map([[FILE, hex(RECAPTURED)]]));
  const error = retainedEvidenceChangedRefusal(workflow, 'verification', changes, { action: 'submission' });
  assert.equal(error.code, 'RETAINED_EVIDENCE_CHANGED');
  for (const expected of [`Submission of verification would change retained evidence that implementation published: ${FILE} for ${AC}.`,
    `implementation published sha256:${hex(PUBLISHED)} in generation 1 (commit ${GENERATION.slice(0, 12)})`,
    `this submission would commit sha256:${hex(RECAPTURED)}. Nothing was committed.`,
    `To keep the published image, restore it with git restore --source=${GENERATION} -- ${FILE}, then submit verification again.`,
    'To keep a new image, implementation, the step that owns this evidence, must publish it again: record it for implementation\'s approvers with '
      + `singularity-flow upstream-issue raise --work-id ${W} --phase implementation --about ${AC} --problem <what-changed>`,
    'Once verification is submitted, an authorized approver can return it to implementation with: singularity-flow reject verification --to implementation.',
    'never at a retained evidence path']) assert.ok(error.message.includes(expected), `${expected}\n${error.message}`);
  assert.deepEqual([error.details.phase, error.details.paths, error.details.upstreamPhases], ['verification', [FILE], ['implementation']]);
  assert.deepEqual(error.details.retainedEvidence[0], { path: FILE, clauseId: AC, publishedBy: 'implementation', generation: 1,
    generationCommit: GENERATION, publishedSha256: `sha256:${hex(PUBLISHED)}`, currentSha256: `sha256:${hex(RECAPTURED)}`, changedDuring: false,
    restore: `git restore --source=${GENERATION} -- ${FILE}` });

  // Its own test run rewrote it: restoring would not help, the test changes in the owning step, and
  // the return that needs this step submitted first is not offered.
  const during = retainedEvidenceChangedRefusal(workflow, 'verification', retainedEvidenceChanges(workflow, 'verification',
    new Map([[FILE, hex(RECAPTURED)]]), new Map([[FILE, `sha256:${hex(PUBLISHED)}`]])), { action: 'submission' });
  assert.match(during.message, /The file changed while this submission ran, most likely because a test saves its capture to this path: every run replaces it, so submitting again would be refused again\. The file is back to its bytes from before this submission\./u);
  assert.match(during.message, /That test changes in implementation, the step that owns this evidence: record it/u);
  assert.doesNotMatch(during.message, /git restore|Once verification is submitted/u);

  // The recovery plan shows the person's own Git step and the route, with every command accepted.
  const plan = refusalRemediationPlan(error, ['submit', 'verification', '--work-id', W]);
  assert.deepEqual(plan.steps.slice(0, 2).map((entry) => [entry.id, entry.command]), [
    ['restore-published-evidence', null],
    ['raise-upstream-issue', `singularity-flow upstream-issue raise --work-id ${W} --phase implementation --about ${AC} --problem <what-changed>`]]);
  assert.match(plan.steps[0].label, new RegExp(`restore it in your own terminal with git restore --source=${GENERATION} -- ${FILE.replace(/[.]/gu, '\\.')}, then run the same command again`, 'u'));
  assert.ok(plan.steps.every((entry) => !entry.commandRejected));
});

test('a refused witness names the published image, the current one and the routes from where the Story stands', () => {
  const answers = Object.fromEntries(WITNESS_CHECKLIST.map((item) => [item, 'yes']));
  const input = { clauseId: AC, slot: { slot: 'graph-reference-screenshot', method: 'visual', witness: { target: FILE } }, file: FILE,
    sha256: `sha256:${hex(RECAPTURED)}`, plannedClaim: { fulfillment: 'evidence', expectedPaths: [FILE] }, answers,
    reason: 'Compared the screen with the reference.', actor: 'carol', authorityGroup: 'quality-reviewers', at: '2026-10-31T00:00:00.000Z' };
  const atRelease = story({ verification: 'approved', current: 'release' });
  atRelease.phases.release.status = 'in_progress';
  const refused = (workflow) => { try { recordWitness(workflow, input); } catch (error) { return error; } return assert.fail('witnessed'); };
  const error = refused(atRelease);
  assert.equal(error.code, 'WITNESS_EVIDENCE_UNPUBLISHED');
  for (const expected of [`${FILE} is not the image implementation published for ${AC}: implementation published sha256:${hex(PUBLISHED)} in generation 1 (commit ${GENERATION.slice(0, 12)}), and the file now has sha256:${hex(RECAPTURED)}. Nothing was recorded.`,
    `To witness the published image, restore it with git restore --source=${GENERATION} -- ${FILE}, then witness it again.`,
    `To keep the new image instead, implementation, the step that owns this evidence, must publish it again: record it for implementation's approvers with singularity-flow upstream-issue raise --work-id ${W} --phase implementation --about ${AC}`,
    'Once release is submitted, an authorized approver can return it to implementation with: singularity-flow reject release --to implementation.'
  ]) assert.ok(error.message.includes(expected), `${expected}\n${error.message}`);
  assert.equal(atRelease.witnessRecords, undefined, 'a refusal appends no decision');
  // Once the step awaits approval, its approver returns the Story to the owning step directly.
  atRelease.phases.release.status = 'awaiting_approval';
  assert.match(refused(atRelease).message, /an approver of release returns the Story to implementation with singularity-flow reject release --work-id ws-graph --to implementation --reason <reason>, and implementation publishes the new image in its next generation\./u);
  // The owning step itself, awaiting approval, is returned to itself.
  assert.match(refused(story({ implementation: 'awaiting_approval', current: 'implementation' })).message,
    /singularity-flow reject implementation --work-id ws-graph --to implementation --reason <reason>/u);
  const plan = refusalRemediationPlan(error, ['decision', 'witness', W, '--criterion', AC]);
  assert.deepEqual(plan.steps.slice(0, 2).map((entry) => entry.id), ['restore-published-evidence', 'raise-upstream-issue']);
  assert.ok(plan.steps.every((entry) => !entry.commandRejected));
  // Nothing published: it says so instead of asking for a correction no command makes.
  const unpublished = refused(story({ generationCommit: null }));
  assert.match(unpublished.message, /^Nothing has published .*graph-tool\.png for WS-GRAPH:AC-001: no step's delivery records it, so there is no published image to witness yet\./u);
  assert.equal(recordWitness(story({ sha256: hex(RECAPTURED) }), input).outcome, 'met', 'the published bytes are witnessed');
});

function git(root, args, options = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', ...options });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** The tree a commit of the worktree would admit, built in a private index like the publication kernel. */
function prospectiveTree(root) {
  const env = { ...process.env, GIT_INDEX_FILE: path.join(root, '.git', 'prospective-index') };
  git(root, ['read-tree', 'HEAD'], { env });
  git(root, ['add', '-A', '--', 'singularity'], { env });
  return git(root, ['write-tree'], { env });
}

test('the guard reads the exact tree a commit admits and tells a change made while the command ran from an earlier one', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-retained-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-qb', 'main']);
  git(root, ['config', 'user.name', 'Retained Evidence Tester']);
  git(root, ['config', 'user.email', 'retained@example.invalid']);
  await mkdir(path.dirname(path.join(root, FILE)), { recursive: true });
  await writeFile(path.join(root, FILE), PUBLISHED);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'publish the evidence']);
  const workflow = story({ generationCommit: git(root, ['rev-parse', 'HEAD']) });
  const event = { type: 'approval-requested', phaseId: 'verification' };
  assert.equal(await retainedEvidenceGuard(root, workflow, { type: 'phase-approved', phaseId: 'verification' }), null);
  assert.equal(await retainedEvidenceGuard(root, workflow, { type: 'approval-requested', phaseId: 'nowhere' }), null);

  const unchanged = await retainedEvidenceGuard(root, workflow, event);
  await unchanged.assert({ workflow, priorWorkflow: workflow, event, prospectiveTree: prospectiveTree(root) });

  // The submission's own test run rewrites the file after the guard read it.
  const guard = await retainedEvidenceGuard(root, workflow, event);
  await writeFile(path.join(root, FILE), RECAPTURED);
  await assert.rejects(guard.assert({ workflow, priorWorkflow: workflow, event, prospectiveTree: prospectiveTree(root) }), (error) => {
    assert.equal(error.code, 'RETAINED_EVIDENCE_CHANGED');
    assert.deepEqual([error.details.retainedEvidence[0].changedDuring, error.details.retainedEvidence[0].restore], [true, null]);
    assert.match(error.message, /changed while this submission ran/u);
    return true;
  });
  // A finalized event for another step or transition is not this guard's to judge.
  await guard.assert({ workflow, priorWorkflow: workflow, event: { ...event, phaseId: 'release' }, prospectiveTree: prospectiveTree(root) });

  // Changed before the command began: restoring the published bytes is the way on.
  const earlier = await retainedEvidenceGuard(root, workflow, event);
  await assert.rejects(earlier.assert({ workflow, priorWorkflow: workflow, event, prospectiveTree: prospectiveTree(root) }), (error) => {
    assert.deepEqual([error.details.retainedEvidence[0].changedDuring, error.details.retainedEvidence[0].currentSha256], [false, `sha256:${hex(RECAPTURED)}`]);
    assert.match(error.message, new RegExp(`git restore --source=${workflow.phases.implementation.generationCommit} -- `, 'u'));
    return true;
  });
  // A deletion is refused too.
  await rm(path.join(root, FILE));
  await assert.rejects(earlier.assert({ workflow, priorWorkflow: workflow, event, prospectiveTree: prospectiveTree(root) }),
    (error) => error.code === 'RETAINED_EVIDENCE_CHANGED' && /this submission would delete it/u.test(error.message));
});

test('planning and capture guidance say a test never saves its capture at a retained evidence path', async () => {
  // The plan template and the planning prompt, where a planner reads how evidence is planned.
  const template = await readFile(new URL('../templates/artifacts/spec-driven/plan.md', import.meta.url), 'utf8');
  assert.match(template, /A planned test never saves its capture straight to that path, because every later run would replace\nthe reviewed file: it saves under its runner's output \(for example `test-results\/`\), and the code\nstep copies the image to the evidence path once/u);
  const planner = { id: 'planning', generationPolicy: { requirement: 'required', producer: 'governed-agent', allowedProducers: ['governed-agent'] } };
  const planned = { workItem: { id: 'PLAN-1' }, phases: { planning: planner, build: { id: 'build', generationPolicy: { task: 'code' } } },
    resolution: { phases: [], plannedClaims: { mode: 'required', owners: { build: 'planning' } } } };
  assert.match(phasePromptExecutionContract({ phases: {} }, planned, planner).lines.join('\n'),
    /Evidence planning: .*A planned test that captures one saves under its runner's output \(for example test-results\/\), never at that path, which every later run would replace; the code step copies it there once\./u);
  // The capture route the code step's author follows when a planned file is missing.
  const code = { id: 'implementation', status: 'in_progress', generation: 0, writeScope: 'source-and-artifact',
    generationPolicy: { task: 'code', requirement: 'required' }, requiredArtifact: { kind: 'implementation-summary' }, generationIntent: { status: 'open', generation: 1 } };
  const story = { workItem: { id: 'HEX-1' }, status: 'in_progress', currentPhase: 'implementation', phaseOrder: ['implementation'],
    phases: { implementation: code }, resolution: { workItemRoot: 'singularity/work-items' } };
  const [capture] = phaseResolutionChoices(story, code, { code: 'code.delivery.retained-evidence-missing', category: 'retained-evidence',
    path: FILE, details: { sourceCode: 'CODE_DELIVERY_RETAINED_EVIDENCE_MISSING' } }).choices;
  assert.equal(capture.kind, 'capture-retained-evidence');
  assert.match(capture.detail, /save the file at exactly that path, then recheck\. A test that captures it saves under its runner's output \(for example test-results\/\) and the file is copied to that path once: a test that saves straight to the path replaces the published file on every later run\./u);
  // The topics every surface explains it from.
  const topics = Object.fromEntries((await loadTopics()).map((topic) => [topic.id, topic.body]));
  assert.match(topics['evidence-matrix'], /A planned test therefore saves its capture under its runner's output \(for example `test-results\/`\)/u);
  assert.match(topics['evidence-matrix'], /\*\*`RETAINED_EVIDENCE_CHANGED`:\*\*/u);
  assert.match(topics['compact-phase-entry'], /A planned test never saves its capture straight\nto that path/u);
  assert.match(topics.findings, /### RETAINED_EVIDENCE_CHANGED\n\n.*`git restore --source=<GENERATION-COMMIT> -- <FILE>`/u);
  assert.match(topics.findings, /When a test captures it, the test saves under its runner's output \(for example `test-results\/`\)/u);
  assert.equal(refusalRemediationPlan(Object.assign(new Error('refused'), { code: 'RETAINED_EVIDENCE_CHANGED', details: {} }), ['submit', 'verification'])
    .documentation.command, 'singularity-flow explain findings --section RETAINED_EVIDENCE_CHANGED');
});
