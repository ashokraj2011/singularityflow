/** Exact Source Snapshots read blob bytes in bounded batches and reuse content-addressed digests. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { commandTimer, withCommandTiming } from '../src/dx-command-timing.mjs';
import {
  createExactSourceSnapshot, createExactSourceSnapshotAtRevision
} from '../src/world-model/source/snapshot.mjs';
import { run } from '../src/util.mjs';

function git(root, args) {
  return run('git', args, { cwd: root }).stdout.trim();
}

async function repository(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wm-batched-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Source Batch']);
  git(root, ['config', 'user.email', 'source-batch@example.com']);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'source']);
  return root;
}

async function counted(label, action) {
  const timer = commandTimer(label, { commandClass: 'read' });
  const value = await withCommandTiming(timer, async () => action());
  return { value, spawns: timer.finish().counters['git.spawns'] ?? 0 };
}

test('an exact Source Snapshot does not spawn Git per file, and a rebuild reuses its digests', async (t) => {
  const files = {};
  for (let index = 0; index < 60; index += 1) files[`src/module-${index}.mjs`] = `export const value${index} = ${index};\n`;
  files['docs/empty.txt'] = '';
  files['assets/binary.bin'] = Buffer.from([0, 1, 2, 255]);
  const root = await repository(t, files);

  const first = await counted('source-snapshot-first', () => createExactSourceSnapshot(root, { subjectId: 'fixture' }));
  const second = await counted('source-snapshot-second', () => createExactSourceSnapshot(root, { subjectId: 'fixture' }));
  assert.ok(first.spawns < 20, `the first snapshot spawned ${first.spawns} processes for 62 files`);
  assert.ok(second.spawns <= first.spawns - 2, 'a rebuild does not read blob bytes again');
  assert.deepEqual(second.value, first.value);

  // Every digest is the SHA-256 and length of the committed bytes, exactly as before.
  for (const file of first.value.files) {
    const bytes = Buffer.from(files[file.path]);
    assert.equal(file.contentSha256, `sha256:${createHash('sha256').update(bytes).digest('hex')}`, file.path);
    assert.equal(file.bytes, bytes.length, file.path);
  }
  const historical = createExactSourceSnapshotAtRevision(root, git(root, ['rev-parse', 'HEAD']), { subjectId: 'fixture' });
  assert.deepEqual(historical.files, first.value.files);
});

test('a blob that is not in the local object store is still the typed unavailable refusal', async (t) => {
  const root = await repository(t, { 'src/a.mjs': 'export const a = 1;\n', 'src/b.mjs': 'export const b = 2;\n' });
  const commit = git(root, ['rev-parse', 'HEAD']);
  const blob = git(root, ['rev-parse', `${commit}:src/b.mjs`]);
  // Remove the loose object so the tree names a blob the object store no longer has.
  await rm(path.join(root, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  assert.throws(
    () => createExactSourceSnapshotAtRevision(root, commit, { subjectId: 'fixture' }),
    (error) => error?.code === 'WMB_SOURCE_OBJECT_UNAVAILABLE'
  );
});
