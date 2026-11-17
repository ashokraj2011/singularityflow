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
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { gitDir } from '../git.mjs';
import { leaseOwnerAssessment, leaseOwnerIdentity } from '../lease-liveness.mjs';
import { writeAtomic } from '../util.mjs';
import { stepAttempts } from './attempts.mjs';

const KIND = 'test-run-marker';
/** The codes of a run held back because an earlier run of its command may still be going. */
export const HELD_RUN_CODES = Object.freeze(['TEST_RUN_STILL_RUNNING', 'TEST_RUN_OUTCOME_UNKNOWN']);

/** The private record of the latest gate run of one command of one step. */
export function testRunMarkerFile(root, { workId, phaseId, commandId }) {
  return path.join(gitDir(root), 'singularity-flow', 'test-attempts', workId, 'runs', phaseId,
    `${createHash('sha256').update(String(commandId)).digest('hex').slice(0, 24)}.json`);
}

export async function readTestRunMarker(root, target) {
  try {
    const marker = JSON.parse(await readFile(testRunMarkerFile(root, target), 'utf8'));
    return marker?.kind === KIND ? marker : null;
  } catch { return null; }
}

const save = (root, marker) => writeAtomic(testRunMarkerFile(root, marker.target), `${JSON.stringify(marker)}\n`, { mode: 0o600 });

/** Whether anything of a run's process (its group on POSIX) is still running here. */
export function runProcessAlive(proc, { platform = process.platform } = {}) {
  const pid = proc?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(proc.group === true && platform !== 'win32' ? -pid : pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

/**
 * What the last run of the same command left, before another starts:
 *   - `none`: no record;
 *   - `ended`: its result is kept and nothing of it runs;
 *   - `recorded`: no result, but the attempt of the original run was kept, so it ran;
 *   - `interrupted`: its owner ended without a result, no attempt was kept, and nothing of it runs;
 *   - `running`: its owner still runs it;
 *   - `unknown`: its stopped processes were not confirmed gone and are still there, or its owner cannot be checked here.
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
  if (marker.result) {
    if (marker.result.processGroup !== 'not-confirmed') return { state: 'ended', marker };
    return probe(marker.process) ? { state: 'unknown', marker } : settle('ended');
  }
  const owner = leaseOwnerAssessment(marker.owner);
  if (owner.state === 'alive' && owner.reason !== 'this-process') return { state: 'running', marker };
  if (owner.state === 'unknown') return { state: 'unknown', marker };
  // The original run's own evidence: an attempt of this command started when the record says it did.
  const attempts = itemRelative ? await stepAttempts(root, itemRelative, target.workId, target.phaseId).catch(() => []) : [];
  if (attempts.some((attempt) => attempt.commandId === target.commandId && attempt.process?.startedAt === marker.startedAt)) return settle('recorded');
  return probe(marker.process) ? { state: 'unknown', marker } : settle('interrupted');
}

/**
 * Reconcile the last run of `target`'s command, then record this one as started. Returns `{ held }` (a code and the
 * person's words, with no process ID: they may reach the Story's records) when an earlier run may still be going; otherwise
 * `spawned(pid, group)` and `finish(result)` for the run, which the caller calls once it ends, whatever happened.
 */
export async function beginTestRun(root, target, { startedAt, itemRelative = null, warn = console.warn } = {}) {
  const earlier = await reconcileTestRun(root, target, { itemRelative });
  const was = earlier.marker ? `The last run of test command '${target.commandId}', started at ${earlier.marker.startedAt},` : '';
  if (earlier.state === 'running' || earlier.state === 'unknown') {
    const pid = earlier.marker.process?.pid ?? earlier.marker.owner?.pid ?? null;
    if (pid) warn(`${was.slice(0, -1)} may still be running here (process ${earlier.marker.process?.group ? 'group ' : ''}${pid}).`);
    return { held: earlier.state === 'running'
      ? { code: 'TEST_RUN_STILL_RUNNING', reason: `${was} is still running in another process on this machine. It was not started a second time. Let that run finish or stop it, then run the same command again.` }
      : { code: 'TEST_RUN_OUTCOME_UNKNOWN', reason: `${was} was stopped, but not all of its processes could be confirmed gone, and some are still running on this machine. It was not started again beside them. Wait for them to end, or end them, then run the same command again.` } };
  }
  if (earlier.state === 'interrupted') warn(`${was} ended without a result: its process stopped first, and nothing of it is still running. It runs again now.`);
  const marker = { schemaVersion: 1, kind: KIND, runId: `TR-${randomBytes(10).toString('hex')}`, target, startedAt,
    owner: leaseOwnerIdentity(), process: null, result: null, ...(earlier.marker ? { after: { runId: earlier.marker.runId, state: earlier.state } } : {}) };
  await save(root, marker);
  let pending = Promise.resolve();
  const write = () => { pending = pending.then(() => save(root, marker), () => save(root, marker)); return pending; };
  return {
    runId: marker.runId,
    spawned: (pid, group) => { marker.process = { pid, group: group === true }; return write().catch(() => {}); },
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
