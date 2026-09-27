/**
 * Opt-in, hash-only Docker candidate for a future SKP host integration.
 *
 * The only container operation is BusyBox sha256sum over one staged, read-only file. This module
 * never runs skill text, scripts, hooks, a model, or lifecycle work. Docker CLI output and image
 * identity are observations, not authenticated host delivery or native M5 qualification.
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rmdir, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { types } from 'node:util';

import { SKP_CAPTURE_LIMITS } from './skp-package.mjs';
import { SingularityFlowError } from './util.mjs';

export const SKP_DOCKER_HASH_PROBE_LIMITS = Object.freeze({
  packageBytes: SKP_CAPTURE_LIMITS.totalBytes,
  outputBytes: 512,
  runTimeoutMs: 15000,
  cleanupTimeoutMs: 5000
});

const BUSYBOX_IMAGE = /^docker\.io\/library\/busybox@sha256:[a-f0-9]{64}$/u;
const HASH_LINE = /^([a-f0-9]{64})  \/skp\/package\r?\n$/u;
const TYPED_ARRAY = Object.getPrototypeOf(Uint8Array.prototype);
const BYTE_LENGTH = Object.getOwnPropertyDescriptor(TYPED_ARRAY, 'byteLength').get;
const ARRAY_BUFFER = Object.getOwnPropertyDescriptor(TYPED_ARRAY, 'buffer').get;
const COPY_BYTES = Uint8Array.prototype.set;

function fail(code, message) {
  throw new SingularityFlowError(message, { code });
}

function closedOptions(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || types.isProxy(input)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    fail('SKP_DOCKER_PROBE_INPUT_INVALID', 'Docker hash probe requires an ordinary options object.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).some((key) => !allowed.includes(key))
      || Object.values(descriptors).some((value) => !Object.hasOwn(value, 'value'))) {
    fail('SKP_DOCKER_PROBE_INPUT_INVALID', 'Docker hash probe options contain an unknown field or accessor.');
  }
  return Object.fromEntries(Object.entries(descriptors).map(([key, value]) => [key, value.value]));
}

function copyPackageBytes(value) {
  if (types.isProxy(value) || !Buffer.isBuffer(value)
      || Object.getPrototypeOf(value) !== Buffer.prototype) {
    fail('SKP_DOCKER_PROBE_INPUT_INVALID', 'Package bytes must be an ordinary Buffer.');
  }
  let length;
  try {
    if (types.isSharedArrayBuffer(ARRAY_BUFFER.call(value))) {
      fail('SKP_DOCKER_PROBE_INPUT_INVALID', 'Shared package bytes are refused.');
    }
    length = BYTE_LENGTH.call(value);
  } catch (error) {
    if (error instanceof SingularityFlowError) throw error;
    fail('SKP_DOCKER_PROBE_INPUT_INVALID', 'Package bytes are detached or invalid.');
  }
  if (length < 1 || length > SKP_DOCKER_HASH_PROBE_LIMITS.packageBytes) {
    fail('SKP_DOCKER_PROBE_INPUT_INVALID', 'Package byte size exceeds the bounded probe profile.');
  }
  const copy = Buffer.alloc(length);
  COPY_BYTES.call(copy, value);
  return copy;
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function absolutePath(value) {
  return typeof value === 'string' && path.isAbsolute(value)
    && value.trim() === value && !/[\r\n\0]/u.test(value);
}

async function exactLocalEndpoints(executable, socket) {
  if (process.platform === 'win32' || !absolutePath(executable) || !absolutePath(socket)) {
    fail('SKP_DOCKER_PROBE_INPUT_INVALID', 'The candidate requires absolute local POSIX Docker paths.');
  }
  const [dockerPath, socketPath] = await Promise.all([
    realpath(executable).catch(() => null), realpath(socket).catch(() => null)
  ]);
  if (!dockerPath || !socketPath || !absolutePath(dockerPath) || !absolutePath(socketPath)) {
    fail('SKP_DOCKER_PROBE_UNAVAILABLE', 'The local Docker CLI or Unix socket is unavailable.');
  }
  const [dockerInfo, socketInfo] = await Promise.all([
    stat(dockerPath).catch(() => null), stat(socketPath).catch(() => null)
  ]);
  if (!dockerInfo?.isFile() || path.basename(dockerPath) !== 'docker'
      || (dockerInfo.mode & 0o111) === 0 || !socketInfo?.isSocket()) {
    fail('SKP_DOCKER_PROBE_UNAVAILABLE', 'The Docker endpoint is not a local executable and Unix socket.');
  }
  return { dockerPath, socketPath };
}

function candidateReport(status, code, image, stagedBytesSha256, observedStagedBytesSha256 = null) {
  return Object.freeze({
    schemaVersion: 1,
    resultType: 'sflow-skp-docker-hash-candidate',
    status,
    code,
    image,
    stagedBytesSha256,
    observedStagedBytesSha256,
    observationScope: 'one-local-docker-hash-probe',
    qualified: false,
    launchAuthorized: false,
    skillExecuted: false,
    deliveryAuthenticated: false,
    hostEnforcementProven: false
  });
}

function dockerInvocation({ dockerPath, socketPath, configPath, packagePath, containerName, image }) {
  return {
    executable: dockerPath,
    args: [
      '--host', `unix://${socketPath}`, '--config', configPath,
      'run', '--rm', '--pull=never', '--name', containerName,
      '--log-driver', 'none',
      '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--user', '65534:65534',
      '--pids-limit', '32', '--memory', '128m', '--memory-swap', '128m',
      '--cpus', '1', '--ipc', 'none', '--ulimit', 'nofile=64:64',
      '--mount', `type=bind,source=${packagePath},target=/skp/package,readonly`,
      '--entrypoint', '/bin/busybox', image, 'sha256sum', '/skp/package'
    ],
    env: { HOME: path.dirname(configPath), DOCKER_CONFIG: configPath,
      PATH: '/usr/bin:/bin', LANG: 'C' },
    timeoutMs: SKP_DOCKER_HASH_PROBE_LIMITS.runTimeoutMs,
    outputBytes: SKP_DOCKER_HASH_PROBE_LIMITS.outputBytes
  };
}

function cleanupInvocation(invocation, containerName) {
  return {
    ...invocation,
    args: invocation.args.slice(0, 4).concat(['container', 'rm', '--force', containerName]),
    timeoutMs: SKP_DOCKER_HASH_PROBE_LIMITS.cleanupTimeoutMs
  };
}

/** Bounded shell-free CLI invocation; the probe caller never receives raw Docker output. */
export function invokeDockerHashProbeCli({ executable, args, env, timeoutMs, outputBytes }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, args, {
        shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env, cwd: env.HOME
      });
    } catch {
      resolve({ status: 'unavailable', stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
      return;
    }
    const output = { stdout: [], stderr: [] };
    let total = 0; let reason = null; let finished = false;
    const complete = (status, exitCode = null) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline); clearTimeout(closeDeadline);
      resolve({ status, exitCode,
        stdout: Buffer.concat(output.stdout), stderr: Buffer.concat(output.stderr) });
    };
    const stop = (why) => {
      if (reason) return;
      reason = why;
      try { child.kill('SIGKILL'); } catch { /* A later close/outer deadline still refuses. */ }
      closeDeadline = setTimeout(() => {
        child.stdout?.destroy(); child.stderr?.destroy(); child.unref?.();
        complete('unclosed');
      }, 2000);
      closeDeadline.unref?.();
    };
    let closeDeadline;
    const deadline = setTimeout(() => stop('timeout'), timeoutMs);
    deadline.unref?.();
    for (const key of ['stdout', 'stderr']) {
      child[key]?.on('data', (chunk) => {
        if (reason) return;
        total += chunk.length;
        if (total > outputBytes) { stop('output-limit'); return; }
        output[key].push(chunk);
      });
    }
    child.once('error', () => { reason = 'unavailable'; complete(reason); });
    child.once('close', (code) => complete(reason ?? (code === 0 ? 'ok' : 'docker-error'), code));
  });
}

async function stageUnchanged(handle, packagePath, expectedSize, expectedHash, initial) {
  const opened = await handle.stat();
  const named = await lstat(packagePath);
  if (!opened.isFile() || !named.isFile() || named.isSymbolicLink()
      || opened.dev !== initial.dev || opened.ino !== initial.ino
      || named.dev !== initial.dev || named.ino !== initial.ino
      || opened.size !== expectedSize || named.size !== expectedSize
      || opened.mtimeMs !== initial.mtimeMs || opened.ctimeMs !== initial.ctimeMs) return false;
  const bytes = Buffer.alloc(expectedSize); let offset = 0;
  while (offset < expectedSize) {
    const result = await handle.read(bytes, offset, expectedSize - offset, offset);
    if (result.bytesRead < 1) return false;
    offset += result.bytesRead;
  }
  const probe = Buffer.alloc(1);
  if ((await handle.read(probe, 0, 1, expectedSize)).bytesRead !== 0) return false;
  return hash(bytes) === expectedHash;
}

/**
 * Hash inert package bytes in a pre-existing digest-pinned local BusyBox image. No pull is allowed.
 * The report never satisfies SKP host admission, regardless of Docker's reported outcome.
 */
export async function probeSkpPackageInDocker(input, { invoke = invokeDockerHashProbeCli } = {}) {
  const options = closedOptions(input, ['packageBytes', 'image', 'dockerExecutable', 'dockerSocketPath']);
  if (!BUSYBOX_IMAGE.test(options.image ?? '')) {
    fail('SKP_DOCKER_PROBE_INPUT_INVALID', 'A full digest-pinned official BusyBox image is required.');
  }
  if (typeof invoke !== 'function') {
    fail('SKP_DOCKER_PROBE_INPUT_INVALID', 'Docker invocation owner is invalid.');
  }
  const bytes = copyPackageBytes(options.packageBytes);
  const packageHash = hash(bytes);
  const expected = `sha256:${packageHash}`;
  const { dockerPath, socketPath } = await exactLocalEndpoints(
    options.dockerExecutable, options.dockerSocketPath
  );
  let stageRoot = null; let stageHandle = null;
  try {
    const tempParent = await realpath(os.tmpdir());
    stageRoot = await mkdtemp(path.join(tempParent, 'skp-docker-hash-'));
    const configPath = path.join(stageRoot, 'empty-docker-config');
    const packagePath = path.join(stageRoot, 'package.bin');
    if ([stageRoot, packagePath, configPath].some((value) => /[,\r\n\0]/u.test(value))) {
      fail('SKP_DOCKER_PROBE_INPUT_INVALID', 'Temporary path cannot be encoded as one Docker bind mount.');
    }
    await mkdir(configPath, { mode: 0o700 });
    const writer = await open(packagePath, 'wx', 0o444);
    try { await writer.writeFile(bytes); await writer.sync(); }
    finally { await writer.close(); }
    stageHandle = await open(packagePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const initial = await stageHandle.stat();
    if (!(await stageUnchanged(stageHandle, packagePath, bytes.length, packageHash, initial))) {
      return candidateReport('unavailable', 'SKP_DOCKER_PROBE_STAGE_CHANGED', options.image, expected);
    }
    const containerName = `skp-hash-${randomUUID().replaceAll('-', '')}`;
    const invocation = dockerInvocation({ dockerPath, socketPath, configPath,
      packagePath, containerName, image: options.image });
    let outcome;
    try { outcome = await invoke(invocation); }
    catch { outcome = { status: 'unavailable' }; }
    if (outcome?.status !== 'ok') {
      // The unique name is ours; a timed-out CLI may have left that container running.
      try { await invoke(cleanupInvocation(invocation, containerName)); }
      catch { /* Cleanup is not established and this report never authorizes execution. */ }
      return candidateReport('unavailable', 'SKP_DOCKER_PROBE_RUN_UNAVAILABLE', options.image, expected);
    }
    if (!Buffer.isBuffer(outcome.stdout) || !Buffer.isBuffer(outcome.stderr)
        || outcome.stdout.length > SKP_DOCKER_HASH_PROBE_LIMITS.outputBytes
        || outcome.stderr.length !== 0) {
      return candidateReport('unavailable', 'SKP_DOCKER_PROBE_OUTPUT_INVALID', options.image, expected);
    }
    const match = outcome.stdout.toString('ascii').match(HASH_LINE);
    if (!match || match[1] !== packageHash
        || !(await stageUnchanged(stageHandle, packagePath, bytes.length, packageHash, initial))) {
      return candidateReport('unavailable', 'SKP_DOCKER_PROBE_HASH_MISMATCH', options.image, expected);
    }
    return candidateReport('candidate-observed', null, options.image, expected, expected);
  } finally {
    await stageHandle?.close().catch(() => {});
    if (stageRoot) {
      await unlink(path.join(stageRoot, 'package.bin')).catch(() => {});
      await rmdir(path.join(stageRoot, 'empty-docker-config')).catch(() => {});
      await rmdir(stageRoot).catch(() => {});
    }
  }
}
