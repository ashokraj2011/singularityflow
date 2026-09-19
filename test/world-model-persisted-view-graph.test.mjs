import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import { run } from '../src/util.mjs';
import { canonicalJson, sealRecord, sha256 } from '../src/world-model/canonicalize.mjs';
import { runDeterministicRegistration } from '../src/world-model/extract/runner.mjs';
import { createViewProjectionRegistration } from '../src/world-model/extract/view-projection.mjs';
import { createWmpViewBinding, createWmpViewInputs } from '../src/world-model/history/contracts.mjs';
import {
  createPersistedWorldModelBindingFromBuild, deriveFrozenV1WorldModelExtractionPolicy,
  preparePersistedWorldModelBuild
} from '../src/world-model/history/model-build.mjs';
import { createWorldModelRepositoryDomain } from '../src/world-model/history/model-owners.mjs';
import { validateRetainedWorldModelBindingGraph } from '../src/world-model/history/store.mjs';
import {
  PERSISTED_OVERVIEW_RENDERER_CONTRACT,
  PERSISTED_OVERVIEW_RENDERER_IMPLEMENTATION,
  PERSISTED_OVERVIEW_RENDERER_IMPLEMENTATION_SHA256,
  PERSISTED_OVERVIEW_VALIDATION_CHECK_IDS,
  PERSISTED_OVERVIEW_VALIDATOR_CONTRACT,
  PERSISTED_OVERVIEW_VALIDATOR_IMPLEMENTATION,
  PERSISTED_OVERVIEW_VALIDATOR_IMPLEMENTATION_SHA256,
  validateWorldModelRendererContract,
  validateWorldModelValidatorContract
} from '../src/world-model/history/view-owner-contracts.mjs';
import { createPersistedViewImplementationRegistry } from '../src/world-model/history/persisted-view-implementation-registry.mjs';
import {
  verifyPersistedOverviewCandidateV1
} from '../src/world-model/history/persisted-overview-validator-v1.mjs';
import {
  PERSISTED_OVERVIEW_RENDERER_V1_SOURCE_MANIFEST,
  PERSISTED_OVERVIEW_VALIDATOR_V1_SOURCE_MANIFEST
} from '../src/world-model/history/persisted-view-source-manifests.mjs';
import { renderPersistedOverviewView } from '../src/world-model/materialize/overview-view.mjs';
import {
  createWorldModelConsumerProfile, createWorldModelOutputBudget
} from '../src/world-model/plan.mjs';
import {
  BUILTIN_EXTRACTOR_REGISTRY, DEFAULT_EXTRACTOR_REFERENCES
} from '../src/world-model/registry/extractors.mjs';
import {
  resolveWmpOverviewViewContract, WMP_OVERVIEW_VIEW_REGISTRY
} from '../src/world-model/registry/views.mjs';
import { createScopeManifest } from '../src/world-model/scope/manifest.mjs';
import { createExactSourceSnapshotAtRevision } from '../src/world-model/source/snapshot.mjs';

function git(root, ...args) {
  return run('git', args, { cwd: root }).stdout.trim();
}

function retained(record, role, family, mediaType = 'application/json') {
  const text = typeof record === 'string' ? record : canonicalJson(record);
  const bytes = Buffer.from(text, 'utf8');
  return Object.freeze({
    ref: Object.freeze({ role, family, mediaType, sha256: sha256(bytes), bytes: bytes.length }),
    bytes: text,
    record: typeof record === 'string' ? null : record
  });
}

function authority(repositoryDomain, capabilityId, commit) {
  const capabilityMapSha256 = sha256({ fixture: 'capability-map' });
  return sealRecord({
    kind: 'wmp/repository-identity-authority', version: 1,
    repositoryDomainSha256: repositoryDomain.repositoryDomainSha256,
    repositoryId: repositoryDomain.repositoryId,
    repositoryIdentitySha256: repositoryDomain.repositoryIdentitySha256,
    capability: {
      id: capabilityId, mode: 'explicit-managed',
      resolutionSha256: sha256({ fixture: 'resolution' }), stateSha256: capabilityMapSha256
    },
    configurationAuthority: {
      kind: 'approved-configuration',
      repositoryIdentitySha256: sha256({ fixture: 'configuration-repository' }),
      branch: 'sflow/config', commit, capabilityMapSha256,
      portfolioSha256: sha256({ fixture: 'portfolio' })
    }
  }, 'authoritySha256');
}

function closure(objects) {
  return new Map(objects.map((object) => [object.ref.sha256, {
    ref: object.ref,
    bytes: Buffer.isBuffer(object.bytes) ? object.bytes : Buffer.from(object.bytes, 'utf8'),
    record: object.record !== undefined
      ? object.record
      : object.ref.family === null ? null : JSON.parse(object.bytes)
  }]));
}

async function validViewGraph(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmp-view-graph-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'WMP View Graph');
  git(root, 'config', 'user.email', 'wmp-view-graph@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# deterministic application source\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'application source');
  const commit = git(root, 'rev-parse', 'HEAD');
  const capabilityId = 'application-api';
  const policySourceSha256 = sha256({ fixture: 'policy' });
  const scopeManifest = createScopeManifest({
    capabilityId, allowedPaths: ['README.md'], policySourceSha256
  });
  const sourceSnapshot = createExactSourceSnapshotAtRevision(root, commit, {
    subjectId: capabilityId, scopeManifest
  });
  const extractionPolicy = deriveFrozenV1WorldModelExtractionPolicy(
    scopeManifest, BUILTIN_EXTRACTOR_REGISTRY, DEFAULT_EXTRACTOR_REFERENCES
  );
  const repositoryDomain = createWorldModelRepositoryDomain({
    repositoryId: 'application', repositoryIdentitySha256: sha256({ fixture: 'repository' })
  });
  const repositoryAuthority = authority(repositoryDomain, capabilityId, commit);
  const resolveRepositoryAuthority = async () => ({
    repositoryDomain, repositoryIdentityAuthority: repositoryAuthority, scopeManifest
  });
  const preparation = await preparePersistedWorldModelBuild(root, {
    sourceSnapshot, scopeManifest, extractionPolicy,
    extractorRegistry: BUILTIN_EXTRACTOR_REGISTRY, resolveRepositoryAuthority
  });
  const contract = resolveWmpOverviewViewContract('repository.development@1');
  const registration = runDeterministicRegistration({
    root, sourceSnapshot, scopeManifest,
    extractorRegistry: BUILTIN_EXTRACTOR_REGISTRY,
    extractorReferences: DEFAULT_EXTRACTOR_REFERENCES,
    requestedViews: [],
    viewRegistry: WMP_OVERVIEW_VIEW_REGISTRY,
    captureExtractorExecutions: true
  });
  const built = await createPersistedWorldModelBindingFromBuild(root, {
    preparation, registration, resolveRepositoryAuthority
  });
  const sourceLedgerObject = built.objects.find((entry) => entry.ref.role === 'fact-ledger');
  assert.ok(sourceLedgerObject);
  const sourceLedger = registration.factLedger;
  const projection = createViewProjectionRegistration({
    sourceSnapshot,
    scopeManifest,
    extractorRegistry: BUILTIN_EXTRACTOR_REGISTRY,
    viewRegistry: WMP_OVERVIEW_VIEW_REGISTRY,
    evidenceCatalog: registration.evidenceCatalog,
    derivationCatalog: registration.derivationCatalog,
    factLedger: sourceLedger,
    viewContracts: [contract]
  });
  const projectedLedgerObject = retained(
    projection.factLedger, 'projection-fact-ledger', 'world-model-fact-ledger'
  );
  const selectedLedger = projection.viewFactLedgers[0];
  const selectedLedgerObject = retained(
    selectedLedger, 'selected-fact-ledger', 'world-model-view-fact-ledger'
  );
  const modelBindingObject = retained(
    built.binding, 'model-binding', 'world-model-model-binding'
  );
  const viewContractObject = retained(contract, 'view-contract', 'world-model-view-contract');
  const consumer = createWorldModelConsumerProfile();
  const consumerObject = retained(
    consumer, 'consumer-profile', 'world-model-consumer-profile'
  );
  const outputBudget = createWorldModelOutputBudget([contract]);
  const budgetObject = retained(outputBudget, 'output-budget', 'world-model-output-budget');
  const rendererObject = retained(
    PERSISTED_OVERVIEW_RENDERER_CONTRACT,
    'renderer-contract', 'world-model-renderer-contract'
  );
  const validatorObject = retained(
    PERSISTED_OVERVIEW_VALIDATOR_CONTRACT,
    'validator-contract', 'world-model-validator-contract'
  );
  const selection = {
    kind: 'wmp/view-selection', version: 1,
    storyScopeSha256: null, querySha256: null, factIds: [],
    traversal: { maximumFacts: 1000, maximumEdges: 1000, maximumDepth: 8 }
  };
  const viewInputs = createWmpViewInputs({
    modelPayloadSha256: built.binding.modelPayloadSha256,
    captures: [
      {
        role: 'fact-ledger', subject: 'accepted-model-source', status: 'available',
        objectRef: sourceLedgerObject.ref, reason: null
      },
      {
        role: 'model-binding', subject: 'accepted-model', status: 'available',
        objectRef: modelBindingObject.ref, reason: null
      },
      {
        role: 'output-budget', subject: contract.id, status: 'available',
        objectRef: budgetObject.ref, reason: null
      },
      {
        role: 'projection-fact-ledger', subject: contract.id, status: 'available',
        objectRef: projectedLedgerObject.ref, reason: null
      }
    ],
    viewContractRef: viewContractObject.ref,
    consumerProfileRef: consumerObject.ref,
    selection,
    comparisonRef: null,
    evidenceCutRef: null
  });
  const viewInputsObject = retained(viewInputs, 'view-inputs', 'world-model-view-inputs');
  const rendered = renderPersistedOverviewView({
    view: contract.id, sourceFactLedger: projection.factLedger, viewFactLedger: selectedLedger,
    modelPayloadSha256: built.binding.modelPayloadSha256,
    viewInputsSha256: viewInputs.inputManifestSha256
  });
  const renderedObject = retained(
    rendered.content, 'rendered-view', null, 'text/markdown'
  );
  const receipt = sealRecord({
    schemaVersion: currentSchemaVersion('world-model-view-validation-receipt'),
    kind: 'world-model-view-validation-receipt',
    viewId: contract.id,
    viewVersion: contract.version,
    candidateSha256: renderedObject.ref.sha256,
    candidateSchemaSha256: PERSISTED_OVERVIEW_VALIDATOR_CONTRACT.candidateSchemaSha256,
    viewSpecSha256: contract.contractSha256,
    factLedgerSha256: selectedLedger.ledgerSha256,
    scopeSha256: scopeManifest.scopeSha256,
    checks: PERSISTED_OVERVIEW_VALIDATION_CHECK_IDS.map((id) => ({ id, status: 'pass' })),
    status: 'passed',
    validatorSha256: PERSISTED_OVERVIEW_VALIDATOR_CONTRACT.implementationSha256
  }, 'receiptSha256');
  const receiptObject = retained(
    receipt, 'validator-receipt', 'world-model-view-validation-receipt'
  );
  const inputs = {
    identityVersion: 1,
    modelPayloadSha256: built.binding.modelPayloadSha256,
    viewInputsSha256: viewInputs.inputManifestSha256,
    viewId: contract.id,
    viewVersion: contract.version,
    viewContractSha256: contract.contractSha256,
    rendererSha256: rendererObject.ref.sha256,
    validatorSha256: validatorObject.ref.sha256,
    consumerProfileSha256: consumer.profileSha256,
    selectionSha256: sha256(selection),
    outputBudgetSha256: outputBudget.budgetSha256,
    tokenizerSha256: null,
    format: 'md',
    variant: 'full'
  };
  const binding = createWmpViewBinding({
    inputs,
    viewInputsRef: viewInputsObject.ref,
    selectedFactLedgerRef: selectedLedgerObject.ref,
    rendererContractRef: rendererObject.ref,
    validatorContractRef: validatorObject.ref,
    status: 'complete', gaps: [],
    selection: {
      mode: 'inline',
      selectedFactIds: rendered.selectedFactIds,
      omittedFactIds: rendered.omittedFactIds,
      manifestRef: null
    },
    rendered: renderedObject.ref,
    measurement: { bytes: rendered.bytes, tokens: null, tokenizerSha256: null },
    validatorReceiptRef: receiptObject.ref
  });
  const objects = [
    ...built.objects,
    modelBindingObject,
    selectedLedgerObject,
    viewContractObject,
    consumerObject,
    budgetObject,
    projectedLedgerObject,
    rendererObject,
    validatorObject,
    viewInputsObject,
    renderedObject,
    receiptObject
  ];
  return {
    binding, objects, receiptObject, renderedObject, scopeManifest,
    replayInput: {
      binding,
      viewInputs,
      projectedFactLedger: projection.factLedger,
      selectedFactLedger: selectedLedger,
      viewContract: contract,
      renderedBytes: renderedObject.bytes
    }
  };
}

test('persisted-view admission binds the exact model, source ledger, owners, scope, and bytes', async (t) => {
  const graph = await validViewGraph(t);
  assert.doesNotThrow(() => validateRetainedWorldModelBindingGraph(
    'view', graph.binding, closure(graph.objects)
  ));
});

test('persisted-view admission rejects a receipt for different rendered bytes or scope', async (t) => {
  const graph = await validViewGraph(t);
  for (const [label, mutation] of [
    ['candidate', { candidateSha256: sha256({ substituted: 'rendered-view' }) }],
    ['scope', { scopeSha256: sha256({ substituted: 'scope' }) }]
  ]) {
    const changed = sealRecord({ ...graph.receiptObject.record, ...mutation }, 'receiptSha256');
    const changedObject = retained(
      changed, 'validator-receipt', 'world-model-view-validation-receipt'
    );
    const binding = createWmpViewBinding({
      ...graph.binding,
      validatorReceiptRef: changedObject.ref,
      bindingSha256: undefined
    });
    const objects = graph.objects
      .filter((entry) => entry.ref.sha256 !== graph.receiptObject.ref.sha256)
      .concat(changedObject);
    assert.throws(
      () => validateRetainedWorldModelBindingGraph('view', binding, closure(objects)),
      (error) => error?.code === 'WMP_GRAPH_MISMATCH',
      label
    );
  }
});

test('persisted-view admission replays bytes even when an arbitrary candidate has a forged passing receipt', async (t) => {
  const graph = await validViewGraph(t);
  const arbitraryObject = retained(
    '# plausible but not deterministically rendered\n', 'rendered-view', null, 'text/markdown'
  );
  const forgedReceipt = sealRecord({
    ...graph.receiptObject.record,
    candidateSha256: arbitraryObject.ref.sha256
  }, 'receiptSha256');
  const forgedReceiptObject = retained(
    forgedReceipt, 'validator-receipt', 'world-model-view-validation-receipt'
  );
  const forgedBinding = createWmpViewBinding({
    ...graph.binding,
    rendered: arbitraryObject.ref,
    measurement: {
      bytes: arbitraryObject.ref.bytes,
      tokens: null,
      tokenizerSha256: null
    },
    validatorReceiptRef: forgedReceiptObject.ref,
    bindingSha256: undefined
  });
  const replaced = graph.objects.filter((entry) => (
    entry.ref.sha256 !== graph.renderedObject.ref.sha256
      && entry.ref.sha256 !== graph.receiptObject.ref.sha256
  )).concat(arbitraryObject, forgedReceiptObject);
  assert.throws(
    () => validateRetainedWorldModelBindingGraph('view', forgedBinding, closure(replaced)),
    (error) => error?.code === 'WMP_GRAPH_MISMATCH'
      && error?.details?.relation === 'view-renderer.exact-replay'
      && error?.details?.causeCode === 'WMP_VIEW_REPLAY_MISMATCH'
  );
});

test('persisted renderer and validator identities derive from pinned exact closure manifests', () => {
  assert.equal(PERSISTED_OVERVIEW_RENDERER_CONTRACT.schemaVersion, 1);
  assert.equal(PERSISTED_OVERVIEW_VALIDATOR_CONTRACT.schemaVersion, 1);
  const cases = [
    {
      manifest: PERSISTED_OVERVIEW_RENDERER_V1_SOURCE_MANIFEST,
      implementation: PERSISTED_OVERVIEW_RENDERER_IMPLEMENTATION,
      implementationSha256: PERSISTED_OVERVIEW_RENDERER_IMPLEMENTATION_SHA256
    },
    {
      manifest: PERSISTED_OVERVIEW_VALIDATOR_V1_SOURCE_MANIFEST,
      implementation: PERSISTED_OVERVIEW_VALIDATOR_IMPLEMENTATION,
      implementationSha256: PERSISTED_OVERVIEW_VALIDATOR_IMPLEMENTATION_SHA256
    }
  ];
  for (const value of cases) {
    assert.equal(value.implementation.sourceSha256, value.manifest.sourceSha256);
    assert.equal(value.implementation.sourceManifestSha256, value.manifest.manifestSha256);
    assert.deepEqual(value.implementation.entrypoints, value.manifest.entrypoints);
    assert.deepEqual(
      value.implementation.sourceFiles, value.manifest.modules.map((entry) => entry.path)
    );
    assert.equal(value.implementationSha256, sha256(value.implementation));
  }
});

test('append-only implementation registry replays actual v1 bytes when actual v2 is active', async (t) => {
  const graph = await validViewGraph(t);
  const versionedOwner = (contract, version) => sealRecord({
    ...contract,
    version,
    implementationSha256: sha256({
      fixture: 'persisted-overview-owner', kind: contract.kind, version
    }),
    contractSha256: undefined
  }, 'contractSha256');
  const rendererV1 = PERSISTED_OVERVIEW_RENDERER_CONTRACT;
  const validatorV1 = PERSISTED_OVERVIEW_VALIDATOR_CONTRACT;
  const rendererV2 = versionedOwner(rendererV1, 2);
  const validatorV2 = versionedOwner(validatorV1, 2);
  let v1Replays = 0;
  let v2Replays = 0;
  const registry = createPersistedViewImplementationRegistry({
    activeWriterId: 'v2',
    entries: [
      {
        id: 'v1', version: 1, rendererContract: rendererV1,
        validatorContract: validatorV1,
        replay: (input) => {
          v1Replays += 1;
          return verifyPersistedOverviewCandidateV1(input);
        }
      },
      {
        id: 'v2', version: 2, rendererContract: rendererV2,
        validatorContract: validatorV2,
        // This fixture represents a separately registered compatible v2 executable. The active
        // pointer must not affect lookup of exact retained v1 owner bytes.
        replay: (input) => {
          v2Replays += 1;
          return verifyPersistedOverviewCandidateV1(input);
        }
      }
    ]
  });
  assert.equal(registry.activeWriter.id, 'v2');
  const replayV1 = registry.replay({
    ...graph.replayInput,
    rendererContract: rendererV1,
    validatorContract: validatorV1
  });
  assert.equal(replayV1.content, graph.renderedObject.bytes);
  assert.equal(v1Replays, 1);
  assert.equal(v2Replays, 0);

  const replayV2 = registry.replay({
    ...graph.replayInput,
    rendererContract: rendererV2,
    validatorContract: validatorV2
  });
  assert.equal(replayV2.content, graph.renderedObject.bytes);
  assert.equal(v1Replays, 1);
  assert.equal(v2Replays, 1);

  const unknown = sealRecord({
    ...rendererV1, implementationSha256: sha256({ unknown: true }), contractSha256: undefined
  }, 'contractSha256');
  assert.throws(
    () => registry.resolveRenderer(unknown),
    (error) => error?.code === 'WMP_OWNER_IMPLEMENTATION_UNAVAILABLE'
  );
  assert.throws(
    () => registry.replay({ rendererContract: rendererV1, validatorContract: validatorV2 }),
    (error) => error?.code === 'WMP_OWNER_IMPLEMENTATION_UNAVAILABLE'
  );
});

test('exact owner lookup rejects migration-shaped bytes before implementation dispatch', () => {
  for (const [contract, validate] of [
    [PERSISTED_OVERVIEW_RENDERER_CONTRACT, validateWorldModelRendererContract],
    [PERSISTED_OVERVIEW_VALIDATOR_CONTRACT, validateWorldModelValidatorContract]
  ]) {
    const projected = sealRecord({
      ...contract,
      schemaVersion: 2,
      contractSha256: undefined
    }, 'contractSha256');
    assert.throws(
      () => validate(projected),
      (error) => error?.code === 'WMB_CONTRACT_INVALID',
      contract.kind
    );
  }
});
