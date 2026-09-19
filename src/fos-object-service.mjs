import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { incrementCommandCounter } from './dx-timing-context.mjs';
import { createGitRuntime } from './git-access.mjs';
import { nonInteractiveGitEnvironment } from './git-execution.mjs';
import { resolvePlatformProcess } from './platform-process.mjs';
import { signalProcessTree, SingularityFlowError } from './util.mjs';

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const TYPE = /^(blob|tree|commit|tag)$/;
const HEADER_LIMIT = 1024;
const MAX_WORKERS = 8;
const MAX_OBJECT_BYTES = 32 * 1024 * 1024;
const MAX_BATCH_BYTES = 32 * 1024 * 1024;
const MAX_BATCH_OBJECTS = 128;
const MAX_COALESCED_SUBSCRIBERS = 8;
const CAPABILITY_OUTPUT_BYTES = 4 * 1024;
const OBJECT_PROTOCOL_BATCH_COMMAND = 'batch-command-buffered';
const OBJECT_PROTOCOL_LEGACY_BATCH = 'legacy-batch';
const pools = new Map();
let poolMutation = Promise.resolve();

function error(message, code, details = {}) {
  return new SingularityFlowError(message, { code, details });
}

function bounded(value, maximum, name) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw error(`Git object service ${name} must be a positive bounded integer.`, 'LIMIT_EXCEEDED');
  }
  return value;
}

async function withPoolLock(action) {
  const previous = poolMutation;
  let release;
  poolMutation = new Promise((resolve) => { release = resolve; });
  await previous;
  try { return await action(); } finally { release(); }
}

// Keep ordinary OS, proxy, CA, HOME, and credential-manager connectivity. Git's inherited
// repository/command overrides are not authority to reinterpret a raw local object request.
function objectEnvironment(source) {
  const env = nonInteractiveGitEnvironment(source);
  for (const key of Object.keys(env)) {
    // These two host-selected protected config scopes may carry office trust settings. Raw local
    // reads still discard every command-scoped/repository Git override and disable lazy fetch.
    if (/^GIT_/i.test(key) && !/^GIT_CONFIG_(?:SYSTEM|GLOBAL)$/i.test(key)) delete env[key];
  }
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
    LC_ALL: 'C'
  };
}

function gitExecutable(env, root) {
  try {
    return resolvePlatformProcess('git', [], { environment: env, cwd: path.resolve(root) }).executable;
  } catch {
    throw error('Git object service could not resolve a trusted Git executable.', 'OBJECT_SERVICE_UNAVAILABLE');
  }
}

async function repositoryProfile(root, executable, env, { signal = null, timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const onAbort = () => controller.abort('cancelled');
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) controller.abort('cancelled');
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  try {
    const runtimeResult = await createGitRuntime({
      trustedGitPath: executable, trustedEnvironment: env, signal: controller.signal,
      deadlineMs: timeoutMs
    });
    if (!runtimeResult.ok) throw error('Git object service could not inspect the repository.',
      controller.signal.reason === 'timeout' ? 'OBJECT_REQUEST_TIMEOUT'
        : controller.signal.aborted ? 'OBJECT_REQUEST_CANCELLED' : runtimeResult.code);
    const runtime = runtimeResult.value;
    try {
      const opened = await runtime.openRepository(root);
      if (!opened.ok) throw error('Git object service could not inspect the repository.',
        controller.signal.reason === 'timeout' ? 'OBJECT_REQUEST_TIMEOUT'
          : controller.signal.aborted ? 'OBJECT_REQUEST_CANCELLED' : opened.code);
      const { gitDir, commonDir, objectFormat } = opened.value.identity;
      return Object.freeze({ gitDir, commonDir, objectFormat });
    } finally { await runtime.dispose(); }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function awaitProfile(promise, timeoutMs, signal) {
  if (signal?.aborted) return Promise.reject(error('Git object request was cancelled.',
    'OBJECT_REQUEST_CANCELLED'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      action(value);
    };
    const onAbort = () => finish(reject, error('Git object request was cancelled.',
      'OBJECT_REQUEST_CANCELLED'));
    const timer = setTimeout(() => finish(reject, error('Git object profile deadline exceeded.',
      'OBJECT_REQUEST_TIMEOUT')), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    promise.then((value) => finish(resolve, value), (cause) => finish(reject, cause));
  });
}

async function awaitCapabilityCleanup(promise) {
  if (!promise) return true;
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(
        () => true,
        (cause) => cause?.code !== 'GAL_CLEANUP_INCOMPLETE'
      ),
      new Promise((resolve) => {
        // The built-in probe's process-tree cleanup is bounded at two seconds. A custom probe that
        // ignores cancellation cannot be declared terminated merely because service.close ran.
        timer = setTimeout(() => resolve(false), 2_100);
      })
    ]);
  } finally { clearTimeout(timer); }
}

async function poolFingerprint(identity, executable, env) {
  const common = await stat(identity.commonDir);
  const objects = await stat(path.join(identity.commonDir, 'objects'));
  const config = await stat(path.join(identity.commonDir, 'config')).catch(() => null);
  const alternates = await stat(path.join(identity.commonDir, 'objects', 'info', 'alternates')).catch(() => null);
  const binary = await stat(executable);
  const instance = (item) => [item.dev, item.ino];
  const generation = (item) => item
    ? [item.dev, item.ino, item.size, item.mtimeMs, item.ctimeMs] : null;
  const fields = [identity.commonDir, identity.objectFormat, executable,
    instance(common), instance(objects), generation(config), generation(alternates), generation(binary),
    Object.entries(env).sort(([a], [b]) => a.localeCompare(b))];
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

async function stopChild(child, force, {
  terminateTree = signalProcessTree,
  timeoutMs = 2_000
} = {}) {
  if (!child) return true;
  const boundedTimeoutMs = bounded(timeoutMs, 5_000, 'object-service cleanup deadline');
  let finishClose;
  const closed = new Promise((resolve) => {
    let settled = false;
    let deadline = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      child.removeListener?.('close', onClose);
      resolve(value);
    };
    finishClose = finish;
    const onClose = () => finish(true);
    if (child.exitCode != null || child.signalCode != null) finish(true);
    else {
      child.once?.('close', onClose);
      deadline = setTimeout(() => finish(false), boundedTimeoutMs);
    }
  });
  try { child.stdin?.end?.(); } catch { /* The child may already have exited. */ }

  const signalTree = async (treeSignal, remainingMs) => {
    try {
      return await terminateTree(child, treeSignal, {
        timeoutMs: Math.max(1, Math.min(1_000, remainingMs)),
        // Real spawned workers always have a PID. On Windows, direct-child termination is only
        // best effort; FOS must not start a fallback while credential/SSH/helper descendants may
        // still be alive. PID-less unit doubles retain the compatibility path used by fixtures.
        requireTree: Number.isSafeInteger(Number(child.pid)) && Number(child.pid) > 0
      }) === true;
    } catch { return false; }
  };
  if (force) {
    // `close` can fire as soon as the direct Git child exits while taskkill /T is still retiring
    // its helpers. Do not certify cleanup until both independently bounded observations settle.
    const [treeTerminated, childClosed] = await Promise.all([
      signalTree('SIGKILL', boundedTimeoutMs), closed
    ]);
    return treeTerminated && childClosed;
  }

  const natural = await Promise.race([
    closed,
    new Promise((resolve) => setTimeout(() => resolve(false),
      Math.min(1_000, Math.max(1, boundedTimeoutMs - 1))))
  ]);
  if (natural) return true;
  const graceful = signalTree('SIGTERM', Math.max(1, boundedTimeoutMs - 1_000));
  const [treeTerminated, childClosed] = await Promise.all([graceful, closed]);
  if (treeTerminated && childClosed) return true;
  // A failed or late graceful cleanup is never called verified. Make one bounded force attempt so
  // disposal is still best-effort, then retain the false result for the caller's recovery gate.
  await signalTree('SIGKILL', Math.max(1, Math.min(1_000, boundedTimeoutMs)));
  finishClose?.(false);
  return false;
}

function probeEvidence(protocol, status, result = {}) {
  return Object.freeze({
    protocol,
    status,
    supported: status === 'supported',
    exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null,
    timedOut: result.timedOut === true,
    outputOverflow: result.outputOverflow === true,
    cleanupVerified: result.cleanupVerified !== false
  });
}

async function probeObjectProtocol(executable, profile, env, args, input, {
  spawnCommand = spawn, timeoutMs = 5_000, signal = null,
  platform = process.platform, terminateTree = signalProcessTree
} = {}) {
  if (signal?.aborted) throw error('Git object-service capability probe was cancelled.',
    'OBJECT_REQUEST_CANCELLED');
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let retiring = false;
    let timedOut = false;
    let outputOverflow = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const complete = (action, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      action(value);
    };
    const protocol = args.includes('--batch-command')
      ? OBJECT_PROTOCOL_BATCH_COMMAND : OBJECT_PROTOCOL_LEGACY_BATCH;
    const finish = (status, result = {}) => {
      complete(resolve, probeEvidence(protocol, status, {
        ...result, timedOut, outputOverflow, cleanupVerified: true
      }));
    };
    const cleanupFailure = (status) => {
      complete(reject, error(
        'Git object-service capability probe cleanup could not be verified.',
        'GAL_CLEANUP_INCOMPLETE', {
          probe: probeEvidence(protocol, status, {
            timedOut, outputOverflow, cleanupVerified: false
          })
        }
      ));
    };
    const retire = (status) => {
      if (retiring || settled) return;
      retiring = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      void stopChild(child, true, { terminateTree }).then((closed) => {
        if (closed) finish(status);
        else cleanupFailure(status);
      });
    };
    const onAbort = () => {
      if (retiring || settled) return;
      retiring = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      void stopChild(child, true, { terminateTree }).then((closed) => {
        if (!closed) {
          cleanupFailure('unavailable');
          return;
        }
        complete(reject, error(
          'Git object-service capability probe was cancelled.', 'OBJECT_REQUEST_CANCELLED'
        ));
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      retire('timeout');
    }, bounded(timeoutMs, 30_000, 'capability-probe deadline'));
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      child = spawnCommand(executable, [`--git-dir=${profile.commonDir}`, ...args], {
        cwd: profile.commonDir,
        shell: false,
        windowsHide: true,
        detached: platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        env
      });
    } catch {
      finish('unavailable');
      return;
    }
    const count = (channel, chunk) => {
      if (settled || retiring) return;
      if (channel === 'stdout') stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (stdoutBytes > CAPABILITY_OUTPUT_BYTES || stderrBytes > CAPABILITY_OUTPUT_BYTES) {
        outputOverflow = true;
        retire('malformed');
      }
    };
    child.stdout?.on('data', (chunk) => count('stdout', chunk));
    child.stderr?.on('data', (chunk) => count('stderr', chunk));
    child.stdin?.once?.('error', () => retire('unavailable'));
    child.stdout?.once?.('error', () => retire('unavailable'));
    child.stderr?.once?.('error', () => retire('unavailable'));
    child.once?.('error', () => retire('unavailable'));
    child.once?.('spawn', () => {
      if (retiring || settled) return;
      try { child.stdin?.end?.(input, 'ascii'); } catch { retire('unavailable'); }
    });
    child.once?.('close', (code) => {
      if (retiring || timedOut || outputOverflow) return;
      finish(code === 0 && stdoutBytes === 0 ? 'supported'
        : code === 0 ? 'malformed' : 'unsupported', { exitCode: code });
    });
  });
}

function normalizeObjectServiceCapabilities(value) {
  const evidenceIsValid = (evidence, protocol) => evidence != null
    && evidence.protocol === protocol
    && ['supported', 'unsupported', 'malformed', 'timeout', 'unavailable']
      .includes(evidence.status)
    && evidence.supported === (evidence.status === 'supported')
    && (evidence.exitCode == null || Number.isInteger(evidence.exitCode))
    && typeof evidence.timedOut === 'boolean'
    && typeof evidence.outputOverflow === 'boolean'
    && evidence.cleanupVerified === true;
  if (!value || value.capabilityEvidenceVersion !== 1
      || ![OBJECT_PROTOCOL_BATCH_COMMAND, OBJECT_PROTOCOL_LEGACY_BATCH]
        .includes(value.selectedProtocol)
      || !evidenceIsValid(value.batchCommand, OBJECT_PROTOCOL_BATCH_COMMAND)
      || (value.selectedProtocol === OBJECT_PROTOCOL_BATCH_COMMAND
        ? !value.batchCommand.supported || value.legacyBatch != null
        : value.batchCommand.supported
          || !evidenceIsValid(value.legacyBatch, OBJECT_PROTOCOL_LEGACY_BATCH)
          || !value.legacyBatch.supported)) {
    throw error('Git object-service capability evidence is invalid.',
      'OBJECT_SERVICE_CAPABILITY_INVALID');
  }
  return Object.freeze({
    capabilityEvidenceVersion: 1,
    mode: 'persistent-opt-in',
    selection: 'capability-probe',
    selectedProtocol: value.selectedProtocol,
    batchCommand: Object.freeze({ ...(value.batchCommand ?? {}) }),
    legacyBatch: value.legacyBatch == null
      ? null : Object.freeze({ ...value.legacyBatch }),
    replacementSuppression: 'GIT_NO_REPLACE_OBJECTS=1',
    lazyFetchSuppression: 'GIT_NO_LAZY_FETCH=1'
  });
}

/** Probe exact persistent Git protocols by executing their no-object grammar, never by version. */
export async function probeFosGitObjectServiceCapabilities(root, {
  env = process.env, executable = null, profile = null,
  spawnCommand = spawn, timeoutMs = 5_000, signal = null,
  platform = process.platform, terminateTree = signalProcessTree
} = {}) {
  const repositoryRoot = path.resolve(root);
  const trustedEnvironment = objectEnvironment(env);
  const trustedExecutable = executable ?? gitExecutable(trustedEnvironment, repositoryRoot);
  const identity = profile ?? await repositoryProfile(
    repositoryRoot, trustedExecutable, trustedEnvironment, { signal, timeoutMs }
  );
  const batchCommand = await probeObjectProtocol(
    trustedExecutable, identity, trustedEnvironment,
    ['cat-file', '--batch-command', '--buffer'], 'flush\n',
    { spawnCommand, timeoutMs, signal, platform, terminateTree }
  );
  if (batchCommand.supported) return normalizeObjectServiceCapabilities({
    capabilityEvidenceVersion: 1,
    selectedProtocol: OBJECT_PROTOCOL_BATCH_COMMAND,
    batchCommand,
    legacyBatch: null
  });
  const legacyBatch = await probeObjectProtocol(
    trustedExecutable, identity, trustedEnvironment,
    ['cat-file', '--batch'], '',
    { spawnCommand, timeoutMs, signal, platform, terminateTree }
  );
  if (!legacyBatch.supported) {
    throw error('Git does not provide a verified persistent raw-object protocol.',
      'OBJECT_SERVICE_UNAVAILABLE', { batchCommand, legacyBatch });
  }
  return normalizeObjectServiceCapabilities({
    capabilityEvidenceVersion: 1,
    selectedProtocol: OBJECT_PROTOCOL_LEGACY_BATCH,
    batchCommand,
    legacyBatch
  });
}

export class FosGitObjectService {
  #root;
  #spawn;
  #env;
  #executable;
  #profile;
  #profileValue = null;
  #capabilityProbe;
  #capabilityPromise = null;
  #capabilities = null;
  #probeSpawn;
  #platform;
  #fingerprint = null;
  #child = null;
  #chunks = [];
  #buffered = 0;
  #headOffset = 0;
  #queue = [];
  #active = null;
  #closed = false;
  #idleTimer = null;
  #maxQueued;
  #maxObjectBytes;
  #maxBatchBytes;
  #timeoutMs;
  #idleMs;
  #spawns = 0;
  #retiring = null;
  #closing = null;
  #closureOutcome = null;
  #cleanupVerified = true;
  #profileController = new AbortController();

  constructor(root, {
    spawnCommand = spawn, maxQueued = 128, maxObjectBytes = 32 * 1024 * 1024,
    maxBatchBytes = MAX_BATCH_BYTES,
    timeoutMs = 30_000, idleMs = 30_000, env = process.env,
    profile = null, executable = null, fingerprint = null,
    capabilities = null,
    capabilityProbe = probeFosGitObjectServiceCapabilities,
    probeSpawnCommand = spawn,
    platform = process.platform
  } = {}) {
    this.#root = path.resolve(root);
    this.#spawn = spawnCommand;
    this.#env = objectEnvironment(env);
    this.#executable = executable ?? gitExecutable(this.#env, this.#root);
    this.#profile = profile ? Promise.resolve(profile) : null;
    this.#capabilities = capabilities == null
      ? null : normalizeObjectServiceCapabilities(capabilities);
    this.#capabilityProbe = capabilityProbe;
    this.#probeSpawn = probeSpawnCommand;
    this.#platform = platform;
    this.#fingerprint = fingerprint;
    this.#maxQueued = bounded(maxQueued, 128, 'queue limit');
    this.#maxObjectBytes = bounded(maxObjectBytes, MAX_OBJECT_BYTES, 'object byte limit');
    this.#maxBatchBytes = bounded(maxBatchBytes, MAX_BATCH_BYTES, 'batch byte limit');
    this.#timeoutMs = bounded(timeoutMs, 30_000, 'operation deadline');
    this.#idleMs = bounded(idleMs, 120_000, 'idle deadline');
  }

  get processSpawns() { return this.#spawns; }
  get capabilities() { return this.#capabilities; }
  get queued() {
    const weight = (operation) => operation?.kind === 'batch'
      ? operation.oids.length : (operation?.subscribers.size ?? 0);
    return this.#queue.reduce((count, operation) => count + weight(operation), 0)
      + weight(this.#active);
  }
  get closed() { return this.#closed; }

  async read(oid, { signal } = {}) {
    if (!OID.test(oid ?? '')) throw error('Object service requires one full SHA-1 or SHA-256 object ID.', 'OBJECT_ID_INVALID');
    const began = Date.now();
    await this.#prepare([oid], signal, began);
    if (this.queued >= this.#maxQueued) throw error('Git object service queue is full.', 'GAL_BUSY');
    incrementCommandCounter('git.requests');
    return new Promise((resolve, reject) => {
      // Coalesce only live requests for the same immutable OID in this exact service profile.
      // Each caller retains its own cancellation and deadline; a queued group is never cached.
      const group = this.#active?.kind !== 'batch' && this.#active?.oid === oid
        && this.#active.subscribers.size < MAX_COALESCED_SUBSCRIBERS ? this.#active
        : this.#queue.find((pending) => pending.kind !== 'batch' && pending.oid === oid
          && pending.subscribers.size < MAX_COALESCED_SUBSCRIBERS);
      const request = group ?? {
        oid, subscribers: new Set(), size: null, objectOid: null, type: null
      };
      const subscriber = { resolve, reject, signal, abort: null, timer: null };
      request.subscribers.add(subscriber);
      subscriber.abort = () => this.#dropSubscriber(request, subscriber,
        error('Git object request was cancelled.', 'OBJECT_REQUEST_CANCELLED'));
      signal?.addEventListener('abort', subscriber.abort, { once: true });
      subscriber.timer = setTimeout(() => this.#dropSubscriber(request, subscriber,
        error('Git object request exceeded its operation deadline.', 'OBJECT_REQUEST_TIMEOUT')),
      Math.max(1, this.#timeoutMs - (Date.now() - began)));
      if (group) incrementCommandCounter('git.coalesced-requests');
      else {
        this.#queue.push(request);
        this.#pump();
      }
      if (signal?.aborted) subscriber.abort();
    });
  }

  async readBatch(oids, { signal } = {}) {
    if (!Array.isArray(oids) || oids.some((oid) => !OID.test(oid ?? ''))) {
      throw error('Object batch requires bounded full SHA-1 or SHA-256 object IDs.', 'OBJECT_ID_INVALID');
    }
    if (oids.length > MAX_BATCH_OBJECTS) {
      throw error('Git object batch exceeds its object-count limit.', 'LIMIT_EXCEEDED');
    }
    if (this.#closed) throw error('Git object service is closed.', 'OBJECT_SERVICE_CLOSED');
    if (signal?.aborted) throw error('Git object request was cancelled.', 'OBJECT_REQUEST_CANCELLED');
    if (!oids.length) return [];
    const began = Date.now();
    await this.#prepare(oids, signal, began);
    if (this.queued + oids.length > this.#maxQueued) {
      throw error('Git object service queue is full.', 'GAL_BUSY');
    }
    incrementCommandCounter('git.requests');
    return new Promise((resolve, reject) => {
      const operation = {
        kind: 'batch', oids: [...oids], index: 0, current: null, results: [], bytes: 0,
        resolve, reject, signal, abort: null, timer: null
      };
      operation.abort = () => this.#dropBatch(operation,
        error('Git object request was cancelled.', 'OBJECT_REQUEST_CANCELLED'));
      signal?.addEventListener('abort', operation.abort, { once: true });
      operation.timer = setTimeout(() => this.#dropBatch(operation,
        error('Git object request exceeded its operation deadline.', 'OBJECT_REQUEST_TIMEOUT')),
      Math.max(1, this.#timeoutMs - (Date.now() - began)));
      this.#queue.push(operation);
      this.#pump();
      if (signal?.aborted) operation.abort();
    });
  }

  async #prepare(oids, signal, began) {
    if (this.#closed) throw error('Git object service is closed.', 'OBJECT_SERVICE_CLOSED');
    if (signal?.aborted) throw error('Git object request was cancelled.', 'OBJECT_REQUEST_CANCELLED');
    this.#profile ??= repositoryProfile(this.#root, this.#executable, this.#env, {
      signal: this.#profileController.signal, timeoutMs: this.#timeoutMs
    });
    const profile = await awaitProfile(this.#profile, this.#timeoutMs, signal);
    if (!['sha1', 'sha256'].includes(profile.objectFormat)) {
      throw error('Git object service could not establish the repository storage format.', 'OBJECT_FORMAT_UNSUPPORTED');
    }
    if (oids.some((oid) => oid.length !== (profile.objectFormat === 'sha1' ? 40 : 64))) {
      throw error('Object ID does not match the repository storage format.', 'OBJECT_ID_INVALID');
    }
    this.#profileValue = profile;
    if (!this.#capabilities) {
      let capability = this.#capabilityPromise;
      if (!capability) {
        capability = Promise.resolve().then(() => this.#capabilityProbe(this.#root, {
          env: this.#env,
          executable: this.#executable,
          profile,
          spawnCommand: this.#probeSpawn,
          timeoutMs: this.#timeoutMs,
          signal: this.#profileController.signal,
          platform: this.#platform
        })).then(normalizeObjectServiceCapabilities);
        this.#capabilityPromise = capability;
        // Capability discovery belongs to the service, not to any one request waiting for it.
        // A caller may cancel or exhaust its own deadline while this shared probe is still
        // retiring. Keep the exact promise attached so close() and a later caller must observe
        // that same cleanup boundary. Only the probe's own terminal result may clear it for a
        // verified retry.
        void capability.catch((cause) => {
          if (this.#capabilityPromise !== capability) return;
          if (cause?.code === 'GAL_CLEANUP_INCOMPLETE') {
            this.#cleanupVerified = false;
            this.#closed = true;
          } else if (!this.#closed) {
            this.#capabilityPromise = null;
          }
        });
      }
      try {
        this.#capabilities = await awaitProfile(capability, this.#timeoutMs, signal);
      } catch (cause) {
        // awaitProfile also enforces the individual caller's cancellation and deadline. Those
        // outcomes must not detach the still-running service-wide capability probe. The terminal
        // handler above owns retry and cleanup state.
        throw cause;
      }
    }
    if (this.#retiring) await this.#retiring;
    const fingerprint = await poolFingerprint(profile, this.#executable, this.#env);
    if (this.#fingerprint && fingerprint !== this.#fingerprint) {
      await this.close();
      throw error('Git object service repository or execution profile changed.', 'OBJECT_SERVICE_STALE');
    }
    this.#fingerprint = fingerprint;
    if (this.#closed) throw error('Git object service is closed.', 'OBJECT_SERVICE_CLOSED');
    if (signal?.aborted) throw error('Git object request was cancelled.', 'OBJECT_REQUEST_CANCELLED');
    if (Date.now() - began >= this.#timeoutMs) {
      throw error('Git object request exceeded its operation deadline.', 'OBJECT_REQUEST_TIMEOUT');
    }
  }

  #ensureChild() {
    if (this.#child) return;
    const profile = this.#profileValue;
    const protocolArguments = this.#capabilities.selectedProtocol === OBJECT_PROTOCOL_BATCH_COMMAND
      ? ['cat-file', '--batch-command', '--buffer']
      : ['cat-file', '--batch'];
    const child = this.#spawn(this.#executable, [
      `--git-dir=${profile.commonDir}`, ...protocolArguments
    ], {
      cwd: profile.commonDir,
      shell: false,
      windowsHide: true,
      detached: this.#platform !== 'win32',
      stdio: ['pipe', 'pipe', 'ignore'],
      env: this.#env
    });
    this.#child = child;
    child.once('spawn', () => {
      // Count a physical child only after the OS confirms creation. An async ENOENT/EACCES
      // failure must not appear as a successfully spawned worker in qualification evidence.
      this.#spawns += 1;
      incrementCommandCounter('git.spawns');
      incrementCommandCounter('git.child-spawns');
    });
    child.stdout.on('data', (chunk) => {
      if (this.#child !== child) return;
      if (!chunk.length) return;
      this.#chunks.push(chunk);
      this.#buffered += chunk.length;
      const batch = this.#active?.kind === 'batch' ? this.#active : null;
      const maximumBuffered = batch
        ? this.#maxBatchBytes + batch.oids.length * (HEADER_LIMIT + 1)
        : this.#maxObjectBytes + HEADER_LIMIT + 1;
      if (this.#buffered > maximumBuffered) {
        this.#failService(error('Git object service output exceeded its bounded buffer.', 'LIMIT_EXCEEDED'));
        return;
      }
      this.#parse();
    });
    child.stdout.on('error', () => {
      if (this.#child === child) this.#failService(error('Git object service output stream failed.', 'OBJECT_SERVICE_UNAVAILABLE'));
    });
    child.stdin.on('error', () => {
      if (this.#child === child) this.#failService(error('Git object service input stream failed.', 'OBJECT_SERVICE_UNAVAILABLE'));
    });
    child.once('error', () => {
      if (this.#child === child) this.#failService(error('Git object service could not start.', 'OBJECT_SERVICE_UNAVAILABLE'));
    });
    child.once('close', (code) => {
      if (this.#child !== child) return;
      this.#child = null;
      if (!this.#closed && (this.#active || this.#queue.length)) {
        this.#failService(error(`Git object service exited before completing its request (${code ?? 'unknown'}).`, 'OBJECT_SERVICE_UNAVAILABLE'));
      }
    });
  }

  #pump() {
    if (this.#active || !this.#queue.length || this.#closed || this.#retiring) {
      if (!this.#active && !this.#queue.length) this.#armIdle();
      return;
    }
    clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
    const request = this.#queue.shift();
    this.#active = request;
    try {
      this.#ensureChild();
      const oids = request.kind === 'batch' ? request.oids : [request.oid];
      const payload = this.#capabilities.selectedProtocol === OBJECT_PROTOCOL_BATCH_COMMAND
        ? `${oids.map((oid) => `contents ${oid}`).join('\n')}\nflush\n`
        : `${oids.join('\n')}\n`;
      this.#child.stdin.write(payload, 'ascii');
      incrementCommandCounter('git.batch-requests');
    } catch {
      this.#failService(error('Git object service input stream is unavailable.', 'OBJECT_SERVICE_UNAVAILABLE'));
    }
  }

  #take(length) {
    const output = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      const head = this.#chunks[0];
      const count = Math.min(head.length - this.#headOffset, length - written);
      head.copy(output, written, this.#headOffset, this.#headOffset + count);
      written += count;
      this.#headOffset += count;
      this.#buffered -= count;
      if (this.#headOffset === head.length) {
        this.#chunks.shift();
        this.#headOffset = 0;
      }
    }
    return output;
  }

  #headerLength() {
    let scanned = 0;
    for (let index = 0; index < this.#chunks.length; index += 1) {
      const chunk = this.#chunks[index];
      const start = index === 0 ? this.#headOffset : 0;
      const newline = chunk.indexOf(0x0a, start);
      if (newline >= 0) return scanned + newline - start;
      scanned += chunk.length - start;
      if (scanned > HEADER_LIMIT) break;
    }
    return null;
  }

  #parse() {
    while (true) {
      const operation = this.#active;
      if (!operation) {
        if (this.#buffered) void this.#failService(error(
          'Git object service returned unrequested bytes.', 'OBJECT_PROTOCOL_INVALID'
        ));
        return;
      }
      const batch = operation.kind === 'batch' ? operation : null;
      const request = batch
        ? (batch.current ??= { oid: batch.oids[batch.index], size: null, objectOid: null, type: null })
        : operation;
      if (request.size == null) {
        const length = this.#headerLength();
        if (length == null) {
          if (this.#buffered > HEADER_LIMIT) void this.#failService(error(
            'Git object service header exceeded its limit.', 'OBJECT_PROTOCOL_INVALID'
          ));
          return;
        }
        if (length > HEADER_LIMIT) {
          void this.#failService(error('Git object service header exceeded its limit.', 'OBJECT_PROTOCOL_INVALID'));
          return;
        }
        const header = this.#take(length + 1).subarray(0, length).toString('latin1');
        if (header === `${request.oid} missing`) {
          if (!this.#completeFrame(operation, null)) return;
          continue;
        }
        const match = /^([a-f0-9]{40}|[a-f0-9]{64}) ([a-z]+) (\d+)$/.exec(header);
        const size = Number(match?.[3]);
        if (!match || !TYPE.test(match[2]) || !Number.isSafeInteger(size) || size < 0) {
          void this.#failService(error('Git object service returned a malformed protocol header.', 'OBJECT_PROTOCOL_INVALID'));
          return;
        }
        if (match[1] !== request.oid) {
          void this.#failService(error(
            'Git object service returned a different object than the exact object requested.',
            'OBJECT_PROTOCOL_INVALID', { expectedOid: request.oid, actualOid: match[1] }
          ));
          return;
        }
        if (size > this.#maxObjectBytes || (batch && batch.bytes + size > this.#maxBatchBytes)) {
          void this.#failService(error('Git object exceeds the configured object-service limit.',
            'LIMIT_EXCEEDED', { size }));
          return;
        }
        request.objectOid = match[1]; request.type = match[2]; request.size = size;
      }
      if (this.#buffered < request.size + 1) return;
      const frame = this.#take(request.size + 1);
      if (frame[request.size] !== 0x0a) {
        void this.#failService(error('Git object service returned malformed object framing.', 'OBJECT_PROTOCOL_INVALID'));
        return;
      }
      const bytes = frame.subarray(0, request.size);
      const observedOid = createHash(this.#profileValue.objectFormat)
        .update(`${request.type} ${request.size}\0`, 'utf8')
        .update(bytes)
        .digest('hex');
      if (observedOid !== request.oid) {
        void this.#failService(error(
          'Git object service returned bytes that do not match the requested object ID.',
          'OBJECT_INTEGRITY_INVALID'
        ));
        return;
      }
      if (batch) batch.bytes += bytes.length;
      if (!this.#completeFrame(operation, Object.freeze({
        oid: request.objectOid, type: request.type, bytes
      }))) return;
    }
  }

  #completeFrame(operation, value) {
    const batch = operation.kind === 'batch' ? operation : null;
    if (batch) {
      batch.results.push(value);
      batch.index += 1;
      batch.current = null;
      if (batch.index < batch.oids.length) return true;
    }
    if (this.#buffered) {
      void this.#failService(error('Git object service returned unrequested bytes.', 'OBJECT_PROTOCOL_INVALID'));
      return false;
    }
    this.#active = null;
    if (batch) this.#finishBatch(batch, 'resolve', batch.results);
    else this.#finishGroup(operation, 'resolve', value);
    this.#pump();
    return false;
  }

  #finishSubscriber(subscriber, method, value) {
    clearTimeout(subscriber.timer);
    subscriber.signal?.removeEventListener('abort', subscriber.abort);
    subscriber[method](method === 'resolve' && value?.bytes
      ? Object.freeze({ oid: value.oid, type: value.type, bytes: Buffer.from(value.bytes) })
      : value);
  }

  #finishGroup(group, method, value) {
    const subscribers = [...group.subscribers];
    group.subscribers.clear();
    for (const subscriber of subscribers) this.#finishSubscriber(subscriber, method, value);
  }

  #finishBatch(batch, method, value) {
    clearTimeout(batch.timer);
    batch.signal?.removeEventListener('abort', batch.abort);
    batch[method](method === 'resolve'
      ? Object.freeze(value.map((entry) => entry && Object.freeze({
        oid: entry.oid, type: entry.type, bytes: Buffer.from(entry.bytes)
      }))) : value);
  }

  #finishOperation(operation, method, value) {
    if (operation.kind === 'batch') this.#finishBatch(operation, method, value);
    else this.#finishGroup(operation, method, value);
  }

  #dropBatch(batch, reason) {
    if (this.#active === batch) {
      // No part of an abandoned batch may satisfy a later operation.
      void this.#failService(reason);
      return;
    }
    const index = this.#queue.indexOf(batch);
    if (index < 0) return;
    this.#queue.splice(index, 1);
    this.#finishBatch(batch, 'reject', reason);
  }

  #dropSubscriber(group, subscriber, reason) {
    if (!group.subscribers.delete(subscriber)) return;
    this.#finishSubscriber(subscriber, 'reject', reason);
    if (group.subscribers.size) return;
    if (this.#active === group) {
      // The last interested caller no longer owns the response. Retire this worker before
      // queued work proceeds, so late frame bytes cannot satisfy another request.
      void this.#failService(reason);
    } else {
      const index = this.#queue.indexOf(group);
      if (index >= 0) this.#queue.splice(index, 1);
    }
  }

  #armIdle() {
    if (this.#idleTimer || !this.#child) return;
    this.#idleTimer = setTimeout(() => this.close(), this.#idleMs);
    this.#idleTimer.unref?.();
  }

  async #failService(reason) {
    // Only the operation whose frame was in flight belongs to the failed worker. Queued
    // requests have not written to that worker and may use a fresh generation, including
    // when an unrelated active subscriber cancels mid-frame.
    const request = this.#active;
    this.#active = null; this.#chunks = [];
    this.#buffered = 0; this.#headOffset = 0;
    const child = this.#child; this.#child = null;
    if (request) this.#finishOperation(request, 'reject', reason);
    if (child) {
      const retiring = stopChild(child, true);
      this.#retiring = retiring;
      const closed = await retiring;
      if (this.#retiring === retiring) this.#retiring = null;
      if (!closed) {
        this.#cleanupVerified = false;
        this.#closed = true;
        const pending = this.#queue;
        this.#queue = [];
        for (const queued of pending) this.#finishOperation(queued, 'reject', error(
          'Git object service could not verify worker cleanup.', 'GAL_CLEANUP_INCOMPLETE'
        ));
        return false;
      }
      this.#pump();
      return closed;
    }
    this.#pump();
    return true;
  }

  async close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#profileController.abort();
    clearTimeout(this.#idleTimer);
    const requests = [this.#active, ...this.#queue].filter(Boolean);
    this.#active = null; this.#queue = []; this.#chunks = [];
    this.#buffered = 0; this.#headOffset = 0;
    const child = this.#child; this.#child = null;
    const capability = this.#capabilityPromise;
    for (const request of requests) this.#finishOperation(request, 'reject', error('Git object service was closed.', 'OBJECT_SERVICE_CLOSED'));
    const retiring = this.#retiring;
    this.#closing = (async () => {
      const [retired, workerTerminated, capabilityTerminated] = await Promise.all([
        retiring ?? true,
        stopChild(child, false),
        awaitCapabilityCleanup(capability)
      ]);
      const terminated = workerTerminated && retired && capabilityTerminated
        && this.#cleanupVerified;
      this.#closureOutcome = Object.freeze({ closed: true, terminated });
      return this.#closureOutcome;
    })();
    return this.#closing;
  }

  async dispose() { return this.close(); }
}

export async function fosGitObjectService(root, options = {}) {
  const env = objectEnvironment(options.env ?? process.env);
  const executable = gitExecutable(env, root);
  const identity = await repositoryProfile(root, executable, env);
  const key = identity.commonDir;
  const fingerprint = await poolFingerprint(identity, executable, env);
  const transport = options.spawnCommand ?? spawn;
  const probeTransport = options.probeSpawnCommand ?? spawn;
  const capabilityProbe = options.capabilityProbe ?? probeFosGitObjectServiceCapabilities;
  const limits = JSON.stringify([
    options.maxQueued ?? 128,
    options.maxObjectBytes ?? MAX_OBJECT_BYTES,
    options.maxBatchBytes ?? MAX_BATCH_BYTES,
    options.timeoutMs ?? 30_000,
    options.idleMs ?? 30_000,
    options.capabilities ?? null,
    options.platform ?? process.platform
  ]);
  return withPoolLock(async () => {
    const current = pools.get(key);
    if (current && current.fingerprint === fingerprint && current.transport === transport
        && current.probeTransport === probeTransport
        && current.capabilityProbe === capabilityProbe
        && current.limits === limits && !current.service.closed) return current.service;
    if (current) {
      const outcome = await current.service.close();
      if (!outcome.terminated) throw error(
        'Git object service replacement is blocked until worker cleanup is verified.',
        'GAL_CLEANUP_INCOMPLETE'
      );
      pools.delete(key);
    }
    if (pools.size >= MAX_WORKERS) {
      const idle = [...pools.entries()].find(([, entry]) => entry.service.queued === 0);
      if (!idle) throw error('Git object worker pool is full.', 'GAL_BUSY');
      const outcome = await idle[1].service.close();
      if (!outcome.terminated) throw error(
        'Git object worker pool is blocked until idle worker cleanup is verified.',
        'GAL_CLEANUP_INCOMPLETE'
      );
      pools.delete(idle[0]);
    }
    const service = new FosGitObjectService(root, { ...options, env, executable, profile: identity, fingerprint });
    pools.set(key, {
      service, fingerprint, transport, probeTransport, capabilityProbe, limits
    });
    return service;
  });
}

export async function closeFosGitObjectServices() {
  return withPoolLock(async () => {
    const entries = [...pools.entries()];
    const outcomes = await Promise.all(entries.map(([, entry]) => entry.service.close()));
    for (let index = 0; index < entries.length; index += 1) {
      if (outcomes[index].terminated) pools.delete(entries[index][0]);
    }
    return { closed: true, terminated: outcomes.every((outcome) => outcome.terminated) };
  });
}
