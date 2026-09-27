import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SingularityFlowClient, CLI_READ_CONCURRENCY, commandClass } from '../apps/vscode/src/cli/client.ts';
import { EventEmitter } from 'node:events';
import { invokeCli, recentCliCommandTimings } from '../apps/vscode/src/cli/runner.ts';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  const end = Date.now() + 10_000;
  while (!(await predicate())) {
    assert.ok(Date.now() < end, 'local child observation timed out');
    await pause(15);
  }
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-map-read-pool-'));
  const log = path.join(directory, 'events.jsonl');
  const cli = path.join(directory, 'fixture.mjs');
  await writeFile(log, '');
  await writeFile(cli, `
    import { appendFileSync } from 'node:fs';
    const emit = (kind) => appendFileSync(${JSON.stringify(log)}, JSON.stringify({ kind, pid: process.pid,
      cwd: process.cwd(), id: process.argv[process.argv.indexOf('--case') + 1] ?? null }) + '\\n');
    emit('start');
    process.on('SIGTERM', () => { emit('stop'); process.exit(0); });
    const index = process.argv.indexOf('--delay');
    await new Promise((resolve) => setTimeout(resolve, index < 0 ? 80 : Number(process.argv[index + 1])));
    emit('end');
    process.stdout.write(JSON.stringify({ pid: process.pid, cwd: process.cwd(), nested: { value: 1 } }));
  `);
  const events = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const client = (options = {}) => new SingularityFlowClient({
    location: { executable: process.execPath, cli, source: 'setting' }, repository: directory, ...options
  });
  t.after(async () => {
    await until(async () => {
      const rows = await events();
      return rows.filter((row) => row.kind === 'start').length
        === rows.filter((row) => row.kind !== 'start').length;
    });
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, client, events };
}

test('workflow proposal inventory is read-only while proposal status and owner reads remain fresh', async (t) => {
  for (const action of ['list', 'proposals', 'proposal', 'proposal-status']) {
    assert.equal(commandClass(['workflow', action]), 'read');
  }
  for (const action of ['publish', 'activate', 'create', 'unknown']) {
    assert.equal(commandClass(['workflow', action]), 'mutation');
  }
  const f = await fixture(t);
  const c = f.client();
  for (const args of [
    ['workflow', 'proposal-status'], ['workflow', 'author', 'read'],
    ['configuration', 'validate'], ['revision', 'attachments', 'status'], ['revision', 'card'],
    ['factory-reset', '--dry-run']
  ]) {
    const [first, second] = await Promise.all([c.run([...args, '--json']), c.run([...args, '--json'])]);
    assert.notEqual(first.pid, second.pid, `${args.join(' ')} must not share prior bytes`);
  }
  const [first, second] = await Promise.all([
    c.run(['workflow', 'proposals', '--json']), c.run(['workflow', 'proposals', '--json'])
  ]);
  assert.equal(first.pid, second.pid);
  second.nested.value = 9;
  assert.equal(first.nested.value, 1, 'subscribers receive independent result objects');
});

test('signal and signal-free subscribers share one read and cancel independently', async (t) => {
  const f = await fixture(t);
  const c = f.client();
  const controller = new AbortController();
  const args = ['capability', 'inspect-repository', 'https://code.example/repo.git', '--delay', '200', '--json'];
  const first = c.run(args, controller.signal).then(() => null, (error) => error);
  const second = c.run(args);
  await until(async () => (await f.events()).some((row) => row.kind === 'start'));
  controller.abort();
  assert.match((await first).message, /cancelled/);
  assert.equal((await second).nested.value, 1);
  const rows = await f.events();
  assert.equal(rows.filter((row) => row.kind === 'start').length, 1);
  assert.equal(rows.filter((row) => row.kind === 'stop').length, 0);
});

test('subscriber deadlines are independent and a later subscriber can finish the shared read', async (t) => {
  const f = await fixture(t);
  const c = f.client();
  const args = ['status', '--delay', '220', '--json'];
  // TypeScript private is intentionally runtime-accessible for this deadline-owner regression.
  const first = c.invoke(args, 140).then(() => null, (error) => error);
  const second = c.invoke(args, 2_000);
  const error = await first;
  assert.equal(error.code, 'SINGULARITY_FLOW_CLI_TIMEOUT');
  assert.match(error.terminalCommand, /status/);
  assert.equal((await second).nested.value, 1);
  assert.equal((await f.events()).filter((row) => row.kind === 'start').length, 1);
});

test('last-subscriber cancellation terminates native work without poisoning a later identical read', async (t) => {
  const f = await fixture(t);
  const c = f.client();
  const a = new AbortController();
  const b = new AbortController();
  const args = ['status', '--delay', '400', '--case', 'cancel-last', '--json'];
  const first = c.run(args, a.signal).then(() => null, (error) => error);
  const second = c.run(args, b.signal).then(() => null, (error) => error);
  await until(async () => (await f.events()).some((row) => row.kind === 'start'));
  a.abort();
  b.abort();
  assert.match((await first).message, /cancelled/);
  assert.match((await second).message, /cancelled/);
  const fresh = c.run(args);
  await until(async () => (await f.events()).some((row) => row.kind === 'stop'));
  assert.equal((await fresh).nested.value, 1);
  assert.equal((await f.events()).filter((row) => row.kind === 'start').length, 2);
});

test('a final subscriber timeout terminates the child and remains an error rather than human cancellation in timing', async (t) => {
  const f = await fixture(t);
  const timings = [];
  const c = f.client({ onTiming: (event) => timings.push(event) });
  const args = ['status', '--delay', '2000', '--json'];
  const anchor = new AbortController();
  const initial = c.invoke(args, 5_000, anchor.signal).then(() => null, (error) => error);
  await until(async () => (await f.events()).some((row) => row.kind === 'start'));
  const result = c.invoke(args, 100).then(() => null, (error) => error);
  anchor.abort();
  assert.match((await initial).message, /cancelled/);
  assert.equal((await result).code, 'SINGULARITY_FLOW_CLI_TIMEOUT');
  await until(() => timings.length === 1);
  assert.equal(timings[0].outcome, 'error');
  assert.equal(timings[0].cancelled, false);
  assert.equal((await f.events()).filter((row) => row.kind === 'stop').length, 1);
});

test('native read concurrency is bounded across separate clients; a queued abort never spawns', async (t) => {
  const f = await fixture(t);
  const pending = Array.from({ length: CLI_READ_CONCURRENCY }, (_, index) =>
    f.client().run(['status', '--delay', '300', '--case', `running-${index}`, '--json']));
  await until(async () => (await f.events()).filter((row) => row.kind === 'start').length === CLI_READ_CONCURRENCY);
  const controller = new AbortController();
  const cancelled = f.client().run(['status', '--case', 'never-spawn', '--json'], controller.signal)
    .then(() => null, (error) => error);
  controller.abort();
  assert.match((await cancelled).message, /cancelled/);
  const trailing = Array.from({ length: 5 }, (_, index) =>
    f.client().run(['status', '--delay', '100', '--case', `trailing-${index}`, '--json']));
  await Promise.all([...pending, ...trailing]);
  let active = 0;
  let maximum = 0;
  for (const row of await f.events()) {
    assert.notEqual(row.id, 'never-spawn');
    active += row.kind === 'start' ? 1 : -1;
    maximum = Math.max(maximum, active);
  }
  assert.equal(active, 0);
  assert.equal(maximum, CLI_READ_CONCURRENCY);
});

test('repository and mutation invalidation reject old reads without clearing a newer flight', async (t) => {
  const f = await fixture(t);
  const c = f.client();
  const args = ['status', '--delay', '220', '--case', 'epoch', '--json'];
  const first = c.run(args).then(() => null, (error) => error);
  await until(async () => (await f.events()).some((row) => row.kind === 'start'));
  c.useRepository(os.tmpdir());
  const second = c.run(args);
  assert.match((await first).message, /superseded/);
  const result = await second;
  assert.equal(result.cwd, await realpath(os.tmpdir()));
  assert.equal((await c.run(args)).pid, result.pid);
  const old = c.run(['status', '--delay', '250', '--case', 'mutation-epoch', '--json'])
    .then(() => null, (error) => error);
  await c.run(['workflow', 'create', '--json']);
  assert.match((await old).message, /superseded/);
  assert.notEqual((await c.run(args)).pid, result.pid, 'a write invalidates previous result reuse');
});

test('silent clients retain copied bounded timing events with sanitized command and subcommand', async (t) => {
  const f = await fixture(t);
  const c = f.client();
  const value = await c.run(['workflow', 'proposal', 'PRIVATE-WORK-ID', '--lead', 'https://code.example/private.git', '--json']);
  assert.equal(value.nested.value, 1);
  const event = recentCliCommandTimings().at(-1);
  assert.equal(event.command, 'workflow');
  assert.equal(event.subcommand, 'proposal');
  assert.doesNotMatch(JSON.stringify(event), /PRIVATE-WORK-ID|private\.git|code\.example/);
  event.command = 'changed-by-reader';
  assert.equal(recentCliCommandTimings().at(-1).command, 'workflow');
  await c.run(['status', 'PRIVATE-WORK-ID', '--json']);
  assert.equal(recentCliCommandTimings().at(-1).subcommand, null);
});

test('timing retention is bounded and unknown command vocabulary cannot leak an argv value', async () => {
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end() {}, write() {} };
    child.exitCode = null;
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('{}'));
      child.exitCode = 0;
      child.emit('close', 0);
    });
    return child;
  };
  for (let index = 0; index < 140; index += 1) await invokeCli({
    executable: 'fixture', cli: 'fixture', repository: '.', args: ['PRIVATE-COMMAND-VALUE', 'PRIVATE-SUBCOMMAND-VALUE'], spawnImpl
  });
  const events = recentCliCommandTimings();
  assert.equal(events.length, 128);
  assert.equal(events.at(-1).command, 'command');
  assert.equal(events.at(-1).subcommand, null);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE-COMMAND-VALUE|PRIVATE-SUBCOMMAND-VALUE/);
});
