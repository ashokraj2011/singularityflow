/**
 * A capability whose repositories use different branch names: no branch is in all of them, so a
 * Story takes a base per repository (`--from-branch <repository>=<branch>`). Story intake in VS Code
 * always starts in an isolated worktree, and that path once read `--from-branch` as one string,
 * fetching the last `<repository>=<branch>` as a branch name (REMOTE_BRANCH_NOT_FOUND).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { run } from '../src/util.mjs';
import { isolatedTestEnvironment } from '../scripts/test-machine-state.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const cli = path.resolve('bin/singularity-flow.mjs');

function machine(root) {
  return {
    ...isolatedTestEnvironment(root),
    NODE_ENV: 'test',
    SINGULARITY_FLOW_TEST_IDENTITY: 'Capability Reviewer',
    SINGULARITY_FLOW_ORGANISATION_CACHE: path.join(root, 'organisation-cache'),
    SINGULARITY_FLOW_BOOTSTRAP_STATE: path.join(root, 'bootstrap'),
    SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(root, 'transport-outbox'),
    SINGULARITY_FLOW_BOOTSTRAP_MIN_DISK_BYTES: '1',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'user.name',
    GIT_CONFIG_VALUE_0: 'Capability Reviewer',
    GIT_CONFIG_KEY_1: 'user.email',
    GIT_CONFIG_VALUE_1: 'capability.reviewer@example.com'
  };
}

/** A bare remote whose first branch is its default; later branches start at the same commit. */
async function remoteRepository(base, name, branches) {
  const source = path.join(base, 'sources', name);
  const remote = path.join(base, 'remotes', `${name}.git`);
  await mkdir(path.join(source, 'src'), { recursive: true });
  run('git', ['init', '-q', '-b', branches[0]], { cwd: source });
  run('git', ['config', 'user.name', 'Fixture Author'], { cwd: source });
  run('git', ['config', 'user.email', 'fixture.author@example.com'], { cwd: source });
  await writeFile(path.join(source, 'package.json'), `{ "name": "${name}", "scripts": { "test": "node --test" } }\n`);
  await writeFile(path.join(source, 'src', 'index.js'), 'export const value = 1;\n');
  run('git', ['add', '-A'], { cwd: source });
  run('git', ['commit', '-qm', 'application baseline'], { cwd: source });
  for (const branch of branches.slice(1)) run('git', ['branch', branch], { cwd: source });
  await mkdir(path.dirname(remote), { recursive: true });
  run('git', ['clone', '-q', '--bare', source, remote], { cwd: base });
  return remote;
}

function invokeJson(env, cwd, args, { expectStatus = 0 } = {}) {
  const result = spawnSync(process.execPath, [cli, ...args, '--json'], {
    cwd, env, encoding: 'utf8', timeout: childTimeout(240_000)
  });
  assert.equal(result.status, expectStatus,
    `singularity-flow ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return JSON.parse(result.status === 0 ? result.stdout : (result.stdout.trim() || result.stderr));
}

test('an isolated Story start takes a base per repository when no branch is shared', slowLane({
  timeout: 600_000
}), async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-repository-bases-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = machine(path.join(base, 'machine'));
  const platform = await remoteRepository(base, 'platform', ['main']);
  const api = await remoteRepository(base, 'payments-api', ['main']);
  const web = await remoteRepository(base, 'payments-web', ['develop']);
  const ledger = await remoteRepository(base, 'ledger-core', ['main', 'develop']);
  const mapped = invokeJson(env, base, ['capability', 'map', 'payments', '--lead', platform, '--name', 'Payments',
    '--kind', 'delivery', '--repository', api, '--repository', web, '--repository', ledger]);
  invokeJson(env, base, ['capability', 'activate', mapped.branch, '--lead', platform, '--confirm', mapped.commit,
    '--acknowledge-unprotected']);
  const prepared = invokeJson(env, base, ['workspace', 'prepare', platform, '--id', 'payments-work', '--name', 'Payments Work',
    '--base', path.join(base, 'workspaces'), '--capability', 'payments', '--lead-capability', 'payments', '--clone', '--initialize']);
  const ready = invokeJson(env, base, ['workspace', 'bootstrap', 'resume', prepared.bootstrapId, '--confirm', 'payments-work']);
  const workspace = ready.result.workspace.path;
  const launch = path.join(workspace, 'repos', 'payments-api');
  invokeJson(env, launch, ['workspace', 'use', 'payments-work', '--repository', 'payments-api']);

  // The listing names each repository's own branches, and no branch in all three.
  const listed = invokeJson(env, launch, ['workspace', 'branches', '--intake', '--capability', 'payments']);
  assert.equal(listed.repositoryId, 'payments-api');
  assert.deepEqual(Object.fromEntries(listed.repositories.map(({ id, branches }) => [id, branches])),
    { 'payments-api': ['main'], 'payments-web': ['develop'], 'ledger-core': ['develop', 'main'] });
  assert.equal(listed.choices.some((choice) => choice.everywhere), false);

  const started = invokeJson(env, launch, ['start', 'PAY-1', '--title', 'Card limits', '--description', 'Limit card spend.',
    '--acceptance-criteria', 'Over the limit is declined.', '--work-type', 'feature', '--isolated-worktree',
    '--from-branch', 'payments-api=main', '--from-branch', 'payments-web=develop', '--from-branch', 'ledger-core=develop']);
  assert.equal(started.outcome.status, 'succeeded', JSON.stringify(started.outcome));
  assert.deepEqual(started.data.capabilityBase.repositories, {
    'ledger-core': { branch: 'develop', source: 'override' },
    'payments-api': { branch: 'main', source: 'override' },
    'payments-web': { branch: 'develop', source: 'override' }
  });
  for (const [name, remote, branch] of [['payments-api', api, 'main'], ['payments-web', web, 'develop'], ['ledger-core', ledger, 'develop']]) {
    const tip = run('git', ['--git-dir', remote, 'rev-parse', '--verify', 'refs/heads/PAY-1'], { cwd: base }).stdout.trim();
    assert.match(tip, /^[0-9a-f]{40}$/u, `${name} has the Story branch`);
    run('git', ['--git-dir', remote, 'merge-base', '--is-ancestor', `refs/heads/${branch}`, 'refs/heads/PAY-1'], { cwd: base });
  }
  // The launch checkout is the isolated worktree cut from its own repository's base.
  assert.equal(started.data.worktree.isolated, true);
  assert.equal(started.data.worktree.launchRepository, launch);
});
