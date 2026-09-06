import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MAX_SNAPSHOT_CACHE_BYTES, MAX_SNAPSHOT_CACHE_REPOSITORIES, RepositorySnapshotFileCache
} from '../apps/vscode/src/snapshot-file-cache.ts';

test('snapshot file cache is atomic, repository-isolated, bounded, and path-free', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-snapshot-cache-'));
  try {
    const cache = new RepositorySnapshotFileCache(root);
    const repository = path.join(root, 'a-secret-repository-name');
    assert.equal(await cache.persist(repository, { revision: 1, value: 'first' }), true);
    cache.write(repository, { revision: 2, value: 'second' });
    cache.write(repository, { revision: 3, value: 'latest' });
    await cache.flush();
    assert.deepEqual(cache.read(repository), { revision: 3, value: 'latest' });
    assert.equal(cache.read(path.join(root, 'different')), null);

    for (let index = 0; index < MAX_SNAPSHOT_CACHE_REPOSITORIES + 3; index += 1) {
      assert.equal(await cache.persist(path.join(root, `repository-${index}`), { index }), true);
    }
    const directory = path.join(root, 'snapshot-cache-v2');
    const files = await readdir(directory);
    assert.equal(files.filter((name) => name.endsWith('.json')).length,
      MAX_SNAPSHOT_CACHE_REPOSITORIES);
    assert.ok(files.every((name) => !name.includes('repository') && !name.includes('secret')),
      'a repository path leaked into a cache filename');
    assert.ok(files.every((name) => !name.endsWith('.tmp')), 'an atomic-write temporary file remained');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('snapshot file cache refuses corrupt and oversized records', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-snapshot-cache-corrupt-'));
  try {
    const cache = new RepositorySnapshotFileCache(root);
    const repository = 'corrupt';
    assert.equal(await cache.persist(repository, { safe: true }), true);
    const directory = path.join(root, 'snapshot-cache-v2');
    const [target] = (await readdir(directory)).filter((name) => name.endsWith('.json'));
    await writeFile(path.join(directory, target), Buffer.alloc(MAX_SNAPSHOT_CACHE_BYTES + 1));
    assert.equal(cache.read(repository), null);
    await writeFile(path.join(directory, target), '{not-json');
    assert.equal(cache.read(repository), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
