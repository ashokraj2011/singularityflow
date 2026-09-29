/**
 * Reference repositories fetched ahead of Story start. `[perf]`
 *
 * The store only changes where the objects of an exact, already pinned commit come from. The pin is
 * still resolved by start, the checkout's origin still names the real repository, and anything the
 * store cannot serve is fetched from the network exactly as before.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runRemoteGitAsync } from '../src/git-execution.mjs';
import {
  REFERENCE_PREFETCH_MAX_ENTRIES, hasPrefetchedReference, prefetchReferenceRepository, prefetchedReferenceSource
} from '../src/reference-prefetch.mjs';
import {
  materializeReferenceRepositories, materializeReferenceRepositoriesFromBranches,
  parseReferenceRepositoryOptions, resolveReferenceRepositoryPins
} from '../src/reference-repositories.mjs';
import { run } from '../src/util.mjs';

const git = (cwd, args) => run('git', args, { cwd }).stdout.trim();

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-reference-prefetch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source');
  const target = path.join(directory, 'target');
  const remote = path.join(directory, 'source.git');
  await mkdir(source);
  git(source, ['init', '--quiet', '--initial-branch=main']);
  git(source, ['config', 'user.name', 'Reference Author']);
  git(source, ['config', 'user.email', 'reference@example.test']);
  await writeFile(path.join(source, 'RuleEngine.java'), 'final class RuleEngine {}\n');
  git(source, ['add', '.']);
  git(source, ['commit', '--quiet', '-m', 'reference source']);
  git(directory, ['clone', '--quiet', '--bare', source, remote]);
  git(source, ['remote', 'add', 'origin', remote]);
  await mkdir(target);
  git(target, ['init', '--quiet', '--initial-branch=main']);
  git(target, ['config', 'user.name', 'Target Author']);
  git(target, ['config', 'user.email', 'target@example.test']);
  await writeFile(path.join(target, 'README.md'), '# target\n');
  git(target, ['add', 'README.md']);
  git(target, ['commit', '--quiet', '-m', 'target']);
  return { directory, source, target, remote, commit: git(source, ['rev-parse', 'HEAD']) };
}

function recorder() {
  const commands = [];
  const runGit = (args, options) => {
    commands.push(args[0]);
    return runRemoteGitAsync(args, options);
  };
  return { commands, runGit };
}

test('a prefetched reference is materialized from the store and verified exactly as before', async (t) => {
  const f = await fixture(t);
  const [pin] = await resolveReferenceRepositoryPins(
    parseReferenceRepositoryOptions([`lib=${f.remote}`], ['lib=main']), { localNamespace: 'STORY-1' }
  );
  assert.deepEqual(await prefetchReferenceRepository(f.target, pin), { status: 'prefetched' });
  assert.deepEqual(await prefetchReferenceRepository(f.target, pin), { status: 'present' });
  assert.ok(await prefetchedReferenceSource(f.target, pin));
  assert.equal(await hasPrefetchedReference(f.target, f.remote), true);

  const { commands, runGit } = recorder();
  const [materialized] = await materializeReferenceRepositories(f.target, [pin], { runGit });
  assert.deepEqual(commands, [], 'no remote transfer: the pinned commit came from the store');
  assert.equal(materialized.materialization, 'created');
  const checkout = path.join(f.target, pin.localPath);
  assert.equal(git(checkout, ['rev-parse', 'HEAD']), f.commit);
  assert.equal(git(checkout, ['remote', 'get-url', 'origin']), f.remote,
    'origin names the real repository, never the store');
  assert.equal(git(checkout, ['status', '--porcelain']), '');
});

test('a deferred pin resolves with one listing when a copy is stored, and a moved tip is fetched as before', async (t) => {
  const f = await fixture(t);
  const requests = parseReferenceRepositoryOptions([`lib=${f.remote}`], ['lib=main']);
  const [pin] = await resolveReferenceRepositoryPins(requests);
  await prefetchReferenceRepository(f.target, pin);
  const first = recorder();
  const [stored] = await materializeReferenceRepositoriesFromBranches(f.target, requests, {
    localNamespace: 'STORY-A', runGit: first.runGit
  });
  assert.deepEqual(first.commands, ['ls-remote'], 'one listing instead of the transfer');
  assert.equal(stored.commit, f.commit);

  await writeFile(path.join(f.source, 'RuleEngine.java'), 'final class RuleEngine { int moved; }\n');
  git(f.source, ['commit', '--quiet', '-am', 'the branch moved on']);
  git(f.source, ['push', '--quiet', 'origin', 'main']);
  const second = recorder();
  const [moved] = await materializeReferenceRepositoriesFromBranches(f.target, requests, {
    localNamespace: 'STORY-B', runGit: second.runGit
  });
  assert.deepEqual(second.commands, ['ls-remote', 'fetch'], 'a commit the store lacks comes from the network');
  assert.equal(moved.commit, git(f.source, ['rev-parse', 'HEAD']));
});

test('the store keeps its newest entries within bounds and never serves what it lacks', async (t) => {
  const f = await fixture(t);
  const pins = [];
  for (let index = 0; index <= REFERENCE_PREFETCH_MAX_ENTRIES; index += 1) {
    await writeFile(path.join(f.source, 'version.txt'), `${index}\n`);
    git(f.source, ['add', 'version.txt']);
    git(f.source, ['commit', '--quiet', '-m', `revision ${index}`]);
    git(f.source, ['push', '--quiet', 'origin', `HEAD:refs/heads/revision-${index}`]);
    pins.push({ repository: f.remote, commit: git(f.source, ['rev-parse', 'HEAD']) });
    assert.equal((await prefetchReferenceRepository(f.target, pins.at(-1))).status, 'prefetched');
  }
  const store = path.join(f.target, '.git', 'singularity-flow', 'reference-prefetch', 'v1');
  assert.equal((await readdir(store)).filter((name) => /^[0-9a-f]{40}$/.test(name)).length,
    REFERENCE_PREFETCH_MAX_ENTRIES);
  assert.equal(await prefetchedReferenceSource(f.target, pins[0]), null, 'the least recently used went first');
  assert.ok(await prefetchedReferenceSource(f.target, pins.at(-1)));
  assert.equal(await prefetchedReferenceSource(f.target, { repository: f.remote, commit: 'c'.repeat(40) }), null);

  const unreachable = await prefetchReferenceRepository(f.target, {
    repository: path.join(f.directory, 'missing.git'), commit: pins.at(-1).commit
  });
  assert.deepEqual(unreachable, { status: 'declined', reason: 'unreachable' });

  const abandoned = path.join(store, `.fill-${'d'.repeat(40)}-1-abcd`);
  await mkdir(abandoned);
  const old = new Date(Date.now() - 60 * 60_000);
  await utimes(abandoned, old, old);
  await writeFile(path.join(f.source, 'version.txt'), 'last\n');
  git(f.source, ['commit', '--quiet', '-am', 'one more']);
  git(f.source, ['push', '--quiet', 'origin', 'HEAD:refs/heads/last']);
  await prefetchReferenceRepository(f.target, { repository: f.remote, commit: git(f.source, ['rev-parse', 'HEAD']) });
  assert.ok(!(await readdir(store)).includes(path.basename(abandoned)), 'an abandoned fill is removed');
});
