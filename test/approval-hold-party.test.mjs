/**
 * The list says who really clears a hold, and what holds the approval comes first [study 6.7].
 *
 * Every hold shape once read "Someone else decides", no group, `allowed: true`: the refusal knew who
 * decides and the hold dropped it. On a real list `holding` said 0, `heldBy` named d2, the headline
 * said "1 decision needed" and `next` sent the person to d1, which held nothing. A dirty checkout,
 * the top real refusal of /sf-approve, passed "every check" until the door refused it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { approvalHold } from '../src/approval-check.mjs';
import { decisionPacket } from '../src/decision-list.mjs';
import { SingularityFlowError } from '../src/util.mjs';

const AT = '2026-11-06T00:00:00.000Z';
const ME = { name: 'Reviewer', email: 'reviewer@example.test' };
const OTHER = { name: 'Other', email: 'other@example.test' };
const SOMEONE = { email: 'someone@example.test' };
const AUTHORITIES = {
  engineering: { label: 'Engineering reviewers', members: [ME, OTHER] },
  planners: { label: 'Plan approvers', members: [ME] },
  risk: { label: 'Risk reviewers', members: [OTHER] }
};

/** Implementation awaits approval, planning and release have their own groups. */
function story({ status = 'awaiting_approval', testRecovery = { riskAuthorities: ['risk'] }, approvalPolicy = {} } = {}) {
  const step = (id, label, stepStatus, policy) => ({ id, label, status: stepStatus, generation: 1, approvals: [],
    approvalPolicy: { authorities: policy, minimum: 1, ...(id === 'implementation' ? approvalPolicy : {}) } });
  return { workItem: { id: 'W-1' }, currentPhase: 'implementation', phaseOrder: ['planning', 'implementation', 'release'],
    phases: { planning: step('planning', 'Planning', 'approved', ['planners']), implementation: step('implementation', 'Implementation', status, ['engineering']),
      release: step('release', 'Release', 'pending', ['engineering']) },
    resolution: { approvalAuthorities: AUTHORITIES, testRecovery } };
}

const refusal = (code, details = {}, message = `${code} refused.`) => new SingularityFlowError(message, { code, details });

/** The list for this refusal, through the real hold mapping, as `actor` sees it. */
function listFor(error, { actor = ME, workflow = story(), facts = {} } = {}) {
  const hold = approvalHold(error, workflow, workflow.phases.implementation);
  const packet = decisionPacket(workflow, { phaseId: 'implementation', pending: {}, ...facts, approvalCheck: { holds: [hold] } },
    { authorities: AUTHORITIES, actor, at: AT });
  return { hold, packet, item: packet.items.find((entry) => entry.kind !== 'approval' && entry.holdsApproval) };
}

test('the whole message is kept, <WORK-ID> is filled, and a list lead never ends a line on a colon', () => {
  const session = listFor(new SingularityFlowError('No active agent session. Run singularity-flow resume <WORK-ID>.', { details: { nextAction: 'singularity-flow resume <WORK-ID>' } }));
  assert.equal(session.hold.summary, 'No active agent session. Run singularity-flow resume W-1.');
  assert.equal(session.hold.action.command, 'singularity-flow resume W-1');
  assert.doesNotMatch(JSON.stringify(session.packet), /<WORK-ID>/u);
  const lead = approvalHold(refusal('APPROVAL_AGENT_BRIEF_INVALID', {}, 'Phase implementation downstream agent-brief review failed:\n- one\n- two'), story(), story().phases.implementation);
  assert.equal(lead.summary, 'Phase implementation downstream agent-brief review failed: one; two');
  assert.equal(lead.message, 'Phase implementation downstream agent-brief review failed:\n- one\n- two');
  const single = approvalHold(refusal('APPROVAL_AGENT_BRIEF_INVALID', {}, 'One line.'), story(), story().phases.implementation);
  assert.equal(single.message, undefined, 'the summary already says all of it');
  // Each named amendment of a two-amendment hold still holds its item, though the first line names neither.
  const two = refusal('APPROVAL_INTENT_AMENDMENT_PENDING', { scopePhase: 'planning' }, 'Approving implementation waits for 2 intent amendments to be decided.\nIntent amendment AMD-001 changes one.\nIntent amendment AMD-002 changes two.');
  const { packet } = listFor(two, { facts: { pending: { intentAmendments: [{ id: 'AMD-001', status: 'proposed' }, { id: 'AMD-002', status: 'proposed' }] } } });
  assert.deepEqual(packet.items.filter((item) => item.kind === 'intent-amendment').map((item) => item.holdsApproval), [true, true]);
});
