/**
 * Versioned SGOS Operational Store SPI and bounded reconstructable replay profiles.
 *
 * Operational state is reconstructable runtime state, never lifecycle or Program authority. The
 * first alternate profile is deliberately ephemeral and admitted only for simulation and tests.
 * It is useful for deterministic replay/conformance without making an in-memory result eligible to
 * authorize a governed mutation.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat, mkdir, open, readFile, readdir, rename, stat, unlink
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { canonicalJson } from '../records.mjs';
import { SingularityFlowError } from '../util.mjs';

export const SGOS_OPERATIONAL_STORE_SPI_VERSION = 1;
export const SGOS_OPERATIONAL_STORE_METHODS = Object.freeze([
  'descriptor', 'doctor', 'read', 'transact', 'verify', 'exportBackup',
  'planRestore', 'restore', 'planRollback', 'rollback'
]);
export const SGOS_OPERATIONAL_STORE_CAPABILITIES = Object.freeze({
  authorityEligible: false,
  compareAndSwap: true,
  appendOnlyLineage: true,
  serializedWriters: true,
  livenessRecovery: true,
  boundedRecords: true,
  schemaValidation: true,
  backupRestore: true,
  rollback: true
});

const MEMORY_PROFILE = 'memory-replay-v1';
const FILESYSTEM_PROFILE = 'filesystem-replay-v1';
const FORMAT_VERSION = 1;
const MAXIMUM_ENTRIES = 2_000;
const MAXIMUM_EVENTS = 20_000;
const MAXIMUM_BYTES = 8 * 1024 * 1024;
const ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;

function fail(message, code = 'SGOS_OPERATIONAL_STORE_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exact(value, keys, label) {
  if (!plain(value)) fail(`${label} must be an object.`);
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) fail(`${label} contains unsupported field '${unexpected[0]}'.`);
}

function clone(value) {
  return structuredClone(value);
}

function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function sealed(core, hashField) {
  const result = { ...core, [hashField]: digest(core) };
  return Object.freeze(result);
}

function sortedEntries(entries) {
  return Object.fromEntries(Object.entries(entries).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0));
}

function state(storeId, revision, eventSha256, entries) {
  const canonicalEntries = sortedEntries(clone(entries));
  return sealed({
    format: 'sflow.sgos.operational-state',
    formatVersion: FORMAT_VERSION,
    storeId,
    revision,
    eventSha256,
    entriesSha256: digest(canonicalEntries),
    entries: canonicalEntries
  }, 'stateSha256');
}

function bounded(value, maximumBytes, label) {
  let bytes;
  try { bytes = Buffer.byteLength(canonicalJson(value), 'utf8'); } catch (error) {
    throw new SingularityFlowError(`${label} is not canonical JSON.`, {
      code: 'SGOS_OPERATIONAL_STORE_INVALID', cause: error
    });
  }
  if (bytes > maximumBytes) {
    fail(`${label} exceeds the installed ${maximumBytes}-byte ceiling.`,
      'SGOS_OPERATIONAL_STORE_LIMIT', { bytes, maximumBytes });
  }
  return bytes;
}

function normalizedChanges(changes, entries) {
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 128) {
    fail('Operational transaction requires 1..128 changes.');
  }
  const result = changes.map((change, index) => {
    exact(change, ['op', 'key', 'value'], `changes[${index}]`);
    if (!['put', 'delete'].includes(change.op) || !KEY.test(String(change.key ?? ''))) {
      fail(`changes[${index}] has an invalid operation or key.`);
    }
    if (change.op === 'put') {
      if (!Object.hasOwn(change, 'value')) fail(`changes[${index}] put requires value.`);
      bounded(change.value, MAXIMUM_BYTES, `changes[${index}].value`);
      return { op: 'put', key: change.key, value: clone(change.value) };
    }
    if (Object.hasOwn(change, 'value')) fail(`changes[${index}] delete cannot include value.`);
    if (!Object.hasOwn(entries, change.key)) {
      fail(`Operational key '${change.key}' does not exist.`,
        'SGOS_OPERATIONAL_STORE_DELETE_MISSING');
    }
    return { op: 'delete', key: change.key };
  }).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  for (let index = 1; index < result.length; index += 1) {
    if (result[index - 1].key === result[index].key) {
      fail(`Operational key '${result[index].key}' is changed more than once.`);
    }
  }
  return result;
}

function apply(entries, changes) {
  const next = clone(entries);
  for (const change of changes) {
    if (change.op === 'put') next[change.key] = clone(change.value);
    else delete next[change.key];
  }
  if (Object.keys(next).length > MAXIMUM_ENTRIES) {
    fail(`Operational Store exceeds the installed ${MAXIMUM_ENTRIES}-entry ceiling.`,
      'SGOS_OPERATIONAL_STORE_LIMIT');
  }
  bounded(next, MAXIMUM_BYTES, 'Operational Store state');
  return sortedEntries(next);
}

function event(storeId, before, operation, changes, nextEntries, extra = {}) {
  return sealed({
    format: 'sflow.sgos.operational-event',
    formatVersion: FORMAT_VERSION,
    storeId,
    revision: before.revision + 1,
    priorEventSha256: before.eventSha256,
    beforeStateSha256: before.stateSha256,
    afterEntriesSha256: digest(nextEntries),
    operation,
    changes: clone(changes),
    ...extra
  }, 'eventSha256');
}

function validateEvent(value, storeId, before) {
  exact(value, [
    'format', 'formatVersion', 'storeId', 'revision', 'priorEventSha256',
    'beforeStateSha256', 'afterEntriesSha256', 'operation', 'changes',
    'rollbackRevision', 'eventSha256'
  ], 'Operational event');
  if (value.format !== 'sflow.sgos.operational-event' || value.formatVersion !== FORMAT_VERSION
      || value.storeId !== storeId || value.revision !== before.revision + 1
      || value.priorEventSha256 !== before.eventSha256
      || value.beforeStateSha256 !== before.stateSha256
      || !SHA256.test(String(value.afterEntriesSha256 ?? ''))
      || !SHA256.test(String(value.eventSha256 ?? ''))
      || !['transact', 'rollback'].includes(value.operation)) {
    fail('Operational event lineage is invalid.', 'SGOS_OPERATIONAL_STORE_CORRUPT');
  }
  if (digest(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'eventSha256')))
      !== value.eventSha256) {
    fail('Operational event digest is invalid.', 'SGOS_OPERATIONAL_STORE_CORRUPT');
  }
  if (value.operation === 'rollback') {
    if (!Number.isSafeInteger(value.rollbackRevision) || value.rollbackRevision < 0) {
      fail('Operational rollback event is invalid.', 'SGOS_OPERATIONAL_STORE_CORRUPT');
    }
  } else if (Object.hasOwn(value, 'rollbackRevision')) {
    fail('Operational transaction event cannot claim rollback.',
      'SGOS_OPERATIONAL_STORE_CORRUPT');
  }
  return normalizedChanges(value.changes, before.entries);
}

function replay(storeId, events) {
  let head = state(storeId, 0, null, {});
  const states = [head];
  for (const raw of events) {
    const changes = validateEvent(raw, storeId, head);
    const entries = apply(head.entries, changes);
    if (digest(entries) !== raw.afterEntriesSha256) {
      fail('Operational event after-state digest is invalid.',
        'SGOS_OPERATIONAL_STORE_CORRUPT');
    }
    head = state(storeId, raw.revision, raw.eventSha256, entries);
    states.push(head);
  }
  return { head, states };
}

function validateBackup(value, expectedStoreId, expectedProfile) {
  exact(value, [
    'format', 'formatVersion', 'profile', 'storeId', 'events', 'head', 'backupSha256'
  ], 'Operational backup');
  if (value.format !== 'sflow.sgos.operational-backup' || value.formatVersion !== FORMAT_VERSION
      || value.profile !== expectedProfile || value.storeId !== expectedStoreId
      || !Array.isArray(value.events) || !plain(value.head)
      || !SHA256.test(String(value.backupSha256 ?? ''))) {
    fail('Operational backup is invalid.', 'SGOS_OPERATIONAL_BACKUP_INVALID');
  }
  if (value.events.length > MAXIMUM_EVENTS) {
    fail('Operational backup exceeds the installed event ceiling.',
      'SGOS_OPERATIONAL_STORE_LIMIT', { maximumEvents: MAXIMUM_EVENTS });
  }
  const core = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'backupSha256'));
  if (digest(core) !== value.backupSha256) {
    fail('Operational backup digest is invalid.', 'SGOS_OPERATIONAL_BACKUP_INVALID');
  }
  bounded(value, MAXIMUM_BYTES, 'Operational backup');
  const replayed = replay(expectedStoreId, value.events);
  if (canonicalJson(replayed.head) !== canonicalJson(value.head)) {
    fail('Operational backup head does not match its lineage.',
      'SGOS_OPERATIONAL_BACKUP_INVALID');
  }
  return { backup: clone(value), replayed };
}

export function assertSgosOperationalStoreAdapter(adapter) {
  if (!plain(adapter) || adapter.spiVersion !== SGOS_OPERATIONAL_STORE_SPI_VERSION
      || adapter.role !== 'operational' || !ID.test(String(adapter.profile ?? ''))
      || !ID.test(String(adapter.storeId ?? ''))) {
    fail('SGOS Operational Store adapter contract is invalid.',
      'SGOS_OPERATIONAL_ADAPTER_INVALID');
  }
  exact(adapter.capabilities, Object.keys(SGOS_OPERATIONAL_STORE_CAPABILITIES),
    'Operational Store capabilities');
  for (const [key, required] of Object.entries(SGOS_OPERATIONAL_STORE_CAPABILITIES)) {
    if (adapter.capabilities[key] !== required) {
      fail(`Operational Store capability '${key}' must be ${required}.`,
        'SGOS_OPERATIONAL_ADAPTER_INVALID', { capability: key });
    }
  }
  for (const method of SGOS_OPERATIONAL_STORE_METHODS) {
    if (typeof adapter[method] !== 'function') {
      fail(`Operational Store adapter is missing '${method}'.`,
        'SGOS_OPERATIONAL_ADAPTER_INVALID', { method });
    }
  }
  return adapter;
}

/**
 * Admit this alternate Store only for an exact pinned simulation/test storage profile.
 * No live runtime or lifecycle publisher calls this boundary.
 */
export function assertSgosOperationalStoreSelection(adapter, {
  purpose, programStorageProfileSha256, selectedStorageProfileSha256
}) {
  const store = assertSgosOperationalStoreAdapter(adapter);
  if (!['simulation', 'test'].includes(purpose)
      || !SHA256.test(String(programStorageProfileSha256 ?? ''))
      || programStorageProfileSha256 !== selectedStorageProfileSha256
      || store.capabilities.authorityEligible !== false) {
    fail('Operational Store selection cannot satisfy the pinned Program storage authority.',
      'SGOS_OPERATIONAL_STORE_SELECTION_REFUSED', {
        purpose: purpose ?? null,
        profile: store.profile,
        programStorageProfileSha256: programStorageProfileSha256 ?? null,
        selectedStorageProfileSha256: selectedStorageProfileSha256 ?? null
      });
  }
  return store;
}

/** Create a bounded, serialized, non-authoritative operational replay Store. */
export function createMemorySgosOperationalStore({ storeId }) {
  if (!ID.test(String(storeId ?? ''))) {
    fail('Operational Store ID must be a portable lower-case identifier.');
  }
  let events = [];
  let current = state(storeId, 0, null, {});
  let states = [current];
  let queue = Promise.resolve();

  const locked = (operation) => {
    const result = queue.then(operation, operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };

  const transactLocked = (input, { operation = 'transact', rollbackRevision = null } = {}) => {
    exact(input, ['expectedRevision', 'expectedStateSha256', 'changes'], 'Operational transaction');
    if (input.expectedRevision !== current.revision
        || input.expectedStateSha256 !== current.stateSha256) {
      fail('Operational transaction lost its compare-and-swap race.',
        'SGOS_OPERATIONAL_CAS_MISMATCH', {
          currentRevision: current.revision,
          currentStateSha256: current.stateSha256
        });
    }
    const changes = normalizedChanges(input.changes, current.entries);
    const entries = apply(current.entries, changes);
    const nextEvent = event(storeId, current, operation, changes, entries,
      operation === 'rollback' ? { rollbackRevision } : {});
    bounded(nextEvent, MAXIMUM_BYTES, 'Operational event');
    const nextState = state(storeId, nextEvent.revision, nextEvent.eventSha256, entries);
    // Publish both references only after every validation and hash succeeds. In-memory interruption
    // before this point leaves the exact prior head and lineage intact.
    events = [...events, nextEvent];
    current = nextState;
    states = [...states, nextState];
    return clone(nextState);
  };

  const adapter = {
    spiVersion: SGOS_OPERATIONAL_STORE_SPI_VERSION,
    role: 'operational',
    profile: MEMORY_PROFILE,
    storeId,
    capabilities: SGOS_OPERATIONAL_STORE_CAPABILITIES,

    descriptor() {
      return Object.freeze({
        spiVersion: SGOS_OPERATIONAL_STORE_SPI_VERSION,
        role: 'operational', profile: MEMORY_PROFILE, storeId,
        durability: 'ephemeral-reconstructable', authorityEligible: false,
        maximumEntries: MAXIMUM_ENTRIES, maximumBytes: MAXIMUM_BYTES,
        purposes: Object.freeze(['simulation', 'test'])
      });
    },

    async doctor() {
      const verification = await adapter.verify();
      return Object.freeze({
        status: verification.valid ? 'ready' : 'corrupt',
        profile: MEMORY_PROFILE, storeId, revision: verification.revision,
        durability: 'ephemeral-reconstructable', authorityEligible: false
      });
    },

    async read() {
      await queue;
      return clone(current);
    },

    async transact(input) {
      return locked(() => transactLocked(input));
    },

    async verify() {
      await queue;
      const verified = replay(storeId, events);
      if (canonicalJson(verified.head) !== canonicalJson(current)) {
        fail('Operational Store head does not match its append-only lineage.',
          'SGOS_OPERATIONAL_STORE_CORRUPT');
      }
      return Object.freeze({
        valid: true, profile: MEMORY_PROFILE, storeId, revision: current.revision,
        stateSha256: current.stateSha256, eventCount: events.length
      });
    },

    async exportBackup() {
      await queue;
      const core = {
        format: 'sflow.sgos.operational-backup',
        formatVersion: FORMAT_VERSION,
        profile: MEMORY_PROFILE,
        storeId,
        events: clone(events),
        head: clone(current)
      };
      return clone(sealed(core, 'backupSha256'));
    },

    async planRestore(backup) {
      await queue;
      const candidate = validateBackup(backup, storeId, MEMORY_PROFILE);
      const prefix = current.revision <= candidate.backup.events.length
        && events.every((entry, index) =>
          entry.eventSha256 === candidate.backup.events[index]?.eventSha256);
      if (!prefix) {
        fail('Operational backup does not fast-forward the current lineage.',
          'SGOS_OPERATIONAL_RESTORE_DIVERGED');
      }
      const mode = current.stateSha256 === candidate.backup.head.stateSha256
        ? 'noop' : 'fast-forward';
      const core = {
        kind: 'sgos-operational-restore-plan', storeId, profile: MEMORY_PROFILE, mode,
        beforeStateSha256: current.stateSha256,
        afterStateSha256: candidate.backup.head.stateSha256,
        backupSha256: candidate.backup.backupSha256
      };
      return Object.freeze({ ...core, confirmationSha256: digest(core) });
    },

    async restore({ backup, confirmationSha256 }) {
      return locked(() => {
        const candidate = validateBackup(backup, storeId, MEMORY_PROFILE);
        const prefix = current.revision <= candidate.backup.events.length
          && events.every((entry, index) =>
            entry.eventSha256 === candidate.backup.events[index]?.eventSha256);
        if (!prefix) fail('Operational backup does not fast-forward the current lineage.',
          'SGOS_OPERATIONAL_RESTORE_DIVERGED');
        const mode = current.stateSha256 === candidate.backup.head.stateSha256
          ? 'noop' : 'fast-forward';
        const core = {
          kind: 'sgos-operational-restore-plan', storeId, profile: MEMORY_PROFILE, mode,
          beforeStateSha256: current.stateSha256,
          afterStateSha256: candidate.backup.head.stateSha256,
          backupSha256: candidate.backup.backupSha256
        };
        const required = digest(core);
        if (confirmationSha256 !== required) {
          fail('Operational restore confirmation does not match the current plan.',
            'SGOS_OPERATIONAL_RESTORE_STALE', { requiredConfirmationSha256: required });
        }
        if (mode === 'fast-forward') {
          events = clone(candidate.backup.events);
          const replayed = replay(storeId, events);
          current = replayed.head;
          states = replayed.states;
        }
        return Object.freeze({
          restored: mode !== 'noop', mode, storeId, profile: MEMORY_PROFILE,
          revision: current.revision, stateSha256: current.stateSha256,
          planSha256: required
        });
      });
    },

    async planRollback(revision) {
      await queue;
      if (!Number.isSafeInteger(revision) || revision < 0 || revision >= current.revision) {
        fail('Operational rollback revision must name an earlier retained state.',
          'SGOS_OPERATIONAL_ROLLBACK_INVALID');
      }
      const target = states[revision];
      const core = {
        kind: 'sgos-operational-rollback-plan', storeId, profile: MEMORY_PROFILE,
        beforeRevision: current.revision, beforeStateSha256: current.stateSha256,
        targetRevision: revision, targetStateSha256: target.stateSha256
      };
      return Object.freeze({ ...core, confirmationSha256: digest(core) });
    },

    async rollback({ revision, confirmationSha256 }) {
      return locked(() => {
        if (!Number.isSafeInteger(revision) || revision < 0 || revision >= current.revision) {
          fail('Operational rollback revision must name an earlier retained state.',
            'SGOS_OPERATIONAL_ROLLBACK_INVALID');
        }
        const target = states[revision];
        const core = {
          kind: 'sgos-operational-rollback-plan', storeId, profile: MEMORY_PROFILE,
          beforeRevision: current.revision, beforeStateSha256: current.stateSha256,
          targetRevision: revision, targetStateSha256: target.stateSha256
        };
        const required = digest(core);
        if (confirmationSha256 !== required) {
          fail('Operational rollback confirmation does not match the current plan.',
            'SGOS_OPERATIONAL_ROLLBACK_STALE', { requiredConfirmationSha256: required });
        }
        const keys = [...new Set([
          ...Object.keys(current.entries), ...Object.keys(target.entries)
        ])].sort();
        const changes = [];
        for (const key of keys) {
          if (!Object.hasOwn(target.entries, key)) changes.push({ op: 'delete', key });
          else if (!Object.hasOwn(current.entries, key)
              || canonicalJson(current.entries[key]) !== canonicalJson(target.entries[key])) {
            changes.push({ op: 'put', key, value: clone(target.entries[key]) });
          }
        }
        if (!changes.length) {
          fail('Operational rollback target has the same material state.',
            'SGOS_OPERATIONAL_ROLLBACK_INVALID');
        }
        const result = transactLocked({
          expectedRevision: current.revision,
          expectedStateSha256: current.stateSha256,
          changes
        }, { operation: 'rollback', rollbackRevision: revision });
        return Object.freeze({
          rolledBack: true, storeId, profile: MEMORY_PROFILE,
          targetRevision: revision, revision: result.revision,
          stateSha256: result.stateSha256, planSha256: required
        });
      });
    }
  };
  return Object.freeze(adapter);
}

const EVENT_FILE = /^(\d{12})-([a-f0-9]{64})\.json$/u;

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    // Directory fsync is not available on every supported Windows filesystem. The event itself is
    // still fsynced and atomically renamed; refusing the whole profile here would make a safe
    // recoverable Store unusable on that platform.
    if (!['EINVAL', 'EPERM', 'EISDIR', 'EBADF'].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeAtomicJson(target, value) {
  const directory = dirname(target);
  const temporary = join(directory, `.${process.pid}-${randomUUID()}.tmp`);
  const bytes = `${canonicalJson(value)}\n`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, target);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function readBoundedJson(path, label) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAXIMUM_BYTES) {
    fail(`${label} is not a bounded regular file.`, 'SGOS_OPERATIONAL_STORE_CORRUPT');
  }
  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new SingularityFlowError(`${label} is not valid JSON.`, {
      code: 'SGOS_OPERATIONAL_STORE_CORRUPT', cause: error
    });
  }
  return value;
}

/**
 * Create a durable, reconstructable filesystem implementation of the same non-authoritative SPI.
 *
 * The caller supplies an explicit private root. Each committed event is a fsynced immutable file;
 * temporary files are ignored after process loss, and the head is always reconstructed from the
 * append-only lineage. This profile is still restricted to simulation and tests.
 */
export function createFilesystemSgosOperationalStore({
  storeId, root, lockTimeoutMs = 5_000, staleLockMs = 30_000
}) {
  if (!ID.test(String(storeId ?? ''))) {
    fail('Operational Store ID must be a portable lower-case identifier.');
  }
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root) {
    fail('Filesystem Operational Store root must be an absolute normalized path.',
      'SGOS_OPERATIONAL_STORE_ROOT_INVALID');
  }
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 100 || lockTimeoutMs > 60_000
      || !Number.isSafeInteger(staleLockMs) || staleLockMs < 1_000 || staleLockMs > 300_000) {
    fail('Filesystem Operational Store lock bounds are invalid.',
      'SGOS_OPERATIONAL_STORE_ROOT_INVALID');
  }

  const storeRoot = join(root, storeId);
  const eventsRoot = join(storeRoot, 'events');
  const lockPath = join(storeRoot, 'writer.lock');
  let initialized = null;
  let queue = Promise.resolve();

  const initialize = async () => {
    if (!initialized) {
      initialized = (async () => {
        await mkdir(eventsRoot, { recursive: true, mode: 0o700 });
        for (const [path, label] of [[root, 'root'], [storeRoot, 'store'], [eventsRoot, 'events']]) {
          const metadata = await lstat(path);
          if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
            fail(`Filesystem Operational Store ${label} is not a directory.`,
              'SGOS_OPERATIONAL_STORE_ROOT_INVALID');
          }
        }
      })().catch((error) => {
        initialized = null;
        throw error;
      });
    }
    return initialized;
  };

  const acquireLock = async () => {
    await initialize();
    const token = { pid: process.pid, nonce: randomUUID(), createdAtMs: Date.now() };
    const deadline = Date.now() + lockTimeoutMs;
    while (true) {
      let handle;
      let created = false;
      try {
        handle = await open(lockPath, 'wx', 0o600);
        created = true;
        await handle.writeFile(`${canonicalJson(token)}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        return token;
      } catch (error) {
        await handle?.close().catch(() => {});
        if (created) await unlink(lockPath).catch(() => {});
        if (error?.code !== 'EEXIST') throw error;
        try {
          const metadata = await stat(lockPath);
          const holder = await readBoundedJson(lockPath, 'Operational writer lock');
          if (Date.now() - metadata.mtimeMs >= staleLockMs && !processIsAlive(holder?.pid)) {
            await unlink(lockPath);
            continue;
          }
        } catch (inspectionError) {
          if (inspectionError?.code === 'ENOENT') continue;
          const metadata = await stat(lockPath).catch(() => null);
          if (metadata && Date.now() - metadata.mtimeMs >= staleLockMs) {
            await unlink(lockPath).catch(() => {});
            continue;
          }
        }
        if (Date.now() >= deadline) {
          fail('Filesystem Operational Store writer lock timed out.',
            'SGOS_OPERATIONAL_STORE_LOCK_TIMEOUT', { lockTimeoutMs });
        }
        await delay(Math.min(25, Math.max(1, deadline - Date.now())));
      }
    }
  };

  const releaseLock = async (token) => {
    try {
      const holder = await readBoundedJson(lockPath, 'Operational writer lock');
      if (holder?.pid === token.pid && holder?.nonce === token.nonce) await unlink(lockPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  };

  const locked = (operation) => {
    const execute = async () => {
      const token = await acquireLock();
      try { return await operation(); } finally { await releaseLock(token); }
    };
    const result = queue.then(execute, execute);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };

  const load = async () => {
    await initialize();
    const names = (await readdir(eventsRoot)).filter((name) => !name.startsWith('.')).sort();
    if (names.length > MAXIMUM_EVENTS) {
      fail('Filesystem Operational Store event count exceeds the installed ceiling.',
        'SGOS_OPERATIONAL_STORE_LIMIT', { maximumEvents: MAXIMUM_EVENTS });
    }
    const events = [];
    for (let index = 0; index < names.length; index += 1) {
      const match = EVENT_FILE.exec(names[index]);
      if (!match || Number(match[1]) !== index + 1) {
        fail('Filesystem Operational Store event filenames are not a contiguous lineage.',
          'SGOS_OPERATIONAL_STORE_CORRUPT');
      }
      const value = await readBoundedJson(join(eventsRoot, names[index]),
        `Operational event ${index + 1}`);
      if (value.eventSha256 !== `sha256:${match[2]}`) {
        fail('Filesystem Operational Store event filename does not match its digest.',
          'SGOS_OPERATIONAL_STORE_CORRUPT');
      }
      events.push(value);
    }
    return { events, ...replay(storeId, events) };
  };

  const append = async (nextEvent) => {
    const hexadecimal = nextEvent.eventSha256.slice('sha256:'.length);
    const name = `${String(nextEvent.revision).padStart(12, '0')}-${hexadecimal}.json`;
    await writeAtomicJson(join(eventsRoot, name), nextEvent);
  };

  const transactLocked = async (input, options = {}) => {
    exact(input, ['expectedRevision', 'expectedStateSha256', 'changes'], 'Operational transaction');
    const loaded = await load();
    const current = loaded.head;
    if (input.expectedRevision !== current.revision
        || input.expectedStateSha256 !== current.stateSha256) {
      fail('Operational transaction lost its compare-and-swap race.',
        'SGOS_OPERATIONAL_CAS_MISMATCH', {
          currentRevision: current.revision, currentStateSha256: current.stateSha256
        });
    }
    if (loaded.events.length >= MAXIMUM_EVENTS) {
      fail('Filesystem Operational Store event count exceeds the installed ceiling.',
        'SGOS_OPERATIONAL_STORE_LIMIT', { maximumEvents: MAXIMUM_EVENTS });
    }
    const changes = normalizedChanges(input.changes, current.entries);
    const entries = apply(current.entries, changes);
    const nextEvent = event(storeId, current, options.operation ?? 'transact', changes, entries,
      options.operation === 'rollback' ? { rollbackRevision: options.rollbackRevision } : {});
    bounded(nextEvent, MAXIMUM_BYTES, 'Operational event');
    await append(nextEvent);
    return state(storeId, nextEvent.revision, nextEvent.eventSha256, entries);
  };

  const adapter = {
    spiVersion: SGOS_OPERATIONAL_STORE_SPI_VERSION,
    role: 'operational',
    profile: FILESYSTEM_PROFILE,
    storeId,
    capabilities: SGOS_OPERATIONAL_STORE_CAPABILITIES,

    descriptor() {
      return Object.freeze({
        spiVersion: SGOS_OPERATIONAL_STORE_SPI_VERSION,
        role: 'operational', profile: FILESYSTEM_PROFILE, storeId,
        durability: 'durable-reconstructable', authorityEligible: false,
        maximumEntries: MAXIMUM_ENTRIES, maximumEvents: MAXIMUM_EVENTS,
        maximumBytes: MAXIMUM_BYTES, purposes: Object.freeze(['simulation', 'test'])
      });
    },

    async doctor() {
      const verification = await adapter.verify();
      return Object.freeze({
        status: 'ready', profile: FILESYSTEM_PROFILE, storeId,
        revision: verification.revision, durability: 'durable-reconstructable',
        authorityEligible: false
      });
    },

    async read() {
      await queue;
      return clone((await load()).head);
    },

    async transact(input) {
      return locked(() => transactLocked(input));
    },

    async verify() {
      await queue;
      const loaded = await load();
      return Object.freeze({
        valid: true, profile: FILESYSTEM_PROFILE, storeId,
        revision: loaded.head.revision, stateSha256: loaded.head.stateSha256,
        eventCount: loaded.events.length
      });
    },

    async exportBackup() {
      await queue;
      const loaded = await load();
      const core = {
        format: 'sflow.sgos.operational-backup', formatVersion: FORMAT_VERSION,
        profile: FILESYSTEM_PROFILE, storeId,
        events: clone(loaded.events), head: clone(loaded.head)
      };
      return clone(sealed(core, 'backupSha256'));
    },

    async planRestore(backup) {
      await queue;
      const loaded = await load();
      const candidate = validateBackup(backup, storeId, FILESYSTEM_PROFILE);
      const prefix = loaded.events.length <= candidate.backup.events.length
        && loaded.events.every((entry, index) =>
          entry.eventSha256 === candidate.backup.events[index]?.eventSha256);
      if (!prefix) fail('Operational backup does not fast-forward the current lineage.',
        'SGOS_OPERATIONAL_RESTORE_DIVERGED');
      const mode = loaded.head.stateSha256 === candidate.backup.head.stateSha256
        ? 'noop' : 'fast-forward';
      const core = {
        kind: 'sgos-operational-restore-plan', storeId, profile: FILESYSTEM_PROFILE, mode,
        beforeStateSha256: loaded.head.stateSha256,
        afterStateSha256: candidate.backup.head.stateSha256,
        backupSha256: candidate.backup.backupSha256
      };
      return Object.freeze({ ...core, confirmationSha256: digest(core) });
    },

    async restore({ backup, confirmationSha256 }) {
      return locked(async () => {
        const loaded = await load();
        const candidate = validateBackup(backup, storeId, FILESYSTEM_PROFILE);
        const prefix = loaded.events.length <= candidate.backup.events.length
          && loaded.events.every((entry, index) =>
            entry.eventSha256 === candidate.backup.events[index]?.eventSha256);
        if (!prefix) fail('Operational backup does not fast-forward the current lineage.',
          'SGOS_OPERATIONAL_RESTORE_DIVERGED');
        const mode = loaded.head.stateSha256 === candidate.backup.head.stateSha256
          ? 'noop' : 'fast-forward';
        const core = {
          kind: 'sgos-operational-restore-plan', storeId, profile: FILESYSTEM_PROFILE, mode,
          beforeStateSha256: loaded.head.stateSha256,
          afterStateSha256: candidate.backup.head.stateSha256,
          backupSha256: candidate.backup.backupSha256
        };
        const required = digest(core);
        if (confirmationSha256 !== required) {
          fail('Operational restore confirmation does not match the current plan.',
            'SGOS_OPERATIONAL_RESTORE_STALE', { requiredConfirmationSha256: required });
        }
        for (const nextEvent of candidate.backup.events.slice(loaded.events.length)) {
          // Validate every imported event against the prefix immediately before it becomes visible.
          const current = (await load()).head;
          validateEvent(nextEvent, storeId, current);
          await append(nextEvent);
        }
        const after = (await load()).head;
        return Object.freeze({
          restored: mode !== 'noop', mode, storeId, profile: FILESYSTEM_PROFILE,
          revision: after.revision, stateSha256: after.stateSha256, planSha256: required
        });
      });
    },

    async planRollback(revision) {
      await queue;
      const loaded = await load();
      if (!Number.isSafeInteger(revision) || revision < 0 || revision >= loaded.head.revision) {
        fail('Operational rollback revision must name an earlier retained state.',
          'SGOS_OPERATIONAL_ROLLBACK_INVALID');
      }
      const target = loaded.states[revision];
      const core = {
        kind: 'sgos-operational-rollback-plan', storeId, profile: FILESYSTEM_PROFILE,
        beforeRevision: loaded.head.revision, beforeStateSha256: loaded.head.stateSha256,
        targetRevision: revision, targetStateSha256: target.stateSha256
      };
      return Object.freeze({ ...core, confirmationSha256: digest(core) });
    },

    async rollback({ revision, confirmationSha256 }) {
      return locked(async () => {
        const loaded = await load();
        if (!Number.isSafeInteger(revision) || revision < 0 || revision >= loaded.head.revision) {
          fail('Operational rollback revision must name an earlier retained state.',
            'SGOS_OPERATIONAL_ROLLBACK_INVALID');
        }
        const target = loaded.states[revision];
        const core = {
          kind: 'sgos-operational-rollback-plan', storeId, profile: FILESYSTEM_PROFILE,
          beforeRevision: loaded.head.revision, beforeStateSha256: loaded.head.stateSha256,
          targetRevision: revision, targetStateSha256: target.stateSha256
        };
        const required = digest(core);
        if (confirmationSha256 !== required) {
          fail('Operational rollback confirmation does not match the current plan.',
            'SGOS_OPERATIONAL_ROLLBACK_STALE', { requiredConfirmationSha256: required });
        }
        const keys = [...new Set([
          ...Object.keys(loaded.head.entries), ...Object.keys(target.entries)
        ])].sort();
        const changes = [];
        for (const key of keys) {
          if (!Object.hasOwn(target.entries, key)) changes.push({ op: 'delete', key });
          else if (!Object.hasOwn(loaded.head.entries, key)
              || canonicalJson(loaded.head.entries[key]) !== canonicalJson(target.entries[key])) {
            changes.push({ op: 'put', key, value: clone(target.entries[key]) });
          }
        }
        if (!changes.length) fail('Operational rollback target has the same material state.',
          'SGOS_OPERATIONAL_ROLLBACK_INVALID');
        const result = await transactLocked({
          expectedRevision: loaded.head.revision,
          expectedStateSha256: loaded.head.stateSha256,
          changes
        }, { operation: 'rollback', rollbackRevision: revision });
        return Object.freeze({
          rolledBack: true, storeId, profile: FILESYSTEM_PROFILE,
          targetRevision: revision, revision: result.revision,
          stateSha256: result.stateSha256, planSha256: required
        });
      });
    }
  };
  return Object.freeze(adapter);
}
