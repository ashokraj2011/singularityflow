import assert from 'node:assert/strict';
import test from 'node:test';

import { schemaFamily } from '../src/schema-migrations.mjs';
import { canonicalJson, sha256 } from '../src/world-model/canonicalize.mjs';
import {
  createWmpModelBinding, createWmpViewInputs, parseCanonicalWmpRecordBytes,
  WMP_RECORD_FAMILIES
} from '../src/world-model/history/contracts.mjs';
import {
  createWmpSourceBinding, deriveWmpModelKey, deriveWmpViewKey
} from '../src/world-model/history/identity.mjs';
import {
  validateWorldModelHistoryRoots, worldModelHistoryObjectPath
} from '../src/world-model/history/paths.mjs';

const digest = (character) => `sha256:${character.repeat(64)}`;

function modelInputs(overrides = {}) {
  return {
    identityVersion: 1,
    repositoryDomainSha256: digest('1'),
    sourceBindingSha256: digest('2'),
    sourceManifestSha256: digest('3'),
    scopeManifestSha256: digest('4'),
    extractionPolicySha256: digest('5'),
    extractorRegistrySha256: digest('6'),
    extractionProfileSha256: digest('7'),
    factRequirementsSha256: digest('8'),
    extractionInputsSha256: digest('9'),
    ...overrides
  };
}

function viewKeyInputs(overrides = {}) {
  return {
    identityVersion: 1,
    modelPayloadSha256: digest('1'),
    viewInputsSha256: digest('2'),
    viewId: 'repository.development',
    viewVersion: 1,
    viewContractSha256: digest('3'),
    rendererSha256: digest('4'),
    validatorSha256: digest('5'),
    consumerProfileSha256: digest('6'),
    selectionSha256: digest('7'),
    outputBudgetSha256: digest('8'),
    tokenizerSha256: null,
    format: 'md',
    variant: 'full',
    ...overrides
  };
}

function objectRef({ role, family, character }) {
  return {
    role,
    family,
    mediaType: 'application/json',
    sha256: digest(character),
    bytes: 2
  };
}

function sortedRefs(values) {
  return [...values].sort((left, right) => (
    `${left.role}\0${left.family ?? ''}\0${left.sha256}`
      .localeCompare(`${right.role}\0${right.family ?? ''}\0${right.sha256}`)
  ));
}

function modelBindingFixture(overrides = {}) {
  const repositoryDomainRef = objectRef({
    role: 'repository-domain', family: 'world-model-source-snapshot', character: 'a'
  });
  const sourceSnapshotRef = objectRef({
    role: 'source-snapshot', family: 'world-model-source-snapshot', character: 'b'
  });
  const sourceBinding = createWmpSourceBinding({
    repositoryDomainRef,
    repositoryDomainSha256: digest('a'),
    sourceKind: 'committed',
    sourceSnapshotRef,
    sourceManifestSha256: digest('b'),
    scopeManifestSha256: digest('c'),
    gitObjectFormat: 'sha1',
    requestedRevision: '1'.repeat(40),
    effectiveRevision: '1'.repeat(40),
    sourceAuthorityRef: null
  });
  const extractionProfile = {
    kind: 'wmp/extraction-profile', version: 1, extractors: [],
    parseSchemaSha256: digest('d'), normalizationContractSha256: digest('e'),
    configurationRefs: []
  };
  const factRequirements = {
    kind: 'wmp/fact-requirements', version: 1,
    requiredFactTypes: [], optionalFactTypes: [], coverageRuleRefs: [],
    requiredUnavailableSubjects: []
  };
  const extractionInputs = { kind: 'wmp/extraction-inputs', version: 1, captures: [] };
  const completenessRecord = objectRef({
    role: 'completeness-record', family: 'world-model-source-snapshot', character: 'f'
  });
  const inputObjects = sortedRefs([
    repositoryDomainRef,
    sourceSnapshotRef,
    objectRef({ role: 'scope-manifest', family: 'world-model-scope-manifest', character: 'c' }),
    objectRef({ role: 'extraction-policy', family: 'world-model-source-snapshot', character: 'd' }),
    objectRef({ role: 'extractor-registry', family: 'world-model-source-snapshot', character: 'e' })
  ]);
  const payloadObjects = sortedRefs([
    completenessRecord,
    objectRef({ role: 'derivation-catalog', family: 'world-model-derivation-catalog', character: '7' }),
    objectRef({ role: 'evidence-catalog', family: 'world-model-evidence-catalog', character: '8' }),
    objectRef({ role: 'fact-ledger', family: 'world-model-fact-ledger', character: '9' })
  ]);
  return {
    inputs: modelInputs({
      repositoryDomainSha256: sourceBinding.repositoryDomainSha256,
      sourceBindingSha256: sha256(sourceBinding),
      sourceManifestSha256: sourceBinding.sourceManifestSha256,
      scopeManifestSha256: sourceBinding.scopeManifestSha256,
      extractionProfileSha256: sha256(extractionProfile),
      factRequirementsSha256: sha256(factRequirements),
      extractionInputsSha256: sha256(extractionInputs)
    }),
    inputDescriptors: { sourceBinding, extractionProfile, factRequirements, extractionInputs },
    inputObjects,
    payloadObjects,
    completeness: {
      totalPaths: 0, processedPaths: 0, unsupportedPaths: 0, failedPaths: 0,
      excludedPaths: 0, requiredSubjects: [], extractorCoverage: [], completenessRecord
    },
    ...overrides
  };
}

test('WMP durable families are frozen identities registered at schema v1', () => {
  assert.equal(WMP_RECORD_FAMILIES.length, 6);
  for (const familyId of WMP_RECORD_FAMILIES) {
    const family = schemaFamily(familyId);
    assert.equal(family.currentVersion, 1, familyId);
    assert.equal(family.immutable, true, familyId);
    assert.equal(family.migrationPolicy, 'frozen-identity', familyId);
  }
});

test('every meaning-bearing model and view input changes its exact reuse key', () => {
  const modelBase = modelInputs();
  const modelKey = deriveWmpModelKey(modelBase);
  for (const field of Object.keys(modelBase).filter((key) => key.endsWith('Sha256'))) {
    assert.notEqual(
      deriveWmpModelKey({ ...modelBase, [field]: digest('a') }),
      modelKey,
      field
    );
  }

  const viewBase = viewKeyInputs();
  const viewKey = deriveWmpViewKey(viewBase);
  const changes = {
    modelPayloadSha256: digest('a'),
    viewInputsSha256: digest('b'),
    viewId: 'repository.testing',
    viewVersion: 2,
    viewContractSha256: digest('c'),
    rendererSha256: digest('d'),
    validatorSha256: digest('e'),
    consumerProfileSha256: digest('f'),
    selectionSha256: digest('a'),
    outputBudgetSha256: digest('b'),
    tokenizerSha256: digest('c'),
    format: 'json',
    variant: 'brief'
  };
  for (const [field, value] of Object.entries(changes)) {
    assert.notEqual(deriveWmpViewKey({ ...viewBase, [field]: value }), viewKey, field);
  }
});

test('source bindings require both revisions to match the declared Git object format', () => {
  const repositoryDomainRef = objectRef({
    role: 'repository-domain', family: 'world-model-source-snapshot', character: 'a'
  });
  const sourceSnapshotRef = objectRef({
    role: 'source-snapshot', family: 'world-model-source-snapshot', character: 'b'
  });
  const binding = (gitObjectFormat, requestedRevision, effectiveRevision) =>
    createWmpSourceBinding({
      repositoryDomainRef,
      repositoryDomainSha256: digest('a'),
      sourceKind: 'committed',
      sourceSnapshotRef,
      sourceManifestSha256: digest('b'),
      scopeManifestSha256: digest('c'),
      gitObjectFormat,
      requestedRevision,
      effectiveRevision,
      sourceAuthorityRef: null
    });

  assert.doesNotThrow(() => binding('sha1', '1'.repeat(40), '2'.repeat(40)));
  assert.doesNotThrow(() => binding('sha256', '1'.repeat(64), '2'.repeat(64)));
  for (const [gitObjectFormat, requestedLength, effectiveLength, field] of [
    ['sha1', 64, 40, 'requestedRevision'],
    ['sha1', 40, 64, 'effectiveRevision'],
    ['sha256', 40, 64, 'requestedRevision'],
    ['sha256', 64, 40, 'effectiveRevision']
  ]) {
    assert.throws(
      () => binding(
        gitObjectFormat,
        '1'.repeat(requestedLength),
        '2'.repeat(effectiveLength)
      ),
      (error) => error?.code === 'WMP_SOURCE_BINDING_INVALID'
        && error?.details?.field === field,
      `${gitObjectFormat} ${field}`
    );
  }
});

test('authority ingestion accepts only exact canonical self-hashed bytes', () => {
  const record = createWmpViewInputs({
    modelPayloadSha256: digest('1'),
    captures: [{
      role: 'output-budget',
      subject: 'repository.development@1',
      status: 'available',
      objectRef: objectRef({
        role: 'output-budget', family: 'world-model-output-budget', character: '4'
      }),
      reason: null
    }],
    viewContractRef: objectRef({
      role: 'view-contract', family: 'world-model-view-contract', character: '2'
    }),
    consumerProfileRef: objectRef({
      role: 'consumer-profile', family: 'world-model-consumer-profile', character: '3'
    }),
    selection: {
      kind: 'wmp/view-selection',
      version: 1,
      storyScopeSha256: null,
      querySha256: null,
      factIds: [],
      traversal: { maximumFacts: 100, maximumEdges: 100, maximumDepth: 4 }
    },
    comparisonRef: null,
    evidenceCutRef: null
  });
  const bytes = Buffer.from(canonicalJson(record), 'utf8');
  assert.deepEqual(parseCanonicalWmpRecordBytes('world-model-view-inputs', bytes), record);

  const prettyButNoncanonical = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
  assert.throws(
    () => parseCanonicalWmpRecordBytes('world-model-view-inputs', prettyButNoncanonical),
    (error) => error?.code === 'WMP_CANONICAL_BYTES_REQUIRED'
  );
  const tampered = { ...record, unexpected: true };
  assert.throws(
    () => parseCanonicalWmpRecordBytes(
      'world-model-view-inputs', Buffer.from(canonicalJson(tampered), 'utf8')
    ),
    (error) => error?.code === 'WMB_CONTRACT_FIELD_UNKNOWN'
  );
  const duplicateKey = Buffer.from(
    canonicalJson(record).replace('{\n', '{\n  "schemaVersion": 1,\n'),
    'utf8'
  );
  assert.throws(
    () => parseCanonicalWmpRecordBytes('world-model-view-inputs', duplicateKey),
    (error) => error?.code === 'WMP_CANONICAL_BYTES_REQUIRED'
  );
});

test('model bindings require the complete frozen v1 retained-role roster', () => {
  const complete = modelBindingFixture();
  assert.doesNotThrow(() => createWmpModelBinding(complete));

  for (const [label, overrides] of [
    ['empty input roster', { inputObjects: [] }],
    ['incomplete input roster', {
      inputObjects: complete.inputObjects.filter((ref) => ref.role !== 'scope-manifest')
    }],
    ['empty payload roster', { payloadObjects: [] }],
    ['incomplete payload roster', {
      payloadObjects: complete.payloadObjects.filter((ref) => ref.role !== 'fact-ledger')
    }]
  ]) {
    assert.throws(
      () => createWmpModelBinding({ ...complete, ...overrides }),
      (error) => error?.code === 'WMP_INPUT_ROLE_MISSING',
      label
    );
  }

  const substitutedSource = sortedRefs(complete.inputObjects.map((ref) => (
    ref.role === 'source-snapshot' ? { ...ref, sha256: digest('0') } : ref
  )));
  assert.throws(
    () => createWmpModelBinding({ ...complete, inputObjects: substitutedSource }),
    (error) => error?.code === 'WMP_INPUT_MISSING'
      && error?.details?.role === 'source-snapshot'
  );
});

test('history roots and object paths remain disjoint and content-addressed', () => {
  assert.deepEqual(validateWorldModelHistoryRoots({
    outputDir: 'singularity/world-model',
    historyDir: 'singularity/world-model-history'
  }), {
    outputDir: 'singularity/world-model',
    historyDir: 'singularity/world-model-history'
  });
  assert.equal(
    worldModelHistoryObjectPath(digest('a')),
    `singularity/world-model-history/objects/sha256/aa/${'a'.repeat(64)}`
  );
  assert.equal(
    worldModelHistoryObjectPath(digest('b'), {
      historyDir: validateWorldModelHistoryRoots({
        outputDir: 'custom/current', historyDir: 'singularity/world-model'
      }).historyDir
    }),
    `singularity/world-model/objects/sha256/bb/${'b'.repeat(64)}`
  );
  for (const historyDir of [
    'singularity/world-model',
    'singularity/world-model/history',
    'singularity',
    '../world-model-history',
    'singularity\\world-model-history',
    'singularity/world-model.',
    'CON/history',
    'singularity/NUL',
    'singularity/com1.cache',
    '.git/wmp-history'
  ]) {
    assert.throws(
      () => validateWorldModelHistoryRoots({
        outputDir: 'singularity/world-model', historyDir
      }),
      (error) => ['WMP_HISTORY_ROOT_OVERLAP', 'WMP_HISTORY_PATH_INVALID'].includes(error?.code),
      historyDir
    );
  }
  assert.equal(sha256(Buffer.from('exact bytes', 'utf8')).startsWith('sha256:'), true);
});
