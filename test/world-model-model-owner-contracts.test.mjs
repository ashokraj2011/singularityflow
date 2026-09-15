import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { schemaFamily } from '../src/schema-migrations.mjs';
import { canonicalJson, sealRecord, sha256 } from '../src/world-model/canonicalize.mjs';
import {
  createWorldModelCompletenessRecord, createWorldModelExtractionPolicy,
  createWorldModelRepositoryDomain, validateWorldModelRepositoryDomain
} from '../src/world-model/history/model-owners.mjs';
import {
  createWorldModelDiscoveredCandidateRoster
} from '../src/world-model/history/candidate-roster-owner.mjs';
import { parseExactRetainedObject } from '../src/world-model/history/retained-object.mjs';
import { BUILTIN_EXTRACTOR_REGISTRY } from '../src/world-model/registry/extractors.mjs';

const digest = (label) => sha256({ fixture: label });
const candidateRosterSchema = JSON.parse(readFileSync(new URL(
  '../schemas/world-model-discovered-candidate-roster.schema.json', import.meta.url
), 'utf8'));

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

function gitObjectSha1(type, bytes) {
  return createHash('sha1')
    .update(Buffer.from(`${type} ${bytes.length}\0`, 'utf8'))
    .update(bytes)
    .digest('hex');
}

function singleFileDeepTreeSha1(depth, objectId) {
  let tree = gitObjectSha1('tree', Buffer.concat([
    Buffer.from('100644 file\0', 'utf8'), Buffer.from(objectId, 'hex')
  ]));
  for (let index = 0; index < depth; index += 1) {
    tree = gitObjectSha1('tree', Buffer.concat([
      Buffer.from('40000 a\0', 'utf8'), Buffer.from(tree, 'hex')
    ]));
  }
  return tree;
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
  const candidateRoster = createWorldModelDiscoveredCandidateRoster({
    source: {
      kind: 'committed-git-tree',
      commit: '1'.repeat(40),
      tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
      gitObjectFormat: 'sha1',
      pathNormalization: 'posix-relative',
      discoveryBoundary: 'recursive-tracked-blobs-before-scope'
    },
    sourceManifestSha256: digest('empty-source'),
    scopeManifestSha256: digest('empty-scope'),
    candidates: []
  });
  return { repositoryDomain, extractionPolicy, completeness, candidateRoster };
}

test('model owner families are frozen immutable v1 identities', () => {
  for (const familyId of [
    'world-model-repository-domain', 'world-model-extraction-policy',
    'world-model-discovered-candidate-roster',
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

test('candidate-roster schema freezes the pre-scope Git discovery boundary', () => {
  assert.equal(candidateRosterSchema.additionalProperties, false);
  assert.equal(candidateRosterSchema.properties.schemaVersion.const, 1);
  assert.equal(
    candidateRosterSchema.properties.kind.const,
    'world-model-discovered-candidate-roster'
  );
  assert.equal(
    candidateRosterSchema.$defs.source.properties.discoveryBoundary.const,
    'recursive-tracked-blobs-before-scope'
  );
  assert.equal(candidateRosterSchema.properties.candidates.maxItems, 50_000);
  assert.equal(candidateRosterSchema.$defs.candidate.additionalProperties, false);
  assert.deepEqual(
    candidateRosterSchema.$defs.candidate.required,
    ['path', 'type', 'mode', 'objectId', 'contentSha256', 'bytes', 'status', 'reasonCode']
  );
  assert.equal(
    candidateRosterSchema.$defs.candidate.allOf[0].then.properties.contentSha256.$ref,
    '#/$defs/hash'
  );
  assert.equal(
    candidateRosterSchema.$defs.candidate.allOf[0].else.properties.contentSha256.type,
    'null'
  );
});

test('candidate-roster tree validation is stack-safe for adversarially deep Git paths', () => {
  const depth = 12_000;
  const objectId = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
  const path = `${'a/'.repeat(depth)}file`;
  const candidateRoster = createWorldModelDiscoveredCandidateRoster({
    source: {
      kind: 'committed-git-tree',
      commit: '1'.repeat(40),
      tree: singleFileDeepTreeSha1(depth, objectId),
      gitObjectFormat: 'sha1',
      pathNormalization: 'posix-relative',
      discoveryBoundary: 'recursive-tracked-blobs-before-scope'
    },
    sourceManifestSha256: digest('deep-source'),
    scopeManifestSha256: digest('deep-scope'),
    candidates: [{
      path,
      type: 'regular',
      mode: '100644',
      objectId,
      contentSha256: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      bytes: 0,
      status: 'selected',
      reasonCode: null
    }]
  });
  assert.equal(candidateRoster.source.tree, singleFileDeepTreeSha1(depth, objectId));
  assert.equal(candidateRoster.candidates[0].path, path);
});

test('model owner constructors are deterministic and their exact retained bytes are readable', () => {
  const first = ownerFixtures();
  const second = ownerFixtures();
  assert.deepEqual(first, second);
  const cases = [
    ['repository-domain', 'world-model-repository-domain', first.repositoryDomain],
    ['extraction-policy', 'world-model-extraction-policy', first.extractionPolicy],
    [
      'candidate-roster', 'world-model-discovered-candidate-roster', first.candidateRoster
    ],
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
