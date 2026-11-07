/** Pure values for the namespace-store draft. No paths, processes, credentials or storage access. */
import { SingularityFlowError } from '../../foundation/failures.mjs';

export const NAMESPACE_LIMITS = Object.freeze({
  maxPage: 1000, maxChanges: 128, maxPreconditions: 256, maxEvents: 128,
  maxValueBytes: 65_536, maxTransactionBytes: 262_144, maxDepth: 24, maxNodes: 20_000
});
export const NAMESPACES = Object.freeze(['config', 'state', 'evidence', 'runtime', 'local']);
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

export function exactObject(value, required, optional = [], label = 'Value') {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw namespaceError(`${label} must be a plain object.`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !allowed.has(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw namespaceError(`${label} contains an unsupported field or accessor.`);
    }
  }
  if (required.some(key => !Object.hasOwn(value, key))) throw namespaceError(`${label} is missing a required field.`);
  return value;
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

function encode(value) {
  if (Array.isArray(value)) return `[${value.map(encode).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${encode(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Reject lossy/non-JSON inputs and return an immutable detached value, including dangerous key spellings. */
export function namespaceJson(value, {
  maxBytes = NAMESPACE_LIMITS.maxTransactionBytes, maxDepth = NAMESPACE_LIMITS.maxDepth, maxNodes = NAMESPACE_LIMITS.maxNodes
} = {}) {
  for (const [value, maximum] of [[maxBytes, NAMESPACE_LIMITS.maxTransactionBytes],
    [maxDepth, NAMESPACE_LIMITS.maxDepth], [maxNodes, NAMESPACE_LIMITS.maxNodes]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw namespaceError('Invalid namespace JSON bound.', 'SDA_NAMESPACE_LIMIT_INVALID');
    }
  }
  let nodes = 0;
  let minimumBytes = 0;
  const budget = amount => {
    minimumBytes += amount;
    if (minimumBytes > maxBytes) throw namespaceError('JSON exceeds the namespace byte limit.', 'SDA_NAMESPACE_LIMIT_INVALID');
  };
  const ancestors = new Set();
  const copy = (item, depth) => {
    if (++nodes > maxNodes || depth > maxDepth) {
      throw namespaceError('JSON exceeds the namespace contract bounds.', 'SDA_NAMESPACE_LIMIT_INVALID');
    }
    if (item === null || typeof item === 'boolean' || typeof item === 'string'
      || (typeof item === 'number' && Number.isFinite(item))) {
      if (typeof item === 'string' && item.length > maxBytes) {
        throw namespaceError('JSON exceeds the namespace byte limit.', 'SDA_NAMESPACE_LIMIT_INVALID');
      }
      budget(JSON.stringify(item).length);
      return Object.is(item, -0) ? 0 : item;
    }
    if (!item || typeof item !== 'object' || ancestors.has(item)
      || (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))) {
      throw namespaceError('Namespace data must be finite, acyclic plain JSON.');
    }
    ancestors.add(item);
    const result = Array.isArray(item) ? [] : {};
    const keys = Reflect.ownKeys(item);
    if (Array.isArray(item) && (keys.length !== item.length + 1
      || keys.some(key => key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= item.length)))) {
      throw namespaceError('Sparse or extended arrays are not JSON records.');
    }
    budget(2 + Math.max(0, keys.length - (Array.isArray(item) ? 1 : 0) - 1));
    for (const key of keys) {
      if (Array.isArray(item) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw namespaceError('Namespace JSON cannot contain accessors, symbols or hidden properties.');
      }
      budget(Array.isArray(item) ? 0 : JSON.stringify(key).length + 1);
      Object.defineProperty(result, key, { value: copy(descriptor.value, depth + 1), enumerable: true });
    }
    ancestors.delete(item);
    return Object.freeze(result);
  };
  const result = copy(value, 0);
  if (new TextEncoder().encode(encode(result)).byteLength > maxBytes) {
    throw namespaceError('JSON exceeds the namespace byte limit.', 'SDA_NAMESPACE_LIMIT_INVALID');
  }
  return result;
}

/** Identity bytes for this new draft only; existing record encodings and hashes are untouched. */
export function namespaceIdentityJson(value) {
  return encode(namespaceJson(value));
}
