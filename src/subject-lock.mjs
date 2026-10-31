import { createHash, randomUUID } from 'node:crypto';
import {
  appendFile, link, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile
} from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { AsyncLocalStorage } from 'node:async_hooks';
import { gitCommonDir, gitDir } from './git.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { SingularityFlowError, nowIso } from './util.mjs';
import { measureCommandSpan } from './dx-timing-context.mjs';
import {
  LEASE_PROCESS_TOKEN, describeLeaseOwner, leaseOwnerAssessment, leaseOwnerIdentity, localMachineId
} from './lease-liveness.mjs';

const PROCESS_TOKEN = LEASE_PROCESS_TOKEN;
// A heartbeat renews active `withSubjectLock` leases. The TTL now only paces renewal and says when a
// heartbeat is reported stale: a lease is taken over when its owner is proven dead, never on age
// (src/lease-liveness.mjs). One configured quality command may legally run for two hours.
const DEFAULT_TTL_MS = 3 * 60 * 60 * 1000;
const RECLAIM_GENERATIONS = 16;
const heldLocks = new AsyncLocalStorage();

function safe(value) {
  return encodeURIComponent(String(value)).replace(/%/g, '_');
}

function heartbeatPath(directory, owner) {
  return path.join(directory, `heartbeat-${safe(owner.lockToken)}`);
}

function heartbeatFailurePath(directory, owner) {
  return path.join(directory, `heartbeat-failed-${safe(owner.lockToken)}`);
}

export function subjectLockPath(root, subject) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'locks', `${safe(subject.kind)}--${safe(subject.id)}.lock`);
}

export function repositoryResetBarrierPath(root) {
  // A sibling of the runtime root, not a child: factory reset moves the runtime only after this
  // barrier has made new mutations impossible, and releases the barrier after replacement ends.
  return path.join(gitCommonDir(root), 'singularity-flow-reset.lock');
}

function subjectLockKey(root, subject) {
  return `${gitCommonDir(root)}\0${subject.kind}\0${subject.id}`;
}

/** The exact lease inherited by the current async transaction, if any. */
export function currentSubjectLockOwner(root, subject) {
  const frame = heldLocks.getStore()?.get(subjectLockKey(root, subject));
  return frame?.active && frame.lease?.active ? frame.lease.owner : null;
}

async function invokeLockHook(hooks, name, value) {
  const hook = hooks?.[name];
  if (typeof hook === 'function') await hook(value);
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
  try { return readRecord('subject-lock-owner', text).record; }
  catch (error) {
    // A malformed owner is the same crash-during-acquisition state that the locking protocol has
    // always represented as null. Version-range and migration failures are different: silently
    // treating a valid but unreadable future owner as corrupt could let this build reclaim its lock.
    if (error?.code !== 'SCHEMA_RECORD_INVALID') throw error;
    return null;
  }
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

function ownerTtlMs(owner) {
  const ttl = Date.parse(owner?.expiresAt ?? '') - Date.parse(owner?.acquiredAt ?? '');
  return Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TTL_MS;
}

/**
 * Whether a lock is still held, and by what kind of owner.
 *
 * A recorded owner is held until it is proven dead (src/lease-liveness.mjs). Age used to decide:
 * an owner past its deadline was taken over even while its process ran, so a laptop asleep for
 * three hours, or any lease from another machine, gained a second concurrent writer. The deadline,
 * the heartbeat and a heartbeat-failure marker are now reported, not acted on; the owner's own TTL,
 * not the observer's, says when its heartbeat counts as stale.
 */
function lockLiveness(owner, directoryAgeMs, heartbeatModifiedAt = null, heartbeatFailed = false) {
  if (owner === undefined || owner === null) {
    const abandoned = directoryAgeMs > ACQUISITION_GRACE_MS;
    return Object.freeze({
      held: !abandoned, state: abandoned ? 'dead' : 'acquiring',
      reason: abandoned ? 'abandoned-acquisition' : 'acquiring', heartbeat: 'missing', lastHeartbeatAt: null
    });
  }
  const assessment = leaseOwnerAssessment(owner, {
    heartbeatMtimeMs: heartbeatModifiedAt, heartbeatTtlMs: ownerTtlMs(owner)
  });
  return Object.freeze({
    ...assessment,
    held: assessment.state !== 'dead',
    heartbeat: heartbeatFailed ? 'failed' : assessment.heartbeat
  });
}

/**
 * Take a lock we have judged stale, or lose the race and say so.
 *
 * Read-decide-delete is not atomic: two processes can both judge one abandoned lock stale, then a
 * delayed pathname operation can retire the first winner's successor. Reclamation below therefore
 * binds every rename to one observed directory generation through an exclusive destination claim.
 */
async function pathInfo(target) {
  try { return await lstat(target, { bigint: true }); }
  catch (error) {
    // A lock is absent only when the filesystem says exactly that. Treating EIO, ESTALE or an
    // access failure as ENOENT makes both sides of the reset barrier fail open.
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function directoryIdentity(info) {
  if (!info) return null;
  return {
    device: String(info.dev),
    inode: String(info.ino),
    birthtimeMs: String(info.birthtimeMs)
  };
}

function sameDirectoryIdentity(left, right) {
  const a = directoryIdentity(left);
  const b = directoryIdentity(right);
  return Boolean(a && b
    && a.device === b.device
    && a.inode === b.inode
    && a.birthtimeMs === b.birthtimeMs);
}

function ownerIdentity(owner) {
  if (owner === undefined) return 'owner-missing';
  if (owner === null) return 'owner-invalid';
  return `owner:${JSON.stringify(owner)}`;
}

function sameObservedDirectory(left, right) {
  return Boolean(left?.info && right?.info
    && sameDirectoryIdentity(left.info, right.info)
    && ownerIdentity(left.owner) === ownerIdentity(right.owner));
}

function directoryAgeFromInfo(info) {
  return Math.max(0, Date.now() - Number(info.mtimeMs));
}

async function directoryAge(directory) {
  const info = await pathInfo(directory);
  // Missing means the prior holder completed removal. It is not evidence of an infinitely old
  // lock: another contender may create a fresh directory at the same path immediately afterward.
  return info ? directoryAgeFromInfo(info) : null;
}

async function heartbeatModifiedAt(directory, owner) {
  if (!owner?.lockToken) return null;
  const file = heartbeatPath(directory, owner);
  const info = await pathInfo(file);
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new SingularityFlowError(`Mutation-lock heartbeat must be a regular file: ${file}`, {
      code: 'SUBJECT_LOCK_UNSAFE', details: { lock: directory, heartbeat: file }
    });
  }
  return Number(info.mtimeMs);
}

async function heartbeatFailureRecorded(directory, owner) {
  if (!owner?.lockToken) return false;
  const file = heartbeatFailurePath(directory, owner);
  const info = await pathInfo(file);
  if (!info) return false;
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new SingularityFlowError(`Mutation-lock heartbeat failure marker must be a regular file: ${file}`, {
      code: 'SUBJECT_LOCK_UNSAFE', details: { lock: directory, heartbeatFailure: file }
    });
  }
  return true;
}

async function activeDirectoryOwner(directory) {
  // A lock can be retired and replaced between any two pathname reads. Retry until the owner and
  // heartbeat were read from one directory generation; an unstable path is held, never absent.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await pathInfo(directory);
    if (!before) return { active: false, owner: undefined, info: null, reason: 'missing', liveness: null };
    if (before.isSymbolicLink() || !before.isDirectory()) {
      return { active: true, owner: null, info: before, reason: 'unsafe-lock-entry', liveness: null };
    }
    const owner = await readOwner(directory);
    const heartbeat = await heartbeatModifiedAt(directory, owner);
    const heartbeatFailed = await heartbeatFailureRecorded(directory, owner);
    const after = await pathInfo(directory);
    if (!after) continue;
    if (!sameDirectoryIdentity(before, after)) continue;
    const liveness = lockLiveness(owner, directoryAgeFromInfo(after), heartbeat, heartbeatFailed);
    return { active: liveness.held, owner, info: after, reason: 'active', liveness };
  }
  return { active: true, owner: null, info: null, reason: 'unstable-lock-entry', liveness: null };
}

function reclaimIdentity(state) {
  return createHash('sha256').update(JSON.stringify({
    directory: directoryIdentity(state?.info),
    owner: ownerIdentity(state?.owner)
  })).digest('hex').slice(0, 32);
}

function reclaimClaimPath(directory, state, generation) {
  return `${directory}.reclaim-${reclaimIdentity(state)}-${String(generation).padStart(4, '0')}`;
}

async function reclaimDestinationState(destination) {
  const info = await pathInfo(destination);
  if (!info) return 'missing';
  if (info.isSymbolicLink()) return 'invalid';
  if (info.isDirectory()) return 'retired';
  if (info.isFile()) return 'fenced';
  return 'invalid';
}

async function reclaimClaimState(claim) {
  const info = await pathInfo(claim);
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new SingularityFlowError(`Mutation-lock reclaim marker is unsafe: ${claim}`, {
      code: 'SUBJECT_LOCK_UNSAFE', details: { claim }
    });
  }
  const destination = path.join(claim, 'retired.lock');
  return {
    destination,
    destinationState: await reclaimDestinationState(destination),
    stale: directoryAgeFromInfo(info) > ACQUISITION_GRACE_MS
  };
}

async function fenceAbandonedClaim(claimState, identity) {
  try {
    await writeFile(claimState.destination, `${identity}\n`, { flag: 'wx', mode: 0o600 });
    return 'fenced';
  } catch (error) {
    if (['EEXIST', 'EISDIR', 'ENOTDIR'].includes(error?.code)) {
      return reclaimDestinationState(claimState.destination);
    }
    throw error;
  }
}

async function restoreRetiredSuccessor(directory, destination, moved) {
  // Node exposes pathname-based rename on every supported platform, but no portable rename-if-
  // inode-matches primitive. A successor can therefore replace `directory` after our last lstat
  // and be moved into the private claim. Never let claim cleanup erase that successor. Recreate an
  // exclusive directory at the public pathname and publish each regular entry without replacement;
  // the original moved generation remains preserved in the claim as the recovery authority.
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const current = await activeDirectoryOwner(directory);
      if (current.owner?.lockToken === moved.owner?.lockToken
          && current.owner?.processToken === moved.owner?.processToken) return;
    }
    throw new SingularityFlowError(
      `A successor mutation lock moved during retirement and could not be restored: ${directory}`,
      {
        code: 'SUBJECT_LOCK_GENERATION_CHANGED',
        details: { lock: directory, preservedAt: destination },
        cause: error
      }
    );
  }

  try {
    const entries = await readdir(destination, { withFileTypes: true });
    for (const entry of entries) {
      const source = path.join(destination, entry.name);
      const target = path.join(directory, entry.name);
      const info = await pathInfo(source);
      if (!entry.isFile() || entry.isSymbolicLink() || !info?.isFile() || info.isSymbolicLink()) {
        throw new SingularityFlowError(
          `A moved successor mutation lock contains an unsafe entry: ${source}`,
          {
            code: 'SUBJECT_LOCK_UNSAFE',
            details: { lock: directory, preservedAt: destination, entry: source }
          }
        );
      }
      const bytes = await readFile(source);
      await publishOwnerNoReplace(source, target, bytes);
    }
    const restored = await activeDirectoryOwner(directory);
    if (ownerIdentity(restored.owner) !== ownerIdentity(moved.owner)) {
      throw lockGenerationChanged(directory);
    }
  } catch (error) {
    if (error?.code === 'SUBJECT_LOCK_UNSAFE'
        || error?.code === 'SUBJECT_LOCK_GENERATION_CHANGED') throw error;
    throw new SingularityFlowError(
      `A successor mutation lock moved during retirement and could not be restored: ${directory}`,
      {
        code: 'SUBJECT_LOCK_GENERATION_CHANGED',
        details: { lock: directory, preservedAt: destination },
        cause: error
      }
    );
  }
}

/**
 * Move exactly one observed directory generation out of the acquisition pathname.
 *
 * The deterministic claim is the compare-and-rename fence which a bare rename lacks. Only the
 * process that creates a claim may rename into its destination. If that process stalls, recovery
 * places a regular-file fence at the destination before advancing to another generation, so the
 * delayed rename can never retire a successor which later appears at `directory`.
 */
async function retireObservedDirectory(directory, observed, {
  requireStale = false,
  expectedOwner = null,
  hooks = null
} = {}) {
  if (!observed?.info || !observed.info.isDirectory() || observed.info.isSymbolicLink()) return false;
  const identity = reclaimIdentity(observed);
  for (let generation = 0; generation < RECLAIM_GENERATIONS; generation += 1) {
    const claim = reclaimClaimPath(directory, observed, generation);
    let created = false;
    try {
      await mkdir(claim, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    if (!created) {
      const claimState = await reclaimClaimState(claim);
      if (!claimState) continue;
      if (claimState.destinationState === 'retired') return false;
      if (claimState.destinationState === 'fenced') continue;
      if (claimState.destinationState === 'invalid') {
        throw new SingularityFlowError(`Mutation-lock reclaim fence is unsafe: ${claimState.destination}`, {
          code: 'SUBJECT_LOCK_UNSAFE', details: { claim, destination: claimState.destination }
        });
      }
      if (!claimState.stale) return false;
      const fenced = await fenceAbandonedClaim(claimState, identity);
      if (fenced === 'retired') return false;
      if (fenced === 'fenced') continue;
      return false;
    }

    const destination = path.join(claim, 'retired.lock');
    let retired = false;
    try {
      await writeFile(path.join(claim, 'claim.json'), `${JSON.stringify({
        pid: process.pid,
        host: os.hostname(),
        processToken: PROCESS_TOKEN,
        identity,
        createdAt: nowIso()
      })}\n`, { flag: 'wx', mode: 0o600 });
      await invokeLockHook(hooks, 'afterReclaimClaim', { directory, claim, destination, observed });
      const current = await activeDirectoryOwner(directory);
      if (!sameObservedDirectory(current, observed)) return false;
      if (requireStale && current.active) return false;
      if (expectedOwner && (current.owner?.lockToken !== expectedOwner.lockToken
          || current.owner?.processToken !== expectedOwner.processToken)) return false;
      await invokeLockHook(hooks, 'beforeRetire', { directory, claim, destination, observed });
      // Hooks model an arbitrarily delayed filesystem request. Revalidate after that delay so even
      // an older client which ignores reclaim claims cannot make us retire its successor.
      const final = await activeDirectoryOwner(directory);
      if (!sameObservedDirectory(final, observed)) return false;
      if (requireStale && final.active) return false;
      if (expectedOwner && (final.owner?.lockToken !== expectedOwner.lockToken
          || final.owner?.processToken !== expectedOwner.processToken)) return false;
      await invokeLockHook(hooks, 'afterRetireRevalidation', {
        directory, claim, destination, observed, final
      });
      try { await rename(directory, destination); }
      catch (error) {
        if (['ENOENT', 'EEXIST', 'ENOTEMPTY', 'EISDIR', 'ENOTDIR'].includes(error?.code)) return false;
        throw error;
      }
      const moved = await activeDirectoryOwner(destination);
      if (!sameObservedDirectory(moved, observed)) {
        // The source pathname changed in the syscall window. Preserve the moved successor under the
        // claim and restore its logical lease without replacing anything at the public pathname.
        // `retired` deliberately remains false, so the finally block cannot recursively delete it.
        await restoreRetiredSuccessor(directory, destination, moved);
        return false;
      }
      retired = true;
      await invokeLockHook(hooks, 'afterRetire', { directory, claim, destination, observed });
      return true;
    } finally {
      // Once our rename has completed no other process can have a delayed rename targeting this
      // claim: creating the claim was exclusive. Cleanup is best effort; an interrupted cleanup is
      // harmless and the next factory reset removes the retained marker with the runtime root.
      if (created && (retired || await reclaimDestinationState(destination) === 'missing')) {
        await rm(claim, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
  throw new SingularityFlowError(
    `Mutation-lock reclaim exceeded ${RECLAIM_GENERATIONS} interrupted generations: ${directory}`,
    { code: 'SUBJECT_LOCK_BUSY', details: { lock: directory } }
  );
}

async function reclaim(directory, observed, { hooks = null } = {}) {
  return retireObservedDirectory(directory, observed, { requireStale: true, hooks });
}

const RESET_BARRIER_SUBJECT = Object.freeze({ kind: 'factory-reset-barrier', id: 'repository' });

function shellWord(value) {
  const text = String(value);
  return /^[A-Za-z0-9._:@/+=-]+$/u.test(text) ? text : JSON.stringify(text);
}

/** The reviewed-release route a refusal names; `releaseLeaseAfterReview` is what it runs. */
export function leaseReleaseCommand(subject, lockToken) {
  return `singularity-flow lock release ${shellWord(subject.kind)} ${shellWord(subject.id)} --confirm ${shellWord(lockToken)}`;
}

/** The read a person reviews before that release; `inspectSubjectLease` answers it. */
export function leaseShowCommand(subject) {
  return `singularity-flow lock show ${shellWord(subject.kind)} ${shellWord(subject.id)}`;
}

/**
 * Whether only a person can end this lease: its owner runs on another machine, or runs here but
 * stopped renewing. A live, renewing owner here ends it by finishing or exiting.
 */
function needsReviewedRelease(owner, liveness) {
  if (!owner?.lockToken || !liveness) return false;
  if (liveness.state === 'unknown') return true;
  return liveness.state === 'alive' && liveness.reason !== 'this-process' && liveness.heartbeat !== 'fresh';
}

function holderDescription(owner, liveness) {
  return owner ? describeLeaseOwner(owner, liveness) : 'another process that is still acquiring it';
}

/**
 * The words a refusal over a held lease adds when only a person can end it: why waiting never ends
 * it, the read to review, then the exact reviewed release. Empty for a live, renewing owner here.
 */
export function reviewedReleaseGuidance(subject, owner, liveness) {
  if (!needsReviewedRelease(owner, liveness)) return '';
  const why = liveness.state === 'unknown'
    ? 'That process runs on another machine, so this one cannot prove it stopped and never takes the lock over.'
    : 'That process is still running here but stopped renewing the lock; it is not taken over while it runs. Stopping it frees the lock.';
  return ` ${why} Review it with: ${leaseShowCommand(subject)}. After checking that it no longer works on this `
    + `${subject.kind}, release exactly that lease with: ${leaseReleaseCommand(subject, owner.lockToken)}`;
}

/**
 * The details every refusal over a held lease carries: the lock, its owner and liveness, and, when
 * only a person can end it, the exact reviewed release (the recovery plan's own-terminal step).
 */
export function heldLeaseDetails(subject, directory, owner, liveness) {
  return {
    lock: directory, owner: owner ?? null, liveness: leaseDetails(liveness),
    ...(needsReviewedRelease(owner, liveness) ? { releaseCommand: leaseReleaseCommand(subject, owner.lockToken) } : {})
  };
}

function leaseDetails(liveness) {
  return liveness ? {
    state: liveness.state, reason: liveness.reason, heartbeat: liveness.heartbeat,
    lastHeartbeatAt: liveness.lastHeartbeatAt
  } : null;
}

async function assertNoRepositoryResetBarrier(root) {
  const directory = repositoryResetBarrierPath(root);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await activeDirectoryOwner(directory);
    if (!state.active) {
      if (!state.info) return;
      if (await reclaim(directory, state)) continue;
      if (await directoryAge(directory) === null) return;
      continue;
    }
    const reviewed = reviewedReleaseGuidance(RESET_BARRIER_SUBJECT, state.owner, state.liveness);
    throw new SingularityFlowError(
      `Repository reinitialization is in progress (${holderDescription(state.owner, state.liveness)}). `
      + (reviewed ? `Waiting does not end it.${reviewed}` : 'Wait for it to finish before starting work.'),
      {
        code: 'FACTORY_RESET_IN_PROGRESS',
        details: heldLeaseDetails(RESET_BARRIER_SUBJECT, directory, state.owner, state.liveness)
      }
    );
  }
  throw new SingularityFlowError(
    'Repository reinitialization state changed while work was starting. Retry after it becomes stable.',
    { code: 'FACTORY_RESET_IN_PROGRESS', details: { lock: directory } }
  );
}

/** Public read-only preflight for repository-scoped mutation entry points. */
export async function assertRepositoryResetAvailable(root) {
  return assertNoRepositoryResetBarrier(root);
}

async function subjectLockRoots(root) {
  const roots = [];
  const seen = new Set();
  for (const gitDirectory of [gitDir(root), gitCommonDir(root)]) {
    const canonical = await realpath(gitDirectory);
    const lockRoot = path.join(canonical, 'singularity-flow', 'locks');
    if (seen.has(lockRoot)) continue;
    seen.add(lockRoot);
    roots.push(lockRoot);
  }
  return roots;
}

/**
 * Every lock that is still held: a live owner, another machine's owner (unknown), or an acquisition
 * in progress. Only a lock whose owner is proven dead is left out, so factory reset never proceeds
 * over a writer it cannot prove has stopped.
 */
export async function activeSubjectLocks(root) {
  const active = [];
  for (const lockRoot of await subjectLockRoots(root)) {
    const entries = await readdir(lockRoot, {
      withFileTypes: true
    }).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
    for (const entry of entries) {
      if (!entry.name.endsWith('.lock')) continue;
      const directory = path.join(lockRoot, entry.name);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        active.push({ directory, owner: null, reason: 'unsafe-lock-entry' });
        continue;
      }
      const state = await activeDirectoryOwner(directory);
      if (state.active) active.push({
        directory,
        owner: state.owner ?? null,
        reason: state.reason ?? 'active',
        liveness: leaseDetails(state.liveness)
      });
    }
  }
  return active;
}

export async function assertNoActiveSubjectLocks(root) {
  const locks = await activeSubjectLocks(root);
  if (!locks.length) return;
  const descriptions = locks.slice(0, 5).map((lock) => {
    const owner = lock.owner;
    return owner
      ? `${owner.subject?.kind ?? 'operation'} '${owner.subject?.id ?? 'unknown'}' `
        + `(PID ${owner.pid ?? 'unknown'} on ${owner.host ?? 'unknown'}`
        + `${lock.liveness?.state === 'unknown' ? ', another machine' : ''})`
      : path.basename(lock.directory);
  });
  const reviewed = locks.find((lock) => lock.owner?.subject?.kind && lock.owner?.subject?.id
    && needsReviewedRelease(lock.owner, lock.liveness));
  throw new SingularityFlowError(
    `Repository reinitialization requires a quiescent repository; active operation(s): `
    + `${descriptions.join(', ')}${locks.length > descriptions.length ? ` and ${locks.length - descriptions.length} more` : ''}. `
    + 'Wait for them to finish or stop them through their normal recovery path, then preview again.'
    + (reviewed ? ' A lock from another machine, or one whose process stopped renewing it, ends only by a '
      + `reviewed release, for example: ${leaseReleaseCommand(reviewed.owner.subject, reviewed.owner.lockToken)}` : ''),
    { code: 'FACTORY_RESET_ACTIVE_OPERATIONS', details: {
      locks, ...(reviewed ? { releaseCommand: leaseReleaseCommand(reviewed.owner.subject, reviewed.owner.lockToken) } : {})
    } }
  );
}

/**
 * Renew a lease even while the main thread is inside a synchronous external quality command.
 *
 * A normal timer cannot do that: `spawnSync` blocks the JavaScript event loop for the entire
 * Playwright/test run. The worker touches a lock-token-specific file, never rewrites owner.json.
 * Token-specific is load-bearing: if the directory is atomically reclaimed between a check and a
 * touch, the old worker cannot refresh the new owner's differently named heartbeat.
 */
function heartbeatWorkerError(directory, cause) {
  const detail = cause instanceof Error ? cause.message : String(cause ?? 'unknown worker failure');
  return new SingularityFlowError(
    `The mutation-lock heartbeat failed for ${directory}: ${detail}. The lock remains fail-closed until this process releases it.`,
    { code: 'SUBJECT_LOCK_HEARTBEAT_FAILED', details: { lock: directory }, cause }
  );
}

function recordHeartbeatFailure(controller, cause) {
  if (!controller || controller.stopping) return null;
  controller.failure ??= heartbeatWorkerError(controller.directory, cause);
  try {
    writeFileSync(heartbeatFailurePath(controller.directory, controller.owner), `${JSON.stringify({
      failedAt: nowIso(),
      pid: process.pid,
      processToken: PROCESS_TOKEN,
      lockToken: controller.owner.lockToken
    })}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code !== 'EEXIST' && !controller.failureMarkerError) {
      controller.failureMarkerError = error;
      controller.failure.message += ` Its fail-closed marker could not be written: ${error.message}`;
    }
  }
  return controller.failure;
}

async function terminateHeartbeatWorker(worker) {
  if (typeof worker?.terminate === 'function') await worker.terminate();
}

let sharedHeartbeatPool = null;

function heartbeatWorkerOptions(workerData = undefined) {
  return {
    eval: true,
    // CLI/test processes may themselves use `--input-type=module`; inheriting it turns an eval
    // worker into ESM and makes the deliberately self-contained CommonJS heartbeat fail.
    execArgv: [],
    ...(workerData === undefined ? {} : { workerData })
  };
}

function setSharedHeartbeatReference(pool) {
  if (pool.controllers.size > 0 || pool.pendingStops.size > 0) pool.worker.ref?.();
  else pool.worker.unref?.();
}

function failSharedHeartbeatPool(pool, cause) {
  if (pool.failed) return;
  pool.failed = cause instanceof Error ? cause : new Error(String(cause ?? 'shared worker failure'));
  if (sharedHeartbeatPool === pool) sharedHeartbeatPool = null;
  for (const controller of pool.controllers.values()) {
    const failure = recordHeartbeatFailure(controller, pool.failed);
    if (!controller.ready && failure) controller.rejectReady(failure);
  }
  for (const pending of pool.pendingStops.values()) pending.reject(pool.failed);
  pool.pendingStops.clear();
}

function createSharedHeartbeatPool() {
  const worker = new Worker(`
    const { utimesSync, writeFileSync } = require('node:fs');
    const { parentPort } = require('node:worker_threads');
    const leases = new Map();
    let timer = null;

    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (!leases.size) return;
      const now = Date.now();
      const nextAt = Math.min(...Array.from(leases.values(), (lease) => lease.nextAt));
      timer = setTimeout(tick, Math.max(10, nextAt - now));
    };
    const fail = (lease, error) => {
      try {
        writeFileSync(lease.failureFile, JSON.stringify({
          failedAt: new Date().toISOString(), pid: lease.pid,
          processToken: lease.processToken, lockToken: lease.lockToken
        }) + '\\n', { flag: 'wx', mode: 0o600 });
      } catch (markerError) {
        if (markerError && markerError.code !== 'EEXIST') {
          try {
            parentPort.postMessage({
              type: 'marker-error', registrationId: lease.registrationId,
              message: markerError.message
            });
          } catch { /* an exit event makes every remaining lease fail closed */ }
        }
      }
      leases.delete(lease.registrationId);
      try {
        parentPort.postMessage({
          type: 'failed', registrationId: lease.registrationId,
          message: error && error.message
        });
      } catch { /* the failure marker remains authoritative */ }
    };
    const beat = (lease) => {
      try {
        const now = new Date();
        utimesSync(lease.file, now, now);
        lease.nextAt = Date.now() + lease.intervalMs;
        return true;
      } catch (error) {
        fail(lease, error);
        return false;
      }
    };
    function tick() {
      timer = null;
      const now = Date.now();
      for (const lease of [...leases.values()]) {
        if (lease.nextAt <= now) beat(lease);
      }
      schedule();
    }
    parentPort.on('message', (message) => {
      if (message && message.type === 'register') {
        const lease = { ...message.lease, nextAt: Date.now() };
        leases.set(lease.registrationId, lease);
        if (beat(lease)) {
          parentPort.postMessage({ type: 'registered', registrationId: lease.registrationId });
        }
        schedule();
        return;
      }
      if (message && message.type === 'unregister') {
        leases.delete(message.registrationId);
        parentPort.postMessage({
          type: 'unregistered', registrationId: message.registrationId,
          requestId: message.requestId
        });
        schedule();
      }
    });
    const failPool = (error) => {
      for (const lease of [...leases.values()]) fail(lease, error);
      try {
        parentPort.postMessage({ type: 'pool-failed', message: error && error.message });
      } catch { /* worker exit still makes the parent fail every registered controller */ }
      parentPort.close();
      process.exitCode = 1;
    };
    process.on('uncaughtException', failPool);
    process.on('unhandledRejection', failPool);
  `, heartbeatWorkerOptions());
  const pool = {
    worker,
    controllers: new Map(),
    pendingStops: new Map(),
    failed: null
  };
  worker.on('message', (value) => {
    if (value?.type === 'pool-failed') {
      failSharedHeartbeatPool(pool, new Error(value.message || 'shared heartbeat worker failed'));
      return;
    }
    const controller = pool.controllers.get(value?.registrationId);
    if (value?.type === 'registered' && controller) {
      if (controller.failure) controller.rejectReady(controller.failure);
      else {
        controller.ready = true;
        controller.resolveReady();
      }
      return;
    }
    if (value?.type === 'unregistered') {
      const pending = pool.pendingStops.get(value.requestId);
      if (pending) {
        pool.pendingStops.delete(value.requestId);
        pending.resolve();
        setSharedHeartbeatReference(pool);
      }
      return;
    }
    if ((value?.type === 'failed' || value?.type === 'marker-error') && controller) {
      const detail = value?.type === 'marker-error'
        ? `heartbeat worker could not publish its failure marker: ${value.message}`
        : value.message || 'heartbeat renewal stopped';
      const failure = recordHeartbeatFailure(controller, new Error(detail));
      if (!controller.ready && failure) controller.rejectReady(failure);
    }
  });
  worker.on('error', (error) => failSharedHeartbeatPool(pool, error));
  worker.on('exit', (code) => {
    if (pool.controllers.size || pool.pendingStops.size) {
      failSharedHeartbeatPool(pool, new Error(
        `shared heartbeat worker exited unexpectedly${Number.isInteger(code) ? ` with code ${code}` : ''}`
      ));
    }
  });
  worker.unref();
  sharedHeartbeatPool = pool;
  return pool;
}

async function startSharedHeartbeat(directory, owner, intervalMs) {
  const pool = sharedHeartbeatPool && !sharedHeartbeatPool.failed
    ? sharedHeartbeatPool : createSharedHeartbeatPool();
  const registrationId = owner.lockToken;
  let resolveReady;
  let rejectReady;
  const readiness = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const controller = {
    pool, registrationId, worker: pool.worker, directory, owner,
    stopping: false, ready: false, failure: null, failureMarkerError: null,
    resolveReady, rejectReady, shared: true
  };
  pool.controllers.set(registrationId, controller);
  setSharedHeartbeatReference(pool);
  try {
    pool.worker.postMessage({
      type: 'register',
      lease: {
        registrationId,
        file: heartbeatPath(directory, owner),
        failureFile: heartbeatFailurePath(directory, owner),
        intervalMs,
        pid: process.pid,
        processToken: PROCESS_TOKEN,
        lockToken: owner.lockToken
      }
    });
    await readiness;
    if (controller.failure) throw controller.failure;
    return controller;
  } catch (error) {
    controller.stopping = true;
    pool.controllers.delete(registrationId);
    setSharedHeartbeatReference(pool);
    throw error;
  }
}

async function startDedicatedHeartbeat(directory, owner, intervalMs, heartbeatFactory) {
  const worker = heartbeatFactory(`
    const { utimesSync, writeFileSync } = require('node:fs');
    const { parentPort, workerData } = require('node:worker_threads');
    let timer = null;
    let failed = false;
    const stop = () => { if (timer) clearInterval(timer); parentPort.close(); };
    const fail = (error) => {
      if (failed) return;
      failed = true;
      try {
        writeFileSync(workerData.failureFile, JSON.stringify({
          failedAt: new Date().toISOString(),
          pid: workerData.pid,
          processToken: workerData.processToken,
          lockToken: workerData.lockToken
        }) + '\\n', { flag: 'wx', mode: 0o600 });
      } catch (markerError) {
        if (markerError && markerError.code !== 'EEXIST') {
          try { parentPort.postMessage({ type: 'marker-error', message: markerError.message }); }
          catch { /* the parent also treats worker exit as failure */ }
        }
      }
      try { parentPort.postMessage({ type: 'failed', message: error && error.message }); }
      catch { /* the marker already made the lease fail-closed */ }
      stop();
    };
    const beat = () => {
      try {
        const now = new Date();
        utimesSync(workerData.file, now, now);
      } catch (error) { fail(error); }
    };
    parentPort.on('message', stop);
    process.on('uncaughtException', fail);
    process.on('unhandledRejection', fail);
    beat();
    if (!failed) {
      timer = setInterval(beat, workerData.intervalMs);
      parentPort.postMessage({ type: 'ready' });
    }
  `, heartbeatWorkerOptions({
      file: heartbeatPath(directory, owner),
      failureFile: heartbeatFailurePath(directory, owner),
      intervalMs,
      pid: process.pid,
      processToken: PROCESS_TOKEN,
      lockToken: owner.lockToken
  }));
  const controller = {
    worker, directory, owner, stopping: false, ready: false,
    failure: null, failureMarkerError: null
  };
  let resolveReady;
  let rejectReady;
  const readiness = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const failed = (cause) => {
    const failure = recordHeartbeatFailure(controller, cause);
    if (!controller.ready && failure) rejectReady(failure);
  };
  const message = (value) => {
    if (value?.type === 'ready') {
      if (controller.failure) rejectReady(controller.failure);
      else {
        controller.ready = true;
        resolveReady();
      }
      return;
    }
    if (value?.type === 'marker-error') {
      failed(new Error(`heartbeat worker could not publish its failure marker: ${value.message}`));
      return;
    }
    if (value?.type === 'failed') failed(new Error(value.message || 'heartbeat renewal stopped'));
  };
  try {
    worker.on('message', message);
    worker.on('error', failed);
    worker.on('exit', (code) => {
      if (!controller.stopping) failed(new Error(
        `heartbeat worker exited unexpectedly${Number.isInteger(code) ? ` with code ${code}` : ''}`
      ));
    });
    // Keep startup referenced. A pending Promise does not keep Node alive, so unref'ing before the
    // ready message lets a short-lived CLI exit successfully without ever entering its callback.
    await readiness;
    if (controller.failure) throw controller.failure;
    worker.unref();
    return controller;
  } catch (error) {
    controller.stopping = true;
    await terminateHeartbeatWorker(worker).catch(() => {});
    throw error;
  }
}

async function startHeartbeat(directory, owner, ttlMs, heartbeatFactory = null) {
  if (!Number.isFinite(ttlMs) || ttlMs < 1_000) return null;
  const intervalMs = Math.max(250, Math.min(30_000, Math.floor(ttlMs / 3)));
  if (!heartbeatFactory) return startSharedHeartbeat(directory, owner, intervalMs);
  return startDedicatedHeartbeat(directory, owner, intervalMs, heartbeatFactory);
}

async function stopHeartbeat(controller) {
  if (!controller) return;
  if (controller.shared) {
    const { pool, registrationId } = controller;
    if (pool.failed || !pool.controllers.has(registrationId)) {
      controller.stopping = true;
      pool.controllers.delete(registrationId);
      setSharedHeartbeatReference(pool);
      return;
    }
    const requestId = randomUUID();
    const stopped = new Promise((resolve, reject) => {
      pool.pendingStops.set(requestId, { resolve, reject });
    });
    try {
      pool.worker.postMessage({ type: 'unregister', registrationId, requestId });
      await stopped;
    }
    finally {
      // Worker-to-parent messages are ordered. Mark the controller stopped only after the
      // unregister acknowledgement, so a heartbeat failure emitted immediately before that
      // acknowledgement still fails the operation instead of being mistaken for shutdown noise.
      controller.stopping = true;
      pool.pendingStops.delete(requestId);
      pool.controllers.delete(registrationId);
      setSharedHeartbeatReference(pool);
    }
    return;
  }
  controller.stopping = true;
  await terminateHeartbeatWorker(controller.worker);
}

async function startOwnedHeartbeat(directory, owner, ttlMs, heartbeatFactory = null) {
  try {
    return await startHeartbeat(directory, owner, ttlMs, heartbeatFactory);
  } catch (error) {
    try { await releaseOwnedDirectory(directory, owner); }
    catch (cleanupError) {
      if (typeof error?.message === 'string') {
        error.message = `${error.message} The acquired lock could not be released: ${cleanupError.message}`;
      }
    }
    throw error;
  }
}

function newLockOwner(subject, ttlMs) {
  return {
    schemaVersion: currentSchemaVersion('subject-lock-owner'),
    subject,
    // pid, host, machineId, processStartedAt, processToken: what proves this owner alive or dead.
    ...leaseOwnerIdentity(),
    lockToken: randomUUID(),
    acquiredAt: nowIso(),
    expiresAt: new Date(Date.now() + ttlMs).toISOString()
  };
}

async function releaseOwnedDirectory(directory, owner, { hooks = null } = {}) {
  const current = await activeDirectoryOwner(directory);
  if (!current.info || !current.owner
      || current.owner.lockToken !== owner.lockToken
      || current.owner.processToken !== PROCESS_TOKEN) return false;
  return retireObservedDirectory(directory, current, { expectedOwner: owner, hooks });
}

function lockGenerationChanged(directory) {
  return new SingularityFlowError(`Mutation-lock generation changed during acquisition: ${directory}`, {
    code: 'SUBJECT_LOCK_GENERATION_CHANGED', details: { lock: directory }
  });
}

function busyError(subject, directory, existing = null, liveness = null) {
  const reviewed = reviewedReleaseGuidance(subject, existing, liveness);
  const automatic = existing
    ? 'it is freed when that command finishes, or taken over once its process has exited.'
    : 'an acquisition abandoned for 30 seconds is taken over automatically.';
  return new SingularityFlowError(
    `${subject.kind} '${subject.id}' is locked by ${holderDescription(existing, liveness)}. `
    + `The lock is ${directory}; ${reviewed ? reviewed.trim() : automatic}`,
    { code: 'SUBJECT_LOCK_BUSY', details: { subject, ...heldLeaseDetails(subject, directory, existing, liveness) } }
  );
}

const OWNER_LINK_FALLBACK_CODES = new Set([
  'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK', 'EINVAL'
]);

async function publishOwnerNoReplace(pending, destination, bytes, ownerLink = link) {
  try {
    await ownerLink(pending, destination);
    return 'hard-link';
  } catch (error) {
    if (!OWNER_LINK_FALLBACK_CODES.has(error?.code)) throw error;
  }
  // Some supported Windows and network filesystems reject hard links. Opening the destination with
  // O_EXCL preserves the load-bearing no-replace property. Publication may briefly be incomplete,
  // but readers already treat a missing or malformed owner as an acquiring lock for the full grace
  // period, and the generation is revalidated immediately afterward.
  await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
  return 'exclusive-write';
}

async function cleanupFailedAcquisition(directory, acquiredInfo, owner, hooks) {
  const current = await activeDirectoryOwner(directory);
  if (!current.info) return;
  const publishedByUs = current.owner?.lockToken === owner.lockToken
    && current.owner?.processToken === owner.processToken;
  // A delayed no-replace publication can win the successor's still-ownerless directory. The owner
  // token is then authoritative: neither contender has entered its callback, so retire that exact
  // successor generation instead of leaving a live-PID lock until TTL.
  if (!publishedByUs && !sameDirectoryIdentity(current.info, acquiredInfo)) return;
  if (current.owner && !publishedByUs) return;
  await retireObservedDirectory(directory, current, {
    expectedOwner: publishedByUs ? owner : null,
    hooks
  });
}

async function acquireLockDirectory(directory, subject, ttlMs, afterAcquire = null, {
  hooks = null,
  ownerLink = link
} = {}) {
  await mkdir(path.dirname(directory), { recursive: true });
  const owner = newLockOwner(subject, ttlMs);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await mkdir(directory, { recursive: false });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await activeDirectoryOwner(directory);
      if (!existing.info) continue;
      if (existing.active) throw busyError(subject, directory, existing.owner, existing.liveness);
      await reclaim(directory, existing, { hooks });
      continue;
    }

    const acquiredInfo = await pathInfo(directory);
    if (!acquiredInfo || acquiredInfo.isSymbolicLink() || !acquiredInfo.isDirectory()) continue;
    const pending = `${path.join(directory, 'owner.json')}.${owner.lockToken}`;
    const ownerBytes = `${JSON.stringify(owner, null, 2)}\n`;
    try {
      await invokeLockHook(hooks, 'afterDirectoryCreated', { directory, owner, acquiredInfo });
      await writeFile(pending, ownerBytes, {
        flag: 'wx', mode: 0o600
      });
      await writeFile(heartbeatPath(directory, owner), '', { flag: 'wx', mode: 0o600 });
      const beforePublish = await pathInfo(directory);
      if (!sameDirectoryIdentity(acquiredInfo, beforePublish)) throw lockGenerationChanged(directory);
      // `rename` replaces an existing owner on POSIX. A hard-link publication is equally atomic but
      // no-replace, so a delayed acquirer can never overwrite a successor generation's owner. The
      // exclusive-create fallback retains that property on filesystems which reject hard links.
      await publishOwnerNoReplace(
        pending, path.join(directory, 'owner.json'), ownerBytes, ownerLink
      );
      await rm(pending, { force: true });
      const published = await activeDirectoryOwner(directory);
      if (!published.info
          || !sameDirectoryIdentity(acquiredInfo, published.info)
          || published.owner?.lockToken !== owner.lockToken
          || published.owner?.processToken !== owner.processToken) {
        throw lockGenerationChanged(directory);
      }
      if (afterAcquire) await afterAcquire();
      return owner;
    } catch (error) {
      await cleanupFailedAcquisition(directory, acquiredInfo, owner, hooks).catch(() => {});
      if (error?.code === 'EEXIST' || error?.code === 'ENOENT'
          || error?.code === 'SUBJECT_LOCK_GENERATION_CHANGED') continue;
      throw error;
    }
  }
  throw new SingularityFlowError(`Unable to acquire the ${subject.kind} '${subject.id}' mutation lock.`, {
    code: 'SUBJECT_LOCK_BUSY', details: { subject, lock: directory }
  });
}

export async function acquireSubjectLock(root, subject, {
  ttlMs = DEFAULT_TTL_MS,
  hooks = null,
  ownerLink = link
} = {}) {
  // Check on both sides of subject-lock creation. This closes the race where reset raises its
  // barrier after the first check but before this lock is published: the callback never starts.
  await assertNoRepositoryResetBarrier(root);
  return acquireLockDirectory(subjectLockPath(root, subject), subject, ttlMs,
    () => assertNoRepositoryResetBarrier(root), { hooks, ownerLink });
}

export async function releaseSubjectLock(root, subject, owner, { hooks = null } = {}) {
  return releaseOwnedDirectory(subjectLockPath(root, subject), owner, { hooks });
}

function reviewedLeaseDirectory(root, subject) {
  if (!subject?.kind || !subject?.id) {
    throw new SingularityFlowError('A lease release names the locked subject: its kind and ID.', {
      code: 'SUBJECT_LOCK_RELEASE_INVALID', details: { subject: subject ?? null }
    });
  }
  return subject.kind === RESET_BARRIER_SUBJECT.kind && subject.id === RESET_BARRIER_SUBJECT.id
    ? repositoryResetBarrierPath(root) : subjectLockPath(root, subject);
}

/** Read-only: who holds a subject's lease and whether only a reviewed release can end it. */
export async function inspectSubjectLease(root, subject) {
  const directory = reviewedLeaseDirectory(root, subject);
  const state = await activeDirectoryOwner(directory);
  return Object.freeze({
    subject, lock: directory, held: Boolean(state.info) && state.active, owner: state.owner ?? null,
    liveness: leaseDetails(state.liveness),
    releaseCommand: needsReviewedRelease(state.owner, state.liveness)
      ? leaseReleaseCommand(subject, state.owner.lockToken) : null
  });
}

/** The release audit beside the locks: a record of what a person released, never a held lock. */
export const RELEASED_LEASE_AUDIT = 'released-leases.jsonl';

export function releasedLeaseAuditPath(root) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'locks', RELEASED_LEASE_AUDIT);
}

/**
 * A person's way out of a lease this machine cannot prove abandoned: another machine's owner, or a
 * live owner here that stopped renewing. `expectedLockToken` is the confirmation: exactly that
 * reviewed generation is removed, never a successor, and one audit line records whose lease it was.
 * A live owner here that is still renewing is refused; it ends by finishing or being stopped.
 */
export async function releaseLeaseAfterReview(root, subject, { expectedLockToken, hooks = null } = {}) {
  const directory = reviewedLeaseDirectory(root, subject);
  if (typeof expectedLockToken !== 'string' || !expectedLockToken) {
    throw new SingularityFlowError('A lease release confirms the reviewed lock token.', {
      code: 'SUBJECT_LOCK_RELEASE_INVALID', details: { subject, lock: directory }
    });
  }
  const state = await activeDirectoryOwner(directory);
  if (!state.info) return Object.freeze({ released: false, reason: 'already-released', subject, lock: directory });
  if (state.owner?.lockToken !== expectedLockToken) {
    throw new SingularityFlowError(
      `The ${subject.kind} '${subject.id}' lease is no longer the reviewed one `
      + `(${state.owner ? `now token ${state.owner.lockToken}, ${holderDescription(state.owner, state.liveness)}` : 'its owner is still being written'}). `
      + `Nothing was released; review it again with: ${leaseShowCommand(subject)}`,
      { code: 'SUBJECT_LOCK_RELEASE_MISMATCH', details: {
        subject, lock: directory, owner: state.owner ?? null, nextAction: leaseShowCommand(subject)
      } }
    );
  }
  const liveness = state.liveness;
  if (liveness?.state === 'alive' && (liveness.reason === 'this-process' || liveness.heartbeat === 'fresh')) {
    throw new SingularityFlowError(
      `The ${subject.kind} '${subject.id}' lease belongs to ${holderDescription(state.owner, liveness)}, `
      + 'which is running on this machine and still renewing it. Nothing was released; let it finish or stop that process.',
      { code: 'SUBJECT_LOCK_RELEASE_REFUSED', details: { subject, lock: directory, owner: state.owner, liveness: leaseDetails(liveness) } }
    );
  }
  if (!await retireObservedDirectory(directory, state, { expectedOwner: state.owner, hooks })) {
    throw new SingularityFlowError(
      `The ${subject.kind} '${subject.id}' lease changed while it was being released. Nothing else was removed; `
      + `review it again with: ${leaseShowCommand(subject)}`,
      { code: 'SUBJECT_LOCK_RELEASE_MISMATCH', details: { subject, lock: directory, nextAction: leaseShowCommand(subject) } }
    );
  }
  const owner = state.owner;
  const audit = releasedLeaseAuditPath(root);
  const entry = {
    releasedAt: nowIso(), subject: { kind: subject.kind, id: subject.id }, lockToken: owner.lockToken,
    owner: {
      pid: owner.pid ?? null, host: owner.host ?? null, machineId: owner.machineId ?? null,
      processStartedAt: owner.processStartedAt ?? null, acquiredAt: owner.acquiredAt ?? null
    },
    liveness: leaseDetails(liveness),
    releasedBy: { pid: process.pid, host: os.hostname(), machineId: localMachineId() }
  };
  let auditWarning = null;
  try {
    await mkdir(path.dirname(audit), { recursive: true });
    await appendFile(audit, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch (error) { auditWarning = `The release was not recorded in ${audit}: ${error.message}`; }
  return Object.freeze({
    released: true, subject, lock: directory, lockToken: owner.lockToken, owner,
    liveness: leaseDetails(liveness), audit, ...(auditWarning ? { warnings: [auditWarning] } : {})
  });
}

function finishInheritedFrame(frame) {
  if (!frame?.active) return;
  frame.active = false;
  const lease = frame.lease;
  lease.reentrantCount -= 1;
  if (lease.reentrantCount === 0) {
    for (const resolve of lease.drainWaiters.splice(0)) resolve();
  }
}

async function waitForInheritedFrames(lease) {
  if (lease.reentrantCount === 0) return;
  await new Promise((resolve) => lease.drainWaiters.push(resolve));
}

function appendSecondaryFailure(primary, secondary) {
  if (!secondary) return primary;
  if (!primary) return secondary;
  if (typeof primary.message === 'string') primary.message = `${primary.message} ${secondary.message}`;
  return primary;
}

export async function withRepositoryResetBarrier(root, callback, {
  ttlMs = DEFAULT_TTL_MS,
  fault = null,
  hooks = null,
  heartbeatFactory = null,
  ownerLink = link
} = {}) {
  const directory = repositoryResetBarrierPath(root);
  const subject = { kind: 'factory-reset-barrier', id: 'repository' };
  const owner = await acquireLockDirectory(directory, subject, ttlMs, null, { hooks, ownerLink });
  const heartbeat = await startOwnedHeartbeat(directory, owner, ttlMs, heartbeatFactory);
  let result;
  let operationError = null;
  try {
    result = await callback(owner);
  } catch (error) {
    operationError = error;
  }
  let barrierWarning = null;
  // Release remains mandatory even if terminating the helper worker itself reports an error.
  await stopHeartbeat(heartbeat).catch(() => {});
  operationError = appendSecondaryFailure(operationError, heartbeat?.failure ?? null);
  try {
    if (fault) await fault('before-release');
    if (!await releaseOwnedDirectory(directory, owner, { hooks })) barrierWarning =
      `The repository reinitialization barrier was taken over while reset held it: ${directory}. `
      + 'Inspect the repository before relying on the result.';
  } catch (error) {
    // This process exits soon, and a dead owner's barrier is taken over by the next command here.
    barrierWarning = `The repository reinitialization barrier could not be cleared at `
      + `${directory}: ${error.message}. The next command on this machine takes it over once this `
      + `process has exited; if it remains, release it with: ${leaseReleaseCommand(RESET_BARRIER_SUBJECT, owner.lockToken)}`;
  }
  if (barrierWarning) {
    if (operationError && typeof operationError.message === 'string') {
      operationError.message = `${operationError.message} ${barrierWarning}`;
    } else if (result && typeof result === 'object') {
      result.barrierPendingPath = directory;
      result.warnings = [...(result.warnings ?? []), barrierWarning];
    } else {
      operationError = new SingularityFlowError(barrierWarning, {
        code: 'FACTORY_RESET_BARRIER_PENDING', details: { lock: directory, owner }
      });
    }
  }
  if (operationError) throw operationError;
  return result;
}

export async function withSubjectLock(root, subject, callback, options = {}) {
  const key = subjectLockKey(root, subject);
  const inherited = heldLocks.getStore();
  // A creation transaction opens its recovery journal before the aggregate exists, then hands the
  // same lock to the publication transaction. Reentrancy is scoped to this async call chain: an
  // unrelated task in the same Node process still has no inherited store and must acquire normally.
  const inheritedFrame = inherited?.get(key);
  if (inheritedFrame?.active && inheritedFrame.lease?.active) {
    // Reentrant work still observes a reset which began after the outer acquisition. The outer lock
    // will make a real factory reset refuse, but admitting new nested mutation behind an already-live
    // barrier violates the public barrier contract and made tests/helpers able to bypass it outright.
    await assertNoRepositoryResetBarrier(root);
    if (inheritedFrame.active && inheritedFrame.lease.active) {
      const lease = inheritedFrame.lease;
      const frame = { lease, active: true };
      lease.reentrantCount += 1;
      const scope = new Map(inherited);
      scope.set(key, frame);
      try { return await heldLocks.run(scope, () => callback(lease.owner)); }
      finally { finishInheritedFrame(frame); }
    }
  }
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const owner = await measureCommandSpan('publication.lock-acquire', () => acquireSubjectLock(root, subject, { ...options, ttlMs }));
  const directory = subjectLockPath(root, subject);
  const heartbeat = await measureCommandSpan('publication.heartbeat-start', () => startOwnedHeartbeat(
    directory, owner, ttlMs, options.heartbeatFactory ?? null
  ));
  const lease = {
    owner, active: true, reentrantCount: 0, drainWaiters: [],
    // `removal` is set only by `prepareHeldLockRemoval`, when this transaction moves the checkout
    // that contains `directory`.
    directory, heartbeat, removal: null
  };
  const frame = { lease, active: true };
  const scope = new Map(inherited ?? []);
  scope.set(key, frame);
  let result;
  let operationError = null;
  try { result = await heldLocks.run(scope, () => callback(owner)); }
  catch (error) { operationError = error; }

  // Invalidate the outer async frame before yielding. Detached resources inherit this exact frame,
  // so any later call must acquire normally and pass the reset barrier. Reentrant calls which had
  // already begun own distinct frames and keep the physical lease held until they settle.
  frame.active = false;
  await waitForInheritedFrames(lease);
  lease.active = false;
  await stopHeartbeat(heartbeat).catch(() => {});
  operationError = appendSecondaryFailure(operationError, heartbeat?.failure ?? null);
  // A false release means the lock we were holding is no longer ours — it was reclaimed as stale
  // while we were working, so something else may have been mutating the same subject alongside
  // us. Discarding that quietly is how a concurrent mutation becomes invisible. The one absence that
  // is not a takeover is the one this transaction caused itself, by committing the removal of the
  // checkout that contained the lock, and only a verified handover can claim that.
  if (!await releaseSubjectLock(root, subject, owner, { hooks: options.hooks ?? null })
      && !await removedWithItsCheckout(lease)) {
    console.warn(
      `Warning: the ${subject.kind} '${subject.id}' lock was taken over while this command held it. `
      + 'Another process may have changed it at the same time; check the result before relying on it.'
    );
  }
  if (operationError) throw operationError;
  return result;
}

/** Resolve symbolic links in `target`, keeping any trailing segments that no longer exist. */
async function canonicalLocation(target) {
  const missing = [];
  let current = path.resolve(target);
  for (;;) {
    try { return path.join(await realpath(current), ...missing); }
    catch (error) {
      const parent = path.dirname(current);
      if (error?.code !== 'ENOENT' || parent === current) throw error;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** `target` relative to `container` when it lies strictly inside it, otherwise null. */
function pathInsideDirectory(container, target) {
  const relative = path.relative(container, target);
  if (!relative || path.isAbsolute(relative)
      || relative === '..' || relative.startsWith(`..${path.sep}`)) return null;
  return relative;
}

/**
 * Whether a lease's missing lock is explained by this transaction's own committed removal of the
 * checkout that contained it, rather than by a takeover.
 */
async function removedWithItsCheckout(lease) {
  if (!lease.removal?.committed) return false;
  // The commit proved the lock left with its checkout. Anything at the original pathname now did not
  // come from that move, so finding something there keeps the warning.
  return pathInfo(lease.directory).then((info) => !info, () => false);
}

/**
 * Hand the locks this transaction holds inside `checkout` over to the move that is about to remove
 * that checkout.
 *
 * A subject lock lives in its repository's common Git directory, which for an ordinary clone is
 * inside the checkout. Moving or deleting the checkout takes the lock with it. The heartbeat then
 * fails against a path that no longer exists, and the release finds nothing at the original path,
 * which is exactly what a takeover looks like. So every committed `workspace detach-capability
 * --drop-local` warned that its lease had been taken over, and one whose renewal tick fell between
 * the move and the release failed outright, after the checkout was already gone.
 *
 * Reset exclusion is unchanged. The handover refuses unless every lock it covers is still present
 * and still ours, so a checkout is never moved after its fence was lost. It stops only the renewal,
 * never the lease: the directory and owner record travel with the checkout, so a reset scan finds a
 * live lease wherever the checkout is. Stopping renewal cannot end that lease early either: a lease
 * is held while the PID that owns it runs, whatever its heartbeat says.
 *
 * Nothing is excused at this point. `commit(destination)` belongs at the point where the removal can
 * no longer be undone, and it marks a lock only after finding it at `destination`, intact and still
 * ours. A takeover before then leaves nothing at `destination` to find, so its release still warns,
 * and so does every release whose removal was never committed.
 *
 * Only locks held by the calling async chain are considered. A lock held by any other operation, even
 * one in this process, is never handed over.
 */
export async function prepareHeldLockRemoval(checkout) {
  const leases = new Set();
  for (const frame of heldLocks.getStore()?.values() ?? []) {
    // A committed lease has already left with an earlier removal. An uncommitted one is checked and
    // handed over again, so a retried removal is never left without its handover.
    if (frame?.active && frame.lease?.active && frame.lease.directory
        && !frame.lease.removal?.committed) leases.add(frame.lease);
  }
  const handovers = [];
  const info = leases.size ? await pathInfo(checkout) : null;
  if (info?.isDirectory() && !info.isSymbolicLink()) {
    const container = await realpath(checkout);
    for (const lease of leases) {
      const relative = pathInsideDirectory(container, await canonicalLocation(lease.directory));
      if (!relative) continue;
      const current = await activeDirectoryOwner(lease.directory);
      if (!current.info || current.owner?.lockToken !== lease.owner.lockToken
          || current.owner?.processToken !== PROCESS_TOKEN) {
        const { subject } = lease.owner;
        throw new SingularityFlowError(
          `The ${subject.kind} '${subject.id}' lock this command held in ${checkout} is no longer its own. `
          + 'Another process may be changing that checkout, so nothing in it was moved. Check it before retrying.',
          { code: 'SUBJECT_LOCK_LOST', details: { lock: lease.directory, checkout } }
        );
      }
      handovers.push({ lease, relative });
    }
  }
  // Stop renewal only after every covered lock has been checked, so a refusal leaves each of them
  // exactly as it was.
  for (const handover of handovers) {
    handover.lease.removal = { checkout, committed: false };
    await stopHeartbeat(handover.lease.heartbeat).catch(() => {});
  }
  return {
    locks: handovers.length,
    async commit(destination) {
      for (const { lease, relative } of handovers) {
        try {
          const moved = await activeDirectoryOwner(path.join(await realpath(destination), relative));
          if (moved.info && moved.owner?.lockToken === lease.owner.lockToken
              && moved.owner?.processToken === PROCESS_TOKEN) lease.removal.committed = true;
        } catch {
          // A lock that cannot be verified keeps its release warning. Verification must never fail
          // a removal that has already been committed.
        }
      }
    }
  };
}

/**
 * Hold one uniquely named subject lease for the complete lifetime of a repository mutation.
 *
 * The random suffix means unrelated commands never serialize on this guard. Factory reset scans
 * the lock root rather than a fixed name, so every in-flight command remains visible until its
 * callback settles. `withSubjectLock` performs the reset-barrier check on both sides of acquisition.
 */
export async function withRepositoryMutationLease(root, operationId, callback) {
  const label = String(operationId ?? '').trim() || 'repository-operation';
  const subject = {
    kind: 'repository-mutation',
    id: `${label}-${randomUUID()}`
  };
  return withSubjectLock(root, subject, callback);
}
