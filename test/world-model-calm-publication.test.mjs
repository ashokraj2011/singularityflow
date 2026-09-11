import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { initializeDefinition, loadDefinition } from '../src/config.mjs';
import { run } from '../src/util.mjs';
import { worldModelCommand } from '../src/worldmodel.mjs';
import {
  assertApprovedArchitectureIntent, evaluateArchitectureIntentGate, projectArchitectureIntentStatus
} from '../src/architecture-intent-gate.mjs';
import {
  createArchitectureIntent, verifyArchitectureIntent
} from '../src/world-model/projections/calm/projection.mjs';
import { canonicalJson, sealRecord } from '../src/world-model/canonicalize.mjs';
import { resolvePublishedWorldModelV4 } from '../src/world-model/store.mjs';
import { validateStagedProjectionAuthorityAgainstSource } from '../src/world-model/publish/transaction.mjs';
import {
  assertArchitectureProjectionAuthoritySnapshots, resolveCurrentArchitectureProjectionInputs
} from '../src/world-model/projections/calm/authority.mjs';
import { resolveArchitectureIntentBase } from '../src/commands/architecture.mjs';

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
  git(root, ['add', 'singularity/work-items/WRK-CALM/context/architecture/architecture-intent.json']);
  git(root, ['commit', '-q', '-m', 'approve architecture intent evidence']);
  const evidenceCommit = git(root, ['rev-parse', 'HEAD']);
  const policy = {
    enabled: true, allowedPhases: ['planning'], blockRequiredUnfulfilledAt: ['verification']
  };
  const definition = await loadDefinition(root);
  definition.architectureIntent = policy;
  const historicalBase = resolveArchitectureIntentBase(root, definition, intent);
  assert.equal(historicalBase.projection.$id, current.projection.$id);
  assert.equal(historicalBase.commit, store.commit);
  assert.ok(historicalBase.sourceMap);
  const workflow = {
    workItem: { id: 'WRK-CALM' },
    resolution: { workItemRoot: 'singularity/work-items', worldModelOutputDir: 'singularity/world-model', architectureIntent: policy },
    phases: {
      planning: {
        approvals: [{ decision: 'approved', generation: 1, evidenceCommit }]
      }
    }
  };
  const candidateStatus = await projectArchitectureIntentStatus(root, definition, {
    ...workflow, phases: { planning: { approvals: [] } }
  });
  assert.equal(candidateStatus.status, 'candidate');
  assert.equal(candidateStatus.approved, false);
  assert.throws(
    () => assertApprovedArchitectureIntent(root, {
      ...workflow, phases: { planning: { approvals: [] } }
    }, intent, path.join(directory, 'architecture-intent.json')),
    (error) => error.code === 'WMC_INTENT_NOT_APPROVED'
  );
  assert.equal(assertApprovedArchitectureIntent(
    root, workflow, intent, path.join(directory, 'architecture-intent.json')
  ).approved, true);
  assert.equal((await projectArchitectureIntentStatus(root, definition, workflow)).status, 'approved');
  const missing = await evaluateArchitectureIntentGate(root, definition, workflow, 'verification');
  assert.match(missing.errors.join('\n'), /has no fulfilment receipt/);

  const report = verifyArchitectureIntent({
    intent, baseAfter: current.projection, baseAfterSha256: current.projectionSha256
  });
  await writeFile(path.join(directory, 'intent-fulfilment.json'), canonicalJson(report));
  const fulfilledStatus = await projectArchitectureIntentStatus(root, definition, workflow);
  assert.equal(fulfilledStatus.fulfilment.status, 'recorded-satisfied');
  assert.equal(fulfilledStatus.fulfilment.baseAfterSha256, current.projectionSha256);
  assert.equal(fulfilledStatus.fulfilment.counts.fulfilled, 1);
  const satisfied = await evaluateArchitectureIntentGate(root, definition, workflow, 'verification');
  assert.deepEqual(satisfied.errors, []);
  assert.match(satisfied.passes[0], /architecture intent fulfilled/);
});

test('capability authority changes stale a reusable CALM projection without source changes', async (t) => {
  const root = await repository(t);
  await worldModelCommand(root, ['wm', 'build'], { format: 'registered-v4', views: 'dev.impact' });
  const publishedPaths = git(root, [
    'ls-tree', '-r', '--name-only', 'state', '--', 'singularity/world-model'
  ]).split('\n').filter(Boolean);
  const files = Object.fromEntries(publishedPaths.map((target) => [
    target, run('git', ['show', `state:${target}`], { cwd: root }).stdout
  ]));
  const publication = {
    outputDir: 'singularity/world-model',
    manifestPath: 'singularity/world-model/manifest.json',
    manifest: JSON.parse(files['singularity/world-model/manifest.json']),
    files,
    replaceRoots: ['singularity/world-model']
  };
  const capabilityPath = path.join(root, 'singularity', 'capabilities.yml');
  const capabilities = YAML.parse(await readFile(capabilityPath, 'utf8'));
  capabilities.capabilities.platform.name = 'Renamed platform';
  await writeFile(capabilityPath, YAML.stringify(capabilities));

  const status = await worldModelCommand(root, ['wm', 'status'], { json: true });
  assert.equal(status.fresh, false);
  assert.ok(status.freshness.changes.some(
    (change) => change.reason === 'capability-snapshot-changed'
  ));
  await assert.rejects(
    () => validateStagedProjectionAuthorityAgainstSource(root, publication),
    (error) => error.code === 'WMC_PROJECTION_INPUT_CHANGED'
  );
});

test('publication refuses a self-consistent normalized snapshot forged from genuine source bytes', async (t) => {
  const root = await repository(t);
  const current = await resolveCurrentArchitectureProjectionInputs(root, await loadDefinition(root));
  const forged = structuredClone(current);
  forged.capabilitySnapshot.capabilities[0].label = 'Forged label';
  forged.capabilitySnapshot = sealRecord({
    ...forged.capabilitySnapshot, snapshotSha256: undefined
  }, 'snapshotSha256');

  assert.throws(
    () => assertArchitectureProjectionAuthoritySnapshots(forged, current),
    (error) => error.code === 'WMC_PROJECTION_INPUT_CHANGED'
      && error.details.changes[0].authority === 'capability'
  );
});
