import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sha256 } from '../src/sgos/contracts.mjs';
import {
  doctorSgosDevice, installedDeviceManifests, invokeSgosDevice, readSgosToolIntent,
  readSgosSandboxCasEffect, readSgosToolResult, recoverSgosToolIntent, revokeSgosDevice,
  SGOS_SANDBOX_CAS_ABSENT_SHA256, verifySgosSandboxCasPostcondition
} from '../src/sgos/devices.mjs';
import { resolveInstalledGvmAdapter } from '../src/sgos/gvm-adapters.mjs';

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

function sandboxCasRequest(overrides = {}) {
  const manifest = installedDeviceManifests().find((entry) => entry.id === 'sandbox-cas');
  assert.ok(manifest);
  return {
    deviceId: 'sandbox-cas', operation: 'compare-and-swap-put',
    processId: 'PROC-123456', taskInstanceId: 'task-cas', attemptId: 'ATT-CAS-123456',
    arguments: {
      key: 'test-key', expectedValueSha256: SGOS_SANDBOX_CAS_ABSENT_SHA256,
      value: { result: 'bounded fixture effect' }
    },
    scope: ['sandbox-cas:test-key'], authorizationSha256: manifest.manifestSha256,
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

test('Sandbox CAS durably binds one consequential fixture effect to its prior Tool Intent', async (t) => {
  const root = await repository(t);
  const applicationEntries = await readdir(root);
  const inputBefore = await readFile(path.join(root, 'input.txt'), 'utf8');
  const invocation = await invokeSgosDevice(root, sandboxCasRequest());
  assert.equal(invocation.result.status, 'observed');
  assert.equal(invocation.result.assurance, 'exact-postcondition-verified');
  assert.equal(invocation.result.effect.class, 'local-consequential');
  assert.equal(invocation.result.effect.changed, true);
  const effect = await readSgosSandboxCasEffect(root, 'test-key');
  assert.equal(effect.intentSha256, invocation.intent.intentSha256);
  assert.equal(effect.effectSha256, invocation.result.effect.effectSha256);
  assert.equal((await verifySgosSandboxCasPostcondition(
    root, invocation.intent, invocation.result
  )).status, 'passed');
  assert.deepEqual(await readdir(root), applicationEntries,
    'the consequential fixture remains inside Git-common SGOS storage');
  assert.equal(await readFile(path.join(root, 'input.txt'), 'utf8'), inputBefore);
});

test('Sandbox CAS recovery distinguishes not-started and applied without replaying the effect', async (t) => {
  const root = await repository(t);
  const beforeEffect = sandboxCasRequest({
    attemptId: 'ATT-CAS-BEFORE',
    arguments: {
      key: 'before-boundary', expectedValueSha256: SGOS_SANDBOX_CAS_ABSENT_SHA256,
      value: { sequence: 1 }
    },
    scope: ['sandbox-cas:before-boundary']
  });
  let beforeIntent = null;
  await assert.rejects(
    invokeSgosDevice(root, beforeEffect, {
      faultInjector(boundary, context) {
        if (boundary === 'after-tool-intent-before-effect') {
          beforeIntent = context.intentSha256;
          throw Object.assign(new Error('simulated pre-effect crash'), { code: 'TEST_CRASH' });
        }
      }
    }),
    (error) => error.code === 'TEST_CRASH'
  );
  assert.match(beforeIntent, /^sha256:/);
  assert.equal(await readSgosSandboxCasEffect(root, 'before-boundary', { optional: true }), null);
  const recoveredBefore = await recoverSgosToolIntent(root, beforeIntent, beforeEffect);
  assert.deepEqual(recoveredBefore.result.observation.recovery, {
    detected: 'not-started', action: 'applied', recovering: true
  });

  const afterEffect = sandboxCasRequest({
    attemptId: 'ATT-CAS-AFTER',
    arguments: {
      key: 'after-boundary', expectedValueSha256: SGOS_SANDBOX_CAS_ABSENT_SHA256,
      value: { sequence: 2 }
    },
    scope: ['sandbox-cas:after-boundary']
  });
  let afterIntent = null;
  await assert.rejects(
    invokeSgosDevice(root, afterEffect, {
      faultInjector(boundary, context) {
        if (boundary === 'after-effect-before-tool-result') {
          afterIntent = context.intentSha256;
          throw Object.assign(new Error('simulated post-effect crash'), { code: 'TEST_CRASH' });
        }
      }
    }),
    (error) => error.code === 'TEST_CRASH' && error.uncertainEffect === true
  );
  const applied = await readSgosSandboxCasEffect(root, 'after-boundary');
  const recoveredAfter = await recoverSgosToolIntent(root, afterIntent, afterEffect);
  assert.deepEqual(recoveredAfter.result.observation.recovery, {
    detected: 'applied', action: 'verified-noop', recovering: true
  });
  assert.equal((await readSgosSandboxCasEffect(root, 'after-boundary')).effectSha256,
    applied.effectSha256);
  const repeated = await recoverSgosToolIntent(root, afterIntent, afterEffect);
  assert.equal(repeated.recovered, true);
  assert.equal(repeated.result.resultSha256, recoveredAfter.result.resultSha256);
});

test('a revocation racing after a consequential effect preserves exact recovery identity', async (t) => {
  const root = await repository(t);
  const requestValue = sandboxCasRequest({
    attemptId: 'ATT-CAS-REVOKED-AFTER-EFFECT',
    arguments: {
      key: 'revoked-after-effect', expectedValueSha256: SGOS_SANDBOX_CAS_ABSENT_SHA256,
      value: { durable: true }
    },
    scope: ['sandbox-cas:revoked-after-effect']
  });
  const manifest = installedDeviceManifests().find((entry) => entry.id === 'sandbox-cas');
  let intentSha256 = null;
  await assert.rejects(invokeSgosDevice(root, requestValue, {
    async faultInjector(boundary, context) {
      if (boundary !== 'after-effect-before-tool-result') return;
      intentSha256 = context.intentSha256;
      const preview = await revokeSgosDevice(root, manifest.manifestSha256, {
        reason: 'concurrent post-effect revocation'
      });
      await revokeSgosDevice(root, manifest.manifestSha256, {
        reason: 'concurrent post-effect revocation',
        confirmationSha256: preview.confirmationSha256,
        revokedAt: '2026-08-30T00:02:00.000Z'
      });
    }
  }), (error) => {
    assert.equal(error.code, 'SGOS_DEVICE_REVOKED');
    assert.equal(error.toolIntentSha256, intentSha256);
    assert.equal(error.uncertainEffect, true);
    return true;
  });
  assert.match(intentSha256, /^sha256:/);
  assert.equal((await readSgosSandboxCasEffect(root, 'revoked-after-effect')).intentSha256,
    intentSha256, 'the consequential effect exists even though result finalization was refused');
  await assert.rejects(
    () => readSgosToolResult(root, intentSha256),
    (error) => error.code === 'SGOS_TOOL_RESULT_NOT_FOUND'
  );
});

test('Sandbox CAS cancellation is durable before effect and recovery applies exactly once', async (t) => {
  const root = await repository(t);
  const controller = new AbortController();
  controller.abort();
  const cancelled = sandboxCasRequest({
    attemptId: 'ATT-CAS-CANCEL',
    arguments: {
      key: 'cancelled-key', expectedValueSha256: SGOS_SANDBOX_CAS_ABSENT_SHA256,
      value: 'eventual value'
    },
    scope: ['sandbox-cas:cancelled-key']
  });
  let intentSha256 = null;
  await assert.rejects(
    invokeSgosDevice(root, cancelled, { signal: controller.signal }),
    (error) => {
      intentSha256 = error.toolIntentSha256;
      return error.code === 'SGOS_DEVICE_CANCELLED' && error.uncertainEffect !== true;
    }
  );
  assert.match(intentSha256, /^sha256:/);
  assert.equal(await readSgosSandboxCasEffect(root, 'cancelled-key', { optional: true }), null);
  const recovered = await recoverSgosToolIntent(root, intentSha256, cancelled);
  assert.equal(recovered.result.verification.status, 'passed');
});

test('Sandbox CAS fails closed on stale, scope, schema, duplicate, and counterfeit requests', async (t) => {
  const root = await repository(t);
  await assert.rejects(
    invokeSgosDevice(root, sandboxCasRequest({
      arguments: { key: 'stale', expectedValueSha256: sha256('not-absent'), value: 1 },
      scope: ['sandbox-cas:stale']
    })),
    (error) => error.code === 'SGOS_DEVICE_CAS_STALE' && error.effectDisposition === 'not-applied'
  );
  await assert.rejects(
    invokeSgosDevice(root, sandboxCasRequest({ scope: ['sandbox-cas:another-key'] })),
    (error) => error.code === 'SGOS_DEVICE_SCOPE_ESCAPE'
  );
  await assert.rejects(
    invokeSgosDevice(root, sandboxCasRequest({
      arguments: {
        key: 'test-key', expectedValueSha256: SGOS_SANDBOX_CAS_ABSENT_SHA256,
        value: 1, extra: true
      }
    })),
    (error) => error.code === 'SGOS_DEVICE_REQUEST_INVALID'
  );
  const first = await invokeSgosDevice(root, sandboxCasRequest());
  const exactDuplicate = await invokeSgosDevice(root, sandboxCasRequest());
  assert.equal(exactDuplicate.result.resultSha256, first.result.resultSha256);
  await assert.rejects(
    invokeSgosDevice(root, sandboxCasRequest({ attemptId: 'ATT-CAS-COLLISION' })),
    (error) => error.code === 'SGOS_DEVICE_IDEMPOTENCY_COLLISION'
  );
  await assert.rejects(
    invokeSgosDevice(root, sandboxCasRequest({
      attemptId: 'ATT-CAS-STALE',
      arguments: {
        key: 'test-key', expectedValueSha256: SGOS_SANDBOX_CAS_ABSENT_SHA256,
        value: { result: 'different' }
      }
    })),
    (error) => error.code === 'SGOS_DEVICE_CAS_STALE'
  );
  await assert.rejects(
    invokeSgosDevice(root, sandboxCasRequest({ deviceId: 'sandbox-cas-counterfeit' })),
    (error) => error.code === 'SGOS_DEVICE_NOT_INSTALLED'
  );
});

test('Sandbox CAS recovery classifies a changed effect record as uncertain', async (t) => {
  const root = await repository(t);
  const requestValue = sandboxCasRequest({
    attemptId: 'ATT-CAS-UNCERTAIN',
    arguments: {
      key: 'uncertain-key', expectedValueSha256: SGOS_SANDBOX_CAS_ABSENT_SHA256,
      value: { durable: true }
    },
    scope: ['sandbox-cas:uncertain-key']
  });
  let intentSha256 = null;
  await assert.rejects(invokeSgosDevice(root, requestValue, {
    faultInjector(boundary, context) {
      if (boundary === 'after-effect-before-tool-result') {
        intentSha256 = context.intentSha256;
        throw Object.assign(new Error('simulated crash'), { code: 'TEST_CRASH' });
      }
    }
  }));
  const effectPath = path.join(root, '.git', 'singularity-flow', 'sgos', 'devices',
    'effects', 'sandbox-cas', 'uncertain-key.json');
  const changed = { ...(await readSgosSandboxCasEffect(root, 'uncertain-key')), deviceRecordVersion: 999 };
  await writeFile(effectPath, JSON.stringify(changed));
  await assert.rejects(
    recoverSgosToolIntent(root, intentSha256, requestValue),
    (error) => error.code === 'SGOS_DEVICE_EFFECT_UNCERTAIN' && error.uncertainEffect === true
  );
});

test('Sandbox CAS exact manifest revocation blocks its consequential boundary', async (t) => {
  const root = await repository(t);
  const manifest = installedDeviceManifests().find((entry) => entry.id === 'sandbox-cas');
  const preview = await revokeSgosDevice(root, manifest.manifestSha256, { reason: 'fixture retired' });
  await revokeSgosDevice(root, manifest.manifestSha256, {
    reason: 'fixture retired', confirmationSha256: preview.confirmationSha256,
    revokedAt: '2026-08-30T00:01:00.000Z'
  });
  await assert.rejects(invokeSgosDevice(root, sandboxCasRequest()),
    (error) => error.code === 'SGOS_DEVICE_REVOKED');
});

test('Sandbox CAS GVM admission requires the exact installed manifest and compiled effect scope', () => {
  const manifest = installedDeviceManifests().find((entry) => entry.id === 'sandbox-cas');
  const template = {
    opcode: 'DEVICE', operation: 'fixture.cas-put',
    metadata: {
      deviceId: manifest.id, deviceVersion: manifest.version,
      deviceManifestSha256: manifest.manifestSha256
    },
    resources: {
      reads: [], writes: ['sandbox-cas:admission-key'], devices: [manifest.id],
      externalEffects: ['sandbox-cas:admission-key']
    }
  };
  assert.equal(resolveInstalledGvmAdapter(template).id, 'sandbox-cas');
  assert.throws(
    () => resolveInstalledGvmAdapter({
      ...template,
      metadata: { ...template.metadata, deviceManifestSha256: sha256('counterfeit') }
    }),
    (error) => error.code === 'SGOS_DEVICE_MANIFEST_MISMATCH'
  );
  assert.throws(
    () => resolveInstalledGvmAdapter({
      ...template,
      metadata: { ...template.metadata, deviceVersion: '0.9.0' }
    }),
    (error) => error.code === 'SGOS_DEVICE_MANIFEST_MISMATCH'
  );
  assert.throws(
    () => resolveInstalledGvmAdapter({
      ...template,
      resources: { ...template.resources, externalEffects: ['sandbox-cas:other-key'] }
    }),
    (error) => error.code === 'SGOS_DEVICE_GVM_PROFILE_UNSUPPORTED'
  );
  assert.throws(
    () => resolveInstalledGvmAdapter({
      ...template,
      resources: { ...template.resources, reads: ['app.mjs'] }
    }),
    (error) => error.code === 'SGOS_DEVICE_GVM_PROFILE_UNSUPPORTED'
  );
});
