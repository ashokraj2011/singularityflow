import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sha256 } from '../src/sgos/contracts.mjs';
import {
  doctorSgosDevice, installedDeviceManifests, invokeSgosDevice, readSgosToolIntent,
  readSgosToolResult, recoverSgosToolIntent, revokeSgosDevice
} from '../src/sgos/devices.mjs';

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-device-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  await writeFile(path.join(root, 'input.txt'), 'device evidence\n');
  return root;
}

function request(overrides = {}) {
  return {
    deviceId: 'filesystem-read', operation: 'read-file',
    processId: 'PROC-123456', taskInstanceId: 'task-1', attemptId: 'ATT-123456',
    arguments: { path: 'input.txt' }, scope: ['input.txt'],
    authorizationSha256: sha256('authority'),
    createdAt: '2026-08-30T00:00:00.000Z',
    ...overrides
  };
}

test('Device writes an exact Tool Intent before a host-observed Tool Result', async (t) => {
  const root = await repository(t);
  const invocation = await invokeSgosDevice(root, request());
  assert.equal(invocation.result.status, 'observed');
  assert.equal(invocation.result.intentSha256, invocation.intent.intentSha256);
  assert.equal(invocation.result.observation.bytes, Buffer.byteLength('device evidence\n'));
  assert.equal(invocation.result.effect.changed, false);
  assert.equal(Object.isFrozen(invocation.manifest.effects), true);
  assert.equal(Object.isFrozen(invocation.result.observation), true);
  assert.equal((await readSgosToolIntent(root, invocation.intent.intentSha256)).intentSha256,
    invocation.intent.intentSha256);
  assert.equal(Object.hasOwn(invocation.intent, 'arguments'), false,
    'raw arguments do not enter the durable Tool Intent');
});

test('Device refuses a symlinked private ledger without writing outside Git authority', async (t) => {
  const root = await repository(t);
  const redirected = await mkdtemp(path.join(os.tmpdir(), 'sflow-device-redirect-'));
  t.after(() => rm(redirected, { recursive: true, force: true }));
  await mkdir(path.join(root, '.git', 'singularity-flow', 'sgos'), { recursive: true });
  try {
    await symlink(redirected, path.join(root, '.git', 'singularity-flow', 'sgos', 'devices'),
      process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error?.code)) {
      t.diagnostic('Windows host does not permit unprivileged links; sidecar ancestor checks remain active.');
      return;
    }
    throw error;
  }
  await assert.rejects(invokeSgosDevice(root, request()),
    (error) => error.code === 'SGOS_SIDECAR_PATH_UNSAFE');
  assert.deepEqual(await readdir(redirected), []);
});

test('Filesystem Device refuses traversal and symlink escape', async (t) => {
  const root = await repository(t);
  await assert.rejects(
    invokeSgosDevice(root, request({ arguments: { path: '../outside.txt' }, scope: ['..'] })),
    (error) => error.code === 'SGOS_DEVICE_SCOPE_ESCAPE'
  );
  await assert.rejects(
    invokeSgosDevice(root, request({ arguments: { path: 'input.txt' }, scope: ['another'] })),
    (error) => error.code === 'SGOS_DEVICE_SCOPE_ESCAPE'
  );
  await writeFile(path.join(root, 'in-repository-secret.txt'), 'must remain outside scope\n');
  try {
    await symlink('in-repository-secret.txt', path.join(root, 'scoped-link.txt'));
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error?.code)) {
      t.diagnostic('Windows host does not permit unprivileged file symlinks; lexical scope checks remain active.');
      return;
    }
    throw error;
  }
  await assert.rejects(
    invokeSgosDevice(root, request({
      arguments: { path: 'scoped-link.txt' }, scope: ['scoped-link.txt']
    })),
    (error) => error.code === 'SGOS_DEVICE_SCOPE_ESCAPE'
  );
});

test('Tool Intent recovery reuses the exact durable result and rejects changed arguments', async (t) => {
  const root = await repository(t);
  const invocation = await invokeSgosDevice(root, request());
  const recovered = await recoverSgosToolIntent(root, invocation.intent.intentSha256, request());
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.result.resultSha256, invocation.result.resultSha256);
  assert.equal((await readSgosToolResult(root, invocation.intent.intentSha256)).resultSha256,
    invocation.result.resultSha256);
  await assert.rejects(
    recoverSgosToolIntent(root, invocation.intent.intentSha256,
      request({ arguments: { path: 'other.txt' } })),
    (error) => error.code === 'SGOS_TOOL_INTENT_REQUEST_MISMATCH'
  );
});

test('Tool Result reads fail closed when raw evidence no longer matches the exact receipt', async (t) => {
  const root = await repository(t);
  const invocation = await invokeSgosDevice(root, request());
  await writeFile(path.join(root, '.git', 'singularity-flow', 'sgos', 'devices', 'raw',
    `${invocation.intent.intentSha256.slice('sha256:'.length)}.bin`), 'tampered evidence\n');
  await assert.rejects(
    readSgosToolResult(root, invocation.intent.intentSha256),
    (error) => error.code === 'SGOS_TOOL_RESULT_INVALID'
  );
});

test('Device revocation is confirmation-bound and blocks later invocation', async (t) => {
  const root = await repository(t);
  const manifest = installedDeviceManifests()[0];
  assert.equal((await doctorSgosDevice(root, manifest.id)).status, 'ready');
  const preview = await revokeSgosDevice(root, manifest.manifestSha256, { reason: ' fixture revocation ' });
  assert.equal(preview.revoked, false);
  assert.equal(preview.reason, 'fixture revocation');
  const revoked = await revokeSgosDevice(root, manifest.manifestSha256, {
    reason: 'fixture revocation', confirmationSha256: preview.confirmationSha256,
    revokedAt: '2026-08-30T00:01:00.000Z'
  });
  assert.equal(revoked.revoked, true);
  await assert.rejects(invokeSgosDevice(root, request()),
    (error) => error.code === 'SGOS_DEVICE_REVOKED');
});
