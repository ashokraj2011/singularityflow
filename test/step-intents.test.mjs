/**
 * Step intents, stages 0 and 1 (step intents spec, owner-approved 2026-11-20): the profile tables and their pure
 * derivation, the workflow rules (§5), the inference rules (§6.1), `intent:` and `because:` on steps, and the refusal an
 * older SFlow gives a workflow.yml from a newer one (§7.7). Nothing here changes how a Story runs: the resolution of
 * every shipped workflow is the same with intents declared on all its steps.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';

import { resolveWorkType, stepIntentFieldProblems, validateDefinition, WORKFLOW_FILE_VERSIONS } from '../src/config.mjs';
import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';
import { packagedWorkflowWithoutIntents } from '../src/workspace-configuration-refresh.mjs';
import {
  BECAUSE_SETTINGS, CURRENT_INTENT_PROFILE, deriveStepSettings, deriveWorkflowSettings, DOCUMENT_INTENTS, inferStepIntents, INTENT_PROFILES,
  intentProfile, PACKAGED_STEP_INTENTS, STEP_INTENTS, workflowIntentFacts
} from '../src/step-intents.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packaged = () => YAML.parse(readFileSync(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));
const REASON = 'Adds the missing regression tests itself, so a person approves it.';

const canonical = (value) => (Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value);
const sha256 = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

// A published profile never changes: an improvement is a new version (spec §7.6). Change a hash here only together
// with the spec, before Stage 2 ships the version it locks.
const PUBLISHED_PROFILE_SHA256 = Object.freeze({
  1: 'e8b8811b834405674cfea0a6e3349181ab78a520fd09b08a4af2e24e8b7daad8'
});

test('every published profile version is locked by its hash, and covers all ten intents', () => {
  assert.equal(STEP_INTENTS.length, 10);
  assert.deepEqual(Object.keys(INTENT_PROFILES).map(Number), Object.keys(PUBLISHED_PROFILE_SHA256).map(Number));
  for (const [version, digest] of Object.entries(PUBLISHED_PROFILE_SHA256)) {
    const profile = intentProfile(Number(version));
    assert.equal(sha256(profile), digest, `profile ${version} changed: publish an improvement as a new version`);
    assert.deepEqual(Object.keys(profile.intents).sort(), [...STEP_INTENTS].sort());
    assert.ok(Object.isFrozen(profile.intents.code), 'profiles are frozen data');
  }
  assert.equal(CURRENT_INTENT_PROFILE, 1);
  assert.throws(() => intentProfile(2), RangeError);
});

test('profile 1 as the spec tables give it (§4.2, D1, D6)', () => {
  const lone = (intent) => deriveStepSettings(intent);
  // Only a code step changes source files (D1: a test step runs the tests the code step wrote).
  for (const intent of STEP_INTENTS) assert.equal(lone(intent).writeScope, intent === 'code' ? 'source-and-artifact' : 'artifact-only', intent);
  // A lone intake or plan is a workflow with no code whose scope it defines, so it is recognised by a kind that defines
  // clauses (the §5 code-free rule, Stage 2); in a workflow with a requirements step they keep intake and implementation-plan.
  assert.deepEqual(STEP_INTENTS.map((intent) => [intent, lone(intent).artifactKind]), [
    ['intake', 'requirements'], ['requirements', 'requirements'], ['design', 'design'], ['plan', 'implementation-spec'],
    ['code', 'implementation-summary'], ['test', 'test-evidence'], ['review', 'conformance-report'], ['release', 'publication-review'],
    ['report', 'report'], ['document', 'document']]);
  assert.equal(lone('code').generationTask, 'code');
  // A person approves the plan and the code; SFlow the rest when clean (a lone step is a workflow with no code, so its own).
  assert.deepEqual(STEP_INTENTS.filter((intent) => intentProfile().intents[intent].approval === 'person'), ['plan', 'code']);
  assert.deepEqual(STEP_INTENTS.map((intent) => lone(intent).defaultAgent),
    ['product-owner', 'product-owner', 'architect', 'architect', 'developer', 'qa', 'qa', 'qa', 'qa', null]);
  assert.deepEqual(STEP_INTENTS.map((intent) => lone(intent).approvers), ['product-approvers', 'product-approvers', 'architecture-reviewers',
    'architecture-reviewers', 'engineering-reviewers', 'quality-reviewers', 'quality-reviewers', 'quality-reviewers', 'quality-reviewers', null]);
  assert.deepEqual(STEP_INTENTS.map((intent) => lone(intent).clarification.maxQuestions), [5, 5, 5, 5, 3, 3, 3, 3, 3, 3]);
  assert.deepEqual(STEP_INTENTS.filter((intent) => lone(intent).attachedDocuments), ['intake', 'requirements', 'design', 'plan']);
  assert.deepEqual(STEP_INTENTS.filter((intent) => lone(intent).repositoryTests === 'run'), ['test']);
  assert.deepEqual(STEP_INTENTS.filter((intent) => lone(intent).preparesCodeEnvironment), ['code', 'test']);
  assert.deepEqual(STEP_INTENTS.filter((intent) => lone(intent).repairBudget), ['code', 'test']);
  assert.deepEqual(lone('code').runtimeCheck.required, ['web', 'backend', 'job', 'cli', 'mobile'], 'D6: required for a runnable kind');
  assert.equal(lone('code').intentProfile, 1);
  assert.deepEqual(DOCUMENT_INTENTS, ['intake', 'requirements', 'design', 'plan', 'document']);
  assert.throws(() => deriveStepSettings('verification'), RangeError);
});

const steps = (...intents) => intents.map((intent, index) => ({ id: `s${index + 1}-${intent}`, intent }));
const derive = (list, options) => deriveWorkflowSettings(list, options);
const byId = (result) => Object.fromEntries(result.steps.map((step) => [step.id, step]));

test('§5: who writes the requirement IDs and who plans each code step', () => {
  // Every requirements step writes IDs; the plan plans the code step and is a person's.
  let result = derive(steps('intake', 'requirements', 'design', 'plan', 'code', 'test', 'review'));
  assert.deepEqual(result.facts.requirementIdSteps, ['s2-requirements']);
  assert.deepEqual(result.facts.planners, { 's5-code': 's4-plan' });
  assert.equal(byId(result)['s4-plan'].artifactKind, 'implementation-plan');
  assert.equal(byId(result)['s1-intake'].artifactKind, 'intake');
  // With no requirements step the first plan writes them, and is recognised as the specification.
  result = derive(steps('intake', 'plan', 'code'));
  assert.deepEqual(result.facts.requirementIdSteps, ['s2-plan']);
  assert.equal(byId(result)['s2-plan'].artifactKind, 'implementation-spec');
  // With neither, the intake writes them and plans the code step.
  result = derive(steps('intake', 'code', 'test'));
  assert.deepEqual([result.facts.requirementIdSteps, result.facts.planners], [['s1-intake'], { 's2-code': 's1-intake' }]);
  assert.equal(byId(result)['s1-intake'].artifactKind, 'requirements');
  assert.equal(byId(result)['s1-intake'].approval.by, 'person', 'the intake is the plan here');
  // The nearest design plans a code step when there is no plan step.
  result = derive(steps('requirements', 'design', 'code'));
  assert.deepEqual(result.facts.planners, { 's3-code': 's2-design' });
  assert.equal(byId(result)['s2-design'].approval.by, 'person');
  // A workflow that leaves the scope out has no IDs, and no planned claims to own.
  result = derive(steps('plan', 'code'), { omitsScope: true });
  assert.deepEqual([result.facts.requirementIdSteps, result.facts.plannedClaimOwners, result.facts.planners], [[], {}, { 's2-code': 's1-plan' }]);
  // Nothing before the code step: it is unplanned, which the builder asks about once (Stage 3).
  result = derive(steps('code', 'test'));
  assert.deepEqual([result.facts.unplanned, result.facts.planSteps], [['s1-code'], []]);
});

test('§5: several code steps each get their planner, and each is a person\'s', () => {
  const result = derive(steps('requirements', 'plan', 'code', 'design', 'code', 'test'));
  assert.deepEqual(result.facts.planners, { 's3-code': 's2-plan', 's5-code': 's2-plan' });
  for (const id of ['s3-code', 's5-code']) assert.equal(byId(result)[id].approval.by, 'person');
});

test('§5 and D5: a workflow that changes no code has a person approve its scope and its last step', () => {
  let result = derive(steps('intake', 'requirements', 'design', 'report'));
  assert.equal(result.facts.codeFree, true);
  assert.deepEqual(result.facts.requirementIdSteps, [], 'IDs are pinned only with a code step');
  assert.deepEqual(result.steps.map((step) => step.approval.by), ['sflow-when-clean', 'person', 'sflow-when-clean', 'person']);
  // A single step has one approval; a test-only workflow runs the repository's tests.
  result = derive(steps('test'));
  assert.deepEqual([result.steps[0].approval.by, result.steps[0].repositoryTests, result.steps[0].testEvidenceFrom], ['person', 'run', null]);
});

test('§5: decisions, rework loops and the design capture hand a step to a person; a held approval too', () => {
  const list = steps('intake', 'design', 'design', 'plan', 'code', 'review');
  const result = byId(derive(list, { decisionsAfter: ['s2-design'], loopSources: ['s6-review'], designCaptureStep: 's1-intake',
    heldForPerson: { 's3-design': 'a named group must approve it' } }));
  assert.deepEqual(['s1-intake', 's2-design', 's3-design', 's6-review'].map((id) => [result[id].approval.by, result[id].approval.why]), [
    ['person', 'it captures the design sources'], ['person', 'a decision follows it'], ['person', 'a named group must approve it'],
    ['person', 'it starts a rework loop']]);
});

test('§5: one step asks every time, and SFlow-built steps ask nothing', () => {
  assert.deepEqual(derive(steps('intake', 'requirements', 'code')).steps.map((step) => step.clarification.mode), ['required', 'when-needed', 'when-needed']);
  assert.deepEqual(derive(steps('requirements', 'design', 'code')).steps.map((step) => step.clarification.mode), ['required', 'when-needed', 'when-needed']);
  assert.deepEqual(derive(steps('code', 'test')).steps.map((step) => step.clarification.mode), ['when-needed', 'when-needed'], 'a workflow starting with code has none');
  const built = derive([{ id: 'act', intent: 'code', builtBySflow: true }, { id: 'check', intent: 'test', builtBySflow: true }]);
  assert.deepEqual(built.steps.map((step) => [step.clarification.mode, step.testEvidenceFrom]), [['off', null], ['off', null]]);
});

test('§5: a test or review step cites the latest code step\'s results while nothing since changed source', () => {
  let result = byId(derive(steps('intake', 'code', 'test', 'review', 'release')));
  assert.deepEqual([result['s3-test'].testEvidenceFrom, result['s4-review'].testEvidenceFrom, result['s5-release'].testEvidenceFrom], ['s2-code', 's2-code', null]);
  assert.ok(result['s3-test'].inputs.includes('s2-code'), 'it reads the code step it cites');
  // A step that changes source between them (a kept override) stops the citing; so does changing source itself.
  const list = [...steps('intake', 'code'), { id: 'fix-tests', intent: 'test', editsSource: true }, { id: 'conform', intent: 'review' }];
  result = byId(derive(list));
  assert.deepEqual([result['fix-tests'].testEvidenceFrom, result.conform.testEvidenceFrom], [null, null]);
});

test('kept overrides settle the rules that read them: a code step that is not one, as chore\'s analyze task', () => {
  const facts = workflowIntentFacts([{ id: 'intake', intent: 'intake' }, { id: 'implementation', intent: 'code', codeStep: false, editsSource: true },
    { id: 'verification', intent: 'test' }]);
  assert.deepEqual([facts.hasCode, facts.requirementIdSteps, facts.planSteps, facts.codeFree], [false, [], ['intake'], false]);
});

const infer = (list, options) => inferStepIntents(list, options).map((entry) => [entry.step, entry.intent, entry.confidence, entry.source]);

test('§6.1: structure first, and every structural signal is certain', () => {
  assert.deepEqual(infer([
    { id: 'a', kind: 'requirements' },
    { id: 'b', kind: 'fix-design' },
    { id: 'c', kind: 'whatever', label: 'Plan it' },
    { id: 'd', kind: 'implementation-summary' },
    { id: 'e', kind: 'implementation-summary', task: 'analyze', writeScope: 'source-and-artifact', label: 'Run the regression tests' },
    { id: 'f', kind: 'notes', testEvidenceFrom: 'd' },
    { id: 'g', kind: 'convergence-report' },
    { id: 'h', kind: 'publication-review' }
  ], { planOwners: ['c'] }), [
    ['a', 'intake', 'certain', 'structure'], ['b', 'design', 'certain', 'structure'], ['c', 'plan', 'certain', 'structure'],
    ['d', 'code', 'certain', 'structure'], ['e', 'test', 'likely', 'structure'], ['f', 'test', 'certain', 'structure'],
    ['g', 'review', 'certain', 'structure'], ['h', 'release', 'likely', 'structure']
  ]);
  // Requirements after an intake-like step are requirements; a publication review that summarizes a close is a report.
  assert.deepEqual(infer([{ id: 'in', kind: 'design-intake' }, { id: 'req', kind: 'requirements' }, { id: 'go', task: 'code' },
    { id: 'close', kind: 'publication-review', task: 'summarize', label: 'Close the Story' }]), [
    ['in', 'intake', 'certain', 'structure'], ['req', 'requirements', 'certain', 'structure'], ['go', 'code', 'certain', 'structure'],
    ['close', 'report', 'likely', 'structure']]);
  // A first step that asks questions is the intake; a structural signal is never overruled by words.
  assert.deepEqual(infer([{ id: 'ask', task: 'clarify', label: 'Write the report' }, { id: 'x', kind: 'test-evidence', label: 'Design review' }]),
    [['ask', 'intake', 'certain', 'structure'], ['x', 'test', 'certain', 'structure']]);
});

test('§6.1: a step with no structural signal is read from its words, place and agent', () => {
  const result = inferStepIntents([
    { id: 'gather', kind: 'gather', label: 'Gather the ticket' },
    { id: 'think', kind: 'think', label: 'Think' },
    { id: 'build', task: 'code' },
    { id: 'validate', kind: 'validate', label: 'Validate' },
    { id: 'notes', kind: 'notes', label: 'Notes', agent: 'qa' },
    { id: 'tidy', kind: 'tidy', label: 'Tidy up' }
  ]);
  assert.deepEqual(result.map((entry) => [entry.step, entry.intent, entry.confidence, entry.source]), [
    ['gather', 'intake', 'likely', 'words'],
    ['think', 'plan', 'unclear', 'position'],
    ['build', 'code', 'certain', 'structure'],
    ['validate', 'test', 'likely', 'words'],
    ['notes', 'test', 'unclear', 'position'],
    ['tidy', 'test', 'unclear', 'position']
  ]);
  assert.match(result[0].why, /"ticket"/u);
  // Words without a place that agrees are unclear; nothing at all is a document, unclear.
  assert.deepEqual(infer([{ id: 'one', kind: 'one', label: 'Write the report' }, { id: 'two', kind: 'two', label: 'Write' }, { id: 'three', kind: 'three', label: 'Investigate', agent: 'mobile-architect' }, { id: 'go', task: 'code' }]), [
    ['one', 'report', 'unclear', 'words'], ['two', 'document', 'unclear', 'none'], ['three', 'design', 'unclear', 'words'], ['go', 'code', 'certain', 'structure']]);
  assert.deepEqual(infer([{ id: 'only', kind: 'only', label: 'Overview', agent: 'architect' }]), [['only', 'intake', 'unclear', 'position']]);
});

test('§6.1: a declared intent is certain, a shipped step its packaged intent, and a disagreeing structure is kept', () => {
  const [same, declared, shipped] = inferStepIntents([
    { id: 'build', declared: 'code', task: 'code' },
    { id: 'check', declared: 'review', kind: 'requirements' },
    { id: 'verification', shipped: PACKAGED_STEP_INTENTS.verification, kind: 'notes' }
  ]);
  assert.deepEqual([declared.intent, declared.confidence, declared.source, declared.inferred.intent], ['review', 'certain', 'declared', 'requirements']);
  assert.deepEqual([shipped.intent, shipped.confidence, shipped.source], ['test', 'certain', 'shipped']);
  assert.equal(Object.hasOwn(same, 'inferred'), false);
});

test('intent: and because: are checked as written on a step, and intent is never a per-workflow override', () => {
  assert.deepEqual(stepIntentFieldProblems({ intent: 'test', because: { writeScope: REASON } }), []);
  assert.deepEqual(stepIntentFieldProblems({ label: 'No intent' }), []);
  const problems = (value, options) => stepIntentFieldProblems(value, options).map((entry) => entry.field);
  assert.deepEqual(problems({ intent: 'verification' }), ['intent']);
  assert.deepEqual(problems({ intent: 'test' }, { override: true }), ['intent']);
  assert.deepEqual(problems({ because: { writeScope: REASON } }, { override: true }), []);
  assert.deepEqual(problems({ because: 'Because.' }), ['because']);
  assert.deepEqual(problems({ because: {} }), ['because']);
  assert.deepEqual(problems({ because: { label: REASON, writeScope: 'Too short.', approval: 'TODO: write the real reason here later' } }),
    ['because.label', 'because.writeScope', 'because.approval']);
  assert.ok(BECAUSE_SETTINGS.includes('generation.task') && !BECAUSE_SETTINGS.includes('label'), 'only framework settings take a reason');
});

test('configuration accepts intent and because on steps, refuses them where they cannot be, and resolves exactly as without them', () => {
  // In a version 3 file (the shipped steps as that version takes them), declared intents and reasons derive nothing.
  const plain = validateDefinition(packagedWorkflowWithoutIntents(packaged(), 3));
  const annotated = packagedWorkflowWithoutIntents(packaged(), 3);
  for (const [id, phase] of Object.entries(annotated.phases)) {
    phase.intent = PACKAGED_STEP_INTENTS[id] ?? 'document';
    phase.because = { writeScope: REASON };
  }
  for (const type of Object.values(annotated.workTypes)) {
    for (const override of Object.values(type.phaseOverrides ?? {})) override.because = { approval: REASON };
  }
  const withIntents = validateDefinition(annotated);
  for (const id of Object.keys(plain.workTypes)) {
    assert.deepEqual(resolveWorkType(withIntents, id), resolveWorkType(plain, id), `${id} resolves the same with intents declared`);
  }
  const refused = (mutate, field) => {
    const definition = packaged();
    mutate(definition);
    assert.throws(() => validateDefinition(definition), (error) => error.code === 'STEP_INTENT_INVALID' && error.details.field === field
      && error.details.nextAction.command === 'singularity-flow workflow studio', field);
  };
  refused((definition) => { definition.phases.intake.intent = 'gather'; }, 'intent');
  refused((definition) => { definition.workTypes.feature.phaseOverrides = { intake: { intent: 'intake' } }; }, 'intent');
  refused((definition) => { definition.phases.intake.because = { writeScope: 'short' }; }, 'because.writeScope');
  refused((definition) => { definition.workTypes.chore.phaseOverrides.implementation.because = { inputs: REASON }; }, 'because.inputs');
});

test('the JSON schema knows intent and because, and refuses intent in a workflow\'s overrides', () => {
  const schema = JSON.parse(readFileSync(path.join(ROOT, 'schemas/workflow-definition.schema.json'), 'utf8'));
  assert.deepEqual(schema.$defs.stepIntent.enum, [...STEP_INTENTS]);
  assert.deepEqual(schema.$defs.stepBecause.propertyNames.enum, [...BECAUSE_SETTINGS]);
  const phase = schema.properties.phases.additionalProperties.properties;
  assert.deepEqual([phase.intent.$ref, phase.because.$ref], ['#/$defs/stepIntent', '#/$defs/stepBecause']);
  const override = schema.properties.workTypes.additionalProperties.properties.phaseOverrides.additionalProperties;
  assert.ok(override.not.anyOf.some((entry) => entry.required?.[0] === 'intent'));
  assert.equal(override.properties.because.$ref, '#/$defs/stepBecause');
});

test('a workflow.yml from a newer SFlow is refused with the update, never a factory reset (§7.7, D4)', async () => {
  // Version 4 (Stage 2) is read: the refusal now starts at version 5.
  assert.deepEqual(WORKFLOW_FILE_VERSIONS, [2, 3, 4]);
  const newer = { ...packaged(), version: 5 };
  let refusal = null;
  try { validateDefinition(newer); } catch (error) { refusal = error; }
  assert.equal(refusal?.code, 'WORKFLOW_VERSION_NEWER');
  assert.match(refusal.message, /^This repository's workflows need a newer SFlow: workflow\.yml is version 5, and this SFlow reads 2, 3 and 4\. Update SFlow/u);
  assert.doesNotMatch(refusal.message, /factory-reset/u);
  assert.deepEqual(refusal.details.nextAction.argv, ['update']);
  const plan = refusalRemediationPlan(refusal, ['workflow', 'check']);
  const first = plan.steps.find((entry) => entry.command);
  assert.equal(first.command, 'singularity-flow update');
  assert.equal(first.copyable, true);
  // VS Code's views offer Update SFlow… for it, and no reinitialize.
  const { buildLifecycleTree } = await import(pathToFileURL(path.join(ROOT, 'apps/vscode/src/views/tree-model.ts')).href);
  const nodes = buildLifecycleTree(null, refusal);
  assert.deepEqual(nodes.filter((node) => node.kind === 'action').map((node) => [node.id, node.runCommand]),
    [['lifecycle:error:update', 'singularityFlow.updateSflow'], ['lifecycle:error:doctor', 'singularityFlow.doctor']]);
  // An older file keeps its own refusal and its own way on.
  assert.throws(() => validateDefinition({ ...packaged(), version: 1 }), (error) => /factory-reset/u.test(error.message) && error.code !== 'WORKFLOW_VERSION_NEWER');
  assert.throws(() => validateDefinition({ ...packaged(), version: '5' }), (error) => error.code !== 'WORKFLOW_VERSION_NEWER');
});
