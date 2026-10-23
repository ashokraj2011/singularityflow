import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initializeDefinition } from '../src/config.mjs';
import { loadStoryConfigurationSnapshot, prepareSelectedStoryConfiguration, withStoryConfigurationTransaction } from '../src/configuration-branch.mjs';
import { GitRemoteSession } from '../src/git-execution.mjs';
import { commandTimer, withCommandTiming } from '../src/dx-command-timing.mjs';

function git(root, ...args) {
  const value = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(value.status, 0, value.stderr); return value.stdout.trim();
}
test('selected configuration prepares exact objects without a checkout and still fences moved authority', async t => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-selected-config-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const source = path.join(parent, 'source'), app = path.join(parent, 'app');
  await mkdir(source); await mkdir(app);
  for (const root of [source, app]) {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 'Preparation Tester');
    git(root, 'config', 'user.email', 'preparation@example.invalid');
    await writeFile(path.join(root, 'README.md'), 'unchanged application\n');
  }
  await initializeDefinition(source);
  git(source, 'add', '.'); git(source, 'commit', '-qm', 'configuration');
  git(source, 'branch', 'sflow/config');
  git(app, 'add', '.'); git(app, 'commit', '-qm', 'application');
  const authority = { remote: source, branch: 'sflow/config', commit: git(source, 'rev-parse', 'HEAD') };
  const before = git(app, 'status', '--porcelain=v1');
  const main = git(app, 'rev-parse', 'HEAD');
  git(app, 'symbolic-ref', 'refs/sflow/intake-configuration/selected', 'refs/heads/main');
  assert.equal((await prepareSelectedStoryConfiguration(app, authority)).status, 'prepared');
  assert.equal(git(app, 'rev-parse', 'HEAD'), main, 'a pre-existing retention alias cannot move application HEAD');
  assert.equal(git(app, 'status', '--porcelain=v1'), before);
  const timer = commandTimer('selected-preparation');
  const snapshot = await withCommandTiming(timer, () => withStoryConfigurationTransaction(() =>
    loadStoryConfigurationSnapshot(authority, { useObjectCache: true, session: new GitRemoteSession({ cwd: app }) })));
  assert.equal(snapshot.sourceCommit, authority.commit);
  // Since b3c8bf7f the workspace reader serves the prepared objects first; either reader takes them from
  // this repository, never by a fetch or a checkout.
  const counters = timer.finish().counters;
  assert.equal((counters['configuration.workspace-object-hit'] ?? 0) + (counters['configuration.prepared-object-hit'] ?? 0), 1, JSON.stringify(counters));
  assert.equal(counters['configuration.workspace-object-fetch'], undefined);
  assert.equal(counters['configuration.workspace-native-checkout'], undefined);
  assert.equal(git(app, 'status', '--porcelain=v1'), before);
  git(source, 'switch', '-q', 'sflow/config');
  await writeFile(path.join(source, 'README.md'), 'advanced configuration\n');
  git(source, 'add', '.'); git(source, 'commit', '-qm', 'advance');
  await assert.rejects(loadStoryConfigurationSnapshot(authority, { useObjectCache: true,
    session: new GitRemoteSession({ cwd: app }) }), { code: 'STORY_CONFIGURATION_AUTHORITY_STALE' });
});
