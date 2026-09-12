import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { run } from '../src/util.mjs';
import { canonicalJson, sealRecord, sha256 } from '../src/world-model/canonicalize.mjs';
import { runDeterministicRegistration } from '../src/world-model/extract/runner.mjs';
import {
  createWmpHandoff, createWmpViewBinding, createWmpViewInputs
} from '../src/world-model/history/contracts.mjs';
import {
  stageWorldModelHistoryPublication, validateStagedWorldModelHistory
} from '../src/world-model/history/publication.mjs';
import {
  resolvePersistedWorldModel, resolveWorldModelHistoryAuthority,
  readWorldModelHistoryObject, resolvePersistedWorldModelView
} from '../src/world-model/history/store.mjs';
import {
  worldModelHistoryHandoffPath, worldModelHistoryModelPath, worldModelHistoryObjectPath,
  worldModelHistoryViewPath
} from '../src/world-model/history/paths.mjs';
import {
  PERSISTED_OVERVIEW_RENDERER
} from '../src/world-model/materialize/overview-view.mjs';
import {
  createWorldModelConsumerProfile, createWorldModelOutputBudget
} from '../src/world-model/plan.mjs';
import {
  resolveWmpOverviewViewContract, WMP_OVERVIEW_VIEW_REGISTRY
} from '../src/world-model/registry/views.mjs';
import { createScopeManifest } from '../src/world-model/scope/manifest.mjs';
import { createExactSourceSnapshotAtRevision } from '../src/world-model/source/snapshot.mjs';

function git(root, ...args) {
  return run('git', args, { cwd: root });
}

function renderedObject(contents) {
  const bytes = Buffer.from(contents, 'utf8');
  return Object.freeze({
    role: 'rendered-view', family: null, mediaType: 'text/markdown',
    sha256: sha256(bytes), bytes: bytes.length
  });
}

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmp-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'WMP History');
  git(root, 'config', 'user.email', 'wmp-history@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# application\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-m', 'application root');
  return root;
}

function retained(record, role, family, mediaType = 'application/json') {
  const text = typeof record === 'string' ? record : canonicalJson(record);
  const bytes = Buffer.from(text, 'utf8');
  return {
    ref: Object.freeze({
      role, family, mediaType, sha256: sha256(bytes), bytes: bytes.length
    }),
    text
  };
}

async function mismatchedViewHistory(t) {
  const root = await repository(t);
  const scopeManifest = createScopeManifest({
    capabilityId: 'view-graph-fixture', allowedPaths: ['**']
  });
  const contract = resolveWmpOverviewViewContract('repository.development@1');
  const registration = runDeterministicRegistration({
    root, scopeManifest,
    requestedViews: ['repository.development@1'],
    viewRegistry: WMP_OVERVIEW_VIEW_REGISTRY
  });
  const selectedLedger = registration.viewFactLedgers[0];
  const consumer = createWorldModelConsumerProfile();
  const outputBudget = createWorldModelOutputBudget([contract]);
  const contractObject = retained(contract, 'view-contract', 'world-model-view-contract');
  const consumerObject = retained(
    consumer, 'consumer-profile', 'world-model-consumer-profile'
  );
  const budgetObject = retained(
    outputBudget, 'output-budget', 'world-model-output-budget'
  );
  const selectedLedgerObject = retained(
    selectedLedger, 'selected-fact-ledger', 'world-model-view-fact-ledger'
  );
  const rendererObject = retained(
    PERSISTED_OVERVIEW_RENDERER,
    'renderer-contract',
    // No renderer-contract family exists yet. This deliberately remains unreadable semantically;
    // the reader may bind its exact bytes but must ultimately fail closed on that missing owner.
    'world-model-view-contract'
  );
  const validatorDefinition = Object.freeze({
    kind: 'wmp/validator-contract', version: 1, algorithm: 'fixture-validator'
  });
  const validatorObject = retained(
    validatorDefinition, 'validator-contract', 'world-model-view-contract'
  );
  const modelPayloadSha256 = sha256({ fixture: 'model-payload' });
  const selection = {
    kind: 'wmp/view-selection', version: 1,
    storyScopeSha256: null, querySha256: null, factIds: [],
    traversal: { maximumFacts: 1000, maximumEdges: 1000, maximumDepth: 8 }
  };
  const viewInputs = createWmpViewInputs({
    modelPayloadSha256,
    captures: [{
      role: 'output-budget', subject: contract.id, status: 'available',
      objectRef: budgetObject.ref, reason: null
    }],
    viewContractRef: contractObject.ref,
    consumerProfileRef: consumerObject.ref,
    selection,
    comparisonRef: null,
    evidenceCutRef: null
  });
  const viewInputsObject = retained(
    viewInputs, 'view-inputs', 'world-model-view-inputs'
  );
  const renderedObjectValue = retained(
    '# Stable persisted view\n', 'rendered-view', null, 'text/markdown'
  );
  const receipt = sealRecord({
    schemaVersion: 1,
    kind: 'world-model-view-validation-receipt',
    viewId: contract.id,
    viewVersion: contract.version,
    candidateSha256: renderedObjectValue.ref.sha256,
    candidateSchemaSha256: sha256({ fixture: 'candidate-schema' }),
    viewSpecSha256: contract.contractSha256,
    factLedgerSha256: selectedLedger.ledgerSha256,
    scopeSha256: scopeManifest.scopeSha256,
    checks: [{ id: 'fixture', status: 'pass' }],
    status: 'passed',
    validatorSha256: validatorObject.ref.sha256
  }, 'receiptSha256');
  const receiptObject = retained(
    receipt, 'validator-receipt', 'world-model-view-validation-receipt'
  );
  const baseInputs = {
    identityVersion: 1,
    modelPayloadSha256,
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
  const cases = [
    ['view-inputs', { viewInputsSha256: sha256({ mismatch: 'view-inputs' }) }],
    ['model-payload', { modelPayloadSha256: sha256({ mismatch: 'model-payload' }) }],
    ['view-contract', { viewContractSha256: sha256({ mismatch: 'view-contract' }) }],
    ['selection', { selectionSha256: sha256({ mismatch: 'selection' }) }],
    ['renderer', { rendererSha256: sha256({ mismatch: 'renderer' }) }],
    ['validator', { validatorSha256: sha256({ mismatch: 'validator' }) }]
  ];
  const objects = [
    contractObject, consumerObject, budgetObject, selectedLedgerObject, rendererObject,
    validatorObject, viewInputsObject, renderedObjectValue, receiptObject
  ];
  const historyFiles = Object.fromEntries(objects.map((object) => [
    worldModelHistoryObjectPath(object.ref.sha256), object.text
  ]));
  const bindings = [];
  for (const [label, override] of cases) {
    const binding = createWmpViewBinding({
      inputs: { ...baseInputs, ...override },
      viewInputsRef: viewInputsObject.ref,
      selectedFactLedgerRef: selectedLedgerObject.ref,
      rendererContractRef: rendererObject.ref,
      validatorContractRef: validatorObject.ref,
      status: 'complete',
      gaps: [],
      selection: {
        mode: 'inline',
        selectedFactIds: selectedLedger.facts.map((fact) => fact.id).sort(),
        omittedFactIds: [],
        manifestRef: null
      },
      rendered: renderedObjectValue.ref,
      measurement: {
        bytes: renderedObjectValue.ref.bytes, tokens: null, tokenizerSha256: null
      },
      validatorReceiptRef: receiptObject.ref
    });
    const bindingText = canonicalJson(binding);
    const bindingDigest = sha256(Buffer.from(bindingText, 'utf8'));
    historyFiles[worldModelHistoryViewPath(binding.viewKey)] = bindingText;
    historyFiles[worldModelHistoryObjectPath(bindingDigest)] = bindingText;
    bindings.push({ label, binding });
  }
  for (const [relative, contents] of Object.entries(historyFiles)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents);
  }
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'persist mismatched view graph fixtures');
  return { root, authorityCommit: git(root, 'rev-parse', 'HEAD').stdout.trim(), bindings };
}

test('history staging emits exact additive bytes with absent-or-identical preconditions', () => {
  const contents = '# Persisted view\n\nExact deterministic content.\n';
  const ref = renderedObject(contents);
  const staged = stageWorldModelHistoryPublication({ objects: [{ ref, bytes: contents }] });
  const target = worldModelHistoryObjectPath(ref.sha256);

  assert.deepEqual(Object.keys(staged.historyAdditions), [target]);
  assert.equal(staged.historyAdditions[target], contents);
  assert.deepEqual(staged.historyExpectations[target], {
    condition: 'absent-or-identical', sha256: ref.sha256,
    bytes: ref.bytes, gitMode: '100644'
  });
  assert.equal(staged.exactBlobSha256[target], ref.sha256);
  assert.deepEqual(staged.summary, { paths: 1, bytes: ref.bytes });
});

test('history staging refuses digest drift before any state writer is called', () => {
  const contents = '# Persisted view\n';
  const ref = renderedObject(contents);
  assert.throws(
    () => stageWorldModelHistoryPublication({
      objects: [{ ref, bytes: `${contents}changed\n` }]
    }),
    (error) => error?.code === 'WMP_INTEGRITY_FAILED'
  );
});

test('family-less retained objects allow only exact rendered roles', () => {
  const contents = '# inert bytes\n';
  const bytes = Buffer.from(contents, 'utf8');
  const ref = {
    role: 'rendered-instructions', family: null, mediaType: 'text/markdown',
    sha256: sha256(bytes), bytes: bytes.length
  };
  assert.throws(
    () => stageWorldModelHistoryPublication({ objects: [{ ref, bytes }] }),
    (error) => error?.code === 'WMP_OBJECT_FAMILY_REQUIRED'
      && error?.details?.allowedRoles?.includes('rendered-view')
      && !error?.details?.allowedRoles?.includes('rendered-instructions')
  );
});

test('retained JSON is canonical before MIG and must pass its semantic owner', async (t) => {
  const root = await repository(t);
  const commit = git(root, 'rev-parse', 'HEAD').stdout.trim();
  const snapshot = createExactSourceSnapshotAtRevision(root, commit, {
    subjectId: 'retained-owner-fixture'
  });
  const canonical = canonicalJson(snapshot);
  const exact = Buffer.from(canonical, 'utf8');
  const sourceRef = {
    role: 'source-snapshot', family: 'world-model-source-snapshot',
    mediaType: 'application/json', sha256: sha256(exact), bytes: exact.length
  };
  const staged = stageWorldModelHistoryPublication({
    objects: [{ ref: sourceRef, bytes: exact }]
  });
  for (const [relative, contents] of Object.entries(staged.historyAdditions)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents);
  }
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'retain semantically owned source snapshot');
  const authorityCommit = git(root, 'rev-parse', 'HEAD').stdout.trim();
  assert.equal(readWorldModelHistoryObject(root, {
    authorityCommit, authorityRef: 'refs/heads/main', ref: sourceRef
  }).record.sourceManifestSha256, snapshot.sourceManifestSha256);
  assert.throws(
    () => readWorldModelHistoryObject(root, {
      authorityCommit, authorityRef: 'refs/heads/main',
      ref: { ...sourceRef, role: 'repository-domain' }
    }),
    (error) => error?.code === 'WMP_OBJECT_OWNER_UNAVAILABLE'
  );

  const noncanonical = Buffer.from(`${JSON.stringify(snapshot)}\n`, 'utf8');
  assert.throws(
    () => stageWorldModelHistoryPublication({
      objects: [{
        ref: { ...sourceRef, sha256: sha256(noncanonical), bytes: noncanonical.length },
        bytes: noncanonical
      }]
    }),
    (error) => error?.code === 'WMP_CANONICAL_BYTES_REQUIRED'
  );

  assert.throws(
    () => stageWorldModelHistoryPublication({
      objects: [{ ref: { ...sourceRef, role: 'repository-domain' }, bytes: exact }]
    }),
    (error) => error?.code === 'WMP_OBJECT_OWNER_UNAVAILABLE'
      && error?.details?.role === 'repository-domain'
  );
});

test('raw staged envelopes accept only closed paths and bind keyed records to their CAS copy', () => {
  const rendered = stageWorldModelHistoryPublication({
    objects: [{ ref: renderedObject('# exact rendered bytes\n'), bytes: '# exact rendered bytes\n' }]
  });
  assert.doesNotThrow(() => validateStagedWorldModelHistory({
    outputDir: 'singularity/world-model', ...rendered
  }));

  const original = Object.keys(rendered.historyAdditions)[0];
  const arbitrary = 'singularity/world-model-history/arbitrary.json';
  assert.throws(
    () => validateStagedWorldModelHistory({
      outputDir: 'singularity/world-model',
      historyDir: rendered.historyDir,
      historyAdditions: { [arbitrary]: rendered.historyAdditions[original] },
      historyExpectations: { [arbitrary]: rendered.historyExpectations[original] },
      exactBlobSha256: { [arbitrary]: rendered.exactBlobSha256[original] }
    }),
    (error) => error?.code === 'WMP_HISTORY_PATH_INVALID'
  );

  const proofBytes = Buffer.from(canonicalJson({ schemaVersion: 1 }), 'utf8');
  const publicationRef = {
    role: 'publication-receipt', family: 'specification-index',
    mediaType: 'application/json', sha256: sha256(proofBytes), bytes: proofBytes.length
  };
  const handoff = createWmpHandoff({
    repositoryDomainSha256: sha256({ repository: 'fixture' }),
    authorityCut: {
      stateRef: 'refs/heads/state', commit: 'a'.repeat(40), publicationRef
    },
    sourceBindingSha256: sha256({ source: 'fixture' }),
    modelBindings: [], viewBindings: [], inputObjects: [], sourceObjects: [], missing: [],
    readerRequirements: [],
    confidentiality: { classification: 'repository-authorized', exportAllowed: false },
    adoption: { required: false, targetRepositoryDomainSha256: null, authorizationRef: null }
  });
  const handoffText = canonicalJson(handoff);
  const handoffBytes = Buffer.from(handoffText, 'utf8');
  const handoffPath = worldModelHistoryHandoffPath(handoff.handoffSha256);
  const expectation = {
    condition: 'absent-or-identical', sha256: sha256(handoffBytes),
    bytes: handoffBytes.length, gitMode: '100644'
  };
  assert.throws(
    () => validateStagedWorldModelHistory({
      outputDir: 'singularity/world-model',
      historyDir: 'singularity/world-model-history',
      historyAdditions: { [handoffPath]: handoffText },
      historyExpectations: { [handoffPath]: expectation },
      exactBlobSha256: { [handoffPath]: expectation.sha256 }
    }),
    (error) => error?.code === 'WMP_INPUT_MISSING'
      && /content-addressed copy/.test(error.message)
  );

  const bindingObjectPath = worldModelHistoryObjectPath(expectation.sha256);
  const wrongKeyPath = worldModelHistoryHandoffPath(`sha256:${'b'.repeat(64)}`);
  assert.throws(
    () => validateStagedWorldModelHistory({
      outputDir: 'singularity/world-model',
      historyDir: 'singularity/world-model-history',
      historyAdditions: {
        [wrongKeyPath]: handoffText,
        [bindingObjectPath]: handoffText
      },
      historyExpectations: {
        [wrongKeyPath]: expectation,
        [bindingObjectPath]: expectation
      },
      exactBlobSha256: {
        [wrongKeyPath]: expectation.sha256,
        [bindingObjectPath]: expectation.sha256
      }
    }),
    (error) => error?.code === 'WMP_INTEGRITY_FAILED'
      && /keyed path/.test(error.message)
  );

  assert.throws(
    () => validateStagedWorldModelHistory({
      outputDir: 'singularity/world-model',
      historyDir: 'singularity/world-model-history',
      historyAdditions: {
        [handoffPath]: handoffText,
        [bindingObjectPath]: handoffText
      },
      historyExpectations: {
        [handoffPath]: expectation,
        [bindingObjectPath]: expectation
      },
      exactBlobSha256: {
        [handoffPath]: expectation.sha256,
        [bindingObjectPath]: expectation.sha256
      }
    }),
    (error) => error?.code === 'WMP_INPUT_MISSING'
      && error?.details?.role === 'publication-receipt'
  );
});

test('persisted object reads are pinned to an exact local authority cut', async (t) => {
  const root = await repository(t);
  const contents = '# Persisted view\n';
  const ref = renderedObject(contents);
  const relative = worldModelHistoryObjectPath(ref.sha256);
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), contents);
  git(root, 'add', relative);
  git(root, 'commit', '-m', 'persist exact view');
  const authorityCommit = git(root, 'rev-parse', 'HEAD').stdout.trim();

  const read = readWorldModelHistoryObject(root, {
    authorityCommit, authorityRef: 'refs/heads/main', ref
  });
  assert.equal(read.authorityCommit, authorityCommit);
  assert.ok(read.bytes.equals(Buffer.from(contents)));
  assert.equal(read.record, null);
  assert.throws(
    () => resolveWorldModelHistoryAuthority(root, 'main', {
      authorityRef: 'refs/heads/main'
    }),
    (error) => error?.code === 'WMP_AUTHORITY_CUT_REQUIRED'
  );

  await writeFile(path.join(root, relative), '# corrupt replacement\n');
  git(root, 'add', relative);
  git(root, 'commit', '-m', 'move branch after selected cut');
  assert.ok(readWorldModelHistoryObject(root, {
    authorityCommit, authorityRef: 'refs/heads/main', ref
  }).bytes.equals(Buffer.from(contents)));
  assert.throws(
    () => readWorldModelHistoryObject(root, {
      authorityCommit: git(root, 'rev-parse', 'HEAD').stdout.trim(),
      authorityRef: 'refs/heads/main',
      ref
    }),
    (error) => error?.code === 'WMP_INTEGRITY_FAILED'
  );
});

test('exact model lookup reports a clean typed miss without building or fetching', async (t) => {
  const root = await repository(t);
  const authorityCommit = git(root, 'rev-parse', 'HEAD').stdout.trim();
  const modelKey = sha256({ model: 'missing' });
  const expectedPath = worldModelHistoryModelPath(modelKey);
  assert.throws(
    () => resolvePersistedWorldModel(root, {
      authorityCommit, authorityRef: 'refs/heads/main', modelKey
    }),
    (error) => error?.code === 'WMP_MODEL_MISSING'
      && error?.details?.path === expectedPath
  );
});

test('a locally available application commit is not accepted as state authority', async (t) => {
  const root = await repository(t);
  git(root, 'switch', '-c', 'application-candidate');
  await writeFile(path.join(root, 'README.md'), '# ungoverned application candidate\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-m', 'application-only commit');
  const applicationCommit = git(root, 'rev-parse', 'HEAD').stdout.trim();

  assert.throws(
    () => resolveWorldModelHistoryAuthority(root, applicationCommit, {
      authorityRef: 'refs/heads/main'
    }),
    (error) => error?.code === 'WMP_AUTHORITY_CUT_NOT_ADMITTED'
  );
});

test('persisted view reads reject every mismatched v1 identity edge before unowned semantics', async (t) => {
  const { root, authorityCommit, bindings } = await mismatchedViewHistory(t);
  for (const { label, binding } of bindings) {
    assert.throws(
      () => resolvePersistedWorldModelView(root, {
        authorityCommit, authorityRef: 'refs/heads/main', viewKey: binding.viewKey
      }),
      (error) => error?.code === 'WMP_GRAPH_MISMATCH',
      label
    );
  }
});
