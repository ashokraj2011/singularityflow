import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { gatewayRegistry } from '../src/gateway/operations.mjs';
import {
  worldModelExplainResult, worldModelInspectResult, worldModelNextResult
} from '../src/gateway/planners/world-model.mjs';
import { SFLOW_TOOLS } from '../src/gateway/tools.mjs';
import {
  MAX_WORLD_MODEL_PREVIEW_BYTES, projectWorldModelIdeSlice, readWorldModelIdeExpansion,
  serializedWorldModelIdeBytes, worldModelSourceExpansionReference
} from '../src/world-model/ide/slice.mjs';
import { createConservativeWorldModelStalenessReceipt } from '../src/world-model/cache.mjs';
import { createScopeManifest } from '../src/world-model/scope/manifest.mjs';
import { createExactSourceSnapshot } from '../src/world-model/source/snapshot.mjs';
import { sealRecord } from '../src/world-model/canonicalize.mjs';
import {
  createViewRegistry, resolveBuiltInViewContract
} from '../src/world-model/registry/views.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = (character) => `sha256:${character.repeat(64)}`;

function store() {
  const facts = [
    {
      id: 'FACT-1111111111111111', factType: 'runtime-frequency',
      subject: { kind: 'symbol', id: 'example' }, status: 'unavailable',
      assurance: 'not-applicable', claim: null,
      reason: { code: 'NO_RUNTIME_EVIDENCE', detail: 'No runtime observation is registered.' },
      evidenceIds: [], derivationId: 'DRV-1111111111111111', conflictsWith: [], scopeStatus: 'inside'
    },
    {
      id: 'FACT-2222222222222222', factType: 'symbol-exists',
      subject: { kind: 'symbol', id: 'other' }, status: 'contradicted',
      assurance: 'structurally-derived', claim: 'x'.repeat(20_000),
      evidenceIds: ['EV-1111111111111111'], derivationId: 'DRV-1111111111111111',
      conflictsWith: ['FACT-1111111111111111'], scopeStatus: 'inside'
    }
  ];
  return {
    ref: 'refs/remotes/origin/state', commit: 'a'.repeat(40), outputDir: 'singularity/world-model',
    manifest: {
      format: 'wmb-v4', manifestSha256: digest('1'),
      views: [{
        viewId: 'dev.impact', viewVersion: 4, required: true, status: 'available',
        path: 'views/dev.impact.md', viewSha256: digest('2'), cache: 'hit'
      }]
    },
    views: [{ viewId: 'dev.impact', markdown: `# Impact\n\n${'é'.repeat(10_000)}` }],
    records: {
      viewFactLedgers: [{ viewId: 'dev.impact', ledgerSha256: digest('3'), facts }],
      refusals: [{ view: 'dev.impact', code: 'WMB_TEST', refusalSha256: digest('4') }]
    },
    factLedger: { ledgerSha256: digest('5'), facts },
    evidenceCatalog: {
      catalogSha256: digest('6'), items: [{
        id: 'EV-1111111111111111', kind: 'file', locator: { path: 'src/example.js' },
        subjectSha256: digest('a'), sourceContentSha256: digest('b'),
        scope: { status: 'inside' }, evidenceSha256: digest('c')
      }]
    },
    derivationCatalog: {
      catalogSha256: digest('7'), derivations: [{
        id: 'DRV-1111111111111111',
        extractor: { id: 'repository-files', version: '1.0.0', implementationSha256: digest('d') },
        sourceManifestSha256: digest('8'), scopeManifestSha256: digest('9'),
        inputEvidenceIds: ['EV-1111111111111111'],
        outputFactIds: ['FACT-2222222222222222'], status: 'complete', derivationSha256: digest('e')
      }]
    },
    sourceSnapshot: { sourceManifestSha256: digest('8') },
    scopeManifest: { scopeSha256: digest('9') },
    freshness: { fresh: true, reason: null }
  };
}

test('the IDE projection is bounded and exposes references instead of complete catalogs', () => {
  const slice = projectWorldModelIdeSlice(store(), { maximumPreviewBytes: 1_024 });
  assert.equal(slice.status, 'ready');
  assert.equal(slice.views[0].preview.truncated, true);
  assert.ok(slice.views[0].preview.bytes <= 1_024);
  assert.deepEqual(slice.views[0].counts, {
    total: 2, available: 0, partial: 0, unavailable: 1, contradicted: 1, stale: 0
  });
  assert.equal(slice.summary.facts, 2);
  assert.equal(slice.summary.unavailable, 1);
  assert.equal(slice.summary.contradictions, 1);
  assert.ok(slice.expansion.every((entry) => entry.ref.startsWith('sfref:world-model:')));
  assert.equal(Object.hasOwn(slice, 'factLedger'), false);
  assert.equal(Object.hasOwn(slice, 'evidenceCatalog'), false);
  assert.ok(serializedWorldModelIdeBytes(slice) < 16 * 1_024);
  assert.throws(
    () => projectWorldModelIdeSlice(store(), { maximumPreviewBytes: MAX_WORLD_MODEL_PREVIEW_BYTES + 1 }),
    /IDE bound/
  );
});

test('WMB v4 reads reuse the five gateway tools and remain bounded, deterministic reads', () => {
  assert.equal(SFLOW_TOOLS.length, 5, 'WMB added a model-facing tool instead of using the five verbs');
  const operation = gatewayRegistry().operations.find((entry) => entry.id === 'world-model.inspect');
  assert.ok(operation);
  assert.equal(operation.classification, 'read');
  assert.equal(operation.modelPolicy, 'never');

  const manifest = worldModelInspectResult({ operation, store: store() });
  assert.equal(manifest.kind, 'read');
  assert.equal(manifest.effects.stateChanged, false);
  assert.equal(manifest.data.worldModel.entity, 'manifest');

  const fact = worldModelInspectResult({
    operation, store: store(), arguments: { entity: 'fact', id: 'FACT-2222222222222222' }
  });
  assert.equal(fact.kind, 'read');
  assert.equal(fact.data.worldModel.value.claimTruncated, true);
  assert.ok(Buffer.byteLength(fact.data.worldModel.value.claim, 'utf8') <= 4_100);

  const missing = worldModelInspectResult({
    operation, store: store(), arguments: { entity: 'evidence', id: 'EV-ffffffffffffffff' }
  });
  assert.equal(missing.kind, 'refusal');
  assert.equal(missing.why[0].code, 'world-model.entity-unavailable');
  assert.equal(missing.effects.filesChanged, false);
});

test('gateway next and explain compute model-free guidance from exact registered authority', () => {
  const registered = store();
  const nextOperation = gatewayRegistry().operations.find((entry) => entry.id === 'world-model.next');
  const explainOperation = gatewayRegistry().operations.find((entry) => entry.id === 'world-model.explain');
  assert.equal(nextOperation.modelPolicy, 'never');
  assert.equal(explainOperation.modelPolicy, 'never');

  const current = worldModelNextResult({ operation: nextOperation, store: registered });
  assert.equal(current.data.worldModel.recommendation.operation, 'world-model.validate');
  assert.equal(current.data.worldModel.recommendation.requiresReview, false);
  assert.equal(current.effects.stateChanged, false);

  const stalenessReceipt = createConservativeWorldModelStalenessReceipt({
    previousViewSha256: digest('2'),
    cause: {
      kind: 'source-change', previousSha256: digest('8'), currentSha256: digest('f')
    },
    affectedFactIds: ['FACT-1111111111111111', 'FACT-2222222222222222'],
    viewId: 'dev.impact'
  });
  const stale = worldModelNextResult({
    operation: nextOperation,
    store: {
      ...registered,
      freshness: { fresh: false, reason: 'source-manifest-changed' },
      stalenessReceipts: [stalenessReceipt]
    },
    arguments: { viewId: 'dev.impact' }
  });
  assert.equal(stale.data.worldModel.recommendation.operation, 'world-model.regenerate');
  assert.equal(stale.data.worldModel.recommendation.requiresReview, true);
  assert.equal(stale.data.worldModel.recommendation.command,
    'singularity-flow world-model regenerate dev.impact');
  assert.deepEqual(stale.data.worldModel.recommendation.stalenessReceipts, [stalenessReceipt]);
  assert.equal(stale.effects.stateChanged, false);

  const missing = worldModelNextResult({
    operation: nextOperation,
    error: Object.assign(new Error('missing'), { code: 'WMB_MANIFEST_MISSING' })
  });
  assert.equal(missing.data.worldModel.recommendation.operation, 'world-model.plan');
  assert.equal(missing.effects.filesChanged, false);

  const explained = worldModelExplainResult({
    operation: explainOperation, store: registered,
    arguments: { entity: 'fact', id: 'FACT-2222222222222222' }
  });
  assert.equal(explained.kind, 'read');
  assert.equal(explained.outcome.messageId, 'gateway.explained');
  assert.equal(explained.data.worldModel.explanation.assurance, 'structurally-derived');
  assert.deepEqual(explained.data.worldModel.explanation.evidenceIds, ['EV-1111111111111111']);
  assert.equal(explained.data.worldModel.explanation.claimTruncated, true);
});

test('exact source expansion is scoped, content-addressed, pinned, and chunk-bounded', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sflow-wmb-ide-source-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'WMB Test'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'wmb@example.test'], { cwd: root });
    mkdirSync(path.join(root, 'src'));
    const pinned = `export const value = '${'registered-'.repeat(90)}';\n`;
    writeFileSync(path.join(root, 'src', 'registered.js'), pinned);
    writeFileSync(path.join(root, 'secret.txt'), 'outside scope\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
    const scopeManifest = createScopeManifest({
      capabilityId: 'bounded-source', allowedPaths: ['src/**'], sharedPaths: [],
      excludedPaths: [], maximumTraversalDepth: 8
    });
    const sourceSnapshot = createExactSourceSnapshot(root, { scopeManifest });
    const denied = resolveBuiltInViewContract('dev.impact@4');
    const { contractSha256: _ignored, ...contractBody } = structuredClone(denied);
    const bodyContract = sealRecord({
      ...contractBody,
      bodyAccess: { allowed: true, maximumBytes: 512 }
    }, 'contractSha256');
    const exactStore = {
      ...store(), sourceSnapshot, scopeManifest,
      viewRegistry: createViewRegistry([bodyContract]),
      records: {
        ...store().records,
        viewFactLedgers: [{
          viewId: 'dev.impact', ledgerSha256: digest('3'),
          facts: [{ id: 'FACT-1111111111111111', evidenceIds: ['EV-1111111111111111'] }]
        }]
      },
      evidenceCatalog: {
        ...store().evidenceCatalog,
        items: [{ id: 'EV-1111111111111111', kind: 'file', locator: { path: 'src/registered.js' } }]
      }
    };
    assert.equal(worldModelSourceExpansionReference(exactStore, 'src/registered.js'), null,
      'source bodies require an exact registered view policy');
    const reference = worldModelSourceExpansionReference(
      exactStore, 'src/registered.js', { viewId: 'dev.impact' }
    );
    assert.ok(reference?.ref.startsWith('sfref:world-model:source:'));
    assert.equal(worldModelSourceExpansionReference(
      exactStore, 'secret.txt', { viewId: 'dev.impact' }
    ), null);
    const operation = gatewayRegistry().operations.find((entry) => entry.id === 'world-model.inspect');
    const evidence = worldModelInspectResult({
      operation, store: exactStore,
      arguments: { entity: 'evidence', id: 'EV-1111111111111111', viewId: 'dev.impact' }
    });
    assert.equal(evidence.data.worldModel.value.exactSource.ref, reference.ref);
    const gatewayExpansion = worldModelInspectResult({
      operation, root, store: exactStore,
      arguments: { entity: 'expansion', id: reference.ref, maximumBytes: 256 }
    });
    assert.equal(gatewayExpansion.kind, 'read');
    assert.equal(gatewayExpansion.data.worldModel.value.source.scope, 'inside');
    assert.ok(gatewayExpansion.data.worldModel.value.bytes <= 256);

    // Dirty working-tree bytes are not the authority. Expansion reads and verifies the pinned blob.
    writeFileSync(path.join(root, 'src', 'registered.js'), 'tampered in the worktree\n');
    let offset = 0;
    const chunks = [];
    let finalPage;
    do {
      const expanded = readWorldModelIdeExpansion(root, exactStore, reference.ref, {
        offset, maximumBytes: 256
      });
      assert.ok(expanded.bytes <= 256);
      assert.equal(expanded.source.scope, 'inside');
      assert.equal(expanded.source.commit, sourceSnapshot.revision.commit);
      assert.match(expanded.pageSha256, /^sha256:[a-f0-9]{64}$/);
      chunks.push(Buffer.from(expanded.content, 'base64'));
      finalPage = expanded;
      offset = expanded.nextOffset;
    } while (offset !== null);
    assert.equal(Buffer.concat(chunks).toString('utf8'), Buffer.from(pinned).subarray(0, 512).toString('utf8'));
    assert.equal(finalPage.policyTruncated, true);
    assert.equal(finalPage.policyMaximumBytes, 512);
    assert.equal(finalPage.complete, false);
    assert.throws(
      () => readWorldModelIdeExpansion(root, exactStore, reference.ref, { offset: 512 }),
      (error) => error.code === 'WMB_SOURCE_BODY_BUDGET_EXCEEDED'
    );

    const forged = reference.ref.replace(/[0-9a-f]$/, (value) => value === 'a' ? 'b' : 'a');
    assert.throws(
      () => readWorldModelIdeExpansion(root, exactStore, forged),
      (error) => error.code === 'WMB_IDE_EXPANSION_DIGEST_MISMATCH'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the Configuration Center leases WMB only for its Explorer tab and releases it on tab change', () => {
  const source = readFileSync(path.join(
    packageRoot, 'apps/vscode/src/views/configuration-center.ts'
  ), 'utf8');
  assert.match(source, /if \(tab === 'world-model'\)[^]*world-model-explorer[^]*\['worldModel'\]/,
    'opening an unrelated Configuration Center tab must not acquire WMB');
  assert.match(source, /tab !== 'world-model'|releaseWorldModelLease\(\)/,
    'leaving the Explorer must release its WMB lease');
  assert.match(source, /this\.tab = tab;[^]*this\.releaseWorldModelLease\(\)/,
    'the panel must switch away before the reduced-snapshot release is rendered');
  assert.match(source, /DEFAULT_WORLD_MODEL_SLICE_LEASE_MS/,
    'the Explorer lease must remain bounded even if panel disposal is lost');
});

test('a cached Explorer payload cannot rejoin the next activation without a lease', () => {
  const stateModule = path.join(packageRoot, 'apps/vscode/src/state.ts');
  const source = `
    import { WorkspaceStore } from ${JSON.stringify(stateModule)};
    const cached = {
      workItems: [], initiatives: [], included: ['repository', 'worldModel'],
      repository: { root: '/fixture' },
      worldModel: { kind:'world-model-ide-slice', root:'singularity/world-model', views:[{ preview:{ text:'heavy' } }] },
      revision: { subjectRevision:'aggregate-with-wmb', slices:{ repository:'repo-1', worldModel:'wmb-1' } }
    };
    const client = { async snapshot() { throw new Error('not called'); } };
    const store = new WorkspaceStore(client, { read: () => cached, write() {} });
    const primed = store.primeFromCache();
    process.stdout.write(JSON.stringify({ primed, snapshot: store.current.snapshot }));
  `;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], {
    encoding: 'utf8', cwd: packageRoot, timeout: 60_000
  });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.primed, true);
  assert.equal(Object.hasOwn(value.snapshot, 'worldModel'), false);
  assert.equal(value.snapshot.included.includes('worldModel'), false);
  assert.equal(Object.hasOwn(value.snapshot.revision.slices, 'worldModel'), false);
  assert.equal(Object.hasOwn(value.snapshot.revision, 'subjectRevision'), false);
});

test('named World Model leases renew, expire, and evict the heavy payload after final release', () => {
  const stateModule = path.join(packageRoot, 'apps/vscode/src/state.ts');
  const source = `
    import { WorkspaceStore } from ${JSON.stringify(stateModule)};
    const calls = [];
    const client = {
      async snapshot(_signal, slices) {
        calls.push([...slices]);
        return {
          workItems: [], initiatives: [], included: [...slices],
          ...(slices.includes('worldModel') ? { worldModel: { root:'singularity/world-model', generatedAt:null, rebuildReason:null, views:[] } } : {}),
          revision: { subjectRevision: String(calls.length), slices: Object.fromEntries(slices.map((slice) => [slice, slice + calls.length])) }
        };
      },
      async configurationSnapshot() { throw new Error('unexpected'); }
    };
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const store = new WorkspaceStore(client);
    await store.refresh();
    const lease = await store.acquireSlices('world-model-explorer', ['worldModel'], { ttlMs: 45 });
    const loaded = Boolean(store.current.snapshot?.worldModel);
    await wait(25);
    const firstExpiry = lease.expiresAt;
    const renewedExpiry = lease.renew(60);
    await wait(30);
    const survivedOriginalExpiry = Boolean(store.current.snapshot?.worldModel);
    await wait(45);
    const evicted = !store.current.snapshot?.worldModel;
    await store.refresh();
    process.stdout.write(JSON.stringify({ loaded, survivedOriginalExpiry, evicted, firstExpiry, renewedExpiry, finalSlices:calls.at(-1) }));
  `;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], {
    encoding: 'utf8', cwd: packageRoot, timeout: 60_000
  });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.loaded, true);
  assert.equal(value.survivedOriginalExpiry, true);
  assert.equal(value.evicted, true);
  assert.notEqual(value.firstExpiry, value.renewedExpiry);
  assert.equal(value.finalSlices.includes('worldModel'), false);
});
