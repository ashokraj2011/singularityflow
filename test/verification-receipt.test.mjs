import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import {
  mergeSignedVerificationReceipts, REQUIRED_RELEASE_PLATFORM_MATRIX,
  signVerificationReceipt, validateReleasePlatformEvidence, verifyVerificationReceipt
} from '../src/verification-receipt.mjs';

function keys() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' })
  };
}

function reviewedPlatformEvidence({
  platform = 'darwin', nodeVersion = '22.18.0', packageCharacter = 'c', vsixCharacter = 'd',
  reviewerIdentity = 'release@example.test'
} = {}) {
  return {
    schemaVersion: 1,
    reviewedAt: '2026-09-01T00:00:00.000Z',
    reviewerIdentity,
    platform,
    nodeVersion,
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    packageSha256: `sha256:${packageCharacter.repeat(64)}`,
    vsixSha256: `sha256:${vsixCharacter.repeat(64)}`,
    checks: {
      installedVsixActivation: { outcome: 'passed', evidenceSha256: `sha256:${'e'.repeat(64)}` },
      stagedInstallerRecovery: { outcome: 'passed', evidenceSha256: `sha256:${'f'.repeat(64)}` },
      windowsNpmNpxRoundTrip: platform === 'win32'
        ? { outcome: 'passed', evidenceSha256: `sha256:${'1'.repeat(64)}`, reasonCode: null }
        : { outcome: 'not-applicable', evidenceSha256: null, reasonCode: 'non-windows-platform' },
      exactPackageLocalStart: {
        outcome: 'passed', evidenceSha256: `sha256:${'2'.repeat(64)}`,
        networkIsolationMechanism: 'firewall-egress-deny',
        packageName: '@playwright/mcp', packageVersion: '0.0.79',
        packageClosureSha256: `sha256:${'4'.repeat(64)}`
      },
      authenticatedPlaywrightSmoke: {
        outcome: 'passed', evidenceSha256: `sha256:${'3'.repeat(64)}`,
        authenticationMechanism: 'managed-auth-profile',
        authenticationProfileSha256: `sha256:${'5'.repeat(64)}`
      }
    }
  };
}

function evidence(options = {}) {
  const platformEvidence = reviewedPlatformEvidence(options);
  const validated = validateReleasePlatformEvidence(platformEvidence);
  return {
    schemaVersion: 4,
    commit: 'a'.repeat(40), tree: 'b'.repeat(40), cleanCheckout: true,
    npmCi: 'passed', npmRunCheck: { passed: true, checks: 880 },
    npmTest: { passed: 2654, failed: 0, skipped: 0, cancelled: 0, todo: 0 },
    pocReleaseGate: 'passed',
    platforms: [platformEvidence.platform], nodeVersions: [platformEvidence.nodeVersion],
    vscodeBuild: 'passed', packageSha256: platformEvidence.packageSha256,
    vsixSha256: platformEvidence.vsixSha256,
    platformEvidence,
    platformEvidenceSha256: validated.evidenceSha256
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
    signVerificationReceipt(evidence({
      platform,
      nodeVersion: `${nodeMajor}.18.0`,
      reviewerIdentity: `${platform}-node-${nodeMajor}@example.test`
    }), runner.privateKey, `${platform}-node-${nodeMajor}@example.test`)
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
  assert.equal(aggregate.schemaVersion, 5);
  assert.equal(
    aggregate.platformMatrix[0].platformEvidenceSha256,
    validateReleasePlatformEvidence(aggregate.platformMatrix[0].platformEvidence).evidenceSha256
  );
  assert.equal(aggregate.platformMatrix.find((cell) => cell.platform === 'win32')
    .platformEvidence.checks.windowsNpmNpxRoundTrip.outcome, 'passed');

  const matrixWithChangedNestedEvidence = structuredClone(aggregate);
  delete matrixWithChangedNestedEvidence.signature;
  matrixWithChangedNestedEvidence.platformMatrix[0].platformEvidence
    .checks.installedVsixActivation.evidenceSha256 = `sha256:${'9'.repeat(64)}`;
  const resignedChangedMatrix = signVerificationReceipt(
    matrixWithChangedNestedEvidence, release.privateKey, 'release-matrix@example.test'
  );
  assert.throws(() => verifyVerificationReceipt(resignedChangedMatrix, {
    trustedPublicKeyPem: release.publicKey,
    requiredPlatformMatrix: REQUIRED_RELEASE_PLATFORM_MATRIX
  }), (error) => error.code === 'VERIFICATION_RECEIPT_REJECTED'
    && error.details.failures.some((failure) => failure.includes('platform evidence digest is invalid')));

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
    evidence({
      platform: 'darwin', nodeVersion: '22.18.0', packageCharacter: 'e',
      reviewerIdentity: 'darwin-node-22@example.test'
    }),
    runner.privateKey,
    'darwin-node-22@example.test'
  );
  assert.throws(() => mergeSignedVerificationReceipts(
    mismatchedArtifact, release.privateKey, 'release-matrix@example.test'
  ), (error) => error.code === 'VERIFICATION_RECEIPT_REJECTED'
    && error.details.field === 'packageSha256');

  const outsideSelection = signVerificationReceipt({
    ...evidence({ reviewerIdentity: 'outside@example.test' }),
    generatedAt: '2026-09-02T00:00:00.000Z'
  }, runner.privateKey, 'outside@example.test');
  assert.throws(() => mergeSignedVerificationReceipts(
    cells, release.privateKey, 'release-matrix@example.test', { artifactReceipt: outsideSelection }
  ), (error) => error.code === 'VERIFICATION_RECEIPT_REJECTED'
    && /one of the reviewed/.test(error.message));
});

test('physical platform evidence is strict, digest-only, and platform-aware', () => {
  const valid = reviewedPlatformEvidence();
  assert.match(validateReleasePlatformEvidence(valid).evidenceSha256, /^sha256:[a-f0-9]{64}$/);

  const withRawTranscript = structuredClone(valid);
  withRawTranscript.checks.installedVsixActivation.transcript = 'raw host output';
  assert.throws(() => validateReleasePlatformEvidence(withRawTranscript),
    (error) => error.code === 'VERIFICATION_PLATFORM_EVIDENCE_INVALID'
      && error.details.failures.includes('installed VSIX activation fields are invalid'));

  const falseWindowsPass = structuredClone(valid);
  falseWindowsPass.checks.windowsNpmNpxRoundTrip = {
    outcome: 'passed', evidenceSha256: `sha256:${'4'.repeat(64)}`, reasonCode: null
  };
  assert.throws(() => validateReleasePlatformEvidence(falseWindowsPass),
    (error) => error.code === 'VERIFICATION_PLATFORM_EVIDENCE_INVALID'
      && error.details.failures.some((failure) => failure.includes('explicitly not-applicable')));

  const missingWindowsPass = reviewedPlatformEvidence({ platform: 'win32' });
  missingWindowsPass.checks.windowsNpmNpxRoundTrip = {
    outcome: 'not-applicable', evidenceSha256: null, reasonCode: 'non-windows-platform'
  };
  assert.throws(() => validateReleasePlatformEvidence(missingWindowsPass),
    (error) => error.code === 'VERIFICATION_PLATFORM_EVIDENCE_INVALID'
      && error.details.failures.some((failure) => failure.includes('physical evidence on win32')));

  assert.throws(() => validateReleasePlatformEvidence(valid, {
    packageSha256: `sha256:${'9'.repeat(64)}`
  }), (error) => error.code === 'VERIFICATION_PLATFORM_EVIDENCE_INVALID'
    && error.details.failures.some((failure) => failure.includes('package digest')));

  const wrongMcpPackage = structuredClone(valid);
  wrongMcpPackage.checks.exactPackageLocalStart.packageVersion = '0.0.78';
  assert.throws(() => validateReleasePlatformEvidence(wrongMcpPackage),
    (error) => error.code === 'VERIFICATION_PLATFORM_EVIDENCE_INVALID'
      && error.details.failures.some((failure) => failure.includes('@playwright/mcp@0.0.79')));

  const unsupportedNode = reviewedPlatformEvidence({ nodeVersion: '21.7.0' });
  assert.throws(() => validateReleasePlatformEvidence(unsupportedNode),
    (error) => error.code === 'VERIFICATION_PLATFORM_EVIDENCE_INVALID'
      && error.details.failures.some((failure) => failure.includes('supported release matrix')));
});

test('old or missing physical evidence cannot authorize merge or promotion', () => {
  const pair = keys();
  const old = evidence();
  old.schemaVersion = 3;
  delete old.platformEvidence;
  delete old.platformEvidenceSha256;
  const signedOld = signVerificationReceipt(old, pair.privateKey, 'release@example.test');
  assert.throws(() => verifyVerificationReceipt(signedOld, { trustedPublicKeyPem: pair.publicKey }),
    (error) => error.code === 'VERIFICATION_RECEIPT_REJECTED'
      && error.details.failures.some((failure) => failure.includes('schemaVersion must be 4'))
      && error.details.failures.some((failure) => failure.includes('platform evidence')));
  assert.throws(() => mergeSignedVerificationReceipts(
    [signedOld], pair.privateKey, 'matrix@example.test'
  ), (error) => error.code === 'VERIFICATION_RECEIPT_REJECTED');

  const badDigest = evidence();
  badDigest.platformEvidenceSha256 = `sha256:${'0'.repeat(64)}`;
  const signedBadDigest = signVerificationReceipt(badDigest, pair.privateKey, 'release@example.test');
  assert.throws(() => verifyVerificationReceipt(signedBadDigest, {
    trustedPublicKeyPem: pair.publicKey
  }), (error) => error.code === 'VERIFICATION_RECEIPT_REJECTED'
    && error.details.failures.includes('platformEvidenceSha256 does not match platformEvidence'));
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

  const failing = signVerificationReceipt({
    ...evidence(),
    npmTest: { passed: 2654, failed: 1, skipped: 0, cancelled: 0, todo: 0 }
  }, pair.privateKey, 'release@example.test');
  assert.throws(() => verifyVerificationReceipt(failing, {
    trustedPublicKeyPem: pair.publicKey
  }), (error) => error.code === 'VERIFICATION_RECEIPT_REJECTED');

  for (const outcome of ['skipped', 'cancelled', 'todo']) {
    const incomplete = evidence();
    incomplete.npmTest[outcome] = 1;
    const signed = signVerificationReceipt(incomplete, pair.privateKey, 'release@example.test');
    assert.throws(() => verifyVerificationReceipt(signed, {
      trustedPublicKeyPem: pair.publicKey
    }), (error) => error.code === 'VERIFICATION_RECEIPT_REJECTED');
  }

  const withoutPoc = evidence();
  delete withoutPoc.pocReleaseGate;
  const signedWithoutPoc = signVerificationReceipt(withoutPoc, pair.privateKey, 'release@example.test');
  assert.throws(() => verifyVerificationReceipt(signedWithoutPoc, {
    trustedPublicKeyPem: pair.publicKey
  }), (error) => error.code === 'VERIFICATION_RECEIPT_REJECTED');
});
