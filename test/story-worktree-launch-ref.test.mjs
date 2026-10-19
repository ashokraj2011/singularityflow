import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  prepareStoryWorktree, rollbackFailedStoryWorktree, rollbackStoryWorktree
} from '../src/story-worktree.mjs';
import { gitCommonDir } from '../src/git.mjs';
import { run, SingularityFlowError } from '../src/util.mjs';

function git(cwd, ...args) { return run('git', args, { cwd }).stdout.trim(); }
const refExists = (cwd, ref) => run('git', ['show-ref', '--verify', '--quiet', ref], { cwd, allowFailure: true }).status === 0;

/** A launch checkout whose remote base is newer than its own checked-out main. */
async function launch(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-launch-ref-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const remote = path.join(base, 'remote.git');
  const root = path.join(base, 'repository');
  const other = path.join(base, 'other');
  git(base, 'init', '--bare', '-q', '-b', 'main', remote);
  git(base, 'init', '-q', '-b', 'main', root);
  for (const cwd of [root]) {
    git(cwd, 'config', 'user.name', 'Launch Ref');
    git(cwd, 'config', 'user.email', 'launch-ref@example.invalid');
  }
  await writeFile(path.join(root, 'README.md'), '# launch ref\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'initial');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  git(base, 'clone', '-q', remote, other);
  git(other, 'config', 'user.name', 'Other');
  git(other, 'config', 'user.email', 'other@example.invalid');
  await writeFile(path.join(other, 'NEWER.md'), 'newer remote base\n');
  git(other, 'add', '.');
  git(other, 'commit', '-qm', 'newer base');
  git(other, 'push', '-q', 'origin', 'main');
  git(root, 'fetch', '-q', 'origin');
  return { root, newer: git(root, 'rev-parse', 'origin/main') };
}

async function stagingBranch(root, id) {
  const common = await realpath(gitCommonDir(root));
  return `sflow-start-${createHash('sha256').update(`${common}\0${id}`).digest('hex').slice(0, 16)}`;
}

test('rollback of a resumed launch removes its launch ref even when its base is newer than the checkout', async (t) => {
  const { root, newer } = await launch(t);
  const prepared = await prepareStoryWorktree(root, 'LAUNCH-1', { base: newer });
  assert.equal(prepared.created, true);
  const resumed = await prepareStoryWorktree(root, 'LAUNCH-1', { base: newer });
  assert.equal(resumed.created, false);
  assert.equal(resumed.initialHead, newer);

  const recovered = rollbackStoryWorktree(resumed);
  assert.equal(recovered.removed, true);
  assert.deepEqual(recovered.cleanupPending, []);
  assert.equal(refExists(root, `refs/heads/${resumed.stagingBranch}`), false);
  // The next start begins cleanly instead of naming an incomplete launch branch.
  const again = await prepareStoryWorktree(root, 'LAUNCH-1', { base: newer });
  assert.equal(again.created, true);
});

test('an orphaned launch ref is deleted only when another ref holds its commit', async (t) => {
  const { root, newer } = await launch(t);
  const held = await stagingBranch(root, 'LAUNCH-2');
  git(root, 'branch', held, newer);
  const prepared = await prepareStoryWorktree(root, 'LAUNCH-2', { base: newer });
  assert.equal(prepared.created, true);
  assert.equal(prepared.stagingBranch, held);

  const unique = await stagingBranch(root, 'LAUNCH-3');
  const orphan = git(root, 'commit-tree', '-p', newer, '-m', 'work only this launch ref holds', `${newer}^{tree}`);
  git(root, 'update-ref', `refs/heads/${unique}`, orphan);
  await assert.rejects(prepareStoryWorktree(root, 'LAUNCH-3', { base: newer }), (error) => {
    assert.equal(error.code, 'STORY_WORKTREE_RECOVERY_REQUIRED');
    assert.deepEqual(error.details.retainedBranches, [unique]);
    assert.match(error.message, /holds commits no other branch has, so it was kept/u);
    return true;
  });
  assert.equal(git(root, 'rev-parse', `refs/heads/${unique}`), orphan);
});

test('a failed start that must keep its launch branch still reports its own failure code', async (t) => {
  const { root, newer } = await launch(t);
  const prepared = await prepareStoryWorktree(root, 'LAUNCH-4', { base: newer });
  await writeFile(path.join(prepared.repositoryPath, 'progress.txt'), 'committed in the launch checkout\n');
  git(prepared.repositoryPath, 'add', 'progress.txt');
  git(prepared.repositoryPath, 'commit', '-qm', 'unique launch progress');
  const original = new SingularityFlowError('Story start stopped for its own reason.', {
    code: 'START_OWN_FAILURE', details: { phase: 'intake' }
  });
  assert.throws(() => rollbackFailedStoryWorktree(prepared, original, root, { changeDirectory() {} }), (error) => {
    assert.equal(error.code, 'START_OWN_FAILURE');
    assert.deepEqual(error.details.retainedBranches, [prepared.stagingBranch]);
    assert.equal(error.details.cleanupCode, 'STORY_WORKTREE_RECOVERY_REQUIRED');
    assert.equal(error.details.phase, 'intake');
    assert.match(error.message, /contains commits Git would not discard/u);
    return true;
  });
  assert.ok(refExists(root, `refs/heads/${prepared.stagingBranch}`), 'unique launch work is kept');
});
