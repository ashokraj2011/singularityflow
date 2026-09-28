/**
 * Opt-in, candidate-only Docker containment observations using fixed BusyBox operations.
 * No imported skill, hook, repository code, model, or lifecycle operation is executed here.
 * A successful observation is not host admission, authenticated delivery, or qualification.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rmdir, stat, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { types } from 'node:util';

import { invokeDockerHashProbeCli, SKP_DOCKER_HASH_PROBE_LIMITS } from './skp-docker-hash-probe.mjs';
import { SingularityFlowError } from './util.mjs';

const IMAGE = /^docker\.io\/library\/busybox@sha256:[a-f0-9]{64}$/u;
const SHA_LINE = /^([a-f0-9]{64})  \/skp\/input\r?\n$/u;
const MAX_OUTPUT = 512;
const RUN_TIMEOUT_MS = 15000;
const CANCEL_TIMEOUT_MS = 3000;
const CLEANUP_TIMEOUT_MS = 5000;
const BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), 'byteLength'
).get;
const ARRAY_BUFFER = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), 'buffer'
).get;

const CHECKS = Object.freeze([
  'hash', 'runtimePolicy', 'read', 'write', 'network', 'controlPlane', 'cancellation'
]);
const SCRIPTS = Object.freeze({
  runtimePolicy: 'busybox awk \'/^NoNewPrivs:/{n=$2} /^Seccomp:/{s=$2} END {printf "runtime-policy=%s:%s\\n",n,s}\' /proc/self/status',
  read: 'if busybox cat "$1" >/dev/null 2>&1; then printf "read-open\\n"; else printf "read-denied\\n"; fi',
  write: 'if (printf x > "$1") >/dev/null 2>&1; then printf "write-open\\n"; else printf "write-denied\\n"; fi',
  network: 'if ! busybox --list | busybox grep -qx nc; then printf "network-tool-missing\\n"; elif ! busybox grep -q host.docker.internal /etc/hosts; then printf "network-target-missing\\n"; elif busybox nc -w 2 host.docker.internal "$1" </dev/null >/dev/null 2>&1; then printf "network-open\\n"; else printf "network-denied\\n"; fi',
  controlPlane: 'if busybox test -e /var/run/docker.sock || busybox test -r /root/.docker/config.json; then printf "control-open\\n"; else printf "control-denied\\n"; fi',
  cancellation: 'printf "sleep-started\\n"; busybox sleep 30'
});

function fail(code, message) {
  throw new SingularityFlowError(message, { code });
}

function closedInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || types.isProxy(input)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    fail('SKP_DOCKER_CONTAINMENT_INPUT_INVALID', 'Docker containment probe requires ordinary options.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const allowed = ['packageBytes', 'image', 'dockerExecutable', 'dockerSocketPath'];
  if (Reflect.ownKeys(descriptors).length !== allowed.length
      || Reflect.ownKeys(descriptors).some((key) => !allowed.includes(key))
      || Object.values(descriptors).some((item) => !Object.hasOwn(item, 'value'))) {
    fail('SKP_DOCKER_CONTAINMENT_INPUT_INVALID', 'Docker containment probe options are not closed.');
  }
  return Object.fromEntries(Object.entries(descriptors).map(([key, item]) => [key, item.value]));
}

function copyBytes(value) {
  if (types.isProxy(value) || !Buffer.isBuffer(value)
      || Object.getPrototypeOf(value) !== Buffer.prototype) {
    fail('SKP_DOCKER_CONTAINMENT_INPUT_INVALID', 'Probe input bytes must be an ordinary Buffer.');
  }
  let length;
  try {
    if (types.isSharedArrayBuffer(ARRAY_BUFFER.call(value))) {
      fail('SKP_DOCKER_CONTAINMENT_INPUT_INVALID', 'Shared input bytes are refused.');
    }
    length = BYTE_LENGTH.call(value);
  } catch (error) {
    if (error instanceof SingularityFlowError) throw error;
    fail('SKP_DOCKER_CONTAINMENT_INPUT_INVALID', 'Probe input bytes are detached or invalid.');
  }
  if (length < 1 || length > SKP_DOCKER_HASH_PROBE_LIMITS.packageBytes) {
    fail('SKP_DOCKER_CONTAINMENT_INPUT_INVALID', 'Probe input exceeds its byte budget.');
  }
  const copy = Buffer.alloc(length);
  Uint8Array.prototype.set.call(copy, value);
  return copy;
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const absolutePath = (value) => typeof value === 'string' && path.isAbsolute(value)
  && value.trim() === value && !/[\r\n\0]/u.test(value);

async function localDocker(executable, socket) {
  if (process.platform === 'win32' || !absolutePath(executable) || !absolutePath(socket)) {
    fail('SKP_DOCKER_CONTAINMENT_INPUT_INVALID', 'An absolute local POSIX Docker endpoint is required.');
  }
  const [dockerPath, socketPath] = await Promise.all([
    realpath(executable).catch(() => null), realpath(socket).catch(() => null)
  ]);
  const [binary, endpoint] = await Promise.all([
    dockerPath ? stat(dockerPath).catch(() => null) : null,
    socketPath ? stat(socketPath).catch(() => null) : null
  ]);
  if (!binary?.isFile() || (binary.mode & 0o111) === 0
      || path.basename(dockerPath) !== 'docker' || !endpoint?.isSocket()) {
    fail('SKP_DOCKER_CONTAINMENT_UNAVAILABLE', 'Local Docker executable or Unix socket is unavailable.');
  }
  return { dockerPath, socketPath };
}

function report(status, code, image, inputSha256, checks, cleanup, localStageCleanup) {
  return Object.freeze({
    schemaVersion: 1,
    resultType: 'sflow-skp-docker-containment-candidate',
    status, code, image, inputSha256,
    observationScope: 'fixed-local-busybox-candidate-only',
    checks: Object.freeze(CHECKS.map((id) => Object.freeze({
      id, status: checks[id] ?? 'not-run'
    }))),
    recovery: Object.freeze({
      containers: Object.freeze(CHECKS.map((id) => Object.freeze({
        id, cleanup: cleanup[id] ?? 'not-started'
      }))),
      localStageCleanup,
      effectsKnownAbsent: false,
      automaticRetryAuthorized: false
    }),
    qualified: false,
    launchAuthorized: false,
    skillExecuted: false,
    deliveryAuthenticated: false,
    hostEnforcementProven: false
  });
}

function baseInvocation(dockerPath, socketPath, configPath, args, checkId, timeoutMs = RUN_TIMEOUT_MS) {
  return {
    checkId,
    executable: dockerPath,
    args: ['--host', `unix://${socketPath}`, '--config', configPath, ...args],
    env: { HOME: path.dirname(configPath), DOCKER_CONFIG: configPath,
      PATH: '/usr/bin:/bin', LANG: 'C' },
    timeoutMs,
    outputBytes: MAX_OUTPUT
  };
}

function runInvocation(base, image, inputPath, name, id, extra = [], timeoutMs = RUN_TIMEOUT_MS) {
  return {
    ...base,
    checkId: id,
    args: base.args.concat([
      'run', '--rm', '--pull=never', '--name', name, '--log-driver', 'none',
      '--network', 'none', '--add-host', 'host.docker.internal:host-gateway',
      '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--security-opt', 'seccomp=builtin',
      '--user', '65534:65534', '--pids-limit', '32', '--memory', '128m',
      '--memory-swap', '128m', '--cpus', '1', '--ipc', 'none',
      '--ulimit', 'nofile=64:64',
      '--mount', `type=bind,source=${inputPath},target=/skp/input,readonly`,
      '--entrypoint', '/bin/busybox', image, ...extra
    ]),
    timeoutMs
  };
}

function exactText(outcome, expected) {
  return outcome?.status === 'ok' && Buffer.isBuffer(outcome.stdout)
    && Buffer.isBuffer(outcome.stderr)
    && outcome.stdout.length <= MAX_OUTPUT && outcome.stderr.length === 0
    && outcome.stdout.toString('utf8') === expected;
}

async function observedAbsent(invoke, base, name, id) {
  let observed;
  try {
    observed = await invoke({ ...base, checkId: `${id}-absence`,
      args: base.args.concat(['container', 'ls', '--all', '--no-trunc',
        '--filter', `name=^/${name}$`, '--format', '{{.ID}}']), timeoutMs: CLEANUP_TIMEOUT_MS });
  } catch { return false; }
  return observed?.status === 'ok' && Buffer.isBuffer(observed.stdout)
    && Buffer.isBuffer(observed.stderr)
    && observed.stdout.length === 0 && observed.stderr.length === 0;
}

async function runFixed(invoke, base, image, inputPath, id, extra, timeoutMs, cleanup) {
  const name = `skp-containment-${randomUUID().replaceAll('-', '')}`;
  const invocation = runInvocation(base, image, inputPath, name, id, extra, timeoutMs);
  let outcome;
  try { outcome = await invoke(invocation); }
  catch { outcome = { status: 'unavailable' }; }
  const remove = async () => {
    try {
      await invoke({ ...base, checkId: `${id}-remove`,
        args: base.args.concat(['container', 'rm', '--force', name]),
        timeoutMs: CLEANUP_TIMEOUT_MS });
    } catch { /* Absence observation below is the only cleanup signal. */ }
  };
  if (outcome?.status !== 'ok') await remove();
  let absent = await observedAbsent(invoke, base, name, id);
  if (!absent) {
    // A successful CLI status is not permission to leave an unexpectedly live container behind.
    await remove();
    absent = await observedAbsent(invoke, base, name, id);
  }
  cleanup[id] = absent ? 'observed-absent' : 'unknown';
  return { outcome, absent };
}

async function stageUnchanged(handle, namedPath, expectedSize, expectedHash, initial) {
  const [opened, named] = await Promise.all([handle.stat(), lstat(namedPath)]);
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
  return (await handle.read(probe, 0, 1, expectedSize)).bytesRead === 0
    && sha256(bytes) === expectedHash;
}

async function openCanaryServer() {
  let accepted = 0;
  const server = createServer((socket) => { accepted += 1; socket.destroy(); });
  server.maxConnections = 1;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolve);
  });
  return { port: server.address().port, accepted: () => accepted,
    close: () => new Promise((resolve) => server.close(resolve)) };
}

/**
 * Probe an exact locally available image with inert operations. Even a complete report is only a
 * candidate observation; no result from this API may be passed as trusted SKP host admission.
 */
export async function probeSkpDockerContainment(input, { invoke = invokeDockerHashProbeCli } = {}) {
  const options = closedInput(input);
  if (!IMAGE.test(options.image) || typeof invoke !== 'function') {
    fail('SKP_DOCKER_CONTAINMENT_INPUT_INVALID', 'A digest-pinned BusyBox image and CLI owner are required.');
  }
  const bytes = copyBytes(options.packageBytes);
  const expectedHash = sha256(bytes);
  const { dockerPath, socketPath } = await localDocker(
    options.dockerExecutable, options.dockerSocketPath
  );
  const checks = {}; const cleanup = {};
  let stageRoot = null; let handle = null; let localStageCleanup = 'not-staged';
  let status = 'unavailable'; let code = 'SKP_DOCKER_CONTAINMENT_UNAVAILABLE';
  try {
    stageRoot = await mkdtemp(path.join(await realpath(os.tmpdir()), 'skp-containment-'));
    const configPath = path.join(stageRoot, 'empty-docker-config');
    const inputPath = path.join(stageRoot, 'input.bin');
    const canaryPath = path.join(stageRoot, 'host-canary.bin');
    if ([stageRoot, inputPath, configPath].some((value) => /[,\r\n\0]/u.test(value))) {
      fail('SKP_DOCKER_CONTAINMENT_UNAVAILABLE', 'Temporary path cannot be encoded as one bind mount.');
    }
    await mkdir(configPath, { mode: 0o700 });
    const writer = await open(inputPath, 'wx', 0o600);
    try { await writer.writeFile(bytes); await writer.sync(); }
    finally { await writer.close(); }
    // World-writable only inside a private temporary directory: a missing readonly bind would
    // otherwise be hidden by ordinary Unix permissions in the write-denial probe.
    await chmod(inputPath, 0o666);
    const canary = await open(canaryPath, 'wx', 0o644);
    try { await canary.writeFile(randomUUID()); await canary.sync(); }
    finally { await canary.close(); }
    handle = await open(inputPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const initial = await handle.stat();
    if (!(await stageUnchanged(handle, inputPath, bytes.length, expectedHash, initial))) {
      code = 'SKP_DOCKER_CONTAINMENT_STAGE_CHANGED';
    } else {
    const base = baseInvocation(dockerPath, socketPath, configPath, [], 'image-inspect');
    let imageInspection;
    try { imageInspection = await invoke({ ...base,
      args: base.args.concat(['image', 'inspect', '--format', '{{json .RepoDigests}}', options.image]) }); }
    catch { imageInspection = { status: 'unavailable' }; }
    let localDigests = null;
    try { localDigests = JSON.parse(imageInspection?.stdout?.toString('utf8') ?? ''); }
    catch { /* Incomplete/invalid image inspection is unavailable. */ }
    const officialAlias = options.image.replace(/^docker\.io\/library\//u, '');
    if (imageInspection?.status !== 'ok'
        || !Buffer.isBuffer(imageInspection.stdout)
        || !Buffer.isBuffer(imageInspection.stderr)
        || imageInspection.stdout.length > MAX_OUTPUT
        || imageInspection.stderr.length !== 0
        || !Array.isArray(localDigests)
        || !localDigests.some((item) => item === options.image || item === officialAlias)) {
      code = 'SKP_DOCKER_CONTAINMENT_IMAGE_UNAVAILABLE';
    } else {
      const fixed = async (id, extra, expectedText, timeout = RUN_TIMEOUT_MS) => {
        const result = await runFixed(invoke, base, options.image, inputPath, id,
          extra, timeout, cleanup);
        checks[id] = result.absent && exactText(result.outcome, expectedText)
          ? 'observed' : 'unavailable';
        return checks[id] === 'observed';
      };
      const hashRun = await runFixed(invoke, base, options.image, inputPath, 'hash',
        ['sha256sum', '/skp/input'], RUN_TIMEOUT_MS, cleanup);
      const hashMatch = hashRun.absent && hashRun.outcome?.status === 'ok'
        && Buffer.isBuffer(hashRun.outcome.stdout) && Buffer.isBuffer(hashRun.outcome.stderr)
        && hashRun.outcome.stderr.length === 0
        && hashRun.outcome.stdout.toString('ascii').match(SHA_LINE)?.[1] === expectedHash;
      checks.hash = hashMatch ? 'observed' : 'unavailable';
      if (hashMatch && await fixed('runtimePolicy', ['sh', '-c', SCRIPTS.runtimePolicy],
        'runtime-policy=1:2\n')
          && await fixed('read', ['sh', '-c', SCRIPTS.read, 'sh', canaryPath], 'read-denied\n')
          && await fixed('write', ['sh', '-c', SCRIPTS.write, 'sh', '/skp/input'], 'write-denied\n')) {
        let server;
        try {
          server = await openCanaryServer();
          const network = await fixed('network', ['sh', '-c', SCRIPTS.network, 'sh',
            String(server.port)], 'network-denied\n');
          if (network && server.accepted() > 0) checks.network = 'unavailable';
        } finally { await server?.close(); }
        if (checks.network === 'observed'
            && await fixed('controlPlane', ['sh', '-c', SCRIPTS.controlPlane],
              'control-denied\n')) {
          const cancelled = await runFixed(invoke, base, options.image, inputPath,
            'cancellation', ['sh', '-c', SCRIPTS.cancellation], CANCEL_TIMEOUT_MS, cleanup);
          checks.cancellation = cancelled.outcome?.status === 'timeout'
            && Buffer.isBuffer(cancelled.outcome.stdout)
            && cancelled.outcome.stdout.toString('utf8') === 'sleep-started\n'
            && cancelled.absent ? 'observed' : 'unavailable';
        }
      }
      if (CHECKS.every((id) => checks[id] === 'observed')
          && await stageUnchanged(handle, inputPath, bytes.length, expectedHash, initial)) {
        status = 'candidate-observed'; code = null;
      } else {
        code = 'SKP_DOCKER_CONTAINMENT_CHECK_UNAVAILABLE';
      }
    }
    }
  } catch {
    status = 'unavailable'; code = 'SKP_DOCKER_CONTAINMENT_UNAVAILABLE';
  } finally {
    await handle?.close().catch(() => {});
    if (stageRoot) {
      const results = await Promise.allSettled([
        unlink(path.join(stageRoot, 'input.bin')),
        unlink(path.join(stageRoot, 'host-canary.bin'))
      ]);
      const config = await rmdir(path.join(stageRoot, 'empty-docker-config')).then(
        () => true, () => false
      );
      const root = await rmdir(stageRoot).then(() => true, () => false);
      localStageCleanup = results.every((item) => item.status === 'fulfilled') && config && root
        ? 'observed-removed' : 'unknown';
    }
  }
  if (localStageCleanup !== 'observed-removed') {
    status = 'unavailable'; code = 'SKP_DOCKER_CONTAINMENT_CLEANUP_UNCONFIRMED';
  }
  return report(status, code, options.image, `sha256:${expectedHash}`,
    checks, cleanup, localStageCleanup);
}
