/**
 * Versioned SGOS Operational Store SPI and the bounded in-memory replay profile.
 *
 * Operational state is reconstructable runtime state, never lifecycle or Program authority. The
 * first alternate profile is deliberately ephemeral and admitted only for simulation and tests.
 * It is useful for deterministic replay/conformance without making an in-memory result eligible to
 * authorize a governed mutation.
 */
import { createHash } from 'node:crypto';

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

const PROFILE = 'memory-replay-v1';
const FORMAT_VERSION = 1;
const MAXIMUM_ENTRIES = 2_000;
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

function validateBackup(value, expectedStoreId) {
  exact(value, [
    'format', 'formatVersion', 'profile', 'storeId', 'events', 'head', 'backupSha256'
  ], 'Operational backup');
  if (value.format !== 'sflow.sgos.operational-backup' || value.formatVersion !== FORMAT_VERSION
      || value.profile !== PROFILE || value.storeId !== expectedStoreId
      || !Array.isArray(value.events) || !plain(value.head)
      || !SHA256.test(String(value.backupSha256 ?? ''))) {
    fail('Operational backup is invalid.', 'SGOS_OPERATIONAL_BACKUP_INVALID');
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
    profile: PROFILE,
    storeId,
    capabilities: SGOS_OPERATIONAL_STORE_CAPABILITIES,

    descriptor() {
      return Object.freeze({
        spiVersion: SGOS_OPERATIONAL_STORE_SPI_VERSION,
        role: 'operational', profile: PROFILE, storeId,
        durability: 'ephemeral-reconstructable', authorityEligible: false,
        maximumEntries: MAXIMUM_ENTRIES, maximumBytes: MAXIMUM_BYTES,
        purposes: Object.freeze(['simulation', 'test'])
      });
    },

    async doctor() {
      const verification = await adapter.verify();
      return Object.freeze({
        status: verification.valid ? 'ready' : 'corrupt',
        profile: PROFILE, storeId, revision: verification.revision,
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
        valid: true, profile: PROFILE, storeId, revision: current.revision,
        stateSha256: current.stateSha256, eventCount: events.length
      });
    },

    async exportBackup() {
      await queue;
      const core = {
        format: 'sflow.sgos.operational-backup',
        formatVersion: FORMAT_VERSION,
        profile: PROFILE,
        storeId,
        events: clone(events),
        head: clone(current)
      };
      return clone(sealed(core, 'backupSha256'));
    },

    async planRestore(backup) {
      await queue;
      const candidate = validateBackup(backup, storeId);
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
        kind: 'sgos-operational-restore-plan', storeId, profile: PROFILE, mode,
        beforeStateSha256: current.stateSha256,
        afterStateSha256: candidate.backup.head.stateSha256,
        backupSha256: candidate.backup.backupSha256
      };
      return Object.freeze({ ...core, confirmationSha256: digest(core) });
    },

    async restore({ backup, confirmationSha256 }) {
      return locked(() => {
        const candidate = validateBackup(backup, storeId);
        const prefix = current.revision <= candidate.backup.events.length
          && events.every((entry, index) =>
            entry.eventSha256 === candidate.backup.events[index]?.eventSha256);
        if (!prefix) fail('Operational backup does not fast-forward the current lineage.',
          'SGOS_OPERATIONAL_RESTORE_DIVERGED');
        const mode = current.stateSha256 === candidate.backup.head.stateSha256
          ? 'noop' : 'fast-forward';
        const core = {
          kind: 'sgos-operational-restore-plan', storeId, profile: PROFILE, mode,
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
          restored: mode !== 'noop', mode, storeId, profile: PROFILE,
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
        kind: 'sgos-operational-rollback-plan', storeId, profile: PROFILE,
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
          kind: 'sgos-operational-rollback-plan', storeId, profile: PROFILE,
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
          rolledBack: true, storeId, profile: PROFILE,
          targetRevision: revision, revision: result.revision,
          stateSha256: result.stateSha256, planSha256: required
        });
      });
    }
  };
  return Object.freeze(adapter);
}
