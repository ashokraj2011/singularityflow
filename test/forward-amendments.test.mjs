import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acceptedRevalidationBindings, forwardAmendmentTerminalBlockers, pendingAmendmentRevalidations, pendingForwardAmendments
} from '../src/forward-amendments.mjs';

function story() {
  return { workItem: { id: 'FAM-STORY' }, phaseOrder: ['intake', 'design', 'detail', 'build'],
    phases: { intake: { id: 'intake', status: 'approved', generation: 2 }, design: { id: 'design', status: 'approved', generation: 1 },
      detail: { id: 'detail', status: 'approved', generation: 3 }, build: { id: 'build', status: 'in_progress', generation: 1 } },
    forwardAmendments: [{ id: 'FAM-001', phase: 'intake' }, { id: 'FAM-002', phase: 'design' }],
    forwardAmendmentDecisions: [{ amendment: 'FAM-001', phase: 'intake', decision: 'approved',
      revalidate: [{ phase: 'design', generation: 1 }, { phase: 'detail', generation: 3 }] }] };
}

test('an approved amendment owes a revalidation for each listed step until it is recorded', () => {
  const workflow = story();
  assert.deepEqual(pendingForwardAmendments(workflow).map((entry) => entry.id), ['FAM-002']);
  assert.deepEqual(pendingAmendmentRevalidations(workflow).map((entry) => entry.phase), ['design', 'detail']);
  workflow.amendmentRevalidations = [{ amendment: 'FAM-001', phase: 'design', outcome: 'unchanged' }];
  assert.deepEqual(pendingAmendmentRevalidations(workflow).map((entry) => entry.phase), ['detail']);
  // A step sent back for rework reads its inputs again; nothing is owed for it.
  workflow.phases.detail = { ...workflow.phases.detail, status: 'not_started' };
  assert.deepEqual(pendingAmendmentRevalidations(workflow), []);
  workflow.phases.detail = { ...workflow.phases.detail, status: 'approved', generation: 4 };
  assert.deepEqual(pendingAmendmentRevalidations(workflow), [], 'a newer generation is not the one that was listed');
  const blockers = forwardAmendmentTerminalBlockers(story());
  assert.deepEqual(blockers.map((entry) => entry.code), ['FORWARD_AMENDMENT_PENDING', 'AMENDMENT_REVALIDATION_REQUIRED', 'AMENDMENT_REVALIDATION_REQUIRED']);
  assert.match(blockers[1].command, /^singularity-flow upstream-issue revalidate design --work-id FAM-STORY --amendment FAM-001 /u);
});

test('a revalidation binds the step generation and its exact input record', () => {
  const workflow = story();
  const binding = { producer: 'intake', producerGeneration: 2, producerSha256: 'a'.repeat(64), inputRecordSha256: 'b'.repeat(64) };
  workflow.amendmentRevalidations = [
    { amendment: 'FAM-001', phase: 'design', generation: 1, outcome: 'unchanged', binding },
    { amendment: 'FAM-001', phase: 'detail', generation: 3, outcome: 'return', binding: null }
  ];
  assert.deepEqual([...acceptedRevalidationBindings(workflow, workflow.phases.design, 'b'.repeat(64)).keys()], ['intake']);
  assert.equal(acceptedRevalidationBindings(workflow, workflow.phases.design, 'c'.repeat(64)).size, 0, 'another input record is not vouched for');
  assert.equal(acceptedRevalidationBindings(workflow, { ...workflow.phases.design, generation: 2 }, 'b'.repeat(64)).size, 0);
  assert.equal(acceptedRevalidationBindings(workflow, workflow.phases.detail, 'b'.repeat(64)).size, 0, 'a return vouches for nothing');
});

test('an intent amendment that updated the spec to the code owes a row for each step it listed, the report\'s own while it awaits approval [SCS:REQ-022]', () => {
  const workflow = { workItem: { id: 'ORD-7' }, phaseOrder: ['intake', 'implementation', 'testing', 'conformance'],
    phases: { intake: { id: 'intake', status: 'approved', generation: 2 }, implementation: { id: 'implementation', status: 'approved', generation: 1 },
      testing: { id: 'testing', status: 'approved', generation: 1 }, conformance: { id: 'conformance', status: 'awaiting_approval', generation: 1 } },
    intentAmendments: [{ id: 'AMD-001', status: 'approved', producer: 'intake',
      revalidate: [{ phase: 'implementation', generation: 1 }, { phase: 'testing', generation: 1 }, { phase: 'conformance', generation: 1 }] },
    { id: 'AMD-002', status: 'approved', changedClauses: ['ORD-7:REQ-001'] }] };
  assert.deepEqual(pendingAmendmentRevalidations(workflow).map((entry) => [entry.amendment, entry.phase, entry.producer]),
    [['AMD-001', 'implementation', 'intake'], ['AMD-001', 'testing', 'intake'], ['AMD-001', 'conformance', 'intake']],
    'an amendment that reopened its steps lists none');
  workflow.amendmentRevalidations = [{ amendment: 'AMD-001', phase: 'testing', generation: 1, outcome: 'unchanged' }];
  workflow.phases.conformance = { ...workflow.phases.conformance, status: 'in_progress' };
  assert.deepEqual(pendingAmendmentRevalidations(workflow).map((entry) => entry.phase), ['implementation'],
    'answered once, and a report returned for a new one reads the amended scope');
  assert.match(forwardAmendmentTerminalBlockers(workflow)[0].command, /upstream-issue revalidate implementation --work-id ORD-7 --amendment AMD-001 /u);
});
