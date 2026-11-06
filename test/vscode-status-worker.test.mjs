/**
 * One window keeps at most one status worker, and none once it closes. A timed-out read used to send
 * SIGTERM and start the next worker at once, so every worker the signal did not stop stayed: ten in one
 * window under load. These run the real client against a real process that SIGTERM does not stop.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GatewayStatusWorker } from '../apps/vscode/src/gateway-status-worker-client.ts';

const STUBBORN = `process.on('SIGTERM', () => {});
process.on('message', () => {});
process.on('disconnect', () => process.exit(0));
setInterval(() => {}, 1000);
`;
const ANSWERS = `process.on('message', (request) => process.send({ id: request.id, value: { gates: null, recoveryWorkId: null, decisions: 2, leads: null } }));
process.on('disconnect', () => process.exit(0));
`;
const TIMING = { readTimeoutMs: 150, stopGraceMs: 150, wedgedBackoffMs: 0 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The client unreferences its timers and worker, so that they follow the host; this file is the host.
const host = setInterval(() => {}, 1000);
test.after(() => clearInterval(host));

async function fixture(t, script) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-status-worker-'));
  await mkdir(path.join(root, 'dist'));
  await writeFile(path.join(root, 'dist', 'gateway-status-worker.cjs'), script);
  const alive = () => execFileSync('ps', ['axww', '-o', 'pid=,command=']).toString().split('\n')
    .filter((line) => line.includes(path.join(root, 'dist', 'gateway-status-worker.cjs'))).map((line) => Number(line.trim().split(/\s+/u)[0]));
  t.after(async () => {
    for (const pid of alive()) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ } }
    await rm(root, { recursive: true, force: true });
  });
  return { root, alive };
}

async function until(condition, what, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(50);
  }
  assert.fail(`Timed out waiting: ${what}`);
}

test('a worker SIGTERM does not stop is killed, and no second one starts until it has gone', async (t) => {
  const { root, alive } = await fixture(t, STUBBORN);
  const client = new GatewayStatusWorker(root, TIMING);
  t.after(() => client.dispose());
  let most = 0;
  for (let round = 0; round < 6; round += 1) {
    assert.equal(await client.read({ root: '/x' }, null, 'today'), null);
    most = Math.max(most, alive().length);
    await sleep(120);
    most = Math.max(most, alive().length);
  }
  assert.equal(most, 1, 'a window never has more than one worker');
  await until(() => alive().length <= 1, 'the last stopped worker to go');
});

test('a read while the last worker is still going answers nothing and starts nothing', async (t) => {
  const { root, alive } = await fixture(t, STUBBORN);
  const client = new GatewayStatusWorker(root, { ...TIMING, stopGraceMs: 400 });
  t.after(() => client.dispose());
  assert.equal(await client.read({ root: '/x' }, null, 'today'), null);
  assert.equal(alive().length, 1, 'the first is still going: SIGTERM did not stop it');
  assert.equal(await client.read({ root: '/x' }, null, 'today'), null);
  assert.equal(alive().length, 1);
  await until(() => alive().length === 0, 'the kill after the grace to land');
});

test('after a wedged read the next waits out its backoff, and then reads again', async (t) => {
  const { root, alive } = await fixture(t, STUBBORN);
  const client = new GatewayStatusWorker(root, { ...TIMING, wedgedBackoffMs: 60_000 });
  t.after(() => client.dispose());
  assert.equal(await client.read({ root: '/x' }, null, 'today'), null);
  await until(() => alive().length === 0, 'the wedged worker to go');
  assert.equal(await client.read({ root: '/x' }, null, 'today'), null, 'a read in its backoff asks nothing');
  assert.equal(alive().length, 0, 'and starts nothing');
  client.notBefore = 0;
  const pending = client.read({ root: '/x' }, null, 'today');
  assert.equal(alive().length, 1, 'once the backoff is over it reads again');
  assert.equal(await pending, null);
});

test('an error on a live worker stops that worker before the next starts', async (t) => {
  const { root, alive } = await fixture(t, STUBBORN);
  const client = new GatewayStatusWorker(root, { ...TIMING, readTimeoutMs: 60_000 });
  t.after(() => client.dispose());
  const pending = client.read({ root: '/x' }, null, 'today');
  assert.equal(alive().length, 1);
  client.worker.emit('error', new Error('write ENOBUFS'));
  assert.equal(await pending, null);
  assert.equal(await client.read({ root: '/x' }, null, 'today'), null);
  assert.ok(alive().length <= 1, 'never a second while the first is going');
  await until(() => alive().length === 0, 'the worker the error left behind to be killed');
});

test('closing the window ends every worker at once, whatever it does with SIGTERM', async (t) => {
  const { root, alive } = await fixture(t, STUBBORN);
  const client = new GatewayStatusWorker(root, { ...TIMING, readTimeoutMs: 60_000 });
  client.read({ root: '/x' }, null, 'today');
  await until(() => alive().length === 1, 'the worker to start');
  client.dispose();
  await until(() => alive().length === 0, 'the worker to end', 2_000);
  assert.equal(await client.read({ root: '/x' }, null, 'today'), null, 'a closed window starts nothing');
  assert.equal(alive().length, 0);
});

test('the real worker ends with its host, and a healthy one is kept and reused', async (t) => {
  const { root, alive } = await fixture(t, ANSWERS);
  const client = new GatewayStatusWorker(root, TIMING);
  t.after(() => client.dispose());
  for (let round = 0; round < 3; round += 1) assert.equal((await client.read({ root: '/x' }, null, 'today'))?.decisions, 2);
  assert.equal(alive().length, 1);
});
