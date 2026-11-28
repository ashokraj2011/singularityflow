// FPL M3 follow-up, §11 question 3 (owner, 2026-11-26): `by: <group>` on `always` and `paths` rules. "Touching src/payments
// needs Security's approval": a rule can only add an approval group, one of the repository's, which must also approve the
// steps it gives a person. Checked with its field at every door, composed into the task as a required group, said in the
// plan line and the Rules place, and walked through the CLI: the step's own approver's yes does not complete it, a person
// outside the step's groups is refused, and a member of the group approves it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { withRuleApprovalGroups } from '../src/approval-authority.mjs';
import { resolveWorkType, validateDefinition } from '../src/config.mjs';
import { planCoverage } from '../src/task-agents.mjs';
import { localWorkflowCandidate } from '../src/task-local.mjs';
import {
  checkTaskRules, composeTask, definitionForStory, groupApprovalWords, planLine, ruleGroupApproves, taskDefinition
} from '../src/task-composition.mjs';
import { applyTaskRuleChange, previewRuleChanges, ruleForm, ruleSlug, ruleViews, taskRuleChecks, taskRulesChange } from '../src/task-rules.mjs';
import { planNote } from '../src/work-rows.mjs';
import { generatedAgent, generatedPerson } from './helpers/generated-journey.mjs';
import { followRoutes, formatTrail, journeyRepository, storyRecord } from './helpers/route-follower.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = readFileSync(path.join(ROOT, 'templates/workflow.yml'), 'utf8');
const BASE = YAML.parse(TEMPLATE);
const SECURITY = { label: 'Security', allowAnyGitIdentity: false, members: [{ email: 'security.lead@example.com' }] };
const withSecurity = (tasks) => ({ ...structuredClone(BASE), approvalAuthorities: { ...structuredClone(BASE.approvalAuthorities), security: SECURITY }, tasks });
const PAYMENTS = { id: 'payments-security', paths: ['src/payments/**'], personApproves: ['code'], by: 'security', because: 'Touching payments needs Security\'s approval.' };
const resolved = (definition, composition) => resolveWorkType(validateDefinition(structuredClone(taskDefinition(definition, composition))), composition.workType);
const approvalOf = (phase) => ({ authorities: phase.approval.authorities, required: phase.approval.requiredAuthorities, minimum: phase.approval.minimum,
  automatic: phase.approval.automatic ?? null, mode: phase.approval.mode });

test('by: a rule names one of the repository\'s approval groups, for the steps it gives a person; every other by is a problem with its field', () => {
  const { problems, rules } = checkTaskRules(withSecurity({
    always: [{ kinds: ['feature'], personApproves: ['plan'], by: 'nobody', because: 'Plans are read.' }, { by: 'security', because: 'No step named.' }],
    paths: [PAYMENTS, { paths: ['db/**'], personApproves: ['code'], by: 7, because: 'Data.' }],
    use: { change: { workflow: 'classic-delivery', by: 'security' } }
  }));
  assert.deepEqual(problems.map((problem) => problem.field), ['tasks.always[0].by', 'tasks.always[1].by', 'tasks.paths[1].by', 'tasks.use.change.by']);
  assert.match(problems[0].message, /^always\[0\] by names 'nobody', which is not one of this repository's approval groups \(product-approvers, .*security\)\.$/u);
  assert.equal(problems[1].message, 'always[1] by names who also approves, so it needs personApproves: the steps security approves.');
  assert.match(problems[3].message, /a use rule has workflow, because and id/u, 'a use rule runs a workflow as it is: no group is added to it');
  assert.deepEqual(rules.paths.map((rule) => [rule.name, rule.by]), [['payments-security', 'security']]);
  // A repository without approval groups has one: git-contributors.
  const plain = checkTaskRules({ workTypes: BASE.workTypes, tasks: { always: [{ personApproves: ['code'], by: 'git-contributors', because: 'Read.' }] } });
  assert.deepEqual(plain.problems, []);
});

test('by: the composed step needs the group too, required and never automatic, beside its own approvers; nothing else changes', () => {
  const definition = withSecurity({ paths: [PAYMENTS] });
  const touched = composeTask(definition, { kind: 'fix', touchedPaths: ['src/payments/round.mjs'] });
  assert.deepEqual(touched.groupApproves, [{ intent: 'code', group: 'security', rule: 'payments-security', because: PAYMENTS.because, label: 'Security' }]);
  assert.deepEqual(touched.personApproves, ['code']);
  const phases = Object.fromEntries(resolved(definition, touched).phases.map((phase) => [phase.id, approvalOf(phase)]));
  const plain = composeTask(definition, { kind: 'fix', touchedPaths: ['src/other.mjs'] });
  assert.equal(plain.groupApproves, undefined, 'a rule that does not apply adds nothing, so a composition reads as before');
  const before = Object.fromEntries(resolved(definition, plain).phases.map((phase) => [phase.id, approvalOf(phase)]));
  assert.deepEqual(phases.implementation, { authorities: [...before.implementation.authorities, 'security'], required: ['security'],
    minimum: before.implementation.minimum + 1, automatic: null, mode: 'required' }, 'its own approvers stay, Security must also approve');
  assert.deepEqual(phases.intake, before.intake);
  assert.deepEqual(phases.verification, before.verification, 'only the steps the rule gives a person');
  // The plan line, the task page's note and the preview say it.
  const approvals = { intake: 'person', implementation: 'person', verification: 'sflow' };
  // A fix sized by its requirement (ITW v1.2): its requirement, the step that implements and tests, SFlow's run of the tests.
  assert.equal(planLine(touched, { approvals }), 'Plan: requirement → implement and test → SFlow runs the tests. You approve the requirement and the code. Security approves the code. Small or big is decided with the requirement. Say "add a design step" to change it.');
  assert.equal(groupApprovalWords(plain), '');
  assert.match(planNote({ resolution: { composition: touched } }), /The team's rules added your approval of the code and Security's approval of the code\./u);
  // A Story rebuilds the same workflow from its own composition, whatever the rules say now.
  const changed = withSecurity(undefined);
  assert.deepEqual(definitionForStory(changed, { resolution: { composition: touched } }).workTypes['task-fix'].ruleApprovers, { implementation: ['security'] });
  // An always rule for a kind, and a group already among the step's own: required, with no one more.
  const own = BASE.approvalAuthorities['engineering-reviewers'] ? 'engineering-reviewers' : Object.keys(BASE.approvalAuthorities)[0];
  const always = withSecurity({ always: [{ kinds: ['feature'], personApproves: ['code'], by: own, because: 'Engineers read every feature.' }] });
  const feature = composeTask(always, { kind: 'feature' });
  const code = resolved(always, feature).phases.find((phase) => phase.id === 'implementation');
  assert.deepEqual([code.approval.authorities.filter((id) => id === own).length, code.approval.requiredAuthorities, code.approval.minimum], [1, [own], 1]);
  assert.deepEqual(ruleGroupApproves(definition, 'fix', ['src/payments/a.mjs']).map((entry) => [entry.intent, entry.group, entry.label]), [['code', 'security', 'Security']]);
});

test('by: the engine adds a group, never removes one; a step with no approval gets one; an unknown group is refused', () => {
  const authorities = { team: { label: 'Team', allowAnyGitIdentity: true, members: [] }, security: SECURITY };
  const policy = { mode: 'policy', policy: 'small', maximumChangedPaths: 3, authorities: ['team'], requiredAuthorities: [], minimum: 1, rejectTo: ['code'],
    allowSelfApproval: true, changeRequests: { commentRequired: true, reopenCompleted: true }, automatic: 'when-ready' };
  const { automatic: _automatic, ...expected } = { ...policy, mode: 'required', policy: null, maximumChangedPaths: null, authorities: ['team', 'security'],
    requiredAuthorities: ['security'], minimum: 2 };
  assert.deepEqual(withRuleApprovalGroups(policy, ['security'], authorities, 'code'), expected, 'never waived by a policy, never approved automatically');
  assert.equal(withRuleApprovalGroups(policy, [], authorities, 'code'), policy, 'no group, the same policy');
  const none = withRuleApprovalGroups({ mode: 'none', authorities: [], requiredAuthorities: [], minimum: 0, rejectTo: ['code'] }, ['security'], authorities, 'code');
  assert.deepEqual([none.mode, none.authorities, none.requiredAuthorities, none.minimum], ['required', ['security'], ['security'], 1]);
  assert.throws(() => withRuleApprovalGroups(policy, ['nobody'], authorities, 'code'), (error) => error.code === 'TASK_RULE_GROUP_UNKNOWN'
    && error.details.nextAction.command === 'singularity-flow rules');
});

test('by: the Rules place says who also approves, writes by, offers the repository\'s groups, and checks it at every door', async () => {
  const definition = withSecurity(undefined);
  const labelOf = (id) => definition.workTypes[id]?.label ?? id;
  const groupLabelOf = (id) => definition.approvalAuthorities[id]?.label ?? id;
  const [view] = ruleViews({ paths: [PAYMENTS] }, { labelOf, groupLabelOf });
  assert.equal(view.words, 'When a task touches src/payments/**: a person approves the code, and Security approves it too.');
  assert.equal(view.fields.by, 'security');
  assert.equal(ruleViews({ always: [{ personApproves: ['test'], by: 'security', because: 'b' }] }, { groupLabelOf })[0].then,
    'a person approves the test results, and Security approves them too');
  // The form's "Who approves" lists only this repository's groups.
  assert.deepEqual(ruleForm(definition).groups.at(-1), { id: 'security', label: 'Security' });
  assert.deepEqual(ruleForm({ workTypes: {} }).groups, [{ id: 'git-contributors', label: 'git-contributors' }]);
  // tasks.rule.add and tasks.rule.change write `by` after personApproves, and the id says it.
  const document = YAML.parseDocument(TEMPLATE);
  const summary = applyTaskRuleChange(document, { op: 'tasks.rule.add', rule: { paths: ['src/payments/**'], personApproves: ['code'], by: 'security',
    because: 'Touching payments needs Security\'s approval.' } }, { labelOf, groupLabelOf });
  assert.equal(summary, 'Rule touching-src-payments-person-approves-code-by-security added: when a task touches src/payments/**, a person approves the code, and Security approves it too.');
  assert.match(document.toString(), /- id: touching-src-payments-person-approves-code-by-security\n\s+paths: \[ src\/payments\/\*\* \]\n\s+personApproves: \[ code \]\n\s+by: security\n\s+because: Touching payments/u);
  applyTaskRuleChange(document, { op: 'tasks.rule.change', id: 'touching-src-payments-person-approves-code-by-security',
    rule: { paths: ['src/payments/**'], personApproves: ['code'], because: 'Payments code is read by a person.' } });
  assert.equal(document.toJS().tasks.paths[0].by, undefined, 'a change can take the group away again: the rule is the team\'s');
  assert.throws(() => applyTaskRuleChange(YAML.parseDocument('version: 4\n'), { op: 'tasks.rule.add', rule: { kinds: ['change'], workflow: 'classic-delivery',
    by: 'security', because: 'x' } }), (error) => error.code === 'TASK_RULE_CHANGE_INVALID');
  assert.equal(ruleSlug({ kinds: ['all'], paths: [], steps: [], personApproves: ['plan'], workflow: null, by: 'security' }), 'person-approves-plan-by-security');
  // The preview: what the rule adds, said as the plan line says it; an unknown group is a problem with its field.
  const preview = await previewRuleChanges(definition, YAML.stringify(definition), { changes: [{ op: 'tasks.rule.add', rule: { kinds: ['fix'],
    paths: ['src/payments/**'], personApproves: ['code'], by: 'security', because: 'Touching payments needs Security\'s approval.' } }] });
  assert.equal(preview.valid, true, JSON.stringify(preview.problems));
  assert.deepEqual(preview.lines.map((line) => [line.kind, line.touching]), [['fix', 'src/payments/x.ts']], 'the group changes the fix, though no step is added');
  assert.match(preview.lines[0].words, /You approve the plan in the intake and the code\. Security approves the code\./u);
  const unknown = await previewRuleChanges(definition, YAML.stringify(definition), { changes: [{ op: 'tasks.rule.add', rule: { paths: ['src/payments/**'],
    personApproves: ['code'], by: 'auditors', because: 'x' } }] });
  assert.deepEqual([unknown.valid, unknown.problems.map((problem) => problem.field)], [false, ['tasks.paths[0].by']]);
  // A change that takes away the group a rule names brings the problem: refused, though the rule is untouched.
  const ruled = withSecurity({ paths: [PAYMENTS] });
  const removed = structuredClone(ruled);
  delete removed.approvalAuthorities.security;
  assert.deepEqual(taskRuleChecks(ruled, removed).refused.map((problem) => problem.field), ['tasks.paths[0].by']);
  // A proposal that adds the group reads as a change to the rule.
  const plainRule = { ...PAYMENTS };
  delete plainRule.by;
  assert.deepEqual(taskRulesChange(withSecurity({ paths: [plainRule] }), ruled).changes.map((entry) => [entry.change, entry.words]),
    [['changed', 'When a task touches src/payments/**: a person approves the code, and Security approves it too.']]);
});

test('by: the team\'s own workflow is the plan with the group added to those steps, as every rule adds to it (ITW v1.2 REQ-107)', () => {
  const definition = withSecurity({ paths: [PAYMENTS] });
  definition.workTypes['secure-fix'] = { label: 'Secure fix', phases: ['intake', 'implementation', 'verification'] };
  const composition = composeTask(definition, { kind: 'fix', touchedPaths: ['src/payments/round.mjs'] });
  const approvals = { intake: 'person', implementation: 'person', verification: 'sflow' };
  const without = localWorkflowCandidate(definition, 'secure-fix', { approvals });
  assert.equal(planCoverage(composition, without).covers, true, 'the rule adds Security to it, so nothing is lost');
  const withGroup = localWorkflowCandidate(definition, 'secure-fix', { approvals, groups: { implementation: ['security'] } });
  assert.equal(planCoverage(composition, withGroup).covers, true);
  assert.equal(planCoverage(composeTask(definition, { kind: 'fix' }), without).covers, true, 'no group added, nothing more asked');
  // Run as the plan, the team's workflow keeps its steps and order, and its code step needs Security too.
  const onIt = composeTask(definition, { kind: 'fix', touchedPaths: ['src/payments/round.mjs'], workflow: { workflow: 'secure-fix' } });
  assert.deepEqual([onIt.workType, onIt.uses, onIt.local, onIt.steps.map((step) => step.id)],
    ['task-fix', undefined, { workflow: 'secure-fix', label: 'Secure fix' }, ['intake', 'implementation', 'verification']]);
  assert.deepEqual(onIt.groupApproves, [{ intent: 'code', group: 'security', rule: 'payments-security', because: PAYMENTS.because, label: 'Security' }]);
  const code = resolved(definition, onIt).phases.find((phase) => phase.id === 'implementation');
  assert.deepEqual(code.approval.requiredAuthorities, ['security']);
});

// ---------------------------------------------------------------------- through the CLI

test('by: a paths rule\'s group must approve: the step\'s own approver\'s yes does not complete it, a person outside is refused, Security approves',
  slowLane({ timeout: 1_800_000 }), async (t) => {
    const story = await journeyRepository(t, {
      files: { 'src/payments/round.mjs': 'export const round = (value) => Math.round(value);\n' },
      configure: (configuration) => {
        // The intake's own group names one person, so someone outside it and outside Security is refused.
        configuration.approvalAuthorities['product-approvers'] = { ...configuration.approvalAuthorities['product-approvers'], allowAnyGitIdentity: false,
          members: [{ email: 'journey.driver@example.com' }] };
        configuration.approvalAuthorities.security = SECURITY;
        configuration.tasks = { paths: [{ id: 'payments-security', paths: ['src/payments/**'], personApproves: ['intake'], by: 'security',
          because: 'Touching payments needs Security\'s approval.' }] };
      }
    });
    Object.assign(story, { workId: 'TASK-1', item: 'singularity/work-items/TASK-1' });
    const words = 'fix the payments rounding so it rounds half up';
    const shown = JSON.parse(story.cli('work', words, '--kind', 'fix', '--path', 'src/payments/round.mjs', '--json'));
    // A fix sized by its requirement (ITW v1.2): the rule's group approves the requirement.
    assert.match(shown.plan, /You approve the requirement and the code\. Security approves the requirement\./u, shown.plan);
    const walk = await followRoutes(story, {
      label: 'task by group', start: { shell: `singularity-flow work "${words}" --kind fix --path src/payments/round.mjs --start` },
      agent: generatedAgent('TASK-1'), person: generatedPerson(story, 'TASK-1'),
      done: ({ record }) => record?.phases?.intake?.status === 'awaiting_approval', maxSteps: 40
    });
    t.diagnostic(formatTrail(walk.trail));
    assert.equal(walk.reached, true, formatTrail(walk.trail));
    const record = storyRecord(story);
    assert.deepEqual(record.resolution.composition.groupApproves.map((entry) => [entry.intent, entry.group, entry.rule]), [['intake', 'security', 'payments-security']]);
    const policy = record.phases.intake.approvalPolicy;
    assert.deepEqual([policy.authorities, policy.requiredAuthorities, policy.minimum], [['product-approvers', 'security'], ['security'], 2]);
    // Starting the Story enrolled its person in the groups, but never in the one a rule names: its approval is not anyone's.
    assert.deepEqual(record.resolution.approvalAuthorities.security.members.map((member) => member.email), ['security.lead@example.com']);
    const as = (name, args) => story.raw(['--no-model', ...args], { environment: { ...story.env, SINGULARITY_FLOW_TEST_IDENTITY: name } });
    // The step's own approver: recorded, and the step still waits for Security.
    const own = as('Journey Driver', ['approve', 'intake', '--yes', '--json']);
    assert.equal(own.status, 0, `${own.stdout}\n${own.stderr}`);
    const waiting = storyRecord(story).phases.intake;
    assert.equal(waiting.status, 'awaiting_approval', 'the step\'s own approver\'s yes does not complete it');
    assert.deepEqual(waiting.approvals.filter((entry) => !entry.invalidatedAt).map((entry) => entry.authorityGroup), ['product-approvers']);
    // Someone outside the step's groups and Security: refused, naming who may approve.
    const outside = as('Other Developer', ['approve', 'intake', '--yes', '--json']);
    assert.notEqual(outside.status, 0);
    assert.match(`${outside.stdout}\n${outside.stderr}`, /APPROVAL_IDENTITY_NOT_AUTHORIZED/u);
    assert.match(`${outside.stdout}\n${outside.stderr}`, /security/u);
    assert.equal(storyRecord(story).phases.intake.status, 'awaiting_approval');
    // A member of Security approves: the step is approved, with both groups recorded.
    const security = as('Security Lead', ['approve', 'intake', '--yes', '--json']);
    assert.equal(security.status, 0, `${security.stdout}\n${security.stderr}`);
    const approved = storyRecord(story).phases.intake;
    assert.equal(approved.status, 'approved');
    assert.deepEqual(approved.approvals.filter((entry) => !entry.invalidatedAt).map((entry) => entry.authorityGroup).sort(), ['product-approvers', 'security']);
  });
