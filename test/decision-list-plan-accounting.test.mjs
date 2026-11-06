/**
 * A changed path no plan row names is a choice on the list: one item per path, each row an option, with
 * no answer chosen and no reason suggested. It was one hold with blanks to fill in, offered to copy.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { approvalHold } from '../src/approval-check.mjs';
import { decisionPacket, decisionRecordPlan, effectWords, parseDecisionAnswers, pendingSummary } from '../src/decision-list.mjs';
import { testSetupFiles } from '../src/test-support-files.mjs';
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
  const packet = listFor(refusal(['src/helper.mjs', 'package.json', 'test/value.test.mjs']));
  const items = packet.items.filter((item) => item.kind === 'plan-accounting');
  assert.deepEqual(items.map((item) => item.details.path), ['src/helper.mjs', 'package.json', 'test/value.test.mjs']);
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

test('files that changed together for how tests run are one decision, and each is recorded by name', () => {
  const planHold = (paths) => listFor(refusal(paths)).items;
  const held = planHold(['package-lock.json', 'playwright.config.js', 'src/test/setup.js', 'src/help.js']);
  const items = held.filter((item) => item.kind === 'plan-accounting');
  assert.deepEqual(items.map((item) => item.title), ['Say where this test setup belongs: package-lock.json, playwright.config.js and src/test/setup.js', 'Say where src/help.js belongs']);
  const [setup] = items;
  assert.match(setup.why, /changed together for how tests run.*one change, so you decide once, and each is recorded by name/u);
  assert.deepEqual(setup.details.paths, ['package-lock.json', 'playwright.config.js', 'src/test/setup.js']);
  assert.match(effectWords(story(), setup.options[0].effects[0]), /list package-lock\.json as a supporting change, dependency-lock, list playwright\.config\.js as a supporting change, build-configuration, add src\/test\/setup\.js to REQ-001 \(plan amendment\)/u);
  // The setup file is under a test folder, so it needs a row; the rest are supporting. One choice does all of it.
  const [row] = setup.options;
  assert.deepEqual(row.effects, [{ kind: 'plan-amendment', changes: [
    { kind: 'add-supporting', path: 'package-lock.json', class: 'dependency-lock' }, { kind: 'add-supporting', path: 'playwright.config.js', class: 'build-configuration' },
    { kind: 'add-location', clauseId: 'W-1:REQ-001', path: 'src/test/setup.js' }] }]);
  assert.match(row.label, /src\/test\/setup\.js under REQ-001.*the rest as supporting changes/u);
  assert.equal(row.chat.command, 'singularity-flow decision plan W-1 --fetch --add-supporting package-lock.json=dependency-lock --supporting-reason "<REASON>" --add-supporting playwright.config.js=build-configuration --supporting-reason "<REASON>" --add-location W-1:REQ-001=src/test/setup.js --reason "<REASON>"');
  // Nothing needs a row: one supporting choice.
  const [all] = planHold(['package-lock.json', 'package.json', 'vite.config.js']).filter((item) => item.kind === 'plan-accounting');
  assert.deepEqual(all.options.map((option) => [option.id, option.effects[0].changes.map((change) => change.path)]), [['supporting', ['package-lock.json', 'package.json', 'vite.config.js']]]);
  // A manifest and its lockfile alone are a dependency change, and a single file has nothing to group.
  assert.equal(planHold(['package-lock.json', 'package.json']).filter((item) => item.kind === 'plan-accounting').length, 2);
  assert.equal(planHold(['vite.config.js', 'src/help.js']).filter((item) => item.kind === 'plan-accounting').length, 2);
});

test('what is test setup: runner configuration and setup files, with what changes with them; never a test or application source', () => {
  assert.deepEqual(testSetupFiles(['vite.config.js', 'package.json', 'yarn.lock', 'src/app.js', 'src/a.test.js', 'README.md']), ['vite.config.js', 'package.json', 'yarn.lock']);
  assert.deepEqual(testSetupFiles(['src/setupTests.ts', 'test/setup.mjs', 'e2e/global-setup.ts']), ['src/setupTests.ts', 'test/setup.mjs', 'e2e/global-setup.ts']);
  assert.deepEqual(testSetupFiles(['pytest.ini', 'requirements-dev.txt', 'conftest.py']), ['pytest.ini', 'requirements-dev.txt', 'conftest.py']);
  assert.deepEqual(testSetupFiles(['src/setup.js', 'lib/setup.mjs', 'package.json', 'package-lock.json']), [], 'a setup.js outside a test folder is the application\'s');
  assert.deepEqual(testSetupFiles(['src/test/setup.js', 'src/test/helpers.js', 'tests/support/page.mjs', 'tests/support/page.test.mjs']), ['src/test/setup.js', 'src/test/helpers.js', 'tests/support/page.mjs']);
  assert.deepEqual(testSetupFiles(['vite.config.js']), []);
});
