import { canonicalJson, sha256 } from './canonicalize.mjs';

export const WMB_V4_DETERMINISTIC_EXECUTION_SHA256 = sha256({
  kind: 'world-model-composer-execution-profile',
  id: 'deterministic-renderer',
  version: 1,
  model: 'never'
});

const MODEL_EXECUTION_UNIT_PREFIX = 'governed-model-composer@1';
const MAXIMUM_EXECUTION_UNIT_LENGTH = 1024;
const MAXIMUM_PROFILE_BYTES = 512;
const MAXIMUM_PROVIDER_LENGTH = 128;
const MAXIMUM_REQUESTED_MODEL_LENGTH = 256;
const MAXIMUM_OBSERVED_MODEL_LENGTH = 256;
const MAXIMUM_INVOCATION_ID_LENGTH = 128;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const INVOCATION_ID = /^[A-Za-z0-9._-]+$/;
// Keep this closure aligned with the installed registry without importing provider implementations
// into publication/cache validation.
const INSTALLED_MODEL_PROVIDERS = new Set(['copilot-cli']);

function profileFailure(message) {
  throw new TypeError(`World-model model execution profile ${message}`);
}

function exactString(value, label, maximumLength) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength
      || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    profileFailure(`${label} is invalid.`);
  }
  return value;
}

/** The exact model request identity that participates in durable execution and cache identity. */
export function worldModelModelExecutionProfile({ provider, requestedModel = null } = {}) {
  const normalizedProvider = exactString(provider, 'provider', MAXIMUM_PROVIDER_LENGTH);
  if (!INSTALLED_MODEL_PROVIDERS.has(normalizedProvider)) {
    profileFailure(`provider '${normalizedProvider}' is not installed.`);
  }
  return Object.freeze({
    provider: normalizedProvider,
    requestedModel: exactString(
      requestedModel ?? 'provider-auto', 'requested model', MAXIMUM_REQUESTED_MODEL_LENGTH
    )
  });
}

function parsedModelExecutionProfile(encoded) {
  if (typeof encoded !== 'string' || !BASE64URL.test(encoded) || encoded.length > 768) {
    profileFailure('encoding is invalid.');
  }
  let bytes;
  try { bytes = Buffer.from(encoded, 'base64url'); }
  catch { profileFailure('encoding is invalid.'); }
  if (bytes.toString('base64url') !== encoded) profileFailure('encoding is not canonical.');
  if (bytes.length === 0 || bytes.length > MAXIMUM_PROFILE_BYTES) {
    profileFailure('is too large.');
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) profileFailure('is not UTF-8.');
  let value;
  try { value = JSON.parse(text); }
  catch { profileFailure('is not JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'provider,requestedModel') {
    profileFailure('has invalid keys.');
  }
  const profile = worldModelModelExecutionProfile(value);
  if (canonicalJson(profile) !== text) profileFailure('is not canonical.');
  return profile;
}

function observedModel(value) {
  return value == null
    ? 'unavailable'
    : exactString(value, 'observed model', MAXIMUM_OBSERVED_MODEL_LENGTH);
}

function invocationId(value) {
  if (value == null) return 'unavailable';
  const normalized = exactString(value, 'invocation ID', MAXIMUM_INVOCATION_ID_LENGTH);
  if (!INVOCATION_ID.test(normalized)) profileFailure('invocation ID is invalid.');
  return normalized;
}

/**
 * The durable execution-unit identity. Deterministic materialization keeps its historical static
 * identity; a model materialization binds the route and exact requested provider/model profile.
 */
export function worldModelExecutionUnitManifestSha256({
  route, provider = null, requestedModel = null
} = {}) {
  if (route === 'deterministic') {
    if (provider !== null || requestedModel !== null) {
      profileFailure('deterministic route cannot name a model profile.');
    }
    return WMB_V4_DETERMINISTIC_EXECUTION_SHA256;
  }
  if (route !== 'model') profileFailure('route is invalid.');
  const profile = worldModelModelExecutionProfile({ provider, requestedModel });
  return sha256({
    kind: 'world-model-execution-unit-manifest',
    id: 'wmb-v4-composer',
    version: '1.0.0',
    route,
    provider: profile.provider,
    requestedModel: profile.requestedModel,
    toolPolicy: { mode: 'none' }
  });
}

/** The narrative-composition cache profile; it is distinct from the durable execution-unit hash. */
export function worldModelExecutionProfileSha256({
  route, provider = null, requestedModel = null
} = {}) {
  if (route === 'deterministic') {
    if (provider !== null || requestedModel !== null) {
      profileFailure('deterministic route cannot name a model profile.');
    }
    return null;
  }
  if (route !== 'model') profileFailure('route is invalid.');
  const profile = worldModelModelExecutionProfile({ provider, requestedModel });
  return sha256({
    kind: 'world-model-composer-execution-profile',
    id: 'governed-model-composer',
    version: 1,
    provider: profile.provider,
    model: profile.requestedModel,
    tools: 'none'
  });
}

/**
 * Encode the exact request profile in the materialized stamp, while retaining the provider-observed
 * model as the stamp's separate `model:` field. Base64url is only a transport encoding: parsing
 * reconstructs and re-canonicalizes the profile before it is trusted.
 */
export function createWorldModelExecutionStamp({
  route, provider = null, requestedModel = null, observedModel: observed = null, invocationId: id = null
} = {}) {
  if (route === 'deterministic') {
    if (provider !== null || requestedModel !== null || observed !== null || id !== null) {
      profileFailure('deterministic route cannot name a model profile.');
    }
    return Object.freeze({ executionUnit: 'deterministic-renderer@1', model: 'unavailable' });
  }
  if (route !== 'model') profileFailure('route is invalid.');
  const profile = worldModelModelExecutionProfile({ provider, requestedModel });
  const encoded = Buffer.from(canonicalJson(profile), 'utf8').toString('base64url');
  const executionUnit = `${MODEL_EXECUTION_UNIT_PREFIX}:${encoded}:${invocationId(id)}`;
  if (executionUnit.length > MAXIMUM_EXECUTION_UNIT_LENGTH) profileFailure('stamp is too large.');
  return Object.freeze({ executionUnit, model: observedModel(observed) });
}

function parseModelExecutionStamp(stamp) {
  if (typeof stamp?.executionUnit !== 'string'
      || stamp.executionUnit.length > MAXIMUM_EXECUTION_UNIT_LENGTH
      || typeof stamp?.model !== 'string') return null;
  const match = stamp.executionUnit.match(
    /^governed-model-composer@1:([A-Za-z0-9_-]+):([A-Za-z0-9._-]+)$/
  );
  if (!match || match[2].length > MAXIMUM_INVOCATION_ID_LENGTH) return null;
  try {
    return Object.freeze({
      profile: parsedModelExecutionProfile(match[1]),
      invocationId: invocationId(match[2]),
      observedModel: observedModel(stamp.model)
    });
  } catch {
    return null;
  }
}

/**
 * Resolve the composition route from the sealed execution identity and independently parsed view
 * stamp. The receipt owns the route; the stamp must agree so neither representation can weaken the
 * other's validation boundary.
 */
export function verifiedWorldModelExecutionRoute(execution, stamp, {
  route = null, provider = null, requestedModel = null, observedModel: expectedObservedModel = null
} = {}) {
  const stampIsDeterministic = stamp?.executionUnit === 'deterministic-renderer@1'
    && stamp?.model === 'unavailable';
  if (execution?.executionUnitManifestSha256 === WMB_V4_DETERMINISTIC_EXECUTION_SHA256
      && stampIsDeterministic && (route === null || route === 'deterministic')
      && provider === null && requestedModel === null && expectedObservedModel === null) {
    return 'deterministic';
  }
  const model = parseModelExecutionStamp(stamp);
  if (!model || (route !== null && route !== 'model')) return null;
  if (provider !== null && model.profile.provider !== provider) return null;
  if (requestedModel !== null && model.profile.requestedModel !== requestedModel) return null;
  if (expectedObservedModel !== null && model.observedModel !== expectedObservedModel) return null;
  return execution?.executionUnitManifestSha256 === worldModelExecutionUnitManifestSha256({
    route: 'model',
    provider: model.profile.provider,
    requestedModel: model.profile.requestedModel
  }) ? 'model' : null;
}
