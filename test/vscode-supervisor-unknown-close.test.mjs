import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { CliTimeoutError, invokeCli, localGit, remoteGit } from '../apps/vscode/src/cli/runner.ts';

function supervisedChild({ closeAfterKill = false, succeed = false } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signals = [];
  child.unrefCount = 0;
  child.unref = () => { child.unrefCount += 1; };
  let closeScheduled = false;
  child.kill = (signal) => {
    child.signals.push(signal);
    if (closeAfterKill && !closeScheduled) {
      closeScheduled = true;
      queueMicrotask(() => child.emit('close', null));
    }
    return true;
  };
  if (succeed) queueMicrotask(() => {
    child.stdout.write('{}');
    child.exitCode = 0;
    child.emit('close', 0);
  });
  return child;
}

const invoke = (spawnImpl, options = {}) => invokeCli({
  executable: 'fixture', cli: 'fixture', repository: '.', args: ['status', '--json'],
  spawnImpl, ...options
});

function assertReleasedUnknownChild(child) {
  assert.ok(child.signals.includes('SIGTERM'));
  assert.ok(child.signals.includes('SIGKILL'));
  assert.equal(child.unrefCount, 1, 'an unconfirmed process handle cannot retain the host');
  assert.equal(child.listenerCount('close'), 0, 'all invocation-capturing close listeners are detached');
  assert.equal(child.listenerCount('error'), 1, 'only the non-capturing late-error guard remains');
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    assert.equal(stream.destroyed, true, 'held pipes are destroyed before settlement');
    assert.equal(stream.listenerCount('data'), 0, 'output closures cannot retain invocation buffers');
    assert.doesNotThrow(() => stream.emit('error', new Error('late broken pipe')));
  }
  assert.doesNotThrow(() => child.emit('error', new Error('late child failure')));
}

test('unknown-close timeout/cancel settlement releases Git and CLI supervision without claiming closure', async () => {
  const cases = [];
  for (const kind of ['remote', 'local', 'cli']) {
    for (const cancelled of [false, true]) {
      const child = supervisedChild();
      const controller = new AbortController();
      const timings = [];
      const outputs = [];
      const options = { signal: controller.signal, spawnImpl: () => child };
      const pending = kind === 'remote'
        ? remoteGit(['status'], { cwd: '.', timeout: cancelled ? 10_000 : 1, ...options })
        : kind === 'local'
          ? localGit(['status'], { cwd: '.', timeout: cancelled ? 10_000 : 1, ...options })
          : invoke(options.spawnImpl, {
            signal: controller.signal, timeoutMs: cancelled ? null : 1,
            onTiming: (event) => timings.push(event), onOutput: (text) => outputs.push(text)
          }).catch((error) => error);
      if (cancelled) controller.abort();
      cases.push({ kind, cancelled, child, timings, outputs, pending });
    }
  }
  const results = await Promise.all(cases.map((entry) => entry.pending));
  for (const [index, entry] of cases.entries()) {
    const result = results[index];
    assertReleasedUnknownChild(entry.child);
    if (entry.kind === 'cli') {
      assert.equal(entry.timings.length, 1);
      assert.equal(entry.timings[0].cleanupStatus, 'unknown');
      assert.equal(entry.timings[0].exitCode, null);
      assert.equal(entry.timings[0].cancelled, entry.cancelled);
      assert.equal(entry.timings[0].outcome, entry.cancelled ? 'cancelled' : 'error');
      if (entry.cancelled) assert.match(result.message, /cancelled/);
      else assert.ok(result instanceof CliTimeoutError);
      entry.child.stdout.emit('data', Buffer.from('PRIVATE-LATE-OUTPUT'));
      entry.child.emit('close', 0);
      assert.equal(entry.timings.length, 1, 'late closure cannot rewrite the settled diagnostic');
      assert.deepEqual(entry.outputs, []);
    } else {
      assert.equal(result.failure, entry.cancelled ? 'cancelled' : 'timeout');
      assert.equal(result.cleanupStatus, 'unknown');
      assert.equal(result.status, null);
    }
  }
});

test('observed closure remains closed and never uses unknown-close detachment', async () => {
  for (const kind of ['remote', 'local', 'cli']) {
    const child = supervisedChild({ closeAfterKill: true });
    const controller = new AbortController();
    const timings = [];
    const options = { signal: controller.signal, spawnImpl: () => child };
    const pending = kind === 'remote'
      ? remoteGit(['status'], { cwd: '.', timeout: 10_000, ...options })
      : kind === 'local'
        ? localGit(['status'], { cwd: '.', timeout: 10_000, ...options })
        : invoke(options.spawnImpl, {
          signal: controller.signal, timeoutMs: null, onTiming: (event) => timings.push(event)
        }).catch((error) => error);
    controller.abort();
    const result = await pending;
    assert.equal(kind === 'cli' ? timings[0].cleanupStatus : result.cleanupStatus, 'closed');
    assert.equal(child.unrefCount, 0);
    assert.equal(child.listenerCount('close'), 0);
    assert.equal(child.stdout.listenerCount('data'), 0);
    assert.equal(child.stderr.listenerCount('data'), 0);
    assert.ok(child.signals.includes('SIGTERM'));
  }
  const child = supervisedChild({ succeed: true });
  const timings = [];
  assert.deepEqual(await invoke(() => child, { onTiming: (event) => timings.push(event) }), {});
  assert.equal(timings[0].cleanupStatus, 'closed');
  assert.equal(timings[0].outcome, 'success');
  assert.equal(child.unrefCount, 0);
});

test('cancel before spawn explicitly reports no started process', async () => {
  const controller = new AbortController();
  controller.abort();
  const timings = [];
  const spawnImpl = () => { throw new Error('must not spawn'); };
  await assert.rejects(invoke(spawnImpl, {
    signal: controller.signal, onTiming: (event) => timings.push(event)
  }), /cancelled/);
  assert.equal(timings[0].cleanupStatus, 'not-started');
  assert.equal((await localGit([], { cwd: '.', timeout: 1, signal: controller.signal, spawnImpl })).cleanupStatus, 'not-started');
  assert.equal((await remoteGit([], { cwd: '.', timeout: 1, signal: controller.signal, spawnImpl })).cleanupStatus, 'not-started');
});
