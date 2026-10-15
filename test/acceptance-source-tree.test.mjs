/**
 * The governance gate hashes the repository's source only when an acceptance run is recorded.
 * `[perf]`
 *
 * The hash reads the content of every file. Measured on a 10,000-file repository it took 1.1-1.8 s,
 * and it ran on every phase entry, submit and approval of a Story whose specification policy checks
 * acceptance, though without a recorded run the hash was compared with nothing.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { acceptanceSourceTree } from '../src/governance.mjs';
import { specificationSourceTreeHash } from '../src/specifications.mjs';

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function repository(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-acceptance-tree-')));
  t.after(async () => {
    await chmod(path.join(root, 'locked.txt'), 0o644).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Acceptance Tree Tester']);
  git(root, ['config', 'user.email', 'acceptance@example.invalid']);
  await writeFile(path.join(root, 'app.js'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'locked.txt'), 'content\n');
  git(root, ['add', '.']);
  git(root, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'first']);
  return root;
}

const run = { id: 'run-1', status: 'passed' };

test('without a recorded acceptance run the source is not read; with one it is hashed exactly', async (t) => {
  const root = await repository(t);
  assert.equal(await acceptanceSourceTree(root, { acceptance: [run] }, null),
    await specificationSourceTreeHash(root, null), 'a recorded run is compared with the same hash as before');
  if (process.getuid?.() !== 0) {
    // An unreadable file proves the content is not read: hashing it fails.
    await chmod(path.join(root, 'locked.txt'), 0o000);
    await assert.rejects(() => specificationSourceTreeHash(root, null));
    assert.equal(await acceptanceSourceTree(root, { acceptance: [] }, null), null);
    assert.equal(await acceptanceSourceTree(root, {}, null), null);
  }
});

test('hidden worktree changes are refused with or without a recorded run', async (t) => {
  const root = await repository(t);
  git(root, ['update-index', '--skip-worktree', 'app.js']);
  await writeFile(path.join(root, 'app.js'), 'export const value = 2;\n');
  for (const records of [{ acceptance: [] }, { acceptance: [run] }]) {
    await assert.rejects(() => acceptanceSourceTree(root, records, null), /hidden|skip-worktree|assume-unchanged/iu);
  }
});
