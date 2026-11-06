/**
 * A changed path no plan row names is a choice on the list: one item per path, each row an option, with
 * no answer chosen and no reason suggested. It was one hold with blanks to fill in, offered to copy.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { approvalHold } from '../src/approval-check.mjs';
import { decisionPacket, decisionRecordPlan, effectWords, parseDecisionAnswers, pendingSummary } from '../src/decision-list.mjs';
import { SingularityFlowError } from '../src/util.mjs';

const AT = '2026-11-06T00:00:00.000Z';
const ME = { name: 'Reviewer', email: 'reviewer@example.test' };
const AUTHORITIES = { planners: { label: 'Plan approvers', members: [ME] }, engineering: { label: 'Engineering reviewers', members: [ME] } };
const story = () => {
  const step = (id, label, status, groups) => ({ id, label, status, generation: 1, approvals: [], approvalPolicy: { authorities: groups, minimum: 1 } });
  return { workItem: { id: 'W-1' }, currentPhase: 'implementation', phaseOrder: ['planning', 'implementation'],
    phases: { planning: step('planning', 'Planning', 'approved', ['planners']), implementation: step('implementation', 'Implementation', 'awaiting_approval', ['engineering']) },
    resolution: { approvalAuthorities: AUTHORITIES, plannedClaims: { owners: { implementation: 'planning' } } } };
};
const clean = { unimplemented: [], withdrawnButClaimed: [], invalidEvidence: [] };
const refusal = (paths, coverage = clean) => new SingularityFlowError(`Phase 'implementation' cannot be approved because specification coverage is incomplete:\n- changed path is not claimed by a clause: ${paths[0]}`, {
  code: 'SPEC_COVERAGE_INCOMPLETE', details: { coverage: { ...coverage, unclaimedChangedPaths: paths },
    recoveryCommands: paths.map((file) => `singularity-flow decision plan W-1 --add-location <clause>=${file} --reason <why>`),
    planRows: [{ clauseId: 'W-1:REQ-001', result: 'The button converts.' }, { clauseId: 'W-1:AC-002', testOnly: true }] } });
const listFor = (error, actor = ME) => {
  const workflow = story();
  const hold = approvalHold(error, workflow, workflow.phases.implementation);
  return decisionPacket(workflow, { phaseId: 'implementation', pending: {}, approvalCheck: { holds: [hold] } }, { authorities: AUTHORITIES, actor, at: AT });
};

test('each changed path is its own item, and a row is a real option an approver of the plan may choose', () => {
  const packet = listFor(refusal(['src/helper.mjs', 'package.json', 'test/setup.mjs']));
  const items = packet.items.filter((item) => item.kind === 'plan-accounting');
  assert.deepEqual(items.map((item) => item.details.path), ['src/helper.mjs', 'package.json', 'test/setup.mjs']);
  assert.equal(items.every((item) => item.holdsApproval), true);
  assert.deepEqual(packet.items.find((item) => item.kind === 'approval').details.heldBy, items.map((item) => item.id));
  const [source, build, testFile] = items;
  assert.deepEqual(source.options.map((option) => option.id), ['row-w-1-req-001'], 'application source is never a supporting change, and a test-only row takes only tests');
  assert.deepEqual(build.options.map((option) => option.id), ['row-w-1-req-001', 'supporting']);
  assert.deepEqual(testFile.options.map((option) => option.id), ['row-w-1-req-001', 'row-w-1-ac-002']);
  assert.equal(items.flatMap((item) => item.options).some((option) => option.recommended), false, 'nothing is chosen for the person');
  for (const option of items.flatMap((item) => item.options)) {
    assert.equal(option.needs.reason.default, '', 'a reason is the person\'s, never suggested');
    assert.notEqual(option.recordable, false);
    assert.equal(option.action, undefined, 'it is a choice, not a command to copy');
    assert.deepEqual(option.decidedBy.groups, ['planners']);
    assert.equal(option.decidedBy.allowed, true);
    assert.doesNotMatch(option.chat.command, /<clause>|<why>/u, 'the row is named');
  }
  assert.equal(source.options[0].chat.command, 'singularity-flow decision plan W-1 --fetch --add-location W-1:REQ-001=src/helper.mjs --reason "<REASON>"');
  assert.equal(build.options[1].chat.command, 'singularity-flow decision plan W-1 --fetch --add-supporting package.json=build-configuration --supporting-reason "<REASON>" --reason "<REASON>"');
  assert.equal(packet.record.copilotCommand, '/sf-decide W-1');
  assert.equal(packet.next.copilotCommand, '/sf-decide W-1');
  assert.match(pendingSummary(packet).headline, /3 decisions needed/u);
});

test('recording refuses a blank reason, and writes the row the person chose', () => {
  const packet = listFor(refusal(['package.json']));
  const answers = (reason) => parseDecisionAnswers({ choose: { d1: 'supporting' }, reason: reason ? { d1: reason } : {} });
  assert.throws(() => decisionRecordPlan(packet, answers(''), { at: AT }), /The reason for d1 must be 20 to 500 characters/u);
  assert.throws(() => decisionRecordPlan(packet, answers('x'.repeat(501)), { at: AT }), /20 to 500/u, 'a supporting change takes at most 500');
  const plan = decisionRecordPlan(packet, answers('The new test script needs this entry.'), { at: AT });
  assert.deepEqual(plan.steps[0].effects, [{ kind: 'plan-amendment', change: { kind: 'add-supporting', path: 'package.json', class: 'build-configuration' } }]);
  assert.match(effectWords(story(), plan.steps[0].effects[0]), /list package\.json as a supporting change, build-configuration/u);
  const row = decisionRecordPlan(packet, parseDecisionAnswers({ choose: { d1: 'row-w-1-req-001' }, reason: { d1: 'The build script is part of this change.' } }), { at: AT });
  assert.match(effectWords(story(), row.steps[0].effects[0]), /add package\.json to REQ-001/u);
});

test('someone outside the plan\'s group sees who decides, and the digest binds the rows', () => {
  const theirs = listFor(refusal(['package.json']), { name: 'Other', email: 'other@example.test' });
  assert.equal(theirs.items[0].decidedBy.allowed, false);
  assert.match(theirs.items[0].decidedBy.words, /The Plan approvers decide this/u);
  const plan = decisionRecordPlan(theirs, parseDecisionAnswers({ choose: { d1: 'supporting' }, reason: { d1: 'The new test script needs this entry.' } }), { at: AT });
  assert.equal(plan.steps.length, 0, 'nothing is written for someone who may not decide it');
  assert.equal(plan.refused[0].item, 'd1');
  assert.notEqual(listFor(refusal(['package.json'])).packetSha256, listFor(refusal(['package-lock.json'])).packetSha256);
});

test('a path beside work the author still owes stays the author\'s, with its route', () => {
  const packet = listFor(refusal(['src/helper.mjs'], { ...clean, unimplemented: ['W-1:REQ-001'] }));
  assert.equal(packet.items.some((item) => item.kind === 'plan-accounting'), false);
  assert.ok(packet.items.some((item) => item.kind === 'approval-hold'));
});
