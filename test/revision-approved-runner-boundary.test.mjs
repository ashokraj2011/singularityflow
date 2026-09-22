import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { writeImmutablePrivateSidecar } from '../src/private-sidecar.mjs';
import { canonicalJson, recordSha256 } from '../src/records.mjs';
import { schemaCensus } from '../src/schema-census.mjs';
import { familyForStoredPath } from '../src/schema-migrations.mjs';
import {
  APPROVED_RUNNER_PROVIDER,
  admitApprovedRunnerArtifacts,
  defineAuthenticatedRunnerReceipt,
  defineCandidateUnderTestAttestation,
  inspectApprovedRunnerReadiness,
  readAuthenticatedRunnerEvidence,
  validateApprovedIsolatedRunnerProvider,
  verifyAuthenticatedRunnerEvidence,
  verifyCandidateUnderTestAttestation,
  writeAuthenticatedRunnerEvidence
} from '../src/revision/approved-runner-boundary.mjs';
import { clonePlatformJson, platformSha256 } from '../src/sgos/platform/contracts.mjs';

const H = (value) => `sha256:${recordSha256(value)}`;
const B = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const digest = (character) => `sha256:${character.repeat(64)}`;
const at = '2026-09-22T00:00:00.000Z';

function runKey() {
  const core = {
    schemaVersion: 1,
    kind: 'revision-browser-run-key',
    candidateId: 'CAN-approved-runner',
    candidateSha256: digest('a'),
    candidateRefSha256: digest('b'),
    candidateTree: 'c'.repeat(40),
    materializationSha256: digest('d'),
    workId: 'WRK-APPROVED',
    phaseId: 'implementation',
    phaseGeneration: 1,
    loopId: 'LOOP-APPROVED',
    intervalId: 'REV-APPROVED-1',
    runId: 'BRL-123456789abc',
    configSha256: digest('e'),
    workflowSha256: digest('f'),
    proofProfileSha256: digest('1'),
    testManifestSha256: H([{ id: 'smoke', bodySha256: digest('2') }]),
    checkId: 'browser-smoke',
    checkDefinitionSha256: digest('3'),
    argvSha256: digest('4'),
    timeoutMs: 60_000,
    environmentName: 'approved-linux',
    environmentSha256: digest('5'),
    baselineManifestSha256: null,
    adapterSha256: digest('6')
  };
  return { ...core, runKeySha256: H(core) };
}

function browserReceipt({ artifact = null } = {}) {
  const selectedRunKey = runKey();
  const artifacts = artifact ? [{
    path: 'test-results/result.json',
    kind: 'structured-result',
    mediaType: 'application/json',
    sha256: B(artifact),
    bytes: artifact.length,
    captureProvenanceSha256: null,
    accessClass: 'private',
    retentionClass: 'proof',
    previewable: false
  }] : [];
  const core = {
    schemaVersion: 1,
    kind: 'revision-browser-run-receipt',
    runKey: selectedRunKey,
    attemptId: 'REVBR-12345678-1234-1234-1234-123456789abc',
    candidateUnderTestAttestation: null,
    startedAt: at,
    endedAt: '2026-09-22T00:00:01.000Z',
    durationMs: 1000,
    status: 'passed',
    reasonCode: null,
    exitCode: 0,
    tests: { discovered: 1, passed: 1, failed: 0, skipped: 0, flaky: 0 },
    testCases: [{
      id: 'smoke', titleSha256: digest('7'), bodySha256: digest('2'),
      status: 'passed', attempts: 1
    }],
    logSha256: null,
    artifacts,
    visualComparisons: [],
    bridgeReceiptSha256: digest('8'),
    executionAssurance: 'bounded-effects-only',
    assertionWitnessStatus: 'not-established',
    testingVerificationStatus: 'not-established-by-browser-run',
    publicationEligibilityEstablished: false
  };
  return { ...core, receiptSha256: H(core) };
}

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' })
  };
}

function signRunnerRecord(record, { privateKeyPem, keyId }) {
  const publicDer = createPublicKey(privateKeyPem).export({ type: 'spki', format: 'der' });
  const payload = canonicalJson(clonePlatformJson(record));
  return {
    record,
    signature: {
      algorithm: 'ed25519', keyId,
      keySha256: platformSha256(publicDer),
      payloadSha256: platformSha256(payload),
      value: signBytes(null, Buffer.from(payload), privateKeyPem).toString('base64')
    }
  };
}

function attestationFor(receipt) {
  const keyId = 'approved-runner-key';
  return defineCandidateUnderTestAttestation({
    runKey: {
      runId: receipt.runKey.runId,
      runKeySha256: receipt.runKey.runKeySha256,
      candidateId: receipt.runKey.candidateId,
      candidateSha256: receipt.runKey.candidateSha256,
      candidateRefSha256: receipt.runKey.candidateRefSha256,
      candidateTree: receipt.runKey.candidateTree,
      materializationSha256: receipt.runKey.materializationSha256,
      environmentSha256: receipt.runKey.environmentSha256
    },
    providerKeyId: keyId,
    observedAt: at,
    completedAt: '2026-09-22T00:00:01.000Z',
    nonceSha256: digest('9')
  });
}

test('approved runner provider ABI and readiness remain fixed and fail closed', () => {
  const provider = {
    descriptor: { ...APPROVED_RUNNER_PROVIDER },
    async executeSealedRevisionRun(_request) { return null; }
  };
  assert.deepEqual(validateApprovedIsolatedRunnerProvider(provider), APPROVED_RUNNER_PROVIDER);
  assert.throws(() => validateApprovedIsolatedRunnerProvider({
    ...provider,
    descriptor: { ...provider.descriptor, protocol: 'caller-selected-v2' }
  }), (error) => error.code === 'REV_RUNNER_PROVIDER_UNREGISTERED');

  const absent = inspectApprovedRunnerReadiness();
  assert.equal(absent.contractBoundaryAvailable, true);
  assert.equal(absent.executionEnabled, false);
  assert.equal(absent.publicationEligibilityEstablished, false);
  assert.ok(absent.checks.every((entry) => entry.status === 'unavailable'));

  const supplied = inspectApprovedRunnerReadiness({
    provider,
    trustedPublicKeyPem: 'not-verified-by-this-diagnostic',
    authorityReceiptSha256: digest('a'),
    authorityPolicySha256: digest('b')
  });
  assert.equal(supplied.executionEnabled, false);
  assert.ok(supplied.checks.slice(1).every((entry) =>
    entry.reasonCode === 'REV_RUNNER_AUTHORITY_REVALIDATION_REQUIRED'));
});

test('candidate-under-test attestation is signature, provider, isolation, and run-key bound', () => {
  const receipt = browserReceipt();
  const attestation = attestationFor(receipt);
  const key = keys();
  const signed = signRunnerRecord(attestation, {
    privateKeyPem: key.privateKeyPem, keyId: attestation.providerKeyId
  });
  assert.deepEqual(verifyCandidateUnderTestAttestation(signed, {
    trustedPublicKeyPem: key.publicKeyPem,
    expectedKeyId: attestation.providerKeyId,
    expectedRunKey: receipt.runKey
  }), attestation);

  const tamperedSignature = structuredClone(signed);
  tamperedSignature.signature.value = `${tamperedSignature.signature.value.slice(0, -4)}AAAA`;
  assert.throws(() => verifyCandidateUnderTestAttestation(tamperedSignature, {
    trustedPublicKeyPem: key.publicKeyPem,
    expectedKeyId: attestation.providerKeyId,
    expectedRunKey: receipt.runKey
  }), (error) => error.code === 'REV_RUNNER_SIGNATURE_INVALID');

  const stale = structuredClone(receipt.runKey);
  stale.materializationSha256 = digest('0');
  assert.throws(() => verifyCandidateUnderTestAttestation(signed, {
    trustedPublicKeyPem: key.publicKeyPem,
    expectedKeyId: attestation.providerKeyId,
    expectedRunKey: stale
  }), (error) => error.code === 'REV_RUNNER_ATTESTATION_STALE');
  assert.throws(() => defineCandidateUnderTestAttestation({
    ...{
      runKey: attestation.run, providerKeyId: attestation.providerKeyId,
      observedAt: at, completedAt: at, nonceSha256: digest('9')
    },
    networkIsolation: 'allow-listed'
  }), (error) => error.code === 'REV_RUNNER_ISOLATION_UNSATISFIED');
});

test('artifact admission identifies bytes independently and never grants rendering', () => {
  const artifact = Buffer.from('{"ok":true}\n');
  const receipt = browserReceipt({ artifact });
  const attestation = attestationFor(receipt);
  const admission = admitApprovedRunnerArtifacts({
    receipt,
    artifactBytes: new Map([[B(artifact), artifact]]),
    candidateAttestationSha256: attestation.attestationSha256
  });
  assert.equal(admission.artifactCount, 1);
  assert.equal(admission.artifacts[0].receiptIndex, 0);
  assert.equal(admission.artifacts[0].path, receipt.artifacts[0].path);
  assert.equal(admission.artifacts[0].detectedMediaType, 'application/json');
  assert.equal(admission.artifacts[0].activeContentPermitted, false);
  assert.equal(admission.renderingAuthorized, false);

  const disguised = Buffer.from('<html>not json</html>');
  const forgedReceipt = browserReceipt({ artifact: disguised });
  assert.throws(() => admitApprovedRunnerArtifacts({
    receipt: forgedReceipt,
    artifactBytes: new Map([[B(disguised), disguised]]),
    candidateAttestationSha256: attestation.attestationSha256
  }), (error) => error.code === 'REV_RUNNER_ARTIFACT_MEDIA_MISMATCH');

  const oversized = structuredClone(receipt);
  oversized.artifacts[0].bytes = 8 * 1024 * 1024 + 1;
  delete oversized.receiptSha256;
  oversized.receiptSha256 = H(oversized);
  assert.throws(() => admitApprovedRunnerArtifacts({
    receipt: oversized,
    artifactBytes: new Map([[oversized.artifacts[0].sha256, artifact]]),
    candidateAttestationSha256: attestation.attestationSha256
  }), (error) => error.code === 'REV_BROWSER_RECEIPT_INVALID');
});

test('artifact admission preserves every receipt entry while deduplicating identical bytes', () => {
  const artifact = Buffer.from('{"same":true}\n');
  const receipt = browserReceipt({ artifact });
  receipt.artifacts.push({
    ...receipt.artifacts[0],
    path: 'test-results/copied-result.json'
  });
  delete receipt.receiptSha256;
  receipt.receiptSha256 = H(receipt);
  const attestation = attestationFor(receipt);
  const admission = admitApprovedRunnerArtifacts({
    receipt,
    artifactBytes: new Map([[B(artifact), artifact]]),
    candidateAttestationSha256: attestation.attestationSha256
  });

  assert.equal(admission.artifactCount, 2);
  assert.deepEqual(admission.artifacts.map(({ receiptIndex, path, artifactSha256 }) => ({
    receiptIndex, path, artifactSha256
  })), [
    { receiptIndex: 0, path: 'test-results/result.json', artifactSha256: B(artifact) },
    { receiptIndex: 1, path: 'test-results/copied-result.json', artifactSha256: B(artifact) }
  ]);
});

test('authenticated receipt rejects a resealed admission that substitutes one artifact for another', () => {
  const first = Buffer.from('{"first":true}\n');
  const second = Buffer.from('{"second":true}\n');
  const receipt = browserReceipt({ artifact: first });
  receipt.artifacts.push({
    ...receipt.artifacts[0],
    path: 'test-results/second.json',
    sha256: B(second),
    bytes: second.length
  });
  delete receipt.receiptSha256;
  receipt.receiptSha256 = H(receipt);
  const attestation = attestationFor(receipt);
  const admission = admitApprovedRunnerArtifacts({
    receipt,
    artifactBytes: new Map([[B(first), first], [B(second), second]]),
    candidateAttestationSha256: attestation.attestationSha256
  });
  const substituted = structuredClone(admission);
  substituted.artifacts[1] = {
    ...substituted.artifacts[0],
    receiptIndex: 1
  };
  delete substituted.admissionSha256;
  substituted.admissionSha256 = H(substituted);

  assert.throws(() => defineAuthenticatedRunnerReceipt({
    receipt, attestation, admission: substituted,
    providerKeyId: attestation.providerKeyId,
    authorityReceiptSha256: digest('a'), authorityPolicySha256: digest('b'), issuedAt: at
  }), (error) => error.code === 'REV_RUNNER_ARTIFACT_INVALID');
});

test('direct authenticated receipt verification enforces the artifact kind and media matrix', () => {
  const artifact = Buffer.from('{"video":false}\n');
  const receipt = browserReceipt({ artifact });
  receipt.artifacts[0].kind = 'playwright-video';
  delete receipt.receiptSha256;
  receipt.receiptSha256 = H(receipt);
  const attestation = attestationFor(receipt);
  const forged = {
    ...admitApprovedRunnerArtifacts({
      receipt: browserReceipt({ artifact }),
      artifactBytes: new Map([[B(artifact), artifact]]),
      candidateAttestationSha256: attestation.attestationSha256
    }),
    runId: receipt.runKey.runId,
    runKeySha256: receipt.runKey.runKeySha256,
    receiptSha256: receipt.receiptSha256
  };
  forged.artifacts = forged.artifacts.map((item) => ({
    ...item, kind: 'playwright-video', receiptSha256: receipt.receiptSha256
  }));
  delete forged.admissionSha256;
  forged.admissionSha256 = H(forged);

  assert.throws(() => defineAuthenticatedRunnerReceipt({
    receipt, attestation, admission: forged,
    providerKeyId: attestation.providerKeyId,
    authorityReceiptSha256: digest('a'), authorityPolicySha256: digest('b'), issuedAt: at
  }), (error) => error.code === 'REV_RUNNER_ARTIFACT_INVALID');
});

test('provider-signed receipt authenticates joins but cannot claim lifecycle or publication authority', () => {
  const receipt = browserReceipt();
  const attestation = attestationFor(receipt);
  const admission = admitApprovedRunnerArtifacts({
    receipt, artifactBytes: new Map(),
    candidateAttestationSha256: attestation.attestationSha256
  });
  const authorityReceiptSha256 = digest('a');
  const authorityPolicySha256 = digest('b');
  const authenticated = defineAuthenticatedRunnerReceipt({
    receipt, attestation, admission,
    providerKeyId: attestation.providerKeyId,
    authorityReceiptSha256, authorityPolicySha256, issuedAt: at
  });
  const key = keys();
  const signedAttestation = signRunnerRecord(attestation, {
    privateKeyPem: key.privateKeyPem, keyId: attestation.providerKeyId
  });
  const signedAuthenticatedReceipt = signRunnerRecord(authenticated, {
    privateKeyPem: key.privateKeyPem, keyId: attestation.providerKeyId
  });
  const verified = verifyAuthenticatedRunnerEvidence({
    receipt, signedAttestation, admission, signedAuthenticatedReceipt,
    trustedPublicKeyPem: key.publicKeyPem,
    expectedKeyId: attestation.providerKeyId,
    expectedAuthorityReceiptSha256: authorityReceiptSha256,
    expectedAuthorityPolicySha256: authorityPolicySha256
  });
  assert.equal(verified.authenticationStatus, 'verified');
  assert.equal(verified.lifecycleAdmissionStatus, 'not-established');
  assert.equal(verified.testingVerificationEstablished, false);
  assert.equal(verified.publicationEligibilityEstablished, false);

  const replayedReceipt = structuredClone(receipt);
  replayedReceipt.runKey.runId = 'BRL-fedcba987654';
  delete replayedReceipt.runKey.runKeySha256;
  replayedReceipt.runKey.runKeySha256 = H(replayedReceipt.runKey);
  delete replayedReceipt.receiptSha256;
  replayedReceipt.receiptSha256 = H(replayedReceipt);
  assert.throws(() => verifyAuthenticatedRunnerEvidence({
    receipt: replayedReceipt, signedAttestation, admission, signedAuthenticatedReceipt,
    trustedPublicKeyPem: key.publicKeyPem,
    expectedKeyId: attestation.providerKeyId,
    expectedAuthorityReceiptSha256: authorityReceiptSha256,
    expectedAuthorityPolicySha256: authorityPolicySha256
  }), (error) => error.code === 'REV_RUNNER_ATTESTATION_STALE');

  assert.throws(() => verifyAuthenticatedRunnerEvidence({
    receipt, signedAttestation, admission, signedAuthenticatedReceipt,
    trustedPublicKeyPem: key.publicKeyPem,
    expectedKeyId: attestation.providerKeyId,
    expectedAuthorityReceiptSha256: digest('f'),
    expectedAuthorityPolicySha256: authorityPolicySha256
  }), (error) => error.code === 'REV_RUNNER_AUTHORITY_STALE');
});

test('authenticated supplement is immutable, durable, and revalidated on read', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-approved-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root });
  const artifact = Buffer.from('{"durable":true}\n');
  const receipt = browserReceipt({ artifact });
  const receiptPath = path.join(root, '.git', 'singularity-flow', 'revision-browser-runs',
    receipt.runKey.runId, 'receipt.json');
  const artifactPath = path.join(root, '.git', 'singularity-flow', 'revision-browser-runs',
    receipt.runKey.runId, 'artifacts', B(artifact).slice('sha256:'.length));
  await writeImmutablePrivateSidecar(root, receiptPath, Buffer.from(canonicalJson(receipt)), {
    maximumBytes: 256 * 1024, enforceWindowsAcl: true
  });
  await writeImmutablePrivateSidecar(root, artifactPath, artifact, {
    maximumBytes: 8 * 1024 * 1024, enforceWindowsAcl: true
  });
  const attestation = attestationFor(receipt);
  const admission = admitApprovedRunnerArtifacts({
    receipt, artifactBytes: new Map([[B(artifact), artifact]]),
    candidateAttestationSha256: attestation.attestationSha256
  });
  const authorityReceiptSha256 = digest('a');
  const authorityPolicySha256 = digest('b');
  const authenticated = defineAuthenticatedRunnerReceipt({
    receipt, attestation, admission,
    providerKeyId: attestation.providerKeyId,
    authorityReceiptSha256, authorityPolicySha256, issuedAt: at
  });
  const key = keys();
  const input = {
    receipt,
    signedAttestation: signRunnerRecord(attestation, {
      privateKeyPem: key.privateKeyPem, keyId: attestation.providerKeyId
    }),
    admission,
    signedAuthenticatedReceipt: signRunnerRecord(authenticated, {
      privateKeyPem: key.privateKeyPem, keyId: attestation.providerKeyId
    }),
    trustedPublicKeyPem: key.publicKeyPem,
    expectedKeyId: attestation.providerKeyId,
    expectedAuthorityReceiptSha256: authorityReceiptSha256,
    expectedAuthorityPolicySha256: authorityPolicySha256
  };
  const first = await writeAuthenticatedRunnerEvidence(root, input);
  assert.equal(first.created, true);
  const storedRoot = path.join(root, '.git', 'singularity-flow', 'revision-browser-runs',
    receipt.runKey.runId, 'authenticated');
  const storedRecords = [
    ['attestation.json', 'revision-candidate-under-test-attestation-envelope'],
    ['admission.json', 'revision-runner-artifact-admission'],
    ['authenticated-receipt.json', 'revision-authenticated-runner-receipt-envelope']
  ];
  for (const [name, family] of storedRecords) {
    const stored = JSON.parse(await readFile(path.join(storedRoot, name), 'utf8'));
    assert.equal(stored.schemaVersion, 1, name);
    assert.equal(stored.kind, family, name);
    assert.equal(familyForStoredPath(
      `$git/revision-browser-runs/${receipt.runKey.runId}/authenticated/${name}`
    )?.id, family, name);
  }
  const census = await schemaCensus(root);
  assert.equal(census.totals.unreadable, 0);
  assert.equal(census.totals.outsideRange, 0);
  for (const [, family] of storedRecords) {
    assert.equal(census.families.find((entry) => entry.family === family)?.records, 1, family);
  }
  const second = await writeAuthenticatedRunnerEvidence(root, input);
  assert.equal(second.created, false);
  const read = await readAuthenticatedRunnerEvidence(root, {
    runId: receipt.runKey.runId,
    receiptSha256: receipt.receiptSha256,
    trustedPublicKeyPem: key.publicKeyPem,
    expectedKeyId: attestation.providerKeyId,
    expectedAuthorityReceiptSha256: authorityReceiptSha256,
    expectedAuthorityPolicySha256: authorityPolicySha256
  });
  assert.equal(read.authenticatedReceipt.authenticatedReceiptSha256,
    authenticated.authenticatedReceiptSha256);
  assert.equal(read.publicationEligibilityEstablished, false);

  await writeFile(artifactPath, Buffer.from('{"tampered":true}\n'));
  await assert.rejects(readAuthenticatedRunnerEvidence(root, {
    runId: receipt.runKey.runId,
    receiptSha256: receipt.receiptSha256,
    trustedPublicKeyPem: key.publicKeyPem,
    expectedKeyId: attestation.providerKeyId,
    expectedAuthorityReceiptSha256: authorityReceiptSha256,
    expectedAuthorityPolicySha256: authorityPolicySha256
  }), (error) => error.code === 'REV_RUNNER_STORE_ARTIFACT_MISMATCH');

  await writeFile(artifactPath, artifact);
  await rm(artifactPath);
  await assert.rejects(readAuthenticatedRunnerEvidence(root, {
    runId: receipt.runKey.runId,
    receiptSha256: receipt.receiptSha256,
    trustedPublicKeyPem: key.publicKeyPem,
    expectedKeyId: attestation.providerKeyId,
    expectedAuthorityReceiptSha256: authorityReceiptSha256,
    expectedAuthorityPolicySha256: authorityPolicySha256
  }), (error) => error.code === 'REV_RUNNER_STORE_ARTIFACT_MISMATCH');
});
