import assert from 'node:assert/strict';
import test from 'node:test';
import { phaseHandoff, workflowGuide } from '../src/guide.mjs';
import { phaseNeedsGeneration } from '../src/sequence.mjs';
import { phaseInspectionGeneration } from '../src/code-submission-evidence.mjs';
import { reservePreparedDocumentSuccessor } from '../src/prepared-document-successor.mjs';
import { sourceReviewContinuation } from '../src/source-review-continuation.mjs';
import { nextStepsSnapshot } from '../src/nextsteps.mjs';
import { planFastPath } from '../src/fast-path.mjs';
import { phaseContinuation, phaseContinuationLines } from '../src/phase-continuation.mjs';

function story(id) {
  const phase = { id, label: id, status: 'in_progress', generation: 1,
    generationPolicy: { requirement: 'required', defaultProducer: 'governed-agent' },
    requiredArtifact: { path: `artifacts/${id}/document.md` },
    generationPublications: [{ generation: 1, record: { path: `context/${id}-gen1.json` } }] };
  return { workItem: { id: 'ROUTE-1', workType: 'custom' }, status: 'in_progress',
    currentPhase: id, phaseOrder: [id], phases: { [id]: phase }, history: [],
    resolution: { sourceReview: { mode: 'enforce', phases: [id], reviewerAgent: 'independent-reviewer' } } };
}

test('every document phase and future custom phase retains the successor authoring handoff until publication', () => {
  for (const id of ['specification', 'planning', 'verification', 'release', 'design', 'my-custom-scope']) {
    const workflow = story(id), phase = workflow.phases[id];
    assert.equal(phaseNeedsGeneration(workflow, phase), false);
    assert.equal(reservePreparedDocumentSuccessor(workflow, phase, '2026-10-07T00:00:00Z'), true);
    const before = JSON.stringify(workflow);
    assert.equal(reservePreparedDocumentSuccessor(workflow, phase, 'later'), false, 'prepare retries cannot replace the reservation');
    assert.equal(JSON.stringify(workflow), before);
    assert.equal(phaseNeedsGeneration(workflow, phase), true);
    assert.equal(phaseInspectionGeneration(workflow, phase), 2);
    assert.equal(phaseHandoff(workflow, phase)[0].command, `singularity-flow prepare ${id}`);
    assert.equal(workflowGuide(workflow).nextActions[0].command, `singularity-flow prepare ${id}`);
    assert.equal(sourceReviewContinuation(workflow, phase).targetGeneration, 2);
    assert.equal(nextStepsSnapshot({ workflow }).actions[0].command, `singularity-flow prepare ${id}`);
    // An actual successor publication, not a preparation/draft/review, clears the route.
    phase.generation = 2;
    phase.generationPublications.push({ generation: 2, record: { path: `context/${id}-gen2.json` } });
    assert.equal(phaseNeedsGeneration(workflow, phase), false);
    assert.equal(phaseInspectionGeneration(workflow, phase), 2);
    assert.equal(phaseHandoff(workflow, phase)[0].command, `singularity-flow review-source status ${id}`);
  }
});

test('preparation cannot reopen code, sign-off-only, inactive or submitted publications', () => {
  for (const change of [p => { p.status = 'awaiting_approval'; }, p => { p.status = 'approved'; },
    p => { p.generationPolicy.requirement = 'none'; },
    p => { p.generationPolicy.task = 'code'; p.generationIntent = { status: 'consumed', generation: 1 }; },
    p => { p.generationPublications = []; }]) {
    const workflow = story('custom-step'), phase = workflow.phases['custom-step']; change(phase);
    const before = JSON.stringify(workflow);
    assert.equal(reservePreparedDocumentSuccessor(workflow, phase, 'now'), false);
    assert.equal(JSON.stringify(workflow), before);
  }
  const workflow = story('custom-step'); workflow.currentPhase = 'different-step';
  assert.equal(reservePreparedDocumentSuccessor(workflow, workflow.phases['custom-step'], 'now'), false);
});

test('planner, fast path and review status agree on a retained source-review correction', () => {
  for (const id of ['specification', 'planning', 'customer-scope']) {
    const workflow = story(id), phase = workflow.phases[id];
    const sourceReviewEvidence = { status: 'correction-required', findings: [{ code: 'reviewer-blocker' }], pendingDispositions: [] };
    const expected = `singularity-flow prepare ${id}`;
    assert.equal(phaseHandoff(workflow, phase, { sourceReviewEvidence })[0].command, expected);
    assert.equal(workflowGuide(workflow, { sourceReviewEvidence }).nextActions[0].command, expected);
    assert.equal(nextStepsSnapshot({ workflow, sourceReviewEvidence }).actions[0].command, expected);
    const definition = { workTypes: { custom: { fastPath: { specify: { milestone: 'done', phases: [id] } } } } };
    const fast = planFastPath(workflow, definition, 'specify', { sourceReviewEvidence });
    assert.equal(fast.next[0].command, expected);
    assert.equal(fast.checkpoint.kind, 'model-generation');
    assert.equal(phase.generation, 1, 'routing is not publication or approval');
  }
});

test('human dispositions, stale bindings and submitted phases never become automatic author corrections', () => {
  const workflow = story('custom-scope'), phase = workflow.phases['custom-scope'];
  const pending = { status: 'correction-required', findings: [{ code: 'human-disposition-required' }],
    pendingDispositions: [{ id: 'exclusion:row-1' }] };
  assert.match(sourceReviewContinuation(workflow, phase, pending).nextCommand, /review-source decide custom-scope --finding exclusion:row-1/);
  assert.equal(sourceReviewContinuation(workflow, phase, { status: 'stale', findings: [{ code: 'review-binding-stale' }] }).nextSkill, '/sf-review-source');
  phase.status = 'awaiting_approval';
  assert.equal(sourceReviewContinuation(workflow, phase, { status: 'correction-required', findings: [{ code: 'reviewer-blocker' }] }).nextSkill, '/sf-nextsteps');
  assert.equal(phase.reworkRevalidation, undefined);
});

test('custom code successors keep guarded rollover and ready reviews keep decision inputs', () => {
  const workflow = story('custom-code'), phase = workflow.phases['custom-code'];
  phase.generationPolicy.task = 'code';
  phase.generationIntent = { status: 'consumed', generation: 1 };
  phase.reworkRevalidation = { generation: 1, invalidatedAt: 'now' };
  const before = JSON.stringify(workflow);
  assert.equal(sourceReviewContinuation(workflow, phase).nextCommand, 'singularity-flow phase rollover custom-code --json');
  assert.equal(JSON.stringify(workflow), before);
  const scoped = story('scope'), scope = scoped.phases.scope;
  scoped.resolution.decisions = [{ id: 'risk', mode: 'auto', after: 'scope', inputs: [{ name: 'risk', type: 'enum', values: ['low', 'high'] }] }];
  const next = sourceReviewContinuation(scoped, scope, { status: 'ready' });
  assert.match(next.nextCommand, /submit scope --work-id ROUTE-1 --decision risk=<risk>/);
});

test('phase continuation selects NOW, never an optional assignment or a later approval', () => {
  const workflow = story('customer-scope'), phase = workflow.phases['customer-scope'];
  phase.approvalPolicy = { mode: 'required', minimum: 1, by: ['reviewers'] };
  const before = JSON.stringify(workflow);
  const next = phaseContinuation(workflow);
  assert.equal(next.automaticAdvance, false);
  assert.equal(next.nextAction.timing, 'now');
  assert.doesNotMatch(next.nextCommand, /assign|approve|cancel/);
  assert.equal(JSON.stringify(workflow), before);
  assert.ok(phaseContinuationLines(next).some(line => line.startsWith('Copilot: /sf-')));
  const historical = phaseContinuation(workflow, { reviewedPhaseId: 'previous-scope' });
  assert.equal(historical.nextCommand, 'singularity-flow nextsteps ROUTE-1 --json');
  assert.equal(historical.copilotCommand, '/sf-nextsteps');
  const recovery = phaseContinuation(workflow, { recovery: { requiresRecovery: true, phaseId: phase.id } });
  assert.equal(recovery.nextCommand, 'singularity-flow recover ROUTE-1 --phase customer-scope');
  assert.equal(recovery.nextSkill, '/sf-recover');
  const synchronization = phaseContinuation(workflow, { publicationPending: true });
  assert.equal(synchronization.nextCommand, 'singularity-flow sync');
});
