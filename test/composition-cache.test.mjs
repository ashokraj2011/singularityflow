import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  clearCompositionCache, compositionCacheEnabled, compositionCacheStatus, compositionFingerprint, memoizeComposition
} from '../src/composition-cache.mjs';

test('composition fingerprints are stable across object key order', () => {
  assert.equal(compositionFingerprint({ b: 2, a: 1 }), compositionFingerprint({ a: 1, b: 2 }));
});

test('dry-run prompt composition never enables the local cache', () => {
  assert.equal(compositionCacheEnabled('local', { dryRun: true }), false);
  assert.equal(compositionCacheEnabled('local', { dryRun: false }), true);
  assert.equal(compositionCacheEnabled('off', { dryRun: false }), false);
});

test('composition cache reuses exact prompt bytes and separates changed output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-composition-cache-'));
  await mkdir(path.join(root, '.git'));
  const first = await memoizeComposition(root, { phase: 'design', files: [{ sha256: 'a' }] }, 'prompt one\n');
  const second = await memoizeComposition(root, { files: [{ sha256: 'a' }], phase: 'design' }, 'prompt one\n');
  const changed = await memoizeComposition(root, { phase: 'design', files: [{ sha256: 'a' }] }, 'prompt two\n');
  assert.equal(first.hit, false);
  assert.equal(second.hit, true);
  assert.equal(first.key, second.key);
  assert.notEqual(first.key, changed.key);
  assert.equal((await compositionCacheStatus(root)).entries, 2);
  assert.equal((await clearCompositionCache(root)).removed, 2);
  assert.equal((await compositionCacheStatus(root)).entries, 0);
});
