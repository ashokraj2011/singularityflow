/**
 * Repository-wide caches must resolve to storage that exists in every checkout of a repository.
 *
 * `<root>/.git/...` is a directory only in a main checkout. In a linked worktree — every Story
 * worktree — `.git` is a pointer file, so writes beneath it failed with ENOTDIR and the GitHub-account
 * cache never hit there: each command run in a Story worktree repeated `gh api user`.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { repositoryGitDirectory, repositoryGitPath } from '../src/git-directory.mjs';
import { GITHUB_LOOKUP, identity } from '../src/git.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function repositoryWithWorktree() {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-git-directory-')));
  const root = path.join(parent, 'main');
  await mkdir(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Worktree Reader');
  git(root, 'config', 'user.email', 'worktree@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# Worktrees\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'initial');
  const worktree = path.join(parent, 'story-worktree');
  git(root, 'worktree', 'add', '-q', '-b', 'story', worktree);
  return { parent, root, worktree };
}

test('a main checkout keeps its own .git directory', async () => {
  const { root } = await repositoryWithWorktree();
  assert.equal(repositoryGitDirectory(root), path.join(root, '.git'));
  assert.equal(repositoryGitPath(root, 'singularity-flow', 'x.json'),
    path.join(root, '.git', 'singularity-flow', 'x.json'));
});

test('a linked worktree resolves to the storage Git itself calls common', async () => {
  const { root, worktree } = await repositoryWithWorktree();
  assert.equal(repositoryGitDirectory(worktree), path.join(root, '.git'));
  assert.equal(repositoryGitDirectory(worktree),
    path.resolve(worktree, git(worktree, 'rev-parse', '--git-common-dir')));
});

test('a pointer without commondir is its own complete Git directory, as for a submodule', async () => {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-git-directory-module-')));
  const modules = path.join(parent, 'super', '.git', 'modules', 'child');
  await mkdir(modules, { recursive: true });
  const child = path.join(parent, 'super', 'child');
  await mkdir(child, { recursive: true });
  await writeFile(path.join(child, '.git'), 'gitdir: ../.git/modules/child\n');
  assert.equal(repositoryGitDirectory(child), modules);
});

test('anything unrecognisable is null and the path falls back to <root>/.git', async () => {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-git-directory-none-')));
  assert.equal(repositoryGitDirectory(parent), null);
  assert.equal(repositoryGitPath(parent, 'a'), path.join(parent, '.git', 'a'));
  await writeFile(path.join(parent, '.git'), 'not a pointer\n');
  assert.equal(repositoryGitDirectory(parent), null);
});

test('a Story worktree reuses the repository GitHub account instead of asking gh again', {
  skip: process.platform === 'win32'
}, async () => {
  const { parent, root, worktree } = await repositoryWithWorktree();
  const bin = path.join(parent, 'bin');
  const calls = path.join(parent, 'gh-calls');
  await mkdir(bin);
  await writeFile(path.join(bin, 'gh'), `#!/bin/sh
echo call >> ${JSON.stringify(calls)}
printf '%s\\n' '{"login":"octocat","name":"The Octocat"}'
`);
  await chmod(path.join(bin, 'gh'), 0o755);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  delete env.SINGULARITY_FLOW_NO_NETWORK;
  delete env.SINGULARITY_FLOW_TEST_IDENTITY;

  const first = identity(worktree, { env });
  assert.equal(first.login, 'octocat');
  const second = identity(worktree, { env });
  assert.equal(second.login, 'octocat');
  assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, 1,
    'the second lookup in the same worktree must be answered from the cache');

  // The main checkout and every other worktree share the one answer.
  const main = identity(root, { env: { ...env, PATH: process.env.PATH }, offline: true });
  assert.equal(main.login, 'octocat');
  assert.equal(main.githubLookup, GITHUB_LOOKUP.RESOLVED);
  const cached = JSON.parse(await readFile(
    path.join(root, '.git', 'singularity-flow', 'github-account.json'), 'utf8'));
  assert.equal(JSON.parse(cached.stdout).login, 'octocat');
});
