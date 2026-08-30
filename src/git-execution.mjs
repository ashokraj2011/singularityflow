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
import { networkDisabled, run, signalProcessTree, SingularityFlowError } from './util.mjs';

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

// A managed installation may shorten or modestly extend cleanup, but it cannot turn the grace
// period into another unbounded network timeout.
const MAX_TERMINATION_GRACE_MS = 5_000;
const boundedTerminationGrace = (value, fallback = 2_000) => Math.min(
  MAX_TERMINATION_GRACE_MS,
  positive(value, fallback)
);
const terminationGraceFor = (env) => boundedTerminationGrace(
  env.SINGULARITY_FLOW_GIT_TERMINATION_GRACE_MS
);

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
  maxBuffer = 16 * 1024 * 1024, spawnCommand = spawn, signal = null,
  terminationGraceMs = terminationGraceFor(env),
  terminateTree = signalProcessTree
} = {}) {
  if (networkDisabled(env)) {
    return runRemoteGit(args, {
      cwd, env, operation, timeoutMs, allowFailure,
      runCommand() { throw new Error('offline Git execution must not spawn'); }
    });
  }
  recordRemoteGitInvocation(args, operation);
  const result = signal?.aborted
    // Abort reasons are caller-owned values and may contain credentials, URLs, or UI text. The
    // closed-vocabulary cancellation classification below is the complete public diagnosis; never
    // copy an arbitrary AbortSignal reason into a result, log, receipt, or JSON response.
    ? { status: 1, stdout: '', stderr: '', error: undefined, timedOut: false, aborted: true }
    : await new Promise((resolve) => {
    let child;
    try {
      child = spawnCommand('git', args, {
        cwd, env: nonInteractiveGitEnvironment(env), shell: false,
        // A private POSIX process group lets the timeout boundary reach Git, credential helpers,
        // SSH, proxy commands, and any other descendant in one signal. Windows uses taskkill /T.
        detached: process.platform !== 'win32',
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
    let aborted = false;
    let outputOverflow = false;
    let spawnError = null;
    let settled = false;
    let terminationReason = null;
    let deadlineTimer = null;
    let forceTimer = null;
    let settleTimer = null;
    let forceSent = false;
    const cleanupAttempts = new Set();
    const graceMs = boundedTerminationGrace(terminationGraceMs, terminationGraceFor(env));
    const forceDelayMs = Math.max(0, Math.min(1_000, Math.floor(graceMs / 2)));
    let cleanupDeadlineAt = Infinity;

    const destroyPipes = () => {
      child.stdout?.removeListener?.('data', onStdout);
      child.stderr?.removeListener?.('data', onStderr);
      child.stdout?.destroy?.();
      child.stderr?.destroy?.();
    };

    const cleanup = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (forceTimer) clearTimeout(forceTimer);
      if (settleTimer) clearTimeout(settleTimer);
      signal?.removeEventListener('abort', onAbort);
      child.removeListener?.('error', onError);
      child.removeListener?.('close', onClose);
    };

    const settle = (code, terminationSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminationReason) destroyPipes();
      // Once a boundary fired, a wrapper exiting zero in response to SIGTERM did not produce a
      // valid remote answer. Preserve failure even when that late exit reports code 0.
      const failedByBoundary = terminationReason != null || outputOverflow;
      resolve({
        status: failedByBoundary ? 1 : (code ?? 1),
        stdout,
        stderr,
        error: spawnError,
        signal: terminationSignal,
        timedOut,
        outputOverflow,
        aborted
      });
    };

    const signalTree = (treeSignal) => {
      // Keep the real Windows taskkill supervisor inside the outer operation grace. The outer hard
      // timer still wins if an injected or broken implementation never settles.
      const remainingMs = Math.max(1, cleanupDeadlineAt - Date.now() - 5);
      let finishAttempt;
      const attempt = new Promise((resolveAttempt) => { finishAttempt = resolveAttempt; });
      // Register the placeholder before invoking an injected implementation. A direct-child test
      // double may emit `close` synchronously while it is being called; that close must still wait
      // for both the graceful and forced cleanup attempts it triggered.
      cleanupAttempts.add(attempt);
      attempt.then(() => cleanupAttempts.delete(attempt));
      try {
        Promise.resolve(terminateTree(child, treeSignal, {
          timeoutMs: Math.max(1, Math.min(remainingMs, treeSignal === 'SIGTERM'
            ? Math.max(1, forceDelayMs - 5)
            : remainingMs))
        })).then(finishAttempt, () => finishAttempt(false));
      } catch {
        finishAttempt(false);
      }
      return attempt;
    };

    const settleAfterCleanup = (code, terminationSignal) => {
      if (settled) return;
      const pending = [...cleanupAttempts];
      if (!pending.length) {
        settle(code, terminationSignal);
        return;
      }
      Promise.allSettled(pending).then(() => {
        if (!settled) settle(code, terminationSignal);
      });
    };

    const force = () => {
      if (settled || forceSent) return null;
      forceSent = true;
      return signalTree('SIGKILL');
    };

    const terminate = (reason) => {
      if (settled || terminationReason) return;
      terminationReason = reason;
      timedOut = reason === 'timeout';
      aborted = reason === 'abort';
      cleanupDeadlineAt = Date.now() + graceMs;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      deadlineTimer = null;
      signalTree('SIGTERM');
      // Force termination happens inside the grace window. The second timer is independent of
      // `close`, so a descendant retaining a pipe cannot retain the awaiting command forever.
      forceTimer = setTimeout(force, forceDelayMs);
      settleTimer = setTimeout(() => {
        force();
        // This deadline is deliberately independent of both Git's `close` event and cleanup
        // promises supplied by an injected implementation. The real Windows supervisor is given
        // a tighter inner timeout, but no test double or damaged host can retain the operation.
        settle(1, forceSent ? 'SIGKILL' : 'SIGTERM');
      }, graceMs);
    };

    const append = (channel, chunk) => {
      if (outputOverflow || settled) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      bytes += value.byteLength;
      if (bytes > maxBuffer) {
        outputOverflow = true;
        terminate('output-overflow');
        return;
      }
      if (channel === 'stdout') stdout += value.toString('utf8');
      else stderr += value.toString('utf8');
    };
    const onStdout = (chunk) => append('stdout', chunk);
    const onStderr = (chunk) => append('stderr', chunk);
    const onError = (error) => {
      spawnError = error;
      // Spawn failures have no process tree and do not reliably emit `close` on every injected
      // implementation. Settle them immediately; post-spawn errors still get bounded cleanup.
      if (!child.pid) settle(1, null);
      else terminate('spawn-error');
    };
    const onClose = (code, terminationSignal) => {
      // `close` proves only that this child's pipes closed. A helper that redirected its own stdio
      // may still be alive in the process group/tree, so complete the escalation before reporting
      // quiescence after any boundary-triggered termination.
      if (terminationReason) {
        force();
        settleAfterCleanup(code, terminationSignal);
      } else settle(code, terminationSignal);
    };
    const onAbort = () => terminate('abort');

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.on('error', onError);
    child.on('close', onClose);
    deadlineTimer = setTimeout(() => terminate('timeout'), timeoutMs);
    // The signal may have changed after the pre-spawn check (an injected launcher can abort while
    // returning the child). Do not miss that narrow cancellation window.
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
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

function observationPatternsCover(available, requested) {
  const held = new Set(available);
  return requested.every((pattern) => held.has(pattern)
    || (pattern.startsWith('refs/heads/') && pattern !== 'refs/heads/*' && held.has('refs/heads/*')));
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

  reusableObservation(remoteIdentity, patterns) {
    for (const [key, observation] of this.observations) {
      let observedRemote;
      let observedPatterns;
      try { [observedRemote, observedPatterns] = JSON.parse(key); } catch { continue; }
      if (observedRemote !== remoteIdentity
        || !observationPatternsCover(observedPatterns, patterns)) continue;
      // An exact waiter may share the exact classified failure it requested. A narrower request
      // must not inherit a failed broad inventory, however: providers can reject/overflow
      // `refs/heads/*` while still answering one exact ref successfully.
      if (JSON.stringify(observedPatterns) === JSON.stringify(patterns) || observation.ok) {
        return observation;
      }
    }
    return null;
  }

  reusablePendingObservation(remoteIdentity, patterns) {
    for (const pending of this.pendingObservations.values()) {
      if (!pending.invalidated && pending.remoteIdentity === remoteIdentity
        && observationPatternsCover(pending.patterns, patterns)) return pending;
    }
    return null;
  }

  invalidatePendingRemote(remoteIdentity) {
    for (const [key, pending] of this.pendingObservations) {
      if (pending.remoteIdentity !== remoteIdentity) continue;
      pending.invalidated = true;
      this.nextObservationGeneration(key);
      this.pendingObservations.delete(key);
    }
  }

  observe(remote, {
    refs = [], includeHead = true, includeAllHeads = false, refresh = false,
    timeoutMs = gitTimeouts(this.env).probe
  } = {}) {
    const url = assertCredentialFreeRemote(remote);
    const patterns = observationPatterns({ refs, includeHead, includeAllHeads });
    const key = JSON.stringify([url, patterns]);
    if (refresh) this.invalidate(url);
    else {
      const reusable = this.reusableObservation(url, patterns);
      if (reusable) return reusable;
    }
    // A synchronous read cannot await an older async one. It supersedes every pending shape for the
    // same transport so none can later repopulate the operation cache with pre-read authority.
    this.invalidatePendingRemote(url);
    const generation = this.nextObservationGeneration(key);
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
    if (refresh) this.invalidate(url);
    else {
      const reusable = this.reusableObservation(url, patterns);
      if (reusable) return reusable;
      const pending = this.reusablePendingObservation(url, patterns);
      if (pending) {
        const observation = await pending.promise;
        const exact = JSON.stringify(pending.patterns) === JSON.stringify(patterns);
        if (exact || observation.ok) return observation;
        // The broad request failed. Retry the narrower shape instead of turning a provider's
        // all-heads limitation into a false absence for an exact authority ref.
      }
    }
    const generation = this.nextObservationGeneration(key);
    const pendingState = {
      remoteIdentity: url, patterns, promise: null, invalidated: false, generation
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
    this.invalidatePendingRemote(remoteIdentity);
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
