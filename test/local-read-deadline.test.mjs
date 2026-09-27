import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { withLocalReadDeadline, localReadDeadlineRemainingMs, localReadDeadlineSignal } from '../src/local-read-deadline.mjs';
import { run } from '../src/util.mjs';
import { runRemoteGitAsync } from '../src/git-execution.mjs';
import { enterpriseGitEnvironment } from '../src/git-enterprise-environment.mjs';

test('local read deadlines are invocation-local, nested absolute and never widen their parent', async () => {
  assert.equal(localReadDeadlineRemainingMs(), null);
  await withLocalReadDeadline(500, async () => {
    const first = localReadDeadlineRemainingMs();
    await delay(10);
    await withLocalReadDeadline(120_000, async () => {
      assert.ok(localReadDeadlineRemainingMs() < first);
      assert.ok(localReadDeadlineRemainingMs() <= 500);
    });
    assert.ok(localReadDeadlineRemainingMs() < first);
  });
  assert.equal(localReadDeadlineRemainingMs(), null);
  assert.equal(localReadDeadlineSignal(), null);
  const [short, ordinary] = await Promise.all([
    withLocalReadDeadline(500, async () => { await delay(5); return localReadDeadlineRemainingMs(); }),
    (async () => { await delay(5); return localReadDeadlineRemainingMs(); })()
  ]);
  assert.ok(short <= 500); assert.equal(ordinary, null);
});

test('deadline admission rejects hooks and invalid durations without invoking a callback', async () => {
  let invoked = false;
  for (const duration of [0, -1, 120_001, Infinity, '500', { valueOf() { throw new Error('hook'); } }]) {
    await assert.rejects(withLocalReadDeadline(duration, () => { invoked = true; }), TypeError);
  }
  assert.equal(invoked, false);
});

test('expired sync and async Git reads refuse before process launch; scopes do not leak on failure', async () => {
  let spawned = false;
  await assert.rejects(withLocalReadDeadline(5, async () => {
    await delay(15);
    assert.equal(localReadDeadlineSignal().aborted, true);
    assert.throws(() => run('git', ['--version'], { spawnSyncCommand() { spawned = true; } }),
      { code: 'LOCAL_READ_DEADLINE_EXCEEDED' });
    await assert.rejects(runRemoteGitAsync(['--version'], { operation: 'local-read', spawnCommand() { spawned = true; } }),
      { code: 'LOCAL_READ_DEADLINE_EXCEEDED' });
  }), { code: 'LOCAL_READ_DEADLINE_EXCEEDED' });
  assert.equal(spawned, false);
  assert.equal(localReadDeadlineRemainingMs(), null);
});

test('legacy sync reads use the remaining ceiling and hard kill; ordinary calls preserve defaults', async () => {
  const seen = [];
  const runner = (_command, _args, options) => {
    seen.push({ timeout: options.timeout, killSignal: options.killSignal });
    return { status: 0, stdout: 'git version fixture\n', stderr: '' };
  };
  await withLocalReadDeadline(500, async () => {
    run('git', ['--version'], { timeoutMs: 20_000, spawnSyncCommand: runner });
    run('git', ['--version'], { timeoutMs: 10, spawnSyncCommand: runner });
    run('git', ['--version'], { spawnSyncCommand: runner });
    run('git', ['--version'], { timeoutMs: null, spawnSyncCommand: runner });
    run('git', ['--version'], { timeoutMs: 0, spawnSyncCommand: runner });
  });
  run('git', ['--version'], { timeoutMs: 20_000, spawnSyncCommand: runner });
  assert.ok(seen[0].timeout > 0 && seen[0].timeout <= 500);
  assert.equal(seen[0].killSignal, 'SIGKILL');
  assert.equal(seen[1].timeout, 10);
  assert.ok(seen[2].timeout > 0 && seen[2].timeout <= 500, 'legacy undefined timeout is tightened, not converted to NaN');
  assert.ok(seen[3].timeout > 0 && seen[3].timeout <= 500, 'null must not become a zero, unbounded timeout');
  assert.ok(seen[4].timeout > 0 && seen[4].timeout <= 500, 'zero must not disable the enclosing deadline');
  assert.deepEqual(seen[5], { timeout: 20_000, killSignal: 'SIGTERM' });
});

test('scoped sync timeout values refuse coercion and invalid ceilings before child launch', async () => {
  let spawned = false;
  let coerced = false;
  await withLocalReadDeadline(500, async () => {
    for (const timeoutMs of [-1, NaN, Infinity, '10', { valueOf() { coerced = true; return 10; } }]) {
      assert.throws(() => run('git', ['--version'], {
        timeoutMs, spawnSyncCommand() { spawned = true; }
      }), { code: 'LOCAL_READ_TIMEOUT_INVALID' });
    }
  });
  assert.equal(spawned, false);
  assert.equal(coerced, false);
});

test('narrow sync timeout, signal and overflow retain cleanup uncertainty before the aggregate deadline', async () => {
  const outcomes = [
    { status: null, error: Object.assign(new Error('fixture timeout'), { code: 'ETIMEDOUT' }), signal: 'SIGKILL' },
    { status: null, signal: 'SIGKILL' },
    { status: null, error: Object.assign(new Error('fixture overflow'), { code: 'ENOBUFS' }) },
    { status: 1, outputOverflow: true }
  ];
  await withLocalReadDeadline(500, async () => {
    for (const [index, outcome] of outcomes.entries()) {
      assert.throws(() => run('git', ['--version'], {
        timeoutMs: 10, allowFailure: true,
        spawnSyncCommand() { return { stdout: '', stderr: '', ...outcome }; }
      }), (error) => error.temporaryGitCleanupUnproven === true
        && error.code === (index === 0 ? 'SUBPROCESS_TIMEOUT' : index === 1 ? 'SUBPROCESS_INTERRUPTED' : 'SUBPROCESS_OUTPUT_TOO_LARGE'));
      assert.ok(localReadDeadlineRemainingMs() > 0, 'the narrower child bound, not the aggregate budget, fired');
    }
  });
  const ordinary = run('git', ['--version'], {
    timeoutMs: 10, allowFailure: true,
    spawnSyncCommand() { return { stdout: '', stderr: '', ...outcomes[0] }; }
  });
  assert.equal(ordinary.timedOut, true, 'ordinary callers retain their existing result contract');
});

test('async local Git admission cannot reset a shared deadline exhausted during launcher lookup', async () => {
  let spawned = false;
  const env = enterpriseGitEnvironment({
    SystemRoot: 'C:\\Windows', PATH: 'C:\\Program Files\\Git\\cmd', PATHEXT: '.EXE'
  }, { runCommand() { return { status: 1, stdout: '', stderr: '' }; } });
  await assert.rejects(withLocalReadDeadline(10, async () => {
    const result = await runRemoteGitAsync(['--version'], {
      operation: 'local-read', platform: 'win32',
      cwd: 'C:\\workspaces\\repository',
      env,
      timeoutMs: null,
      platformLookupCommand() {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        return { status: 0, stdout: 'C:\\Program Files\\Git\\cmd\\git.exe\r\n', stderr: '' };
      },
      spawnCommand() { spawned = true; throw new Error('expired admission must not spawn'); }
    });
    assert.equal(result.timedOut, true);
  }), { code: 'LOCAL_READ_DEADLINE_EXCEEDED' });
  assert.equal(spawned, false);
});

test('late synchronous read completion cannot return success after consuming the shared budget', async () => {
  await assert.rejects(withLocalReadDeadline(10, () => run('git', ['--version'], {
    spawnSyncCommand() {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      return { status: 0, stdout: 'late success\n', stderr: '' };
    }
  })), (error) => error.code === 'LOCAL_READ_DEADLINE_EXCEEDED' && error.temporaryGitCleanupUnproven === true);
});
