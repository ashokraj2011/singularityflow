import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  canonicalTokenReductionSegmentKey,
  clearTokenReductionSegmentCache,
  prepareTokenReductionSegment,
  tokenReductionSegmentCachePath,
  tokenReductionSegmentCacheRoot,
  tokenReductionSegmentCacheStatus,
  tokenReductionSegmentKeySha256,
  writeTokenReductionSegment,
  lookupTokenReductionSegment
} from '../src/token-reduction-segment-cache.mjs';

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-tkr-segments-'));
  git(root, 'init', '-q');
  await writeFile(path.join(root, 'README.md'), '# fixture\n');
  git(root, 'add', 'README.md');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '-qm', 'fixture');
  return root;
}

function digest(character) {
  return `sha256:${character.repeat(64)}`;
}

function segmentKey(overrides = {}) {
  return {
    domain: {
      accessScope: 'repository-private',
      repositoryRef: digest('1'),
      candidateRef: digest('2')
    },
    effectiveInputRefs: [
      { kind: 'workflow', ref: digest('3') },
      { kind: 'source', ref: digest('4') }
    ],
    rendererRef: digest('5'),
    relevantSelectionRef: digest('6'),
    normalizationRef: digest('7'),
    format: 'text/markdown; charset=utf-8',
    serializerRef: digest('8'),
    segmentKind: 'stable-governance',
    ...overrides
  };
}

async function exists(target) {
  return access(target).then(() => true, () => false);
}

async function listJsonFiles(root) {
  const output = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name.endsWith('.json')) output.push(target);
    }
  }
  await visit(root);
  return output.sort();
}

test('segment keys canonically bind every byte-affecting dependency and reject malformed keys', () => {
  const original = segmentKey();
  const reordered = {
    segmentKind: original.segmentKind,
    serializerRef: original.serializerRef,
    format: original.format,
    normalizationRef: original.normalizationRef,
    relevantSelectionRef: original.relevantSelectionRef,
    rendererRef: original.rendererRef,
    effectiveInputRefs: original.effectiveInputRefs.map((reference) => ({
      ref: reference.ref, kind: reference.kind
    })),
    domain: {
      candidateRef: original.domain.candidateRef,
      repositoryRef: original.domain.repositoryRef,
      accessScope: original.domain.accessScope
    }
  };
  assert.deepEqual(canonicalTokenReductionSegmentKey(reordered),
    canonicalTokenReductionSegmentKey(original));
  assert.equal(tokenReductionSegmentKeySha256(reordered),
    tokenReductionSegmentKeySha256(original));

  const variants = [
    { domain: { ...original.domain, accessScope: 'private-candidate' } },
    { effectiveInputRefs: [...original.effectiveInputRefs, { kind: 'agent', ref: digest('9') }] },
    { rendererRef: digest('a') },
    { relevantSelectionRef: digest('b') },
    { normalizationRef: digest('c') },
    { format: 'application/json' },
    { serializerRef: digest('d') },
    { segmentKind: 'dynamic-source' }
  ];
  for (const variant of variants) {
    assert.notEqual(tokenReductionSegmentKeySha256(segmentKey(variant)),
      tokenReductionSegmentKeySha256(original));
  }

  assert.throws(() => canonicalTokenReductionSegmentKey({ ...original, unexpected: true }),
    { code: 'TKR_CONTRACT_UNSUPPORTED' });
  assert.throws(() => canonicalTokenReductionSegmentKey({ ...original, rendererRef: '' }),
    { code: 'TKR_CONTRACT_UNSUPPORTED' });
  for (const malformed of [
    { domain: { ...original.domain, extra: true } },
    { domain: { ...original.domain, accessScope: 'public' } },
    { domain: { ...original.domain, repositoryRef: { sha256: digest('1') } } },
    { domain: { ...original.domain, candidateRef: 'mutable-branch' } },
    { effectiveInputRefs: [] },
    { effectiveInputRefs: [{ kind: 'workflow', ref: digest('3'), extra: true }] },
    { effectiveInputRefs: [{ kind: 'Workflow', ref: digest('3') }] },
    { effectiveInputRefs: [{ kind: 'workflow', ref: 'mutable-ref' }] },
    { effectiveInputRefs: [original.effectiveInputRefs[0], original.effectiveInputRefs[0]] },
    { rendererRef: { ref: digest('5') } },
    { relevantSelectionRef: 'selection-latest' },
    { normalizationRef: 'normalization-latest' },
    { serializerRef: 'serializer-latest' }
  ]) assert.throws(() => canonicalTokenReductionSegmentKey(segmentKey(malformed)),
    { code: 'TKR_CONTRACT_UNSUPPORTED' });

  const contractRef = `sflow-core/tkr/renderer/test@1#${digest('a')}`;
  assert.equal(canonicalTokenReductionSegmentKey(segmentKey({ rendererRef: contractRef }))
    .rendererRef, contractRef);
  const frozen = canonicalTokenReductionSegmentKey(original);
  assert.equal(Object.isFrozen(frozen), true);
  assert.equal(Object.isFrozen(frozen.domain), true);
  assert.equal(Object.isFrozen(frozen.effectiveInputRefs), true);
  assert.equal(Object.isFrozen(frozen.effectiveInputRefs[0]), true);
});

test('segment cache is repository scoped in the common Git directory across linked worktrees', async (t) => {
  const root = await repository();
  const linked = `${root}-linked`;
  t.after(async () => {
    await rm(linked, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  git(root, 'worktree', 'add', '-q', '-b', 'linked-segment-cache', linked);

  const stored = await writeTokenReductionSegment(root, segmentKey(), 'shared bytes', {
    admitted: true
  });
  assert.equal(stored.cached, true);
  // macOS may spell one common-dir path through /private/var and the other through /var.
  assert.equal(await realpath(tokenReductionSegmentCacheRoot(linked)),
    await realpath(tokenReductionSegmentCacheRoot(root)));
  const fromLinked = await lookupTokenReductionSegment(linked, segmentKey());
  assert.equal(fromLinked.hit, true);
  assert.equal(fromLinked.content.toString(), 'shared bytes');
});

test('lookup-only paths never create, quarantine, evict, or rewrite cache bytes', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const cacheRoot = tokenReductionSegmentCacheRoot(root);
  const first = await lookupTokenReductionSegment(root, segmentKey());
  assert.equal(first.hit, false);
  assert.equal(await exists(cacheRoot), false);

  await writeTokenReductionSegment(root, segmentKey(), 'original', { admitted: true });
  const target = tokenReductionSegmentCachePath(root, segmentKey());
  const corrupt = JSON.parse(await readFile(target, 'utf8'));
  corrupt.contentBytes += 1;
  await writeFile(target, `${JSON.stringify(corrupt, null, 2)}\n`);
  const before = await readFile(target);
  const miss = await lookupTokenReductionSegment(root, segmentKey());
  assert.equal(miss.hit, false);
  assert.equal(miss.corrupt, true);
  assert.deepEqual(await readFile(target), before);
  assert.equal((await listJsonFiles(path.join(cacheRoot, 'quarantine'))).length, 0);
});

test('admitted prepare memoizes exact bytes and never calls a model or renderer on a hit', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  let renders = 0;
  const bytes = Buffer.from([0, 10, 226, 152, 131, 255]);
  const first = await prepareTokenReductionSegment(root, segmentKey(), async () => {
    renders += 1;
    return bytes;
  }, { admitted: true });
  assert.equal(first.rendered, true);
  assert.equal(first.cached, true);
  const second = await prepareTokenReductionSegment(root, segmentKey(), async () => {
    renders += 1;
    throw new Error('renderer and any model-backed path must not run on an exact hit');
  }, { admitted: true });
  assert.equal(second.rendered, false);
  assert.equal(second.reused, true);
  assert.deepEqual(second.content, bytes);
  assert.equal(renders, 1);

  await assert.rejects(prepareTokenReductionSegment(root, segmentKey(), async () => 'forbidden'),
    { code: 'TKR_CONTRACT_UNSUPPORTED' });
  await assert.rejects(writeTokenReductionSegment(root, segmentKey(), 'forbidden'),
    { code: 'TKR_CONTRACT_UNSUPPORTED' });
});

test('corrupt digest or length is a miss and only an admitted prepare may quarantine and recompute', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = segmentKey();
  await writeTokenReductionSegment(root, key, 'before corruption', { admitted: true });
  const target = tokenReductionSegmentCachePath(root, key);
  const corrupt = JSON.parse(await readFile(target, 'utf8'));
  corrupt.contentSha256 = digest('f');
  await writeFile(target, `${JSON.stringify(corrupt, null, 2)}\n`);

  assert.equal((await lookupTokenReductionSegment(root, key)).hit, false);
  const repaired = await prepareTokenReductionSegment(root, key,
    async () => 'recomputed exact bytes', { admitted: true, quarantineCorrupt: true });
  assert.equal(repaired.rendered, true);
  assert.equal(repaired.cached, true);
  assert.equal(repaired.quarantined, true);
  assert.equal((await lookupTokenReductionSegment(root, key)).content.toString(),
    'recomputed exact bytes');
  const status = await tokenReductionSegmentCacheStatus(root);
  assert.equal(status.validEntries, 1);
  assert.equal(status.corruptEntries, 0);
  assert.equal(status.quarantinedEntries, 1);
});

test('atomic writers reuse identical bodies and reject differing bodies for one exact key', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const sameKey = segmentKey();
  const identical = await Promise.all(Array.from({ length: 12 }, () =>
    writeTokenReductionSegment(root, sameKey, 'one body', { admitted: true })));
  assert.equal(identical.every((result) => result.cached), true);
  assert.equal((await lookupTokenReductionSegment(root, sameKey)).content.toString(), 'one body');
  await assert.rejects(writeTokenReductionSegment(root, sameKey, 'different body', {
    admitted: true
  }), { code: 'TKR_RENDER_CONFLICT' });

  const racingKey = segmentKey({ relevantSelectionRef: digest('e') });
  const raced = await Promise.allSettled([
    writeTokenReductionSegment(root, racingKey, 'left', { admitted: true }),
    writeTokenReductionSegment(root, racingKey, 'right', { admitted: true })
  ]);
  assert.equal(raced.filter((result) => result.status === 'fulfilled').length, 1);
  const rejection = raced.find((result) => result.status === 'rejected');
  assert.equal(rejection?.reason?.code, 'TKR_RENDER_CONFLICT');
  assert.match((await lookupTokenReductionSegment(root, racingKey)).content.toString(), /^(left|right)$/);
});

test('finite eviction and clear affect only eligible derived entries, never retained history', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const limits = { maximumEntries: 2, maximumDiskBytes: 32 * 1024 };
  const retained = segmentKey({ segmentKind: 'retained-key' });
  const second = segmentKey({ segmentKind: 'second-key' });
  const third = segmentKey({ segmentKind: 'third-key' });
  const retainedDigest = tokenReductionSegmentKeySha256(retained);
  await writeTokenReductionSegment(root, retained, 'retained cache body', {
    admitted: true, limits, retainedKeys: [retainedDigest]
  });
  await writeTokenReductionSegment(root, second, 'second cache body', {
    admitted: true, limits, retainedKeys: [retainedDigest]
  });
  const history = path.join(tokenReductionSegmentCacheRoot(root), 'history', 'packet.json');
  await mkdir(path.dirname(history), { recursive: true });
  await writeFile(history, '{"retained":"authority"}\n');
  await writeTokenReductionSegment(root, third, 'third cache body', {
    admitted: true, limits, retainedKeys: [retainedDigest]
  });

  const status = await tokenReductionSegmentCacheStatus(root, { limits });
  assert.equal(status.withinLimits, true);
  assert.ok(status.entries <= 2);
  assert.equal((await lookupTokenReductionSegment(root, retained, { limits })).hit, true);
  assert.equal(await readFile(history, 'utf8'), '{"retained":"authority"}\n');

  const preview = await clearTokenReductionSegmentCache(root, {
    dryRun: true, retainedKeys: [retainedDigest], limits
  });
  assert.equal(preview.status, 'preview');
  assert.equal(preview.removedEntries, 0);
  assert.equal((await lookupTokenReductionSegment(root, retained, { limits })).hit, true);
  const cleared = await clearTokenReductionSegmentCache(root, {
    retainedKeys: [retainedDigest], limits
  });
  assert.equal(cleared.status, 'cleared');
  assert.equal((await lookupTokenReductionSegment(root, retained, { limits })).hit, true);
  await clearTokenReductionSegmentCache(root, { limits });
  assert.equal((await lookupTokenReductionSegment(root, retained, { limits })).hit, false);
  assert.equal(await readFile(history, 'utf8'), '{"retained":"authority"}\n');

  const full = await prepareTokenReductionSegment(root, segmentKey({ segmentKind: 'too-full' }),
    async () => 'valid bytes that cannot fit', {
      admitted: true, limits: { maximumEntries: 1, maximumDiskBytes: 1 }
    });
  assert.equal(full.cached, false);
  assert.equal(full.reason, 'cache-full');
  assert.equal(full.content.toString(), 'valid bytes that cannot fit');
  assert.equal(await readFile(history, 'utf8'), '{"retained":"authority"}\n');
});

test('cache storage failure cannot invalidate an admitted uncached composition', async (t) => {
  const root = await repository();
  t.after(async () => {
    await chmod(tokenReductionSegmentCacheRoot(root), 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const cacheRoot = tokenReductionSegmentCacheRoot(root);
  await mkdir(path.dirname(cacheRoot), { recursive: true });
  await writeFile(cacheRoot, 'a regular file deliberately blocks cache directory creation\n');
  const prepared = await prepareTokenReductionSegment(root, segmentKey(),
    async () => 'valid composition despite unavailable cache', { admitted: true });
  assert.equal(prepared.rendered, true);
  assert.equal(prepared.cached, false);
  assert.equal(prepared.content.toString(), 'valid composition despite unavailable cache');
  assert.match(prepared.reason, /^(corrupt-entry-retained|cache-write-failed)$/);
});

test('unrecognized files inside derived cache areas fail the quota scan closed', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeTokenReductionSegment(root, segmentKey(), 'valid cache body', { admitted: true });
  const entriesRoot = path.join(tokenReductionSegmentCacheRoot(root), 'entries');
  await writeFile(path.join(entriesRoot, 'unaccounted.bin'), 'not a cache entry');

  const status = await tokenReductionSegmentCacheStatus(root);
  assert.equal(status.scanComplete, false);
  assert.equal(status.withinLimits, false);
  assert.equal(status.status, 'partial');

  const preview = await clearTokenReductionSegmentCache(root, { dryRun: true });
  assert.equal(preview.status, 'partial');
  assert.equal(preview.scanComplete, false);
  assert.equal(preview.removedEntries, 0);
  const clear = await clearTokenReductionSegmentCache(root);
  assert.equal(clear.status, 'partial');
  assert.equal(clear.scanComplete, false);
  assert.equal(clear.removedEntries, 0);
  assert.equal(clear.retainedEntries, 1);
  assert.equal((await lookupTokenReductionSegment(root, segmentKey())).hit, true);
  assert.equal(await readFile(path.join(entriesRoot, 'unaccounted.bin'), 'utf8'),
    'not a cache entry');

  const attempted = await writeTokenReductionSegment(
    root,
    segmentKey({ segmentKind: 'new-after-incomplete-scan' }),
    'valid uncached bytes',
    { admitted: true }
  );
  assert.equal(attempted.cached, false);
  assert.equal(attempted.reason, 'cache-full');
  assert.equal(attempted.content.toString(), 'valid uncached bytes');
});
