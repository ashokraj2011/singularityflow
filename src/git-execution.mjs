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
  sanitizeRemote
} from './git-remote-diagnostics.mjs';
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
  if (networkDisabled(env)) {
    const blocked = {
      status: 1, stdout: '', stderr: '', error: undefined,
      timedOut: false, blocked: true
    };
    const failure = classifyGitRemoteFailure(blocked);
    const observed = { ...blocked, failure, operation, timeoutMs };
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
  maxBuffer = 16 * 1024 * 1024, spawnCommand = spawn
} = {}) {
  if (networkDisabled(env)) {
    return runRemoteGit(args, {
      cwd, env, operation, timeoutMs, allowFailure,
      runCommand() { throw new Error('offline Git execution must not spawn'); }
    });
  }
  const result = await new Promise((resolve) => {
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
    // These timers are part of the promise's completion machinery. Unreferencing the deadline (or
    // the forced-kill grace timer) lets Node conclude that the event loop is empty while callers are
    // still awaiting this operation. `node:test` then reports a pending promise instead of the
    // classified timeout result. Keep both referenced until `close` settles the operation.
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      resolve({
        status: code ?? 1, stdout, stderr, error: spawnError,
        signal, timedOut, outputOverflow
      });
    });
  });
  const failure = result.status === 0 && !result.outputOverflow
    ? null
    : classifyGitRemoteFailure(result);
  const observed = { ...result, failure, operation, timeoutMs };
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

/**
 * A per-operation observation cache. Mutations construct a fresh session and explicitly invalidate
 * it after a successful push; no remote fact is cached across CLI invocations or authority changes.
 */
export class GitRemoteSession {
  constructor({ env = process.env, runCommand = run } = {}) {
    this.env = env;
    this.runCommand = runCommand;
    this.observations = new Map();
  }

  observe(remote, {
    refs = [], includeHead = true, includeAllHeads = false, refresh = false,
    timeoutMs = gitTimeouts(this.env).probe
  } = {}) {
    const url = assertCredentialFreeRemote(remote);
    const patterns = [...new Set([
      ...(includeHead ? ['HEAD'] : []),
      ...refs.map((ref) => String(ref).trim()).filter(Boolean),
      ...(includeAllHeads ? ['refs/heads/*'] : [])
    ])];
    const key = JSON.stringify([url, patterns]);
    if (!refresh && this.observations.has(key)) return this.observations.get(key);
    const result = runRemoteGit(['ls-remote', '--symref', '--', url, ...patterns], {
      operation: 'remote-probe', timeoutMs, env: this.env,
      runCommand: this.runCommand, allowFailure: true
    });
    const refsByName = advertisedRefs(result.stdout);
    const observation = Object.freeze({
      ok: result.status === 0,
      remote: sanitizeRemote(url),
      defaultBranch: result.status === 0 ? symrefBranch(result.stdout) : null,
      refs: refsByName,
      branches: [...refsByName.keys()].filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length)).sort(),
      failure: result.failure,
      timedOut: result.timedOut === true,
      result
    });
    this.observations.set(key, observation);
    return observation;
  }

  invalidate(remote) {
    const safe = sanitizeRemote(remote);
    for (const [key, observation] of this.observations) {
      if (observation.remote === safe) this.observations.delete(key);
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
