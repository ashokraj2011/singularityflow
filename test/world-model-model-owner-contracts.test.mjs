import assert from 'node:assert/strict';
import test from 'node:test';

import { schemaFamily } from '../src/schema-migrations.mjs';
import { canonicalJson, sealRecord, sha256 } from '../src/world-model/canonicalize.mjs';
import {
  createWorldModelCompletenessRecord, createWorldModelExtractionPolicy,
  createWorldModelRepositoryDomain, validateWorldModelRepositoryDomain
} from '../src/world-model/history/model-owners.mjs';
import { parseExactRetainedObject } from '../src/world-model/history/retained-object.mjs';
import { BUILTIN_EXTRACTOR_REGISTRY } from '../src/world-model/registry/extractors.mjs';

const digest = (label) => sha256({ fixture: label });

function extractor(manifest, coverage) {
  return {
    id: manifest.id,
    version: manifest.version,
    implementationSha256: manifest.producer.implementationSha256,
    manifestSha256: manifest.manifestSha256,
    coverage
  };
}

function retained(record, role, family) {
  const bytes = Buffer.from(canonicalJson(record), 'utf8');
  return {
    ref: { role, family, mediaType: 'application/json', sha256: sha256(bytes), bytes: bytes.length },
    bytes
  };
}

function ownerFixtures() {
  const [pathManifest, globalManifest] = BUILTIN_EXTRACTOR_REGISTRY.manifests;
  const pathExtractor = extractor(pathManifest, 'path');
  const globalExtractor = extractor(globalManifest, 'global');
  const repositoryDomain = createWorldModelRepositoryDomain({
    repositoryId: 'payments-api',
    repositoryIdentitySha256: digest('repository-identity')
  });
  const extractionPolicy = createWorldModelExtractionPolicy({
    policySnapshotSha256: digest('policy'),
    allowedExtractors: [pathExtractor, globalExtractor],
    factSemantics: {
      allowedFactTypes: ['dependency-edge', 'file-exists'],
      requiredFactTypes: ['file-exists'],
      optionalFactTypes: ['dependency-edge'],
      requiredUnavailableSubjects: [],
      coverageExtractorRefs: [`${pathExtractor.id}@${pathExtractor.version}`]
    }
  });
  const completeness = createWorldModelCompletenessRecord({
    sourceManifestSha256: digest('source'),
    scopeManifestSha256: digest('scope'),
    extractorRegistrySha256: BUILTIN_EXTRACTOR_REGISTRY.registrySha256,
    extractorReferences: [pathExtractor, globalExtractor],
    pathOutcomes: [
      {
        path: 'src/App.java', sourceContentSha256: digest('app'), status: 'partial',
        reasonCode: 'PARTIAL_PARSE',
        extractors: [{
          id: pathExtractor.id, version: pathExtractor.version,
          implementationSha256: pathExtractor.implementationSha256,
          status: 'partial', reasonCode: 'PARTIAL_PARSE'
        }]
      },
      {
        path: 'generated/output.js', sourceContentSha256: null, status: 'excluded',
        reasonCode: 'OUTSIDE_SCOPE', extractors: []
      }
    ],
    globalOutcomes: [{
      id: globalExtractor.id, version: globalExtractor.version,
      implementationSha256: globalExtractor.implementationSha256,
      status: 'processed', reasonCode: null
    }]
  });
  return { repositoryDomain, extractionPolicy, completeness };
}

test('model owner families are frozen immutable v1 identities', () => {
  for (const familyId of [
    'world-model-repository-domain', 'world-model-extraction-policy',
    'world-model-extractor-registry', 'world-model-completeness-record',
    'world-model-source-snapshot', 'world-model-scope-manifest',
    'world-model-view-contract', 'world-model-extractor-manifest',
    'world-model-evidence-catalog', 'world-model-derivation-catalog',
    'world-model-fact-ledger', 'world-model-view-fact-ledger',
    'world-model-consumer-profile', 'world-model-output-budget',
    'world-model-view-validation-receipt'
  ]) {
    const family = schemaFamily(familyId);
    assert.equal(family.currentVersion, 1, familyId);
    assert.equal(family.immutable, true, familyId);
    assert.equal(family.migrationPolicy, 'frozen-identity', familyId);
  }
});

test('model owner constructors are deterministic and their exact retained bytes are readable', () => {
  const first = ownerFixtures();
  const second = ownerFixtures();
  assert.deepEqual(first, second);
  const cases = [
    ['repository-domain', 'world-model-repository-domain', first.repositoryDomain],
    ['extraction-policy', 'world-model-extraction-policy', first.extractionPolicy],
    ['completeness-record', 'world-model-completeness-record', first.completeness]
  ];
  for (const [role, family, record] of cases) {
    const object = retained(record, role, family);
    assert.deepEqual(parseExactRetainedObject(object.ref, object.bytes), record, role);
  }
  assert.deepEqual(first.completeness.counts, {
    totalPaths: 1,
    processedPaths: 1,
    unsupportedPaths: 0,
    failedPaths: 0,
    excludedPaths: 1
  });
});

test('repository domain refuses machine-local paths and remote URLs', () => {
  const base = ownerFixtures().repositoryDomain;
  for (const repositoryId of ['/tmp/repo', 'C:\\repo', 'https://example.invalid/repo.git']) {
    assert.throws(
      () => createWorldModelRepositoryDomain({
        repositoryId,
        repositoryIdentitySha256: base.repositoryIdentitySha256
      }),
      (error) => ['WMB_CONTRACT_FORMAT_INVALID', 'WMP_REPOSITORY_DOMAIN_NOT_PORTABLE']
        .includes(error?.code),
      repositoryId
    );
  }
  assert.throws(
    () => validateWorldModelRepositoryDomain(sealRecord({
      schemaVersion: base.schemaVersion,
      kind: base.kind,
      repositoryId: base.repositoryId,
      repositoryIdentitySha256: base.repositoryIdentitySha256,
      identityAuthority: {
        kind: 'capability-resolution', recordSha256: digest('unproved-authority')
      }
    }, 'repositoryDomainSha256')),
    (error) => error instanceof TypeError
      && /unknown field 'identityAuthority'/.test(error.message)
  );
});

test('extraction policy cannot authorize model or network effects', () => {
  const policy = ownerFixtures().extractionPolicy;
  const mutated = structuredClone(policy);
  mutated.permissions.model = 'allowed';
  delete mutated.extractionPolicySha256;
  assert.throws(
    () => createWorldModelExtractionPolicy(mutated),
    (error) => error?.code === 'WMP_EXTRACTION_POLICY_EFFECT_FORBIDDEN'
  );
});

test('completeness rejects aggregate status or extractor identities not proved by outcomes', () => {
  const record = structuredClone(ownerFixtures().completeness);
  record.pathOutcomes[0].status = 'processed';
  record.pathOutcomes[0].reasonCode = null;
  const resealed = sealRecord(record, 'completenessSha256');
  const object = retained(resealed, 'completeness-record', 'world-model-completeness-record');
  assert.throws(
    () => parseExactRetainedObject(object.ref, object.bytes),
    (error) => error?.code === 'WMP_INTEGRITY_FAILED'
      && error?.details?.role === 'completeness-record'
      && error?.details?.family === 'world-model-completeness-record'
  );
});
