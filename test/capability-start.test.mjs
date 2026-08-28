import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  capabilityPublicationPlan, preflightStoryRepositories, publishCapabilityRepositories,
  publishedBranches, publishedBranchesAsync, prepareCapabilityRepositories
} from '../src/capability-start.mjs';
import { parseBaseSelection, resolveCapabilityBase } from '../src/capability-branches.mjs';
import { run } from '../src/util.mjs';
import { branch as currentBranch } from '../src/git.mjs';
import { ensureConfigurationBranch } from '../src/configuration-branch.mjs';

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

test('capability remote inventory is bounded, concurrent, and returns manifest order', async () => {
  let active = 0;
  let maximum = 0;
  const repositories = Array.from({ length: 6 }, (_, index) => ({
    id: `repository-${index}`, url: `https://example.invalid/repository-${index}.git`
  }));
  const runGit = async (args) => {
    active += 1;
    maximum = Math.max(maximum, active);
    const index = Number(args.at(-1).match(/repository-(\d+)/)[1]);
    await new Promise((resolve) => setTimeout(resolve, (6 - index) * 3));
    active -= 1;
    return {
      status: 0, stderr: '',
      stdout: `${String(index).padStart(40, 'a')}\trefs/heads/main\n`
    };
  };
  const result = await publishedBranchesAsync(repositories, { workers: 3, runGit });
  assert.equal(maximum, 3);
  assert.deepEqual(Object.keys(result.published), repositories.map((entry) => entry.id));
  assert.deepEqual(result.unreachable, []);
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

test('capability sibling Story branches are published for another machine', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'sflow-capability-'));
  const repositories = [
    await repository(base, 'payments-api', ['main']),
    await repository(base, 'payments-web', ['main'])
  ];
  const { published } = publishedBranches(repositories);
  const resolution = resolveCapabilityBase({
    repositories: published, selection: parseBaseSelection(['main'])
  });
  const plan = { repositories, resolution };
  const checked = await preflightStoryRepositories(base, plan, 'S-REMOTE');
  prepareCapabilityRepositories(base, plan, 'S-REMOTE');

  const leadRoot = path.join(base, repositories[0].path);
  const publicationPlan = capabilityPublicationPlan(checked, leadRoot);
  assert.deepEqual(publicationPlan.map((entry) => entry.repository), ['payments-web']);
  const result = publishCapabilityRepositories(publicationPlan);
  assert.equal(result.error, null);
  assert.deepEqual(result.pending, []);
  assert.equal(result.published[0].branch, 'S-REMOTE');

  const sibling = path.join(base, repositories[1].path);
  assert.equal(
    run('git', ['rev-parse', 'refs/remotes/origin/S-REMOTE'], { cwd: sibling }).stdout.trim(),
    run('git', ['rev-parse', 'refs/remotes/origin/main'], { cwd: sibling }).stdout.trim()
  );
  const clone = path.join(base, 'other-machine');
  git(base, 'clone', '--quiet', repositories[1].url, clone);
  assert.equal(run('git', ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/S-REMOTE'], {
    cwd: clone, allowFailure: true
  }).status, 0);
});

test('a post-preflight sibling publication failure returns an exact resumable remainder', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'sflow-capability-'));
  const repositories = [
    await repository(base, 'lead', ['main']),
    await repository(base, 'sibling', ['main'])
  ];
  const { published } = publishedBranches(repositories);
  const resolution = resolveCapabilityBase({
    repositories: published, selection: parseBaseSelection(['main'])
  });
  const plan = { repositories, resolution };
  const checked = await preflightStoryRepositories(base, plan, 'S-RECOVER');
  prepareCapabilityRepositories(base, plan, 'S-RECOVER');
  const entries = capabilityPublicationPlan(checked, path.join(base, repositories[0].path));
  const sibling = path.join(base, repositories[1].path);
  git(sibling, 'config', 'remote.origin.receivepack', '/usr/bin/false');
  const failed = publishCapabilityRepositories(entries);
  assert.equal(failed.pending.length, 1);
  assert.equal(failed.pending[0].repository, 'sibling');
  assert.match(failed.error, /false|receive|failed|fatal/i);

  git(sibling, 'config', '--unset', 'remote.origin.receivepack');
  const recovered = publishCapabilityRepositories(failed.pending);
  assert.equal(recovered.error, null);
  assert.deepEqual(recovered.pending, []);
  assert.equal(run('git', ['rev-parse', 'refs/remotes/origin/S-RECOVER'], { cwd: sibling }).stdout.trim(),
    failed.pending[0].commit);
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

test('a late sibling failure rolls earlier capability checkouts back atomically', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'sflow-capability-'));
  const repositories = [
    await repository(base, 'payments-api', ['main']),
    await repository(base, 'payments-web', ['main'])
  ];
  await writeFile(path.join(base, repositories[1].path, 'scratch.txt'), 'arrived after preflight\n');
  const resolution = resolveCapabilityBase({
    repositories: { 'payments-api': ['main'], 'payments-web': ['main'] },
    selection: parseBaseSelection(['main'])
  });

  assert.throws(
    () => prepareCapabilityRepositories(base, { repositories, resolution }, 'S-RACE'),
    /clean|uncommitted|dirty/i
  );
  const first = path.join(base, repositories[0].path);
  assert.equal(currentBranch(first), 'main', 'the earlier repository remained on the Story branch');
  assert.equal(run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/S-RACE'], {
    cwd: first, allowFailure: true
  }).status, 1, 'the rolled-back local Story branch remained behind');
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

  await assert.rejects(
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
  await assert.rejects(
    () => preflightStoryRepositories(base, { repositories: [present, absent], resolution }, 'S-MISSING'),
    /not cloned.*Nothing was changed/i
  );
  assert.equal(currentBranch(path.join(base, present.path)), 'main');
});

test('Story preflight rejects a workspace capability absent from the governed catalog', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'sflow-capability-'));
  const repositoryEntry = await repository(base, 'ruleengine', ['main']);
  const lifecycleRoot = path.join(base, repositoryEntry.path);
  await mkdir(path.join(lifecycleRoot, 'singularity'), { recursive: true });
  await writeFile(path.join(lifecycleRoot, 'singularity/capabilities.yml'), `version: 1
capabilities:
  enterprise:
    kind: collection
    parent: null
    policy: {}
  product:
    kind: collection
    parent: enterprise
    policy: {}
`);
  git(lifecycleRoot, 'add', 'singularity/capabilities.yml');
  git(lifecycleRoot, 'commit', '--quiet', '-m', 'governed capability catalog');
  git(lifecycleRoot, 'push', '--quiet', 'origin', 'main');
  const resolution = resolveCapabilityBase({
    repositories: { ruleengine: ['main'] },
    selection: parseBaseSelection(['main'])
  });

  await assert.rejects(
    () => preflightStoryRepositories(base, {
      repositories: [repositoryEntry],
      resolution,
      record: { capability: 'rule-engine' }
    }, 'WORK-ANU', {
      lifecycleRoot,
      capabilityId: 'rule-engine',
      publishRequired: false
    }),
    (error) => error?.code === 'CAPABILITY_UNKNOWN'
      && error.message === "Unknown capability 'rule-engine'."
  );
  assert.equal(currentBranch(lifecycleRoot), 'main');
  assert.equal(run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/WORK-ANU'], {
    cwd: lifecycleRoot, allowFailure: true
  }).status, 1);
});

test('Story preflight resolves a valid capability from code-only application branches', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'sflow-capability-'));
  const repositoryEntry = await repository(base, 'ruleengine', ['main']);
  const lifecycleRoot = path.join(base, repositoryEntry.path);
  await ensureConfigurationBranch(repositoryEntry.url, {
    capability: {
      capabilityId: 'rule-engine',
      capabilityName: 'Rule Engine',
      kind: 'delivery',
      repositoryId: 'ruleengine',
      jiraProject: null,
      teams: []
    }
  });
  assert.equal(run('git', ['cat-file', '-e', 'main:singularity/capabilities.yml'], {
    cwd: lifecycleRoot, allowFailure: true
  }).status, 128, 'the application branch remains code-only');
  const resolution = resolveCapabilityBase({
    repositories: { ruleengine: ['main'] },
    selection: parseBaseSelection(['main'])
  });

  const checked = await preflightStoryRepositories(base, {
    repositories: [repositoryEntry],
    resolution,
    record: { capability: 'rule-engine' }
  }, 'WORK-VALID', {
    lifecycleRoot,
    capabilityId: 'rule-engine',
    publishRequired: false
  });
  assert.equal(checked[0].repository, 'ruleengine');
  assert.equal(currentBranch(lifecycleRoot), 'main');
  assert.equal(run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/WORK-VALID'], {
    cwd: lifecycleRoot, allowFailure: true
  }).status, 1);
});
