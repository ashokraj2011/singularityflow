import { constants as fsConstants } from 'node:fs';
import {
  lstat, mkdir, open, readdir, realpath, rename, rm, utimes
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { canonicalJson } from '../../records.mjs';
import { SingularityFlowError } from '../../util.mjs';
import {
  clonePlatformJson, createAuthorityPortableExport, createAuthorityState,
  createAuthorityTransactionEvent, createPlatformEnvelope, isPlainPlatformObject,
  platformSha256, validatePlatformEnvelope, validatePlatformRecord
} from './contracts.mjs';
import { signPlatformRecord, verifySignedPlatformRecord } from './signatures.mjs';

const MAX_AUTHORITY_EVENTS = 100_000;
const MAX_AUTHORITY_FILE_BYTES = 8 * 1024 * 1024;
// This is a private adapter protocol, not a durable migration-registry record. `lockVersion` is
// deliberately not named `schemaVersion`: a lock is operational coordination state and must never
// masquerade as one of Singularity Flow's registered record families.
const AUTHORITY_LOCK_FORMAT = 'sflow.sgos.authority-store-lock';
const AUTHORITY_LOCK_VERSION = 1;
const AUTHORITY_LOCK_TTL_MS = 30 * 1000;
const AUTHORITY_LOCK_ACQUISITION_GRACE_MS = 30 * 1000;
const AUTHORITY_LOCK_ATTEMPTS = 3;
const AUTHORITY_LOCK_RETRY_MS = 10;

function fail(message, code = 'SGOS_AUTHORITY_STORE_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function identifier(value, label) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._:-]{1,127}$/.test(value)) {
    fail(`${label} must be a canonical identifier.`);
  }
}

function exactObject(value, allowed, label) {
  if (!isPlainPlatformObject(value)) fail(`${label} must be an object.`);
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) if (!accepted.has(key)) fail(`${label} contains unknown field '${key}'.`);
}

async function assertNotSymlink(target, label, { optional = false, directory = false } = {}) {
  let info;
  try { info = await lstat(target); } catch (error) {
    if (optional && error?.code === 'ENOENT') return false;
    throw error;
  }
  if (info.isSymbolicLink()) fail(`${label} must not be a symbolic link.`, 'SGOS_AUTHORITY_PATH_UNSAFE');
  if (directory && !info.isDirectory()) fail(`${label} must be a directory.`, 'SGOS_AUTHORITY_PATH_UNSAFE');
  if (!directory && !info.isFile()) fail(`${label} must be a regular file.`, 'SGOS_AUTHORITY_PATH_UNSAFE');
  return true;
}

async function safeReadJson(file, label) {
  let handle;
  let text;
  try {
    handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile()) fail(`${label} must be a regular file.`, 'SGOS_AUTHORITY_PATH_UNSAFE');
    if (info.size > MAX_AUTHORITY_FILE_BYTES) fail(`${label} exceeds the installed byte ceiling.`, 'SGOS_AUTHORITY_LIMIT_EXCEEDED');
    text = await handle.readFile('utf8');
  } catch (error) {
    if (error?.code === 'ELOOP') fail(`${label} must not be a symbolic link.`, 'SGOS_AUTHORITY_PATH_UNSAFE');
    throw error;
  } finally {
    await handle?.close();
  }
  let value;
  try { value = JSON.parse(text); } catch (error) {
    throw new SingularityFlowError(`${label} is not valid JSON.`, {
      code: 'SGOS_AUTHORITY_STORE_CORRUPT', cause: error
    });
  }
  return value;
}

async function fsyncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function writeExclusive(file, value) {
  let handle;
  try {
    handle = await open(file,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(canonicalJson(value), 'utf8');
    await handle.sync();
  } finally {
    await handle?.close();
  }
  await fsyncDirectory(path.dirname(file));
}

async function writeAtomic(file, value) {
  const temporary = path.join(path.dirname(file), `.state-${randomUUID()}.tmp`);
  try {
    await writeExclusive(temporary, value);
    await rename(temporary, file);
    await fsyncDirectory(path.dirname(file));
  } finally {
    await rm(temporary, { force: true });
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function authorityLockOwner(storeId, now = Date.now()) {
  const core = {
    lockFormat: AUTHORITY_LOCK_FORMAT,
    lockVersion: AUTHORITY_LOCK_VERSION,
    storeId,
    token: randomUUID(),
    host: os.hostname(),
    pid: process.pid,
    acquiredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + AUTHORITY_LOCK_TTL_MS).toISOString()
  };
  return Object.freeze({ ...core, ownerSha256: platformSha256(core) });
}

function authorityHeartbeatPath(directory, owner) {
  return path.join(directory, `heartbeat-${owner.token}`);
}

function startAuthorityHeartbeat(directory, owner) {
  const heartbeat = authorityHeartbeatPath(directory, owner);
  let pending = Promise.resolve();
  const timer = setInterval(() => {
    const now = new Date();
    pending = pending.then(() => utimes(heartbeat, now, now)).catch(() => undefined);
  }, Math.max(250, Math.floor(AUTHORITY_LOCK_TTL_MS / 3)));
  timer.unref();
  return async () => {
    clearInterval(timer);
    await pending;
  };
}

function validateAuthorityLockOwner(value, storeId) {
  if (!isPlainPlatformObject(value)) {
    fail('Authority Store lock owner must be an object.', 'SGOS_AUTHORITY_LOCK_CORRUPT');
  }
  // Inspect the private protocol version before exact validation. A newer build may legitimately
  // add fields, and treating those as corruption/staleness would let this build steal its live lock.
  if (value.lockFormat !== AUTHORITY_LOCK_FORMAT) {
    fail('Authority Store lock uses an unknown private format.', 'SGOS_AUTHORITY_LOCK_FORMAT_UNSUPPORTED');
  }
  if (!Number.isInteger(value.lockVersion) || value.lockVersion < 1) {
    fail('Authority Store lock version is invalid.', 'SGOS_AUTHORITY_LOCK_CORRUPT');
  }
  if (value.lockVersion > AUTHORITY_LOCK_VERSION) {
    fail(`Authority Store lock version ${value.lockVersion} is newer than this build supports.`,
      'SGOS_AUTHORITY_LOCK_VERSION_UNSUPPORTED', { lockVersion: value.lockVersion });
  }
  exactObject(value, [
    'lockFormat', 'lockVersion', 'storeId', 'token', 'host', 'pid', 'acquiredAt', 'expiresAt',
    'ownerSha256'
  ], 'Authority Store lock owner');
  if (value.storeId !== storeId) {
    fail('Authority Store lock belongs to another store.', 'SGOS_AUTHORITY_STORE_MISMATCH');
  }
  if (typeof value.token !== 'string' || !/^[0-9a-f-]{36}$/.test(value.token)) {
    fail('Authority Store lock token is invalid.', 'SGOS_AUTHORITY_LOCK_CORRUPT');
  }
  if (typeof value.host !== 'string' || value.host.length < 1 || value.host.length > 255
      || !Number.isSafeInteger(value.pid) || value.pid <= 0) {
    fail('Authority Store lock host or process identity is invalid.', 'SGOS_AUTHORITY_LOCK_CORRUPT');
  }
  const acquired = Date.parse(value.acquiredAt);
  const expires = Date.parse(value.expiresAt);
  if (!Number.isFinite(acquired) || !Number.isFinite(expires) || expires <= acquired) {
    fail('Authority Store lock lease timestamps are invalid.', 'SGOS_AUTHORITY_LOCK_CORRUPT');
  }
  const core = { ...value };
  delete core.ownerSha256;
  if (value.ownerSha256 !== platformSha256(core)) {
    fail('Authority Store lock owner digest is invalid.', 'SGOS_AUTHORITY_LOCK_CORRUPT');
  }
  return Object.freeze({ ...value, acquired, expires });
}

function sameFileIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino
    && left.mtimeMs === right.mtimeMs && left.size === right.size);
}

async function waitBriefly() {
  await new Promise((resolve) => setTimeout(resolve, AUTHORITY_LOCK_RETRY_MS));
}

function normalizeChanges(changes, entries) {
  if (!Array.isArray(changes) || !changes.length || changes.length > 128) {
    fail('Authority transaction requires 1..128 changes.');
  }
  const normalized = changes.map((change, index) => {
    exactObject(change, ['op', 'key', 'value'], `changes[${index}]`);
    if (!['put', 'delete'].includes(change.op)) fail(`changes[${index}].op is invalid.`);
    identifier(change.key, `changes[${index}].key`);
    if (change.op === 'put') {
      if (!Object.hasOwn(change, 'value')) fail(`changes[${index}] put requires a value.`);
      return { op: 'put', key: change.key, value: clonePlatformJson(change.value) };
    }
    if (Object.hasOwn(change, 'value')) fail(`changes[${index}] delete cannot carry a value.`);
    if (!Object.hasOwn(entries, change.key)) fail(`Authority key '${change.key}' does not exist.`, 'SGOS_AUTHORITY_DELETE_MISSING');
    return { op: 'delete', key: change.key };
  }).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].key === normalized[index].key) fail(`Authority key '${normalized[index].key}' is changed more than once.`);
  }
  return normalized;
}

function applyChanges(entries, changes) {
  const next = clonePlatformJson(entries);
  for (const change of changes) {
    if (change.op === 'put') next[change.key] = clonePlatformJson(change.value);
    else delete next[change.key];
  }
  return Object.fromEntries(Object.entries(next).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

function eventFilename(eventSha256) {
  if (!/^sha256:[a-f0-9]{64}$/.test(String(eventSha256 ?? ''))) fail('Authority event digest is invalid.');
  return `${eventSha256.slice(7)}.json`;
}

export function assertAuthorityStoreAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') fail('Authority Store adapter is required.');
  for (const method of ['read', 'transact', 'verify', 'planRecovery', 'recover', 'exportPortable']) {
    if (typeof adapter[method] !== 'function') fail(`Authority Store adapter is missing '${method}'.`);
  }
  if (adapter.profile !== 'experimental-filesystem-v1') {
    fail(`Authority Store profile '${adapter.profile ?? 'unknown'}' is not enabled.`, 'SGOS_AUTHORITY_PROFILE_UNSUPPORTED');
  }
  return adapter;
}

async function verifyEventSequence(storeId, head, events) {
  let entries = {};
  let priorEventSha256 = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = validatePlatformRecord(events[index], 'platform-authority-transaction');
    if (event.storeId !== storeId || event.revision !== index + 1 || event.priorEventSha256 !== priorEventSha256) {
      fail('Authority event lineage is invalid.', 'SGOS_AUTHORITY_LINEAGE_INVALID');
    }
    if (event.beforeEntriesSha256 !== platformSha256(entries)) {
      fail('Authority event before-state digest is invalid.', 'SGOS_AUTHORITY_LINEAGE_INVALID');
    }
    entries = applyChanges(entries, event.changes);
    if (event.afterEntriesSha256 !== platformSha256(entries)) {
      fail('Authority event after-state digest is invalid.', 'SGOS_AUTHORITY_LINEAGE_INVALID');
    }
    priorEventSha256 = event.recordSha256;
  }
  if (head.revision !== events.length || head.eventSha256 !== priorEventSha256
      || head.entriesSha256 !== platformSha256(entries)
      || canonicalJson(head.entries) !== canonicalJson(entries)) {
    fail('Authority head does not match its immutable event lineage.', 'SGOS_AUTHORITY_LINEAGE_INVALID');
  }
  return entries;
}

export async function openFilesystemAuthorityStore({ root, storeId }) {
  identifier(storeId, 'storeId');
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail('Authority Store root must be an absolute path.', 'SGOS_AUTHORITY_PATH_UNSAFE');
  const requestedRoot = path.resolve(root);
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  await assertNotSymlink(requestedRoot, 'Authority Store root', { directory: true });
  const canonicalRoot = await realpath(requestedRoot);
  const eventsDirectory = path.join(canonicalRoot, 'events');
  await mkdir(eventsDirectory, { recursive: true, mode: 0o700 });
  await assertNotSymlink(eventsDirectory, 'Authority Store events directory', { directory: true });
  const stateFile = path.join(canonicalRoot, 'state.json');
  const lockDirectory = path.join(canonicalRoot, '.transaction-lock');

  async function assertLayout() {
    await assertNotSymlink(canonicalRoot, 'Authority Store root', { directory: true });
    await assertNotSymlink(eventsDirectory, 'Authority Store events directory', { directory: true });
    await assertNotSymlink(stateFile, 'Authority Store state', { optional: true });
  }

  async function inspectLock() {
    let info;
    try { info = await lstat(lockDirectory); } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      fail('Authority Store lock must be a real directory.', 'SGOS_AUTHORITY_PATH_UNSAFE');
    }
    let rawOwner;
    try { rawOwner = await safeReadJson(path.join(lockDirectory, 'owner.json'), 'Authority Store lock owner'); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      rawOwner = null;
    }
    const owner = rawOwner === null ? null : validateAuthorityLockOwner(rawOwner, storeId);
    let heartbeatModifiedAt = null;
    if (owner) {
      let heartbeatInfo;
      try { heartbeatInfo = await lstat(authorityHeartbeatPath(lockDirectory, owner)); } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      if (heartbeatInfo) {
        if (heartbeatInfo.isSymbolicLink() || !heartbeatInfo.isFile()) {
          fail('Authority Store lock heartbeat must be a regular file.', 'SGOS_AUTHORITY_PATH_UNSAFE');
        }
        heartbeatModifiedAt = heartbeatInfo.mtimeMs;
      }
    }
    return Object.freeze({ info, owner, heartbeatModifiedAt });
  }

  function reclaimableLock(lock, now = Date.now()) {
    if (!lock.owner) {
      // A newly-created directory precedes atomic owner publication by a few filesystem calls. It
      // is an acquiring lock throughout this bounded grace period, never evidence of abandonment.
      return now - lock.info.mtimeMs > AUTHORITY_LOCK_ACQUISITION_GRACE_MS;
    }
    if (lock.owner.acquired > now) return false;
    // A dead same-host owner is conclusive and can be recovered before its conservative lease
    // deadline. Otherwise expiry is authoritative only when the token-specific heartbeat also
    // expired. This prevents a recycled/live PID from stranding the store forever while ensuring a
    // genuinely active operation continually extends its lease.
    if (lock.owner.host === os.hostname() && !processAlive(lock.owner.pid)) return true;
    const heartbeatExpiry = Number.isFinite(lock.heartbeatModifiedAt)
      ? lock.heartbeatModifiedAt + AUTHORITY_LOCK_TTL_MS
      : 0;
    return now > Math.max(lock.owner.expires, heartbeatExpiry);
  }

  function sameObservedLock(left, right) {
    if (!left || !right || !sameFileIdentity(left.info, right.info)) return false;
    return (left.owner?.ownerSha256 ?? null) === (right.owner?.ownerSha256 ?? null)
      && left.heartbeatModifiedAt === right.heartbeatModifiedAt;
  }

  async function reclaimLock(seen) {
    const current = await inspectLock();
    if (!sameObservedLock(seen, current) || !reclaimableLock(current)) return false;
    // Rename is the recovery commit point. The abandoned directory is deliberately retained under
    // a unique forensic name: recovery never recursively deletes evidence and a competing process
    // cannot mistake these exact bytes for the active lock.
    const condemned = path.join(canonicalRoot,
      `.transaction-lock.reclaimed-${Date.now()}-${randomUUID()}`);
    try { await rename(lockDirectory, condemned); } catch (error) {
      if (['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(error?.code)) return false;
      throw error;
    }
    await fsyncDirectory(canonicalRoot);
    return true;
  }

  async function acquireLock() {
    const owner = authorityLockOwner(storeId);
    for (let attempt = 0; attempt < AUTHORITY_LOCK_ATTEMPTS; attempt += 1) {
      try {
        await mkdir(lockDirectory, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const existing = await inspectLock();
        if (existing && reclaimableLock(existing) && await reclaimLock(existing)) continue;
        if (!existing || (!existing.owner && attempt + 1 < AUTHORITY_LOCK_ATTEMPTS)) {
          await waitBriefly();
          continue;
        }
        fail('Authority Store is busy.', 'SGOS_AUTHORITY_STORE_BUSY', {
          lock: lockDirectory,
          owner: existing.owner ? {
            host: existing.owner.host,
            pid: existing.owner.pid,
            acquiredAt: existing.owner.acquiredAt,
            expiresAt: existing.owner.expiresAt
          } : null
        });
      }
      // Publish a complete, fsynced owner atomically. Readers either see no owner (and observe the
      // acquisition grace) or the exact self-hashed record; they never accept a partial JSON write.
      const pending = path.join(lockDirectory, `.owner-${owner.token}.pending`);
      await writeExclusive(pending, owner);
      await writeExclusive(authorityHeartbeatPath(lockDirectory, owner), {
        lockFormat: `${AUTHORITY_LOCK_FORMAT}.heartbeat`,
        lockVersion: AUTHORITY_LOCK_VERSION,
        token: owner.token
      });
      await rename(pending, path.join(lockDirectory, 'owner.json'));
      await fsyncDirectory(lockDirectory);
      await fsyncDirectory(canonicalRoot);
      return owner;
    }
    fail('Authority Store lock could not be acquired after bounded retries.', 'SGOS_AUTHORITY_STORE_BUSY', {
      lock: lockDirectory
    });
  }

  async function releaseLock(owner) {
    const current = await inspectLock();
    if (!current?.owner || current.owner.token !== owner.token) {
      fail('Authority Store lock ownership changed before release.', 'SGOS_AUTHORITY_LOCK_OWNERSHIP_LOST');
    }
    const released = path.join(canonicalRoot, `.transaction-lock.released-${owner.token}-${randomUUID()}`);
    try { await rename(lockDirectory, released); } catch (error) {
      if (error?.code === 'ENOENT') {
        fail('Authority Store lock disappeared before release.', 'SGOS_AUTHORITY_LOCK_OWNERSHIP_LOST');
      }
      throw error;
    }
    // Recheck the token after the atomic move before deleting our own completed lease. If anything
    // unexpected moved, leave it quarantined for inspection instead of erasing another owner.
    const moved = validateAuthorityLockOwner(
      await safeReadJson(path.join(released, 'owner.json'), 'Released Authority Store lock owner'),
      storeId
    );
    if (moved.token !== owner.token) {
      fail('Released Authority Store lock does not match its owner token.', 'SGOS_AUTHORITY_LOCK_OWNERSHIP_LOST', {
        quarantine: released
      });
    }
    await rm(released, { recursive: true });
    await fsyncDirectory(canonicalRoot);
  }

  async function withLock(operation) {
    await assertLayout();
    const owner = await acquireLock();
    const stopHeartbeat = startAuthorityHeartbeat(lockDirectory, owner);
    try { return await operation(); } finally {
      await stopHeartbeat();
      await releaseLock(owner);
    }
  }

  async function readState() {
    await assertLayout();
    const envelope = validatePlatformEnvelope(await safeReadJson(stateFile, 'Authority Store state'), 'platform-authority-state');
    const state = validatePlatformRecord(envelope.record, 'platform-authority-state');
    if (state.storeId !== storeId) fail('Authority Store state belongs to another store.', 'SGOS_AUTHORITY_STORE_MISMATCH');
    return state;
  }

  async function readEvent(eventSha256) {
    const file = path.join(eventsDirectory, eventFilename(eventSha256));
    const envelope = validatePlatformEnvelope(await safeReadJson(file, `Authority event ${eventSha256}`), 'platform-authority-transaction');
    const event = validatePlatformRecord(envelope.record, 'platform-authority-transaction');
    if (event.recordSha256 !== eventSha256) fail('Authority event file name does not bind its contents.', 'SGOS_AUTHORITY_LINEAGE_INVALID');
    return event;
  }

  async function lineage(head) {
    if (head.revision > MAX_AUTHORITY_EVENTS) fail('Authority event history exceeds the installed ceiling.', 'SGOS_AUTHORITY_LIMIT_EXCEEDED');
    const reverse = [];
    let next = head.eventSha256;
    while (next !== null) {
      if (reverse.length >= MAX_AUTHORITY_EVENTS) fail('Authority event history exceeds the installed ceiling.', 'SGOS_AUTHORITY_LIMIT_EXCEEDED');
      const event = await readEvent(next);
      reverse.push(event);
      next = event.priorEventSha256;
    }
    return reverse.reverse();
  }

  async function recoveryInspection() {
    const head = await readState();
    const events = await lineage(head);
    await verifyEventSequence(storeId, head, events);
    const allFiles = await readdir(eventsDirectory);
    if (allFiles.length > MAX_AUTHORITY_EVENTS) fail('Authority event directory exceeds the installed ceiling.', 'SGOS_AUTHORITY_LIMIT_EXCEEDED');
    if (allFiles.some((name) => !/^[a-f0-9]{64}\.json$/.test(name))) {
      fail('Authority event directory contains an unexpected entry.', 'SGOS_AUTHORITY_STORE_CORRUPT');
    }
    const reachable = new Set(events.map((event) => `${event.recordSha256.slice(7)}.json`));
    const orphanFiles = allFiles.filter((name) => !reachable.has(name)).sort();
    if (!orphanFiles.length) return { head, events, orphanEventCount: 0, recoveryPlan: null };
    const remaining = new Map();
    for (const file of orphanFiles) {
      const event = await readEvent(`sha256:${file.slice(0, -'.json'.length)}`);
      remaining.set(event.recordSha256, event);
    }
    const recoveredEvents = [];
    let priorEventSha256 = head.eventSha256;
    let revision = head.revision;
    let entries = clonePlatformJson(head.entries);
    while (remaining.size) {
      const next = [...remaining.values()].filter((event) =>
        event.priorEventSha256 === priorEventSha256 && event.revision === revision + 1);
      if (next.length !== 1) {
        fail('Authority Store orphan events do not form one exact forward recovery chain.',
          'SGOS_AUTHORITY_RECOVERY_AMBIGUOUS', {
            orphanEventCount: orphanFiles.length,
            candidatesAtBoundary: next.length,
            revision
          });
      }
      const event = next[0];
      if (event.beforeEntriesSha256 !== platformSha256(entries)) {
        fail('Authority recovery event does not bind the current state.',
          'SGOS_AUTHORITY_LINEAGE_INVALID', { eventSha256: event.recordSha256 });
      }
      entries = applyChanges(entries, event.changes);
      if (event.afterEntriesSha256 !== platformSha256(entries)) {
        fail('Authority recovery event after-state is invalid.',
          'SGOS_AUTHORITY_LINEAGE_INVALID', { eventSha256: event.recordSha256 });
      }
      recoveredEvents.push(event);
      remaining.delete(event.recordSha256);
      priorEventSha256 = event.recordSha256;
      revision = event.revision;
    }
    const recoveredHead = createAuthorityState({
      storeId,
      revision,
      eventSha256: priorEventSha256,
      entriesSha256: platformSha256(entries),
      entries
    });
    const planCore = {
      kind: 'platform-authority-recovery-plan',
      storeId,
      beforeRevision: head.revision,
      beforeStateSha256: head.recordSha256,
      eventSha256s: recoveredEvents.map((event) => event.recordSha256),
      afterRevision: recoveredHead.revision,
      afterStateSha256: recoveredHead.recordSha256,
      orphanEventCount: orphanFiles.length
    };
    const recoveryPlan = Object.freeze({
      ...planCore,
      confirmationSha256: platformSha256(planCore)
    });
    return { head, events, orphanEventCount: orphanFiles.length, recoveredHead, recoveryPlan };
  }

  async function verifiedSnapshot() {
    const inspected = await recoveryInspection();
    if (inspected.orphanEventCount) {
      fail('Authority Store contains events outside the committed head lineage.', 'SGOS_AUTHORITY_ROLLBACK_OR_PARTIAL_WRITE', {
        orphanEventCount: inspected.orphanEventCount,
        recoveryPlan: inspected.recoveryPlan
      });
    }
    return inspected;
  }

  if (!await assertNotSymlink(stateFile, 'Authority Store state', { optional: true })) {
    await withLock(async () => {
      if (await assertNotSymlink(stateFile, 'Authority Store state', { optional: true })) return;
      const genesis = createAuthorityState({
        storeId, revision: 0, eventSha256: null, entriesSha256: platformSha256({}), entries: {}
      });
      await writeExclusive(stateFile, createPlatformEnvelope(genesis));
    });
  }

  const adapter = {
    profile: 'experimental-filesystem-v1',
    storeId,
    root: canonicalRoot,

    async read() {
      const { head } = await verifiedSnapshot();
      return clonePlatformJson(head);
    },

    async transact(input) {
      exactObject(input, ['expectedRevision', 'expectedStateSha256', 'actorId', 'changes'], 'authority transaction');
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) fail('expectedRevision must be a non-negative safe integer.');
      if (!/^sha256:[a-f0-9]{64}$/.test(String(input.expectedStateSha256 ?? ''))) fail('expectedStateSha256 is invalid.');
      identifier(input.actorId, 'authority transaction.actorId');
      return withLock(async () => {
        const { head: before } = await verifiedSnapshot();
        if (before.revision !== input.expectedRevision || before.recordSha256 !== input.expectedStateSha256) {
          fail('Authority transaction lost its compare-and-swap race.', 'SGOS_AUTHORITY_CAS_MISMATCH', {
            currentRevision: before.revision, currentStateSha256: before.recordSha256
          });
        }
        const changes = normalizeChanges(input.changes, before.entries);
        const entries = applyChanges(before.entries, changes);
        const event = createAuthorityTransactionEvent({
          storeId,
          revision: before.revision + 1,
          priorEventSha256: before.eventSha256,
          beforeEntriesSha256: before.entriesSha256,
          afterEntriesSha256: platformSha256(entries),
          actorId: input.actorId,
          committedAt: new Date().toISOString(),
          changes
        });
        const eventFile = path.join(eventsDirectory, eventFilename(event.recordSha256));
        try { await writeExclusive(eventFile, createPlatformEnvelope(event)); } catch (error) {
          if (error?.code !== 'EEXIST') throw error;
          const existing = validatePlatformEnvelope(await safeReadJson(eventFile, 'Existing authority event'), 'platform-authority-transaction');
          if (existing.recordSha256 !== event.recordSha256) fail('Authority event collision detected.', 'SGOS_AUTHORITY_STORE_CORRUPT');
        }
        const after = createAuthorityState({
          storeId,
          revision: event.revision,
          eventSha256: event.recordSha256,
          entriesSha256: event.afterEntriesSha256,
          entries
        });
        await writeAtomic(stateFile, createPlatformEnvelope(after));
        return clonePlatformJson(after);
      });
    },

    async verify() {
      const { head, orphanEventCount } = await verifiedSnapshot();
      return Object.freeze({
        valid: true,
        storeId,
        revision: head.revision,
        stateSha256: head.recordSha256,
        eventSha256: head.eventSha256,
        orphanEventCount
      });
    },

    async planRecovery() {
      const inspected = await recoveryInspection();
      if (!inspected.recoveryPlan) {
        return Object.freeze({
          required: false,
          storeId,
          revision: inspected.head.revision,
          stateSha256: inspected.head.recordSha256,
          orphanEventCount: 0,
          recoveryPlan: null
        });
      }
      return Object.freeze({
        required: true,
        storeId,
        revision: inspected.head.revision,
        stateSha256: inspected.head.recordSha256,
        orphanEventCount: inspected.orphanEventCount,
        recoveryPlan: inspected.recoveryPlan
      });
    },

    async recover({ confirmationSha256 }) {
      if (!/^sha256:[a-f0-9]{64}$/.test(String(confirmationSha256 ?? ''))) {
        fail('Authority recovery requires the exact plan confirmation digest.',
          'SGOS_AUTHORITY_RECOVERY_CONFIRMATION_REQUIRED');
      }
      return withLock(async () => {
        const inspected = await recoveryInspection();
        if (!inspected.recoveryPlan) {
          return Object.freeze({
            recovered: false,
            storeId,
            revision: inspected.head.revision,
            stateSha256: inspected.head.recordSha256,
            recoveredEventCount: 0
          });
        }
        if (inspected.recoveryPlan.confirmationSha256 !== confirmationSha256) {
          fail('Authority recovery confirmation does not match the current exact recovery plan.',
            'SGOS_AUTHORITY_RECOVERY_CONFIRMATION_MISMATCH', {
              requiredConfirmationSha256: inspected.recoveryPlan.confirmationSha256
            });
        }
        await writeAtomic(stateFile, createPlatformEnvelope(inspected.recoveredHead));
        const verified = await verifiedSnapshot();
        return Object.freeze({
          recovered: true,
          storeId,
          revision: verified.head.revision,
          stateSha256: verified.head.recordSha256,
          recoveredEventCount: inspected.recoveryPlan.eventSha256s.length,
          recoveryPlanSha256: confirmationSha256
        });
      });
    },

    async exportPortable({ privateKeyPem, keyId }) {
      const { head, events } = await verifiedSnapshot();
      const record = createAuthorityPortableExport({
        storeId, head, events, exportedAt: new Date().toISOString()
      });
      return signPlatformRecord(record, { privateKeyPem, keyId });
    }
  };
  return Object.freeze(adapter);
}

export function verifyPortableAuthorityExport(signedExport, {
  trustedPublicKeyPem,
  expectedKeyId,
  expectedStoreId = null
}) {
  const record = verifySignedPlatformRecord(signedExport, {
    trustedPublicKeyPem, expectedKeyId, expectedKind: 'platform-authority-export'
  });
  if (expectedStoreId !== null && record.storeId !== expectedStoreId) {
    fail('Portable Authority export belongs to another store.', 'SGOS_AUTHORITY_STORE_MISMATCH');
  }
  // The export contract validates the predecessor chain. Reapply mutations here so a self-consistent
  // but forged state cannot pass without the trusted signature and exact state reconstruction.
  let entries = {};
  for (const event of record.events) {
    if (event.beforeEntriesSha256 !== platformSha256(entries)) fail('Portable export before-state is invalid.', 'SGOS_AUTHORITY_LINEAGE_INVALID');
    entries = applyChanges(entries, event.changes);
    if (event.afterEntriesSha256 !== platformSha256(entries)) fail('Portable export after-state is invalid.', 'SGOS_AUTHORITY_LINEAGE_INVALID');
  }
  if (record.head.entriesSha256 !== platformSha256(entries)
      || canonicalJson(record.head.entries) !== canonicalJson(entries)) {
    fail('Portable export head does not match its events.', 'SGOS_AUTHORITY_LINEAGE_INVALID');
  }
  return Object.freeze({
    valid: true,
    storeId: record.storeId,
    revision: record.head.revision,
    stateSha256: record.head.recordSha256,
    exportSha256: record.recordSha256
  });
}
