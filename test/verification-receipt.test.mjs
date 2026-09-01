import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import {
  mergeSignedVerificationReceipts, REQUIRED_RELEASE_PLATFORM_MATRIX,
  signVerificationReceipt, verifyVerificationReceipt
} from '../src/verification-receipt.mjs';

function keys() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' })
  };
}

function evidence({
  platform = 'darwin', nodeVersion = '22.18.0', packageCharacter = 'c', vsixCharacter = 'd'
} = {}) {
  return {
    schemaVersion: 2,
    commit: 'a'.repeat(40), tree: 'b'.repeat(40), cleanCheckout: true,
    npmCi: 'passed', npmRunCheck: { passed: true, checks: 880 },
    npmTest: { passed: 2654, failed: 0 },
    platforms: [platform], nodeVersions: [nodeVersion],
    vscodeBuild: 'passed', packageSha256: `sha256:${packageCharacter.repeat(64)}`,
    vsixSha256: `sha256:${vsixCharacter.repeat(64)}`
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

test('release promotion accepts only a reviewed signed aggregate covering the exact platform matrix', () => {
  const runner = keys();
  const release = keys();
  const cells = REQUIRED_RELEASE_PLATFORM_MATRIX.map(({ platform, nodeMajor }) => (
    signVerificationReceipt(
      evidence({
        platform, nodeVersion: `${nodeMajor}.18.0`
      }),
      runner.privateKey,
      `${platform}-node-${nodeMajor}@example.test`
    )
  ));
  const aggregate = mergeSignedVerificationReceipts(
    cells, release.privateKey, 'release-matrix@example.test',
    { generatedAt: '2026-09-01T00:00:00.000Z', artifactReceipt: cells[0] }
  );
  const result = verifyVerificationReceipt(aggregate, {
    trustedPublicKeyPem: release.publicKey,
    expectedCommit: evidence().commit,
    expectedTree: evidence().tree,
    requiredPlatformMatrix: REQUIRED_RELEASE_PLATFORM_MATRIX
  });
  assert.equal(result.valid, true);
  assert.equal(aggregate.platformMatrix.length, REQUIRED_RELEASE_PLATFORM_MATRIX.length);
  assert.deepEqual(aggregate.platforms, ['darwin', 'linux', 'win32']);
  assert.equal(aggregate.packageSha256, cells[0].packageSha256);
  assert.equal(aggregate.artifactEvidence.payloadSha256, cells[0].signature.payloadSha256);

  const partial = mergeSignedVerificationReceipts(
    cells.slice(0, 2), release.privateKey, 'release-matrix@example.test'
  );
  assert.throws(() => verifyVerificationReceipt(partial, {
    trustedPublicKeyPem: release.publicKey,
    requiredPlatformMatrix: REQUIRED_RELEASE_PLATFORM_MATRIX
  }), (error) => error.code === 'VERIFICATION_RECEIPT_REJECTED'
    && error.details.failures.some((failure) => failure.includes('matrix is incomplete')));

  assert.throws(() => verifyVerificationReceipt(cells[0], {
    trustedPublicKeyPem: runner.publicKey,
    requiredPlatformMatrix: REQUIRED_RELEASE_PLATFORM_MATRIX
  }), (error) => error.code === 'VERIFICATION_RECEIPT_REJECTED'
    && error.details.failures.includes('platformMatrix is absent'));

  const mismatchedArtifact = [...cells];
  mismatchedArtifact[1] = signVerificationReceipt(
    evidence({ platform: 'darwin', nodeVersion: '22.18.0', packageCharacter: 'e' }),
    runner.privateKey,
    'darwin-node-22@example.test'
  );
  assert.throws(() => mergeSignedVerificationReceipts(
    mismatchedArtifact, release.privateKey, 'release-matrix@example.test'
  ), (error) => error.code === 'VERIFICATION_RECEIPT_REJECTED'
    && error.details.field === 'packageSha256');
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
