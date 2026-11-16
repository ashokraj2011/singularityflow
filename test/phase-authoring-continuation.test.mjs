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
import { phaseAuthoringEntry } from '../src/phase-authoring-entry.mjs';

/**
 * A document step's next version opened as Stage 2 opens it: its reservation, and the opening operation's record of it
 * (story-version-opening.mjs). A reservation alone is an older build's local one, promoted on the person's yes [OSA §14].
 */
function openThroughOperation(workflow, phase) {
  const reserved = reservePreparedDocumentSuccessor(workflow, phase, '2026-10-07T00:00:00Z');
  const version = Number(phase.generation) + 1;
  const operationId = `vo-${'3'.repeat(32)}`;
  phase.versionOpening = { operationId, version, highWatermark: version, writer: { fence: 1, writerId: `vw-${'4'.repeat(32)}`, operationId } };
  return reserved;
}

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
    // Reviewed because it defines the scope, whatever it is called.
    workflow.resolution.obligationGraph = { nodes: [{ id, responsibilities: ['scope'] }] };
    assert.equal(phaseNeedsGeneration(workflow, phase), false);
    assert.equal(openThroughOperation(workflow, phase), true);
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
    // A pin listing a step that neither defines the scope nor plans the claims owes it no review.
    workflow.resolution.obligationGraph.nodes[0].responsibilities = ['review'];
    assert.equal(phaseHandoff(workflow, phase)[0].command, `singularity-flow submit ${id}`);
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
  for (const id of ['specification', 'planning', 'verification', 'convergence', 'release', 'design', 'customer-scope']) {
    const workflow = story(id), phase = workflow.phases[id];
    const sourceReviewEvidence = { status: 'correction-required', findings: [{ code: 'reviewer-blocker' }], pendingDispositions: [] };
    // Stage 2: a document's next version opens on the person's yes, through the step's preview [D3, journey I].
    const expected = `singularity-flow phase rollover ${id} --json`;
    assert.equal(phaseHandoff(workflow, phase, { sourceReviewEvidence })[0].command, expected);
    assert.equal(workflowGuide(workflow, { sourceReviewEvidence }).nextActions[0].command, expected);
    assert.equal(nextStepsSnapshot({ workflow, sourceReviewEvidence }).actions[0].command, expected);
    const definition = { workTypes: { custom: { fastPath: { specify: { milestone: 'done', phases: [id] } } } } };
    const fast = planFastPath(workflow, definition, 'specify', { sourceReviewEvidence });
    assert.equal(fast.next[0].command, expected);
    const before = JSON.stringify(workflow);
    const entry = phaseAuthoringEntry(workflow, phase, { review: sourceReviewEvidence });
    assert.equal(entry.status, 'successor-confirmation-required');
    assert.equal(entry.targetGeneration, 2);
    assert.equal(entry.successor.preview.command, expected);
    assert.match(entry.successor.question, /^Start version 2 of [\w-]+ to fix the review's findings\? Published version 1 will stay unchanged\.$/u);
    assert.equal(JSON.stringify(workflow), before, 'entry cannot reserve or compose a successor');
    // Once the person's yes opened it through the operation, the entry writes it.
    openThroughOperation(workflow, phase);
    assert.equal(phaseAuthoringEntry(workflow, phase, { review: sourceReviewEvidence }).status, 'authoring-entry');
    assert.equal(phase.generation, 1, 'routing is not publication or approval');
  }
});

test('human dispositions, stale bindings and submitted phases never become automatic author corrections', () => {
  const workflow = story('custom-scope'), phase = workflow.phases['custom-scope'];
  const pending = { status: 'correction-required', findings: [{ code: 'human-disposition-required' }],
    pendingDispositions: [{ id: 'exclusion:row-1' }] };
  assert.match(sourceReviewContinuation(workflow, phase, pending).nextCommand, /review-source decision-context custom-scope.*--finding exclusion:row-1/);
  assert.equal(sourceReviewContinuation(workflow, phase, { status: 'stale', findings: [{ code: 'review-binding-stale' }] }).nextSkill, '/sf-review-source');
  assert.equal(phaseAuthoringEntry(workflow, phase, { review: pending }).status, 'retained-generation');
  assert.equal(phaseAuthoringEntry(workflow, phase, { review: { status: 'stale' } }).status, 'retained-generation');
  assert.equal(phaseAuthoringEntry(workflow, phase, { reviewError: { code: 'SOURCE_REVIEW_INPUT_UNPUBLISHED' } }).status, 'attention-required');
  phase.status = 'awaiting_approval';
  assert.equal(sourceReviewContinuation(workflow, phase, { status: 'correction-required', findings: [{ code: 'reviewer-blocker' }] }).nextSkill, '/sf-nextsteps');
  assert.equal(phase.reworkRevalidation, undefined);
  assert.equal(phaseAuthoringEntry(workflow, phase, { review: { status: 'correction-required', findings: [{ code: 'reviewer-blocker' }] } }).status, 'retained-generation');
});

test('code and sign-off phases never receive implicit document successor preparation', () => {
  // A code step asks the person to start its next version instead (owner, 2026-11-16); neither prepares a document successor.
  for (const [change, status] of [[p => { p.generationPolicy.task = 'code'; p.generationIntent = { status: 'consumed', generation: 1 }; }, 'successor-confirmation-required'],
    [p => { p.generationPolicy.requirement = 'none'; }, 'retained-generation']]) {
    const workflow = story('custom-step'), phase = workflow.phases['custom-step']; change(phase);
    const entry = phaseAuthoringEntry(workflow, phase, { review: { status: 'correction-required', findings: [{ code: 'reviewer-blocker' }] } });
    assert.equal(entry.status, status);
    assert.equal(entry.preparation, undefined);
    assert.equal(entry.successor?.preparation, undefined);
  }
});

test('a code step returned for rework is written again, other code successors keep guarded rollover, ready reviews keep decision inputs', () => {
  const workflow = story('custom-code'), phase = workflow.phases['custom-code'];
  phase.generationPolicy.task = 'code';
  phase.generationIntent = { status: 'consumed', generation: 1 };
  phase.reworkRevalidation = { generation: 1, invalidatedAt: 'now' };
  const before = JSON.stringify(workflow);
  // Stage 2: a return opens its next version on the person's yes too [D3]: the one rollover preview its entry, edit
  // permission and task name [OSA:REQ-010, REQ-030, C13]; the entry asks it.
  assert.equal(sourceReviewContinuation(workflow, phase).nextCommand, 'singularity-flow phase rollover custom-code --json');
  const asked = phaseAuthoringEntry(workflow, phase);
  assert.equal(asked.status, 'successor-confirmation-required');
  assert.equal(asked.reason, 'rework');
  assert.equal(JSON.stringify(workflow), before);
  delete phase.reworkRevalidation;
  const corrected = sourceReviewContinuation(workflow, phase, { status: 'correction-required', findings: [{ code: 'reviewer-blocker' }] });
  assert.equal(corrected.nextCommand, 'singularity-flow phase rollover custom-code --json');
  const scoped = story('scope'), scope = scoped.phases.scope;
  scoped.resolution.decisions = [{ id: 'risk', mode: 'auto', after: 'scope', inputs: [{ name: 'risk', type: 'enum', values: ['low', 'high'] }] }];
  const next = sourceReviewContinuation(scoped, scope, { status: 'ready' });
  assert.match(next.nextCommand, /submit scope --work-id ROUTE-1 --decision risk=<risk>/);
});

test('a later document correction advances only its explicit reservation, never an earlier publication', () => {
  const workflow = story('custom-plan'), phase = workflow.phases['custom-plan'];
  phase.generation = 7;
  phase.generationPublications = [{ generation: 7, record: { path: 'context/custom-plan-gen7.json' } }];
  const review = { status: 'correction-required', findings: [{ code: 'reviewer-blocker' }] };
  assert.equal(phaseAuthoringEntry(workflow, phase, { review }).targetGeneration, 8);
  openThroughOperation(workflow, phase);
  assert.equal(phaseAuthoringEntry(workflow, phase, { review }).status, 'authoring-entry');
  assert.equal(phaseInspectionGeneration(workflow, phase), 8);
  assert.equal(phase.generation, 7);
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
  assert.ok(phaseContinuationLines(next).some(line => line.startsWith('- Copilot: /sf-')));
  const historical = phaseContinuation(workflow, { reviewedPhaseId: 'previous-scope' });
  assert.equal(historical.nextCommand, 'singularity-flow nextsteps ROUTE-1 --json');
  assert.equal(historical.copilotCommand, '/sf-nextsteps');
  const recovery = phaseContinuation(workflow, { recovery: { requiresRecovery: true, phaseId: phase.id } });
  assert.equal(recovery.nextCommand, 'singularity-flow recover ROUTE-1 --phase customer-scope');
  assert.equal(recovery.nextSkill, '/sf-recover');
  const synchronization = phaseContinuation(workflow, { publicationPending: true });
  assert.equal(synchronization.nextCommand, 'singularity-flow sync');
});
