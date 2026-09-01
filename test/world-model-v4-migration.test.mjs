import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sha256 } from '../src/world-model/canonicalize.mjs';
import { runDeterministicRegistration } from '../src/world-model/extract/runner.mjs';
import {
  createWorldModelMigrationReceipt, mapLegacyClaimsToRegisteredFacts,
  validateWorldModelMigrationReceipt
} from '../src/world-model/migration/v3-to-v4.mjs';
import {
  LEGACY_WORLD_MODEL_CLASSIFICATION, classifyWorldModelInput, readLegacyWorldModelView,
  worldModelMigrationRequired
} from '../src/world-model/migration/v3-reader.mjs';
import { createScopeManifest } from '../src/world-model/scope/manifest.mjs';

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
    `# Legacy view\n\n- ${mappedFact.claim}\n- This model-invented behavior is not registered anywhere.\n`
  );
  const mapping = mapLegacyClaimsToRegisteredFacts({
    legacyView: legacy,
    evidenceCatalog: registered.evidenceCatalog,
    factLedger: registered.factLedger
  });
  assert.deepEqual(mapping.mappings.map((entry) => entry.factId), [mappedFact.id]);
  assert.equal(mapping.unresolved.length, 1);
  assert.equal(mapping.unresolved[0].status, 'unavailable');
  assert.ok(mapping.mappings.every((entry) => registered.factLedger.facts.some((fact) => fact.id === entry.factId)));

  const migrated = createWorldModelMigrationReceipt({
    legacyView: legacy,
    targetViewSha256: sha256({ target: 'registered-v4-view' }),
    sourceSnapshot: registered.sourceSnapshot,
    scopeManifest: registered.scopeManifest,
    evidenceCatalog: registered.evidenceCatalog,
    factLedger: registered.factLedger
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
    sourceSnapshot: registered.sourceSnapshot,
    scopeManifest: registered.scopeManifest,
    evidenceCatalog: registered.evidenceCatalog,
    factLedger: registered.factLedger,
    availableViews: [{ status: 'available', viewSha256: migrated.receipt.targetViewSha256 }]
  }).receiptSha256, migrated.receipt.receiptSha256);
  assert.match(migrated.receipt.receiptSha256, /^sha256:[a-f0-9]{64}$/);

  const forgedCore = structuredClone(migrated.receipt);
  forgedCore.mappings[0].factSha256 = sha256({ forged: true });
  delete forgedCore.receiptSha256;
  const forged = { ...forgedCore, receiptSha256: sha256(forgedCore) };
  assert.throws(() => validateWorldModelMigrationReceipt(forged, {
    factLedger: registered.factLedger,
    availableViews: [{ status: 'available', viewSha256: migrated.receipt.targetViewSha256 }]
  }), (error) => error.code === 'WMB_MIGRATION_RECEIPT_INVALID');
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
  // The appended path#symbol changes the prose, so conservative migration refuses instead of
  // laundering a plausible locator into a registered Fact.
  assert.equal(mapping.mappings.length, 0);
  assert.equal(mapping.unresolved[0].status, 'unavailable');
  assert.deepEqual(mapping.unresolved[0].evidenceCandidates, ['src/service.mjs#service']);
});
