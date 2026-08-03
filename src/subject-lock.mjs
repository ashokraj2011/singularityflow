import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

async function readOwner(directory) {
  try { return JSON.parse(await readFile(path.join(directory, 'owner.json'), 'utf8')); }
  catch { return null; }
}

function stale(owner, ttlMs) {
  if (!owner) return true;
  if (owner.host === os.hostname() && pidAlive(owner.pid)) return false;
  const acquired = Date.parse(owner.acquiredAt ?? '');
  return !Number.isFinite(acquired) || Date.now() - acquired > ttlMs;
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
      await writeFile(path.join(directory, 'owner.json'), `${JSON.stringify(owner, null, 2)}\n`, { flag: 'wx' });
      return owner;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await readOwner(directory);
      if (!stale(existing, ttlMs)) {
        throw new SingularityFlowError(
          `${subject.kind} '${subject.id}' is locked by PID ${existing.pid ?? 'unknown'} on ${existing.host ?? 'unknown'} since ${existing.acquiredAt ?? 'unknown'}.`
        );
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
  finally { await releaseSubjectLock(root, subject, owner); }
}
