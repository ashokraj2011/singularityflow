import { createHash } from 'node:crypto';

import { SingularityFlowError, run } from './util.mjs';

const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DEFAULT_BATCH_BYTES = 24 * 1024 * 1024;
const MAXIMUM_BATCH_OBJECTS = 512;

function refusal(message, code, details) {
  throw new SingularityFlowError(message, { code, details });
}

/**
 * Read an exact, already-resolved set of local Git blobs with bounded batch processes.
 *
 * The check pass supplies authoritative byte sizes before materialization, allowing callers to
 * enforce their aggregate ceiling and allowing this helper to split output below Node's buffer
 * ceiling. Raw reads disable object replacement and lazy fetch: an exact local object admission
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
  const formatResult = runCommand('git', ['rev-parse', '--show-object-format'], {
    cwd: root,
    env: localEnv,
    allowFailure: true,
    timeoutClass: 'local-read',
    maxBuffer: 1024
  });
  const objectFormat = String(formatResult.stdout ?? '').trim();
  if (formatResult.status !== 0 || !['sha1', 'sha256'].includes(objectFormat)) {
    refusal(`${label} could not establish the repository object format.`, code);
  }
  const objectIdLength = objectFormat === 'sha1' ? 40 : 64;
  if (unique.some((oid) => oid.length !== objectIdLength)) {
    refusal(`${label} contains an object identity for a different repository format.`, code);
  }
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
    const batch = runCommand('git', ['cat-file', '--batch'], {
      cwd: root,
      env: localEnv,
      input: `${entries.map((entry) => entry.oid).join('\n')}\n`,
      encoding: 'buffer',
      allowFailure: true,
      timeoutClass: 'local-read',
      maxBuffer: expectedBytes + (entries.length * 160) + 1024
    });
    const bytes = Buffer.isBuffer(batch.stdout) ? batch.stdout : Buffer.from(batch.stdout ?? '');
    if (batch.status !== 0) refusal(`${label} could not read every retained object.`, code);
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
      const observedOid = createHash(objectFormat)
        .update(`blob ${size}\0`, 'utf8')
        .update(body)
        .digest('hex');
      if (observedOid !== entry.oid) {
        refusal(`${label} returned blob bytes that do not match the requested object identity.`, code, {
          object: entry.oid
        });
      }
      output.set(entry.oid, Buffer.from(body));
      cursor = end + 1;
    }
    if (cursor !== bytes.length) refusal(`${label} returned unexpected trailing bytes.`, code);
  }
  return output;
}
