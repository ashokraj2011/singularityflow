import test from 'node:test';
import assert from 'node:assert/strict';
import { epicJourney, nextInitiativeAction, NEXT_ACTIONS } from '../src/initiative-next.mjs';

const definition = {
  id: 'epic-requirements',
  label: 'Requirements',
  outputs: [
    { id: 'spec', label: 'Requirements specification', required: true },
    { id: 'trace', label: 'Traceability', required: true },
    { id: 'gaps', label: 'Source gaps', required: false }
  ]
};

function initiative(phase, { currentPhase = 'epic-requirements' } = {}) {
  return { currentPhase, resolution: { phases: [definition] }, phases: { 'epic-requirements': phase } };
}

test('an unauthored phase asks for the outputs it is actually waiting on', () => {
  const next = nextInitiativeAction(initiative({
    status: 'in_progress', generation: 0, outputs: { spec: {}, trace: { sha256: 'a', status: 'draft' }, gaps: {} }
  }));
  assert.equal(next.action, NEXT_ACTIONS.AUTHOR);
  // Only the unauthored required output is named. Listing everything, or counting the optional one,
  // would send the user looking for work that is already done or was never needed.
  assert.deepEqual(next.outputs, ['spec']);
  assert.match(next.title, /1 required output/);
});

test('an optional output left blank does not hold up publication', () => {
  // The engine reports a missing output only when its definition is required, so the next action
  // must agree — otherwise the app asks for a document the gate does not want.
  const next = nextInitiativeAction(initiative({
    status: 'in_progress',
    generation: 0,
    outputs: { spec: { sha256: 'a', status: 'draft' }, trace: { sha256: 'b', status: 'draft' }, gaps: {} }
  }));
  assert.equal(next.action, NEXT_ACTIONS.PUBLISH);
  assert.match(next.command, /initiative phase publish epic-requirements/);
});

test('a published phase with an unevidenced blocking gate asks for evidence, not approval', () => {
  const next = nextInitiativeAction(
    initiative({ status: 'awaiting_approval', generation: 1, outputs: {} }),
    null,
    { checklist: [
      { id: 'requirements-traceable', label: 'Traceable', gate: 'block', status: 'satisfied' },
      { id: 'material-questions-resolved', label: 'Questions resolved', gate: 'block', status: 'missing' }
    ] }
  );
  assert.equal(next.action, NEXT_ACTIONS.EVIDENCE);
  assert.deepEqual(next.checks, ['material-questions-resolved']);
});

test('a warn-level gate does not block, and a satisfied phase offers approval with its exact string', () => {
  const next = nextInitiativeAction(
    initiative({ status: 'awaiting_approval', generation: 2, outputs: {} }),
    null,
    { checklist: [
      { id: 'advisory', gate: 'warn', status: 'missing' },
      { id: 'traceable', gate: 'block', status: 'satisfied' }
    ] }
  );
  assert.equal(next.action, NEXT_ACTIONS.APPROVE);
  // The confirmation is exact and non-obvious; showing it is the difference between one attempt
  // and three.
  assert.equal(next.confirmation, 'epic-requirements:phase');
});

test('gates are only reported when an evaluation was supplied', () => {
  // Checklist status is derived from evidence records rather than stored, so with no evaluation
  // the honest answer is to offer approval rather than to claim gates are clear.
  const next = nextInitiativeAction(initiative({ status: 'awaiting_approval', generation: 1, outputs: {} }));
  assert.equal(next.action, NEXT_ACTIONS.APPROVE);
});

test('a phase that is not the active one is reported as blocked rather than actionable', () => {
  // The engine is sequence-aware and refuses work on any other phase; offering an action here
  // would produce exactly the refusal this is meant to prevent.
  const next = nextInitiativeAction(
    initiative({ status: 'in_progress', generation: 0, outputs: {} }, { currentPhase: 'epic-intake' }),
    'epic-requirements'
  );
  assert.equal(next.action, NEXT_ACTIONS.BLOCKED);
  assert.match(next.detail, /is at 'epic-intake'/);
});

test('approved and completed states resolve without inventing work', () => {
  assert.equal(nextInitiativeAction(initiative({ status: 'approved', generation: 1, outputs: {} })).action, NEXT_ACTIONS.ADVANCE);
  assert.equal(nextInitiativeAction({ currentPhase: null, phases: {}, resolution: { phases: [] } }).action, NEXT_ACTIONS.COMPLETE);
});

test('unknown input is reported rather than thrown, because this renders in a status bar', () => {
  assert.equal(nextInitiativeAction(null).action, NEXT_ACTIONS.BLOCKED);
  assert.equal(nextInitiativeAction(initiative({ status: 'in_progress', outputs: {} }), 'no-such-phase').action, NEXT_ACTIONS.BLOCKED);
});

test('Epic journey projects the governed phase into a business-friendly stage and CTA', () => {
  const state = {
    currentPhase: 'epic-plan',
    status: 'in_progress',
    phaseOrder: ['epic-intake', 'epic-requirements', 'epic-plan', 'epic-spec', 'epic-create'],
    phases: {
      'epic-intake': { status: 'approved' },
      'epic-requirements': { status: 'approved' },
      'epic-plan': { status: 'in_progress' }
    }
  };
  const journey = epicJourney(state, [{ action: 'author-and-publish', command: 'singularity-flow initiative phase publish epic-plan', reason: 'Review the Story plan.' }]);
  assert.equal(journey.stage, 'planning');
  assert.equal(journey.activeStep, 2);
  assert.equal(journey.nextAction.label, 'Publish Planning');
  assert.equal(journey.stages[0].status, 'complete');
  assert.equal(journey.stages[3].status, 'upcoming');
});

test('completed Epic journey exposes a report CTA and reaches 100 percent', () => {
  const journey = epicJourney({ status: 'complete', currentPhase: null, phaseOrder: [], phases: {} }, []);
  assert.equal(journey.stage, 'complete');
  assert.equal(journey.completionPercent, 100);
  assert.equal(journey.nextAction.id, 'report');
});
