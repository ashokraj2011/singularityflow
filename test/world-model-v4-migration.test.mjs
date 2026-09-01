import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sha256 } from '../src/world-model/canonicalize.mjs';
import { runDeterministicRegistration } from '../src/world-model/extract/runner.mjs';
import {
  createFactLedger, factIdentityFromRecord
} from '../src/world-model/extract/fact-ledger.mjs';
import {
  augmentRegistrationForLegacyMigration, createWorldModelMigrationReceipt,
  mapLegacyClaimsToRegisteredFacts,
  validateWorldModelMigrationReceipt
} from '../src/world-model/migration/v3-to-v4.mjs';
import {
  LEGACY_WORLD_MODEL_CLASSIFICATION, classifyWorldModelInput, readLegacyWorldModelView,
  worldModelMigrationRequired
} from '../src/world-model/migration/v3-reader.mjs';
import { createScopeManifest } from '../src/world-model/scope/manifest.mjs';
import { BUILTIN_EXTRACTOR_REGISTRY } from '../src/world-model/registry/extractors.mjs';
import {
  BUILTIN_VIEW_REGISTRY, resolveViewContract
} from '../src/world-model/registry/views.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmb-v4-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'tests@example.invalid');
  git(root, 'config', 'user.name', 'WMB Tests');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'service.mjs'), 'export function service() { return 1; }\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture');
  const scopeManifest = createScopeManifest({
    capabilityId: 'service', allowedPaths: ['src/**'],
    allowedSubjects: ['analysis', 'dependency-edge', 'file', 'symbol']
  });
  return {
    root,
    registered: runDeterministicRegistration({ root, scopeManifest, requestedViews: ['dev.impact@4'] })
  };
}

test('legacy classifier returns a typed migration boundary and never confuses v4 views', () => {
  const legacy = '# Legacy impact\n\n- src/service.mjs has an exported service. [confidence: exact]\n';
  assert.equal(classifyWorldModelInput(legacy).classification, LEGACY_WORLD_MODEL_CLASSIFICATION);
  const error = worldModelMigrationRequired(legacy);
  assert.equal(error.code, 'WMB_MIGRATION_REQUIRED');
  assert.equal(error.details.classification, LEGACY_WORLD_MODEL_CLASSIFICATION);
  assert.equal(classifyWorldModelInput({
    schemaVersion: 1, kind: 'world-model-manifest', format: 'wmb-v4'
  }).classification, 'registered-v4-manifest');
  assert.equal(classifyWorldModelInput(
    `<!--\nSFlow World-Model View\nfact-ledger-sha256: ${sha256({ ledger: 1 })}\n-->\n## Facts\n`
  ).classification, 'registered-v4-view');
});

test('migration maps only exact current registered facts and leaves unproven legacy claims unavailable', async (t) => {
  const { registered } = await fixture(t);
  const mappedFact = registered.factLedger.facts.find((fact) => typeof fact.claim === 'string');
  assert.ok(mappedFact);
  const legacy = readLegacyWorldModelView(
    `# Legacy view\n\n- ${mappedFact.claim}\n- This model-invented behavior is not registered anywhere. [confidence: unavailable]\n`
  );
  assert.equal(legacy.claims[1].legacyConfidence, 'unavailable');
  const mapping = mapLegacyClaimsToRegisteredFacts({
    legacyView: legacy,
    evidenceCatalog: registered.evidenceCatalog,
    factLedger: registered.factLedger
  });
  assert.deepEqual(mapping.mappings.map((entry) => entry.factId), [mappedFact.id]);
  assert.equal(mapping.unresolved.length, 1);
  assert.equal(mapping.unresolved[0].status, 'unavailable');
  assert.ok(mapping.mappings.every((entry) => registered.factLedger.facts.some((fact) => fact.id === entry.factId)));

  const augmented = augmentRegistrationForLegacyMigration({
    legacyView: legacy,
    registration: registered,
    targetViewContract: resolveViewContract(BUILTIN_VIEW_REGISTRY, 'dev.impact@4'),
    viewRegistry: BUILTIN_VIEW_REGISTRY,
    extractorRegistry: BUILTIN_EXTRACTOR_REGISTRY
  });
  assert.equal(augmented.unavailableFacts.length, 1);
  assert.equal(augmented.unavailableFacts[0].claim, null);
  assert.equal(augmented.unavailableFacts[0].status, 'unavailable');
  assert.equal(augmented.unavailableFacts[0].reason.attemptedProducer,
    'legacy-migration-resolution');
  assert.doesNotMatch(augmented.unavailableFacts[0].reason.detail,
    /model-invented behavior/);

  const migrated = createWorldModelMigrationReceipt({
    legacyView: legacy,
    targetViewSha256: sha256({ target: 'registered-v4-view' }),
    sourceSnapshot: augmented.registration.sourceSnapshot,
    scopeManifest: augmented.registration.scopeManifest,
    evidenceCatalog: augmented.registration.evidenceCatalog,
    factLedger: augmented.registration.factLedger
  });
  assert.equal(migrated.classification, LEGACY_WORLD_MODEL_CLASSIFICATION);
  assert.deepEqual(migrated.receipt.claims, {
    total: 2, mappedToRegisteredFacts: 1, unresolved: 1, contradicted: 0
  });
  assert.deepEqual(migrated.receipt.mappings, migrated.mappings);
  assert.deepEqual(migrated.receipt.unresolvedClaims, migrated.unresolved);
  assert.deepEqual(migrated.receipt.mappings.map((entry) => entry.sourceClaimIndex), [0]);
  assert.deepEqual(migrated.receipt.unresolvedClaims.map((entry) => entry.sourceClaimIndex), [1]);
  assert.equal(validateWorldModelMigrationReceipt(migrated.receipt, {
    sourceSnapshot: augmented.registration.sourceSnapshot,
    scopeManifest: augmented.registration.scopeManifest,
    evidenceCatalog: augmented.registration.evidenceCatalog,
    factLedger: augmented.registration.factLedger,
    availableViews: [{ status: 'available', viewSha256: migrated.receipt.targetViewSha256 }]
  }).receiptSha256, migrated.receipt.receiptSha256);
  assert.match(migrated.receipt.receiptSha256, /^sha256:[a-f0-9]{64}$/);

  const forgedCore = structuredClone(migrated.receipt);
  forgedCore.mappings[0].factSha256 = sha256({ forged: true });
  delete forgedCore.receiptSha256;
  const forged = { ...forgedCore, receiptSha256: sha256(forgedCore) };
  assert.throws(() => validateWorldModelMigrationReceipt(forged, {
    factLedger: augmented.registration.factLedger,
    availableViews: [{ status: 'available', viewSha256: migrated.receipt.targetViewSha256 }]
  }), (error) => error.code === 'WMB_MIGRATION_RECEIPT_INVALID');

  const forgedUnavailableCore = structuredClone(migrated.receipt);
  forgedUnavailableCore.unresolvedClaims[0].sourceClaimSha256 = sha256({ forged: 'claim' });
  delete forgedUnavailableCore.receiptSha256;
  assert.throws(() => validateWorldModelMigrationReceipt(
    { ...forgedUnavailableCore, receiptSha256: sha256(forgedUnavailableCore) },
    {
      factLedger: augmented.registration.factLedger,
      availableViews: [{ status: 'available', viewSha256: migrated.receipt.targetViewSha256 }]
    }
  ), (error) => error.code === 'WMB_MIGRATION_RECEIPT_INVALID');
});

test('path#symbol legacy strings narrow registered evidence but never become evidence IDs', async (t) => {
  const { registered } = await fixture(t);
  const symbolFact = registered.factLedger.facts.find((fact) => fact.factType === 'symbol-exists');
  assert.ok(symbolFact);
  const legacy = readLegacyWorldModelView(`- ${symbolFact.claim} src/service.mjs#service\n`);
  const mapping = mapLegacyClaimsToRegisteredFacts({
    legacyView: legacy,
    evidenceCatalog: registered.evidenceCatalog,
    factLedger: registered.factLedger
  });
  assert.deepEqual(mapping.mappings.map((entry) => entry.factId), [symbolFact.id]);
  assert.equal(mapping.unresolved.length, 0);
  assert.deepEqual(legacy.claims[0].evidenceCandidates, ['src/service.mjs#service']);
  assert.equal(legacy.claims[0].text, symbolFact.claim);

  const wrongLocator = readLegacyWorldModelView(`- ${symbolFact.claim} README.md#intro\n`);
  const refused = mapLegacyClaimsToRegisteredFacts({
    legacyView: wrongLocator,
    evidenceCatalog: registered.evidenceCatalog,
    factLedger: registered.factLedger
  });
  assert.equal(refused.mappings.length, 0);
  assert.deepEqual(refused.unresolved[0].evidenceCandidates, ['README.md#intro']);
});

test('migration preserves a current registered contradiction instead of trusting legacy prose', async (t) => {
  const { registered } = await fixture(t);
  const conflict = registered.factLedger.facts.find((fact) => (
    fact.status === 'available' && fact.evidenceIds.length
  ));
  assert.ok(conflict);
  const contradictedClaim = 'Current registered observations contradict this legacy behavior.';
  const contradictionDraft = {
    factType: conflict.factType,
    subject: structuredClone(conflict.subject),
    claim: contradictedClaim,
    status: 'contradicted',
    assurance: 'deterministically-derived',
    evidenceIds: [...conflict.evidenceIds],
    derivationId: conflict.derivationId,
    conflictsWith: [conflict.id],
    scopeStatus: 'inside'
  };
  const contradictedLedger = createFactLedger({
    sourceSnapshot: registered.sourceSnapshot,
    scopeManifest: registered.scopeManifest,
    extractorRegistry: BUILTIN_EXTRACTOR_REGISTRY,
    evidenceCatalog: registered.evidenceCatalog,
    derivationIds: new Set(registered.derivationCatalog.derivations.map((entry) => entry.id)),
    factDrafts: [
      ...registered.factLedger.facts.map(factIdentityFromRecord),
      contradictionDraft
    ]
  });
  const contradiction = contradictedLedger.facts.find((fact) => (
    fact.claim === contradictedClaim
  ));
  assert.ok(contradiction);
  assert.equal(contradiction.status, 'contradicted');

  const legacy = readLegacyWorldModelView(`# Legacy view\n\n- ${contradictedClaim}\n`);
  const mapped = mapLegacyClaimsToRegisteredFacts({
    legacyView: legacy,
    evidenceCatalog: registered.evidenceCatalog,
    factLedger: contradictedLedger
  });
  assert.deepEqual(mapped.mappings.map((entry) => ({
    factId: entry.factId, status: entry.status
  })), [{ factId: contradiction.id, status: 'contradicted' }]);
  assert.deepEqual(mapped.unresolved, []);

  const migrated = createWorldModelMigrationReceipt({
    legacyView: legacy,
    targetViewSha256: sha256({ target: 'contradiction-view' }),
    sourceSnapshot: registered.sourceSnapshot,
    scopeManifest: registered.scopeManifest,
    evidenceCatalog: registered.evidenceCatalog,
    factLedger: contradictedLedger
  });
  assert.deepEqual(migrated.receipt.claims, {
    total: 1, mappedToRegisteredFacts: 1, unresolved: 0, contradicted: 1
  });
  assert.equal(migrated.receipt.mappings[0].factSha256, contradiction.factSha256);
});
