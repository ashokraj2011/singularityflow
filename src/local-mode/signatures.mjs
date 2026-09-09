import {
  createPrivateKey, createPublicKey, sign as signBytes, timingSafeEqual,
  verify as verifyBytes
} from 'node:crypto';

import { canonicalJcs, parseCanonicalJcs } from './jcs.mjs';
import { LOC_LIMITS, locFail, locSha256 } from './contracts.mjs';

function pae(payloadType, payload) {
  const type = Buffer.from(payloadType);
  const bytes = Buffer.from(payload);
  return Buffer.concat([
    Buffer.from('DSSEv1 ' + type.length + ' '),
    type,
    Buffer.from(' ' + bytes.length + ' '),
    bytes
  ]);
}

function strictBase64(value, label) {
  if (typeof value !== 'string' || !value.length) {
    locFail(label + ' is missing.', 'BUNDLE_INTEGRITY_INVALID');
  }
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  let bytes;
  try { bytes = Buffer.from(padded, 'base64'); } catch { bytes = Buffer.alloc(0); }
  if (!bytes.length || bytes.toString('base64').replace(/=+$/u, '')
    !== padded.replace(/=+$/u, '')) {
    locFail(label + ' is not strict base64.', 'BUNDLE_INTEGRITY_INVALID');
  }
  return bytes;
}

export function createDsseEnvelope(payloadBytes, payloadType, signer) {
  let privateKey;
  try { privateKey = createPrivateKey(signer.privateKeyPem); } catch (error) {
    throw Object.assign(error, { code: 'SIGNER_UNAVAILABLE' });
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    locFail('Local bundle signer must use Ed25519.', 'SIGNER_UNAVAILABLE');
  }
  const payload = Buffer.from(payloadBytes);
  const envelope = {
    payload: payload.toString('base64'),
    payloadType,
    signatures: [{
      keyid: signer.keyId,
      sig: signBytes(null, pae(payloadType, payload), privateKey).toString('base64')
    }]
  };
  const bytes = Buffer.from(canonicalJcs(envelope));
  if (bytes.length > LOC_LIMITS.maximumEnvelopeBytes) {
    locFail('DSSE envelope exceeds the registered byte ceiling.',
      'EXPORT_PROFILE_UNSUPPORTED');
  }
  return Object.freeze({ envelope: Object.freeze(envelope), bytes });
}

export function verifyDsseEnvelope(envelopeBytes, {
  payloadType, trustedPublicKeyPem, expectedKeyId
}) {
  const envelope = parseCanonicalJcs(envelopeBytes, {
    maximumBytes: LOC_LIMITS.maximumEnvelopeBytes
  });
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
      || Object.keys(envelope).sort().join(',')
        !== ['payload', 'payloadType', 'signatures'].sort().join(',')
      || envelope.payloadType !== payloadType
      || !Array.isArray(envelope.signatures)
      || envelope.signatures.length !== 1
      || envelope.signatures.length > LOC_LIMITS.maximumSignatures) {
    locFail('DSSE envelope shape or payload type is unsupported.',
      'BUNDLE_SCHEMA_UNSUPPORTED');
  }
  const signature = envelope.signatures[0];
  if (!signature || typeof signature !== 'object' || Array.isArray(signature)
      || Object.keys(signature).sort().join(',')
        !== ['keyid', 'sig'].sort().join(',')
      || signature.keyid !== expectedKeyId) {
    locFail('DSSE signature is not from the expected key.',
      'BUNDLE_TRUST_UNAVAILABLE');
  }
  let publicKey;
  try { publicKey = createPublicKey(trustedPublicKeyPem); } catch (error) {
    throw Object.assign(error, { code: 'BUNDLE_TRUST_UNAVAILABLE' });
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    locFail('Trusted bundle key must use Ed25519.',
      'BUNDLE_TRUST_UNAVAILABLE');
  }
  const payload = strictBase64(envelope.payload, 'DSSE payload');
  const signatureBytes = strictBase64(signature.sig, 'DSSE signature');
  if (!verifyBytes(null, pae(payloadType, payload), publicKey, signatureBytes)) {
    locFail('DSSE signature is invalid.', 'BUNDLE_INTEGRITY_INVALID');
  }
  const keySha256 = locSha256(publicKey.export({ type: 'spki', format: 'der' }));
  return Object.freeze({
    payload,
    keyId: signature.keyid,
    keySha256,
    signatureSha256: locSha256(signatureBytes)
  });
}

export function sameDigest(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string'
      || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
