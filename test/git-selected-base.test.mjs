import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fetchRemote, localRefHeads } from '../src/git.mjs';
import { commandTimer, withCommandTiming } from '../src/dx-command-timing.mjs';
import { prepareStoryWorktree } from '../src/story-worktree.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-selected-base-'));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const source = path.join(base, 'source');
  await mkdir(source);
  git(source, 'init', '-q', '-b', 'main');
  git(source, 'config', 'user.name', 'Base Fixture');
  git(source, 'config', 'user.email', 'base@example.test');
  await writeFile(path.join(source, 'README.md'), '# Base fixture\n');
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'base');
  const remote = path.join(base, 'origin.git');
  git(base, 'clone', '-q', '--bare', source, remote);
  const clone = path.join(base, 'clone');
  git(base, 'clone', '-q', '--no-local', '--single-branch', remote, clone);
  return { base, source, remote, clone };
}

test('selected-base fetch leaves other refs, custom tracking, HEAD, index and local edits untouched', async (t) => {
  const { source, remote, clone } = await fixture(t);
  const initial = git(clone, 'rev-parse', 'HEAD');
  git(clone, 'update-ref', 'refs/remotes/origin/retained', initial);
  git(clone, 'config', '--add', 'remote.origin.fetch', '+refs/heads/release/*:refs/remotes/origin/releases/*');
  const fetchPolicy = git(clone, 'config', '--get-all', 'remote.origin.fetch');
  git(source, 'switch', '-q', '-c', 'selected/base');
  await writeFile(path.join(source, 'selected.txt'), 'selected revision\n');
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'advance selected base');
  const selected = git(source, 'rev-parse', 'HEAD');
  git(source, 'push', '-q', remote, 'selected/base');
  git(source, 'switch', '-q', '-c', 'unrelated');
  git(source, 'commit', '-q', '--allow-empty', '-m', 'unrelated');
  git(source, 'push', '-q', remote, 'unrelated');
  await writeFile(path.join(clone, 'README.md'), '# Keep my edits\n');
  const index = await readFile(path.join(clone, '.git/index'));
  await fetchRemote(clone, 'origin', { branches: ['selected/base'], transportRemote: remote });
  assert.equal(git(clone, 'rev-parse', 'refs/remotes/origin/selected/base'), selected);
  assert.equal(localRefHeads(clone, ['refs/remotes/origin/unrelated']).size, 0);
  assert.equal(git(clone, 'rev-parse', 'refs/remotes/origin/retained'), initial);
  assert.equal(git(clone, 'rev-parse', 'HEAD'), initial);
  assert.equal(git(clone, 'config', '--get-all', 'remote.origin.fetch'), fetchPolicy);
  assert.deepEqual(await readFile(path.join(clone, '.git/index')), index);
  assert.equal(await readFile(path.join(clone, 'README.md'), 'utf8'), '# Keep my edits\n');
  await assert.rejects(() => fetchRemote(clone, 'origin', { branches: ['--all'] }),
    { code: 'GIT_REMOTE_BRANCH_INVALID' });
  await assert.rejects(() => fetchRemote(clone, 'origin', { branches: [] }),
    { code: 'GIT_REMOTE_BRANCH_INVALID' });
  await assert.rejects(() => fetchRemote(clone, 'origin', { branches: 'main' }),
    { code: 'GIT_REMOTE_BRANCH_INVALID' });
  git(clone, 'remote', 'set-url', 'origin', `${remote}.different`);
  await assert.rejects(() => fetchRemote(clone, 'origin', {
    branches: ['selected/base'], transportRemote: remote
  }), { code: 'GIT_REMOTE_AUTHORITY_CHANGED' });
});

test('local intake refs use one live read and do not credit descendants or reuse mutable tips', async (t) => {
  const { source } = await fixture(t);
  const initial = git(source, 'rev-parse', 'HEAD');
  git(source, 'branch', 'story/child');
  const timer = commandTimer('intake-refs', { commandClass: 'read' });
  const observed = await withCommandTiming(timer, () => localRefHeads(source,
    ['refs/heads/main', 'refs/heads/story', 'refs/remotes/origin/main']));
  assert.deepEqual([...observed], [['refs/heads/main', initial]]);
  assert.equal(timer.finish().counters['git.spawns'], 1);
  git(source, 'commit', '-q', '--allow-empty', '-m', 'changed tip');
  assert.notEqual(localRefHeads(source, ['refs/heads/main']).get('refs/heads/main'), initial);
  for (const refs of [[], ['--all'], ['refs/heads/*'], ['refs/heads/main\nother'], ['refs/heads/../main']]) {
    assert.throws(() => localRefHeads(source, refs), { code: 'GIT_REF_SELECTION_INVALID' });
  }
});

test('a Story worktree reuses the workspace sparse checkout instead of expanding the monorepo', async (t) => {
  const { source } = await fixture(t);
  for (const folder of ['selected', 'excluded']) {
    await mkdir(path.join(source, folder));
    await writeFile(path.join(source, folder, 'code.txt'), `${folder}\n`);
  }
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'monorepo paths');
  git(source, 'sparse-checkout', 'set', 'selected');
  const prepared = await prepareStoryWorktree(source, 'SPARSE-STORY', { base: 'HEAD' });
  assert.equal(git(prepared.repositoryPath, 'sparse-checkout', 'list'), 'selected');
  assert.equal(await readFile(path.join(prepared.repositoryPath, 'selected/code.txt'), 'utf8'), 'selected\n');
  await assert.rejects(readFile(path.join(prepared.repositoryPath, 'excluded/code.txt')), { code: 'ENOENT' });
});
