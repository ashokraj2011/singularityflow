import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { branch, gitCommonDir, gitDir, head, repoRoot, resetGitDirCache } from '../src/git-execution.mjs';
import { commandTimer, withCommandTiming } from '../src/dx-command-timing.mjs';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function fixture(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-path-batch-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'repository with spaces'); await mkdir(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Batch Tester'); git(root, 'config', 'user.email', 'batch@example.invalid');
  await writeFile(path.join(root, 'README.md'), 'preserved\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'fixture');
  return { parent, root };
}
async function observe(action) {
  const previous = process.env.SINGULARITY_FLOW_GIT_FACT_CACHE;
  process.env.SINGULARITY_FLOW_GIT_FACT_CACHE = 'off';
  resetGitDirCache();
  try {
    const timer = commandTimer('batch-test', { commandClass: 'read' });
    const value = await withCommandTiming(timer, action);
    return { value, counters: timer.finish().counters };
  } finally {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_GIT_FACT_CACHE;
    else process.env.SINGULARITY_FLOW_GIT_FACT_CACHE = previous;
    resetGitDirCache();
  }
}
test('root discovery fills both Git directory answers in one physical process', async t => {
  const { root } = await fixture(t), nested = path.join(root, 'nested'); await mkdir(nested);
  const index = await readFile(path.join(root, '.git/index'));
  const result = await observe(() => {
    const found = repoRoot(nested);
    assert.equal(found, git(root, 'rev-parse', '--show-toplevel'));
    assert.equal(gitDir(found), git(root, 'rev-parse', '--absolute-git-dir'));
    assert.equal(gitCommonDir(found), git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
    return found;
  });
  assert.equal(result.counters['git.spawns'], 1);
  assert.deepEqual(await readFile(path.join(root, '.git/index')), index);
});
test('directory-only batching preserves linked-worktree and bare-repository identity', async t => {
  const { parent, root } = await fixture(t), linked = path.join(parent, 'linked'), bare = path.join(parent, 'bare.git');
  git(root, 'worktree', 'add', '-q', '-b', 'story', linked);
  git(root, 'clone', '-q', '--bare', root, bare);
  for (const selected of [linked, bare]) {
    const result = await observe(() => [gitDir(selected), gitCommonDir(selected)]);
    assert.equal(result.counters['git.spawns'], 1);
    assert.deepEqual(result.value, [git(selected, 'rev-parse', '--absolute-git-dir'),
      git(selected, 'rev-parse', '--path-format=absolute', '--git-common-dir')]);
  }
  const before = head(linked); git(linked, 'switch', '-qc', 'another');
  assert.equal(branch(linked), 'another');
  assert.equal(head(linked), before, 'directory caching never caches a branch or HEAD');
});
test('resetting path caches also discards the old common-directory answer', async t => {
  const { parent, root } = await fixture(t), linked = path.join(parent, 'replaced');
  git(root, 'worktree', 'add', '-q', '-b', 'replaced', linked);
  const old = gitCommonDir(linked);
  git(root, 'worktree', 'remove', linked); await mkdir(linked);
  git(linked, 'init', '-q');
  resetGitDirCache();
  assert.notEqual(gitCommonDir(linked), old);
  assert.equal(gitCommonDir(linked), git(linked, 'rev-parse', '--absolute-git-dir'));
});
