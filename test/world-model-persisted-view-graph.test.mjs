import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  materializePersistedWorldModelViews, planPersistedWorldModelViews
} from '../src/world-model/history/saved-view-publication.mjs';
import {
  preparePersistedStoryGrounding, replayPersistedStoryGrounding
} from '../src/world-model/history/grounding-packet.mjs';
import {
  composePersistedGroundingPacketV1, PERSISTED_GROUNDING_SEPARATOR_V1
} from '../src/world-model/history/persisted-grounding-composer-v1.mjs';
import {
  createPersistedGroundingImplementationRegistry
} from '../src/world-model/history/persisted-grounding-implementation-registry.mjs';
import {
  PERSISTED_GROUNDING_COMPOSER_CONTRACT,
  PERSISTED_GROUNDING_COMPOSER_CONTRACT_SHA256,
  PERSISTED_GROUNDING_COMPOSER_IMPLEMENTATION_SHA256
} from '../src/world-model/history/persisted-grounding-owner.mjs';
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
    root, binding, objects, receiptObject, renderedObject, scopeManifest,
    model: { binding: built.binding, objects: built.objects },
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

test('owned saved-view service materializes full and brief views as one admitted byte-only closure', async (t) => {
  const graph = await validViewGraph(t);
  const result = materializePersistedWorldModelViews({
    model: graph.model,
    views: ['development', 'repository.testing@1'],
    variants: ['brief', 'full']
  });
  assert.equal(result.status, 'materialized');
  assert.equal(result.measurementPolicy, 'exact-bytes-v1');
  assert.equal(result.views.length, 4);
  assert.deepEqual(result.views.map((entry) => `${entry.reference}:${entry.variant}`), [
    'repository.development@1:brief',
    'repository.development@1:full',
    'repository.testing@1:brief',
    'repository.testing@1:full'
  ]);
  assert.equal(result.bindings.every((entry) => (
    entry.inputs.tokenizerSha256 === null
      && entry.measurement.tokens === null
      && entry.measurement.tokenizerSha256 === null
  )), true);
  assert.equal(result.views.every((entry) => (
    /^wmp-view:sha256:[a-f0-9]{64}$/.test(entry.expansionHandle)
  )), true);
  assert.equal(Object.keys(result.stagedHistory.historyAdditions).some((entry) => (
    entry.includes('/models/')
  )), true);
  assert.equal(Object.keys(result.stagedHistory.historyAdditions).filter((entry) => (
    entry.includes('/views/')
  )).length, 4);
});

test('saved-view planner derives the materializer exact keys without rendering or side effects', async (t) => {
  const graph = await validViewGraph(t);
  const options = {
    model: graph.model,
    views: ['development', 'repository.testing@1'],
    variants: ['brief', 'full']
  };
  const planned = planPersistedWorldModelViews(options);
  const materialized = materializePersistedWorldModelViews(options);

  assert.equal(planned.status, 'planned');
  assert.deepEqual(planned.views.map(({ reference, variant, format, viewKey }) => ({
    reference, variant, format, viewKey
  })), materialized.views.map(({ reference, variant, format, viewKey }) => ({
    reference, variant, format, viewKey
  })));
  assert.deepEqual(planned.execution, {
    renders: 0, modelCalls: 0, astCalls: 0, cacheWrites: 0, publications: 0
  });
  assert.equal(Object.hasOwn(planned, 'objects'), false);
  assert.equal(Object.hasOwn(planned, 'historyAdditions'), false);
});

test('owned saved-view service fails closed for token measurement and caller-supplied bytes', async (t) => {
  const graph = await validViewGraph(t);
  assert.throws(
    () => materializePersistedWorldModelViews({
      model: graph.model,
      views: ['development'],
      tokenizer: { id: 'approximate-provider-tokenizer' }
    }),
    (error) => error?.code === 'WMP_TOKENIZER_OWNER_UNAVAILABLE'
  );
  assert.throws(
    () => materializePersistedWorldModelViews({
      model: graph.model,
      views: ['development'],
      renderedBytes: '# forged caller bytes\n'
    }),
    (error) => error?.code === 'WMP_VIEW_MATERIALIZATION_INVALID'
      && error?.details?.unsupported?.includes('renderedBytes')
  );
  const mismatchedRecord = structuredClone(graph.model);
  mismatchedRecord.objects[0].record = { forged: 'caller-side parsed record' };
  assert.throws(
    () => materializePersistedWorldModelViews({
      model: mismatchedRecord, views: ['development']
    }),
    (error) => error?.code === 'WMP_INTEGRITY_FAILED'
  );
});

test('successor grounding packet replays exact original saved-view bytes after source changes', async (t) => {
  const graph = await validViewGraph(t);
  const saved = materializePersistedWorldModelViews({
    model: graph.model,
    views: ['development', 'repository.testing@1'],
    variants: ['brief']
  });
  const repositoryDomainSha256 = saved.modelBinding.inputs.repositoryDomainSha256;
  const prepared = preparePersistedStoryGrounding({
    activation: 'story',
    subject: {
      repositoryDomainSha256,
      workId: 'WMP-STORY', workflowInstanceId: 'WMP-STORY',
      phase: 'implementation', generation: 1
    },
    authority: {
      repositoryDomainSha256,
      stateRef: 'refs/remotes/origin/state', authorityCommit: '1'.repeat(40),
      repositoryIdentitySha256: sha256({ fixture: 'state-remote' })
    },
    savedViews: saved,
    viewKeys: saved.views.map((entry) => entry.viewKey),
    maximumBytes: 128 * 1024
  });
  assert.equal(prepared.status, 'composed');
  assert.equal(prepared.authorityProven, false);
  assert.equal(prepared.packet.kind, 'world-model-grounding-packet');
  assert.equal(prepared.packet.composition.ordering, 'explicit-order-v1');
  assert.equal(prepared.packet.budget.mode, 'bytes');
  assert.equal(prepared.packet.budget.tokenizerSha256, null);
  assert.deepEqual(prepared.packet.views.map((entry) => entry.order), [0, 1]);
  assert.equal(prepared.files[0].path.endsWith('.packet.json'), true);
  assert.equal(prepared.files[1].path.endsWith('.md'), true);

  // Mutable application/source bytes can move after the Story captured its packet. Replay consumes
  // only the retained exact closure and must reproduce the original packet byte-for-byte.
  await writeFile(path.join(graph.root, 'README.md'), '# source changed after packet capture\n');
  const replayed = replayPersistedStoryGrounding({
    packet: prepared.packet,
    objects: prepared.objects
  });
  assert.equal(replayed.status, 'replayed');
  assert.equal(replayed.authorityProven, false);
  assert.equal(replayed.sha256, prepared.packet.renderedBlock.sha256);
  assert.equal(replayed.bytes, prepared.packet.renderedBlock.bytes);
  assert.equal(replayed.content, prepared.files[1].content);
});

test('successor grounding derives identity from retained saved-view bytes and rejects metadata contradictions', async (t) => {
  const graph = await validViewGraph(t);
  const saved = materializePersistedWorldModelViews({
    model: graph.model,
    views: ['development', 'repository.testing@1'],
    variants: ['brief']
  });
  const repositoryDomainSha256 = saved.modelBinding.inputs.repositoryDomainSha256;
  const base = {
    activation: 'story',
    subject: {
      repositoryDomainSha256, workId: 'WMP-STORY', workflowInstanceId: 'WMP-STORY',
      phase: 'implementation', generation: 1
    },
    authority: {
      repositoryDomainSha256, stateRef: 'refs/heads/state',
      authorityCommit: '1'.repeat(40), repositoryIdentitySha256: null
    },
    viewKeys: saved.views.map((entry) => entry.viewKey),
    maximumBytes: 128 * 1024
  };
  const malformed = (change) => {
    const copy = structuredClone(saved);
    change(copy);
    return copy;
  };
  for (const [label, changed, code] of [
    ['model key', malformed((copy) => { copy.modelKey = sha256({ forged: 'model-key' }); }),
      'WMP_GRAPH_MISMATCH'],
    ['view reference', malformed((copy) => { copy.views[0].reference = 'repository.security@1'; }),
      'WMP_GRAPH_MISMATCH'],
    ['binding digest', malformed((copy) => { copy.views[0].bindingSha256 = sha256({ forged: 'binding' }); }),
      'WMP_GRAPH_MISMATCH'],
    ['rendered byte count', malformed((copy) => { copy.views[0].bytes += 1; }),
      'WMP_GRAPH_MISMATCH'],
    ['rendered reference', malformed((copy) => { copy.views[0].renderedRef = copy.views[1].renderedRef; }),
      'WMP_GRAPH_MISMATCH'],
    ['expansion handle', malformed((copy) => {
      copy.views[0].expansionHandle = `wmp-view:${sha256({ forged: 'handle' })}`;
    }), 'WMP_GROUNDING_EXPANSION_HANDLE_MISMATCH'],
    ['duplicate view key', malformed((copy) => { copy.views[1].viewKey = copy.views[0].viewKey; }),
      'WMP_IDENTITY_CONFLICT'],
    ['binding roster', malformed((copy) => { copy.bindings[0] = copy.bindings[1]; }),
      'WMP_IDENTITY_CONFLICT'],
    ['missing roster identity', malformed((copy) => {
      copy.bindings[0] = { bindingSha256: sha256({ forged: 'roster-entry' }) };
    }), 'WMP_GRAPH_MISMATCH'],
    ['missing binding', malformed((copy) => { delete copy.views[0].binding; }),
      'WMP_GROUNDING_NOT_READY'],
    ['unknown metadata', malformed((copy) => { copy.views[0].untrusted = true; }),
      'WMP_GROUNDING_NOT_READY']
  ]) {
    assert.throws(
      () => preparePersistedStoryGrounding({ ...base, savedViews: changed }),
      (error) => error?.code === code,
      label
    );
  }
  const differentDomain = sha256({ forged: 'repository-domain' });
  assert.throws(
    () => preparePersistedStoryGrounding({
      ...base,
      subject: { ...base.subject, repositoryDomainSha256: differentDomain },
      authority: { ...base.authority, repositoryDomainSha256: differentDomain },
      savedViews: saved
    }),
    (error) => error?.code === 'WMP_GRAPH_MISMATCH'
  );

  const substitutedModelCapture = structuredClone(saved);
  const firstView = substitutedModelCapture.views[0];
  const originalViewInputs = substitutedModelCapture.objects.find(
    (entry) => entry.ref.sha256 === firstView.binding.viewInputsRef.sha256
  );
  assert.ok(originalViewInputs);
  const alternateModelBindingRef = {
    ...substitutedModelCapture.modelBindingRef,
    sha256: sha256({ alternate: 'model-binding-with-equal-payload-claim' })
  };
  const changedViewInputs = sealRecord({
    ...originalViewInputs.record,
    captures: originalViewInputs.record.captures.map((capture) => (
      capture.role === 'model-binding'
        ? { ...capture, objectRef: alternateModelBindingRef }
        : capture
    )),
    inputManifestSha256: undefined
  }, 'inputManifestSha256');
  const changedViewInputsObject = retained(
    changedViewInputs, 'view-inputs', 'world-model-view-inputs'
  );
  const changedBinding = createWmpViewBinding({
    ...firstView.binding,
    inputs: {
      ...firstView.binding.inputs,
      viewInputsSha256: changedViewInputs.inputManifestSha256
    },
    viewInputsRef: changedViewInputsObject.ref,
    viewKey: undefined,
    bindingSha256: undefined
  });
  substitutedModelCapture.objects = substitutedModelCapture.objects
    .filter((entry) => entry.ref.sha256 !== originalViewInputs.ref.sha256)
    .concat(changedViewInputsObject);
  substitutedModelCapture.bindings = substitutedModelCapture.bindings.map((binding) => (
    binding.bindingSha256 === firstView.bindingSha256 ? changedBinding : binding
  ));
  substitutedModelCapture.views[0] = {
    ...firstView,
    viewKey: changedBinding.viewKey,
    bindingSha256: changedBinding.bindingSha256,
    binding: changedBinding
  };
  assert.throws(
    () => preparePersistedStoryGrounding({
      ...base,
      savedViews: substitutedModelCapture,
      viewKeys: substitutedModelCapture.views.map((entry) => entry.viewKey)
    }),
    (error) => error?.code === 'WMP_GRAPH_MISMATCH'
      && error?.details?.relation === 'grounding-view.model-binding-capture'
  );
});

test('successor grounding stays default-off and refuses missing owners, token mode, and tampering', async (t) => {
  let touched = false;
  const disabled = { activation: 'disabled' };
  Object.defineProperty(disabled, 'savedViews', {
    enumerable: true,
    get() { touched = true; throw new Error('must not inspect disabled history'); }
  });
  assert.deepEqual(preparePersistedStoryGrounding(disabled), {
    status: 'disabled', activation: 'disabled', files: [],
    execution: {
      modelReads: 0, viewReads: 0, renders: 0, modelCalls: 0, astCalls: 0, writes: 0
    }
  });
  assert.equal(touched, false);

  const graph = await validViewGraph(t);
  const saved = materializePersistedWorldModelViews({
    model: graph.model, views: ['development'], variants: ['brief']
  });
  const repositoryDomainSha256 = saved.modelBinding.inputs.repositoryDomainSha256;
  const base = {
    activation: 'story',
    subject: {
      repositoryDomainSha256, workId: 'WMP-STORY', workflowInstanceId: 'WMP-STORY',
      phase: 'implementation', generation: 1
    },
    authority: {
      repositoryDomainSha256, stateRef: 'refs/heads/state',
      authorityCommit: '1'.repeat(40), repositoryIdentitySha256: null
    },
    savedViews: saved, viewKeys: [saved.views[0].viewKey], maximumBytes: 128 * 1024
  };
  assert.throws(
    () => preparePersistedStoryGrounding({ ...base, tokenizer: { id: 'approximate' } }),
    (error) => error?.code === 'WMP_TOKENIZER_OWNER_UNAVAILABLE'
  );
  assert.throws(
    () => preparePersistedStoryGrounding({ ...base, savedViews: null }),
    (error) => error?.code === 'WMP_GROUNDING_NOT_READY'
  );
  const prepared = preparePersistedStoryGrounding(base);
  const changed = prepared.objects.map((entry) => (
    entry.ref.sha256 === prepared.packet.views[0].renderedRef.sha256
      ? { ...entry, bytes: `${entry.bytes}\nforged` }
      : entry
  ));
  assert.throws(
    () => replayPersistedStoryGrounding({ packet: prepared.packet, objects: changed }),
    (error) => error?.code === 'WMP_INTEGRITY_FAILED'
  );
  const reordered = sealRecord({
    ...prepared.packet,
    views: [{ ...prepared.packet.views[0], order: 1 }],
    groundingSha256: undefined
  }, 'groundingSha256');
  assert.throws(
    () => replayPersistedStoryGrounding({ packet: reordered, objects: prepared.objects }),
    (error) => error?.code === 'WMP_GROUNDING_ORDER_INVALID'
  );
  const wrongComposer = sealRecord({
    ...prepared.packet,
    composition: {
      ...prepared.packet.composition,
      separatorSha256: sha256({ forged: 'separator' })
    },
    groundingSha256: undefined
  }, 'groundingSha256');
  assert.throws(
    () => replayPersistedStoryGrounding({ packet: wrongComposer, objects: prepared.objects }),
    (error) => error?.code === 'WMP_GROUNDING_COMPOSER_UNSUPPORTED'
  );
  const wrongAuthority = sealRecord({
    ...prepared.packet,
    authority: {
      ...prepared.packet.authority,
      repositoryDomainSha256: sha256({ forged: 'domain' })
    },
    groundingSha256: undefined
  }, 'groundingSha256');
  assert.throws(
    () => replayPersistedStoryGrounding({ packet: wrongAuthority, objects: prepared.objects }),
    (error) => error?.code === 'WMP_CONTRACT_INVALID'
  );
  const wrongBinding = sealRecord({
    ...prepared.packet,
    views: [{
      ...prepared.packet.views[0],
      bindingRef: prepared.packet.model.bindingRef
    }],
    groundingSha256: undefined
  }, 'groundingSha256');
  assert.throws(
    () => replayPersistedStoryGrounding({ packet: wrongBinding, objects: prepared.objects }),
    (error) => error?.code === 'WMP_OBJECT_ROLE_MISMATCH'
  );
  const wrongExpansionHandle = sealRecord({
    ...prepared.packet,
    views: [{
      ...prepared.packet.views[0],
      expansionHandle: `wmp-view:${sha256({ forged: 'expansion-handle' })}`
    }],
    groundingSha256: undefined
  }, 'groundingSha256');
  assert.throws(
    () => replayPersistedStoryGrounding({
      packet: wrongExpansionHandle, objects: prepared.objects
    }),
    (error) => error?.code === 'WMP_GROUNDING_EXPANSION_HANDLE_MISMATCH'
  );

  const retainedViewBinding = prepared.objects.find(
    (entry) => entry.ref.sha256 === prepared.packet.views[0].bindingRef.sha256
  );
  const retainedViewInputs = prepared.objects.find(
    (entry) => entry.ref.sha256 === retainedViewBinding.record.viewInputsRef.sha256
  );
  const alternateModelBindingRef = {
    ...prepared.packet.model.bindingRef,
    sha256: sha256({ alternate: 'replay-model-binding-with-equal-payload-claim' })
  };
  const replayViewInputs = sealRecord({
    ...retainedViewInputs.record,
    captures: retainedViewInputs.record.captures.map((capture) => (
      capture.role === 'model-binding'
        ? { ...capture, objectRef: alternateModelBindingRef }
        : capture
    )),
    inputManifestSha256: undefined
  }, 'inputManifestSha256');
  const replayViewInputsObject = retained(
    replayViewInputs, 'view-inputs', 'world-model-view-inputs'
  );
  const replayViewBinding = createWmpViewBinding({
    ...retainedViewBinding.record,
    inputs: {
      ...retainedViewBinding.record.inputs,
      viewInputsSha256: replayViewInputs.inputManifestSha256
    },
    viewInputsRef: replayViewInputsObject.ref,
    viewKey: undefined,
    bindingSha256: undefined
  });
  const replayViewBindingObject = retained(
    replayViewBinding, 'view-binding', 'world-model-view-binding'
  );
  const crossModelPacket = sealRecord({
    ...prepared.packet,
    views: [{
      ...prepared.packet.views[0],
      viewKey: replayViewBinding.viewKey,
      bindingRef: replayViewBindingObject.ref
    }],
    groundingSha256: undefined
  }, 'groundingSha256');
  const crossModelObjects = prepared.objects.filter((entry) => (
    entry.ref.sha256 !== retainedViewInputs.ref.sha256
      && entry.ref.sha256 !== retainedViewBinding.ref.sha256
  )).concat(replayViewInputsObject, replayViewBindingObject);
  assert.throws(
    () => replayPersistedStoryGrounding({
      packet: crossModelPacket, objects: crossModelObjects
    }),
    (error) => error?.code === 'WMP_GRAPH_MISMATCH'
      && error?.details?.relation === 'grounding-view.model-binding-capture'
  );

  const packetSchema = JSON.parse(await readFile(
    new URL('../schemas/world-model-grounding-packet.schema.json', import.meta.url), 'utf8'
  ));
  const schemaMaximum = packetSchema.$defs.budget.properties.maximum.maximum;
  assert.equal(schemaMaximum, 32 * 1024 * 1024);
  const maximumPacket = sealRecord({
    ...prepared.packet,
    budget: { ...prepared.packet.budget, maximum: schemaMaximum },
    groundingSha256: undefined
  }, 'groundingSha256');
  assert.equal(replayPersistedStoryGrounding({
    packet: maximumPacket, objects: prepared.objects
  }).status, 'replayed');
  const oversizedMaximumPacket = sealRecord({
    ...prepared.packet,
    budget: { ...prepared.packet.budget, maximum: schemaMaximum + 1 },
    groundingSha256: undefined
  }, 'groundingSha256');
  assert.throws(
    () => replayPersistedStoryGrounding({
      packet: oversizedMaximumPacket, objects: prepared.objects
    }),
    (error) => error?.code === 'WMP_CONTRACT_LIMIT'
  );
});

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

test('persisted grounding composer contract is frozen and dispatch remains append-only', () => {
  assert.equal(
    PERSISTED_GROUNDING_COMPOSER_CONTRACT_SHA256,
    'sha256:be819f7b1624949088dcb3f6262f5f631dd26f1f53c381798c43d4bc0dbc138f'
  );
  assert.equal(
    PERSISTED_GROUNDING_COMPOSER_CONTRACT.contractSha256,
    PERSISTED_GROUNDING_COMPOSER_CONTRACT_SHA256
  );
  assert.equal(
    PERSISTED_GROUNDING_COMPOSER_CONTRACT.implementationSha256,
    PERSISTED_GROUNDING_COMPOSER_IMPLEMENTATION_SHA256
  );
  const composerV2 = sealRecord({
    ...PERSISTED_GROUNDING_COMPOSER_CONTRACT,
    version: 2,
    implementationSha256: sha256({ fixture: 'persisted-grounding-owner', version: 2 }),
    contractSha256: undefined
  }, 'contractSha256');
  let v1Replays = 0;
  let v2Replays = 0;
  const registry = createPersistedGroundingImplementationRegistry({
    activeWriterId: 'v2',
    entries: [
      {
        id: 'v1', version: 1,
        composerContract: PERSISTED_GROUNDING_COMPOSER_CONTRACT,
        replay: (entries) => {
          v1Replays += 1;
          return composePersistedGroundingPacketV1(entries);
        }
      },
      {
        id: 'v2', version: 2, composerContract: composerV2,
        replay: (entries) => {
          v2Replays += 1;
          return composePersistedGroundingPacketV1(entries);
        }
      }
    ]
  });
  const expansionHandle = `wmp-view:${sha256({ fixture: 'expansion' })}`;
  const bytes = `# Retained view\n\n- Expansion: ${expansionHandle}\n`;
  const entries = [{
    order: 0, renderedSha256: sha256(Buffer.from(bytes, 'utf8')),
    expansionHandle, bytes
  }];
  assert.equal(registry.activeWriter.id, 'v2');
  assert.equal(registry.replay({
    composerContract: PERSISTED_GROUNDING_COMPOSER_CONTRACT, entries
  }).content, `${bytes}${PERSISTED_GROUNDING_SEPARATOR_V1}`);
  assert.equal(v1Replays, 1);
  assert.equal(v2Replays, 0);
  assert.equal(
    registry.replay({ composerContract: composerV2, entries }).content,
    `${bytes}${PERSISTED_GROUNDING_SEPARATOR_V1}`
  );
  assert.equal(v1Replays, 1);
  assert.equal(v2Replays, 1);
  const unknown = sealRecord({
    ...PERSISTED_GROUNDING_COMPOSER_CONTRACT,
    implementationSha256: sha256({ unknown: true }), contractSha256: undefined
  }, 'contractSha256');
  assert.throws(
    () => registry.resolve(unknown),
    (error) => error?.code === 'WMP_OWNER_IMPLEMENTATION_UNAVAILABLE'
  );

  const moderateBytes = `${bytes}${'x'.repeat(140 * 1024)}`;
  const aggregate = Array.from({ length: 256 }, (_, order) => ({
    order,
    renderedSha256: sha256(Buffer.from(moderateBytes, 'utf8')),
    expansionHandle,
    bytes: moderateBytes
  }));
  assert.throws(
    () => composePersistedGroundingPacketV1(aggregate),
    (error) => error?.code === 'WMP_CONTRACT_LIMIT'
  );
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
