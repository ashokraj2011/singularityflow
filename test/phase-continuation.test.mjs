import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { phaseJourney } from '../src/phase-journey.mjs';
import { coordinatePhaseContinuation } from '../src/phase-continuation-runtime.mjs';
import { readContinuationJournal } from '../src/phase-continuation-journal.mjs';
import { gitCommonDir } from '../src/git.mjs';
import { repairDigest } from '../src/phase-repair-journal.mjs';
import { run } from '../src/util.mjs';
import { safeCommandGuidance } from '../src/safe-command-guidance.mjs';
import { resolveOperation } from '../src/command-registry.mjs';

const WORK = 'JOURNEY-1';
function aggregate(id = 'team-build') {
  return { status: 'in_progress', currentPhase: id, workItem: { id: WORK, branch: WORK }, resolution: {},
    phases: { [id]: { id, generation: 0, status: 'in_progress',
      generationIntent: { id: 'GI-1', generation: 1, status: 'open' } } } };
}
const submit = id => ({ classification: 'ready-to-attempt', lifecycleReady: true,
  nextCommand: `singularity-flow submit ${id} --work-id ${WORK}` });
function observation(workflow, extra = {}) {
  const phase = workflow.phases[workflow.currentPhase];
  const inspection = { status: 'ready', draftFingerprint: 'stable', commands: {
    publish: `singularity-flow phase publish ${phase.id} --authored human --channel manual-in-place` } };
  return { inspection, recovery: { revision: 'stable' }, journey: phaseJourney(workflow, phase,
    { inspection, submission: submit(phase.id), ...extra }) };
}
async function fixture(t, id) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-continuation-'));
  t.after(() => import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })));
  run('git', ['init', '-b', WORK], { cwd: root });
  const workflow = aggregate(id); const calls = [];
  const dependencies = { load: async () => ({ workflow, definition: {} }), branch: () => WORK,
    inspect: async () => observation(workflow), execute: async (_root, argv) => {
      calls.push(argv); const phase = workflow.phases[workflow.currentPhase];
      if (argv[0] === 'phase') { phase.generation = 1; phase.generationIntent.status = 'consumed'; }
      else phase.status = 'awaiting_approval';
      return { code: null };
    } };
  const invoke = (action = 'preview', confirmation = null, override = {}) => coordinatePhaseContinuation(
    { root, workId: WORK, phaseId: workflow.currentPhase, action, confirmation }, { ...dependencies, ...override });
  return { root, workflow, calls, dependencies, invoke };
}

test('the journey separates draft repair, pending human decisions, tests and immutable trust', () => {
  for (const id of ['specification', 'planning', 'implementation', 'verification', 'release', 'future-team-step']) {
    const workflow = aggregate(id); const phase = workflow.phases[id];
    const author = { code: 'artifact.placeholder.unresolved', category: 'artifact', path: 'draft.md' };
    const human = { code: 'phase.evidence-contract.not-ready', path: 'screen.png', details: { sourceCode: 'PLAN_EVIDENCE_CORRECTION_REVIEW_REQUIRED' } };
    const repaired = phaseJourney(workflow, phase, { findings: [human, author], inspection: { correction: { sameTurn: true } } });
    assert.equal(repaired.state, 'draft-repair'); assert.equal(repaired.authoring.allowed, true);
    assert.equal(repaired.transition.publishAllowed, false); assert.equal(repaired.pendingHumanReviews.length, 1);
    assert.match(repaired.next.command, /repair-plan/u, 'owned repair remains the immediate route, not the pending human decision');
    const corrupt = phaseJourney(workflow, phase, { findings: [author, { code: 'SPECIFICATION_CLAIM_MAP_BINDING_STALE', category: 'artifact' }], inspection: { correction: { sameTurn: true } } });
    assert.equal(corrupt.state, 'integrity-blocked'); assert.equal(corrupt.authoring.allowed, false);
    assert.match(corrupt.next.command, /doctor/u, 'integrity owner wins over a preceding draft repair');
    assert.equal(corrupt.transition.testsWaived, false);
    const unknown = phaseJourney(workflow, phase, { findings: [{ code: 'UNREGISTERED_GATE' }] });
    assert.equal(unknown.state, 'owner-resolution'); assert.match(unknown.next.command, /doctor/u);
  }
});
test('visual evidence is forecast before submission, but needs its actual witness before approval', () => {
  const workflow = aggregate(); const phase = workflow.phases[workflow.currentPhase];
  phase.generation = 1; phase.generationIntent.status = 'consumed';
  const witness = { clauseId: `${WORK}:AC-001`, status: 'pending', commandGuidance: safeCommandGuidance({ command: 'singularity-flow decision witness --work-id JOURNEY-1' }) };
  assert.equal(phaseJourney(workflow, phase, { witnesses: [witness], submission: submit(phase.id) }).state, 'ready-to-submit');
  phase.status = 'awaiting_approval';
  const journey = phaseJourney(workflow, phase, { witnesses: [witness], submission: submit(phase.id) });
  assert.equal(journey.state, 'witness-review'); assert.equal(journey.transition.submitAllowed, false);
  assert.equal(phaseJourney(workflow, phase, { witnesses: [{ ...witness, status: 'met' }], submission: submit(phase.id) }).state, 'human-approval');
});
test('required source/convergence reviews, decision inputs and soft sequencing cannot be auto-submitted', () => {
  const workflow = aggregate(); const phase = workflow.phases[workflow.currentPhase];
  phase.generation = 1; phase.generationIntent.status = 'consumed';
  for (const submission of [{ classification: 'source-review-required', lifecycleReady: false },
    { ...submit(phase.id), confirmationRequired: true }, { ...submit(phase.id), decisionInputs: [{ id: 'human' }] },
    { classification: 'convergence-review-required', lifecycleReady: true }]) {
    assert.equal(phaseJourney(workflow, phase, { submission }).transition.submitAllowed, false);
  }
});
test('all continuation commands are registered model-free with accurate mutation classes', () => {
  for (const action of ['resolve', 'resolve-run', 'resolve-resume']) {
    const operation = resolveOperation({ requestedCommand: 'appeal', positionals: ['appeal', action], options: {} });
    assert.equal(operation.id, `appeal.${action}`);
    assert.equal(operation.classification, action === 'resolve' ? 'read' : 'mutation');
  }
});
test('confirmed continuation performs only bounded publish and submit, never approval', async t => {
  const f = await fixture(t, 'team-build');
  const planned = await f.invoke(); assert.equal(planned.continuationAllowed, true);
  assert.match(planned.next.copilotCommand, /^\/sf-appeal resolve-run/u);
  assert.equal(f.calls.length, 0);
  const result = await f.invoke('run', planned.confirmation);
  assert.deepEqual(f.calls.map(argv => argv[0]), ['phase', 'submit']);
  assert.equal(result.journey.state, 'human-approval'); assert.equal(result.executed.length, 2);
  assert.equal(f.workflow.phases['team-build'].status, 'awaiting_approval');
  assert.equal(result.attemptsRemaining, 1);
  assert.equal(result.mutates, true);
  assert.equal(result.testsRun, null, 'continuation never invents a passing test claim');
});
test('a failed operation stays visible after reopening and its retained diagnostic is redacted', async t => {
  const f = await fixture(t); const plan = await f.invoke();
  const diagnostic = 'Runner refused https://user:super-secret@example.test/repo?token=secret-token';
  const result = await f.invoke('run', plan.confirmation, { execute: async () => ({ code: 'RUNNER_UNAVAILABLE', diagnostic }) });
  assert.equal(result.journey.state, 'operation-review');
  assert.equal(result.status, 'operation-review');
  const reopened = await f.invoke();
  assert.equal(reopened.journey.lastRefusal, 'RUNNER_UNAVAILABLE');
  assert.doesNotMatch(reopened.journey.diagnostic, /super-secret|secret-token/u);
  assert.equal(reopened.transition?.publishAllowed ?? reopened.journey.transition.publishAllowed, false);
  assert.match(reopened.next.command, /recover/u);
});
test('stale plans and changed checkout bindings cannot execute any operation', async t => {
  const f = await fixture(t); const plan = await f.invoke();
  f.workflow.resolution.changedPolicy = true;
  await assert.rejects(f.invoke('run', plan.confirmation), { code: 'PHASE_CONTINUATION_STALE' });
  await assert.rejects(f.invoke('run', plan.confirmation, { branch: () => 'other-story' }), { code: 'PHASE_CONTINUATION_BINDING_INVALID' });
  assert.equal(f.calls.length, 0);
});
test('a zero exit without retained postconditions cannot pass or blindly retry', async t => {
  const f = await fixture(t); const plan = await f.invoke();
  const result = await f.invoke('run', plan.confirmation, { execute: async () => ({ code: null }) });
  assert.equal(result.executed[0].outcome, 'not-verified'); assert.equal(result.continuationAllowed, false);
  await assert.rejects(f.invoke('run', result.confirmation), { code: 'PHASE_CONTINUATION_NOT_ADMITTED' });
  assert.equal((await readContinuationJournal(f.root, plan.binding)).consumed, 1);
});
test('crash after reservation resumes by inspection without repeating tests/publication', async t => {
  const f = await fixture(t); const plan = await f.invoke();
  await assert.rejects(f.invoke('run', plan.confirmation, { afterReservation: () => { throw Error('simulated crash'); } }));
  const pending = await f.invoke(); assert.equal(pending.status, 'resume-required');
  const resumed = await f.invoke('resume'); assert.equal(resumed.result, 'not-verified');
  assert.equal(resumed.continuationAllowed, false); assert.equal(f.calls.length, 0);
});
test('crash after committed publication authenticates it without rerunning the operation', async t => {
  const f = await fixture(t); const plan = await f.invoke();
  await assert.rejects(f.invoke('run', plan.confirmation, { afterOperation: () => { throw Error('simulated crash'); } }));
  const resumed = await f.invoke('resume');
  assert.equal(resumed.result, 'verified'); assert.equal(resumed.journey.state, 'ready-to-submit');
  assert.equal(f.calls.length, 1); assert.equal(resumed.registeredOperationExecuted, false);
});
test('private journal corruption is a hard owner route, not a fresh retry budget', async t => {
  const f = await fixture(t); const plan = await f.invoke();
  await f.invoke('run', plan.confirmation);
  const file = path.join(gitCommonDir(f.root), 'singularity-flow', 'phase-continuations', repairDigest(plan.binding).slice(7), '000001.json');
  const event = JSON.parse(await readFile(file, 'utf8')); event.action = 'approve'; await writeFile(file, JSON.stringify(event));
  await assert.rejects(f.invoke(), { code: 'PHASE_CONTINUATION_JOURNAL_INVALID' });
});
