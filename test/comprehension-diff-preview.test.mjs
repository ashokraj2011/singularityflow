import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { buildComprehensionDiffPreview } from '../src/comprehension/diff-preview.mjs';
import { buildRepositoryChangeSet } from '../src/repository-change-set.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-cmp-diff-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'CMP Diff');
  git(root, 'config', 'user.email', 'cmp-diff@example.com');
  await writeFile(path.join(root, 'tracked.txt'), 'before\nshared\n');
  git(root, 'add', 'tracked.txt');
  git(root, 'commit', '-m', 'baseline');
  return root;
}

test('the leased diff preview is exact, bounded, and excludes untracked bodies', async () => {
  const root = await repository();
  await writeFile(path.join(root, 'tracked.txt'), 'after\nshared\n');
  await writeFile(path.join(root, 'untracked-secret.txt'), 'never copied into the preview\n');
  const changeSet = await buildRepositoryChangeSet(root, { baseCommit: 'HEAD' });

  const preview = buildComprehensionDiffPreview(root, changeSet);
  assert.equal(preview.status, 'available');
  assert.equal(preview.authoritative, false);
  assert.equal(preview.lifecycleGate, false);
  assert.equal(preview.changeSetSha256, changeSet.digest);
  assert.equal(preview.trackedRegions, 1);
  assert.equal(preview.omittedUntrackedRegions, 1);
  assert.match(preview.patch, /-before\n\+after/);
  assert.doesNotMatch(preview.patch, /never copied into the preview/);
  assert.match(preview.patchSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(Buffer.byteLength(preview.patch, 'utf8'), preview.bytes);
  assert.equal(preview.fileProjectionStatus, 'available');
  assert.equal(preview.files.length, 1);
  assert.equal(preview.files[0].pathAfter, 'tracked.txt');
  assert.equal(preview.files[0].sourceChangeId, changeSet.entries.find((entry) => !entry.untracked).changeId);
  assert.equal(preview.patch.slice(preview.files[0].patchStart, preview.files[0].patchEnd), preview.patch,
    'file sections are offsets into the one bounded patch rather than duplicate source payloads');
  assert.equal(preview.files[0].hunks.length, 1);
  assert.deepEqual(preview.files[0].hunks[0], {
    header: '@@ -1,2 +1,2 @@', beforeStart: 1, beforeLines: 2, afterStart: 1, afterLines: 2
  });
});

test('an oversized patch degrades without returning partial source bytes', async () => {
  const root = await repository();
  await writeFile(path.join(root, 'tracked.txt'), `${'changed line\n'.repeat(100)}`);
  const changeSet = await buildRepositoryChangeSet(root, { baseCommit: 'HEAD' });

  const preview = buildComprehensionDiffPreview(root, changeSet, { maximumBytes: 64 });
  assert.equal(preview.status, 'unavailable');
  assert.equal(preview.reason, 'preview-output-limit');
  assert.equal(preview.patch, null);
  assert.equal(preview.patchSha256, null);
  assert.equal(preview.bytes, 0);
  assert.equal(preview.files.length, 0);
  assert.equal(preview.fileProjectionStatus, 'unavailable');
});

test('an untracked-only interval names the privacy boundary without reading file content', async () => {
  const root = await repository();
  await writeFile(path.join(root, 'untracked.txt'), 'local only\n');
  const changeSet = await buildRepositoryChangeSet(root, { baseCommit: 'HEAD' });

  const preview = buildComprehensionDiffPreview(root, changeSet);
  assert.equal(preview.status, 'unavailable');
  assert.equal(preview.reason, 'untracked-content-not-projected');
  assert.equal(preview.omittedUntrackedRegions, 1);
  assert.equal(preview.patch, null);
  assert.equal(preview.fileProjectionStatus, 'not-applicable');
  assert.deepEqual(preview.files, []);
});

test('one Git process indexes multiple tracked file sections in change-set order', async () => {
  const root = await repository();
  await writeFile(path.join(root, 'alpha.txt'), 'before alpha\n');
  await writeFile(path.join(root, 'zeta.txt'), 'before zeta\n');
  git(root, 'add', 'alpha.txt', 'zeta.txt');
  git(root, 'commit', '-m', 'add indexed files');
  await writeFile(path.join(root, 'alpha.txt'), 'after alpha\n');
  await writeFile(path.join(root, 'zeta.txt'), 'after zeta\n');
  const changeSet = await buildRepositoryChangeSet(root, { baseCommit: 'HEAD' });

  const preview = buildComprehensionDiffPreview(root, changeSet);
  assert.equal(preview.fileProjectionStatus, 'available');
  assert.deepEqual(preview.files.map((file) => file.pathAfter), ['alpha.txt', 'zeta.txt']);
  for (const file of preview.files) {
    const section = preview.patch.slice(file.patchStart, file.patchEnd);
    assert.match(section, new RegExp(`after ${path.basename(file.pathAfter, '.txt')}`));
    assert.equal(Buffer.byteLength(section, 'utf8'), file.bytes);
    assert.match(file.patchSha256, /^sha256:[a-f0-9]{64}$/u);
  }
  assert.equal(preview.files[0].patchEnd, preview.files[1].patchStart);
});

test('file-section identity remains exact for repository paths containing spaces', async () => {
  const root = await repository();
  await writeFile(path.join(root, 'path with space.txt'), 'before space\n');
  git(root, 'add', 'path with space.txt');
  git(root, 'commit', '-m', 'add spaced path');
  await writeFile(path.join(root, 'path with space.txt'), 'after space\n');
  const changeSet = await buildRepositoryChangeSet(root, { baseCommit: 'HEAD' });

  const preview = buildComprehensionDiffPreview(root, changeSet);
  assert.equal(preview.fileProjectionStatus, 'available');
  assert.equal(preview.files[0].pathAfter, 'path with space.txt');
  const section = preview.patch.slice(preview.files[0].patchStart, preview.files[0].patchEnd);
  assert.match(section, /^diff --git a\/path with space\.txt b\/path with space\.txt/mu);
});
