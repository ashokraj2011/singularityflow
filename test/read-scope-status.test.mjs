/**
 * Working-tree status is asked once per read scope, and never handed to a read that must be fresh.
 * `[perf]`
 *
 * A full snapshot ran `git status --untracked-files=all` three times; on a large Windows checkout
 * each one scans every file. A read scope is a claim that the operation does not write, so inside
 * one the first answer serves the rest. Outside a scope, where writers live, every call asks Git.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { changedFiles, changes, hasUpstream } from '../src/git.mjs';
import { withFreshReadScope, withReadScope } from '../src/read-scope.mjs';
import { buildRepositorySubjectIndex } from '../src/repository-subject-index.mjs';
import { SnapshotCoordinator } from '../src/snapshot-coordinator.mjs';

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function repository(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-scope-status-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Scope Tester']);
  git(root, ['config', 'user.email', 'scope@example.invalid']);
  await writeFile(path.join(root, 'README.md'), 'first\n');
  git(root, ['add', 'README.md']);
  git(root, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'first']);
  return root;
}

test('status and upstream are asked once inside a read scope and every time outside one', async (t) => {
  const root = await repository(t);
  assert.equal(changes(root), '');
  await writeFile(path.join(root, 'outside.txt'), 'x\n');
  assert.match(changes(root), /outside\.txt/u, 'no scope: a writer sees its own change at once');

  await withReadScope(async () => {
    const first = changes(root);
    assert.equal(hasUpstream(root), false);
    await writeFile(path.join(root, 'inside.txt'), 'y\n');
    // A branch cannot track itself; it tracks another local branch here.
    git(root, ['branch', 'base']);
    git(root, ['branch', '--set-upstream-to=base', 'main']);
    assert.equal(changes(root), first, 'one answer for the whole read');
    assert.equal(hasUpstream(root), false);
    await withFreshReadScope(async () => {
      assert.match(changes(root), /inside\.txt/u, 'a fresh scope asks Git again');
      assert.equal(hasUpstream(root), true);
    });
  });
  assert.match(changes(root), /inside\.txt/u, 'the scope is gone once the read returns');
});

test('a snapshot that reloads because the tree moved reads the status afresh', async (t) => {
  const root = await repository(t);
  const coordinator = new SnapshotCoordinator(root);
  const seen = [];
  const result = await withReadScope(() => coordinator.capture(async () => {
    const status = changes(root);
    seen.push(status);
    // The first load is disturbed by an edit landing mid-read, which moves the revision.
    if (seen.length === 1) await writeFile(path.join(root, 'landed.txt'), 'z\n');
    return { status };
  }, { consistency: 'best-effort' }));
  assert.equal(seen.length, 2, 'the moved revision caused one reload');
  assert.equal(seen[0], '');
  assert.match(result.value?.status ?? result.status, /landed\.txt/u, 'the reload did not reuse the first load\'s status');
});

test('changed files and the working-tree Story index are computed once per read scope', async (t) => {
  const root = await repository(t);
  const definition = { workItemRoot: 'singularity/work-items' };
  await withReadScope(async () => {
    const files = changedFiles(root);
    const index = await buildRepositorySubjectIndex(root, { definition });
    await writeFile(path.join(root, 'late.txt'), 'late\n');
    assert.deepEqual(changedFiles(root), files, 'one answer for the whole read');
    assert.equal(await buildRepositorySubjectIndex(root, { definition }), index, 'one scan shared by every slice');
    assert.notEqual(await buildRepositorySubjectIndex(root, { definition: { workItemRoot: 'other/root' } }), index,
      'another Story root is another scan');
    await withFreshReadScope(async () => assert.ok(changedFiles(root).includes('late.txt')));
  });
  // Outside a scope, where writers live, every call asks again.
  assert.ok(changedFiles(root).includes('late.txt'));
  assert.notEqual(await buildRepositorySubjectIndex(root, { definition }), await buildRepositorySubjectIndex(root, { definition }));
});
