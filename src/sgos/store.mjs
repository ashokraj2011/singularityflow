/**
 * Machine-local storage for the first SGOS runtime slice.
 *
 * This is deliberately an operational sidecar.  Nothing in this module writes a Story workflow,
 * lifecycle branch, or governed artifact.  The exact Story/Git binding is retained as immutable
 * evidence while the existing lifecycle remains the only authority for Story state.
 */
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { constants as FS_CONSTANTS, realpathSync } from 'node:fs';
import { link, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { branch, gitCommonDir, gitDir, head, repoRoot } from '../git.mjs';
import { canonicalJson, recordSha256 } from '../records.mjs';
import {
  currentSchemaVersion, familyForStoredPath, readRecord
} from '../schema-migrations.mjs';
import { withSubjectLock } from '../subject-lock.mjs';
import { SingularityFlowError, nowIso } from '../util.mjs';
import {
  createSgosTransitionIntent, MAXIMUM_SGOS_RECORD_INDEX_DELTA,
  SGOS_RECORD_INDEX_FAMILIES, validateSgosRecord, validateSgosTransitionIntent
} from './contracts.mjs';
import { sgosContractPathFromLocal } from './paths.mjs';
import { SGOS_INSTALLED_LIMITS } from './limits.mjs';
import { assertSgosProcessMaterialization } from './materialization.mjs';
import { compareSgosCodePoints } from './order.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const PROCESS_STATES = new Set([
  'queued', 'running', 'waiting-human', 'blocked', 'paused', 'succeeded', 'failed',
  'cancelled', 'recovery-required'
]);
const TASK_STATES = new Set([
  'planned', 'waiting', 'ready', 'leased', 'running', 'waiting-human', 'verifying',
  'succeeded', 'failed', 'blocked', 'cancelled', 'invalidated', 'recovery-required', 'skipped'
]);
const MAX_IMMUTABLE_RECORD_SCAN = 10_000;
const MAX_PROCESS_TASKS = SGOS_INSTALLED_LIMITS.maximumTasks;
const MAX_CONTROL_RECORDS = SGOS_INSTALLED_LIMITS.maximumControlRecords;
const MAX_OPERATOR_CONTROL_TRANSITIONS = SGOS_INSTALLED_LIMITS.maximumOperatorControlTransitions;
const MAX_EXECUTION_LEASES = SGOS_INSTALLED_LIMITS.maximumExecutionLeases;
const MAX_PROCESS_RECORD_BYTES = SGOS_INSTALLED_LIMITS.maximumProcessRecordBytes;
const MAX_PROCESS_RECORDS = SGOS_INSTALLED_LIMITS.maximumProcessRecords;
const INDEXED_RECORD_FAMILIES = new Set(SGOS_RECORD_INDEX_FAMILIES);
const PROCESS_LOCK_CONTEXT = new AsyncLocalStorage();
const RECORD_DELTA_CONTEXT = new AsyncLocalStorage();
const RECORD_INDEX_MEMBERSHIP_CACHE = new Map();
const RECORD_RESERVATION_DIRECTORY = 'record-reservations';
const TRANSITION_INTENT_FILE = 'transition-intent.json';
let SGOS_STORE_FAULT_BOUNDARY = null;
const CURRENT_EXECUTION_OWNER_STARTED_AT = Math.max(
  0, Math.trunc(Date.now() - process.uptime() * 1_000)
);
const CURRENT_EXECUTION_OWNER_FINGERPRINT = `sha256:${createHash('sha256')
  .update(`sgos-execution-owner\0${process.pid}\0${CURRENT_EXECUTION_OWNER_STARTED_AT}`)
  .digest('hex')}`;
const LIVE_CURRENT_EXECUTION_OWNERS = new Set();
// Admission permits a bounded attempt/control envelope. In the most conservative layout, each
// attempt-record slot can also leave a candidate, evidence, receipt, Human Request/Response, and
// one additional immutable record; each control transition can leave an event, successor, and
// checkpoint. The fixed allowance covers state, authority, Program, lease, and directories.
const MAX_QUARANTINE_RECORD_ENTRIES = 32
  + 7 * SGOS_INSTALLED_LIMITS.maximumAttemptRecords
  + 3 * SGOS_INSTALLED_LIMITS.maximumControlRecords;
const MAX_QUARANTINE_PENDING_FILES = SGOS_INSTALLED_LIMITS.maximumPendingWriterFiles;
const MAX_QUARANTINE_TREE_FILES = MAX_QUARANTINE_RECORD_ENTRIES
  + MAX_QUARANTINE_PENDING_FILES;
const MAX_QUARANTINE_FILE_BYTES = SGOS_INSTALLED_LIMITS.maximumRecordBytes;
// Indexed application/evidence bytes have one practical Process-wide ceiling. Control/index/state
// plumbing remains separately count-bounded and each file retains the installed record ceiling.
const MAX_QUARANTINE_TREE_BYTES = MAX_PROCESS_RECORD_BYTES
  + (2 * MAX_CONTROL_RECORDS + MAX_EXECUTION_LEASES + MAX_QUARANTINE_PENDING_FILES + 4)
    * MAX_QUARANTINE_FILE_BYTES;
const DIRECTORY_SYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP']);
const WINDOWS_DIRECTORY_SYNC_UNSUPPORTED = new Set(['EACCES', 'EBADF', 'EISDIR', 'EPERM', 'UNKNOWN']);

const IMMUTABLE_FAMILIES = Object.freeze({
  'gvm-program': Object.freeze({ directory: 'programs', hashField: 'programSha256' }),
  'candidate-snapshot': Object.freeze({ directory: 'candidate-snapshots', hashField: 'candidateSha256' }),
  'process-binding': Object.freeze({ directory: 'bindings', hashField: 'bindingSha256' }),
  'sgos-record-index': Object.freeze({ directory: 'record-indexes', hashField: 'recordIndexSha256' }),
  'sgos-control-event': Object.freeze({ directory: 'control-events', hashField: 'controlEventSha256' }),
  'gvm-task-attempt': Object.freeze({ directory: 'attempts', hashField: 'attemptSha256' }),
  'gvm-task-receipt': Object.freeze({ directory: 'receipts', hashField: 'receiptSha256' }),
  'gvm-checkpoint': Object.freeze({ directory: 'checkpoints', hashField: 'checkpointSha256' }),
  'human-request': Object.freeze({ directory: 'human-requests', hashField: 'requestSha256' }),
  'human-response': Object.freeze({ directory: 'human-responses', hashField: 'responseSha256' }),
  'action-evidence': Object.freeze({ directory: 'evidence', hashField: 'evidenceSha256' })
});

function fail(message, code, details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function clone(value) {
  return structuredClone(value);
}

function requireId(label, value) {
  const normalized = String(value ?? '');
  if (!ID.test(normalized)) fail(`${label} '${normalized}' is not a safe SGOS identifier.`, 'SGOS_ID_INVALID', { label, value });
  return normalized;
}

function requireProcessId(value) {
  const id = requireId('processId', value);
  if (!/^PROC-[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/.test(id)) {
    fail(`processId '${id}' must be a PROC-prefixed SGOS identifier.`, 'SGOS_ID_INVALID', { label: 'processId', value: id });
  }
  return id;
}

function requireSha256(label, value, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (!SHA256.test(String(value ?? ''))) {
    fail(`${label} must be an exact sha256 reference.`, 'SGOS_HASH_INVALID', { label, value: value ?? null });
  }
  return String(value);
}

function safeSegment(value) {
  return encodeURIComponent(requireProcessId(value));
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, FS_CONSTANTS.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (DIRECTORY_SYNC_UNSUPPORTED.has(error?.code)
        || (process.platform === 'win32' && WINDOWS_DIRECTORY_SYNC_UNSUPPORTED.has(error?.code))) return;
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeDurableStagingFile(target, bytes) {
  const byteCount = Buffer.byteLength(bytes);
  if (byteCount > SGOS_INSTALLED_LIMITS.maximumRecordBytes) {
    fail(`SGOS durable record exceeds the installed ${SGOS_INSTALLED_LIMITS.maximumRecordBytes}-byte ceiling.`,
      'SGOS_RECORD_BUDGET_EXCEEDED', {
        maximumBytes: SGOS_INSTALLED_LIMITS.maximumRecordBytes,
        actualBytes: byteCount
      });
  }
  let handle;
  try {
    const flags = FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL
      | (FS_CONSTANTS.O_NOFOLLOW ?? 0);
    handle = await open(target, flags, 0o600);
    await handle.writeFile(bytes);
    // Data reaches stable storage before a rename or hard-link makes the record authoritative.
    await handle.sync();
  } catch (error) {
    if (['ELOOP', 'EMLINK'].includes(error?.code)) {
      fail(`SGOS staging target '${target}' is a symbolic link.`, 'SGOS_SIDECAR_PATH_UNSAFE');
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function sgosProcessDirectory(root, processId) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'sgos', 'processes', safeSegment(processId));
}

export function sgosProcessStatePath(root, processId) {
  return path.join(sgosProcessDirectory(root, processId), 'state.json');
}

export function sgosProcessQuarantineRoot(root) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'sgos', 'quarantine');
}

/** Compatibility name for callers compiled against the initial preview API. */
export function sgosProcessArchiveRoot(root) {
  return sgosProcessQuarantineRoot(root);
}

function sgosProcessQuarantineDirectory(root, processId, treeSha256) {
  const digest = requireSha256('treeSha256', treeSha256).slice('sha256:'.length);
  return path.join(sgosProcessQuarantineRoot(root), `${safeSegment(processId)}--${digest}`);
}

function executionLeasePath(root, processId, leaseId) {
  return path.join(sgosProcessDirectory(root, processId), 'execution-leases',
    `${encodeURIComponent(requireId('leaseId', leaseId))}.json`);
}

function controlSuccessorPath(root, processId, beforeProcessSha256) {
  const digest = requireSha256('beforeProcessSha256', beforeProcessSha256)
    .slice('sha256:'.length);
  return path.join(sgosProcessDirectory(root, processId), 'control-next', `${digest}.json`);
}

function transitionIntentPath(root, processId) {
  return path.join(sgosProcessDirectory(root, processId), TRANSITION_INTENT_FILE);
}

/** @internal Deterministic crash injection used only by focused store tests. */
export function setSgosStoreFaultBoundaryForTests(boundary = null, {
  occurrence = 1,
  code = 'SGOS_TEST_FAULT'
} = {}) {
  if (boundary === null) {
    SGOS_STORE_FAULT_BOUNDARY = null;
    return;
  }
  if (!Number.isSafeInteger(occurrence) || occurrence < 1 || typeof code !== 'string' || !code) {
    fail('SGOS test fault boundary requires a positive occurrence and error code.',
      'SGOS_TEST_FAULT_CONFIGURATION_INVALID');
  }
  SGOS_STORE_FAULT_BOUNDARY = { boundary, remaining: occurrence, code };
}

function injectSgosStoreFault(boundary) {
  if (SGOS_STORE_FAULT_BOUNDARY?.boundary !== boundary) return;
  if (SGOS_STORE_FAULT_BOUNDARY.remaining > 1) {
    SGOS_STORE_FAULT_BOUNDARY.remaining -= 1;
    return;
  }
  const { code } = SGOS_STORE_FAULT_BOUNDARY;
  SGOS_STORE_FAULT_BOUNDARY = null;
  if (code === 'SGOS_TEST_FAULT') {
    fail(`Injected SGOS store crash after '${boundary}'.`, code, { boundary });
  }
  throw Object.assign(new Error(`Injected SGOS store ${code} after '${boundary}'.`), {
    code, boundary
  });
}

function validateExecutionLease(value, { processId = null, leaseId = null } = {}) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)
      || value.kind !== 'sgos-execution-lease') {
    fail('SGOS execution lease is malformed.', 'SGOS_EXECUTION_LEASE_CORRUPT');
  }
  const allowed = new Set([
    'schemaVersion', 'kind', 'leaseId', 'processId', 'attemptId', 'taskInstanceId',
    'ownerId', 'ownerPid', 'ownerStartFingerprint', 'beforeProcessSha256', 'beforeProcessRevision',
    'executionHandleSha256', 'attemptSha256', 'acquiredAt', 'heartbeatAt'
  ]);
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) {
    fail(`SGOS execution lease contains unsupported field '${unknown}'.`,
      'SGOS_EXECUTION_LEASE_CORRUPT');
  }
  const requiredStrings = [
    'leaseId', 'processId', 'attemptId', 'taskInstanceId', 'ownerId',
    'ownerStartFingerprint', 'beforeProcessSha256', 'executionHandleSha256',
    'attemptSha256', 'acquiredAt', 'heartbeatAt'
  ];
  for (const field of requiredStrings) {
    if (typeof value[field] !== 'string' || !value[field]) {
      fail(`SGOS execution lease is missing '${field}'.`, 'SGOS_EXECUTION_LEASE_CORRUPT');
    }
  }
  requireId('leaseId', value.leaseId);
  requireProcessId(value.processId);
  requireId('attemptId', value.attemptId);
  requireId('ownerId', value.ownerId);
  requireSha256('ownerStartFingerprint', value.ownerStartFingerprint);
  requireSha256('beforeProcessSha256', value.beforeProcessSha256);
  requireSha256('executionHandleSha256', value.executionHandleSha256);
  requireSha256('attemptSha256', value.attemptSha256);
  if (!Number.isInteger(value.beforeProcessRevision) || value.beforeProcessRevision < 1
      || !Number.isInteger(value.ownerPid) || value.ownerPid < 1) {
    fail('SGOS execution lease has invalid revision or owner PID.', 'SGOS_EXECUTION_LEASE_CORRUPT');
  }
  for (const field of ['acquiredAt', 'heartbeatAt']) {
    if (!Number.isFinite(Date.parse(value[field]))) {
      fail(`SGOS execution lease has invalid '${field}'.`, 'SGOS_EXECUTION_LEASE_CORRUPT');
    }
  }
  if (processId != null && value.processId !== processId) {
    fail('SGOS execution lease belongs to another Process.', 'SGOS_EXECUTION_LEASE_CORRUPT');
  }
  if (leaseId != null && value.leaseId !== leaseId) {
    fail('SGOS execution lease identity does not match its path.', 'SGOS_EXECUTION_LEASE_CORRUPT');
  }
  return value;
}

/** @internal Process-instance identity for lease writers/tests; omitted from the public barrel. */
export function currentSgosExecutionOwnerFingerprint() {
  return CURRENT_EXECUTION_OWNER_FINGERPRINT;
}

/** @internal Mark one current-process execution coroutine as live before lease publication. */
export function registerSgosExecutionOwner(lease) {
  const validated = validateExecutionLease(lease, {
    processId: lease?.processId,
    leaseId: lease?.leaseId
  });
  if (validated.ownerPid !== process.pid
      || validated.ownerStartFingerprint !== CURRENT_EXECUTION_OWNER_FINGERPRINT) {
    fail('SGOS execution owner registration does not identify this process instance.',
      'SGOS_EXECUTION_LEASE_CORRUPT');
  }
  if (LIVE_CURRENT_EXECUTION_OWNERS.has(validated.ownerId)) {
    fail('SGOS execution owner is already registered.', 'SGOS_EXECUTION_LEASE_BUSY', {
      ownerId: validated.ownerId
    });
  }
  LIVE_CURRENT_EXECUTION_OWNERS.add(validated.ownerId);
}

/** @internal End current-process liveness without deleting durable recovery evidence. */
export function unregisterSgosExecutionOwner(lease) {
  if (lease?.ownerPid === process.pid
      && lease?.ownerStartFingerprint === CURRENT_EXECUTION_OWNER_FINGERPRINT) {
    LIVE_CURRENT_EXECUTION_OWNERS.delete(lease.ownerId);
  }
}

/** @internal Conservative liveness proof; a reused local PID cannot inherit an old lease. */
export function isSgosExecutionOwnerLive(lease) {
  if (!Number.isInteger(lease?.ownerPid) || lease.ownerPid < 1
      || !SHA256.test(String(lease?.ownerStartFingerprint ?? ''))) return false;
  try {
    process.kill(lease.ownerPid, 0);
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    // EPERM and unknown platform errors conservatively preserve the lease.
    return true;
  }
  if (lease.ownerPid === process.pid) {
    return lease.ownerStartFingerprint === CURRENT_EXECUTION_OWNER_FINGERPRINT
      && LIVE_CURRENT_EXECUTION_OWNERS.has(lease.ownerId);
  }
  // For another visible PID, inability to authenticate its process-start token is fail-closed:
  // recovery may wait, but never steals execution from a potentially live owner.
  return true;
}

/** Operational owner record used only to distinguish a live executor from a crashed one. */
export async function writeSgosExecutionLease(root, processId, lease) {
  const id = requireProcessId(processId);
  const validated = validateExecutionLease({
    ...clone(lease), schemaVersion: currentSchemaVersion('sgos-execution-lease')
  }, { processId: id });
  return withProcessLock(root, id, async () => {
    // Recheck existence after acquiring the same lock used by quarantine. A concurrent move must
    // never be followed by recreation of a partial Process directory containing only a lease.
    await readSafeFile(root, sgosProcessStatePath(root, id));
    const target = executionLeasePath(root, id, validated.leaseId);
    await writeSafeAtomic(root, target, canonicalJson(validated));
    return Object.freeze(clone(validated));
  }, 2_000, { createDirectory: false });
}

export async function readSgosExecutionLease(root, processId, leaseId) {
  const id = requireProcessId(processId);
  const target = executionLeasePath(root, id, leaseId);
  try {
    const value = readRecord('sgos-execution-lease', await readSafeFile(root, target)).record;
    return Object.freeze(clone(validateExecutionLease(value, { processId: id, leaseId })));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) {
      fail('SGOS execution lease is not valid JSON.', 'SGOS_EXECUTION_LEASE_CORRUPT');
    }
    throw error;
  }
}

export async function removeSgosExecutionLease(root, processId, leaseId) {
  const id = requireProcessId(processId);
  try {
    return await withProcessLock(root, id, async () => {
      const target = executionLeasePath(root, id, leaseId);
      try {
        const stats = await lstat(target);
        if (stats.isSymbolicLink() || !stats.isFile()) {
          fail('SGOS execution lease target is unsafe.', 'SGOS_SIDECAR_PATH_UNSAFE');
        }
        await rm(target);
        await syncDirectory(path.dirname(target));
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }, 2_000, { createDirectory: false });
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * @internal Reconcile the bounded pre-CAS lease crash window under the Process lock.
 * An unreferenced live owner blocks dispatch; an unreferenced exited owner is safely removed.
 */
export async function reconcileSgosExecutionLeases(root, processId) {
  const id = requireProcessId(processId);
  return withProcessLock(root, id, async () => {
    const state = await readSgosProcessUnlocked(root, id);
    const pendingIntent = await readSgosTransitionIntent(root, id);
    const pendingLeases = new Set(pendingIntent?.controlEvent?.result?.activeLeases ?? []);
    const pendingExecutions = new Set(
      pendingIntent?.controlEvent?.result?.activeExecutions ?? []
    );
    const directory = path.join(sgosProcessDirectory(root, id), 'execution-leases');
    let entries;
    try {
      await safeSgosDirectory(root, directory);
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return Object.freeze({ removed: [], retained: [] });
      throw error;
    }
    if (entries.length > MAX_EXECUTION_LEASES) {
      fail('SGOS Process execution-lease directory exceeds its installed bounded capacity.',
        'SGOS_EXECUTION_LEASE_LIMIT', {
          actual: entries.length,
          maximum: MAX_EXECUTION_LEASES
        });
    }
    const removed = [];
    const retained = [];
    for (const entry of entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) {
        fail('SGOS execution-lease directory contains an unsafe entry.',
          'SGOS_SIDECAR_PATH_UNSAFE', { entry: entry.name });
      }
      let leaseId;
      try { leaseId = decodeURIComponent(entry.name.slice(0, -'.json'.length)); } catch {
        fail('SGOS execution-lease path has an invalid encoded identity.',
          'SGOS_SIDECAR_PATH_UNSAFE', { entry: entry.name });
      }
      requireId('leaseId', leaseId);
      const lease = await readSgosExecutionLease(root, id, leaseId);
      if (state.activeLeases.includes(leaseId)
          || pendingLeases.has(leaseId)
          || pendingExecutions.has(lease.attemptId)) {
        retained.push(leaseId);
        continue;
      }
      if (isSgosExecutionOwnerLive(lease)) {
        fail('An unreferenced SGOS execution lease still has a live owner.',
          'SGOS_EXECUTION_LEASE_BUSY', {
            leaseId,
            ownerPid: lease.ownerPid,
            ownerStartFingerprint: lease.ownerStartFingerprint
          });
      }
      await rm(executionLeasePath(root, id, leaseId));
      removed.push(leaseId);
    }
    if (removed.length) await syncDirectory(directory);
    return Object.freeze({ removed: Object.freeze(removed), retained: Object.freeze(retained) });
  }, 2_000, { createDirectory: false });
}

/** @internal Delete only this owner's lease after an exact locked state reread proves release. */
export async function removeSgosExecutionLeaseIfUnreferenced(root, processId, lease) {
  const id = requireProcessId(processId);
  const validated = validateExecutionLease(lease, { processId: id, leaseId: lease?.leaseId });
  return withProcessLock(root, id, async () => {
    const state = await readSgosProcessUnlocked(root, id);
    const pendingIntent = await readSgosTransitionIntent(root, id);
    if (state.activeLeases.includes(validated.leaseId)
        || state.activeExecutions.includes(validated.attemptId)
        || pendingIntent?.controlEvent?.result?.activeLeases?.includes(validated.leaseId)
        || pendingIntent?.controlEvent?.result?.activeExecutions?.includes(validated.attemptId)) {
      return false;
    }
    const durable = await readSgosExecutionLease(root, id, validated.leaseId);
    if (durable === null) return false;
    if (durable.ownerId !== validated.ownerId
        || durable.ownerPid !== validated.ownerPid
        || durable.ownerStartFingerprint !== validated.ownerStartFingerprint
        || durable.attemptId !== validated.attemptId) {
      fail('SGOS execution lease ownership changed before conditional cleanup.',
        'SGOS_EXECUTION_LEASE_LOST', { leaseId: validated.leaseId });
    }
    await rm(executionLeasePath(root, id, validated.leaseId));
    await syncDirectory(path.dirname(executionLeasePath(root, id, validated.leaseId)));
    return true;
  }, 2_000, { createDirectory: false });
}

async function safeSgosDirectory(root, directory, { create = false } = {}) {
  const commonDirectory = path.resolve(gitCommonDir(root));
  const targetDirectory = path.resolve(directory);
  const relative = path.relative(commonDirectory, targetDirectory);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('SGOS store path escapes the Git common directory.', 'SGOS_SIDECAR_PATH_UNSAFE');
  }
  let commonStats;
  try { commonStats = await lstat(commonDirectory); } catch (error) {
    if (error?.code === 'ENOENT') fail('Git common directory is unavailable.', 'SGOS_SIDECAR_PATH_UNSAFE');
    throw error;
  }
  if (commonStats.isSymbolicLink() || !commonStats.isDirectory()) {
    fail('Git common directory is not a real directory.', 'SGOS_SIDECAR_PATH_UNSAFE');
  }
  let cursor = commonDirectory;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    const parent = cursor;
    cursor = path.join(cursor, segment);
    let stats;
    try {
      stats = await lstat(cursor);
    } catch (error) {
      if (error?.code !== 'ENOENT' || !create) throw error;
      try { await mkdir(cursor, { mode: 0o700 }); } catch (mkdirError) {
        if (mkdirError?.code !== 'EEXIST') throw mkdirError;
      }
      // Persist each new directory entry before a child path becomes part of the sidecar layout.
      await syncDirectory(parent);
      stats = await lstat(cursor);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      fail(`SGOS store ancestor '${cursor}' is not a real directory.`, 'SGOS_SIDECAR_PATH_UNSAFE');
    }
  }
  return targetDirectory;
}

async function readSafeFile(root, target) {
  await safeSgosDirectory(root, path.dirname(target));
  let handle;
  try {
    handle = await open(target, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW ?? 0));
    const stats = await handle.stat();
    if (!stats.isFile()) fail(`SGOS store target '${target}' is not a real file.`, 'SGOS_SIDECAR_PATH_UNSAFE');
    if (stats.size > SGOS_INSTALLED_LIMITS.maximumRecordBytes) {
      fail(`SGOS store target '${target}' exceeds the installed durable-record byte ceiling.`,
        'SGOS_RECORD_SIZE_LIMIT', {
          actualBytes: stats.size,
          maximumBytes: SGOS_INSTALLED_LIMITS.maximumRecordBytes
        });
    }
    return await handle.readFile('utf8');
  } catch (error) {
    if (['ELOOP', 'EMLINK'].includes(error?.code)) {
      fail(`SGOS store target '${target}' is a symbolic link.`, 'SGOS_SIDECAR_PATH_UNSAFE');
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeSafeAtomic(root, target, bytes) {
  await safeSgosDirectory(root, path.dirname(target), { create: true });
  const temporary = `${target}.pending-${process.pid}-${randomUUID()}`;
  try {
    await writeDurableStagingFile(temporary, bytes);
    const staged = await lstat(temporary);
    if (staged.isSymbolicLink() || !staged.isFile()) {
      fail('Mutable SGOS staging target is not a real file.', 'SGOS_SIDECAR_PATH_UNSAFE');
    }
    await safeSgosDirectory(root, path.dirname(target));
    try {
      const existing = await lstat(target);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        fail(`SGOS store target '${target}' is not a real file.`, 'SGOS_SIDECAR_PATH_UNSAFE');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await rename(temporary, target);
    await syncDirectory(path.dirname(target));
    await safeSgosDirectory(root, path.dirname(target));
    const published = await lstat(target);
    if (published.isSymbolicLink() || !published.isFile()) {
      fail(`SGOS store publication '${target}' is not a real file.`, 'SGOS_SIDECAR_PATH_UNSAFE');
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function immutableLocation(root, processId, familyId, sha256) {
  const family = IMMUTABLE_FAMILIES[familyId];
  if (!family) fail(`'${familyId}' is not an SGOS immutable-store family.`, 'SGOS_RECORD_FAMILY_INVALID', { family: familyId });
  const reference = requireSha256(family.hashField, sha256);
  return path.join(sgosProcessDirectory(root, processId), family.directory, `${reference.slice('sha256:'.length)}.json`);
}

function recordReservationLocation(root, processId, familyId, sha256) {
  if (!INDEXED_RECORD_FAMILIES.has(familyId)) {
    fail(`'${familyId}' is not an indexed SGOS record family.`,
      'SGOS_RECORD_FAMILY_INVALID', { family: familyId });
  }
  const reference = requireSha256('recordSha256', sha256);
  return path.join(
    sgosProcessDirectory(root, processId), RECORD_RESERVATION_DIRECTORY,
    `${familyId}--${reference.slice('sha256:'.length)}.json`
  );
}

function recordIndexEntry(familyId, record, bytes = canonicalJson(record)) {
  const family = IMMUTABLE_FAMILIES[familyId];
  if (!family || !INDEXED_RECORD_FAMILIES.has(familyId)) {
    fail(`'${familyId}' is not an indexed SGOS record family.`,
      'SGOS_RECORD_FAMILY_INVALID', { family: familyId });
  }
  const entry = {
    family: familyId,
    recordSha256: requireSha256(family.hashField, record[family.hashField]),
    bytes: Buffer.byteLength(bytes)
  };
  if (record.attemptId != null) entry.attemptId = requireId('attemptId', record.attemptId);
  if (record.taskInstanceId != null) {
    entry.taskInstanceId = requireId('taskInstanceId', record.taskInstanceId);
  }
  return Object.freeze(entry);
}

function compareRecordIndexEntries(left, right) {
  const leftKey = [
    left.family, left.recordSha256, left.attemptId ?? '', left.taskInstanceId ?? ''
  ].join('\u0000');
  const rightKey = [
    right.family, right.recordSha256, right.attemptId ?? '', right.taskInstanceId ?? ''
  ].join('\u0000');
  return compareSgosCodePoints(leftKey, rightKey);
}

function reservationToken(family, recordSha256, bytes) {
  return Object.freeze({ family, recordSha256, bytes });
}

async function readCurrentRecordIndexForCapacity(root, processId) {
  let raw;
  try { raw = await readSafeFile(root, sgosProcessStatePath(root, processId)); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let stored;
  try { stored = JSON.parse(raw); } catch {
    fail(`SGOS process '${processId}' is not valid JSON.`, 'SGOS_PROCESS_CORRUPT');
  }
  if (stored?.processId !== processId
      || stored.processSha256 !== hashWithout(stored, 'processSha256')) {
    fail(`SGOS process '${processId}' failed its stored-byte integrity check.`,
      'SGOS_PROCESS_CORRUPT');
  }
  const loaded = readRecord('gvm-process', raw);
  if (loaded.storedVersion === currentSchemaVersion('gvm-process')
      && canonicalJson(loaded.record) !== raw) {
    fail(`SGOS process '${processId}' is not stored in canonical exact-byte form.`,
      'SGOS_PROCESS_CORRUPT');
  }
  const state = loaded.storedVersion === currentSchemaVersion('gvm-process')
    ? loaded.record
    : sealProcess(loaded.record);
  assertProcessShape(state);
  try { validateSgosRecord(state); } catch (error) {
    fail(`SGOS process '${processId}' failed its strict contract.`, 'SGOS_PROCESS_CORRUPT', {
      cause: error?.message ?? String(error)
    });
  }
  const leaseFootprint = await readExecutionLeaseFootprint(root, processId);
  if (state.recordIndexSha256 == null) {
    if (state.processRevision !== 1 || state.controlEventSha256 !== null) {
      fail('SGOS Process without a record index is not a private creation seed.',
        'SGOS_RECORD_INDEX_INVALID');
    }
    return Object.freeze({
      index: null,
      state,
      stateBytes: Buffer.byteLength(raw),
      infrastructureBytes: 0,
      infrastructureRecords: 0,
      ...leaseFootprint
    });
  }
  const reconciled = await reconcileSgosControlLineage(root, state);
  const { index } = await readSgosRecordIndexHead(
    root, processId, reconciled.state.recordIndexSha256
  );
  if (index.processId !== processId) {
    fail('SGOS Process record index belongs to another Process.', 'SGOS_RECORD_INDEX_INVALID');
  }
  const { record: event } = await readSgosImmutableRecord(
    root, processId, 'sgos-control-event', reconciled.state.controlEventSha256
  );
  const successor = await readSgosControlSuccessor(root, processId, event.beforeProcessSha256);
  if (successor == null || successor.controlEventSha256 !== event.controlEventSha256) {
    fail('SGOS Process capacity cannot trust an incomplete control successor.',
      'SGOS_CONTROL_LINEAGE_INVALID');
  }
  return Object.freeze({
    index,
    state,
    stateBytes: Buffer.byteLength(raw),
    infrastructureBytes: successor.cumulativeInfrastructureBytes,
    infrastructureRecords: successor.cumulativeInfrastructureRecords,
    ...leaseFootprint
  });
}

async function readExecutionLeaseFootprint(root, processId) {
  const directory = path.join(sgosProcessDirectory(root, processId), 'execution-leases');
  let entries = [];
  try {
    await safeSgosDirectory(root, directory);
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (entries.length > MAX_EXECUTION_LEASES) {
    fail('SGOS Process execution-lease directory exceeds its installed bounded capacity.',
      'SGOS_EXECUTION_LEASE_LIMIT', {
        actual: entries.length,
        maximum: MAX_EXECUTION_LEASES
      });
  }
  let leaseBytes = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) {
      fail('SGOS execution-lease directory contains an unsafe entry.',
        'SGOS_SIDECAR_PATH_UNSAFE', { entry: entry.name });
    }
    leaseBytes += Buffer.byteLength(await readSafeFile(root, path.join(directory, entry.name)));
  }
  return Object.freeze({ leaseBytes, leaseRecords: entries.length });
}

async function readRecordReservation(root, processId, familyId, sha256) {
  const target = recordReservationLocation(root, processId, familyId, sha256);
  let raw;
  try { raw = await readSafeFile(root, target); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const family = IMMUTABLE_FAMILIES[familyId];
  const record = readRecord(familyId, raw).record;
  if (canonicalJson(record) !== raw
      || record[family.hashField] !== sha256
      || hashWithout(record, family.hashField) !== sha256
      || (record.processId != null && record.processId !== processId)) {
    fail('SGOS durable record reservation failed its exact integrity binding.',
      'SGOS_RECORD_RESERVATION_CORRUPT', { family: familyId, recordSha256: sha256 });
  }
  try { validateSgosRecord(record); } catch (error) {
    fail('SGOS durable record reservation failed its strict contract.',
      'SGOS_RECORD_RESERVATION_CORRUPT', {
        family: familyId, recordSha256: sha256, cause: error?.message ?? String(error)
      });
  }
  return Object.freeze({
    path: target,
    record: Object.freeze(record),
    entry: recordIndexEntry(familyId, record, raw),
    token: reservationToken(familyId, sha256, Buffer.byteLength(raw))
  });
}

async function listRecordReservations(root, processId) {
  const directory = path.join(sgosProcessDirectory(root, processId), RECORD_RESERVATION_DIRECTORY);
  let entries;
  try {
    await safeSgosDirectory(root, directory);
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze([]);
    throw error;
  }
  if (entries.length > SGOS_INSTALLED_LIMITS.maximumPendingWriterFiles) {
    fail('SGOS Process has too many pending durable record reservations.',
      'SGOS_RECORD_RESERVATION_LIMIT', {
        actual: entries.length,
        maximum: SGOS_INSTALLED_LIMITS.maximumPendingWriterFiles
      });
  }
  const reservations = [];
  for (const entry of entries.sort((left, right) => compareSgosCodePoints(left.name, right.name))) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      fail('SGOS record-reservation directory contains an unsafe entry.',
        'SGOS_SIDECAR_PATH_UNSAFE', { entry: entry.name });
    }
    const matchedFamily = SGOS_RECORD_INDEX_FAMILIES.find((family) =>
      entry.name.startsWith(`${family}--`));
    const suffix = matchedFamily == null ? null : entry.name.slice(`${matchedFamily}--`.length);
    if (matchedFamily == null || !/^[a-f0-9]{64}\.json$/.test(suffix)) {
      fail('SGOS record-reservation directory contains an unrecognized entry.',
        'SGOS_RECORD_RESERVATION_CORRUPT', { entry: entry.name });
    }
    const sha256 = `sha256:${suffix.slice(0, -'.json'.length)}`;
    const reservation = await readRecordReservation(root, processId, matchedFamily, sha256);
    if (reservation === null) {
      fail('SGOS durable record reservation disappeared during inspection.',
        'SGOS_RECORD_RESERVATION_CORRUPT', { entry: entry.name });
    }
    reservations.push(reservation);
  }
  return Object.freeze(reservations);
}

/** @internal Read one exact pre-index crash reservation without scanning immutable history. */
export async function readSgosPendingReservedRecordByField(
  root, processId, familyId, field, expected
) {
  const id = requireProcessId(processId);
  if (!INDEXED_RECORD_FAMILIES.has(familyId) || typeof field !== 'string' || !field) {
    fail('SGOS pending-reservation lookup has an invalid family or field.',
      'SGOS_RECORD_RESERVATION_INVALID');
  }
  return withProcessLock(root, id, async () => {
    const matches = (await listRecordReservations(root, id)).filter((reservation) =>
      reservation.entry.family === familyId && reservation.record[field] === expected);
    if (matches.length > 1) {
      fail('SGOS pending crash lineage is ambiguous.', 'SGOS_RECORD_LINEAGE_INVALID', {
        family: familyId, field, expected, matches: matches.length
      });
    }
    return matches[0]?.record ?? null;
  }, 2_000, { createDirectory: false });
}

async function assertReservationCapacity(root, processId, candidateBytes) {
  const [footprint, reservations] = await Promise.all([
    readCurrentRecordIndexForCapacity(root, processId),
    listRecordReservations(root, processId)
  ]);
  const reservedBytes = reservations.reduce((total, item) => total + item.entry.bytes, 0);
  const indexedBytes = footprint?.index?.totalBytes ?? 0;
  const indexedRecords = footprint?.index?.totalRecordCount ?? 0;
  const infrastructureBytes = footprint?.infrastructureBytes ?? 0;
  const infrastructureRecords = footprint?.infrastructureRecords ?? 0;
  const stateBytes = footprint?.stateBytes ?? 0;
  const leaseBytes = footprint?.leaseBytes ?? 0;
  const leaseRecords = footprint?.leaseRecords ?? 0;
  if (reservations.length + 1 > SGOS_INSTALLED_LIMITS.maximumPendingWriterFiles
      || indexedRecords + infrastructureRecords + reservations.length + leaseRecords + 2
        > MAX_PROCESS_RECORDS
      || indexedBytes + infrastructureBytes + reservedBytes + candidateBytes
        + stateBytes + leaseBytes > MAX_PROCESS_RECORD_BYTES) {
    fail('SGOS Process immutable-record reservation exceeds its installed cumulative capacity.',
      'SGOS_PROCESS_RECORD_BUDGET_EXCEEDED', {
        indexedRecords,
        reservedRecords: reservations.length,
        indexedBytes,
        infrastructureBytes,
        reservedBytes,
        candidateBytes,
        stateBytes,
        leaseBytes,
        maximumRecords: MAX_PROCESS_RECORDS,
        maximumBytes: MAX_PROCESS_RECORD_BYTES
      });
  }
}

function hashWithout(record, hashField) {
  const core = clone(record);
  delete core[hashField];
  return `sha256:${recordSha256(core)}`;
}

/** Stamp and content-address one immutable SGOS record. */
export function sealSgosImmutableRecord(familyId, value) {
  const family = IMMUTABLE_FAMILIES[familyId];
  if (!family) fail(`'${familyId}' is not an SGOS immutable-store family.`, 'SGOS_RECORD_FAMILY_INVALID', { family: familyId });
  const core = clone(value ?? {});
  delete core[family.hashField];
  core.schemaVersion = currentSchemaVersion(familyId);
  const sealed = { ...core, [family.hashField]: `sha256:${recordSha256(core)}` };
  return Object.freeze(sealed);
}

function sealProcess(value) {
  const core = clone(value);
  delete core.processSha256;
  core.schemaVersion = currentSchemaVersion('gvm-process');
  return { ...core, processSha256: `sha256:${recordSha256(core)}` };
}

function transitionIntentToken(token) {
  if (token == null || typeof token !== 'object' || Array.isArray(token)
      || !INDEXED_RECORD_FAMILIES.has(token.family)
      || !SHA256.test(String(token.recordSha256 ?? ''))
      || !Number.isSafeInteger(token.bytes) || token.bytes < 1) {
    fail('SGOS transition intent contains an invalid reservation token.',
      'SGOS_TRANSITION_INTENT_CORRUPT');
  }
  return Object.freeze({
    family: token.family,
    recordSha256: token.recordSha256,
    bytes: token.bytes
  });
}

function sealSgosTransitionIntent(value) {
  const reservations = (value.reservations ?? []).map(transitionIntentToken)
    .sort((left, right) => compareRecordIndexEntries(
    { family: left.family, recordSha256: left.recordSha256 },
    { family: right.family, recordSha256: right.recordSha256 }
  ));
  if (new Set(reservations.map((token) =>
    `${token.family}\u0000${token.recordSha256}`)).size !== reservations.length) {
    fail('SGOS transition intent contains duplicate reservation tokens.',
      'SGOS_TRANSITION_INTENT_CORRUPT');
  }
  const core = {
    schemaVersion: currentSchemaVersion('sgos-transition-intent'),
    kind: 'sgos-transition-intent',
    processId: requireProcessId(value.processId),
    beforeProcessSha256: requireSha256('beforeProcessSha256', value.beforeProcessSha256),
    beforeProcessRevision: value.beforeProcessRevision,
    priorRecordIndexSha256: requireSha256(
      'priorRecordIndexSha256', value.priorRecordIndexSha256
    ),
    reservations,
    nextRecordIndexSha256: requireSha256(
      'nextRecordIndexSha256', value.nextRecordIndexSha256
    ),
    controlEvent: clone(value.controlEvent),
    successorSha256: requireSha256('successorSha256', value.successorSha256),
    candidateProcessSha256: requireSha256(
      'candidateProcessSha256', value.candidateProcessSha256
    )
  };
  if (!Number.isInteger(core.beforeProcessRevision) || core.beforeProcessRevision < 1
      || reservations.length > MAXIMUM_SGOS_RECORD_INDEX_DELTA) {
    fail('SGOS transition intent exceeds its strict revision or reservation bounds.',
      'SGOS_TRANSITION_INTENT_CORRUPT');
  }
  try { validateSgosRecord(core.controlEvent); } catch (error) {
    fail('SGOS transition intent contains an invalid control event.',
      'SGOS_TRANSITION_INTENT_CORRUPT', { cause: error?.message ?? String(error) });
  }
  if (core.controlEvent.processId !== core.processId
      || core.controlEvent.beforeProcessSha256 !== core.beforeProcessSha256
      || core.controlEvent.beforeProcessRevision !== core.beforeProcessRevision
      || core.controlEvent.recordIndexSha256 !== core.nextRecordIndexSha256) {
    fail('SGOS transition intent event does not bind its exact predecessor and index.',
      'SGOS_TRANSITION_INTENT_CORRUPT');
  }
  try { return createSgosTransitionIntent(core); } catch (error) {
    fail('SGOS transition intent failed its strict durable contract.',
      'SGOS_TRANSITION_INTENT_CORRUPT', { cause: error?.message ?? String(error) });
  }
}

async function readSgosTransitionIntent(root, processId) {
  const target = transitionIntentPath(root, processId);
  let raw;
  try { raw = await readSafeFile(root, target); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const loaded = readRecord('sgos-transition-intent', raw);
  if (loaded.storedVersion !== currentSchemaVersion('sgos-transition-intent')
      || canonicalJson(loaded.record) !== raw) {
    fail('SGOS transition intent is not current canonical JSON.',
      'SGOS_TRANSITION_INTENT_CORRUPT');
  }
  const expectedKeys = [
    'schemaVersion', 'kind', 'processId', 'beforeProcessSha256',
    'beforeProcessRevision', 'priorRecordIndexSha256', 'reservations',
    'nextRecordIndexSha256', 'controlEvent', 'successorSha256',
    'candidateProcessSha256', 'intentSha256'
  ].sort();
  if (canonicalJson(Object.keys(loaded.record).sort()) !== canonicalJson(expectedKeys)
      || loaded.record.kind !== 'sgos-transition-intent'
      || loaded.record.processId !== processId
      || loaded.record.intentSha256 !== hashWithout(loaded.record, 'intentSha256')) {
    fail('SGOS transition intent failed its exact identity or content hash.',
      'SGOS_TRANSITION_INTENT_CORRUPT');
  }
  try { validateSgosTransitionIntent(loaded.record); } catch (error) {
    fail('SGOS transition intent failed its strict durable contract.',
      'SGOS_TRANSITION_INTENT_CORRUPT', { cause: error?.message ?? String(error) });
  }
  const sealed = sealSgosTransitionIntent(loaded.record);
  if (sealed.intentSha256 !== loaded.record.intentSha256) {
    fail('SGOS transition intent failed strict reconstruction.',
      'SGOS_TRANSITION_INTENT_CORRUPT');
  }
  return Object.freeze(loaded.record);
}

async function writeSgosTransitionIntent(root, processId, intent) {
  const sealed = sealSgosTransitionIntent(intent);
  const bytes = canonicalJson(sealed);
  if (Buffer.byteLength(bytes) > SGOS_INSTALLED_LIMITS.maximumRecordBytes) {
    fail('SGOS transition intent exceeds the installed durable-record ceiling.',
      'SGOS_RECORD_SIZE_LIMIT');
  }
  const existing = await readSgosTransitionIntent(root, processId);
  if (existing !== null && canonicalJson(existing) !== bytes) {
    fail('Another exact SGOS transition intent already owns this predecessor.',
      'SGOS_TRANSITION_INTENT_CONFLICT', {
        beforeProcessSha256: existing.beforeProcessSha256
      });
  }
  if (existing === null) {
    await writeSafeAtomic(root, transitionIntentPath(root, processId), bytes);
  }
  return sealed;
}

async function removeSgosTransitionIntent(root, processId, intentSha256) {
  const existing = await readSgosTransitionIntent(root, processId);
  if (existing === null) return false;
  if (existing.intentSha256 !== intentSha256) {
    fail('SGOS transition intent changed before cleanup.',
      'SGOS_TRANSITION_INTENT_CONFLICT');
  }
  await rm(transitionIntentPath(root, processId));
  injectSgosStoreFault('intent-removal');
  await syncDirectory(path.dirname(transitionIntentPath(root, processId)));
  return true;
}

function mutableProcessProjection(state) {
  return {
    status: state.status,
    taskInstances: clone(state.taskInstances),
    activeExecutions: clone(state.activeExecutions),
    openHumanRequests: clone(state.openHumanRequests),
    activeLeases: clone(state.activeLeases),
    currentCheckpointSha256: state.currentCheckpointSha256,
    processRevision: state.processRevision,
    updatedAt: state.updatedAt
  };
}

function immutableProcessCoreSha256(state) {
  return `sha256:${recordSha256({
    processId: state.processId,
    programSha256: state.programSha256,
    policySnapshotSha256: state.policySnapshotSha256,
    processBindingSha256: state.processBindingSha256,
    taskContractSha256: state.taskContractSha256,
    authorityBinding: clone(state.authorityBinding),
    createdAt: state.createdAt
  })}`;
}

function controlEventAction(before, after) {
  if (before.status !== 'paused' && after.status === 'paused') return 'process-paused';
  if (before.status === 'paused' && after.status !== 'paused') return 'process-resumed';
  if (before.status !== 'recovery-required' && after.status === 'recovery-required') {
    return 'recovery-required';
  }
  if (before.status === 'recovery-required' && after.status !== 'recovery-required') {
    return 'recovery-resolved';
  }
  if (after.activeExecutions.length > before.activeExecutions.length) return 'execution-started';
  if (after.activeExecutions.length < before.activeExecutions.length) return 'execution-finished';
  if (after.openHumanRequests.length > before.openHumanRequests.length) return 'human-requested';
  if (after.openHumanRequests.length < before.openHumanRequests.length) return 'human-resolved';
  return 'process-transition';
}

function processFromControlEvent(base, event) {
  if (event.processCoreSha256 !== immutableProcessCoreSha256(base)) {
    fail('SGOS control event does not bind the Process immutable authority core.',
      'SGOS_CONTROL_LINEAGE_INVALID', { controlEventSha256: event.controlEventSha256 });
  }
  const reconstructed = {
    ...clone(base),
    ...clone(event.result),
    schemaVersion: currentSchemaVersion('gvm-process'),
    kind: 'gvm-process',
    controlEventSha256: event.controlEventSha256,
    recordIndexSha256: event.recordIndexSha256
  };
  delete reconstructed.processSha256;
  const sealed = sealProcess(reconstructed);
  assertProcessShape(sealed);
  try { validateSgosRecord(sealed); } catch (error) {
    fail('SGOS control event reconstructs an invalid Process.', 'SGOS_CONTROL_LINEAGE_INVALID', {
      controlEventSha256: event.controlEventSha256,
      cause: error?.message ?? String(error)
    });
  }
  return sealed;
}

function sealControlEvent(before, after, {
  beforeProcessSha256 = before.processSha256,
  priorControlEventSha256 = before.controlEventSha256,
  controlDepth,
  operatorTransitionCount,
  action = controlEventAction(before, after)
} = {}) {
  return sealSgosImmutableRecord('sgos-control-event', {
    schemaVersion: currentSchemaVersion('sgos-control-event'),
    kind: 'sgos-control-event',
    processId: before.processId,
    processCoreSha256: immutableProcessCoreSha256(before),
    priorControlEventSha256,
    beforeProcessSha256,
    beforeProcessRevision: before.processRevision,
    controlDepth,
    operatorTransitionCount,
    recordIndexSha256: requireSha256('recordIndexSha256', after.recordIndexSha256),
    action,
    result: mutableProcessProjection(after),
    createdAt: after.updatedAt
  });
}

function assertSgosControlCapacity(controlDepth, operatorTransitionCount) {
  if (!Number.isSafeInteger(controlDepth) || controlDepth < 1
      || controlDepth > MAX_CONTROL_RECORDS) {
    fail('SGOS Process control lineage reached its installed transition ceiling.',
      'SGOS_CONTROL_LINEAGE_LIMIT', {
        controlDepth,
        maximum: MAX_CONTROL_RECORDS
      });
  }
  if (!Number.isSafeInteger(operatorTransitionCount) || operatorTransitionCount < 0
      || operatorTransitionCount > MAX_OPERATOR_CONTROL_TRANSITIONS) {
    fail('SGOS Process reached its installed operator pause/resume ceiling.',
      'SGOS_OPERATOR_CONTROL_LIMIT', {
        operatorTransitionCount,
        maximum: MAX_OPERATOR_CONTROL_TRANSITIONS
      });
  }
}

async function nextSgosControlPosition(root, before, after) {
  const action = controlEventAction(before, after);
  if (before.controlEventSha256 === null) {
    const initial = { controlDepth: 1, operatorTransitionCount: 0, action };
    assertSgosControlCapacity(initial.controlDepth, initial.operatorTransitionCount);
    return initial;
  }
  const { record: prior } = await readSgosImmutableRecord(
    root, before.processId, 'sgos-control-event', before.controlEventSha256
  );
  const operatorTransition = ['process-paused', 'process-resumed'].includes(action) ? 1 : 0;
  const next = {
    controlDepth: prior.controlDepth + 1,
    operatorTransitionCount: prior.operatorTransitionCount + operatorTransition,
    action
  };
  assertSgosControlCapacity(next.controlDepth, next.operatorTransitionCount);
  return next;
}

function assertProcessShape(state) {
  if (state?.kind !== 'gvm-process') fail('SGOS process state has the wrong kind.', 'SGOS_PROCESS_CORRUPT');
  requireProcessId(state.processId);
  requireSha256('programSha256', state.programSha256);
  requireSha256('policySnapshotSha256', state.policySnapshotSha256);
  requireSha256('processBindingSha256', state.processBindingSha256);
  requireSha256('taskContractSha256', state.taskContractSha256, { nullable: true });
  requireSha256('currentCheckpointSha256', state.currentCheckpointSha256, { nullable: true });
  requireSha256('controlEventSha256', state.controlEventSha256, { nullable: true });
  requireSha256('recordIndexSha256', state.recordIndexSha256, { nullable: true });
  if (!PROCESS_STATES.has(state.status)) fail(`Unknown SGOS process status '${state.status}'.`, 'SGOS_PROCESS_CORRUPT');
  if (!Number.isInteger(state.processRevision) || state.processRevision < 1) {
    fail('SGOS process revision must be a positive integer.', 'SGOS_PROCESS_CORRUPT');
  }
  if (!state.taskInstances || typeof state.taskInstances !== 'object' || Array.isArray(state.taskInstances)) {
    fail('SGOS process taskInstances must be an object.', 'SGOS_PROCESS_CORRUPT');
  }
  if (Object.keys(state.taskInstances).length > MAX_PROCESS_TASKS) {
    fail(`SGOS process exceeds the installed ${MAX_PROCESS_TASKS}-task ceiling.`,
      'SGOS_PROCESS_TASK_LIMIT', { maximum: MAX_PROCESS_TASKS });
  }
  for (const [taskId, task] of Object.entries(state.taskInstances)) {
    if (task?.taskInstanceId !== taskId || !TASK_STATES.has(task?.state)) {
      fail(`SGOS task instance '${taskId}' is malformed.`, 'SGOS_PROCESS_CORRUPT');
    }
    if (!Array.isArray(task.predecessorTaskInstanceIds) || !Array.isArray(task.attemptIds)) {
      fail(`SGOS task instance '${taskId}' has malformed lineage.`, 'SGOS_PROCESS_CORRUPT');
    }
    if (task.state === 'succeeded' && !SHA256.test(String(task.receiptSha256 ?? ''))) {
      fail(`SGOS task '${taskId}' cannot succeed without an exact receipt.`, 'SGOS_SUCCESS_WITHOUT_RECEIPT');
    }
    if (task.state !== 'succeeded' && task.receiptSha256 != null) {
      fail(`SGOS task '${taskId}' cannot retain a receipt outside succeeded state.`,
        'SGOS_RECEIPT_LINEAGE_INVALID');
    }
  }
  for (const field of ['activeExecutions', 'openHumanRequests', 'activeLeases']) {
    if (!Array.isArray(state[field])) fail(`SGOS process ${field} must be an array.`, 'SGOS_PROCESS_CORRUPT');
    if (new Set(state[field]).size !== state[field].length) {
      fail(`SGOS process ${field} must not contain duplicates.`, 'SGOS_PROCESS_CORRUPT');
    }
  }
  if (state.status === 'succeeded') {
    const incomplete = Object.values(state.taskInstances).filter((task) => !['succeeded', 'skipped'].includes(task.state));
    if (incomplete.length || state.activeExecutions.length || state.openHumanRequests.length) {
      fail('A succeeded SGOS process must have only receipted terminal tasks and no active work.', 'SGOS_SUCCESS_WITHOUT_RECEIPT');
    }
  }
  return state;
}

function assertImmutableCore(before, after) {
  const fields = [
    'processId', 'programSha256', 'policySnapshotSha256', 'processBindingSha256',
    'taskContractSha256', 'authorityBinding', 'createdAt'
  ];
  for (const field of fields) {
    if (JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null)) {
      fail(`SGOS process mutation attempted to replace immutable '${field}'.`, 'SGOS_PROCESS_BINDING_CHANGED', { field });
    }
  }
  const beforeIds = Object.keys(before.taskInstances).sort();
  const afterIds = Object.keys(after.taskInstances ?? {}).sort();
  if (JSON.stringify(beforeIds) !== JSON.stringify(afterIds)) {
    fail('The sequential SGOS runtime cannot add or remove compiled task instances.', 'SGOS_TASK_SET_CHANGED');
  }
  const attemptOwners = new Map();
  for (const id of beforeIds) {
    const stableFields = [
      'taskInstanceId', 'taskTemplateId', 'predecessorTaskInstanceIds', 'inputRefs'
    ];
    for (const field of stableFields) {
      if (JSON.stringify(before.taskInstances[id][field] ?? null) !== JSON.stringify(after.taskInstances[id]?.[field] ?? null)) {
        fail(`SGOS task '${id}' attempted to replace immutable '${field}'.`, 'SGOS_TASK_BINDING_CHANGED', { taskInstanceId: id, field });
      }
    }
    const priorAttempts = before.taskInstances[id].attemptIds;
    const nextAttempts = after.taskInstances[id]?.attemptIds;
    if (!Array.isArray(nextAttempts)
        || nextAttempts.length < priorAttempts.length
        || nextAttempts.length > priorAttempts.length + 1
        || canonicalJson(nextAttempts.slice(0, priorAttempts.length)) !== canonicalJson(priorAttempts)) {
      fail(`SGOS task '${id}' attempted to remove, reorder, or skip immutable attempt lineage.`,
        'SGOS_TASK_BINDING_CHANGED', { taskInstanceId: id, field: 'attemptIds' });
    }
    if (new Set(nextAttempts).size !== nextAttempts.length) {
      fail(`SGOS task '${id}' contains duplicate immutable attempt IDs.`,
        'SGOS_RECORD_LINEAGE_INVALID', { taskInstanceId: id });
    }
    for (const attemptId of nextAttempts) {
      const owner = attemptOwners.get(attemptId);
      if (owner != null && owner !== id) {
        fail(`SGOS attempt '${attemptId}' is owned by more than one task.`,
          'SGOS_RECORD_LINEAGE_INVALID', { attemptId, owners: [owner, id] });
      }
      attemptOwners.set(attemptId, id);
    }
    const beforeTask = before.taskInstances[id];
    const afterTask = after.taskInstances[id];
    if (canonicalJson(beforeTask.invalidatedBy ?? null)
        !== canonicalJson(afterTask.invalidatedBy ?? null)) {
      fail(`SGOS task '${id}' attempted to replace immutable 'invalidatedBy'.`,
        'SGOS_TASK_BINDING_CHANGED', { taskInstanceId: id, field: 'invalidatedBy' });
    }
    const successTransition = beforeTask.state !== 'succeeded' && afterTask.state === 'succeeded';
    for (const field of ['outputRefs', 'receiptSha256']) {
      const changed = canonicalJson(beforeTask[field] ?? null)
        !== canonicalJson(afterTask[field] ?? null);
      if (beforeTask.state === 'succeeded' && changed) {
        fail(`SGOS task '${id}' attempted to hide or replace durable '${field}'.`,
          'SGOS_RECORD_LINEAGE_INVALID', { taskInstanceId: id, field });
      }
      if (changed && !successTransition) {
        fail(`SGOS task '${id}' may introduce '${field}' only on its success transition.`,
          'SGOS_TASK_BINDING_CHANGED', { taskInstanceId: id, field });
      }
    }
    const prior = before.taskInstances[id].state;
    const next = after.taskInstances[id]?.state;
    const legal = {
      planned: new Set(['planned', 'waiting', 'ready']),
      waiting: new Set(['waiting', 'ready']),
      ready: new Set(['ready', 'waiting', 'running', 'verifying', 'blocked']),
      leased: new Set(['leased', 'running', 'recovery-required']),
      running: new Set(['running', 'waiting-human', 'succeeded', 'ready', 'failed', 'recovery-required']),
      'waiting-human': new Set(['waiting-human', 'succeeded', 'failed', 'cancelled']),
      'recovery-required': new Set(['recovery-required', 'ready', 'failed', 'succeeded']),
      blocked: new Set(['blocked']),
      succeeded: new Set(['succeeded']),
      failed: new Set(['failed']),
      cancelled: new Set(['cancelled']),
      invalidated: new Set(['invalidated']),
      skipped: new Set(['skipped']),
      verifying: new Set(['verifying', 'succeeded', 'failed', 'recovery-required'])
    }[prior];
    if (!legal?.has(next)) {
      fail(`SGOS task '${id}' attempted illegal transition '${prior}' -> '${next}'.`,
        'SGOS_TASK_TRANSITION_INVALID', { taskInstanceId: id, prior, next });
    }
    const beforeRevisionProjection = { ...clone(beforeTask), revision: null };
    const afterRevisionProjection = { ...clone(afterTask), revision: null };
    const taskChanged = canonicalJson(beforeRevisionProjection) !== canonicalJson(afterRevisionProjection);
    const expectedTaskRevision = beforeTask.revision + (taskChanged ? 1 : 0);
    if (afterTask.revision !== expectedTaskRevision) {
      fail(`SGOS task '${id}' revision does not exactly match its mutable transition.`,
        'SGOS_TASK_REVISION_INVALID', {
          taskInstanceId: id,
          expectedRevision: expectedTaskRevision,
          actualRevision: afterTask.revision
        });
    }
  }
}

async function withProcessLock(root, processId, callback, timeoutMs = 2_000, {
  createDirectory = true
} = {}) {
  const lockKey = `${realpathSync.native(gitCommonDir(root))}\0${processId}`;
  const inheritedLock = PROCESS_LOCK_CONTEXT.getStore();
  if (inheritedLock?.active === true && inheritedLock.key === lockKey) {
    // Immutable records may be published from a Human-response/recovery mutation callback. Those
    // writes must remain inside the already-held Process CAS lock, not deadlock trying to reacquire
    // it or move outside the serialization boundary.
    return callback();
  }
  await safeSgosDirectory(root, sgosProcessDirectory(root, processId), {
    create: createDirectory
  });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await withSubjectLock(root, { kind: 'sgos-process', id: processId }, async () => {
        if (!createDirectory) {
          await safeSgosDirectory(root, sgosProcessDirectory(root, processId));
        }
        const lockContext = { key: lockKey, active: true };
        return PROCESS_LOCK_CONTEXT.run(lockContext, async () => {
          try { return await callback(); } finally { lockContext.active = false; }
        });
      });
    } catch (error) {
      if (error?.code !== 'SUBJECT_LOCK_BUSY' || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function quarantinePathLabel(root, absolute) {
  const relative = path.relative(path.join(gitCommonDir(root), 'singularity-flow'), absolute);
  return `$git/${relative.split(path.sep).join('/')}`;
}

function quarantineSha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

const SGOS_PENDING_WRITER_FILE = /^(?<target>.+\.json)\.pending-(?<pid>[1-9][0-9]{0,9})-(?<staging>[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/;

function recognizedPendingWriterLeftover(processDirectoryName, entry) {
  if (entry.type !== 'file') return null;
  const match = SGOS_PENDING_WRITER_FILE.exec(entry.path);
  if (!match?.groups) return null;
  const family = familyForStoredPath(
    `$git/sgos/processes/${processDirectoryName}/${match.groups.target}`
  );
  if (!family) return null;
  return Object.freeze({
    path: entry.path,
    targetPath: match.groups.target,
    family: family.id,
    writerPid: Number(match.groups.pid),
    stagingId: match.groups.staging,
    bytes: entry.bytes,
    sha256: entry.sha256
  });
}

async function readQuarantineFile(root, target) {
  await safeSgosDirectory(root, path.dirname(target));
  let handle;
  try {
    handle = await open(target, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW ?? 0));
    const stats = await handle.stat();
    if (!stats.isFile()) {
      fail('SGOS Process quarantine input contains a special file.', 'SGOS_PROCESS_QUARANTINE_UNSAFE');
    }
    if (stats.size > MAX_QUARANTINE_FILE_BYTES) {
      fail(`SGOS Process quarantine input exceeds the ${MAX_QUARANTINE_FILE_BYTES}-byte per-file bound.`,
        'SGOS_PROCESS_QUARANTINE_BUDGET', { target: path.basename(target), bytes: stats.size });
    }
    const bytes = await handle.readFile();
    if (bytes.length !== stats.size) {
      fail('SGOS Process quarantine input changed while it was being inspected.',
        'SGOS_PROCESS_QUARANTINE_STALE');
    }
    return bytes;
  } catch (error) {
    if (['ELOOP', 'EMLINK'].includes(error?.code)) {
      fail('SGOS Process quarantine input contains a symbolic link.',
        'SGOS_PROCESS_QUARANTINE_UNSAFE');
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function quarantineTreeSnapshot(root, processId, source = sgosProcessDirectory(root, processId)) {
  try {
    await safeSgosDirectory(root, source);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      fail(`SGOS process '${processId}' is unavailable.`, 'SGOS_PROCESS_NOT_FOUND');
    }
    throw error;
  }
  const entries = [];
  let totalBytes = 0;
  let fileCount = 0;
  let directoryCount = 0;
  async function visit(directory, relative = '') {
    const children = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const child of children) {
      if (entries.length >= MAX_QUARANTINE_TREE_FILES) {
        fail(`SGOS Process quarantine input exceeds the ${MAX_QUARANTINE_TREE_FILES}-entry bound.`,
          'SGOS_PROCESS_QUARANTINE_BUDGET');
      }
      const absolute = path.join(directory, child.name);
      const nested = relative ? `${relative}/${child.name}` : child.name;
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) {
        fail(`SGOS Process quarantine input '${nested}' is a symbolic link.`,
          'SGOS_PROCESS_QUARANTINE_UNSAFE', { path: nested });
      }
      if (stats.isDirectory()) {
        directoryCount += 1;
        entries.push({ path: nested, type: 'directory' });
        await visit(absolute, nested);
        continue;
      }
      if (!stats.isFile()) {
        fail(`SGOS Process quarantine input '${nested}' is a special file.`,
          'SGOS_PROCESS_QUARANTINE_UNSAFE', { path: nested });
      }
      const bytes = await readQuarantineFile(root, absolute);
      totalBytes += bytes.length;
      if (totalBytes > MAX_QUARANTINE_TREE_BYTES) {
        fail(`SGOS Process quarantine input exceeds the ${MAX_QUARANTINE_TREE_BYTES}-byte tree bound.`,
          'SGOS_PROCESS_QUARANTINE_BUDGET');
      }
      fileCount += 1;
      entries.push({ path: nested, type: 'file', bytes: bytes.length, sha256: quarantineSha256(bytes) });
    }
  }
  await visit(source);
  const publicEntries = entries.map((entry) => Object.freeze({ ...entry }));
  const treeSha256 = `sha256:${recordSha256({
    kind: 'sgos-process-quarantine-tree', processId, entries: publicEntries
  })}`;
  return Object.freeze({
    source,
    entries: Object.freeze(publicEntries),
    treeSha256,
    fileCount,
    directoryCount,
    totalBytes
  });
}

function quarantinedRecordHash(record, hashField) {
  const core = clone(record);
  delete core[hashField];
  return `sha256:${recordSha256(core)}`;
}

function assertQuarantinedRecord(record, {
  familyId, hashField, processId, expectedSha256, relative, requireProcessId = true
}) {
  if (record?.kind !== familyId
      || (requireProcessId ? record?.processId !== processId
        : record?.processId != null && record.processId !== processId)
      || record?.[hashField] !== expectedSha256
      || quarantinedRecordHash(record, hashField) !== expectedSha256) {
    fail(`Quarantined SGOS ${familyId} '${relative}' failed its identity or content hash.`,
      'SGOS_PROCESS_QUARANTINE_CORRUPT', { path: relative, family: familyId });
  }
}

function validateCurrentQuarantineRecord(record, {
  familyId, processId, relative, rawRecord = record, storedVersion = null
}) {
  let candidate = record;
  if (familyId === 'gvm-process') {
    if (relative !== 'state.json' || rawRecord?.kind !== familyId
        || rawRecord?.processId !== processId
        || rawRecord?.processSha256 !== quarantinedRecordHash(rawRecord, 'processSha256')) {
      fail(`SGOS Process quarantine state '${relative}' failed its stored-byte identity or content hash.`,
        'SGOS_PROCESS_QUARANTINE_CORRUPT', { path: relative, family: familyId });
    }
    // Readable predecessor schemas are validated in their migrated current shape, but quarantine
    // preserves the exact predecessor bytes. Re-sealing here is in-memory only and mirrors the
    // ordinary reader's integrity check; it never rewrites the source tree.
    if (storedVersion !== currentSchemaVersion('gvm-process')) candidate = sealProcess(record);
  }
  let validated;
  try {
    validated = validateSgosRecord(candidate);
  } catch (error) {
    fail(`SGOS Process quarantine input '${relative}' failed its current contract: ${error.message}.`,
      'SGOS_PROCESS_QUARANTINE_CORRUPT', { path: relative, family: familyId });
  }
  if (familyId === 'gvm-process') {
    try { assertProcessShape(validated); } catch (error) {
      fail(`SGOS Process quarantine state '${relative}' failed its runtime shape: ${error.message}.`,
        'SGOS_PROCESS_QUARANTINE_CORRUPT', { path: relative, family: familyId });
    }
    if (validated.processId !== processId
        || validated.processSha256 !== quarantinedRecordHash(validated, 'processSha256')) {
      fail(`SGOS Process quarantine state '${relative}' failed its identity or content hash.`,
        'SGOS_PROCESS_QUARANTINE_CORRUPT', { path: relative, family: familyId });
    }
    return validated;
  }
  if (familyId === 'sgos-control-successor') {
    const expectedBeforeProcessSha256 = `sha256:${path.basename(relative, '.json')}`;
    if (validated.processId !== processId
        || validated.beforeProcessSha256 !== expectedBeforeProcessSha256
        || validated.successorSha256 !== quarantinedRecordHash(validated, 'successorSha256')) {
      fail(`SGOS Process quarantine control successor '${relative}' failed its identity or content hash.`,
        'SGOS_PROCESS_QUARANTINE_CORRUPT', { path: relative, family: familyId });
    }
    return validated;
  }
  const family = IMMUTABLE_FAMILIES[familyId];
  if (!family) {
    fail(`SGOS Process quarantine input '${relative}' has no immutable family registration.`,
      'SGOS_PROCESS_QUARANTINE_CORRUPT', { path: relative, family: familyId });
  }
  assertQuarantinedRecord(validated, {
    familyId,
    hashField: family.hashField,
    processId,
    expectedSha256: `sha256:${path.basename(relative, '.json')}`,
    relative,
    requireProcessId: !['candidate-snapshot', 'gvm-program'].includes(familyId)
  });
  return validated;
}

function terminalBeforeReceiptQuarantine(records, state) {
  const attempts = [...records.values()]
    .filter((entry) => entry.family === 'gvm-task-attempt' && entry.reservation !== true)
    .map((entry) => entry.record);
  const receipts = [...records.values()]
    .filter((entry) => entry.family === 'gvm-task-receipt' && entry.reservation !== true)
    .map((entry) => entry.record);
  const evidence = [...records.values()]
    .filter((entry) => entry.family === 'action-evidence' && entry.reservation !== true)
    .map((entry) => entry.record);
  const leases = [...records.values()]
    .filter((entry) => entry.family === 'sgos-execution-lease' && entry.reservation !== true)
    .map((entry) => entry.record);
  const candidates = [];
  for (const [taskInstanceId, task] of Object.entries(state.taskInstances)) {
    const latestAttemptId = task.attemptIds.at(-1) ?? null;
    if (latestAttemptId == null) continue;
    const terminal = attempts.filter((record) => record.attemptId === latestAttemptId
      && record.status !== 'running');
    const boundReceipts = receipts.filter((record) => record.attemptId === latestAttemptId);
    const boundEvidence = evidence.filter((record) => record.attemptId === latestAttemptId);
    if (terminal.length > 1 || boundReceipts.length > 1 || boundEvidence.length > 1
        || (terminal[0]?.status === 'failed' && boundReceipts.length > 0)) {
      fail(`SGOS process '${state.processId}' has ambiguous terminal lineage for attempt '${latestAttemptId}'.`,
        'SGOS_PROCESS_QUARANTINE_CORRUPT', {
          attemptId: latestAttemptId,
          terminal: terminal.length,
          receipts: boundReceipts.length,
          evidence: boundEvidence.length
        });
    }
    if (terminal.length === 1 && terminal[0].status === 'succeeded'
        && boundReceipts.length === 0) {
      candidates.push({
        taskInstanceId, task, attempt: terminal[0], evidence: boundEvidence,
        quarantineReason: 'terminal-attempt-before-receipt'
      });
    } else if (terminal.length === 1 && terminal[0].status === 'failed'
        && boundReceipts.length === 0 && boundEvidence.length === 0) {
      candidates.push({
        taskInstanceId, task, attempt: terminal[0], evidence: boundEvidence,
        quarantineReason: 'failed-terminal-before-evidence'
      });
    }
  }
  if (candidates.length === 0) {
    fail(`SGOS process '${state.processId}' is readable current state and has no exact quarantinable terminal crash. It must not be quarantined.`,
      'SGOS_PROCESS_QUARANTINE_NOT_REQUIRED');
  }
  if (candidates.length !== 1) {
    fail(`SGOS process '${state.processId}' has ${candidates.length} terminal attempts without receipts; only one exact interrupted task can be quarantined.`,
      'SGOS_PROCESS_QUARANTINE_CORRUPT', { candidates: candidates.length });
  }
  const candidate = candidates[0];
  const { task, taskInstanceId, attempt } = candidate;
  const attemptId = attempt.attemptId;
  const activeStates = new Set([
    'leased', 'running', 'waiting-human', 'verifying', 'recovery-required'
  ]);
  const otherInterrupted = Object.values(state.taskInstances).filter((entry) =>
    entry.taskInstanceId !== taskInstanceId && activeStates.has(entry.state));
  const activeMatches = state.activeExecutions.length === 1
    && state.activeExecutions[0] === attemptId
    && ['running', 'recovery-required'].includes(task.state);
  const inactiveInterrupted = state.activeExecutions.length === 0
    && ['waiting-human', 'recovery-required'].includes(task.state);
  if (!['running', 'waiting-human', 'recovery-required'].includes(task.state)
      || (!activeMatches && !inactiveInterrupted)
      || otherInterrupted.length > 0
      || !['running', 'waiting-human', 'recovery-required'].includes(state.status)) {
    fail(`SGOS process '${state.processId}' does not contain one exact latest interrupted task for terminal attempt '${attemptId}'.`,
      'SGOS_PROCESS_QUARANTINE_CORRUPT', {
        taskInstanceId, taskState: task.state, processStatus: state.status,
        activeExecutions: state.activeExecutions
      });
  }
  if (state.activeLeases.length > 1 || leases.length > 1) {
    fail(`SGOS process '${state.processId}' has ambiguous execution leases and cannot be quarantined.`,
      'SGOS_PROCESS_QUARANTINE_CORRUPT', {
        activeLeases: state.activeLeases.length, storedLeases: leases.length
      });
  }
  for (const lease of leases) {
    if (lease.attemptId !== attemptId || lease.taskInstanceId !== taskInstanceId
        || lease.executionHandleSha256 !== attempt.executionHandleSha256
        || !state.activeLeases.includes(lease.leaseId)) {
      fail(`SGOS process '${state.processId}' has an execution lease outside the interrupted attempt.`,
        'SGOS_PROCESS_QUARANTINE_CORRUPT', {
          leaseId: lease.leaseId, leaseAttemptId: lease.attemptId, attemptId
        });
    }
  }
  return Object.freeze({
    taskInstanceId,
    attemptId,
    attemptSha256: attempt.attemptSha256,
    taskState: task.state,
    quarantineReason: candidate.quarantineReason,
    terminalAttemptStatus: attempt.status,
    receiptPresent: false,
    evidencePresent: candidate.evidence.length > 0,
    liveLeasePresent: false
  });
}

async function classifyTransitionIntentQuarantine(root, processId, transition, records, state) {
  let intent = null;
  let failure = null;
  try {
    const rawText = transition.bytes.toString('utf8');
    const parsed = JSON.parse(rawText);
    const loaded = readRecord('sgos-transition-intent', parsed);
    if (loaded.storedVersion !== currentSchemaVersion('sgos-transition-intent')
        || canonicalJson(loaded.record) !== rawText) {
      throw Object.assign(new Error('transition intent is not current canonical JSON'), {
        code: 'SGOS_TRANSITION_INTENT_CORRUPT'
      });
    }
    intent = validateSgosTransitionIntent(loaded.record);
    if (intent.processId !== processId) {
      throw Object.assign(new Error('transition intent belongs to another Process'), {
        code: 'SGOS_TRANSITION_INTENT_CORRUPT'
      });
    }
  } catch (error) {
    failure = error;
  }
  if (intent != null) {
    const alreadyCommitted = state.processSha256 === intent.candidateProcessSha256
      && state.controlEventSha256 === intent.controlEvent.controlEventSha256
      && state.recordIndexSha256 === intent.nextRecordIndexSha256;
    if (alreadyCommitted) {
      fail(`SGOS Process '${processId}' has a valid committed transition intent; recover its exact cleanup before quarantine.`,
        'SGOS_TRANSITION_RECOVERY_REQUIRED', {
          intentSha256: intent.intentSha256, state: 'candidate-committed'
        });
    }
    const exactPredecessor = state.processSha256 === intent.beforeProcessSha256
      && state.processRevision === intent.beforeProcessRevision
      && state.recordIndexSha256 === intent.priorRecordIndexSha256;
    const missingReservations = [];
    if (exactPredecessor) {
      for (const token of intent.reservations) {
        const relative = `${RECORD_RESERVATION_DIRECTORY}/${token.family}--${token.recordSha256.slice('sha256:'.length)}.json`;
        const reservation = records.get(relative);
        if (reservation?.reservation !== true || reservation.corrupt === true
            || reservation.record?.[IMMUTABLE_FAMILIES[token.family]?.hashField]
              !== token.recordSha256
            || reservation.bytes !== token.bytes) {
          missingReservations.push(Object.freeze({
            family: token.family, recordSha256: token.recordSha256
          }));
        }
      }
      if (missingReservations.length === 0) {
        fail(`SGOS Process '${processId}' has a valid replayable transition intent; recover it before quarantine.`,
          'SGOS_TRANSITION_RECOVERY_REQUIRED', {
            intentSha256: intent.intentSha256, state: 'exact-predecessor'
          });
      }
      // State replacement may be the only missing publication step. A complete exact successor,
      // event, and index already authorize deterministic replay even when reservations were
      // consumed; quarantine must not misclassify that recoverable rollback boundary.
      try {
        const successor = await readSgosControlSuccessor(
          root, processId, intent.beforeProcessSha256
        );
        const { record: event } = await readSgosImmutableRecord(
          root, processId, 'sgos-control-event', intent.controlEvent.controlEventSha256
        );
        await readSgosRecordIndexHead(root, processId, intent.nextRecordIndexSha256);
        const candidate = processFromControlEvent(state, event);
        if (successor?.successorSha256 === intent.successorSha256
            && successor.controlEventSha256 === event.controlEventSha256
            && canonicalJson(event) === canonicalJson(intent.controlEvent)
            && candidate.processSha256 === intent.candidateProcessSha256) {
          fail(`SGOS Process '${processId}' has a complete replayable transition successor; recover it before quarantine.`,
            'SGOS_TRANSITION_RECOVERY_REQUIRED', {
              intentSha256: intent.intentSha256, state: 'successor-committed'
            });
        }
      } catch (error) {
        if (error?.code === 'SGOS_TRANSITION_RECOVERY_REQUIRED') throw error;
        // Missing or corrupt infrastructure remains part of the fail-closed unreplayable
        // classification below; every byte is preserved by the exact-tree quarantine.
      }
      failure = Object.assign(new Error('transition intent is missing exact durable reservations'), {
        code: 'SGOS_RECORD_RESERVATION_INVALID', details: { missingReservations }
      });
    } else {
      failure = Object.assign(new Error('transition intent matches neither current state nor predecessor'), {
        code: 'SGOS_TRANSITION_INTENT_STALE'
      });
    }
  }
  for (const entry of records.values()) {
    if (entry.family === 'sgos-execution-lease' && entry.record != null
        && isSgosExecutionOwnerLive(entry.record)) {
      fail(`SGOS process '${processId}' still has a live execution owner and cannot be quarantined.`,
        'SGOS_PROCESS_QUARANTINE_LIVE', {
          leaseId: entry.record.leaseId, ownerPid: entry.record.ownerPid
        });
    }
  }
  return Object.freeze({
    intentSha256: intent?.intentSha256 ?? null,
    failureCode: failure?.code ?? 'SGOS_TRANSITION_INTENT_CORRUPT',
    failure: failure?.message ?? 'transition intent is unreadable',
    missingReservations: Object.freeze(failure?.details?.missingReservations ?? [])
  });
}

function quarantineTaskInstancesForProgram(program, processId) {
  const dependencies = new Map(program.taskTemplates.map((task) => [
    task.taskTemplateId, new Set(task.dependsOn ?? [])
  ]));
  for (const edge of program.edges ?? []) {
    const from = Array.isArray(edge) ? edge[0]
      : (edge?.from ?? edge?.source ?? edge?.predecessor);
    const to = Array.isArray(edge) ? edge[1]
      : (edge?.to ?? edge?.target ?? edge?.successor);
    if (from && to && dependencies.has(to)) dependencies.get(to).add(from);
  }
  const taskIds = new Map(program.taskTemplates.map((task) => [
    task.taskTemplateId,
    `TSK-${recordSha256({ processId, taskTemplateId: task.taskTemplateId })
      .slice(0, 24).toUpperCase()}`
  ]));
  const templateRefs = (values = []) => [...new Set((Array.isArray(values) ? values : [])
    .map((value) => typeof value === 'string' ? value
      : typeof value?.ref === 'string' ? value.ref
        : `sha256:${recordSha256(value)}`))].sort(compareSgosCodePoints);
  return Object.fromEntries([...program.taskTemplates]
    .sort((left, right) => compareSgosCodePoints(left.taskTemplateId, right.taskTemplateId))
    .map((template) => {
      const taskInstanceId = taskIds.get(template.taskTemplateId);
      const predecessors = [...(dependencies.get(template.taskTemplateId) ?? [])]
        .map((id) => taskIds.get(id))
        .filter(Boolean)
        .sort(compareSgosCodePoints);
      return [taskInstanceId, {
        taskInstanceId,
        taskTemplateId: template.taskTemplateId,
        state: predecessors.length ? 'waiting' : 'ready',
        predecessorTaskInstanceIds: predecessors,
        inputRefs: templateRefs(template.inputs ?? template.inputRefs ?? []),
        outputRefs: [],
        attemptIds: [],
        receiptSha256: null,
        invalidatedBy: null,
        revision: 1
      }];
    }));
}

function interruptedCreationSeedQuarantine(records, state, stateEntry) {
  const looksLikeSeed = stateEntry.storedVersion === currentSchemaVersion('gvm-process')
    && state.processRevision === 1
    && state.controlEventSha256 === null;
  if (!looksLikeSeed) return null;
  const taskInstances = Object.values(state.taskInstances ?? {});
  const hasSeedStateShape = state.status === 'running'
    && state.createdAt === state.updatedAt
    && state.activeExecutions.length === 0
    && state.activeLeases.length === 0
    && state.openHumanRequests.length === 0
    && state.currentCheckpointSha256 === null
    && taskInstances.every((task) => ['ready', 'waiting'].includes(task.state)
      && task.attemptIds.length === 0
      && task.receiptSha256 === null
      && task.outputRefs.length === 0
      && task.invalidatedBy === null);
  // Revision one with a null control head is also the pre-control-lineage shape used by an
  // interrupted execution. Only the exact unstarted materialization is a creation seed; a task
  // that has progressed must continue through the terminal-attempt classifier below.
  if (!hasSeedStateShape) return null;
  const forbiddenFamilies = new Set([
    'candidate-snapshot', 'sgos-control-event', 'sgos-control-successor',
    'gvm-task-attempt', 'gvm-task-receipt', 'gvm-checkpoint', 'human-request',
    'human-response', 'action-evidence', 'sgos-execution-lease'
  ]);
  const forbidden = [...records.entries()]
    .filter(([, entry]) => forbiddenFamilies.has(entry.family))
    .map(([relative, entry]) => ({ path: relative, family: entry.family }));
  if (forbidden.length !== 0) {
    fail(`SGOS process '${state.processId}' is not an exact interrupted creation seed.`,
      'SGOS_PROCESS_QUARANTINE_CORRUPT', {
        processRevision: state.processRevision,
        controlEventSha256: state.controlEventSha256,
        forbidden
      });
  }
  const programPath = `programs/${state.programSha256.slice('sha256:'.length)}.json`;
  const bindingPath = `bindings/${state.processBindingSha256.slice('sha256:'.length)}.json`;
  const programEntry = records.get(programPath);
  const bindingEntry = records.get(bindingPath);
  if (programEntry?.family !== 'gvm-program' || bindingEntry?.family !== 'process-binding'
      || programEntry.quarantinedV1 || bindingEntry.quarantinedV1) {
    fail(`SGOS process '${state.processId}' creation seed is missing its readable Program or Process Binding.`,
      'SGOS_PROCESS_QUARANTINE_CORRUPT', { programPath, bindingPath });
  }
  const program = programEntry.record;
  const binding = bindingEntry.record;
  const expectedTasks = quarantineTaskInstancesForProgram(program, state.processId);
  const authority = state.authorityBinding;
  if (program.programSha256 !== state.programSha256
      || program.policySnapshotSha256 !== state.policySnapshotSha256
      || binding.bindingSha256 !== state.processBindingSha256
      || binding.processId !== state.processId
      || binding.expectedProcessRevision !== 0
      || authority.subjectId !== binding.subjectId
      || canonicalJson(authority.subjectAuthority ?? null)
        !== canonicalJson(binding.subjectAuthority ?? null)
      || authority.branch !== binding.branch
      || authority.baselineRevision !== binding.baselineRevision
      || canonicalJson(authority.configurationAuthority ?? null)
        !== canonicalJson(binding.configurationAuthority ?? null)
      || authority.executionAdmission?.programSha256 !== program.programSha256
      || canonicalJson(state.taskInstances) !== canonicalJson(expectedTasks)) {
    fail(`SGOS process '${state.processId}' creation seed is not the deterministic materialization of its Program and Process Binding.`,
      'SGOS_PROCESS_QUARANTINE_CORRUPT', {
        programSha256: state.programSha256,
        processBindingSha256: state.processBindingSha256
      });
  }
  return Object.freeze({
    processRevision: state.processRevision,
    controlEventSha256: null,
    programSha256: state.programSha256,
    processBindingSha256: state.processBindingSha256,
    taskCount: Object.keys(expectedTasks).length,
    attemptsPresent: false,
    evidencePresent: false,
    receiptsPresent: false,
    activeReferencesPresent: false,
    checkpointPresent: false
  });
}

async function classifyQuarantineSnapshot(root, processId, snapshot) {
  const records = new Map();
  const pendingWriterLeftovers = [];
  const processDirectoryName = path.basename(snapshot.source);
  const hasTransitionIntent = snapshot.entries.some((entry) =>
    entry.type === 'file' && entry.path === TRANSITION_INTENT_FILE);
  let transitionIntentSnapshot = null;
  for (const entry of snapshot.entries) {
    if (entry.type !== 'file') continue;
    const leftover = recognizedPendingWriterLeftover(processDirectoryName, entry);
    if (leftover) {
      pendingWriterLeftovers.push(leftover);
      if (pendingWriterLeftovers.length > MAX_QUARANTINE_PENDING_FILES) {
        fail(`SGOS Process quarantine input exceeds the ${MAX_QUARANTINE_PENDING_FILES}-file pending-writer bound.`,
          'SGOS_PROCESS_QUARANTINE_BUDGET', {
            maximumPendingWriterFiles: MAX_QUARANTINE_PENDING_FILES
          });
      }
      // A staging file is incomplete by definition. Its exact bytes remain in the tree digest and
      // atomic move, but are never parsed, restored, or treated as an authoritative record.
      continue;
    }
    const family = familyForStoredPath(`$git/sgos/processes/${processDirectoryName}/${entry.path}`);
    if (!family) {
      fail(`SGOS Process quarantine input '${entry.path}' is not a registered Process record.`,
        'SGOS_PROCESS_QUARANTINE_CORRUPT', { path: entry.path });
    }
    const absolute = path.join(snapshot.source, ...entry.path.split('/'));
    const bytes = await readQuarantineFile(root, absolute);
    if (quarantineSha256(bytes) !== entry.sha256) {
      fail('SGOS Process quarantine input changed after its tree digest was calculated.',
        'SGOS_PROCESS_QUARANTINE_STALE', { path: entry.path });
    }
    if (family.id === 'sgos-transition-intent') {
      transitionIntentSnapshot = Object.freeze({ entry, bytes });
      continue;
    }
    let raw;
    try {
      raw = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      fail(`SGOS Process quarantine input '${entry.path}' is not valid JSON: ${error.message}.`,
        'SGOS_PROCESS_QUARANTINE_CORRUPT', { path: entry.path });
    }
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      fail(`SGOS Process quarantine input '${entry.path}' is not a JSON object.`,
        'SGOS_PROCESS_QUARANTINE_CORRUPT', { path: entry.path });
    }
    const reservationMatch = entry.path.match(
      /^record-reservations\/([a-z0-9-]+)--([a-f0-9]{64})\.json$/
    );
    if (reservationMatch) {
      try {
        const loaded = readRecord(family.id, raw);
        const validated = validateSgosRecord(loaded.record);
        const familyDefinition = IMMUTABLE_FAMILIES[family.id];
        const expectedSha256 = `sha256:${reservationMatch[2]}`;
        if (reservationMatch[1] !== family.id || familyDefinition == null
            || canonicalJson(loaded.record) !== bytes.toString('utf8')
            || validated[familyDefinition.hashField] !== expectedSha256
            || (validated.processId != null && validated.processId !== processId)) {
          throw Object.assign(new Error('reservation identity or exact bytes do not match'), {
            code: 'SGOS_RECORD_RESERVATION_CORRUPT'
          });
        }
        records.set(entry.path, Object.freeze({
          family: family.id, record: validated, reservation: true,
          corrupt: false, bytes: bytes.length, storedVersion: loaded.storedVersion
        }));
      } catch (error) {
        if (!hasTransitionIntent) {
          fail(`SGOS Process quarantine reservation '${entry.path}' cannot be read safely: ${error.message}.`,
            'SGOS_PROCESS_QUARANTINE_CORRUPT', { path: entry.path, family: family.id });
        }
        records.set(entry.path, Object.freeze({
          family: family.id, record: null, reservation: true,
          corrupt: true, bytes: bytes.length, storedVersion: null
        }));
      }
      continue;
    }
    let loaded = null;
    let readable = null;
    let quarantinedV1 = false;
    try {
      loaded = readRecord(family.id, raw);
      readable = loaded.record;
    } catch (error) {
      if (error?.code === 'SCHEMA_VERSION_FUTURE') {
        fail(`SGOS Process quarantine input '${entry.path}' was written by a newer sflow. Upgrade instead of quarantining it.`,
          'SGOS_PROCESS_QUARANTINE_FUTURE_SCHEMA', {
            path: entry.path, family: family.id, storedVersion: error.details?.storedVersion ?? null
          });
      }
      quarantinedV1 = error?.code === 'SCHEMA_VERSION_ARCHIVED'
        && [
          'process-binding', 'gvm-process', 'human-request',
          'gvm-task-receipt', 'sgos-execution-lease'
        ].includes(family.id)
        && error.details?.storedVersion === 1;
      if (!quarantinedV1) {
        const code = error?.code === 'SCHEMA_VERSION_ARCHIVED'
          ? 'SGOS_PROCESS_QUARANTINE_SCHEMA_UNSUPPORTED'
          : 'SGOS_PROCESS_QUARANTINE_CORRUPT';
        fail(`SGOS Process quarantine input '${entry.path}' cannot be read safely: ${error.message}.`,
          code, { path: entry.path, family: family.id });
      }
    }
    if (quarantinedV1) {
      if (family.id === 'gvm-process') {
        if (entry.path !== 'state.json' || raw.kind !== 'gvm-process'
            || raw.processId !== processId || !SHA256.test(String(raw.processSha256 ?? ''))
            || raw.processSha256 !== quarantinedRecordHash(raw, 'processSha256')) {
          fail(`Quarantined SGOS gvm-process '${entry.path}' failed its identity or content hash.`,
            'SGOS_PROCESS_QUARANTINE_CORRUPT', { path: entry.path, family: family.id });
        }
      } else if (family.id === 'sgos-execution-lease') {
        const expectedKeys = [
          'schemaVersion', 'kind', 'leaseId', 'processId', 'attemptId', 'taskInstanceId',
          'ownerId', 'ownerPid', 'ownerStartFingerprint', 'beforeProcessSha256',
          'beforeProcessRevision', 'executionHandleSha256', 'acquiredAt', 'heartbeatAt'
        ].sort();
        if (canonicalJson(Object.keys(raw).sort()) !== canonicalJson(expectedKeys)
            || raw.kind !== 'sgos-execution-lease' || raw.processId !== processId
            || path.basename(entry.path, '.json') !== encodeURIComponent(raw.leaseId)) {
          fail(`Quarantined SGOS execution lease '${entry.path}' failed its v1 identity.`,
            'SGOS_PROCESS_QUARANTINE_CORRUPT', { path: entry.path, family: family.id });
        }
        validateExecutionLease({
          ...raw,
          schemaVersion: currentSchemaVersion('sgos-execution-lease'),
          // Quarantine never adopts this value; it only reuses the strict current validator for
          // all other v1 fields while preserving the original bytes unchanged.
          attemptSha256: raw.executionHandleSha256
        }, { processId, leaseId: raw.leaseId });
      } else {
        const hashField = family.id === 'process-binding' ? 'bindingSha256'
          : family.id === 'gvm-task-receipt' ? 'receiptSha256' : 'requestSha256';
        const expectedSha256 = `sha256:${path.basename(entry.path, '.json')}`;
        assertQuarantinedRecord(raw, {
          familyId: family.id, hashField, processId, expectedSha256, relative: entry.path
        });
      }
    } else if (family.id === 'gvm-process') {
      raw = validateCurrentQuarantineRecord(readable, {
        familyId: family.id, processId, relative: entry.path,
        rawRecord: raw, storedVersion: loaded.storedVersion
      });
    } else if (family.id === 'sgos-execution-lease') {
      const leaseId = decodeURIComponent(path.basename(entry.path, '.json'));
      raw = validateExecutionLease(readable, { processId, leaseId });
      if (isSgosExecutionOwnerLive(raw)) {
        fail(`SGOS process '${processId}' still has a live execution lease owned by PID ${raw.ownerPid}.`,
          'SGOS_PROCESS_QUARANTINE_LIVE', { leaseId, ownerPid: raw.ownerPid });
      }
    } else {
      raw = validateCurrentQuarantineRecord(readable, {
        familyId: family.id, processId, relative: entry.path,
        rawRecord: raw, storedVersion: loaded.storedVersion
      });
    }
    records.set(entry.path, Object.freeze({
      family: family.id,
      record: raw,
      quarantinedV1,
      storedVersion: loaded?.storedVersion ?? (quarantinedV1 ? 1 : null)
    }));
  }
  const stateEntry = records.get('state.json');
  if (stateEntry?.family !== 'gvm-process') {
    fail('SGOS Process quarantine input has no valid state.json.',
      'SGOS_PROCESS_QUARANTINE_CORRUPT');
  }
  const state = stateEntry.record;
  if (!SHA256.test(String(state.processBindingSha256 ?? ''))
      || !Array.isArray(state.openHumanRequests) || !Array.isArray(state.activeLeases)) {
    fail('SGOS Process quarantine state has malformed immutable references.',
      'SGOS_PROCESS_QUARANTINE_CORRUPT');
  }
  const references = [{
    family: 'process-binding',
    sha256: state.processBindingSha256,
    path: `bindings/${state.processBindingSha256.slice('sha256:'.length)}.json`
  }, ...(state.openHumanRequests ?? []).map((sha256) => ({
    family: 'human-request', sha256,
    path: `human-requests/${String(sha256).slice('sha256:'.length)}.json`
  })), ...(state.currentCheckpointSha256 ? [{
    family: 'gvm-checkpoint', sha256: state.currentCheckpointSha256,
    path: `checkpoints/${state.currentCheckpointSha256.slice('sha256:'.length)}.json`
  }] : [])];
  const quarantinedReferences = stateEntry.quarantinedV1 ? [Object.freeze({
    family: 'gvm-process', path: 'state.json', storedVersion: 1
  })] : [];
  for (const reference of references) {
    if (!SHA256.test(String(reference.sha256 ?? ''))) {
      fail('SGOS Process quarantine state contains a malformed immutable reference.',
        'SGOS_PROCESS_QUARANTINE_CORRUPT', { family: reference.family });
    }
    const resolved = records.get(reference.path);
    if (!resolved || resolved.family !== reference.family) {
      fail(`SGOS Process quarantine state references missing ${reference.family} bytes.`,
        'SGOS_PROCESS_QUARANTINE_CORRUPT', { path: reference.path });
    }
    if (!resolved.quarantinedV1 && reference.family === 'human-request'
        && resolved.record.status !== 'open') {
      fail(`SGOS Process quarantine state references closed Human Request '${reference.path}'.`,
        'SGOS_PROCESS_QUARANTINE_CORRUPT', { path: reference.path });
    }
    if (resolved.quarantinedV1) quarantinedReferences.push(Object.freeze({
      family: reference.family, path: reference.path, storedVersion: 1
    }));
  }
  if (transitionIntentSnapshot != null) {
    const transitionIntent = await classifyTransitionIntentQuarantine(
      root, processId, transitionIntentSnapshot, records, state
    );
    return Object.freeze({
      state,
      reason: 'unreplayable-transition-intent',
      transitionIntent,
      quarantinedReferences: Object.freeze(quarantinedReferences),
      pendingWriterLeftovers: Object.freeze(pendingWriterLeftovers),
      creationSeed: null,
      interruptedTask: null
    });
  }
  if (quarantinedReferences.length) {
    return Object.freeze({
      state,
      reason: 'legacy-v1-authority-unreadable',
      quarantinedReferences: Object.freeze(quarantinedReferences),
      pendingWriterLeftovers: Object.freeze(pendingWriterLeftovers),
      transitionIntent: null,
      creationSeed: null,
      interruptedTask: null
    });
  }
  const creationSeed = interruptedCreationSeedQuarantine(records, state, stateEntry);
  if (creationSeed) {
    return Object.freeze({
      state,
      reason: 'interrupted-creation-seed',
      quarantinedReferences: Object.freeze([]),
      pendingWriterLeftovers: Object.freeze(pendingWriterLeftovers),
      transitionIntent: null,
      creationSeed,
      interruptedTask: null
    });
  }
  const interruptedTask = terminalBeforeReceiptQuarantine(records, state);
  try {
    await assertReferencedRecords(root, state, { snapshotRecords: records });
  } catch (error) {
    // A crash may remove its dead lease before state can drop the active attempt. The exact
    // terminal/no-receipt candidate above proves the only shape for which that one invariant may
    // be incomplete; every other lineage failure remains corruption.
    if (error?.code !== 'SGOS_ACTIVE_EXECUTION_INVALID') {
      fail(`SGOS Process quarantine input failed current lineage validation: ${error.message}.`,
        'SGOS_PROCESS_QUARANTINE_CORRUPT', { causeCode: error?.code ?? null });
    }
  }
  return Object.freeze({
    state,
    reason: interruptedTask.quarantineReason,
    quarantinedReferences: Object.freeze([]),
    pendingWriterLeftovers: Object.freeze(pendingWriterLeftovers),
    transitionIntent: null,
    creationSeed: null,
    interruptedTask
  });
}

async function buildSgosProcessQuarantinePlan(root, processId, {
  snapshot: suppliedSnapshot = null,
  sourceLabel = null
} = {}) {
  const id = requireProcessId(processId);
  const snapshot = suppliedSnapshot ?? await quarantineTreeSnapshot(root, id);
  const classification = await classifyQuarantineSnapshot(root, id, snapshot);
  const rechecked = await quarantineTreeSnapshot(root, id, snapshot.source);
  if (rechecked.treeSha256 !== snapshot.treeSha256) {
    fail('SGOS Process quarantine input changed while its current records were validated.',
      'SGOS_PROCESS_QUARANTINE_STALE', {
        expected: snapshot.treeSha256, received: rechecked.treeSha256
      });
  }
  const quarantineDirectory = sgosProcessQuarantineDirectory(root, id, snapshot.treeSha256);
  return Object.freeze({
    schemaVersion: 1,
    kind: 'sgos-process-quarantine-plan',
    processId: id,
    status: 'quarantine-ready',
    reason: classification.reason,
    source: quarantinePathLabel(root, sourceLabel ?? snapshot.source),
    quarantine: quarantinePathLabel(root, quarantineDirectory),
    treeSha256: snapshot.treeSha256,
    confirmationSha256: snapshot.treeSha256,
    fileCount: snapshot.fileCount,
    directoryCount: snapshot.directoryCount,
    totalBytes: snapshot.totalBytes,
    quarantinedReferences: classification.quarantinedReferences,
    pendingWriterLeftovers: classification.pendingWriterLeftovers,
    transitionIntent: classification.transitionIntent ?? null,
    creationSeed: classification.creationSeed,
    interruptedTask: classification.interruptedTask,
    limits: Object.freeze({
      maximumFiles: MAX_QUARANTINE_TREE_FILES,
      maximumFileBytes: MAX_QUARANTINE_FILE_BYTES,
      maximumTreeBytes: MAX_QUARANTINE_TREE_BYTES,
      maximumPendingWriterFiles: MAX_QUARANTINE_PENDING_FILES
    }),
    retryable: false,
    resumable: false,
    restorable: false,
    successClaimed: false
  });
}

/** Read-only plan for byte-preserving, non-runnable SGOS Process quarantine. */
export async function planSgosProcessQuarantine(root, processId) {
  return buildSgosProcessQuarantinePlan(root, processId);
}

async function completedSgosProcessQuarantine(root, processId, confirmationSha256) {
  const source = sgosProcessDirectory(root, processId);
  try {
    await safeSgosDirectory(root, source);
    return null;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const target = sgosProcessQuarantineDirectory(root, processId, confirmationSha256);
  let snapshot;
  try {
    snapshot = await quarantineTreeSnapshot(root, processId, target);
  } catch (error) {
    if (error?.code === 'SGOS_PROCESS_NOT_FOUND' || error?.code === 'ENOENT') return null;
    throw error;
  }
  if (snapshot.treeSha256 !== confirmationSha256) {
    fail('SGOS Process quarantine target does not match the confirmed exact tree.',
      'SGOS_PROCESS_QUARANTINE_STALE', {
        expected: confirmationSha256,
        received: snapshot.treeSha256
      });
  }
  const plan = await buildSgosProcessQuarantinePlan(root, processId, {
    snapshot,
    sourceLabel: source
  });
  return Object.freeze({ ...plan, status: 'quarantined', quarantined: true });
}

/**
 * Atomically move a narrowly classified machine-local Process into managed quarantine. No record
 * is deleted, rewritten, migrated, restored, resumed, or treated as a successful execution.
 */
export async function quarantineSgosProcess(root, processId, { confirmationSha256 } = {}) {
  const id = requireProcessId(processId);
  requireSha256('confirmationSha256', confirmationSha256);
  const alreadyCompleted = await completedSgosProcessQuarantine(root, id, confirmationSha256);
  if (alreadyCompleted !== null) return alreadyCompleted;
  try {
    return await withProcessLock(root, id, async () => {
    const plan = await buildSgosProcessQuarantinePlan(root, id);
    if (plan.confirmationSha256 !== confirmationSha256) {
      fail(`SGOS Process quarantine confirmation must equal ${plan.confirmationSha256}.`,
        'SGOS_PROCESS_QUARANTINE_STALE', {
          expected: plan.confirmationSha256, received: confirmationSha256
        });
    }
    const source = sgosProcessDirectory(root, id);
    const quarantineDirectory = sgosProcessQuarantineDirectory(root, id, plan.treeSha256);
    const quarantineRoot = sgosProcessQuarantineRoot(root);
    await safeSgosDirectory(root, quarantineRoot, { create: true });
    try {
      await lstat(quarantineDirectory);
      fail(`SGOS Process quarantine target '${plan.quarantine}' already exists.`,
        'SGOS_PROCESS_QUARANTINE_EXISTS');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await rename(source, quarantineDirectory);
    injectSgosStoreFault('quarantine-rename');
    await syncDirectory(path.dirname(source));
    injectSgosStoreFault('quarantine-source-parent-sync');
    await syncDirectory(quarantineRoot);
    await safeSgosDirectory(root, quarantineDirectory);
    return Object.freeze({ ...plan, status: 'quarantined', quarantined: true });
    }, 2_000, { createDirectory: false });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'SGOS_PROCESS_NOT_FOUND'
        || error?.code === 'EIO' || error?.code === 'SGOS_TEST_FAULT') {
      const completed = await completedSgosProcessQuarantine(root, id, confirmationSha256);
      if (completed !== null && !['EIO', 'SGOS_TEST_FAULT'].includes(error?.code)) {
        return completed;
      }
    }
    throw error;
  }
}

/** Compatibility aliases for the initial preview spelling. Results remain quarantine-labelled. */
export async function planSgosProcessArchive(root, processId) {
  return planSgosProcessQuarantine(root, processId);
}

export async function archiveSgosProcess(root, processId, options = {}) {
  return quarantineSgosProcess(root, processId, options);
}

/**
 * Construct the exact local/Git binding without granting the sidecar any Story authority.
 */
export function buildSgosProcessBinding(root, {
  processId,
  subjectId,
  subjectAuthority = null,
  configurationAuthority = null,
  repositoryIdentity = null,
  canonicalWorktreeRoot = null,
  branchName = null,
  baselineRevision = null,
  expectedProcessRevision = 0
} = {}) {
  const id = requireProcessId(processId);
  const subject = requireId('subjectId', subjectId);
  // Resolve filesystem aliases (for example macOS /var -> /private/var) before hashing. A Process
  // must remain loadable when a later CLI invocation reaches the same checkout through its real
  // path instead of the spelling used by the starting shell.
  const common = sgosContractPathFromLocal(realpathSync.native(gitCommonDir(root)));
  const worktreeGit = sgosContractPathFromLocal(realpathSync.native(gitDir(root)));
  const worktreeRoot = sgosContractPathFromLocal(
    realpathSync.native(canonicalWorktreeRoot == null ? repoRoot(root) : path.resolve(canonicalWorktreeRoot))
  );
  const core = {
    schemaVersion: currentSchemaVersion('process-binding'),
    kind: 'process-binding',
    processId: id,
    subjectId: subject,
    subjectAuthority,
    configurationAuthority,
    repositoryIdentity: repositoryIdentity ?? `sha256:${recordSha256({ gitCommonDirectory: common })}`,
    gitCommonDirectory: common,
    worktreeGitDirectory: worktreeGit,
    canonicalWorktreeRoot: worktreeRoot,
    branch: branchName ?? branch(root),
    baselineRevision: baselineRevision ?? head(root),
    expectedProcessRevision
  };
  return sealSgosImmutableRecord('process-binding', core);
}

/** Write a content-addressed record once; equal writers converge on the same bytes. */
export async function putSgosImmutableRecord(root, processId, familyId, value, {
  reserveExisting = false
} = {}) {
  const id = requireProcessId(processId);
  const sealed = sealSgosImmutableRecord(familyId, value);
  try { validateSgosRecord(sealed); } catch (error) {
    fail(`SGOS ${familyId} failed its strict contract.`, 'SGOS_RECORD_INVALID', {
      cause: error?.message ?? String(error)
    });
  }
  if (sealed.processId != null && sealed.processId !== id) {
    fail(`SGOS ${familyId} belongs to another process.`, 'SGOS_RECORD_PROCESS_MISMATCH');
  }
  const family = IMMUTABLE_FAMILIES[familyId];
  const target = immutableLocation(root, id, familyId, sealed[family.hashField]);
  const bytes = canonicalJson(sealed);
  const publish = async () => {
    await safeSgosDirectory(root, path.dirname(target), { create: true });
    let existing = null;
    try { existing = await readSafeFile(root, target); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (existing !== null && existing !== bytes) {
      fail(`Immutable SGOS ${familyId} hash collision.`, 'SGOS_IMMUTABLE_CONFLICT');
    }

    let reservation = null;
    if (INDEXED_RECORD_FAMILIES.has(familyId)) {
      reservation = await readRecordReservation(
        root, id, familyId, sealed[family.hashField]
      );
      if ((existing === null || reserveExisting) && reservation === null) {
        await assertReservationCapacity(root, id, Buffer.byteLength(bytes));
        const reservationPath = recordReservationLocation(
          root, id, familyId, sealed[family.hashField]
        );
        // This durable, schema-censused hard-link source is the capacity reservation. It exists
        // before the application/evidence record becomes visible and remains until an exact index
        // transition commits, bounding repeated pre-index crashes without scanning history.
        await writeSafeAtomic(root, reservationPath, bytes);
        reservation = await readRecordReservation(
          root, id, familyId, sealed[family.hashField]
        );
      }
      if (existing === null) {
        try {
          await link(reservation.path, target);
          await syncDirectory(path.dirname(target));
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error;
          const converged = await readSafeFile(root, target);
          if (converged !== bytes) {
            fail(`Immutable SGOS ${familyId} hash collision.`, 'SGOS_IMMUTABLE_CONFLICT');
          }
        }
      }
      const token = reservation == null ? null : Object.freeze({
        ...reservation.token,
        // Only explicit recovery/reassertion may pay the bounded historical-membership check.
        // Fresh publications and deterministic pre-CAS retries are proven unindexed locally.
        checkRootedHistory: reserveExisting && existing !== null
      });
      const deltaContext = RECORD_DELTA_CONTEXT.getStore();
      if (token !== null && deltaContext?.active === true) deltaContext.tokens.push(token);
      return Object.freeze({
        record: sealed,
        sha256: sealed[family.hashField],
        path: target,
        reservationToken: token
      });
    }

    if (existing === null) {
      const temporary = `${target}.pending-${process.pid}-${randomUUID()}`;
      try {
        await writeDurableStagingFile(temporary, bytes);
        const temporaryStats = await lstat(temporary);
        if (temporaryStats.isSymbolicLink() || !temporaryStats.isFile()) {
          fail('Immutable SGOS staging target is not a real file.', 'SGOS_SIDECAR_PATH_UNSAFE');
        }
        try {
          // A hard link publishes a fully-written file and, unlike rename, never replaces an
          // existing record. Equal writers converge on the same exact bytes.
          await link(temporary, target);
          await syncDirectory(path.dirname(target));
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error;
          const converged = await readSafeFile(root, target);
          if (converged !== bytes) {
            fail(`Immutable SGOS ${familyId} hash collision.`, 'SGOS_IMMUTABLE_CONFLICT');
          }
        }
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }
    }
    return Object.freeze({
      record: sealed, sha256: sealed[family.hashField], path: target, reservationToken: null
    });
  };

  const published = INDEXED_RECORD_FAMILIES.has(familyId)
    ? await withProcessLock(root, id, publish)
    : await publish();
  await safeSgosDirectory(root, path.dirname(target));
  const publishedStats = await lstat(target);
  if (publishedStats.isSymbolicLink() || !publishedStats.isFile()) {
    fail('Immutable SGOS publication is not a real file.', 'SGOS_SIDECAR_PATH_UNSAFE');
  }
  return published;
}

function sealSgosControlSuccessor(value) {
  const core = {
    ...clone(value),
    schemaVersion: currentSchemaVersion('sgos-control-successor'),
    kind: 'sgos-control-successor'
  };
  delete core.successorSha256;
  return Object.freeze({ ...core, successorSha256: hashWithout(core, 'successorSha256') });
}

async function prepareSgosControlSuccessor(root, processId, value, {
  event: suppliedEvent = null,
  publishedIndexes = null,
  candidateState = null
} = {}) {
  const id = requireProcessId(processId);
  const event = suppliedEvent ?? (await readSgosImmutableRecord(
    root, id, 'sgos-control-event', value.controlEventSha256
  )).record;
  if (event.controlEventSha256 !== value.controlEventSha256) {
    fail('SGOS control successor event does not match its declared control hash.',
      'SGOS_CONTROL_LINEAGE_INVALID');
  }
  let priorInfrastructureBytes = 0;
  let priorInfrastructureRecords = 0;
  if (event.priorControlEventSha256 !== null) {
    const { record: priorEvent } = await readSgosImmutableRecord(
      root, id, 'sgos-control-event', event.priorControlEventSha256
    );
    const priorSuccessor = await readSgosControlSuccessor(
      root, id, priorEvent.beforeProcessSha256
    );
    if (priorSuccessor === null
        || priorSuccessor.controlEventSha256 !== priorEvent.controlEventSha256) {
      fail('SGOS control successor cannot extend an incomplete infrastructure lineage.',
        'SGOS_CONTROL_LINEAGE_INVALID');
    }
    priorInfrastructureBytes = priorSuccessor.cumulativeInfrastructureBytes;
    priorInfrastructureRecords = priorSuccessor.cumulativeInfrastructureRecords;
  }
  let indexes = publishedIndexes;
  if (indexes == null) {
    const { record: index } = await readSgosImmutableRecord(
      root, id, 'sgos-record-index', event.recordIndexSha256
    );
    indexes = [index];
  }
  if (!Array.isArray(indexes) || indexes.length < 1) {
    fail('SGOS control successor requires its exact published record-index set.',
      'SGOS_RECORD_INDEX_INVALID');
  }
  const infrastructureBaseBytes = priorInfrastructureBytes
    + indexes.reduce((total, index) => total + Buffer.byteLength(canonicalJson(index)), 0)
    + Buffer.byteLength(canonicalJson(event));
  const cumulativeInfrastructureRecords = priorInfrastructureRecords + indexes.length + 2;
  let cumulativeInfrastructureBytes = infrastructureBaseBytes;
  let sealed;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    sealed = sealSgosControlSuccessor({
      ...value,
      cumulativeInfrastructureBytes,
      cumulativeInfrastructureRecords
    });
    const exact = infrastructureBaseBytes + Buffer.byteLength(canonicalJson(sealed));
    if (exact === cumulativeInfrastructureBytes) break;
    cumulativeInfrastructureBytes = exact;
  }
  sealed = sealSgosControlSuccessor({
    ...value,
    cumulativeInfrastructureBytes,
    cumulativeInfrastructureRecords
  });
  if (infrastructureBaseBytes + Buffer.byteLength(canonicalJson(sealed))
      !== cumulativeInfrastructureBytes) {
    fail('SGOS control successor infrastructure accounting did not converge.',
      'SGOS_PROCESS_RECORD_BUDGET_EXCEEDED');
  }
  if (sealed.processId !== id) {
    fail('SGOS control successor belongs to another Process.', 'SGOS_RECORD_PROCESS_MISMATCH');
  }
  try { validateSgosRecord(sealed); } catch (error) {
    fail('SGOS control successor failed its strict contract.', 'SGOS_RECORD_INVALID', {
      cause: error?.message ?? String(error)
    });
  }
  const currentIndex = indexes.at(-1);
  if (currentIndex.recordIndexSha256 !== event.recordIndexSha256) {
    fail('SGOS control successor does not account for the event record-index head.',
      'SGOS_RECORD_INDEX_INVALID');
  }
  const committed = new Set(indexes.flatMap((index) => index.delta
    .map((entry) => `${entry.family}\u0000${entry.recordSha256}`)));
  const pending = (await listRecordReservations(root, id)).filter((reservation) =>
    !committed.has(`${reservation.entry.family}\u0000${reservation.entry.recordSha256}`));
  const pendingBytes = pending.reduce((total, reservation) => total + reservation.entry.bytes, 0);
  if (candidateState?.processId !== id
      || candidateState.controlEventSha256 !== event.controlEventSha256
      || candidateState.recordIndexSha256 !== currentIndex.recordIndexSha256) {
    fail('SGOS control successor requires the exact candidate Process state for admission.',
      'SGOS_CONTROL_LINEAGE_INVALID');
  }
  const stateBytes = Buffer.byteLength(canonicalJson(candidateState));
  const leaseDirectory = path.join(sgosProcessDirectory(root, id), 'execution-leases');
  let leaseEntries = [];
  try {
    await safeSgosDirectory(root, leaseDirectory);
    leaseEntries = await readdir(leaseDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (leaseEntries.length > MAX_EXECUTION_LEASES) {
    fail('SGOS Process execution-lease directory exceeds its installed bounded capacity.',
      'SGOS_EXECUTION_LEASE_LIMIT');
  }
  let leaseBytes = 0;
  for (const entry of leaseEntries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) {
      fail('SGOS execution-lease directory contains an unsafe entry.',
        'SGOS_SIDECAR_PATH_UNSAFE', { entry: entry.name });
    }
    leaseBytes += Buffer.byteLength(await readSafeFile(root, path.join(leaseDirectory, entry.name)));
  }
  if (currentIndex.totalBytes + cumulativeInfrastructureBytes + pendingBytes
        + stateBytes + leaseBytes
        > MAX_PROCESS_RECORD_BYTES
      || currentIndex.totalRecordCount + cumulativeInfrastructureRecords + pending.length
        + 1 + leaseEntries.length
        > MAX_PROCESS_RECORDS) {
    fail('SGOS Process physical immutable history exceeds its installed cumulative capacity.',
      'SGOS_PROCESS_RECORD_BUDGET_EXCEEDED', {
        indexedBytes: currentIndex.totalBytes,
        infrastructureBytes: cumulativeInfrastructureBytes,
        pendingBytes,
        stateBytes,
        leaseBytes,
        maximumBytes: MAX_PROCESS_RECORD_BYTES,
        indexedRecords: currentIndex.totalRecordCount,
        infrastructureRecords: cumulativeInfrastructureRecords,
        pendingRecords: pending.length,
        stateRecords: 1,
        leaseRecords: leaseEntries.length,
        maximumRecords: MAX_PROCESS_RECORDS
      });
  }
  return sealed;
}

async function putPreparedSgosControlSuccessor(root, processId, sealed) {
  const id = requireProcessId(processId);
  if (sealed.processId !== id) {
    fail('SGOS control successor belongs to another Process.', 'SGOS_RECORD_PROCESS_MISMATCH');
  }
  try { validateSgosRecord(sealed); } catch (error) {
    fail('SGOS control successor failed its strict contract.', 'SGOS_RECORD_INVALID', {
      cause: error?.message ?? String(error)
    });
  }
  const target = controlSuccessorPath(root, id, sealed.beforeProcessSha256);
  await safeSgosDirectory(root, path.dirname(target), { create: true });
  const bytes = canonicalJson(sealed);
  const temporary = `${target}.pending-${process.pid}-${randomUUID()}`;
  try {
    await writeDurableStagingFile(temporary, bytes);
    try {
      await link(temporary, target);
      await syncDirectory(path.dirname(target));
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await readSafeFile(root, target);
      if (existing !== bytes) {
        fail('SGOS Process control lineage has more than one successor.',
          'SGOS_CONTROL_LINEAGE_FORK', {
            beforeProcessSha256: sealed.beforeProcessSha256
          });
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  await safeSgosDirectory(root, path.dirname(target));
  const published = await lstat(target);
  if (published.isSymbolicLink() || !published.isFile()) {
    fail('SGOS control successor publication is not a real file.',
      'SGOS_SIDECAR_PATH_UNSAFE');
  }
  return Object.freeze({ record: sealed, path: target });
}

async function intentReservationsIfPresent(root, processId, intent) {
  const reservations = [];
  for (const token of intent.reservations) {
    const reservation = await readRecordReservation(
      root, processId, token.family, token.recordSha256
    );
    if (reservation !== null) {
      if (reservation.token.bytes !== token.bytes) {
        fail('SGOS transition reservation changed before cleanup.',
          'SGOS_TRANSITION_INTENT_CORRUPT', {
            family: token.family, recordSha256: token.recordSha256
          });
      }
      reservations.push(reservation);
    }
  }
  return reservations;
}

async function assertTransitionIntentCapacity(
  root, processId, { index, successor, candidateState, intent }
) {
  const deltaIdentities = new Set(index.delta
    .map((entry) => `${entry.family}\u0000${entry.recordSha256}`));
  const pending = (await listRecordReservations(root, processId)).filter((reservation) =>
    !deltaIdentities.has(`${reservation.entry.family}\u0000${reservation.entry.recordSha256}`));
  const pendingBytes = pending.reduce((total, reservation) => total + reservation.entry.bytes, 0);
  const lease = await readExecutionLeaseFootprint(root, processId);
  const intentBytes = Buffer.byteLength(canonicalJson(intent));
  const stateBytes = Buffer.byteLength(canonicalJson(candidateState));
  if (index.totalBytes + successor.cumulativeInfrastructureBytes + pendingBytes
        + lease.leaseBytes + intentBytes + stateBytes > MAX_PROCESS_RECORD_BYTES
      || index.totalRecordCount + successor.cumulativeInfrastructureRecords + pending.length
        + lease.leaseRecords + 2 > MAX_PROCESS_RECORDS) {
    fail('SGOS transition intent exceeds the complete Process physical capacity.',
      'SGOS_PROCESS_RECORD_BUDGET_EXCEEDED', {
        indexedBytes: index.totalBytes,
        infrastructureBytes: successor.cumulativeInfrastructureBytes,
        pendingBytes,
        leaseBytes: lease.leaseBytes,
        intentBytes,
        stateBytes,
        maximumBytes: MAX_PROCESS_RECORD_BYTES,
        maximumRecords: MAX_PROCESS_RECORDS
      });
  }
}

async function publishSgosTransitionIntent(root, current, intent, {
  preparedIndex = null,
  preparedSuccessor = null,
  preparedState = null,
  preparedReservations = null
} = {}) {
  const id = current.processId;
  if (intent.beforeProcessSha256 !== current.processSha256
      || intent.beforeProcessRevision !== current.processRevision
      || intent.priorRecordIndexSha256 !== current.recordIndexSha256) {
    fail('SGOS transition intent does not extend the exact current Process.',
      'SGOS_TRANSITION_INTENT_STALE');
  }
  const { index: priorIndex } = await readSgosRecordIndexHead(
    root, id, current.recordIndexSha256
  );
  const prepared = preparedIndex == null
    ? await prepareSgosRecordIndex(root, id, priorIndex, intent.reservations)
    : { index: preparedIndex, reservations: preparedReservations ?? [] };
  if (prepared.index.recordIndexSha256 !== intent.nextRecordIndexSha256) {
    fail('SGOS transition intent record index changed before recovery.',
      'SGOS_TRANSITION_INTENT_CORRUPT');
  }
  const event = intent.controlEvent;
  const candidateState = preparedState ?? processFromControlEvent(current, event);
  if (candidateState.processSha256 !== intent.candidateProcessSha256
      || candidateState.recordIndexSha256 !== prepared.index.recordIndexSha256
      || candidateState.controlEventSha256 !== event.controlEventSha256) {
    fail('SGOS transition intent candidate Process does not reconstruct exactly.',
      'SGOS_TRANSITION_INTENT_CORRUPT');
  }
  await assertTransitionIndexDelta(root, current, candidateState, prepared.index);
  await assertHotReferencedRecords(root, candidateState);
  const successor = preparedSuccessor ?? await prepareSgosControlSuccessor(root, id, {
    processId: id,
    beforeProcessSha256: current.processSha256,
    controlEventSha256: event.controlEventSha256,
    controlDepth: event.controlDepth,
    operatorTransitionCount: event.operatorTransitionCount
  }, { event, publishedIndexes: [prepared.index], candidateState });
  if (successor.successorSha256 !== intent.successorSha256) {
    fail('SGOS transition intent successor changed before recovery.',
      'SGOS_TRANSITION_INTENT_CORRUPT');
  }
  // Recovery may run after unrelated opaque reservations or leases appeared. Re-admit the exact
  // durable intent against the complete current physical footprint before publishing any missing
  // index/event/successor file.
  await assertTransitionIntentCapacity(root, id, {
    index: prepared.index, successor, candidateState, intent
  });
  await publishPreparedRecordIndexes(root, id, [prepared.index]);
  injectSgosStoreFault('record-index');
  await putSgosImmutableRecord(root, id, 'sgos-control-event', event);
  injectSgosStoreFault('control-event');
  await putPreparedSgosControlSuccessor(root, id, successor);
  injectSgosStoreFault('control-successor');
  await writeSafeAtomic(root, sgosProcessStatePath(root, id), canonicalJson(candidateState));
  injectSgosStoreFault('state');
  const reservations = prepared.reservations.length
    ? prepared.reservations
    : await intentReservationsIfPresent(root, id, intent);
  await consumeRecordReservations(root, reservations);
  injectSgosStoreFault('reservation-cleanup');
  await removeSgosTransitionIntent(root, id, intent.intentSha256);
  return Object.freeze(candidateState);
}

async function reconcileSgosTransitionIntent(root, current, intent) {
  if (intent.candidateProcessSha256 === current.processSha256) {
    if (intent.controlEvent.controlEventSha256 !== current.controlEventSha256
        || intent.nextRecordIndexSha256 !== current.recordIndexSha256) {
      fail('Completed SGOS transition intent does not match current Process authority.',
        'SGOS_TRANSITION_INTENT_CORRUPT');
    }
    await writeSafeAtomic(root, sgosProcessStatePath(root, current.processId), canonicalJson(current));
    await consumeRecordReservations(
      root, await intentReservationsIfPresent(root, current.processId, intent)
    );
    await removeSgosTransitionIntent(root, current.processId, intent.intentSha256);
    return Object.freeze(current);
  }
  if (intent.beforeProcessSha256 !== current.processSha256) {
    fail('SGOS transition intent belongs to neither current nor exact predecessor state.',
      'SGOS_TRANSITION_INTENT_STALE', {
        beforeProcessSha256: intent.beforeProcessSha256,
        currentProcessSha256: current.processSha256
      });
  }
  return publishSgosTransitionIntent(root, current, intent);
}

async function throwSgosTransitionRecoveryRequired(root, processId, intent, cause) {
  let pending = null;
  let inspectionError = null;
  try { pending = await readSgosTransitionIntent(root, processId); } catch (error) {
    inspectionError = error;
  }
  if (pending?.intentSha256 === intent.intentSha256 || inspectionError != null) {
    fail('An exact SGOS transition intent is durable but publication did not finish. Retry recovery before any new operation.',
      'SGOS_TRANSITION_RECOVERY_REQUIRED', {
        processId,
        intentSha256: intent.intentSha256,
        causeCode: cause?.code ?? null,
        cause: cause?.message ?? String(cause),
        inspectionCode: inspectionError?.code ?? null
      });
  }
  // Removal precedes the directory fsync. If that fsync fails, the exact candidate may already be
  // authoritative while the journal pathname is gone. Never let a caller reinterpret that storage
  // error as task failure and synthesize conflicting terminal lineage.
  let current = null;
  try { current = await readSgosProcessUnlocked(root, processId); } catch {
    current = null;
  }
  if (current?.processSha256 === intent.candidateProcessSha256
      && current.controlEventSha256 === intent.controlEvent.controlEventSha256
      && current.recordIndexSha256 === intent.nextRecordIndexSha256) {
    fail('The exact SGOS transition completed, but journal cleanup durability was uncertain. Retry the caller against the committed revision.',
      'SGOS_TRANSITION_RECOVERED_RETRY', {
        processId,
        processRevision: current.processRevision,
        processSha256: current.processSha256,
        intentSha256: intent.intentSha256,
        causeCode: cause?.code ?? null
      });
  }
  throw cause;
}

/** @internal Complete one exact pending transition before any caller performs new work. */
export async function recoverPendingSgosTransition(root, processId) {
  const id = requireProcessId(processId);
  return withProcessLock(root, id, async () => {
    const current = await readSgosProcessUnlocked(root, id);
    const intent = await readSgosTransitionIntent(root, id);
    if (intent === null) return Object.freeze({ recovered: false, process: current });
    let recovered;
    try { recovered = await reconcileSgosTransitionIntent(root, current, intent); } catch (error) {
      return throwSgosTransitionRecoveryRequired(root, id, intent, error);
    }
    return Object.freeze({ recovered: true, process: recovered, intentSha256: intent.intentSha256 });
  }, 2_000, { createDirectory: false });
}

export async function readSgosControlSuccessor(root, processId, beforeProcessSha256) {
  const id = requireProcessId(processId);
  const target = controlSuccessorPath(root, id, beforeProcessSha256);
  let raw;
  try { raw = await readSafeFile(root, target); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const loaded = readRecord('sgos-control-successor', raw);
  const record = loaded.record;
  if (loaded.storedVersion === currentSchemaVersion('sgos-control-successor')
      && canonicalJson(record) !== raw) {
    fail('SGOS control successor is not stored in canonical exact-byte form.',
      'SGOS_CONTROL_LINEAGE_INVALID', { beforeProcessSha256 });
  }
  if (record.processId !== id || record.beforeProcessSha256 !== beforeProcessSha256
      || record.successorSha256 !== hashWithout(record, 'successorSha256')) {
    fail('SGOS control successor failed its exact integrity binding.',
      'SGOS_CONTROL_LINEAGE_INVALID', { beforeProcessSha256 });
  }
  try { validateSgosRecord(record); } catch (error) {
    fail('SGOS control successor failed its strict contract.',
      'SGOS_CONTROL_LINEAGE_INVALID', { cause: error?.message ?? String(error) });
  }
  if (record.cumulativeInfrastructureBytes > MAX_PROCESS_RECORD_BYTES
      || record.cumulativeInfrastructureRecords > MAX_PROCESS_RECORDS) {
    fail('SGOS control successor exceeds installed cumulative infrastructure capacity.',
      'SGOS_PROCESS_RECORD_BUDGET_EXCEEDED', {
        cumulativeInfrastructureBytes: record.cumulativeInfrastructureBytes,
        cumulativeInfrastructureRecords: record.cumulativeInfrastructureRecords
      });
  }
  return Object.freeze(record);
}

export async function readSgosImmutableRecord(root, processId, familyId, sha256) {
  const id = requireProcessId(processId);
  const family = IMMUTABLE_FAMILIES[familyId];
  if (!family) fail(`'${familyId}' is not an SGOS immutable-store family.`, 'SGOS_RECORD_FAMILY_INVALID');
  const target = immutableLocation(root, id, familyId, sha256);
  let raw;
  try {
    raw = await readSafeFile(root, target);
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`SGOS ${familyId} '${sha256}' is unavailable.`, 'SGOS_RECORD_NOT_FOUND', { family: familyId, sha256 });
    throw error;
  }
  const loaded = readRecord(familyId, raw);
  const record = loaded.record;
  if (loaded.storedVersion === currentSchemaVersion(familyId)
      && canonicalJson(record) !== raw) {
    fail(`SGOS ${familyId} '${sha256}' is not stored in canonical exact-byte form.`,
      'SGOS_RECORD_CORRUPT');
  }
  const expected = requireSha256(family.hashField, record[family.hashField]);
  if (expected !== sha256 || hashWithout(record, family.hashField) !== expected) {
    fail(`SGOS ${familyId} '${sha256}' failed its integrity check.`, 'SGOS_RECORD_CORRUPT');
  }
  if (record.processId != null && record.processId !== id) {
    fail(`SGOS ${familyId} '${sha256}' belongs to another process.`, 'SGOS_RECORD_PROCESS_MISMATCH');
  }
  try { validateSgosRecord(record); } catch (error) {
    fail(`SGOS ${familyId} '${sha256}' failed its strict contract.`, 'SGOS_RECORD_CORRUPT', {
      cause: error?.message ?? String(error)
    });
  }
  return Object.freeze({ record, sha256: expected, path: target, bytes: Buffer.byteLength(raw) });
}

function familyCountsAfter(prior, delta) {
  const counts = { ...(prior?.familyCounts ?? {}) };
  for (const entry of delta) counts[entry.family] = (counts[entry.family] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => compareSgosCodePoints(left, right)));
}

function sealSgosRecordIndex(processId, prior, delta) {
  const sorted = [...delta].sort(compareRecordIndexEntries);
  const deltaBytes = sorted.reduce((total, entry) => total + entry.bytes, 0);
  const totalRecordCount = (prior?.totalRecordCount ?? 0) + sorted.length;
  const totalBytes = (prior?.totalBytes ?? 0) + deltaBytes;
  if (sorted.length > MAXIMUM_SGOS_RECORD_INDEX_DELTA
      || totalRecordCount > MAX_PROCESS_RECORDS
      || totalBytes > MAX_PROCESS_RECORD_BYTES) {
    fail('SGOS Process record-index transition exceeds its installed capacity.',
      'SGOS_PROCESS_RECORD_BUDGET_EXCEEDED', {
        deltaRecords: sorted.length,
        totalRecordCount,
        totalBytes,
        maximumDeltaRecords: MAXIMUM_SGOS_RECORD_INDEX_DELTA,
        maximumRecords: MAX_PROCESS_RECORDS,
        maximumBytes: MAX_PROCESS_RECORD_BYTES
      });
  }
  return sealSgosImmutableRecord('sgos-record-index', {
    schemaVersion: currentSchemaVersion('sgos-record-index'),
    kind: 'sgos-record-index',
    processId,
    sequence: prior == null ? 0 : prior.sequence + 1,
    priorIndexSha256: prior?.recordIndexSha256 ?? null,
    delta: sorted,
    familyCounts: familyCountsAfter(prior, sorted),
    totalRecordCount,
    totalBytes
  });
}

async function assertSgosRecordIndexEdge(root, processId, index, prior = null, {
  verifyRecords = true
} = {}) {
  if (index.processId !== processId
      || index.sequence !== (prior == null ? 0 : prior.sequence + 1)
      || index.priorIndexSha256 !== (prior?.recordIndexSha256 ?? null)) {
    fail('SGOS Process record index does not extend its exact predecessor.',
      'SGOS_RECORD_INDEX_INVALID', {
        recordIndexSha256: index.recordIndexSha256,
        priorIndexSha256: index.priorIndexSha256
      });
  }
  const expectedCounts = familyCountsAfter(prior, index.delta);
  const deltaBytes = index.delta.reduce((total, entry) => total + entry.bytes, 0);
  if (canonicalJson(index.familyCounts) !== canonicalJson(expectedCounts)
      || index.totalRecordCount !== (prior?.totalRecordCount ?? 0) + index.delta.length
      || index.totalBytes !== (prior?.totalBytes ?? 0) + deltaBytes) {
    fail('SGOS Process record index has inconsistent cumulative arithmetic.',
      'SGOS_RECORD_INDEX_INVALID', { recordIndexSha256: index.recordIndexSha256 });
  }
  if (!verifyRecords) return index;
  for (const entry of index.delta) {
    let record;
    let bytes;
    try {
      ({ record, bytes } = await readSgosImmutableRecord(
        root, processId, entry.family, entry.recordSha256
      ));
    } catch (error) {
      if (error?.code !== 'SGOS_RECORD_NOT_FOUND') throw error;
      const code = entry.family === 'gvm-task-attempt'
        ? 'SGOS_RECORD_LINEAGE_INVALID'
        : entry.family === 'gvm-task-receipt'
          ? 'SGOS_RECEIPT_LINEAGE_INVALID'
          : 'SGOS_RECORD_INDEX_INVALID';
      fail('SGOS Process record index references missing immutable bytes.', code, {
        family: entry.family, recordSha256: entry.recordSha256
      });
    }
    const actual = recordIndexEntry(entry.family, record, canonicalJson(record));
    if (actual.bytes !== entry.bytes
        || bytes !== entry.bytes
        || actual.attemptId !== entry.attemptId
        || actual.taskInstanceId !== entry.taskInstanceId) {
      fail('SGOS Process record-index delta does not match its exact immutable record.',
        'SGOS_RECORD_INDEX_INVALID', {
          family: entry.family,
          recordSha256: entry.recordSha256
        });
    }
  }
  return index;
}

async function readSgosRecordIndexHead(root, processId, recordIndexSha256) {
  const { record: index } = await readSgosImmutableRecord(
    root, processId, 'sgos-record-index', recordIndexSha256
  );
  let prior = null;
  if (index.priorIndexSha256 !== null) {
    ({ record: prior } = await readSgosImmutableRecord(
      root, processId, 'sgos-record-index', index.priorIndexSha256
    ));
  }
  await assertSgosRecordIndexEdge(root, processId, index, prior);
  return Object.freeze({ index, prior });
}

function recordMembershipCacheKey(root, processId) {
  return `${sgosProcessDirectory(root, processId)}\u0000${processId}`;
}

async function rootedRecordMembership(root, processId, headSha256) {
  const key = recordMembershipCacheKey(root, processId);
  const cached = RECORD_INDEX_MEMBERSHIP_CACHE.get(key);
  if (cached?.headSha256 === headSha256) return cached.identities;
  const identities = new Set();
  let cursor = headSha256;
  let traversed = 0;
  while (cursor !== null) {
    if (traversed >= MAX_PROCESS_RECORDS) {
      fail('SGOS record-index membership traversal exceeded its installed bound.',
        'SGOS_RECORD_INDEX_LIMIT');
    }
    const { record: index } = await readSgosImmutableRecord(
      root, processId, 'sgos-record-index', cursor
    );
    for (const entry of index.delta) {
      const identity = `${entry.family}\u0000${entry.recordSha256}`;
      if (identities.has(identity)) {
        fail('SGOS record-index history contains a duplicate immutable identity.',
          'SGOS_RECORD_INDEX_DUPLICATE', {
            family: entry.family, recordSha256: entry.recordSha256
          });
      }
      identities.add(identity);
    }
    cursor = index.priorIndexSha256;
    traversed += 1;
  }
  if (identities.size > MAX_PROCESS_RECORDS) {
    fail('SGOS record-index membership exceeds its installed bound.',
      'SGOS_RECORD_INDEX_LIMIT');
  }
  RECORD_INDEX_MEMBERSHIP_CACHE.set(key, Object.freeze({ headSha256, identities }));
  if (RECORD_INDEX_MEMBERSHIP_CACHE.size > 32) {
    RECORD_INDEX_MEMBERSHIP_CACHE.delete(RECORD_INDEX_MEMBERSHIP_CACHE.keys().next().value);
  }
  return identities;
}

async function isRootedRecord(root, processId, headSha256, family, recordSha256) {
  if (headSha256 == null) return false;
  return (await rootedRecordMembership(root, processId, headSha256))
    .has(`${family}\u0000${recordSha256}`);
}

function advanceRootedRecordMembership(root, processId, priorSha256, index) {
  const key = recordMembershipCacheKey(root, processId);
  const cached = RECORD_INDEX_MEMBERSHIP_CACHE.get(key);
  if (cached?.headSha256 !== priorSha256) {
    RECORD_INDEX_MEMBERSHIP_CACHE.delete(key);
    return;
  }
  for (const entry of index.delta) {
    cached.identities.add(`${entry.family}\u0000${entry.recordSha256}`);
  }
  RECORD_INDEX_MEMBERSHIP_CACHE.set(key, Object.freeze({
    headSha256: index.recordIndexSha256,
    identities: cached.identities
  }));
}

async function exactReservedIndexEntries(root, processId, tokens) {
  const unique = new Map();
  for (const token of tokens ?? []) {
    if (token == null || typeof token !== 'object' || Array.isArray(token)
        || !INDEXED_RECORD_FAMILIES.has(token.family)
        || !SHA256.test(String(token.recordSha256 ?? ''))
        || !Number.isSafeInteger(token.bytes) || token.bytes < 1) {
      fail('SGOS mutation received an invalid durable record-reservation token.',
        'SGOS_RECORD_RESERVATION_INVALID');
    }
    unique.set(`${token.family}\u0000${token.recordSha256}`, token);
  }
  if (unique.size > MAXIMUM_SGOS_RECORD_INDEX_DELTA) {
    fail('SGOS mutation has too many exact record reservations for one transition.',
      'SGOS_RECORD_INDEX_DELTA_LIMIT', {
        actual: unique.size, maximum: MAXIMUM_SGOS_RECORD_INDEX_DELTA
      });
  }
  const reservations = [];
  for (const token of unique.values()) {
    const reservation = await readRecordReservation(
      root, processId, token.family, token.recordSha256
    );
    if (reservation === null || reservation.token.bytes !== token.bytes) {
      fail('SGOS mutation record reservation is missing or changed.',
        'SGOS_RECORD_RESERVATION_INVALID', {
          family: token.family, recordSha256: token.recordSha256
        });
    }
    reservations.push(reservation);
  }
  reservations.sort((left, right) => compareRecordIndexEntries(left.entry, right.entry));
  return Object.freeze(reservations);
}

async function prepareSgosRecordIndex(root, processId, prior, tokens) {
  const reservations = await exactReservedIndexEntries(root, processId, tokens);
  const index = sealSgosRecordIndex(processId, prior, reservations.map((item) => item.entry));
  await assertSgosRecordIndexEdge(root, processId, index, prior);
  return Object.freeze({ index, reservations });
}

async function publishPreparedRecordIndexes(root, processId, indexes) {
  let priorSha256 = indexes[0]?.priorIndexSha256 ?? null;
  for (const index of indexes) {
    await putSgosImmutableRecord(root, processId, 'sgos-record-index', index);
    advanceRootedRecordMembership(root, processId, priorSha256, index);
    priorSha256 = index.recordIndexSha256;
  }
}

async function snapshotAllIndexedRecords(root, processId) {
  const entries = [];
  for (const family of SGOS_RECORD_INDEX_FAMILIES) {
    const records = await readAllSgosImmutableRecords(root, processId, family);
    for (const record of records) entries.push(recordIndexEntry(family, record));
  }
  entries.sort(compareRecordIndexEntries);
  if (entries.length > MAX_PROCESS_RECORDS
      || entries.reduce((total, entry) => total + entry.bytes, 0) > MAX_PROCESS_RECORD_BYTES) {
    fail('SGOS Process immutable-record snapshot exceeds its installed cumulative capacity.',
      'SGOS_PROCESS_RECORD_BUDGET_EXCEEDED', {
        actualRecords: entries.length,
        maximumRecords: MAX_PROCESS_RECORDS,
        maximumBytes: MAX_PROCESS_RECORD_BYTES
      });
  }
  return Object.freeze(entries);
}

async function prepareSgosRecordIndexBaseline(root, processId, entries) {
  let prior = sealSgosRecordIndex(processId, null, []);
  await assertSgosRecordIndexEdge(root, processId, prior, null);
  const indexes = [prior];
  for (let offset = 0; offset < entries.length; offset += MAXIMUM_SGOS_RECORD_INDEX_DELTA) {
    const index = sealSgosRecordIndex(
      processId, prior, entries.slice(offset, offset + MAXIMUM_SGOS_RECORD_INDEX_DELTA)
    );
    await assertSgosRecordIndexEdge(root, processId, index, prior);
    indexes.push(index);
    prior = index;
  }
  return Object.freeze({ index: prior, indexes: Object.freeze(indexes) });
}

async function consumeRecordReservations(root, reservations) {
  if (!reservations?.length) return;
  const directories = new Set();
  for (const reservation of reservations) {
    try {
      const current = await readSafeFile(root, reservation.path);
      if (canonicalJson(reservation.record) !== current) {
        fail('SGOS record reservation changed before it could be consumed.',
          'SGOS_RECORD_RESERVATION_CORRUPT');
      }
      await rm(reservation.path);
      directories.add(path.dirname(reservation.path));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  for (const directory of directories) await syncDirectory(directory);
}

/** @internal Rare start/recovery cleanup for exact reservations already rooted in index history. */
export async function consumeRootedSgosRecordReservations(root, processId, tokens = []) {
  const id = requireProcessId(processId);
  const supplied = tokens.filter(Boolean);
  if (supplied.length === 0) return Object.freeze({ consumed: 0 });
  return withProcessLock(root, id, async () => {
    const state = await readSgosProcessUnlocked(root, id);
    for (const token of supplied) {
      if (!INDEXED_RECORD_FAMILIES.has(token?.family)
          || !SHA256.test(String(token?.recordSha256 ?? ''))
          || !await isRootedRecord(
            root, id, state.recordIndexSha256, token.family, token.recordSha256
          )) {
        fail('SGOS recovery refused to consume a reservation outside rooted record-index authority.',
          'SGOS_RECORD_RESERVATION_INVALID', {
            family: token?.family ?? null,
            recordSha256: token?.recordSha256 ?? null
          });
      }
    }
    const reservations = await exactReservedIndexEntries(root, id, supplied);
    await consumeRecordReservations(root, reservations);
    return Object.freeze({ consumed: reservations.length });
  }, 2_000, { createDirectory: false });
}

async function readAllSgosImmutableRecords(root, processId, familyId) {
  const family = IMMUTABLE_FAMILIES[familyId];
  if (!family) fail(`'${familyId}' is not an SGOS immutable-store family.`, 'SGOS_RECORD_FAMILY_INVALID');
  const directory = path.join(sgosProcessDirectory(root, processId), family.directory);
  let entries;
  try {
    await safeSgosDirectory(root, directory);
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze([]);
    throw error;
  }
  const records = entries.filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry.name))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const maximumRecords = familyId === 'sgos-control-event'
    ? MAX_CONTROL_RECORDS
    : MAX_IMMUTABLE_RECORD_SCAN;
  if (records.length > maximumRecords) {
    fail(`SGOS ${familyId} lookup exceeded its bounded record ceiling.`, 'SGOS_RECORD_SCAN_LIMIT', {
      maximum: maximumRecords, actual: records.length
    });
  }
  const values = [];
  for (const entry of records) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      fail(`SGOS ${familyId} contains a non-file record entry.`, 'SGOS_SIDECAR_PATH_UNSAFE');
    }
    const reference = `sha256:${entry.name.slice(0, -'.json'.length)}`;
    const { record } = await readSgosImmutableRecord(root, processId, familyId, reference);
    values.push(record);
  }
  return Object.freeze(values.map((record) => Object.freeze(record)));
}

async function reconcileSgosControlLineage(root, state, {
  baselineProcessSha256 = state.processSha256,
  legacyBaseline = false
} = {}) {
  let current = state;
  let currentLookupSha256 = baselineProcessSha256;
  let currentControlDepth = 0;
  let currentOperatorTransitionCount = 0;
  let successorLookups = 0;
  let replayedTransitions = 0;
  if (current.controlEventSha256 === null) {
    if (!legacyBaseline && current.processRevision !== 1) {
      fail('SGOS Process has no immutable control head for its mutable revision.',
        'SGOS_CONTROL_LINEAGE_INVALID', { processRevision: current.processRevision });
    }
  } else {
    const { record: headEvent } = await readSgosImmutableRecord(
      root, current.processId, 'sgos-control-event', current.controlEventSha256
    );
    if (headEvent.recordIndexSha256 !== current.recordIndexSha256) {
      fail('SGOS Process and control head bind different immutable record indexes.',
        'SGOS_RECORD_INDEX_INVALID', {
          processRecordIndexSha256: current.recordIndexSha256,
          eventRecordIndexSha256: headEvent.recordIndexSha256
        });
    }
    const { index: headIndex } = await readSgosRecordIndexHead(
      root, current.processId, headEvent.recordIndexSha256
    );
    const authoritativeSuccessor = await readSgosControlSuccessor(
      root, current.processId, headEvent.beforeProcessSha256
    );
    assertSgosControlCapacity(headEvent.controlDepth, headEvent.operatorTransitionCount);
    let expectedHeadDepth = 1;
    let expectedHeadOperatorTransitions = ['process-paused', 'process-resumed']
      .includes(headEvent.action) ? 1 : 0;
    if (headEvent.priorControlEventSha256 !== null) {
      const { record: priorHeadEvent } = await readSgosImmutableRecord(
        root, current.processId, 'sgos-control-event', headEvent.priorControlEventSha256
      );
      if (headIndex.priorIndexSha256 !== priorHeadEvent.recordIndexSha256) {
        fail('SGOS Process record-index head does not extend the prior control event.',
          'SGOS_RECORD_INDEX_INVALID', {
            recordIndexSha256: headIndex.recordIndexSha256,
            expectedPriorIndexSha256: priorHeadEvent.recordIndexSha256
          });
      }
      const priorState = processFromControlEvent(current, priorHeadEvent);
      if (priorState.processSha256 !== headEvent.beforeProcessSha256) {
        fail('SGOS Process control head does not follow its claimed prior event.',
          'SGOS_CONTROL_LINEAGE_INVALID', {
            controlEventSha256: current.controlEventSha256,
            priorControlEventSha256: headEvent.priorControlEventSha256
          });
      }
      expectedHeadDepth = priorHeadEvent.controlDepth + 1;
      expectedHeadOperatorTransitions = priorHeadEvent.operatorTransitionCount
        + (['process-paused', 'process-resumed'].includes(headEvent.action) ? 1 : 0);
    }
    if (authoritativeSuccessor === null
        || authoritativeSuccessor.controlEventSha256 !== current.controlEventSha256
        || authoritativeSuccessor.controlDepth !== headEvent.controlDepth
        || authoritativeSuccessor.operatorTransitionCount !== headEvent.operatorTransitionCount
        || headEvent.controlDepth !== expectedHeadDepth
        || headEvent.operatorTransitionCount !== expectedHeadOperatorTransitions
        || headEvent.beforeProcessRevision + 1 !== current.processRevision) {
      fail('SGOS Process control head is not the authoritative successor of its predecessor.',
        'SGOS_CONTROL_LINEAGE_INVALID', {
          controlEventSha256: current.controlEventSha256,
          beforeProcessSha256: headEvent.beforeProcessSha256,
          processRevision: current.processRevision
        });
    }
    const reconstructed = processFromControlEvent(current, headEvent);
    if (reconstructed.processSha256 !== current.processSha256) {
      fail('SGOS Process mutable state does not match its immutable control event.',
        'SGOS_CONTROL_LINEAGE_INVALID', { controlEventSha256: current.controlEventSha256 });
    }
    currentLookupSha256 = current.processSha256;
    currentControlDepth = headEvent.controlDepth;
    currentOperatorTransitionCount = headEvent.operatorTransitionCount;
  }

  let replayed = false;
  for (let replayCount = 0; replayCount <= MAX_CONTROL_RECORDS; replayCount += 1) {
    successorLookups += 1;
    const successor = await readSgosControlSuccessor(
      root, current.processId, currentLookupSha256
    );
    if (successor === null) {
      return Object.freeze({ state: current, replayed, successorLookups, replayedTransitions });
    }
    const { record: event } = await readSgosImmutableRecord(
      root, current.processId, 'sgos-control-event', successor.controlEventSha256
    );
    const { index: eventIndex } = await readSgosRecordIndexHead(
      root, current.processId, event.recordIndexSha256
    );
    assertSgosControlCapacity(event.controlDepth, event.operatorTransitionCount);
    const expectedOperatorTransitionCount = currentOperatorTransitionCount
      + (['process-paused', 'process-resumed'].includes(event.action) ? 1 : 0);
    if (event.beforeProcessSha256 !== currentLookupSha256
        || event.beforeProcessRevision !== current.processRevision
        || event.priorControlEventSha256 !== current.controlEventSha256
        || (!((legacyBaseline && replayedTransitions === 0)
          || (replayedTransitions === 0 && current.controlEventSha256 === null
            && current.recordIndexSha256 === null
            && event.priorControlEventSha256 === null))
          && eventIndex.priorIndexSha256 !== current.recordIndexSha256)
        || event.controlDepth !== currentControlDepth + 1
        || successor.controlDepth !== event.controlDepth
        || successor.operatorTransitionCount !== event.operatorTransitionCount
        || event.operatorTransitionCount !== expectedOperatorTransitionCount) {
      fail('SGOS control successor is not bound to the exact preceding Process revision.',
        'SGOS_CONTROL_LINEAGE_INVALID', {
          controlEventSha256: event.controlEventSha256,
          beforeProcessSha256: currentLookupSha256,
          processRevision: current.processRevision
        });
    }
    current = processFromControlEvent(current, event);
    currentLookupSha256 = current.processSha256;
    currentControlDepth = event.controlDepth;
    currentOperatorTransitionCount = event.operatorTransitionCount;
    replayed = true;
    replayedTransitions += 1;
  }
  fail('SGOS Process control replay exceeded its installed transition ceiling.',
    'SGOS_CONTROL_LINEAGE_LIMIT', { maximum: MAX_CONTROL_RECORDS });
}

export async function listSgosImmutableRecordsByField(root, processId, familyId, field, value) {
  const records = await readAllSgosImmutableRecords(root, processId, familyId);
  const matches = records.filter((record) => record[field] === value);
  return Object.freeze(matches.map((record) => Object.freeze(record)));
}

async function findSgosImmutableRecord(root, processId, familyId, field, value) {
  const matches = await listSgosImmutableRecordsByField(root, processId, familyId, field, value);
  if (matches.length !== 1) {
    fail(`SGOS ${familyId} '${value}' has ${matches.length} immutable lineage records; expected exactly one.`,
      'SGOS_RECORD_LINEAGE_INVALID', { family: familyId, field, value, matches: matches.length });
  }
  return matches[0];
}

function successfulSgosAttempt(attemptsById, attemptId) {
  const matches = attemptsById.get(attemptId) ?? [];
  const completed = matches.filter((record) => record.status !== 'running');
  const successful = completed.filter((record) => record.status === 'succeeded');
  if (successful.length !== 1 || completed.length !== 1) {
    fail(`SGOS attempt '${attemptId}' has invalid immutable terminal lineage.`,
      'SGOS_RECORD_LINEAGE_INVALID', {
        family: 'gvm-task-attempt', attemptId, records: matches.length,
        terminalRecords: completed.length, successfulRecords: successful.length
      });
  }
  const running = matches.filter((record) => record.status === 'running');
  if (running.length !== 1
      || running[0].executionHandleSha256 !== successful[0].executionHandleSha256) {
    fail(`SGOS attempt '${attemptId}' has inconsistent start lineage.`,
      'SGOS_RECORD_LINEAGE_INVALID', { attemptId, runningRecords: running.length });
  }
  return successful[0];
}

function recordsBy(records, field) {
  const indexed = new Map();
  for (const record of records) {
    const values = indexed.get(record[field]) ?? [];
    values.push(record);
    indexed.set(record[field], values);
  }
  return indexed;
}

async function assertSuccessfulReceiptLineage(
  root, state, taskId, task, record, attemptsById,
  readImmutable = (familyId, sha256) => readSgosImmutableRecord(
    root, state.processId, familyId, sha256
  )
) {
    if (record.taskInstanceId !== taskId || record.processId !== state.processId
        || record.verification?.status !== 'passed'
        || task.attemptIds.at(-1) !== record.attemptId
        || canonicalJson(record.inputRefs) !== canonicalJson(task.inputRefs)
        || (task.state === 'succeeded'
          && canonicalJson(record.outputRefs) !== canonicalJson(task.outputRefs))) {
      fail(`SGOS task '${taskId}' does not have a valid passing receipt.`, 'SGOS_SUCCESS_WITHOUT_RECEIPT');
    }
    const attempt = successfulSgosAttempt(attemptsById, record.attemptId);
    if (attempt.attemptSha256 !== record.attemptSha256
        || attempt.processId !== state.processId || attempt.taskInstanceId !== taskId
        || attempt.taskContractSha256 !== state.taskContractSha256 || attempt.status !== 'succeeded') {
      fail(`SGOS task '${taskId}' receipt is not bound to its successful immutable attempt.`, 'SGOS_RECEIPT_LINEAGE_INVALID');
    }
    const { record: candidate } = await readImmutable(
      'candidate-snapshot', record.candidateSha256
    );
    if (!record.evidenceRefs.includes(candidate.candidateSha256)
        || candidate.subject?.sha256 !== state.processBindingSha256
        || candidate.subject?.id !== state.authorityBinding?.subjectId) {
      fail(`SGOS task '${taskId}' receipt is not bound to its immutable Candidate Snapshot.`, 'SGOS_RECEIPT_LINEAGE_INVALID');
    }
    let boundEvidence = null;
    for (const reference of record.evidenceRefs) {
      if (reference === candidate.candidateSha256 || !SHA256.test(reference)) continue;
      try {
        const { record: evidence } = await readImmutable('action-evidence', reference);
        if (evidence.processId === state.processId && evidence.taskInstanceId === taskId
            && evidence.attemptId === record.attemptId
            && evidence.programSha256 === state.programSha256
            && evidence.taskContractSha256 === state.taskContractSha256
            && evidence.postStateSha256 === candidate.candidateSha256
            && evidence.verification?.status === 'passed'
            && evidence.verification?.checksSha256 === record.verification?.checksSha256
            && (evidence.contradictions?.length ?? 0) === 0) {
          boundEvidence = evidence;
          break;
        }
      } catch (error) {
        if (error?.code !== 'SGOS_RECORD_NOT_FOUND') throw error;
      }
    }
    if (!boundEvidence) {
      fail(`SGOS task '${taskId}' receipt has no exact passing Action Evidence lineage.`, 'SGOS_RECEIPT_LINEAGE_INVALID');
    }
    for (const responseSha256 of record.humanDecisionRefs ?? []) {
      const { record: response } = await readImmutable('human-response', responseSha256);
      if (response.processId !== state.processId || response.taskInstanceId !== taskId) {
        fail(`SGOS task '${taskId}' receipt references another task's Human Response.`, 'SGOS_RECEIPT_LINEAGE_INVALID');
      }
    }
}

async function assertHotSuccessfulReceiptLineage(root, state, taskId, task, record) {
  if (record.taskInstanceId !== taskId || record.processId !== state.processId
      || record.verification?.status !== 'passed'
      || task.attemptIds.at(-1) !== record.attemptId
      || canonicalJson(record.inputRefs) !== canonicalJson(task.inputRefs)
      || canonicalJson(record.outputRefs) !== canonicalJson(task.outputRefs)) {
    fail(`SGOS task '${taskId}' does not have a valid passing receipt.`,
      'SGOS_SUCCESS_WITHOUT_RECEIPT');
  }
  const { record: attempt } = await readSgosImmutableRecord(
    root, state.processId, 'gvm-task-attempt', record.attemptSha256
  );
  if (attempt.attemptId !== record.attemptId
      || attempt.taskInstanceId !== taskId
      || attempt.processId !== state.processId
      || attempt.status !== 'succeeded'
      || attempt.taskContractSha256 !== state.taskContractSha256) {
    fail(`SGOS task '${taskId}' receipt is not bound to its exact successful terminal attempt.`,
      'SGOS_RECEIPT_LINEAGE_INVALID');
  }
  const { record: candidate } = await readSgosImmutableRecord(
    root, state.processId, 'candidate-snapshot', record.candidateSha256
  );
  if (!record.evidenceRefs.includes(candidate.candidateSha256)
      || candidate.subject?.sha256 !== state.processBindingSha256
      || candidate.subject?.id !== state.authorityBinding?.subjectId) {
    fail(`SGOS task '${taskId}' receipt is not bound to its immutable Candidate Snapshot.`,
      'SGOS_RECEIPT_LINEAGE_INVALID');
  }
  let boundEvidence = null;
  for (const reference of record.evidenceRefs) {
    if (reference === candidate.candidateSha256 || !SHA256.test(reference)) continue;
    try {
      const { record: evidence } = await readSgosImmutableRecord(
        root, state.processId, 'action-evidence', reference
      );
      if (evidence.processId === state.processId && evidence.taskInstanceId === taskId
          && evidence.attemptId === record.attemptId
          && evidence.programSha256 === state.programSha256
          && evidence.taskContractSha256 === state.taskContractSha256
          && evidence.postStateSha256 === candidate.candidateSha256
          && evidence.verification?.status === 'passed'
          && evidence.verification?.checksSha256 === record.verification?.checksSha256
          && (evidence.contradictions?.length ?? 0) === 0) {
        boundEvidence = evidence;
        break;
      }
    } catch (error) {
      if (error?.code !== 'SGOS_RECORD_NOT_FOUND') throw error;
    }
  }
  if (!boundEvidence) {
    fail(`SGOS task '${taskId}' receipt has no exact passing Action Evidence lineage.`,
      'SGOS_RECEIPT_LINEAGE_INVALID');
  }
  for (const responseSha256 of record.humanDecisionRefs ?? []) {
    const { record: response } = await readSgosImmutableRecord(
      root, state.processId, 'human-response', responseSha256
    );
    if (response.processId !== state.processId || response.taskInstanceId !== taskId) {
      fail(`SGOS task '${taskId}' receipt references another task's Human Response.`,
        'SGOS_RECEIPT_LINEAGE_INVALID');
    }
  }
}

async function assertSgosStoredAuthorityAndMaterialization(root, state) {
  const [{ record: program }, { record: binding }] = await Promise.all([
    readSgosImmutableRecord(root, state.processId, 'gvm-program', state.programSha256),
    readSgosImmutableRecord(root, state.processId, 'process-binding', state.processBindingSha256)
  ]);
  if (program.policySnapshotSha256 !== state.policySnapshotSha256
      || binding.processId !== state.processId
      || binding.bindingSha256 !== state.processBindingSha256
      || binding.subjectId !== state.authorityBinding?.subjectId
      || binding.branch !== state.authorityBinding?.branch
      || binding.baselineRevision !== state.authorityBinding?.baselineRevision
      || canonicalJson(binding.subjectAuthority ?? null)
        !== canonicalJson(state.authorityBinding?.subjectAuthority ?? null)
      || canonicalJson(binding.configurationAuthority ?? null)
        !== canonicalJson(state.authorityBinding?.configurationAuthority ?? null)) {
    fail('SGOS Process does not match its immutable Program and Process Binding authority.',
      'SGOS_PROCESS_BINDING_INVALID', {
        processId: state.processId,
        programSha256: state.programSha256,
        processBindingSha256: state.processBindingSha256
      });
  }
  assertSgosProcessMaterialization(program, state);
}

async function assertReferencedRecords(root, state, { snapshotRecords = null } = {}) {
  const snapshotValues = snapshotRecords == null ? null : [...snapshotRecords.values()]
    .filter((entry) => entry.reservation !== true && entry.quarantinedV1 !== true);
  const allRecords = async (familyId) => snapshotValues == null
    ? readAllSgosImmutableRecords(root, state.processId, familyId)
    : snapshotValues.filter((entry) => entry.family === familyId).map((entry) => entry.record);
  const readImmutable = async (familyId, sha256) => {
    if (snapshotValues == null) {
      return readSgosImmutableRecord(root, state.processId, familyId, sha256);
    }
    const hashField = IMMUTABLE_FAMILIES[familyId]?.hashField;
    const record = snapshotValues.find((entry) => entry.family === familyId
      && entry.record?.[hashField] === sha256)?.record ?? null;
    if (record == null) {
      fail(`SGOS ${familyId} record '${sha256}' does not exist.`, 'SGOS_RECORD_NOT_FOUND', {
        family: familyId, sha256
      });
    }
    return Object.freeze({ record });
  };
  const readLease = async (leaseId) => {
    if (snapshotValues == null) return readSgosExecutionLease(root, state.processId, leaseId);
    return snapshotValues.find((entry) => entry.family === 'sgos-execution-lease'
      && entry.record?.leaseId === leaseId)?.record ?? null;
  };
  // Index every bounded attempt and receipt once, including immutable records hidden by mutable
  // task state. A self-hashed Process cannot reset a receipted task to ready and execute it again.
  const [attempts, receipts] = await Promise.all([
    allRecords('gvm-task-attempt'),
    allRecords('gvm-task-receipt')
  ]);
  const attemptsById = recordsBy(attempts, 'attemptId');
  const receiptsByAttempt = recordsBy(receipts, 'attemptId');
  const ownerByAttempt = new Map();

  for (const [taskId, task] of Object.entries(state.taskInstances)) {
    if (new Set(task.attemptIds).size !== task.attemptIds.length) {
      fail(`SGOS task '${taskId}' contains duplicate attempt lineage.`, 'SGOS_RECORD_LINEAGE_INVALID');
    }
    for (let index = 0; index < task.attemptIds.length; index += 1) {
      const attemptId = requireId('attemptId', task.attemptIds[index]);
      if (ownerByAttempt.has(attemptId)) {
        fail(`SGOS attempt '${attemptId}' is referenced by more than one task.`,
          'SGOS_RECORD_LINEAGE_INVALID');
      }
      ownerByAttempt.set(attemptId, taskId);
      const lineage = attemptsById.get(attemptId) ?? [];
      const running = lineage.filter((record) => record.status === 'running');
      const terminal = lineage.filter((record) => record.status !== 'running');
      if (running.length > 1 || terminal.length > 1) {
        fail(`SGOS attempt '${attemptId}' has ambiguous immutable lineage.`,
          'SGOS_RECORD_LINEAGE_INVALID', {
            attemptId, running: running.length, terminal: terminal.length
          });
      }
      const expectedParent = index === 0 ? null : task.attemptIds[index - 1];
      for (const record of lineage) {
        if (record.processId !== state.processId || record.taskInstanceId !== taskId
            || record.attemptNumber !== index + 1 || record.parentAttemptId !== expectedParent
            || record.taskContractSha256 !== state.taskContractSha256) {
          fail(`SGOS attempt '${attemptId}' is not bound to its exact task position.`,
            'SGOS_RECORD_LINEAGE_INVALID', { attemptId, taskInstanceId: taskId });
        }
      }
      if (running[0] && terminal[0]
          && running[0].executionHandleSha256 !== terminal[0].executionHandleSha256) {
        fail(`SGOS attempt '${attemptId}' has inconsistent execution handles.`,
          'SGOS_RECORD_LINEAGE_INVALID');
      }
      const isLast = index === task.attemptIds.length - 1;
      const isActive = state.activeExecutions.includes(attemptId);
      if (lineage.length === 0 && !(isLast && isActive)) {
        fail(`SGOS attempt '${attemptId}' has no immutable lineage.`, 'SGOS_RECORD_LINEAGE_INVALID');
      }
      if (!isLast && terminal.length !== 1) {
        fail(`SGOS attempt '${attemptId}' is incomplete before a later attempt.`,
          'SGOS_RECORD_LINEAGE_INVALID');
      }
      const boundReceipts = receiptsByAttempt.get(attemptId) ?? [];
      if (boundReceipts.length > 1) {
        fail(`SGOS attempt '${attemptId}' has ambiguous receipts.`,
          'SGOS_RECORD_LINEAGE_INVALID');
      }
      if (terminal[0]?.status === 'succeeded') {
        if (boundReceipts.length !== 1) {
          // A terminal-before-receipt crash remains visible to recovery/quarantine, but it can
          // never become ready or execute again.
          if (!isLast || !['running', 'recovery-required', 'waiting-human'].includes(task.state)) {
            fail(`SGOS successful attempt '${attemptId}' has no exact receipt.`,
              'SGOS_RECEIPT_LINEAGE_INVALID');
          }
        } else {
          const recoverableInterruptedSuccess = isLast && (
            isActive || task.state === 'recovery-required' || task.state === 'waiting-human'
          );
          if (task.state !== 'succeeded' && !recoverableInterruptedSuccess) {
            fail(`SGOS task '${taskId}' hides an immutable successful receipt in state '${task.state}'.`,
              'SGOS_RECEIPT_LINEAGE_INVALID');
          }
          await assertSuccessfulReceiptLineage(
            root, state, taskId, task, boundReceipts[0], attemptsById, readImmutable
          );
        }
      } else if (boundReceipts.length) {
        fail(`SGOS attempt '${attemptId}' has a receipt without a successful terminal attempt.`,
          'SGOS_RECEIPT_LINEAGE_INVALID');
      }
    }

    if (task.state === 'succeeded') {
      const attemptId = task.attemptIds.at(-1);
      const receipt = (receiptsByAttempt.get(attemptId) ?? [])[0] ?? null;
      if (!receipt || receipt.receiptSha256 !== task.receiptSha256) {
        fail(`SGOS task '${taskId}' does not retain its exact latest successful receipt.`,
          'SGOS_SUCCESS_WITHOUT_RECEIPT');
      }
    }
  }

  for (const record of attempts) {
    if (ownerByAttempt.get(record.attemptId) !== record.taskInstanceId) {
      fail(`SGOS attempt '${record.attemptId}' is orphaned from mutable task lineage.`,
        'SGOS_RECORD_LINEAGE_INVALID');
    }
  }
  for (const receipt of receipts) {
    if (ownerByAttempt.get(receipt.attemptId) !== receipt.taskInstanceId) {
      fail(`SGOS receipt '${receipt.receiptSha256}' is orphaned from mutable task lineage.`,
        'SGOS_RECEIPT_LINEAGE_INVALID');
    }
  }
  if (state.activeExecutions.length > 1
      || state.activeLeases.length !== state.activeExecutions.length) {
    fail('The sequential SGOS runtime requires one exact active execution/lease pair.',
      'SGOS_ACTIVE_EXECUTION_INVALID', {
        activeExecutions: state.activeExecutions.length,
        activeLeases: state.activeLeases.length
      });
  }
  const activeAttemptId = state.activeExecutions[0] ?? null;
  if (activeAttemptId != null) {
    const taskId = ownerByAttempt.get(activeAttemptId);
    const task = taskId == null ? null : state.taskInstances[taskId];
    if (!task || task.attemptIds.at(-1) !== activeAttemptId
        || !['running', 'verifying', 'recovery-required'].includes(task.state)) {
      fail('Active SGOS execution is not the latest attempt of one executable task.',
        'SGOS_ACTIVE_EXECUTION_INVALID', { attemptId: activeAttemptId, taskInstanceId: taskId ?? null });
    }
    if (!['running', 'recovery-required'].includes(state.status)) {
      fail('An active SGOS execution requires running or recovery-required Process state.',
        'SGOS_ACTIVE_EXECUTION_INVALID', { status: state.status });
    }
    const leaseId = state.activeLeases[0];
    const lease = await readLease(leaseId);
    if (!lease || lease.attemptId !== activeAttemptId || lease.taskInstanceId !== taskId
        || !SHA256.test(String(lease.attemptSha256 ?? ''))) {
      fail('Active SGOS execution is not bound to its exact durable execution lease.',
        'SGOS_ACTIVE_EXECUTION_INVALID', { attemptId: activeAttemptId, leaseId });
    }
    const { record: attempt } = await readImmutable('gvm-task-attempt', lease.attemptSha256);
    if (attempt.attemptId !== activeAttemptId || attempt.taskInstanceId !== taskId
        || attempt.processId !== state.processId || attempt.status !== 'running'
        || attempt.executionHandleSha256 !== lease.executionHandleSha256
        || attempt.taskContractSha256 !== state.taskContractSha256) {
      fail('Active SGOS execution is not bound to its exact running-attempt record.',
        'SGOS_ACTIVE_EXECUTION_INVALID', { attemptId: activeAttemptId, leaseId });
    }
    const lineage = attemptsById.get(activeAttemptId) ?? [];
    const runningAttempt = lineage.find((attempt) =>
      attempt.status === 'running' && attempt.attemptSha256 === lease.attemptSha256);
    if (!runningAttempt || lineage.some((attempt) =>
      attempt.executionHandleSha256 !== lease.executionHandleSha256)) {
      fail('Active SGOS attempt and execution lease have different execution handles.',
        'SGOS_ACTIVE_EXECUTION_INVALID', { attemptId: activeAttemptId, leaseId });
    }
  }
  for (const [taskId, task] of Object.entries(state.taskInstances)) {
    if (['running', 'verifying'].includes(task.state)
        && task.attemptIds.at(-1) !== activeAttemptId) {
      fail(`SGOS task '${taskId}' claims execution without the active attempt/lease pair.`,
        'SGOS_ACTIVE_EXECUTION_INVALID');
    }
  }
  if (state.currentCheckpointSha256) {
    await readImmutable('gvm-checkpoint', state.currentCheckpointSha256);
  }
  for (const requestSha256 of state.openHumanRequests) {
    const { record } = await readImmutable('human-request', requestSha256);
    if (record.status !== 'open') fail(`Open Human Request '${requestSha256}' is not open.`, 'SGOS_HUMAN_REQUEST_CORRUPT');
  }
}

async function assertHotReferencedRecords(root, state) {
  await assertSgosStoredAuthorityAndMaterialization(root, state);
  const ownerByAttempt = new Map();
  for (const [taskId, task] of Object.entries(state.taskInstances)) {
    if (new Set(task.attemptIds).size !== task.attemptIds.length) {
      fail(`SGOS task '${taskId}' contains duplicate attempt lineage.`,
        'SGOS_RECORD_LINEAGE_INVALID');
    }
    for (const attemptId of task.attemptIds) {
      requireId('attemptId', attemptId);
      if (ownerByAttempt.has(attemptId)) {
        fail(`SGOS attempt '${attemptId}' is referenced by more than one task.`,
          'SGOS_RECORD_LINEAGE_INVALID');
      }
      ownerByAttempt.set(attemptId, taskId);
    }
    if (task.state === 'succeeded') {
      const { record: receipt } = await readSgosImmutableRecord(
        root, state.processId, 'gvm-task-receipt', task.receiptSha256
      );
      await assertHotSuccessfulReceiptLineage(root, state, taskId, task, receipt);
    }
  }
  if (state.activeExecutions.length > 1
      || state.activeLeases.length !== state.activeExecutions.length) {
    fail('The sequential SGOS runtime requires one exact active execution/lease pair.',
      'SGOS_ACTIVE_EXECUTION_INVALID', {
        activeExecutions: state.activeExecutions.length,
        activeLeases: state.activeLeases.length
      });
  }
  const activeAttemptId = state.activeExecutions[0] ?? null;
  if (activeAttemptId != null) {
    const taskId = ownerByAttempt.get(activeAttemptId);
    const task = taskId == null ? null : state.taskInstances[taskId];
    if (!task || task.attemptIds.at(-1) !== activeAttemptId
        || !['running', 'verifying', 'recovery-required'].includes(task.state)
        || !['running', 'recovery-required'].includes(state.status)) {
      fail('Active SGOS execution is not the latest attempt of one executable task.',
        'SGOS_ACTIVE_EXECUTION_INVALID', { attemptId: activeAttemptId });
    }
    const leaseId = state.activeLeases[0];
    const lease = await readSgosExecutionLease(root, state.processId, leaseId);
    if (!lease || lease.attemptId !== activeAttemptId || lease.taskInstanceId !== taskId
        || !SHA256.test(String(lease.attemptSha256 ?? ''))) {
      fail('Active SGOS execution is not bound to its exact durable execution lease.',
        'SGOS_ACTIVE_EXECUTION_INVALID', { attemptId: activeAttemptId, leaseId });
    }
    const { record: attempt } = await readSgosImmutableRecord(
      root, state.processId, 'gvm-task-attempt', lease.attemptSha256
    );
    if (attempt.attemptId !== activeAttemptId || attempt.taskInstanceId !== taskId
        || attempt.processId !== state.processId || attempt.status !== 'running'
        || attempt.executionHandleSha256 !== lease.executionHandleSha256
        || attempt.taskContractSha256 !== state.taskContractSha256) {
      fail('Active SGOS execution is not bound to its exact running-attempt record.',
        'SGOS_ACTIVE_EXECUTION_INVALID', { attemptId: activeAttemptId, leaseId });
    }
  }
  for (const [taskId, task] of Object.entries(state.taskInstances)) {
    if (['running', 'verifying'].includes(task.state)
        && task.attemptIds.at(-1) !== activeAttemptId) {
      fail(`SGOS task '${taskId}' claims execution without the active attempt/lease pair.`,
        'SGOS_ACTIVE_EXECUTION_INVALID');
    }
  }
  if (state.currentCheckpointSha256) {
    await readSgosImmutableRecord(
      root, state.processId, 'gvm-checkpoint', state.currentCheckpointSha256
    );
  }
  for (const requestSha256 of state.openHumanRequests) {
    const { record } = await readSgosImmutableRecord(
      root, state.processId, 'human-request', requestSha256
    );
    if (record.status !== 'open') {
      fail(`Open Human Request '${requestSha256}' is not open.`,
        'SGOS_HUMAN_REQUEST_CORRUPT');
    }
  }
}

async function assertTransitionIndexDelta(root, before, after, index) {
  const indexed = new Set(index.delta
    .map((entry) => `${entry.family}\u0000${entry.recordSha256}`));
  const requireIndexed = (family, sha256, detail) => {
    if (!indexed.has(`${family}\u0000${sha256}`)) {
      fail(`SGOS Process transition introduced unindexed ${detail}.`,
        'SGOS_RECORD_INDEX_INVALID', { family, recordSha256: sha256, detail });
    }
  };
  const requireRooted = async (family, sha256, detail) => {
    if (indexed.has(`${family}\u0000${sha256}`)) return;
    if (await isRootedRecord(
      root, before.processId, before.recordIndexSha256, family, sha256
    )) return;
    fail(`SGOS Process transition introduced unrooted ${detail}.`,
      'SGOS_RECORD_INDEX_INVALID', { family, recordSha256: sha256, detail });
  };
  if (after.currentCheckpointSha256 !== before.currentCheckpointSha256
      && after.currentCheckpointSha256 !== null) {
    requireIndexed('gvm-checkpoint', after.currentCheckpointSha256, 'checkpoint');
  }
  for (const requestSha256 of after.openHumanRequests) {
    if (!before.openHumanRequests.includes(requestSha256)) {
      requireIndexed('human-request', requestSha256, 'Human Request');
    }
  }
  for (const [taskId, task] of Object.entries(after.taskInstances)) {
    const prior = before.taskInstances[taskId];
    for (const attemptId of task.attemptIds.slice(prior.attemptIds.length)) {
      const exactAttempt = index.delta.find((entry) => entry.family === 'gvm-task-attempt'
        && entry.attemptId === attemptId && entry.taskInstanceId === taskId);
      if (!exactAttempt) {
        fail(`SGOS Process transition introduced unindexed attempt '${attemptId}'.`,
          'SGOS_RECORD_INDEX_INVALID', { family: 'gvm-task-attempt', attemptId, taskInstanceId: taskId });
      }
    }
    if (task.receiptSha256 !== prior.receiptSha256 && task.receiptSha256 !== null) {
      requireIndexed('gvm-task-receipt', task.receiptSha256, `receipt for task '${taskId}'`);
      const { record: receipt } = await readSgosImmutableRecord(
        root, after.processId, 'gvm-task-receipt', task.receiptSha256
      );
      await requireRooted('gvm-task-attempt', receipt.attemptSha256,
        `terminal attempt for task '${taskId}'`);
      await requireRooted('candidate-snapshot', receipt.candidateSha256,
        `candidate for task '${taskId}'`);
      let evidenceRooted = index.delta.some((entry) => entry.family === 'action-evidence'
          && entry.attemptId === receipt.attemptId && entry.taskInstanceId === taskId
          && receipt.evidenceRefs.includes(entry.recordSha256));
      if (!evidenceRooted) {
        for (const evidenceSha256 of receipt.evidenceRefs) {
          if (evidenceSha256 === receipt.candidateSha256) continue;
          if (await isRootedRecord(
            root, before.processId, before.recordIndexSha256,
            'action-evidence', evidenceSha256
          )) {
            evidenceRooted = true;
            break;
          }
        }
      }
      if (!evidenceRooted) {
        fail(`SGOS Process transition introduced unindexed Action Evidence for task '${taskId}'.`,
          'SGOS_RECORD_INDEX_INVALID', { family: 'action-evidence', taskInstanceId: taskId });
      }
      for (const responseSha256 of receipt.humanDecisionRefs ?? []) {
        await requireRooted('human-response', responseSha256,
          `Human Response for task '${taskId}'`);
      }
    }
  }
}

function sealSgosProcessCreationSeed(value, {
  createdAt = value.createdAt ?? nowIso(),
  updatedAt = value.updatedAt ?? createdAt
} = {}) {
  return sealProcess(assertProcessShape({
    ...clone(value),
    schemaVersion: currentSchemaVersion('gvm-process'),
    kind: 'gvm-process',
    controlEventSha256: null,
    recordIndexSha256: null,
    processRevision: 1,
    createdAt,
    updatedAt
  }));
}

export async function createSgosProcess(root, value) {
  const processId = requireProcessId(value?.processId);
  return withProcessLock(root, processId, async () => {
    const target = sgosProcessStatePath(root, processId);
    let seed;
    try {
      const raw = await readSafeFile(root, target);
      let stored;
      try { stored = JSON.parse(raw); } catch {
        fail(`SGOS process '${processId}' is not valid JSON.`, 'SGOS_PROCESS_CORRUPT');
      }
      if (stored?.processId !== processId
          || stored.processSha256 !== hashWithout(stored, 'processSha256')) {
        fail(`SGOS process '${processId}' failed its stored-byte integrity check.`,
          'SGOS_PROCESS_CORRUPT');
      }
      const loaded = readRecord('gvm-process', raw);
      if (loaded.storedVersion !== currentSchemaVersion('gvm-process')
          || loaded.record.processRevision !== 1
          || loaded.record.controlEventSha256 !== null) {
        fail(`SGOS process '${processId}' already exists.`, 'SGOS_PROCESS_EXISTS');
      }
      seed = loaded.record;
      assertProcessShape(seed);
      try { validateSgosRecord(seed); } catch (error) {
        fail(`SGOS process '${processId}' failed its strict contract.`, 'SGOS_PROCESS_CORRUPT', {
          cause: error?.message ?? String(error)
        });
      }
      // The unrooted rev1 seed is a private crash boundary, never an authority surface. A retry
      // may reuse its persisted timestamps, but every other byte must equal the requested initial
      // Process. This prevents a self-rehashed seed from skipping work or fabricating completion.
      const expectedSeed = sealSgosProcessCreationSeed(value, {
        createdAt: seed.createdAt,
        updatedAt: seed.updatedAt
      });
      if (canonicalJson(expectedSeed) !== canonicalJson(seed)) {
        fail(`SGOS process '${processId}' has a conflicting interrupted creation seed.`,
          'SGOS_PROCESS_CREATION_SEED_CONFLICT');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      seed = sealSgosProcessCreationSeed(value);
      await assertSgosStoredAuthorityAndMaterialization(root, seed);
      await assertReferencedRecords(root, seed);
      // Persist the exact seed first so retries can retain its timestamp and derive the same
      // content-addressed genesis after crashes at any later publication boundary.
      await writeSafeAtomic(root, target, canonicalJson(seed));
    }
    await assertSgosStoredAuthorityAndMaterialization(root, seed);
    await assertReferencedRecords(root, seed);
    const programReservation = await readRecordReservation(
      root, processId, 'gvm-program', seed.programSha256
    );
    const bindingReservation = await readRecordReservation(
      root, processId, 'process-binding', seed.processBindingSha256
    );
    if (programReservation === null || bindingReservation === null) {
      fail('SGOS Process genesis is missing its exact Program or Binding capacity reservation.',
        'SGOS_RECORD_RESERVATION_INVALID', {
          programReserved: programReservation !== null,
          bindingReserved: bindingReservation !== null
        });
    }
    const emptyIndex = sealSgosRecordIndex(processId, null, []);
    await assertSgosRecordIndexEdge(root, processId, emptyIndex, null);
    const { index: baselineIndex, reservations: genesisReservations } =
      await prepareSgosRecordIndex(root, processId, emptyIndex, [
        programReservation.token, bindingReservation.token
      ]);
    const promoted = clone(seed);
    promoted.processRevision = 2;
    promoted.updatedAt = seed.updatedAt;
    promoted.recordIndexSha256 = baselineIndex.recordIndexSha256;
    const event = sealControlEvent(seed, promoted, {
      beforeProcessSha256: seed.processSha256,
      priorControlEventSha256: null,
      controlDepth: 1,
      operatorTransitionCount: 0
    });
    const candidateState = processFromControlEvent(seed, event);
    const successor = await prepareSgosControlSuccessor(root, processId, {
      processId,
      beforeProcessSha256: seed.processSha256,
      controlEventSha256: event.controlEventSha256,
      controlDepth: event.controlDepth,
      operatorTransitionCount: event.operatorTransitionCount
    }, {
      event,
      publishedIndexes: [emptyIndex, baselineIndex],
      candidateState
    });
    // Admission is complete before the first immutable infrastructure byte is published.
    await publishPreparedRecordIndexes(root, processId, [emptyIndex, baselineIndex]);
    await putSgosImmutableRecord(root, processId, 'sgos-control-event', event);
    await putPreparedSgosControlSuccessor(root, processId, successor);
    const reconciled = await reconcileSgosControlLineage(root, seed);
    if (reconciled.replayedTransitions !== 1
        || reconciled.state.controlEventSha256 !== event.controlEventSha256) {
      fail(`SGOS process '${processId}' genesis did not publish an exact control successor.`,
        'SGOS_CONTROL_LINEAGE_INVALID');
    }
    await assertReferencedRecords(root, reconciled.state);
    await writeSafeAtomic(root, target, canonicalJson(reconciled.state));
    injectSgosStoreFault('genesis-state');
    await consumeRecordReservations(root, genesisReservations);
    return Object.freeze(reconciled.state);
  });
}

async function readSgosProcessUnlocked(root, id, {
  controlDiagnostics = null,
  diagnosticsOnly = false
} = {}) {
  let raw;
  try {
    raw = await readSafeFile(root, sgosProcessStatePath(root, id));
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`SGOS process '${id}' is unavailable.`, 'SGOS_PROCESS_NOT_FOUND');
    throw error;
  }
  let stored;
  try { stored = JSON.parse(raw); } catch {
    fail(`SGOS process '${id}' is not valid JSON.`, 'SGOS_PROCESS_CORRUPT');
  }
  if (stored?.processId !== id
      || stored.processSha256 !== hashWithout(stored, 'processSha256')) {
    fail(`SGOS process '${id}' failed its stored-byte integrity check.`, 'SGOS_PROCESS_CORRUPT');
  }
  const loaded = readRecord('gvm-process', raw);
  if (loaded.storedVersion === currentSchemaVersion('gvm-process')
      && canonicalJson(loaded.record) !== raw) {
    fail(`SGOS process '${id}' is not stored in canonical exact-byte form.`,
      'SGOS_PROCESS_CORRUPT');
  }
  let state = loaded.storedVersion === currentSchemaVersion('gvm-process')
    ? loaded.record
    : sealProcess(loaded.record);
  assertProcessShape(state);
  if (state.processId !== id || state.processSha256 !== hashWithout(state, 'processSha256')) {
    fail(`SGOS process '${id}' failed its integrity check.`, 'SGOS_PROCESS_CORRUPT');
  }
  try { validateSgosRecord(state); } catch (error) {
    fail(`SGOS process '${id}' failed its strict contract.`, 'SGOS_PROCESS_CORRUPT', {
      cause: error?.message ?? String(error)
    });
  }
  if (loaded.storedVersion === currentSchemaVersion('gvm-process')
      && state.controlEventSha256 === null) {
    fail(`SGOS process '${id}' has no immutable genesis control head.`,
      'SGOS_CONTROL_LINEAGE_INVALID', {
        processId: id,
        processRevision: state.processRevision
      });
  }
  // Fsck needs the strict, self-hashed current Process even when a referenced head record is the
  // corrupted item it is being asked to diagnose. It performs the complete bounded lineage and
  // physical census itself below; ordinary reads never use this branch.
  if (diagnosticsOnly && loaded.storedVersion === currentSchemaVersion('gvm-process')) {
    return Object.freeze(state);
  }
  const storedProcessSha256 = stored.processSha256;
  if (loaded.storedVersion < currentSchemaVersion('gvm-process')) {
    // A content-addressed event is not itself an authoritative transition: publication is only
    // complete once the exact predecessor-keyed successor exists.  In particular, a crash after
    // writing the deterministic v2 root event must not let an ordinary read return a migrated
    // Process with a null control head.
    const successor = await readSgosControlSuccessor(root, id, storedProcessSha256);
    if (successor === null) {
      fail(`SGOS process '${id}' requires an exact control-lineage upgrade before it can run.`,
        'SGOS_PROCESS_CONTROL_UPGRADE_REQUIRED', {
          processId: id,
          storedVersion: loaded.storedVersion,
          expectedProcessSha256: storedProcessSha256
        });
    }
  }
  const reconciled = await reconcileSgosControlLineage(root, state, {
    baselineProcessSha256: loaded.storedVersion < currentSchemaVersion('gvm-process')
      ? storedProcessSha256
      : state.processSha256,
    legacyBaseline: loaded.storedVersion < currentSchemaVersion('gvm-process')
  });
  if (loaded.storedVersion < currentSchemaVersion('gvm-process')
      && (reconciled.replayedTransitions < 1
        || reconciled.state.controlEventSha256 === null)) {
    fail(`SGOS process '${id}' has no complete immutable control-lineage upgrade.`,
      'SGOS_PROCESS_CONTROL_UPGRADE_REQUIRED', {
        processId: id,
        storedVersion: loaded.storedVersion,
        expectedProcessSha256: storedProcessSha256
      });
  }
  state = reconciled.state;
  if (controlDiagnostics) {
    controlDiagnostics.successorLookups = reconciled.successorLookups;
    controlDiagnostics.replayedTransitions = reconciled.replayedTransitions;
  }
  await assertHotReferencedRecords(root, state);
  return Object.freeze(state);
}

export async function readSgosProcess(root, processId) {
  const id = requireProcessId(processId);
  return withProcessLock(root, id, () => readSgosProcessUnlocked(root, id), 2_000, {
    createDirectory: false
  });
}

/** @internal Read-only test/doctor instrumentation; omitted from the supported SGOS barrel. */
export async function inspectSgosControlLineage(root, processId) {
  const id = requireProcessId(processId);
  const diagnostics = {};
  const state = await withProcessLock(
    root, id,
    () => readSgosProcessUnlocked(root, id, { controlDiagnostics: diagnostics }),
    2_000, { createDirectory: false }
  );
  return Object.freeze({
    processId: id,
    processRevision: state.processRevision,
    controlEventSha256: state.controlEventSha256,
    successorLookups: diagnostics.successorLookups,
    replayedTransitions: diagnostics.replayedTransitions
  });
}

/**
 * @internal Establish the immutable control-lineage root for an unshipped/interrupted-development
 * v2 Process. This is deliberately a separate exact-hash mutation: ordinary reads never rewrite
 * the Process or invent upgrade time. Shipped v1 Processes remain quarantined by the registry.
 */
export async function upgradeSgosProcessControlLineage(root, processId, {
  expectedProcessSha256
} = {}) {
  const id = requireProcessId(processId);
  requireSha256('expectedProcessSha256', expectedProcessSha256);
  return withProcessLock(root, id, async () => {
    const raw = await readSafeFile(root, sgosProcessStatePath(root, id));
    let stored;
    try { stored = JSON.parse(raw); } catch {
      fail(`SGOS process '${id}' is not valid JSON.`, 'SGOS_PROCESS_CORRUPT');
    }
    if (stored?.processId !== id
        || stored.processSha256 !== hashWithout(stored, 'processSha256')) {
      fail(`SGOS process '${id}' failed its stored-byte integrity check.`, 'SGOS_PROCESS_CORRUPT');
    }
    const loaded = readRecord('gvm-process', raw);
    if (loaded.storedVersion === currentSchemaVersion('gvm-process')) {
      // A retry after the final state publication is idempotent only for the exact v2 predecessor
      // and its root event.  A normal v3 Process, or a Process advanced after upgrade, is not an
      // excuse to weaken the exact-hash API.
      const successor = await readSgosControlSuccessor(root, id, expectedProcessSha256);
      if (successor !== null && stored.controlEventSha256 === successor.controlEventSha256) {
        return readSgosProcessUnlocked(root, id);
      }
      fail(`SGOS process '${id}' changed before its control-lineage upgrade.`,
        'SGOS_PROCESS_REVISION_STALE', {
          expectedProcessSha256,
          actualProcessSha256: stored.processSha256
        });
    }
    if (loaded.storedVersion !== 2) {
      fail(`SGOS process '${id}' cannot be upgraded by this build.`,
        'SGOS_PROCESS_CONTROL_UPGRADE_REQUIRED', { storedVersion: loaded.storedVersion });
    }
    if (stored.processSha256 !== expectedProcessSha256) {
      fail(`SGOS process '${id}' changed before its control-lineage upgrade.`,
        'SGOS_PROCESS_REVISION_STALE', {
          expectedProcessSha256,
          actualProcessSha256: stored.processSha256
        });
    }
    const migrated = sealProcess(loaded.record);
    assertProcessShape(migrated);
    try { validateSgosRecord(migrated); } catch (error) {
      fail(`SGOS process '${id}' failed its strict contract.`, 'SGOS_PROCESS_CORRUPT', {
        cause: error?.message ?? String(error)
      });
    }
    await assertSgosStoredAuthorityAndMaterialization(root, migrated);
    await assertReferencedRecords(root, migrated);
    // A legacy upgrade is the one deliberate full-census boundary. It validates every immutable
    // application/evidence record once, then roots that exact set in deterministic 64-entry
    // chunks so all later reads can remain bounded to the current edge.
    const baselineEntries = await snapshotAllIndexedRecords(root, id);
    const { index: baselineIndex, indexes: baselineIndexes } =
      await prepareSgosRecordIndexBaseline(root, id, baselineEntries);
    const promoted = clone(migrated);
    promoted.processRevision = migrated.processRevision + 1;
    // No clock is consulted: the schema-only promotion retains the last durable update time.
    // Re-derive and publish both records on every attempt. Content addressing and predecessor CAS
    // make retries converge after crashes before or after either immutable publication.
    promoted.updatedAt = migrated.updatedAt;
    promoted.recordIndexSha256 = baselineIndex.recordIndexSha256;
    const event = sealControlEvent(migrated, promoted, {
      beforeProcessSha256: stored.processSha256,
      priorControlEventSha256: null,
      controlDepth: 1,
      operatorTransitionCount: 0
    });
    const candidateState = processFromControlEvent(migrated, event);
    const successor = await prepareSgosControlSuccessor(root, id, {
      processId: id,
      beforeProcessSha256: stored.processSha256,
      controlEventSha256: event.controlEventSha256,
      controlDepth: event.controlDepth,
      operatorTransitionCount: event.operatorTransitionCount
    }, { event, publishedIndexes: baselineIndexes, candidateState });
    await publishPreparedRecordIndexes(root, id, baselineIndexes);
    await putSgosImmutableRecord(root, id, 'sgos-control-event', event);
    await putPreparedSgosControlSuccessor(root, id, successor);
    const reconciled = await reconcileSgosControlLineage(root, migrated, {
      baselineProcessSha256: stored.processSha256,
      legacyBaseline: true
    });
    if (reconciled.replayedTransitions < 1
        || reconciled.state.controlEventSha256 === null) {
      fail(`SGOS process '${id}' control-lineage upgrade did not publish an exact successor.`,
        'SGOS_PROCESS_CONTROL_UPGRADE_REQUIRED', {
          processId: id,
          expectedProcessSha256: stored.processSha256
        });
    }
    await assertReferencedRecords(root, reconciled.state);
    await writeSafeAtomic(
      root, sgosProcessStatePath(root, id), canonicalJson(reconciled.state)
    );
    return Object.freeze(reconciled.state);
  }, 2_000, { createDirectory: false });
}

/**
 * Subject-locked compare-and-swap.  The revision is always incremented by this function, never by
 * callers, and every succeeded task is checked against its immutable receipt before publication.
 */
export async function mutateSgosProcess(root, processId, mutate, {
  expectedRevision,
  expectedProcessSha256 = null,
  updatedAt = null,
  recordReservations = []
} = {}) {
  const id = requireProcessId(processId);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    fail('SGOS process mutation requires an exact expectedRevision.', 'SGOS_PROCESS_REVISION_REQUIRED');
  }
  return withProcessLock(root, id, async () => {
    const current = await readSgosProcessUnlocked(root, id);
    const pendingIntent = await readSgosTransitionIntent(root, id);
    if (pendingIntent !== null) {
      const recovered = await reconcileSgosTransitionIntent(root, current, pendingIntent);
      fail('A prior exact SGOS transition was recovered. Retry this operation against the recovered revision.',
        'SGOS_TRANSITION_RECOVERED_RETRY', {
          processId: id,
          processRevision: recovered.processRevision,
          processSha256: recovered.processSha256,
          intentSha256: pendingIntent.intentSha256
        });
    }
    if (current.processRevision !== expectedRevision
        || (expectedProcessSha256 != null && current.processSha256 !== expectedProcessSha256)) {
      fail(`SGOS process '${id}' changed before this operation could commit.`, 'SGOS_PROCESS_REVISION_STALE', {
        expectedRevision,
        actualRevision: current.processRevision,
        expectedProcessSha256,
        actualProcessSha256: current.processSha256
      });
    }
    const draft = clone(current);
    const collector = { active: true, tokens: [] };
    let returned;
    try {
      returned = await RECORD_DELTA_CONTEXT.run(
        collector, () => mutate(draft, current)
      );
    } finally {
      collector.active = false;
    }
    const next = returned ?? draft;
    assertImmutableCore(current, next);
    next.schemaVersion = currentSchemaVersion('gvm-process');
    next.kind = 'gvm-process';
    next.processRevision = current.processRevision + 1;
    next.updatedAt = updatedAt ?? nowIso();
    delete next.processSha256;
    assertProcessShape(next);
    const suppliedTokens = [...recordReservations, ...collector.tokens];
    const { index: currentIndex } = await readSgosRecordIndexHead(
      root, id, current.recordIndexSha256
    );
    const committedTokens = [];
    const pendingTokens = [];
    const headDelta = new Set(currentIndex.delta
      .map((entry) => `${entry.family}\u0000${entry.recordSha256}`));
    for (const token of suppliedTokens) {
      const identity = `${token?.family}\u0000${token?.recordSha256}`;
      if (headDelta.has(identity)
          || (token?.checkRootedHistory === true && await isRootedRecord(
            root, id, currentIndex.recordIndexSha256, token?.family, token?.recordSha256
          ))) committedTokens.push(token);
      else pendingTokens.push(token);
    }
    const committedReservations = await exactReservedIndexEntries(root, id, committedTokens);
    // A state publication may crash immediately before reservation cleanup. Reasserting that exact
    // token is an idempotent cleanup, never a duplicate index delta or byte/count increment.
    await consumeRecordReservations(root, committedReservations);
    const { index: nextIndex, reservations } = await prepareSgosRecordIndex(
      root, id, currentIndex, pendingTokens
    );
    next.recordIndexSha256 = nextIndex.recordIndexSha256;
    await assertTransitionIndexDelta(root, current, next, nextIndex);
    await assertHotReferencedRecords(root, next);
    const controlPosition = await nextSgosControlPosition(root, current, next);
    const controlEvent = sealControlEvent(current, next, controlPosition);
    next.controlEventSha256 = controlEvent.controlEventSha256;
    const sealed = sealProcess(next);
    try { validateSgosRecord(sealed); } catch (error) {
      fail('SGOS Process mutation produced an invalid durable Process.',
        'SGOS_PROCESS_CORRUPT', { cause: error?.message ?? String(error) });
    }
    const successor = await prepareSgosControlSuccessor(root, id, {
      processId: id,
      beforeProcessSha256: current.processSha256,
      controlEventSha256: controlEvent.controlEventSha256,
      controlDepth: controlEvent.controlDepth,
      operatorTransitionCount: controlEvent.operatorTransitionCount
    }, { event: controlEvent, publishedIndexes: [nextIndex], candidateState: sealed });
    const intent = sealSgosTransitionIntent({
      processId: id,
      beforeProcessSha256: current.processSha256,
      beforeProcessRevision: current.processRevision,
      priorRecordIndexSha256: current.recordIndexSha256,
      reservations: reservations.map((reservation) => reservation.token),
      nextRecordIndexSha256: nextIndex.recordIndexSha256,
      controlEvent,
      successorSha256: successor.successorSha256,
      candidateProcessSha256: sealed.processSha256
    });
    await assertTransitionIntentCapacity(root, id, {
      index: nextIndex, successor, candidateState: sealed, intent
    });
    try {
      await writeSgosTransitionIntent(root, id, intent);
      injectSgosStoreFault('transition-intent');
      return await publishSgosTransitionIntent(root, current, intent, {
        preparedIndex: nextIndex,
        preparedSuccessor: successor,
        preparedState: sealed,
        preparedReservations: reservations
      });
    } catch (error) {
      return throwSgosTransitionRecoveryRequired(root, id, intent, error);
    }
  });
}

export async function readSgosCheckpoint(root, processId, checkpointSha256) {
  return readSgosImmutableRecord(root, processId, 'gvm-checkpoint', checkpointSha256);
}

export async function readSgosProgram(root, processId, programSha256) {
  return readSgosImmutableRecord(root, processId, 'gvm-program', programSha256);
}

/**
 * Read-only integrity census. Normal runtime reads validate only the rooted head edge; fsck is the
 * explicit bounded operation that walks complete indexed and physical authority and reports
 * unindexed crash leftovers without deleting, adopting, or repairing them.
 */
export async function fsckSgosProcess(root, processId) {
  const id = requireProcessId(processId);
  return withProcessLock(root, id, async () => {
    const state = await readSgosProcessUnlocked(root, id, { diagnosticsOnly: true });
    const errors = [];
    let transitionIntent = null;
    try { transitionIntent = await readSgosTransitionIntent(root, id); } catch (error) {
      errors.push(Object.freeze({
        code: error?.code ?? 'SGOS_TRANSITION_INTENT_CORRUPT',
        message: error?.message ?? String(error)
      }));
    }
    const authoritative = new Map();
    const indexes = [];
    let cursor = state.recordIndexSha256;
    let newer = null;
    for (let depth = 0; cursor !== null && depth <= MAX_PROCESS_RECORDS; depth += 1) {
      let index;
      try {
        ({ record: index } = await readSgosImmutableRecord(
          root, id, 'sgos-record-index', cursor
        ));
        if (newer !== null) await assertSgosRecordIndexEdge(root, id, newer, index);
      } catch (error) {
        errors.push(Object.freeze({
          code: error?.code ?? 'SGOS_RECORD_INDEX_INVALID',
          message: error?.message ?? String(error),
          recordIndexSha256: cursor
        }));
        break;
      }
      indexes.push(index);
      for (const entry of index.delta) {
        const identity = `${entry.family}\u0000${entry.recordSha256}`;
        if (authoritative.has(identity)) {
          errors.push(Object.freeze({
            code: 'SGOS_RECORD_INDEX_DUPLICATE',
            message: `Indexed record '${entry.recordSha256}' appears more than once.`,
            family: entry.family,
            recordSha256: entry.recordSha256
          }));
        } else {
          authoritative.set(identity, entry);
        }
      }
      newer = index;
      cursor = index.priorIndexSha256;
    }
    if (cursor !== null) {
      errors.push(Object.freeze({
        code: 'SGOS_RECORD_INDEX_LIMIT',
        message: 'Record-index traversal exceeded the installed Process record ceiling.'
      }));
    } else if (newer !== null) {
      try { await assertSgosRecordIndexEdge(root, id, newer, null); } catch (error) {
        errors.push(Object.freeze({
          code: error?.code ?? 'SGOS_RECORD_INDEX_INVALID',
          message: error?.message ?? String(error),
          recordIndexSha256: newer.recordIndexSha256
        }));
      }
    }
    const headIndex = indexes[0] ?? null;
    const reconstructedFamilyCounts = {};
    let reconstructedIndexedBytes = 0;
    for (const entry of authoritative.values()) {
      reconstructedFamilyCounts[entry.family] =
        (reconstructedFamilyCounts[entry.family] ?? 0) + 1;
      reconstructedIndexedBytes += entry.bytes;
    }
    const normalizedReconstructedCounts = Object.fromEntries(
      Object.entries(reconstructedFamilyCounts)
        .sort(([left], [right]) => compareSgosCodePoints(left, right))
    );
    if (headIndex == null
        || headIndex.totalRecordCount !== authoritative.size
        || headIndex.totalBytes !== reconstructedIndexedBytes
        || canonicalJson(headIndex.familyCounts) !== canonicalJson(normalizedReconstructedCounts)) {
      errors.push(Object.freeze({
        code: 'SGOS_RECORD_INDEX_INVALID',
        message: 'Record-index cumulative counters do not match reconstructed rooted deltas.'
      }));
    }

    const rootedEvents = new Map();
    const rootedSuccessors = new Map();
    let eventCursor = state.controlEventSha256;
    for (let depth = 0; eventCursor !== null && depth <= MAX_CONTROL_RECORDS; depth += 1) {
      try {
        const { record: event } = await readSgosImmutableRecord(
          root, id, 'sgos-control-event', eventCursor
        );
        const successor = await readSgosControlSuccessor(root, id, event.beforeProcessSha256);
        if (successor == null || successor.controlEventSha256 !== event.controlEventSha256
            || successor.controlDepth !== event.controlDepth
            || successor.operatorTransitionCount !== event.operatorTransitionCount) {
          fail('Control event has no exact predecessor-keyed successor.',
            'SGOS_CONTROL_LINEAGE_INVALID');
        }
        rootedEvents.set(event.controlEventSha256, event);
        rootedSuccessors.set(event.beforeProcessSha256, successor);
        eventCursor = event.priorControlEventSha256;
      } catch (error) {
        errors.push(Object.freeze({
          code: error?.code ?? 'SGOS_CONTROL_LINEAGE_INVALID',
          message: error?.message ?? String(error),
          controlEventSha256: eventCursor
        }));
        break;
      }
    }
    if (eventCursor !== null) {
      errors.push(Object.freeze({
        code: 'SGOS_CONTROL_LINEAGE_LIMIT',
        message: 'Control-lineage traversal exceeded the installed transition ceiling.'
      }));
    }
    if (state.controlEventSha256 === null) {
      if (state.processRevision !== 1) {
        errors.push(Object.freeze({
          code: 'SGOS_CONTROL_LINEAGE_INVALID',
          message: 'SGOS Process has no immutable control head for its mutable revision.'
        }));
      }
    } else {
      const headEvent = rootedEvents.get(state.controlEventSha256) ?? null;
      if (headEvent !== null) {
        try {
          if (headEvent.recordIndexSha256 !== state.recordIndexSha256
              || headEvent.beforeProcessRevision + 1 !== state.processRevision) {
            fail('SGOS Process state does not bind the exact current control head.',
              'SGOS_CONTROL_LINEAGE_INVALID');
          }
          const reconstructed = processFromControlEvent(state, headEvent);
          if (reconstructed.processSha256 !== state.processSha256) {
            fail('SGOS Process mutable state does not match its immutable control event.',
              'SGOS_CONTROL_LINEAGE_INVALID');
          }
        } catch (error) {
          errors.push(Object.freeze({
            code: error?.code ?? 'SGOS_CONTROL_LINEAGE_INVALID',
            message: error?.message ?? String(error),
            controlEventSha256: state.controlEventSha256
          }));
        }
      }
    }
    const chronologicalEvents = [...rootedEvents.values()].reverse();
    const indexBySha256 = new Map(indexes.map((index) => [index.recordIndexSha256, index]));
    let reconstructedInfrastructureBytes = 0;
    let reconstructedInfrastructureRecords = 0;
    let priorEvent = null;
    for (const event of chronologicalEvents) {
      const expectedPriorEventSha256 = priorEvent?.controlEventSha256 ?? null;
      if (event.priorControlEventSha256 !== expectedPriorEventSha256
          || event.controlDepth !== (priorEvent?.controlDepth ?? 0) + 1) {
        errors.push(Object.freeze({
          code: 'SGOS_CONTROL_LINEAGE_INVALID',
          message: 'Control event does not extend the reconstructed predecessor chain.',
          controlEventSha256: event.controlEventSha256
        }));
      }
      const priorIndexSha256 = priorEvent?.recordIndexSha256 ?? null;
      let indexCursor = event.recordIndexSha256;
      const introducedIndexes = [];
      while (indexCursor !== priorIndexSha256) {
        const index = indexBySha256.get(indexCursor);
        if (index == null) {
          errors.push(Object.freeze({
            code: 'SGOS_RECORD_INDEX_INVALID',
            message: 'Control event references an index outside the rooted index chain.',
            controlEventSha256: event.controlEventSha256,
            recordIndexSha256: indexCursor
          }));
          break;
        }
        introducedIndexes.push(index);
        indexCursor = index.priorIndexSha256;
      }
      const successor = rootedSuccessors.get(event.beforeProcessSha256);
      reconstructedInfrastructureBytes += introducedIndexes.reduce(
        (total, index) => total + Buffer.byteLength(canonicalJson(index)), 0
      ) + Buffer.byteLength(canonicalJson(event))
        + Buffer.byteLength(canonicalJson(successor));
      reconstructedInfrastructureRecords += introducedIndexes.length + 2;
      if (successor?.cumulativeInfrastructureBytes !== reconstructedInfrastructureBytes
          || successor?.cumulativeInfrastructureRecords !== reconstructedInfrastructureRecords) {
        errors.push(Object.freeze({
          code: 'SGOS_CONTROL_LINEAGE_INVALID',
          message: 'Control successor cumulative infrastructure counters do not reconstruct.',
          controlEventSha256: event.controlEventSha256
        }));
      }
      priorEvent = event;
    }
    const disk = new Map();
    let physicalEntriesScanned = 0;
    let physicalLimitExceeded = false;
    for (const familyId of SGOS_RECORD_INDEX_FAMILIES) {
      const family = IMMUTABLE_FAMILIES[familyId];
      const directory = path.join(sgosProcessDirectory(root, id), family.directory);
      let entries = [];
      try {
        await safeSgosDirectory(root, directory);
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      if (physicalEntriesScanned + entries.length > MAX_PROCESS_RECORDS) {
        errors.push(Object.freeze({
          code: 'SGOS_RECORD_SCAN_LIMIT',
          message: 'Physical SGOS record census exceeds the aggregate installed entry ceiling.'
        }));
        physicalLimitExceeded = true;
        break;
      }
      physicalEntriesScanned += entries.length;
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink()
            || !/^[a-f0-9]{64}\.json$/.test(entry.name)) {
          errors.push(Object.freeze({
            code: 'SGOS_SIDECAR_PATH_UNSAFE',
            message: `Unrecognized ${familyId} entry '${entry.name}'.`
          }));
          continue;
        }
        const sha256 = `sha256:${entry.name.slice(0, -'.json'.length)}`;
        const identity = `${familyId}\u0000${sha256}`;
        try {
          const { record, bytes } = await readSgosImmutableRecord(
            root, id, familyId, sha256
          );
          disk.set(identity, Object.freeze({
            ...recordIndexEntry(familyId, record), bytes
          }));
        } catch (error) {
          errors.push(Object.freeze({
            code: error?.code ?? 'SGOS_RECORD_CORRUPT',
            message: error?.message ?? String(error),
            family: familyId,
            recordSha256: sha256
          }));
        }
      }
    }
    const missing = [...authoritative.entries()]
      .filter(([identity]) => !disk.has(identity))
      .map(([, entry]) => Object.freeze(clone(entry)))
      .sort(compareRecordIndexEntries);
    for (const [identity, expected] of authoritative.entries()) {
      const actual = disk.get(identity);
      if (actual != null && canonicalJson(actual) !== canonicalJson(expected)) {
        errors.push(Object.freeze({
          code: 'SGOS_RECORD_INDEX_INVALID',
          message: 'Indexed immutable record metadata does not match its exact stored bytes.',
          family: expected.family,
          recordSha256: expected.recordSha256,
          expected: Object.freeze(clone(expected)),
          actual: Object.freeze(clone(actual))
        }));
      }
    }
    const orphans = [...disk.entries()]
      .filter(([identity]) => !authoritative.has(identity))
      .map(([, entry]) => Object.freeze(clone(entry)))
      .sort(compareRecordIndexEntries);

    const physicalInfrastructure = new Map();
    if (!physicalLimitExceeded) {
      for (const [familyId, directoryName, rooted] of [
        ['sgos-record-index', 'record-indexes', new Set(indexBySha256.keys())],
        ['sgos-control-event', 'control-events', new Set(rootedEvents.keys())]
      ]) {
        const directory = path.join(sgosProcessDirectory(root, id), directoryName);
        let entries = [];
        try {
          await safeSgosDirectory(root, directory);
          entries = await readdir(directory, { withFileTypes: true });
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        if (physicalEntriesScanned + entries.length > MAX_PROCESS_RECORDS) {
          errors.push(Object.freeze({
            code: 'SGOS_RECORD_SCAN_LIMIT',
            message: 'Physical SGOS census exceeds the aggregate installed entry ceiling.'
          }));
          physicalLimitExceeded = true;
          break;
        }
        physicalEntriesScanned += entries.length;
        for (const entry of entries) {
          if (!entry.isFile() || entry.isSymbolicLink()
              || !/^[a-f0-9]{64}\.json$/.test(entry.name)) {
            errors.push(Object.freeze({
              code: 'SGOS_SIDECAR_PATH_UNSAFE',
              message: `Unrecognized ${familyId} entry '${entry.name}'.`
            }));
            continue;
          }
          const sha256 = `sha256:${entry.name.slice(0, -'.json'.length)}`;
          try {
            const { record, bytes } = await readSgosImmutableRecord(
              root, id, familyId, sha256
            );
            physicalInfrastructure.set(`${familyId}\u0000${sha256}`, Object.freeze({
              family: familyId, recordSha256: sha256, bytes, rooted: rooted.has(sha256), record
            }));
          } catch (error) {
            errors.push(Object.freeze({
              code: error?.code ?? 'SGOS_RECORD_CORRUPT',
              message: error?.message ?? String(error),
              family: familyId,
              recordSha256: sha256
            }));
          }
        }
      }
    }
    if (!physicalLimitExceeded) {
      const directory = path.join(sgosProcessDirectory(root, id), 'control-next');
      let entries = [];
      try {
        await safeSgosDirectory(root, directory);
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      if (physicalEntriesScanned + entries.length > MAX_PROCESS_RECORDS) {
        errors.push(Object.freeze({
          code: 'SGOS_RECORD_SCAN_LIMIT',
          message: 'Physical SGOS census exceeds the aggregate installed entry ceiling.'
        }));
      } else {
        physicalEntriesScanned += entries.length;
        for (const entry of entries) {
          if (!entry.isFile() || entry.isSymbolicLink()
              || !/^[a-f0-9]{64}\.json$/.test(entry.name)) {
            errors.push(Object.freeze({
              code: 'SGOS_SIDECAR_PATH_UNSAFE',
              message: `Unrecognized control-successor entry '${entry.name}'.`
            }));
            continue;
          }
          const beforeProcessSha256 = `sha256:${entry.name.slice(0, -'.json'.length)}`;
          try {
            const successor = await readSgosControlSuccessor(root, id, beforeProcessSha256);
            physicalInfrastructure.set(`sgos-control-successor\u0000${beforeProcessSha256}`,
              Object.freeze({
                family: 'sgos-control-successor',
                recordSha256: successor.successorSha256,
                bytes: Buffer.byteLength(canonicalJson(successor)),
                rooted: rootedSuccessors.has(beforeProcessSha256),
                record: successor
              }));
          } catch (error) {
            errors.push(Object.freeze({
              code: error?.code ?? 'SGOS_CONTROL_LINEAGE_INVALID',
              message: error?.message ?? String(error),
              family: 'sgos-control-successor',
              beforeProcessSha256
            }));
          }
        }
      }
    }
    orphans.push(...[...physicalInfrastructure.values()]
      .filter((entry) => !entry.rooted)
      .map(({ family, recordSha256, bytes }) => Object.freeze({
        family, recordSha256, bytes
      })));
    orphans.sort(compareRecordIndexEntries);
    const reservations = await listRecordReservations(root, id);
    const leaseFootprint = await readExecutionLeaseFootprint(root, id);
    if (physicalEntriesScanned + reservations.length + leaseFootprint.leaseRecords + 1
          + (transitionIntent === null ? 0 : 1)
        > MAX_PROCESS_RECORDS) {
      errors.push(Object.freeze({
        code: 'SGOS_RECORD_SCAN_LIMIT',
        message: 'Complete SGOS Process census exceeds the aggregate installed record ceiling.'
      }));
    }
    // A diagnostic must return the structured errors already collected when the head is absent or
    // corrupt; do not perform a second unconditional authority read that masks the fsck report.
    const headEvent = rootedEvents.get(state.controlEventSha256) ?? null;
    const headSuccessor = headEvent == null
      ? null
      : rootedSuccessors.get(headEvent.beforeProcessSha256) ?? null;
    const indexBytes = indexes.reduce(
      (total, index) => total + Buffer.byteLength(canonicalJson(index)), 0
    );
    const status = errors.length || missing.length
      ? 'failed'
      : orphans.length || reservations.length || transitionIntent !== null
        ? 'attention'
        : 'ok';
    return Object.freeze({
      schemaVersion: 1,
      kind: 'sgos-process-fsck',
      processId: id,
      processSha256: state.processSha256,
      recordIndexSha256: state.recordIndexSha256,
      status,
      indexedRecordCount: authoritative.size,
      indexedBytes: indexes[0]?.totalBytes ?? 0,
      reconstructedIndexedBytes,
      indexRecordCount: indexes.length,
      indexBytes,
      reconstructedInfrastructureBytes,
      reconstructedInfrastructureRecords,
      cumulativeInfrastructureBytes: headSuccessor?.cumulativeInfrastructureBytes ?? null,
      cumulativeInfrastructureRecords: headSuccessor?.cumulativeInfrastructureRecords ?? null,
      missing: Object.freeze(missing),
      orphans: Object.freeze(orphans),
      pendingReservations: Object.freeze(reservations.map((reservation) => Object.freeze({
        ...reservation.entry,
        path: quarantinePathLabel(root, reservation.path)
      }))),
      transitionIntent: transitionIntent == null ? null : Object.freeze({
        intentSha256: transitionIntent.intentSha256,
        beforeProcessSha256: transitionIntent.beforeProcessSha256,
        candidateProcessSha256: transitionIntent.candidateProcessSha256,
        nextRecordIndexSha256: transitionIntent.nextRecordIndexSha256,
        reservationCount: transitionIntent.reservations.length
      }),
      errors: Object.freeze(errors),
      repaired: false,
      deleted: false
    });
  }, 5_000, { createDirectory: false });
}

/** A bounded, deterministic local-runtime listing; it never scans or interprets Story authority. */
export async function listSgosProcesses(root) {
  const directory = path.join(gitCommonDir(root), 'singularity-flow', 'sgos', 'processes');
  let entries;
  try {
    await safeSgosDirectory(root, directory);
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze([]);
    throw error;
  }
  const ids = entries.filter((entry) => entry.isDirectory()).map((entry) => {
    try { return decodeURIComponent(entry.name); } catch { return null; }
  }).filter((id) => id && ID.test(id)).sort();
  const states = [];
  for (const id of ids) {
    try {
      states.push(await readSgosProcess(root, id));
    } catch (error) {
      // Listing is an inventory boundary, not an authority bypass. Keep healthy Processes visible
      // while representing each refused/private Process as an explicit unavailable diagnostic; no
      // bytes are repaired, migrated, restored, or treated as runnable state here.
      states.push(Object.freeze({
        kind: 'sgos-process-unavailable',
        processId: id,
        available: false,
        availability: 'unavailable',
        status: 'unavailable',
        processRevision: null,
        processSha256: null,
        taskInstances: Object.freeze({}),
        openHumanRequests: Object.freeze([]),
        error: Object.freeze({
          code: error?.code ?? 'SGOS_PROCESS_UNAVAILABLE',
          message: error?.message ?? String(error)
        }),
        inspectionCommand: `singularity-flow process quarantine ${id} --json`,
        successClaimed: false,
        resumable: false
      }));
    }
  }
  return Object.freeze(states);
}

export const SGOS_IMMUTABLE_RECORD_FAMILIES = Object.freeze([
  ...Object.keys(IMMUTABLE_FAMILIES), 'sgos-control-successor'
]);
