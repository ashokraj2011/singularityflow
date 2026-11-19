/**
 * An upstream issue is on every step's decision list from the moment it is raised [owner, 2026-11-19, Q12]: raised at a
 * middle step against an earlier one, it shows there with what it holds (the Story's end), and nothing that stops the
 * step changes: the refusal lead and the pending count keep reading the issues only at the step that ends the Story.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { decisionPacket } from '../src/decision-list.mjs';
import { decisionRefusalLead } from '../src/decision-list-facts.mjs';
import { upstreamIssueStates } from '../src/upstream-routes.mjs';

const AT = '2026-11-19T09:00:00.000Z';
const actor = { name: 'Dev Person', email: 'dev@example.invalid', login: null };

function story(status = 'in_progress') {
  return {
    workItem: { id: 'EAR-101' }, status: 'in_progress', currentPhase: 'implementation',
    phaseOrder: ['requirements', 'implementation', 'release'],
    phases: {
      requirements: { id: 'requirements', label: 'Requirements', status: 'approved', generation: 1, approvalPolicy: { authorities: ['product-approvers'] } },
      implementation: { id: 'implementation', label: 'Implementation', status, generation: 1, approvalPolicy: { authorities: ['engineering-reviewers'] } },
      release: { id: 'release', label: 'Release', status: 'pending', generation: 0, approvalPolicy: { authorities: ['release-approvers'] } }
    },
    resolution: { approvalAuthorities: {
      'product-approvers': { label: 'Product approvers', allowAnyGitIdentity: true, members: [] },
      'engineering-reviewers': { label: 'Engineering reviewers', allowAnyGitIdentity: true, members: [] },
      'release-approvers': { label: 'Release approvers', allowAnyGitIdentity: true, members: [] }
    } },
    upstreamIssues: [{ id: 'UPI-001', phase: 'requirements', about: 'EAR-101:REQ-002', problem: 'The requirement names a field the API never returns.',
      raisedIn: { phase: 'implementation', status: 'in_progress', generation: 1 } }],
    upstreamIssueDecisions: []
  };
}

const packetOf = (workflow, extra = {}) => decisionPacket(workflow, { phaseId: 'implementation', at: AT, endsStory: false, gaps: [],
  issues: upstreamIssueStates(workflow, AT), activeReuse: [], candidates: [], reuseProblems: [], testRisks: [], unavailable: [], state: {}, ...extra },
{ authorities: workflow.resolution.approvalAuthorities, actor, at: AT });

test('an issue raised at a middle step is on that step\'s list at once, holding only the Story\'s end', () => {
  const packet = packetOf(story());
  const item = packet.items.find((entry) => entry.kind === 'upstream-issue');
  assert.ok(item, 'the issue is listed while implementation is still open');
  assert.equal(item.details.issue, 'UPI-001');
  assert.equal(item.details.early, true);
  assert.equal(item.holds, 'story-end');
  assert.equal(item.holdsWords, 'Holds the Story\'s end, not this step.');
  assert.equal(item.holdsApproval, false);
  // With its recommendation, as every item.
  assert.ok(item.recommended?.words);
  // Nothing stops implementation: the headline counts it as later, never as what stops the step.
  assert.equal(packet.holding, 0);
  assert.match(packet.headline, /needed before the Story ends/u);
});

test('awaiting approval, the early issue still does not hold the step\'s approval', () => {
  const packet = packetOf(story('awaiting_approval'));
  const item = packet.items.find((entry) => entry.kind === 'upstream-issue');
  assert.equal(item.holds, 'story-end');
  assert.equal(item.holdsApproval, false);
  const approval = packet.items.find((entry) => entry.kind === 'approval');
  assert.deepEqual(approval.details.heldBy, []);
});

test('the refusal lead and its count keep their own rule: only the step that ends the Story counts an unnamed issue', () => {
  const workflow = story();
  const issues = upstreamIssueStates(workflow, AT);
  assert.equal(decisionRefusalLead(workflow, 'implementation', { gaps: [], issues, includeAllIssues: false }), null);
  assert.equal(decisionRefusalLead(workflow, 'release', { gaps: [], issues, includeAllIssues: true }).count, 1);
});

test('at the step that ends the Story the issue holds the approval, as before', () => {
  const workflow = story('awaiting_approval');
  const packet = packetOf(workflow, { endsStory: true });
  const item = packet.items.find((entry) => entry.kind === 'upstream-issue');
  assert.equal(item.details.early, undefined);
  assert.equal(item.holdsApproval, true);
});
