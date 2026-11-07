/** Trusted persistence port for applications hosting the namespace protocol. No authority selection. */
import { addressIdentity, exactObject, namespaceAddress, namespaceError, namespaceIdentifier,
  namespaceJson, namespaceRevision, namespaceScope, NAMESPACE_LIMITS } from './values.mjs';
import { namespaceBinding } from './contract.mjs';

export const NAMESPACE_JOURNAL_PORT = 'sflow-namespace-journal/v1';
export const NAMESPACE_JOURNAL_METHODS = Object.freeze(['read', 'append', 'confirm']);

/**
 * read(scope, {through?}) -> one integrity-checked immutable prefix:
 *   {scope, sequence, sha256, state:{records:Map, events:Map, operations:Map}}
 * append(scope, observed, transaction, {signal?}) -> {accepted:false} on a moved prefix, or
 *   {accepted:true, replayed:boolean, receipt} after atomic, durable acceptance.
 * confirm(scope) -> reconcile/flush an observed accepted prefix before acknowledging a receipt.
 *
 * Record/event/receipt application is defined by applyNamespaceTransaction. An application must
 * supply an actual atomic conditional commit; describing this port does not prove that guarantee.
 * Once acceptance may have happened, return OUTCOME_UNKNOWN and reconcile by operation identity.
 */
export function namespaceJournalManifest(port, binding) {
  if (port?.contract !== NAMESPACE_JOURNAL_PORT
    || NAMESPACE_JOURNAL_METHODS.some(method => typeof port?.[method] !== 'function')) {
    throw namespaceError('The application journal does not implement the required persistence port.', 'SDA_NAMESPACE_UNSUPPORTED');
  }
  exactObject(port.manifest, ['storeId', 'binding', 'cursorKey'], [], 'Journal manifest');
  const manifest = { storeId: namespaceIdentifier(port.manifest.storeId, 'Store ID'),
    binding: namespaceBinding(port.manifest.binding), cursorKey: port.manifest.cursorKey };
  if (typeof manifest.cursorKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(manifest.cursorKey)
    || JSON.stringify(manifest.binding) !== JSON.stringify(namespaceBinding(binding))) {
    throw namespaceError('The application journal has an invalid identity or another binding.');
  }
  return Object.freeze(manifest);
}

export function namespaceJournalObservation(value, scope, through = null) {
  try {
    exactObject(value, ['scope', 'state', 'sequence', 'sha256']);
    exactObject(value.state, ['records', 'events', 'operations']);
    if (namespaceScope(value.scope).projectId !== namespaceScope(scope).projectId
      || !Number.isSafeInteger(value.sequence) || value.sequence < 0
      || (through !== null && value.sequence !== through)
      || (value.sequence === 0 ? value.sha256 !== null
        : typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256))
      || Object.values(value.state).some(part => !(part instanceof Map))
      || (value.sequence === 0 && Object.values(value.state).some(part => part.size !== 0))) {
      throw namespaceError('Journal observation has another scope or an invalid prefix.');
    }
    for (const [key, record] of value.state.records) {
      const address = namespaceAddress({ namespace: record?.namespace, key: record?.key });
      if (key !== addressIdentity(address)) throw namespaceError('A journal record has another namespace or key.');
    }
    return value;
  } catch (cause) {
    throw namespaceError('The application journal returned an invalid observation.', 'SDA_NAMESPACE_UNSUPPORTED',
      { stage: 'journal-observation' }, cause);
  }
}

export function namespaceJournalReceipt(receipt, scope, operationId) {
  exactObject(receipt, ['operationId', 'scope', 'revision', 'requestDigest', 'records', 'eventIds']);
  receipt = namespaceJson(receipt);
  if (receipt.operationId !== operationId || namespaceScope(receipt.scope).projectId !== namespaceScope(scope).projectId
    || namespaceRevision(receipt.revision) === null
    || typeof receipt.requestDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(receipt.requestDigest)
    || !Array.isArray(receipt.records) || receipt.records.length > NAMESPACE_LIMITS.maxChanges
    || !Array.isArray(receipt.eventIds) || receipt.eventIds.length > NAMESPACE_LIMITS.maxEvents) {
    throw namespaceError('The journal receipt is invalid or bound to another operation.');
  }
  const addresses = new Set();
  for (const record of receipt.records) {
    exactObject(record, ['namespace', 'key', 'version']);
    const address = JSON.stringify(namespaceAddress({ namespace: record.namespace, key: record.key }));
    namespaceRevision(record.version);
    if (addresses.has(address)) throw namespaceError('The journal receipt repeats a record address.');
    addresses.add(address);
  }
  for (const id of receipt.eventIds) namespaceIdentifier(id, 'Event ID');
  if (new Set(receipt.eventIds).size !== receipt.eventIds.length) throw namespaceError('The journal receipt repeats an event ID.');
  return receipt;
}

export function namespaceJournalAcceptance(value, scope, transaction, requestDigest) {
  try {
    if (value?.accepted === false) { exactObject(value, ['accepted']); return value; }
    exactObject(value, ['accepted', 'replayed', 'receipt'], ['state']);
    const receipt = namespaceJournalReceipt(value.receipt, scope, transaction.operationId);
    if (value.accepted !== true || typeof value.replayed !== 'boolean' || receipt.requestDigest !== requestDigest
      || receipt.records.length !== transaction.changes.length || receipt.eventIds.length !== transaction.events.length
      || receipt.eventIds.some((id, index) => id !== transaction.events[index].eventId)) {
      throw namespaceError('The journal receipt differs from the requested transaction.');
    }
    for (const [index, record] of receipt.records.entries()) {
      exactObject(record, ['namespace', 'key', 'version']);
      const change = transaction.changes[index];
      if (record.namespace !== change.namespace || record.key !== change.key
        || (change.op === 'delete' ? record.version !== null : namespaceRevision(record.version) === null)) {
        throw namespaceError('The journal receipt has an invalid changed-record binding.');
      }
    }
    return { ...value, receipt };
  } catch (cause) {
    throw namespaceError('The journal did not return a valid commit receipt; inspect this operation before retrying.',
      'SDA_NAMESPACE_OUTCOME_UNKNOWN', { operationId: transaction.operationId, stage: 'journal-receipt' }, cause);
  }
}

export function namespaceJournalRecord(record, { namespace, key = null }, limits) {
  try {
    exactObject(record, ['namespace', 'key', 'version', 'immutable', 'value']);
    const address = namespaceAddress({ namespace: record.namespace, key: record.key });
    if (address.namespace !== namespace || (key !== null && address.key !== key)
      || namespaceRevision(record.version) === null || typeof record.immutable !== 'boolean') {
      throw namespaceError('The journal returned another record binding.');
    }
    return { ...record, value: namespaceJson(record.value, {
      maxBytes: limits.maxValueBytes, maxDepth: limits.maxDepth, maxNodes: limits.maxNodes
    }) };
  } catch (cause) {
    throw namespaceError('The application journal returned an invalid record.', 'SDA_NAMESPACE_UNSUPPORTED',
      { stage: 'journal-record' }, cause);
  }
}
