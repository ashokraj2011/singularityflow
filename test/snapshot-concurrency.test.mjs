/**
 * A tree snapshot must not depend on how the reads were scheduled.
 *
 * A world-model build reads and hashes the whole repository four times before any model runs — one
 * source snapshot and three isolation-guard passes, each of which is load-bearing: the guards exist
 * because a builder that wrote outside its scratch space once passed discovery and failed synthesis
 * on the identical file twenty minutes later. So the passes stay and each one got faster instead.
 *
 * Reading concurrently is only safe if the digest is folded in sorted file order afterwards. Hashing
 * as results arrive would make the source-tree hash depend on disk timing, which would show up as
 * a model that is randomly "stale" — the exact false signal the exclusion rules above it exist to
 * prevent, and one that would be maddening to trace.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { repositoryContentSnapshot, worldModelSourceSnapshot } from '../src/grounding.mjs';
import { mapLimit } from '../src/util.mjs';

async function repository(fileCount) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-snapshot-'));
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Snapshot Tester');
  git('config', 'user.email', 'snapshot@example.com');
  for (let index = 0; index < fileCount; index += 1) {
    const directory = path.join(root, `group-${index % 5}`);
    await mkdir(directory, { recursive: true });
    // Varying sizes so reads finish out of order rather than uniformly.
    await writeFile(path.join(directory, `file-${index}.txt`), 'x'.repeat((index % 23) * 400 + 1));
  }
  git('add', '-A');
  git('commit', '-m', 'fixture');
  return root;
}

test('the source digest is the same every time, whatever order the reads complete in', async () => {
  const root = await repository(80);
  const runs = await Promise.all([1, 2, 3].map(() => worldModelSourceSnapshot(root, {})));
  assert.equal(new Set(runs.map((run) => run.sha256)).size, 1,
    'the source-tree hash changed between identical runs');
  assert.equal(new Set(runs.map((run) => run.files.length)).size, 1);
  // File order is part of the contract: the digest folds over it.
  const paths = runs.map((run) => run.files.map((file) => file.path).join('\n'));
  assert.equal(new Set(paths).size, 1, 'files came back in a different order');
  assert.deepEqual([...paths[0].split('\n')], [...paths[0].split('\n')].sort());
});

test('the content snapshot iterates identically across runs', async () => {
  const root = await repository(60);
  const first = await repositoryContentSnapshot(root);
  const second = await repositoryContentSnapshot(root);
  assert.deepEqual([...first.keys()], [...second.keys()]);
  assert.deepEqual([...first.entries()], [...second.entries()]);
});

test('mapLimit returns results in input order, not completion order', async () => {
  // The property the digest rests on. Deliberately makes early items slow.
  const order = await mapLimit([40, 30, 20, 10, 0], 4, async (delay, index) => {
    await new Promise((resolve) => { setTimeout(resolve, delay); });
    return index;
  });
  assert.deepEqual(order, [0, 1, 2, 3, 4]);
});

test('mapLimit runs concurrently rather than one at a time', async () => {
  let live = 0;
  let peak = 0;
  await mapLimit(Array.from({ length: 20 }), 5, async () => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    live -= 1;
  });
  assert.ok(peak > 1, 'nothing ran in parallel');
  assert.ok(peak <= 5, `concurrency limit exceeded: ${peak}`);
});

test('mapLimit copes with fewer items than its limit, and with none', async () => {
  assert.deepEqual(await mapLimit([1, 2], 16, async (value) => value * 2), [2, 4]);
  assert.deepEqual(await mapLimit([], 16, async () => 1), []);
});
