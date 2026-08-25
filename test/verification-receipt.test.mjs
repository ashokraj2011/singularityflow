import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import {
  signVerificationReceipt, verifyVerificationReceipt
} from '../src/verification-receipt.mjs';

function keys() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' })
  };
}

function evidence() {
  return {
    schemaVersion: 2,
    commit: 'a'.repeat(40), tree: 'b'.repeat(40), cleanCheckout: true,
    npmCi: 'passed', npmRunCheck: { passed: true, checks: 880 },
    npmTest: { passed: 2654, failed: 0 },
    platforms: ['darwin'], nodeVersions: ['22.18.0'],
    vscodeBuild: 'passed', packageSha256: `sha256:${'c'.repeat(64)}`,
    vsixSha256: `sha256:${'d'.repeat(64)}`
  };
}

test('a trusted signed receipt binds the exact commit, tree, package, and observed platform', () => {
  const pair = keys();
  const receipt = signVerificationReceipt(evidence(), pair.privateKey, 'release@example.test');
  const result = verifyVerificationReceipt(receipt, {
    trustedPublicKeyPem: pair.publicKey,
    expectedCommit: evidence().commit,
    expectedTree: evidence().tree,
    expectedPackageSha256: evidence().packageSha256,
    expectedVsixSha256: evidence().vsixSha256
  });
  assert.equal(result.valid, true);
  assert.equal(result.verifierIdentity, 'release@example.test');
  assert.match(result.publicKeySha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.vsixSha256, evidence().vsixSha256);
});

test('receipt tampering, an untrusted signer, and missing checks fail closed', () => {
  const pair = keys();
  const receipt = signVerificationReceipt(evidence(), pair.privateKey, 'release@example.test');
  const tampered = structuredClone(receipt);
  tampered.npmTest.passed += 1;
  assert.throws(() => verifyVerificationReceipt(tampered, {
    trustedPublicKeyPem: pair.publicKey
  }), (error) => error.code === 'VERIFICATION_RECEIPT_SIGNATURE_INVALID');

  const other = keys();
  assert.throws(() => verifyVerificationReceipt(receipt, {
    trustedPublicKeyPem: other.publicKey
  }), (error) => error.code === 'VERIFICATION_RECEIPT_UNTRUSTED');

  const failing = signVerificationReceipt({ ...evidence(), npmTest: { passed: 2654, failed: 1 } }, pair.privateKey, 'release@example.test');
  assert.throws(() => verifyVerificationReceipt(failing, {
    trustedPublicKeyPem: pair.publicKey
  }), (error) => error.code === 'VERIFICATION_RECEIPT_REJECTED');
});
