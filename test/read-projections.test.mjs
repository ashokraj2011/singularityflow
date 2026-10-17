import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createWarmReadFixture } from '../scripts/warm-read-fixture.mjs';
import { accountingProjection } from '../src/accounting-projection.mjs';
import { workflowCatalogMetadata } from '../src/workflow-catalog.mjs';
import { loadDefinition } from '../src/config.mjs';
import { withCommandReadScope, withFreshReadScope } from '../src/read-scope.mjs';
import { withConfigurationReadRoot } from '../src/configuration-read-scope.mjs';
import { withCommandTiming } from '../src/dx-timing-context.mjs';

test('metadata/accounting are source-bound views, not executable definitions or validation receipts', async t => {
  const f = await createWarmReadFixture(); t.after(f.cleanup);
  const counters = {};
  const spans = new Set();
  await rm(path.join(f.repository, 'singularity/templates/chore/intake.md'));
  const timer = { increment(key, n = 1) { counters[key] = (counters[key] ?? 0) + n; }, measure(key, fn) { spans.add(key); return fn(); } };
  await withCommandTiming(timer, () => withCommandReadScope(async () => {
    const preferences = await accountingProjection(f.repository);
    assert.equal(preferences.harnessImports.mode, 'off');
    const rows = await workflowCatalogMetadata(f.repository);
    const own = rows.find(row => row.id === 'chore');
    assert.equal(own.catalogProjection.readiness, 'not-assessed');
    assert.equal(own.catalogProjection.sourceSha256, preferences.sourceBinding.sha256);
    assert.equal(own.catalogProjection.sourceCommit, null);
    await assert.rejects(loadDefinition(f.repository), /Template missing/);
  }));
  assert.equal(counters['configuration.source-read'], 1);
  assert.equal(counters['configuration.yaml-parse'], 1);
  assert.equal(counters['catalog.metadata-projections'], 1);
  for (const key of ['accounting.preferences', 'catalog.workflow-metadata', 'configuration.source-io',
    'configuration.source-parse', 'configuration.validate']) assert.ok(spans.has(key), key);
});

test('projections see fresh edits and exact overlays, with malformed preferences refused', async t => {
  const f = await createWarmReadFixture(), other = await createWarmReadFixture();
  t.after(f.cleanup); t.after(other.cleanup);
  const file = path.join(f.repository, 'singularity/workflow.yml');
  const original = await readFile(file, 'utf8');
  await withCommandReadScope(async () => {
    const before = await accountingProjection(f.repository);
    await writeFile(file, original + '\nlogging:\n  level: debug\n');
    const fresh = await withFreshReadScope(() => accountingProjection(f.repository));
    assert.equal(fresh.logging.level, 'debug');
    assert.notEqual(fresh.sourceBinding.sha256, before.sourceBinding.sha256);
    const overlaid = await withConfigurationReadRoot(f.repository, other.repository,
      { commit: 'a'.repeat(40) }, () => accountingProjection(f.repository));
    assert.equal(overlaid.logging.level, 'info');
    assert.equal(overlaid.sourceBinding.commit, 'a'.repeat(40));
  });
  await writeFile(file, original + '\nlogging:\n  keep: 0\n');
  await assert.rejects(accountingProjection(f.repository), /logging.keep/);
  await writeFile(file, 'version: [invalid\n');
  await assert.rejects(accountingProjection(f.repository));
  await assert.rejects(workflowCatalogMetadata(f.repository));
});

test('output profiling is opt-in, bounded diagnostics and never changes JSON stdout', async t => {
  const f = await createWarmReadFixture(); t.after(f.cleanup);
  const args = [f.cli, 'progress', 'PERF-001', '--utility-entry', '--for-agent', '--json'];
  const env = { ...f.env, SINGULARITY_FLOW_AGENT_OUTPUT: 'full' };
  const before = spawnSync(process.execPath, args, { cwd: f.repository, env, encoding: 'utf8' });
  const after = spawnSync(process.execPath, args, { cwd: f.repository,
    env: { ...env, SINGULARITY_FLOW_OUTPUT_TIMING: 'stderr-v1' }, encoding: 'utf8' });
  assert.equal(after.status, 0, after.stderr);
  assert.equal(after.stdout, before.stdout);
  const line = after.stderr.split('\n').find(line => line.startsWith('@@sflow-output/v1 '));
  const times = JSON.parse(line.slice(18));
  assert.ok(times.serializeMs >= 0 && times.renderMs >= 0 && times.emitMs >= 0);
  assert.ok(times.inputBytes > 0 && times.outputBytes > 0);
  assert.equal(before.stderr.includes('@@sflow-output/v1'), false);
});

test('catalog display keeps its metadata classification across a fresh approved overlay', async t => {
  const f = await createWarmReadFixture(); t.after(f.cleanup);
  f.git(['branch', 'sflow/config']);
  const commit = f.git(['rev-parse', 'sflow/config']);
  await rm(path.join(f.repository, 'singularity/workflow.yml'));
  f.git(['add', 'singularity/workflow.yml']);
  f.git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'application without configuration projection']);
  const result = f.cold(['workflow', 'list', '--utility-entry', '--for-agent', '--json']);
  assert.equal(result.readCompleted, true);
  assert.equal(result.catalogView.readiness, 'not-assessed');
  assert.equal(result.catalogView.sourceBindings[0].sourceCommit, commit);
});
