import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { createHash } from 'node:crypto';
import { resolvePlatformProcess, tryWindowsTaskkill } from './platform-process.mjs';

const DEFAULT_CAPTURE_BYTES = 128 * 1024;
export const MAX_DEFAULT_SUBPROCESS_CONCURRENCY = 4;
const unavailableLaunches = new WeakMap();
const completedLaunches = new WeakMap();

/** A report may describe execution only when its bytes came from this native invocation. */
export function verifyCompletedQualityLaunch(result, { command, args, cwd, environmentSha256, stdoutFile, reportCapture = null }) {
  const observed = completedLaunches.get(result);
  return observed && observed.command === command && observed.cwd === cwd
    && JSON.stringify(observed.args) === JSON.stringify(args)
    && typeof environmentSha256 === 'string' && environmentSha256 === observed.environmentSha256
    && stdoutFile === observed.stdoutFile && JSON.stringify(reportCapture) === JSON.stringify(observed.reportCapture)
    && !result.error && !result.signal
    && result.status === observed.status && result.timedOut === false && result.aborted === false
    ? Object.freeze({ startedAt: observed.startedAt, completedAt: observed.completedAt,
      status: observed.status, stdoutSha256: observed.stdoutSha256, stdoutBytes: observed.stdoutBytes,
      reports: observed.reports ? structuredClone(observed.reports) : null }) : null;
}

/** Opaque, native-spawn provenance. Injected test transports cannot mint execution evidence. */
export function verifyUnavailableQualityLaunch(result, { command, args, cwd, environmentSha256 }) {
  const observed = unavailableLaunches.get(result);
  return observed && observed.command === command && observed.cwd === cwd
    && JSON.stringify(observed.args) === JSON.stringify(args)
    && typeof environmentSha256 === 'string' && environmentSha256 === observed.environmentSha256
    && result.error?.code === 'ENOENT' && result.status === observed.status
    && result.timedOut === false && result.aborted === false
    ? Object.freeze({ startedAt: observed.startedAt, completedAt: observed.completedAt }) : null;
}

function boundedCapture(maxBytes) {
  const firstLimit = Math.ceil(maxBytes / 2);
  const lastLimit = Math.floor(maxBytes / 2);
  let first = Buffer.alloc(0);
  let last = Buffer.alloc(0);
  let bytes = 0;
  return {
    add(value) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.length;
      if (first.length < firstLimit) {
        const take = Math.min(firstLimit - first.length, chunk.length);
        first = Buffer.concat([first, chunk.subarray(0, take)]);
      }
      if (lastLimit) last = Buffer.concat([last, chunk.subarray(-lastLimit)]).subarray(-lastLimit);
    },
    result() {
      const truncated = bytes > maxBytes;
      const decodePrefix = (buffer) => {
        const decoder = new StringDecoder('utf8');
        return decoder.write(buffer);
      };
      const decodeTail = (buffer) => {
        let offset = 0;
        while (offset < Math.min(3, buffer.length) && (buffer[offset] & 0xc0) === 0x80) offset += 1;
        return buffer.subarray(offset).toString('utf8');
      };
      const output = truncated
        ? `${decodePrefix(first)}\n… ${bytes - first.length - last.length} output bytes omitted …\n${decodeTail(last)}`
        : Buffer.concat([
          first,
          last.subarray(Math.max(0, first.length + last.length - bytes))
        ]).toString('utf8');
      return { output, bytes, truncated };
    }
  };
}

/**
 * Stream a quality command instead of using spawnSync's fixed output buffer. Only a bounded
 * diagnostic prefix/tail is retained in memory; output volume can never turn a passing check into
 * ENOBUFS.
 */
export async function runQualityCommand(command, args = [], {
  cwd = process.cwd(),
  env = process.env,
  shell = false,
  timeoutMs,
  captureBytes = DEFAULT_CAPTURE_BYTES,
  stdoutFile = null,
  reportCapture = null,
  input = null,
  signal = null,
  killTree = true,
  platform = process.platform,
  spawnCommand = spawn,
  platformLookupCommand = spawnSync,
  platformLstatCommand = undefined,
  platformRealpathCommand = undefined
} = {}) {
  if (reportCapture) {
    try {
      const { assertTestReportTargetEmpty } = await import('./code-delivery-tests.mjs');
      await assertTestReportTargetEmpty(reportCapture.root, reportCapture.command);
    } catch (error) {
      return { status: 1, signal: null, error, timedOut: false, aborted: false, stdout: '', stderr: '', stdoutBytes: 0,
        stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false };
    }
  }
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const executionEnvironment = { ...env };
    const executionArgs = [...args];
    const environmentSha256 = createHash('sha256').update(JSON.stringify(Object.entries(executionEnvironment).sort())).digest('hex');
    const stdout = boundedCapture(captureBytes);
    const stdoutDigest = createHash('sha256');
    const stderr = boundedCapture(captureBytes);
    let timedOut = false;
    let aborted = signal?.aborted === true;
    let error = null;
    let settled = false;
    let hardKillTimer = null;
    let timer = null;
    let timeoutDecisionTimer = null;
    let stdoutStream = null;
    let streamError = null;
    let child;
    const terminate = (terminationSignal) => {
      if (!child?.pid) return;
      if (killTree && platform === 'win32') {
        if (tryWindowsTaskkill(child.pid, {
          force: terminationSignal === 'SIGKILL', environment: env,
          spawnSyncCommand: spawnSync, timeoutMs: 5_000
        })) return;
      }
      if (killTree && platform !== 'win32') {
        try { process.kill(-child.pid, terminationSignal); return; } catch { /* child may already be gone */ }
      }
      child.kill(terminationSignal);
    };
    if (aborted) {
      resolve({ status: 1, signal: null, error: null, timedOut: false, aborted: true, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false });
      return;
    }
    try {
      stdoutStream = stdoutFile ? createWriteStream(stdoutFile, { flags: 'w' }) : null;
      stdoutStream?.on('error', (caught) => {
        streamError = caught;
        error ??= caught;
        terminate('SIGTERM');
      });
      // Legacy string commands deliberately retain their explicit shell contract. Argv-form
      // commands stay shell-free; only the known Windows npm/npx batch shims receive the narrow,
      // escaped ComSpec launch adapter.
      const launch = shell
        ? { executable: command, arguments: executionArgs, spawnOptions: { shell: true } }
        : resolvePlatformProcess(command, executionArgs, {
          platform, environment: executionEnvironment, spawnSyncCommand: platformLookupCommand, cwd,
          lstatSyncCommand: platformLstatCommand,
          realpathSyncCommand: platformRealpathCommand
        });
      child = spawnCommand(launch.executable, launch.arguments, {
        cwd, env: executionEnvironment, ...launch.spawnOptions,
        detached: killTree && platform !== 'win32',
        stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe']
      });
    } catch (caught) {
      resolve({ status: 1, signal: null, error: caught, timedOut: false, aborted: false, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false });
      return;
    }
    child.stdout?.on('data', (chunk) => {
      stdout.add(chunk);
      stdoutDigest.update(chunk);
      stdoutStream?.write(chunk);
    });
    child.stderr?.on('data', (chunk) => stderr.add(chunk));
    if (input != null) child.stdin?.end(Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8'));
    child.on('error', (caught) => { error = caught; });
    timer = timeoutMs == null ? null : setTimeout(() => {
      timer = null;
      // Timers are checked before child-process close callbacks. If the host event loop was
      // suspended or starved past the deadline, an already-finished child can therefore look
      // timed out for one turn. Give the pending exit notification one complete event-loop turn
      // before classifying and terminating the process. A genuinely running command still gets
      // the same bounded deadline plus only this scheduling grace turn.
      timeoutDecisionTimer = setTimeout(() => {
        timeoutDecisionTimer = null;
        if (settled) return;
        timedOut = true;
        terminate('SIGTERM');
        hardKillTimer = setTimeout(() => terminate('SIGKILL'), 2_000);
      }, 0);
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (timeoutDecisionTimer) clearTimeout(timeoutDecisionTimer);
      timeoutDecisionTimer = null;
      terminate('SIGTERM');
      hardKillTimer = setTimeout(() => terminate('SIGKILL'), 2_000);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('close', (code, terminationSignal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (timeoutDecisionTimer) clearTimeout(timeoutDecisionTimer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      signal?.removeEventListener?.('abort', onAbort);
      const finish = async () => {
        const out = stdout.result();
        const err = stderr.result();
        if (streamError && stdoutFile) await unlink(stdoutFile).catch(() => {});
        const result = {
          status: code ?? 1,
          signal: terminationSignal,
          error,
          timedOut,
          aborted,
          stdout: out.output,
          stderr: err.output,
          stdoutBytes: out.bytes,
          stderrBytes: err.bytes,
          stdoutTruncated: out.truncated,
          stderrTruncated: err.truncated
        };
        const native = spawnCommand === spawn && platformLookupCommand === spawnSync
          && platformLstatCommand === undefined && platformRealpathCommand === undefined
          && platform === process.platform && !shell && !timedOut && !aborted && !streamError;
        if (native && !child.pid && error?.code === 'ENOENT') {
          unavailableLaunches.set(result, { command, args: executionArgs, cwd, status: result.status,
            startedAt, completedAt: new Date().toISOString(),
            environmentSha256 });
        }
        if (native && child.pid && !error && !terminationSignal && Number.isInteger(code)) {
          let reports = null;
          if (reportCapture) {
            try {
              const { parseTestResult } = await import('./code-delivery-tests.mjs');
              const parsed = await parseTestResult(reportCapture.root, reportCapture.command, { startedAt });
              reports = parsed.rawReports.map(({ sourcePath, sha256, bytes }) => ({ sourcePath, sha256, bytes }));
            } catch { /* A native completion with absent/invalid reports grants no report provenance. */ }
          }
          completedLaunches.set(result, { command, args: executionArgs, cwd, status: code,
            startedAt, completedAt: new Date().toISOString(), environmentSha256, stdoutFile,
            stdoutSha256: `sha256:${stdoutDigest.digest('hex')}`, stdoutBytes: out.bytes,
            reportCapture: structuredClone(reportCapture), reports });
        }
        resolve(result);
      };
      if (stdoutStream && !stdoutStream.destroyed) stdoutStream.end(() => { void finish(); });
      else void finish();
    });
  });
}

/**
 * Compute bounded subprocess/task concurrency (`Math.min(4, os.availableParallelism())` by default).
 */
export function defaultSubprocessConcurrency(requested = null) {
  if (Number.isInteger(requested) && requested >= 1) {
    return Math.min(16, requested);
  }
  const available = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : (os.cpus()?.length || 2);
  return Math.max(1, Math.min(MAX_DEFAULT_SUBPROCESS_CONCURRENCY, available));
}

/**
 * Execute an array of items through a concurrency-bounded async worker pool with deterministic
 * result ordering and optional fail-fast cancellation.
 */
export async function runBoundedTaskPool(items, worker, {
  maxConcurrency = defaultSubprocessConcurrency(),
  failFast = false,
  shouldAbort = null,
  onAbortedItem = null,
  signal = null
} = {}) {
  const list = Array.from(items ?? []);
  const limit = defaultSubprocessConcurrency(maxConcurrency);
  if (!list.length) {
    return {
      results: [],
      maxConcurrency: limit,
      peakConcurrency: 0,
      completedCount: 0,
      abortedCount: 0,
      aborted: Boolean(signal?.aborted)
    };
  }

  const controller = new AbortController();
  const onParentAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onParentAbort, { once: true });
  }

  const results = new Array(list.length);
  let nextIndex = 0;
  let active = 0;
  let peakConcurrency = 0;
  let completedCount = 0;
  let abortedCount = 0;
  let firstError = null;

  const runWorker = async () => {
    while (nextIndex < list.length) {
      if (controller.signal.aborted) {
        if (!firstError) {
          const skippedIndex = nextIndex;
          nextIndex += 1;
          abortedCount += 1;
          if (typeof onAbortedItem === 'function') {
            results[skippedIndex] = onAbortedItem(list[skippedIndex], skippedIndex);
          }
          continue;
        }
        break;
      }
      const index = nextIndex;
      nextIndex += 1;
      active += 1;
      if (active > peakConcurrency) peakConcurrency = active;
      try {
        const value = await worker(list[index], { index, signal: controller.signal });
        results[index] = value;
        completedCount += 1;
        if (failFast && typeof shouldAbort === 'function' && shouldAbort(value, list[index], index)) {
          controller.abort();
        }
      } catch (error) {
        firstError ??= error;
        controller.abort(error);
      } finally {
        active -= 1;
      }
    }
  };

  try {
    const workerCount = Math.min(limit, list.length);
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  } finally {
    signal?.removeEventListener?.('abort', onParentAbort);
  }

  if (firstError) throw firstError;

  return {
    results,
    maxConcurrency: limit,
    peakConcurrency,
    completedCount,
    abortedCount,
    aborted: controller.signal.aborted
  };
}

/**
 * Run multiple quality/test commands through a concurrency-bounded subprocess pool with
 * deterministic output ordering and optional fail-fast cancellation of in-flight child trees.
 */
export async function runQualityCommandPool(commands, {
  maxConcurrency = defaultSubprocessConcurrency(),
  failFast = false,
  signal = null,
  runner = runQualityCommand
} = {}) {
  const specs = Array.from(commands ?? []);
  const abortedResult = (spec, index) => ({
    id: spec.id ?? `command-${index}`,
    index,
    status: null,
    signal: null,
    error: null,
    timedOut: false,
    aborted: true,
    stdout: '',
    stderr: '',
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false
  });
  return runBoundedTaskPool(
    specs,
    async (spec, { index, signal: poolSignal }) => {
      if (poolSignal.aborted) {
        return abortedResult(spec, index);
      }
      const command = spec.command ?? spec.argv?.[0];
      const args = spec.args ?? (spec.argv ? spec.argv.slice(1) : []);
      const result = await runner(command, args, {
        ...(spec.options ?? {}),
        signal: poolSignal
      });
      const aborted = Boolean(result.aborted || (poolSignal.aborted && result.status !== 0));
      return {
        id: spec.id ?? `command-${index}`,
        index,
        ...result,
        aborted
      };
    },
    {
      maxConcurrency,
      failFast,
      signal,
      onAbortedItem: abortedResult,
      shouldAbort: (result, spec) => {
        if (result?.aborted) return false;
        const requirement = spec?.requirement ?? (spec?.optional === true ? 'advisory' : 'required');
        if (requirement === 'advisory' || requirement === 'optional') return false;
        return Boolean(result.error || result.timedOut || result.status !== 0);
      }
    }
  );
}

