import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeFosGitObjectServices, fosGitObjectService, FosGitObjectService
} from '../src/fos-object-service.mjs';

function git(args, cwd, options = {}) { return execFileSync('git', args, { cwd, encoding: options.binary ? null : 'utf8', input: options.input }).toString().trim(); }
async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-fos-objects-'));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.name', 'FOS Test'], root); git(['config', 'user.email', 'fos@example.com'], root);
  await writeFile(path.join(root, 'source.bin'), Buffer.from([0, 10, 255, 13, 10]));
  git(['add', '.'], root); git(['commit', '-qm', 'initial'], root);
  return root;
}

test('FOS:AC-031 persistent object service preserves binary bytes and missing results', async () => {
  const root = await repository();
  const oid = git(['rev-parse', 'HEAD:source.bin'], root);
  const service = new FosGitObjectService(root, { idleMs: 60_000 });
  const [first, second] = await Promise.all([service.read(oid), service.read(oid)]);
  assert.deepEqual(first.bytes, Buffer.from([0, 10, 255, 13, 10]));
  assert.deepEqual(second.bytes, first.bytes);
  assert.equal(service.processSpawns, 1);
  assert.equal(await service.read('0'.repeat(40)), null);
  await service.close();
});

test('FOS:AC-028 a missing object result is not sticky after the exact object becomes available', async () => {
  const root = await repository();
  const bytes = Buffer.from('arrives after the negative lookup\n');
  const oid = git(['hash-object', '--stdin'], root, { input: bytes });
  const service = new FosGitObjectService(root, { idleMs: 60_000 });
  assert.equal(await service.read(oid), null);
  assert.equal(git(['hash-object', '-w', '--stdin'], root, { input: bytes }), oid);
  const available = await service.read(oid);
  assert.equal(available.oid, oid);
  assert.equal(available.type, 'blob');
  assert.deepEqual(available.bytes, bytes);
  assert.equal(service.processSpawns, 1);
  await service.close();
});

test('FOS:AC-031 linked worktrees share one immutable object-store service', async () => {
  const root = await repository();
  const target = path.join(path.dirname(root), `${path.basename(root)}-linked`);
  git(['worktree', 'add', '-q', '-b', 'WORK-OBJECTS', target, 'main'], root);
  const first = await fosGitObjectService(root, { idleMs: 60_000 });
  const second = await fosGitObjectService(target, { idleMs: 60_000 });
  assert.equal(first, second);
  const oid = git(['rev-parse', 'HEAD:source.bin'], root);
  assert.deepEqual((await second.read(oid)).bytes, Buffer.from([0, 10, 255, 13, 10]));
  await closeFosGitObjectServices();
});

test('FOS:AC-031 oversized objects fail closed and terminate the protocol session', async () => {
  const root = await repository();
  const oid = git(['rev-parse', 'HEAD:source.bin'], root);
  const service = new FosGitObjectService(root, { maxObjectBytes: 2, idleMs: 60_000 });
  await assert.rejects(() => service.read(oid), (error) => error.code === 'LIMIT_EXCEEDED');
  await service.close();
});
