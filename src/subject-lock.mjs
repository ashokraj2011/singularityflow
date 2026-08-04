import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gitDir } from './git.mjs';
import { SingularityFlowError, nowIso } from './util.mjs';

const PROCESS_TOKEN = randomUUID();
const DEFAULT_TTL_MS = 15 * 60 * 1000;

function safe(value) {
  return encodeURIComponent(String(value)).replace(/%/g, '_');
}

export function subjectLockPath(root, subject) {
  return path.join(gitDir(root), 'singularity-flow', 'locks', `${safe(subject.kind)}--${safe(subject.id)}.lock`);
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

function stale(owner, ttlMs, directoryAgeMs) {
  if (owner === undefined || owner === null) return directoryAgeMs > ACQUISITION_GRACE_MS;
  if (owner.host === os.hostname() && pidAlive(owner.pid)) return false;
  const acquired = Date.parse(owner.acquiredAt ?? '');
  return !Number.isFinite(acquired) || Date.now() - acquired > ttlMs;
}

async function directoryAge(directory) {
  const info = await stat(directory).catch(() => null);
  if (!info) return Number.POSITIVE_INFINITY;
  return Date.now() - info.mtimeMs;
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
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(directory, { recursive: false });
      // Written whole and then moved into place. A plain write leaves a truncated record if the
      // process dies mid-write, and the next acquirer reads that as an unowned lock.
      const pending = `${path.join(directory, 'owner.json')}.${owner.lockToken}`;
      await writeFile(pending, `${JSON.stringify(owner, null, 2)}\n`, { flag: 'wx' });
      await rename(pending, path.join(directory, 'owner.json'));
      return owner;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await readOwner(directory);
      if (!stale(existing, ttlMs, await directoryAge(directory))) {
        const held = existing
          ? `PID ${existing.pid ?? 'unknown'} on ${existing.host ?? 'unknown'} since ${existing.acquiredAt ?? 'unknown'}`
          : 'another process that is still acquiring it';
        throw new SingularityFlowError(`${subject.kind} '${subject.id}' is locked by ${held}.`);
      }
      await rm(directory, { recursive: true, force: true });
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

export async function withSubjectLock(root, subject, callback, options) {
  const owner = await acquireSubjectLock(root, subject, options);
  try { return await callback(owner); }
  finally {
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
