/**
 * Git and remote work SFlow starts by itself waits until the laptop has been idle [owner, 2026-11-19]. The stamp, the
 * gate, the operating system's idle reading and the one waiting runner, each with its clock and readers injected: no
 * test waits for real minutes, and none reads the person's keyboard.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { activityFile, idleMinutes, idleState, noteActivity, noteCommandActivity } from '../src/machine-activity.mjs';
import { automaticWorkDirectory, laptopIdle, MAXIMUM_WAIT_MS, runQueuedAutomaticWork, whenLaptopIdle } from '../src/automatic-work.mjs';
import { osIdleMilliseconds } from '../src/platform-process.mjs';
import { MACHINE_STATE_LOCATIONS, ISOLATED_RUN_SWITCHES } from '../src/machine-state-locations.mjs';

const MINUTE = 60_000;
async function home(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-activity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { SINGULARITY_FLOW_ACTIVITY_FILE: path.join(directory, 'activity.json'), SINGULARITY_FLOW_OS_IDLE: 'off' };
  return { directory, env, file: env.SINGULARITY_FLOW_ACTIVITY_FILE };
}

test('the stamp is machine-local, redirected in isolated runs, and written at most once a minute', async t => {
  assert.equal(MACHINE_STATE_LOCATIONS.SINGULARITY_FLOW_ACTIVITY_FILE, 'activity.json');
  assert.equal(ISOLATED_RUN_SWITCHES.SINGULARITY_FLOW_OS_IDLE, 'off');
  assert.equal(activityFile({}, '/home/person'), path.resolve('/home/person/.singularity-flow/activity.json'));
  const { env, file } = await home(t);
  // Long past, so the real clock below is always later than every stamp written here.
  const now = Date.parse('2020-01-01T09:00:00Z');
  assert.equal(noteActivity({ env, now }), true);
  assert.equal(statSync(file).mtimeMs, now);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { at: '2020-01-01T09:00:00.000Z' });
  assert.equal(noteActivity({ env, now: now + 59_000 }), false, 'a minute is not up');
  assert.equal(statSync(file).mtimeMs, now);
  assert.equal(noteActivity({ env, now: now + MINUTE }), true);
  assert.equal(noteActivity({ env, now: now - 5 * MINUTE }), true, 'a stamp from the future (a clock moved back) is replaced');
  assert.equal(statSync(file).mtimeMs, now - 5 * MINUTE);
  // A host's own calls and background replays are not a person at work.
  assert.equal(noteCommandActivity({ ...env, SINGULARITY_FLOW_ACTIVITY_STAMP: 'off' }), false);
  assert.equal(noteCommandActivity({ ...env, SINGULARITY_FLOW_INDEX_REFRESH: '1' }), false);
  assert.equal(noteCommandActivity(env), true);
  // Never fails its caller.
  assert.equal(noteActivity({ env, file: path.join(file, 'not-a-directory', 'activity.json') }), false);
});

test('idle means no activity for the chosen minutes, by the stamp or the operating system, whichever is later', async t => {
  const { env, file } = await home(t);
  assert.equal(idleMinutes({}), 30);
  for (const [value, minutes] of [['0', 0], ['45', 45], ['1440', 1440], ['', 30], [' ', 30], ['-1', 30], ['1441', 30], ['2.5', 30], ['soon', 30]]) {
    assert.equal(idleMinutes({ SINGULARITY_FLOW_IDLE_MINUTES: value }), minutes, value);
  }
  const now = Date.parse('2026-11-19T12:00:00Z');
  assert.deepEqual(idleState({ env, now }), { idle: true, remainingMs: 0, lastActivityAt: null }, 'nothing recorded is idle');
  noteActivity({ env, now: now - 10 * MINUTE });
  assert.deepEqual(idleState({ env, now }), { idle: false, remainingMs: 20 * MINUTE, lastActivityAt: now - 10 * MINUTE });
  assert.equal(idleState({ env, now: now + 20 * MINUTE }).idle, true);
  assert.deepEqual(idleState({ env, now, osIdleMs: 1000 }), { idle: false, remainingMs: 30 * MINUTE - 1000, lastActivityAt: now - 1000 },
    'the keyboard used a second ago');
  assert.equal(idleState({ env, now: now + 15 * MINUTE, osIdleMs: 40 * MINUTE }).idle, false, 'the stamp is later than the keyboard');
  assert.equal(idleState({ env: { ...env, SINGULARITY_FLOW_IDLE_MINUTES: '0' }, now }).idle, true, '0 waits for nothing');
  assert.equal(idleState({ env, now, idleMs: 5 * MINUTE }).idle, true);
  assert.equal(statSync(file).isFile(), true);
});

test('the operating system idle time is read on macOS and Windows, and never guessed', () => {
  const calls = [];
  const answer = (stdout, status = 0) => (command, args, options) => { calls.push({ command, args, options }); return { status, stdout }; };
  assert.equal(osIdleMilliseconds({ platform: 'darwin', spawnSyncCommand: answer('  |   "HIDIdleTime" = 149063329458\n') }), 149063);
  assert.equal(calls[0].command, '/usr/sbin/ioreg');
  assert.deepEqual(calls[0].args, ['-c', 'IOHIDSystem', '-r', '-d', '1', '-k', 'HIDIdleTime']);
  assert.equal(calls[0].options.shell, false);
  assert.equal(osIdleMilliseconds({ platform: 'darwin', spawnSyncCommand: answer('nothing here') }), null);
  const windows = answer('125000\r\n');
  assert.equal(osIdleMilliseconds({ platform: 'win32', environment: { SystemRoot: 'C:\\Windows' }, spawnSyncCommand: windows }), 125000);
  assert.equal(calls.at(-1).command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.match(calls.at(-1).args.at(-1), /GetLastInputInfo/u);
  assert.equal(osIdleMilliseconds({ platform: 'win32', environment: { SystemRoot: 'C:\\Windows' }, spawnSyncCommand: answer('', 0) }), null, 'empty is not zero');
  assert.equal(osIdleMilliseconds({ platform: 'win32', environment: { SystemRoot: 'C:\\Windows' }, spawnSyncCommand: answer('5', 1) }), null);
  assert.equal(osIdleMilliseconds({ platform: 'win32', environment: {}, spawnSyncCommand: windows }), null, 'no trusted PowerShell path');
  assert.equal(osIdleMilliseconds({ platform: 'linux', spawnSyncCommand: () => assert.fail('nothing to run') }), null);
  assert.equal(osIdleMilliseconds({ platform: 'darwin', spawnSyncCommand: () => { throw new Error('no ioreg'); } }), null);
});

test('the gate asks the operating system only when the stamp alone says idle', async t => {
  const { env } = await home(t);
  const now = Date.parse('2026-11-19T15:00:00Z');
  let reads = 0;
  const readSystemIdle = () => { reads += 1; return 5 * MINUTE; };
  noteActivity({ env, now: now - MINUTE });
  assert.equal((await laptopIdle({ env, now, readSystemIdle })).idle, false);
  assert.equal(reads, 0, 'a laptop in use costs one stat');
  assert.deepEqual(await laptopIdle({ env, now: now + 40 * MINUTE, readSystemIdle }),
    { idle: false, remainingMs: 25 * MINUTE, lastActivityAt: now + 35 * MINUTE }, 'the keyboard says five minutes ago');
  assert.equal(reads, 1);
  assert.equal((await laptopIdle({ env: { ...env, SINGULARITY_FLOW_IDLE_MINUTES: '0' }, now, readSystemIdle })).idle, true);
  assert.equal(reads, 1, 'no wait, nothing to read');
});

test('a job due while someone works is queued for one waiting runner; on an idle laptop it starts at once', async t => {
  const { env } = await home(t);
  const busy = async () => ({ idle: false, remainingMs: 7 * MINUTE });
  const job = { kind: 'workspace-cleanup', workspacePath: path.resolve('/work/space'), protect: [path.resolve('/work/space/app')] };
  let started = 0, launched = 0;
  const launch = async () => { launched += 1; };
  assert.equal(await whenLaptopIdle(job, () => { started += 1; }, { env, idle: async () => ({ idle: true, remainingMs: 0 }), launch }), 'started');
  assert.equal(started, 1); assert.equal(launched, 0);
  assert.equal(existsSync(automaticWorkDirectory(env)), false, 'nothing queued');
  assert.equal(await whenLaptopIdle(job, () => { started += 1; }, { env, idle: busy, launch }), 'waiting');
  assert.equal(started, 1); assert.equal(launched, 1);
  const directory = automaticWorkDirectory(env);
  assert.equal(directory, path.join(path.dirname(env.SINGULARITY_FLOW_ACTIVITY_FILE), 'automatic-work'));
  const queued = readdirSync(directory);
  assert.equal(queued.length, 1); assert.match(queued[0], /^workspace-cleanup-[0-9a-f]{16}\.json$/u);
  assert.deepEqual(JSON.parse(readFileSync(path.join(directory, queued[0]), 'utf8')), job);
  // The same job again is the same file; a waiting runner is not started twice.
  writeFileSync(path.join(directory, 'runner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  assert.equal(await whenLaptopIdle(job, () => {}, { env, idle: busy, launch }), 'waiting');
  assert.equal(readdirSync(directory).length, 2); assert.equal(launched, 1);
  // A runner that outlived its day, or whose process is gone, is replaced.
  writeFileSync(path.join(directory, 'runner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - MAXIMUM_WAIT_MS - 2 * MINUTE).toISOString() }));
  await whenLaptopIdle(job, () => {}, { env, idle: busy, launch });
  assert.equal(launched, 2);
  // Only the known jobs, with absolute paths, are ever queued.
  for (const bad of [{ kind: 'shell', command: 'rm' }, { kind: 'history-index', root: 'relative' }, { kind: 'build-currency', checkout: '/a' }]) {
    await whenLaptopIdle(bad, () => {}, { env, idle: busy, launch });
  }
  assert.equal(readdirSync(directory).length, 2);
});

test('the runner sleeps exactly the time left, re-arms after activity, starts every queued job once idle, then stops', async t => {
  const { env } = await home(t);
  const directory = automaticWorkDirectory(env);
  mkdirSync(directory, { recursive: true });
  const jobs = [{ kind: 'history-index', root: path.resolve('/repo/one') }, { kind: 'build-currency', checkout: path.resolve('/sflow'), rawFile: path.resolve('/sflow/raw') }];
  jobs.forEach((job, index) => writeFileSync(path.join(directory, `${job.kind}-${index}.json`), JSON.stringify(job)));
  writeFileSync(path.join(directory, 'stray-job.json'), JSON.stringify({ kind: 'shell', command: 'anything' }));
  writeFileSync(path.join(directory, 'torn.json'), '{');
  let clock = 0;
  const answers = [{ idle: false, remainingMs: 12 * MINUTE }, { idle: false, remainingMs: 3 * MINUTE }, { idle: true, remainingMs: 0 }];
  const slept = [], started = [];
  const result = await runQueuedAutomaticWork({ env, pid: 4242, now: () => clock,
    idle: async () => answers.shift(), sleep: async (ms) => { slept.push(ms); clock += ms; },
    start: async (job) => { started.push(job.kind); if (job.kind === 'history-index') throw new Error('one failure holds nothing'); } });
  assert.equal(result, 'done');
  assert.deepEqual(slept, [12 * MINUTE + 1000, 3 * MINUTE + 1000], 'the time left, never a poll');
  assert.deepEqual(started.sort(), ['build-currency', 'history-index']);
  assert.deepEqual(readdirSync(directory), [], 'queue drained, unknown files dropped, runner released');
});

test('one runner holds the queue, and it gives up after a day of activity', async t => {
  const { env } = await home(t);
  const directory = automaticWorkDirectory(env);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'runner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  assert.equal(await runQueuedAutomaticWork({ env, idle: () => assert.fail('another runner waits') }), 'already-waiting');
  writeFileSync(path.join(directory, 'runner.json'), JSON.stringify({ pid: 2 ** 30, startedAt: new Date().toISOString() }));
  writeFileSync(path.join(directory, 'history-index-1.json'), JSON.stringify({ kind: 'history-index', root: path.resolve('/repo') }));
  let clock = Date.now();
  const result = await runQueuedAutomaticWork({ env, now: () => clock, idle: async () => ({ idle: false, remainingMs: 30 * MINUTE }),
    sleep: async (ms) => { clock += ms; }, start: () => assert.fail('never idle') });
  assert.equal(result, 'gave-up');
  assert.deepEqual(readdirSync(directory), ['history-index-1.json'], 'the job stays for the next runner; this one released its claim');
});

test('VS Code notes what its person does, never its own output or commands it ran', async () => {
  const { watchLaptopActivity, idleMinutesSetting, idleWaitWords } = await import('../apps/vscode/src/laptop-activity.ts');
  const listeners = {};
  const event = (name) => (listener) => { listeners[name] = listener; return { dispose() {} }; };
  const api = { window: { onDidChangeWindowState: event('focus'), onDidOpenTerminal: event('terminal'),
    onDidChangeTextEditorSelection: event('selection') }, workspace: { onDidChangeTextDocument: event('text') } };
  let noted = 0;
  const disposables = watchLaptopActivity(api, () => { noted += 1; });
  assert.equal(disposables.length, 4, 'an event this VS Code lacks is skipped');
  listeners.focus({ focused: false }); listeners.focus({ focused: true });
  listeners.terminal({});
  listeners.selection({ kind: 3 }); listeners.selection({ kind: 1 });
  listeners.text({ document: { uri: { scheme: 'output' } }, contentChanges: [{}] });
  listeners.text({ document: { uri: { scheme: 'file' } }, contentChanges: [] });
  listeners.text({ document: { uri: { scheme: 'file' } }, contentChanges: [{}] });
  assert.equal(noted, 4);
  assert.equal(idleMinutesSetting(15), 15); assert.equal(idleMinutesSetting(-3), 30); assert.equal(idleMinutesSetting('10'), 30);
  assert.equal(idleWaitWords(30), 'shares after 30 minutes idle');
  assert.equal(idleWaitWords(1), 'shares after 1 minute idle');
  assert.equal(idleWaitWords(0), 'shares when saved');
});
