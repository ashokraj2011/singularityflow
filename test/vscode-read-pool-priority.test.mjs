/**
 * The shared read pool serves the person waiting first. `[perf]`
 *
 * Activation's background discovery and product checks used to fill the four slots first-come,
 * and the intake form queued behind them — invisibly, because the timing clock started at spawn.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CLI_READ_CONCURRENCY, SingularityFlowClient, defaultReadPriority
} from '../apps/vscode/src/cli/client.ts';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  const end = Date.now() + 10_000;
  while (!(await predicate())) {
    assert.ok(Date.now() < end, 'local child observation timed out');
    await pause(10);
  }
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-read-priority-'));
  const log = path.join(directory, 'events.jsonl');
  const cli = path.join(directory, 'fixture.mjs');
  await writeFile(log, '');
  await writeFile(cli, `
    import { appendFileSync } from 'node:fs';
    const id = process.argv[process.argv.indexOf('--case') + 1];
    const emit = (kind) => appendFileSync(${JSON.stringify(log)}, JSON.stringify({ kind, id, at: Date.now() }) + '\\n');
    emit('start');
    const index = process.argv.indexOf('--delay');
    await new Promise((resolve) => setTimeout(resolve, index < 0 ? 60 : Number(process.argv[index + 1])));
    emit('end');
    process.stdout.write(JSON.stringify({ id }));
  `);
  const events = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const timings = [];
  const client = new SingularityFlowClient({
    location: { executable: process.execPath, cli, source: 'setting' }, repository: directory,
    onTiming: (event) => timings.push(event)
  });
  t.after(async () => {
    await until(async () => {
      const rows = await events();
      return rows.filter((row) => row.kind === 'start').length === rows.filter((row) => row.kind === 'end').length;
    });
    await rm(directory, { recursive: true, force: true });
  });
  return { client, events, timings };
}

const started = (rows, id) => rows.find((row) => row.kind === 'start' && row.id === id);

test('reads a person waits on are interactive and discovery is background by default', () => {
  assert.equal(defaultReadPriority(['workspace', 'branches', '--json', '--intake']), 'interactive');
  assert.equal(defaultReadPriority(['workspace', 'branches', '--json']), 'normal');
  assert.equal(defaultReadPriority(['session', 'candidates', '--json']), 'background');
  assert.equal(defaultReadPriority(['product', 'status', '--json']), 'background');
  assert.equal(defaultReadPriority(['jira', 'status', '--json']), 'background');
  assert.equal(defaultReadPriority(['snapshot', '--json']), 'normal');
});

test('an interactive read starts ahead of queued background reads, on the slot kept for it', async (t) => {
  const f = await fixture(t);
  const background = Array.from({ length: CLI_READ_CONCURRENCY + 1 }, (_, index) =>
    f.client.run(['session', 'candidates', '--json', '--case', `bg-${index}`, '--delay', '400']));
  await until(async () => (await f.events()).filter((row) => row.kind === 'start').length
    >= CLI_READ_CONCURRENCY - 1);
  await pause(60);
  const runningBackground = (await f.events()).filter((row) => row.kind === 'start').length;
  assert.equal(runningBackground, CLI_READ_CONCURRENCY - 1,
    'background reads leave one slot free for interactive work');
  const interactive = f.client.run(['workspace', 'branches', '--json', '--intake', '--case', 'fg']);
  await Promise.all([interactive, ...background]);
  const rows = await f.events();
  const fg = started(rows, 'fg');
  const firstEnd = rows.filter((row) => row.kind === 'end' && row.id.startsWith('bg-'))
    .sort((left, right) => left.at - right.at)[0];
  const waiting = rows.filter((row) => row.kind === 'start' && row.id.startsWith('bg-')
    && row.at > fg.at);
  assert.ok(fg, 'the interactive read ran');
  assert.ok(fg.at < firstEnd.at, 'it did not wait for a background read to finish');
  assert.equal(waiting.length, 2, 'the queued background reads started only after it');
  const fgTiming = f.timings.find((event) => event.command === 'workspace' && event.priority === 'interactive');
  assert.ok(fgTiming, 'the timing record names the priority');
  const queuedBackground = f.timings.filter((event) => event.priority === 'background')
    .map((event) => event.stages.queueMs);
  assert.ok(Math.max(...queuedBackground) >= 300, 'queue wait is reported, not hidden in the spawn clock');
});

test('a higher-priority caller joining a queued identical read raises it', async (t) => {
  const f = await fixture(t);
  const blockers = Array.from({ length: CLI_READ_CONCURRENCY - 1 }, (_, index) =>
    f.client.run(['session', 'candidates', '--json', '--case', `blocker-${index}`, '--delay', '400']));
  await until(async () => (await f.events()).filter((row) => row.kind === 'start').length
    >= CLI_READ_CONCURRENCY - 1);
  // A background read now has to wait for a background slot; an interactive caller does not.
  const args = ['jira', 'status', '--json', '--case', 'shared'];
  const lowFirst = f.client.run(args);
  const highJoin = f.client.run(args, undefined, { priority: 'interactive' });
  const [low, high] = await Promise.all([lowFirst, highJoin]);
  assert.equal(low.id, 'shared');
  assert.equal(high.id, 'shared');
  const rows = await f.events();
  assert.equal(rows.filter((row) => row.kind === 'start' && row.id === 'shared').length, 1,
    'one shared process served both callers');
  await Promise.all(blockers);
  const firstBlockerEnd = (await f.events()).filter((row) => row.kind === 'end' && row.id.startsWith('blocker-'))
    .sort((left, right) => left.at - right.at)[0];
  assert.ok(started(rows, 'shared').at < firstBlockerEnd.at,
    'the raised read took the free slot instead of waiting for a background slot');
});
