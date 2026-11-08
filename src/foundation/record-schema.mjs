/** Pure durable-record format, identity capabilities and version admission. */
import { SingularityFlowError } from './failures.mjs';

export const TEXT_DIGEST_PROFILE = 'sflow-text-digests/sha256-utf8-v1';
const TEXT_DIGEST_CAPABILITIES = new WeakMap();

export const RECORD_BYTES_PROFILE = 'sflow-record-bytes/utf8-v1';
const RECORD_BYTE_SYNTAX = new WeakMap();

export const TEXT_VALUE_SYNTAX_PROFILE = 'sflow-text-values/utf8-sha256-v1';
const TEXT_VALUE_SYNTAX = new WeakMap();

/** Raw text primitives retain their native invalid-value errors; rules own valid-domain checks. */
export function textValueSyntax(port) {
  const invalid = () => { throw new SingularityFlowError('Text rules require one frozen, explicit UTF-8 size/hash capability.', { code: 'ENGINE_TEXT_VALUE_SYNTAX_INVALID' }); };
  if (!port || typeof port !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(port)) || !Object.isFrozen(port)) invalid();
  const fields = Object.getOwnPropertyDescriptors(port), keys = Reflect.ownKeys(fields);
  if (keys.length !== 3 || keys.some(key => !['profile', 'byteLengthUtf8', 'sha256Utf8'].includes(key))) invalid();
  for (const key of keys) if (!fields[key].enumerable || !Object.hasOwn(fields[key], 'value')
    || (key === 'profile' ? fields[key].value !== TEXT_VALUE_SYNTAX_PROFILE : typeof fields[key].value !== 'function')) invalid();
  if (TEXT_VALUE_SYNTAX.has(port)) return TEXT_VALUE_SYNTAX.get(port);
  const size = fields.byteLengthUtf8.value, hash = fields.sha256Utf8.value;
  const syntax = Object.freeze({
    byteLengthUtf8(value) {
      const result = Reflect.apply(size, port, [value]);
      if (!Number.isSafeInteger(result) || result < 0) throw new SingularityFlowError('Text syntax did not return an exact UTF-8 byte count.', { code: 'ENGINE_TEXT_VALUE_SYNTAX_RESULT_INVALID' });
      return result;
    },
    sha256Utf8(value) {
      const result = Reflect.apply(hash, port, [value]);
      if (typeof result !== 'string' || !/^[a-f0-9]{64}$/u.test(result)) throw new SingularityFlowError('Text syntax did not return an exact lowercase SHA-256 digest.', { code: 'ENGINE_TEXT_VALUE_SYNTAX_RESULT_INVALID' });
      return result;
    }
  });
  TEXT_VALUE_SYNTAX.set(port, syntax); return syntax;
}

/** Capture byte-value primitives only. Parsing, cloning and schema admission belong to foundation. */
export function recordJsonSyntax(port) {
  const invalid = () => { throw new SingularityFlowError('Record parsing requires one frozen, explicit UTF-8 byte capability.', {
    code: 'ENGINE_RECORD_BYTES_PORT_INVALID'
  }); };
  if (!port || typeof port !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(port)) || !Object.isFrozen(port)) invalid();
  const fields = Object.getOwnPropertyDescriptors(port), keys = Reflect.ownKeys(fields);
  if (keys.length !== 3 || keys.some(key => !['profile', 'isBytes', 'decodeUtf8'].includes(key))) invalid();
  for (const key of keys) if (!fields[key].enumerable || !Object.hasOwn(fields[key], 'value')
    || (key === 'profile' ? fields[key].value !== RECORD_BYTES_PROFILE : typeof fields[key].value !== 'function')) invalid();
  if (RECORD_BYTE_SYNTAX.has(port)) return RECORD_BYTE_SYNTAX.get(port);
  const isBytes = fields.isBytes.value, decodeUtf8 = fields.decodeUtf8.value;
  const syntax = Object.freeze({ parseObject(rawBytes) {
    if (rawBytes != null && typeof rawBytes === 'object' && !Array.isArray(rawBytes) && !(rawBytes instanceof Uint8Array)
        && [Object.prototype, null].includes(Object.getPrototypeOf(rawBytes))) return structuredClone(rawBytes);
    let text;
    if (typeof rawBytes === 'string') text = rawBytes;
    else {
      const bytes = Reflect.apply(isBytes, port, [rawBytes]);
      if (typeof bytes !== 'boolean') throw new SingularityFlowError('The record byte capability did not return an exact byte classification.', { code: 'ENGINE_RECORD_BYTES_RESULT_INVALID' });
      if (!bytes) throw new SingularityFlowError('Durable record bytes must be UTF-8 JSON.', { code: 'SCHEMA_RECORD_INVALID' });
      text = Reflect.apply(decodeUtf8, port, [rawBytes]);
      if (typeof text !== 'string') throw new SingularityFlowError('The record byte capability did not return UTF-8 text.', { code: 'ENGINE_RECORD_BYTES_RESULT_INVALID' });
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed) || parsed instanceof Uint8Array
          || ![Object.prototype, null].includes(Object.getPrototypeOf(parsed))) throw new Error('top-level value is not an object');
      return parsed;
    } catch (error) {
      throw new SingularityFlowError(`Durable record is not valid JSON: ${error.message}`, { code: 'SCHEMA_RECORD_INVALID', cause: error });
    }
  } });
  RECORD_BYTE_SYNTAX.set(port, syntax);
  return syntax;
}

// One unchanged v1 record family, shared by the portable policy reader and native registry.
export const APPLICATION_REVIEW_POLICY_SCHEMA = Object.freeze({ id: 'application-review-policy',
  currentVersion: 1, minimumReadableVersion: 1, maximumReadableVersion: 1, unversionedAs: 1,
  immutable: true, migrationPolicy: 'migrate-on-read' });

export const REPOSITORY_COMMIT_POLICY_SCHEMAS = Object.freeze({
  policy: Object.freeze({ id: 'repository-commit-policy', currentVersion: 1, minimumReadableVersion: 1,
    maximumReadableVersion: 1, unversionedAs: null, immutable: true, migrationPolicy: 'migrate-on-read' }),
  profile: Object.freeze({ id: 'repository-commit-policy-profile', currentVersion: 1, minimumReadableVersion: 1,
    maximumReadableVersion: 1, unversionedAs: null, immutable: true, migrationPolicy: 'migrate-on-read' })
});

/** Capture a synchronous text primitive without invoking it or evaluating an accessor. */
export function textDigestCapability(port) {
  const invalid = () => { throw new SingularityFlowError('Record identity requires one frozen, explicit UTF-8 SHA-256 capability.', {
    code: 'ENGINE_TEXT_DIGEST_PORT_INVALID'
  }); };
  if (!port || typeof port !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(port)) || !Object.isFrozen(port)) invalid();
  const fields = Object.getOwnPropertyDescriptors(port), keys = Reflect.ownKeys(fields);
  if (keys.length !== 2 || keys.some(key => !['profile', 'sha256Utf8'].includes(key))
    || !fields.profile?.enumerable || !Object.hasOwn(fields.profile, 'value') || fields.profile.value !== TEXT_DIGEST_PROFILE
    || !fields.sha256Utf8?.enumerable || !Object.hasOwn(fields.sha256Utf8, 'value') || typeof fields.sha256Utf8.value !== 'function') invalid();
  if (TEXT_DIGEST_CAPABILITIES.has(port)) return TEXT_DIGEST_CAPABILITIES.get(port);
  const method = fields.sha256Utf8.value;
  const capability = Object.freeze({ sha256Utf8(value) {
    if (typeof value !== 'string') throw new SingularityFlowError('The text digest capability requires a string.', { code: 'ENGINE_TEXT_DIGEST_INPUT_INVALID' });
    const digest = Reflect.apply(method, port, [value]);
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest)) throw new SingularityFlowError(
      'The text digest capability did not return an exact lowercase SHA-256 digest.', { code: 'ENGINE_TEXT_DIGEST_RESULT_INVALID' });
    return digest;
  } });
  TEXT_DIGEST_CAPABILITIES.set(port, capability);
  return capability;
}

// Shared immutable format metadata, not backend selection or model/World Model behavior.
const frozenFamily = id => Object.freeze({ id, currentVersion: 1, minimumReadableVersion: 1,
  maximumReadableVersion: 1, unversionedAs: null, immutable: true, migrationPolicy: 'frozen-identity' });
export const NAMESPACE_STORAGE_SCHEMAS = Object.freeze({
  manifest: frozenFamily('namespace-filesystem-manifest'),
  entry: frozenFamily('namespace-filesystem-entry')
});
export const SQLITE_NAMESPACE_SCHEMAS = Object.freeze({
  manifest: frozenFamily('namespace-sqlite-manifest'),
  entry: frozenFamily('namespace-sqlite-entry')
});
export const CONTENT_STORAGE_SCHEMA = frozenFamily('content-sqlite-manifest');
export const NAMESPACE_READER_SCHEMAS = Object.freeze({
  head: frozenFamily('namespace-story-read-head'), state: frozenFamily('namespace-story-read-state'),
  policy: frozenFamily('namespace-story-read-policy'), documents: frozenFamily('namespace-story-document-index')
});
export const NAMESPACE_LIFECYCLE_SCHEMAS = Object.freeze({
  authority: frozenFamily('namespace-lifecycle-authority'), configuration: frozenFamily('namespace-lifecycle-configuration'),
  head: frozenFamily('namespace-lifecycle-head'),
  // Immutable bodies keep their stored version and identity; readers dispatch without migration.
  state: Object.freeze({ id: 'namespace-lifecycle-state', currentVersion: 2, minimumReadableVersion: 1,
    maximumReadableVersion: 2, unversionedAs: null, immutable: true, migrationPolicy: 'preserve-versions' }),
  prepared: frozenFamily('namespace-lifecycle-prepared'), manifest: frozenFamily('namespace-lifecycle-manifest')
});
export const NAMESPACE_ENROLLMENT_SCHEMAS = Object.freeze({
  intent: frozenFamily('namespace-enrollment-intent'), manifest: frozenFamily('namespace-enrollment-manifest')
});
export const NAMESPACE_CONFIGURATION_SCHEMAS = Object.freeze({
  source: frozenFamily('namespace-configuration-source'), compiled: frozenFamily('namespace-configuration-compiled'),
  head: frozenFamily('namespace-configuration-head'), intent: frozenFamily('namespace-configuration-intent'),
  manifest: frozenFamily('namespace-configuration-manifest')
});
// Wire shape constraints, selected here without rewriting an immutable historical body.
const LIFECYCLE_STATE_PROFILES = Object.freeze({
  1: Object.freeze({ requireOwnedCurrentPhase: false, terminalStatuses: Object.freeze([]) }),
  2: Object.freeze({ requireOwnedCurrentPhase: true, terminalStatuses: Object.freeze(['closed', 'cancelled']) })
});

export function namespaceLifecycleRecordProfile(kind, input) {
  if (!Object.hasOwn(NAMESPACE_LIFECYCLE_SCHEMAS, kind)) {
    throw new SingularityFlowError('Unknown namespace lifecycle record family.', { code: 'SCHEMA_FAMILY_UNKNOWN' });
  }
  const { storedVersion } = admitRecordSchemaVersion(NAMESPACE_LIFECYCLE_SCHEMAS[kind], input);
  return Object.freeze({ format: `sflow-namespace-lifecycle-${kind}/v${storedVersion}`,
    state: kind === 'state' ? LIFECYCLE_STATE_PROFILES[storedVersion] : null });
}
// Historical view records retain their original schema and compatibility export indefinitely.
export const WORLD_MODEL_VIEW_CONTRACT_SCHEMA_VERSION = frozenFamily('world-model-view-contract').currentVersion;
// Writers need the current wire stamp, not every historical migration function.
export const COMMAND_TIMING_SCHEMA = Object.freeze({ id: 'dx-command-timing', currentVersion: 6 });

export function admitRecordSchemaVersion(entry, input) {
  const familyId = entry.id;
  let record = input;
  const storedVersion = Number.isInteger(record.schemaVersion) && record.schemaVersion > 0
    ? record.schemaVersion
    : entry.unversionedAs;
  if (storedVersion != null && record.schemaVersion == null) record = { ...record, schemaVersion: storedVersion };
  if (!Number.isInteger(storedVersion) || storedVersion < 1) {
    throw new SingularityFlowError(`Durable record '${familyId}' has no valid schemaVersion.`, {
      code: 'SCHEMA_VERSION_MISSING', details: { family: familyId, received: storedVersion ?? null }
    });
  }
  const future = storedVersion > entry.maximumReadableVersion;
  if (future || storedVersion < entry.minimumReadableVersion) {
    const direction = future ? 'above' : 'below';
    const recovery = future ? 'it was written by a newer sflow — upgrade to read it.'
      : 'use the archival reader for that release or a republication with recorded lineage.';
    throw new SingularityFlowError(
      `Durable record '${familyId}' is stored at schema version ${storedVersion} (v${storedVersion}), ${direction} this build's readable range v${entry.minimumReadableVersion}–v${entry.maximumReadableVersion}; ${recovery}`,
      { code: future ? 'SCHEMA_VERSION_FUTURE' : 'SCHEMA_VERSION_ARCHIVED',
        details: { family: familyId, storedVersion, readable: { minimum: entry.minimumReadableVersion, maximum: entry.maximumReadableVersion } } }
    );
  }
  return { record, storedVersion };
}



function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}


export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}


/** The ledger's historical compact identity uses the same key ordering, without display spaces. */
export function compactCanonicalJson(value) {
  return `${JSON.stringify(canonicalize(value))}\n`;
}


/** Closed, bounded JSON value grammar. Limits/codes are data; no adapter or admission callbacks. */
export function jsonValueContract(options) {
  const keys=['maximumBytes','maximumDepth','maximumNodes','inputCode','limitCode'];
  if(!options || ![Object.prototype,null].includes(Object.getPrototypeOf(options))
    || Reflect.ownKeys(options).length!==keys.length || keys.some(key=>{const d=Object.getOwnPropertyDescriptor(options,key);return !d?.enumerable || !Object.hasOwn(d,'value');})
    || !Number.isSafeInteger(options.maximumBytes) || options.maximumBytes<1 || options.maximumBytes>134_217_728
    || !Number.isSafeInteger(options.maximumDepth) || options.maximumDepth<1 || options.maximumDepth>64
    || !Number.isSafeInteger(options.maximumNodes) || options.maximumNodes<1 || options.maximumNodes>250_000
    || ![options.inputCode,options.limitCode].every(value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,127}$/u.test(value))) {
    throw new SingularityFlowError('Invalid closed JSON value contract.',{code:'ENGINE_JSON_CONTRACT_INVALID'});
  }
  const NAMESPACE_LIMITS=Object.freeze({maxTransactionBytes:options.maximumBytes,maxDepth:options.maximumDepth,maxNodes:options.maximumNodes});
  const inputCode=options.inputCode,limitCode=options.limitCode;
  const namespaceError=(message,code=inputCode)=>new SingularityFlowError(message,{code,details:null});
function exactObject(value, required, optional = [], label = 'Value') {
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

function encode(value) {
  if (Array.isArray(value)) return `[${value.map(encode).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${encode(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function namespaceJson(value, {
  maxBytes = NAMESPACE_LIMITS.maxTransactionBytes, maxDepth = NAMESPACE_LIMITS.maxDepth, maxNodes = NAMESPACE_LIMITS.maxNodes
} = {}) {
  for (const [value, maximum] of [[maxBytes, NAMESPACE_LIMITS.maxTransactionBytes],
    [maxDepth, NAMESPACE_LIMITS.maxDepth], [maxNodes, NAMESPACE_LIMITS.maxNodes]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw namespaceError('Invalid namespace JSON bound.', limitCode);
    }
  }
  let nodes = 0;
  let minimumBytes = 0;
  const budget = amount => {
    minimumBytes += amount;
    if (minimumBytes > maxBytes) throw namespaceError('JSON exceeds the namespace byte limit.', limitCode);
  };
  const ancestors = new Set();
  const copy = (item, depth) => {
    if (++nodes > maxNodes || depth > maxDepth) {
      throw namespaceError('JSON exceeds the namespace contract bounds.', limitCode);
    }
    if (item === null || typeof item === 'boolean' || typeof item === 'string'
      || (typeof item === 'number' && Number.isFinite(item))) {
      if (typeof item === 'string' && item.length > maxBytes) {
        throw namespaceError('JSON exceeds the namespace byte limit.', limitCode);
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
    throw namespaceError('JSON exceeds the namespace byte limit.', limitCode);
  }
  return result;
}
  return Object.freeze({exactObject,namespaceJson,encode});
}
