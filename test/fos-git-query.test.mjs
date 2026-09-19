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

test('fresh observations bypass captured values and invalidate across a local mutation', async () => {
  let value = 'first';
  let calls = 0;
  const context = new RepoContext('/tmp/example', {
    execute: async () => { calls += 1; return value; }
  });
  assert.equal(await context.observe('repository.head'), 'first');
  value = 'second';
  assert.equal(await context.observe('repository.head'), 'first', 'legacy capture remains explicit');
  assert.equal(await context.observeFresh('repository.head'), 'second');
  assert.equal(await context.observeFresh('repository.head'), 'second');
  assert.equal(calls, 3, 'each fresh read executes again');
  await context.mutate(async () => { value = 'third'; });
  assert.equal(await context.observe('repository.head'), 'third');
  assert.equal(calls, 4);
});

test('invalidation retires repository identity captures and rejects overlapping fresh reads', async () => {
  let release;
  let value = 'old';
  const gate = new Promise((resolve) => { release = resolve; });
  const context = new RepoContext('/tmp/example', {
    execute: async (_root, id) => {
      if (id === 'repository.head') await gate;
      return value;
    }
  });
  const pending = context.observeFresh('repository.head');
  context.invalidate();
  release();
  await assert.rejects(pending, (error) => error.code === 'REPO_CONTEXT_EPOCH_CHANGED');
  assert.equal(await context.observe('repository.object-format'), 'old');
  value = 'new';
  context.invalidate();
  assert.equal(await context.observe('repository.object-format'), 'new');
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

test('GAL:AC-005 failed, cancelled, and timed-out mutations retire pending mutable and configuration reads', async () => {
  for (const failure of ['failed', 'cancelled', 'timed-out']) {
    for (const [id, scope] of [
      ['repository.head', 'shared'],
      ['repository.remote-url', 'configuration']
    ]) {
      let current = 'old';
      let calls = 0;
      let releaseRead;
      let startedRead;
      const gate = new Promise((resolve) => { releaseRead = resolve; });
      const started = new Promise((resolve) => { startedRead = resolve; });
      const context = new RepoContext('/tmp/example', {
        execute: async () => {
          calls += 1;
          const result = current;
          if (calls === 1) {
            startedRead();
            await gate;
          }
          return result;
        }
      });
      const stale = context.observe(id);
      await started;
      let finishMutation;
      const attempt = context.mutate(async () => {
        current = 'new';
        releaseRead();
        await new Promise((resolve) => { finishMutation = resolve; });
        throw Object.assign(new Error(failure), { code: failure.toUpperCase() });
      }, { scope });
      await assert.rejects(context.observe(id), (error) => error.code === 'REPO_CONTEXT_MUTATION_IN_PROGRESS');
      assert.equal(await stale, 'old');
      finishMutation();
      await assert.rejects(attempt, (error) => error.message === failure);
      assert.equal(await context.observe(id), 'new');
      assert.equal(await context.observeFresh(id), 'new');
      assert.equal(calls, 3, `${failure}: old pending read was not reused`);
    }
  }
});

test('GAL:AC-005 scoped epochs preserve unrelated captures and reject invalid scopes without a stuck barrier', async () => {
  const calls = new Map();
  const context = new RepoContext('/tmp/example', {
    execute: (_root, id) => {
      calls.set(id, (calls.get(id) ?? 0) + 1);
      return `${id}:${calls.get(id)}`;
    }
  });
  for (const id of ['repository.object-format', 'repository.remote-url',
    'repository.head', 'repository.index-detail', 'repository.local-branch-exists']) {
    await context.observe(id);
  }
  await context.mutate(async () => {}, { scope: 'worktree' });
  assert.equal(await context.observe('repository.object-format'), 'repository.object-format:1');
  assert.equal(await context.observe('repository.remote-url'), 'repository.remote-url:1');
  assert.equal(await context.observe('repository.local-branch-exists'), 'repository.local-branch-exists:1');
  assert.equal(await context.observe('repository.head'), 'repository.head:2');
  assert.equal(await context.observe('repository.index-detail'), 'repository.index-detail:2');
  await context.mutate(async () => {}, { scope: 'shared' });
  assert.equal(await context.observe('repository.head'), 'repository.head:3');
  assert.equal(await context.observe('repository.local-branch-exists'), 'repository.local-branch-exists:2');
  assert.equal(await context.observe('repository.index-detail'), 'repository.index-detail:2');
  await assert.rejects(context.mutate(async () => {}, { scope: 'unknown' }),
    (error) => error.code === 'REPO_CONTEXT_INVALIDATION_SCOPE_INVALID');
  assert.equal(await context.observe('repository.head'), 'repository.head:3');
});

test('GAL:AC-014 external worktree and configuration changes refresh affected captures but fresh reads bypass silent changes', async () => {
  const root = await repository();
  git(['remote', 'add', 'origin', 'https://example.test/old.git'], root);
  const context = new RepoContext(root);
  assert.deepEqual(await context.observe('repository.status'), []);
  assert.equal(await context.observe('repository.remote-url', { remote: 'origin' }),
    'https://example.test/old.git');
  await writeFile(path.join(root, 'alpha.txt'), 'changed outside context\n');
  git(['remote', 'set-url', 'origin', 'https://example.test/new.git'], root);
  assert.deepEqual(await context.observe('repository.status'), [], 'captured status remains captured');
  assert.equal(await context.observeFresh('repository.remote-url', { remote: 'origin' }),
    'https://example.test/new.git');
  context.notifyExternalChange('watcher', { scope: 'worktree' });
  assert.ok((await context.observe('repository.status')).some((entry) => entry.includes('alpha.txt')));
  assert.equal(await context.observe('repository.remote-url', { remote: 'origin' }),
    'https://example.test/old.git', 'worktree-only notification preserves unrelated configuration capture');
  context.notifyExternalChange('external', { scope: 'configuration' });
  assert.equal(await context.observe('repository.remote-url', { remote: 'origin' }),
    'https://example.test/new.git');
});

test('GAL:AC-015 shared-ref and configuration barriers reach registered linked worktree contexts', async () => {
  const root = await repository();
  const linked = `${root}-linked`;
  git(['worktree', 'add', '-q', '-b', 'linked', linked], root);
  const primary = new RepoContext(root);
  const sibling = new RepoContext(linked);
  await Promise.all([primary.identity(), sibling.identity()]);
  assert.equal(await sibling.observe('repository.local-branch-exists', { branch: 'created' }), false);
  let finish;
  const mutation = primary.mutate(async () => {
    git(['branch', 'created'], root);
    await new Promise((resolve) => { finish = resolve; });
  }, { scope: 'shared' });
  await assert.rejects(sibling.observe('repository.local-branch-exists', { branch: 'created' }),
    (error) => error.code === 'REPO_CONTEXT_MUTATION_IN_PROGRESS');
  finish();
  await mutation;
  assert.equal(await sibling.observe('repository.local-branch-exists', { branch: 'created' }), true);
  git(['remote', 'add', 'origin', 'https://example.test/old.git'], root);
  primary.notifyExternalChange('external', { scope: 'configuration' });
  assert.equal(await sibling.observe('repository.remote-url', { remote: 'origin' }),
    'https://example.test/old.git');
  git(['remote', 'set-url', 'origin', 'https://example.test/new.git'], root);
  primary.notifyExternalChange('external', { scope: 'configuration' });
  assert.equal(await sibling.observe('repository.remote-url', { remote: 'origin' }),
    'https://example.test/new.git');
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
  assert.throws(() => executeGitQuery('/tmp', 'repository.status', { untracked: 'sometimes' }),
    (error) => error.code === 'GIT_QUERY_INPUT_INVALID');
});

test('typed status supports the reviewed summary projection without reading untracked paths', async () => {
  const root = await repository();
  await writeFile(path.join(root, 'untracked.txt'), 'untracked\n');
  assert.equal(executeGitQuery(root, 'repository.status', { untracked: 'no' }).length, 0);
  assert.equal(executeGitQuery(root, 'repository.status', { untracked: 'all' }).length, 1);
});

test('typed revision and local-branch queries preserve branch, HEAD, dirty paths, and literal inputs', async () => {
  const root = await repository();
  await writeFile(path.join(root, 'alpha.txt'), 'changed\n');
  await writeFile(path.join(root, 'space and δ.txt'), 'untracked\n');
  const revision = executeGitQuery(root, 'repository.revision');
  assert.equal(revision.branchName, 'main');
  assert.equal(revision.commit, git(['rev-parse', 'HEAD'], root));
  assert.deepEqual(revision.changedFiles, ['alpha.txt', 'space and δ.txt']);
  assert.deepEqual(revision.untrackedFiles, ['space and δ.txt']);
  assert.equal(executeGitQuery(root, 'repository.local-branch-exists', { branch: 'main' }), true);
  assert.equal(executeGitQuery(root, 'repository.local-branch-exists', { branch: 'missing' }), false);
  assert.throws(() => executeGitQuery(root, 'repository.local-branch-exists', {
    branch: '../unsafe'
  }), (error) => error.code === 'GIT_QUERY_INPUT_INVALID');
});

test('registered branch observation is one bounded spawn and rejects deadline/protocol failures', () => {
  const calls = [];
  const branch = executeGitQuery('/tmp', 'repository.branch', {}, {
    env: { SINGULARITY_FLOW_GIT_LOCAL_TIMEOUT_MS: '4321' },
    runner(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: 'refs/heads/topic\n', stderr: '' };
    }
  });
  assert.equal(branch, 'topic');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'git');
  assert.deepEqual(calls[0].args, ['symbolic-ref', '--quiet', 'HEAD']);
  assert.equal(calls[0].options.timeoutClass, 'local-read');
  assert.equal(calls[0].options.operation, 'repository.branch');

  assert.throws(() => executeGitQuery('/tmp', 'repository.branch', {}, {
    runner: () => ({ status: null, stdout: '', stderr: '', timedOut: true })
  }), (error) => error.code === 'GIT_QUERY_FAILED');
  for (const queryId of ['repository.branch', 'repository.head', 'repository.remote-url']) {
    assert.throws(() => executeGitQuery('/tmp', queryId,
      queryId === 'repository.remote-url' ? { remote: 'origin' } : {}, {
        runner: () => ({
          status: 1, stdout: '', stderr: '', error: Object.assign(new Error('timeout'), {
            code: 'ETIMEDOUT'
          }), signal: null, timedOut: true, blocked: false
        })
      }), (error) => error.code === 'GIT_QUERY_FAILED', queryId);
  }
  assert.throws(() => executeGitQuery('/tmp', 'repository.branch', {}, {
    runner: () => ({ status: 0, stdout: 'refs/tags/not-a-branch\n', stderr: '' })
  }), (error) => error.code === 'GIT_QUERY_PARSE_FAILED');
});

test('registered branch observation selects each linked worktree and preserves detached absence', async () => {
  const root = await repository();
  const linked = `${root}-branch-read-linked`;
  git(['worktree', 'add', '-q', '-b', 'linked-status', linked], root);
  assert.equal(executeGitQuery(root, 'repository.branch'), 'main');
  assert.equal(executeGitQuery(linked, 'repository.branch'), 'linked-status');
  git(['switch', '--detach', '-q', 'HEAD'], linked);
  assert.equal(executeGitQuery(linked, 'repository.branch'), null);
});

test('registered repository identity cannot be redirected by ambient Git process selectors', async () => {
  const root = await repository();
  const other = await repository();
  git(['remote', 'add', 'origin', 'https://example.invalid/root.git'], root);
  git(['remote', 'add', 'origin', 'https://example.invalid/other.git'], other);
  git(['branch', '-m', 'other-branch'], other);
  const hostile = {
    ...process.env,
    GIT_DIR: path.join(other, '.git'),
    GIT_WORK_TREE: other,
    GIT_INDEX_FILE: path.join(other, '.git', 'index')
  };

  assert.equal(executeGitQuery(root, 'repository.remote-url', { remote: 'origin' }, {
    env: hostile
  }), 'https://example.invalid/root.git');
  assert.equal(executeGitQuery(root, 'repository.branch', {}, { env: hostile }), 'main');
  assert.equal(executeGitQuery(root, 'repository.head', {}, { env: hostile }),
    git(['rev-parse', 'HEAD'], root));
});

test('FOS:AC-024 porcelain revision parsing preserves hostile literal paths and rename destinations', async () => {
  const root = await repository();
  const tabbed = 'tab\tname.txt';
  const newline = 'line\nname.txt';
  const renamed = 'renamed\tδ.txt';
  await writeFile(path.join(root, tabbed), 'tabbed\n');
  await writeFile(path.join(root, newline), 'newline\n');
  git(['add', '--', tabbed, newline], root);
  git(['commit', '-qm', 'hostile paths'], root);
  git(['mv', '--', tabbed, renamed], root);
  await writeFile(path.join(root, newline), 'changed\n');
  await writeFile(path.join(root, '-untracked.txt'), 'leading dash\n');
  const revision = executeGitQuery(root, 'repository.revision');
  assert.ok(revision.changedFiles.includes(renamed));
  assert.ok(revision.changedFiles.includes(newline));
  assert.ok(revision.changedFiles.includes('-untracked.txt'));
  assert.equal(revision.changedFiles.includes(tabbed), false,
    'the rename source is not a second changed destination');
  assert.deepEqual(revision.untrackedFiles, ['-untracked.txt']);
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
