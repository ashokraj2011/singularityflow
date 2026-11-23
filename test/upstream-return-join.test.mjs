import assert from 'node:assert/strict';
import test from 'node:test';
import { upstreamReturnJoin } from '../src/upstream-routes.mjs';
import { commitAmendmentRevalidation } from '../src/commands/upstream-issue.mjs';

// d-story (2026-11-23): "Return the work to Verification" for two issues about Verification returned the first; the second
// was refused, as no later step was left to return from, and the card offered only a dated risk or a dismissal. A return the
// work already makes through a step is joined, never refused and never made twice. The CLI walk is in
// lifecycle-unhappy-paths.test.mjs ("two issues about one step sent back together are one return").

const story = (overrides = {}) => ({
  workItem: { id: 'W' }, status: 'in_progress', currentPhase: 'implementation', phaseOrder: ['intake', 'implementation', 'testing', 'release'],
  phases: { intake: { id: 'intake', status: 'approved' }, implementation: { id: 'implementation', status: 'in_progress' },
    testing: { id: 'testing', status: 'pending' }, release: { id: 'release', status: 'pending' } },
  changeRequests: [{ id: 'CR-001', status: 'open', targetPhase: 'implementation', requestedAt: '2026-11-23T10:00:00.000Z' }],
  ...overrides
});

test('an open return joins an issue about its step or a later one, raised before it', () => {
  const issue = (phase, at = '2026-11-23T09:00:00.000Z') => ({ id: 'UPI-002', phase, at });
  assert.equal(upstreamReturnJoin(story(), issue('implementation'))?.id, 'CR-001', 'the step it returned to');
  assert.equal(upstreamReturnJoin(story(), issue('testing'))?.id, 'CR-001', 'a later step runs again after it');
  assert.equal(upstreamReturnJoin(story(), issue('intake')), null, 'an earlier step is not redone by it');
  assert.equal(upstreamReturnJoin(story(), issue('implementation', '2026-11-23T11:00:00.000Z')), null, 'raised after the return: the redo never read it');
  assert.equal(upstreamReturnJoin(story({ currentPhase: 'release' }), issue('testing')), null, 'the Story is past the step again');
  assert.equal(upstreamReturnJoin(story({ status: 'completed' }), issue('implementation')), null);
  const resolved = story();
  resolved.changeRequests[0].status = 'resolved';
  assert.equal(upstreamReturnJoin(resolved, issue('implementation')), null, 'a resolved return is no redo under way');
});

test('a second "redo" after an amendment joins the return that already reset its step, and writes nothing', async () => {
  // The first answer returned the Story to implementation, which reset testing, so testing's row is no longer owed:
  // its own return used to stop the answers as "no revalidation owed" after the first was recorded.
  const workflow = story();
  const before = structuredClone(workflow);
  const value = await commitAmendmentRevalidation(null, null, workflow, { amendmentId: 'FAM-001', phaseId: 'testing', outcome: 'return',
    reason: 'Testing reads the amended plan, so it runs again.' }, { actor: null });
  assert.deepEqual(value, { amendment: 'FAM-001', phase: 'testing', outcome: 'return', link: 'CR-001', joined: true });
  assert.deepEqual(workflow, before, 'nothing written');
});
