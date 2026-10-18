import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runRemoteGitAsync } from '../src/git-execution.mjs';
import { withUnansweredRemoteReuse } from '../src/git-child-groups.mjs';
import { fetchOrigin, pullFastForward } from '../src/git.mjs';

/**
 * Remote Git that waits says so, a session command does not probe a remote that just went
 * unanswered a second time, and a watch that has just fetched fast-forwards locally instead of
 * pulling again.
 */
const posix = process.platform !== 'win32';
const quiet = { ...process.env, SINGULARITY_FLOW_GIT_STORAGE_CHECK: 'off' };

async function silentRemote(t) {
  const sockets = new Set();
  const server = net.createServer((socket) => { sockets.add(socket); socket.on('error', () => {}); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}/silent.git`, host: `127.0.0.1:${server.address().port}` };
}

function probeInChild(url, env) {
  const moduleUrl = new URL('../src/git-execution.mjs', import.meta.url).href;
  const script = `const { runRemoteGitAsync } = await import(${JSON.stringify(moduleUrl)});
    await runRemoteGitAsync(['ls-remote', ${JSON.stringify(url)}], { operation: 'remote-probe', timeoutMs: 1500 });`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', () => resolve({ stdout, stderr }));
  });
}

test('a waiting Git child reports on the terminal, and stays silent when output is piped', { skip: !posix }, async (t) => {
  const remote = await silentRemote(t);
  const reported = await probeInChild(remote.url, { ...quiet, SINGULARITY_FLOW_GIT_PROGRESS: 'always', SINGULARITY_FLOW_GIT_PROGRESS_AFTER_MS: '200' });
  assert.ok(reported.stderr.includes(`sflow: still waiting for Git ls-remote (${remote.host}) after 0 s (it stops by itself at 2 s).`), reported.stderr);
  assert.equal(reported.stdout, '', 'stdout is never used for it');
  const piped = await probeInChild(remote.url, { ...quiet, SINGULARITY_FLOW_GIT_PROGRESS_AFTER_MS: '200' });
  assert.doesNotMatch(piped.stderr, /still waiting/, 'a pipe is not a terminal, so nothing is added');
});

test('inside a session command, a remote that just left a probe unanswered is not probed again', { skip: !posix }, async (t) => {
  const remote = await silentRemote(t);
  const probe = () => runRemoteGitAsync(['ls-remote', remote.url], { operation: 'remote-probe', timeoutMs: 800, env: quiet, terminationGraceMs: 100 });
  await withUnansweredRemoteReuse(async () => {
    const first = await probe();
    assert.equal(first.timedOut, true);
    const started = performance.now();
    const second = await probe();
    assert.ok(performance.now() - started < 300, 'answered from the first timeout');
    assert.equal(second.timedOut, true);
    assert.equal(second.failure.classification, 'operation-timeout');
    assert.match(second.failure.advice, /did not answer a probe earlier in this command, so it was not asked again/);
  });
  // Outside that scope (publication, retries) every probe still asks the remote.
  const started = performance.now();
  const outside = await probe();
  assert.ok(performance.now() - started >= 700, 'outside the scope the remote is asked again');
  assert.equal(outside.timedOut, true);
});

test('after a fetch, the upstream is fast-forwarded locally; a diverged branch still refuses', { skip: !posix }, async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-remote-repeats-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = { ...quiet, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Repeat Tester',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'repeat.tester@example.invalid' };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  const remote = path.join(base, 'remote.git');
  const root = path.join(base, 'root');
  const other = path.join(base, 'other');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(base, 'clone', '-q', remote, root);
  await writeFile(path.join(root, 'a.txt'), 'one\n');
  git(root, 'add', 'a.txt');
  git(root, 'commit', '-q', '-m', 'one');
  git(root, 'push', '-q', '-u', 'origin', 'main');
  git(base, 'clone', '-q', remote, other);
  await writeFile(path.join(other, 'b.txt'), 'two\n');
  git(other, 'add', 'b.txt');
  git(other, 'commit', '-q', '-m', 'two');
  git(other, 'push', '-q', 'origin', 'main');

  await fetchOrigin(root);
  // The remote is gone after the fetch: only a local fast-forward can still succeed.
  await rename(remote, `${remote}.away`);
  await pullFastForward(root, { fetchedRemote: 'origin' });
  assert.equal(git(root, 'rev-parse', 'HEAD'), git(other, 'rev-parse', 'HEAD'));
  await rename(`${remote}.away`, remote);

  await writeFile(path.join(root, 'local.txt'), 'local\n');
  git(root, 'add', 'local.txt');
  git(root, 'commit', '-q', '-m', 'local');
  await writeFile(path.join(other, 'c.txt'), 'three\n');
  git(other, 'add', 'c.txt');
  git(other, 'commit', '-q', '-m', 'three');
  git(other, 'push', '-q', 'origin', 'main');
  await fetchOrigin(root);
  const localHead = git(root, 'rev-parse', 'HEAD');
  await assert.rejects(pullFastForward(root, { fetchedRemote: 'origin' }), (error) => error.code === 'LOCAL_FAST_FORWARD_FAILED');
  assert.equal(git(root, 'rev-parse', 'HEAD'), localHead, 'nothing was merged');
});
