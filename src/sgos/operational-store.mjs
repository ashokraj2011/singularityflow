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

import { canonicalJson } from '../foundation/record-schema.mjs';
import { SingularityFlowError } from '../util.mjs';

import {SGOS_OPERATIONAL_STORE_SPI_VERSION,SGOS_OPERATIONAL_STORE_METHODS,SGOS_OPERATIONAL_STORE_CAPABILITIES,
  FORMAT_VERSION,MAXIMUM_ENTRIES,MAXIMUM_EVENTS,MAXIMUM_BYTES,OPERATIONAL_STORE_ID as ID,
  assertSgosOperationalStoreAdapter,assertSgosOperationalStoreSelection,createSgosOperationalCodec} from './operational-contract.mjs';
export {SGOS_OPERATIONAL_STORE_SPI_VERSION,SGOS_OPERATIONAL_STORE_METHODS,SGOS_OPERATIONAL_STORE_CAPABILITIES,
  assertSgosOperationalStoreAdapter,assertSgosOperationalStoreSelection} from './operational-contract.mjs';

const MEMORY_PROFILE = 'memory-replay-v1';
const FILESYSTEM_PROFILE = 'filesystem-replay-v1';
export const SGOS_LIVE_OPERATIONAL_STORE_PROFILE = 'filesystem-live-v1';
// Runtime admission is an implementation boundary, not a profile-name convention. Keep the
// installed live adapters in a module-private identity set so a structurally compatible replay or
// caller-created object cannot promote itself into live Process-head service by copying the public
// descriptor fields.
const INSTALLED_LIVE_OPERATIONAL_STORES = new WeakSet();
function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

const {fail,plain,exact,clone,sealed,sortedEntries,state,bounded,normalizedChanges,apply,event,validateEvent,replay,validateBackup}=createSgosOperationalCodec({digest});

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

async function ensureOperationalDirectory(target, label) {
  let metadata;
  try {
    metadata = await lstat(target);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const parent = dirname(target);
    let parentMetadata;
    try { parentMetadata = await lstat(parent); } catch (parentError) {
      if (parentError?.code === 'ENOENT') {
        fail(`Filesystem Operational Store ${label} parent does not exist.`,
          'SGOS_OPERATIONAL_STORE_ROOT_INVALID');
      }
      throw parentError;
    }
    if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
      fail(`Filesystem Operational Store ${label} parent is not a safe directory.`,
        'SGOS_OPERATIONAL_STORE_ROOT_INVALID');
    }
    try { await mkdir(target, { mode: 0o700 }); } catch (createError) {
      if (createError?.code !== 'EEXIST') throw createError;
    }
    metadata = await lstat(target);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail(`Filesystem Operational Store ${label} is not a directory.`,
      'SGOS_OPERATIONAL_STORE_ROOT_INVALID');
  }
}

/**
 * Create a durable, reconstructable filesystem implementation of the same non-authoritative SPI.
 *
 * The caller supplies an explicit private root. Each committed event is a fsynced immutable file;
 * temporary files are ignored after process loss, and the head is always reconstructed from the
 * append-only lineage. Owner wrappers select its purpose; only the separately admitted live
 * adapter can serve Process-head state, and no operational profile grants shared authority.
 */
function createFilesystemOperationalStore({
  storeId, root, lockTimeoutMs = 5_000, staleLockMs = 30_000,
  profile, purposes
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
        // Each caller-owned level is validated before its child is created. A recursive mkdir on
        // `eventsRoot` would follow a supplied root/store symlink and could create escaped bytes
        // before the later lstat refusal.
        await ensureOperationalDirectory(root, 'root');
        await ensureOperationalDirectory(storeRoot, 'store');
        await ensureOperationalDirectory(eventsRoot, 'events');
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
    profile,
    storeId,
    capabilities: SGOS_OPERATIONAL_STORE_CAPABILITIES,

    descriptor() {
      return Object.freeze({
        spiVersion: SGOS_OPERATIONAL_STORE_SPI_VERSION,
        role: 'operational', profile, storeId,
        durability: 'durable-reconstructable', authorityEligible: false,
        maximumEntries: MAXIMUM_ENTRIES, maximumEvents: MAXIMUM_EVENTS,
        maximumBytes: MAXIMUM_BYTES, purposes: Object.freeze([...purposes])
      });
    },

    async doctor() {
      const verification = await adapter.verify();
      return Object.freeze({
        status: 'ready', profile, storeId,
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
        valid: true, profile, storeId,
        revision: loaded.head.revision, stateSha256: loaded.head.stateSha256,
        eventCount: loaded.events.length
      });
    },

    async exportBackup() {
      await queue;
      const loaded = await load();
      const core = {
        format: 'sflow.sgos.operational-backup', formatVersion: FORMAT_VERSION,
        profile, storeId,
        events: clone(loaded.events), head: clone(loaded.head)
      };
      return clone(sealed(core, 'backupSha256'));
    },

    async planRestore(backup) {
      await queue;
      const loaded = await load();
      const candidate = validateBackup(backup, storeId, profile);
      const prefix = loaded.events.length <= candidate.backup.events.length
        && loaded.events.every((entry, index) =>
          entry.eventSha256 === candidate.backup.events[index]?.eventSha256);
      if (!prefix) fail('Operational backup does not fast-forward the current lineage.',
        'SGOS_OPERATIONAL_RESTORE_DIVERGED');
      const mode = loaded.head.stateSha256 === candidate.backup.head.stateSha256
        ? 'noop' : 'fast-forward';
      const core = {
        kind: 'sgos-operational-restore-plan', storeId, profile, mode,
        beforeStateSha256: loaded.head.stateSha256,
        afterStateSha256: candidate.backup.head.stateSha256,
        backupSha256: candidate.backup.backupSha256
      };
      return Object.freeze({ ...core, confirmationSha256: digest(core) });
    },

    async restore({ backup, confirmationSha256 }) {
      return locked(async () => {
        const loaded = await load();
        const candidate = validateBackup(backup, storeId, profile);
        const prefix = loaded.events.length <= candidate.backup.events.length
          && loaded.events.every((entry, index) =>
            entry.eventSha256 === candidate.backup.events[index]?.eventSha256);
        if (!prefix) fail('Operational backup does not fast-forward the current lineage.',
          'SGOS_OPERATIONAL_RESTORE_DIVERGED');
        const mode = loaded.head.stateSha256 === candidate.backup.head.stateSha256
          ? 'noop' : 'fast-forward';
        const core = {
          kind: 'sgos-operational-restore-plan', storeId, profile, mode,
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
          restored: mode !== 'noop', mode, storeId, profile,
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
        kind: 'sgos-operational-rollback-plan', storeId, profile,
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
          kind: 'sgos-operational-rollback-plan', storeId, profile,
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
          rolledBack: true, storeId, profile,
          targetRevision: revision, revision: result.revision,
          stateSha256: result.stateSha256, planSha256: required
        });
      });
    }
  };
  return Object.freeze(adapter);
}

/** Create the non-authoritative durable replay profile used by simulation and conformance. */
export function createFilesystemSgosOperationalStore(options) {
  return createFilesystemOperationalStore({
    ...options,
    profile: FILESYSTEM_PROFILE,
    purposes: ['simulation', 'test']
  });
}

/**
 * Create the installed live Process-head profile.
 *
 * This remains operational state (`authorityEligible: false`). Program, policy, lifecycle, and
 * evidence authority are validated by the caller before a Process head can be appended. Keeping
 * this profile separate prevents repository configuration from promoting a replay adapter into
 * live execution merely by naming it.
 */
export function createLiveFilesystemSgosOperationalStore(options) {
  const adapter = createFilesystemOperationalStore({
    ...options,
    profile: SGOS_LIVE_OPERATIONAL_STORE_PROFILE,
    purposes: ['runtime']
  });
  INSTALLED_LIVE_OPERATIONAL_STORES.add(adapter);
  return adapter;
}

/** Reuse the same journal/CAS implementation for configuration transport recovery, not authority. */
export function createConfigurationOperationalStore(options) {
  return createFilesystemOperationalStore({
    ...options, profile: 'filesystem-configuration-v1', purposes: ['configuration-recovery']
  });
}

/** Admit only the one installed runtime profile; this does not grant Program or policy authority. */
export function assertSgosLiveOperationalStoreSelection(adapter) {
  const store = assertSgosOperationalStoreAdapter(adapter);
  const descriptor = store.descriptor();
  if (!INSTALLED_LIVE_OPERATIONAL_STORES.has(store)
      || store.profile !== SGOS_LIVE_OPERATIONAL_STORE_PROFILE
      || descriptor.profile !== SGOS_LIVE_OPERATIONAL_STORE_PROFILE
      || canonicalJson(descriptor.purposes) !== canonicalJson(['runtime'])
      || descriptor.authorityEligible !== false) {
    fail('Operational Store selection is not the installed live Process-head profile.',
      'SGOS_OPERATIONAL_STORE_SELECTION_REFUSED', { profile: store.profile });
  }
  return store;
}
