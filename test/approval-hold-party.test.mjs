/**
 * The list says who really clears a hold, and what holds the approval comes first [study 6.7].
 *
 * Every hold shape once read "Someone else decides", no group, `allowed: true`: the refusal knew who
 * decides and the hold dropped it. On a real list `holding` said 0, `heldBy` named d2, the headline
 * said "1 decision needed" and `next` sent the person to d1, which held nothing. A dirty checkout,
 * the top real refusal of /sf-approve, passed "every check" until the door refused it.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { agentAct } from '../src/agent-output.mjs';
import { approvalHold, approvalHoldOwner } from '../src/approval-check.mjs';
import { decisionPacket, pendingSummary } from '../src/decision-list.mjs';
import { approvalCheckLines, owedDecisionLines } from '../src/owed-decisions.mjs';
import { SingularityFlowError } from '../src/util.mjs';
import { retainedEvidenceDelivered } from '../src/verification/witness-records.mjs';
import { CLI, submittedPlanningStory } from './helpers/submitted-planning-story.mjs';

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

test('a hold whose route /sf-decide never takes goes to that route\'s skill, not back to /sf-decide', () => {
  const unknown = listFor(refusal('A_CODE_NOBODY_LISTED'));
  assert.equal(unknown.packet.next.copilotCommand, '/sf-recover W-1');
  assert.equal(unknown.item.decidedBy.allowed, false, 'nothing says it is this person\'s');
  const changed = listFor(refusal('STORY_REVIEW_SOURCE_CHANGED'));
  assert.equal(changed.packet.next.copilotCommand, '/sf-reject W-1');
  assert.equal(changed.packet.record.copilotCommand, null, 'no choice left is recorded in a /sf-decide turn');
  assert.equal(changed.item.decidedBy.allowed, true, 'returning it is this approver\'s step');
  assert.match(changed.item.decidedBy.words, /^You may do this \(Engineering reviewers\)\. An approver returns implementation for changes/u);
  // A person decides this one on the list: /sf-decide shows it and names them.
  const person = listFor(refusal('APPROVAL_IDENTITY_NOT_AUTHORIZED', { authorities: ['engineering'], eligibleApprovers: ['reviewer@example.test'] }), { actor: SOMEONE });
  assert.equal(person.packet.next.copilotCommand, '/sf-decide W-1');
});

test('holding, heldBy, the headline and next describe one situation (the real bin-opr list)', () => {
  const workflow = story();
  const owed = { kind: 'witness', clauseId: 'W-1:AC-001', slot: 'visual', method: 'visual', files: ['shots/home.png'], owners: ['implementation'], command: 'singularity-flow decision witness --work-id W-1' };
  const gap = refusal('SPEC_COVERAGE_INCOMPLETE', { coverage: { unclaimedChangedPaths: ['src/test/setup.js'], unimplemented: [], withdrawnButClaimed: [], invalidEvidence: [] },
    recoveryCommands: ['singularity-flow decision plan W-1 --add-location <clause>=src/test/setup.js --reason <why>'] },
  "Phase 'implementation' cannot be approved because specification coverage is incomplete:\n- changed path is not claimed by a clause: src/test/setup.js; add it to a row\nRun singularity-flow recover W-1.");
  const { packet } = listFor(gap, { workflow, facts: { pending: { owed: [owed] } } });
  const [d1, d2, d3] = packet.items;
  assert.deepEqual([d1.kind, d1.holdsApproval, d2.kind, d2.holdsApproval, d3.kind], ['owed-decision', false, 'approval-hold', true, 'approval']);
  assert.equal(packet.holding, 1);
  assert.deepEqual(d3.details.heldBy, ['d2']);
  assert.equal(packet.open, 3);
  assert.equal(packet.next.item, 'd2', 'next is what holds the approval, not the first item');
  assert.equal(packet.headline, "Implementation can't be approved yet: 1 decision needed. 1 other decision does not hold its approval.");
  // The whole message, and a title that does not end on a colon with the path cut off.
  assert.equal(d2.title, "Phase 'implementation' cannot be approved because specification coverage is incomplete: changed path is not claimed by a clause: src/test/setup.js");
  assert.match(d2.why, /- changed path is not claimed by a clause: src\/test\/setup\.js; add it to a row\nRun singularity-flow recover W-1\./u);
  // Nothing holds it: the approval is next, and the owed sign-off stays listed.
  const clear = decisionPacket(workflow, { phaseId: 'implementation', pending: { owed: [owed] }, approvalCheck: { holds: [] } }, { authorities: AUTHORITIES, actor: ME, at: AT });
  assert.deepEqual([clear.next.kind, clear.holding, clear.open], ['approval', 0, 2]);
  assert.equal(clear.headline, 'Implementation has 1 open decision; none holds its approval.');
});

test('a step still open is not told a sign-off stops its approval', () => {
  const workflow = story({ status: 'in_progress' });
  const owed = { kind: 'witness', clauseId: 'W-1:AC-001', slot: 'visual', method: 'visual', files: ['shots/home.png'], owners: ['implementation'], command: 'singularity-flow decision witness --work-id W-1' };
  const open = (extra) => decisionPacket(workflow, { phaseId: 'implementation', pending: { owed: [owed] }, ...extra }, { authorities: AUTHORITIES, actor: ME, at: AT });
  const only = open({});
  assert.equal(only.headline, 'Implementation has 1 open decision; none holds its approval.');
  assert.deepEqual([only.holding, only.next.kind], [0, 'owed-decision']);
  // A test-run risk does stop it, at submission: that still reads as needed first, and comes first.
  const risk = { phase: 'implementation', commandId: 'unit', status: 'blocked' };
  const stopped = open({ testRisks: [risk] });
  assert.equal(stopped.headline, 'Implementation needs 1 decision before it can be approved. 1 other decision does not hold its approval.');
  assert.equal(stopped.next.kind, 'test-run-risk');
});

test('the door\'s other refusal, a hidden change, belongs to this checkout too and says what clears it', () => {
  const hidden = approvalHold(refusal('WORKTREE_HIDDEN_CHANGE', { paths: ['src/a.mjs'] }, 'Lifecycle decision cannot continue because Git index flags hide visible changes in: src/a.mjs.'), story(), story().phases.implementation);
  assert.equal(hidden.owner, 'this-checkout');
  assert.match(hidden.action.label, /^Clear the flags it names/u);
  assert.equal(hidden.action.skill, '/sf-recover');
});

test('a dirty checkout holds the check, the list and the packet first; the door stays as it was', async (t) => {
  const WORK = 'HOLD-DOOR';
  const { cli, git, run } = await submittedPlanningStory(t, WORK);
  const root = git('rev-parse', '--show-toplevel');
  const payload = (result) => { const parsed = JSON.parse(result.stdout); return parsed.resultType === 'command-result' ? parsed.data : parsed; };
  const readiness = () => JSON.parse(cli('status', WORK, '--submission-readiness', '--json').stdout);
  const clean = readiness();
  assert.equal(clean.approvalCheck.ready, true);
  const cleanList = payload(cli('decisions', WORK, '--json'));

  // Test runner output and Singularity Flow's own results are what the door already exempts: still nothing to clear.
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await writeFile(path.join(root, 'test-results', '.last-run.json'), '{}\n');
  assert.deepEqual(readiness().approvalCheck.holds, [], 'files the door exempts stay exempt');

  await writeFile(path.join(root, 'stray-note.js'), 'export const stray = 1;\n');
  const dirty = readiness();
  const check = dirty.approvalCheck;
  assert.equal(check.ready, false);
  assert.equal(check.statement, 'Approving planning now would be refused until one hold is cleared.');
  assert.deepEqual(check.holds.map((hold) => [hold.code, hold.owner, hold.who]),
    [['LIFECYCLE_WORKTREE_REVIEW_REQUIRED', 'this-checkout', 'Whoever works in this checkout clears it']]);
  const [hold] = check.holds;
  assert.equal(hold.summary, 'The checkout has changes that are not part of this lifecycle decision: stray-note.js.');
  assert.match(hold.message, /stray-note\.js\.\nA person reviews them and sets them aside/u);
  assert.equal(hold.action.command, `singularity-flow recover ${WORK} --json`);
  assert.doesNotMatch(JSON.stringify(check), /test-results/u);
  assert.match(approvalCheckLines(check).join('\n'), /Whoever works in this checkout clears it: The checkout has changes .*stray-note\.js\./u);
  assert.equal(dirty.classification, 'already-submitted', 'readiness still says what it said');
  assert.equal(dirty.nextSkill, '/sf-recover');

  const list = payload(cli('decisions', WORK, '--json'));
  assert.deepEqual(list.items.map((item) => [item.kind, item.holdsApproval]), [['approval-hold', true], ['approval', false]]);
  assert.equal(list.next.command, hold.action.command);
  assert.equal(list.next.copilotCommand, `/sf-recover ${WORK}`);
  assert.equal(list.items[0].decidedBy.allowed, true);
  assert.equal(list.items[0].id, 'd0');
  assert.deepEqual(list.items.at(-1).details.heldBy, ['d0']);
  assert.equal(list.holding, 1);
  assert.equal(list.packetSha256, cleanList.packetSha256, 'setting it aside leaves what a person chose valid, so nothing newly refuses as a changed list');
  assert.equal(list.items.at(-1).id, cleanList.items.at(-1).id, 'no number changes what it means');

  const packet = JSON.parse(cli('choices', 'begin', 'approve', WORK, '--json', '--review-packet').stdout);
  assert.deepEqual([packet.begun, packet.reason], [false, 'approval-holds'], 'said first, before any receipt');
  const act = agentAct(packet);
  assert.equal(act.state, 'blocked');
  assert.equal(act.do.copilot, `/sf-recover ${WORK}`);
  assert.equal(act.do.shell, hold.action.command);

  // The door refuses exactly as it did, and recovery really is the way through.
  const refused = run(process.execPath, [CLI, '--no-model', 'approve', 'planning', '--work-id', WORK, '--yes', '--json'], { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.equal(JSON.parse(refused.stdout).error.code, 'LIFECYCLE_WORKTREE_REVIEW_REQUIRED');
  const recovery = payload(cli('recover', WORK, '--json'));
  const setAside = recovery.actions.find((action) => action.id === 'set-aside-worktree');
  assert.deepEqual(setAside.paths, ['stray-note.js']);
  run(process.execPath, [CLI, ...setAside.argv ?? setAside.command.split(' ').slice(1)]);
  assert.deepEqual(readiness().approvalCheck.holds, [], 'what the route said clears it');
  cli('approve', 'planning', '--work-id', WORK, '--yes', '--json');
});

test('a witness with no file, or nothing published yet, says so', () => {
  const workflow = story({ status: 'in_progress' });
  const witness = (extra) => decisionPacket(workflow, { phaseId: 'implementation', pending: { owed: [{ kind: 'witness', clauseId: 'W-1:AC-001', slot: 'visual', method: 'visual', files: [], owners: ['implementation'],
    command: 'singularity-flow decision witness --file <EVIDENCE-PATH>', ...extra }] } }, { authorities: AUTHORITIES, actor: ME, at: AT }).items[0];
  const noFile = witness({});
  assert.equal(noFile.why, 'An approver of Implementation signs it off, naming the file they inspected: the plan names none. The Story cannot end without it.');
  assert.doesNotMatch(noFile.why, / {2}/u);
  assert.ok(noFile.options[0].action.humanReview);
  const unpublished = witness({ files: ['shots/home.png'], available: false });
  assert.match(unpublished.why, /It cannot be signed off yet: nothing has published shots\/home\.png for AC-001\. Implementation publishes it with its delivery; sign it off after that\./u);
  assert.equal(unpublished.options[0].available, false);
  assert.equal(unpublished.options[0].action.humanReview, undefined, 'no review is opened for what its command would refuse');
  assert.equal(unpublished.options[0].action.command, null, 'and no command is offered that would refuse it');
  // With nothing else on the list, the next thing is the Story's: a real chat printed "Copilot: no verified equivalent" and the command.
  const waiting = decisionPacket(workflow, { phaseId: 'implementation', pending: { owed: [{ kind: 'witness', clauseId: 'W-1:AC-001', slot: 'visual', method: 'visual', files: ['shots/home.png'], owners: ['implementation'],
    available: false, command: 'singularity-flow decision witness --file shots/home.png' }] } }, { authorities: AUTHORITIES, actor: ME, at: AT });
  assert.equal(waiting.next.copilotCommand, '/sf-next W-1');
  assert.equal(waiting.next.command, 'singularity-flow nextsteps W-1 --json');
  assert.match(waiting.next.notYet, /cannot be signed off yet/u);
  assert.equal(waiting.record.copilotCommand, null, 'nothing here can be recorded yet');
  const act = agentAct(waiting);
  assert.equal(act.state, 'next');
  assert.equal(act.do.copilot, '/sf-next W-1');
  assert.match(act.do.shell, /^singularity-flow nextsteps W-1 /u);
  assert.match(act.said, /Nothing here can be recorded yet\.$/u);
  assert.doesNotMatch(JSON.stringify([waiting.next, act]), /decision witness/u);
  const lines = owedDecisionLines({ status: 'owed', more: { witnesses: 0, scopeItems: 0 }, scopeItems: [],
    witnesses: [{ clauseId: 'W-1:AC-001', slot: 'visual', method: 'visual', files: ['shots/home.png'], available: false, command: 'c' }, { clauseId: 'W-1:AC-002', slot: 'visual', method: 'visual', files: [], command: 'd' }] });
  assert.match(lines[1], /nothing has published it yet; once its step does, inspect it, then:$/u);
  assert.match(lines[3], /\(visual: the plan names no file\) — inspect it first, then:$/u);
  // Available once a delivery recorded that very file present for that clause, as the witness itself requires.
  const delivered = (state, clauseId = 'W-1:AC-001') => ({ phases: { implementation: { generation: 1, deliveryEvidence: { fulfillment: [
    { clauseId, fulfillment: 'evidence', paths: [{ path: 'shots/home.png', state }] }] } } } });
  assert.equal(retainedEvidenceDelivered(delivered('present'), 'W-1:AC-001', 'shots/home.png'), true);
  assert.equal(retainedEvidenceDelivered(delivered('missing'), 'W-1:AC-001', 'shots/home.png'), false);
  assert.equal(retainedEvidenceDelivered(delivered('present', 'W-1:AC-002'), 'W-1:AC-001', 'shots/home.png'), false);
  assert.equal(retainedEvidenceDelivered({ phases: { implementation: { generation: 0 } } }, 'W-1:AC-001', 'shots/home.png'), false);
});
