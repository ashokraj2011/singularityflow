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
import * as markers from '../src/verification/test-run-marker.mjs';
import { beginTestRun, readTestRunMarker, reconcileTestRun, runProcessAlive, testRunMarkerFile } from '../src/verification/test-run-marker.mjs';
import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';
import { escalateRefusalEnvelope } from '../src/finding-escalation.mjs';
import { ownTerminalStep } from '../src/command-skills.mjs';
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
  assert.deepEqual([kept.result.timedOut, kept.result.processGroup, kept.process.pid, kept.process.group], [true, 'not-confirmed', left.pid, true]);
  assert.equal((await reconcileTestRun(root, TARGET, { itemRelative: ITEM })).state, 'unknown', 'never read as quiet');
  await assert.rejects(beginTestRun(root, TARGET, { startedAt: '2026-11-17T20:05:00.000Z', itemRelative: ITEM, warn: () => {} }),
    (error) => error.code === 'TEST_RUN_OUTCOME_UNKNOWN' && error.message.includes(`group ${left.pid}`), 'its own refusal, naming the process');
  assert.equal((await readTestRunMarker(root, TARGET)).runId, kept.runId, 'nothing new was started');
  // Its processes gone, the next entry settles it and runs.
  left.end();
  for (let waited = 0; runProcessAlive({ pid: left.pid, group: true }); waited += 20) {
    assert.ok(waited < childTimeout(10_000), 'the leftover group never ended');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal((await reconcileTestRun(root, TARGET, { itemRelative: ITEM })).state, 'ended');
  await beginTestRun(root, TARGET, { startedAt: '2026-11-17T20:10:00.000Z', itemRelative: ITEM, warn: () => {} });
  assert.deepEqual((await readTestRunMarker(root, TARGET)).after, { runId: kept.runId, state: 'ended' });
});

test('a crash between start and result is reconciled from the original run\'s evidence and processes, with no duplicate run [CVL-REQ-016]', { skip: process.platform === 'win32' }, async (t) => {
  const root = await checkout(t);
  // The owner still runs it: nothing starts beside it.
  const live = await owner(t, root, `await beginTestRun(root, target, { startedAt: '2026-11-17T20:00:00.000Z' });
    process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`);
  await assert.rejects(beginTestRun(root, TARGET, { startedAt: '2026-11-17T20:01:00.000Z', itemRelative: ITEM, warn: () => {} }), { code: 'TEST_RUN_STILL_RUNNING' });
  live.child.kill('SIGKILL');
  await live.exited();

  // The owner crashed with a process of its run still going: unknown, still nothing started beside it.
  const left = leftover(t);
  const crashed = await owner(t, root, `const run = await beginTestRun(root, target, { startedAt: '2026-11-17T20:02:00.000Z' });
    await run.spawned(${left.pid}, true); process.stdout.write('ready\\n', () => process.kill(process.pid, 'SIGKILL'));`);
  await crashed.exited();
  const before = await readTestRunMarker(root, TARGET);
  assert.deepEqual([before.result, before.process.pid, before.process.group], [null, left.pid, true], 'started, with no result');
  assert.equal(JSON.stringify(before).includes(os.hostname()), true, 'the owner is named here, on this machine only');
  assert.match(testRunMarkerFile(root, TARGET), new RegExp(`^${gitDir(root).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'), 'kept in private Git storage');
  await assert.rejects(beginTestRun(root, TARGET, { startedAt: '2026-11-17T20:03:00.000Z', itemRelative: ITEM, warn: () => {} }), { code: 'TEST_RUN_OUTCOME_UNKNOWN' });
  // Its processes gone and no evidence kept: the run happened and was interrupted; the next one says so and names it.
  left.end();
  for (let waited = 0; runProcessAlive({ pid: left.pid, group: true }); waited += 20) {
    assert.ok(waited < childTimeout(10_000), 'the leftover group never ended');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const warned = [];
  const again = await beginTestRun(root, TARGET, { startedAt: '2026-11-17T20:04:00.000Z', itemRelative: ITEM, warn: (line) => warned.push(line) });
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

/** A record as a gate's run leaves it, written as it is on disk. */
async function record(root, fields) {
  const file = testRunMarkerFile(root, TARGET);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ schemaVersion: 1, kind: 'test-run-marker', runId: 'TR-0123456789abcdef0123', target: TARGET,
    startedAt: '2026-11-17T20:00:00.000Z', owner: { pid: 1, host: 'elsewhere', machineId: '00000000-0000-4000-8000-000000000000', processStartedAt: 0 },
    process: null, result: null, ...fields })}\n`);
}

test('a run that cannot be this machine\'s, or a number another process took, never holds the next run [review #1]', { skip: process.platform === 'win32' }, async (t) => {
  const root = await checkout(t);
  // Its owner is on another machine or container: nothing here can see it, so it is not held here.
  await record(root, {});
  const elsewhere = await reconcileTestRun(root, TARGET, { itemRelative: ITEM });
  assert.equal(elsewhere.state, 'elsewhere');
  const next = await beginTestRun(root, TARGET, { startedAt: '2026-11-17T20:01:00.000Z', itemRelative: ITEM, warn: () => {} });
  assert.equal((await readTestRunMarker(root, TARGET)).after.state, 'elsewhere');
  await next.finish({ status: 0 });
  // The run's own group was not confirmed gone, but the process now holding that number started after the run did:
  // another program took the number, so the run's processes are gone.
  const left = leftover(t);
  await record(root, { owner: (await readTestRunMarker(root, TARGET)).owner, process: { pid: left.pid, group: true, startedAt: Date.now() - 600_000 },
    result: { completedAt: '2026-11-17T20:02:00.000Z', status: null, timedOut: true, processGroup: 'not-confirmed' } });
  assert.equal((await reconcileTestRun(root, TARGET, { itemRelative: ITEM })).state, 'ended');
  // Another user's process with that number is not this run's either.
  assert.equal(runProcessAlive({ pid: 1, group: false, startedAt: Date.now() }), false);
});

test('a held run is its own refusal that names the process, is never counted as a repair, and a person sets it aside in their own terminal [review #1, #6]', { skip: process.platform === 'win32' }, async (t) => {
  const root = await checkout(t);
  const left = leftover(t);
  const run = await beginTestRun(root, TARGET, { startedAt: '2026-11-17T20:00:00.000Z', itemRelative: ITEM, warn: () => {} });
  await run.spawned(left.pid, true);
  await run.finish({ status: null, timedOut: true, processGroup: 'not-confirmed' });
  const held = await beginTestRun(root, TARGET, { startedAt: '2026-11-17T20:05:00.000Z', itemRelative: ITEM, warn: () => {} }).then(() => null, (error) => error);
  assert.equal(held?.code, 'TEST_RUN_OUTCOME_UNKNOWN');
  assert.match(held.message, new RegExp(`group ${left.pid}\\b`, 'u'), 'the refusal names the process');
  assert.doesNotMatch(held.message, /fix the cause|Do not repeat/u);
  const listed = `singularity-flow tests held --work-id ${W} --phase implement`;
  assert.equal(held.details.nextAction.command, listed);
  // Its own routes: a wait on the list a person reads first, then the same command once that process ended; never a repair
  // of the step, and never the same check first, which ran into the same hold (loop 12) [owner, 2026-11-19].
  const plan = refusalRemediationPlan(held, ['phase', 'prepublish', 'implement']);
  assert.deepEqual(plan.steps.map((step) => step.command), [listed, 'singularity-flow phase prepublish implement --for-agent --json --publish-if-ready']);
  assert.deepEqual([plan.steps[0].wait, plan.steps[1].changes], [true, 'the held run has ended']);
  assert.equal(plan.steps.some((step) => /Do not repeat|fix the cause|[Rr]epair/u.test(step.label ?? '')), false);
  // Asked about three times, it is a wait, never "the same finding returned".
  const streaks = await mkdtemp(path.join(os.tmpdir(), 'sflow-cvl-streaks-'));
  t.after(() => rm(streaks, { recursive: true, force: true }));
  const previous = process.env.SINGULARITY_FLOW_FINDING_STREAKS;
  process.env.SINGULARITY_FLOW_FINDING_STREAKS = streaks;
  t.after(() => { if (previous === undefined) delete process.env.SINGULARITY_FLOW_FINDING_STREAKS; else process.env.SINGULARITY_FLOW_FINDING_STREAKS = previous; });
  for (let index = 0; index < 4; index += 1) {
    const envelope = escalateRefusalEnvelope({ error: { code: held.code }, remediationPlan: refusalRemediationPlan(held, ['phase', 'prepublish', 'implement']) }, held, root);
    assert.equal(envelope.remediationPlan.steps.some((step) => step.id === 'escalate-repeated-finding'), false, `ask ${index + 1}`);
  }
  // The person sets it aside, after reading which process it was, with the confirmation it printed.
  const setAsideTestRun = (...args) => markers.setAsideTestRun(...args);
  const preview = await setAsideTestRun(root, TARGET, {});
  assert.equal(preview.status, 'confirmation-required');
  assert.match(preview.words, new RegExp(`group ${left.pid}\\b`, 'u'));
  assert.equal(preview.command, `singularity-flow tests held --work-id ${W} --phase implement --command unit --set-aside --confirm ${preview.confirmation}`);
  assert.equal(ownTerminalStep(preview.command), 'test-run-set-aside', 'the person\'s own terminal step');
  assert.equal(ownTerminalStep(listed), null, 'reading it is anyone\'s');
  await assert.rejects(setAsideTestRun(root, TARGET, { confirm: 'not-it' }), { code: 'TEST_RUN_SET_ASIDE_STALE' });
  assert.equal((await setAsideTestRun(root, TARGET, { confirm: preview.confirmation })).status, 'set-aside');
  const next = await beginTestRun(root, TARGET, { startedAt: '2026-11-17T20:10:00.000Z', itemRelative: ITEM, warn: () => {} });
  assert.deepEqual((await readTestRunMarker(root, TARGET)).after.state, 'set-aside');
  await next.finish({ status: 0 });
});
