import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { storyIndexDrift } from '../src/git.mjs';

test('batched operation-marker lookup preserves normal and linked-worktree drift guards', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-bookkeeping-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo with spaces'), linked = path.join(base, 'linked');
  const env = { ...process.env, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Fixture',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'fixture@example.invalid' };
  const git = (root, ...args) => {
    const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git(base, 'init', '-q', '-b', 'main', repo);
  const relative = 'singularity/work-items/PERF-1/workflow.json';
  await mkdir(path.dirname(path.join(repo, relative)), { recursive: true });
  await writeFile(path.join(repo, relative), '{"generation":0}\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'before');
  await writeFile(path.join(repo, relative), '{"generation":1}\n');
  git(repo, 'commit', '-qam', 'after');
  git(repo, 'worktree', 'add', '-q', '-b', 'PERF-1', linked);
  for (const root of [repo, linked]) {
    git(root, 'read-tree', 'HEAD^');
    assert.deepEqual(storyIndexDrift(root, 'singularity/work-items/PERF-1'), [relative]);
    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
      const absolute = path.resolve(root, git(root, 'rev-parse', '--git-path', marker));
      if (marker.startsWith('rebase-')) await mkdir(absolute); else await writeFile(absolute, git(root, 'rev-parse', 'HEAD'));
      assert.deepEqual(storyIndexDrift(root, 'singularity/work-items/PERF-1'), [], `${root}: ${marker}`);
      await rm(absolute, { recursive: marker.startsWith('rebase-') });
      assert.deepEqual(storyIndexDrift(root, 'singularity/work-items/PERF-1'), [relative]);
    }
  }
});
