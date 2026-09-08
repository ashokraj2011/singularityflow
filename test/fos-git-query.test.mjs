import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { executeGitQuery, gitQueryDescriptor } from '../src/git-query.mjs';
import { compareFosSemanticProjections } from '../src/fos-semantic-projection.mjs';
import { RepoContext } from '../src/repo-context.mjs';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-fos-query-'));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.name', 'FOS Test'], root);
  git(['config', 'user.email', 'fos@example.com'], root);
  await writeFile(path.join(root, 'alpha.txt'), 'alpha\n');
  git(['add', '.'], root);
  git(['commit', '-qm', 'initial'], root);
  return root;
}

test('FOS:AC-019 typed repository identity uses Git paths and distinguishes worktrees', async () => {
  const root = await repository();
  const linked = `${root}-linked`;
  git(['worktree', 'add', '-q', '-b', 'linked', linked], root);
  const primary = await new RepoContext(root).identity();
  const secondary = await new RepoContext(linked).identity();
  assert.equal(primary.commonDir, secondary.commonDir);
  assert.equal(primary.repositoryInstanceId, secondary.repositoryInstanceId);
  assert.notEqual(primary.gitDir, secondary.gitDir);
  assert.notEqual(primary.worktreeInstanceId, secondary.worktreeInstanceId);
  assert.equal(primary.objectFormat, 'sha1');
  assert.equal(primary.bare, false);
});

test('FOS:AC-020 lazy observations coalesce and are defensively immutable', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const context = new RepoContext('/tmp/example', {
    execute: async (_root, id) => {
      calls += 1;
      await gate;
      return id === 'repository.head' ? 'a'.repeat(40) : null;
    }
  });
  const one = context.observe('repository.head');
  const two = context.observe('repository.head');
  release();
  assert.equal(await one, 'a'.repeat(40));
  assert.equal(await two, 'a'.repeat(40));
  assert.equal(calls, 1);
});

test('FOS:AC-021 mutation barriers prevent stale in-flight results from entering a new epoch', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const context = new RepoContext('/tmp/example', {
    execute: async () => {
      calls += 1;
      if (calls === 1) await gate;
      return calls === 1 ? 'old' : 'new';
    }
  });
  const stale = context.observe('repository.head');
  const mutation = context.mutate(async () => { release(); });
  assert.equal(await stale, 'old');
  await mutation;
  assert.equal(await context.observe('repository.head'), 'new');
  assert.equal(calls, 2);
});

test('FOS:AC-022 external edits, watcher overflow and resume advance observational status epochs', async () => {
  const root = await repository();
  const context = new RepoContext(root);
  const clean = await context.statusObservation();
  assert.equal(clean.classification, 'observational');
  assert.deepEqual(clean.entries, []);
  await writeFile(path.join(root, 'alpha.txt'), 'externally edited\n');
  context.notifyExternalChange('watcher-overflow');
  const changed = await context.statusObservation();
  assert.ok(changed.epoch > clean.epoch);
  assert.ok(changed.entries.some((entry) => entry.includes('alpha.txt')));
  context.notifyExternalChange('resume');
  const resumed = await context.statusObservation();
  assert.ok(resumed.epoch > changed.epoch);
  assert.equal(resumed.head, changed.head);
  const newInvocation = await new RepoContext(root).statusObservation();
  assert.ok(newInvocation.entries.some((entry) => entry.includes('alpha.txt')));
});

test('FOS:AC-024 query registry rejects unknown operations and unsafe remote names', async () => {
  assert.throws(() => gitQueryDescriptor('git.anything'), (error) => error.code === 'GIT_QUERY_UNKNOWN');
  assert.throws(() => executeGitQuery('/tmp', 'repository.remote-url', { remote: '--upload-pack=x' }),
    (error) => error.code === 'GIT_QUERY_INPUT_INVALID');
});

test('FOS:AC-006 remote identity reads the repository-local literal without URL rewrites', async () => {
  const root = await repository();
  git(['remote', 'add', 'origin', 'https://example.test/repository.git'], root);
  git(['config', '--local', 'url.https://rewritten.invalid/.insteadOf', 'https://example.test/'], root);
  const context = new RepoContext(root);
  assert.equal(await context.observe('repository.remote-url', { remote: 'origin' }),
    'https://example.test/repository.git');
});

test('FOS:AC-037 cached and --no-cache repository projections remain equivalent', async () => {
  const root = await repository();
  let cachedCalls = 0;
  let uncachedCalls = 0;
  const cached = new RepoContext(root, {
    cache: true,
    execute(repositoryRoot, id, params) {
      cachedCalls += 1;
      return executeGitQuery(repositoryRoot, id, params);
    }
  });
  const uncached = new RepoContext(root, {
    cache: false,
    execute(repositoryRoot, id, params) {
      uncachedCalls += 1;
      return executeGitQuery(repositoryRoot, id, params);
    }
  });
  const cachedProjection = {
    identity: await cached.identity(),
    status: await cached.observe('repository.status'),
    repeatIdentity: await cached.identity(),
    repeatStatus: await cached.observe('repository.status')
  };
  const uncachedProjection = {
    identity: await uncached.identity(),
    status: await uncached.observe('repository.status'),
    repeatIdentity: await uncached.identity(),
    repeatStatus: await uncached.observe('repository.status')
  };
  assert.equal(compareFosSemanticProjections(cachedProjection, uncachedProjection).equivalent, true);
  assert.equal(cachedCalls, 7);
  assert.equal(uncachedCalls, 14);
});
