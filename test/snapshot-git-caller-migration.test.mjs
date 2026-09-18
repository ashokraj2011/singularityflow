import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { executeGitQuery } from '../src/git-query.mjs';
import { parsePorcelainV2Revision } from '../src/git-status-projection.mjs';
import { SnapshotCoordinator } from '../src/snapshot-coordinator.mjs';
import { run } from '../src/util.mjs';

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function legacyRevision(root) {
  return parsePorcelainV2Revision(run('git', [
    'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'
  ], { cwd: root }).stdout);
}

async function repository(t, { unborn = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-snapshot-git-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Snapshot Test']);
  git(root, ['config', 'user.email', 'snapshot@example.com']);
  if (!unborn) {
    await writeFile(path.join(root, 'tracked.txt'), 'initial\n');
    git(root, ['add', 'tracked.txt']);
    git(root, ['commit', '-qm', 'initial']);
  }
  return root;
}

async function captureRevision(coordinator) {
  const result = await coordinator.capture(async ({ revision }) => ({
    repository: { ...revision }
  }), { included: ['repository'] });
  return result;
}

function assertRevisionParity(result, expected) {
  assert.equal(result.revision.branch, expected.branchName);
  assert.equal(result.revision.head, expected.commit);
  assert.deepEqual(result.repository.changedFiles, expected.changedFiles);
}

test('snapshot revision descriptor is one fresh Git query with the legacy argv and parser', async (t) => {
  const root = await repository(t);
  let calls = 0;
  const runner = (command, argv, options) => {
    calls += 1;
    assert.equal(command, 'git');
    assert.deepEqual(argv, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
    assert.equal(options.timeoutClass, 'local-read');
    return run(command, argv, options);
  };
  const expected = legacyRevision(root);
  assert.deepEqual(executeGitQuery(root, 'repository.revision', {}, { runner }), expected);
  assert.equal(calls, 1);
  await writeFile(path.join(root, 'untracked.txt'), 'new\n');
  assert.deepEqual(executeGitQuery(root, 'repository.revision', {}, { runner }), legacyRevision(root));
  assert.equal(calls, 2, 'the next boundary must issue a new Git query');
});

test('snapshot revision matches legacy on dirty, detached, and switched branches', async (t) => {
  const root = await repository(t);
  const coordinator = new SnapshotCoordinator(root);
  let result = await captureRevision(coordinator);
  assertRevisionParity(result, legacyRevision(root));

  await writeFile(path.join(root, 'tracked.txt'), 'modified\n');
  await writeFile(path.join(root, 'untracked.txt'), 'untracked\n');
  result = await captureRevision(coordinator);
  assertRevisionParity(result, legacyRevision(root));
  assert.deepEqual(result.repository.changedFiles, ['tracked.txt', 'untracked.txt']);

  git(root, ['switch', '-q', '-c', 'feature']);
  result = await captureRevision(coordinator);
  assertRevisionParity(result, legacyRevision(root));
  assert.equal(result.revision.branch, 'feature');

  git(root, ['checkout', '--detach', '-q', 'HEAD']);
  result = await captureRevision(coordinator);
  assertRevisionParity(result, legacyRevision(root));
  assert.equal(result.revision.branch, '(detached)');
});

test('a branch switch during a snapshot is observed at the second revision boundary', async (t) => {
  const root = await repository(t);
  const coordinator = new SnapshotCoordinator(root);
  await assert.rejects(() => coordinator.capture(async () => {
    git(root, ['switch', '-q', '-c', 'feature']);
    return { repository: {} };
  }, { included: ['repository'] }), /Repository state changed/);
  const settled = await captureRevision(coordinator);
  assertRevisionParity(settled, legacyRevision(root));
  assert.equal(settled.revision.branch, 'feature');
});

test('snapshot revision retains unborn HEAD projection and shadow equivalence', async (t) => {
  const root = await repository(t, { unborn: true });
  const observations = [];
  const result = await captureRevision(new SnapshotCoordinator(root, {
    gitReadMode: 'shadow',
    onGitShadowComparison(value) { observations.push(value); }
  }));
  assertRevisionParity(result, legacyRevision(root));
  assert.equal(result.revision.branch, 'main');
  assert.equal(observations.length, 2, 'both snapshot boundaries are compared');
  assert.ok(observations.every((entry) => entry.outcome === 'equivalent'));
  assert.ok(observations.every((entry) => entry.authoritativePath === 'reference'));
});
