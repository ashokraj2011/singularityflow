import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { recordSha256 } from '../src/records.mjs';
import {
  admitApprovedRunnerArtifacts,
  defineAuthenticatedRunnerReceipt,
  defineCandidateUnderTestAttestation
} from '../src/revision/approved-runner-boundary.mjs';
import {
  familyForStoredPath, migrationRegistrySnapshot
} from '../src/schema-migrations.mjs';

const FAMILIES = Object.freeze({
  'revision-candidate-under-test-attestation': [
    'schemaVersion', 'kind', 'providerId', 'providerProtocol', 'providerKeyId', 'run',
    'observedAt', 'completedAt', 'nonceSha256', 'isolation', 'cleanupStatus',
    'testingAuthorityEstablished', 'publicationEligibilityEstablished', 'attestationSha256'
  ],
  'revision-candidate-under-test-attestation-envelope': [
    'schemaVersion', 'kind', 'record', 'signature'
  ],
  'revision-runner-artifact-admission': [
    'schemaVersion', 'kind', 'runId', 'runKeySha256', 'receiptSha256',
    'candidateAttestationSha256', 'artifacts', 'artifactCount', 'totalBytes',
    'renderingAuthorized', 'extractionAuthorized', 'admissionSha256'
  ],
  'revision-authenticated-runner-receipt': [
    'schemaVersion', 'kind', 'providerId', 'providerProtocol', 'providerKeyId', 'authority',
    'runId', 'runKeySha256', 'browserReceiptSha256', 'candidateAttestationSha256',
    'artifactAdmissionSha256', 'issuedAt', 'executionAssurance',
    'testingVerificationStatus', 'publicationEligibilityEstablished',
    'authenticatedReceiptSha256'
  ],
  'revision-authenticated-runner-receipt-envelope': [
    'schemaVersion', 'kind', 'record', 'signature'
  ]
});

const STORED_PATHS = Object.freeze({
  'revision-candidate-under-test-attestation-envelope':
    '$git/revision-browser-runs/BRL-123456789abc/authenticated/attestation.json',
  'revision-runner-artifact-admission':
    '$git/revision-browser-runs/BRL-123456789abc/authenticated/admission.json',
  'revision-authenticated-runner-receipt-envelope':
    '$git/revision-browser-runs/BRL-123456789abc/authenticated/authenticated-receipt.json'
});

const digest = (character) => `sha256:${character.repeat(64)}`;
const sha = (value) => `sha256:${recordSha256(value)}`;
const bytesSha = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const at = '2026-09-22T00:00:00.000Z';

async function loadSchemas() {
  const names = [...Object.keys(FAMILIES), 'revision-contract-definitions'];
  return new Map(await Promise.all(names.map(async (name) => [name,
    JSON.parse(await readFile(new URL(`../schemas/${name}.schema.json`, import.meta.url), 'utf8'))
  ])));
}

function pointer(document, fragment) {
  if (!fragment || fragment === '#') return document;
  let value = document;
  for (const encoded of fragment.replace(/^#\//u, '').split('/')) {
    const key = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    value = value?.[key];
  }
  return value;
}

// Deliberately small draft-2020-12 evaluator for the vocabulary used by these three contracts.
// It makes the test fixtures prove the schema constraints instead of merely snapshotting JSON.
function schemaErrors(schemas, family, value) {
  const visit = (schema, candidate, location, documentName) => {
    if (schema.$ref) {
      const [file = '', fragment = ''] = schema.$ref.split('#');
      const targetName = file
        ? file.replace(/\.schema\.json$/u, '')
        : documentName;
      const target = pointer(schemas.get(targetName), fragment ? `#${fragment}` : '#');
      return target ? visit(target, candidate, location, targetName)
        : [`${location}: unresolved reference ${schema.$ref}`];
    }
    const errors = [];
    if (Object.hasOwn(schema, 'const') && !Object.is(candidate, schema.const)) {
      errors.push(`${location}: const`);
    }
    if (schema.enum && !schema.enum.some((entry) => Object.is(entry, candidate))) {
      errors.push(`${location}: enum`);
    }
    const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
    const matchesType = (type) => ({
      null: candidate === null,
      object: candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate),
      array: Array.isArray(candidate),
      string: typeof candidate === 'string',
      integer: Number.isSafeInteger(candidate),
      number: typeof candidate === 'number' && Number.isFinite(candidate),
      boolean: typeof candidate === 'boolean'
    })[type] === true;
    if (types.length && !types.some(matchesType)) {
      errors.push(`${location}: type`);
      return errors;
    }
    if (typeof candidate === 'string') {
      if (schema.pattern && !new RegExp(schema.pattern, 'u').test(candidate)) {
        errors.push(`${location}: pattern`);
      }
      if (schema.minLength != null && [...candidate].length < schema.minLength) {
        errors.push(`${location}: minLength`);
      }
      if (schema.maxLength != null && [...candidate].length > schema.maxLength) {
        errors.push(`${location}: maxLength`);
      }
      if (schema.format === 'date-time'
          && (Number.isNaN(Date.parse(candidate)) || new Date(candidate).toISOString() !== candidate)) {
        errors.push(`${location}: date-time`);
      }
    }
    if (typeof candidate === 'number') {
      if (schema.minimum != null && candidate < schema.minimum) errors.push(`${location}: minimum`);
      if (schema.maximum != null && candidate > schema.maximum) errors.push(`${location}: maximum`);
    }
    if (Array.isArray(candidate)) {
      if (schema.minItems != null && candidate.length < schema.minItems) errors.push(`${location}: minItems`);
      if (schema.maxItems != null && candidate.length > schema.maxItems) errors.push(`${location}: maxItems`);
      if (schema.uniqueItems) {
        const identities = candidate.map((entry) => JSON.stringify(entry));
        if (new Set(identities).size !== identities.length) errors.push(`${location}: uniqueItems`);
      }
      if (schema.items) candidate.forEach((entry, index) => {
        errors.push(...visit(schema.items, entry, `${location}[${index}]`, documentName));
      });
    }
    if (candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const declared = new Set(Object.keys(schema.properties ?? {}));
      for (const key of schema.required ?? []) {
        if (!Object.hasOwn(candidate, key)) errors.push(`${location}.${key}: required`);
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(candidate)) {
          if (!declared.has(key)) errors.push(`${location}.${key}: unknown`);
        }
      }
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        if (Object.hasOwn(candidate, key)) {
          errors.push(...visit(child, candidate[key], `${location}.${key}`, documentName));
        }
      }
    }
    return errors;
  };
  return visit(schemas.get(family), value, '$', family);
}

function browserReceipt(artifact) {
  const runCore = {
    schemaVersion: 1,
    kind: 'revision-browser-run-key',
    candidateId: 'CAN-contract-schema',
    candidateSha256: digest('a'),
    candidateRefSha256: digest('b'),
    candidateTree: 'c'.repeat(40),
    materializationSha256: digest('d'),
    workId: 'WRK-CONTRACT',
    phaseId: 'implementation',
    phaseGeneration: 1,
    loopId: 'LOOP-CONTRACT',
    intervalId: 'REV-CONTRACT-1',
    runId: 'BRL-123456789abc',
    configSha256: digest('e'),
    workflowSha256: digest('f'),
    proofProfileSha256: digest('1'),
    testManifestSha256: sha([{ id: 'browser-contract', bodySha256: digest('8') }]),
    checkId: 'browser-contract',
    checkDefinitionSha256: digest('3'),
    argvSha256: digest('4'),
    timeoutMs: 60_000,
    environmentName: 'approved-linux',
    environmentSha256: digest('5'),
    baselineManifestSha256: null,
    adapterSha256: digest('6')
  };
  const runKey = { ...runCore, runKeySha256: sha(runCore) };
  const core = {
    schemaVersion: 1,
    kind: 'revision-browser-run-receipt',
    runKey,
    startedAt: at,
    endedAt: '2026-09-22T00:00:01.000Z',
    durationMs: 1000,
    status: 'passed',
    reasonCode: null,
    exitCode: 0,
    tests: { discovered: 1, passed: 1, failed: 0, skipped: 0, flaky: 0 },
    testCases: [{
      id: 'browser-contract', titleSha256: digest('7'), bodySha256: digest('8'),
      status: 'passed', attempts: 1
    }],
    logSha256: null,
    artifacts: [{
      path: 'test-results/result.json', kind: 'structured-result',
      mediaType: 'application/json', sha256: bytesSha(artifact), bytes: artifact.length,
      captureProvenanceSha256: null, accessClass: 'private', retentionClass: 'proof',
      previewable: false
    }],
    visualComparisons: [],
    bridgeReceiptSha256: digest('9'),
    attemptId: 'REVBR-12345678-1234-1234-1234-123456789abc',
    candidateUnderTestAttestation: null,
    executionAssurance: 'bounded-effects-only',
    assertionWitnessStatus: 'not-established',
    testingVerificationStatus: 'not-established-by-browser-run',
    publicationEligibilityEstablished: false
  };
  return { ...core, receiptSha256: sha(core) };
}

function validRecords() {
  const artifact = Buffer.from('{"ok":true}\n');
  const receipt = browserReceipt(artifact);
  const attestation = defineCandidateUnderTestAttestation({
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
    providerKeyId: 'approved-runner-key',
    observedAt: at,
    completedAt: '2026-09-22T00:00:01.000Z',
    nonceSha256: digest('a')
  });
  const admission = admitApprovedRunnerArtifacts({
    receipt,
    artifactBytes: new Map([[bytesSha(artifact), artifact]]),
    candidateAttestationSha256: attestation.attestationSha256
  });
  const authenticated = defineAuthenticatedRunnerReceipt({
    receipt, attestation, admission,
    providerKeyId: attestation.providerKeyId,
    authorityReceiptSha256: digest('b'),
    authorityPolicySha256: digest('c'),
    issuedAt: '2026-09-22T00:00:02.000Z'
  });
  const signed = (record) => ({
    schemaVersion: 1,
    kind: record.kind === 'revision-candidate-under-test-attestation'
      ? 'revision-candidate-under-test-attestation-envelope'
      : 'revision-authenticated-runner-receipt-envelope',
    record,
    signature: {
      algorithm: 'ed25519', keyId: 'approved-runner-key',
      keySha256: digest('d'), payloadSha256: sha(record), value: `${'A'.repeat(86)}==`
    }
  });
  return {
    receipt, attestation, admission, authenticated,
    attestationEnvelope: signed(attestation), authenticatedEnvelope: signed(authenticated)
  };
}

function assertClosedObjects(schema, location) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false, `${location} must be closed`);
    assert.deepEqual(
      [...schema.required ?? []].sort(), Object.keys(schema.properties ?? {}).sort(),
      `${location} must require every declared property`
    );
  }
  for (const [key, child] of Object.entries(schema)) {
    if (key === 'properties' || key === '$defs') {
      for (const [name, value] of Object.entries(child ?? {})) {
        assertClosedObjects(value, `${location}.${key}.${name}`);
      }
    } else if (key === 'items') assertClosedObjects(child, `${location}.items`);
  }
}

test('approved-runner durable schemas freeze exact closed v1 identities and real stored paths remain discoverable', async () => {
  const schemas = await loadSchemas();
  const registry = new Map(migrationRegistrySnapshot().map((entry) => [entry.id, entry]));
  const goldens = JSON.parse(await readFile(
    new URL('./fixtures/schema-migrations/goldens.json', import.meta.url), 'utf8'
  ));
  for (const [family, fields] of Object.entries(FAMILIES)) {
    const schema = schemas.get(family);
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', family);
    assert.equal(schema.properties.schemaVersion.const, 1, family);
    assert.equal(schema.properties.kind.const, family, family);
    assert.deepEqual([...schema.required].sort(), [...fields].sort(), `${family}.required`);
    assert.deepEqual(Object.keys(schema.properties).sort(), [...fields].sort(),
      `${family}.properties`);
    assertClosedObjects(schema, family);
    assert.equal(registry.get(family)?.currentVersion, 1, family);
    assert.equal(registry.get(family)?.minimumReadableVersion, 1, family);
    assert.equal(registry.get(family)?.immutable, true, family);
    assert.equal(registry.get(family)?.migrationPolicy, 'frozen-identity', family);
    assert.deepEqual(goldens[family], [{ schemaVersion: 1 }], family);

    const stored = STORED_PATHS[family];
    if (stored) assert.equal(familyForStoredPath(stored)?.id, family, stored);
  }
  assert.equal(familyForStoredPath(
    `$git/revisions/WRK/implementation/1/records/revision-runner-artifact-admission/${'a'.repeat(64)}.json`
  ), null, 'the registry must not claim a path the approved-runner store never writes');
});

test('runtime-produced approved-runner records satisfy their published JSON schemas', async () => {
  const schemas = await loadSchemas();
  const {
    attestation, admission, authenticated, attestationEnvelope, authenticatedEnvelope
  } = validRecords();
  assert.deepEqual(schemaErrors(schemas,
    'revision-candidate-under-test-attestation', attestation), []);
  assert.deepEqual(schemaErrors(schemas,
    'revision-runner-artifact-admission', admission), []);
  assert.deepEqual(schemaErrors(schemas,
    'revision-authenticated-runner-receipt', authenticated), []);
  assert.deepEqual(schemaErrors(schemas,
    'revision-candidate-under-test-attestation-envelope', attestationEnvelope), []);
  assert.deepEqual(schemaErrors(schemas,
    'revision-authenticated-runner-receipt-envelope', authenticatedEnvelope), []);
});

test('approved-runner schemas reject unknown authority, malformed bindings, and unsafe artifacts', async () => {
  const schemas = await loadSchemas();
  const {
    attestation, admission, authenticated, attestationEnvelope, authenticatedEnvelope
  } = validRecords();
  const invalid = [
    ['revision-candidate-under-test-attestation',
      { ...attestation, injectedAuthority: true }, /unknown/u],
    ['revision-candidate-under-test-attestation',
      { ...attestation, run: { ...attestation.run, runId: 'BRL-NOT-HEX' } }, /pattern/u],
    ['revision-candidate-under-test-attestation',
      { ...attestation, run: { ...attestation.run, candidateSha256: 'sha256:bad' } }, /pattern/u],
    ['revision-candidate-under-test-attestation',
      { ...attestation, testingAuthorityEstablished: true }, /const/u],
    ['revision-runner-artifact-admission',
      { ...admission, artifacts: [{ ...admission.artifacts[0], bytes: 8_388_609 }] }, /maximum/u],
    ['revision-runner-artifact-admission',
      { ...admission, artifacts: [{ ...admission.artifacts[0], detectedMediaType: 'application/javascript' }] }, /enum/u],
    ['revision-runner-artifact-admission',
      { ...admission, artifacts: Array.from({ length: 257 }, (_, index) => ({
        ...admission.artifacts[0], artifactSha256: `sha256:${index.toString(16).padStart(64, '0')}`
      })) }, /maxItems/u],
    ['revision-authenticated-runner-receipt',
      { ...authenticated, authority: { ...authenticated.authority, receiptSha256: 'bad' } }, /pattern/u],
    ['revision-authenticated-runner-receipt',
      { ...authenticated, publicationEligibilityEstablished: true }, /const/u],
    ['revision-authenticated-runner-receipt',
      { ...authenticated, unsignedOverride: true }, /unknown/u],
    ['revision-candidate-under-test-attestation-envelope',
      { ...attestationEnvelope, unsignedOverride: true }, /unknown/u],
    ['revision-candidate-under-test-attestation-envelope',
      { ...attestationEnvelope, signature: { ...attestationEnvelope.signature, value: 'not-base64' } }, /pattern/u],
    ['revision-authenticated-runner-receipt-envelope',
      { ...authenticatedEnvelope, record: { ...authenticated, publicationEligibilityEstablished: true } }, /const/u]
  ];
  for (const [family, value, expected] of invalid) {
    const errors = schemaErrors(schemas, family, value);
    assert.ok(errors.length > 0, family);
    assert.match(errors.join('\n'), expected, family);
  }
});

test('runtime contract enforces the same candidate, count, size, and media ceilings', () => {
  const { receipt, attestation, admission } = validRecords();
  assert.throws(() => defineCandidateUnderTestAttestation({
    runKey: { ...attestation.run, candidateId: 'CAN-x' },
    providerKeyId: attestation.providerKeyId,
    observedAt: at, completedAt: at, nonceSha256: digest('d')
  }), (error) => error?.code === 'REV_RUNNER_ATTESTATION_INVALID');

  const unknownAdmission = { ...admission, callerAuthority: true };
  assert.throws(() => defineAuthenticatedRunnerReceipt({
    receipt, attestation, admission: unknownAdmission,
    providerKeyId: attestation.providerKeyId,
    authorityReceiptSha256: digest('e'), authorityPolicySha256: digest('f'), issuedAt: at
  }), (error) => error?.code === 'REV_RUNNER_CONTRACT_INVALID');

  const tooMany = structuredClone(receipt);
  tooMany.artifacts = Array.from({ length: 257 }, (_, index) => ({
    ...receipt.artifacts[0],
    path: `test-results/result-${index}.json`,
    sha256: `sha256:${index.toString(16).padStart(64, '0')}`,
    bytes: 0
  }));
  delete tooMany.receiptSha256;
  tooMany.receiptSha256 = sha(tooMany);
  assert.throws(() => admitApprovedRunnerArtifacts({
    receipt: tooMany,
    artifactBytes: new Map(),
    candidateAttestationSha256: attestation.attestationSha256
  }), (error) => error?.code === 'REV_BROWSER_RECEIPT_INVALID');

  const oversized = structuredClone(receipt);
  oversized.artifacts[0].bytes = 8_388_609;
  delete oversized.receiptSha256;
  oversized.receiptSha256 = sha(oversized);
  assert.throws(() => admitApprovedRunnerArtifacts({
    receipt: oversized,
    artifactBytes: new Map(),
    candidateAttestationSha256: attestation.attestationSha256
  }), (error) => error?.code === 'REV_BROWSER_RECEIPT_INVALID');

  const wrongMedia = Buffer.from('<html>not structured JSON</html>');
  const forgedReceipt = browserReceipt(wrongMedia);
  assert.throws(() => admitApprovedRunnerArtifacts({
    receipt: forgedReceipt,
    artifactBytes: new Map([[bytesSha(wrongMedia), wrongMedia]]),
    candidateAttestationSha256: attestation.attestationSha256
  }), (error) => error?.code === 'REV_RUNNER_ARTIFACT_MEDIA_MISMATCH');
});
