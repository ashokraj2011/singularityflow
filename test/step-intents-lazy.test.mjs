/**
 * Step intents' derivation loads only for a workflow.yml that opts in (step intents spec, Stage 2): a repository whose
 * workflows have no intents validates and resolves every work type without it, and the cheap gate says why. A
 * definition resolved directly loads it in place, as the same module instance an import gives.
 * Its own file, so nothing else in this process has loaded the derivation first.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { loadStepIntentSettings, resolveWorkType, validateDefinition } from '../src/config.mjs';
import { declaresStepIntents, INTENTS_FILE_VERSION, workTypeDerivesIntents } from '../src/phase-roles.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packaged = () => YAML.parse(readFileSync(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));

test('a workflow.yml without intents never loads the derivation; one that opts in loads it once, as one module', async () => {
  // Version 3 and version 4 without intents: every work type validates and resolves, and nothing loaded the derivation.
  for (const version of [3, INTENTS_FILE_VERSION]) {
    const definition = validateDefinition({ ...packaged(), version });
    for (const id of Object.keys(definition.workTypes)) resolveWorkType(definition, id);
    assert.equal(declaresStepIntents(definition), false);
    assert.equal(await loadStepIntentSettings(definition), null, `version ${version} loaded the derivation`);
  }
  // Intents in a version 3 file opt nothing in either.
  const three = packaged();
  three.phases.intake.intent = 'intake';
  assert.equal(declaresStepIntents(validateDefinition(three)), false);
  assert.equal(await loadStepIntentSettings(three), null);

  // A version 4 workflow of intents, resolved directly: the derivation loads in place, and it is the module an import gives.
  const opted = packaged();
  opted.version = INTENTS_FILE_VERSION;
  for (const [id, intent] of [['intake', 'intake'], ['requirements', 'requirements'], ['design', 'design']]) opted.phases[id].intent = intent;
  opted.workTypes.demo = { label: 'Demo', phases: ['intake', 'requirements', 'design'] };
  assert.equal(declaresStepIntents(opted), true);
  assert.equal(workTypeDerivesIntents(opted, opted.workTypes.demo), true);
  assert.equal(workTypeDerivesIntents(opted, opted.workTypes.feature), false, 'a work type with a step that has no intent derives nothing');
  const resolved = resolveWorkType(validateDefinition(opted), 'demo');
  assert.deepEqual(resolved.phases.map((phase) => phase.intentProfile), [1, 1, 1]);
  const loaded = await loadStepIntentSettings();
  assert.ok(loaded, 'resolving it loaded the derivation');
  assert.equal(loaded.deriveWorkTypeSettings, (await import('../src/step-intent-settings.mjs')).deriveWorkTypeSettings, 'one module instance');
  assert.equal(loaded.INTENTS_FILE_VERSION, INTENTS_FILE_VERSION);
});
