import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import { incrementCommandCounter } from './dx-timing-context.mjs';
import { signalProcessTree } from './util.mjs';

const MAXIMUM_BATCH_OBJECTS = 512;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

class LocalBlobReadError extends Error {
  constructor(code, result = null) {
    super(code);
    this.code = code;
    this.result = result;
  }
}

function refuse(code, result = null) { throw new LocalBlobReadError(code, result); }

/** A byte-preserving local subprocess boundary, with one deadline shared by every batch stage. */
async function runLocalGitBytes(executable, args, {
  cwd, env, input = null, maxBuffer, signal, deadlineAt
}) {
  if (signal?.aborted) return { status: 1, stdout: Buffer.alloc(0), aborted: true };
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return { status: 1, stdout: Buffer.alloc(0), timedOut: true };
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, args, {
        cwd, env, detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
      });
    } catch (error) {
      resolve({ status: 1, stdout: Buffer.alloc(0), error });
      return;
    }
    const chunks = [];
    const diagnostics = [];
    let bytes = 0;
    let settled = false;
    let boundary = null;
    let spawnError = null;
    let deadlineTimer;
    let settleTimer;
    const cleanupAttempts = new Set();

    const cleanup = () => {
      clearTimeout(deadlineTimer);
      clearTimeout(settleTimer);
      signal?.removeEventListener('abort', onAbort);
      child.removeListener('close', onClose);
      child.removeListener('error', onError);
      child.stdin?.removeListener('error', onInputError);
      child.stdout?.removeListener('data', onStdout);
      child.stderr?.removeListener('data', onStderr);
    };
    const finish = (code, terminationSignal = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (boundary) {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      resolve({
        status: boundary ? 1 : (code ?? 1),
        stdout: Buffer.concat(chunks), stderr: Buffer.concat(diagnostics).toString('utf8'),
        signal: terminationSignal, error: spawnError,
        aborted: boundary === 'abort', timedOut: boundary === 'timeout',
        outputOverflow: boundary === 'overflow'
      });
    };
    const signalTree = (treeSignal) => {
      let attempt;
      try {
        // Invoke before `close` can release the child's PID. A local read has no state to flush.
        attempt = Promise.resolve(signalProcessTree(child, treeSignal, {
          timeoutMs: 500
        })).catch(() => false);
      } catch { attempt = Promise.resolve(false); }
      cleanupAttempts.add(attempt);
      attempt.finally(() => cleanupAttempts.delete(attempt));
      return attempt;
    };
    const terminate = (reason) => {
      if (settled || boundary) return;
      boundary = reason;
      clearTimeout(deadlineTimer);
      signalTree('SIGKILL');
      settleTimer = setTimeout(() => finish(1, 'SIGKILL'), 1_000);
    };
    const capture = (target, chunk) => {
      if (settled || boundary) return;
      bytes += chunk.length;
      if (bytes > maxBuffer) {
        terminate('overflow');
        return;
      }
      target.push(Buffer.from(chunk));
    };
    const onStdout = (chunk) => capture(chunks, chunk);
    const onStderr = (chunk) => capture(diagnostics, chunk);
    const onInputError = (error) => {
      if (error?.code !== 'EPIPE') spawnError = error;
    };
    const onError = (error) => {
      spawnError = error;
      if (!child.pid) finish(1);
      else terminate('error');
    };
    const onClose = (code, terminationSignal) => {
      if (boundary) {
        Promise.allSettled([...cleanupAttempts]).then(() => finish(code, terminationSignal));
      } else finish(code, terminationSignal);
    };
    const onAbort = () => terminate('abort');
    child.stdin?.on('error', onInputError);
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.on('error', onError);
    // Count a physical child only after Node confirms it spawned. A synchronous spawn refusal
    // and an ENOENT/error event are attempts, not successfully launched Git processes.
    child.once('spawn', () => incrementCommandCounter('git.spawns'));
    child.on('close', onClose);
    deadlineTimer = setTimeout(() => terminate('timeout'), remaining);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    if (input == null) child.stdin?.end();
    else child.stdin?.end(input);
  });
}

function commandFailure(result) {
  if (result?.aborted) refuse('GAL_CANCELLED', result);
  if (result?.timedOut) refuse('GAL_TIMEOUT', result);
  if (result?.outputOverflow) refuse('GAL_OUTPUT_LIMIT', result);
  if (result?.error) refuse('GAL_EXECUTABLE_UNAVAILABLE', result);
  if (result?.status !== 0) refuse('GIT_BLOB_BATCH_INVALID', result);
}

function lines(bytes, count) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes[bytes.length - 1] !== 0x0a) {
    refuse('GIT_BLOB_BATCH_INVALID');
  }
  const rows = bytes.toString('utf8').slice(0, -1).split('\n');
  if (rows.length !== count || rows.some((row) => row.includes('\r') || row.includes('\0'))) {
    refuse('GIT_BLOB_BATCH_INVALID');
  }
  return rows;
}

/**
 * Read exact local Git blobs without occupying the event loop during Git I/O. Every child uses
 * the caller's pinned executable and sanitized environment; no Git override or lazy fetch is used.
 */
export async function readLocalGitBlobsAsync(root, objectIds, {
  executable, env, signal = null, deadlineMs = 30_000,
  maximumBytes = 64 * 1024 * 1024,
  maximumObjectBytes = 32 * 1024 * 1024,
  maximumBatchBytes = 32 * 1024 * 1024,
  runCommand = runLocalGitBytes
} = {}) {
  const unique = [...new Set(objectIds)];
  incrementCommandCounter('git.requests');
  incrementCommandCounter('git.batch-requests');
  incrementCommandCounter('git.objects-requested', objectIds.length);
  incrementCommandCounter('git.objects-unique', unique.length);
  if (!unique.length) return new Map();
  if (unique.some((oid) => typeof oid !== 'string' || !OBJECT_ID.test(oid))) {
    refuse('GIT_BLOB_BATCH_INVALID');
  }
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0
      || !Number.isSafeInteger(maximumBytes) || maximumBytes < 0
      || !Number.isSafeInteger(maximumObjectBytes) || maximumObjectBytes < 0
      || !Number.isSafeInteger(maximumBatchBytes) || maximumBatchBytes <= 0) {
    refuse('GIT_BLOB_BATCH_INVALID');
  }
  const deadlineAt = Date.now() + deadlineMs;
  const localEnv = { ...env, GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' };
  const execute = async (args, input, maxBuffer) => {
    const result = await runCommand(executable, args, {
      cwd: root, env: localEnv, input, maxBuffer, signal, deadlineAt
    });
    commandFailure(result);
    return result;
  };
  const format = await execute(['rev-parse', '--show-object-format'], null, 1024);
  const objectFormat = format.stdout.toString('utf8');
  if (!['sha1\n', 'sha256\n'].includes(objectFormat)) refuse('GIT_BLOB_BATCH_INVALID', format);
  const hashName = objectFormat.slice(0, -1);
  const oidLength = hashName === 'sha1' ? 40 : 64;
  if (unique.some((oid) => oid.length !== oidLength)) refuse('GIT_BLOB_BATCH_INVALID');

  const check = await execute(
    ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    Buffer.from(`${unique.join('\n')}\n`), Math.max(1024, unique.length * 160)
  );
  let totalBytes = 0;
  const sized = lines(check.stdout, unique.length).map((row, index) => {
    const oid = unique[index];
    if (row === `${oid} missing`) refuse('GAL_OBJECT_MISSING', check);
    const match = row.match(/^([a-f0-9]{40}|[a-f0-9]{64}) ([a-z]+) ([0-9]+)$/u);
    if (!match || match[1] !== oid) refuse('GIT_BLOB_BATCH_INVALID', check);
    if (match[2] !== 'blob') refuse('GAL_WRONG_OBJECT_TYPE', check);
    const size = Number(match[3]);
    if (!Number.isSafeInteger(size) || size < 0) refuse('GIT_BLOB_BATCH_INVALID', check);
    if (size > maximumObjectBytes || size > maximumBatchBytes) {
      refuse('GAL_LIMIT_EXCEEDED', check);
    }
    totalBytes += size;
    if (totalBytes > maximumBytes) refuse('GAL_LIMIT_EXCEEDED', check);
    return { oid, size };
  });
  const groups = [];
  let group = [];
  let groupBytes = 0;
  for (const entry of sized) {
    if (group.length && (group.length >= MAXIMUM_BATCH_OBJECTS
        || groupBytes + entry.size > maximumBatchBytes)) {
      groups.push(group);
      group = [];
      groupBytes = 0;
    }
    group.push(entry);
    groupBytes += entry.size;
  }
  if (group.length) groups.push(group);

  const output = new Map();
  for (const entries of groups) {
    const expectedBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    const batch = await execute(['cat-file', '--batch'],
      Buffer.from(`${entries.map((entry) => entry.oid).join('\n')}\n`),
      expectedBytes + entries.length * 160 + 1024);
    const bytes = batch.stdout;
    let cursor = 0;
    for (const entry of entries) {
      const newline = bytes.indexOf(0x0a, cursor);
      if (newline < 0 || newline - cursor > 160) refuse('GIT_BLOB_BATCH_INVALID', batch);
      const header = bytes.toString('utf8', cursor, newline);
      const match = header.match(/^([a-f0-9]{40}|[a-f0-9]{64}) blob ([0-9]+)$/u);
      if (!match || match[1] !== entry.oid || Number(match[2]) !== entry.size) {
        refuse('GIT_BLOB_BATCH_INVALID', batch);
      }
      const start = newline + 1;
      const end = start + entry.size;
      if (!Number.isSafeInteger(end) || end >= bytes.length || bytes[end] !== 0x0a) {
        refuse('GIT_BLOB_BATCH_INVALID', batch);
      }
      const body = bytes.subarray(start, end);
      const observed = createHash(hashName).update(`blob ${entry.size}\0`, 'utf8')
        .update(body).digest('hex');
      if (observed !== entry.oid) refuse('GIT_BLOB_BATCH_INVALID', batch);
      output.set(entry.oid, Buffer.from(body));
      cursor = end + 1;
    }
    if (cursor !== bytes.length) refuse('GIT_BLOB_BATCH_INVALID', batch);
  }
  if (signal?.aborted) refuse('GAL_CANCELLED');
  if (Date.now() > deadlineAt) refuse('GAL_TIMEOUT');
  return output;
}
