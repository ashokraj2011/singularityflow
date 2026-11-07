/** Large immutable bytes are separate from conditional metadata transactions. No host I/O. */
import { SingularityFlowError } from '../../foundation/failures.mjs';
import { exactObject, namespaceName, namespaceScope } from '../namespace/values.mjs';
import { namespaceBinding } from '../namespace/contract.mjs';

export const CONTENT_STORE_CONTRACT = 'sda-content-store/draft-1';
export const CONTENT_LIMITS = Object.freeze({ maximumBytes: 134_217_728 });
export const CONTENT_STORE_METHODS = Object.freeze(['put', 'read']);

export function contentError(message, code = 'SDA_CONTENT_INPUT_INVALID', details = null, cause = undefined) {
  return new SingularityFlowError(message, { code, details, cause,
    outcomeClass: code === 'SDA_CONTENT_OUTCOME_UNKNOWN' ? 'OUTCOME_UNKNOWN' : null });
}

export function contentReference(value, maximumBytes = CONTENT_LIMITS.maximumBytes) {
  exactObject(value, ['namespace', 'sha256', 'bytes'], [], 'Content reference');
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > CONTENT_LIMITS.maximumBytes
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)
    || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > maximumBytes) {
    throw contentError('A content reference requires a namespace, SHA-256 and bounded byte count.');
  }
  return Object.freeze({ namespace: namespaceName(value.namespace), sha256: value.sha256, bytes: value.bytes });
}

export function contentStoreDescriptor(value) {
  exactObject(value, ['id', 'binding', 'maximumBytes']);
  if (typeof value.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.id)
    || !Number.isSafeInteger(value.maximumBytes) || value.maximumBytes < 1 || value.maximumBytes > CONTENT_LIMITS.maximumBytes) {
    throw contentError('Invalid content-store descriptor.');
  }
  return Object.freeze({ id: value.id, contract: CONTENT_STORE_CONTRACT,
    binding: namespaceBinding(value.binding), maximumBytes: value.maximumBytes });
}

export function validateContentStore(store) {
  const descriptor = store?.descriptor;
  exactObject(descriptor, ['id', 'contract', 'binding', 'maximumBytes']);
  if (descriptor.contract !== CONTENT_STORE_CONTRACT || CONTENT_STORE_METHODS.some(name => typeof store[name] !== 'function')) {
    throw contentError('Unsupported content-store protocol.', 'SDA_CONTENT_UNSUPPORTED');
  }
  const { contract: _contract, ...value } = descriptor; contentStoreDescriptor(value);
  return store;
}

export function contentReadOptions(value = {}, maximumBytes = CONTENT_LIMITS.maximumBytes) {
  exactObject(value, [], ['maximumBytes', 'signal'], 'Content read options');
  const limit = value.maximumBytes ?? maximumBytes;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > maximumBytes) throw contentError('Invalid content read budget.');
  return { maximumBytes: limit, signal: value.signal ?? null };
}

export function assertContentBinding(descriptor, scope, namespace, signal = null) {
  const selected = namespaceScope(scope); namespaceName(namespace);
  if ((namespace === 'local') !== (descriptor.binding.kind === 'machine-local')) {
    throw contentError('Machine-local bytes require their separate device binding.', 'SDA_CONTENT_UNSUPPORTED');
  }
  if (signal?.aborted) throw contentError('Content operation cancelled before acceptance.', 'SDA_CONTENT_CANCELLED');
  return selected;
}
