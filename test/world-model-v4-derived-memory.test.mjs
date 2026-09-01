import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { run } from '../src/util.mjs';
import { inspectWorldModelViewCache, readWorldModelViewCache } from '../src/world-model/cache.mjs';
import {
  buildWorldModelQueryIndex, queryWorldModelIndex, readWorldModelQueryIndex,
  storeWorldModelQueryIndex, validateWorldModelQueryIndex
} from '../src/world-model/query-index.mjs';
import {
  hydrateLocalWorldModelViewCacheFromShared, publishWorldModelViewToSharedCache,
  readSharedWorldModelViewCache
} from '../src/world-model/shared-cache.mjs';
import { buildAndPublishWorldModelV4 } from '../src/world-model/service.mjs';
import { sealRecord, sha256 } from '../src/world-model/canonicalize.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';

function git(root, ...args) { return run('git', args, { cwd: root }); }

async function repository(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmb-derived-memory-'));
  const root = path.join(parent, 'repo');
  const shared = path.join(parent, 'shared-cache');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'), { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Derived Memory Tests');
  git(root, 'config', 'user.email', 'derived-memory@example.invalid');
  await writeFile(path.join(root, 'src', 'service.py'), [
    'from helpers import calculate',
    'class Service:',
    '    def run(self): return calculate()',
    ''
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'helpers.py'), 'def calculate(): return 1\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture');
  return { root, shared };
}

function options() {
  return {
    views: ['dev.impact'], composer: 'deterministic', publish: false,
    capabilityId: 'derived-memory', allowedPaths: ['src/**'],
    excludedPaths: ['singularity/**'],
    policySnapshotSha256: sha256({ fixture: 'derived-memory' }),
    generatedAt: '2026-09-01T00:00:00.000Z'
  };
}

test('L2 shared Derived-Memory cache hydrates only through the verified L1 boundary', async (t) => {
  const { root, shared } = await repository(t);
  await buildAndPublishWorldModelV4(root, options());
  const inspected = await inspectWorldModelViewCache(root);
  assert.equal(inspected.entries.length, 1);
  const [entry] = inspected.entries;
  const published = await publishWorldModelViewToSharedCache(shared, root, entry.components);
  assert.equal(published.written, true);
  const sharedHit = await readSharedWorldModelViewCache(shared, entry.components);
  assert.equal(sharedHit.hit, true);

  await rm(entry.recordPath);
  assert.equal((await readWorldModelViewCache(root, entry.components)).hit, false);
  const hydrated = await hydrateLocalWorldModelViewCacheFromShared(root, shared, entry.components);
  assert.equal(hydrated.hit, true);
  assert.equal(hydrated.shared, true);
  assert.equal((await readWorldModelViewCache(root, entry.components)).hit, true);

  const bytes = await readFile(sharedHit.path);
  const forged = JSON.parse(bytes);
  forged.view += '\nforged';
  await writeFile(sharedHit.path, JSON.stringify(forged));
  const rejected = await readSharedWorldModelViewCache(shared, entry.components);
  assert.equal(rejected.hit, false);
  assert.equal(rejected.status, 'corrupt');
});

test('WMB runtime automatically warms and reuses L2 without trusting corrupt shared bytes', async (t) => {
  const { root, shared } = await repository(t);
  const first = await buildAndPublishWorldModelV4(root, {
    ...options(), sharedCacheDirectory: shared
  });
  assert.equal(first.status, 'completed');
  assert.equal(first.runtime.availableViews[0].cache, 'miss');
  assert.equal(first.runtime.cacheDiagnostics.some((entry) => (
    entry.level === 'l2' && entry.operation === 'publish' && entry.status === 'written'
  )), true);

  const [entry] = (await inspectWorldModelViewCache(root)).entries;
  await rm(entry.recordPath);
  const second = await buildAndPublishWorldModelV4(root, {
    ...options(), sharedCacheDirectory: shared
  });
  assert.equal(second.runtime.availableViews[0].cache, 'hit');
  assert.equal(second.runtime.availableViews[0].cacheLevel, 'l2');
  assert.equal(second.runtime.cacheDiagnostics.some((item) => (
    item.level === 'l2' && item.operation === 'hydrate' && item.status === 'hit'
  )), true);

  const sharedHit = await readSharedWorldModelViewCache(shared, entry.components);
  const forged = JSON.parse(await readFile(sharedHit.path, 'utf8'));
  forged.view += '\ncorrupt';
  await writeFile(sharedHit.path, JSON.stringify(forged));
  await rm(entry.recordPath);
  const rebuilt = await buildAndPublishWorldModelV4(root, {
    ...options(), sharedCacheDirectory: shared
  });
  assert.equal(rebuilt.status, 'completed');
  assert.equal(rebuilt.runtime.availableViews[0].cache, 'miss');
  assert.equal(rebuilt.runtime.cacheDiagnostics.some((item) => (
    item.level === 'l2' && item.operation === 'hydrate' && item.status === 'corrupt'
  )), true);
});

test('rebuildable query index exposes bounded exact facts and evidence without source bodies', async (t) => {
  const { root } = await repository(t);
  const built = await buildAndPublishWorldModelV4(root, options());
  assert.equal(built.queryIndex.status, 'ready');
  const graph = {
    manifest: built.manifest,
    evidenceCatalog: built.runtime.registration.evidenceCatalog,
    derivationCatalog: built.runtime.registration.derivationCatalog,
    factLedger: built.runtime.registration.factLedger
  };
  const index = buildWorldModelQueryIndex(graph);
  assert.equal(built.queryIndex.indexSha256, index.indexSha256);
  const stored = await storeWorldModelQueryIndex(root, graph);
  assert.equal(stored.index.indexSha256, index.indexSha256);
  const loaded = await readWorldModelQueryIndex(root, built.manifestSha256);
  assert.equal(loaded.index.indexSha256, index.indexSha256);
  await writeFile(loaded.path, '{}');
  const repaired = await storeWorldModelQueryIndex(root, graph);
  assert.equal(repaired.written, true);
  assert.equal(repaired.replaced, true);
  assert.equal(
    (await readWorldModelQueryIndex(root, built.manifestSha256)).index.indexSha256,
    index.indexSha256
  );

  const symbols = queryWorldModelIndex(index, { factType: 'symbol-exists' });
  assert.ok(symbols.facts.some((fact) => fact.subjectId === 'src/service.py#Service'));
  const evidence = queryWorldModelIndex(index, { path: 'src/service.py' });
  assert.ok(evidence.evidence.length > 0);
  assert.doesNotMatch(JSON.stringify(index), /return calculate|return 1/);
  assert.throws(
    () => queryWorldModelIndex(index, { arbitrary: 'no' }),
    (error) => error.code === 'WMB_QUERY_INVALID'
  );
});

test('rebuildable query index refuses coherently resealed values outside closed vocabularies', () => {
  const base = {
    schemaVersion: currentSchemaVersion('world-model-query-index'),
    kind: 'world-model-query-index',
    manifestSha256: sha256({ fixture: 'manifest' }),
    sourceManifestSha256: sha256({ fixture: 'source' }),
    views: [],
    facts: [{
      id: `FACT-${'a'.repeat(16)}`,
      factType: 'file-exists',
      status: 'available',
      assurance: 'source-exact',
      subjectKind: 'file',
      subjectId: 'src/example.js',
      evidenceIds: [`EV-${'b'.repeat(16)}`],
      derivationId: `DRV-${'c'.repeat(16)}`,
      factSha256: sha256({ fixture: 'fact' })
    }],
    evidence: [{
      id: `EV-${'b'.repeat(16)}`,
      kind: 'file',
      path: 'src/example.js',
      symbol: null,
      target: null,
      subjectSha256: sha256({ fixture: 'subject' }),
      evidenceSha256: sha256({ fixture: 'evidence' })
    }]
  };
  assert.doesNotThrow(() => validateWorldModelQueryIndex(sealRecord(base, 'indexSha256')));
  const forged = structuredClone(base);
  forged.facts[0].factType = 'self-asserted-fact';
  assert.throws(
    () => validateWorldModelQueryIndex(sealRecord(forged, 'indexSha256')),
    (error) => error.code === 'WMB_QUERY_INDEX_INVALID'
  );
});
