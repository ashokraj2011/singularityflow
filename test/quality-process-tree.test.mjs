import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { endStoppedProcessGroup } from '../src/git-child-groups.mjs';
import { runQualityCommand } from '../src/quality-command-runner.mjs';

const posixOnly = { skip: process.platform === 'win32' };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('quality timeout terminates descendants before reporting completion', posixOnly, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-quality-tree-'));
  const canary = path.join(root, 'descendant-survived');
  const child = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(canary)}, 'bad'), 750); setInterval(() => {}, 1000)`;
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], {stdio:'ignore'}); setInterval(() => {}, 1000)`;
  const result = await runQualityCommand(process.execPath, ['-e', parent], { cwd: root, timeoutMs: 100 });
  assert.equal(result.timedOut, true);
  await new Promise((resolve) => setTimeout(resolve, 900));
  await assert.rejects(access(canary), { code: 'ENOENT' });
});

/*
 * A descendant that holds none of the command's pipes (stdio 'ignore') and traps SIGTERM outlives
 * the command: the command's `close` arrives while it still runs. 2.5 s after the SIGTERM it writes
 * a canary. The command stays until that descendant is in place, so the stop always finds it there.
 */
function trappingDescendantCommand(root) {
  const files = { ready: path.join(root, 'ready'), canary: path.join(root, 'canary') };
  const grandchild = `const fs = require('node:fs');
    process.on('SIGTERM', () => setTimeout(() => fs.writeFileSync(${JSON.stringify(files.canary)}, String(Date.now())), 2500));
    fs.writeFileSync(${JSON.stringify(`${files.ready}.tmp`)}, String(process.pid));
    fs.renameSync(${JSON.stringify(`${files.ready}.tmp`)}, ${JSON.stringify(files.ready)});
    setInterval(() => {}, 1000);`;
  const command = `const fs = require('node:fs');
    let stopped = false;
    const leave = () => { if (stopped && fs.existsSync(${JSON.stringify(files.ready)})) process.exit(143); };
    process.on('SIGTERM', () => { stopped = true; leave(); });
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });
    setInterval(leave, 20);`;
  return { files, args: ['-e', command] };
}

async function assertNothingOutlivedTheReport(files, result) {
  const reportedAt = Date.now();
  const pid = Number(await readFile(files.ready, 'utf8'));
  const runningAtReport = alive(pid);
  try {
    assert.equal(runningAtReport, false, 'a descendant of the stopped command was still running when the run reported');
    await pause(3_000);
    // The canary is due 2.5 s after the stop; the run must not report while anything could still write it.
    const written = await readFile(files.canary, 'utf8').catch(() => null);
    assert.ok(written == null || Number(written) < reportedAt, 'a descendant wrote after the run reported');
    assert.equal(result.stdout, '');
  } finally {
    if (alive(pid)) process.kill(pid, 'SIGKILL');
  }
}

test('a timed-out quality command reports only once a descendant that traps SIGTERM is gone', posixOnly, async () => {
  // The deadline can find the command still starting, before its descendant exists; a longer one is
  // then tried, so the test never passes without the descendant it is about.
  for (const timeoutMs of [300, 1_500, 6_000]) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-quality-trap-'));
    const { files, args } = trappingDescendantCommand(root);
    const result = await runQualityCommand(process.execPath, args, { cwd: root, timeoutMs });
    assert.equal(result.timedOut, true);
    if (!await access(files.ready).then(() => true, () => false)) continue;
    await assertNothingOutlivedTheReport(files, result);
    return;
  }
  assert.fail('the command never had its descendant in place before its deadline');
});

test('an aborted quality command reports only once a descendant that traps SIGTERM is gone', posixOnly, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-quality-trap-'));
  const { files, args } = trappingDescendantCommand(root);
  const controller = new AbortController();
  const running = runQualityCommand(process.execPath, args, { cwd: root, timeoutMs: 60_000, signal: controller.signal });
  while (!await access(files.ready).then(() => true, () => false)) await pause(20);
  controller.abort();
  const result = await running;
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
  await assertNothingOutlivedTheReport(files, result);
});

test('a stopped group is ended once its leader closed, and only a real child names a group', posixOnly, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-quality-trap-'));
  const { files, args } = trappingDescendantCommand(root);
  const leader = spawn(process.execPath, args, { cwd: root, detached: true, stdio: 'ignore' });
  const closed = new Promise((resolve) => leader.once('close', resolve));
  while (!await access(files.ready).then(() => true, () => false)) await pause(20);
  process.kill(-leader.pid, 'SIGTERM');
  await closed;
  const pid = Number(await readFile(files.ready, 'utf8'));
  // A test double carrying a live group's ID is never mistaken for that group: nothing is signalled.
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  try {
    assert.equal(alive(pid), true, 'the descendant traps SIGTERM, so it outlives its leader');
    assert.equal(await endStoppedProcessGroup(leader), true);
    assert.equal(alive(pid), false);
    assert.equal(await endStoppedProcessGroup({ pid: bystander.pid }), true);
    assert.equal(alive(bystander.pid), true);
  } finally {
    if (alive(pid)) process.kill(pid, 'SIGKILL');
    process.kill(-bystander.pid, 'SIGKILL');
  }
});
