/**
 * One boundary for Git commands that contact a remote.
 *
 * Local Git operations are intentionally still synchronous and live in git.mjs: reading HEAD,
 * the index, or an object is bounded by local storage and many write transactions depend on the
 * answer immediately. Remote Git is a different contract. It must not open an invisible credential
 * prompt, wait forever behind an office proxy, or make every caller independently interpret the
 * same provider error.
 */
import {
  assertCredentialFreeRemote, classifyGitRemoteFailure, redactDiagnosticText,
  frozenRemoteTransport, sanitizeRemote
} from './git-remote-diagnostics.mjs';
import { incrementCommandCounter } from './dx-timing-context.mjs';
import { spawn } from 'node:child_process';
import { networkDisabled, run, SingularityFlowError } from './util.mjs';

const positive = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/** Timeouts are read per invocation so tests and managed installations can tune them safely. */
export function gitTimeouts(env = process.env) {
  return Object.freeze({
    probe: positive(env.SINGULARITY_FLOW_GIT_PREFLIGHT_TIMEOUT_MS, 30_000),
    configuration: positive(env.SINGULARITY_FLOW_GIT_CONFIGURATION_TIMEOUT_MS, 120_000),
    push: positive(env.SINGULARITY_FLOW_GIT_PUSH_TIMEOUT_MS, 180_000)
  });
}

/**
 * VS Code has no terminal in which Git or Git Credential Manager can ask a question. A command
 * must either use the configured credential helper without interaction or fail with a classified,
 * actionable result. The caller's proxy and CA environment is otherwise preserved byte-for-byte.
 */
export function nonInteractiveGitEnvironment(env = process.env) {
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never'
  };
}

const timeoutFor = (operation, env) => {
  const timeouts = gitTimeouts(env);
  if (operation === 'remote-probe') return timeouts.probe;
  if (operation === 'remote-push') return timeouts.push;
  return timeouts.configuration;
};

const REMOTE_GIT_VERBS = new Set(['clone', 'fetch', 'ls-remote', 'pull', 'push']);

/**
 * Count only closed-vocabulary transport facts. Arguments may contain credentials, repository
 * paths, refs, and Work IDs, so they must never become timing keys or values.
 */
function recordRemoteGitInvocation(args, operation) {
  incrementCommandCounter('git.remote.total');
  const operationName = String(operation ?? '').replace(/^remote-/, '');
  if (['probe', 'configuration', 'push'].includes(operationName)) {
    incrementCommandCounter(`git.remote.operation.${operationName}`);
  }
  const verb = (args ?? []).find((candidate) => REMOTE_GIT_VERBS.has(String(candidate)));
  if (verb) incrementCommandCounter(`git.remote.command.${verb}`);
}

function recordRemoteGitOutcome(result) {
  if (result?.timedOut === true) incrementCommandCounter('git.remote.outcome.timeout');
  if (result?.outputOverflow === true) incrementCommandCounter('git.remote.outcome.output-overflow');
  if (result?.status !== 0 || result?.outputOverflow === true) {
    incrementCommandCounter('git.remote.outcome.failure');
  }
}

function throwRemoteFailure(observed) {
  const { failure, operation, timedOut, outputOverflow } = observed;
  throw new SingularityFlowError(
    `Git ${operation.replace(/^remote-/, '')} failed. ${failure.advice}`,
    {
      code: outputOverflow ? 'REMOTE_OUTPUT_LIMIT' : failure.code,
      details: {
        operation,
        classification: failure.classification,
        retryable: failure.retryable,
        timedOut: timedOut === true,
        outputOverflow: outputOverflow === true
      }
    }
  );
}

/**
 * Execute one bounded remote Git operation and attach the shared failure classification.
 *
 * `allowFailure` defaults to true because most callers need to distinguish a missing ref from an
 * unavailable authority. Setting it false turns the same structured result into a safe refusal.
 */
export function runRemoteGit(args, {
  cwd = process.cwd(),
  env = process.env,
  operation = 'remote-probe',
  timeoutMs = timeoutFor(operation, env),
  allowFailure = true,
  runCommand = run,
  maxBuffer = undefined
} = {}) {
  recordRemoteGitInvocation(args, operation);
  if (networkDisabled(env)) {
    const blocked = {
      status: 1, stdout: '', stderr: '', error: undefined,
      timedOut: false, blocked: true
    };
    const failure = classifyGitRemoteFailure(blocked);
    const observed = { ...blocked, failure, operation, timeoutMs };
    recordRemoteGitOutcome(observed);
    if (!allowFailure) throwRemoteFailure(observed);
    return observed;
  }
  const result = runCommand('git', args, {
    cwd,
    env: nonInteractiveGitEnvironment(env),
    timeoutMs,
    allowFailure: true,
    ...(maxBuffer === undefined ? {} : { maxBuffer })
  });
  const failure = result.status === 0 ? null : classifyGitRemoteFailure(result);
  const observed = { ...result, failure, operation, timeoutMs };
  recordRemoteGitOutcome(observed);
  if (result.status !== 0 && !allowFailure) throwRemoteFailure(observed);
  return observed;
}

/**
 * Asynchronous sibling used by workspace-wide fan-out. The synchronous boundary remains useful
 * inside atomic Git transactions, but running four independent repository fetches synchronously
 * turns office proxy latency into their sum. This form keeps the same timeout, environment, and
 * classification contract while allowing bounded `mapLimit` concurrency.
 */
export async function runRemoteGitAsync(args, {
  cwd = process.cwd(), env = process.env, operation = 'remote-probe',
  timeoutMs = timeoutFor(operation, env), allowFailure = true,
  maxBuffer = 16 * 1024 * 1024, spawnCommand = spawn, signal = null
} = {}) {
  if (networkDisabled(env)) {
    return runRemoteGit(args, {
      cwd, env, operation, timeoutMs, allowFailure,
      runCommand() { throw new Error('offline Git execution must not spawn'); }
    });
  }
  recordRemoteGitInvocation(args, operation);
  const result = signal?.aborted
    ? { status: 1, stdout: '', stderr: '', error: signal.reason, timedOut: false, aborted: true }
    : await new Promise((resolve) => {
    let child;
    try {
      child = spawnCommand('git', args, {
        cwd, env: nonInteractiveGitEnvironment(env), shell: false,
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
      });
    } catch (error) {
      resolve({ status: 1, stdout: '', stderr: '', error, timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let timedOut = false;
    let outputOverflow = false;
    let spawnError = null;
    let forceTimer = null;
    const terminate = () => {
      child.kill('SIGTERM');
      forceTimer ??= setTimeout(() => child.kill('SIGKILL'), 1_000);
    };
    const append = (channel, chunk) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      bytes += value.byteLength;
      if (bytes > maxBuffer) {
        outputOverflow = true;
        terminate();
        return;
      }
      if (channel === 'stdout') stdout += value.toString('utf8');
      else stderr += value.toString('utf8');
    };
    child.stdout?.on('data', (chunk) => append('stdout', chunk));
    child.stderr?.on('data', (chunk) => append('stderr', chunk));
    child.on('error', (error) => { spawnError = error; });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const abort = () => terminate();
    signal?.addEventListener('abort', abort, { once: true });
    // These timers are part of the promise's completion machinery. Unreferencing the deadline (or
    // the forced-kill grace timer) lets Node conclude that the event loop is empty while callers are
    // still awaiting this operation. `node:test` then reports a pending promise instead of the
    // classified timeout result. Keep both referenced until `close` settles the operation.
    child.on('close', (code, terminationSignal) => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      signal?.removeEventListener('abort', abort);
      resolve({
        status: code ?? 1, stdout, stderr, error: spawnError,
        signal: terminationSignal, timedOut, outputOverflow, aborted: signal?.aborted === true
      });
    });
  });
  const failure = result.aborted
    ? {
        code: 'REMOTE_OPERATION_ABORTED', classification: 'cancelled', retryable: true,
        advice: 'The Git operation was cancelled before it completed. Retry when ready.'
      }
    : result.status === 0 && !result.outputOverflow
    ? null
    : classifyGitRemoteFailure(result);
  const observed = { ...result, failure, operation, timeoutMs };
  recordRemoteGitOutcome(observed);
  if ((result.status !== 0 || result.outputOverflow) && !allowFailure) throwRemoteFailure(observed);
  return observed;
}

function symrefBranch(stdout) {
  return String(stdout ?? '').match(/^ref:\s+refs\/heads\/(.+?)\s+HEAD$/m)?.[1] ?? null;
}

function advertisedRefs(stdout) {
  const refs = new Map();
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-f]{40,64})\s+(refs\/[^\s]+)$/i);
    if (match) refs.set(match[2], match[1]);
  }
  return refs;
}

function observationPatterns({ refs = [], includeHead = true, includeAllHeads = false } = {}) {
  return [...new Set([
    ...(includeHead ? ['HEAD'] : []),
    ...refs.map((ref) => String(ref).trim()).filter(Boolean),
    ...(includeAllHeads ? ['refs/heads/*'] : [])
  ])];
}

function remoteObservation(url, patterns, result) {
  const refsByName = advertisedRefs(result.stdout);
  return Object.freeze({
    ok: result.status === 0,
    remote: sanitizeRemote(url),
    defaultBranch: result.status === 0 ? symrefBranch(result.stdout) : null,
    refs: refsByName,
    branches: [...refsByName.keys()].filter((ref) => ref.startsWith('refs/heads/'))
      .map((ref) => ref.slice('refs/heads/'.length)).sort(),
    includedHead: patterns.includes('HEAD'),
    patterns: Object.freeze([...patterns]),
    failure: result.failure,
    timedOut: result.timedOut === true,
    result
  });
}

/**
 * A per-operation observation cache. Mutations construct a fresh session and explicitly invalidate
 * it after a successful push; no remote fact is cached across CLI invocations or authority changes.
 */
export class GitRemoteSession {
  constructor({
    env = process.env, runCommand = run, runAsyncCommand = runRemoteGitAsync
  } = {}) {
    this.env = env;
    this.runCommand = runCommand;
    this.runAsyncCommand = runAsyncCommand;
    this.observations = new Map();
    this.pendingObservations = new Map();
    this.observationGenerations = new Map();
  }

  nextObservationGeneration(key) {
    const generation = (this.observationGenerations.get(key) ?? 0) + 1;
    this.observationGenerations.set(key, generation);
    return generation;
  }

  observe(remote, {
    refs = [], includeHead = true, includeAllHeads = false, refresh = false,
    timeoutMs = gitTimeouts(this.env).probe
  } = {}) {
    const url = assertCredentialFreeRemote(remote);
    const patterns = observationPatterns({ refs, includeHead, includeAllHeads });
    const key = JSON.stringify([url, patterns]);
    if (!refresh && this.observations.has(key)) return this.observations.get(key);
    const generation = this.nextObservationGeneration(key);
    const pending = this.pendingObservations.get(key);
    if (pending) pending.invalidated = true;
    const transport = frozenRemoteTransport(url, { env: this.env });
    const result = runRemoteGit(['ls-remote', '--symref', '--', transport.remote, ...patterns], {
      operation: 'remote-probe', timeoutMs, env: transport.env,
      runCommand: this.runCommand, allowFailure: true
    });
    const observation = remoteObservation(url, patterns, result);
    if (this.observationGenerations.get(key) === generation) {
      this.observations.set(key, observation);
    }
    return observation;
  }

  /** Async equivalent for independent repository fan-out, sharing the exact same cache contract. */
  async observeAsync(remote, {
    refs = [], includeHead = true, includeAllHeads = false, refresh = false,
    timeoutMs = gitTimeouts(this.env).probe, signal = null
  } = {}) {
    const url = assertCredentialFreeRemote(remote);
    const patterns = observationPatterns({ refs, includeHead, includeAllHeads });
    const key = JSON.stringify([url, patterns]);
    if (!refresh && this.observations.has(key)) return this.observations.get(key);
    if (!refresh && this.pendingObservations.has(key)) {
      return this.pendingObservations.get(key).promise;
    }
    const generation = this.nextObservationGeneration(key);
    const pendingState = {
      remoteIdentity: url, promise: null, invalidated: false, generation
    };
    const pending = (async () => {
      const transport = frozenRemoteTransport(url, { env: this.env });
      const result = await this.runAsyncCommand(
        ['ls-remote', '--symref', '--', transport.remote, ...patterns],
        {
          operation: 'remote-probe', timeoutMs, env: transport.env,
          allowFailure: true, signal
        }
      );
      const observation = remoteObservation(url, patterns, result);
      // A successful mutation can invalidate this remote while an older observation is still in
      // flight. The awaiting caller may use the result it explicitly requested, but that stale
      // result must never repopulate the operation cache after the mutation boundary.
      if (!pendingState.invalidated
        && this.observationGenerations.get(key) === pendingState.generation) {
        this.observations.set(key, observation);
      }
      return observation;
    })();
    pendingState.promise = pending;
    this.pendingObservations.set(key, pendingState);
    try {
      return await pending;
    } finally {
      if (this.pendingObservations.get(key)?.promise === pending) this.pendingObservations.delete(key);
    }
  }

  invalidate(remote) {
    const remoteIdentity = assertCredentialFreeRemote(remote);
    for (const key of this.observations.keys()) {
      let observedRemote = null;
      try { [observedRemote] = JSON.parse(key); } catch { /* an invalid private key is unrelated */ }
      if (observedRemote === remoteIdentity) this.observations.delete(key);
    }
    for (const [key, pending] of this.pendingObservations) {
      if (pending.remoteIdentity === remoteIdentity) {
        pending.invalidated = true;
        this.nextObservationGeneration(key);
        this.pendingObservations.delete(key);
      }
    }
  }
}

export function requireRemoteObservation(observation, label = 'repository') {
  if (observation?.ok) return observation;
  const failure = observation?.failure ?? {
    code: 'REMOTE_UNKNOWN', classification: 'unknown', retryable: false,
    advice: 'Inspect Git access and retry.'
  };
  // Reachability failures need to retain the language used by the workspace form and CLI. Besides
  // being clearer for a missing URL, this distinction stops an unavailable remote from sounding
  // like a malformed configuration file. Authentication, authorization, trust, and protocol
  // failures did reach Git and are therefore accurately described as unreadable.
  const verb = ['network-transient', 'offline', 'remote-not-found']
    .includes(failure.classification) ? 'reach' : 'read';
  throw new SingularityFlowError(
    `Cannot ${verb} ${label}. ${failure.advice}`,
    {
      code: failure.code,
      details: {
        classification: failure.classification,
        retryable: failure.retryable,
        remote: observation?.remote ?? null,
        diagnostic: redactDiagnosticText(failure.advice)
      }
    }
  );
}
