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
