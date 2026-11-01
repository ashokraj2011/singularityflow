import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { constants, fstatSync, lstatSync, readSync, unlinkSync } from 'node:fs';
import { incrementCommandCounter } from './dx-command-timing.mjs';
import {
  LEASE_PROCESS_STARTED_AT, LEASE_PROCESS_TOKEN, describeLeaseOwner, leaseOwnerAssessment, leaseOwnerIdentity
} from './lease-liveness.mjs';
import { SingularityFlowError } from "./util.mjs";

const REGISTRY_LOCK_TIMEOUT_MS = 10_000;
// Paces the heartbeat and says when it is reported stale. It never ends a live owner's lease.
const REGISTRY_LOCK_STALE_MS = 15 * 60_000;
const REGISTRY_LOCK_ACQUISITION_GRACE_MS = 30_000;
const REGISTRY_RECLAIM_GRACE_MS = 30_000;
const REGISTRY_RECLAIM_GENERATIONS = 32;
const heldFileLeases = new Map();
const leaseSignalHandlers = new Map();
const CACHE_LEASE_STALE_MS = 15 * 60_000;
const LEASE_BYTES = 4096;


function nowIso() { return new Date().toISOString(); }

/** The shared liveness answer (src/lease-liveness.mjs) for a parsed owner record, or null. */
function registryLeaseLiveness(owner, info = null, staleMs = REGISTRY_LOCK_STALE_MS) {
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) return null;
  return leaseOwnerAssessment(owner, {
    heartbeatMtimeMs: info ? Number(info.mtimeMs) : null, heartbeatTtlMs: staleMs
  });
}

function registryLeaseReclaimIdentity(ownerBytes, info) {
  return createHash('sha256').update(JSON.stringify({
    ownerBytes: ownerBytes ?? null,
    device: String(info?.dev ?? ''),
    inode: String(info?.ino ?? ''),
    birthtimeMs: Number(info?.birthtimeMs ?? 0),
    mtimeMs: Number(info?.mtimeMs ?? 0)
  })).digest('hex').slice(0, 32);
}

function registryLeaseAgeMs(info) {
  return Math.max(0, Date.now() - Number(info?.mtimeMs ?? 0));
}

async function registryLeaseState(lock, {
  staleMs = REGISTRY_LOCK_STALE_MS,
  acquisitionGraceMs = REGISTRY_LOCK_ACQUISITION_GRACE_MS
} = {}) {
  let info;
  try { info = await lstat(lock, { bigint: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  // The lease is a regular file. An unexpected path type is never interpreted as an abandoned
  // lease because reclaiming it could move an unrelated directory or a symlink target selected by
  // another process.
  if (!info.isFile() || info.isSymbolicLink()) {
    return { info, ownerBytes: null, owner: null, stale: false, reclaimIdentity: null };
  }
  const ownerBytes = await readFile(lock, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (ownerBytes === null) return null;
  let owner = null;
  try { owner = JSON.parse(ownerBytes); } catch { /* malformed abandoned lock */ }
  const ageMs = registryLeaseAgeMs(info);
  const liveness = registryLeaseLiveness(owner, info, staleMs);
  const ownerAlive = Boolean(liveness) && liveness.state !== 'dead';
  // Only a proven-dead owner is taken over (after the short grace that also covers a crash between
  // open and owner publication). The inode heartbeat is reported, never decisive: a 15-minute age
  // used to retire a live owner's lease, and another machine's, while it was still writing.
  const stale = !ownerAlive && ageMs > acquisitionGraceMs;
  return {
    info,
    ownerBytes,
    owner,
    ownerAlive,
    liveness,
    ageMs,
    stale,
    reclaimIdentity: registryLeaseReclaimIdentity(ownerBytes, info)
  };
}

function registryReclaimClaimPath(lock, identity, generation, options = {}) {
  if (options.reclaimRoot) {
    const namespace = createHash('sha256').update(lock).digest('hex').slice(0, 16);
    return path.join(options.reclaimRoot, `lease-${namespace}-${identity}-${String(generation).padStart(4, '0')}`);
  }
  return `${lock}.reclaimed-${identity}-${String(generation).padStart(4, '0')}`;
}

async function registryReclaimDestinationState(destination) {
  let info;
  try { info = await lstat(destination); }
  catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return 'missing';
    throw error;
  }
  if (info.isSymbolicLink()) return 'invalid';
  if (info.isFile()) return 'retired';
  if (info.isDirectory()) return 'fenced';
  return 'invalid';
}

async function registryReclaimClaimState(claim, {
  reclaimGraceMs = REGISTRY_RECLAIM_GRACE_MS,
  acquisitionGraceMs = REGISTRY_LOCK_ACQUISITION_GRACE_MS
} = {}) {
  let info;
  try { info = await lstat(claim, { bigint: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new SingularityFlowError(
      `The local workspace registry reclaim marker is unsafe: ${claim}. Remove it only after inspection.`,
      { code: 'WORKSPACE_REGISTRY_BUSY' }
    );
  }
  const destination = path.join(claim, 'retired.lock');
  const destinationState = await registryReclaimDestinationState(destination);
  if (destinationState === 'invalid') {
    throw new SingularityFlowError(
      `The local workspace registry reclaim fence is unsafe: ${destination}. Remove it only after inspection.`,
      { code: 'WORKSPACE_REGISTRY_BUSY' }
    );
  }
  let owner = null;
  try { owner = JSON.parse(await readFile(path.join(claim, 'claim.json'), 'utf8')); }
  catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const ageMs = registryLeaseAgeMs(info);
  return {
    destination,
    destinationState,
    // A claim is a fence, not a lease: fencing a slow claimant never adds a writer, so age may end it.
    stale: destinationState === 'missing'
      && (ageMs > reclaimGraceMs
        || ((registryLeaseLiveness(owner)?.state ?? 'dead') === 'dead' && ageMs > acquisitionGraceMs))
  };
}

async function fenceAbandonedRegistryReclaimClaim(claimState, identity) {
  try {
    await mkdir(claimState.destination, { mode: 0o700 });
  } catch (error) {
    if (['EEXIST', 'EISDIR', 'ENOTDIR'].includes(error?.code)) {
      return registryReclaimDestinationState(claimState.destination);
    }
    throw error;
  }
  // A non-empty directory is an atomic, permanent fence: POSIX and Windows rename cannot replace
  // it with the old lock file if an abandoned claimant later resumes.
  await writeFile(path.join(claimState.destination, 'fenced.claim'), `${identity}\n`, {
    flag: 'wx', mode: 0o600
  });
  return 'fenced';
}

async function invokeRegistryLeaseHook(hooks, name, value) {
  const hook = hooks?.[name];
  if (typeof hook === 'function') await hook(value);
}

/**
 * Reclaim exactly one observed stale lease without a compare-then-unlink successor race.
 *
 * Each deterministic claim generation has a unique `retired.lock` destination. A completed
 * generation retains the old lock there. An abandoned generation is recovered by creating a
 * directory at that destination before advancing to the next generation. That directory is the
 * atomic fence: a paused old claimant can no longer rename either the old lease or a successor into
 * its destination. Claims are never reused or deleted, so delayed contenders cannot regain stale
 * authority over the acquisition pathname.
 */
async function reclaimRegistryFileLease(lock, observed, options = {}) {
  // A reviewed release names the exact owner token a person checked; it stands in for staleness.
  const permitted = (state) => state.stale
    || (typeof options.reviewedToken === 'string' && (state.owner?.token ?? state.owner?.nonce) === options.reviewedToken);
  if (!observed || !permitted(observed) || !observed.reclaimIdentity) return false;
  for (let generation = 0; generation < REGISTRY_RECLAIM_GENERATIONS; generation += 1) {
    const claim = registryReclaimClaimPath(lock, observed.reclaimIdentity, generation, options);
    let created = false;
    try {
      await mkdir(claim, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    if (!created) {
      const claimState = await registryReclaimClaimState(claim, options);
      if (!claimState) continue;
      if (claimState.destinationState === 'retired') return false;
      if (claimState.destinationState === 'fenced') continue;
      if (!claimState.stale) return false;
      const fenced = await fenceAbandonedRegistryReclaimClaim(
        claimState, observed.reclaimIdentity
      );
      if (fenced === 'retired') return false;
      if (fenced === 'fenced') continue;
      return false;
    }

    const claimToken = randomUUID();
    await writeFile(path.join(claim, 'claim.json'), `${JSON.stringify({
      ...leaseOwnerIdentity(),
      claimToken,
      reclaimIdentity: observed.reclaimIdentity,
      createdAt: nowIso()
    })}\n`, { flag: 'wx', mode: 0o600 });
    await invokeRegistryLeaseHook(options.hooks, 'afterClaimCreated', {
      claim, claimToken, generation, observed
    });

    const current = options.cachePolicy
      ? await cacheFileLeaseState(lock, options) : await registryLeaseState(lock, options);
    if (!current || !permitted(current)
        || current.reclaimIdentity !== observed.reclaimIdentity
        || current.ownerBytes !== observed.ownerBytes
        || String(current.info.dev) !== String(observed.info.dev)
        || String(current.info.ino) !== String(observed.info.ino)) return false;
    const destination = path.join(claim, 'retired.lock');
    await invokeRegistryLeaseHook(options.hooks, 'beforeRetire', {
      claim, destination, claimToken, generation, observed
    });
    try {
      await rename(lock, destination);
      return true;
    } catch (error) {
      if (['ENOENT', 'EEXIST', 'ENOTEMPTY', 'EISDIR', 'ENOTDIR'].includes(error?.code)) {
        return false;
      }
      throw error;
    }
  }
  throw new SingularityFlowError(
    'The local workspace registry contains too many interrupted reclaim generations. Inspect the retained reclaim markers before retrying.',
    { code: 'WORKSPACE_REGISTRY_BUSY' }
  );
}

function startRegistryLeaseHeartbeat(handle, {
  staleMs = REGISTRY_LOCK_STALE_MS,
  acquisitionGraceMs = REGISTRY_LOCK_ACQUISITION_GRACE_MS
} = {}) {
  const renewalWindowMs = Math.max(40, Math.min(staleMs, acquisitionGraceMs));
  const intervalMs = Math.max(10, Math.min(30_000, Math.floor(renewalWindowMs / 4)));
  const worker = new Worker(`
    const { futimesSync } = require('node:fs');
    const { parentPort, workerData } = require('node:worker_threads');
    const stop = () => { clearInterval(timer); parentPort.close(); };
    const beat = () => {
      try {
        const now = new Date();
        futimesSync(workerData.fd, now, now);
      } catch {
        stop();
      }
    };
    const timer = setInterval(beat, workerData.intervalMs);
    parentPort.on('message', stop);
  `, {
    eval: true,
    execArgv: [],
    workerData: { fd: handle.fd, intervalMs }
  });
  // A worker startup failure must not become an unhandled process exception. The bounded lease
  // still expires fail-safe; ordinary asynchronous operations also complete well inside its TTL.
  worker.on('error', () => {});
  worker.unref();
  return worker;
}

async function removeOwnedRegistryLeaseCandidate(lock, handle, acquiredInfo) {
  await handle?.close().catch(() => {});
  let current;
  try { current = await lstat(lock, { bigint: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (String(current.dev) === String(acquiredInfo?.dev)
      && String(current.ino) === String(acquiredInfo?.ino)) {
    await rm(lock, { force: true });
  }
}

function registryLeaseNeedsReview(observed) {
  const liveness = observed?.liveness;
  if (!liveness || typeof observed.owner?.token !== 'string') return false;
  return liveness.state === 'unknown'
    || (liveness.state === 'alive' && liveness.reason !== 'this-process' && liveness.heartbeat !== 'fresh');
}

/** The reviewed-release route a registry refusal names; `releaseRegistryLeaseAfterReview` runs it. */
export function registryLeaseReleaseCommand(lock, token) {
  return `singularity-flow lock release-file ${JSON.stringify(lock)} --confirm ${token}`;
}

/** The read a person reviews before that release: `inspectRegistryLease` answers it. */
export function registryLeaseShowCommand(lock) {
  return `singularity-flow lock show-file ${JSON.stringify(lock)}`;
}

function livenessDetails(liveness) {
  return liveness ? { state: liveness.state, reason: liveness.reason, heartbeat: liveness.heartbeat, lastHeartbeatAt: liveness.lastHeartbeatAt } : null;
}

function registryBusyError(lock, observed) {
  let message = 'The local workspace registry is busy in another process. Retry the same command.';
  const details = { lock };
  if (observed?.owner && observed.liveness) {
    details.owner = observed.owner;
    details.liveness = livenessDetails(observed.liveness);
  }
  if (registryLeaseNeedsReview(observed)) {
    const { owner, liveness } = observed;
    details.releaseCommand = registryLeaseReleaseCommand(lock, owner.token);
    message = `The lease ${lock} is held by ${describeLeaseOwner(owner, liveness)}. `
      + (liveness.state === 'unknown'
        ? 'That process runs on another machine, so this one cannot prove it stopped and never takes the lease over. '
        : 'That process is still running here but stopped renewing the lease; stopping it frees the lease. ')
      + `Review it with: ${registryLeaseShowCommand(lock)}. `
      + `After checking that it no longer uses this file, release exactly that lease with: ${details.releaseCommand}`;
  }
  return new SingularityFlowError(message, { code: 'WORKSPACE_REGISTRY_BUSY', details });
}

/**
 * Read-only: who holds a registry lease file and whether only a reviewed release can end it. The
 * same answer `lock show` gives a subject lease, for the lease files a refusal names by path.
 */
export async function inspectRegistryLease(lockFile) {
  const lock = path.resolve(lockFile);
  const observed = await registryLeaseState(lock);
  if (!observed) return Object.freeze({ lock, held: false, owner: null, liveness: null, releaseCommand: null });
  return Object.freeze({
    lock, held: true, owner: observed.owner, liveness: livenessDetails(observed.liveness),
    releaseCommand: registryLeaseNeedsReview(observed) ? registryLeaseReleaseCommand(lock, observed.owner.token) : null
  });
}

/**
 * A person's way out of a registry lease this machine cannot prove abandoned. `expectedToken` is
 * the reviewed owner token: only that inode generation moves, into a retained reclaim claim (the
 * audit record), never a successor. A live owner here that still renews it is refused.
 */
export async function releaseRegistryLeaseAfterReview(lockFile, { expectedToken, hooks = null } = {}) {
  const lock = path.resolve(lockFile);
  if (typeof expectedToken !== 'string' || !expectedToken) {
    throw new SingularityFlowError('A lease release confirms the reviewed lease token.', {
      code: 'WORKSPACE_REGISTRY_RELEASE_INVALID', details: { lock }
    });
  }
  const observed = await registryLeaseState(lock);
  if (!observed) return Object.freeze({ released: false, reason: 'already-released', lock });
  if (observed.owner?.token !== expectedToken) {
    throw new SingularityFlowError(`The lease ${lock} is no longer the reviewed one. Nothing was released; review it again with: ${registryLeaseShowCommand(lock)}`, {
      code: 'WORKSPACE_REGISTRY_RELEASE_MISMATCH', details: { lock, owner: observed.owner, nextAction: registryLeaseShowCommand(lock) }
    });
  }
  const liveness = observed.liveness;
  if (liveness?.state === 'alive' && (liveness.reason === 'this-process' || liveness.heartbeat === 'fresh')) {
    throw new SingularityFlowError(
      `The lease ${lock} belongs to ${describeLeaseOwner(observed.owner, liveness)}, which is running on this machine and still renewing it. `
      + 'Nothing was released; let it finish or stop that process.',
      { code: 'WORKSPACE_REGISTRY_RELEASE_REFUSED', details: { lock, owner: observed.owner } }
    );
  }
  let claim = null;
  const released = await reclaimRegistryFileLease(lock, observed, {
    reviewedToken: expectedToken,
    hooks: { ...hooks, beforeRetire: async (value) => { claim = value.claim; await hooks?.beforeRetire?.(value); } }
  });
  if (!released) {
    throw new SingularityFlowError(`The lease ${lock} changed while it was being released. Nothing else was removed; review it again with: ${registryLeaseShowCommand(lock)}`, {
      code: 'WORKSPACE_REGISTRY_RELEASE_MISMATCH', details: { lock, nextAction: registryLeaseShowCommand(lock) }
    });
  }
  return Object.freeze({
    released: true, lock, token: expectedToken, owner: observed.owner,
    liveness: liveness ? { state: liveness.state, heartbeat: liveness.heartbeat, lastHeartbeatAt: liveness.lastHeartbeatAt } : null,
    retainedAt: claim ? path.join(claim, 'retired.lock') : null
  });
}

/** @internal Cross-process manifest lease; exported so its race contract can be process-tested. */
export async function withRegistryFileLease(file, operation, options = {}) {
  const lock = `${path.resolve(file)}.lock`;
  await mkdir(path.dirname(lock), { recursive: true });
  const started = Date.now();
  const token = randomUUID();
  const timeoutMs = options.timeoutMs ?? REGISTRY_LOCK_TIMEOUT_MS;
  let handle;
  let acquiredInfo;
  let heartbeat = null;
  while (!handle) {
    let candidate;
    let candidateHeartbeat = null;
    try {
      candidate = await open(lock, 'wx', 0o600);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const observed = await registryLeaseState(lock, options);
      if (observed?.stale) {
        await invokeRegistryLeaseHook(options.hooks, 'afterStaleObserved', { lock, observed });
      }
      if (observed?.stale) {
        const reclaimed = await reclaimRegistryFileLease(lock, observed, options);
        await invokeRegistryLeaseHook(options.hooks, 'afterReclaimAttempt', {
          lock, observed, reclaimed
        });
        if (reclaimed) continue;
      }
      if (Date.now() - started >= timeoutMs) throw registryBusyError(lock, observed);
      await new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 50)));
      continue;
    }
    try {
      acquiredInfo = await candidate.stat({ bigint: true });
      // Acquisition creates the inode before it can publish owner bytes. Start the inode-bound
      // heartbeat first so a stalled write can never age past the malformed-owner grace and be
      // retired while this process still holds the original descriptor.
      candidateHeartbeat = startRegistryLeaseHeartbeat(candidate, options);
      await invokeRegistryLeaseHook(options.hooks, 'afterLockOpened', {
        lock, token, acquiredInfo
      });
      const ownerBytes = `${JSON.stringify({
        ...leaseOwnerIdentity(),
        token,
        createdAt: nowIso()
      })}\n`;
      await candidate.writeFile(ownerBytes);
      await candidate.sync();
      handle = candidate;
      heartbeat = candidateHeartbeat;
      heldFileLeases.set(lock, { file: lock, handle, info: acquiredInfo,
        bytes: Buffer.from(ownerBytes), protected: false });
    } catch (error) {
      if (candidateHeartbeat) await candidateHeartbeat.terminate().catch(() => {});
      await removeOwnedRegistryLeaseCandidate(lock, candidate, acquiredInfo).catch(() => {});
      throw error;
    }
  }
  try {
    return await operation();
  } finally {
    if (heldFileLeases.get(lock)?.handle === handle) heldFileLeases.delete(lock);
    if (heartbeat) await heartbeat.terminate().catch(() => {});
    await handle.close().catch(() => {});
    const current = await registryLeaseState(lock, options).catch(() => null);
    if (current?.ownerBytes
        && String(current.info.dev) === String(acquiredInfo?.dev)
        && String(current.info.ino) === String(acquiredInfo?.ino)) {
      try {
        const owner = JSON.parse(current.ownerBytes);
        if (owner?.token === token
            && owner.processToken === LEASE_PROCESS_TOKEN
            && owner.processStartedAt === LEASE_PROCESS_STARTED_AT) {
          await rm(lock, { force: true }).catch(() => {});
        }
      } catch { /* A changed or malformed successor is never removed. */ }
    }
  }
}

function leaseError(code = 'FILE_LEASE_UNAVAILABLE') {
  return new SingularityFlowError('The private cache lease is unavailable; use the uncached read.', { code });
}

function sameInode(left, right) {
  return Boolean(left && right && String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino) && String(left.birthtimeMs) === String(right.birthtimeMs));
}

async function readCacheLease(file) {
  let before;
  try { before = await lstat(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size > BigInt(LEASE_BYTES)
      || (typeof process.getuid === 'function' && before.uid !== BigInt(process.getuid()))) {
    return { info: before, ownerBytes: null, unsafe: true };
  }
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!sameInode(before, opened)) return { info: before, ownerBytes: null, unsafe: true };
    const bytes = Buffer.alloc(LEASE_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await lstat(file, { bigint: true });
    if (bytesRead > LEASE_BYTES || !sameInode(opened, after)
        || opened.mtimeMs !== after.mtimeMs || opened.size !== after.size) {
      return { info: before, ownerBytes: null, unsafe: true };
    }
    return { info: after, ownerBytes: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)) };
  } catch (error) {
    if (['ENOENT', 'ELOOP'].includes(error.code)) return null;
    throw error;
  } finally { await handle?.close().catch(() => {}); }
}

function processDeath(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

const CACHE_OWNER_KEYS = new Set(['version', 'pid', 'host', 'nonce', 'createdAt', 'heartbeatAt',
  'quarantine', 'childPids', 'unknownChildren']);
// Version 3 records the machine identity every other lease records (src/lease-liveness.mjs), so its
// owner is judged by machine ID and process start, not by a hostname that changes with the network
// or a PID the OS gave to another process (A5). An older build refuses a version 3 record (fail closed).
const CACHE_OWNER_IDENTITY_KEYS = new Set(['machineId', 'pidNamespace', 'hardwareDigest', 'processStartedAt', 'processToken']);

function cacheOwner(text) {
  let owner;
  try { owner = JSON.parse(text); } catch { return null; }
  const identity = owner?.version === 3;
  if (!owner || typeof owner !== 'object' || Array.isArray(owner) || (owner.version !== 2 && !identity)
      || Object.keys(owner).some((key) => !CACHE_OWNER_KEYS.has(key) && !(identity && CACHE_OWNER_IDENTITY_KEYS.has(key)))
      || !Number.isSafeInteger(owner.pid) || owner.pid < 1
      || typeof owner.host !== 'string' || owner.host.length < 1 || owner.host.length > 256
      || /[\u0000-\u001f\u007f]/u.test(owner.host)
      || !/^[a-f0-9-]{36}$/u.test(owner.nonce ?? '')
      || !Number.isFinite(Date.parse(owner.createdAt)) || !Number.isFinite(Date.parse(owner.heartbeatAt))
      || (owner.quarantine !== undefined && typeof owner.quarantine !== 'boolean')
      || (owner.unknownChildren !== undefined && typeof owner.unknownChildren !== 'boolean')
      || (owner.childPids !== undefined && (!Array.isArray(owner.childPids) || owner.childPids.length > 128
        || owner.childPids.some((pid) => !Number.isSafeInteger(pid) || pid < 1)
        || new Set(owner.childPids).size !== owner.childPids.length))
      || [owner.machineId, owner.pidNamespace, owner.hardwareDigest, owner.processToken]
        .some((value) => value !== undefined && (typeof value !== 'string' || !value || value.length > 256))
      || (owner.processStartedAt !== undefined && !Number.isFinite(owner.processStartedAt))) return null;
  return owner;
}

/**
 * Whether a cache lease's owner is running here and can still finish: this process, or a process
 * here whose recorded start matches and whose lease is younger than its bound. A version 2 record has
 * no start to compare, so its running PID proves nothing about it (a recycled PID looks the same).
 */
function cacheLeaseActive(owner, liveness) {
  return liveness?.state === 'alive' && (liveness.reason === 'this-process'
    || (liveness.heartbeat === 'fresh' && Number.isFinite(owner?.processStartedAt)));
}

/**
 * A lease this copy of the module wrote and no longer holds: a release whose removal failed. Its
 * process is this one, so it reads as alive, yet nothing here will ever release it. A held lease is
 * found by its inode: the same file is often reached by another spelling (`/var` and `/private/var`).
 */
function releasedHere(owner, info) {
  if (owner.processToken !== LEASE_PROCESS_TOKEN || owner.quarantine === true) return false;
  for (const held of heldFileLeases.values()) if (sameInode(held.info, info)) return false;
  return true;
}

async function cacheFileLeaseState(file, { staleMs = CACHE_LEASE_STALE_MS, legacyQuarantine = false, legacyOwner = null } = {}) {
  const observed = await readCacheLease(file);
  if (!observed) return null;
  let reason = 'unverifiable'; let stale = false; let liveness = null;
  const owner = observed.ownerBytes === null ? null : cacheOwner(observed.ownerBytes);
  if (owner) {
    // One rule for every lease family: only a proven-dead owner is taken over, never one by age.
    liveness = leaseOwnerAssessment(owner, { heartbeatMtimeMs: Number(observed.info.mtimeMs), heartbeatTtlMs: staleMs });
    if (liveness.state === 'unknown') reason = 'foreign-owner';
    else if (liveness.state === 'alive' && !releasedHere(owner, observed.info)) reason = 'live-owner';
    else if (owner.unknownChildren === true
        || (owner.quarantine === true && owner.unknownChildren !== false)) reason = 'unknown-children';
    else if ((owner.childPids ?? []).some((pid) => !processDeath(pid))) reason = 'live-child';
    else { stale = true; reason = owner.quarantine ? 'dead-quarantine' : liveness.state === 'alive' ? 'released-here' : 'dead-owner'; }
  } else if (!observed.unsafe) {
    const text = observed.ownerBytes.trim();
    // Older active-operation markers carry no trustworthy child identity. Age cannot establish
    // process cleanup. Only the local allocation-only dialect, and an older build's owner text for
    // the caller's own lock (`legacyOwner`), may use legacy acquisition age: they carry no identity.
    const legacy = /^[a-f0-9-]{36}$/u.test(text) || text === '' || legacyOwner?.test(text) === true;
    if (legacy && !legacyQuarantine) {
      stale = registryLeaseAgeMs(observed.info) > staleMs;
      reason = stale ? 'legacy-stale' : 'legacy-busy';
    } else if (legacyQuarantine) reason = 'unknown-children';
  }
  return { ...observed, owner, liveness, stale, reason,
    reclaimIdentity: observed.unsafe ? null : registryLeaseReclaimIdentity(observed.ownerBytes, observed.info) };
}

/**
 * Read-only local ownership inspection. No age override can reclaim a live/unknown-child store.
 * `active` says the owner runs here and can still finish; a held lease that is not active and not
 * reclaimable names its review and reviewed release, as a registry lease does.
 */
export async function inspectFileLease(file, options = {}) {
  const lock = path.resolve(file);
  const observed = await cacheFileLeaseState(lock, options);
  if (!observed) return { state: 'missing', reason: 'missing' };
  const state = observed.stale ? 'reclaimable' : observed.reason === 'unverifiable' ? 'unverifiable' : 'busy';
  // An acquisition creates the file before it writes its owner: a young empty lease is being written.
  const writing = !observed.owner && !observed.unsafe && observed.ownerBytes?.trim() === ''
    && registryLeaseAgeMs(observed.info) <= REGISTRY_LOCK_ACQUISITION_GRACE_MS;
  const active = state === 'busy' && (writing || cacheLeaseActive(observed.owner, observed.liveness));
  return { state, reason: observed.reason, active,
    ...(observed.owner ? { owner: observed.owner, liveness: livenessDetails(observed.liveness), token: observed.owner.nonce,
      showCommand: registryLeaseShowCommand(lock),
      releaseCommand: state === 'busy' && !active ? registryLeaseReleaseCommand(lock, observed.owner.nonce) : null } : {}) };
}

/**
 * A lease file named by its path, whichever family wrote it: a cache lease (a read index refresh, a
 * configuration cache) or a registry lease. What `lock show-file` prints.
 */
export async function inspectLeaseFile(file) {
  const lock = path.resolve(file);
  const cache = await cacheFileLeaseState(lock).catch(() => null);
  if (!cache?.owner) return inspectRegistryLease(lock);
  const inspected = await inspectFileLease(lock);
  return Object.freeze({ lock, held: true, form: 'cache', owner: cache.owner, liveness: inspected.liveness,
    active: inspected.active, state: inspected.state, releaseCommand: inspected.releaseCommand });
}

/**
 * `lock release-file` for either family. A cache lease moves into its retained reclaim area under
 * the reviewed token (its owner's nonce), never a successor; one whose owner runs here and can still
 * finish is refused.
 */
export async function releaseLeaseFileAfterReview(file, { expectedToken, hooks = null } = {}) {
  const lock = path.resolve(file);
  const observed = await cacheFileLeaseState(lock).catch(() => null);
  if (!observed?.owner) return releaseRegistryLeaseAfterReview(lock, { expectedToken, hooks });
  if (typeof expectedToken !== 'string' || !expectedToken) {
    throw new SingularityFlowError('A lease release confirms the reviewed lease token.', {
      code: 'WORKSPACE_REGISTRY_RELEASE_INVALID', details: { lock }
    });
  }
  if (observed.owner.nonce !== expectedToken) {
    throw new SingularityFlowError(`The lease ${lock} is no longer the reviewed one. Nothing was released; review it again with: ${registryLeaseShowCommand(lock)}`, {
      code: 'WORKSPACE_REGISTRY_RELEASE_MISMATCH', details: { lock, owner: observed.owner, nextAction: registryLeaseShowCommand(lock) }
    });
  }
  if (cacheLeaseActive(observed.owner, observed.liveness)) {
    throw new SingularityFlowError(
      `The lease ${lock} belongs to ${describeLeaseOwner(observed.owner, observed.liveness)}, which is running on this machine and can still finish. `
      + 'Nothing was released; let it finish or stop that process.',
      { code: 'WORKSPACE_REGISTRY_RELEASE_REFUSED', details: { lock, owner: observed.owner } }
    );
  }
  let claim = null;
  const released = await reclaimRegistryFileLease(lock, observed, {
    cachePolicy: true, reviewedToken: expectedToken, reclaimRoot: await privateReclaimRoot(lock),
    hooks: { ...hooks, beforeRetire: async (value) => { claim = value.claim; await hooks?.beforeRetire?.(value); } }
  });
  if (!released) {
    throw new SingularityFlowError(`The lease ${lock} changed while it was being released. Nothing else was removed; review it again with: ${registryLeaseShowCommand(lock)}`, {
      code: 'WORKSPACE_REGISTRY_RELEASE_MISMATCH', details: { lock, nextAction: registryLeaseShowCommand(lock) }
    });
  }
  return Object.freeze({ released: true, lock, token: expectedToken, owner: observed.owner,
    liveness: livenessDetails(observed.liveness), retainedAt: claim ? path.join(claim, 'retired.lock') : null });
}

async function privateReclaimRoot(file) {
  const root = path.join(path.dirname(file), '.file-lease-reclaims');
  await mkdir(root, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(root);
  // Windows reports synthetic mode bits even for a directory created with mode 0700; those
  // bits cannot establish its DACL. Keep the existing same-user derived-cache boundary there,
  // while still refusing links/non-directories and retaining exact nonce/inode/death fences.
  if (!info.isDirectory() || info.isSymbolicLink()
      || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
      || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw leaseError();
  return root;
}

/**
 * One bounded, nonce/inode-bound lease for disposable private caches. Reclaim uses the same
 * permanent atomic claim fences as registry leases; a paused reclaimer cannot retire a successor.
 * A protected operation is never automatically reaped without exact child-death evidence.
 */
export async function acquireFileLease(file, { waitMs = 0, staleMs = CACHE_LEASE_STALE_MS,
  legacyQuarantine = false, legacyOwner = null, onReclaimed = null } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')
      || !Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 250
      || !Number.isSafeInteger(staleMs) || staleMs < 1
      || typeof legacyQuarantine !== 'boolean' || (legacyOwner !== null && !(legacyOwner instanceof RegExp))
      || (onReclaimed !== null && typeof onReclaimed !== 'function')) throw leaseError('FILE_LEASE_INVALID');
  const started = performance.now();
  let reclaimed = false; let reclaimReason = null;
  let handle;
  while (!handle) {
    try { handle = await open(file, 'wx+', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const observed = await cacheFileLeaseState(file, { staleMs, legacyQuarantine, legacyOwner });
      if (!observed) continue;
      if (observed.stale) {
        const reclaimRoot = await privateReclaimRoot(file);
        if (await reclaimRegistryFileLease(file, observed, { cachePolicy: true, staleMs, legacyQuarantine, legacyOwner, reclaimRoot })) {
          reclaimed = true; reclaimReason = observed.reason;
          incrementCommandCounter(`cache.lease-reclaimed-${reclaimReason}`);
          continue;
        }
      }
      const remaining = waitMs - (performance.now() - started);
      if (remaining <= 0) return null;
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)));
    }
  }
  let frame;
  let owner = { version: 3, ...leaseOwnerIdentity(), nonce: randomUUID(),
    createdAt: nowIso(), heartbeatAt: nowIso() };
  let active = true;
  let releasing = false;
  const ownsExactFrame = async () => {
    if (!active || !frame) return false;
    const observed = await readCacheLease(file).catch(() => null);
    return Boolean(observed && !observed.unsafe && sameInode(frame.info, observed.info)
      && observed.ownerBytes === frame.bytes?.toString('utf8'));
  };
  const owns = async () => !releasing && await ownsExactFrame();
  const writeOwner = async (value, initial = false) => {
    if (!initial && !await owns()) throw leaseError('FILE_LEASE_OWNERSHIP_LOST');
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    await handle.truncate(0);
    await handle.write(bytes, 0, bytes.length, 0);
    await handle.sync();
    frame.bytes = bytes; owner = value;
  };
  // `remove: false` closes and forgets the lease and leaves its file to a caller that removes it
  // with its own retries; until then a later acquisition here takes it over as released here.
  const release = async ({ cleanupConfirmed = false, remove = true } = {}) => {
    if (!active || releasing) return false;
    // Fence before the first await: duplicate releases must not inspect one generation and then
    // remove a replacement acquired after another release has finished.
    releasing = true;
    frame.releasing = true;
    let removed = false;
    try {
      if (remove && (!frame.protected || cleanupConfirmed === true) && await ownsExactFrame()) {
        await rm(file, { force: true }); removed = true;
      }
    } finally {
      active = false;
      if (heldFileLeases.get(file) === frame) heldFileLeases.delete(file);
      await handle.close().catch(() => {});
    }
    return removed;
  };
  const retainQuarantine = async ({ childPids = [], unknownChildren = true } = {}) => {
    if (!Array.isArray(childPids) || childPids.length > 128 || typeof unknownChildren !== 'boolean'
        || childPids.some((pid) => !Number.isSafeInteger(pid) || pid < 1)
        || new Set(childPids).size !== childPids.length) throw leaseError('FILE_LEASE_INVALID');
    frame.protected = true;
    await writeOwner({ ...owner, heartbeatAt: nowIso(), quarantine: true, childPids: [...childPids], unknownChildren });
    return true;
  };
  try {
    // Guard every post-open operation, including stat. An I/O failure cannot leak the descriptor;
    // without inode identity we preserve the empty candidate rather than deleting an unknown path.
    frame = { file, handle, info: await handle.stat({ bigint: true }), bytes: null, protected: false };
    // Held before its owner is readable: another acquisition here never reads it as released here.
    heldFileLeases.set(file, frame);
    await writeOwner(owner, true);
    if (reclaimed && onReclaimed) await onReclaimed({ reason: reclaimReason });
    return Object.freeze({ file, info: frame.info, owner: Object.freeze({ ...owner }), bytes: frame.bytes.toString('utf8'),
      reclaimed, owns, release, retainQuarantine, protect: () => retainQuarantine({ unknownChildren: true }) });
  } catch (error) {
    if (frame) await release().catch(() => {});
    else await handle.close().catch(() => {});
    throw error;
  }
}

/**
 * A small local lock (a store's write lock, a receipt's mutation lock) behind a bounded wait: the
 * cache lease's rule, so only a proven-dead owner, or this process's own released lease, is taken
 * over, never a live one by age. Null when it is still held at the deadline; the refusal then adds
 * `heldFileLeaseRoute`.
 */
export async function acquireFileLeaseWithin(file, timeoutMs, options = {}) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const waitMs = Math.max(0, Math.min(250, Math.floor(deadline - performance.now())));
    const lease = await acquireFileLease(file, { ...options, waitMs });
    if (lease || waitMs === 0) return lease;
  }
}

/**
 * What a refusal adds for a lease file still held at its deadline. Its holder, and when waiting
 * cannot end it (another machine's owner, or one here that stopped renewing), the review and the
 * exact reviewed release, which the refusal plan makes the person's first step.
 */
export async function heldFileLeaseRoute(file) {
  const lock = path.resolve(file);
  const held = await inspectFileLease(lock).catch(() => null);
  if (!held?.owner) return { message: '', details: { lock } };
  const details = { lock, owner: held.owner, liveness: held.liveness };
  if (!held.releaseCommand) return { message: '', details };
  return {
    message: ` It is held by ${describeLeaseOwner(held.owner, held.liveness)}, and waiting does not end it. `
      + `Review it with: ${held.showCommand}. After checking that it no longer uses this file, release exactly that lease with: ${held.releaseCommand}`,
    details: { ...details, releaseCommand: held.releaseCommand }
  };
}

/** Best effort synchronous signal cleanup; no protected or changed successor is removed. */
export function releaseHeldFileLeasesSync({ budgetMs = 100 } = {}) {
  const deadline = performance.now() + Math.min(100, Math.max(0, budgetMs));
  for (const [key, frame] of heldFileLeases) {
    if (performance.now() >= deadline) break;
    if (frame.protected || frame.releasing || !frame.bytes) continue;
    try {
      const opened = fstatSync(frame.handle.fd, { bigint: true });
      const current = lstatSync(frame.file, { bigint: true });
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n
          || !sameInode(opened, frame.info) || !sameInode(opened, current)) continue;
      const bytes = Buffer.alloc(LEASE_BYTES + 1);
      const read = readSync(frame.handle.fd, bytes, 0, bytes.length, 0);
      if (read !== frame.bytes.length || !frame.bytes.equals(bytes.subarray(0, read))) continue;
      unlinkSync(frame.file); heldFileLeases.delete(key);
    } catch { /* A crash/death check on the next invocation remains the safety net. */ }
  }
}

/** Installed only around CLI main. Existing embedding signal owners are not replaced. */
export function installFileLeaseSignalHandlers() {
  const installed = [];
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    const retained = leaseSignalHandlers.get(signal);
    if (retained) { retained.references += 1; installed.push(signal); continue; }
    if (process.listenerCount(signal) > 0) continue;
    const handler = () => {
      releaseHeldFileLeasesSync();
      process.removeListener(signal, handler);
      process.kill(process.pid, signal);
    };
    try {
      process.on(signal, handler); leaseSignalHandlers.set(signal, { handler, references: 1 }); installed.push(signal);
    } catch { /* Platform has no such signal. */ }
  }
  let active = true;
  return () => {
    if (!active) return; active = false;
    for (const signal of installed) {
      const retained = leaseSignalHandlers.get(signal);
      if (retained && --retained.references === 0) {
        process.removeListener(signal, retained.handler); leaseSignalHandlers.delete(signal);
      }
    }
  };
}
