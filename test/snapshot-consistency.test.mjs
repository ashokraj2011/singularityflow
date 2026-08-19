/**
 * A read and a governed write need different answers to "the repository moved".
 *
 * `SnapshotCoordinator` hashes the whole worktree — both diffs plus the full contents of every
 * untracked file — before and after the load, and refused outright if a single byte changed. That is
 * correct for `action execute`, which re-verifies branch, HEAD, worktree and lifecycle before it
 * commits; a commit built on a tree that has since moved is the thing the kernel exists to prevent.
 *
 * The same rule was applied to reads, which write nothing. So an autosave landing mid-read, or a
 * phase writing its own artifacts, emptied every view in the extension at once — and since the only
 * automatic retry watched `singularity/**` , a disturbance from anywhere else left the sidebar dead
 * until someone clicked refresh.
 *
 * These tests pin both halves: `exact` still refuses, `best-effort` answers and says what it is.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { CONSISTENCY_MODES, SnapshotCoordinator } from '../src/snapshot-coordinator.mjs';
import { withReadScope } from '../src/read-scope.mjs';

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-consistency-'));
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Consistency Tester');
  git('config', 'user.email', 'consistency@example.com');
  await writeFile(path.join(root, 'tracked.txt'), 'original\n');
  git('add', '-A');
  git('commit', '-m', 'fixture');
  return root;
}

// Every disturbance must be genuinely new content. Writing the same bytes twice leaves the worktree
// hash where it was — which is correct, and quietly turns a test of the disturbed path into a test
// of the undisturbed one.
let writes = 0;

/** A loader that disturbs the tree on its first `n` calls, the way a background writer would. */
function disturbingLoader(root, disturbances) {
  let call = 0;
  return async () => {
    call += 1;
    if (call <= disturbances) {
      writes += 1;
      await writeFile(path.join(root, `scratch-${writes}.txt`), `disturbance ${writes}\n`);
    }
    return { lifecycle: { id: 'KERNEL-1', call } };
  };
}

test('a governed write still refuses a tree that moved underneath it', async () => {
  const root = await repository();
  const coordinator = new SnapshotCoordinator(root);
  // The default, and what `action execute` relies on. This must never quietly relax.
  await assert.rejects(
    () => coordinator.capture(disturbingLoader(root, 1), { included: ['lifecycle'] }),
    /Repository state changed/
  );
  await assert.rejects(
    () => coordinator.capture(disturbingLoader(root, 1), { included: ['lifecycle'], consistency: 'exact' }),
    /Repository state changed/
  );
});

test('a read cache never hides changed bytes from the coordinator boundary', async () => {
  const root = await repository();
  await assert.rejects(
    () => withReadScope(() => new SnapshotCoordinator(root).capture(
      disturbingLoader(root, 1), { included: ['lifecycle'], consistency: 'exact' }
    )),
    /Repository state changed/
  );
});

test('a read reloads once and answers, with no warning to show for it', async () => {
  const root = await repository();
  const result = await new SnapshotCoordinator(root).capture(
    disturbingLoader(root, 1),
    { included: ['lifecycle'], consistency: 'best-effort' }
  );
  // The second load ran against the settled tree, so this is a clean, coherent snapshot.
  assert.equal(result.lifecycle.call, 2);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.notModified, false);
});

test('a repository under continuous write still answers, and says the answer is behind', async () => {
  const root = await repository();
  const result = await new SnapshotCoordinator(root).capture(
    disturbingLoader(root, 5),
    { included: ['lifecycle'], consistency: 'best-effort' }
  );
  // A running phase writes throughout. A slightly stale lifecycle is worth far more than none.
  assert.equal(result.lifecycle.call, 2, 'exactly one reload, never a spin');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /describes the moment the read started/);
});

test('the recorded revision is the moment the surviving load started from', async () => {
  const root = await repository();
  const coordinator = new SnapshotCoordinator(root);
  const settled = await coordinator.capture(async () => ({ lifecycle: {} }), { included: ['lifecycle'] });

  const disturbed = await coordinator.capture(
    disturbingLoader(root, 5),
    { included: ['lifecycle'], consistency: 'best-effort' }
  );
  // Never the pre-disturbance hash, and never a hash the value cannot claim: reporting "current"
  // for a tree that has since moved would tell the next refresh it is already up to date.
  assert.notEqual(disturbed.revision.worktreeHash, settled.revision.worktreeHash);
  assert.equal(disturbed.revision.branch, 'main');
  assert.ok(disturbed.revision.head);
});

test('a loader’s own warnings survive alongside the coordinator’s', async () => {
  const root = await repository();
  const result = await new SnapshotCoordinator(root).capture(
    async () => {
      writes += 1;
      await writeFile(path.join(root, 'always.txt'), `still writing ${writes}\n`);
      return { lifecycle: {}, warnings: ['a slice said something'] };
    },
    { included: ['lifecycle'], consistency: 'best-effort' }
  );
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0], /describes the moment the read started/);
  assert.equal(result.warnings[1], 'a slice said something');
});

test('an unknown consistency mode is refused rather than silently treated as exact', async () => {
  const root = await repository();
  await assert.rejects(
    () => new SnapshotCoordinator(root).capture(async () => ({}), { consistency: 'relaxed' }),
    /must be one of/
  );
  assert.deepEqual([...CONSISTENCY_MODES], ['exact', 'best-effort']);
});

test('an undisturbed read is byte-identical whichever mode asked for it', async () => {
  const root = await repository();
  const coordinator = new SnapshotCoordinator(root);
  const load = async () => ({ lifecycle: { id: 'KERNEL-1' } });
  const strict = await coordinator.capture(load, { included: ['lifecycle'] });
  const relaxed = await coordinator.capture(load, { included: ['lifecycle'], consistency: 'best-effort' });
  // The new mode changes what happens when the tree moves and nothing else.
  assert.deepEqual(relaxed, strict);
});
