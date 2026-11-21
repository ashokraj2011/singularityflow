/**
 * Step intents Stage 4 (spec §4.3, §4.4, §9.2): the shipped workflow.yml is version 4, every step it ships says what it
 * is for, and each setting that differs from its intent's profile is set on the step or the workflow with its reason
 * (G1–G7, each kept until the owner's decision on it is adopted, one at a time, in Stage 7).
 *
 * The golden (test/fixtures/step-intents-shipped-golden.json) is what every shipped work type resolved to before step
 * intents: the digest of its whole resolution, without the intent pins a Story now also keeps (intent, intentProfile,
 * because), and its people steps, automatic approvals, requirement-ID steps, plan owners, independent reviews,
 * attached documents and obligation shape for a person to read. Written from the version 2 file before Stage 4, it must
 * pass unchanged: a later change to what a shipped workflow does lands with its own golden update
 * (SINGULARITY_FLOW_GOLDEN_WRITE=1 writes it, and the diff is the decision).
 *
 * Also proved: deriving adds nothing to what the steps set themselves (resolved without deriving, as a Story started
 * before intents re-resolves, and as a repository on version 2 or 3 takes the shipped steps, every work type is the
 * same), and no shipped setting differs from its intent without a reason.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { approvesAutomatically } from '../src/approval-authority.mjs';
import { loadStepIntentSettings, resolveWorkType, validateDefinition } from '../src/config.mjs';
import { INTENTS_FILE_VERSION, storyIntentProfile, workTypeDerivesIntents } from '../src/phase-roles.mjs';
import { PACKAGED_STEP_INTENTS } from '../src/packaged-step-intents.mjs';
import { packagedWorkflowWithoutIntents } from '../src/workspace-configuration-refresh.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = path.join(ROOT, 'test/fixtures/step-intents-shipped-golden.json');
const packaged = () => YAML.parse(readFileSync(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));

const canonical = (value) => (Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value);
const withoutPins = (resolved) => ({
  ...resolved, phases: resolved.phases.map(({ intent: _intent, intentProfile: _profile, because: _because, ...phase }) => phase)
});
const sha256 = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const approvedBy = (phase) => (phase.approval.mode === 'none' ? 'none' : phase.approval.mode === 'policy' ? 'low-risk rule'
  : approvesAutomatically(phase.approval) ? 'SFlow when ready' : 'a person');

/** What one shipped work type resolves to, as the golden records it. */
function summary(resolved) {
  const plain = withoutPins(resolved);
  const by = (who) => plain.phases.filter((phase) => approvedBy(phase) === who).map((phase) => phase.id);
  return {
    resolutionSha256: sha256(plain),
    people: by('a person'),
    automatic: by('SFlow when ready'),
    other: plain.phases.filter((phase) => !['a person', 'SFlow when ready'].includes(approvedBy(phase))).map((phase) => `${phase.id}: ${approvedBy(phase)}`),
    changeSource: plain.phases.filter((phase) => phase.writeScope === 'source-and-artifact').map((phase) => phase.id),
    questionsEveryTime: plain.phases.filter((phase) => phase.clarification?.mode === 'required').map((phase) => phase.id),
    repositoryTests: plain.phases.filter((phase) => phase.repositoryTests === 'run').map((phase) => phase.id),
    requirementIds: plain.plannedClaims?.clausePhases ?? [],
    planOwners: plain.plannedClaims?.owners ?? {},
    reviewed: plain.sourceReview?.phases ?? [],
    attachedDocuments: plain.documents?.allowedPhases ?? [],
    shapeDigest: plain.obligationGraph?.shapeDigest ?? null
  };
}

async function shipped() {
  const raw = packaged();
  await loadStepIntentSettings(raw);
  return { raw, definition: validateDefinition(structuredClone(raw)) };
}

test('every shipped step says what it is for, in a version 4 file, and each work type derives from its steps', async () => {
  const { raw } = await shipped();
  assert.equal(raw.version, INTENTS_FILE_VERSION);
  const steps = Object.entries(raw.phases).filter(([, phase]) => phase.kind !== 'skill');
  for (const [id, phase] of steps) assert.equal(phase.intent, PACKAGED_STEP_INTENTS[id], `${id}: its packaged intent`);
  assert.deepEqual(Object.keys(PACKAGED_STEP_INTENTS).sort(), steps.map(([id]) => id).sort(), 'PACKAGED_STEP_INTENTS names every shipped step, and nothing else');
  for (const [id, workType] of Object.entries(raw.workTypes)) assert.equal(workTypeDerivesIntents(raw, workType), true, id);
});

test('no shipped setting differs from its intent without a reason, and nothing contradicts an intent', async () => {
  const { raw } = await shipped();
  const { deriveWorkTypeSettings } = await import('../src/step-intent-settings.mjs');
  for (const id of Object.keys(raw.workTypes)) {
    const derived = deriveWorkTypeSettings(raw, id);
    assert.deepEqual(derived.refusals, [], `${id}: refused`);
    assert.deepEqual(derived.warnings.map((entry) => `${entry.step ?? '(workflow)'} ${entry.code} ${entry.setting ?? ''}`), [], `${id}: warned`);
  }
  // The kept differences say why where a person reads them (workflow check --settings): a few of each group.
  const sources = (workType, step) => deriveWorkTypeSettings(raw, workType).steps.find((entry) => entry.id === step).sources;
  // G1 adopted (D1, Stage 7): the core test steps change no source code, as their intent says, and SFlow approves a
  // clean run; the three kept differences still say why.
  assert.equal(sources('feature', 'verification').writeScope.reason, undefined, 'G1 adopted');
  assert.equal(sources('benchmarking-a', 'testing').writeScope.reason, undefined, 'G1 adopted');
  assert.match(sources('figma-mobile', 'visual-verification').writeScope.reason, /may correct screen differences/u, 'G1 kept');
  assert.match(sources('poc-workflow', 'poc-validation').writeScope.reason, /repairs the Playwright tests it runs/u, 'G1 kept');
  assert.match(sources('quick-fix', 'verify').writeScope.reason, /keeps its check on the changed code/u, 'G1 kept');
  // G2 adopted (D2): approve twice for both benchmarks and the POC workflow, with no reason left to give; the demo closes keep a person.
  assert.deepEqual([sources('benchmarking-a', 'intake').approval.from, sources('benchmarking-a', 'intake').approval.reason], ['override', undefined], 'G2 adopted');
  assert.equal(sources('poc-workflow', 'poc-intake').approval.reason, undefined, 'G2 adopted');
  assert.match(sources('demo-check-repair-close', 'demo-close').approval.reason, /closing decision/u, 'G2 kept');
  assert.match(sources('quick-fix', 'implement').approval.reason, /the Verify step after it checks it/u, 'G3');
  // G4 adopted (D2): planning, release, careful-change and test-run ask only when needed, as their intents do; the quick
  // fix's and the findings' intakes keep asking only when needed, with their reasons.
  for (const [type, step] of [['spec-driven-standard', 'planning'], ['spec-driven-standard', 'release'], ['careful-change', 'careful-change'], ['test-run', 'test-run']]) {
    assert.equal(sources(type, step)['clarification.mode'].reason, undefined, `G4 adopted: ${step}`);
  }
  assert.match(sources('quick-fix', 'intake')['clarification.mode'].reason, /concrete change/u, 'G4 kept');
  assert.match(sources('findings-remediation', 'findings-intake')['clarification.mode'].reason, /from the register/u, 'G4 kept');
  assert.match(sources('figma-mobile', 'visual-verification').repositoryTests.reason, /whole test suite/u, 'G5');
  assert.match(deriveWorkTypeSettings(raw, 'feature').workType.sources['plannedClaims.clausePhases'].reason, /its own requirement IDs/u, 'G6');
  assert.match(deriveWorkTypeSettings(raw, 'poc-workflow').workType.sources['documents.allowedPhases'].reason, /no attached documents/u, 'G7');
});

test('golden: every shipped work type resolves exactly as it did before step intents, apart from its intent pins', async () => {
  const { definition } = await shipped();
  const now = Object.fromEntries(Object.keys(definition.workTypes).map((id) => [id, summary(resolveWorkType(definition, id))]));
  if (process.env.SINGULARITY_FLOW_GOLDEN_WRITE === '1') {
    // One line per setting, so its diff reads as the decision it records.
    writeFileSync(GOLDEN, `{\n${Object.entries(now).map(([id, entry]) => `  ${JSON.stringify(id)}: {\n${Object.entries(entry)
      .map(([key, value]) => `    ${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(',\n')}\n  }`).join(',\n')}\n}\n`);
    return;
  }
  assert.deepEqual(now, JSON.parse(readFileSync(GOLDEN, 'utf8')));
  // A Story started from a shipped workflow now also keeps what each step is for, and the profile it derived with.
  for (const id of Object.keys(definition.workTypes)) {
    for (const phase of resolveWorkType(definition, id).phases) {
      assert.equal(phase.intent, PACKAGED_STEP_INTENTS[phase.id], `${id} ${phase.id}`);
      assert.equal(phase.intentProfile, 1, `${id} ${phase.id}`);
    }
  }
});

test('deriving adds nothing: without deriving, and as a version 2 or 3 file takes the shipped steps, each work type is the same', async () => {
  const { raw, definition } = await shipped();
  for (const id of Object.keys(definition.workTypes)) {
    const derived = canonical(withoutPins(resolveWorkType(definition, id)));
    // A Story started before step intents re-resolves without deriving (an amendment reading newer configuration).
    const before = resolveWorkType(definition, id, { intentProfile: storyIntentProfile({ phases: [{ id: 'intake' }] }) });
    assert.ok(before.phases.every((phase) => !Object.hasOwn(phase, 'intent') && !Object.hasOwn(phase, 'intentProfile')), id);
    assert.deepEqual(canonical(before), derived, `${id}: without deriving`);
    for (const version of [2, 3]) {
      const older = resolveWorkType(validateDefinition(packagedWorkflowWithoutIntents(raw, version)), id);
      assert.deepEqual(canonical(older), derived, `${id}: at version ${version}`);
    }
  }
  // What version 2 or 3 takes reads nothing only version 4 reads.
  const older = packagedWorkflowWithoutIntents(raw, 3);
  assert.equal(older.version, 3);
  const text = JSON.stringify(older);
  for (const word of ['"intent"', '"because"', '"automatic":"off"', '"intentProfiles"']) assert.equal(text.includes(word), false, word);
  assert.equal(JSON.stringify(raw).includes('"intent"'), true, 'the packaged file itself is unchanged');
  assert.equal(storyIntentProfile({ phases: [{ id: 'a', intentProfile: 1 }] }), 1, 'a Story that derived keeps its profile');
});
