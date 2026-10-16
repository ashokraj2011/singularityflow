import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import path from 'node:path';

import { localReadDeadlineRemainingMs } from './local-read-deadline.mjs';
import { SingularityFlowError, run } from './util.mjs';

const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DEFAULT_BATCH_BYTES = 24 * 1024 * 1024;
const MAXIMUM_BATCH_OBJECTS = 512;

function refusal(message, code, details) {
  throw new SingularityFlowError(message, { code, details });
}

/**
 * A checkout's object format, asked of Git once per checkout. `[perf]`
 *
 * Callers read blobs under different Git environments (a temporary index, no replacement refs),
 * so the general fact cache keyed each one separately and a mutating command asked three or four
 * times. sha1 or sha256 is fixed when a repository is created, so it is kept per checkout path and
 * the identity of its `.git` entry: a repository recreated at the same path is asked afresh. A
 * relocating environment or an injected runner always asks Git.
 */
const objectFormats = new Map();
const RELOCATING = ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE'];

/** sha1 or sha256 for `root`, or null when Git could not say; asked once per checkout. */
export function repositoryObjectFormat(root, { env = process.env, runCommand = run } = {}) {
  const key = objectFormatKey(root, env, runCommand);
  if (key && objectFormats.has(key)) return objectFormats.get(key);
  const formatResult = runCommand('git', ['rev-parse', '--show-object-format'], {
    cwd: root,
    env,
    allowFailure: true,
    timeoutClass: 'local-read',
    maxBuffer: 1024
  });
  const objectFormat = String(formatResult.stdout ?? '').trim();
  if (formatResult.status !== 0 || !['sha1', 'sha256'].includes(objectFormat)) return null;
  if (key) objectFormats.set(key, objectFormat);
  return objectFormat;
}

function objectFormatKey(root, env, runCommand) {
  if (runCommand !== run || RELOCATING.some((name) => env[name])) return null;
  try {
    const marker = lstatSync(path.join(root, '.git'), { bigint: true });
    if (marker.isSymbolicLink()) return null;
    const identity = marker.ino !== 0n ? String(marker.ino) : (marker.birthtimeNs > 0n ? `b${marker.birthtimeNs}` : null);
    return identity ? `${path.resolve(root)}\0${identity}:${marker.birthtimeNs}` : null;
  } catch { return null; }
}

/**
 * Blob bytes this process has already read and verified, by repository and object ID. `[perf]`
 *
 * A blob's bytes are fixed by its ID, yet one lifecycle command read the same blobs (the Story's
 * workflow.json, its configuration snapshot) up to ten times: about sixty repeated batch reads in
 * one Story. A request whose every blob was already read is answered from here within the same
 * limits; any other request reads as before, and what it read is remembered. Only reads by the real
 * runner in a repository Git locates by itself are kept, bounded in bytes, and never across
 * processes: an object another program prunes is still refused by the next command.
 */
const rememberedBlobs = new Map();
const REMEMBERED_BLOB_BYTES = 32 * 1024 * 1024;
let rememberedBlobBytes = 0;
/** A warm read retains code, never command-local object-presence observations. */
export function resetGitBlobReadCaches() {
  objectFormats.clear();
  rememberedBlobs.clear();
  rememberedBlobBytes = 0;
}
const OBJECT_RELOCATING = [...RELOCATING, 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'];

function blobMemoScope(root, env, runCommand) {
  return runCommand === run && !OBJECT_RELOCATING.some((name) => env[name]) ? path.resolve(root) : null;
}

function rememberedRead(scope, objectIds, { maximumBytes, maximumObjectBytes }) {
  const found = objectIds.map((oid) => rememberedBlobs.get(`${scope}\0${oid}`));
  if (!found.every(Boolean)) return null;
  let total = 0;
  for (const bytes of found) {
    total += bytes.length;
    // A limit the request would break is refused by the ordinary read, with its exact reason.
    if (bytes.length > maximumObjectBytes || total > maximumBytes) return null;
  }
  const output = new Map();
  objectIds.forEach((oid, index) => {
    const key = `${scope}\0${oid}`;
    rememberedBlobs.delete(key);
    rememberedBlobs.set(key, found[index]);
    output.set(oid, Buffer.from(found[index]));
  });
  return output;
}

function rememberBlobs(scope, blobs) {
  if (!scope) return blobs;
  for (const [oid, bytes] of blobs) {
    if (bytes.length > REMEMBERED_BLOB_BYTES / 8) continue;
    const key = `${scope}\0${oid}`;
    if (rememberedBlobs.has(key)) continue;
    rememberedBlobs.set(key, Buffer.from(bytes));
    rememberedBlobBytes += bytes.length;
  }
  for (const [key, bytes] of rememberedBlobs) {
    if (rememberedBlobBytes <= REMEMBERED_BLOB_BYTES) break;
    rememberedBlobs.delete(key);
    rememberedBlobBytes -= bytes.length;
  }
  return blobs;
}

function blobId(objectFormat, body) {
  return createHash(objectFormat).update(`blob ${body.length}\0`, 'utf8').update(body).digest('hex');
}

/** One `cat-file --batch` read of `objectIds`: its output bytes, or null when Git did not answer. */
function batchOutput(root, objectIds, { runCommand, env, maxBuffer }) {
  const batch = runCommand('git', ['cat-file', '--batch'], {
    cwd: root,
    env,
    input: `${objectIds.join('\n')}\n`,
    encoding: 'buffer',
    allowFailure: true,
    timeoutClass: 'local-read',
    maxBuffer
  });
  if (batch.status !== 0) return null;
  return Buffer.isBuffer(batch.stdout) ? batch.stdout : Buffer.from(batch.stdout ?? '');
}

/**
 * The blobs from one read without the sizing pass, or null when only that pass can answer exactly.
 *
 * The sizing pass exists so a large set splits below the buffer ceiling and an unavailable,
 * non-blob or oversized object is refused with its exact reason before its bytes are read. Most
 * reads are a few small records, where it is a second process repeating what the read's own
 * headers say: about forty processes in one intake step. This reads once with the buffer capped
 * at what the caller would accept anyway, and checks every header, ceiling and object hash as the
 * sized read does. Anything else (a missing, non-blob or oversized object, a full buffer, a failed
 * process) returns null and the sized read answers, so every refusal is unchanged. A scoped read
 * deadline turns a full buffer into a refusal of its own, so reads under one keep the sized read.
 */
function readWithoutSizing(root, objectIds, {
  runCommand, env, objectFormat, maximumBytes, maximumObjectBytes, maximumBatchBytes
}) {
  if (objectIds.length > MAXIMUM_BATCH_OBJECTS || localReadDeadlineRemainingMs() !== null) return null;
  const budget = Math.min(maximumBytes, maximumBatchBytes, objectIds.length * maximumObjectBytes);
  if (!Number.isSafeInteger(budget) || budget < 0) return null;
  const bytes = batchOutput(root, objectIds, {
    runCommand, env, maxBuffer: budget + (objectIds.length * 160) + 1024
  });
  if (!bytes) return null;
  const output = new Map();
  let cursor = 0;
  let totalBytes = 0;
  for (const oid of objectIds) {
    const newline = bytes.indexOf(0x0a, cursor);
    if (newline < 0) return null;
    const [observed, type, rawSize] = bytes.toString('utf8', cursor, newline).trim().split(' ');
    const size = Number(rawSize);
    const start = newline + 1;
    const end = start + size;
    totalBytes += size;
    if (observed !== oid || type !== 'blob' || !Number.isSafeInteger(size) || size < 0
        || size > maximumObjectBytes || totalBytes > maximumBytes
        || end >= bytes.length || bytes[end] !== 0x0a) return null;
    const body = bytes.subarray(start, end);
    if (blobId(objectFormat, body) !== oid) return null;
    output.set(oid, Buffer.from(body));
    cursor = end + 1;
  }
  return cursor === bytes.length ? output : null;
}

/**
 * Read an exact, already-resolved set of local Git blobs with bounded batch processes.
 *
 * The check pass supplies authoritative byte sizes before materialization, allowing callers to
 * enforce their aggregate ceiling and allowing this helper to split output below Node's buffer
 * ceiling. A small set is first read once without it (`readWithoutSizing`); whatever that read
 * cannot prove takes the check pass. Raw reads disable object replacement and lazy fetch: an exact local object admission
 * must neither substitute another object's bytes nor become a hidden network operation.
 */
export function readLocalGitBlobs(root, objectIds, {
  env = process.env,
  runCommand = run,
  maximumBytes = Number.POSITIVE_INFINITY,
  maximumObjectBytes = maximumBytes,
  maximumBatchBytes = DEFAULT_BATCH_BYTES,
  code = 'GIT_BLOB_BATCH_INVALID',
  limitCode = code,
  label = 'Git blob batch'
} = {}) {
  const unique = [...new Set(objectIds)];
  if (!unique.length) return new Map();
  if (unique.some((oid) => typeof oid !== 'string' || !OBJECT_ID.test(oid))) {
    refusal(`${label} contains an invalid object identity.`, code);
  }
  const localEnv = { ...env, GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' };
  const objectFormat = repositoryObjectFormat(root, { env: localEnv, runCommand });
  if (!objectFormat) refusal(`${label} could not establish the repository object format.`, code);
  const objectIdLength = objectFormat === 'sha1' ? 40 : 64;
  if (unique.some((oid) => oid.length !== objectIdLength)) {
    refusal(`${label} contains an object identity for a different repository format.`, code);
  }
  const scope = blobMemoScope(root, env, runCommand);
  const remembered = scope && rememberedRead(scope, unique, { maximumBytes, maximumObjectBytes });
  if (remembered) return remembered;
  const unsized = readWithoutSizing(root, unique, {
    runCommand, env: localEnv, objectFormat, maximumBytes, maximumObjectBytes, maximumBatchBytes
  });
  if (unsized) return rememberBlobs(scope, unsized);
  const input = `${unique.join('\n')}\n`;
  const checked = runCommand('git', [
    'cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'
  ], {
    cwd: root,
    env: localEnv,
    input,
    allowFailure: true,
    timeoutClass: 'local-read',
    maxBuffer: Math.max(1024, unique.length * 160)
  });
  const rows = String(checked.stdout ?? '').trimEnd().split('\n');
  if (checked.status !== 0 || rows.length !== unique.length) {
    refusal(`${label} could not size every retained object.`, code);
  }

  let totalBytes = 0;
  const sized = rows.map((row, index) => {
    const [oid, type, rawSize] = row.trim().split(' ');
    const size = Number(rawSize);
    if (oid !== unique[index] || type !== 'blob' || !Number.isSafeInteger(size) || size < 0) {
      refusal(`${label} contains an unavailable, unsupported, or oversized object.`, code, {
        object: unique[index], maximumObjectBytes
      });
    }
    if (size > maximumObjectBytes) {
      refusal(`${label} contains an object larger than its byte ceiling.`, limitCode, {
        object: unique[index], bytes: size, maximumObjectBytes
      });
    }
    totalBytes += size;
    if (totalBytes > maximumBytes) {
      refusal(`${label} exceeds its aggregate byte ceiling.`, limitCode, {
        bytes: totalBytes, maximumBytes
      });
    }
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
    const bytes = batchOutput(root, entries.map((entry) => entry.oid), {
      runCommand, env: localEnv, maxBuffer: expectedBytes + (entries.length * 160) + 1024
    });
    if (!bytes) refusal(`${label} could not read every retained object.`, code);
    let cursor = 0;
    for (const entry of entries) {
      const newline = bytes.indexOf(0x0a, cursor);
      if (newline < 0) refusal(`${label} returned a truncated object header.`, code);
      const [oid, type, rawSize] = bytes.toString('utf8', cursor, newline).trim().split(' ');
      const size = Number(rawSize);
      const start = newline + 1;
      const end = start + size;
      if (oid !== entry.oid || type !== 'blob' || size !== entry.size
          || end >= bytes.length || bytes[end] !== 0x0a) {
        refusal(`${label} returned a malformed or truncated object stream.`, code);
      }
      const body = bytes.subarray(start, end);
      if (blobId(objectFormat, body) !== entry.oid) {
        refusal(`${label} returned blob bytes that do not match the requested object identity.`, code, {
          object: entry.oid
        });
      }
      output.set(entry.oid, Buffer.from(body));
      cursor = end + 1;
    }
    if (cursor !== bytes.length) refusal(`${label} returned unexpected trailing bytes.`, code);
  }
  return rememberBlobs(scope, output);
}
