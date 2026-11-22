/**
 * A change the person asks for in a code step that already finished (daily run, 2026-11-22): the pure rules of
 * src/completed-step-change.mjs. Which finished code step a change goes back to, and when it does not, because a person
 * approved something it would undo; and the question the person answers. The whole path through the CLI is journey X in
 * test/journey-stories.test.mjs.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { completedChangeQuestion, completedCodeStepForChange } from '../src/completed-step-change.mjs';
import { SETTLED_KINDS } from '../src/settled-decisions.mjs';
import { settledOpening } from '../src/story-version-opening.mjs';
import { plainSettled } from '../src/decision-plain.mjs';

const person = { decision: 'approved', generation: 1, actor: 'a person' };
const story = ({ implement = {}, verify = {}, extra = null, resolution = {} } = {}) => {
  const phases = {
    intake: { id: 'intake', label: 'Scope and plan', status: 'approved', generation: 1, approvals: [person], approvalPolicy: { mode: 'required' } },
    implement: { id: 'implement', label: 'Implement', status: 'approved', generation: 1, generationPolicy: { task: 'code' }, approvalDisposition: 'not_required',
      approvals: [], approvalPolicy: { mode: 'none', rejectTo: ['implement'] }, ...implement },
    ...(extra ? { [extra.id]: extra } : {}),
    verify: { id: 'verify', label: 'Verify', status: 'awaiting_approval', generation: 1, generationPolicy: { task: 'analyze' }, approvals: [],
      approvalPolicy: { mode: 'policy', rejectTo: ['intake', 'implement', 'verify'] }, ...verify }
  };
  return { workItem: { id: 'DLY-1' }, status: 'in_progress', currentPhase: 'verify',
    phaseOrder: ['intake', 'implement', ...(extra ? [extra.id] : []), 'verify'], phases, resolution };
};

test('a change goes back to the code step that finished without a person, while the later step waits or is being written', () => {
  assert.equal(completedCodeStepForChange(story())?.id, 'implement');
  assert.equal(completedCodeStepForChange(story(), { named: 'implement' })?.id, 'implement');
  assert.equal(completedCodeStepForChange(story({ verify: { status: 'in_progress', generation: 0 } }))?.id, 'implement', 'Verify not built yet');
  // Approved by SFlow, not a person, also counts.
  assert.equal(completedCodeStepForChange(story({ implement: { approvalDisposition: 'approved_automatically' } }))?.id, 'implement');
});

test('never when it would undo what a person approved, or where the step may not return work', () => {
  assert.equal(completedCodeStepForChange(story({ implement: { approvals: [person] } })), null, 'a person approved the code');
  assert.equal(completedCodeStepForChange(story({ verify: { approvals: [person], status: 'approved' } })), null, 'a person approved the later step');
  assert.equal(completedCodeStepForChange(story({ extra: { id: 'review', status: 'approved', approvals: [person] } })), null, 'a person approved a step between');
  assert.equal(completedCodeStepForChange(story({ extra: { id: 'review', status: 'approved', approvals: [], approvalDisposition: 'approved_automatically' } }))?.id, 'implement');
  assert.equal(completedCodeStepForChange(story({ verify: { approvalPolicy: { mode: 'policy', rejectTo: ['verify'] } } })), null, 'Verify may not return work to Implement');
  assert.equal(completedCodeStepForChange(story({ implement: { status: 'in_progress' } })), null, 'Implement has not finished: its own step asks');
  assert.equal(completedCodeStepForChange(story({ resolution: { presence: { required: true } } })), null, 'a Story that takes signatures');
  assert.equal(completedCodeStepForChange(story(), { named: 'intake' }), null, 'only a code step');
  assert.equal(completedCodeStepForChange(story(), { named: 'verify' }), null, 'only a step before the current one');
  assert.equal(completedCodeStepForChange({ ...story(), status: 'closed' }), null);
  // The current step writes code: its own step asks for the change, as before.
  const coding = story({ verify: { generationPolicy: { task: 'code' } } });
  assert.equal(completedCodeStepForChange(coding), null);
});

test('the question names the version it starts, what stays as published and what runs again', () => {
  const workflow = story();
  assert.equal(completedChangeQuestion(workflow, workflow.phases.implement, 2),
    'Start version 2 of Implement for this change? The Story goes back to Implement: version 1 and its tests stay as published, and Verify version 1 is set aside and runs again after it.');
  const unbuilt = story({ verify: { status: 'in_progress', generation: 0 } });
  assert.match(completedChangeQuestion(unbuilt, unbuilt.phases.implement, 2), /, and Verify runs after it\.$/u);
  // The yes binding reads "start … version 2" in it, as for every version question.
  assert.match(completedChangeQuestion(workflow, workflow.phases.implement, 2), /\bstart\b[^?]*\bversion 2\b/iu);
});

test('its version starts on the person\'s yes, recorded with the words the decisions list says it in', () => {
  assert.ok(SETTLED_KINDS.includes('person-change'));
  const settlement = { kind: 'person-change', settlement: { kind: 'person-change' } };
  assert.equal(settledOpening(settlement, { reason: 'rejected' }), true);
  assert.equal(settledOpening(settlement, { reason: 'requested-change' }), false, 'never for a version the person did not go back for');
  const said = plainSettled(story(), { id: 'STL-001', kind: 'person-change', by: 'sflow', phase: 'implement', subject: 's', answer: 'a',
    evidence: [{ what: 'w', where: 'x' }], effect: { generation: 1, toGeneration: 2, byPerson: 'CR-001' }, at: '2026-11-22T00:00:00.000Z' });
  assert.match(JSON.stringify(said), /went back to Implement and started version 2 for the change you asked for, because you said yes/u);
});
