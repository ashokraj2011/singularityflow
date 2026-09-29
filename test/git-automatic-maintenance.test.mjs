/**
 * Singularity Flow's Git children never start Git's automatic maintenance.
 *
 * With Git 2.54, two overlapping detached auto-maintenance runs in one repository destroyed the
 * history of the end-to-end Story clone: the second (geometric) repack adopted the first repack's
 * temporary pack, deleted the packs and loose objects behind it, and the first repack then failed
 * and removed that temporary pack. Singularity Flow issues writing commands seconds apart and from
 * background workers, so none of its Git processes may start maintenance.
 *
 * The fixtures make maintenance synchronous and leave a commit-graph behind every time it runs, so
 * "maintenance did not run" is an observed fact rather than a race the test hopes to lose.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { withoutAutomaticGitMaintenance } from '../src/platform-process.mjs';
import { runRemoteGit, runRemoteGitAsync } from '../src/git-execution.mjs';
import { run } from '../src/util.mjs';

// The fixture's own Git must not start maintenance either, and must not inherit counted config.
const plainEnvironment = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !/^GIT_(?:CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)|DIR|WORK_TREE|INDEX_FILE)$/iu.test(key)));

function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], {
    cwd, encoding: 'utf8', env: plainEnvironment
  });
  assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

/** A Git command in `repository` that starts auto-maintenance now runs it to completion first. */
function observeMaintenance(repository) {
  git(repository, 'config', 'maintenance.auto', 'true');
  git(repository, 'config', 'maintenance.autoDetach', 'false');
  git(repository, 'config', 'gc.autoDetach', 'false');
  git(repository, 'config', 'maintenance.commit-graph.enabled', 'true');
  git(repository, 'config', 'maintenance.commit-graph.auto', '-1');
}

function maintenanceRan(repository) {
  return ['commit-graph', 'commit-graphs'].some((name) => existsSync(path.join(repository, '.git', 'objects', 'info', name)));
}

async function repository(t, label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `sflow-maintenance-${label}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Maintenance Fixture');
  git(root, 'config', 'user.email', 'maintenance@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# fixture\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'initial');
  return root;
}

async function commitChange(root, name) {
  await writeFile(path.join(root, `${name}.txt`), `${name}\n`);
  git(root, 'add', `${name}.txt`);
}

/** Skip on a Git that has no automatic maintenance to start (before 2.29). */
async function requireObservableMaintenance(t) {
  const control = await repository(t, 'control');
  observeMaintenance(control);
  await commitChange(control, 'control');
  const plain = spawnSync('git', ['commit', '-q', '-m', 'control'], {
    cwd: control, encoding: 'utf8', env: plainEnvironment
  });
  assert.equal(plain.status, 0, plain.stderr);
  if (!maintenanceRan(control)) {
    t.skip('this Git does not start automatic maintenance after a commit');
    return false;
  }
  return true;
}

test('the counted configuration follows the caller\'s entries and is added once', () => {
  const caller = {
    PATH: '/usr/bin', GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: 'office'
  };
  const env = withoutAutomaticGitMaintenance(caller, { platform: 'linux' });
  assert.notEqual(env, caller);
  assert.equal(caller.GIT_CONFIG_COUNT, '1', 'the caller environment was modified');
  assert.equal(env.GIT_CONFIG_COUNT, '3');
  assert.deepEqual([[env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_VALUE_0]], [['credential.helper', 'office']]);
  assert.deepEqual([1, 2].map((index) => [env[`GIT_CONFIG_KEY_${index}`], env[`GIT_CONFIG_VALUE_${index}`]]),
    [['maintenance.auto', 'false'], ['gc.auto', '0']]);
  assert.equal(withoutAutomaticGitMaintenance(env, { platform: 'linux' }), env, 'a second pass added entries again');

  const empty = withoutAutomaticGitMaintenance({ PATH: '/usr/bin' }, { platform: 'linux' });
  assert.equal(empty.GIT_CONFIG_COUNT, '2');
  assert.equal(empty.GIT_CONFIG_KEY_0, 'maintenance.auto');

  // A later caller entry that turns maintenance back on is overridden by an appended entry.
  const reenabled = withoutAutomaticGitMaintenance({
    ...env, GIT_CONFIG_COUNT: '4', GIT_CONFIG_KEY_3: 'maintenance.auto', GIT_CONFIG_VALUE_3: 'true'
  }, { platform: 'linux' });
  assert.equal(reenabled.GIT_CONFIG_COUNT, '6');
  assert.equal(reenabled.GIT_CONFIG_KEY_4, 'maintenance.auto');
  assert.equal(reenabled.GIT_CONFIG_VALUE_4, 'false');
});

test('a count Git would refuse is left for Git to refuse', () => {
  // Malformed, negative, or naming entries the environment cannot hold (Git reports them missing).
  for (const count of ['two', '-1', '1x', '5', '99999999999']) {
    const env = { GIT_CONFIG_COUNT: count };
    assert.equal(withoutAutomaticGitMaintenance(env, { platform: 'linux' }), env, count);
  }
  const ambiguous = { GIT_CONFIG_COUNT: '1', Git_Config_Count: '2' };
  assert.equal(withoutAutomaticGitMaintenance(ambiguous, { platform: 'win32' }), ambiguous);
  // Node never passes an undefined variable to the child, so it is no count at all.
  assert.equal(withoutAutomaticGitMaintenance({ GIT_CONFIG_COUNT: undefined }, { platform: 'linux' }).GIT_CONFIG_COUNT, '2');
});

test('Windows spellings are read case-insensitively and replaced by one canonical count', () => {
  const env = withoutAutomaticGitMaintenance({
    Path: 'C:\\Git\\cmd', Git_Config_Count: '1',
    git_config_key_0: 'http.proxy', Git_Config_Value_0: 'http://proxy.invalid:8080',
    git_config_key_1: 'stale.key'
  }, { platform: 'win32' });
  const counts = Object.keys(env).filter((key) => key.toUpperCase() === 'GIT_CONFIG_COUNT');
  assert.deepEqual(counts, ['GIT_CONFIG_COUNT']);
  assert.equal(env.GIT_CONFIG_COUNT, '3');
  assert.equal(env.git_config_key_0, 'http.proxy');
  assert.deepEqual(Object.keys(env).filter((key) => key.toUpperCase() === 'GIT_CONFIG_KEY_1'), ['GIT_CONFIG_KEY_1']);
  assert.equal(env.GIT_CONFIG_KEY_1, 'maintenance.auto');

  // POSIX Git never reads a lower-case spelling, so it is neither a count nor something to remove.
  const posix = withoutAutomaticGitMaintenance({ git_config_count: 'junk' }, { platform: 'linux' });
  assert.equal(posix.git_config_count, 'junk');
  assert.equal(posix.GIT_CONFIG_COUNT, '2');
});

test('a local Git command Singularity Flow runs starts no automatic maintenance', async (t) => {
  if (!await requireObservableMaintenance(t)) return;
  const root = await repository(t, 'local');
  observeMaintenance(root);
  await commitChange(root, 'change');
  const committed = run('git', ['commit', '-q', '-m', 'governed change'], { cwd: root, env: plainEnvironment });
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(maintenanceRan(root), false, 'run() let `git commit` start automatic maintenance');
});

/** A clone that fetches from a local origin, and a way to give the origin one more commit. */
async function fetchFixture(t) {
  const source = await repository(t, 'source');
  const origin = await mkdtemp(path.join(os.tmpdir(), 'sflow-maintenance-origin-'));
  t.after(() => rm(origin, { recursive: true, force: true }));
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  git(source, 'remote', 'add', 'origin', origin);
  git(source, 'push', '-q', 'origin', 'main');
  const clone = await mkdtemp(path.join(os.tmpdir(), 'sflow-maintenance-clone-'));
  t.after(() => rm(clone, { recursive: true, force: true }));
  git(clone, 'clone', '-q', origin, '.');
  observeMaintenance(clone);
  return {
    clone,
    async publish(label) {
      await commitChange(source, label);
      git(source, 'commit', '-q', '-m', label);
      git(source, 'push', '-q', 'origin', 'main');
      return git(source, 'rev-parse', 'HEAD');
    }
  };
}

test('a fetch Singularity Flow runs, synchronously or not, starts no automatic maintenance', async (t) => {
  if (!await requireObservableMaintenance(t)) return;
  const { clone, publish } = await fetchFixture(t);
  for (const [label, fetch] of [
    ['runRemoteGit', () => runRemoteGit(['fetch', '--quiet', 'origin'], {
      cwd: clone, env: plainEnvironment, operation: 'remote-configuration'
    })],
    ['runRemoteGitAsync', () => runRemoteGitAsync(['fetch', '--quiet', 'origin'], {
      cwd: clone, env: plainEnvironment, operation: 'remote-configuration'
    })]
  ]) {
    const published = await publish(label);
    const fetched = await fetch();
    assert.equal(fetched.status, 0, `${label}: ${fetched.stderr}`);
    assert.equal(git(clone, 'rev-parse', 'origin/main'), published, `${label} did not fetch`);
    assert.equal(maintenanceRan(clone), false, `${label} let \`git fetch\` start automatic maintenance`);
  }
});

test('the VS Code host\'s own Git fetch starts no automatic maintenance', async (t) => {
  if (!await requireObservableMaintenance(t)) return;
  const { remoteGit } = await import('../apps/vscode/src/cli/runner.ts');
  const { clone, publish } = await fetchFixture(t);
  const published = await publish('vscode');
  const fetched = await remoteGit(['fetch', '--quiet', '--no-tags', '--', 'origin'], { cwd: clone, timeout: 60_000 });
  assert.equal(fetched.status, 0, `remoteGit: ${fetched.failure}`);
  assert.equal(git(clone, 'rev-parse', 'origin/main'), published, 'remoteGit did not fetch');
  assert.equal(maintenanceRan(clone), false, 'the extension\'s remoteGit let `git fetch` start automatic maintenance');
});
