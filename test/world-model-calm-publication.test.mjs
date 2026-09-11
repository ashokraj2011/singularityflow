import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { initializeDefinition } from '../src/config.mjs';
import { run } from '../src/util.mjs';
import { worldModelCommand } from '../src/worldmodel.mjs';
import { evaluateArchitectureIntentGate } from '../src/architecture-intent-gate.mjs';
import {
  createArchitectureIntent, verifyArchitectureIntent
} from '../src/world-model/projections/calm/projection.mjs';
import { canonicalJson } from '../src/world-model/canonicalize.mjs';
import { resolvePublishedWorldModelV4 } from '../src/world-model/store.mjs';

function git(root, args) { return run('git', args, { cwd: root }).stdout.trim(); }

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmc-publication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'WMC Test']);
  git(root, ['config', 'user.email', 'wmc@example.invalid']);
  await writeFile(path.join(root, 'app.mjs'), 'export const ready = true;\n');
  await initializeDefinition(root);
  const workflowPath = path.join(root, 'singularity', 'workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workflow.worldModel.format = 'registered-v4';
  workflow.worldModel.promptSource = 'builtin';
  workflow.worldModel.views = ['dev.impact'];
  workflow.worldModel.v4 = {
    composer: 'deterministic', consumer: 'developer', cachePolicy: 'reuse-valid',
    totalMaximumOutputTokens: 1400
  };
  workflow.worldModel.projections['arch.calm'].enabled = true;
  for (const phase of Object.values(workflow.phases)) {
    if (phase.worldModel?.views?.length) phase.worldModel.views = ['dev.impact'];
  }
  await writeFile(workflowPath, YAML.stringify(workflow));
  for (const name of await readdir(path.join(root, '.github', 'agents'))) {
    if (!name.endsWith('.agent.md')) continue;
    const target = path.join(root, '.github', 'agents', name);
    const source = await readFile(target, 'utf8');
    await writeFile(target, source.replace(
      /sflow-world-model-views: "[^"]*"/, 'sflow-world-model-views: "dev.impact"'
    ));
  }
  await writeFile(path.join(root, 'singularity', 'capabilities.yml'), YAML.stringify({
    version: 2,
    management: { mode: 'sflow-cli' },
    capabilities: {
      platform: {
        name: 'Platform', kind: 'delivery', repository: 'platform',
        architecture: { nodeType: 'service' }, sourceRoots: []
      }
    }
  }));
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'initialize CALM publication fixture']);
  return root;
}

test('one WMB v4 transaction publishes and reuses the exact CALM product on state', async (t) => {
  const root = await repository(t);
  const built = await worldModelCommand(root, ['wm', 'build'], {
    format: 'registered-v4', views: 'dev.impact'
  });
  assert.equal(built.status, 'completed');
  assert.deepEqual(built.projections.map(({ projectionId, status }) => ({ projectionId, status })), [
    { projectionId: 'arch.calm', status: 'available' }
  ]);
  assert.equal(built.publication.branch, 'state');
  assert.equal(git(root, ['status', '--short']), '');

  const status = await worldModelCommand(root, ['wm', 'status'], { json: true });
  assert.equal(status.fresh, true);
  assert.deepEqual(status.projections.map(({ projectionId, status: projectionStatus }) => ({
    projectionId, status: projectionStatus
  })), [{ projectionId: 'arch.calm', status: 'available' }]);
  const projection = JSON.parse(git(root, [
    'show', 'state:singularity/world-model/projections/arch.calm.json'
  ]));
  assert.equal(projection.$schema, 'https://calm.finos.org/release/1.2/meta/calm.json');
  assert.ok(projection.nodes.some((node) => node['unique-id'] === 'platform'));
});

test('a configured lifecycle gate requires current exact architecture-intent fulfilment', async (t) => {
  const root = await repository(t);
  await worldModelCommand(root, ['wm', 'build'], { format: 'registered-v4', views: 'dev.impact' });
  const store = resolvePublishedWorldModelV4(root, { stateBranch: 'state' });
  const current = store.projections.find((entry) => entry.projectionId === 'arch.calm');
  const intent = createArchitectureIntent({
    workId: 'WRK-CALM', phase: 'planning', generation: 1,
    base: {
      worldModelManifestSha256: store.manifest.manifestSha256,
      calmProjectionSha256: current.projectionSha256
    },
    clauses: [{
      clauseId: 'WRK-CALM:ARCH-001', operation: 'change-node', elementId: 'platform',
      required: true, value: { name: 'Platform' }
    }]
  });
  const directory = path.join(root, 'singularity', 'work-items', 'WRK-CALM', 'context', 'architecture');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'architecture-intent.json'), canonicalJson(intent));
  const policy = {
    enabled: true, allowedPhases: ['planning'], blockRequiredUnfulfilledAt: ['verification']
  };
  const definition = { worldModel: { outputDir: 'singularity/world-model' }, architectureIntent: policy };
  const workflow = {
    workItem: { id: 'WRK-CALM' },
    resolution: { workItemRoot: 'singularity/work-items', worldModelOutputDir: 'singularity/world-model', architectureIntent: policy }
  };
  const missing = await evaluateArchitectureIntentGate(root, definition, workflow, 'verification');
  assert.match(missing.errors.join('\n'), /has no fulfilment receipt/);

  const report = verifyArchitectureIntent({
    intent, baseAfter: current.projection, baseAfterSha256: current.projectionSha256
  });
  await writeFile(path.join(directory, 'intent-fulfilment.json'), canonicalJson(report));
  const satisfied = await evaluateArchitectureIntentGate(root, definition, workflow, 'verification');
  assert.deepEqual(satisfied.errors, []);
  assert.match(satisfied.passes[0], /architecture intent fulfilled/);
});
