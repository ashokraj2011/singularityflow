import test from 'node:test';
import assert from 'node:assert/strict';

import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import { canonicalJson, sealRecord, sha256 } from '../src/world-model/canonicalize.mjs';
import {
  buildWorldModelManifest, readWorldModelV4Manifest, verifyWorldModelManifest,
  worldModelViewSha256
} from '../src/world-model/publish/manifest.mjs';
import {
  publishWorldModelTransaction, stageWorldModelPublication
} from '../src/world-model/publish/transaction.mjs';
import {
  WMB_V4_CANDIDATE_SCHEMA_SHA256, WMB_V4_VALIDATION_CHECK_IDS,
  WMB_V4_VALIDATOR_SHA256
} from '../src/world-model/validate/candidate.mjs';

const digest = (id) => sha256({ id });

function dependencies() {
  return {
    sourceManifestSha256: digest('source'),
    scopeManifestSha256: digest('scope'),
    policySnapshotSha256: digest('policy'),
    viewRegistrySha256: digest('views'),
    extractorRegistrySha256: digest('extractors'),
    evidenceCatalogSha256: digest('evidence'),
    derivationCatalogSha256: digest('derivations'),
    factLedgerSha256: digest('facts')
  };
}

function availableView(deps, { id = 'dev.impact', required = true, content = 'Registered finding [F:FACT-0123456789abcdef]' } = {}) {
  const viewFactLedgerSha256 = digest(`${id}-facts`);
  const candidate = {
    schemaVersion: 1,
    kind: 'world-model-composition-candidate',
    view: id,
    viewVersion: 4,
    title: 'Publication fixture',
    tldrMarkdown: content,
    sections: [{ sectionId: 'fixture', markdown: content }],
    usedFactIds: ['FACT-0123456789abcdef']
  };
  const receipt = sealRecord({
    schemaVersion: currentSchemaVersion('world-model-view-validation-receipt'),
    kind: 'world-model-view-validation-receipt',
    viewId: id,
    viewVersion: 4,
    candidateSha256: sha256(candidate),
    candidateSchemaSha256: WMB_V4_CANDIDATE_SCHEMA_SHA256,
    viewSpecSha256: digest(`${id}-contract`),
    factLedgerSha256: viewFactLedgerSha256,
    scopeSha256: deps.scopeManifestSha256,
    checks: WMB_V4_VALIDATION_CHECK_IDS.map((checkId) => ({ id: checkId, status: 'pass' })),
    status: 'passed',
    validatorSha256: WMB_V4_VALIDATOR_SHA256
  }, 'receiptSha256');
  const markdown = `<!--\nSFlow World-Model View\nsource-manifest-sha256: ${deps.sourceManifestSha256}\nscope-sha256: ${deps.scopeManifestSha256}\nfact-ledger-sha256: ${viewFactLedgerSha256}\n-->\n\n# Impact\n\n${content}\n`;
  const viewSha256 = worldModelViewSha256(markdown);
  const execution = sealRecord({
    schemaVersion: currentSchemaVersion('world-model-view-execution'),
    kind: 'world-model-view-execution',
    requestSha256: digest('request'),
    viewId: id,
    viewVersion: 4,
    executionUnitManifestSha256: digest('execution-unit'),
    contextManifestSha256: digest('context'),
    viewFactLedgerSha256,
    status: 'completed',
    candidateSha256: receipt.candidateSha256,
    validationReceiptSha256: receipt.receiptSha256,
    publishedViewSha256: viewSha256,
    usageObservationSha256: null
  }, 'executionSha256');
  return {
    viewId: id, viewVersion: 4, required, status: 'available',
    path: `views/${id}.md`, markdown, viewSha256, validationReceipt: receipt, candidate,
    execution, cache: 'miss'
  };
}

test('aggregate v4 manifest self-hashes and binds exact view, receipt, execution, and dependencies', () => {
  const deps = dependencies();
  const view = availableView(deps);
  const built = buildWorldModelManifest({
    subject: { kind: 'repository', id: 'payments-api' }, dependencies: deps, views: [view]
  });
  assert.match(built.manifest.manifestSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(readWorldModelV4Manifest(canonicalJson(built.manifest)).manifestSha256, built.manifest.manifestSha256);
  assert.equal(verifyWorldModelManifest(built.manifest, { dependencies: deps, views: [view] }).views[0].viewSha256,
    view.viewSha256);

  const altered = { ...view, markdown: `${view.markdown}\nInvented late line.\n` };
  assert.throws(
    () => verifyWorldModelManifest(built.manifest, { dependencies: deps, views: [altered] }),
    (error) => error.code === 'WMB_VIEW_HASH_MISMATCH'
  );
});

test('required-view publication is atomic while explicitly permitted optional gaps remain visible', () => {
  const deps = dependencies();
  assert.throws(
    () => buildWorldModelManifest({
      subject: { kind: 'repository', id: 'payments-api' }, dependencies: deps,
      views: [{ viewId: 'dev.impact', viewVersion: 4, required: true, status: 'unavailable' }]
    }),
    (error) => error.code === 'WMB_REQUIRED_VIEW_UNAVAILABLE'
  );
  assert.throws(
    () => buildWorldModelManifest({
      subject: { kind: 'repository', id: 'payments-api' }, dependencies: deps,
      views: [availableView(deps), { viewId: 'biz.rules', viewVersion: 4, required: false, status: 'unavailable' }]
    }),
    (error) => error.code === 'WMB_OPTIONAL_VIEW_UNAVAILABLE'
  );
  const built = buildWorldModelManifest({
    subject: { kind: 'repository', id: 'payments-api' }, dependencies: deps,
    views: [availableView(deps), { viewId: 'biz.rules', viewVersion: 4, required: false, status: 'unavailable' }],
    allowUnavailableOptionalViews: true
  });
  assert.deepEqual(built.manifest.completeness, {
    requiredViews: 1, availableRequiredViews: 1, optionalViews: 1, unavailableOptionalViews: 1
  });
});

test('a forged partial validator receipt cannot enter an aggregate manifest', () => {
  const deps = dependencies();
  const view = availableView(deps);
  view.validationReceipt = sealRecord({
    ...view.validationReceipt,
    checks: [{ id: 'fact-reference-integrity', status: 'pass' }]
  }, 'receiptSha256');
  view.execution = sealRecord({
    ...view.execution,
    validationReceiptSha256: view.validationReceipt.receiptSha256
  }, 'executionSha256');
  assert.throws(
    () => buildWorldModelManifest({
      subject: { kind: 'repository', id: 'payments-api' }, dependencies: deps, views: [view]
    }),
    (error) => error.code === 'WMB_VIEW_VALIDATION_INVALID'
  );
});

test('staging refuses a manifest-only map before any state-branch publication is possible', () => {
  const deps = dependencies();
  const view = availableView(deps);
  const built = buildWorldModelManifest({
    subject: { kind: 'repository', id: 'payments-api' }, dependencies: deps, views: [view]
  });
  assert.throws(
    () => stageWorldModelPublication({
      manifest: built.manifest, dependencies: deps, views: [view]
    }),
    (error) => error.code === 'WMB_PUBLICATION_PARTIAL'
      && /source-snapshot\.json/.test(error.message)
  );
});

test('publishing revalidates an untrusted staged envelope before invoking the state writer', async () => {
  let publisherCalls = 0;
  await assert.rejects(
    publishWorldModelTransaction('/repo', { branch: 'state' }, {
      outputDir: 'singularity/world-model',
      manifestPath: 'singularity/world-model/manifest.json',
      manifest: { manifestSha256: digest('forged') },
      files: {},
      replaceRoots: ['singularity/world-model']
    }, {
      publisher: async () => { publisherCalls += 1; }
    }),
    (error) => error.code === 'WMB_PUBLICATION_PARTIAL'
  );
  assert.equal(publisherCalls, 0);
});

test('v3 manifests are never silently accepted by the v4 reader', () => {
  assert.throws(
    () => readWorldModelV4Manifest({ schema_version: '3.0', repository_commit: 'a'.repeat(40) }),
    (error) => error.code === 'WMB_MIGRATION_REQUIRED'
      && error.details.classification === 'legacy-unregistered-view'
  );
});
