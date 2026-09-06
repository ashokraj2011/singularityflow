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
});
