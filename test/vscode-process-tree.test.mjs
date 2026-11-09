import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { invokeCli, localGit, remoteGit } from '../apps/vscode/src/cli/runner.ts';

const posixOnly = { skip: process.platform === 'win32' };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exists = (file) => access(file).then(() => true, () => false);

/*
 * The extension's runners stop a child by signalling its process group, and `close` proves only that
 * the leader's pipes closed. This grandchild holds none of them (stdio 'ignore'), traps SIGTERM and
 * writes a canary 2.5 s after the stop. The leader stays until the grandchild is in place, so the
 * stop always finds it there (the same command as test/quality-process-tree.test.mjs).
 */
async function trappingDescendantCommand() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-tree-'));
  const files = { ready: path.join(root, 'ready'), canary: path.join(root, 'canary'), script: path.join(root, 'leader.cjs') };
  const grandchild = `const fs = require('node:fs');
    process.on('SIGTERM', () => setTimeout(() => fs.writeFileSync(${JSON.stringify(files.canary)}, String(Date.now())), 2500));
    fs.writeFileSync(${JSON.stringify(`${files.ready}.tmp`)}, String(process.pid));
    fs.renameSync(${JSON.stringify(`${files.ready}.tmp`)}, ${JSON.stringify(files.ready)});
    setInterval(() => {}, 1000);`;
  await writeFile(files.script, `const fs = require('node:fs');
    let stopped = false;
    const leave = () => { if (stopped && fs.existsSync(${JSON.stringify(files.ready)})) process.exit(143); };
    process.on('SIGTERM', () => { stopped = true; leave(); });
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });
    setInterval(leave, 20);\n`);
  return { root, files };
}

/** Each runner, stopped by its signal once the grandchild is in place; resolves the runner's report. */
const RUNNERS = {
  remoteGit: ({ root, files }, signal) => remoteGit(['fetch'], {
    cwd: root, timeout: 60_000, signal, spawnImpl: (_git, _args, options) => spawn(process.execPath, [files.script], options)
  }),
  localGit: ({ root, files }, signal) => localGit(['cat-file', '--batch'], {
    cwd: root, timeout: 60_000, signal, spawnImpl: (_git, _args, options) => spawn(process.execPath, [files.script], options)
  }),
  invokeCli: ({ root, files }, signal) => {
    const timings = [];
    return invokeCli({
      executable: process.execPath, cli: files.script, repository: root, args: [], json: false,
      timeoutMs: null, signal, onTiming: (event) => timings.push(event)
    }).then(() => assert.fail('a cancelled CLI call must reject'), (error) => ({
      failure: /cancelled/.test(error.message) ? 'cancelled' : error.message, cleanupStatus: timings[0]?.cleanupStatus
    }));
  }
};

for (const [name, run] of Object.entries(RUNNERS)) {
  test(`${name} reports a cancelled child closed only once its descendant that traps SIGTERM is gone`, posixOnly, async () => {
    const fixture = await trappingDescendantCommand();
    const controller = new AbortController();
    const running = run(fixture, controller.signal);
    while (!await exists(fixture.files.ready)) await pause(20);
    controller.abort();
    const result = await running;
    const reportedAt = Date.now();
    const pid = Number(await readFile(fixture.files.ready, 'utf8'));
    const runningAtReport = alive(pid);
    try {
      assert.equal(result.failure, 'cancelled');
      assert.equal(runningAtReport, false, 'a descendant of the stopped child was still running when the runner reported');
      assert.equal(result.cleanupStatus, 'closed');
      await pause(3_000);
      // The canary is due 2.5 s after the stop; nothing may still be able to write it once the runner reported.
      const written = await readFile(fixture.files.canary, 'utf8').catch(() => null);
      assert.ok(written == null || Number(written) < reportedAt, 'a descendant wrote after the runner reported');
    } finally {
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
  });
}

test('a stopped group that outlives the sweep is reported unknown, not closed', posixOnly, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-tree-'));
  let leader;
  // The group answers EPERM as long as it lives: it counts as alive, so the sweep gives up at its limit.
  const kill = process.kill;
  t.after(() => { process.kill = kill; if (leader?.pid) try { kill(-leader.pid, 'SIGKILL'); } catch { /* gone */ } });
  process.kill = (pid, signal) => {
    if (leader && pid === -leader.pid) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    return kill.call(process, pid, signal);
  };
  const controller = new AbortController();
  const running = localGit(['cat-file', '--batch'], {
    cwd: root, timeout: 60_000, signal: controller.signal,
    spawnImpl: (_git, _args, options) => { leader = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options); return leader; }
  });
  while (!leader?.pid) await pause(5);
  controller.abort();
  const startedAt = Date.now();
  const result = await running;
  assert.equal(result.failure, 'cancelled');
  assert.equal(leader.exitCode !== null || leader.signalCode !== null, true, 'the leader itself was stopped');
  assert.equal(result.cleanupStatus, 'unknown', 'a group still answering after the sweep is not reported closed');
  assert.ok(Date.now() - startedAt < 6_000, 'the sweep is bounded');
});

test('a test double carrying a live group ID is never signalled as that group', posixOnly, async (t) => {
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-bystander.pid, 'SIGKILL'); } catch { /* gone */ } });
  const double = new EventEmitter();
  Object.assign(double, { pid: bystander.pid, exitCode: null, signals: [], unref() {},
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  double.kill = (signal) => { double.signals.push(signal); queueMicrotask(() => double.emit('close', null)); return true; };
  const controller = new AbortController();
  const running = localGit(['cat-file', '--batch'], { cwd: '.', timeout: 60_000, signal: controller.signal, spawnImpl: () => double });
  controller.abort();
  const result = await running;
  assert.equal(result.failure, 'cancelled');
  assert.equal(result.cleanupStatus, 'closed');
  assert.ok(double.signals.includes('SIGTERM'), 'the double is stopped through its own kill()');
  await pause(100);
  assert.equal(alive(bystander.pid), true, 'the group whose ID the double carries was never signalled');
});
