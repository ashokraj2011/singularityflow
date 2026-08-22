import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  resolveWorldModelGenerationRouting, worldModelInvocationAttribution
} from '../src/world-model-generation-routing.mjs';

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wm-routing-'));
  const initialized = spawnSync('git', ['init', '-b', 'main'], { cwd: root, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  return root;
}

test('world-model discovery and synthesis route through analyze and reason', async () => {
  const root = await repository();
  const template = await readFile(new URL('../templates/modelTiers.yml', import.meta.url), 'utf8');
  await writeFile(path.join(root, 'singularity/modelTiers.yml'), template);

  const plan = await resolveWorldModelGenerationRouting(root);
  assert.equal(plan.mode, 'task-routed');
  assert.deepEqual(plan.discovery.request, { task: 'analyze' });
  assert.deepEqual(plan.synthesis.request, { task: 'reason' });
  assert.match(plan.identity.mappingRevision, /^[a-f0-9]{64}$/);
  assert.equal(plan.discovery.planned.mappingRevision, plan.synthesis.planned.mappingRevision);

  const attribution = worldModelInvocationAttribution({
    model: plan.discovery.planned.preferredModel,
    routing: {
      task: 'analyze', mappingRevision: plan.identity.mappingRevision,
      resolvedModel: plan.discovery.planned.preferredModel,
      available: [...plan.discovery.planned.availableModels], fallbackHops: [],
      aliasOf: plan.discovery.planned.aliasOf, paramsDigest: plan.discovery.planned.paramsDigest
    }
  }, plan.discovery);
  assert.equal(attribution.mode, 'task-routed');
  assert.equal(attribution.task, 'analyze');
  assert.equal(attribution.reason, null);
});

test('explicit and legacy caller-named routes are distinct and missing routing fails closed', async () => {
  const root = await repository();
  const mappingPath = path.join(root, 'singularity/modelTiers.yml');
  await writeFile(mappingPath, 'not: [valid');

  // An explicit override must not consult even a malformed task mapping.
  const explicit = await resolveWorldModelGenerationRouting(root, { explicitModel: 'override-model' });
  assert.equal(explicit.mode, 'caller-named');
  assert.deepEqual(explicit.discovery.request, { model: 'override-model' });
  assert.equal(explicit.discovery.planned.reason, 'explicit-model-override');

  await rm(mappingPath);
  const legacy = await resolveWorldModelGenerationRouting(root, { legacyModel: 'legacy-model' });
  assert.equal(legacy.discovery.planned.reason, 'legacy-configured-model');
  assert.match(legacy.warning, /legacy configured model/);

  await assert.rejects(
    () => resolveWorldModelGenerationRouting(root),
    (error) => error.code === 'WORLD_MODEL_ROUTING_UNAVAILABLE'
      && /modelTiers\.yml/.test(error.message)
  );
});
