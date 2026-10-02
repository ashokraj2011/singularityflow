import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gitCommonDir } from '../src/git.mjs';
import { preparedStoryWorktreePath, prepareStoryWorktree, storyWorktreePath } from '../src/story-worktree.mjs';

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-prepared-readonly-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'repository'); await mkdir(root);
  git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.name', 'Worktree Test'); git(root, 'config', 'user.email', 'worktree@example.invalid');
  await writeFile(path.join(root, 'README.md'), 'exact base\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Exact base');
  return { root, parent, baseCommit: git(root, 'rev-parse', 'HEAD'), id: 'PREPARED-1' };
}

test('prepared lookup returns null without creating paths, branches, or a checkout', async t => {
  const { root, parent, id, baseCommit } = await fixture(t);
  const inventory = git(root, 'worktree', 'list', '--porcelain'); const refs = git(root, 'show-ref');
  assert.equal(await preparedStoryWorktreePath(root, id, { baseCommit }), null);
  assert.equal(git(root, 'worktree', 'list', '--porcelain'), inventory); assert.equal(git(root, 'show-ref'), refs);
  await assert.rejects(() => lstat(path.join(parent, '.singularity-flow')), { code: 'ENOENT' });
  await assert.rejects(() => preparedStoryWorktreePath(root, id, { baseCommit: 'main' }), { code: 'STORY_WORKTREE_INVALID' });
});

test('prepared lookup verifies exact staging ownership and preserves dirty launch and target files', async t => {
  const { root, id, baseCommit } = await fixture(t);
  const prepared = await prepareStoryWorktree(root, id, { base: baseCommit });
  await writeFile(path.join(root, 'launch.txt'), 'preserve source work\n');
  await writeFile(path.join(prepared.repositoryPath, 'target.txt'), 'preserve target work\n');
  const before = git(root, 'worktree', 'list', '--porcelain');
  assert.equal(await preparedStoryWorktreePath(root, id, { baseCommit }), await realpath(prepared.repositoryPath));
  assert.equal(await preparedStoryWorktreePath(prepared.repositoryPath, id, { baseCommit }), await realpath(prepared.repositoryPath));
  assert.equal(git(root, 'worktree', 'list', '--porcelain'), before);
  assert.equal(await readFile(path.join(root, 'launch.txt'), 'utf8'), 'preserve source work\n');
  assert.equal(await readFile(path.join(prepared.repositoryPath, 'target.txt'), 'utf8'), 'preserve target work\n');
});

test('prepared lookup refuses an unrelated or already-created Story branch without switching it', async t => {
  const { root, id, baseCommit } = await fixture(t);
  const prepared = await prepareStoryWorktree(root, id, { base: baseCommit });
  git(prepared.repositoryPath, 'switch', '-q', '-c', id);
  await assert.rejects(() => preparedStoryWorktreePath(root, id, { baseCommit }), { code: 'STORY_WORKTREE_RECOVERY_REQUIRED' });
  assert.equal(git(prepared.repositoryPath, 'branch', '--show-current'), id);
});

test('prepared lookup refuses a moved baseline HEAD without resetting the worktree', async t => {
  const { root, id, baseCommit } = await fixture(t);
  const prepared = await prepareStoryWorktree(root, id, { base: baseCommit });
  git(prepared.repositoryPath, 'commit', '--allow-empty', '-qm', 'Moved launch head');
  const moved = git(prepared.repositoryPath, 'rev-parse', 'HEAD');
  await assert.rejects(() => preparedStoryWorktreePath(root, id, { baseCommit }), { code: 'STORY_WORKTREE_RECOVERY_REQUIRED' });
  assert.equal(git(prepared.repositoryPath, 'rev-parse', 'HEAD'), moved);
});

test('prepared lookup refuses a foreign common directory behind an old worktree registration', async t => {
  const { root, parent, id, baseCommit } = await fixture(t);
  const prepared = await prepareStoryWorktree(root, id, { base: baseCommit });
  // Warm the legacy process-global path cache, then make the foreign checkout's branch and
  // HEAD identical. Only a fresh common-directory check can reject this substitution.
  gitCommonDir(prepared.repositoryPath);
  await preparedStoryWorktreePath(root, id, { baseCommit });
  const foreign = path.join(parent, 'foreign');
  git(parent, 'clone', '-q', '--no-hardlinks', root, foreign);
  git(foreign, 'switch', '-q', '-c', prepared.stagingBranch);
  const pointer = path.join(prepared.repositoryPath, '.git'); const original = await readFile(pointer);
  await writeFile(pointer, `gitdir: ${path.join(foreign, '.git')}\n`);
  try {
    await assert.rejects(() => preparedStoryWorktreePath(root, id, { baseCommit }), /different Git common directory/u);
    assert.equal(await readFile(pointer, 'utf8'), `gitdir: ${path.join(foreign, '.git')}\n`);
  } finally { await writeFile(pointer, original); }
});

test('prepared lookup refuses an occupied unregistered managed path', async t => {
  const { root, id, baseCommit } = await fixture(t);
  const target = await storyWorktreePath(root, id); await mkdir(target, { recursive: true });
  await writeFile(path.join(target, 'keep.txt'), 'unowned bytes\n');
  await assert.rejects(() => preparedStoryWorktreePath(root, id, { baseCommit }), /without matching Git registration/u);
  assert.equal(await readFile(path.join(target, 'keep.txt'), 'utf8'), 'unowned bytes\n');
});

test('prepared lookup reuses the same registered legacy path as prepare without creating compact paths', async t => {
  const { root, id, baseCommit } = await fixture(t);
  const common = gitCommonDir(root); const canonical = await realpath(common);
  const compact = await storyWorktreePath(root, id);
  const legacy = path.join(path.dirname(compact), hash(common).slice(0, 12), id);
  const staging = `sflow-start-${hash(`${canonical}\0${id}`).slice(0, 16)}`;
  await mkdir(path.dirname(legacy), { recursive: true });
  git(root, 'worktree', 'add', '-q', '-b', staging, '--', legacy, baseCommit);
  assert.equal(await preparedStoryWorktreePath(root, id, { baseCommit }), await realpath(legacy));
  assert.equal((await prepareStoryWorktree(root, id, { base: baseCommit })).repositoryPath, await realpath(legacy));
  await assert.rejects(() => lstat(compact), { code: 'ENOENT' });
});
