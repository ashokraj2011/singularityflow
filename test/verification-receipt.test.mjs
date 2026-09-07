import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import {
  mergeSignedVerificationReceipts, REQUIRED_RELEASE_PLATFORM_MATRIX,
  signVerificationReceipt, validateReleasePlatformEvidence, verifyVerificationReceipt
} from '../src/verification-receipt.mjs';
import {
  validateWelBenchmarkEvidence, WEL_BENCHMARK_ASSURANCE, WEL_BENCHMARK_CAPABILITIES,
  WEL_BENCHMARK_EXCLUDED_CONTENT, WEL_BENCHMARK_SCHEMA
} from '../src/wel-benchmark-evidence.mjs';

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
    schemaVersion: 2,
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
      },
      sgosEndToEnd: {
        softwareConversionJourney: {
          outcome: 'passed', evidenceSha256: `sha256:${'6'.repeat(64)}`
        },
        hypothesisAnalysisJourney: {
          outcome: 'passed', evidenceSha256: `sha256:${'7'.repeat(64)}`
        },
        interruptionRecovery: {
          outcome: 'passed', evidenceSha256: `sha256:${'8'.repeat(64)}`
        },
        counterfeitAuthorityRefusal: {
          outcome: 'passed', evidenceSha256: `sha256:${'9'.repeat(64)}`
        },
        crossMachineAuthorityRoundTrip: {
          outcome: 'passed', evidenceSha256: `sha256:${'a'.repeat(64)}`
        },
        performanceBudget: {
          outcome: 'passed', evidenceSha256: `sha256:${'b'.repeat(64)}`,
          budgetProfileSha256: `sha256:${'c'.repeat(64)}`
        }
      }
    }
  };
}

function timing(minimum = 1) {
  return { minimum, median: minimum + 1, p95: minimum + 2, maximum: minimum + 3 };
}

function welBenchmark({ platform = 'darwin', nodeMajor = 22 } = {}) {
  return {
    schema: WEL_BENCHMARK_SCHEMA,
    assurance: WEL_BENCHMARK_ASSURANCE,
    platform,
    architecture: platform === 'darwin' ? 'arm64' : 'x64',
    nodeMajor,
    requestedSamples: 12,
    completedSamples: 12,
    outcome: 'observed',
    unavailableCode: null,
    parserMilliseconds: timing(1),
    reportIngestionMilliseconds: timing(2),
    receiptProjectionMilliseconds: timing(3),
    baselineReceiptProjectionMilliseconds: timing(2),
    incrementalReceiptProjectionMilliseconds: {
      minimum: -1, median: 0, p95: 1, maximum: 2,
      method: 'witnessed-minus-unenrolled-same-process'
    },
    contextXrayProjectionMilliseconds: timing(4),
    storyStartRequestedSamples: 3,
    storyStartCompletedSamples: 3,
    storyStartMode: 'governed-local-publication-push-off',
    storyStartMilliseconds: timing(5),
    storyTimingInterpretation: 'synthetic local Story-start transaction including its governed local commits; configuration authority uses a local bare remote and application push is disabled',
    storyPushRecovery: {
      outcome: 'recovered', failureCode: 'STORY_PUBLICATION_FAILED',
      failureMilliseconds: 10, recoveryMilliseconds: 11, exactRetainedCommitPublished: true
    },
    storyRecoveryInterpretation: 'synthetic local post-preflight transport loss followed by the public exact pending-publication sync path; this is not office-network evidence',
    storyOfflineRecovery: {
      outcome: 'recovered', failureCode: 'STORY_PUBLICATION_FAILED',
      failureMilliseconds: 12, recoveryMilliseconds: 13,
      exactRetainedCommitPublished: true, freshCloneMilliseconds: 14,
      freshCloneExact: true, freshCloneClean: true
    },
    storyOfflineRecoveryInterpretation: 'synthetic local authority loss after publication preflight, exact public sync recovery, and clean fresh-clone verification; this is not office-network evidence',
    interruptedWriteRecovery: {
      outcome: 'recovered', failureCode: 'ABRUPT_PROCESS_EXIT',
      failureMilliseconds: 15, recoveryMilliseconds: 16, exactStableStateRestored: true
    },
    interruptedWriteInterpretation: 'synthetic abrupt process exit after state write and before ref advancement, recovered through the public sync surface',
    adapterCancellation: {
      outcome: 'cancelled-safe', milliseconds: 1, exact: false, mappingProposals: 0
    },
    adapterCancellationInterpretation: 'pre-cancelled exact-static observation returns unavailable evidence and creates no mapping proposal',
    timingInterpretation: 'paired local observation; signed deltas may be negative from timer noise and are not an enforced budget',
    cpuMilliseconds: { median: 2, p95: 3 },
    catalogBytes: 100,
    baselineReceiptBytes: 200,
    receiptBytes: 300,
    incrementalReceiptBytes: 100,
    contextXrayBytes: 400,
    storyWorkflowBytes: 500,
    rawReportBytes: 600,
    estimatedDurableBytesPerExecution: 900,
    estimatedDurableIncrementalBytesPerExecution: 700,
    fixtureOutcomes: { cases: 1, exactStatic: 1, inexact: 0, falseExact: 0 },
    measurementCapabilities: [...WEL_BENCHMARK_CAPABILITIES],
    contentExcluded: [...WEL_BENCHMARK_EXCLUDED_CONTENT]
  };
}

function evidence(options = {}) {
  const platformEvidence = reviewedPlatformEvidence(options);
  const validated = validateReleasePlatformEvidence(platformEvidence);
  const benchmark = welBenchmark({
    platform: platformEvidence.platform,
    nodeMajor: Number(platformEvidence.nodeVersion.split('.')[0])
  });
  const validatedBenchmark = validateWelBenchmarkEvidence(benchmark);
  return {
    schemaVersion: 5,
    commit: 'a'.repeat(40), tree: 'b'.repeat(40), cleanCheckout: true,
    npmCi: 'passed', npmRunCheck: { passed: true, checks: 880 },
    npmTest: { passed: 2654, failed: 0, skipped: 0, cancelled: 0, todo: 0 },
    pocReleaseGate: 'passed',
    platforms: [platformEvidence.platform], nodeVersions: [platformEvidence.nodeVersion],
    vscodeBuild: 'passed', packageSha256: platformEvidence.packageSha256,
    vsixSha256: platformEvidence.vsixSha256,
    welBenchmark: benchmark,
    welBenchmarkSha256: validatedBenchmark.evidenceSha256,
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
    {
      generatedAt: '2026-09-01T00:00:00.000Z',
      artifactReceipt: cells[0],
      requireSgosEndToEnd: true
    }
  );
  const result = verifyVerificationReceipt(aggregate, {
    trustedPublicKeyPem: release.publicKey,
    expectedCommit: evidence().commit,
    expectedTree: evidence().tree,
    requiredPlatformMatrix: REQUIRED_RELEASE_PLATFORM_MATRIX,
    requireSgosEndToEnd: true
  });
  assert.equal(result.valid, true);
  assert.equal(aggregate.platformMatrix.length, REQUIRED_RELEASE_PLATFORM_MATRIX.length);
  assert.deepEqual(aggregate.platforms, ['darwin', 'linux', 'win32']);
  assert.equal(aggregate.packageSha256, cells[0].packageSha256);
  assert.equal(aggregate.artifactEvidence.payloadSha256, cells[0].signature.payloadSha256);
  assert.equal(aggregate.schemaVersion, 6);
  assert.equal(
    aggregate.platformMatrix[0].platformEvidenceSha256,
    validateReleasePlatformEvidence(aggregate.platformMatrix[0].platformEvidence).evidenceSha256
  );
  assert.equal(aggregate.platformMatrix.find((cell) => cell.platform === 'win32')
    .platformEvidence.checks.windowsNpmNpxRoundTrip.outcome, 'passed');
  assert.equal(aggregate.platformMatrix.find((cell) => cell.platform === 'linux')
    .welBenchmark.platform, 'linux');

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

  const matrixWithChangedBenchmark = structuredClone(aggregate);
  delete matrixWithChangedBenchmark.signature;
  matrixWithChangedBenchmark.platformMatrix[0].welBenchmark.fixtureOutcomes.falseExact = 1;
  const resignedChangedBenchmark = signVerificationReceipt(
    matrixWithChangedBenchmark, release.privateKey, 'release-matrix@example.test'
  );
  assert.throws(() => verifyVerificationReceipt(resignedChangedBenchmark, {
    trustedPublicKeyPem: release.publicKey,
    requiredPlatformMatrix: REQUIRED_RELEASE_PLATFORM_MATRIX
  }), (error) => error.code === 'VERIFICATION_RECEIPT_REJECTED'
    && error.details.failures.some((failure) => failure.includes('fixtureOutcomes')));

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
  assert.match(validateReleasePlatformEvidence(valid, {
    requireSgosEndToEnd: true
  }).evidenceSha256, /^sha256:[a-f0-9]{64}$/);

  const legacy = structuredClone(valid);
  legacy.schemaVersion = 1;
  delete legacy.checks.sgosEndToEnd;
  assert.match(validateReleasePlatformEvidence(legacy).evidenceSha256, /^sha256:[a-f0-9]{64}$/,
    'historical v1 evidence remains readable outside SGOS release promotion');
  assert.throws(() => validateReleasePlatformEvidence(legacy, { requireSgosEndToEnd: true }),
    (error) => error.code === 'VERIFICATION_PLATFORM_EVIDENCE_INVALID'
      && error.details.failures.some((failure) => failure.includes('requires platform evidence schemaVersion 2')));

  const duplicateJourneyReceipt = structuredClone(valid);
  duplicateJourneyReceipt.checks.sgosEndToEnd.hypothesisAnalysisJourney.evidenceSha256 =
    duplicateJourneyReceipt.checks.sgosEndToEnd.softwareConversionJourney.evidenceSha256;
  assert.throws(() => validateReleasePlatformEvidence(duplicateJourneyReceipt),
    (error) => error.code === 'VERIFICATION_PLATFORM_EVIDENCE_INVALID'
      && error.details.failures.some((failure) => failure.includes('distinct retained receipt')));

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

test('WEL benchmark evidence is strict, content-free, host-bound, and digest-bound', () => {
  const valid = welBenchmark();
  assert.match(validateWelBenchmarkEvidence(valid, {
    platform: 'darwin', nodeMajor: 22
  }).evidenceSha256, /^sha256:[a-f0-9]{64}$/);

  const rawPath = structuredClone(valid);
  rawPath.repositoryPath = '/private/repository';
  assert.throws(() => validateWelBenchmarkEvidence(rawPath),
    (error) => error.code === 'WEL_BENCHMARK_EVIDENCE_INVALID'
      && error.details.failures.includes('WEL benchmark fields are invalid'));

  const falseExact = structuredClone(valid);
  falseExact.fixtureOutcomes.falseExact = 1;
  assert.throws(() => validateWelBenchmarkEvidence(falseExact),
    (error) => error.code === 'WEL_BENCHMARK_EVIDENCE_INVALID'
      && error.details.failures.includes('fixtureOutcomes is invalid'));

  assert.throws(() => validateWelBenchmarkEvidence(valid, { platform: 'linux' }),
    (error) => error.code === 'WEL_BENCHMARK_EVIDENCE_INVALID'
      && error.details.failures.includes('platform does not match the verified host'));
});

test('old or missing physical evidence cannot authorize merge or promotion', () => {
  const pair = keys();
  const old = evidence();
  old.schemaVersion = 4;
  delete old.platformEvidence;
  delete old.platformEvidenceSha256;
  delete old.welBenchmark;
  delete old.welBenchmarkSha256;
  const signedOld = signVerificationReceipt(old, pair.privateKey, 'release@example.test');
  assert.throws(() => verifyVerificationReceipt(signedOld, { trustedPublicKeyPem: pair.publicKey }),
    (error) => error.code === 'VERIFICATION_RECEIPT_REJECTED'
      && error.details.failures.some((failure) => failure.includes('schemaVersion must be 5'))
      && error.details.failures.some((failure) => failure.includes('platform evidence'))
      && error.details.failures.some((failure) => failure.includes('WEL benchmark evidence')));
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

  const badBenchmarkDigest = evidence();
  badBenchmarkDigest.welBenchmarkSha256 = `sha256:${'0'.repeat(64)}`;
  const signedBadBenchmarkDigest = signVerificationReceipt(
    badBenchmarkDigest, pair.privateKey, 'release@example.test'
  );
  assert.throws(() => verifyVerificationReceipt(signedBadBenchmarkDigest, {
    trustedPublicKeyPem: pair.publicKey
  }), (error) => error.code === 'VERIFICATION_RECEIPT_REJECTED'
    && error.details.failures.includes('welBenchmarkSha256 does not match welBenchmark'));
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
