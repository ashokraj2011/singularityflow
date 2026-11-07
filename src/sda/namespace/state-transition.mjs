/** Conditional record/event/receipt rules shared by concrete namespace backends. No host I/O. */
import {
  addressIdentity, namespaceError, namespaceRevision, namespaceScope
} from './values.mjs';
import { namespaceTransaction, namespaceTransactionIdentity } from './transaction.mjs';

export function emptyNamespaceState() {
  return { records: new Map(), events: new Map(), operations: new Map() };
}

/** An accepted transaction has one publication point supplied by the backend, outside this reducer. */
export function applyNamespaceTransaction(state, scope, input, { revision, requestDigest, limits } = {}) {
  const normalizedScope = namespaceScope(scope);
  const transaction = namespaceTransaction(input, limits);
  const identity = namespaceTransactionIdentity(normalizedScope, transaction, limits);
  const previous = state.operations.get(transaction.operationId);
  if (previous) {
    if (previous.identity !== identity) {
      throw namespaceError('Operation ID already records another intent.', 'SDA_NAMESPACE_OPERATION_ID_REUSED');
    }
    return { state, receipt: previous.receipt, replayed: true };
  }
  if (namespaceRevision(revision) === null || typeof requestDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(requestDigest)) {
    throw namespaceError('An accepted transaction requires a revision and intent digest.');
  }
  for (const condition of transaction.preconditions) {
    const current = state.records.get(addressIdentity(condition))?.version ?? null;
    if (current !== condition.version) {
      throw namespaceError('The record revision changed.', 'SDA_NAMESPACE_REVISION_CONFLICT', {
        namespace: condition.namespace, key: condition.key,
        expectedVersion: condition.version, currentVersion: current
      });
    }
  }
  const records = new Map(state.records), events = new Map(state.events), operations = new Map(state.operations);
  const written = [];
  for (const change of transaction.changes) {
    const address = addressIdentity(change);
    if (records.get(address)?.immutable) {
      throw namespaceError('An immutable version cannot be replaced or deleted.', 'SDA_NAMESPACE_IMMUTABLE');
    }
    const version = change.op === 'delete' ? null : namespaceRevision(`${revision}/record-${written.length + 1}`);
    if (change.op === 'delete') records.delete(address);
    else records.set(address, { namespace: change.namespace, key: change.key,
      version, immutable: change.immutable, value: change.value });
    written.push({ namespace: change.namespace, key: change.key, version });
  }
  for (const event of transaction.events) {
    if (events.has(event.eventId)) {
      throw namespaceError('Event ID already belongs to another transaction.', 'SDA_NAMESPACE_EVENT_ID_REUSED');
    }
    events.set(event.eventId, { ...event, operationId: transaction.operationId, revision });
  }
  const receipt = { operationId: transaction.operationId, scope: normalizedScope, revision, requestDigest,
    records: written, eventIds: transaction.events.map(event => event.eventId) };
  operations.set(transaction.operationId, { identity, receipt });
  return { state: { records, events, operations }, receipt, replayed: false };
}
