/** Portable owner-policy tests; synthetic Windows/Linux branches are not native OS qualification. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { isFullyQualifiedWindowsPath, resolveWindowsBatchProcess, resolveWindowsSystemTool } from '../src/platform-process.mjs';
import { signalProcessTree } from '../src/util.mjs';

const windows = Object.freeze({ SystemRoot: 'C:\\Windows' });
function owner() {
  const calls = []; return { calls, child: { pid: 12345, kill(signal) { calls.push(signal); return true; } } };
}
function helper() {
  const child = new EventEmitter(); let kills = 0; let unrefs = 0;
  child.kill = () => { kills += 1; return false; };
  child.unref = () => { unrefs += 1; };
  return { child, counts: () => ({ kills, unrefs }) };
}

test('synthetic Windows cancellation selects only the absolute system utility and fixed shell-free tree arguments', async () => {
  const f = owner(); const h = helper(); const invocations = [];
  const pending = signalProcessTree(f.child, 'SIGKILL', { platform: 'win32', environment: windows,
    requireTree: true, spawnCommand(command, args, options) {
      invocations.push({ command, args, options }); queueMicrotask(() => h.child.emit('close', 0)); return h.child;
    } });
  assert.equal(await pending, true);
  assert.deepEqual(invocations, [{ command: 'C:\\Windows\\System32\\taskkill.exe', args: ['/PID', '12345', '/T', '/F'],
    options: { shell: false, stdio: 'ignore', windowsHide: true } }]);
  assert.deepEqual(f.calls, []); assert.deepEqual(h.counts(), { kills: 0, unrefs: 0 });
});

test('synthetic Windows timeout detaches an unclosed cleanup helper and refuses strict tree assurance', async () => {
  const f = owner(); const h = helper(); const began = Date.now();
  const accepted = await signalProcessTree(f.child, 'SIGKILL', { platform: 'win32', environment: windows,
    requireTree: true, timeoutMs: 5, spawnCommand: () => h.child });
  assert.equal(accepted, false, 'direct child signal acceptance cannot establish tree termination');
  assert.ok(Date.now() - began < 2000); assert.deepEqual(f.calls, ['SIGKILL']);
  assert.deepEqual(h.counts(), { kills: 1, unrefs: 1 });
  assert.equal(h.child.listenerCount('error'), 1);
  assert.doesNotThrow(() => h.child.emit('error', new Error('late private system diagnostic')));
  h.child.emit('close', 1); assert.equal(h.child.listenerCount('error'), 0);
});

test('synthetic Windows utility errors and missing trusted SystemRoot never claim successful tree containment', async () => {
  for (const mode of ['error', 'nonzero', 'throw', 'no-root']) {
    const f = owner(); const h = helper(); let spawns = 0;
    const accepted = await signalProcessTree(f.child, 'SIGTERM', { platform: 'win32',
      environment: mode === 'no-root' ? {} : windows, requireTree: true, spawnCommand() {
        spawns += 1; if (mode === 'throw') throw Error('private spawn error');
        queueMicrotask(() => h.child.emit(mode === 'error' ? 'error' : 'close', mode === 'error' ? Error('private') : 1));
        return h.child;
      } });
    assert.equal(accepted, false); assert.deepEqual(f.calls, ['SIGTERM']);
    assert.equal(spawns, mode === 'no-root' ? 0 : 1);
    if (mode === 'error') { assert.equal(h.counts().unrefs, 1); h.child.emit('close', 1); }
  }
});

test('Linux/POSIX policy signals the exact detached group; direct fallback remains explicitly weaker', async () => {
  const f = owner(); const groups = [];
  assert.equal(await signalProcessTree(f.child, 'SIGKILL', { platform: 'linux', requireTree: true,
    killProcess(pid, signal) { groups.push([pid, signal]); } }), true);
  assert.deepEqual(groups, [[-12345, 'SIGKILL']]); assert.deepEqual(f.calls, []);
  for (const requireTree of [false, true]) {
    const absent = owner();
    assert.equal(await signalProcessTree(absent.child, 'SIGTERM', { platform: 'linux', requireTree,
      killProcess() { throw Object.assign(Error('group absent'), { code: 'ESRCH' }); } }), !requireTree);
    assert.deepEqual(absent.calls, ['SIGTERM']);
  }
});

test('invalid child PID cannot launch a Windows utility or qualify a Linux process group', async () => {
  for (const platform of ['win32', 'linux']) for (const pid of [0, -1, NaN, 'not-a-pid']) {
    let calls = 0;
    assert.equal(await signalProcessTree({ pid, kill: () => true }, 'SIGTERM', { platform, environment: windows,
      requireTree: true, spawnCommand: () => { calls += 1; throw Error('must not spawn'); },
      killProcess: () => { calls += 1; } }), false);
    assert.equal(calls, 0);
  }
});

test('Windows path policy distinguishes drive/UNC identities from relative, device and expansion aliases', () => {
  for (const value of ['C:\\Program Files\\工具\\runner.cmd', '\\\\server\\share\\folder\\runner.cmd']) {
    assert.equal(isFullyQualifiedWindowsPath(value), true);
    const launch = resolveWindowsBatchProcess(value, ['literal spaces', '雪', 'x&y'], { environment: windows });
    assert.equal(launch.executable, 'C:\\Windows\\System32\\cmd.exe');
    assert.deepEqual(launch.spawnOptions, { shell: false, windowsVerbatimArguments: true });
    assert.deepEqual(launch.arguments.slice(0, 4), ['/d', '/s', '/v:off', '/c']);
  }
  for (const value of ['C:runner.cmd', '\\runner.cmd', '.\\runner.cmd', '\\\\?\\C:\\runner.cmd', '\\\\.\\runner.cmd']) {
    assert.equal(isFullyQualifiedWindowsPath(value), false);
    assert.throws(() => resolveWindowsBatchProcess(value, [], { environment: windows }));
  }
  for (const value of ['C:\\%TEMP%\\runner.cmd', 'C:\\bang!\\runner.cmd']) {
    assert.throws(() => resolveWindowsBatchProcess(value, [], { environment: windows }));
  }
  assert.throws(() => resolveWindowsSystemTool({ SystemRoot: 'C:Windows' }, 'taskkill.exe'));
  assert.throws(() => resolveWindowsSystemTool({ SystemRoot: '\\\\server\\share' }, 'taskkill.exe'));
});
