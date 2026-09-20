import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  readPrivateSidecar, safePrivateSidecarDirectory, writeImmutablePrivateSidecar
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

test('private sidecars enforce private POSIX directories and files', async (t) => {
  const root = await repository(t);
  const target = path.join(root, '.git', 'singularity-flow', 'private', 'record.json');
  await writeImmutablePrivateSidecar(root, target, Buffer.from('{}'), { maximumBytes: 32 });
  assert.equal((await stat(path.dirname(target))).mode & 0o077, 0);
  assert.equal((await stat(target)).mode & 0o077, 0);
  assert.deepEqual(await readPrivateSidecar(root, target, { maximumBytes: 32 }), Buffer.from('{}'));

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
