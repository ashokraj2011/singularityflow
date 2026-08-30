import { SingularityFlowError } from '../../util.mjs';
import {
  clonePlatformJson, isPlainPlatformObject, platformSha256, validatePlatformRecord
} from './contracts.mjs';
import { verifySignedPlatformRecord } from './signatures.mjs';

function fail(message, code = 'SGOS_SECRET_BROKER_INVALID') {
  throw new SingularityFlowError(message, { code });
}

function exactObject(value, allowed, label) {
  if (!isPlainPlatformObject(value)) fail(`${label} must be an object.`);
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) if (!accepted.has(key)) fail(`${label} contains unknown field '${key}'.`);
}

function operationalNow() {
  return new Date().toISOString();
}

const MAXIMUM_EPHEMERAL_SECRET_BYTES = 64 * 1024;

function adapterAuthorization(value, adapterId) {
  exactObject(value, [
    'manifestSha256', 'brokerIds', 'purposes', 'audiences'
  ], `secret-authorized adapter '${adapterId}'`);
  if (!/^sha256:[a-f0-9]{64}$/.test(String(value.manifestSha256 ?? ''))
      || !Array.isArray(value.brokerIds) || !Array.isArray(value.purposes)
      || !Array.isArray(value.audiences)) {
    fail(`Secret-authorized adapter '${adapterId}' has an invalid profile.`,
      'SGOS_SECRET_ADAPTER_UNAUTHORIZED');
  }
  for (const list of [value.brokerIds, value.purposes, value.audiences]) {
    if (!list.length || list.some((entry) => typeof entry !== 'string' || !entry)
        || new Set(list).size !== list.length) {
      fail(`Secret-authorized adapter '${adapterId}' has an invalid scope.`,
        'SGOS_SECRET_ADAPTER_UNAUTHORIZED');
    }
  }
  return Object.freeze(clonePlatformJson(value));
}

function containsSecretBytes(value, secret) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { return true; }
  if (typeof encoded !== 'string') return true;
  const probes = [secret.toString('utf8'), secret.toString('base64'), secret.toString('hex')]
    .filter((entry) => entry.length >= 4);
  return probes.some((probe) => encoded.includes(probe));
}

export function createSecretBrokerRegistry({
  trustedIssuers,
  resolvers = {},
  authorizedAdapters = {}
}) {
  if (!isPlainPlatformObject(trustedIssuers) || !Object.keys(trustedIssuers).length) {
    fail('Secret broker registry requires explicit trusted issuer keys.', 'SGOS_SECRET_BROKER_UNTRUSTED');
  }
  if (!isPlainPlatformObject(resolvers) || Object.values(resolvers)
    .some((resolver) => typeof resolver !== 'function')) {
    fail('Secret Broker resolvers must be an explicit broker-to-function map.');
  }
  if (!isPlainPlatformObject(authorizedAdapters)) {
    fail('Secret Broker authorizedAdapters must be an explicit map.');
  }
  const issuers = new Map(Object.entries(trustedIssuers));
  const resolverMap = new Map(Object.entries(resolvers));
  const adapterMap = new Map(Object.entries(authorizedAdapters).map(([adapterId, value]) => [
    adapterId, adapterAuthorization(value, adapterId)
  ]));
  const brokers = new Map();
  const handles = new Map();
  const revoked = new Set();

  function brokerFor(brokerId, at) {
    const signed = brokers.get(brokerId);
    if (!signed) fail(`Secret broker '${brokerId}' is not attested.`, 'SGOS_SECRET_BROKER_UNTRUSTED');
    const keyId = signed.record.issuerKeyId;
    const trustedPublicKeyPem = issuers.get(keyId);
    if (!trustedPublicKeyPem) fail(`Secret broker issuer '${keyId}' is not trusted.`, 'SGOS_SECRET_BROKER_UNTRUSTED');
    const record = verifySignedPlatformRecord(signed, {
      trustedPublicKeyPem,
      expectedKeyId: keyId,
      expectedKind: 'platform-secret-broker-attestation'
    });
    const instant = Date.parse(at);
    if (!Number.isFinite(instant) || instant < Date.parse(record.validFrom) || instant >= Date.parse(record.expiresAt)) {
      fail(`Secret broker '${brokerId}' attestation is not currently valid.`, 'SGOS_SECRET_BROKER_EXPIRED');
    }
    return record;
  }

  return Object.freeze({
    profile: 'local-reference-only-v1',

    registerBroker(signedAttestation) {
      const claimed = validatePlatformRecord(signedAttestation?.record, 'platform-secret-broker-attestation');
      const trustedPublicKeyPem = issuers.get(claimed.issuerKeyId);
      if (!trustedPublicKeyPem) fail(`Secret broker issuer '${claimed.issuerKeyId}' is not trusted.`, 'SGOS_SECRET_BROKER_UNTRUSTED');
      const record = verifySignedPlatformRecord(signedAttestation, {
        trustedPublicKeyPem,
        expectedKeyId: claimed.issuerKeyId,
        expectedKind: 'platform-secret-broker-attestation'
      });
      brokers.set(record.brokerId, clonePlatformJson(signedAttestation));
      try { brokerFor(record.brokerId, operationalNow()); } catch (error) {
        brokers.delete(record.brokerId);
        throw error;
      }
      return record;
    },

    registerHandle(signedHandle) {
      exactObject(signedHandle, ['record', 'signature'], 'signed secret handle');
      const now = operationalNow();
      const claimed = validatePlatformRecord(signedHandle.record, 'platform-secret-handle');
      const broker = brokerFor(claimed.brokerId, now);
      const trustedPublicKeyPem = issuers.get(broker.issuerKeyId);
      const record = verifySignedPlatformRecord(signedHandle, {
        trustedPublicKeyPem,
        expectedKeyId: broker.issuerKeyId,
        expectedKind: 'platform-secret-handle'
      });
      if (record.brokerAttestationSha256 !== broker.recordSha256) {
        fail('Secret handle is not bound to the current broker attestation.', 'SGOS_SECRET_BROKER_UNTRUSTED');
      }
      if (!broker.purposes.includes(record.purpose) || !broker.audiences.includes(record.audience)) {
        fail('Secret handle purpose or audience is not allowed by the broker attestation.', 'SGOS_SECRET_SCOPE_DENIED');
      }
      const expiresAt = Date.parse(record.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt > Date.parse(broker.expiresAt) || expiresAt <= Date.parse(now)
          || Date.parse(record.attestedAt) < Date.parse(broker.validFrom)
          || Date.parse(record.attestedAt) > Date.parse(now)) {
        fail('Secret handle expiry must be in the future and before broker attestation expiry.', 'SGOS_SECRET_HANDLE_EXPIRED');
      }
      handles.set(record.recordSha256, record);
      return record;
    },

    verifyHandle(handleSha256, { purpose, audience } = {}) {
      const record = handles.get(handleSha256);
      if (!record) fail('Secret handle is unavailable.', 'SGOS_SECRET_HANDLE_UNAVAILABLE');
      validatePlatformRecord(record, 'platform-secret-handle');
      if (revoked.has(handleSha256)) fail('Secret handle has been revoked.', 'SGOS_SECRET_HANDLE_REVOKED');
      const now = operationalNow();
      const broker = brokerFor(record.brokerId, now);
      if (broker.recordSha256 !== record.brokerAttestationSha256) {
        fail('Secret handle broker attestation changed.', 'SGOS_SECRET_BROKER_UNTRUSTED');
      }
      if (Date.parse(record.expiresAt) <= Date.parse(now)) fail('Secret handle has expired.', 'SGOS_SECRET_HANDLE_EXPIRED');
      if (purpose !== record.purpose || audience !== record.audience) {
        fail('Secret handle purpose or audience does not match.', 'SGOS_SECRET_SCOPE_DENIED');
      }
      return Object.freeze({
        valid: true,
        handleSha256: record.recordSha256,
        brokerId: record.brokerId,
        purpose: record.purpose,
        audience: record.audience,
        retrievable: false
      });
    },

    /**
     * Resolve one handle only inside a caller-supplied, explicitly authorized adapter callback.
     * The raw value is required to be mutable bytes, is never returned by this method, and both
     * the resolver buffer and callback copy are overwritten in finally.
     */
    async withEphemeralSecret(handleSha256, {
      purpose,
      audience,
      adapterId,
      adapterManifestSha256
    } = {}, consume) {
      if (typeof consume !== 'function') {
        fail('Secret release requires an explicit adapter callback.',
          'SGOS_SECRET_ADAPTER_UNAUTHORIZED');
      }
      const record = handles.get(handleSha256);
      const verified = this.verifyHandle(handleSha256, { purpose, audience });
      const authorization = adapterMap.get(adapterId);
      if (!authorization || authorization.manifestSha256 !== adapterManifestSha256
          || !authorization.brokerIds.includes(verified.brokerId)
          || !authorization.purposes.includes(verified.purpose)
          || !authorization.audiences.includes(verified.audience)) {
        fail(`Adapter '${adapterId ?? 'unknown'}' is not explicitly authorized for this secret scope.`,
          'SGOS_SECRET_ADAPTER_UNAUTHORIZED');
      }
      const resolver = resolverMap.get(verified.brokerId);
      if (typeof resolver !== 'function') {
        fail(`Secret broker '${verified.brokerId}' has no ephemeral resolver.`,
          'SGOS_SECRET_RELEASE_UNAVAILABLE');
      }
      let resolved;
      let ephemeral;
      try {
        resolved = await resolver(Object.freeze({
          brokerId: verified.brokerId,
          handleId: record.handleId,
          handleSha256,
          opaqueReferenceSha256: record.opaqueReferenceSha256,
          purpose: verified.purpose,
          audience: verified.audience
        }));
        if (!(Buffer.isBuffer(resolved) || resolved instanceof Uint8Array)) {
          fail('Secret Broker resolver must return mutable bytes, never a string.',
            'SGOS_SECRET_RELEASE_INVALID');
        }
        if (resolved.byteLength < 1 || resolved.byteLength > MAXIMUM_EPHEMERAL_SECRET_BYTES) {
          fail(`Secret Broker release exceeds the ${MAXIMUM_EPHEMERAL_SECRET_BYTES}-byte ephemeral ceiling.`,
            'SGOS_SECRET_RELEASE_INVALID');
        }
        ephemeral = Buffer.from(resolved);
        const result = await consume(ephemeral, Object.freeze({
          brokerId: verified.brokerId,
          handleSha256,
          adapterId,
          adapterManifestSha256,
          authorizationSha256: platformSha256(authorization)
        }));
        if (Buffer.isBuffer(result) || result instanceof Uint8Array
            || containsSecretBytes(result, ephemeral)) {
          fail('Secret-authorized adapter attempted to return released credential material.',
            'SGOS_SECRET_RESULT_LEAK');
        }
        return Object.freeze({
          result: clonePlatformJson(result),
          release: Object.freeze({
            brokerId: verified.brokerId,
            handleSha256,
            adapterId,
            adapterManifestSha256,
            authorizationSha256: platformSha256(authorization),
            secretBytes: null
          })
        });
      } finally {
        ephemeral?.fill(0);
        if (Buffer.isBuffer(resolved) || resolved instanceof Uint8Array) resolved.fill(0);
      }
    },

    revokeHandle(handleSha256) {
      if (!handles.has(handleSha256)) fail('Secret handle is unavailable.', 'SGOS_SECRET_HANDLE_UNAVAILABLE');
      revoked.add(handleSha256);
      return Object.freeze({ revoked: true, handleSha256 });
    },

    snapshot() {
      return Object.freeze({
        profile: 'local-reference-only-v1',
        brokers: Object.freeze([...brokers.values()].map((entry) => clonePlatformJson(entry))),
        handles: Object.freeze([...handles.values()].map((entry) => clonePlatformJson(entry))),
        revokedHandleSha256s: Object.freeze([...revoked].sort()),
        // Only conformance-safe adapter authorization digests are surfaced. Resolver functions
        // and raw values are deliberately absent from snapshots, logs, evidence, and prompts.
        authorizedAdapters: Object.freeze([...adapterMap.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([adapterId, value]) => Object.freeze({
            adapterId, authorizationSha256: platformSha256(value)
          })))
      });
    }
  });
}
