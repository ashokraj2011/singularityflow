import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  SKP_DOCKER_HASH_PROBE_LIMITS,
  invokeDockerHashProbeCli,
  probeSkpPackageInDocker
} from '../src/skp-docker-hash-probe.mjs';

const IMAGE = `docker.io/library/busybox@sha256:${'a'.repeat(64)}`; // Mock-only digest.
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skp-docker-probe-test-'));
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
  return { packageBytes: Buffer.from('inert SKP package bytes\n'), image: IMAGE,
    dockerExecutable: docker, dockerSocketPath: socket };
}

test('Docker candidate uses one read-only inert byte mount and closed process policy', async (t) => {
  const input = await fixture(t);
  let calls = 0; let invocationError = null;
  const report = await probeSkpPackageInDocker(input, { invoke: async (invocation) => {
    try {
    calls += 1;
    const args = invocation.args;
    assert.equal(invocation.executable, await realpath(input.dockerExecutable));
    assert.equal(args[0], '--host');
    assert.match(args[1], /^unix:\/\//u);
    assert.equal(args[2], '--config');
    assert.ok(path.isAbsolute(args[3]));
    assert.ok(args.includes('--pull=never'));
    for (const [flag, value] of [
      ['--log-driver', 'none'],
      ['--network', 'none'], ['--cap-drop', 'ALL'],
      ['--security-opt', 'no-new-privileges:true'], ['--user', '65534:65534'],
      ['--pids-limit', '32'], ['--memory', '128m'], ['--memory-swap', '128m'],
      ['--cpus', '1'], ['--ipc', 'none'], ['--ulimit', 'nofile=64:64'],
      ['--entrypoint', '/bin/busybox']
    ]) assert.equal(args[args.indexOf(flag) + 1], value);
    assert.ok(args.includes('--read-only'));
    assert.ok(args.includes('--rm'));
    assert.equal(args.includes('--privileged'), false);
    assert.equal(args.includes('--env'), false);
    assert.equal(args.includes('--env-file'), false);
    assert.equal(args.includes('--volume'), false);
    assert.deepEqual(args.slice(-3), [IMAGE, 'sha256sum', '/skp/package']);
    assert.equal(args.filter((arg) => arg === '--mount').length, 1);
    const mount = args[args.indexOf('--mount') + 1];
    const source = mount.match(/^type=bind,source=(.+),target=\/skp\/package,readonly$/u)?.[1];
    assert.ok(source);
    const staged = await readFile(source);
    assert.deepEqual(staged, input.packageBytes);
    assert.deepEqual(Object.keys(invocation.env).sort(), ['DOCKER_CONFIG', 'HOME', 'LANG', 'PATH']);
    assert.equal(invocation.env.DOCKER_CONFIG, args[3]);
    assert.equal(invocation.env.HOME, path.dirname(args[3]));
    assert.equal(invocation.env.PATH, '/usr/bin:/bin');
    assert.equal(invocation.env.LANG, 'C');
    assert.equal(invocation.timeoutMs, SKP_DOCKER_HASH_PROBE_LIMITS.runTimeoutMs);
    assert.equal(invocation.outputBytes, SKP_DOCKER_HASH_PROBE_LIMITS.outputBytes);
    return { status: 'ok', stdout: Buffer.from(`${sha256(staged)}  /skp/package\n`),
      stderr: Buffer.alloc(0) };
    } catch (error) { invocationError = error; throw error; }
  } });
  assert.ifError(invocationError);
  assert.equal(calls, 1);
  assert.equal(report.status, 'candidate-observed');
  assert.equal(report.stagedBytesSha256, `sha256:${sha256(input.packageBytes)}`);
  assert.equal(report.observedStagedBytesSha256, report.stagedBytesSha256);
  assert.equal(report.qualified, false);
  assert.equal(report.launchAuthorized, false);
  assert.equal(report.skillExecuted, false);
  assert.equal(report.deliveryAuthenticated, false);
  assert.equal(report.hostEnforcementProven, false);
  assert.equal(report.recovery.cliCleanup, 'not-requested');
  assert.equal(report.recovery.effectsKnownAbsent, false);
  assert.equal(report.recovery.automaticRetryAuthorized, false);
});

test('Docker candidate refuses tags, arbitrary images, ambient options and oversized bytes', async (t) => {
  const input = await fixture(t);
  for (const image of ['busybox:latest', `evil.example/busybox@sha256:${'a'.repeat(64)}`,
    `docker.io/library/busybox@sha256:${'a'.repeat(63)}`,
    `${IMAGE} --privileged`]) {
    await assert.rejects(probeSkpPackageInDocker({ ...input, image }),
      { code: 'SKP_DOCKER_PROBE_INPUT_INVALID' });
  }
  await assert.rejects(probeSkpPackageInDocker({ ...input, privileged: true }),
    { code: 'SKP_DOCKER_PROBE_INPUT_INVALID' });
  await assert.rejects(probeSkpPackageInDocker({ ...input,
    packageBytes: Buffer.alloc(SKP_DOCKER_HASH_PROBE_LIMITS.packageBytes + 1) }),
  { code: 'SKP_DOCKER_PROBE_INPUT_INVALID' });
  const accessor = Object.defineProperty({ ...input }, 'image', { get() { throw Error('read'); } });
  await assert.rejects(probeSkpPackageInDocker(accessor),
    { code: 'SKP_DOCKER_PROBE_INPUT_INVALID' });
});

test('Docker candidate refuses unavailable endpoint, failed run and mismatched output', async (t) => {
  const input = await fixture(t);
  await assert.rejects(probeSkpPackageInDocker({ ...input, dockerExecutable: '/missing/docker' }),
    { code: 'SKP_DOCKER_PROBE_UNAVAILABLE' });
  const calls = [];
  const failed = await probeSkpPackageInDocker(input, { invoke: async (invocation) => {
    calls.push(invocation.args);
    return { status: 'docker-error', stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  } });
  assert.equal(failed.status, 'unavailable');
  assert.equal(failed.code, 'SKP_DOCKER_PROBE_RUN_UNAVAILABLE');
  assert.equal(failed.recovery.cliCleanup, 'unconfirmed');
  assert.equal(failed.recovery.effectsKnownAbsent, false);
  assert.equal(failed.recovery.automaticRetryAuthorized, false);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].slice(-4, -1), ['container', 'rm', '--force']);
  const mismatch = await probeSkpPackageInDocker(input, { invoke: async () => ({
    status: 'ok', stdout: Buffer.from(`${'0'.repeat(64)}  /skp/package\n`),
    stderr: Buffer.alloc(0)
  }) });
  assert.equal(mismatch.status, 'unavailable');
  assert.equal(mismatch.code, 'SKP_DOCKER_PROBE_HASH_MISMATCH');
  assert.equal(mismatch.observedStagedBytesSha256, null);
});

test('Docker candidate distinguishes CLI-reported cleanup from proven effect absence', async (t) => {
  const input = await fixture(t);
  let attempts = 0;
  const report = await probeSkpPackageInDocker(input, { invoke: async () => {
    attempts += 1;
    return { status: attempts === 1 ? 'timeout' : 'ok',
      stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  } });
  assert.equal(attempts, 2);
  assert.equal(report.status, 'unavailable');
  assert.equal(report.recovery.cliCleanup, 'cli-reported');
  assert.equal(report.recovery.effectsKnownAbsent, false);
  assert.equal(report.recovery.automaticRetryAuthorized, false);
});

test('Docker candidate refuses a staged file changed during the hash operation', async (t) => {
  const input = await fixture(t);
  const report = await probeSkpPackageInDocker(input, { invoke: async (invocation) => {
    const mount = invocation.args[invocation.args.indexOf('--mount') + 1];
    const source = mount.match(/^type=bind,source=(.+),target=\/skp\/package,readonly$/u)[1];
    await chmod(source, 0o644);
    await writeFile(source, 'replaced bytes');
    return { status: 'ok', stdout: Buffer.from(`${sha256(input.packageBytes)}  /skp/package\n`),
      stderr: Buffer.alloc(0) };
  } });
  assert.equal(report.status, 'unavailable');
  assert.equal(report.code, 'SKP_DOCKER_PROBE_HASH_MISMATCH');
});

test('Docker process adapter bounds output without exposing it as evidence', async () => {
  const result = await invokeDockerHashProbeCli({
    executable: process.execPath,
    args: ['-e', 'process.stdout.write("x".repeat(2048))'],
    env: { HOME: os.tmpdir(), PATH: '/usr/bin:/bin' },
    timeoutMs: 1000, outputBytes: 64
  });
  assert.equal(result.status, 'output-limit');
  assert.ok(result.stdout.length + result.stderr.length <= 64);
});
