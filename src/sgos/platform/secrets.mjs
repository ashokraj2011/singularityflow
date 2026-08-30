import { SingularityFlowError } from '../../util.mjs';
import {
  clonePlatformJson, isPlainPlatformObject, validatePlatformRecord
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

export function createSecretBrokerRegistry({ trustedIssuers }) {
  if (!isPlainPlatformObject(trustedIssuers) || !Object.keys(trustedIssuers).length) {
    fail('Secret broker registry requires explicit trusted issuer keys.', 'SGOS_SECRET_BROKER_UNTRUSTED');
  }
  const issuers = new Map(Object.entries(trustedIssuers));
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
        revokedHandleSha256s: Object.freeze([...revoked].sort())
      });
    }
  });
}
