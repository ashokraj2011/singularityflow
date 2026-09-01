import assert from 'node:assert/strict';
import {
  chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { gitCommonDir } from '../src/git.mjs';
import {
  AUTO_PRIVATE_RECORD_LIMITS, listAutoPrivateRecords, readAutoPrivateRecord,
  writeAutoPrivateRecord
} from '../src/auto/auto-private-store.mjs';

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-auto-private-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const initialized = spawnSync('git', ['init', '-b', 'main'], { cwd: root, encoding: 'utf8' });
  if (initialized.status !== 0) throw new Error(initialized.stderr);
  return root;
}

function privatePath(root, ...segments) {
  return path.join(gitCommonDir(root), 'singularity-flow', ...segments);
}

test('Auto private records are bounded, private, mutable, and listable', async (t) => {
  const root = await repository(t);
  const directory = privatePath(root, 'auto-flights', `AFL-${'A'.repeat(26)}`);
  const target = path.join(directory, 'state.json');
  assert.equal(await readAutoPrivateRecord(root, target, 'flight-state', { optional: true }), null);
  assert.deepEqual(await listAutoPrivateRecords(root, privatePath(root, 'auto-flights')), []);

  assert.equal((await writeAutoPrivateRecord(root, target, 'flight-state', '{"value":1}')).created, true);
  assert.equal(await readAutoPrivateRecord(root, target, 'flight-state'), '{"value":1}');
  assert.equal((await writeAutoPrivateRecord(root, target, 'flight-state', '{"value":2}')).created, false);
  assert.equal(await readAutoPrivateRecord(root, target, 'flight-state'), '{"value":2}');
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o077, 0,
    'new Auto private directories must not grant group/other access');
  assert.deepEqual((await listAutoPrivateRecords(root, privatePath(root, 'auto-flights')))
    .map((entry) => entry.name), [`AFL-${'A'.repeat(26)}`]);

  const oversized = Buffer.alloc(AUTO_PRIVATE_RECORD_LIMITS['flight-state'] + 1);
  await assert.rejects(
    () => writeAutoPrivateRecord(root, path.join(directory, 'too-large.json'), 'flight-state', oversized),
    (error) => error.code === 'AUTO_PRIVATE_STORE_SIZE_LIMIT'
  );
});

test('Auto private reads reject oversized and non-regular records', async (t) => {
  const root = await repository(t);
  const directory = privatePath(root, 'auto-plans');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const oversized = path.join(directory, `APL-${'B'.repeat(26)}.json`);
  await writeFile(oversized, Buffer.alloc(AUTO_PRIVATE_RECORD_LIMITS.plan + 1));
  await assert.rejects(
    () => readAutoPrivateRecord(root, oversized, 'plan'),
    (error) => error.code === 'AUTO_PRIVATE_STORE_SIZE_LIMIT'
  );

  const nonRegular = path.join(directory, `APL-${'C'.repeat(26)}.json`);
  await mkdir(nonRegular);
  await assert.rejects(
    () => readAutoPrivateRecord(root, nonRegular, 'plan'),
    (error) => error.code === 'AUTO_PRIVATE_STORE_UNSAFE'
  );
});

test('Auto private storage refuses symlink ancestors and final records', {
  skip: process.platform === 'win32'
}, async (t) => {
  const root = await repository(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-auto-private-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const base = privatePath(root);
  await mkdir(base, { recursive: true, mode: 0o700 });

  const plans = path.join(base, 'auto-plans');
  await symlink(outside, plans, 'dir');
  const escaped = path.join(plans, `APL-${'D'.repeat(26)}.json`);
  await assert.rejects(
    () => writeAutoPrivateRecord(root, escaped, 'plan', '{}', { immutable: true }),
    (error) => error.code === 'AUTO_PRIVATE_STORE_UNSAFE'
  );
  await assert.rejects(() => lstat(path.join(outside, path.basename(escaped))), (error) => error.code === 'ENOENT');

  await rm(plans);
  await mkdir(plans, { mode: 0o700 });
  const external = path.join(outside, 'authorization.json');
  await writeFile(external, 'outside');
  const linked = path.join(plans, `APL-${'E'.repeat(26)}.json`);
  await symlink(external, linked);
  await assert.rejects(
    () => readAutoPrivateRecord(root, linked, 'authorization'),
    (error) => error.code === 'AUTO_PRIVATE_STORE_UNSAFE'
  );
  await assert.rejects(
    () => writeAutoPrivateRecord(root, linked, 'authorization', 'replacement'),
    (error) => error.code === 'AUTO_PRIVATE_STORE_UNSAFE'
  );
  assert.equal(await readFile(external, 'utf8'), 'outside');
});

test('Story Auto private storage has no SGOS module dependency', async () => {
  const source = await readFile(path.resolve('src/auto/auto-private-store.mjs'), 'utf8');
  assert.doesNotMatch(source, /(?:from|import\()\s*['"][^'"]*\/sgos\//u);
  assert.match(source, /from ['"]\.\.\/private-sidecar\.mjs['"]/u);
});
