import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, stat, rename, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  readPrivateSidecar, safePrivateSidecarDirectory, writeImmutablePrivateSidecar, writeMutablePrivateSidecar
} from '../src/private-sidecar.mjs';

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-private-sidecar-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const initialized = spawnSync('git', ['init', '-b', 'main'], {
    cwd: root, encoding: 'utf8'
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  return root;
}

test('private sidecars retain bytes and enforce POSIX modes on supporting hosts', async (t) => {
  const root = await repository(t);
  const target = path.join(root, '.git', 'singularity-flow', 'private', 'record.json');
  await writeImmutablePrivateSidecar(root, target, Buffer.from('{}'), { maximumBytes: 32 });
  assert.deepEqual(await readPrivateSidecar(root, target, { maximumBytes: 32 }), Buffer.from('{}'));
  // Windows uses the separately qualified current-user ACL contract, not synthetic stat modes.
  if (process.platform === 'win32') return;
  assert.equal((await stat(path.dirname(target))).mode & 0o077, 0);
  assert.equal((await stat(target)).mode & 0o077, 0);

  await chmod(target, 0o644);
  await assert.rejects(readPrivateSidecar(root, target, { maximumBytes: 32 }), {
    code: 'PRIVATE_SIDECAR_PATH_UNSAFE'
  });

  const other = await repository(t);
  const exposed = path.join(other, '.git', 'singularity-flow');
  await mkdir(path.join(exposed, 'private'), { recursive: true, mode: 0o755 });
  await assert.rejects(safePrivateSidecarDirectory(other, path.join(exposed, 'private'), {
    create: false
  }), { code: 'PRIVATE_SIDECAR_PATH_UNSAFE' });
});

test('legacy Windows private sidecars do not impose a new ACL requirement', async (t) => {
  const root = await repository(t);
  const target = path.join(root, '.git', 'singularity-flow', 'legacy', 'record.json');
  const calls = [];
  const windowsAcl = async (selected, options) => calls.push({ selected, ...options });

  await writeImmutablePrivateSidecar(root, target, Buffer.from('{}'), {
    maximumBytes: 32, platform: 'win32', windowsAcl
  });
  await readPrivateSidecar(root, target, {
    maximumBytes: 32, platform: 'win32', windowsAcl
  });

  assert.deepEqual(calls, []);
});

test('strict Windows private sidecars apply and verify current-user-only ACL boundaries', async (t) => {
  const root = await repository(t);
  const target = path.join(root, '.git', 'singularity-flow', 'private', 'record.json');
  const calls = [];
  const windowsAcl = async (selected, options) => calls.push({ selected, ...options });

  await writeImmutablePrivateSidecar(root, target, Buffer.from('{}'), {
    maximumBytes: 32, platform: 'win32', windowsAcl, enforceWindowsAcl: true
  });
  await readPrivateSidecar(root, target, {
    maximumBytes: 32, platform: 'win32', windowsAcl, enforceWindowsAcl: true
  });

  assert.ok(calls.some((call) => call.selected === path.join(root, '.git', 'singularity-flow', 'private')
    && call.directory === true && call.apply === true));
  assert.ok(calls.some((call) => call.selected === target
    && call.directory === false && call.apply === true));
  assert.ok(calls.some((call) => call.selected === target
    && call.directory === false && call.apply === false));
});

test('Windows mutable sidecars retry transient replacement without deleting the old state', async t => {
  const root = await repository(t);
  const target = path.join(root, '.git', 'singularity-flow', 'retry', 'state.json');
  await writeMutablePrivateSidecar(root, target, 'old', { maximumBytes: 32 });
  let calls = 0;
  await writeMutablePrivateSidecar(root, target, 'new', {
    maximumBytes: 32, platform: 'win32', renameAttempts: 8,
    renameFile: async (from, to) => {
      calls += 1;
      if (calls <= 2) {
        assert.equal((await readPrivateSidecar(root, target, { maximumBytes: 32 })).toString(), 'old');
        throw Object.assign(new Error('temporary Windows sharing violation'), { code: calls === 1 ? 'EPERM' : 'EBUSY' });
      }
      return rename(from, to);
    }
  });
  assert.equal(calls, 3);
  assert.equal((await readPrivateSidecar(root, target, { maximumBytes: 32 })).toString(), 'new');
});

test('permanent Windows replacement failures retain state and remove only their pending file', async t => {
  const root = await repository(t);
  const target = path.join(root, '.git', 'singularity-flow', 'retry', 'state.json');
  await writeMutablePrivateSidecar(root, target, 'old', { maximumBytes: 32 });
  let calls = 0;
  const failure = Object.assign(new Error('permanent access denial'), { code: 'EPERM' });
  await assert.rejects(writeMutablePrivateSidecar(root, target, 'new', {
    maximumBytes: 32, platform: 'win32', renameAttempts: 3,
    renameFile: async () => { calls += 1; throw failure; }
  }), error => error === failure);
  assert.equal(calls, 3);
  assert.equal((await readPrivateSidecar(root, target, { maximumBytes: 32 })).toString(), 'old');
  assert.deepEqual(await readdir(path.dirname(target)), ['state.json']);
});

test('default and non-Windows access denial remains immediate', async t => {
  const root = await repository(t);
  const target = path.join(root, '.git', 'singularity-flow', 'retry', 'state.json');
  let calls = 0;
  await assert.rejects(writeMutablePrivateSidecar(root, target, 'new', {
    maximumBytes: 32, platform: process.platform,
    renameAttempts: process.platform === 'win32' ? 1 : 8,
    renameFile: async () => { calls += 1; throw Object.assign(new Error('access denied'), { code: 'EPERM' }); }
  }), { code: 'EPERM' });
  assert.equal(calls, 1);
});
