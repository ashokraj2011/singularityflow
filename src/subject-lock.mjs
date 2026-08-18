import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { gitCommonDir } from './git.mjs';
import { SingularityFlowError, nowIso } from './util.mjs';

const PROCESS_TOKEN = randomUUID();
// A heartbeat renews active `withSubjectLock` leases. Three hours is the fail-safe if a worker
// cannot start: one configured quality command may legally run for two hours.
const DEFAULT_TTL_MS = 3 * 60 * 60 * 1000;

function safe(value) {
  return encodeURIComponent(String(value)).replace(/%/g, '_');
}

function heartbeatPath(directory, owner) {
  return path.join(directory, `heartbeat-${safe(owner.lockToken)}`);
}

export function subjectLockPath(root, subject) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'locks', `${safe(subject.kind)}--${safe(subject.id)}.lock`);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

/**
 * @returns the owner record, `null` when the lock has no readable owner, and `undefined` when there
 *   is no owner file at all — a distinction that decides whether the lock may be broken.
 */
async function readOwner(directory) {
  const file = path.join(directory, 'owner.json');
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Whether a lock may be taken from its current holder.
 *
 * "No owner file" used to mean stale, and it is the opposite: acquisition creates the directory and
 * *then* writes the record, so a lock with no record yet is the newest lock there is. Treating it as
 * abandoned let a second process delete a live lock and proceed, after which two processes both
 * believed they held it and ran a publication concurrently — interleaved writes to the same
 * `workflow.json`, then two commits.
 *
 * A directory younger than the grace period is therefore held, not stale. Older than that with no
 * record is a genuinely crashed acquisition and can be reclaimed. A record that will not parse is
 * treated the same way, because a truncated write is exactly what a crash mid-acquisition leaves.
 */
const ACQUISITION_GRACE_MS = 30 * 1000;

function stale(owner, ttlMs, directoryAgeMs, heartbeatModifiedAt = null) {
  if (owner === undefined || owner === null) return directoryAgeMs > ACQUISITION_GRACE_MS;
  const acquired = Date.parse(owner.acquiredAt ?? '');
  if (!Number.isFinite(acquired)) return true;
  const expiry = Date.parse(owner.expiresAt ?? '');
  const recordedDeadline = Number.isFinite(expiry) ? expiry : acquired + ttlMs;
  const heartbeatDeadline = Number.isFinite(heartbeatModifiedAt) ? heartbeatModifiedAt + ttlMs : 0;
  const deadline = Math.max(recordedDeadline, heartbeatDeadline);
  // Liveness shortens the wait; it does not grant an indefinite hold. This check used to come first
  // and return "held" outright, so a PID the OS had recycled to an unrelated live process satisfied
  // it forever: the TTL never applied, and the only way out was deleting a file inside `.git` by
  // hand. A dead local holder is still reclaimed immediately, which is the useful half.
  if (owner.host === os.hostname() && !pidAlive(owner.pid)) return true;
  return Date.now() > deadline;
}

/**
 * Take a lock we have judged stale, or lose the race and say so.
 *
 * Read-decide-delete is not atomic: two processes could both judge the same abandoned lock stale,
 * and the second would delete the *live* lock the first had just created in its place — after which
 * both believed they held it and ran a publication against the same subject. `rename` is the atomic
 * primitive here. Exactly one process can move a given directory; the loser gets ENOENT and retries
 * against whatever is there now.
 */
async function reclaim(directory, seen) {
  const current = await readOwner(directory);
  if (JSON.stringify(current ?? null) !== JSON.stringify(seen ?? null)) return false;
  const condemned = `${directory}.stale-${randomUUID()}`;
  try { await rename(directory, condemned); }
  catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTEMPTY' || error?.code === 'EEXIST') return false;
    throw error;
  }
  await rm(condemned, { recursive: true, force: true });
  return true;
}

async function directoryAge(directory) {
  const info = await stat(directory).catch(() => null);
  if (!info) return Number.POSITIVE_INFINITY;
  return Date.now() - info.mtimeMs;
}

async function heartbeatModifiedAt(directory, owner) {
  if (!owner?.lockToken) return null;
  const info = await stat(heartbeatPath(directory, owner)).catch(() => null);
  return info?.mtimeMs ?? null;
}

/**
 * Renew a lease even while the main thread is inside a synchronous external quality command.
 *
 * A normal timer cannot do that: `spawnSync` blocks the JavaScript event loop for the entire
 * Playwright/test run. The worker touches a lock-token-specific file, never rewrites owner.json.
 * Token-specific is load-bearing: if the directory is atomically reclaimed between a check and a
 * touch, the old worker cannot refresh the new owner's differently named heartbeat.
 */
function startHeartbeat(directory, owner, ttlMs) {
  if (!Number.isFinite(ttlMs) || ttlMs < 1_000) return null;
  const intervalMs = Math.max(250, Math.min(30_000, Math.floor(ttlMs / 3)));
  const worker = new Worker(`
    const { utimesSync } = require('node:fs');
    const { parentPort, workerData } = require('node:worker_threads');
    const stop = () => { clearInterval(timer); parentPort.close(); };
    const beat = () => {
      try {
        const now = new Date();
        utimesSync(workerData.file, now, now);
      } catch {
        stop();
      }
    };
    const timer = setInterval(beat, workerData.intervalMs);
    parentPort.on('message', stop);
  `, {
    eval: true,
    // CLI/test processes may themselves use `--input-type=module`; inheriting it turns an eval
    // worker into ESM and makes the deliberately self-contained CommonJS heartbeat fail.
    execArgv: [],
    workerData: { file: heartbeatPath(directory, owner), intervalMs }
  });
  worker.unref();
  return worker;
}

async function stopHeartbeat(worker) {
  if (!worker) return;
  await worker.terminate();
}

export async function acquireSubjectLock(root, subject, { ttlMs = DEFAULT_TTL_MS } = {}) {
  const directory = subjectLockPath(root, subject);
  await mkdir(path.dirname(directory), { recursive: true });
  const owner = {
    schemaVersion: 1,
    subject,
    pid: process.pid,
    host: os.hostname(),
    processToken: PROCESS_TOKEN,
    lockToken: randomUUID(),
    acquiredAt: nowIso(),
    expiresAt: new Date(Date.now() + ttlMs).toISOString()
  };
  // Three attempts rather than two: losing the reclaim race to another process is a normal outcome
  // now, and costs one extra turn round the loop.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await mkdir(directory, { recursive: false });
      // Written whole and then moved into place. A plain write leaves a truncated record if the
      // process dies mid-write, and the next acquirer reads that as an unowned lock.
      const pending = `${path.join(directory, 'owner.json')}.${owner.lockToken}`;
      await writeFile(pending, `${JSON.stringify(owner, null, 2)}\n`, { flag: 'wx' });
      await writeFile(heartbeatPath(directory, owner), '', { flag: 'wx', mode: 0o600 });
      await rename(pending, path.join(directory, 'owner.json'));
      return owner;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await readOwner(directory);
      if (!stale(
        existing,
        ttlMs,
        await directoryAge(directory),
        await heartbeatModifiedAt(directory, existing)
      )) {
        const held = existing
          ? `PID ${existing.pid ?? 'unknown'} on ${existing.host ?? 'unknown'} since ${existing.acquiredAt ?? 'unknown'}`
          : 'another process that is still acquiring it';
        throw new SingularityFlowError(
          `${subject.kind} '${subject.id}' is locked by ${held}. `
          + `The lock is ${directory}; it is reclaimed automatically once it expires.`
        );
      }
      await reclaim(directory, existing);
    }
  }
  throw new SingularityFlowError(`Unable to acquire the ${subject.kind} '${subject.id}' mutation lock.`);
}

export async function releaseSubjectLock(root, subject, owner) {
  const directory = subjectLockPath(root, subject);
  const current = await readOwner(directory);
  if (!current || current.lockToken !== owner.lockToken || current.processToken !== PROCESS_TOKEN) return false;
  await rm(directory, { recursive: true, force: true });
  return true;
}

export async function withSubjectLock(root, subject, callback, options = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const owner = await acquireSubjectLock(root, subject, { ...options, ttlMs });
  const heartbeat = startHeartbeat(subjectLockPath(root, subject), owner, ttlMs);
  try { return await callback(owner); }
  finally {
    await stopHeartbeat(heartbeat);
    // A false release means the lock we were holding is no longer ours — it was reclaimed as stale
    // while we were working, so something else may have been mutating the same subject alongside
    // us. Discarding that quietly is how a concurrent mutation becomes invisible.
    if (!await releaseSubjectLock(root, subject, owner)) {
      console.warn(
        `Warning: the ${subject.kind} '${subject.id}' lock was taken over while this command held it. `
        + 'Another process may have changed it at the same time; check the result before relying on it.'
      );
    }
  }
}
