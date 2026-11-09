/** SGOS Operational Store v1 values and rules. No host, persistence or authority selection. */
import {canonicalJson} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';

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

export const FORMAT_VERSION = 1;
export const MAXIMUM_ENTRIES = 2_000;
export const MAXIMUM_EVENTS = 20_000;
export const MAXIMUM_BYTES = 8 * 1024 * 1024;
export const OPERATIONAL_STORE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;


const ID=OPERATIONAL_STORE_ID;
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


/** Explicit digest binding; the record protocol stays independent of a Node host. */
export function createSgosOperationalCodec({digest}={}) {
  if(typeof digest!=='function')fail('Supply an explicit Operational Store digest implementation.');
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
  try { bytes = new TextEncoder().encode(canonicalJson(value)).byteLength; } catch (error) {
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


  return Object.freeze({fail,plain,exact,clone,digest,sealed,sortedEntries,state,bounded,normalizedChanges,apply,event,validateEvent,replay,validateBackup});
}
