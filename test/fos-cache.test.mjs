import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  clearFosDerivedCache, fosDerivedCachePath, readFosDerivedCache, writeFosDerivedCache
} from '../src/fos-derived-cache.mjs';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-fos-cache-'));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.name', 'FOS Test'], root);
  git(['config', 'user.email', 'fos@example.com'], root);
  await writeFile(path.join(root, 'source.txt'), 'source\n');
  git(['add', '.'], root);
  git(['commit', '-qm', 'initial'], root);
  return root;
}

const key = {
  producer: 'fos.test',
  producerVersion: '1.0.0',
  inputs: [`sha256:${'a'.repeat(64)}`],
  configuration: `sha256:${'b'.repeat(64)}`
};

test('FOS:AC-027 corrupt derived entries are safe misses', async () => {
  const root = await repository();
  const written = await writeFosDerivedCache(root, key, { symbols: 3 });
  assert.equal(written.cached, true);
  assert.deepEqual(await readFosDerivedCache(root, key), { symbols: 3 });
  const located = await fosDerivedCachePath(root, key);
  const record = JSON.parse(await readFile(located.target, 'utf8'));
  record.payload.symbols = 99;
  await writeFile(located.target, JSON.stringify(record));
  assert.equal(await readFosDerivedCache(root, key), null);
});

test('FOS:AC-029 clearing derived cache preserves sibling authority and recovery state', async () => {
  const root = await repository();
  await writeFosDerivedCache(root, key, { value: true });
  const common = path.resolve(root, git(['rev-parse', '--git-common-dir'], root));
  const receipt = path.join(common, 'singularity-flow', 'fos', 'attachments', 'keep.json');
  await mkdir(path.dirname(receipt), { recursive: true });
  await writeFile(receipt, 'keep\n');
  const result = await clearFosDerivedCache(root);
  assert.equal(result.status, 'cleared');
  assert.equal(await readFosDerivedCache(root, key), null);
  assert.equal(await readFile(receipt, 'utf8'), 'keep\n');
});

test('FOS:AC-026 incomplete cache dependencies are refused before write', async () => {
  const root = await repository();
  await assert.rejects(() => writeFosDerivedCache(root, {
    producer: 'fos.test', producerVersion: '1', inputs: ['HEAD']
  }, {}), (error) => error.code === 'FOS_CACHE_KEY_INVALID');
});

test('FOS:AC-025 parser, configuration, membership, sparse, ignore and path-resolution inputs invalidate persistent facts', async () => {
  const root = await repository();
  const complete = {
    ...key,
    parser: `sha256:${'c'.repeat(64)}`,
    membership: `sha256:${'d'.repeat(64)}`,
    sparse: `sha256:${'e'.repeat(64)}`,
    ignore: `sha256:${'f'.repeat(64)}`,
    pathResolution: `sha256:${'1'.repeat(64)}`
  };
  await writeFosDerivedCache(root, complete, { bounded: true });
  assert.deepEqual(await readFosDerivedCache(root, complete), { bounded: true });
  for (const field of [
    'inputs', 'configuration', 'parser', 'membership', 'sparse', 'ignore', 'pathResolution'
  ]) {
    const changed = structuredClone(complete);
    changed[field] = field === 'inputs'
      ? [`sha256:${'2'.repeat(64)}`]
      : `sha256:${'2'.repeat(64)}`;
    assert.equal(await readFosDerivedCache(root, changed), null, field);
  }
});

test('FOS:AC-026 malformed optional dependency digests are refused before cache write', async () => {
  const root = await repository();
  await assert.rejects(() => writeFosDerivedCache(root, {
    ...key, parser: 'parser-v1'
  }, {}), (error) => error.code === 'FOS_CACHE_KEY_INVALID');
});
