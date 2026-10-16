import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDefinition, loadDefinition, withDefinitionCache } from '../src/config.mjs';
import { withRepositoryConfigurationCommitRead } from '../src/approved-configuration-reader.mjs';
import { loadStoryConfigurationSnapshot,
  materializeConfigurationSnapshot } from '../src/configuration-branch.mjs';
import { loadMaterializedConfigurationDefinition, withMaterializedConfigurationRead } from '../src/commands/start-configuration.mjs';
import { commandTimer, withCommandTiming } from '../src/dx-command-timing.mjs';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
async function fixture(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-shared-definition-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'root'), target = path.join(parent, 'story'); await mkdir(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Definition Tester'); git(root, 'config', 'user.email', 'definition@example.invalid');
  await initializeDefinition(root);
  await writeFile(path.join(root, 'README.md'), 'source stays unchanged\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'approved');
  const commit = git(root, 'rev-parse', 'HEAD'); git(root, 'branch', 'sflow/config');
  const snapshot = await loadStoryConfigurationSnapshot({ remote: root, branch: 'sflow/config', commit });
  git(root, 'worktree', 'add', '-q', '-b', 'story', target);
  await materializeConfigurationSnapshot(target, { snapshot });
  return { parent, root, target, commit, snapshot };
}
test('materialized configuration shares verified compilation but rebinds paths and isolates consumer edits', async t => {
  const f = await fixture(t), before = await readFile(path.join(f.root, '.git/index'));
  const timer = commandTimer('materialized-reuse', { commandClass: 'mutation' });
  const value = await withCommandTiming(timer, () => loadMaterializedConfigurationDefinition(f.target, f.snapshot));
  const counters = timer.finish().counters;
  assert.equal(counters['configuration.compiled-materialized-reuse'], 1);
  assert.equal(counters['configuration.definition-load'] ?? 0, 0);
  for (const agent of value.agentCatalog.filter(agent => agent.scope === 'repository')) {
    assert.equal(path.relative(f.target, agent.file).startsWith('..'), false);
  }
  assert.deepEqual(value.governedRoots, f.snapshot.definition.governedRoots);
  value.workTypes.feature.label = 'consumer edit';
  assert.notEqual((await loadMaterializedConfigurationDefinition(f.target, f.snapshot)).workTypes.feature.label, 'consumer edit');
  assert.deepEqual(await readFile(path.join(f.root, '.git/index')), before);
});
test('byte drift and extra governed assets cannot use a previously validated definition', async t => {
  const f = await fixture(t);
  await appendFile(path.join(f.target, 'singularity/workflow.yml'), '\n# same semantics, changed bytes\n');
  await assert.rejects(loadMaterializedConfigurationDefinition(f.target, f.snapshot), /changed after materialization/);
  await materializeConfigurationSnapshot(f.target, { snapshot: f.snapshot });
  await writeFile(path.join(f.target, '.github/agents/extra.agent.md'), '# Unexpected\n');
  await assert.rejects(loadMaterializedConfigurationDefinition(f.target, f.snapshot), /asset set changed/);
});
test('materialized reuse still checks live output-root containment and refuses changed snapshot data', async t => {
  const f = await fixture(t), outside = path.join(f.parent, 'outside'); await mkdir(outside);
  const output = path.join(f.target, 'singularity/work-items');
  await rm(output, { recursive: true, force: true });
  await symlink(outside, output, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(loadMaterializedConfigurationDefinition(f.target, f.snapshot), /symbolic|symlink|escape/);
  await rm(output);
  f.snapshot.definition.workTypes.feature.label = 'tampered snapshot';
  await assert.rejects(loadMaterializedConfigurationDefinition(f.target, f.snapshot), /changed in memory/);
});
test('one exact legacy commit overlay shares concurrent configuration loads without inheriting a caller cache', async t => {
  const f = await fixture(t);
  const timer = commandTimer('legacy-definition-reuse', { commandClass: 'read' });
  await withDefinitionCache(async () => {
    await loadDefinition(f.root);
    const values = await withCommandTiming(timer, () => withRepositoryConfigurationCommitRead(f.root,
      { commit: f.commit }, () => Promise.all([loadDefinition(f.root), loadDefinition(f.root), loadDefinition(f.root)])));
    assert.equal(values[0], values[1]);
    assert.equal(values[1], values[2]);
  });
  assert.equal(timer.finish().counters['configuration.definition-load'], 1);
});

test('bounded materialized consumers reuse compilation without hiding writes or leaking to later readers', async t => {
  const f = await fixture(t);
  const timer = commandTimer('bounded-materialized-reuse', { commandClass: 'mutation' });
  await withCommandTiming(timer, () => withMaterializedConfigurationRead(f.target, f.snapshot, async () => {
    const first = await loadDefinition(f.target);
    first.workTypes.feature.label = 'private consumer mutation';
    assert.notEqual((await loadDefinition(f.target)).workTypes.feature.label, first.workTypes.feature.label);
  }));
  assert.equal(timer.finish().counters['configuration.definition-load'] ?? 0, 0);
  await assert.rejects(withMaterializedConfigurationRead(f.target, f.snapshot, async () => {
    await appendFile(path.join(f.target, 'singularity/workflow.yml'), '\n# concurrent edit\n');
    await loadDefinition(f.target);
  }), /changed after materialization/);
  const fresh = commandTimer('outside-bounded-reuse', { commandClass: 'read' });
  await withCommandTiming(fresh, () => loadDefinition(f.target));
  assert.equal(fresh.finish().counters['configuration.definition-load'], 1);
});
