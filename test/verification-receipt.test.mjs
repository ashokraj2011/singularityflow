import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import {
  CURRENT_MATRIX_VERIFICATION_RECEIPT_VERSION,
  CURRENT_SINGLE_VERIFICATION_RECEIPT_VERSION,
  mergeSignedVerificationReceipts, REQUIRED_RELEASE_PLATFORM_MATRIX, signVerificationReceipt,
  validateReleasePlatformEvidence, verifyVerificationReceipt
} from '../src/verification-receipt.mjs';
import { signReleaseArtifactReceipt } from '../src/release-artifact-receipt.mjs';
import {
  validateWelBenchmarkEvidence, WEL_BENCHMARK_ASSURANCE, WEL_BENCHMARK_CAPABILITIES,
  WEL_BENCHMARK_EXCLUDED_CONTENT, WEL_BENCHMARK_SCHEMA
} from '../src/wel-benchmark-evidence.mjs';
import {
  signWelCorpusReviewReceipt, validateWelCorpusMeasurement, verifyWelCorpusReviewReceipt,
  WEL_CORPUS_LIFECYCLE_AUTHORITY, WEL_CORPUS_MEASUREMENT_SCHEMA,
  WEL_CORPUS_REVIEW_ASSURANCE, WEL_CORPUS_REVIEW_RECEIPT_KIND,
  WEL_CORPUS_REVIEW_RECEIPT_VERSION, WEL_CORPUS_RUNNER_ENTRYPOINT
} from '../src/wel-corpus-review-receipt.mjs';

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

function artifactReceipt(pair, {
  packageSha256 = evidence().packageSha256,
  vsixSha256 = evidence().vsixSha256,
  identity = 'artifact-builder@example.test'
} = {}) {
  return signReleaseArtifactReceipt({
    schemaVersion: 1,
    kind: 'singularity-flow-release-artifact-receipt',
    generatedAt: '2026-09-01T00:00:00.000Z',
    sourceCommit: evidence().commit,
    sourceTree: evidence().tree,
    packageEntryManifestSha256: `sha256:${'e'.repeat(64)}`,
    packagingProfile: {
      nodeVersion: '22.18.0', npmVersion: '11.8.0', zlibVersion: '1.3.1',
      sourceDateEpoch: '1788220800',
      npmToolchainLockSha256: `sha256:${'f'.repeat(64)}`,
      productionDependencyLockSha256: `sha256:${'0'.repeat(64)}`,
      vsceToolchainLockSha256: `sha256:${'1'.repeat(64)}`
    },
    artifacts: [
      {
        kind: 'cli-and-copilot-plugin', name: 'singularity-flow-0.9.0.tgz',
        sizeBytes: 100, sha256: packageSha256
      },
      {
        kind: 'vscode-extension', name: 'singularity-flow-vscode-0.9.0.vsix',
        sizeBytes: 200, sha256: vsixSha256
      }
    ]
  }, pair.privateKey, identity);
}

function welCorpusMeasurement({ platform = 'darwin', nodeVersion = '22.18.0' } = {}) {
  const architecture = platform === 'darwin' ? 'arm64' : 'x64';
  const nodeMajor = Number(nodeVersion.split('.')[0]);
  return {
    schema: WEL_CORPUS_MEASUREMENT_SCHEMA,
    assurance: 'content-free-local-measurement',
    authority: 'none',
    platform,
    architecture,
    nodeMajor,
    corpusProfile: 'operator-reviewed-manifest-v1',
    inputBinding: 'operator-reviewed-out-of-band',
    repositoryCount: 2,
    caseCount: 3,
    requestedSamplesPerCase: 2,
    completedMeasurements: 6,
    outcome: 'observed',
    timingsMilliseconds: { observation: timing(1), cpu: timing(2) },
    catalogBytesPerCase: timing(100),
    counts: {
      expectedExact: 2, expectedInexact: 1, expectedReportRefused: 0,
      observedExact: 2, observedInexact: 1, observedReportRefused: 0,
      falseExact: 0, falseInconclusive: 0, mismatched: 0,
      mappingProposals: 0, exactOccurrences: 2,
      reasons: { UNSUPPORTED_JAVASCRIPT_SOURCE_SHAPE: 1 }
    },
    availability: {
      javascriptStaticObservation: 'used', junitSurefireStaticObservation: 'used',
      model: 'not-invoked', astIntelligence: 'not-invoked',
      structuralExtraction: 'local-jdk-parser', network: 'not-invoked',
      testExecution: 'not-invoked', cache: 'not-used-observe-only'
    },
    repositoryState: 'unchanged-observed',
    lifecycleGate: false,
    authoritative: false,
    releaseEligible: false,
    contentExcluded: [
      'manifest-path', 'repository-path', 'file-path', 'test-name', 'clause-id',
      'content-digest', 'source-bytes', 'report-bytes', 'work-id', 'git-identity',
      'prompt', 'transcript'
    ]
  };
}

function reviewedWelCorpus(pair, options = {}) {
  const report = welCorpusMeasurement(options);
  const measured = validateWelCorpusMeasurement(report);
  const receipt = signWelCorpusReviewReceipt({
    schemaVersion: WEL_CORPUS_REVIEW_RECEIPT_VERSION,
    kind: WEL_CORPUS_REVIEW_RECEIPT_KIND,
    reviewedAt: '2026-09-01T00:00:00.000Z',
    reviewerIdentity: 'independent-corpus-reviewer@example.test',
    independentReviewReference: 'review:123e4567-e89b-42d3-a456-426614174000',
    sourceCommit: 'a'.repeat(40),
    sourceTree: 'b'.repeat(40),
    runner: {
      entrypoint: WEL_CORPUS_RUNNER_ENTRYPOINT,
      profile: 'operator-reviewed-manifest-v1',
      reportSchema: WEL_CORPUS_MEASUREMENT_SCHEMA,
      runtime: {
        platform: report.platform,
        architecture: report.architecture,
        nodeVersion: options.nodeVersion ?? '22.18.0'
      }
    },
    measurement: measured.evidence,
    measurementSha256: measured.evidenceSha256,
    assurance: WEL_CORPUS_REVIEW_ASSURANCE,
    lifecycleAuthority: WEL_CORPUS_LIFECYCLE_AUTHORITY
  }, pair.privateKey, 'independent-corpus-reviewer@example.test');
  return verifyWelCorpusReviewReceipt(receipt, { trustedPublicKeyPem: pair.publicKey });
}

function currentEvidence(artifact, options = {}, corpusReview = null) {
  const value = evidence(options);
  delete value.vscodeBuild;
  return {
    ...value,
    schemaVersion: CURRENT_SINGLE_VERIFICATION_RECEIPT_VERSION,
    artifactConsumption: 'passed',
    artifactAuthority: {
      payloadSha256: artifact.signature.payloadSha256,
      signerKeySha256: artifact.signature.publicKeySha256,
      builderIdentity: artifact.builderIdentity
    },
    ...(corpusReview ? {
      welCorpusReview: corpusReview.evidence,
      welCorpusReviewSha256: corpusReview.evidenceSha256
    } : {})
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

test('historical receipt versions remain auditable but cannot be merged or promoted', () => {
  assert.equal(CURRENT_SINGLE_VERIFICATION_RECEIPT_VERSION, 7);
  assert.equal(CURRENT_MATRIX_VERIFICATION_RECEIPT_VERSION, 8);
  const legacySigner = keys();
  const legacySingle = signVerificationReceipt(
    evidence(), legacySigner.privateKey, 'release@example.test'
  );
  const legacyResult = verifyVerificationReceipt(legacySingle, {
    trustedPublicKeyPem: legacySigner.publicKey
  });
  assert.equal(legacyResult.valid, true);
  assert.equal(legacyResult.historical, true);
  assert.equal(legacyResult.schemaVersion, 5);
  assert.throws(() => mergeSignedVerificationReceipts(
    [legacySingle], legacySigner.privateKey, 'matrix@example.test'
  ), (error) => error.code === 'VERIFICATION_RECEIPT_REJECTED'
    && /historical cells remain available only for audit reads/u.test(error.message));

  const legacyMatrixV6 = signVerificationReceipt({
    schemaVersion: 6,
    commit: legacySingle.commit,
    tree: legacySingle.tree,
    cleanCheckout: true,
    npmCi: 'passed',
    npmRunCheck: structuredClone(legacySingle.npmRunCheck),
    npmTest: structuredClone(legacySingle.npmTest),
    pocReleaseGate: 'passed',
    platforms: ['darwin'],
    nodeVersions: ['22.18.0'],
    platformMatrix: [{
      platform: 'darwin', nodeVersion: '22.18.0', nodeMajor: 22,
      evidencePayloadSha256: legacySingle.signature.payloadSha256,
      evidenceSignerKeySha256: legacySingle.signature.publicKeySha256,
      evidenceVerifierIdentity: legacySingle.verifierIdentity,
      platformEvidence: legacySingle.platformEvidence,
      platformEvidenceSha256: legacySingle.platformEvidenceSha256,
      welBenchmark: legacySingle.welBenchmark,
      welBenchmarkSha256: legacySingle.welBenchmarkSha256
    }],
    artifactEvidence: {
      payloadSha256: legacySingle.signature.payloadSha256,
      signerKeySha256: legacySingle.signature.publicKeySha256,
      verifierIdentity: legacySingle.verifierIdentity
    },
    vscodeBuild: 'passed',
    packageSha256: legacySingle.packageSha256,
    vsixSha256: legacySingle.vsixSha256
  }, legacySigner.privateKey, 'historical-matrix@example.test');
  assert.equal(verifyVerificationReceipt(legacyMatrixV6, {
    trustedPublicKeyPem: legacySigner.publicKey
  }).historical, true);

  const builder = keys();
  const artifact = artifactReceipt(builder);
  const historicalV6 = currentEvidence(artifact);
  historicalV6.schemaVersion = 6;
  const signedV6 = signVerificationReceipt(
    historicalV6, legacySigner.privateKey, 'release@example.test'
  );
  const v6Result = verifyVerificationReceipt(signedV6, {
    trustedPublicKeyPem: legacySigner.publicKey,
    artifactReceipt: artifact,
    trustedArtifactPublicKeyPem: builder.publicKey
  });
  assert.equal(v6Result.historical, true);
  assert.equal(v6Result.schemaVersion, 6);

  const corpusReviewer = keys();
  const versionSmeared = currentEvidence(
    artifact, {}, reviewedWelCorpus(corpusReviewer)
  );
  versionSmeared.schemaVersion = 6;
  const signedVersionSmeared = signVerificationReceipt(
    versionSmeared, legacySigner.privateKey, 'release@example.test'
  );
  assert.throws(() => verifyVerificationReceipt(signedVersionSmeared, {
    trustedPublicKeyPem: legacySigner.publicKey,
    artifactReceipt: artifact,
    trustedArtifactPublicKeyPem: builder.publicKey,
    trustedWelCorpusReviewPublicKeyPem: corpusReviewer.publicKey
  }), (error) => error.code === 'VERIFICATION_RECEIPT_REJECTED'
    && error.details.failures.includes(
      'historical receipt versions cannot contain WEL corpus review fields'
    ));

  const historicalMatrixBase = structuredClone(historicalV6);
  delete historicalMatrixBase.platformEvidence;
  delete historicalMatrixBase.platformEvidenceSha256;
  delete historicalMatrixBase.welBenchmark;
  delete historicalMatrixBase.welBenchmarkSha256;
  const resignedHistoricalMatrix = signVerificationReceipt({
    ...historicalMatrixBase,
    schemaVersion: 7,
    platforms: ['darwin'],
    nodeVersions: ['22.18.0'],
    platformMatrix: [{
      platform: 'darwin', nodeVersion: '22.18.0', nodeMajor: 22,
      evidencePayloadSha256: signedV6.signature.payloadSha256,
      evidenceSignerKeySha256: signedV6.signature.publicKeySha256,
      evidenceVerifierIdentity: signedV6.verifierIdentity,
      platformEvidence: signedV6.platformEvidence,
      platformEvidenceSha256: signedV6.platformEvidenceSha256,
      welBenchmark: signedV6.welBenchmark,
      welBenchmarkSha256: signedV6.welBenchmarkSha256
    }]
  }, legacySigner.privateKey, 'historical-matrix@example.test');
  assert.equal(verifyVerificationReceipt(resignedHistoricalMatrix, {
    trustedPublicKeyPem: legacySigner.publicKey,
    artifactReceipt: artifact,
    trustedArtifactPublicKeyPem: builder.publicKey
  }).historical, true);
  assert.throws(() => verifyVerificationReceipt(resignedHistoricalMatrix, {
    trustedPublicKeyPem: legacySigner.publicKey,
    artifactReceipt: artifact,
    trustedArtifactPublicKeyPem: builder.publicKey,
    requireCurrentMatrixVersion: true
  }), (error) => error.code === 'VERIFICATION_RECEIPT_REJECTED'
    && error.details.failures.some((failure) => failure.includes(
      `schemaVersion ${CURRENT_MATRIX_VERIFICATION_RECEIPT_VERSION}`
    )));
});

test('current platform and matrix receipts consume one separately trusted artifact authority', () => {
  const builder = keys();
  const artifact = artifactReceipt(builder);
  const runner = keys();
  const release = keys();
  const corpusReviewer = keys();
  const cells = REQUIRED_RELEASE_PLATFORM_MATRIX.map(({ platform, nodeMajor }) => {
    const nodeVersion = `${nodeMajor}.18.0`;
    return signVerificationReceipt(currentEvidence(artifact, {
      platform,
      nodeVersion,
      reviewerIdentity: `${platform}-node-${nodeMajor}@example.test`
    }, reviewedWelCorpus(corpusReviewer, { platform, nodeVersion })),
    runner.privateKey, `${platform}-node-${nodeMajor}@example.test`);
  });
  const aggregate = mergeSignedVerificationReceipts(
    cells, release.privateKey, 'release-matrix@example.test', {
      generatedAt: '2026-09-02T00:00:00.000Z',
      artifactReceipt: artifact,
      trustedArtifactPublicKeyPem: builder.publicKey,
      trustedWelCorpusReviewPublicKeyPem: corpusReviewer.publicKey,
      requireSgosEndToEnd: true
    }
  );
  assert.equal(aggregate.schemaVersion, CURRENT_MATRIX_VERIFICATION_RECEIPT_VERSION);
  assert.equal(aggregate.artifactAuthority.payloadSha256, artifact.signature.payloadSha256);
  assert.equal(verifyVerificationReceipt(aggregate, {
    trustedPublicKeyPem: release.publicKey,
    artifactReceipt: artifact,
    trustedArtifactPublicKeyPem: builder.publicKey,
    trustedWelCorpusReviewPublicKeyPem: corpusReviewer.publicKey,
    requiredPlatformMatrix: REQUIRED_RELEASE_PLATFORM_MATRIX,
    requireCurrentMatrixVersion: true,
    requireSgosEndToEnd: true
  }).valid, true);

  const untrusted = keys();
  assert.throws(() => verifyVerificationReceipt(cells[0], {
    trustedPublicKeyPem: runner.publicKey,
    artifactReceipt: artifact,
    trustedArtifactPublicKeyPem: untrusted.publicKey,
    trustedWelCorpusReviewPublicKeyPem: corpusReviewer.publicKey
  }), (error) => error.code === 'VERIFICATION_RECEIPT_REJECTED'
    && error.details.failures.some((failure) => failure.includes('trusted builder key')));

  const otherArtifact = artifactReceipt(builder, {
    packageSha256: `sha256:${'9'.repeat(64)}`
  });
  assert.throws(() => mergeSignedVerificationReceipts(
    cells, release.privateKey, 'release-matrix@example.test', {
      artifactReceipt: otherArtifact,
      trustedArtifactPublicKeyPem: builder.publicKey,
      trustedWelCorpusReviewPublicKeyPem: corpusReviewer.publicKey
    }
  ), (error) => error.code === 'VERIFICATION_RECEIPT_REJECTED');

  const foreignCell = signVerificationReceipt(currentEvidence(otherArtifact, {
    reviewerIdentity: 'foreign@example.test'
  }, reviewedWelCorpus(corpusReviewer)), runner.privateKey, 'foreign@example.test');
  assert.throws(() => mergeSignedVerificationReceipts(
    [cells[0], foreignCell], release.privateKey, 'release-matrix@example.test', {
      artifactReceipt: artifact,
      trustedArtifactPublicKeyPem: builder.publicKey,
      trustedWelCorpusReviewPublicKeyPem: corpusReviewer.publicKey
    }
  ), (error) => error.code === 'VERIFICATION_RECEIPT_REJECTED');
});

test('release matrix requires and preserves independently trusted WEL corpus review per cell', () => {
  const builder = keys();
  const artifact = artifactReceipt(builder);
  const runner = keys();
  const matrixReviewer = keys();
  const corpusReviewer = keys();
  const cells = REQUIRED_RELEASE_PLATFORM_MATRIX.map(({ platform, nodeMajor }) => {
    const nodeVersion = `${nodeMajor}.18.0`;
    const corpus = reviewedWelCorpus(corpusReviewer, { platform, nodeVersion });
    return signVerificationReceipt(currentEvidence(artifact, {
      platform,
      nodeVersion,
      reviewerIdentity: `${platform}-node-${nodeMajor}@example.test`
    }, corpus), runner.privateKey, `${platform}-node-${nodeMajor}@example.test`);
  });
  const aggregate = mergeSignedVerificationReceipts(
    cells, matrixReviewer.privateKey, 'release-matrix@example.test', {
      generatedAt: '2026-09-02T00:00:00.000Z',
      artifactReceipt: artifact,
      trustedArtifactPublicKeyPem: builder.publicKey,
      requireSgosEndToEnd: true,
      requireWelCorpusReview: true,
      trustedWelCorpusReviewPublicKeyPem: corpusReviewer.publicKey
    }
  );
  assert.equal(verifyVerificationReceipt(aggregate, {
    trustedPublicKeyPem: matrixReviewer.publicKey,
    artifactReceipt: artifact,
    trustedArtifactPublicKeyPem: builder.publicKey,
    requiredPlatformMatrix: REQUIRED_RELEASE_PLATFORM_MATRIX,
    requireCurrentMatrixVersion: true,
    requireSgosEndToEnd: true,
    requireWelCorpusReview: true,
    trustedWelCorpusReviewPublicKeyPem: corpusReviewer.publicKey
  }).valid, true);
  assert.equal(aggregate.platformMatrix.length, REQUIRED_RELEASE_PLATFORM_MATRIX.length);
  assert.equal(aggregate.platformMatrix[0].welCorpusReview.lifecycleAuthority, 'none-observe-only');
  assert.match(aggregate.platformMatrix[0].welCorpusReviewSha256, /^sha256:[a-f0-9]{64}$/u);

  const withoutCorpus = signVerificationReceipt(
    currentEvidence(artifact, { reviewerIdentity: 'missing-corpus@example.test' }),
    runner.privateKey,
    'missing-corpus@example.test'
  );
  assert.throws(() => verifyVerificationReceipt(withoutCorpus, {
    trustedPublicKeyPem: runner.publicKey,
    artifactReceipt: artifact,
    trustedArtifactPublicKeyPem: builder.publicKey,
    requireWelCorpusReview: true,
    trustedWelCorpusReviewPublicKeyPem: corpusReviewer.publicKey
  }), (error) => error.code === 'VERIFICATION_RECEIPT_REJECTED'
    && error.details.failures.includes('WEL independent corpus review evidence is absent'));

  const foreignReviewer = keys();
  assert.throws(() => verifyVerificationReceipt(cells[0], {
    trustedPublicKeyPem: runner.publicKey,
    artifactReceipt: artifact,
    trustedArtifactPublicKeyPem: builder.publicKey,
    requireWelCorpusReview: true,
    trustedWelCorpusReviewPublicKeyPem: foreignReviewer.publicKey
  }), (error) => error.code === 'VERIFICATION_RECEIPT_REJECTED'
    && error.details.failures.some((failure) => failure.includes('not the trusted independent reviewer')));

  const tampered = structuredClone(aggregate);
  delete tampered.signature;
  tampered.platformMatrix[0].welCorpusReview.measurement.counts.exactOccurrences += 1;
  const resigned = signVerificationReceipt(
    tampered, matrixReviewer.privateKey, 'release-matrix@example.test'
  );
  assert.throws(() => verifyVerificationReceipt(resigned, {
    trustedPublicKeyPem: matrixReviewer.publicKey,
    artifactReceipt: artifact,
    trustedArtifactPublicKeyPem: builder.publicKey,
    requiredPlatformMatrix: REQUIRED_RELEASE_PLATFORM_MATRIX,
    requireSgosEndToEnd: true,
    requireWelCorpusReview: true,
    trustedWelCorpusReviewPublicKeyPem: corpusReviewer.publicKey
  }), (error) => error.code === 'VERIFICATION_RECEIPT_REJECTED'
    && error.details.failures.some((failure) => failure.includes('signature or payload digest')));
});

test('artifact-builder, release-verifier, and WEL-reviewer key fingerprints must be pairwise distinct', () => {
  for (const collision of ['builder-verifier', 'builder-wel', 'verifier-wel']) {
    const shared = keys();
    const independentA = keys();
    const independentB = keys();
    const builder = collision.startsWith('builder-') ? shared : independentA;
    const runner = collision === 'builder-verifier' || collision === 'verifier-wel'
      ? shared
      : independentB;
    const corpusReviewer = collision === 'builder-wel' || collision === 'verifier-wel'
      ? shared
      : independentB;
    const artifact = artifactReceipt(builder);
    const corpus = reviewedWelCorpus(corpusReviewer);
    const receipt = signVerificationReceipt(
      currentEvidence(artifact, {}, corpus), runner.privateKey, 'release@example.test'
    );
    assert.throws(() => verifyVerificationReceipt(receipt, {
      trustedPublicKeyPem: runner.publicKey,
      artifactReceipt: artifact,
      trustedArtifactPublicKeyPem: builder.publicKey,
      trustedWelCorpusReviewPublicKeyPem: corpusReviewer.publicKey
    }), (error) => error.code === 'VERIFICATION_TRUST_ROOT_COLLISION'
      && error.details.roles.length === 2, collision);
  }

  const builder = keys();
  const runner = keys();
  const corpusReviewer = keys();
  const artifact = artifactReceipt(builder);
  const corpus = reviewedWelCorpus(corpusReviewer);
  const cell = signVerificationReceipt(
    currentEvidence(artifact, {}, corpus), runner.privateKey, 'cell@example.test'
  );
  assert.throws(() => mergeSignedVerificationReceipts(
    [cell], builder.privateKey, 'matrix@example.test', {
      artifactReceipt: artifact,
      trustedArtifactPublicKeyPem: builder.publicKey,
      trustedWelCorpusReviewPublicKeyPem: corpusReviewer.publicKey
    }
  ), (error) => error.code === 'VERIFICATION_TRUST_ROOT_COLLISION'
    && error.details.roles.includes('artifact-builder')
    && error.details.roles.includes('release-verifier'));
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
      && error.details.failures.some((failure) => failure.includes(
        `schemaVersion must be ${CURRENT_SINGLE_VERIFICATION_RECEIPT_VERSION}`
      ))
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
