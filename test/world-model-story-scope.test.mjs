import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { run } from '../src/util.mjs';
import { configuredWorldModelV4ScopeOptions } from '../src/world-model/scope/configuration.mjs';
import { planWorldModelV4 } from '../src/world-model/plan.mjs';

test('default Story metadata scope keeps its identity; custom and pinned roots are excluded', () => {
  const options = config => configuredWorldModelV4ScopeOptions('/repository', config);
  const defaults = options({ definition: {} });
  assert.deepEqual(options({ definition: { workItemRoot: 'singularity/work-items' } }), defaults);
  assert.deepEqual(options({ definition: { workItemRoot: 'singularity/other-stories' } }), defaults);
  const custom = options({ definition: { workItemRoot: './team/stories/' } });
  assert.ok(custom.excludedPaths.includes('team/stories/**'));
  assert.notEqual(custom.policySnapshotSha256, defaults.policySnapshotSha256);
  assert.deepEqual(options({ definition: { workItemRoot: 'changed/root' },
    workflow: { resolution: { workItemRoot: 'team/stories' } } }), custom);
  assert.throws(() => options({ definition: { workItemRoot: '../outside' } }), /repository-relative/);
});

test('custom-root generated records do not dirty source, but actual application changes still do', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => run('git', args, { cwd: root });
  git('init', '-qb', 'main');
  git('config', 'user.name', 'Scope Tester'); git('config', 'user.email', 'scope@example.invalid');
  await mkdir(path.join(root, 'src')); await writeFile(path.join(root, 'src/app.mjs'), 'export const n = 1;\n');
  git('add', '.'); git('commit', '-qm', 'source');
  const options = { views: ['dev.impact'], composer: 'deterministic',
    ...configuredWorldModelV4ScopeOptions(root, { definition: { workItemRoot: 'team/stories' } }) };
  const before = planWorldModelV4(root, options);
  await mkdir(path.join(root, 'team/stories/SCOPE-1/context'), { recursive: true });
  await writeFile(path.join(root, 'team/stories/SCOPE-1/context/phase.json'), '{}\n');
  const after = planWorldModelV4(root, options);
  assert.equal(after.sourceSnapshot.sourceManifestSha256, before.sourceSnapshot.sourceManifestSha256);
  assert.deepEqual(after.sourceSnapshot.files.map(file => file.path), ['src/app.mjs']);
  await writeFile(path.join(root, 'src/app.mjs'), 'export const n = 2;\n');
  assert.throws(() => planWorldModelV4(root, options), error => error.code === 'WMB_SOURCE_SNAPSHOT_REQUIRED'
    && error.details.dirtyPaths.includes('src/app.mjs'));
});
