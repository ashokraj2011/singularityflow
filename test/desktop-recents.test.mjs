import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  forgetRecentRepository,
  MAX_RECENT_REPOSITORIES,
  readRecentRepositories,
  rememberRecentRepository
} from '../apps/desktop/electron/recent-repositories.mjs';

test('recent repository store persists, deduplicates, orders, limits, and forgets locations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-desktop-recents-'));
  const store = path.join(root, 'settings', 'recent-repositories.json');
  assert.deepEqual(await readRecentRepositories(store), []);

  const first = path.join(root, 'first'); const second = path.join(root, 'second');
  await rememberRecentRepository(store, { path: first, branch: 'main', openedAt: '2026-07-20T10:00:00.000Z' });
  await rememberRecentRepository(store, { path: second, name: 'Second project', branch: 'feature', openedAt: '2026-07-21T10:00:00.000Z' });
  await rememberRecentRepository(store, { path: first, name: 'First renamed', branch: 'work', openedAt: '2026-07-22T10:00:00.000Z' });
  let recent = await readRecentRepositories(store);
  assert.deepEqual(recent.map((item) => item.name), ['First renamed', 'Second project']);
  assert.equal(recent[0].branch, 'work');
  assert.equal(recent.filter((item) => item.path === first).length, 1);

  for (let index = 0; index < MAX_RECENT_REPOSITORIES + 3; index += 1) {
    await rememberRecentRepository(store, { path: path.join(root, `repository-${index}`), openedAt: new Date(Date.UTC(2026, 6, 23, index)).toISOString() });
  }
  recent = await readRecentRepositories(store);
  assert.equal(recent.length, MAX_RECENT_REPOSITORIES);
  assert.equal(recent[0].name, `repository-${MAX_RECENT_REPOSITORIES + 2}`);

  const removed = recent[3].path;
  await forgetRecentRepository(store, removed);
  assert.ok(!(await readRecentRepositories(store)).some((item) => item.path === removed));
  const persisted = JSON.parse(await readFile(store, 'utf8'));
  assert.equal(persisted.schemaVersion, 1);
});

test('recent repository store safely recovers from malformed local state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-desktop-recents-bad-'));
  const store = path.join(root, 'recent-repositories.json');
  await writeFile(store, '{not-json', 'utf8');
  assert.deepEqual(await readRecentRepositories(store), []);
  const recent = await rememberRecentRepository(store, { path: path.join(root, 'repository'), branch: 'main' });
  assert.equal(recent.length, 1);
});
