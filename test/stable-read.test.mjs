import assert from 'node:assert/strict';
import { mkdtemp, writeFile, utimes, stat, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { withStableRead } from '../src/stable-read.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-stable-read-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json'); await writeFile(file, 'aaaa');
  return { directory, file };
}

test('a stable read returns its typed result and preserves the original file', async t => {
  const { file } = await fixture(t);
  assert.deepEqual(await withStableRead({ files: [file], identity: () => 'same' }, async () => ({ ready: true })), { ready: true });
});

test('same-size restored-time changes rebuild once rather than return stale content', async t => {
  const { file } = await fixture(t); const before = await stat(file); let reads = 0;
  const result = await withStableRead({ files: [file], identity: () => 'same' }, async () => {
    if (++reads === 1) { await writeFile(file, 'bbbb'); await utimes(file, before.atime, before.mtime); }
    return reads;
  });
  assert.equal(result, 2); assert.equal(reads, 2);
});

test('continued identity drift refuses after one rebuild and preserves caller-owned abort reasons', async t => {
  const { file } = await fixture(t); let identity = 0, reads = 0;
  await assert.rejects(withStableRead({ files: [file], identity: () => identity++ }, async () => ++reads), { code: 'READ_SNAPSHOT_STALE' });
  assert.equal(reads, 2);
  const controller = new AbortController(); controller.abort('secret caller reason');
  await assert.rejects(withStableRead({ files: [file], identity: () => 'same', signal: controller.signal }, () => { throw new Error('must not run'); }),
    error => error.code === 'READ_CANCELLED' && !error.message.includes('secret'));
});

test('an ABA file edit is not hidden by restoring its content and modification time', async t => {
  const { file } = await fixture(t); const before = await stat(file); let reads = 0;
  const observed = await withStableRead({ files: [file], identity: () => 'same' }, async () => {
    if (++reads === 1) { await writeFile(file, 'bbbb'); await writeFile(file, 'aaaa'); await utimes(file, before.atime, before.mtime); }
    return reads;
  });
  assert.equal(observed, 2);
});

test('parallel requests and a later request never inherit another request snapshot', async t => {
  const first = await fixture(t), second = await fixture(t);
  let release; const gate = new Promise(resolve => { release = resolve; });
  const held = withStableRead({ files: [first.file], identity: () => 'one' }, async () => { await gate; return 'one'; });
  assert.equal(await withStableRead({ files: [second.file], identity: () => 'two' }, () => 'two'), 'two');
  release(); assert.equal(await held, 'one');
  await writeFile(first.file, 'next');
  assert.equal(await withStableRead({ files: [first.file], identity: () => 'new-request' }, () => 'new'), 'new');
});

test('missing dependencies and lazy dependencies invalidate, and symlinks cannot become cached authority', async t => {
  const { directory, file } = await fixture(t); const missing = path.join(directory, 'missing'); let reads = 0;
  assert.equal(await withStableRead({ files: [missing], identity: () => 'same' }, async ({ watch }) => {
    await watch(file); if (++reads === 1) await writeFile(missing, 'created'); return reads;
  }), 2);
  const link = path.join(directory, 'link'); await symlink(file, link);
  await assert.rejects(withStableRead({ files: [link], identity: () => 'same' }, () => null), { code: 'READ_SNAPSHOT_UNAVAILABLE' });
});

test('a dependency removed between stat and open triggers a bounded rebuild, not a raw filesystem error', async t => {
  const { file } = await fixture(t); const original = fs.open; let interleaved = false, reads = 0;
  const hook = t.mock.method(fs, 'open', async (...args) => {
    if (args[0] === file && !interleaved) {
      interleaved = true; await rm(file);
      throw Object.assign(new Error('removed during capture'), { code: 'ENOENT' });
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(await withStableRead({ files: [file], identity: () => 'same' }, () => ++reads), 1);
    assert.equal(interleaved, true);
  } finally { hook.mock.restore(); syncBuiltinESMExports(); }
});
