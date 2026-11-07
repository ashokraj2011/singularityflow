/** Namespace-store draft protocol. Describing/validating an adapter never selects lifecycle authority. */
import { OUTCOME_CLASSES } from '../../foundation/failures.mjs';
/**
 * @typedef {{projectId: string}} NamespaceScope
 * @typedef {{namespace: string, key: string, version: string, immutable: boolean, value: unknown}} NamespaceRecord
 * @typedef {{operationId: string, scope: NamespaceScope, revision: string, requestDigest: string,
 *   records: Array<{namespace: string, key: string, version: string|null}>, eventIds: string[]}} NamespaceReceipt
 * @typedef {{status: 'present', record: NamespaceRecord}|{status: 'missing', record: null}} NamespaceRead
 * @typedef {{snapshot: string, entries: NamespaceRecord[], complete: boolean, continuation: string|null}} NamespacePage
 * @typedef {{status: 'committed', replayed: boolean, receipt: NamespaceReceipt}} NamespaceCommit
 * @typedef {{status: 'committed', receipt: NamespaceReceipt}|{status: 'missing', receipt: null}} NamespaceOperation
 *
 * read(scope, namespace, key, {signal}?) -> NamespaceRead
 * list(scope, namespace, {limit, prefix?, continuation?}, {signal}?) -> NamespacePage
 * transact(scope, transaction, {signal}?) -> NamespaceCommit
 * inspectOperation(scope, operationId, {signal}?) -> NamespaceOperation
 * verify(scope, {signal}?) -> {valid: boolean, errors: string[]}
 *
 * Results are detached JSON data. Missing is an authoritative observation, never a substitute for
 * unavailable/corrupt data. A transaction receipt and its records/events commit in one declared
 * project/backend scope. Snapshot export/restore and production admission are later contracts.
 */
import {
  NAMESPACE_LIMITS, NAMESPACES, exactObject, namespaceError, namespaceIdentifier,
  namespaceJson, namespaceKey, namespaceName, namespaceScope
} from './values.mjs';

export const NAMESPACE_STORE_CONTRACT = 'sda-namespace-store/draft-1';
export const NAMESPACE_STORE_METHODS = Object.freeze(['read', 'list', 'transact', 'inspectOperation', 'verify']);
export const NAMESPACE_STORE_CAPABILITIES = Object.freeze([
  'conditional-transactions', 'idempotent-transactions', 'atomic-records-events-receipts',
  'snapshot-pages', 'immutable-records', 'project-isolation', 'namespace-isolation',
  'cancellation', 'integrity-verification'
]);

export function namespaceLimits(value = {}) {
  exactObject(value, [], Object.keys(NAMESPACE_LIMITS), 'Limits');
  const result = { ...NAMESPACE_LIMITS, ...value };
  for (const [name, maximum] of Object.entries(NAMESPACE_LIMITS)) {
    if (!Number.isSafeInteger(result[name]) || result[name] < 1 || result[name] > maximum) {
      throw namespaceError('Adapter limits must be positive integers within the contract bounds.', 'SDA_NAMESPACE_LIMIT_INVALID');
    }
  }
  return Object.freeze(result);
}

export function namespaceBinding(value) {
  exactObject(value, ['kind'], ['deviceId'], 'Binding');
  if (value.kind === 'shared' && !Object.hasOwn(value, 'deviceId')) return Object.freeze({ kind: 'shared' });
  if (value.kind === 'machine-local' && Object.hasOwn(value, 'deviceId')) {
    return Object.freeze({ kind: 'machine-local', deviceId: namespaceIdentifier(value.deviceId, 'Device ID') });
  }
  throw namespaceError('Choose shared storage or an explicit machine-local device binding.');
}

export function namespaceStoreDescriptor(options) {
  exactObject(options, ['id', 'qualification', 'binding'], ['limits', 'capabilities'], 'Adapter descriptor');
  if (!['production', 'test-only'].includes(options.qualification)) throw namespaceError('Unknown adapter qualification.');
  const capabilities = Object.hasOwn(options, 'capabilities') ? namespaceJson(options.capabilities) : NAMESPACE_STORE_CAPABILITIES;
  if (!Array.isArray(capabilities) || new Set(capabilities).size !== capabilities.length
    || capabilities.some(value => !NAMESPACE_STORE_CAPABILITIES.includes(value))) {
    throw namespaceError('Unknown or duplicate namespace-store capability.');
  }
  return Object.freeze({
    id: namespaceIdentifier(options.id, 'Adapter ID'), contract: NAMESPACE_STORE_CONTRACT,
    qualification: options.qualification, binding: namespaceBinding(options.binding),
    capabilities: Object.freeze([...capabilities]), limits: namespaceLimits(options.limits)
  });
}

export function validateNamespaceStore(adapter) {
  const descriptor = adapter?.descriptor;
  exactObject(descriptor, ['id', 'contract', 'qualification', 'binding', 'capabilities', 'limits'], [], 'Adapter descriptor');
  if (descriptor.contract !== NAMESPACE_STORE_CONTRACT) throw namespaceError('Unsupported namespace-store contract.', 'SDA_NAMESPACE_UNSUPPORTED');
  const { contract: _contract, ...options } = descriptor;
  const validated = namespaceStoreDescriptor(options);
  if (NAMESPACE_STORE_METHODS.some(name => typeof adapter[name] !== 'function')
    || NAMESPACE_STORE_CAPABILITIES.some(name => !validated.capabilities.includes(name))) {
    throw namespaceError('The adapter does not implement the required namespace-store protocol.', 'SDA_NAMESPACE_UNSUPPORTED');
  }
  return adapter;
}

export function assertNamespaceBinding(descriptor, namespace) {
  namespaceName(namespace);
  const binding = namespaceBinding(descriptor?.binding);
  if ((namespace === 'local') !== (binding.kind === 'machine-local')) {
    throw namespaceError('Local content and shared namespaces need separate bindings.', 'SDA_NAMESPACE_UNSUPPORTED');
  }
}

export function namespaceListQuery(input, suppliedLimits = NAMESPACE_LIMITS) {
  const limits = namespaceLimits(suppliedLimits);
  exactObject(input, ['limit'], ['prefix', 'continuation'], 'List query');
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > limits.maxPage) {
    throw namespaceError('Page limit exceeds this adapter\'s declared bounds.', 'SDA_NAMESPACE_LIMIT_INVALID');
  }
  const continuation = input.continuation ?? null;
  if (continuation !== null && (typeof continuation !== 'string' || continuation.length < 1 || continuation.length > 4096)) {
    throw namespaceError('Invalid namespace continuation.', 'SDA_NAMESPACE_CURSOR_INVALID');
  }
  return Object.freeze({ prefix: namespaceKey(Object.hasOwn(input, 'prefix') ? input.prefix : '', { prefix: true }), limit: input.limit, continuation });
}

export function assertNamespaceNotCancelled(signal) {
  if (signal?.aborted) throw namespaceError('The namespace operation was cancelled before it changed anything.', 'SDA_NAMESPACE_CANCELLED');
}

const OUTCOMES = Object.freeze({
  SDA_NAMESPACE_INPUT_INVALID: 'invalid', SDA_NAMESPACE_LIMIT_INVALID: 'limit-invalid',
  SDA_NAMESPACE_CANCELLED: 'cancelled', SDA_NAMESPACE_UNSUPPORTED: 'unsupported',
  SDA_NAMESPACE_UNAVAILABLE: 'unavailable', SDA_NAMESPACE_CORRUPT: 'corrupt',
  SDA_NAMESPACE_CURSOR_INVALID: 'continuation-invalid', SDA_NAMESPACE_CURSOR_EXPIRED: 'continuation-expired',
  SDA_NAMESPACE_IMMUTABLE: 'immutable'
});

export function namespaceStoreOutcome(error) {
  return OUTCOME_CLASSES.includes(error?.outcomeClass) ? error.outcomeClass
    : Object.hasOwn(OUTCOMES, error?.code) ? OUTCOMES[error.code] : 'failed';
}

// Scope validation is exported here as well as from the package's internal namespace entry.
export { namespaceScope, NAMESPACES };
