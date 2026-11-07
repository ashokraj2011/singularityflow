import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';
import { createSflow } from '../src/api.mjs';
import { compileWorkflowBundle, exportWorkflowBundle, serializeWorkflowBundle } from '../src/workflow-transfer.mjs';
import { withApprovedConfigurationRead } from '../src/approved-configuration-reader.mjs';
import { withConfigurationReadRoot } from '../src/configuration-read-scope.mjs';
import { isolatedTestEnvironment } from '../scripts/test-machine-state.mjs';
import { bundledCliUrl } from '../src/bundled-cli.mjs';

const executable = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const capture = fileURLToPath(new URL('./helpers/capture-engine-operation.mjs', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-engine-workflow-assets-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const env = isolatedTestEnvironment(path.join(root, '.machine'));
  await initializeDefinition(root);
  const file = path.join(root, 'singularity/workflow.yml'), config = YAML.parse(await readFile(file, 'utf8'));
  config.workTypes['future-custom'] = { ...structuredClone(config.workTypes.feature), label: 'Custom future workflow' };
  await writeFile(file, YAML.stringify(config));
  const git = (...args) => { const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.error?.message || result.stderr); return result.stdout.trim(); };
  git('init', '-q', '-b', 'main'); git('add', 'singularity', '.github'); git('commit', '-qm', 'fixture configuration');
  git('branch', 'sflow/config');
  return { root, env, git, file, config };
}

test('SDK inventory and actual CLI export use the same approved compiler for packaged and future custom workflows', async t => {
  const f = await fixture(t), head = f.git('rev-parse', 'HEAD'), status = f.git('status', '--porcelain');
  const ids = ['future-custom', 'story:feature'];
  const reviewed = await withApprovedConfigurationRead(f.root, () => compileWorkflowBundle(f.root, ids), { preferAuthority: true });
  const api = createSflow({ root: f.root }), result = await api.run('workflow.assets', { workflowIds: ids });
  assert.equal(result.manifest.bundleSha256, reviewed.bundleSha256);
  assert.deepEqual(result.manifest.source, { kind: 'approved-snapshot', revision: head });
  assert.deepEqual(result.manifest.dependencies.workflows, ['story:feature', 'story:future-custom']);
  const output = path.join(f.root, '.machine', 'workflow-bundle.json');
  const captured = path.join(f.root, '.machine', 'workflow-assets.capture.json');
  const cli = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--no-warnings', '--import', capture,
    executable, 'workflow', 'export', '--workflow', ids.join(','), '--out', output, '--json'], {
    cwd: f.root, env: { ...f.env, NODE_ENV: 'test', SINGULARITY_FLOW_BUNDLE: 'off', SINGULARITY_FLOW_TEST_ENGINE_CAPTURE: captured },
    encoding: 'utf8', timeout: 60_000
  });
  assert.equal(cli.status, 0, cli.error?.message || cli.stderr || cli.stdout);
  const exported = JSON.parse(cli.stdout);
  assert.deepEqual(JSON.parse(await readFile(captured, 'utf8')), { operation: 'workflow.assets', result },
    'observe the actual CLI registry result rather than substituting a domain result');
  assert.deepEqual(exported.dependencies, result.manifest.dependencies);
  assert.deepEqual(exported.summary, result.manifest.summary);
  assert.equal(await readFile(output, 'utf8'), serializeWorkflowBundle(reviewed));
  const outdir = await mkdtemp(fileURLToPath(new URL('../.bundle-test-workflow-assets-', import.meta.url)));
  t.after(() => rm(outdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const { buildCliBundle } = await import('../scripts/build-cli-bundle.mjs'); await buildCliBundle({ outdir });
  const bundleEnv = { ...f.env, SINGULARITY_FLOW_BUNDLE: 'auto', SINGULARITY_FLOW_BUNDLE_DIR: outdir };
  assert.ok(bundledCliUrl(fileURLToPath(new URL('..', import.meta.url)), bundleEnv)?.startsWith(pathToFileURL(outdir + path.sep).href));
  const bundledOutput = path.join(f.root, '.machine', 'bundled-workflow-bundle.json');
  const bundled = spawnSync(process.execPath, [executable, 'workflow', 'export', '--workflow', ids.join(','), '--out', bundledOutput, '--json'], {
    cwd: f.root, env: bundleEnv, encoding: 'utf8', timeout: 60_000
  });
  assert.equal(bundled.status, 0, bundled.error?.message || bundled.stderr || bundled.stdout);
  assert.deepEqual(JSON.parse(bundled.stdout).dependencies, result.manifest.dependencies);
  assert.equal(await readFile(bundledOutput, 'utf8'), serializeWorkflowBundle(reviewed));
  assert.equal(f.git('rev-parse', 'HEAD'), head);
  assert.equal(f.git('status', '--porcelain'), status);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(f.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('an API query refreshes its approved source while a direct legacy export preserves its selected working scope', async t => {
  const f = await fixture(t), api = createSflow({ root: f.root });
  const original = await api.run('workflow.assets', { workflowIds: ['feature'] });
  f.config.workTypes.feature.label = 'Unapproved local edit'; await writeFile(f.file, YAML.stringify(f.config));
  const local = await exportWorkflowBundle(f.root, ['feature']);
  assert.notEqual(local.bundleSha256, original.manifest.bundleSha256);
  const fresh = await withConfigurationReadRoot(f.root, f.root, null, () => api.run('workflow.assets', { workflowIds: ['feature'] }));
  assert.equal(fresh.manifest.bundleSha256, original.manifest.bundleSha256);
  assert.equal((await readFile(f.file, 'utf8')).includes('Unapproved local edit'), true);
});

test('native missing-selection and unknown-workflow errors remain explicit without creating an export', async t => {
  const f = await fixture(t), api = createSflow({ root: f.root }), head = f.git('rev-parse', 'HEAD');
  await assert.rejects(api.run('workflow.assets', { workflowIds: ['missing-workflow'] }), { code: 'WORKFLOW_UNKNOWN' });
  await assert.rejects(exportWorkflowBundle(f.root, []), { code: 'WORKFLOW_EXPORT_SELECTION_REQUIRED' });
  assert.equal(f.git('rev-parse', 'HEAD'), head);
});
