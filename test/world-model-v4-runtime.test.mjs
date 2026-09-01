import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { run } from '../src/util.mjs';
import {
  inspectWorldModelViewCache, verifyWorldModelStalenessReceipt,
  worldModelViewCacheRoot, writeWorldModelViewCache
} from '../src/world-model/cache.mjs';
import { canonicalJson, sealRecord, sha256 } from '../src/world-model/canonicalize.mjs';
import {
  materializeWorldModelView, usageObservation
} from '../src/world-model/materialize/view.mjs';
import { createWorldModelMigrationReceipt } from '../src/world-model/migration/v3-to-v4.mjs';
import { readLegacyWorldModelView } from '../src/world-model/migration/v3-reader.mjs';
import { createWorldModelViewOutputBudget } from '../src/world-model/plan.mjs';
import {
  buildWorldModelManifest, deriveWorldModelManifestDependencies
} from '../src/world-model/publish/manifest.mjs';
import {
  publishWorldModelTransaction, stageWorldModelMigrationPublication
} from '../src/world-model/publish/transaction.mjs';
import { buildWorldModelV4 } from '../src/world-model/runtime.mjs';
import { buildAndPublishWorldModelV4 } from '../src/world-model/service.mjs';
import {
  resolvePublishedWorldModelV4, worldModelV4StoreSummary
} from '../src/world-model/store.mjs';

const LEDGER = Object.freeze({
  enabled: true,
  branch: 'state',
  remote: 'origin',
  behind: 'block',
  enforcement: 'shadow',
  signing: 'off',
  trustTier: 'T0',
  maxRetries: 3
});

function git(root, ...args) {
  return run('git', args, { cwd: root });
}

async function repository(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmb-v4-runtime-'));
  const remote = path.join(parent, 'remote.git');
  const root = path.join(parent, 'repo');
  t.after(() => rm(parent, { recursive: true, force: true }));
  run('git', ['init', '--bare', remote]);
  await mkdir(path.join(root, 'src'), { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'WMB Runtime Tests');
  git(root, 'config', 'user.email', 'wmb-runtime@example.invalid');
  await writeFile(path.join(root, 'src', 'service.mjs'), [
    "import { tax } from './tax.mjs';",
    'export function total(value) { return value + tax(value); }',
    ''
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'tax.mjs'), 'export const tax = (value) => value * 0.1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'application source');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-u', 'origin', 'main');
  return { root, remote };
}

function buildOptions(overrides = {}) {
  return {
    outputDir: 'singularity/world-model',
    ledgerConfig: LEDGER,
    views: ['dev.impact'],
    composer: 'deterministic',
    capabilityId: 'runtime-fixture',
    allowedPaths: ['src/**'],
    excludedPaths: ['singularity/**', '.sflow/**', '.singularity-flow/**'],
    policySnapshotSha256: sha256({ fixture: 'wmb-v4-runtime-policy' }),
    generatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides
  };
}

test('deterministic views publish atomically, reuse exact cache, and survive selective regeneration', async (t) => {
  const { root } = await repository(t);
  const first = await buildAndPublishWorldModelV4(root, buildOptions());
  assert.equal(first.status, 'completed');
  assert.equal(first.views.length, 1);
  assert.equal(first.views[0].viewId, 'dev.impact');
  assert.equal(first.views[0].cache, 'miss');
  assert.equal(first.runtime.availableViews[0].route, 'deterministic');
  assert.equal(first.runtime.availableViews[0].validationReceipt.checks.length, 20);
  assert.ok(first.runtime.availableViews[0].validationReceipt.checks.every((check) => check.status === 'pass'));
  assert.equal(git(root, 'branch', '--show-current').stdout.trim(), 'main');
  assert.equal(git(root, 'status', '--porcelain').stdout.trim(), '');

  const stored = resolvePublishedWorldModelV4(root, {
    outputDir: 'singularity/world-model', stateBranch: 'state', remote: 'origin'
  });
  assert.equal(stored.freshness.fresh, true);
  assert.equal(stored.manifest.manifestSha256, first.manifestSha256);
  assert.equal(stored.views[0].markdown, first.runtime.availableViews[0].markdown);

  const second = await buildAndPublishWorldModelV4(root, buildOptions({
    views: ['arch.contracts'], generatedAt: '2026-09-01T00:01:00.000Z'
  }));
  assert.deepEqual(second.manifest.views.map((entry) => entry.viewId), [
    'arch.contracts', 'dev.impact'
  ]);
  assert.equal(second.manifest.views.find((entry) => entry.viewId === 'dev.impact').viewSha256,
    first.views[0].viewSha256);
  const independentlyReused = second.runtime.availableViews.find((entry) => entry.viewId === 'dev.impact');
  assert.equal(independentlyReused.cache, 'hit');
  const contract = second.runtime.planned.requestedViews.find(
    (entry) => entry.viewId === 'dev.impact'
  ).contract;
  const expectedViewBudget = createWorldModelViewOutputBudget(
    second.runtime.planned.outputBudget, contract
  );
  assert.equal(
    independentlyReused.contextManifest.regions.find((entry) => entry.id === 'output-budget').sha256,
    sha256(canonicalJson(expectedViewBudget))
  );

  const cached = await buildAndPublishWorldModelV4(root, buildOptions({
    generatedAt: '2026-09-01T00:02:00.000Z'
  }));
  const cachedImpact = cached.runtime.availableViews.find((entry) => entry.viewId === 'dev.impact');
  assert.equal(cachedImpact.cache, 'hit');
  assert.equal(cachedImpact.viewSha256, first.views[0].viewSha256);
  assert.equal(cachedImpact.markdown, first.runtime.availableViews[0].markdown);
});

test('an exact-key cache race never attributes the losing execution to the winning bytes', async (t) => {
  const { root } = await repository(t);
  const [left, right] = await Promise.all([
    buildWorldModelV4(root, buildOptions({ generatedAt: '2026-09-01T00:03:00.000Z' })),
    buildWorldModelV4(root, buildOptions({ generatedAt: '2026-09-01T00:03:01.000Z' }))
  ]);
  const views = [left, right].map((result) => result.availableViews[0]);
  assert.equal(views.every(Boolean), true);
  assert.equal(views[0].viewSha256, views[1].viewSha256);
  assert.equal(views.filter((view) => view.execution.status === 'completed').length, 1);
  const reused = views.find((view) => view.execution.status === 'cached');
  assert.ok(reused, 'the losing or late execution must be represented as reuse of the winner');
  assert.equal(reused.cache, 'hit');
  assert.equal(reused.usageObservation.providerInputTokens, null);
  assert.equal(reused.usageObservation.providerOutputTokens, null);
  assert.equal(reused.usageObservation.promptBytes, 0);
});

test('regenerate replaces only the selected cache entry and preserves a missing sibling entry without recomposition', async (t) => {
  const { root } = await repository(t);
  const first = await buildAndPublishWorldModelV4(root, buildOptions({
    views: ['dev.impact', 'arch.contracts'],
    generatedAt: '2026-09-01T00:10:00.000Z'
  }));
  const before = await inspectWorldModelViewCache(root);
  const beforeByView = new Map(before.entries.map((entry) => [entry.components.viewId, entry]));
  const siblingBefore = beforeByView.get('arch.contracts');
  const selectedBefore = beforeByView.get('dev.impact');
  assert.ok(siblingBefore?.hit);
  assert.ok(selectedBefore?.hit);

  // Simulate a new machine/local cleanup: the published sibling is still exact authority, but its
  // machine-local key pointer is absent. Regeneration may rehydrate it, never compose it.
  await rm(siblingBefore.recordPath);
  const regenerated = await buildAndPublishWorldModelV4(root, buildOptions({
    views: ['dev.impact'],
    cachePolicy: 'rebuild',
    generatedAt: '2026-09-01T00:11:00.000Z'
  }));
  assert.equal(regenerated.status, 'completed');
  assert.deepEqual(regenerated.manifest.views.map((entry) => entry.viewId), [
    'arch.contracts', 'dev.impact'
  ]);
  const sibling = regenerated.runtime.availableViews.find(
    (entry) => entry.viewId === 'arch.contracts'
  );
  const selected = regenerated.runtime.availableViews.find(
    (entry) => entry.viewId === 'dev.impact'
  );
  assert.equal(sibling.cache, 'hit');
  assert.equal(sibling.execution.status, 'cached');
  assert.equal(sibling.viewSha256, first.views.find(
    (entry) => entry.viewId === 'arch.contracts'
  ).viewSha256);
  assert.equal(selected.cache, 'miss');
  assert.notEqual(selected.viewSha256, first.views.find(
    (entry) => entry.viewId === 'dev.impact'
  ).viewSha256);

  const after = await inspectWorldModelViewCache(root);
  const afterByView = new Map(after.entries.map((entry) => [entry.components.viewId, entry]));
  assert.equal(
    afterByView.get('arch.contracts').record.recordSha256,
    siblingBefore.record.recordSha256,
    'the sibling exact cache authority must not be replaced'
  );
  assert.notEqual(
    afterByView.get('dev.impact').record.recordSha256,
    selectedBefore.record.recordSha256,
    'the selected regenerate must replace its exact cache authority'
  );
});

test('a coherently rehashed cache candidate is independently refused against current facts', async (t) => {
  const { root } = await repository(t);
  const first = await buildAndPublishWorldModelV4(root, buildOptions({ publish: false }));
  const [entry] = (await inspectWorldModelViewCache(root)).entries;
  const forgedCandidate = {
    ...structuredClone(entry.candidate),
    usedFactIds: [...entry.candidate.usedFactIds, `FACT-${'f'.repeat(16)}`].sort()
  };
  const receiptCore = {
    ...structuredClone(entry.validationReceipt),
    candidateSha256: sha256(forgedCandidate)
  };
  delete receiptCore.receiptSha256;
  const forgedReceipt = { ...receiptCore, receiptSha256: sha256(receiptCore) };
  await writeWorldModelViewCache(root, entry.components, {
    view: first.runtime.availableViews[0].markdown,
    candidate: forgedCandidate,
    validationReceipt: forgedReceipt,
    createdAt: '2026-09-01T00:20:00.000Z',
    replaceExisting: true,
    expectedRecordSha256: entry.record.recordSha256
  });

  const refused = await buildAndPublishWorldModelV4(root, buildOptions({
    publish: false,
    generatedAt: '2026-09-01T00:21:00.000Z'
  }));
  assert.equal(refused.status, 'refused');
  assert.equal(refused.refusals[0].code, 'WMB_CACHE_REVALIDATION_FAILED');
  assert.equal(refused.refusals[0].failures[0].details.causeCode, 'WMB_FACT_REFERENCE_UNKNOWN');
});

test('publication revalidates an exact complete projection before invoking its state writer', async (t) => {
  const { root } = await repository(t);
  const built = await buildAndPublishWorldModelV4(root, buildOptions({ publish: false }));
  assert.equal(built.status, 'completed');
  assert.ok(built.staged.files['singularity/world-model/source/source-snapshot.json']);

  const calls = [];
  const published = await publishWorldModelTransaction(root, LEDGER, built.staged, {
    publisher: async (...args) => {
      calls.push(args);
      return {
        branch: 'state', commit: 'a'.repeat(40), changed: true,
        published: Object.keys(args[2]), removed: []
      };
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(published.manifestSha256, built.manifestSha256);
  assert.deepEqual(calls[0][4].replaceRoots, ['singularity/world-model']);

  const mutations = [
    (publication) => { delete publication.files['singularity/world-model/source/source-snapshot.json']; },
    (publication) => { delete publication.files['singularity/world-model/contexts/dev.impact.json']; },
    (publication) => { publication.files['singularity/world-model/unregistered.json'] = '{}\n'; },
    (publication) => { publication.replaceRoots = ['singularity']; }
  ];
  for (const mutate of mutations) {
    const publication = {
      ...built.staged,
      manifest: structuredClone(built.staged.manifest),
      files: { ...built.staged.files },
      replaceRoots: [...built.staged.replaceRoots]
    };
    mutate(publication);
    await assert.rejects(
      () => publishWorldModelTransaction(root, LEDGER, publication, {
        publisher: async () => {
          calls.push('unexpected');
          return {};
        }
      }),
      (error) => error.code === 'WMB_PUBLICATION_PARTIAL'
    );
  }
  assert.equal(calls.length, 1, 'no invalid projection reached the state writer');
});

test('publication reruns semantic validation instead of trusting a coherently rehashed receipt', async (t) => {
  const { root } = await repository(t);
  const built = await buildAndPublishWorldModelV4(root, buildOptions({ publish: false }));
  const original = built.runtime.availableViews[0];
  const factId = original.candidate.usedFactIds[0];
  const candidate = {
    ...structuredClone(original.candidate),
    tldrMarkdown: `The moon is made of cheese. [F:${factId}]`
  };
  const receiptCore = {
    ...structuredClone(original.validationReceipt),
    candidateSha256: sha256(candidate)
  };
  delete receiptCore.receiptSha256;
  const validationReceipt = sealRecord(receiptCore, 'receiptSha256');
  const materialized = materializeWorldModelView({
    candidate,
    contract: original.contract,
    viewFactLedger: original.viewFactLedger,
    scopeManifest: built.runtime.planned.scopeManifest,
    sourceSnapshot: built.runtime.planned.sourceSnapshot,
    evidenceCatalog: built.runtime.registration.evidenceCatalog,
    derivationCatalog: built.runtime.registration.derivationCatalog,
    validationReceipt,
    contextManifest: original.contextManifest,
    executionUnit: original.execution.executionUnit,
    model: original.execution.model,
    generatedAt: buildOptions().generatedAt
  });
  const observation = usageObservation({
    viewId: original.viewId,
    prompt: '',
    output: materialized.markdown
  });
  const executionCore = {
    ...structuredClone(original.execution),
    candidateSha256: validationReceipt.candidateSha256,
    validationReceiptSha256: validationReceipt.receiptSha256,
    publishedViewSha256: materialized.viewSha256,
    usageObservationSha256: observation.observationSha256
  };
  delete executionCore.executionSha256;
  const execution = sealRecord(executionCore, 'executionSha256');
  const dependencies = deriveWorldModelManifestDependencies({
    sourceSnapshot: built.runtime.planned.sourceSnapshot,
    scopeManifest: built.runtime.planned.scopeManifest,
    policySnapshotSha256: built.runtime.planned.request.policySnapshotSha256,
    viewRegistry: built.runtime.planned.viewRegistry,
    extractorRegistry: built.runtime.planned.extractorRegistry,
    evidenceCatalog: built.runtime.registration.evidenceCatalog,
    derivationCatalog: built.runtime.registration.derivationCatalog,
    factLedger: built.runtime.registration.factLedger
  });
  const forgedView = {
    viewId: original.viewId,
    viewVersion: original.contract.version,
    required: original.required,
    status: 'available',
    path: `views/${original.viewId}.md`,
    markdown: materialized.markdown,
    viewSha256: materialized.viewSha256,
    validationReceipt,
    candidate,
    execution,
    usageObservation: observation,
    cache: original.cache
  };
  const { manifest } = buildWorldModelManifest({
    subject: built.runtime.planned.sourceSnapshot.subject,
    dependencies,
    views: [forgedView]
  });
  const outputDir = built.staged.outputDir;
  const files = {
    ...built.staged.files,
    [`${outputDir}/manifest.json`]: canonicalJson(manifest),
    [`${outputDir}/candidates/${original.viewId}.json`]: canonicalJson(candidate),
    [`${outputDir}/receipts/validation/${original.viewId}.json`]: canonicalJson(validationReceipt),
    [`${outputDir}/receipts/execution/${original.viewId}.json`]: canonicalJson(execution),
    [`${outputDir}/usage/${original.viewId}.json`]: canonicalJson(observation),
    [`${outputDir}/views/${original.viewId}.md`]: materialized.markdown
  };
  let publisherCalls = 0;
  await assert.rejects(
    () => publishWorldModelTransaction(root, LEDGER, {
      ...built.staged,
      manifest,
      files
    }, {
      publisher: async () => {
        publisherCalls += 1;
        return {};
      }
    }),
    (error) => error.code === 'WMB_FACT_ASSURANCE_UPGRADED'
  );
  assert.equal(publisherCalls, 0, 'semantic-invalid view bytes must not reach the state writer');
});

test('publication reproduces the deterministic Fact graph before invoking its state writer', async (t) => {
  const { root } = await repository(t);
  const built = await buildAndPublishWorldModelV4(root, buildOptions({ publish: false }));
  const planPath = `${built.staged.outputDir}/plans/build-plan.json`;
  const planCore = JSON.parse(built.staged.files[planPath]);
  delete planCore.planSha256;
  planCore.extractors = [planCore.extractors[0]];
  planCore.estimatedWork = {
    ...planCore.estimatedWork,
    deterministicExtractors: planCore.extractors.length
  };
  const forgedPlan = sealRecord(planCore, 'planSha256');
  let publisherCalls = 0;
  await assert.rejects(
    () => publishWorldModelTransaction(root, LEDGER, {
      ...built.staged,
      files: {
        ...built.staged.files,
        [planPath]: canonicalJson(forgedPlan)
      }
    }, {
      publisher: async () => {
        publisherCalls += 1;
        return {};
      }
    }),
    (error) => error.code === 'WMB_PUBLICATION_FACTS_UNVERIFIED'
  );
  assert.equal(publisherCalls, 0, 'a non-reproducible Fact graph must not reach the state writer');
});

test('migration receipt and target projection cross the state writer as one validated transaction', async (t) => {
  const { root } = await repository(t);
  const built = await buildAndPublishWorldModelV4(root, buildOptions({ publish: false }));
  const target = built.runtime.availableViews.find((entry) => entry.viewId === 'dev.impact');
  const mappedFact = built.runtime.registration.factLedger.facts.find((entry) => (
    typeof entry.claim === 'string'
  ));
  assert.ok(mappedFact);
  const migration = createWorldModelMigrationReceipt({
    legacyView: readLegacyWorldModelView(
      `# Legacy impact\n\n- ${mappedFact.claim}\n- An unregistered historical claim.\n`
    ),
    targetViewSha256: target.viewSha256,
    sourceSnapshot: built.runtime.planned.sourceSnapshot,
    scopeManifest: built.runtime.planned.scopeManifest,
    evidenceCatalog: built.runtime.registration.evidenceCatalog,
    factLedger: built.runtime.registration.factLedger
  });
  const receiptPath = `singularity/world-model/migrations/${migration.receipt.sourceViewSha256.replace(/^sha256:/, '')}.json`;
  let publisherCalls = 0;
  let publishedFiles = null;
  const publishMigration = async (receipt) => {
    const staged = stageWorldModelMigrationPublication(built.staged, receipt);
    return publishWorldModelTransaction(root, LEDGER, staged, {
      publisher: async (_root, _ledger, files) => {
        publisherCalls += 1;
        publishedFiles = files;
        return {
          branch: 'state', commit: 'b'.repeat(40), changed: true,
          published: Object.keys(files), removed: []
        };
      }
    });
  };

  const published = await publishMigration(migration.receipt);
  assert.equal(publisherCalls, 1);
  assert.equal(published.manifestSha256, built.manifestSha256);
  assert.deepEqual(JSON.parse(publishedFiles[receiptPath]), migration.receipt);
  assert.equal(JSON.parse(publishedFiles['singularity/world-model/manifest.json']).manifestSha256,
    built.manifestSha256);

  await assert.rejects(
    () => publishMigration(undefined),
    (error) => error.code === 'SCHEMA_RECORD_INVALID'
  );

  const staleSeal = {
    ...migration.receipt,
    targetViewSha256: sha256({ target: 'not-the-published-view' })
  };
  await assert.rejects(
    () => publishMigration(staleSeal),
    (error) => error.code === 'WMB_RECORD_HASH_MISMATCH'
  );

  const coherentlyForged = sealRecord(staleSeal, 'receiptSha256');
  await assert.rejects(
    () => publishMigration(coherentlyForged),
    (error) => error.code === 'WMB_MIGRATION_RECEIPT_INVALID'
  );

  const forgedMappingCore = structuredClone(migration.receipt);
  forgedMappingCore.mappings[0] = forgedMappingCore.mappings[0]
    ? { ...forgedMappingCore.mappings[0], factSha256: sha256({ forged: 'fact' }) }
    : null;
  assert.ok(forgedMappingCore.mappings[0]);
  delete forgedMappingCore.receiptSha256;
  await assert.rejects(
    () => publishMigration(sealRecord(forgedMappingCore, 'receiptSha256')),
    (error) => error.code === 'WMB_MIGRATION_RECEIPT_INVALID'
  );

  const broadened = stageWorldModelMigrationPublication(built.staged, migration.receipt);
  const movedReceipt = {
    ...broadened,
    files: { ...broadened.files }
  };
  delete movedReceipt.files[receiptPath];
  movedReceipt.files[`singularity/world-model/migrations/${'f'.repeat(64)}.json`] = canonicalJson(migration.receipt);
  await assert.rejects(
    () => publishWorldModelTransaction(root, LEDGER, movedReceipt, {
      publisher: async () => {
        publisherCalls += 1;
        return {};
      }
    }),
    (error) => error.code === 'WMB_PUBLICATION_PARTIAL'
      && /migration receipt does not bind/i.test(error.message)
  );
  assert.equal(publisherCalls, 1, 'missing, forged, mismatched, or moved receipts never reach the state writer');
});

test('Story metadata does not rebuild a repository view, while scoped source changes make it stale', async (t) => {
  const { root } = await repository(t);
  const first = await buildAndPublishWorldModelV4(root, buildOptions());
  const firstSource = first.runtime.planned.sourceSnapshot.sourceManifestSha256;

  await mkdir(path.join(root, 'singularity', 'work-items', 'WRK-META'), { recursive: true });
  await writeFile(path.join(root, 'singularity', 'work-items', 'WRK-META', 'state.json'), '{"phase":"planning"}\n');
  git(root, 'add', 'singularity/work-items/WRK-META/state.json');
  git(root, 'commit', '-m', 'Story metadata only');

  const metadataOnly = await buildAndPublishWorldModelV4(root, buildOptions({
    generatedAt: '2026-09-01T00:03:00.000Z'
  }));
  assert.equal(metadataOnly.runtime.planned.sourceSnapshot.sourceManifestSha256, firstSource);
  assert.equal(metadataOnly.runtime.availableViews[0].cache, 'hit');

  await writeFile(path.join(root, 'src', 'tax.mjs'), 'export const tax = (value) => value * 0.2;\n');
  git(root, 'add', 'src/tax.mjs');
  git(root, 'commit', '-m', 'Change governed source');

  const stale = resolvePublishedWorldModelV4(root, {
    outputDir: 'singularity/world-model', stateBranch: 'state', remote: 'origin'
  });
  assert.equal(stale.freshness.fresh, false);
  assert.equal(stale.freshness.reason, 'source-snapshot-changed');
  assert.equal(stale.stalenessReceipts.length, 1);
  const [receipt] = stale.stalenessReceipts;
  assert.equal(verifyWorldModelStalenessReceipt(receipt), true);
  assert.equal(receipt.nextAction.view, 'dev.impact');
  assert.equal(receipt.previousViewSha256, first.views[0].viewSha256);
  assert.equal(receipt.cause.kind, 'source-change');
  assert.equal(receipt.cause.previousSha256, stale.freshness.built);
  assert.equal(receipt.cause.currentSha256, stale.freshness.current);
  assert.deepEqual(receipt.unaffectedFactIds, []);
  assert.deepEqual(
    receipt.affectedFactIds,
    stale.records.viewFactLedgers.find((entry) => entry.viewId === 'dev.impact')
      .facts.map((fact) => fact.id).sort()
  );
  const receiptDigest = receipt.receiptSha256.slice('sha256:'.length);
  const receiptPath = path.join(
    worldModelViewCacheRoot(root), 'staleness', receiptDigest.slice(0, 2), `${receiptDigest}.json`
  );
  await assert.rejects(access(receiptPath), (error) => error.code === 'ENOENT');

  const status = worldModelV4StoreSummary(stale);
  assert.deepEqual(status.stalenessReceipts, [receipt]);
  await assert.rejects(
    access(receiptPath),
    (error) => error.code === 'ENOENT',
    'read-only status serialization must not persist a receipt'
  );

  const rebuilt = await buildAndPublishWorldModelV4(root, buildOptions({
    cachePolicy: 'rebuild',
    generatedAt: '2026-09-01T00:04:00.000Z'
  }));
  assert.notEqual(rebuilt.runtime.planned.sourceSnapshot.sourceManifestSha256, firstSource);
  assert.equal(rebuilt.runtime.availableViews[0].cache, 'miss');
  assert.equal(rebuilt.stalenessReceipts.length, 1);
  assert.deepEqual(rebuilt.stalenessReceipts[0], {
    receipt,
    persistence: { status: 'stored', written: true }
  });
  assert.deepEqual(JSON.parse(await readFile(receiptPath, 'utf8')), receipt);
  assert.deepEqual(rebuilt.warnings, []);
});

test('a required view failure preserves registered facts but cannot publish a manifest', async (t) => {
  const { root } = await repository(t);
  const runtime = await buildWorldModelV4(root, {
    ...buildOptions({ views: ['biz.rules'], cachePolicy: 'rebuild' }),
    composer: 'not-a-composer'
  });
  assert.equal(runtime.status, 'refused');
  assert.deepEqual(runtime.requiredFailures, ['biz.rules']);
  assert.equal(runtime.availableViews.length, 0);
  assert.equal(runtime.refusals.length, 1);
  assert.ok(runtime.registration.factLedger.facts.length > 0);
  assert.ok(runtime.preservedObjects.length >= 4);

  const published = await buildAndPublishWorldModelV4(root, {
    ...buildOptions({ views: ['biz.rules'], cachePolicy: 'rebuild' }),
    composer: 'not-a-composer'
  });
  assert.equal(published.status, 'refused');
  assert.equal(published.manifestSha256, null);
  assert.equal(run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/state'], {
    cwd: root, allowFailure: true
  }).status, 1);
});

test('aggregate output budget is admitted before independent view fan-out', async (t) => {
  const { root } = await repository(t);
  await assert.rejects(
    buildWorldModelV4(root, {
      ...buildOptions({ views: ['dev.impact', 'arch.contracts'] }),
      totalMaximumOutputTokens: 2_000
    }),
    (error) => error.code === 'WMB_OUTPUT_BUDGET_EXCEEDED'
      && error.details.minimumRequiredTokens === 2_800
  );
});
