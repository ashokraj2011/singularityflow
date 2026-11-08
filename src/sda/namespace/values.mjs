import { jsonValueContract } from '../../foundation/record-schema.mjs';
/** Pure values for the namespace-store draft. No paths, processes, credentials or storage access. */
import { SingularityFlowError } from '../../foundation/failures.mjs';

export const NAMESPACE_LIMITS = Object.freeze({
  maxPage: 1000, maxChanges: 128, maxPreconditions: 256, maxEvents: 128,
  maxValueBytes: 65_536, maxTransactionBytes: 262_144, maxDepth: 24, maxNodes: 20_000
});
export const NAMESPACES = Object.freeze(['config', 'state', 'evidence', 'runtime', 'local']);
const jsonValues=jsonValueContract({maximumBytes:NAMESPACE_LIMITS.maxTransactionBytes,maximumDepth:NAMESPACE_LIMITS.maxDepth,
  maximumNodes:NAMESPACE_LIMITS.maxNodes,inputCode:'SDA_NAMESPACE_INPUT_INVALID',limitCode:'SDA_NAMESPACE_LIMIT_INVALID'});
const {exactObject,namespaceJson,encode}=jsonValues;
export {exactObject,namespaceJson};
const CLASSES = Object.freeze({
  SDA_NAMESPACE_REVISION_CONFLICT: 'REVISION_CONFLICT',
  SDA_NAMESPACE_OPERATION_ID_REUSED: 'OPERATION_ID_REUSE',
  SDA_NAMESPACE_EVENT_ID_REUSED: 'OPERATION_ID_REUSE',
  SDA_NAMESPACE_OUTCOME_UNKNOWN: 'OUTCOME_UNKNOWN'
});

export function namespaceError(message, code = 'SDA_NAMESPACE_INPUT_INVALID', details = null, cause = undefined) {
  return new SingularityFlowError(message, { code, details, cause,
    outcomeClass: Object.hasOwn(CLASSES, code) ? CLASSES[code] : null });
}



export function namespaceIdentifier(value, label = 'Identifier') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw namespaceError(`${label} must be a bounded logical identifier.`);
  }
  return value;
}

export function namespaceScope(value) {
  exactObject(value, ['projectId'], [], 'Scope');
  return Object.freeze({ projectId: namespaceIdentifier(value.projectId, 'Project ID') });
}

export function namespaceName(value) {
  if (!NAMESPACES.includes(value)) throw namespaceError('Unknown namespace.');
  return value;
}

export function namespaceKey(value, { prefix = false } = {}) {
  if (typeof prefix !== 'boolean') throw namespaceError('Prefix mode must be a boolean.');
  if (prefix && value === '') return value;
  const checked = prefix && typeof value === 'string' && value.endsWith('/') ? value.slice(0, -1) : value;
  if (typeof checked !== 'string' || checked.length < 1 || value.length > 512
    || !checked.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(part))) {
    throw namespaceError('A key must be a bounded logical key, not a filesystem path.');
  }
  return value;
}

export function namespaceRevision(value) {
  if (value === null) return value; // Explicit absence; an omitted revision is never an unconditional write.
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw namespaceError('A revision must be an opaque nonempty token or explicit null.');
  }
  return value;
}

export function namespaceAddress(value) {
  exactObject(value, ['namespace', 'key'], [], 'Record address');
  return Object.freeze({ namespace: namespaceName(value.namespace), key: namespaceKey(value.key) });
}

export const addressIdentity = ({ namespace, key }) => JSON.stringify([namespace, key]);



/** Reject lossy/non-JSON inputs and return an immutable detached value, including dangerous key spellings. */


/** Identity bytes for this new draft only; existing record encodings and hashes are untouched. */
export function namespaceIdentityJson(value) {
  return encode(namespaceJson(value));
}
