import { SingularityFlowError, run } from './util.mjs';

const OBJECT_ID = /^[a-f0-9]{40,64}$/;
const DEFAULT_BATCH_BYTES = 24 * 1024 * 1024;

function refusal(message, code, details) {
  throw new SingularityFlowError(message, { code, details });
}

/**
 * Read an exact, already-resolved set of local Git blobs with bounded batch processes.
 *
 * The check pass supplies authoritative byte sizes before materialization, allowing callers to
 * enforce their aggregate ceiling and allowing this helper to split output below Node's buffer
 * ceiling. GIT_NO_LAZY_FETCH is deliberate: a local admission/read must never become a hidden
 * network operation merely because the repository is partial.
 */
export function readLocalGitBlobs(root, objectIds, {
  env = process.env,
  maximumBytes = Number.POSITIVE_INFINITY,
  maximumObjectBytes = maximumBytes,
  maximumBatchBytes = DEFAULT_BATCH_BYTES,
  code = 'GIT_BLOB_BATCH_INVALID',
  label = 'Git blob batch'
} = {}) {
  const unique = [...new Set(objectIds)];
  if (!unique.length) return new Map();
  if (unique.some((oid) => !OBJECT_ID.test(String(oid)))) {
    refusal(`${label} contains an invalid object identity.`, code);
  }
  const localEnv = { ...env, GIT_NO_LAZY_FETCH: '1' };
  const input = `${unique.join('\n')}\n`;
  const checked = run('git', [
    'cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'
  ], {
    cwd: root,
    env: localEnv,
    input,
    allowFailure: true,
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
    if (oid !== unique[index] || type !== 'blob' || !Number.isSafeInteger(size) || size < 0
        || size > maximumObjectBytes) {
      refusal(`${label} contains an unavailable, unsupported, or oversized object.`, code, {
        object: unique[index], maximumObjectBytes
      });
    }
    totalBytes += size;
    if (totalBytes > maximumBytes) {
      refusal(`${label} exceeds its aggregate byte ceiling.`, code, { bytes: totalBytes, maximumBytes });
    }
    return { oid, size };
  });

  const groups = [];
  let group = [];
  let groupBytes = 0;
  for (const entry of sized) {
    if (group.length && groupBytes + entry.size > maximumBatchBytes) {
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
    const batch = run('git', ['cat-file', '--batch'], {
      cwd: root,
      env: localEnv,
      input: `${entries.map((entry) => entry.oid).join('\n')}\n`,
      encoding: 'buffer',
      allowFailure: true,
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
      output.set(entry.oid, Buffer.from(bytes.subarray(start, end)));
      cursor = end + 1;
    }
    if (cursor !== bytes.length) refusal(`${label} returned unexpected trailing bytes.`, code);
  }
  return output;
}
