/**
 * SPEC-CVL gap report piece 1, folded into OSA §8 and TCE:REQ-034 [CVL-REQ-016, CVL-REQ-018]: a gate's required test run
 * says that it started before it starts and what it ended with, and its stopped process group's answer is kept. A later
 * run of the same command reconciles what the last one left: a crash between start and result is read from the original
 * run's evidence and processes, never assumed not to have happened, and nothing starts beside a run that may still be
 * going. Expected results are written out here, never computed by the code under test.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runQualityCommand } from '../src/quality-command-runner.mjs';
import { beginTestRun, readTestRunMarker, reconcileTestRun, runProcessAlive, testRunMarkerFile } from '../src/verification/test-run-marker.mjs';
import { gitDir } from '../src/git.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';

const W = 'CVL-1';
const TARGET = Object.freeze({ workId: W, phaseId: 'implement', generation: 2, commandId: 'unit' });
const ITEM = `singularity/work-items/${W}`;
const MARKER = pathToFileURL(fileURLToPath(new URL('../src/verification/test-run-marker.mjs', import.meta.url))).href;

async function checkout(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-cvl-run-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: directory }).status, 0);
  return directory;
}

/** A detached process group that stays until it is ended: what a stopped run can leave behind. */
function leftover(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  const end = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
  t.after(end);
  return { pid: child.pid, end };
}

/** Run a script in its own Node process, as a gate's owner would be, and wait for it to say `ready`. */
async function owner(t, root, body) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { beginTestRun } = await import(${JSON.stringify(MARKER)});
    const root = ${JSON.stringify(root)}, target = ${JSON.stringify(TARGET)};
    ${body}`], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the owner never started its run')), childTimeout(30_000));
    child.stdout.on('data', (chunk) => { out += chunk; if (out.includes('ready')) { clearTimeout(timer); resolve(); } });
    child.once('exit', (code) => { clearTimeout(timer); out.includes('ready') ? resolve() : reject(new Error(`owner exited ${code}`)); });
  });
  return { child, exited: () => new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', resolve))) };
}

test('a stopped run keeps its process group\'s answer: one not confirmed gone reads as unknown until its processes are seen gone [CVL-REQ-018, TCE:REQ-034]', { skip: process.platform === 'win32' }, async (t) => {
  const root = await checkout(t);
  // The runner keeps the cleanup's answer beside the real cause: a timeout stays a timeout.
  const spawned = [];
  const confirmed = await runQualityCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: root, timeoutMs: 200, killTree: true,
    onSpawn: (pid, group) => spawned.push([typeof pid, group]) });
  assert.deepEqual([confirmed.timedOut, confirmed.processGroup], [true, 'gone']);
  assert.deepEqual(spawned, [['number', true]], 'the started process is named once, with its own group');
  const unconfirmed = await runQualityCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: root, timeoutMs: 200, killTree: true,
    endGroup: async () => false });
  assert.deepEqual([unconfirmed.timedOut, unconfirmed.aborted, unconfirmed.processGroup], [true, false, 'not-confirmed']);
  const finished = await runQualityCommand(process.execPath, ['-e', 'process.exit(3)'], { cwd: root, timeoutMs: 30_000, killTree: true });
  assert.deepEqual([finished.status, 'processGroup' in finished], [3, false], 'a run nobody stopped has no stopped group to answer for');

  // A gate's run whose cleanup could not confirm its group gone: the next run of the command is held while it is there.
  const left = leftover(t);
  const run = await beginTestRun(root, TARGET, { startedAt: '2026-11-17T20:00:00.000Z', itemRelative: ITEM, warn: () => {} });
  await run.spawned(left.pid, true);
  await run.finish(unconfirmed);
  const kept = await readTestRunMarker(root, TARGET);
  assert.deepEqual([kept.result.timedOut, kept.result.processGroup, kept.process], [true, 'not-confirmed', { pid: left.pid, group: true }]);
  assert.equal((await reconcileTestRun(root, TARGET, { itemRelative: ITEM })).state, 'unknown', 'never read as quiet');
  const warned = [];
  const held = await beginTestRun(root, TARGET, { startedAt: '2026-11-17T20:05:00.000Z', itemRelative: ITEM, warn: (line) => warned.push(line) });
  assert.equal(held.held.code, 'TEST_RUN_OUTCOME_UNKNOWN');
  assert.doesNotMatch(held.held.reason, new RegExp(`\\b${left.pid}\\b`, 'u'), 'a process ID stays out of words a Story record may keep');
  assert.match(warned[0], new RegExp(`group ${left.pid}`, 'u'), 'this terminal is told which processes');
  assert.equal((await readTestRunMarker(root, TARGET)).runId, kept.runId, 'nothing new was started');
  // Its processes gone, the next entry settles it and runs.
  left.end();
  for (let waited = 0; runProcessAlive({ pid: left.pid, group: true }); waited += 20) {
    assert.ok(waited < childTimeout(10_000), 'the leftover group never ended');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal((await reconcileTestRun(root, TARGET, { itemRelative: ITEM })).state, 'ended');
  const next = await beginTestRun(root, TARGET, { startedAt: '2026-11-17T20:10:00.000Z', itemRelative: ITEM, warn: () => {} });
  assert.equal(next.held, undefined);
  assert.deepEqual((await readTestRunMarker(root, TARGET)).after, { runId: kept.runId, state: 'ended' });
});

test('a crash between start and result is reconciled from the original run\'s evidence and processes, with no duplicate run [CVL-REQ-016]', { skip: process.platform === 'win32' }, async (t) => {
  const root = await checkout(t);
  // The owner still runs it: nothing starts beside it.
  const live = await owner(t, root, `await beginTestRun(root, target, { startedAt: '2026-11-17T20:00:00.000Z' });
    process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`);
  const running = await beginTestRun(root, TARGET, { startedAt: '2026-11-17T20:01:00.000Z', itemRelative: ITEM, warn: () => {} });
  assert.equal(running.held.code, 'TEST_RUN_STILL_RUNNING');
  live.child.kill('SIGKILL');
  await live.exited();

  // The owner crashed with a process of its run still going: unknown, still nothing started beside it.
  const left = leftover(t);
  const crashed = await owner(t, root, `const run = await beginTestRun(root, target, { startedAt: '2026-11-17T20:02:00.000Z' });
    await run.spawned(${left.pid}, true); process.stdout.write('ready\\n', () => process.kill(process.pid, 'SIGKILL'));`);
  await crashed.exited();
  const before = await readTestRunMarker(root, TARGET);
  assert.deepEqual([before.result, before.process], [null, { pid: left.pid, group: true }], 'started, with no result');
  assert.equal(JSON.stringify(before).includes(os.hostname()), true, 'the owner is named here, on this machine only');
  assert.match(testRunMarkerFile(root, TARGET), new RegExp(`^${gitDir(root).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'), 'kept in private Git storage');
  assert.equal((await beginTestRun(root, TARGET, { startedAt: '2026-11-17T20:03:00.000Z', itemRelative: ITEM, warn: () => {} })).held.code, 'TEST_RUN_OUTCOME_UNKNOWN');
  // Its processes gone and no evidence kept: the run happened and was interrupted; the next one says so and names it.
  left.end();
  for (let waited = 0; runProcessAlive({ pid: left.pid, group: true }); waited += 20) {
    assert.ok(waited < childTimeout(10_000), 'the leftover group never ended');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const warned = [];
  const again = await beginTestRun(root, TARGET, { startedAt: '2026-11-17T20:04:00.000Z', itemRelative: ITEM, warn: (line) => warned.push(line) });
  assert.equal(again.held, undefined);
  assert.match(warned[0], /ended without a result/u);
  assert.deepEqual((await readTestRunMarker(root, TARGET)).after, { runId: before.runId, state: 'interrupted' });
  await again.finish({ status: 0, signal: null, timedOut: false, aborted: false });

  // The owner crashed after its run's attempt was kept (a lost reply): the run is read from that evidence as recorded.
  const lost = await owner(t, root, `await beginTestRun(root, target, { startedAt: '2026-11-17T20:06:00.000Z' });
    process.stdout.write('ready\\n', () => process.kill(process.pid, 'SIGKILL'));`);
  await lost.exited();
  const attempts = path.join(gitDir(root), 'singularity-flow', 'test-attempts', W, 'implement');
  await mkdir(attempts, { recursive: true });
  await writeFile(path.join(attempts, `TA-${'a'.repeat(20)}.json`), JSON.stringify({ schemaVersion: 5, attemptId: `TA-${'a'.repeat(20)}`,
    commandId: 'unit', purpose: 'preflight', status: 'passed', process: { startedAt: '2026-11-17T20:06:00.000Z', completedAt: '2026-11-17T20:07:00.000Z' } }));
  const recorded = await reconcileTestRun(root, TARGET, { itemRelative: ITEM });
  assert.equal(recorded.state, 'recorded');
  assert.equal(JSON.parse(await readFile(testRunMarkerFile(root, TARGET), 'utf8')).reconciled.state, 'recorded', 'settled once, as it was found');
});
