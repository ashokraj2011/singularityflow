/**
 * A gate's required test run, started and ended on this machine [CVL-REQ-016, CVL-REQ-018; OSA §8, TCE:REQ-034].
 *
 * Before a publication's or a submission's required test command starts, a small private record says so: the run's ID,
 * its target (Story, step, version and command), when it started and which process owns it, then the process it started.
 * When the run ends, its result is written beside: how it ended, and whether its stopped process group is confirmed gone.
 *
 * The next run of the same command reads it first. A record with no result (its owner crashed, or the reply was lost) is
 * reconciled from the original run's evidence (the attempt kept for it) and its processes. A stopped group not confirmed
 * gone is an unknown outcome until its processes are seen gone. Nothing assumes the run did not happen, and nothing starts
 * beside a run that may still be going.
 *
 * Kept in the checkout's private Git storage beside the test attempts (attempts.mjs) and never admitted into the Story:
 * process IDs and host names stay on this machine [CVL-REQ-020]. Loaded only when a gate runs a test command.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { gitDir } from '../git.mjs';
import { leaseOwnerAssessment, leaseOwnerIdentity, processStartTimeMs } from '../lease-liveness.mjs';
import { assertConfirmation } from '../text-lines.mjs';
import { SingularityFlowError, writeAtomic } from '../util.mjs';
import { stepAttempts } from './attempts.mjs';

const KIND = 'test-run-marker';
/** The refusals of a run held back because the last run of its command may still be going: waits, never repairs. */
export const HELD_RUN_CODES = Object.freeze(['TEST_RUN_STILL_RUNNING', 'TEST_RUN_OUTCOME_UNKNOWN']);
// A process with the run's number that started this much after the run's own is another program that took the number.
const PID_REUSE_TOLERANCE_MS = 2_000;

const directoryOf = (root, { workId, phaseId }) => path.join(gitDir(root), 'singularity-flow', 'test-attempts', workId, 'runs', phaseId);

/** The private record of the latest gate run of one command of one step. */
export function testRunMarkerFile(root, target) {
  return path.join(directoryOf(root, target), `${createHash('sha256').update(String(target.commandId)).digest('hex').slice(0, 24)}.json`);
}

export async function readTestRunMarker(root, target) {
  try {
    const marker = JSON.parse(await readFile(testRunMarkerFile(root, target), 'utf8'));
    return marker?.kind === KIND ? marker : null;
  } catch { return null; }
}

const save = (root, marker) => writeAtomic(testRunMarkerFile(root, marker.target), `${JSON.stringify(marker)}\n`, { mode: 0o600 });

/**
 * Whether anything of a run's process (its group on POSIX) is still running here, as this run's. Only a process this user
 * may signal can be its own (another user's is not), and a process now holding the run's number that started after the
 * run's own is another program that took the number, as a lease's owner is judged (lease-liveness.mjs).
 */
export function runProcessAlive(proc, { platform = process.platform, probe = processStartTimeMs } = {}) {
  const pid = proc?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const here = (target) => { try { process.kill(target, 0); return true; } catch { return false; } };
  if (!here(proc.group === true && platform !== 'win32' ? -pid : pid)) return false;
  if (!Number.isFinite(proc.startedAt) || !here(pid)) return true;
  const observed = probe(pid);
  return !(Number.isFinite(observed) && observed - proc.startedAt > PID_REUSE_TOLERANCE_MS);
}

/**
 * What the last run of the same command left, before another starts:
 *   - `none`: no record;
 *   - `ended`: its result is kept and nothing of it runs;
 *   - `recorded`: no result, but the attempt of the original run was kept, so it ran;
 *   - `interrupted`: its owner ended without a result, no attempt was kept, and nothing of it runs;
 *   - `elsewhere`: its owner was another machine or container, whose processes nothing here can see;
 *   - `set-aside`: a person set it aside in their own terminal (setAsideTestRun);
 *   - `running`: its owner still runs it here;
 *   - `unknown`: its stopped processes were not confirmed gone and are still running here as its own.
 * Only `running` and `unknown` hold the next run back. A record settled here keeps how it was settled.
 */
export async function reconcileTestRun(root, target, { itemRelative = null, probe = runProcessAlive } = {}) {
  const marker = await readTestRunMarker(root, target);
  if (!marker) return { state: 'none', marker: null };
  if (marker.reconciled) return { state: marker.reconciled.state, marker };
  const settle = async (state) => {
    marker.reconciled = { state, at: new Date().toISOString() };
    await save(root, marker);
    return { state, marker };
  };
  const owner = leaseOwnerAssessment(marker.owner);
  // Another machine or PID namespace: its process IDs are not this table's, so nothing here holds on them.
  if (owner.state === 'unknown') return settle('elsewhere');
  if (marker.result) {
    if (marker.result.processGroup !== 'not-confirmed') return { state: 'ended', marker };
    return probe(marker.process) ? { state: 'unknown', marker } : settle('ended');
  }
  if (owner.state === 'alive' && owner.reason !== 'this-process') return { state: 'running', marker };
  // The original run's own evidence: an attempt of this command started when the record says it did.
  const attempts = itemRelative ? await stepAttempts(root, itemRelative, target.workId, target.phaseId).catch(() => []) : [];
  if (attempts.some((attempt) => attempt.commandId === target.commandId && attempt.process?.startedAt === marker.startedAt)) return settle('recorded');
  return probe(marker.process) ? { state: 'unknown', marker } : settle('interrupted');
}

/** The read that lists a step's held runs, each with its person's set-aside command. */
export const heldRunsCommand = ({ workId, phaseId }) => `singularity-flow tests held --work-id ${workId} --phase ${phaseId}`;

/** Which process a held run is, in words: its group or process, and the process that started it, on this machine. */
function processWords(marker) {
  const proc = marker.process;
  const owner = marker.owner ?? {};
  return `${proc ? `process ${proc.group ? 'group ' : ''}${proc.pid}, started by ` : ''}process ${owner.pid ?? 'unknown'} on ${owner.host ?? 'this machine'}`;
}

/** The refusal of a run held back by the last one: what it waits for, which process, and how a person ends the wait. */
function heldRunRefusal(target, { state, marker }) {
  const subject = `The last run of test command '${target.commandId}' for ${target.phaseId} (${marker.startedAt})`;
  const unknown = state === 'unknown';
  const listed = heldRunsCommand(target);
  const proc = processWords(marker);
  return new SingularityFlowError(`${subject} ${unknown ? `was stopped, but ${proc} still runs` : `still runs in ${proc}`}. Nothing started beside it. `
    + `${unknown ? 'Wait for it to end or end it' : 'Let it finish or stop it'}, then run the command again. This lists it: ${listed}`, {
    code: unknown ? 'TEST_RUN_OUTCOME_UNKNOWN' : 'TEST_RUN_STILL_RUNNING',
    details: { workId: target.workId, phase: target.phaseId, commandId: target.commandId, startedAt: marker.startedAt, waits: true,
      process: { pid: marker.process?.pid ?? null, group: marker.process?.group === true, owner: marker.owner?.pid ?? null },
      nextAction: { command: listed, label: 'See which process holds the run' } } });
}

/** Refuse before anything runs when the last run of any of these commands may still be going (no partial gate run). */
export async function assertNoHeldRuns(root, targets, { itemRelative = null } = {}) {
  for (const target of targets) {
    const earlier = await reconcileTestRun(root, target, { itemRelative });
    if (earlier.state === 'running' || earlier.state === 'unknown') throw heldRunRefusal(target, earlier);
  }
}

/**
 * Reconcile the last run of `target`'s command, then record this one as started; refuses (heldRunRefusal) when the last
 * one may still be going. Returns `spawned(pid, group)` and `finish(result)` for the run, which the caller calls once it
 * ends, whatever happened.
 */
export async function beginTestRun(root, target, { startedAt, itemRelative = null, warn = console.warn } = {}) {
  const earlier = await reconcileTestRun(root, target, { itemRelative });
  if (earlier.state === 'running' || earlier.state === 'unknown') throw heldRunRefusal(target, earlier);
  const was = earlier.marker ? `The last run of test command '${target.commandId}', started at ${earlier.marker.startedAt},` : '';
  if (earlier.state === 'interrupted') warn(`${was} ended without a result: its process stopped first, and nothing of it is still running. It runs again now.`);
  if (earlier.state === 'elsewhere') warn(`${was} was started on another machine or container, which nothing here can see. It runs again here.`);
  const marker = { schemaVersion: 1, kind: KIND, runId: `TR-${randomBytes(10).toString('hex')}`, target, startedAt,
    owner: leaseOwnerIdentity(), process: null, result: null, ...(earlier.marker ? { after: { runId: earlier.marker.runId, state: earlier.state } } : {}) };
  await save(root, marker);
  let pending = Promise.resolve();
  const write = () => { pending = pending.then(() => save(root, marker), () => save(root, marker)); return pending; };
  return {
    runId: marker.runId,
    // When it started, so a later process given the same number is never read as this run's.
    spawned: (pid, group) => { marker.process = { pid, group: group === true, startedAt: Date.now() }; return write().catch(() => {}); },
    // A run that threw is ended with no result of its own: its processes are not confirmed gone.
    finish: async (result) => {
      marker.result = { completedAt: new Date().toISOString(), status: Number.isInteger(result?.status) ? result.status : null,
        signal: result?.signal ?? null, timedOut: result?.timedOut === true, aborted: result?.aborted === true,
        error: result?.error ? (/^[A-Z][A-Z0-9_]{0,40}$/u.test(String(result.error.code ?? '')) ? result.error.code : 'ERROR') : null,
        processGroup: result ? result.processGroup ?? null : 'not-confirmed' };
      await write();
    }
  };
}

const confirmationOf = (marker) => createHash('sha256').update(JSON.stringify(marker)).digest('hex').slice(0, 24);
const shellWord = (value) => (/^[A-Za-z0-9_.:@+-]+$/u.test(String(value)) ? String(value) : `'${String(value).replaceAll("'", "'\\''")}'`);

/**
 * `tests held`: the runs of a step held back because their last run may still be going, each named by its process; and
 * the person's own set-aside of one (`--set-aside --confirm`, a step no agent turn runs: person-step-catalog.mjs), after
 * they checked that process is not the run. Without `target.commandId` it lists the step's held runs. It ends nothing:
 * the record is kept, marked set aside, and the next run of the command starts.
 */
export async function setAsideTestRun(root, target, { confirm = null, itemRelative = null } = {}) {
  if (!target.commandId) {
    const names = await readdir(directoryOf(root, target)).catch(() => []);
    const held = [];
    for (const name of names.filter((entry) => /^[a-f0-9]{24}\.json$/u.test(entry)).sort()) {
      const marker = JSON.parse(await readFile(path.join(directoryOf(root, target), name), 'utf8').catch(() => 'null'));
      if (marker?.kind === KIND && marker.target?.commandId) held.push(await setAsideTestRun(root, { ...target, commandId: marker.target.commandId }, { itemRelative }));
    }
    return { schemaVersion: 1, resultType: 'sflow-held-test-runs', status: held.some((entry) => entry.status === 'confirmation-required') ? 'held' : 'none-held',
      workId: target.workId, phase: target.phaseId, runs: held.filter((entry) => entry.status === 'confirmation-required') };
  }
  const earlier = await reconcileTestRun(root, target, { itemRelative });
  const base = { schemaVersion: 1, resultType: 'sflow-held-test-run', workId: target.workId, phase: target.phaseId, commandId: target.commandId };
  if (earlier.state !== 'running' && earlier.state !== 'unknown') return { ...base, status: 'not-held', state: earlier.state,
    words: `Nothing holds test command '${target.commandId}' for ${target.phaseId}: its next run starts.` };
  const confirmation = confirmationOf(earlier.marker);
  if (confirm == null) return { ...base, status: 'confirmation-required', state: earlier.state, startedAt: earlier.marker.startedAt,
    process: { pid: earlier.marker.process?.pid ?? null, group: earlier.marker.process?.group === true, owner: earlier.marker.owner?.pid ?? null, host: earlier.marker.owner?.host ?? null },
    words: `Its last run, started at ${earlier.marker.startedAt}, is held by ${processWords(earlier.marker)}. Set it aside only once you checked that process is not that run, or ended it.`,
    confirmation, command: `singularity-flow tests held --work-id ${target.workId} --phase ${target.phaseId} --command ${shellWord(target.commandId)} --set-aside --confirm ${confirmation}` };
  assertConfirmation(confirm, confirmation, { code: 'TEST_RUN_SET_ASIDE_STALE',
    fail: (message, code, details) => { throw new SingularityFlowError(message, { code, details }); },
    message: 'The held run changed after it was listed: list it again and confirm what it shows now.',
    details: { nextAction: { command: heldRunsCommand(target) } } });
  earlier.marker.reconciled = { state: 'set-aside', at: new Date().toISOString(), by: 'person' };
  await save(root, earlier.marker);
  return { ...base, status: 'set-aside', words: `Set aside: the next run of test command '${target.commandId}' for ${target.phaseId} starts. Nothing was ended.` };
}
