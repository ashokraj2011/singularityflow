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
  assertCredentialFreeRemote, classifyGitRemoteFailure, failureEvidence, redactDiagnosticText,
  frozenRemoteTransport, isPortableAbsoluteGitPath, sanitizeRemote
} from './git-remote-diagnostics.mjs';
import { incrementCommandCounter } from './dx-timing-context.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { resolvePlatformProcess } from './platform-process.mjs';
import { processResultSucceeded } from './process-result.mjs';
import {
  inheritEnterpriseGitEnvironment, remoteGitEnvironment
} from './git-enterprise-environment.mjs';
import {
  networkDisabled, recordSubprocessTiming, run, signalProcessTree, SingularityFlowError
} from './util.mjs';

const positive = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

function workingDirectoryAvailable(cwd) {
  try { return statSync(cwd).isDirectory(); } catch { return false; }
}

/** Timeouts are read per invocation so tests and managed installations can tune them safely. */
export function gitTimeouts(env = process.env) {
  return Object.freeze({
    probe: positive(env.SINGULARITY_FLOW_GIT_PREFLIGHT_TIMEOUT_MS, 30_000),
    configuration: positive(env.SINGULARITY_FLOW_GIT_CONFIGURATION_TIMEOUT_MS, 120_000),
    push: positive(env.SINGULARITY_FLOW_GIT_PUSH_TIMEOUT_MS, 180_000)
  });
}

/**
 * A filesystem authority cannot be made faster by DNS/proxy recovery and must not be reported as
 * an office-network outage merely because a busy host took longer than the interactive probe
 * budget to schedule Git. Keep the operation bounded, but give local and file:// authorities the
 * configuration-operation window. Explicit caller deadlines continue to win.
 */
export function gitRemoteProbeTimeout(remote, env = process.env) {
  const value = String(remote ?? '').trim();
  const local = /^file:/iu.test(value)
    || isPortableAbsoluteGitPath(value)
    || /^\.{1,2}[\\/]/u.test(value);
  const timeouts = gitTimeouts(env);
  return local ? timeouts.configuration : timeouts.probe;
}

/**
 * VS Code has no terminal in which Git or Git Credential Manager can ask a question. A command
 * must either use the configured credential helper without interaction or fail with a classified,
 * actionable result. The caller's proxy and CA environment is otherwise preserved byte-for-byte.
 */
export function nonInteractiveGitEnvironment(env = process.env) {
  const nonInteractive = {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never'
  };
  // This helper is routinely applied before the final executor. Preserve the private attestation
  // carried by a frozen transport; otherwise that executor correctly treats the cloned object as
  // ambient input, removes its counted configuration, and loses SFlow's exact URL alias.
  return inheritEnterpriseGitEnvironment(env, nonInteractive);
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
  incrementCommandCounter('git.requests');
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
  if (!processResultSucceeded(result)) {
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
        outputOverflow: outputOverflow === true,
        evidence: failure.evidence
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
  maxBuffer = undefined,
  encoding = 'utf8'
} = {}) {
  recordRemoteGitInvocation(args, operation);
  const serviceStarted = performance.now();
  if (networkDisabled(env)) {
    const blocked = {
      status: 1, stdout: '', stderr: '', error: undefined,
      timedOut: false, blocked: true
    };
    const failure = {
      ...classifyGitRemoteFailure(blocked),
      evidence: failureEvidence(blocked)
    };
    const observed = { ...blocked, failure, operation, timeoutMs };
    recordRemoteGitOutcome(observed);
    if (!allowFailure) throwRemoteFailure(observed);
    return observed;
  }
  incrementCommandCounter('git.spawns');
  let result;
  try {
    result = runCommand('git', args, {
      cwd,
      // The runner is the final authority boundary. Callers should normally pass the marked
      // environment returned by enterpriseGitEnvironment/frozenRemoteTransport, but a legacy or
      // direct caller cannot bypass isolation merely by passing process.env itself.
      env: nonInteractiveGitEnvironment(remoteGitEnvironment(env)),
      timeoutMs,
      allowFailure: true,
      // This adapter owns the logical-request, physical-spawn and service-time counters. The shared
      // runner owns raw local Git calls; naming the owner prevents the two layers counting one child.
      recordGitTiming: false,
      ...(encoding === 'buffer' ? { encoding: 'buffer' } : {}),
      ...(maxBuffer === undefined ? {} : { maxBuffer })
    });
  } finally {
    incrementCommandCounter('git.service-ms', Math.max(0, Math.round(performance.now() - serviceStarted)));
  }
  const succeeded = processResultSucceeded(result);
  const failure = succeeded ? null : {
    ...classifyGitRemoteFailure(result, { cwdAvailable: workingDirectoryAvailable(cwd) }),
    evidence: failureEvidence(result)
  };
  const observed = {
    ...result,
    // Preserve the raw process exit in failure evidence, while ensuring legacy status-only
    // consumers cannot admit a poisoned zero exit as success.
    status: succeeded ? 0 : result.status === 0 ? 1 : result.status,
    failure, operation, timeoutMs
  };
  recordRemoteGitOutcome(observed);
  if (!succeeded && !allowFailure) throwRemoteFailure(observed);
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
  encoding = 'utf8',
  platform = process.platform, platformLookupCommand = spawnSync,
  platformLstatCommand = undefined, platformRealpathCommand = undefined,
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
  const serviceStarted = performance.now();
  const operationDeadlineAt = serviceStarted + positive(timeoutMs, timeoutFor(operation, env));
  const probeStarted = process.env.SINGULARITY_FLOW_SUBPROCESS_PROBE ? serviceStarted : 0;
  // Environment admission is a preflight boundary, not a child-process failure. Let its structured
  // GIT_ENTERPRISE_CONFIG_UNAVAILABLE refusal propagate intact instead of catching it below and
  // misclassifying it as an opaque spawn/remote error. A pre-aborted request still performs no
  // configuration read or process launch.
  const executionEnvironment = signal?.aborted
    ? null
    : nonInteractiveGitEnvironment(remoteGitEnvironment(env));
  const result = signal?.aborted
    // Abort reasons are caller-owned values and may contain credentials, URLs, or UI text. The
    // closed-vocabulary cancellation classification below is the complete public diagnosis; never
    // copy an arbitrary AbortSignal reason into a result, log, receipt, or JSON response.
    ? { status: 1, stdout: '', stderr: '', error: undefined, timedOut: false, aborted: true }
    : performance.now() >= operationDeadlineAt
      // System/global Git configuration is read synchronously. It cannot be pre-empted by an
      // event-loop timer, but its elapsed time still consumes the operation budget: do not start a
      // network child after that preflight has already exhausted the caller's deadline.
      ? { status: 1, stdout: '', stderr: '', error: undefined, timedOut: true, aborted: false }
    : await new Promise((resolve) => {
    let child;
    try {
      // Match the synchronous `run` boundary exactly. In particular, CreateProcess must never
      // resolve a repository-local `git.exe` before PATH on Windows: resolve the reviewed logical
      // command to a hardened absolute executable (or the safely escaped batch adapter) first.
      const launch = resolvePlatformProcess('git', args, {
        platform, environment: executionEnvironment, spawnSyncCommand: platformLookupCommand, cwd,
        lstatSyncCommand: platformLstatCommand,
        realpathSyncCommand: platformRealpathCommand
      });
      if (performance.now() >= operationDeadlineAt) {
        resolve({ status: 1, stdout: '', stderr: '', timedOut: true, aborted: false });
        return;
      }
      incrementCommandCounter('git.spawns');
      child = spawnCommand(launch.executable, launch.arguments, {
        cwd, env: executionEnvironment, ...launch.spawnOptions,
        // A private POSIX process group lets the timeout boundary reach Git, credential helpers,
        // SSH, proxy commands, and any other descendant in one signal. Windows uses taskkill /T.
        detached: platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
      });
    } catch (error) {
      resolve({ status: 1, stdout: '', stderr: '', error, timedOut: false });
      return;
    }
    // Local byte-exact Git descriptors can opt into raw stdout. Keep remote callers' text
    // contract unchanged, and never decode a pathname before its strict parser sees it.
    let stdout = encoding === 'buffer' ? Buffer.alloc(0) : '';
    const stdoutChunks = encoding === 'buffer' ? [] : null;
    let stderr = '';
    const stdoutDecoder = encoding === 'buffer' ? null : new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
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
      if (stdoutDecoder) stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      // Once a boundary fired, a wrapper exiting zero in response to SIGTERM did not produce a
      // valid remote answer. Preserve failure even when that late exit reports code 0.
      const failedByBoundary = terminationReason != null || outputOverflow;
      resolve({
        status: failedByBoundary ? 1 : (code ?? 1),
        stdout: stdoutChunks ? Buffer.concat(stdoutChunks) : stdout,
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
      if (channel === 'stdout') {
        if (stdoutChunks) stdoutChunks.push(value);
        else stdout += stdoutDecoder.write(value);
      }
      else stderr += stderrDecoder.write(value);
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
    deadlineTimer = setTimeout(
      () => terminate('timeout'),
      Math.max(1, Math.ceil(operationDeadlineAt - performance.now()))
    );
    // The signal may have changed after the pre-spawn check (an injected launcher can abort while
    // returning the child). Do not miss that narrow cancellation window.
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
  const serviceMs = performance.now() - serviceStarted;
  incrementCommandCounter('git.service-ms', Math.max(0, Math.round(serviceMs)));
  if (probeStarted) recordSubprocessTiming('git', args, serviceMs);
  const succeeded = processResultSucceeded(result);
  const classified = succeeded
    ? null
    : {
        ...classifyGitRemoteFailure(result, { cwdAvailable: workingDirectoryAvailable(cwd) }),
        evidence: failureEvidence(result)
      };
  const failure = result.aborted
      ? {
        code: 'REMOTE_OPERATION_ABORTED', classification: 'cancelled', retryable: true,
        advice: 'The Git operation was cancelled before it completed. Retry when ready.',
        evidence: failureEvidence(result)
      }
    : result.outputOverflow
      ? {
          ...classified,
          code: 'REMOTE_OUTPUT_LIMIT',
          retryable: true,
          advice: 'Git produced more diagnostic or reference data than the bounded operation permits. Narrow the requested refs or inspect the provider outside SFlow.'
        }
    : succeeded
    ? null
    : classified;
  const observed = {
    ...result,
    status: succeeded ? 0 : result.status === 0 ? 1 : result.status,
    failure, operation, timeoutMs
  };
  recordRemoteGitOutcome(observed);
  if (!succeeded && !allowFailure) throwRemoteFailure(observed);
  return observed;
}

function symrefBranch(stdout) {
  return String(stdout ?? '').match(/^ref:\s+refs\/heads\/(.+?)\s+HEAD$/m)?.[1] ?? null;
}

/**
 * Validate the ref grammar advertised by Git without spawning a second `check-ref-format` process.
 *
 * This mirrors Git's full-ref safety rules that matter at the provider boundary: refs are rooted,
 * have no empty/dot/lock components, traversal, reflog syntax, control/option metacharacters, or
 * trailing dot. `HEAD` is the only accepted pseudo-ref and is handled explicitly by the caller.
 */
function validAdvertisedRef(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('refs/')
      || ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.')
      || ref.includes('//') || ref.includes('..') || ref.includes('@{')
      || /[\u0000-\u0020\u007f-\u009f~^:?*\\]/u.test(ref) || ref.includes('[')) {
    return false;
  }
  const components = ref.split('/');
  return components.length >= 2
    && components.every((component) => component !== ''
      && !component.startsWith('.')
      && !component.endsWith('.lock'));
}

function parseRemoteAdvertisement(stdout) {
  const refs = new Map();
  const symbolicRefs = new Map();
  let invalid = false;
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const value = line.trim();
    if (!value) continue;
    const symbolic = /^ref:\s+([^\s]+)\s+([^\s]+)$/u.exec(value);
    if (symbolic) {
      const validTarget = symbolic[1].startsWith('refs/heads/')
        && validAdvertisedRef(symbolic[1]);
      const validName = symbolic[2] === 'HEAD' || validAdvertisedRef(symbolic[2]);
      if (!validTarget || !validName || symbolicRefs.has(symbolic[2])) invalid = true;
      else symbolicRefs.set(symbolic[2], symbolic[1]);
      continue;
    }
    const direct = /^([0-9a-f]{40}|[0-9a-f]{64})\s+(refs\/[^\s]+|HEAD)$/iu.exec(value);
    if (direct) {
      if ((direct[2] !== 'HEAD' && !validAdvertisedRef(direct[2])) || refs.has(direct[2])) {
        invalid = true;
      }
      else refs.set(direct[2], direct[1]);
      continue;
    }
    invalid = true;
  }
  return { refs, symbolicRefs, invalid };
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

function strictRemoteText(value) {
  if (typeof value === 'string') return value;
  if (!Buffer.isBuffer(value)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(value); }
  catch { return null; }
}

function remoteObservation(url, patterns, result) {
  const succeeded = processResultSucceeded(result);
  const stdout = succeeded ? strictRemoteText(result.stdout) : null;
  // Failed/poisoned process output is diagnostic input, never an authority advertisement.
  const advertisement = succeeded && stdout != null
    ? parseRemoteAdvertisement(stdout)
    : { refs: new Map(), symbolicRefs: new Map(), invalid: false };
  const refsByName = advertisement.refs;
  const symbolicRefs = advertisement.symbolicRefs;
  const unsupportedSymbolicAuthority = [...symbolicRefs.keys()]
    .find((ref) => ref !== 'HEAD') ?? null;
  const symbolicFailure = unsupportedSymbolicAuthority ? Object.freeze({
    code: 'REMOTE_SYMBOLIC_REF_UNSUPPORTED',
    classification: 'authority-invalid',
    retryable: false,
    advice: 'The requested Git authority is a symbolic ref. Replace it with a direct branch ref before retrying.',
    evidence: result.failure?.evidence ?? failureEvidence(result)
  }) : null;
  const protocolFailure = succeeded && (stdout == null || advertisement.invalid) ? Object.freeze({
    code: 'REMOTE_PROTOCOL_INVALID',
    classification: 'authority-invalid',
    retryable: false,
    advice: 'Git returned a duplicate or malformed remote-reference advertisement. Inspect the approved Git executable and provider before retrying.',
    evidence: result.failure?.evidence ?? failureEvidence(result)
  }) : null;
  return Object.freeze({
    ok: succeeded && !symbolicFailure && !protocolFailure,
    remote: sanitizeRemote(url),
    defaultBranch: succeeded && !symbolicFailure && !protocolFailure
      ? symrefBranch(stdout) : null,
    refs: refsByName,
    branches: [...refsByName.keys()].filter((ref) => ref.startsWith('refs/heads/'))
      .map((ref) => ref.slice('refs/heads/'.length)).sort(),
    includedHead: patterns.includes('HEAD'),
    patterns: Object.freeze([...patterns]),
    failure: symbolicFailure ?? protocolFailure ?? result.failure,
    timedOut: result.timedOut === true,
    result
  });
}

function interruptedObservation(url, patterns, reason) {
  // A shared Git process belongs to the session, not to any one caller. A waiter that reaches its
  // own boundary receives an independent, content-free observation while other waiters may still
  // use the physical result. Never include AbortSignal.reason in this result.
  const result = {
    status: 1, stdout: '', stderr: '', timedOut: reason === 'timeout',
    aborted: reason === 'abort'
  };
  result.failure = reason === 'abort'
    ? {
        code: 'REMOTE_OPERATION_ABORTED', classification: 'cancelled', retryable: true,
        advice: 'The Git operation was cancelled before it completed. Retry when ready.',
        evidence: failureEvidence(result)
      }
    : { ...classifyGitRemoteFailure(result), evidence: failureEvidence(result) };
  return remoteObservation(url, patterns, result);
}

/**
 * A per-operation observation cache. Mutations construct a fresh session and explicitly invalidate
 * it after a successful push; no remote fact is cached across CLI invocations or authority changes.
 */
export class GitRemoteSession {
  constructor({
    cwd = process.cwd(), env = process.env, runCommand = run,
    runAsyncCommand = runRemoteGitAsync
  } = {}) {
    this.cwd = cwd;
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
      if (observation.timedOut || observation.result?.aborted) continue;
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

  waitForPendingObservation(pending, { url, patterns, signal, deadlineAt }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const waiter = { deadlineAt };
      const finish = (observation, error, ownBoundary = false) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        pending.waiters.delete(waiter);
        if (pending.waiters.size === 0 && !pending.settled) {
          // No caller may use or cache this result now. Reap the physical Git process, but do not
          // make a cancelled caller wait for another caller's deadline or cleanup grace.
          pending.invalidated = true;
          if (this.observationGenerations.get(pending.key) === pending.generation) {
            this.nextObservationGeneration(pending.key);
          }
          if (this.pendingObservations.get(pending.key) === pending) {
            this.pendingObservations.delete(pending.key);
          }
          pending.controller.abort();
        }
        if (error) reject(error);
        else resolve({ observation, ownBoundary });
      };
      const onAbort = () => finish(interruptedObservation(url, patterns, 'abort'), null, true);
      pending.waiters.add(waiter);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      const remainingMs = deadlineAt - performance.now();
      if (remainingMs <= 0) {
        finish(interruptedObservation(url, patterns, 'timeout'), null, true);
        return;
      }
      timer = setTimeout(
        () => finish(interruptedObservation(url, patterns, 'timeout'), null, true),
        Math.ceil(remainingMs)
      );
      signal?.addEventListener('abort', onAbort, { once: true });
      pending.promise.then((observation) => {
        // Promise callbacks run before timers after an event-loop stall. Do not admit a late
        // authority result merely because its overdue timeout callback has not run yet.
        if (performance.now() >= deadlineAt) {
          finish(interruptedObservation(url, patterns, 'timeout'), null, true);
        } else finish(observation);
      }, (error) => finish(null, error));
    });
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
    timeoutMs = null
  } = {}) {
    const url = assertCredentialFreeRemote(remote);
    const effectiveTimeoutMs = timeoutMs ?? gitRemoteProbeTimeout(url, this.env);
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
      cwd: this.cwd, operation: 'remote-probe', timeoutMs: effectiveTimeoutMs, env: transport.env,
      runCommand: this.runCommand, allowFailure: true, encoding: 'buffer'
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
    timeoutMs = null, signal = null
  } = {}) {
    const url = assertCredentialFreeRemote(remote);
    const effectiveTimeoutMs = positive(timeoutMs, gitRemoteProbeTimeout(url, this.env));
    const deadlineAt = performance.now() + effectiveTimeoutMs;
    const patterns = observationPatterns({ refs, includeHead, includeAllHeads });
    const key = JSON.stringify([url, patterns]);
    if (signal?.aborted) return interruptedObservation(url, patterns, 'abort');
    if (refresh) this.invalidate(url);
    else {
      const reusable = this.reusableObservation(url, patterns);
      if (reusable) return reusable;
      const pending = this.reusablePendingObservation(url, patterns);
      // The shared process has its own bounded reserve; a late or longer-lived waiter must not
      // inherit an earlier caller's physical deadline. Start a separate probe in that case.
      if (pending && pending.physicalDeadlineAt >= deadlineAt) {
        const { observation, ownBoundary } = await this.waitForPendingObservation(pending, {
          url, patterns, signal, deadlineAt
        });
        if (ownBoundary) return observation;
        const exact = JSON.stringify(pending.patterns) === JSON.stringify(patterns);
        if (exact || observation.ok) return observation;
        // The broad request failed. Retry the narrower shape instead of turning a provider's
        // all-heads limitation into a false absence for an exact authority ref.
      }
    }
    if (signal?.aborted) return interruptedObservation(url, patterns, 'abort');
    const remainingMs = deadlineAt - performance.now();
    if (remainingMs <= 0) return interruptedObservation(url, patterns, 'timeout');
    const generation = this.nextObservationGeneration(key);
    const physicalTimeoutMs = Math.min(2_147_483_647, Math.ceil(remainingMs * 2));
    const pendingState = {
      key, remoteIdentity: url, patterns, promise: null, invalidated: false, generation,
      controller: new AbortController(), waiters: new Set(), settled: false,
      physicalDeadlineAt: performance.now() + physicalTimeoutMs
    };
    // Register the first waiter's timer and signal before entering synchronous enterprise-config
    // preflight. That preflight still blocks the event loop, but once it returns we can refuse to
    // start Git if every waiting caller's deadline expired while it ran.
    const pending = Promise.resolve().then(async () => {
      if (pendingState.controller.signal.aborted) {
        return interruptedObservation(url, patterns, 'abort');
      }
      const transport = frozenRemoteTransport(url, { env: this.env });
      // Enterprise Git configuration is a synchronous preflight today. Count its elapsed time
      // against the observation budget; never launch a remote process after it exhausted that
      // budget, even though an event-loop timer cannot interrupt the preflight itself.
      const now = performance.now();
      const physicalRemainingMs = pendingState.physicalDeadlineAt - now;
      if (physicalRemainingMs <= 0
        || ![...pendingState.waiters].some((waiter) => waiter.deadlineAt > now)
        || pendingState.controller.signal.aborted) {
        return interruptedObservation(url, patterns,
          pendingState.controller.signal.aborted ? 'abort' : 'timeout');
      }
      const result = await this.runAsyncCommand(
        ['ls-remote', '--symref', '--', transport.remote, ...patterns],
        {
          cwd: this.cwd, operation: 'remote-probe', timeoutMs: Math.ceil(physicalRemainingMs),
          env: transport.env,
          allowFailure: true, signal: pendingState.controller.signal, encoding: 'buffer'
        }
      );
      const observation = remoteObservation(url, patterns, result);
      // A successful mutation can invalidate this remote while an older observation is still in
      // flight. The awaiting caller may use the result it explicitly requested, but that stale
      // result must never repopulate the operation cache after the mutation boundary.
      if (!pendingState.invalidated
        && [...pendingState.waiters].some((waiter) => waiter.deadlineAt > performance.now())
        && !observation.timedOut && !observation.result?.aborted
        && this.observationGenerations.get(key) === pendingState.generation) {
        this.observations.set(key, observation);
      }
      return observation;
    });
    pendingState.promise = pending;
    this.pendingObservations.set(key, pendingState);
    pending.then(() => {
      pendingState.settled = true;
      if (this.pendingObservations.get(key) === pendingState) this.pendingObservations.delete(key);
    }, () => {
      pendingState.settled = true;
      if (this.pendingObservations.get(key) === pendingState) this.pendingObservations.delete(key);
    });
    const { observation } = await this.waitForPendingObservation(pendingState, {
      url, patterns, signal, deadlineAt
    });
    return observation;
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
