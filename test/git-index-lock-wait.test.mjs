/**
 * Another program's brief hold on a Story worktree's index must not fail a governed publication.
 *
 * VS Code's Git view and editors run `git status`, which takes `index.lock`, typically right after
 * Singularity Flow writes files. A publication refreshes its published index entries after the
 * branch has advanced; failing there reported "Unable to create '.../index.lock': File exists",
 * left the commit published, and made every published file look changed.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { commitIsolated, refreshStalePublishedIndex } from '../src/git.mjs';
import { run } from '../src/util.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'singularity-flow.mjs');

const env = { ...process.env, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Lock Tester',
  GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'lock@example.invalid' };
const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

/** A Story worktree beside its repository, with one governed file written and not yet committed. */
async function storyWorktree(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-index-lock-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = path.join(base, 'app');
  git(base, 'init', '-q', '-b', 'main', repo);
  await writeFile(path.join(repo, 'README.md'), '# App\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-qm', 'init');
  const worktree = path.join(base, 'story');
  git(repo, 'worktree', 'add', '-q', '-b', 'STORY-1', worktree);
  await writeFile(path.join(worktree, 'spec.md'), '# Specification\n');
  return { worktree, lock: path.resolve(worktree, git(worktree, 'rev-parse', '--git-path', 'index.lock')) };
}

/** Hold `lock` as another program would, releasing it after `ms` from a separate process. */
async function holdLock(lock, ms) {
  await writeFile(lock, '');
  spawn(process.execPath, ['-e', `setTimeout(() => require('node:fs').rmSync(${JSON.stringify(lock)}, { force: true }), ${ms})`],
    { detached: true, stdio: 'ignore' }).unref();
}

test('a publication waits out a brief index lock taken after its branch advanced, and leaves a clean index', async (t) => {
  const { worktree, lock } = await storyWorktree(t);
  const expectedHead = git(worktree, 'rev-parse', 'HEAD');
  const committed = await commitIsolated(worktree, '[STORY-1][phase:specification] publish', ['spec.md'], {
    expectedHead,
    // The moment that failed: after the branch moved, before the index refresh.
    onRefAdvanced: () => holdLock(lock, 600)
  });
  assert.equal(git(worktree, 'rev-parse', 'HEAD'), committed);
  assert.equal(existsSync(lock), false);
  assert.equal(git(worktree, 'status', '--porcelain'), '', 'nothing looks changed after publishing');
});

test('a lock held past the wait still fails, says who to look for, and keeps the published commit', async (t) => {
  const { worktree, lock } = await storyWorktree(t);
  const expectedHead = git(worktree, 'rev-parse', 'HEAD');
  const previous = process.env.SINGULARITY_FLOW_GIT_INDEX_LOCK_WAIT_MS;
  process.env.SINGULARITY_FLOW_GIT_INDEX_LOCK_WAIT_MS = '300';
  t.after(() => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_GIT_INDEX_LOCK_WAIT_MS;
    else process.env.SINGULARITY_FLOW_GIT_INDEX_LOCK_WAIT_MS = previous;
  });
  const started = Date.now();
  const error = await commitIsolated(worktree, '[STORY-1][phase:specification] publish', ['spec.md'], {
    expectedHead, onRefAdvanced: () => writeFile(lock, '')
  }).then(() => null, (caught) => caught);
  assert.ok(error, 'a held lock is not ignored');
  assert.ok(Date.now() - started >= 300, 'it waited before failing');
  assert.match(error.message, /index\.lock/u);
  assert.match(error.message, /Singularity Flow waited [\d.]+ s for .*index\.lock; another program \(VS Code's Git view, an editor or a terminal\) still holds it/u);
  assert.equal(error.publicationRefAdvanced, true, 'the branch had advanced; recovery must not roll it back');
  await rm(lock, { force: true });

  // The state the failure left: published, yet the index still describes the parent, so the
  // published file looks changed and the next start refuses a dirty tree.
  assert.equal(git(worktree, 'rev-parse', 'HEAD'), error.publicationCommit);
  assert.match(git(worktree, 'status', '--porcelain'), /spec\.md/u);
  // Something staged meanwhile is not the publication's to refresh.
  await writeFile(path.join(worktree, 'notes.txt'), 'developer notes\n');
  git(worktree, 'add', 'notes.txt');
  assert.deepEqual(refreshStalePublishedIndex(worktree, error.publicationCommit), ['spec.md']);
  assert.equal(git(worktree, 'status', '--porcelain'), 'A  notes.txt', 'recovery leaves only what someone staged');
  assert.deepEqual(refreshStalePublishedIndex(worktree, error.publicationCommit), [], 'a second run finds nothing stale');
});

test('recovery leaves a published path alone once someone has staged new content for it', async (t) => {
  const { worktree, lock } = await storyWorktree(t);
  const expectedHead = git(worktree, 'rev-parse', 'HEAD');
  process.env.SINGULARITY_FLOW_GIT_INDEX_LOCK_WAIT_MS = '0';
  t.after(() => { delete process.env.SINGULARITY_FLOW_GIT_INDEX_LOCK_WAIT_MS; });
  const error = await commitIsolated(worktree, '[STORY-1][phase:specification] publish', ['spec.md'], {
    expectedHead, onRefAdvanced: () => writeFile(lock, '')
  }).then(() => null, (caught) => caught);
  assert.ok(error?.publicationRefAdvanced);
  await rm(lock, { force: true });
  await writeFile(path.join(worktree, 'spec.md'), '# Specification\n\nA later edit.\n');
  git(worktree, 'add', 'spec.md');
  assert.deepEqual(refreshStalePublishedIndex(worktree, error.publicationCommit), []);
  assert.equal(git(worktree, 'status', '--porcelain'), 'M  spec.md');
});

test('only commands that take the index lock before changing anything are run again', async (t) => {
  const { worktree, lock } = await storyWorktree(t);
  await holdLock(lock, 400);
  const added = run('git', ['-c', 'core.quotepath=false', 'add', 'spec.md'], { cwd: worktree, env });
  assert.equal(added.status, 0, 'add waited for the lock');
  await writeFile(lock, '');
  const stash = run('git', ['stash'], { cwd: worktree, env, allowFailure: true });
  assert.notEqual(stash.status, 0, 'a compound command is not repeated');
  assert.doesNotMatch(stash.stderr, /Singularity Flow waited/u);
  await rm(lock, { force: true });
});

/** A POC Lite Story whose first phase is prepared and ready to publish, beside a bare origin. */
async function preparedStory(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-index-lock-story-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'app');
  const storyEnv = { ...env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1',
    HOME: path.join(base, 'home'), USERPROFILE: path.join(base, 'home'), SINGULARITY_FLOW_TEST_IDENTITY: 'Lock Tester',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'ws.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'mode.json') };
  const sflow = (args, extra = {}) => spawnSync(process.execPath, [CLI, '--no-model', ...args], { cwd: root, env: { ...storyEnv, ...extra }, encoding: 'utf8' });
  git(base, 'init', '-q', '-b', 'main', root);
  await writeFile(path.join(root, 'README.md'), '# Lock\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  assert.equal(sflow(['init']).status, 0);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const configuration = YAML.parse(await readFile(configPath, 'utf8'));
  configuration.repositoryReadiness.requiredBeforeStory = false;
  await writeFile(configPath, YAML.stringify(configuration));
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  git(base, 'init', '-q', '--bare', '-b', 'main', `${root}.git`);
  git(root, 'remote', 'add', 'origin', `${root}.git`);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  for (const args of [['start', 'LOCK-1', '--from-branch', 'main', '--work-type', 'poc-lite', '--title', 'One local change',
    '--description', 'Publication survives a busy index.'], ['prepare', 'poc-lite-plan']]) {
    const result = sflow(args);
    assert.equal(result.status, 0, result.stderr);
  }
  const lock = path.resolve(root, git(root, 'rev-parse', '--git-path', 'index.lock'));
  const publish = (extra) => sflow(['phase', 'publish', 'poc-lite-plan', '--authored', 'deterministic', '--channel', 'kernel-generator'], extra);
  return { root, lock, sflow, publish };
}

/** Another program taking the index lock whenever it is free: for `holdMs`, or until stopped. */
function lockHolder(lock, { holdMs = null, everyMs = 2 } = {}) {
  const release = holdMs ? `;setTimeout(()=>fs.rmSync(${JSON.stringify(lock)},{force:true}),${holdMs})` : '';
  const child = spawn(process.execPath, ['-e', `const fs=require('node:fs');setInterval(()=>{try{fs.writeFileSync(${JSON.stringify(lock)},'',{flag:'wx'})${release}}catch{}},${everyMs})`],
    { stdio: 'ignore' });
  return async () => { child.kill(); await new Promise((resolve) => setTimeout(resolve, 50)); await rm(lock, { force: true }); };
}

test('a Story publishes while an editor keeps taking the index lock for a moment', { timeout: 300_000 }, async (t) => {
  const { root, lock, publish } = await preparedStory(t);
  const stop = lockHolder(lock, { holdMs: 150, everyMs: 400 });
  t.after(stop);
  const published = publish();
  await stop();
  assert.equal(published.status, 0, published.stderr);
  assert.equal(git(root, 'status', '--porcelain'), '', 'nothing looks changed after publishing');
});

test('a Story publish that outlasts the wait is repaired by sync: pushed, and nothing left looking changed', { timeout: 300_000 }, async (t) => {
  const { root, lock, sflow, publish } = await preparedStory(t);
  const stop = lockHolder(lock);
  t.after(stop);
  const before = git(root, 'rev-parse', 'HEAD');
  const published = publish({ SINGULARITY_FLOW_GIT_INDEX_LOCK_WAIT_MS: '300' });
  await stop();
  assert.notEqual(published.status, 0);
  assert.match(published.stderr + published.stdout, /Singularity Flow waited [\d.]+ s for .*index\.lock/u);
  const commit = git(root, 'rev-parse', 'HEAD');
  assert.notEqual(commit, before, 'the branch had advanced');
  assert.notEqual(git(root, 'status', '--porcelain'), '', 'the published files looked changed');
  const synced = sflow(['sync']);
  assert.equal(synced.status, 0, synced.stderr);
  assert.equal(git(root, 'status', '--porcelain'), '', 'sync refreshed the published index entries');
  assert.match(git(root, 'ls-remote', 'origin'), new RegExp(commit));
});
