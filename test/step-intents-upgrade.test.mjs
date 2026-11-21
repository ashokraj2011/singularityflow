/**
 * Step intents Stage 4 (spec §7.7, §8.1): a repository on the workflow.yml shipped before step intents
 * (test/fixtures/workflow-v2-before-step-intents.yml, version 2) and the upgrade to this build's version 4 file.
 *
 * - The previous file keeps working with this build, at version 2 and at 3: every shipped work type resolves to the
 *   golden it always had (test/fixtures/workflow-v2-before-step-intents.resolutions.json).
 * - Its exact shipped nodes are known packaged revisions, so a reinitialize replaces them; an edited one is the
 *   repository's own and is kept as it is.
 * - The upgrade moves the file to version 4 only when no workflow of the repository's would run differently. A team's
 *   own workflow made only of shipped steps would start deriving the settings it leaves unset, so that repository keeps
 *   its version and takes the shipped steps without what only version 4 reads; every workflow then runs as before.
 * - Since Stage 7 the shipped workflows run as the owner decided (test steps change no source code, and the rest of
 *   G1-G7): a repository that takes them runs them as this build ships them, at its own version, and its own
 *   workflows run as before.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { initializeDefinition, loadStepIntentSettings, resolveWorkType, validateDefinition } from '../src/config.mjs';
import { withAgentsHomeSetting } from '../src/initialization-assets.mjs';
import { isKnownPackagedWorkflowValue, packagedWorkflowValueSha256 } from '../src/packaged-workflow-history.mjs';
import {
  packagedWorkflowWithoutIntents, refreshPackagedConfiguration, workTypesChangedByIntents
} from '../src/workspace-configuration-refresh.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREVIOUS_TEXT = readFileSync(path.join(ROOT, 'test/fixtures/workflow-v2-before-step-intents.yml'), 'utf8');
const previous = () => YAML.parse(PREVIOUS_TEXT);
const shipped = () => YAML.parse(readFileSync(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));
// What each work type of the previous file resolved to, before and with step intents alike: it never moves.
const PREVIOUS_GOLDEN = JSON.parse(readFileSync(path.join(ROOT, 'test/fixtures/workflow-v2-before-step-intents.resolutions.json'), 'utf8'));
const canonical = (value) => (Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value);
const withoutPins = (resolved) => ({
  ...resolved, phases: resolved.phases.map(({ intent: _intent, intentProfile: _profile, because: _because, ...phase }) => phase)
});
const resolutions = (definition) => Object.fromEntries(Object.keys(definition.workTypes)
  .map((id) => [id, canonical(withoutPins(resolveWorkType(definition, id)))]));
/** What each shipped work type resolves to now, `edit` applied to the shipped file first. */
async function shippedResolutions(edit = () => {}) {
  const value = shipped();
  edit(value);
  await loadStepIntentSettings(value);
  return resolutions(validateDefinition(structuredClone(value)));
}

/** A repository initialized by this build whose workflow.yml is then `text` (as an older build left it). */
async function repository(t, text) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-intents-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.git'), { recursive: true });
  await initializeDefinition(root);
  await writeFile(path.join(root, 'singularity', 'workflow.yml'), withAgentsHomeSetting(text));
  return root;
}
const workflowOf = async (root) => YAML.parse(await readFile(path.join(root, 'singularity', 'workflow.yml'), 'utf8'));

test('the workflow.yml shipped before step intents keeps working with this build, at version 2 and at 3', async () => {
  const { createHash } = await import('node:crypto');
  for (const version of [2, 3]) {
    const definition = validateDefinition({ ...previous(), version });
    for (const id of Object.keys(definition.workTypes)) {
      const resolved = resolveWorkType(definition, id);
      assert.ok(resolved.phases.every((phase) => !Object.hasOwn(phase, 'intent')), `${id} at ${version} derives nothing`);
      assert.equal(createHash('sha256').update(JSON.stringify(canonical(resolved))).digest('hex'), PREVIOUS_GOLDEN[id], `${id} at ${version}`);
    }
  }
});

test('every node of the previous shipped workflow.yml is a known packaged revision; an edited one is not', () => {
  const before = previous();
  for (const section of ['workTypes', 'phases', 'artifactSets', 'mcpServers']) {
    for (const [id, value] of Object.entries(before[section])) assert.equal(isKnownPackagedWorkflowValue(section, id, value), true, `${section}.${id}`);
  }
  // As a version 2 or 3 repository takes the current shipped steps: known too, so the next refresh moves them on.
  const older = packagedWorkflowWithoutIntents(shipped(), 2);
  for (const section of ['workTypes', 'phases']) {
    for (const [id, value] of Object.entries(older[section])) assert.equal(isKnownPackagedWorkflowValue(section, id, value), true, `${section}.${id} without intents`);
  }
  assert.equal(isKnownPackagedWorkflowValue('phases', 'verification', { ...before.phases.verification, label: 'Our verification' }), false);
  assert.equal(isKnownPackagedWorkflowValue('workTypes', 'feature', { ...before.workTypes.feature, label: 'Our feature' }), false);
  assert.notEqual(packagedWorkflowValueSha256(before.phases.verification), packagedWorkflowValueSha256(shipped().phases.verification));
});

test('an untouched repository moves to version 4 with the shipped steps and their intents, on refresh and on reinitialize', async (t) => {
  for (const restorePackagedSeeds of [false, true]) {
    for (const version of [2, 3]) {
      const root = await repository(t, PREVIOUS_TEXT.replace(/^version: 2$/mu, `version: ${version}`));
      const refreshed = await refreshPackagedConfiguration(root, { restorePackagedSeeds });
      assert.deepEqual(refreshed.stepIntents, { version: 4, movedFrom: version, kept: false, workTypes: [] }, `${version} ${restorePackagedSeeds}`);
      assert.equal(refreshed.conflicts.some((entry) => entry.path === 'workflow.version'), false);
      const after = await workflowOf(root);
      const packaged = shipped();
      assert.equal(after.version, 4);
      assert.deepEqual(canonical(after.phases), canonical(packaged.phases), `${version} ${restorePackagedSeeds}: phases`);
      assert.deepEqual(canonical(after.workTypes), canonical(packaged.workTypes), `${version} ${restorePackagedSeeds}: workflows`);
      // Every workflow runs as this build ships it (the owner's adopted differences, Stage 7), nothing half taken.
      await loadStepIntentSettings(after);
      assert.deepEqual(resolutions(validateDefinition(structuredClone(after))), await shippedResolutions());
      // A second refresh finds nothing to do.
      const again = await refreshPackagedConfiguration(root, { restorePackagedSeeds });
      assert.equal(again.files.includes('singularity/workflow.yml'), false, `${version} ${restorePackagedSeeds}: idempotent`);
    }
  }
});

test('reinitialize keeps an edited shipped step as the repository\'s own, and moves the rest', async (t) => {
  const edited = previous();
  edited.phases.verification.label = 'Our verification';
  const text = PREVIOUS_TEXT.replace(/^ {4}label: Verification$/mu, '    label: Our verification');
  assert.notEqual(text, PREVIOUS_TEXT);
  const root = await repository(t, text);
  const refreshed = await refreshPackagedConfiguration(root, { restorePackagedSeeds: true });
  const after = await workflowOf(root);
  assert.deepEqual(after.phases.verification, edited.phases.verification, 'kept exactly, with no intent');
  assert.ok(refreshed.conflicts.some((entry) => entry.path === 'workflow.phases.verification' && entry.resolution === 'preserved-local'));
  assert.deepEqual(after.phases.implementation, shipped().phases.implementation, 'an untouched step moves on');
  // The workflows that use the kept step have a step with no intent, so they derive nothing. They run as this build
  // ships them, with the repository's own step: its verification changes no source code there because the shipped
  // workflow says so beside its automatic approval (Stage 7), so the kept step makes no workflow invalid.
  assert.equal(after.version, 4);
  await loadStepIntentSettings(after);
  const definition = validateDefinition(structuredClone(after));
  assert.ok(resolveWorkType(definition, 'feature').phases.every((phase) => !Object.hasOwn(phase, 'intent')));
  const feature = canonical(withoutPins(resolveWorkType(definition, 'feature')));
  assert.deepEqual(feature, (await shippedResolutions((value) => { value.phases.verification = edited.phases.verification; })).feature);
  const verification = feature.phases.find((phase) => phase.id === 'verification');
  assert.deepEqual([verification.label, verification.writeScope, verification.approval.automatic], ['Our verification', 'artifact-only', 'when-ready']);
});

test('a team\'s own workflow of shipped steps keeps the repository on its version, and every workflow runs as before', async (t) => {
  const own = { label: 'Our delivery', phases: ['intake', 'implementation', 'verification', 'conformance'] };
  const before = previous();
  before.workTypes['our-delivery'] = own;
  const root = await repository(t, YAML.stringify(before, { lineWidth: 0 }));
  // At version 4 its steps would all have an intent, so it would derive what it leaves unset.
  const moved = shipped();
  moved.workTypes['our-delivery'] = own;
  assert.deepEqual(await workTypesChangedByIntents(moved, packagedWorkflowWithoutIntents(moved, 2)), ['our-delivery']);
  assert.deepEqual(await workTypesChangedByIntents(shipped(), packagedWorkflowWithoutIntents(shipped(), 2)), [], 'the shipped workflows alone change nothing');
  // One version 4 reads without a refusal, but whose settings it would derive differently, is named too.
  const docs = shipped();
  docs.workTypes['our-docs'] = { label: 'Our documents', phases: ['requirements', 'design'] };
  assert.deepEqual(await workTypesChangedByIntents(docs, packagedWorkflowWithoutIntents(docs, 3)), ['our-docs']);

  for (const restorePackagedSeeds of [false, true]) {
    const refreshed = await refreshPackagedConfiguration(root, { restorePackagedSeeds });
    assert.deepEqual(refreshed.stepIntents, { version: 2, movedFrom: null, kept: true, workTypes: ['our-delivery'] });
    const after = await workflowOf(root);
    assert.equal(after.version, 2);
    const text = JSON.stringify(after);
    for (const word of ['"intent"', '"because"', '"automatic":"off"']) assert.equal(text.includes(word), false, word);
    // The shipped steps it took are known packaged values, so the next refresh still moves them on.
    for (const [id, value] of Object.entries(after.phases)) assert.equal(isKnownPackagedWorkflowValue('phases', id, value), true, id);
    // Every workflow runs on the shipped steps as this build ships them, at the repository's version: the shipped
    // workflows as at version 4, and the team's own derives nothing (its test step now changes no source code, as the
    // shared step it uses says since Stage 7).
    const expected = packagedWorkflowWithoutIntents(shipped(), 2);
    expected.workTypes['our-delivery'] = own;
    const now = resolutions(validateDefinition(structuredClone(after)));
    assert.deepEqual(now, resolutions(validateDefinition(expected)));
    const { ['our-delivery']: _own, ...shippedNow } = now;
    assert.deepEqual(shippedNow, await shippedResolutions());
  }
  // Moved to version 4 by hand (as Workflow Studio does for a workflow it confirms), the file still takes the shipped
  // steps without their intents while that workflow of shipped steps would run differently with them.
  const rewrite = async (edit) => {
    const document = await workflowOf(root);
    edit(document);
    await writeFile(path.join(root, 'singularity', 'workflow.yml'), withAgentsHomeSetting(YAML.stringify(document, { lineWidth: 0 })));
  };
  await rewrite((document) => { document.version = 4; });
  const stillKept = await refreshPackagedConfiguration(root);
  assert.deepEqual(stillKept.stepIntents, { version: 4, movedFrom: null, kept: true, workTypes: ['our-delivery'] });
  assert.equal(JSON.stringify(await workflowOf(root)).includes('"intent"'), false);
  // With its own workflow gone, the next refresh brings the shipped steps' intents.
  await rewrite((document) => { delete document.workTypes['our-delivery']; });
  const moving = await refreshPackagedConfiguration(root);
  assert.deepEqual(moving.stepIntents, { version: 4, movedFrom: null, kept: false, workTypes: [] });
  const after = await workflowOf(root);
  assert.equal(after.version, 4);
  assert.deepEqual(canonical(after.phases), canonical(shipped().phases));
  // Once every shipped step says what it is for, a refresh has nothing left to decide.
  assert.equal(Object.hasOwn(await refreshPackagedConfiguration(root), 'stepIntents'), false);
});
