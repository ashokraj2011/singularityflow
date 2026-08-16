import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  preflightStoryRepositories, publishedBranches, prepareCapabilityRepositories
} from '../src/capability-start.mjs';
import { parseBaseSelection, resolveCapabilityBase } from '../src/capability-branches.mjs';
import { run } from '../src/util.mjs';
import { branch as currentBranch } from '../src/git.mjs';

const git = (cwd, ...args) => run('git', args, { cwd, allowFailure: false });

/** A bare origin with the named branches, and a working clone of it. */
async function repository(base, id, branches) {
  const origin = path.join(base, `${id}.git`);
  const work = path.join(base, 'work', id);
  await mkdir(path.dirname(work), { recursive: true });
  git(base, 'init', '--bare', '--initial-branch=main', origin);
  git(base, 'clone', '--quiet', origin, work);
  git(work, 'config', 'user.email', 'test@example.com');
  git(work, 'config', 'user.name', 'Test');
  await writeFile(path.join(work, 'README.md'), `# ${id}\n`);
  git(work, 'add', '.');
  git(work, 'commit', '--quiet', '-m', 'initial');
  git(work, 'push', '--quiet', 'origin', 'main');
  for (const name of branches.filter((entry) => entry !== 'main')) {
    git(work, 'switch', '--quiet', '-c', name, 'main');
    git(work, 'push', '--quiet', 'origin', name);
  }
  git(work, 'switch', '--quiet', 'main');
  return { id, url: origin, path: path.join('work', id), defaultBranch: 'main', capabilities: ['payments'] };
}

test('published branches come from the remote, and drive the resolution', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'sflow-capability-'));
  const repositories = [
    await repository(base, 'payments-api', ['main', 'develop', 'release/24.3']),
    await repository(base, 'audit-sink', ['main'])
  ];

  const { published, unreachable } = publishedBranches(repositories);
  assert.deepEqual(unreachable, []);
  assert.deepEqual(published['payments-api'], ['develop', 'main', 'release/24.3']);
  assert.deepEqual(published['audit-sink'], ['main']);

  // The refusal is computed from what the remotes actually publish, not from the manifest.
  const refused = resolveCapabilityBase({ repositories: published, selection: parseBaseSelection(['release/24.3']) });
  assert.equal(refused.usable, false);
  assert.deepEqual(refused.missing.map((entry) => entry.repository), ['audit-sink']);
});

test('an unreachable remote is reported, never treated as a repository with no branches', () => {
  // Silently reporting "no branches" would make a network failure look like an empty repository and
  // send the reader hunting for a branch that is there.
  const { published, unreachable } = publishedBranches(
    [{ id: 'ghost', url: path.join(tmpdir(), 'does-not-exist-sflow.git') }],
    { timeoutMs: 5000 }
  );
  assert.deepEqual(published.ghost, []);
  assert.equal(unreachable.length, 1);
  assert.equal(unreachable[0].repository, 'ghost');
});

test('every repository in the capability lands on the Story branch cut from the chosen base', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'sflow-capability-'));
  const repositories = [
    await repository(base, 'payments-api', ['main', 'release/24.3']),
    await repository(base, 'payments-web', ['main', 'release/24.3'])
  ];
  const { published } = publishedBranches(repositories);
  const resolution = resolveCapabilityBase({ repositories: published, selection: parseBaseSelection(['release/24.3']) });
  assert.equal(resolution.usable, true);

  const prepared = prepareCapabilityRepositories(base, { repositories, resolution }, 'S-42');
  assert.deepEqual(prepared.map((entry) => entry.action), ['switched', 'switched']);
  for (const repo of repositories) {
    const root = path.join(base, repo.path);
    assert.equal(currentBranch(root), 'S-42', `${repo.id} is on the Story branch`);
    // Cut from release/24.3, so that branch is an ancestor and main-only commits are not present.
    const merged = run('git', ['branch', '--contains', 'HEAD', '-a'], { cwd: root }).stdout;
    assert.match(merged, /S-42/);
  }
});

test('a repository the workspace has not cloned is named, not skipped in silence', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'sflow-capability-'));
  const present = await repository(base, 'payments-api', ['main']);
  const absent = { id: 'not-cloned', url: 'unused', path: path.join('work', 'not-cloned'), defaultBranch: 'main', capabilities: ['payments'] };
  const resolution = resolveCapabilityBase({
    repositories: { 'payments-api': ['main'], 'not-cloned': ['main'] },
    selection: parseBaseSelection(['main'])
  });
  const prepared = prepareCapabilityRepositories(base, { repositories: [present, absent], resolution }, 'S-7');
  assert.equal(prepared.find((entry) => entry.repository === 'not-cloned').action, 'absent');
  assert.equal(prepared.find((entry) => entry.repository === 'payments-api').action, 'switched');
});

test('a dirty sibling refuses rather than having its work moved', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'sflow-capability-'));
  const repositories = [await repository(base, 'payments-api', ['main'])];
  await writeFile(path.join(base, repositories[0].path, 'scratch.txt'), 'uncommitted\n');
  const resolution = resolveCapabilityBase({
    repositories: { 'payments-api': ['main'] }, selection: parseBaseSelection(['main'])
  });
  // Uncommitted work in a sibling is not this command's to stash.
  assert.throws(() => prepareCapabilityRepositories(base, { repositories, resolution }, 'S-9'),
    /clean|uncommitted|dirty/i);
});

test('publication preflight checks every required repository before any branch moves', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'sflow-capability-'));
  const repositories = [
    await repository(base, 'payments-api', ['main']),
    await repository(base, 'payments-web', ['main'])
  ];
  const { published } = publishedBranches(repositories);
  const resolution = resolveCapabilityBase({
    repositories: published, selection: parseBaseSelection(['main'])
  });
  const blocked = path.join(base, repositories[1].path);
  git(blocked, 'config', 'remote.origin.receivepack', '/usr/bin/false');

  assert.throws(
    () => preflightStoryRepositories(base, { repositories, resolution }, 'S-READONLY'),
    /payments-web|Cannot publish/
  );
  for (const repository of repositories) {
    const root = path.join(base, repository.path);
    assert.equal(currentBranch(root), 'main');
    assert.equal(run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/S-READONLY'], {
      cwd: root, allowFailure: true
    }).status, 1);
  }
});

test('publication preflight refuses a required repository that is not cloned', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'sflow-capability-'));
  const present = await repository(base, 'payments-api', ['main']);
  const absent = {
    id: 'payments-web', url: path.join(base, 'payments-web.git'),
    path: path.join('work', 'payments-web'), defaultBranch: 'main', capabilities: ['payments']
  };
  const resolution = resolveCapabilityBase({
    repositories: { 'payments-api': ['main'], 'payments-web': ['main'] },
    selection: parseBaseSelection(['main'])
  });
  assert.throws(
    () => preflightStoryRepositories(base, { repositories: [present, absent], resolution }, 'S-MISSING'),
    /not cloned.*Nothing was changed/i
  );
  assert.equal(currentBranch(path.join(base, present.path)), 'main');
});
