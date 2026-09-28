import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { probeSkpDockerContainment } from '../src/skp-docker-containment-probe.mjs';

const IMAGE = `docker.io/library/busybox@sha256:${'a'.repeat(64)}`; // Mock-only digest.
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const result = (text = '', status = 'ok') => ({
  status, stdout: Buffer.from(text), stderr: Buffer.alloc(0)
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skp-containment-test-'));
  const socket = path.join(root, 'docker.sock');
  const docker = path.join(root, 'docker');
  await writeFile(docker, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { packageBytes: Buffer.from('synthetic input bytes\n'), image: IMAGE,
    dockerExecutable: docker, dockerSocketPath: socket };
}

function mock({ override = {}, calls = [] } = {}) {
  const invoke = async (invocation) => {
    calls.push(invocation);
    const id = invocation.checkId;
    if (Object.hasOwn(override, id)) return override[id](invocation);
    if (id === 'image-inspect') return result(`${JSON.stringify([IMAGE])}\n`);
    if (id.endsWith('-absence')) return result();
    if (id.endsWith('-remove')) return result();
    if (id === 'hash') {
      const mount = invocation.args[invocation.args.indexOf('--mount') + 1];
      const source = mount.match(/^type=bind,source=(.+),target=\/skp\/input,readonly$/u)?.[1];
      assert.ok(source);
      return result(`${digest(await readFile(source))}  /skp/input\n`);
    }
    if (id === 'runtimePolicy') return result('runtime-policy=1:2\n');
    if (id === 'read') return result('read-denied\n');
    if (id === 'write') return result('write-denied\n');
    if (id === 'network') return result('network-denied\n');
    if (id === 'controlPlane') return result('control-denied\n');
    if (id === 'cancellation') return result('sleep-started\n', 'timeout');
    throw Error(`Unexpected mock operation ${id}`);
  };
  return { invoke, calls };
}

test('fixed Docker candidate observes synthetic containment without qualifying imported execution',
  { skip: process.platform === 'win32' }, async (t) => {
    const input = await fixture(t);
    const { invoke, calls } = mock();
    const report = await probeSkpDockerContainment(input, { invoke });
    assert.equal(report.status, 'candidate-observed');
    assert.equal(report.code, null);
    assert.equal(report.inputSha256, `sha256:${digest(input.packageBytes)}`);
    assert.equal(report.observationScope, 'fixed-local-busybox-candidate-only');
    assert.deepEqual(report.checks.map((item) => [item.id, item.status]), [
      ['hash', 'observed'], ['runtimePolicy', 'observed'], ['read', 'observed'],
      ['write', 'observed'], ['network', 'observed'], ['controlPlane', 'observed'],
      ['cancellation', 'observed']
    ]);
    assert.ok(report.recovery.containers.every((item) => item.cleanup === 'observed-absent'));
    assert.equal(report.recovery.localStageCleanup, 'observed-removed');
    assert.equal(report.recovery.effectsKnownAbsent, false);
    assert.equal(report.recovery.automaticRetryAuthorized, false);
    assert.equal(report.qualified, false);
    assert.equal(report.launchAuthorized, false);
    assert.equal(report.skillExecuted, false);
    assert.equal(report.deliveryAuthenticated, false);
    assert.equal(report.hostEnforcementProven, false);
    assert.equal(calls[0].checkId, 'image-inspect');
    const runs = calls.filter((item) => ['hash', 'runtimePolicy', 'read', 'write', 'network',
      'controlPlane', 'cancellation'].includes(item.checkId));
    assert.equal(runs.length, 7);
    for (const invocation of runs) {
      const args = invocation.args;
      assert.equal(args[0], '--host');
      assert.match(args[1], /^unix:\/\//u);
      assert.equal(args[2], '--config');
      assert.ok(path.isAbsolute(args[3]));
      assert.ok(args.includes('--pull=never'));
      assert.ok(args.includes('--read-only'));
      assert.deepEqual(args.filter((item) => item === '--security-opt').map((_, index) => {
        const positions = args.flatMap((item, position) => item === '--security-opt' ? [position] : []);
        return args[positions[index] + 1];
      }), ['no-new-privileges:true', 'seccomp=builtin']);
      for (const [flag, value] of [
        ['--log-driver', 'none'], ['--network', 'none'],
        ['--add-host', 'host.docker.internal:host-gateway'], ['--cap-drop', 'ALL'],
        ['--user', '65534:65534'], ['--pids-limit', '32'], ['--memory', '128m'],
        ['--memory-swap', '128m'], ['--cpus', '1'], ['--ipc', 'none'],
        ['--entrypoint', '/bin/busybox']
      ]) assert.equal(args[args.indexOf(flag) + 1], value);
      assert.equal(args.filter((item) => item === '--mount').length, 1);
      assert.ok(args.includes(IMAGE));
      assert.equal(args.includes('--privileged'), false);
      assert.equal(args.includes('--env-file'), false);
      assert.deepEqual(Object.keys(invocation.env).sort(), ['DOCKER_CONFIG', 'HOME', 'LANG', 'PATH']);
      assert.equal(invocation.env.DOCKER_CONFIG, args[3]);
    }
    assert.ok(calls.some((item) => item.checkId === 'cancellation-remove'));
  });

test('Docker candidate rejects unpinned images and unreviewed options before CLI access',
  { skip: process.platform === 'win32' }, async (t) => {
    const input = await fixture(t);
    const calls = []; const { invoke } = mock({ calls });
    for (const image of ['busybox:latest', `evil.invalid/busybox@sha256:${'a'.repeat(64)}`]) {
      await assert.rejects(probeSkpDockerContainment({ ...input, image }, { invoke }),
        { code: 'SKP_DOCKER_CONTAINMENT_INPUT_INVALID' });
    }
    await assert.rejects(probeSkpDockerContainment({ ...input, privileged: true }, { invoke }),
      { code: 'SKP_DOCKER_CONTAINMENT_INPUT_INVALID' });
    const accessor = Object.defineProperty({ ...input }, 'image', {
      get() { throw Error('should not read accessor'); }
    });
    await assert.rejects(probeSkpDockerContainment(accessor, { invoke }),
      { code: 'SKP_DOCKER_CONTAINMENT_INPUT_INVALID' });
    assert.equal(calls.length, 0);
  });

test('missing image and failed runtime security observation remain unavailable',
  { skip: process.platform === 'win32' }, async (t) => {
    const input = await fixture(t);
    const imageMissing = mock({ override: { 'image-inspect': () => result('[]\n') } });
    const missing = await probeSkpDockerContainment(input, imageMissing);
    assert.equal(missing.status, 'unavailable');
    assert.equal(missing.code, 'SKP_DOCKER_CONTAINMENT_IMAGE_UNAVAILABLE');
    assert.ok(missing.checks.every((item) => item.status === 'not-run'));
    assert.equal(imageMissing.calls.filter((item) => item.args.includes('run')).length, 0);
    const officialAlias = mock({ override: { 'image-inspect': () => result(
      `${JSON.stringify([IMAGE.replace('docker.io/library/', '')])}\n`
    ) } });
    const aliasReport = await probeSkpDockerContainment(input, officialAlias);
    assert.equal(aliasReport.status, 'candidate-observed');
    const seccompMissing = mock({ override: {
      runtimePolicy: () => result('runtime-policy=1:0\n')
    } });
    const unavailable = await probeSkpDockerContainment(input, seccompMissing);
    assert.equal(unavailable.status, 'unavailable');
    assert.equal(unavailable.code, 'SKP_DOCKER_CONTAINMENT_CHECK_UNAVAILABLE');
    assert.equal(unavailable.checks.find((item) => item.id === 'runtimePolicy').status, 'unavailable');
    assert.equal(unavailable.checks.find((item) => item.id === 'read').status, 'not-run');
  });

test('observed forbidden access or unknown cancellation cleanup never becomes candidate success',
  { skip: process.platform === 'win32' }, async (t) => {
    const input = await fixture(t);
    const opened = mock({ override: { read: () => result('read-open\n') } });
    const readFailure = await probeSkpDockerContainment(input, opened);
    assert.equal(readFailure.status, 'unavailable');
    assert.equal(readFailure.checks.find((item) => item.id === 'read').status, 'unavailable');
    const unknownCleanup = mock({ override: {
      'cancellation-absence': () => result('abc123\n')
    } });
    const cleanupFailure = await probeSkpDockerContainment(input, unknownCleanup);
    assert.equal(cleanupFailure.status, 'unavailable');
    assert.equal(cleanupFailure.recovery.containers.find((item) => item.id === 'cancellation').cleanup,
      'unknown');
    assert.equal(cleanupFailure.recovery.automaticRetryAuthorized, false);
    assert.ok(unknownCleanup.calls.some((item) => item.checkId === 'cancellation-remove'));
  });

test('reported write denial cannot hide mutation of the staged input',
  { skip: process.platform === 'win32' }, async (t) => {
    const input = await fixture(t);
    const mutated = mock({ override: { write: async (invocation) => {
      const mount = invocation.args[invocation.args.indexOf('--mount') + 1];
      const source = mount.match(/^type=bind,source=(.+),target=\/skp\/input,readonly$/u)?.[1];
      assert.ok(source);
      await writeFile(source, 'tampered');
      return result('write-denied\n');
    } } });
    const report = await probeSkpDockerContainment(input, mutated);
    assert.equal(report.status, 'unavailable');
    assert.equal(report.code, 'SKP_DOCKER_CONTAINMENT_CHECK_UNAVAILABLE');
    assert.equal(report.recovery.localStageCleanup, 'observed-removed');
  });
