/** Conditional transaction data. Normalization chooses no backend and performs no writes. */
import {
  NAMESPACE_LIMITS, addressIdentity, exactObject, namespaceAddress, namespaceError, namespaceIdentifier,
  namespaceIdentityJson, namespaceJson, namespaceName, namespaceRevision, namespaceScope
} from './values.mjs';
import { namespaceLimits } from './contract.mjs';

const ordered = values => values.sort((left, right) => {
  const a = addressIdentity(left), b = addressIdentity(right);
  return a < b ? -1 : a > b ? 1 : 0;
});

function boundedArray(value, maximum, label) {
  if (!Array.isArray(value) || value.length > maximum) throw namespaceError(`${label} exceeds its bound.`, 'SDA_NAMESPACE_LIMIT_INVALID');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some(key => key !== 'length'
    && (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')))) {
    throw namespaceError(`${label} must be a dense data array.`);
  }
  return namespaceJson(value);
}

function uniqueAddresses(values, label) {
  const seen = new Set();
  for (const value of values) {
    const identity = addressIdentity(value);
    if (seen.has(identity)) throw namespaceError(`${label} contains a duplicate record address.`);
    seen.add(identity);
  }
}

export function namespaceTransaction(input, suppliedLimits = NAMESPACE_LIMITS) {
  const limits = namespaceLimits(suppliedLimits);
  const jsonLimits = { maxDepth: limits.maxDepth, maxNodes: limits.maxNodes };
  exactObject(input, ['operationId', 'preconditions', 'changes', 'events'], [], 'Transaction');
  const operationId = namespaceIdentifier(input.operationId, 'Operation ID');
  const preconditions = boundedArray(input.preconditions, limits.maxPreconditions, 'Preconditions').map(value => {
    exactObject(value, ['namespace', 'key', 'version'], [], 'Precondition');
    return Object.freeze({ ...namespaceAddress({ namespace: value.namespace, key: value.key }), version: namespaceRevision(value.version) });
  });
  uniqueAddresses(preconditions, 'Preconditions');
  const conditions = new Map(preconditions.map(value => [addressIdentity(value), value.version]));
  const changes = boundedArray(input.changes, limits.maxChanges, 'Changes').map(value => {
    exactObject(value, ['op', 'namespace', 'key'], ['value', 'immutable'], 'Change');
    const put = value.op === 'put';
    exactObject(value, put ? ['op', 'namespace', 'key', 'value', 'immutable'] : ['op', 'namespace', 'key'], [], 'Change');
    if (!['put', 'delete'].includes(value.op)) throw namespaceError('Unknown record change.');
    const address = namespaceAddress({ namespace: value.namespace, key: value.key });
    if (!conditions.has(addressIdentity(address))) throw namespaceError('Every changed record needs one explicit revision precondition.');
    if (!put && conditions.get(addressIdentity(address)) === null) throw namespaceError('A delete requires an existing revision.');
    if (put && typeof value.immutable !== 'boolean') throw namespaceError('A put declares whether the record is immutable.');
    return Object.freeze(put ? { op: 'put', ...address, immutable: value.immutable,
      value: namespaceJson(value.value, { ...jsonLimits, maxBytes: limits.maxValueBytes }) } : { op: 'delete', ...address });
  });
  uniqueAddresses(changes, 'Changes');
  const eventIds = new Set();
  const events = boundedArray(input.events, limits.maxEvents, 'Events').map(value => {
    exactObject(value, ['eventId', 'eventType', 'namespace', 'payload'], [], 'Event');
    const eventId = namespaceIdentifier(value.eventId, 'Event ID');
    if (eventIds.has(eventId)) throw namespaceError('Transaction contains duplicate event IDs.');
    eventIds.add(eventId);
    return Object.freeze({ eventId, eventType: namespaceIdentifier(value.eventType, 'Event type'),
      namespace: namespaceName(value.namespace), payload: namespaceJson(value.payload, { ...jsonLimits, maxBytes: limits.maxValueBytes }) });
  });
  if (!changes.length && !events.length) throw namespaceError('A transaction must change records or append events.');
  const normalized = { operationId, preconditions: ordered(preconditions), changes: ordered(changes), events };
  return namespaceJson(normalized, { ...jsonLimits, maxBytes: limits.maxTransactionBytes });
}

/** Stable intent bytes include scope, conditions and flags. Events retain their declared order. */
export function namespaceTransactionIdentity(scope, input, limits = NAMESPACE_LIMITS) {
  return `{"scope":${namespaceIdentityJson(namespaceScope(scope))},"transaction":${namespaceIdentityJson(namespaceTransaction(input, limits))}}`;
}
