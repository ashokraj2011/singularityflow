/**
 * SPEC-OSA Stage 1: one answer to "is this step being written now?" (stepBeingWritten) [OSA:REQ-002, REQ-010, REQ-012,
 * REQ-020, REQ-032]. A real Story (2026-11-16) opened version 2 of its code step, and six tests disagreed about it: the
 * edit permission said "write it", while submission readiness said "review version 1" or "ready to submit", the
 * authoring task was missing so the turn could end, and next steps put the Story's ending decisions first.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { stepBeingWritten } from '../src/phase-generation-need.mjs';
import { requiresProspectivePhaseInspection } from '../src/phase-generation-need.mjs';
import { deriveMutationContract } from '../src/phase-mutation-contract.mjs';
import { phaseAuthoringProgress } from '../src/phase-authoring-progress.mjs';
import { sourceReviewContinuation } from '../src/source-review-continuation.mjs';
import { submissionReadinessSnapshot } from '../src/submission-readiness.mjs';
import { sequenceGuidance, storyNextDetails } from '../src/sequence.mjs';
import { workflowNextSteps } from '../src/nextsteps.mjs';
import { workflowGuide } from '../src/guide.mjs';

const RECORD = { path: 'singularity/work-items/OSA-1/publications/x.json', sha256: `sha256:${'a'.repeat(64)}` };

/** A Story at its last step, a code step published at version 1 and its review asking for nothing yet. */
function story({ code = true, review = false, phase: changes = {}, gates = null } = {}) {
  const id = code ? 'implement' : 'design';
  const phase = { id, label: code ? 'Implement' : 'Design', status: 'in_progress', generation: 1,
    writeScope: code ? 'source-and-artifact' : 'artifact-only',
    generationPolicy: { requirement: 'required', task: code ? 'code' : 'document', defaultProducer: 'governed-agent', allowedProducers: ['governed-agent'] },
    requiredArtifact: { path: `artifacts/${id}/summary.md`, kind: code ? 'implementation-summary' : 'document' },
    generationIntent: code ? { status: 'consumed', generation: 1 } : undefined,
    generationPublications: [{ generation: 1, record: RECORD }], approvalPolicy: { mode: 'required' }, ...changes };
  return { workItem: { id: 'OSA-1' }, status: 'in_progress', currentPhase: id, phaseOrder: [id], phases: { [id]: phase }, history: [],
    resolution: { ...(review ? { sourceReview: { mode: 'enforce', phases: [id], kinds: { [id]: code ? 'code' : 'planning' }, reviewerAgent: 'sflow-source-reviewer' } } : {}),
      ...(gates ? { sequenceGates: gates } : {}) } };
}
/**
 * Version `generation` open, as the opening operation opens it (Stage 2): the intent with its shared opening record. An
 * intent alone is an older build's local opening, which a successor promotes on the person's yes first [OSA §14].
 */
const open = (workflow, generation = 2) => {
  const phase = workflow.phases[workflow.currentPhase];
  phase.generationIntent = { status: 'open', generation };
  const operationId = `vo-${'1'.repeat(32)}`;
  phase.versionOpening = { operationId, version: generation, highWatermark: generation, writer: { fence: 1, writerId: `vw-${'2'.repeat(32)}`, operationId } };
  return phase;
};

test('one "being written" answer: version 1, an open next version, a rework; never a published or submitted step', () => {
  const cases = [
    ['version 1 not yet published', (w) => Object.assign(w.phases[w.currentPhase], { generation: 0, generationIntent: undefined, generationPublications: [] }), true],
    ['version 1 published', () => {}, false],
    ['version 2 open', (w) => open(w), true],
    ['returned for rework', (w) => Object.assign(w.phases[w.currentPhase], { reworkRevalidation: { generation: 1 } }), true],
    ['submitted', (w) => Object.assign(w.phases[w.currentPhase], { status: 'awaiting_approval' }), false],
    ['submitted with version 2 open', (w) => { open(w); w.phases[w.currentPhase].status = 'awaiting_approval'; }, false]
  ];
  for (const [name, change, expected] of cases) {
    const workflow = story();
    change(workflow);
    assert.equal(stepBeingWritten(workflow, workflow.phases[workflow.currentPhase]), expected, name);
  }
});

test('"may write" and "may edit" are one test: the entry\'s inspection and the edit permission agree in every state [C7]', () => {
  const states = [];
  for (const code of [true, false]) for (const status of ['not_started', 'in_progress', 'awaiting_approval', 'approved'])
    for (const generation of [0, 1, 2]) for (const intent of [null, 'open-next', 'open-stale', 'consumed', 'superseded'])
      for (const reason of [null, 'rework', 'rejected', 'skill-amendment']) for (const record of [true, false])
        for (const requirement of ['required', 'none']) states.push({ code, status, generation, intent, reason, record, requirement });
  let disagreements = [];
  for (const state of states) {
    const workflow = story({ code: state.code });
    const phase = workflow.phases[workflow.currentPhase];
    Object.assign(phase, { status: state.status, generation: state.generation,
      generationPolicy: { ...phase.generationPolicy, requirement: state.requirement },
      generationPublications: state.record && state.generation > 0 ? [{ generation: state.generation, record: RECORD }] : [] });
    phase.generationIntent = state.intent === 'open-next' ? { status: 'open', generation: state.generation + 1 }
      : state.intent === 'open-stale' ? { status: 'open', generation: Math.max(1, state.generation) }
        : state.intent ? { status: state.intent, generation: state.generation } : undefined;
    if (state.reason === 'rework') phase.reworkRevalidation = { generation: state.generation };
    if (state.reason === 'rejected') phase.rejectedAt = '2026-11-16T09:00:00.000Z';
    if (state.reason === 'skill-amendment') phase.skillAmendmentRevalidation = { state: 'affected', generationAtAdoption: state.generation };
    const inspection = requiresProspectivePhaseInspection(workflow, phase);
    const editable = deriveMutationContract({ definition: {}, workflow }).policy.editable;
    if (inspection !== editable || inspection !== stepBeingWritten(workflow, phase)) disagreements.push({ state, inspection, editable });
  }
  assert.ok(states.length > 900, states.length);
  assert.deepEqual(disagreements.slice(0, 5), [], `${disagreements.length} states disagree`);
});

test('the three states the two tests once split on are not being written: nothing can be written there [C7]', () => {
  // An open version at or below the published one: publication would refuse it (requireOpenGenerationIntent).
  const stale = story(); open(stale, 1);
  // A version with no publication record and no consumed intent: readiness calls it a missing record.
  const unrecorded = story({ code: false, phase: { generationPublications: [] } });
  // A sign-off step with no output at version 0: it drafts nothing.
  const signOff = story({ code: false, phase: { generation: 0, generationPublications: [], generationPolicy: { requirement: 'none' } } });
  for (const [name, workflow] of [['stale open version', stale], ['unrecorded version', unrecorded], ['sign-off step', signOff]]) {
    const phase = workflow.phases[workflow.currentPhase];
    assert.equal(stepBeingWritten(workflow, phase), false, name);
    assert.equal(requiresProspectivePhaseInspection(workflow, phase), false, name);
    assert.equal(deriveMutationContract({ definition: {}, workflow }).policy.editable, false, name);
  }
});

test('an open next version has its authoring task, so the turn is held until it is published [OSA:REQ-012, C5]', () => {
  for (const code of [true, false]) {
    const workflow = story({ code });
    const phase = open(workflow);
    const progress = phaseAuthoringProgress(workflow, phase, { draftEvidence: { draftExists: true, draftModified: false } });
    assert.ok(progress, `${code ? 'code' : 'document'}: an open version 2 has a task`);
    assert.equal(progress.generation, 2);
    assert.equal(progress.next.command, `singularity-flow prepare ${phase.id}`);
    assert.equal(progress.next.copilotCommand, code ? '/sf-code' : '/sf-phase');
    // The guide's "now" is that task's next stage.
    assert.equal(workflowGuide(workflow, { authoringProgress: progress }).nextActions[0].command, progress.next.command);
  }
  // Published with nothing open: no task.
  const published = story();
  assert.equal(phaseAuthoringProgress(published, published.phases.implement), null);
});

test('the review continuation of a step with version 2 open is writing it, never reviewing version 1 [OSA:REQ-032, C2]', () => {
  const workflow = story({ review: true });
  const phase = open(workflow);
  for (const review of [null, { status: 'successor-publication-required', findings: [] }, { status: 'staged', findings: [] }]) {
    const continuation = sourceReviewContinuation(workflow, phase, review);
    assert.equal(continuation.classification, 'successor-publication-required', JSON.stringify(review));
    assert.equal(continuation.nextCommand, 'singularity-flow prepare implement');
    assert.equal(continuation.copilotCommand, '/sf-code');
    assert.equal(continuation.targetGeneration, 2);
    assert.match(continuation.presentation, /^Now — Write version 2 of Implement/u);
    assert.doesNotMatch(JSON.stringify(continuation.actions), /review-source|\/sf-review-source|\bsubmit\b/u);
  }
});

test('submission readiness never says "ready to submit" or "review version 1" while version 2 is open, soft gates too [OSA:REQ-032, C2]', () => {
  for (const review of [false, true]) for (const gates of [null, { default: 'soft' }]) {
    const workflow = story({ review, gates });
    open(workflow);
    const readiness = submissionReadinessSnapshot(workflow, { sourceReviewEvidence: review ? { status: 'ready', findings: [] } : null });
    const name = `${review ? 'reviewed' : 'no review'}, ${gates ? 'soft' : 'hard'} gates`;
    assert.equal(readiness.classification, 'generation-required', name);
    assert.equal(readiness.lifecycleReady, false, name);
    assert.equal(readiness.nextCommand ?? readiness.command, 'singularity-flow prepare implement', name);
    assert.equal(readiness.nextSkill, '/sf-code', name);
  }
  // Published, nothing open, no review owed: ready to submit, as before.
  assert.equal(submissionReadinessSnapshot(story()).classification, 'ready-to-attempt');
});

test('the sequence guidance and a refusal\'s "next for this Story" write the open version [C2, C21]', () => {
  const workflow = story({ review: true });
  open(workflow);
  const guidance = sequenceGuidance(workflow);
  assert.equal(guidance.actions[0].command, 'singularity-flow prepare implement');
  assert.equal(guidance.actions[0].skill, '/sf-code');
  assert.match(guidance.summary, /^Write version 2 of implement/u);
  assert.equal(storyNextDetails(workflow).nextAction.command, 'singularity-flow prepare implement');
});

test('next steps: writing the open version is "now", then its publication, review and submission; the ending decisions wait [C5, C18]', () => {
  const workflow = story({ review: true });
  const phase = open(workflow);
  const authoringProgress = phaseAuthoringProgress(workflow, phase);
  const steps = workflowNextSteps(workflow, { authoringProgress });
  const now = steps.filter((entry) => entry.timing === 'now');
  assert.equal(now.length, 1, JSON.stringify(steps.map((entry) => [entry.timing, entry.command])));
  assert.equal(now[0].command, 'singularity-flow prepare implement');
  const then = steps.filter((entry) => entry.timing === 'then').map((entry) => entry.command);
  assert.ok(then.some((command) => /^singularity-flow phase publish implement\b/u.test(command)), then.join('\n'));
  assert.ok(then.some((command) => /^singularity-flow review-source context implement\b/u.test(command)), then.join('\n'));
  assert.ok(then.indexOf(then.find((command) => /review-source/u.test(command))) > then.indexOf(then.find((command) => /phase publish/u.test(command))));
});

test('next steps: a review asking corrections leads with starting the next version, the inputs read after it [OSA:REQ-020]', () => {
  const workflow = story({ review: true });
  Object.assign(workflow.resolution, { inputsMode: 'enforce', phases: [{ id: 'implement', inputs: ['intake'] }] });
  const steps = workflowNextSteps(workflow, { sourceReviewEvidence: { status: 'correction-required', findings: [{ code: 'reviewer-blocker', message: 'Fix it.' }] } });
  const now = steps.filter((entry) => entry.timing === 'now');
  assert.deepEqual(now.map((entry) => entry.command), ['singularity-flow phase rollover implement --json'], JSON.stringify(steps.map((entry) => [entry.timing, entry.command])));
  assert.ok(steps.some((entry) => entry.timing === 'then' && entry.command === 'singularity-flow inputs implement'));
});
