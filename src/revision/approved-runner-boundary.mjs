/**
 * Cryptographic boundary for a future independently approved isolated runner.
 *
 * This module does not select a runner and never grants Testing or publication authority.  It
 * defines the one provider ABI Singularity Flow is prepared to call, verifies provider-signed
 * Candidate/materialization attestations with SGOS' canonical Ed25519 envelope, admits
 * bounded browser artifacts without rendering or extracting them, and persists an authenticated
 * supplement beside the immutable BRL receipt.  The approved SGOS/CAB configuration remains the
 * only place from which a trusted public key and approval receipt may be obtained.
 */
import {
  createHash, createPublicKey, timingSafeEqual, verify as verifyBytes
} from 'node:crypto';
import path from 'node:path';

import { gitCommonDir } from '../git.mjs';
import {
  readPrivateSidecar, writeImmutablePrivateSidecar
} from '../private-sidecar.mjs';
import { canonicalJson, recordSha256 } from '../records.mjs';
import { readRecord, stampCurrentRecord } from '../schema-migrations.mjs';
import { clonePlatformJson, platformSha256 } from '../sgos/platform/contracts.mjs';
import { SingularityFlowError } from '../util.mjs';
import { validateRevisionBrowserRunReceipt } from './browser-loop.mjs';
import { APPROVED_RUNNER_PROVIDER } from './approved-runner-contract.mjs';
import {
  readRevisionBrowserArtifact, readRevisionBrowserRunReceipt
} from './browser-run-store.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/u;
const OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const RUN_ID = /^BRL-[a-f0-9]{12}$/u;
const CANDIDATE_ID = /^CAN-[A-Za-z0-9._:-]{6,127}$/u;
const KEY_ID = /^[a-z0-9][a-z0-9._:-]{1,127}$/u;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_ARTIFACTS = 256;
const STORED_EVIDENCE = Object.freeze({
  'attestation.json': Object.freeze({
    family: 'revision-candidate-under-test-attestation-envelope', signed: true
  }),
  'admission.json': Object.freeze({
    family: 'revision-runner-artifact-admission', signed: false
  }),
  'authenticated-receipt.json': Object.freeze({
    family: 'revision-authenticated-runner-receipt-envelope', signed: true
  })
});

export { APPROVED_RUNNER_PROVIDER };

const ALLOWED_MEDIA = new Map([
  ['application/json', new Set(['structured-result', 'playwright-report'])],
  ['application/zip', new Set(['playwright-trace', 'playwright-report'])],
  ['text/plain', new Set(['bounded-log', 'playwright-report'])],
  ['text/html', new Set(['playwright-report'])],
  ['image/png', new Set(['playwright-screenshot', 'visual-diff'])],
  ['image/jpeg', new Set(['playwright-screenshot', 'visual-diff'])],
  ['image/webp', new Set(['playwright-screenshot', 'visual-diff'])],
  ['video/webm', new Set(['playwright-video'])]
]);

function fail(code, message, details = null) {
  throw new SingularityFlowError(message, { code, details });
}
function hash(value) { return `sha256:${recordSha256(value)}`; }
function bytesHash(value) {
  return `sha256:${createHash('sha256').update(Buffer.from(value)).digest('hex')}`;
}
function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail('REV_RUNNER_CONTRACT_INVALID', `${label} must be a plain object.`);
  }
  return value;
}
function exact(value, fields, label) {
  plain(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length
      || actual.some((field, index) => field !== expected[index])) {
    fail('REV_RUNNER_CONTRACT_INVALID', `${label} has missing or unknown fields.`);
  }
  return value;
}
function digest(value, label) {
  if (!HASH.test(String(value ?? ''))) {
    fail('REV_RUNNER_CONTRACT_INVALID', `${label} needs an exact SHA-256 digest.`);
  }
  return value;
}
function timestamp(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))
      || new Date(value).toISOString() !== value) {
    fail('REV_RUNNER_CONTRACT_INVALID', `${label} needs an exact UTC timestamp.`);
  }
  return value;
}
function boundedRecord(value, label) {
  let size;
  try { size = Buffer.byteLength(canonicalJson(value)); }
  catch { fail('REV_RUNNER_CONTRACT_INVALID', `${label} is not canonical JSON.`); }
  if (size > MAX_RECORD_BYTES) {
    fail('REV_RUNNER_RECORD_LIMIT', `${label} exceeds the 256 KiB record limit.`);
  }
  return value;
}
function seal(kind, core, field) {
  const value = stampCurrentRecord(kind, { kind, ...core });
  return Object.freeze({ ...value, [field]: hash(value) });
}
function currentRecord(kind, value, label) {
  try { return readRecord(kind, value).record; }
  catch { fail('REV_RUNNER_CONTRACT_INVALID', `${label} has an unreadable schema version.`); }
}

function durableSignedEnvelope(family, signed, label) {
  exact(signed, ['record', 'signature'], label);
  return stampCurrentRecord(family, {
    kind: family,
    record: clonePlatformJson(signed.record),
    signature: clonePlatformJson(signed.signature)
  });
}

function storedEvidenceRecord(name, value) {
  const descriptor = STORED_EVIDENCE[name];
  if (!descriptor) fail('REV_RUNNER_STORE_SCOPE', 'Authenticated runner evidence name is invalid.');
  return descriptor.signed
    ? durableSignedEnvelope(descriptor.family, value, `Stored ${name} signed envelope`)
    : currentRecord(descriptor.family, value, `Stored ${name}`);
}

function readStoredEvidenceRecord(name, bytes) {
  const descriptor = STORED_EVIDENCE[name];
  if (!descriptor) fail('REV_RUNNER_STORE_SCOPE', 'Authenticated runner evidence name is invalid.');
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); }
  catch { fail('REV_RUNNER_STORE_CORRUPT', 'Stored authenticated runner evidence is not JSON.'); }
  const wasLegacySignedEnvelope = descriptor.signed
    && !Object.hasOwn(parsed, 'schemaVersion') && !Object.hasOwn(parsed, 'kind');
  const stored = currentRecord(descriptor.family, parsed, `Stored ${name}`);
  if (!descriptor.signed) return stored;
  if (wasLegacySignedEnvelope) {
    exact(parsed, ['record', 'signature'], `Legacy stored ${name} signed envelope`);
    return structuredClone(parsed);
  }
  exact(stored, ['schemaVersion', 'kind', 'record', 'signature'], `Stored ${name} signed envelope`);
  if (stored.kind !== descriptor.family) {
    fail('REV_RUNNER_STORE_CORRUPT', `Stored ${name} names a different durable family.`);
  }
  return Object.freeze({
    record: structuredClone(stored.record), signature: structuredClone(stored.signature)
  });
}

/*
 * Same detached Ed25519 envelope and canonical payload used by SGOS platform records. REV records
 * keep their own frozen schema/self-hash rather than pretending to be an existing SGOS family.
 * Trust still comes from the SGOS/CAB-selected public key; this function owns no key registry.
 */
function verifySgosCompatibleSignedRecord(signed, { trustedPublicKeyPem, expectedKeyId }) {
  exact(signed, ['record', 'signature'], 'Signed runner record');
  exact(signed.signature, [
    'algorithm', 'keyId', 'keySha256', 'payloadSha256', 'value'
  ], 'Runner record signature');
  if (signed.signature.algorithm !== 'ed25519' || signed.signature.keyId !== expectedKeyId) {
    fail('REV_RUNNER_SIGNATURE_UNTRUSTED', 'Runner record signature key is not approved.');
  }
  let trusted;
  try { trusted = createPublicKey(trustedPublicKeyPem); }
  catch { fail('REV_RUNNER_SIGNATURE_UNTRUSTED', 'Approved runner public key is invalid.'); }
  if (trusted.asymmetricKeyType !== 'ed25519') {
    fail('REV_RUNNER_SIGNATURE_UNTRUSTED', 'Approved runner key must be Ed25519.');
  }
  const keySha256 = platformSha256(trusted.export({ type: 'spki', format: 'der' }));
  const payload = canonicalJson(clonePlatformJson(signed.record));
  const payloadSha256 = platformSha256(payload);
  let signature = Buffer.alloc(0);
  if (/^[A-Za-z0-9+/]{86}==$/.test(String(signed.signature.value ?? ''))) {
    signature = Buffer.from(signed.signature.value, 'base64');
  }
  if (!HASH.test(String(signed.signature.keySha256 ?? ''))
      || !HASH.test(String(signed.signature.payloadSha256 ?? ''))
      || !timingSafeEqual(Buffer.from(signed.signature.keySha256), Buffer.from(keySha256))
      || !timingSafeEqual(Buffer.from(signed.signature.payloadSha256), Buffer.from(payloadSha256))
      || signature.length !== 64
      || !verifyBytes(null, Buffer.from(payload), trusted, signature)) {
    fail('REV_RUNNER_SIGNATURE_INVALID', 'Runner record signature or payload digest is invalid.');
  }
  return structuredClone(signed.record);
}

/** Validate the fixed provider ABI. This checks shape, not approval or installation. */
export function validateApprovedIsolatedRunnerProvider(provider) {
  exact(provider, ['descriptor', 'executeSealedRevisionRun'], 'isolated runner provider');
  exact(provider.descriptor, Object.keys(APPROVED_RUNNER_PROVIDER), 'isolated runner descriptor');
  for (const [field, expected] of Object.entries(APPROVED_RUNNER_PROVIDER)) {
    if (provider.descriptor[field] !== expected) {
      fail('REV_RUNNER_PROVIDER_UNREGISTERED',
        `Isolated runner provider ${field} does not match the registered v1 provider ABI.`);
    }
  }
  if (typeof provider.executeSealedRevisionRun !== 'function'
      || provider.executeSealedRevisionRun.length !== 1) {
    fail('REV_RUNNER_PROVIDER_UNREGISTERED',
      'The registered isolated runner must expose exactly executeSealedRevisionRun(request).');
  }
  return Object.freeze({ ...provider.descriptor });
}

/**
 * Fail-closed machine diagnostic. Passing values proves shape only: SGOS/CAB still has to load the
 * approval receipt and trusted key, and the execution adapter intentionally remains disconnected.
 */
export function inspectApprovedRunnerReadiness({
  provider = null, trustedPublicKeyPem = null, authorityReceiptSha256 = null,
  authorityPolicySha256 = null
} = {}) {
  const checks = [];
  let providerDescriptor = null;
  try {
    providerDescriptor = validateApprovedIsolatedRunnerProvider(provider);
    checks.push({ id: 'registered-provider', status: 'present', reasonCode: null });
  } catch {
    checks.push({ id: 'registered-provider', status: 'unavailable',
      reasonCode: 'REV_RUNNER_PROVIDER_UNAVAILABLE' });
  }
  checks.push({ id: 'sgos-cab-authority-receipt',
    status: HASH.test(String(authorityReceiptSha256 ?? '')) ? 'present-unverified' : 'unavailable',
    reasonCode: HASH.test(String(authorityReceiptSha256 ?? ''))
      ? 'REV_RUNNER_AUTHORITY_REVALIDATION_REQUIRED' : 'REV_RUNNER_AUTHORITY_UNAVAILABLE' });
  checks.push({ id: 'sgos-cab-policy-binding',
    status: HASH.test(String(authorityPolicySha256 ?? '')) ? 'present-unverified' : 'unavailable',
    reasonCode: HASH.test(String(authorityPolicySha256 ?? ''))
      ? 'REV_RUNNER_AUTHORITY_REVALIDATION_REQUIRED' : 'REV_RUNNER_POLICY_UNAVAILABLE' });
  checks.push({ id: 'trusted-runner-key',
    status: typeof trustedPublicKeyPem === 'string' && trustedPublicKeyPem.trim()
      ? 'present-unverified' : 'unavailable',
    reasonCode: typeof trustedPublicKeyPem === 'string' && trustedPublicKeyPem.trim()
      ? 'REV_RUNNER_AUTHORITY_REVALIDATION_REQUIRED' : 'REV_RUNNER_TRUST_KEY_UNAVAILABLE' });
  const core = {
    schemaVersion: 1,
    kind: 'revision-approved-runner-readiness',
    provider: providerDescriptor,
    checks,
    contractBoundaryAvailable: true,
    artifactAdmissionAvailable: true,
    authenticatedStoreAvailable: true,
    authoritySource: 'sgos-cab-approved-configuration',
    activationStatus: 'disabled-pending-authority-revalidation-and-adapter-wiring',
    executionEnabled: false,
    testingVerificationEstablished: false,
    publicationEligibilityEstablished: false
  };
  return Object.freeze({ ...core, readinessSha256: hash(core) });
}

function validateRunKeySummary(value) {
  exact(value, [
    'runId', 'runKeySha256', 'candidateId', 'candidateSha256', 'candidateRefSha256',
    'candidateTree', 'materializationSha256', 'environmentSha256'
  ], 'Candidate-under-test run binding');
  if (!RUN_ID.test(String(value.runId ?? ''))
      || !CANDIDATE_ID.test(String(value.candidateId ?? ''))
      || !OID.test(String(value.candidateTree ?? ''))) {
    fail('REV_RUNNER_ATTESTATION_INVALID', 'Candidate-under-test identity is invalid.');
  }
  for (const field of [
    'runKeySha256', 'candidateSha256', 'candidateRefSha256', 'materializationSha256',
    'environmentSha256'
  ]) digest(value[field], field);
  return { ...value };
}

/** Build the unsigned record a registered provider must sign after materialization and cleanup. */
export function defineCandidateUnderTestAttestation({
  runKey, providerKeyId, observedAt, completedAt, nonceSha256,
  filesystemIsolation = 'ephemeral-readonly-candidate',
  processIsolation = 'dedicated-process-group', networkIsolation = 'deny-all',
  cleanupStatus = 'verified'
} = {}) {
  const selected = validateRunKeySummary(runKey);
  if (!KEY_ID.test(String(providerKeyId ?? ''))) {
    fail('REV_RUNNER_ATTESTATION_INVALID', 'Candidate attestation needs a canonical provider key ID.');
  }
  timestamp(observedAt, 'Candidate observation');
  timestamp(completedAt, 'Candidate completion');
  if (Date.parse(completedAt) < Date.parse(observedAt)) {
    fail('REV_RUNNER_ATTESTATION_INVALID', 'Candidate completion predates its observation.');
  }
  digest(nonceSha256, 'Candidate attestation nonce');
  if (filesystemIsolation !== 'ephemeral-readonly-candidate'
      || processIsolation !== 'dedicated-process-group'
      || networkIsolation !== 'deny-all' || cleanupStatus !== 'verified') {
    fail('REV_RUNNER_ISOLATION_UNSATISFIED',
      'Candidate attestation must prove read-only candidate bytes, a dedicated process group, denied network, and verified cleanup.');
  }
  return seal('revision-candidate-under-test-attestation', {
    providerId: APPROVED_RUNNER_PROVIDER.id,
    providerProtocol: APPROVED_RUNNER_PROVIDER.protocol,
    providerKeyId,
    run: selected,
    observedAt, completedAt, nonceSha256,
    isolation: {
      filesystem: filesystemIsolation,
      process: processIsolation,
      network: networkIsolation
    },
    cleanupStatus,
    testingAuthorityEstablished: false,
    publicationEligibilityEstablished: false
  }, 'attestationSha256');
}

function validateCandidateAttestationRecord(value, expectedRunKey = null) {
  value = currentRecord('revision-candidate-under-test-attestation', value,
    'Candidate-under-test attestation');
  exact(value, [
    'schemaVersion', 'kind', 'providerId', 'providerProtocol', 'providerKeyId', 'run',
    'observedAt', 'completedAt', 'nonceSha256', 'isolation', 'cleanupStatus',
    'testingAuthorityEstablished', 'publicationEligibilityEstablished', 'attestationSha256'
  ], 'Candidate-under-test attestation');
  if (value.kind !== 'revision-candidate-under-test-attestation'
      || value.providerId !== APPROVED_RUNNER_PROVIDER.id
      || value.providerProtocol !== APPROVED_RUNNER_PROVIDER.protocol
      || !KEY_ID.test(String(value.providerKeyId ?? ''))) {
    fail('REV_RUNNER_ATTESTATION_INVALID', 'Candidate-under-test provider identity is invalid.');
  }
  const run = validateRunKeySummary(value.run);
  timestamp(value.observedAt, 'Candidate observation');
  timestamp(value.completedAt, 'Candidate completion');
  digest(value.nonceSha256, 'Candidate attestation nonce');
  digest(value.attestationSha256, 'Candidate attestation');
  exact(value.isolation, ['filesystem', 'network', 'process'], 'Candidate isolation');
  if (Date.parse(value.completedAt) < Date.parse(value.observedAt)
      || value.isolation.filesystem !== 'ephemeral-readonly-candidate'
      || value.isolation.process !== 'dedicated-process-group'
      || value.isolation.network !== 'deny-all' || value.cleanupStatus !== 'verified'
      || value.testingAuthorityEstablished !== false
      || value.publicationEligibilityEstablished !== false) {
    fail('REV_RUNNER_ATTESTATION_INVALID', 'Candidate-under-test isolation or authority boundary is invalid.');
  }
  const { attestationSha256, ...core } = value;
  if (hash(core) !== attestationSha256) {
    fail('REV_RUNNER_ATTESTATION_INVALID', 'Candidate-under-test self hash is invalid.');
  }
  if (expectedRunKey) {
    const expected = {
      runId: expectedRunKey.runId,
      runKeySha256: expectedRunKey.runKeySha256,
      candidateId: expectedRunKey.candidateId,
      candidateSha256: expectedRunKey.candidateSha256,
      candidateRefSha256: expectedRunKey.candidateRefSha256,
      candidateTree: expectedRunKey.candidateTree,
      materializationSha256: expectedRunKey.materializationSha256,
      environmentSha256: expectedRunKey.environmentSha256
    };
    if (canonicalJson(run) !== canonicalJson(expected)) {
      fail('REV_RUNNER_ATTESTATION_STALE',
        'Candidate-under-test attestation does not bind the exact browser run key.');
    }
  }
  return Object.freeze(structuredClone(value));
}

/** Verify using the existing SGOS signed-record primitive and an authority-loaded public key. */
export function verifyCandidateUnderTestAttestation(signed, {
  trustedPublicKeyPem, expectedKeyId, expectedRunKey = null
} = {}) {
  if (typeof trustedPublicKeyPem !== 'string' || !trustedPublicKeyPem.trim()
      || !KEY_ID.test(String(expectedKeyId ?? ''))) {
    fail('REV_RUNNER_TRUST_UNAVAILABLE',
      'Candidate attestation verification needs the exact SGOS/CAB-approved key and key ID.');
  }
  const verified = verifySgosCompatibleSignedRecord(signed, {
    trustedPublicKeyPem, expectedKeyId
  });
  const attestation = validateCandidateAttestationRecord(verified, expectedRunKey);
  if (attestation.providerKeyId !== expectedKeyId) {
    fail('REV_RUNNER_ATTESTATION_UNTRUSTED', 'Candidate attestation names a different provider key.');
  }
  return attestation;
}

function detectMediaType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF'
      && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45
      && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video/webm';
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
      && [0x03, 0x05, 0x07].includes(bytes[2]) && [0x04, 0x06, 0x08].includes(bytes[3])) {
    return 'application/zip';
  }
  if (bytes.includes(0)) return null;
  const text = bytes.toString('utf8');
  if (Buffer.from(text, 'utf8').equals(bytes)) {
    const trimmed = text.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { JSON.parse(text); return 'application/json'; } catch { return null; }
    }
    if (/^(?:<!doctype\s+html|<html(?:\s|>))/iu.test(trimmed)) return 'text/html';
    return 'text/plain';
  }
  return null;
}

/**
 * Independently bind bytes to the receipt inventory. Opaque compressed/media formats are never
 * rendered or extracted here; admission means safe bounded retention, not safe active content.
 */
export function admitApprovedRunnerArtifacts({
  receipt, artifactBytes, candidateAttestationSha256
} = {}) {
  const browserReceipt = validateRevisionBrowserRunReceipt(receipt);
  digest(candidateAttestationSha256, 'Candidate attestation');
  const expectedDigests = new Set(browserReceipt.artifacts.map((artifact) => artifact.sha256));
  if (!(artifactBytes instanceof Map) || artifactBytes.size !== expectedDigests.size
      || artifactBytes.size > MAX_ARTIFACTS
      || [...artifactBytes.keys()].some((artifactSha256) => !expectedDigests.has(artifactSha256))) {
    fail('REV_RUNNER_ARTIFACT_INVALID', 'Artifact byte handoff differs from the receipt inventory.');
  }
  const admissions = [];
  let totalBytes = 0;
  for (const [receiptIndex, artifact] of browserReceipt.artifacts.entries()) {
    const bytes = artifactBytes.get(artifact.sha256);
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_ARTIFACT_BYTES
        || bytes.length !== artifact.bytes || bytesHash(bytes) !== artifact.sha256) {
      fail('REV_RUNNER_ARTIFACT_INVALID', 'Artifact bytes do not match their bounded receipt entry.');
    }
    const detectedMediaType = detectMediaType(bytes);
    if (detectedMediaType !== artifact.mediaType
        || !ALLOWED_MEDIA.get(detectedMediaType)?.has(artifact.kind)) {
      fail('REV_RUNNER_ARTIFACT_MEDIA_MISMATCH',
        `Artifact '${artifact.path}' bytes do not match its declared media type and kind.`);
    }
    totalBytes += bytes.length;
    if (totalBytes > 32 * 1024 * 1024) {
      fail('REV_RUNNER_ARTIFACT_LIMIT', 'Admitted artifacts exceed the 32 MiB aggregate limit.');
    }
    admissions.push(Object.freeze({
      receiptIndex,
      path: artifact.path,
      artifactSha256: artifact.sha256,
      receiptSha256: browserReceipt.receiptSha256,
      candidateAttestationSha256,
      kind: artifact.kind,
      declaredMediaType: artifact.mediaType,
      detectedMediaType,
      bytes: bytes.length,
      validation: ['application/json', 'text/plain', 'text/html'].includes(detectedMediaType)
        ? 'decoded-bounded-content' : 'magic-bounded-opaque',
      activeContentPermitted: false,
      archiveExtractionPermitted: false,
      previewable: false
    }));
  }
  return seal('revision-runner-artifact-admission', {
    runId: browserReceipt.runKey.runId,
    runKeySha256: browserReceipt.runKey.runKeySha256,
    receiptSha256: browserReceipt.receiptSha256,
    candidateAttestationSha256,
    artifacts: admissions,
    artifactCount: admissions.length,
    totalBytes,
    renderingAuthorized: false,
    extractionAuthorized: false
  }, 'admissionSha256');
}

function validateArtifactAdmission(value, receipt, attestation) {
  value = currentRecord('revision-runner-artifact-admission', value, 'Artifact admission');
  exact(value, [
    'schemaVersion', 'kind', 'runId', 'runKeySha256', 'receiptSha256',
    'candidateAttestationSha256', 'artifacts', 'artifactCount', 'totalBytes',
    'renderingAuthorized', 'extractionAuthorized', 'admissionSha256'
  ], 'Artifact admission');
  if (value.kind !== 'revision-runner-artifact-admission'
      || value.runId !== receipt.runKey.runId
      || value.runKeySha256 !== receipt.runKey.runKeySha256
      || value.receiptSha256 !== receipt.receiptSha256
      || value.candidateAttestationSha256 !== attestation.attestationSha256
      || value.renderingAuthorized !== false || value.extractionAuthorized !== false
      || !Array.isArray(value.artifacts) || value.artifacts.length > MAX_ARTIFACTS
      || value.artifactCount !== value.artifacts.length
      || !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0
      || value.totalBytes > 32 * 1024 * 1024) {
    fail('REV_RUNNER_ARTIFACT_INVALID', 'Artifact admission does not bind the exact receipt and attestation.');
  }
  let total = 0;
  for (const [receiptIndex, item] of value.artifacts.entries()) {
    exact(item, [
      'receiptIndex', 'path', 'artifactSha256', 'receiptSha256',
      'candidateAttestationSha256', 'kind',
      'declaredMediaType', 'detectedMediaType', 'bytes', 'validation',
      'activeContentPermitted', 'archiveExtractionPermitted', 'previewable'
    ], 'Admitted artifact');
    const original = receipt.artifacts[receiptIndex];
    const expectedValidation = ['application/json', 'text/plain', 'text/html']
      .includes(item.detectedMediaType)
      ? 'decoded-bounded-content' : 'magic-bounded-opaque';
    if (!original || item.receiptIndex !== receiptIndex || item.path !== original.path
        || item.artifactSha256 !== original.sha256
        || item.receiptSha256 !== receipt.receiptSha256
        || item.candidateAttestationSha256 !== attestation.attestationSha256
        || item.kind !== original.kind || item.declaredMediaType !== original.mediaType
        || item.detectedMediaType !== original.mediaType || item.bytes !== original.bytes
        || !ALLOWED_MEDIA.get(item.detectedMediaType)?.has(item.kind)
        || item.validation !== expectedValidation
        || item.activeContentPermitted !== false
        || item.archiveExtractionPermitted !== false || item.previewable !== false) {
      fail('REV_RUNNER_ARTIFACT_INVALID', 'Admitted artifact metadata is inconsistent.');
    }
    total += item.bytes;
  }
  const { admissionSha256, ...core } = value;
  digest(admissionSha256, 'Artifact admission');
  if (value.artifacts.length !== receipt.artifacts.length || total !== value.totalBytes
      || hash(core) !== admissionSha256) {
    fail('REV_RUNNER_ARTIFACT_INVALID', 'Artifact admission seal or inventory is invalid.');
  }
  return Object.freeze(structuredClone(value));
}

/** Build the unsigned provider receipt that authenticates an existing frozen BRL v1 receipt. */
export function defineAuthenticatedRunnerReceipt({
  receipt, attestation, admission, providerKeyId, authorityReceiptSha256,
  authorityPolicySha256, issuedAt
} = {}) {
  const browserReceipt = validateRevisionBrowserRunReceipt(receipt);
  const candidate = validateCandidateAttestationRecord(attestation, browserReceipt.runKey);
  const artifacts = validateArtifactAdmission(admission, browserReceipt, candidate);
  if (providerKeyId !== candidate.providerKeyId || !KEY_ID.test(String(providerKeyId ?? ''))) {
    fail('REV_RUNNER_RECEIPT_INVALID', 'Authenticated receipt provider key does not match its attestation.');
  }
  digest(authorityReceiptSha256, 'SGOS/CAB authority receipt');
  digest(authorityPolicySha256, 'SGOS/CAB authority policy');
  timestamp(issuedAt, 'Authenticated receipt issue time');
  return seal('revision-authenticated-runner-receipt', {
    providerId: APPROVED_RUNNER_PROVIDER.id,
    providerProtocol: APPROVED_RUNNER_PROVIDER.protocol,
    providerKeyId,
    authority: {
      source: 'sgos-cab-approved-configuration',
      receiptSha256: authorityReceiptSha256,
      policySha256: authorityPolicySha256,
      revalidationRequiredAtConsumption: true
    },
    runId: browserReceipt.runKey.runId,
    runKeySha256: browserReceipt.runKey.runKeySha256,
    browserReceiptSha256: browserReceipt.receiptSha256,
    candidateAttestationSha256: candidate.attestationSha256,
    artifactAdmissionSha256: artifacts.admissionSha256,
    issuedAt,
    executionAssurance: 'provider-signed-isolation-claims',
    testingVerificationStatus: 'authenticated-not-lifecycle-admitted',
    publicationEligibilityEstablished: false
  }, 'authenticatedReceiptSha256');
}

function validateAuthenticatedRecord(value, receipt, attestation, admission) {
  value = currentRecord('revision-authenticated-runner-receipt', value,
    'Authenticated runner receipt');
  exact(value, [
    'schemaVersion', 'kind', 'providerId', 'providerProtocol', 'providerKeyId',
    'authority', 'runId', 'runKeySha256', 'browserReceiptSha256',
    'candidateAttestationSha256', 'artifactAdmissionSha256', 'issuedAt',
    'executionAssurance', 'testingVerificationStatus',
    'publicationEligibilityEstablished', 'authenticatedReceiptSha256'
  ], 'Authenticated runner receipt');
  exact(value.authority, [
    'source', 'receiptSha256', 'policySha256', 'revalidationRequiredAtConsumption'
  ], 'Authenticated runner authority binding');
  timestamp(value.issuedAt, 'Authenticated receipt issue time');
  for (const field of ['receiptSha256', 'policySha256']) digest(value.authority[field], field);
  if (value.kind !== 'revision-authenticated-runner-receipt'
      || value.providerId !== APPROVED_RUNNER_PROVIDER.id
      || value.providerProtocol !== APPROVED_RUNNER_PROVIDER.protocol
      || value.providerKeyId !== attestation.providerKeyId
      || value.authority.source !== 'sgos-cab-approved-configuration'
      || value.authority.revalidationRequiredAtConsumption !== true
      || value.runId !== receipt.runKey.runId
      || value.runKeySha256 !== receipt.runKey.runKeySha256
      || value.browserReceiptSha256 !== receipt.receiptSha256
      || value.candidateAttestationSha256 !== attestation.attestationSha256
      || value.artifactAdmissionSha256 !== admission.admissionSha256
      || value.executionAssurance !== 'provider-signed-isolation-claims'
      || value.testingVerificationStatus !== 'authenticated-not-lifecycle-admitted'
      || value.publicationEligibilityEstablished !== false) {
    fail('REV_RUNNER_RECEIPT_INVALID', 'Authenticated runner receipt bindings or authority boundary are invalid.');
  }
  const { authenticatedReceiptSha256, ...core } = value;
  digest(authenticatedReceiptSha256, 'Authenticated runner receipt');
  if (hash(core) !== authenticatedReceiptSha256) {
    fail('REV_RUNNER_RECEIPT_INVALID', 'Authenticated runner receipt self hash is invalid.');
  }
  return Object.freeze(structuredClone(value));
}

/** Verify both provider signatures and all Candidate, run, receipt, and artifact joins. */
export function verifyAuthenticatedRunnerEvidence({
  receipt, signedAttestation, admission, signedAuthenticatedReceipt,
  trustedPublicKeyPem, expectedKeyId, expectedAuthorityReceiptSha256,
  expectedAuthorityPolicySha256
} = {}) {
  const browserReceipt = validateRevisionBrowserRunReceipt(receipt);
  const attestation = verifyCandidateUnderTestAttestation(signedAttestation, {
    trustedPublicKeyPem, expectedKeyId, expectedRunKey: browserReceipt.runKey
  });
  const admitted = validateArtifactAdmission(admission, browserReceipt, attestation);
  const record = verifySgosCompatibleSignedRecord(signedAuthenticatedReceipt, {
    trustedPublicKeyPem, expectedKeyId
  });
  const authenticatedReceipt = validateAuthenticatedRecord(
    record, browserReceipt, attestation, admitted
  );
  if (authenticatedReceipt.authority.receiptSha256 !== expectedAuthorityReceiptSha256
      || authenticatedReceipt.authority.policySha256 !== expectedAuthorityPolicySha256) {
    fail('REV_RUNNER_AUTHORITY_STALE',
      'Authenticated evidence does not bind the current SGOS/CAB authority receipt and policy.');
  }
  return Object.freeze({
    receipt: browserReceipt,
    attestation,
    admission: admitted,
    authenticatedReceipt,
    authenticationStatus: 'verified',
    lifecycleAdmissionStatus: 'not-established',
    testingVerificationEstablished: false,
    publicationEligibilityEstablished: false
  });
}

function evidencePath(root, runId, name) {
  if (!RUN_ID.test(String(runId ?? '')) || !Object.hasOwn(STORED_EVIDENCE, name)) {
    fail('REV_RUNNER_STORE_SCOPE', 'Authenticated runner evidence path is invalid.');
  }
  return path.join(path.resolve(gitCommonDir(root)), 'singularity-flow',
    'revision-browser-runs', runId, 'authenticated', name);
}

async function immutableJson(root, target, value) {
  boundedRecord(value, 'Authenticated runner evidence');
  try {
    return await writeImmutablePrivateSidecar(root, target,
      Buffer.from(canonicalJson(value)), {
        maximumBytes: MAX_RECORD_BYTES, enforceWindowsAcl: true
      });
  } catch (error) {
    if (error?.code === 'PRIVATE_SIDECAR_RECORD_CONFLICT') {
      fail('REV_RUNNER_STORE_CONFLICT',
        'This browser run already has different authenticated evidence. Create a new run.');
    }
    throw error;
  }
}

async function readAndAdmitStoredArtifacts(root, receipt, candidateAttestationSha256) {
  const bytes = new Map();
  try {
    for (const artifact of receipt.artifacts) {
      if (bytes.has(artifact.sha256)) continue;
      bytes.set(artifact.sha256, await readRevisionBrowserArtifact(root, {
        runId: receipt.runKey.runId,
        artifactSha256: artifact.sha256,
        maximumBytes: artifact.bytes || 1
      }));
    }
    return admitApprovedRunnerArtifacts({ receipt, artifactBytes: bytes,
      candidateAttestationSha256 });
  } catch (error) {
    if (error?.code === 'REV_RUNNER_ARTIFACT_INVALID'
        || error?.code === 'REV_RUNNER_ARTIFACT_MEDIA_MISMATCH'
        || error?.code === 'REV_RUNNER_ARTIFACT_LIMIT') throw error;
    fail('REV_RUNNER_STORE_ARTIFACT_MISMATCH',
      'Stored artifact bytes are unavailable or no longer match the immutable browser receipt.');
  }
}

/**
 * Persist only after independently re-reading the immutable BRL receipt and every admitted byte.
 * The signed supplement cannot replace or rewrite the original evidence.
 */
export async function writeAuthenticatedRunnerEvidence(root, input) {
  const runId = input?.receipt?.runKey?.runId;
  const stored = await readRevisionBrowserRunReceipt(root, {
    runId, receiptSha256: input?.receipt?.receiptSha256
  });
  if (canonicalJson(stored) !== canonicalJson(input.receipt)) {
    fail('REV_RUNNER_STORE_RECEIPT_MISMATCH',
      'Authenticated evidence must supplement the exact immutable stored browser receipt.');
  }
  const independentlyAdmitted = await readAndAdmitStoredArtifacts(
    root, stored, input.admission?.candidateAttestationSha256
  );
  if (canonicalJson(independentlyAdmitted) !== canonicalJson(input.admission)) {
    fail('REV_RUNNER_STORE_ARTIFACT_MISMATCH',
      'Stored artifact bytes do not reproduce the supplied secure admission record.');
  }
  const verified = verifyAuthenticatedRunnerEvidence({ ...input, receipt: stored });
  const writes = await Promise.all([
    immutableJson(root, evidencePath(root, runId, 'attestation.json'),
      storedEvidenceRecord('attestation.json', input.signedAttestation)),
    immutableJson(root, evidencePath(root, runId, 'admission.json'),
      storedEvidenceRecord('admission.json', verified.admission)),
    immutableJson(root, evidencePath(root, runId, 'authenticated-receipt.json'),
      storedEvidenceRecord('authenticated-receipt.json', input.signedAuthenticatedReceipt))
  ]);
  return Object.freeze({
    runId,
    browserReceiptSha256: stored.receiptSha256,
    candidateAttestationSha256: verified.attestation.attestationSha256,
    artifactAdmissionSha256: verified.admission.admissionSha256,
    authenticatedReceiptSha256: verified.authenticatedReceipt.authenticatedReceiptSha256,
    created: writes.some((item) => item.created),
    authenticationStatus: 'verified',
    lifecycleAdmissionStatus: 'not-established',
    testingVerificationEstablished: false,
    publicationEligibilityEstablished: false
  });
}

export async function readAuthenticatedRunnerEvidence(root, {
  runId, receiptSha256, trustedPublicKeyPem, expectedKeyId,
  expectedAuthorityReceiptSha256, expectedAuthorityPolicySha256
} = {}) {
  const receipt = await readRevisionBrowserRunReceipt(root, { runId, receiptSha256 });
  const readJson = async (name) => {
    const bytes = await readPrivateSidecar(root, evidencePath(root, runId, name), {
      maximumBytes: MAX_RECORD_BYTES, enforceWindowsAcl: true
    });
    return readStoredEvidenceRecord(name, bytes);
  };
  const [signedAttestation, admission, signedAuthenticatedReceipt] = await Promise.all([
    readJson('attestation.json'), readJson('admission.json'), readJson('authenticated-receipt.json')
  ]);
  const independentlyAdmitted = await readAndAdmitStoredArtifacts(
    root, receipt, admission.candidateAttestationSha256
  );
  if (canonicalJson(independentlyAdmitted) !== canonicalJson(admission)) {
    fail('REV_RUNNER_STORE_ARTIFACT_MISMATCH',
      'Stored artifact bytes do not reproduce the authenticated admission record.');
  }
  return verifyAuthenticatedRunnerEvidence({
    receipt, signedAttestation, admission, signedAuthenticatedReceipt,
    trustedPublicKeyPem, expectedKeyId, expectedAuthorityReceiptSha256,
    expectedAuthorityPolicySha256
  });
}
