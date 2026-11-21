/**
 * Step intents, Stage 2 (step intents spec §5, §7.2, §7.5, §7.6, §7.7): a work type whose steps all say what they are
 * for, in a version 4 workflow.yml, derives every setting a step does not set itself from its intent's profile and
 * the workflow rules; every other work type resolves exactly as before.
 *
 * - Opt-in only: no intents, some intents, or a version 2/3 file resolve byte for byte as without step intents.
 * - Precedence: SFlow's safety rules, the workflow's override, the shared step's own value, the profile with the
 *   workflow rules, the engine's defaults; nested settings and `because` merge key by key.
 * - One fixture per row of §5, and each contradiction of §7.5 with its fix.
 * - `intentProfiles`, the pinned profile and the version 4 file.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { approvesAutomatically } from '../src/approval-authority.mjs';
import { phaseRequiresCodeDelivery } from '../src/code-delivery-policy.mjs';
import { assertWorkTypeStartable, resolveWorkType, validateDefinition, WORKFLOW_FILE_VERSIONS } from '../src/config.mjs';
import { mergePhaseOverride } from '../src/phase-overrides.mjs';
import {
  deriveWorkTypeSettings, FIRST_INTENT_PROFILE, INTENTS_FILE_VERSION, pinnedIntentProfile, workTypeDerivesIntents
} from '../src/step-intent-settings.mjs';
import { PACKAGED_STEP_INTENTS } from '../src/step-intents.mjs';
import { assertImportedIntentsDerive } from '../src/workflow-transfer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = readFileSync(path.join(ROOT, 'templates/workflow.yml'), 'utf8');
const packaged = () => YAML.parse(TEMPLATE);
const REASON = 'Adds the missing regression tests itself, so a person approves it.';

/** The packaged configuration at `version`, with a work type `custom` of the given steps ({ id, intent, label?, ...settings }). */
function definition(steps, { workType = {}, version = INTENTS_FILE_VERSION, intentProfiles, approvalAuthorities } = {}) {
  const value = packaged();
  value.version = version;
  if (intentProfiles !== undefined) value.intentProfiles = intentProfiles;
  if (approvalAuthorities) {
    // Another repository's groups: only the custom workflow, whose steps name none.
    value.approvalAuthorities = approvalAuthorities;
    value.phases = {};
    value.workTypes = {};
    delete value.documents;
    delete value.contextPolicy;
    delete value.mcpServers;
  }
  for (const { id, label, ...settings } of steps) {
    value.phases[id] = { label: label ?? id, artifact: { path: `artifacts/${id}/${id}.md`, ...(settings.artifact ?? {}) }, defaultTemplate: 'common/intake.md',
      ...Object.fromEntries(Object.entries(settings).filter(([key]) => key !== 'artifact')) };
  }
  value.workTypes.custom = { label: 'Custom', phases: steps.map((step) => step.id), ...workType };
  return value;
}
const resolve = (steps, options) => resolveWorkType(validateDefinition(definition(steps, options)), 'custom');
const byId = (resolved) => Object.fromEntries(resolved.phases.map((phase) => [phase.id, phase]));
const who = (phase) => (phase.approval.mode === 'none' ? 'none' : phase.approval.mode === 'policy' ? 'policy'
  : approvesAutomatically(phase.approval) ? 'sflow' : 'person');
const refusal = (steps, options) => {
  try { validateDefinition(definition(steps, options)); } catch (error) { return error; }
  return null;
};

// A payments workflow named against its intents: names decide nothing.
const FEATURE = [
  { id: 'gather-needs', intent: 'intake', label: 'Write the report' },
  { id: 'pay-rules', intent: 'requirements', label: 'Ship it' },
  { id: 'pay-shape', intent: 'design', label: 'Run the tests' },
  { id: 'pay-steps', intent: 'plan', label: 'Code review' },
  { id: 'pay-build', intent: 'code', label: 'Plan the work' },
  { id: 'pay-check', intent: 'test', label: 'Gather the request' },
  { id: 'pay-conform', intent: 'review', label: 'Design it' }
];

test('opt-in only: no intents, some intents, or an older file resolve byte for byte as without step intents', () => {
  const plain = validateDefinition(packaged());
  // Version 4 alone changes nothing: a file that uses no intents means the same at 3 and 4.
  const four = validateDefinition({ ...packaged(), version: 4 });
  for (const id of Object.keys(plain.workTypes)) {
    assert.equal(JSON.stringify(resolveWorkType(four, id)), JSON.stringify(resolveWorkType(plain, id)), `${id} at version 4`);
    assert.equal(workTypeDerivesIntents(four, four.workTypes[id]), false);
  }
  // Every step of every shipped workflow with its intent, at version 3: still derives nothing.
  const annotated = packaged();
  for (const [id, phase] of Object.entries(annotated.phases)) phase.intent = PACKAGED_STEP_INTENTS[id] ?? 'document';
  const three = validateDefinition(annotated);
  for (const id of Object.keys(plain.workTypes)) assert.equal(JSON.stringify(resolveWorkType(three, id)), JSON.stringify(resolveWorkType(plain, id)), `${id} at version 3`);
  // A work type with one step that says nothing derives nothing, at version 4: as if no step said anything.
  const partial = FEATURE.map((step, index) => (index === 4 ? { ...step, intent: undefined, generation: { task: 'code' }, writeScope: 'source-and-artifact' } : step));
  const withSome = resolve(partial.map(({ intent, ...rest }) => (intent ? { ...rest, intent } : rest)));
  const withNone = resolve(partial.map(({ intent: _intent, ...rest }) => rest));
  assert.equal(JSON.stringify(withSome), JSON.stringify(withNone));
  assert.equal(withSome.phases.some((phase) => Object.hasOwn(phase, 'intent') || Object.hasOwn(phase, 'intentProfile')), false);
  assert.deepEqual(WORKFLOW_FILE_VERSIONS, [2, 3, 4]);
});

test('a workflow of intents gets exactly what profile 1 says, whatever its steps are called', () => {
  const resolved = resolve(FEATURE);
  assertWorkTypeStartable(resolved);
  const steps = byId(resolved);
  // Only the code step changes source files and is a code step; each output is recognised by its intent.
  assert.deepEqual(resolved.phases.map((phase) => [phase.id, phase.writeScope ?? 'artifact-only', phaseRequiresCodeDelivery(phase), phase.artifact.kind]), [
    ['gather-needs', 'artifact-only', false, 'intake'], ['pay-rules', 'artifact-only', false, 'requirements'], ['pay-shape', 'artifact-only', false, 'design'],
    ['pay-steps', 'artifact-only', false, 'implementation-plan'], ['pay-build', 'source-and-artifact', true, 'implementation-summary'],
    ['pay-check', 'artifact-only', false, 'test-evidence'], ['pay-conform', 'artifact-only', false, 'conformance-report']]);
  // Approve twice: a person approves the plan and the code; SFlow approves the rest when clean.
  assert.deepEqual(resolved.phases.map(who), ['sflow', 'sflow', 'sflow', 'person', 'person', 'sflow', 'sflow']);
  // The intake asks every time; the others when needed, with the profile's limits.
  assert.deepEqual(resolved.phases.map((phase) => [phase.clarification.mode, phase.clarification.maxQuestions]), [
    ['required', 5], ['when-needed', 5], ['when-needed', 5], ['when-needed', 5], ['when-needed', 3], ['when-needed', 3], ['when-needed', 3]]);
  // The profile's approver groups (this repository has them), and send-back to any earlier step or itself.
  assert.deepEqual(resolved.phases.map((phase) => phase.approval.authorities[0]), ['product-approvers', 'product-approvers', 'architecture-reviewers',
    'architecture-reviewers', 'engineering-reviewers', 'quality-reviewers', 'quality-reviewers']);
  assert.deepEqual(steps['pay-check'].approval.rejectTo, ['gather-needs', 'pay-rules', 'pay-shape', 'pay-steps', 'pay-build', 'pay-check']);
  // The test step runs the repository's tests and cites the code step's results, which it reads; the review cites them too.
  assert.equal(steps['pay-check'].repositoryTests, 'run');
  assert.deepEqual([steps['pay-check'].testEvidenceFrom, steps['pay-conform'].testEvidenceFrom], ['pay-build', 'pay-build']);
  assert.deepEqual(steps['pay-check'].inputs.map((input) => input.phase), ['pay-rules', 'pay-build']);
  assert.deepEqual(steps['pay-build'].inputs.map((input) => input.phase), ['pay-rules', 'pay-shape', 'pay-steps']);
  assert.deepEqual(steps['gather-needs'].inputs, []);
  // The requirement IDs and the plan owner, and the steps that take attached documents.
  assert.deepEqual([resolved.plannedClaims.mode, resolved.plannedClaims.clausePhases, resolved.plannedClaims.owners],
    ['required', ['pay-rules'], { 'pay-build': 'pay-steps' }]);
  assert.deepEqual(resolved.documents.allowedPhases, ['gather-needs', 'pay-rules', 'pay-shape', 'pay-steps']);
  // Each step pins its intent and the profile it derived from (spec §7.6).
  assert.deepEqual(resolved.phases.map((phase) => [phase.intent, phase.intentProfile]), FEATURE.map((step) => [step.intent, 1]));
  assert.equal(pinnedIntentProfile(resolved), 1);
  assert.equal(pinnedIntentProfile(resolveWorkType(validateDefinition(packaged()), 'feature')), null);
});

test('names decide nothing: the same intents under other names derive the same settings and the same route shape', () => {
  const renamed = FEATURE.map((step, index) => ({ ...step, id: `step-${String.fromCharCode(97 + index)}`, label: `Step ${index}` }));
  const left = resolve(FEATURE);
  const right = resolve(renamed);
  assert.equal(left.obligationGraph.shapeDigest, right.obligationGraph.shapeDigest);
  const shape = (resolved) => resolved.phases.map((phase) => [phase.writeScope ?? null, phase.artifact.kind, who(phase), phase.clarification.mode,
    phase.repositoryTests ?? null, Boolean(phase.testEvidenceFrom), phase.inputs.length]);
  assert.deepEqual(shape(right), shape(left));
});

test('precedence: the workflow\'s override, then the step\'s own setting, then the intent; key by key, with every reason kept', () => {
  const steps = FEATURE.map((step) => (step.id === 'pay-check'
    ? { ...step, writeScope: 'source-and-artifact', clarification: { maxQuestions: 2 }, because: { writeScope: REASON } } : step));
  const workType = { phaseOverrides: { 'pay-check': { approval: { authorities: ['engineering-reviewers'] }, because: { approval: 'Engineering signs off the payment checks here.' } },
    'pay-conform': { approval: { automatic: 'off' }, because: { 'approval.automatic': 'A person signs the final payments review, always.' } } } };
  const resolved = byId(resolve(steps, { workType }));
  const check = resolved['pay-check'];
  // The step's own writeScope and question count win; the intent still gives the mode; the override's group wins.
  assert.deepEqual([check.writeScope, check.clarification.mode, check.clarification.maxQuestions, check.approval.authorities],
    ['source-and-artifact', 'when-needed', 2, ['engineering-reviewers']]);
  // SFlow's rule over the intent: a step that changes source files is a person's to approve, and cites nothing.
  assert.equal(who(check), 'person');
  assert.equal(check.testEvidenceFrom, undefined);
  assert.equal(resolved['pay-conform'].testEvidenceFrom, undefined, 'nothing since the last code step may cite its results once a later step changed source');
  // `because` merges key by key, and the step pins it; `automatic: off` keeps a person on a step SFlow would approve.
  assert.deepEqual(check.because, { writeScope: REASON, approval: 'Engineering signs off the payment checks here.' });
  assert.equal(who(resolved['pay-conform']), 'person');
  assert.equal(Object.hasOwn(resolved['pay-conform'].approval, 'automatic'), false);
  // The shared merge keeps a step without reasons in its own shape.
  assert.equal(Object.hasOwn(mergePhaseOverride({ label: 'x' }, { label: 'y' }), 'because'), false);
  assert.deepEqual(mergePhaseOverride({ because: { writeScope: REASON } }, { because: { approval: REASON } }).because, { writeScope: REASON, approval: REASON });
  // Outside a workflow of intents, `automatic: off` is still refused, as it always was.
  const three = definition(FEATURE.map((step) => (step.id === 'pay-conform' ? { ...step, approval: { automatic: 'off' } } : step)), { version: 3 });
  assert.throws(() => validateDefinition(three), (error) => error.code === 'AUTOMATIC_APPROVAL_NOT_ALLOWED');
});

test('where each setting came from: intent, workflow rule, the step, the workflow\'s override or an SFlow rule', () => {
  const steps = FEATURE.map((step) => (step.id === 'pay-check' ? { ...step, writeScope: 'source-and-artifact', because: { writeScope: REASON } } : step));
  const derived = deriveWorkTypeSettings(validateDefinition(definition(steps)), 'custom');
  const sources = Object.fromEntries(derived.steps.map((step) => [step.id, step.sources]));
  assert.deepEqual(sources['pay-check'].writeScope, { from: 'shared-step', reason: REASON });
  assert.deepEqual(sources['pay-check'].approval, { from: 'safety-rule', reason: 'it changes source files, so a person approves it' });
  assert.equal(sources['pay-steps'].approval.from, 'intent');
  assert.equal(sources['gather-needs']['clarification.mode'].from, 'intent');
  assert.equal(sources['pay-rules']['artifact.kind'].from, 'intent');
  assert.equal(sources['pay-conform'].testEvidenceFrom.from, 'workflow-rule');
  assert.deepEqual(derived.workType.sources['plannedClaims.clausePhases'].from, 'workflow-rule');
  // The reason is said once, so no warning; without it, the changed setting is named with its fix.
  assert.deepEqual(derived.warnings, []);
  const silent = deriveWorkTypeSettings(validateDefinition(definition(steps.map(({ because: _because, ...step }) => step))), 'custom');
  assert.deepEqual(silent.warnings.map((entry) => [entry.code, entry.step, entry.setting]), [['CHECK_INTENT_OVERRIDE_WITHOUT_REASON', 'pay-check', 'writeScope']]);
  assert.match(silent.warnings[0].fix, /because: \{ writeScope: "Why this step differs from its intent\." \}/u);
});

test('§5: who writes the requirement IDs, and who plans each code step', () => {
  const ids = (steps, options) => { const resolved = resolve(steps, options); return [resolved.plannedClaims.clausePhases, resolved.plannedClaims.owners]; };
  // No requirements step: the first plan writes them, and is recognised as the specification.
  let resolved = resolve([{ id: 'ask', intent: 'intake' }, { id: 'spec', intent: 'plan' }, { id: 'make', intent: 'code' }]);
  assert.deepEqual([resolved.plannedClaims.clausePhases, resolved.plannedClaims.owners, byId(resolved).spec.artifact.kind], [['spec'], { make: 'spec' }, 'implementation-spec']);
  // No plan either: the intake writes them, is recognised as requirements, plans the code step and is a person's.
  resolved = resolve([{ id: 'ask', intent: 'intake' }, { id: 'make', intent: 'code' }, { id: 'prove', intent: 'test' }]);
  assert.deepEqual([resolved.plannedClaims.clausePhases, resolved.plannedClaims.owners], [['ask'], { make: 'ask' }]);
  assert.deepEqual([byId(resolved).ask.artifact.kind, who(byId(resolved).ask)], ['requirements', 'person']);
  assertWorkTypeStartable(resolved);
  // The nearest design plans a code step when there is no plan step.
  assert.deepEqual(ids([{ id: 'rules', intent: 'requirements' }, { id: 'think', intent: 'design' }, { id: 'make', intent: 'code' }]), [['rules'], { make: 'think' }]);
  // Several code steps: each gets its planner (the nearest plan before it, else the nearest design), and each is a person's.
  resolved = resolve([{ id: 'rules', intent: 'requirements' }, { id: 'p1', intent: 'plan' }, { id: 'c1', intent: 'code' }, { id: 'd2', intent: 'design' },
    { id: 'c2', intent: 'code' }, { id: 't', intent: 'test' }]);
  assert.deepEqual(resolved.plannedClaims.owners, { c1: 'p1', c2: 'p1' });
  assert.deepEqual(resolved.phases.map(who), ['sflow', 'person', 'person', 'sflow', 'person', 'sflow']);
  assertWorkTypeStartable(resolved);
  resolved = resolve([{ id: 'rules', intent: 'requirements' }, { id: 'd1', intent: 'design' }, { id: 'c1', intent: 'code' }, { id: 'd2', intent: 'design' },
    { id: 'c2', intent: 'code' }]);
  assert.deepEqual(resolved.plannedClaims.owners, { c1: 'd1', c2: 'd2' });
  assert.deepEqual(resolved.phases.map(who), ['sflow', 'person', 'person', 'person', 'person']);
  assertWorkTypeStartable(resolved);
  // The workflow's own plannedClaims keeps the rules' owners for what it does not say (G6: the plan writes IDs too).
  resolved = resolve(FEATURE, { workType: { plannedClaims: { mode: 'required', clausePhases: ['pay-rules', 'pay-steps'] },
    because: { plannedClaims: 'The technical specification adds its own IDs.' } } });
  assert.deepEqual([resolved.plannedClaims.clausePhases, resolved.plannedClaims.owners], [['pay-rules', 'pay-steps'], { 'pay-build': 'pay-steps' }]);
});

test('§5: nothing before a code step plans it, so Story start names the two ways on', () => {
  const resolved = resolve([{ id: 'make', intent: 'code' }, { id: 'prove', intent: 'test' }]);
  assert.deepEqual(resolved.plannedClaims.unplanned, ['make']);
  assert.throws(() => assertWorkTypeStartable(resolved), (error) => error.code === 'WORKFLOW_PLANNED_CLAIMS_MIGRATION_REQUIRED'
    && /Nothing before make plans its change\. Add a short plan step before it \(recommended\), or let it plan its own change/u.test(error.message)
    && error.details.nextAction.command === 'singularity-flow workflow studio');
  // A design plans the code step, but no step writes the requirements it builds: the same, with its own two ways on.
  const unscoped = resolve([{ id: 'think', intent: 'design' }, { id: 'make', intent: 'code' }]);
  assert.throws(() => assertWorkTypeStartable(unscoped), (error) => error.code === 'WORKFLOW_PLANNED_CLAIMS_MIGRATION_REQUIRED'
    && /No step before make writes the requirements it builds\. Add an intake or requirements step before it \(recommended\)/u.test(error.message)
    && /requirements step/u.test(error.details.nextAction.label));
  // The second way: the workflow says it leaves out scope and plan, with its reasons.
  const omitted = resolve([{ id: 'make', intent: 'code' }, { id: 'prove', intent: 'test' }], { workType: { omits: [
    { responsibility: 'scope', reason: 'Careful change works from its own instructions.', authority: 'engineering-reviewers' },
    { responsibility: 'plan', reason: 'Careful change plans and makes the change in its one step.', authority: 'engineering-reviewers' }] } });
  assert.equal(omitted.plannedClaims.mode, 'omitted');
  assertWorkTypeStartable(omitted);
});

test('§5 and D5: a workflow that changes no code leaves out what no step holds, and a person approves its scope and its last step', () => {
  let resolved = resolve([{ id: 'ask', intent: 'intake' }, { id: 'think', intent: 'design' }, { id: 'write', intent: 'document' }, { id: 'tell', intent: 'report' }]);
  assertWorkTypeStartable(resolved);
  assert.deepEqual(resolved.phases.map(who), ['person', 'sflow', 'sflow', 'person']);
  assert.equal(resolved.plannedClaims.mode, 'disabled');
  assert.equal(byId(resolved).ask.artifact.kind, 'requirements', 'the scope step defines clauses in a code-free workflow too');
  const omits = resolved.obligationGraph.edges.find((edge) => edge.to === '$end').omits;
  assert.deepEqual(omits.map((entry) => [entry.responsibility, entry.authority]), [['implement', 'quality-reviewers'], ['verify', 'quality-reviewers']]);
  assert.match(omits[0].reason, /changes no code/u);
  // A test-only workflow: one step, one person approval, the repository's tests, and scope, plan and implement left out.
  resolved = resolve([{ id: 'run-them', intent: 'test' }]);
  assertWorkTypeStartable(resolved);
  assert.deepEqual([who(resolved.phases[0]), resolved.phases[0].repositoryTests, resolved.phases[0].testEvidenceFrom], ['person', 'run', undefined]);
  assert.deepEqual(resolved.obligationGraph.edges.find((edge) => edge.to === '$end').omits.map((entry) => entry.responsibility), ['scope', 'plan', 'implement']);
  // An omission the workflow declares keeps its own reason; the rule adds only what is missing.
  resolved = resolve([{ id: 'run-them', intent: 'test' }], { workType: { omits: [{ responsibility: 'scope', reason: 'A test run checks the product as it is.', authority: 'product-approvers' }] } });
  assert.deepEqual(resolved.obligationGraph.edges.find((edge) => edge.to === '$end').omits.map((entry) => [entry.responsibility, entry.authority]),
    [['scope', 'product-approvers'], ['plan', 'quality-reviewers'], ['implement', 'quality-reviewers']]);
});

test('§5: decisions, rework loops and the design capture keep a step with a person; one step asks every time', () => {
  const loop = resolve(FEATURE, { workType: { reworkLoops: [{ from: 'pay-conform', to: 'pay-build', maxAttempts: 2 }] } });
  assert.equal(who(byId(loop)['pay-conform']), 'person');
  assertWorkTypeStartable(loop);
  const capture = resolve([{ id: 'take-designs', intent: 'intake' }, { id: 'map', intent: 'design' }, { id: 'make', intent: 'code' }],
    { workType: { designSources: { capturePhase: 'take-designs' } } });
  assert.equal(who(byId(capture)['take-designs']), 'person');
  // With no intake, the first document step asks every time; a workflow that starts with code has none.
  assert.equal(resolve([{ id: 'rules', intent: 'requirements' }, { id: 'make', intent: 'code' }]).phases[0].clarification.mode, 'required');
  const codeFirst = resolve([{ id: 'make', intent: 'code' }, { id: 'prove', intent: 'test' }]);
  assert.deepEqual(codeFirst.phases.map((phase) => phase.clarification.mode), ['when-needed', 'when-needed']);
  // A step SFlow builds itself asks nothing and cites nothing.
  const built = byId(resolve([{ id: 'ask', intent: 'intake' }, { id: 'make', intent: 'code' }, { id: 'prove', intent: 'test',
    generation: { producer: 'deterministic' }, because: { 'generation.producer': 'SFlow runs the checks itself and writes the summary.' } }]));
  assert.deepEqual([built.prove.clarification.mode, built.prove.testEvidenceFrom], ['off', undefined]);
});

test('approver groups: the profile\'s when the repository has it, else its first group', () => {
  const groups = { 'git-contributors': { label: 'Git contributors', allowAnyGitIdentity: true, members: [] }, 'quality-reviewers': { label: 'QA', members: [], allowAnyGitIdentity: true } };
  const resolved = resolve(FEATURE, { approvalAuthorities: groups, workType: {} });
  assert.deepEqual(resolved.phases.map((phase) => phase.approval.authorities[0]), ['git-contributors', 'git-contributors', 'git-contributors',
    'git-contributors', 'git-contributors', 'quality-reviewers', 'quality-reviewers']);
});

test('§7.5: what contradicts a step\'s intent is refused at load, each with its fix', () => {
  const refusedWith = (steps, field, pattern, options) => {
    const error = refusal(steps, options);
    assert.equal(error?.code, 'STEP_INTENT_INVALID', `${field}: ${error?.message}`);
    assert.equal(error.details.field, field);
    assert.match(error.message, pattern);
    assert.equal(error.details.nextAction.command, 'singularity-flow workflow studio');
    assert.ok(error.details.fix.length > 20);
    return error;
  };
  const swap = (id, settings) => FEATURE.map((step) => (step.id === id ? { ...step, ...settings } : step));
  refusedWith(swap('pay-build', { writeScope: 'artifact-only' }), 'writeScope', /Plan the work is a code step \(intent code\), so it changes source files/u);
  refusedWith(swap('pay-check', { generation: { task: 'code' } }), 'generation.task', /is a test step, but its generation task is code/u);
  refusedWith(swap('pay-conform', { artifact: { kind: 'requirements' } }), 'artifact.kind', /Design it is a review step, but its output kind requirements is what a intake or requirements step writes/u);
  refusedWith(swap('pay-check', { artifact: { kind: 'scenario-notes' } }), 'artifact.kind', /test step, so SFlow recognises its output as test results/u);
  refusedWith([{ id: 'ask', intent: 'intake', artifact: { kind: 'ticket' } }, { id: 'make', intent: 'code' }], 'artifact.kind', /defines this workflow's requirements/u);
  refusedWith([...FEATURE.slice(0, 2), { id: 'again', intent: 'intake' }, ...FEATURE.slice(2)], 'intent', /is a second intake/u);
  refusedWith([FEATURE[1], FEATURE[0], ...FEATURE.slice(2)], 'intent', /is the intake, so it comes first/u);
  // Automatic approval on the plan, as configuration has always refused it.
  assert.throws(() => validateDefinition(definition(swap('pay-steps', { approval: { automatic: 'when-ready' } }))),
    (error) => error.code === 'AUTOMATIC_APPROVAL_NOT_ALLOWED' && /it is the plan/u.test(error.message));
  // A kind that is the step's own name for its output, or a refinement of its intent's, is no contradiction.
  const own = byId(resolve(swap('pay-shape', { artifact: { kind: 'reproduction' } })));
  assert.equal(own['pay-shape'].artifact.kind, 'reproduction');
  // A step SFlow builds may have no approval of its own when a later step reviews its results (poc-lite's check).
  const built = resolve([{ id: 'ask', intent: 'intake' }, { id: 'make', intent: 'code' }, { id: 'prove', intent: 'test', approval: 'none',
    generation: { producer: 'deterministic' } }, { id: 'ship', intent: 'release' }]);
  assertWorkTypeStartable(built);
  // A compiled skill step takes no intent: its reviewed binding decides how it runs.
  const skill = packaged();
  skill.version = 4;
  skill.phases['skill-step'] = { kind: 'skill', intent: 'design', label: 'Skill step' };
  assert.throws(() => validateDefinition(skill), (error) => error.code === 'STEP_INTENT_INVALID' && /compiled skill step/u.test(error.message));
});

test('§7.5 warnings: a review before any code, and a framework setting changed with no reason', () => {
  const derived = deriveWorkTypeSettings(validateDefinition(definition([{ id: 'ask', intent: 'intake' }, { id: 'look', intent: 'review' },
    { id: 'rules', intent: 'requirements', clarification: { mode: 'required' } }, { id: 'make', intent: 'code' }])), 'custom');
  assert.deepEqual(derived.warnings.map((entry) => [entry.code, entry.step, entry.setting ?? null]), [
    ['CHECK_INTENT_BEFORE_CODE', 'look', null], ['CHECK_INTENT_OVERRIDE_WITHOUT_REASON', 'rules', 'clarification.mode']]);
  assert.match(derived.warnings[0].fix, /Move look after make, or set its intent to design or document/u);
});

test('intentProfiles: version 4 only, absent means 1, and a newer one asks for the update', () => {
  assert.equal(resolve(FEATURE, { intentProfiles: 1 }).phases[0].intentProfile, 1);
  assert.equal(resolve(FEATURE).phases[0].intentProfile, FIRST_INTENT_PROFILE);
  const newer = refusal(FEATURE, { intentProfiles: 2 });
  assert.equal(newer?.code, 'WORKFLOW_VERSION_NEWER');
  assert.match(newer.message, /^This repository's workflows need a newer SFlow: they derive their settings from step intent profile 2, and this SFlow has profile 1\. Update SFlow/u);
  assert.deepEqual(newer.details.nextAction.argv, ['update']);
  for (const [value, pattern] of [['1', /must be a profile number/u], [0, /must be a profile number/u]]) {
    const error = refusal(FEATURE, { intentProfiles: value });
    assert.equal(error?.code, 'STEP_INTENT_INVALID');
    assert.match(error.message, pattern);
  }
  const older = refusal(FEATURE, { version: 3, intentProfiles: 1 });
  assert.match(older?.message ?? '', /intentProfiles is read only in a version 4 workflow\.yml, and this one is version 3/u);
});

test('the pin: an amendment derives with the Story\'s profile, not the repository\'s', () => {
  const resolved = resolve(FEATURE);
  const validated = validateDefinition(definition(FEATURE));
  // The Story's own profile resolves the same configuration exactly as it was pinned.
  assert.equal(JSON.stringify(resolveWorkType(validated, 'custom', { intentProfile: pinnedIntentProfile(resolved) })), JSON.stringify(resolved));
  // A profile this build does not have, pinned by a Story a newer SFlow started, asks for the update, not a guess.
  assert.throws(() => resolveWorkType(validated, 'custom', { intentProfile: 2 }),
    (error) => error.code === 'WORKFLOW_VERSION_NEWER' && /This Story's workflow derives its settings from step intent profile 2/u.test(error.message));
  // A Story pinned before step intents has no profile, and its amendment reads the file's.
  assert.equal(pinnedIntentProfile({ phases: [{ id: 'a' }] }), null);
  // A work type that derives nothing ignores the pin: its resolution has no profile to keep.
  const plain = validateDefinition(packaged());
  assert.equal(JSON.stringify(resolveWorkType(plain, 'feature', { intentProfile: 1 })), JSON.stringify(resolveWorkType(plain, 'feature')));
});

test('a work type\'s own because names only the work-type settings its intents give', () => {
  const error = refusal(FEATURE, { workType: { because: { writeScope: REASON } } });
  assert.equal(error?.code, 'STEP_INTENT_INVALID');
  assert.match(error.message, /Work type 'custom' because names 'writeScope', which is not a setting a workflow's intents give/u);
  assert.equal(refusal(FEATURE, { workType: { because: { 'sourceReview.skip': 'The release notes need no second reader here.' } } }), null);
});

test('an import never lands a workflow of intents in a file where it would run without them', () => {
  const target = packaged();
  const incoming = definition(FEATURE, { version: 3 });
  assert.throws(() => assertImportedIntentsDerive(incoming, target), (error) => error.code === 'WORKFLOW_INTENTS_VERSION_REQUIRED'
    && /Workflow custom says what every step is for, so it derives its settings from those intents, which needs workflow\.yml version 4\. This repository's workflow\.yml is version 3/u.test(error.message)
    && /Set version: 4 at the top of singularity\/workflow\.yml/u.test(error.message));
  // At version 4 it derives as where it came from; an unchanged workflow, or one with a step that has no intent, is not this import's.
  assert.doesNotThrow(() => assertImportedIntentsDerive(definition(FEATURE), target));
  assert.doesNotThrow(() => assertImportedIntentsDerive(incoming, incoming));
  assert.doesNotThrow(() => assertImportedIntentsDerive(definition(FEATURE.map((step, index) => (index ? step : { ...step, intent: undefined })), { version: 3 }), target));
});
