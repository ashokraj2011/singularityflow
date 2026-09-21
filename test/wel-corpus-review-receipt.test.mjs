import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  signWelCorpusReviewReceipt, validateWelCorpusMeasurement, verifyWelCorpusReviewReceipt,
  WEL_CORPUS_LIFECYCLE_AUTHORITY, WEL_CORPUS_MEASUREMENT_SCHEMA,
  WEL_CORPUS_REVIEW_ASSURANCE, WEL_CORPUS_REVIEW_RECEIPT_KIND,
  WEL_CORPUS_REVIEW_RECEIPT_VERSION, WEL_CORPUS_RUNNER_ENTRYPOINT
} from '../src/wel-corpus-review-receipt.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function keys() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' })
  };
}

function distribution(minimum) {
  return { minimum, median: minimum + 1, p95: minimum + 2, maximum: minimum + 3 };
}

function measurement({ platform = 'darwin', architecture = 'arm64', nodeMajor = 22 } = {}) {
  return {
    schema: WEL_CORPUS_MEASUREMENT_SCHEMA,
    assurance: 'content-free-local-measurement',
    authority: 'none',
    platform,
    architecture,
    nodeMajor,
    corpusProfile: 'operator-reviewed-manifest-v1',
    inputBinding: 'operator-reviewed-out-of-band',
    repositoryCount: 3,
    caseCount: 4,
    requestedSamplesPerCase: 2,
    completedMeasurements: 8,
    outcome: 'observed',
    timingsMilliseconds: {
      observation: distribution(1),
      cpu: distribution(2)
    },
    catalogBytesPerCase: distribution(100),
    counts: {
      expectedExact: 2,
      expectedInexact: 1,
      expectedReportRefused: 1,
      observedExact: 2,
      observedInexact: 1,
      observedReportRefused: 1,
      falseExact: 0,
      falseInconclusive: 0,
      mismatched: 0,
      mappingProposals: 0,
      exactOccurrences: 2,
      reasons: {
        CODE_TEST_RESULT_REQUIRED: 1,
        UNSUPPORTED_JAVASCRIPT_SOURCE_SHAPE: 1
      }
    },
    availability: {
      javascriptStaticObservation: 'used',
      junitSurefireStaticObservation: 'used',
      model: 'not-invoked',
      astIntelligence: 'not-invoked',
      structuralExtraction: 'local-jdk-parser',
      network: 'not-invoked',
      testExecution: 'not-invoked',
      cache: 'not-used-observe-only'
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

function unsignedReceipt(options = {}) {
  const report = measurement(options);
  const validated = validateWelCorpusMeasurement(report);
  return {
    schemaVersion: WEL_CORPUS_REVIEW_RECEIPT_VERSION,
    kind: WEL_CORPUS_REVIEW_RECEIPT_KIND,
    reviewedAt: '2026-09-21T00:00:00.000Z',
    reviewerIdentity: 'independent-reviewer@example.test',
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
        nodeVersion: `${report.nodeMajor}.18.0`
      }
    },
    measurement: validated.evidence,
    measurementSha256: validated.evidenceSha256,
    assurance: WEL_CORPUS_REVIEW_ASSURANCE,
    lifecycleAuthority: WEL_CORPUS_LIFECYCLE_AUTHORITY
  };
}

test('independent WEL corpus review receipt binds source, runner, runtime, aggregate, and trust root', () => {
  const reviewer = keys();
  const receipt = signWelCorpusReviewReceipt(
    unsignedReceipt(), reviewer.privateKey, 'independent-reviewer@example.test'
  );
  const result = verifyWelCorpusReviewReceipt(receipt, {
    trustedPublicKeyPem: reviewer.publicKey,
    expectedCommit: 'a'.repeat(40),
    expectedTree: 'b'.repeat(40),
    expectedPlatform: 'darwin',
    expectedArchitecture: 'arm64',
    expectedNodeVersion: '22.18.0'
  });
  assert.equal(result.valid, true);
  assert.equal(result.evidence.lifecycleAuthority, 'none-observe-only');
  assert.equal(result.evidence.measurement.authoritative, false);
  assert.equal(result.evidence.measurement.releaseEligible, false);
  assert.match(result.evidenceSha256, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(result.measurementSha256, receipt.measurementSha256);
  assert.equal(
    result.independentReviewReference,
    'review:123e4567-e89b-42d3-a456-426614174000'
  );

  const digestReference = unsignedReceipt();
  digestReference.independentReviewReference = `sha256:${'1'.repeat(64)}`;
  assert.equal(signWelCorpusReviewReceipt(
    digestReference, reviewer.privateKey, 'independent-reviewer@example.test'
  ).independentReviewReference, `sha256:${'1'.repeat(64)}`);
});

test('corpus review rejects tampering, an untrusted signer, and source or runtime substitution', () => {
  const reviewer = keys();
  const receipt = signWelCorpusReviewReceipt(
    unsignedReceipt(), reviewer.privateKey, 'independent-reviewer@example.test'
  );
  const tampered = structuredClone(receipt);
  tampered.measurement.counts.observedExact += 1;
  assert.throws(() => verifyWelCorpusReviewReceipt(tampered, {
    trustedPublicKeyPem: reviewer.publicKey
  }), (error) => error.code === 'WEL_CORPUS_REVIEW_RECEIPT_SIGNATURE_INVALID');

  const foreign = keys();
  assert.throws(() => verifyWelCorpusReviewReceipt(receipt, {
    trustedPublicKeyPem: foreign.publicKey
  }), (error) => error.code === 'WEL_CORPUS_REVIEW_RECEIPT_UNTRUSTED');

  for (const expected of [
    { expectedCommit: 'c'.repeat(40) },
    { expectedTree: 'd'.repeat(40) },
    { expectedPlatform: 'linux' },
    { expectedArchitecture: 'x64' },
    { expectedNodeVersion: '20.20.2' }
  ]) {
    assert.throws(() => verifyWelCorpusReviewReceipt(receipt, {
      trustedPublicKeyPem: reviewer.publicKey,
      ...expected
    }), (error) => error.code === 'WEL_CORPUS_REVIEW_RECEIPT_INVALID');
  }
});

test('corpus review cannot sign false outcomes, content-bearing shapes, or lifecycle authority', () => {
  const reviewer = keys();
  const candidates = [];

  const falseExact = unsignedReceipt();
  falseExact.measurement.counts.falseExact = 1;
  candidates.push(falseExact);

  const mismatch = unsignedReceipt();
  mismatch.measurement.outcome = 'mismatch';
  mismatch.measurement.counts.mismatched = 1;
  candidates.push(mismatch);

  const contentBearing = unsignedReceipt();
  contentBearing.measurement.repositoryPath = '/private/customer/repository';
  candidates.push(contentBearing);

  const authorityUpgrade = unsignedReceipt();
  authorityUpgrade.lifecycleAuthority = 'story-publication';
  candidates.push(authorityUpgrade);

  for (const reference of [
    '../../private/review.json',
    'wel-review-2026-09-21-001',
    'review:123e4567-e89b-02d3-a456-426614174000',
    'review:123E4567-E89B-42D3-A456-426614174000',
    `sha256:${'A'.repeat(64)}`
  ]) {
    const unsafeReference = unsignedReceipt();
    unsafeReference.independentReviewReference = reference;
    candidates.push(unsafeReference);
  }

  for (const candidate of candidates) {
    assert.throws(() => signWelCorpusReviewReceipt(
      candidate, reviewer.privateKey, 'independent-reviewer@example.test'
    ), (error) => error.code === 'WEL_CORPUS_REVIEW_RECEIPT_INVALID');
  }
});

test('measurement validation is closed, aggregate-consistent, and content-free', () => {
  const incomplete = measurement();
  incomplete.completedMeasurements = 7;
  assert.throws(() => validateWelCorpusMeasurement(incomplete),
    (error) => error.code === 'WEL_CORPUS_MEASUREMENT_INVALID'
      && error.details.failures.includes('measurement completedMeasurements is incomplete'));

  const leaking = measurement();
  leaking.counts.reasons['customer/private/path'] = 1;
  assert.throws(() => validateWelCorpusMeasurement(leaking),
    (error) => error.code === 'WEL_CORPUS_MEASUREMENT_INVALID'
      && error.details.failures.includes('measurement reason counts are invalid'));

  const disguisedContent = measurement();
  disguisedContent.counts.reasons.SECRET_CUSTOMER_NAME = 1;
  assert.throws(() => validateWelCorpusMeasurement(disguisedContent),
    (error) => error.code === 'WEL_CORPUS_MEASUREMENT_INVALID'
      && error.details.failures.includes('measurement reason counts are invalid'));

  const missingReasonAggregate = measurement();
  missingReasonAggregate.counts.reasons = { CODE_TEST_RESULT_REQUIRED: 1 };
  assert.throws(() => validateWelCorpusMeasurement(missingReasonAggregate),
    (error) => error.code === 'WEL_CORPUS_MEASUREMENT_INVALID'
      && error.details.failures.includes(
        'measurement reason counts do not equal non-exact observed outcomes'
      ));

  const contradictoryZeroMismatch = measurement();
  contradictoryZeroMismatch.counts.observedExact = 1;
  contradictoryZeroMismatch.counts.observedInexact = 2;
  contradictoryZeroMismatch.counts.reasons.UNSUPPORTED_JAVASCRIPT_SOURCE_SHAPE = 2;
  assert.throws(() => validateWelCorpusMeasurement(contradictoryZeroMismatch),
    (error) => error.code === 'WEL_CORPUS_MEASUREMENT_INVALID'
      && error.details.failures.includes(
        'measurement zero mismatches contradict expected and observed category counts'
      ));

  const upgraded = measurement();
  upgraded.authoritative = true;
  assert.throws(() => validateWelCorpusMeasurement(upgraded),
    (error) => error.code === 'WEL_CORPUS_MEASUREMENT_INVALID'
      && error.details.failures.includes(
        'measurement must remain non-authoritative and outside lifecycle gating'
      ));
});

test('packaged CLI and schema expose the independent review boundary without a default signer', async () => {
  const [manifest, schema, script, verification, merge, release] = await Promise.all([
    readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'schemas/wel-corpus-review-receipt.schema.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'scripts/wel-corpus-review-receipt.mjs'), 'utf8'),
    readFile(path.join(root, 'scripts/verification-receipt.mjs'), 'utf8'),
    readFile(path.join(root, 'scripts/merge-verification-receipts.mjs'), 'utf8'),
    readFile(path.join(root, 'scripts/release.mjs'), 'utf8')
  ]);
  assert.ok(manifest.files.includes('scripts/wel-corpus-review-receipt.mjs'));
  assert.equal(
    manifest.scripts['evidence:wel:corpus-review'],
    'node scripts/wel-corpus-review-receipt.mjs'
  );
  assert.equal(schema.properties.lifecycleAuthority.const, 'none-observe-only');
  assert.equal(schema.properties.measurement.$ref, '#/$defs/measurement');
  assert.equal(
    schema.properties.independentReviewReference.pattern,
    '^(review:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|sha256:[a-f0-9]{64})$'
  );
  assert.ok((script.match(/assertReleaseCheckoutClean\(/gu) ?? []).length >= 2);
  assert.match(script, /readSecurePrivateKey/);
  assert.match(script, /writeReleaseJsonNoClobber/);
  for (const source of [verification, merge, release]) {
    assert.match(source, /--wel-corpus-review-key/);
  }
  assert.match(verification, /CURRENT_SINGLE_VERIFICATION_RECEIPT_VERSION/u);
  for (const source of [merge, release]) {
    assert.match(source, /requireCurrentMatrixVersion:\s*true/u);
  }
  const missing = spawnSync(process.execPath, ['scripts/wel-corpus-review-receipt.mjs'], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--review-reference <review:uuid\|sha256:64hex>/u);
});
