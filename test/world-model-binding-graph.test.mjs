import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import { run } from '../src/util.mjs';
import {
  canonicalJson, compareText, sealRecord, sha256
} from '../src/world-model/canonicalize.mjs';
import { createEvidenceCatalog } from '../src/world-model/extract/evidence-catalog.mjs';
import { runDeterministicRegistration } from '../src/world-model/extract/runner.mjs';
import { createWmpModelBinding } from '../src/world-model/history/contracts.mjs';
import {
  deriveWmpParseSchemaSha256, WMP_SOURCE_NORMALIZATION_CONTRACT_SHA256
} from '../src/world-model/history/extraction-profile-owners.mjs';
import {
  WMP_IDENTITY_VERSION, createWmpSourceBinding
} from '../src/world-model/history/identity.mjs';
import {
  createWorldModelCompletenessRecord, createWorldModelExtractionPolicy,
  createWorldModelRepositoryDomain
} from '../src/world-model/history/model-owners.mjs';
import {
  worldModelHistoryModelPath, worldModelHistoryObjectPath
} from '../src/world-model/history/paths.mjs';
import { stageWorldModelHistoryPublication } from '../src/world-model/history/publication.mjs';
import { resolvePersistedWorldModel } from '../src/world-model/history/store.mjs';
import {
  BUILTIN_EXTRACTOR_REGISTRY, resolveExtractorManifest, validateExtractorRegistry
} from '../src/world-model/registry/extractors.mjs';
import { createScopeManifest } from '../src/world-model/scope/manifest.mjs';
import { createExactSourceSnapshotAtRevision } from '../src/world-model/source/snapshot.mjs';

function git(root, ...args) {
  return run('git', args, { cwd: root }).stdout.trim();
}

function digest(label) {
  return sha256({ fixture: label });
}

function retained(record, role, family) {
  const bytes = Buffer.from(canonicalJson(record), 'utf8');
  return {
    ref: Object.freeze({
      role, family, mediaType: 'application/json', sha256: sha256(bytes), bytes: bytes.length
    }),
    bytes
  };
}

function sortedRefs(values) {
  return [...values].sort((left, right) => compareText(
    `${left.role}\0${left.family ?? ''}\0${left.sha256}`,
    `${right.role}\0${right.family ?? ''}\0${right.sha256}`
  ));
}

async function modelFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmp-binding-graph-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'WMP Binding Graph');
  git(root, 'config', 'user.email', 'wmp-binding-graph@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# exact source\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-m', 'source');
  const sourceCommit = git(root, 'rev-parse', 'HEAD');

  const policySnapshotSha256 = digest('policy-snapshot');
  const scopeManifest = createScopeManifest({
    capabilityId: 'model-history-fixture',
    allowedPaths: ['**'],
    policySourceSha256: policySnapshotSha256
  });
  const sourceSnapshot = createExactSourceSnapshotAtRevision(root, sourceCommit, {
    subjectId: 'model-history-fixture', scopeManifest
  });
  const manifest = resolveExtractorManifest(
    BUILTIN_EXTRACTOR_REGISTRY, 'repository-files@1.0.0'
  );
  const registration = runDeterministicRegistration({
    root,
    sourceSnapshot,
    scopeManifest,
    extractorRegistry: BUILTIN_EXTRACTOR_REGISTRY,
    extractorReferences: [`${manifest.id}@${manifest.version}`],
    requestedViews: []
  });
  const ownerExtractor = {
    id: manifest.id,
    version: manifest.version,
    implementationSha256: manifest.producer.implementationSha256,
    manifestSha256: manifest.manifestSha256,
    coverage: 'path'
  };
  const repositoryDomain = createWorldModelRepositoryDomain({
    repositoryId: 'fixture-repository-id',
    repositoryIdentitySha256: digest('repository-identity')
  });
  const extractionPolicy = createWorldModelExtractionPolicy({
    policySnapshotSha256,
    allowedExtractors: [ownerExtractor],
    factSemantics: {
      allowedFactTypes: [...manifest.factTypes],
      requiredFactTypes: [],
      optionalFactTypes: [...manifest.factTypes],
      requiredUnavailableSubjects: [],
      coverageExtractorRefs: [`${manifest.id}@${manifest.version}`]
    }
  });
  const pathOutcomes = sourceSnapshot.files.map((file) => ({
    path: file.path,
    sourceContentSha256: file.contentSha256,
    status: 'processed',
    reasonCode: null,
    extractors: [{
      id: manifest.id,
      version: manifest.version,
      implementationSha256: manifest.producer.implementationSha256,
      status: 'processed',
      reasonCode: null
    }]
  }));
  const completenessRecord = createWorldModelCompletenessRecord({
    sourceManifestSha256: sourceSnapshot.sourceManifestSha256,
    scopeManifestSha256: scopeManifest.scopeSha256,
    extractorRegistrySha256: BUILTIN_EXTRACTOR_REGISTRY.registrySha256,
    extractorReferences: [ownerExtractor],
    pathOutcomes,
    globalOutcomes: [],
    requiredSubjects: []
  });

  const objects = {
    repositoryDomain: retained(
      repositoryDomain, 'repository-domain', 'world-model-repository-domain'
    ),
    sourceSnapshot: retained(
      sourceSnapshot, 'source-snapshot', 'world-model-source-snapshot'
    ),
    scopeManifest: retained(
      scopeManifest, 'scope-manifest', 'world-model-scope-manifest'
    ),
    extractionPolicy: retained(
      extractionPolicy, 'extraction-policy', 'world-model-extraction-policy'
    ),
    extractorRegistry: retained(
      BUILTIN_EXTRACTOR_REGISTRY, 'extractor-registry', 'world-model-extractor-registry'
    ),
    completenessRecord: retained(
      completenessRecord, 'completeness-record', 'world-model-completeness-record'
    ),
    evidenceCatalog: retained(
      registration.evidenceCatalog, 'evidence-catalog', 'world-model-evidence-catalog'
    ),
    derivationCatalog: retained(
      registration.derivationCatalog, 'derivation-catalog', 'world-model-derivation-catalog'
    ),
    factLedger: retained(
      registration.factLedger, 'fact-ledger', 'world-model-fact-ledger'
    )
  };
  const sourceBinding = createWmpSourceBinding({
    repositoryDomainRef: objects.repositoryDomain.ref,
    repositoryDomainSha256: repositoryDomain.repositoryDomainSha256,
    sourceKind: 'committed',
    sourceSnapshotRef: objects.sourceSnapshot.ref,
    sourceManifestSha256: sourceSnapshot.sourceManifestSha256,
    scopeManifestSha256: scopeManifest.scopeSha256,
    gitObjectFormat: sourceCommit.length === 64 ? 'sha256' : 'sha1',
    requestedRevision: sourceCommit,
    effectiveRevision: sourceCommit,
    sourceAuthorityRef: null
  });
  const numericVersion = Number(manifest.version.split('.')[0]);
  const extractionProfile = {
    kind: 'wmp/extraction-profile',
    version: 1,
    extractors: [{
      id: manifest.id,
      version: numericVersion,
      manifestSha256: manifest.manifestSha256,
      grammarSha256: manifest.producer.parser.grammarSha256,
      parserSha256: null,
      resolverSha256: null,
      implementationSha256: manifest.producer.implementationSha256
    }],
    parseSchemaSha256: null,
    normalizationContractSha256: WMP_SOURCE_NORMALIZATION_CONTRACT_SHA256,
    configurationRefs: []
  };
  extractionProfile.parseSchemaSha256 = deriveWmpParseSchemaSha256(
    extractionProfile.extractors
  );
  const factRequirements = {
    kind: 'wmp/fact-requirements',
    version: 1,
    requiredFactTypes: [],
    optionalFactTypes: [...manifest.factTypes],
    coverageRuleRefs: [],
    requiredUnavailableSubjects: []
  };
  const extractionInputs = { kind: 'wmp/extraction-inputs', version: 1, captures: [] };
  const inputs = {
    identityVersion: WMP_IDENTITY_VERSION,
    repositoryDomainSha256: repositoryDomain.repositoryDomainSha256,
    sourceBindingSha256: sha256(sourceBinding),
    sourceManifestSha256: sourceSnapshot.sourceManifestSha256,
    scopeManifestSha256: scopeManifest.scopeSha256,
    extractionPolicySha256: extractionPolicy.extractionPolicySha256,
    extractorRegistrySha256: BUILTIN_EXTRACTOR_REGISTRY.registrySha256,
    extractionProfileSha256: sha256(extractionProfile),
    factRequirementsSha256: sha256(factRequirements),
    extractionInputsSha256: sha256(extractionInputs)
  };
  const createBinding = (completeness, objectSet = objects) => createWmpModelBinding({
    inputs,
    inputDescriptors: { sourceBinding, extractionProfile, factRequirements, extractionInputs },
    inputObjects: sortedRefs([
      objectSet.repositoryDomain.ref,
      objectSet.sourceSnapshot.ref,
      objectSet.scopeManifest.ref,
      objectSet.extractionPolicy.ref,
      objectSet.extractorRegistry.ref
    ]),
    payloadObjects: sortedRefs([
      objectSet.completenessRecord.ref,
      objectSet.evidenceCatalog.ref,
      objectSet.derivationCatalog.ref,
      objectSet.factLedger.ref
    ]),
    completeness: {
      ...completeness.counts,
      requiredSubjects: completeness.requiredSubjects,
      extractorCoverage: [{
        id: manifest.id,
        version: numericVersion,
        status: 'complete',
        processedPaths: sourceSnapshot.files.length
      }],
      completenessRecord: objectSet.completenessRecord.ref
    }
  });
  return {
    root,
    sourceSnapshot,
    scopeManifest,
    manifest,
    ownerExtractor,
    policySnapshotSha256,
    extractionPolicy,
    pathOutcomes,
    completenessRecord,
    objects,
    binding: createBinding(completenessRecord),
    createBinding
  };
}

test('a structurally complete semantic model graph stages and resolves at one pinned authority cut', async (t) => {
  const fixture = await modelFixture(t);
  const staged = stageWorldModelHistoryPublication({
    modelBindings: [fixture.binding], objects: Object.values(fixture.objects)
  });
  assert.equal(staged.summary.paths, 11);
  for (const [relative, contents] of Object.entries(staged.historyAdditions)) {
    await mkdir(path.dirname(path.join(fixture.root, relative)), { recursive: true });
    await writeFile(path.join(fixture.root, relative), contents);
  }
  git(fixture.root, 'add', '.');
  git(fixture.root, 'commit', '-m', 'persist valid model history');
  const authorityCommit = git(fixture.root, 'rev-parse', 'HEAD');
  const read = resolvePersistedWorldModel(fixture.root, {
    authorityCommit,
    authorityRef: 'refs/heads/main',
    modelKey: fixture.binding.modelKey
  });
  assert.deepEqual(read.binding, fixture.binding);
  assert.equal(read.closure.length, 9);
  assert.ok(read.closure.every((entry) => entry.record !== null));
});

test('a retained historical extractor graph replays without becoming executable by this release', async (t) => {
  const fixture = await modelFixture(t);
  const historicalManifest = structuredClone(fixture.manifest);
  historicalManifest.tests.conformanceReceiptSha256 = digest('historical-conformance');
  const sealedManifest = sealRecord(historicalManifest, 'manifestSha256');
  const historicalRegistry = sealRecord({
    schemaVersion: currentSchemaVersion('world-model-extractor-registry'),
    kind: 'world-model-extractor-registry',
    manifests: [sealedManifest]
  }, 'registrySha256');
  assert.throws(
    () => validateExtractorRegistry(historicalRegistry),
    (error) => error?.code === 'WMB_EXTRACTOR_CONFORMANCE_FAILED'
  );

  const historicalExtractor = {
    id: sealedManifest.id,
    version: sealedManifest.version,
    implementationSha256: sealedManifest.producer.implementationSha256,
    manifestSha256: sealedManifest.manifestSha256,
    coverage: 'path'
  };
  const extractionPolicy = createWorldModelExtractionPolicy({
    policySnapshotSha256: fixture.policySnapshotSha256,
    allowedExtractors: [historicalExtractor],
    factSemantics: {
      allowedFactTypes: [...sealedManifest.factTypes],
      requiredFactTypes: [],
      optionalFactTypes: [...sealedManifest.factTypes],
      requiredUnavailableSubjects: [],
      coverageExtractorRefs: [`${sealedManifest.id}@${sealedManifest.version}`]
    }
  });
  const pathOutcomes = fixture.sourceSnapshot.files.map((file) => ({
    path: file.path,
    sourceContentSha256: file.contentSha256,
    status: 'processed',
    reasonCode: null,
    extractors: [{
      id: sealedManifest.id,
      version: sealedManifest.version,
      implementationSha256: sealedManifest.producer.implementationSha256,
      status: 'processed',
      reasonCode: null
    }]
  }));
  const completenessRecord = createWorldModelCompletenessRecord({
    sourceManifestSha256: fixture.sourceSnapshot.sourceManifestSha256,
    scopeManifestSha256: fixture.scopeManifest.scopeSha256,
    extractorRegistrySha256: historicalRegistry.registrySha256,
    extractorReferences: [historicalExtractor],
    pathOutcomes,
    globalOutcomes: [],
    requiredSubjects: []
  });
  const evidenceCatalog = createEvidenceCatalog({
    sourceSnapshot: fixture.sourceSnapshot,
    scopeManifest: fixture.scopeManifest,
    descriptors: []
  });
  const factLedger = sealRecord({
    schemaVersion: currentSchemaVersion('world-model-fact-ledger'),
    kind: 'world-model-fact-ledger',
    sourceManifestSha256: fixture.sourceSnapshot.sourceManifestSha256,
    scopeManifestSha256: fixture.scopeManifest.scopeSha256,
    extractorRegistrySha256: historicalRegistry.registrySha256,
    facts: []
  }, 'ledgerSha256');
  const derivationCatalog = sealRecord({
    schemaVersion: currentSchemaVersion('world-model-derivation-catalog'),
    kind: 'world-model-derivation-catalog',
    derivations: []
  }, 'catalogSha256');
  const objects = {
    ...fixture.objects,
    extractionPolicy: retained(
      extractionPolicy, 'extraction-policy', 'world-model-extraction-policy'
    ),
    extractorRegistry: retained(
      historicalRegistry, 'extractor-registry', 'world-model-extractor-registry'
    ),
    completenessRecord: retained(
      completenessRecord, 'completeness-record', 'world-model-completeness-record'
    ),
    evidenceCatalog: retained(
      evidenceCatalog, 'evidence-catalog', 'world-model-evidence-catalog'
    ),
    factLedger: retained(factLedger, 'fact-ledger', 'world-model-fact-ledger'),
    derivationCatalog: retained(
      derivationCatalog, 'derivation-catalog', 'world-model-derivation-catalog'
    )
  };
  const extractionProfile = {
    ...fixture.binding.inputDescriptors.extractionProfile,
    extractors: [{
      ...fixture.binding.inputDescriptors.extractionProfile.extractors[0],
      manifestSha256: sealedManifest.manifestSha256
    }]
  };
  extractionProfile.parseSchemaSha256 = deriveWmpParseSchemaSha256(
    extractionProfile.extractors
  );
  const inputs = {
    ...fixture.binding.inputs,
    extractionPolicySha256: extractionPolicy.extractionPolicySha256,
    extractorRegistrySha256: historicalRegistry.registrySha256,
    extractionProfileSha256: sha256(extractionProfile)
  };
  const binding = createWmpModelBinding({
    inputs,
    inputDescriptors: {
      ...fixture.binding.inputDescriptors,
      extractionProfile
    },
    inputObjects: sortedRefs([
      objects.repositoryDomain.ref,
      objects.sourceSnapshot.ref,
      objects.scopeManifest.ref,
      objects.extractionPolicy.ref,
      objects.extractorRegistry.ref
    ]),
    payloadObjects: sortedRefs([
      objects.completenessRecord.ref,
      objects.evidenceCatalog.ref,
      objects.derivationCatalog.ref,
      objects.factLedger.ref
    ]),
    completeness: {
      ...completenessRecord.counts,
      requiredSubjects: [],
      extractorCoverage: [{
        id: sealedManifest.id,
        version: Number(sealedManifest.version.split('.')[0]),
        status: 'complete',
        processedPaths: fixture.sourceSnapshot.files.length
      }],
      completenessRecord: objects.completenessRecord.ref
    }
  });
  // A current writer cannot introduce an uninstalled historical producer. The bytes below model
  // a record that was admitted by an older release and already exists on the state branch.
  assert.throws(
    () => stageWorldModelHistoryPublication({
      modelBindings: [binding], objects: Object.values(objects)
    }),
    (error) => error?.code === 'WMP_GRAPH_MISMATCH'
      && error?.details?.relation === 'extractor-registry.current-admission'
      && error?.details?.causeCode === 'WMB_EXTRACTOR_CONFORMANCE_FAILED'
  );
  const bindingContents = canonicalJson(binding);
  const historicalFiles = new Map([
    [worldModelHistoryModelPath(binding.modelKey), bindingContents],
    [worldModelHistoryObjectPath(sha256(Buffer.from(bindingContents, 'utf8'))), bindingContents]
  ]);
  for (const object of Object.values(objects)) {
    historicalFiles.set(worldModelHistoryObjectPath(object.ref.sha256),
      object.bytes.toString('utf8'));
  }
  for (const [relative, contents] of historicalFiles) {
    await mkdir(path.dirname(path.join(fixture.root, relative)), { recursive: true });
    await writeFile(path.join(fixture.root, relative), contents);
  }
  git(fixture.root, 'add', '.');
  git(fixture.root, 'commit', '-m', 'persist historical extractor graph');
  const authorityCommit = git(fixture.root, 'rev-parse', 'HEAD');
  const replay = resolvePersistedWorldModel(fixture.root, {
    authorityCommit,
    authorityRef: 'refs/heads/main',
    modelKey: binding.modelKey
  });
  assert.deepEqual(replay.binding, binding);
});

test('model history refuses configured extraction until a configuration owner binds derivations', async (t) => {
  const fixture = await modelFixture(t);
  const extractionProfile = {
    ...fixture.binding.inputDescriptors.extractionProfile,
    // Reusing an already retained object proves that this is a semantic authority refusal, not a
    // missing-object failure. Frozen v1 has no contract mapping configuration refs to extractors.
    configurationRefs: [fixture.objects.scopeManifest.ref]
  };
  const binding = createWmpModelBinding({
    inputs: {
      ...fixture.binding.inputs,
      extractionProfileSha256: sha256(extractionProfile)
    },
    inputDescriptors: {
      ...fixture.binding.inputDescriptors,
      extractionProfile
    },
    inputObjects: fixture.binding.inputObjects,
    payloadObjects: fixture.binding.payloadObjects,
    completeness: fixture.binding.completeness
  });
  assert.throws(
    () => stageWorldModelHistoryPublication({
      modelBindings: [binding], objects: Object.values(fixture.objects)
    }),
    (error) => error?.code === 'WMP_GRAPH_MISMATCH'
      && error?.details?.relation === 'extraction-profile.configuration-authority'
  );
});

test('model history refuses completeness that omits or changes exact source bytes', async (t) => {
  const fixture = await modelFixture(t);
  const changedOutcomes = structuredClone(fixture.pathOutcomes);
  changedOutcomes[0].sourceContentSha256 = digest('different-source-bytes');
  const changedCompleteness = createWorldModelCompletenessRecord({
    sourceManifestSha256: fixture.sourceSnapshot.sourceManifestSha256,
    scopeManifestSha256: fixture.scopeManifest.scopeSha256,
    extractorRegistrySha256: BUILTIN_EXTRACTOR_REGISTRY.registrySha256,
    extractorReferences: [fixture.ownerExtractor],
    pathOutcomes: changedOutcomes,
    globalOutcomes: [],
    requiredSubjects: []
  });
  const changedObject = retained(
    changedCompleteness, 'completeness-record', 'world-model-completeness-record'
  );
  const objects = { ...fixture.objects, completenessRecord: changedObject };
  const binding = fixture.createBinding(changedCompleteness, objects);
  assert.throws(
    () => stageWorldModelHistoryPublication({
      modelBindings: [binding], objects: Object.values(objects)
    }),
    (error) => error?.code === 'WMP_GRAPH_MISMATCH'
      && error?.details?.relation === 'completeness.source-content'
  );

  const excludedCompleteness = createWorldModelCompletenessRecord({
    sourceManifestSha256: fixture.sourceSnapshot.sourceManifestSha256,
    scopeManifestSha256: fixture.scopeManifest.scopeSha256,
    extractorRegistrySha256: BUILTIN_EXTRACTOR_REGISTRY.registrySha256,
    extractorReferences: [fixture.ownerExtractor],
    pathOutcomes: [
      ...fixture.pathOutcomes,
      {
        path: 'unproved/excluded.txt',
        sourceContentSha256: null,
        status: 'excluded',
        reasonCode: 'OUTSIDE_SCOPE',
        extractors: []
      }
    ],
    globalOutcomes: [],
    requiredSubjects: []
  });
  const excludedObject = retained(
    excludedCompleteness, 'completeness-record', 'world-model-completeness-record'
  );
  const excludedObjects = { ...fixture.objects, completenessRecord: excludedObject };
  const excludedBinding = fixture.createBinding(excludedCompleteness, excludedObjects);
  assert.throws(
    () => stageWorldModelHistoryPublication({
      modelBindings: [excludedBinding], objects: Object.values(excludedObjects)
    }),
    (error) => error?.code === 'WMP_GRAPH_MISMATCH'
      && error?.details?.relation === 'completeness.excluded-source-roster'
  );
});

test('model history refuses a self-consistent completeness extractor with borrowed registry bytes', async (t) => {
  const fixture = await modelFixture(t);
  const borrowed = {
    ...fixture.ownerExtractor,
    id: 'borrowed-extractor'
  };
  const pathOutcomes = fixture.pathOutcomes.map((outcome) => ({
    ...outcome,
    extractors: outcome.extractors.map((extractor) => ({
      ...extractor,
      id: borrowed.id
    }))
  }));
  const completeness = createWorldModelCompletenessRecord({
    sourceManifestSha256: fixture.sourceSnapshot.sourceManifestSha256,
    scopeManifestSha256: fixture.scopeManifest.scopeSha256,
    extractorRegistrySha256: BUILTIN_EXTRACTOR_REGISTRY.registrySha256,
    extractorReferences: [borrowed],
    pathOutcomes,
    globalOutcomes: [],
    requiredSubjects: []
  });
  const completenessObject = retained(
    completeness, 'completeness-record', 'world-model-completeness-record'
  );
  const objects = { ...fixture.objects, completenessRecord: completenessObject };
  const binding = fixture.createBinding(completeness, objects);
  assert.throws(
    () => stageWorldModelHistoryPublication({
      modelBindings: [binding], objects: Object.values(objects)
    }),
    (error) => error?.code === 'WMP_GRAPH_MISMATCH'
      && error?.details?.relation === 'completeness.extractor-registry'
  );
});

test('model history validates evidence, facts, and derivations as one exact closure', async (t) => {
  const fixture = await modelFixture(t);
  const emptyEvidence = createEvidenceCatalog({
    sourceSnapshot: fixture.sourceSnapshot,
    scopeManifest: fixture.scopeManifest,
    descriptors: []
  });
  const evidenceObject = retained(
    emptyEvidence, 'evidence-catalog', 'world-model-evidence-catalog'
  );
  const objects = { ...fixture.objects, evidenceCatalog: evidenceObject };
  const binding = fixture.createBinding(fixture.completenessRecord, objects);
  assert.throws(
    () => stageWorldModelHistoryPublication({
      modelBindings: [binding], objects: Object.values(objects)
    }),
    (error) => error?.code === 'WMP_GRAPH_MISMATCH'
      && error?.details?.relation === 'fact-ledger.complete-closure'
      && error?.details?.causeCode === 'WMB_EVIDENCE_NOT_REGISTERED'
  );
});

test('model history refuses facts outside the selected extraction policy', async (t) => {
  const fixture = await modelFixture(t);
  const policy = createWorldModelExtractionPolicy({
    policySnapshotSha256: fixture.policySnapshotSha256,
    allowedExtractors: [fixture.ownerExtractor],
    factSemantics: {
      allowedFactTypes: [],
      requiredFactTypes: [],
      optionalFactTypes: [],
      requiredUnavailableSubjects: [],
      coverageExtractorRefs: [
        `${fixture.ownerExtractor.id}@${fixture.ownerExtractor.version}`
      ]
    }
  });
  const policyObject = retained(
    policy, 'extraction-policy', 'world-model-extraction-policy'
  );
  const objects = { ...fixture.objects, extractionPolicy: policyObject };
  const factRequirements = {
    ...fixture.binding.inputDescriptors.factRequirements,
    optionalFactTypes: []
  };
  const binding = createWmpModelBinding({
    inputs: {
      ...fixture.binding.inputs,
      extractionPolicySha256: policy.extractionPolicySha256,
      factRequirementsSha256: sha256(factRequirements)
    },
    inputDescriptors: {
      ...fixture.binding.inputDescriptors,
      factRequirements
    },
    inputObjects: sortedRefs([
      objects.repositoryDomain.ref,
      objects.sourceSnapshot.ref,
      objects.scopeManifest.ref,
      objects.extractionPolicy.ref,
      objects.extractorRegistry.ref
    ]),
    payloadObjects: fixture.binding.payloadObjects,
    completeness: fixture.binding.completeness
  });
  assert.throws(
    () => stageWorldModelHistoryPublication({
      modelBindings: [binding], objects: Object.values(objects)
    }),
    (error) => error?.code === 'WMP_GRAPH_MISMATCH'
      && error?.details?.relation === 'derivation.fact-type-authority'
  );
});

test('model history derives required-subject completeness from retained Facts', async (t) => {
  const fixture = await modelFixture(t);
  const factType = fixture.manifest.factTypes[0];
  const policy = createWorldModelExtractionPolicy({
    policySnapshotSha256: fixture.policySnapshotSha256,
    allowedExtractors: [fixture.ownerExtractor],
    factSemantics: {
      allowedFactTypes: [...fixture.manifest.factTypes],
      requiredFactTypes: [factType],
      optionalFactTypes: fixture.manifest.factTypes.filter((entry) => entry !== factType),
      requiredUnavailableSubjects: [],
      coverageExtractorRefs: [
        `${fixture.ownerExtractor.id}@${fixture.ownerExtractor.version}`
      ]
    }
  });
  const completeness = createWorldModelCompletenessRecord({
    sourceManifestSha256: fixture.sourceSnapshot.sourceManifestSha256,
    scopeManifestSha256: fixture.scopeManifest.scopeSha256,
    extractorRegistrySha256: BUILTIN_EXTRACTOR_REGISTRY.registrySha256,
    extractorReferences: [fixture.ownerExtractor],
    pathOutcomes: fixture.pathOutcomes,
    globalOutcomes: [],
    requiredSubjects: [{
      id: factType, status: 'unavailable', reasonCode: 'NO_REGISTERED_PRODUCER'
    }]
  });
  const policyObject = retained(
    policy, 'extraction-policy', 'world-model-extraction-policy'
  );
  const completenessObject = retained(
    completeness, 'completeness-record', 'world-model-completeness-record'
  );
  const objects = {
    ...fixture.objects,
    extractionPolicy: policyObject,
    completenessRecord: completenessObject
  };
  const factRequirements = {
    ...fixture.binding.inputDescriptors.factRequirements,
    requiredFactTypes: [factType],
    optionalFactTypes: fixture.manifest.factTypes.filter((entry) => entry !== factType)
  };
  const binding = createWmpModelBinding({
    inputs: {
      ...fixture.binding.inputs,
      extractionPolicySha256: policy.extractionPolicySha256,
      factRequirementsSha256: sha256(factRequirements)
    },
    inputDescriptors: {
      ...fixture.binding.inputDescriptors,
      factRequirements
    },
    inputObjects: sortedRefs([
      objects.repositoryDomain.ref,
      objects.sourceSnapshot.ref,
      objects.scopeManifest.ref,
      objects.extractionPolicy.ref,
      objects.extractorRegistry.ref
    ]),
    payloadObjects: sortedRefs([
      objects.completenessRecord.ref,
      objects.evidenceCatalog.ref,
      objects.derivationCatalog.ref,
      objects.factLedger.ref
    ]),
    completeness: {
      ...fixture.binding.completeness,
      ...completeness.counts,
      requiredSubjects: completeness.requiredSubjects,
      completenessRecord: objects.completenessRecord.ref
    }
  });
  assert.throws(
    () => stageWorldModelHistoryPublication({
      modelBindings: [binding], objects: Object.values(objects)
    }),
    (error) => error?.code === 'WMP_GRAPH_MISMATCH'
      && error?.details?.relation === 'completeness.required-subject-outcomes'
  );
});
