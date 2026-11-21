/**
 * What shipping every step with its intent (step intents Stage 4) needed from the derivation (spec §5, §7.2, §7.3):
 * - the plan owners a workflow names are the plan a person approves, over the rule's nearest step (precedence);
 * - a workflow's own list of steps that take attached documents may say why;
 * - a review in a workflow whose change is not a code step (chore's configuration change) is not told to be a report,
 *   and cites no code step's test results, since that change commits none;
 * - `approval: none` gives its own reason, not that of an automatic approval it does not have.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { approvesAutomatically } from '../src/approval-authority.mjs';
import { resolveWorkType, validateDefinition } from '../src/config.mjs';
import { deriveWorkTypeSettings, workflowIntentFacts, WORK_TYPE_BECAUSE_SETTINGS } from '../src/step-intent-settings.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REASON = 'The team keeps this as it always was, for its own reasons.';

/** The packaged configuration at version 4 with a work type `custom` of the given steps ({ id, intent, label?, ...settings }). */
function definition(steps, workType = {}) {
  const value = YAML.parse(readFileSync(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));
  value.version = 4;
  for (const { id, label, ...settings } of steps) {
    value.phases[id] = { label: label ?? id, artifact: { path: `artifacts/${id}/${id}.md`, ...(settings.artifact ?? {}) }, defaultTemplate: 'common/intake.md',
      ...Object.fromEntries(Object.entries(settings).filter(([key]) => key !== 'artifact')) };
  }
  value.workTypes.custom = { label: 'Custom', phases: steps.map((step) => step.id), ...workType };
  return value;
}
const byId = (resolved) => Object.fromEntries(resolved.phases.map((phase) => [phase.id, phase]));

test('the plan owner a workflow names is the plan a person approves, so the design before it may be approved when ready', () => {
  const steps = [{ id: 'ask', intent: 'intake', artifact: { kind: 'requirements' } }, { id: 'shape', intent: 'design' }, { id: 'make', intent: 'code' }];
  // By the rule alone the design nearest the code step plans it.
  const ruled = byId(resolveWorkType(validateDefinition(definition(steps)), 'custom'));
  assert.equal(approvesAutomatically(ruled.shape.approval), false, 'the design plans the code: a person approves it');
  // The workflow names the intake as the plan: the intake is a person's, and the design may be approved when ready.
  const named = definition(steps, { plannedClaims: { mode: 'required', clausePhases: ['ask'], owners: { make: 'ask' } },
    phaseOverrides: { shape: { approval: { automatic: 'when-ready' } } }, because: { plannedClaims: REASON } });
  const resolved = byId(resolveWorkType(validateDefinition(named), 'custom'));
  assert.equal(approvesAutomatically(resolved.shape.approval), true);
  assert.equal(approvesAutomatically(resolved.ask.approval), false);
  assert.deepEqual(deriveWorkTypeSettings(validateDefinition(named), 'custom').planSteps, ['ask']);
  // A named owner after its code step, or one the workflow does not run, is no plan of it.
  assert.deepEqual(workflowIntentFacts([{ id: 'a', intent: 'intake' }, { id: 'b', intent: 'code' }, { id: 'c', intent: 'design' }],
    { declaredOwners: { b: 'c' } }).planSteps, ['a']);
  assert.deepEqual(workflowIntentFacts([{ id: 'a', intent: 'intake' }, { id: 'b', intent: 'code' }], { declaredOwners: { b: 'gone' } }).planSteps, ['a']);
});

test('a workflow\'s own attached-documents list may say why, and its reason is shown where the setting comes from', () => {
  assert.ok(WORK_TYPE_BECAUSE_SETTINGS.includes('documents.allowedPhases'));
  const schema = JSON.parse(readFileSync(path.join(ROOT, 'schemas/workflow-definition.schema.json'), 'utf8'));
  assert.deepEqual(schema.$defs.workTypeBecause.propertyNames.enum, [...WORK_TYPE_BECAUSE_SETTINGS]);
  const steps = [{ id: 'ask', intent: 'intake', artifact: { kind: 'requirements' } }, { id: 'make', intent: 'code' }];
  const value = definition(steps, { documents: { allowedPhases: [] }, because: { 'documents.allowedPhases': REASON } });
  const derived = deriveWorkTypeSettings(validateDefinition(value), 'custom');
  assert.deepEqual(derived.workType.allowedPhases, []);
  assert.deepEqual(derived.workType.sources['documents.allowedPhases'], { from: 'override', reason: REASON });
  assert.deepEqual(resolveWorkType(validateDefinition(value), 'custom').documents.allowedPhases, []);
});

test('a review after a change that is not a code step is not told to become a report; one in a workflow that changes nothing is', () => {
  // chore's shape: the change is configuration (task analyze), but it still changes files a review checks.
  const chore = deriveWorkTypeSettings(validateDefinition(definition([{ id: 'ask', intent: 'intake', artifact: { kind: 'requirements' } },
    { id: 'make', intent: 'code', generation: { task: 'analyze' }, writeScope: 'source-and-artifact', because: { 'generation.task': REASON } },
    { id: 'look', intent: 'review' }])), 'custom');
  assert.deepEqual(chore.warnings.map((entry) => entry.code), []);
  assert.equal(chore.steps.find((step) => step.id === 'look').settings.testEvidenceFrom, undefined);
  const nothing = deriveWorkTypeSettings(validateDefinition(definition([{ id: 'ask', intent: 'intake' }, { id: 'look', intent: 'review' }])), 'custom');
  assert.deepEqual(nothing.warnings.map((entry) => entry.code), ['CHECK_INTENT_BEFORE_CODE']);
});

test('approval none gives its own reason, not that of an automatic approval it does not have', () => {
  const value = definition([{ id: 'ask', intent: 'intake', artifact: { kind: 'requirements' } },
    { id: 'make', intent: 'code', approval: 'none', generation: { producer: 'deterministic', task: 'code' },
      because: { 'approval.mode': REASON, 'generation.producer': REASON } },
    { id: 'prove', intent: 'test' }]);
  const derived = deriveWorkTypeSettings(validateDefinition(value), 'custom');
  assert.deepEqual(derived.steps.find((step) => step.id === 'make').sources.approval, { from: 'shared-step', reason: REASON });
});
