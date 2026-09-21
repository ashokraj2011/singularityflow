import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { initializeDefinition } from '../src/config.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function flow(root, ...args) {
  return spawnSync(process.execPath, [executable, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.test-workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.test-active-workspace.json'),
      SINGULARITY_FLOW_LEAD_REGISTRY: path.join(root, '.test-leads.json')
    }
  });
}

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workflow-transfer-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeDefinition(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Workflow Transfer Test');
  git(root, 'config', 'user.email', 'workflow-transfer@example.test');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'initialize workflow configuration');
  return root;
}

test('workflow export writes one portable bundle for several selected workflows', async (t) => {
  const root = await repository(t);
  const output = path.join(root, 'selected-workflows.sflow-workflows.json');
  const result = flow(root,
    'workflow', 'export',
    '--workflow', 'feature', '--workflow', 'bugfix',
    '--out', output, '--json');

  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.resultType, 'workflow-export');
  assert.equal(receipt.status, 'exported');
  assert.equal(receipt.outputPath, output);
  assert.match(receipt.bundleSha256, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(receipt.workflows.map((entry) => entry.id), ['bugfix', 'feature']);
  assert.ok(receipt.summary.phases > 0);
  assert.ok(receipt.summary.templates > 0);
  assert.ok(receipt.summary.agents > 0);
  assert.ok(receipt.dependencies.workflows.includes('story:feature'));
  assert.ok(receipt.dependencies.phases.includes('story:implementation'));

  const bundle = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(bundle.kind, 'sflow-workflow-bundle');
  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.bundleSha256, receipt.bundleSha256);
  assert.deepEqual(bundle.workflows.map((entry) => `${entry.governs}:${entry.id}`), [
    'story:bugfix', 'story:feature'
  ]);
  assert.ok(Object.hasOwn(bundle.objects.story.workTypes, 'bugfix'));
  assert.ok(Object.hasOwn(bundle.objects.story.workTypes, 'feature'));
  assert.ok(bundle.assets.some((asset) => asset.kind === 'template'));
  assert.ok(bundle.assets.some((asset) => asset.kind === 'agent'));
});

test('workflow import dry-run reports exact reuse without changing configuration', async (t) => {
  const root = await repository(t);
  const output = path.join(root, 'feature.sflow-workflows.json');
  const exported = flow(root, 'workflow', 'export', '--workflow', 'feature', '--out', output, '--json');
  assert.equal(exported.status, 0, exported.stderr);
  const workflowFile = path.join(root, 'singularity', 'workflow.yml');
  const before = await readFile(workflowFile, 'utf8');

  const preview = flow(root, 'workflow', 'import', output, '--dry-run', '--json');

  assert.equal(preview.status, 0, preview.stderr);
  const plan = JSON.parse(preview.stdout);
  assert.equal(plan.resultType, 'workflow-import-plan');
  assert.equal(plan.status, 'ready');
  assert.match(plan.planSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(plan.operations.conflicts.length, 0);
  assert.ok(plan.operations.reuse.some((entry) =>
    entry.kind === 'story.workTypes' && entry.id === 'feature'));
  assert.equal(await readFile(workflowFile, 'utf8'), before);
});

test('workflow copy and duplicate previews are deterministic linked-copy plans', async (t) => {
  const root = await repository(t);
  const workflowFile = path.join(root, 'singularity', 'workflow.yml');
  const before = await readFile(workflowFile, 'utf8');

  const copied = flow(root,
    'workflow', 'copy', 'feature', 'feature-copy', '--label', 'Feature copy', '--dry-run', '--json');
  const duplicated = flow(root,
    'workflow', 'duplicate', 'feature', 'feature-copy', '--label', 'Feature copy', '--dry-run', '--json');

  assert.equal(copied.status, 0, copied.stderr);
  assert.equal(duplicated.status, 0, duplicated.stderr);
  const copyPlan = JSON.parse(copied.stdout);
  const duplicatePlan = JSON.parse(duplicated.stdout);
  assert.equal(copyPlan.resultType, 'workflow-copy-plan');
  assert.equal(copyPlan.status, 'ready');
  assert.equal(copyPlan.sharedDependencies.linked, true);
  assert.deepEqual(copyPlan.operations.add, [{ kind: 'story.workflow', id: 'feature-copy' }]);
  assert.ok(copyPlan.operations.reuse.some((entry) => entry.kind === 'story.phase'));
  assert.equal(duplicatePlan.planSha256, copyPlan.planSha256);
  assert.equal(await readFile(workflowFile, 'utf8'), before);

  const applied = flow(root,
    'workflow', 'copy', 'feature', 'feature-copy', '--label', 'Feature copy',
    '--confirm', copyPlan.planSha256, '--json');
  assert.equal(applied.status, 0, applied.stderr);
  const result = JSON.parse(applied.stdout);
  assert.equal(result.resultType, 'workflow-copy');
  assert.equal(result.status, 'copied');
  const after = YAML.parse(await readFile(workflowFile, 'utf8'));
  assert.deepEqual(after.workTypes['feature-copy'], {
    ...after.workTypes.feature,
    label: 'Feature copy'
  });
});
