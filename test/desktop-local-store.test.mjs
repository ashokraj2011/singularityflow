import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  atomicPrivateJson,
  atomicPrivateWrite,
  withLocalStoreMutation
} from '../apps/desktop/electron/local-store.mjs';

test('desktop local-store mutations stay ordered and recover after a failed mutation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-local-store-order-'));
  const file = path.join(root, 'state.json');
  const events = [];
  const results = await Promise.allSettled([
    withLocalStoreMutation(file, async () => {
      events.push('first-start');
      await Promise.resolve();
      events.push('first-fail');
      throw new Error('expected failure');
    }),
    withLocalStoreMutation(file, async () => {
      events.push('second-start');
      await atomicPrivateJson(file, { ready: true });
      events.push('second-complete');
    })
  ]);

  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'fulfilled');
  assert.deepEqual(events, ['first-start', 'first-fail', 'second-start', 'second-complete']);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('failed atomic desktop writes remove their unique temporary file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-local-store-cleanup-'));
  const target = path.join(root, 'existing-directory');
  await mkdir(target);

  await assert.rejects(() => atomicPrivateWrite(target, 'cannot replace a directory'));

  assert.deepEqual(await readdir(root), ['existing-directory']);
});
