import { spawn } from 'node:child_process';

const DEFAULT_CAPTURE_BYTES = 128 * 1024;

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
      const output = truncated
        ? `${first.toString('utf8')}\n… ${bytes - first.length - last.length} output bytes omitted …\n${last.toString('utf8')}`
        : first.toString('utf8') + last.subarray(Math.max(0, first.length + last.length - bytes)).toString('utf8');
      return { output, bytes, truncated };
    }
  };
}

/**
 * Stream a quality command instead of using spawnSync's fixed output buffer. Only a bounded
 * diagnostic prefix/tail is retained in memory; output volume can never turn a passing check into
 * ENOBUFS.
 */
export function runQualityCommand(command, args = [], {
  cwd = process.cwd(),
  env = process.env,
  shell = false,
  timeoutMs,
  captureBytes = DEFAULT_CAPTURE_BYTES
} = {}) {
  return new Promise((resolve) => {
    const stdout = boundedCapture(captureBytes);
    const stderr = boundedCapture(captureBytes);
    let timedOut = false;
    let error = null;
    let settled = false;
    let hardKillTimer = null;
    let child;
    try {
      child = spawn(command, args, { cwd, env, shell, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (caught) {
      resolve({ status: 1, signal: null, error: caught, timedOut: false, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false });
      return;
    }
    child.stdout?.on('data', (chunk) => stdout.add(chunk));
    child.stderr?.on('data', (chunk) => stderr.add(chunk));
    child.on('error', (caught) => { error = caught; });
    const timer = timeoutMs == null ? null : setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      hardKillTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      hardKillTimer.unref?.();
    }, timeoutMs);
    timer?.unref?.();
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      const out = stdout.result();
      const err = stderr.result();
      resolve({
        status: code ?? 1,
        signal,
        error,
        timedOut,
        stdout: out.output,
        stderr: err.output,
        stdoutBytes: out.bytes,
        stderrBytes: err.bytes,
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated
      });
    });
  });
}
