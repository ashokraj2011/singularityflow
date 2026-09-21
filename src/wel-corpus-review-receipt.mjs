/** Signed, content-free independent review evidence for one WEL real-repository corpus run. */
import {
  createHash, createPrivateKey, createPublicKey, sign as signBytes, verify as verifyBytes
} from 'node:crypto';

import { canonicalJson } from './records.mjs';
import { SingularityFlowError } from './util.mjs';

export const WEL_CORPUS_REVIEW_RECEIPT_VERSION = 1;
export const WEL_CORPUS_REVIEW_RECEIPT_KIND = 'singularity-flow-wel-real-corpus-review-receipt';
export const WEL_CORPUS_MEASUREMENT_SCHEMA = 'sflow-wel-real-corpus/v2';
export const WEL_CORPUS_RUNNER_ENTRYPOINT = 'scripts/wel-corpus-measurement.mjs';
export const WEL_CORPUS_REVIEW_ASSURANCE = 'content-free-independent-review';
export const WEL_CORPUS_LIFECYCLE_AUTHORITY = 'none-observe-only';

const MEASUREMENT_ASSURANCE = 'content-free-local-measurement';
const CORPUS_PROFILE = 'operator-reviewed-manifest-v1';
const INPUT_BINDING = 'operator-reviewed-out-of-band';
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const GIT_OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const NODE_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const SAFE_ARCHITECTURE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SAFE_REASON = /^[A-Z][A-Z0-9_]{2,127}$/;
const OPAQUE_REVIEW_REFERENCE = /^(?:review:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|sha256:[a-f0-9]{64})$/;
const PLATFORMS = new Set(['darwin', 'linux', 'win32']);
const MAX_REPORT_BYTES = 128 * 1024;
const MAX_COUNT = 1_000_000_000;
const MAX_DURATION_MILLISECONDS = 60 * 60 * 1_000;
const ALLOWED_REASONS = new Set([
  'CODE_TEST_RESULT_REQUIRED',
  'FOCUSED_TEST_EXECUTION_UNSUPPORTED',
  'FOCUSED_OR_RETRIED_TEST_EXECUTION_UNSUPPORTED',
  'FRAMEWORK_RETRY_UNSUPPORTED',
  'JAVASCRIPT_SOURCE_CATALOG_UNAVAILABLE',
  'JAVASCRIPT_TEST_SOURCE_UNAVAILABLE',
  'JAVASCRIPT_TEST_SOURCES_UNAVAILABLE',
  'JUNIT_SOURCE_CATALOG_UNAVAILABLE',
  'JUNIT_SOURCE_NOT_UTF8',
  'JUNIT_SOURCE_PARSER_CANCELLED',
  'JUNIT_SOURCE_PARSER_MALFORMED',
  'JUNIT_SOURCE_PARSER_OUTPUT_LIMIT',
  'JUNIT_SOURCE_PARSER_TIMEOUT',
  'JUNIT_SOURCE_PARSER_UNAVAILABLE',
  'JUNIT_TEST_SOURCE_UNAVAILABLE',
  'JUNIT_TEST_SOURCES_UNAVAILABLE',
  'MAVEN_SUREFIRE_COMMAND_UNSUPPORTED',
  'REPOSITORY_IDENTITY_UNAVAILABLE',
  'REPORT_SOURCE_DECLARATION_UNMATCHED',
  'REPORT_TEST_IDENTITY_AMBIGUOUS',
  'SOURCE_PATH_INVALID',
  'TAGGED_TEST_DECLARATIONS_UNAVAILABLE',
  'TEST_DECLARATION_COLLISION',
  'TEST_SOURCE_CHANGED_DURING_CAPTURE',
  'TEST_SOURCE_LIMIT_EXCEEDED',
  'UNSUPPORTED_JUNIT5_SOURCE_SHAPE',
  'UNSUPPORTED_JAVASCRIPT_SOURCE_SHAPE',
  'WITNESS_MAPPING_COLLISION',
  'WITNESS_MAPPING_PROPOSALS_UNAVAILABLE'
]);

const CONTENT_EXCLUDED = Object.freeze([
  'manifest-path', 'repository-path', 'file-path', 'test-name', 'clause-id',
  'content-digest', 'source-bytes', 'report-bytes', 'work-id', 'git-identity',
  'prompt', 'transcript'
]);

const MEASUREMENT_KEYS = Object.freeze([
  'architecture', 'assurance', 'authoritative', 'authority', 'availability',
  'caseCount', 'catalogBytesPerCase', 'completedMeasurements', 'contentExcluded',
  'corpusProfile', 'counts', 'inputBinding', 'lifecycleGate', 'nodeMajor', 'outcome',
  'platform', 'releaseEligible', 'repositoryCount', 'repositoryState',
  'requestedSamplesPerCase', 'schema', 'timingsMilliseconds'
]);

const COUNT_KEYS = Object.freeze([
  'exactOccurrences', 'expectedExact', 'expectedInexact', 'expectedReportRefused',
  'falseExact', 'falseInconclusive', 'mappingProposals', 'mismatched', 'observedExact',
  'observedInexact', 'observedReportRefused', 'reasons'
]);

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function plainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return plainObject(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort());
}

function boundedInteger(value, minimum = 0, maximum = MAX_COUNT) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function boundedNumber(value, minimum = 0, maximum = MAX_DURATION_MILLISECONDS) {
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}

function validTimestamp(value) {
  const milliseconds = typeof value === 'string' && value.endsWith('Z') ? Date.parse(value) : NaN;
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validIdentity(value) {
  return typeof value === 'string' && value === value.trim() && value.length > 0
    && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function nodeMajor(value) {
  const match = String(value ?? '').match(/^(\d+)\./u);
  return match ? Number(match[1]) : null;
}

function distributionFailures(value, label, { maximum = MAX_DURATION_MILLISECONDS } = {}) {
  if (!exactKeys(value, ['maximum', 'median', 'minimum', 'p95'])) {
    return [`${label} fields are invalid`];
  }
  const failures = [];
  for (const field of ['minimum', 'median', 'p95', 'maximum']) {
    if (!boundedNumber(value[field], 0, maximum)) failures.push(`${label}.${field} is invalid`);
  }
  if (!failures.length
      && !(value.minimum <= value.median && value.median <= value.p95
        && value.p95 <= value.maximum)) {
    failures.push(`${label} percentile order is invalid`);
  }
  return failures;
}

function collectMeasurementFailures(report, {
  platform = null,
  architecture = null,
  expectedNodeMajor = null,
  requireObserved = true
} = {}) {
  const failures = [];
  if (!exactKeys(report, MEASUREMENT_KEYS)) failures.push('measurement fields are invalid');
  if (report?.schema !== WEL_CORPUS_MEASUREMENT_SCHEMA) {
    failures.push(`measurement schema must be ${WEL_CORPUS_MEASUREMENT_SCHEMA}`);
  }
  if (report?.assurance !== MEASUREMENT_ASSURANCE) failures.push('measurement assurance is invalid');
  if (report?.authority !== 'none') failures.push('measurement authority must remain none');
  if (report?.corpusProfile !== CORPUS_PROFILE) failures.push('measurement corpusProfile is invalid');
  if (report?.inputBinding !== INPUT_BINDING) failures.push('measurement inputBinding is invalid');
  if (!PLATFORMS.has(report?.platform)) failures.push('measurement platform is unsupported');
  if (platform != null && report?.platform !== platform) failures.push('measurement platform does not match the reviewed runtime');
  if (!SAFE_ARCHITECTURE.test(String(report?.architecture ?? ''))) failures.push('measurement architecture is invalid');
  if (architecture != null && report?.architecture !== architecture) {
    failures.push('measurement architecture does not match the reviewed runtime');
  }
  if (!boundedInteger(report?.nodeMajor, 20, 99)) failures.push('measurement nodeMajor is invalid');
  if (expectedNodeMajor != null && report?.nodeMajor !== expectedNodeMajor) {
    failures.push('measurement nodeMajor does not match the reviewed runtime');
  }
  if (!boundedInteger(report?.repositoryCount, 1, 16)) failures.push('measurement repositoryCount is invalid');
  if (!boundedInteger(report?.caseCount, 1, 64)) failures.push('measurement caseCount is invalid');
  if (boundedInteger(report?.repositoryCount, 1, 16) && boundedInteger(report?.caseCount, 1, 64)
      && report.repositoryCount > report.caseCount) {
    failures.push('measurement repositoryCount cannot exceed caseCount');
  }
  if (!boundedInteger(report?.requestedSamplesPerCase, 1, 20)) {
    failures.push('measurement requestedSamplesPerCase is invalid');
  }
  if (report?.completedMeasurements !== report?.caseCount * report?.requestedSamplesPerCase) {
    failures.push('measurement completedMeasurements is incomplete');
  }
  if (!['observed', 'mismatch'].includes(report?.outcome)) failures.push('measurement outcome is invalid');
  if (requireObserved && report?.outcome !== 'observed') {
    failures.push('independent review requires an observed, non-mismatching measurement');
  }

  if (!exactKeys(report?.timingsMilliseconds, ['cpu', 'observation'])) {
    failures.push('measurement timingsMilliseconds fields are invalid');
  } else {
    failures.push(...distributionFailures(report.timingsMilliseconds.observation, 'measurement observation timing'));
    failures.push(...distributionFailures(report.timingsMilliseconds.cpu, 'measurement CPU timing'));
  }
  failures.push(...distributionFailures(report?.catalogBytesPerCase, 'measurement catalog bytes', {
    maximum: MAX_COUNT
  }));

  const counts = report?.counts;
  if (!exactKeys(counts, COUNT_KEYS)) failures.push('measurement counts fields are invalid');
  else {
    for (const field of COUNT_KEYS.filter((field) => field !== 'reasons')) {
      if (!boundedInteger(counts[field])) failures.push(`measurement counts.${field} is invalid`);
    }
    if (counts.expectedExact + counts.expectedInexact + counts.expectedReportRefused !== report.caseCount) {
      failures.push('measurement expected outcome counts do not equal caseCount');
    }
    if (counts.observedExact + counts.observedInexact + counts.observedReportRefused !== report.caseCount) {
      failures.push('measurement observed outcome counts do not equal caseCount');
    }
    if (counts.mismatched === 0 && (
      counts.expectedExact !== counts.observedExact
      || counts.expectedInexact !== counts.observedInexact
      || counts.expectedReportRefused !== counts.observedReportRefused
    )) {
      failures.push('measurement zero mismatches contradict expected and observed category counts');
    }
    if (requireObserved && (counts.falseExact !== 0 || counts.falseInconclusive !== 0
        || counts.mismatched !== 0)) {
      failures.push('independent review requires zero false or mismatched outcomes');
    }
    const reasons = counts.reasons;
    if (!plainObject(reasons) || Object.keys(reasons).length > 64) {
      failures.push('measurement reason counts are invalid');
    } else {
      let reasonTotal = 0;
      for (const [reason, count] of Object.entries(reasons)) {
        if (!SAFE_REASON.test(reason) || !ALLOWED_REASONS.has(reason)
            || !boundedInteger(count, 1, report.caseCount)) {
          failures.push('measurement reason counts are invalid');
          break;
        }
        reasonTotal += count;
      }
      if (reasonTotal !== counts.observedInexact + counts.observedReportRefused) {
        failures.push('measurement reason counts do not equal non-exact observed outcomes');
      }
    }
  }

  const availability = report?.availability;
  if (!exactKeys(availability, [
    'astIntelligence', 'cache', 'javascriptStaticObservation',
    'junitSurefireStaticObservation', 'model', 'network', 'structuralExtraction',
    'testExecution'
  ])) failures.push('measurement availability fields are invalid');
  else {
    for (const field of ['javascriptStaticObservation', 'junitSurefireStaticObservation']) {
      if (!['used', 'not-selected'].includes(availability[field])) {
        failures.push(`measurement availability.${field} is invalid`);
      }
    }
    if (availability.javascriptStaticObservation !== 'used'
        && availability.junitSurefireStaticObservation !== 'used') {
      failures.push('measurement did not exercise a supported WEL adapter family');
    }
    if (!['local-jdk-parser', 'not-invoked'].includes(availability.structuralExtraction)
        || availability.structuralExtraction !== (availability.junitSurefireStaticObservation === 'used'
          ? 'local-jdk-parser' : 'not-invoked')
        || availability.model !== 'not-invoked'
        || availability.astIntelligence !== 'not-invoked'
        || availability.network !== 'not-invoked'
        || availability.testExecution !== 'not-invoked'
        || availability.cache !== 'not-used-observe-only') {
      failures.push('measurement availability does not preserve the reviewed read-only boundary');
    }
  }
  if (report?.repositoryState !== 'unchanged-observed') failures.push('measurement repositoryState is invalid');
  if (report?.lifecycleGate !== false || report?.authoritative !== false
      || report?.releaseEligible !== false) {
    failures.push('measurement must remain non-authoritative and outside lifecycle gating');
  }
  if (canonicalJson(report?.contentExcluded) !== canonicalJson(CONTENT_EXCLUDED)) {
    failures.push('measurement contentExcluded is invalid');
  }
  try {
    if (Buffer.byteLength(canonicalJson(report), 'utf8') > MAX_REPORT_BYTES) {
      failures.push('measurement exceeds its byte limit');
    }
  } catch {
    failures.push('measurement is not canonical JSON');
  }
  return failures;
}

/** Validate and hash the exact content-free aggregate emitted by the real-corpus runner. */
export function validateWelCorpusMeasurement(report, expected = {}) {
  const failures = collectMeasurementFailures(report, expected);
  if (failures.length) {
    throw new SingularityFlowError(`WEL real-corpus measurement is invalid: ${failures.join('; ')}.`, {
      code: 'WEL_CORPUS_MEASUREMENT_INVALID', details: { failures }
    });
  }
  const evidence = structuredClone(report);
  return Object.freeze({ evidence, evidenceSha256: sha256(canonicalJson(evidence)) });
}

function publicKeyDer(key) {
  const publicKey = key?.type === 'public' ? key : createPublicKey(key);
  return publicKey.export({ type: 'spki', format: 'der' });
}

function payload(receipt) {
  const copy = structuredClone(receipt);
  delete copy.signature;
  return canonicalJson(copy);
}

function unsignedFailures(receipt, expected = {}) {
  const failures = [];
  if (!exactKeys(receipt, [
    'assurance', 'independentReviewReference', 'kind', 'lifecycleAuthority', 'measurement',
    'measurementSha256', 'reviewedAt', 'reviewerIdentity', 'runner', 'schemaVersion',
    'sourceCommit', 'sourceTree'
  ])) failures.push('review receipt fields are invalid');
  if (receipt?.schemaVersion !== WEL_CORPUS_REVIEW_RECEIPT_VERSION) { // schema-transient: externally signed review transport receipt
    failures.push(`schemaVersion must be ${WEL_CORPUS_REVIEW_RECEIPT_VERSION}`);
  }
  if (receipt?.kind !== WEL_CORPUS_REVIEW_RECEIPT_KIND) failures.push('kind is invalid');
  if (receipt?.assurance !== WEL_CORPUS_REVIEW_ASSURANCE) failures.push('assurance is invalid');
  if (receipt?.lifecycleAuthority !== WEL_CORPUS_LIFECYCLE_AUTHORITY) {
    failures.push('lifecycleAuthority must remain none-observe-only');
  }
  if (!validTimestamp(receipt?.reviewedAt)) failures.push('reviewedAt is invalid');
  if (!validIdentity(receipt?.reviewerIdentity)) failures.push('reviewerIdentity is invalid');
  if (!OPAQUE_REVIEW_REFERENCE.test(String(receipt?.independentReviewReference ?? ''))) {
    failures.push(
      'independentReviewReference must be review:<lowercase UUID> or sha256:<64 lowercase hex>'
    );
  }
  if (!GIT_OBJECT_ID.test(String(receipt?.sourceCommit ?? ''))) failures.push('sourceCommit is invalid');
  if (!GIT_OBJECT_ID.test(String(receipt?.sourceTree ?? ''))) failures.push('sourceTree is invalid');

  const runner = receipt?.runner;
  if (!exactKeys(runner, ['entrypoint', 'profile', 'reportSchema', 'runtime'])) {
    failures.push('runner fields are invalid');
  }
  if (runner?.entrypoint !== WEL_CORPUS_RUNNER_ENTRYPOINT) failures.push('runner entrypoint is invalid');
  if (runner?.profile !== CORPUS_PROFILE) failures.push('runner profile is invalid');
  if (runner?.reportSchema !== WEL_CORPUS_MEASUREMENT_SCHEMA) failures.push('runner reportSchema is invalid');
  const runtime = runner?.runtime;
  if (!exactKeys(runtime, ['architecture', 'nodeVersion', 'platform'])) {
    failures.push('runner runtime fields are invalid');
  }
  if (!PLATFORMS.has(runtime?.platform)) failures.push('runner runtime platform is unsupported');
  if (!SAFE_ARCHITECTURE.test(String(runtime?.architecture ?? ''))) {
    failures.push('runner runtime architecture is invalid');
  }
  if (!NODE_VERSION.test(String(runtime?.nodeVersion ?? ''))) failures.push('runner runtime nodeVersion is invalid');

  let measurement = null;
  try {
    measurement = validateWelCorpusMeasurement(receipt?.measurement, {
      platform: runtime?.platform,
      architecture: runtime?.architecture,
      expectedNodeMajor: nodeMajor(runtime?.nodeVersion),
      requireObserved: true
    });
    if (receipt?.measurementSha256 !== measurement.evidenceSha256) {
      failures.push('measurementSha256 does not match the exact measurement');
    }
  } catch (error) {
    failures.push(error.message);
  }
  for (const [field, label] of [
    ['sourceCommit', 'source commit'], ['sourceTree', 'source tree']
  ]) {
    if (expected[field] != null && receipt?.[field] !== expected[field]) {
      failures.push(`${label} does not match the expected release source`);
    }
  }
  for (const [field, label] of [
    ['platform', 'platform'], ['architecture', 'architecture'], ['nodeVersion', 'Node version']
  ]) {
    if (expected[field] != null && runtime?.[field] !== expected[field]) {
      failures.push(`runner runtime ${label} does not match the verified host`);
    }
  }
  return failures;
}

/** Sign a pre-reviewed content-free measurement. The caller supplies the independent key. */
export function signWelCorpusReviewReceipt(unsignedReceipt, privateKeyPem, reviewerIdentity) {
  let privateKey;
  try { privateKey = createPrivateKey(privateKeyPem); } catch {
    throw new SingularityFlowError('WEL corpus review signing key is invalid.', {
      code: 'WEL_CORPUS_REVIEW_SIGNING_KEY_INVALID'
    });
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new SingularityFlowError('WEL corpus review receipts require an Ed25519 signing key.', {
      code: 'WEL_CORPUS_REVIEW_SIGNING_KEY_INVALID'
    });
  }
  const receipt = {
    ...structuredClone(unsignedReceipt),
    reviewerIdentity: String(reviewerIdentity ?? '').trim()
  };
  const failures = unsignedFailures(receipt);
  if (failures.length) {
    throw new SingularityFlowError(`WEL corpus review receipt is invalid: ${failures.join('; ')}.`, {
      code: 'WEL_CORPUS_REVIEW_RECEIPT_INVALID', details: { failures }
    });
  }
  const publicDer = publicKeyDer(privateKey);
  const canonical = payload(receipt);
  return Object.freeze({
    ...receipt,
    signature: {
      algorithm: 'ed25519',
      publicKeySpki: publicDer.toString('base64'),
      publicKeySha256: sha256(publicDer),
      payloadSha256: sha256(canonical),
      value: signBytes(null, Buffer.from(canonical), privateKey).toString('base64')
    }
  });
}

function strictBase64(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return null;
  }
  try {
    const bytes = Buffer.from(value, 'base64');
    return bytes.toString('base64') === value ? bytes : null;
  } catch {
    return null;
  }
}

/** Verify independent authority, exact source/runtime binding, and the content-free measurement. */
export function verifyWelCorpusReviewReceipt(receipt, {
  trustedPublicKeyPem,
  expectedCommit = null,
  expectedTree = null,
  expectedPlatform = null,
  expectedArchitecture = null,
  expectedNodeVersion = null
} = {}) {
  if (!plainObject(receipt)) {
    throw new SingularityFlowError('WEL corpus review receipt must be an object.', {
      code: 'WEL_CORPUS_REVIEW_RECEIPT_INVALID'
    });
  }
  if (!exactKeys(receipt, [
    'assurance', 'independentReviewReference', 'kind', 'lifecycleAuthority', 'measurement',
    'measurementSha256', 'reviewedAt', 'reviewerIdentity', 'runner', 'schemaVersion',
    'signature', 'sourceCommit', 'sourceTree'
  ])) {
    throw new SingularityFlowError('WEL corpus review receipt fields are invalid.', {
      code: 'WEL_CORPUS_REVIEW_RECEIPT_INVALID'
    });
  }
  const signature = receipt.signature;
  if (!trustedPublicKeyPem || !exactKeys(signature, [
    'algorithm', 'payloadSha256', 'publicKeySha256', 'publicKeySpki', 'value'
  ]) || signature?.algorithm !== 'ed25519') {
    throw new SingularityFlowError(
      'WEL corpus review receipt requires an Ed25519 signature and an explicitly trusted independent reviewer key.',
      { code: 'WEL_CORPUS_REVIEW_RECEIPT_UNTRUSTED' }
    );
  }
  let trusted;
  try { trusted = createPublicKey(trustedPublicKeyPem); } catch {
    throw new SingularityFlowError('Trusted WEL corpus reviewer key is invalid.', {
      code: 'WEL_CORPUS_REVIEW_RECEIPT_UNTRUSTED'
    });
  }
  if (trusted.asymmetricKeyType !== 'ed25519') {
    throw new SingularityFlowError('Trusted WEL corpus reviewer key must be Ed25519.', {
      code: 'WEL_CORPUS_REVIEW_RECEIPT_UNTRUSTED'
    });
  }
  const embedded = strictBase64(signature.publicKeySpki);
  const signatureBytes = strictBase64(signature.value);
  const trustedDer = publicKeyDer(trusted);
  if (!embedded?.equals(trustedDer) || signature.publicKeySha256 !== sha256(trustedDer)) {
    throw new SingularityFlowError('WEL corpus review receipt signer is not the trusted independent reviewer.', {
      code: 'WEL_CORPUS_REVIEW_RECEIPT_UNTRUSTED'
    });
  }
  const canonical = payload(receipt);
  if (!signatureBytes || signature.payloadSha256 !== sha256(canonical)
      || !verifyBytes(null, Buffer.from(canonical), trusted, signatureBytes)) {
    throw new SingularityFlowError('WEL corpus review receipt signature or payload digest is invalid.', {
      code: 'WEL_CORPUS_REVIEW_RECEIPT_SIGNATURE_INVALID'
    });
  }
  const unsigned = structuredClone(receipt);
  delete unsigned.signature;
  const failures = unsignedFailures(unsigned, {
    sourceCommit: expectedCommit,
    sourceTree: expectedTree,
    platform: expectedPlatform,
    architecture: expectedArchitecture,
    nodeVersion: expectedNodeVersion
  });
  if (failures.length) {
    throw new SingularityFlowError(`WEL corpus review receipt is invalid: ${failures.join('; ')}.`, {
      code: 'WEL_CORPUS_REVIEW_RECEIPT_INVALID', details: { failures }
    });
  }
  const evidence = structuredClone(receipt);
  return Object.freeze({
    valid: true,
    evidence,
    evidenceSha256: sha256(canonicalJson(evidence)),
    payloadSha256: signature.payloadSha256,
    signerKeySha256: signature.publicKeySha256,
    reviewerIdentity: receipt.reviewerIdentity,
    independentReviewReference: receipt.independentReviewReference,
    sourceCommit: receipt.sourceCommit,
    sourceTree: receipt.sourceTree,
    platform: receipt.runner.runtime.platform,
    architecture: receipt.runner.runtime.architecture,
    nodeVersion: receipt.runner.runtime.nodeVersion,
    measurementSha256: receipt.measurementSha256
  });
}

export function isWelCorpusReviewEvidenceSha256(value) {
  return SHA256.test(String(value ?? ''));
}
