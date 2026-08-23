import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

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
export function runQualityCommand(command, args = [], {
  cwd = process.cwd(),
  env = process.env,
  shell = false,
  timeoutMs,
  captureBytes = DEFAULT_CAPTURE_BYTES,
  stdoutFile = null,
  input = null,
  signal = null,
  killTree = true
} = {}) {
  return new Promise((resolve) => {
    const stdout = boundedCapture(captureBytes);
    const stderr = boundedCapture(captureBytes);
    let timedOut = false;
    let aborted = signal?.aborted === true;
    let error = null;
    let settled = false;
    let hardKillTimer = null;
    let stdoutStream = null;
    let streamError = null;
    let child;
    const terminate = (terminationSignal) => {
      if (!child?.pid) return;
      if (killTree && process.platform === 'win32') {
        const force = terminationSignal === 'SIGKILL' ? ['/F'] : [];
        const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', ...force], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 5_000
        });
        if (!killed.error && killed.status === 0) return;
      }
      if (killTree && process.platform !== 'win32') {
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
      child = spawn(command, args, {
        cwd, env, shell,
        detached: killTree && process.platform !== 'win32',
        stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe']
      });
    } catch (caught) {
      resolve({ status: 1, signal: null, error: caught, timedOut: false, aborted: false, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false });
      return;
    }
    child.stdout?.on('data', (chunk) => {
      stdout.add(chunk);
      stdoutStream?.write(chunk);
    });
    child.stderr?.on('data', (chunk) => stderr.add(chunk));
    if (input != null) child.stdin?.end(Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8'));
    child.on('error', (caught) => { error = caught; });
    const timer = timeoutMs == null ? null : setTimeout(() => {
      timedOut = true;
      terminate('SIGTERM');
      hardKillTimer = setTimeout(() => terminate('SIGKILL'), 2_000);
      hardKillTimer.unref?.();
    }, timeoutMs);
    timer?.unref?.();
    const onAbort = () => {
      aborted = true;
      terminate('SIGTERM');
      hardKillTimer = setTimeout(() => terminate('SIGKILL'), 2_000);
      hardKillTimer.unref?.();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('close', (code, terminationSignal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      signal?.removeEventListener?.('abort', onAbort);
      const finish = async () => {
        const out = stdout.result();
        const err = stderr.result();
        if (streamError && stdoutFile) await unlink(stdoutFile).catch(() => {});
        resolve({
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
        });
      };
      if (stdoutStream && !stdoutStream.destroyed) stdoutStream.end(() => { void finish(); });
      else void finish();
    });
  });
}
