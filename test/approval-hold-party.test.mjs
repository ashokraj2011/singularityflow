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

import { approvalHold, approvalHoldOwner } from '../src/approval-check.mjs';
import { decisionPacket, pendingSummary } from '../src/decision-list.mjs';
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

test('a refusal nothing here knows says so and goes to recover, never reject', () => {
  const unknown = refusal('A_CODE_NOBODY_LISTED');
  assert.equal(approvalHoldOwner(unknown), 'unknown');
  const { hold, packet } = listFor(unknown);
  assert.equal(hold.who, 'Singularity Flow cannot say who clears this');
  assert.equal(hold.action.command, 'singularity-flow recover W-1 --phase implementation --json');
  assert.doesNotMatch(JSON.stringify(packet), /singularity-flow reject|The author revises it/u);
  // A refusal with no code at all is the same; one that names its own route keeps it.
  assert.equal(listFor(new SingularityFlowError('Uncoded.')).hold.owner, 'unknown');
  const named = listFor(refusal('A_CODE_NOBODY_LISTED', { nextAction: { command: 'singularity-flow nextsteps W-1 --json', label: 'See.' } }));
  assert.equal(named.hold.action.command, 'singularity-flow nextsteps W-1 --json');
  // Only a code known to be the author's still names the return.
  assert.equal(listFor(refusal('STORY_REVIEW_SOURCE_CHANGED')).hold.who, 'The author revises it');
  assert.match(listFor(refusal('STORY_REVIEW_SOURCE_CHANGED')).hold.action.command, /^singularity-flow reject implementation /u);
});

test('a hold names the real groups, and says so when the viewer is in one', () => {
  const lapsed = refusal('PHASE_VALIDATION_FAILED', { testRunRiskRenewals: [{ phase: 'implementation', command: 'singularity-flow decision test-risk W-1' }],
    nextAction: { command: 'singularity-flow decision test-risk W-1' } }, 'Phase cannot be approved: the run a decision let through is no longer carried.');
  const upstream = refusal('SPEC_COVERAGE_INCOMPLETE', { upstreamDecision: { complete: true, issues: [{ id: 'UPI-001', phase: 'planning', clauses: ['W-1:AC-001'] }] },
    nextAction: { command: 'singularity-flow decisions W-1 --json', label: 'Planning\'s approvers decide UPI-001.' } });
  const amendment = refusal('APPROVAL_INTENT_AMENDMENT_PENDING', { scopePhase: 'planning', pendingIntentAmendments: [{ id: 'AMD-001' }],
    nextAction: { command: 'singularity-flow story intent-amendment status --work-id W-1 --json', label: 'See it.' } });
  const expected = [
    [lapsed, 'An approver of Implementation decides', 'Engineering reviewers', 'test-run-risk'],
    [upstream, 'An approver of Planning decides', 'Plan approvers', 'approval-hold'],
    [amendment, 'An approver of Planning decides', 'Plan approvers', 'approval-hold']
  ];
  for (const [error, who, group, kind] of expected) {
    const { hold, item, packet } = listFor(error);
    assert.equal(hold.owner, 'someone-decides', error.code);
    assert.equal(hold.who, who, 'words true for any reader');
    assert.equal(item.kind, kind);
    assert.equal(item.decidedBy.allowed, true, error.code);
    assert.equal(item.decidedBy.words.startsWith(`You may do this (${group}).`), true, item.decidedBy.words);
    assert.equal(pendingSummary(packet).items[0].yours, true);
  }
  // The same holds for someone outside the group: who to ask, and the line to share.
  const outside = listFor(upstream, { actor: { email: 'risk-only@example.test' } }).item;
  assert.equal(outside.decidedBy.allowed, false);
  assert.match(outside.decidedBy.words, /^The Plan approvers \(Reviewer\) decide this; ask them\./u);
  assert.equal(outside.decidedBy.share, '/sf-decide W-1');
});

test('a TRP gate names its delegated reviewers, not an ordinary approver, and says so when none is pinned', () => {
  const blocked = refusal('TRP_PHASE_GATE_BLOCKED', { phase: 'implementation', workId: 'W-1' });
  const { hold, item } = listFor(blocked);
  assert.equal(hold.who, 'A risk reviewer of this Story decides');
  assert.deepEqual(item.decidedBy.groups, ['risk']);
  assert.equal(item.decidedBy.allowed, false, 'an engineering reviewer is not a risk reviewer');
  assert.match(item.decidedBy.words, /^The Risk reviewers \(Other\) decide this; ask them\./u);
  const none = listFor(blocked, { workflow: story({ testRecovery: null }) });
  assert.equal(none.hold.who, 'Singularity Flow cannot say who clears this');
  assert.deepEqual([none.item.decidedBy.groups, none.item.decidedBy.allowed], [[], false]);
  assert.match(none.item.decidedBy.words, /^Singularity Flow cannot say who decides this\./u);
});

test('an appeal names the plan\'s approvers, whose authority its decision checks', () => {
  const { hold, item } = listFor(refusal('PHASE_APPEAL_REVIEW_REQUIRED', { recoveryCommand: 'singularity-flow appeal list --phase implementation --json' }));
  assert.equal(hold.who, 'An approver of the plan decides');
  assert.equal(item.decidedBy.allowed, false, 'no step of this fixture holds the plan, so nothing is claimed');
  assert.match(item.decidedBy.words, /cannot say who decides this/u);
});

test('identity refusals name the people, and never call this identity\'s step its own', () => {
  const details = { phase: 'implementation', authorities: ['engineering'] };
  const recorded = listFor(refusal('APPROVAL_IDENTITY_ALREADY_RECORDED', { ...details, eligibleApprovers: ['other@example.test'] }, `${ME.email} already approved phase implementation; approvals require distinct identities.`));
  assert.equal(recorded.hold.who, 'Another approver of Implementation decides');
  assert.deepEqual([recorded.item.decidedBy.allowed, recorded.item.decidedBy.people], [false, ['Other']]);
  assert.match(recorded.item.decidedBy.words, /^You have already approved this\. The Engineering reviewers \(Other\) decide this; ask them\./u);
  const self = listFor(refusal('APPROVAL_SELF_APPROVAL_PROHIBITED', { ...details, eligibleApprovers: ['other@example.test'] }));
  assert.equal(self.hold.who, 'An approver of Implementation other than its author decides');
  assert.match(self.item.decidedBy.words, /^Its author may not approve it\. The Engineering reviewers \(Other\) decide this; ask them\./u);
  const alone = listFor(refusal('APPROVAL_SELF_APPROVAL_PROHIBITED', { ...details, eligibleApprovers: [] }));
  assert.match(alone.item.decidedBy.words, /Nobody else is listed in Engineering reviewers for this Story\./u);
  const outsider = listFor(refusal('APPROVAL_IDENTITY_NOT_AUTHORIZED', { ...details, identity: SOMEONE.email, eligibleApprovers: ['reviewer@example.test', 'other@example.test'] }), { actor: SOMEONE });
  assert.equal(outsider.hold.who, 'An approver of Implementation decides');
  assert.deepEqual(outsider.item.decidedBy.people, ['Reviewer', 'Other']);
  const open = listFor(refusal('APPROVAL_IDENTITY_NOT_AUTHORIZED', { ...details, identity: SOMEONE.email, eligibleApprovers: [], anyIdentity: true }), { actor: SOMEONE });
  assert.match(open.item.decidedBy.words, /^The Engineering reviewers decide this; ask them\./u, 'a group open to any identity lists nobody and still decides');
});

test('a person\'s own step never claims it is yours because nothing names a group', () => {
  const workflow = story();
  // A routing decision with no group, a scope item nobody resolved a group for: both refused by their own commands.
  const routing = decisionPacket(workflow, { phaseId: 'implementation', pending: { routing: { key: 'k', decision: 'route', after: 'planning', options: [{ id: 'a', label: 'A' }] } } },
    { authorities: AUTHORITIES, actor: ME, at: AT }).items[0];
  assert.deepEqual([routing.decidedBy.groups, routing.decidedBy.allowed], [[], false]);
  assert.match(routing.decidedBy.words, /^Singularity Flow cannot say who decides this\./u);
  const scope = decisionPacket(workflow, { phaseId: 'implementation', pending: { owed: [{ kind: 'scope', id: 'SRI-1', text: 'A statement', command: 'singularity-flow decision scope W-1', groups: ['planners'] }] } },
    { authorities: AUTHORITIES, actor: { email: 'risk-only@example.test' }, at: AT }).items[0];
  assert.deepEqual([scope.decidedBy.groups, scope.decidedBy.allowed], [['planners'], false], 'a scope item names the group its command checks');
  // What really needs no group says so: acknowledging an approved amendment, and publishing.
  const open = decisionPacket(workflow, { phaseId: 'implementation', pending: { publication: { commit: null, cause: 'No.' },
    intentAmendments: [{ id: 'AMD-001', status: 'approved', changedClauses: [] }] } }, { authorities: AUTHORITIES, actor: SOMEONE, at: AT });
  assert.ok(open.items.filter((item) => item.kind !== 'approval').every((item) => item.decidedBy.allowed), 'neither command checks a group');
});
