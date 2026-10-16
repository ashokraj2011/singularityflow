import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run, networkDisabled } from '../src/util.mjs';
import { readLocalGitAsync } from '../src/git-execution.mjs';
import { withCommandTiming } from '../src/dx-timing-context.mjs';

test('closed async local reads work offline, return exact identity and are never counted as remote probes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-local-async-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await writeFile(path.join(root, 'file.txt'), 'fixture');
  run('git', ['add', '.'], { cwd: root });
  run('git', ['-c', 'user.name=Read Fixture', '-c', 'user.email=read@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root });
  const expected = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
  const counters = {}, env = { ...process.env, SINGULARITY_FLOW_NO_NETWORK: '1' };
  assert.equal(networkDisabled(env), true);
  const result = await withCommandTiming({ increment(name, amount = 1) { counters[name] = (counters[name] ?? 0) + amount; } },
    () => readLocalGitAsync('repository.identity', root, { env }));
  assert.equal(result.status, 0);
  assert.deepEqual(result.stdout.trimEnd().split(/\r?\n/u).slice(2), [expected, 'refs/heads/main']);
  assert.equal(counters['git.local.async-reads'], 1);
  assert.equal(counters['git.remote.total'] ?? 0, 0);
  assert.ok(counters['git.spawns'] >= 1, 'the descriptor execution is counted as a spawn');
});

test('unknown async descriptors and pre-cancelled requests cannot execute caller supplied Git operations', async () => {
  await assert.rejects(readLocalGitAsync('push', process.cwd()), { code: 'LOCAL_GIT_READ_UNSUPPORTED' });
  await assert.rejects(readLocalGitAsync('repository.identity'), { code: 'LOCAL_GIT_READ_ROOT_REQUIRED' });
  await assert.rejects(readLocalGitAsync('repository.identity', '.'), { code: 'LOCAL_GIT_READ_ROOT_REQUIRED' });
  const controller = new AbortController(); controller.abort('private reason');
  await assert.rejects(readLocalGitAsync('repository.identity', process.cwd(), { signal: controller.signal }),
    error => error.code === 'READ_CANCELLED' && !error.message.includes('private'));
});

test('the async identity read honours the same Git configuration as the synchronous reads it is compared with', async t => {
  // A repository Git treats as owned by someone else, trusted only by the user's global safe.directory.
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-local-async-owner-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  await writeFile(path.join(base, 'global.gitconfig'), '[safe]\n\tdirectory = *\n');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(base, 'global.gitconfig'), GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' };
  run('git', ['init', '-q', '-b', 'main', root], { cwd: base, env });
  run('git', ['-c', 'user.name=Read Fixture', '-c', 'user.email=read@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'fixture'], { cwd: root, env });
  const expected = run('git', ['rev-parse', 'HEAD'], { cwd: root, env }).stdout.trim();
  const untrusted = run('git', ['rev-parse', 'HEAD'], { cwd: root, env: { ...env, GIT_CONFIG_GLOBAL: path.join(base, 'absent') }, allowFailure: true });
  assert.notEqual(untrusted.status, 0, 'without the global trust Git refuses this repository');
  const result = await readLocalGitAsync('repository.identity', root, { env });
  assert.equal(result.stdout.trimEnd().split(/\r?\n/u)[2], expected);
});
