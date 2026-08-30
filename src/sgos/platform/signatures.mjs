import {
  createPrivateKey, createPublicKey, sign as signBytes, timingSafeEqual, verify as verifyBytes
} from 'node:crypto';

import { canonicalJson } from '../../records.mjs';
import { SingularityFlowError } from '../../util.mjs';
import {
  PLATFORM_DIGEST_PATTERN, clonePlatformJson, platformSha256, validatePlatformRecord
} from './contracts.mjs';

function fail(message, code) {
  throw new SingularityFlowError(message, { code });
}

function signaturePayload(record) {
  return canonicalJson(clonePlatformJson(record));
}

function publicKeyDigest(key) {
  const publicKey = key?.type === 'public' ? key : createPublicKey(key);
  return platformSha256(publicKey.export({ type: 'spki', format: 'der' }));
}

export function signPlatformRecord(record, { privateKeyPem, keyId }) {
  const validated = validatePlatformRecord(record);
  if (typeof keyId !== 'string' || !/^[a-z0-9][a-z0-9._:-]{1,127}$/.test(keyId)) {
    fail('Platform signature requires a canonical key ID.', 'SGOS_PLATFORM_SIGNATURE_INVALID');
  }
  let privateKey;
  try { privateKey = createPrivateKey(privateKeyPem); } catch (error) {
    throw new SingularityFlowError('Platform signing key is invalid.', {
      code: 'SGOS_PLATFORM_SIGNING_KEY_INVALID', cause: error
    });
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    fail('Platform records require an Ed25519 signing key.', 'SGOS_PLATFORM_SIGNING_KEY_INVALID');
  }
  const payload = signaturePayload(validated);
  return Object.freeze({
    record: validated,
    signature: Object.freeze({
      algorithm: 'ed25519',
      keyId,
      keySha256: publicKeyDigest(privateKey),
      payloadSha256: platformSha256(payload),
      value: signBytes(null, Buffer.from(payload), privateKey).toString('base64')
    })
  });
}

export function verifySignedPlatformRecord(signed, {
  trustedPublicKeyPem,
  expectedKeyId = null,
  expectedKind = null
} = {}) {
  if (!signed || typeof signed !== 'object' || Array.isArray(signed)
      || Object.keys(signed).sort().join(',') !== 'record,signature') {
    fail('Signed platform record must contain exactly record and signature.', 'SGOS_PLATFORM_SIGNATURE_INVALID');
  }
  const signature = signed.signature;
  if (!signature || typeof signature !== 'object' || Array.isArray(signature)) {
    fail('Signed platform record has no signature.', 'SGOS_PLATFORM_SIGNATURE_INVALID');
  }
  const expectedFields = ['algorithm', 'keyId', 'keySha256', 'payloadSha256', 'value'];
  if (Object.keys(signature).sort().join(',') !== [...expectedFields].sort().join(',')) {
    fail('Platform signature contains missing or unknown fields.', 'SGOS_PLATFORM_SIGNATURE_INVALID');
  }
  if (signature.algorithm !== 'ed25519' || !trustedPublicKeyPem) {
    fail('Platform record requires an explicitly trusted Ed25519 key.', 'SGOS_PLATFORM_SIGNATURE_UNTRUSTED');
  }
  if (expectedKeyId !== null && signature.keyId !== expectedKeyId) {
    fail('Platform signature key ID is not approved for this record.', 'SGOS_PLATFORM_SIGNATURE_UNTRUSTED');
  }
  let trusted;
  try { trusted = createPublicKey(trustedPublicKeyPem); } catch (error) {
    throw new SingularityFlowError('Trusted platform public key is invalid.', {
      code: 'SGOS_PLATFORM_SIGNATURE_UNTRUSTED', cause: error
    });
  }
  if (trusted.asymmetricKeyType !== 'ed25519') {
    fail('Trusted platform public key must be Ed25519.', 'SGOS_PLATFORM_SIGNATURE_UNTRUSTED');
  }
  const trustedDigest = publicKeyDigest(trusted);
  if (!PLATFORM_DIGEST_PATTERN.test(String(signature.keySha256 ?? ''))
      || !timingSafeEqual(Buffer.from(signature.keySha256), Buffer.from(trustedDigest))) {
    fail('Platform signature key digest does not match the approved key.', 'SGOS_PLATFORM_SIGNATURE_UNTRUSTED');
  }
  const record = validatePlatformRecord(signed.record, expectedKind);
  const payload = signaturePayload(record);
  const payloadSha256 = platformSha256(payload);
  let signatureBytes;
  try { signatureBytes = Buffer.from(String(signature.value ?? ''), 'base64'); } catch {
    signatureBytes = Buffer.alloc(0);
  }
  if (!PLATFORM_DIGEST_PATTERN.test(String(signature.payloadSha256 ?? ''))
      || !timingSafeEqual(Buffer.from(signature.payloadSha256), Buffer.from(payloadSha256))
      || !verifyBytes(null, Buffer.from(payload), trusted, signatureBytes)) {
    fail('Platform record signature or payload digest is invalid.', 'SGOS_PLATFORM_SIGNATURE_INVALID');
  }
  return record;
}
