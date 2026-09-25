/**
 * Bounded, typed reads of a set of blobs from one Git ref.
 *
 * A ref containing no matching paths is a valid empty answer. A missing ref, missing promisor
 * object, truncated batch, timeout, or output overflow is not. Keeping those states distinct is
 * essential because this reader supplies lifecycle projections, Goals, the approval Inbox, and the
 * append-only ledger.
 */
import { createHash } from 'node:crypto';
import { run, SingularityFlowError } from './util.mjs';

const DEFAULT_BATCH_BYTES = 16 * 1024 * 1024;
const DEFAULT_OBJECT_BYTES = 16 * 1024 * 1024;
const HEADER_ALLOWANCE = 1024 * 1024;

function diagnostic(code, message, details = {}) {
  return Object.freeze({ code, message, ...details });
}

function gitEnvironment(env) {
  return {
    ...env,
    // A local state read must not turn into an unclassified promisor fetch. Callers that choose to
    // materialize missing objects do so through the governed remote-Git boundary first.
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never'
  };
}

function result(status, contents, errors, objectsRequested, objectsRead) {
  return Object.freeze({ status, contents, errors: Object.freeze(errors), objectsRequested, objectsRead });
}

function batches(entries, maximumBytes) {
  const grouped = [];
  let current = [];
  let bytes = 0;
  for (const entry of entries) {
    if (current.length && bytes + entry.size > maximumBytes) {
      grouped.push(current);
      current = [];
      bytes = 0;
    }
    current.push(entry);
    bytes += entry.size;
  }
  if (current.length) grouped.push(current);
  return grouped;
}

function parseBatch(buffer, entries) {
  const contents = new Map();
  const errors = [];
  let cursor = 0;
  for (const entry of entries) {
    const newline = buffer.indexOf(0x0a, cursor);
    if (newline < 0) {
      errors.push(diagnostic('REF_TREE_BATCH_HEADER_MISSING', `No batch header was returned for ${entry.file}.`, { path: entry.file }));
      break;
    }
    const header = buffer.toString('utf8', cursor, newline).trim();
    const parts = header.split(/\s+/);
    if (parts.length < 3 || parts[0] !== entry.oid || parts[1] !== 'blob') {
      errors.push(diagnostic(
        parts.at(-1) === 'missing' ? 'REF_TREE_OBJECT_MISSING' : 'REF_TREE_BATCH_HEADER_INVALID',
        `Git returned an invalid batch header for ${entry.file}.`,
        { path: entry.file, object: entry.oid }
      ));
      break;
    }
    const size = Number(parts[2]);
    if (!Number.isSafeInteger(size) || size < 0 || size !== entry.size) {
      errors.push(diagnostic('REF_TREE_OBJECT_SIZE_MISMATCH', `Git returned a different size for ${entry.file}.`, {
        path: entry.file, listedBytes: entry.size, returnedBytes: Number.isFinite(size) ? size : null
      }));
      break;
    }
    const start = newline + 1;
    const end = start + size;
    if (end >= buffer.length || buffer[end] !== 0x0a) {
      errors.push(diagnostic('REF_TREE_BATCH_TRUNCATED', `Git returned incomplete bytes for ${entry.file}.`, {
        path: entry.file, expectedBytes: size, availableBytes: Math.max(0, buffer.length - start)
      }));
      break;
    }
    const body = buffer.subarray(start, end);
    const actualOid = createHash(entry.oid.length === 64 ? 'sha256' : 'sha1')
      .update(`blob ${size}\0`).update(body).digest('hex');
    if (actualOid !== entry.oid) {
      errors.push(diagnostic('REF_TREE_OBJECT_HASH_MISMATCH', `Git returned bytes that do not match ${entry.file}.`, {
        path: entry.file, object: entry.oid, actualObject: actualOid
      }));
      break;
    }
    contents.set(entry.file, buffer.toString('utf8', start, end));
    cursor = end + 1;
  }
  if (!errors.length && cursor !== buffer.length) {
    errors.push(diagnostic('REF_TREE_BATCH_TRAILING_BYTES', 'Git returned unclaimed bytes after the requested objects.', {
      bytes: buffer.length - cursor
    }));
  }
  return { contents, errors };
}

/**
 * Read one ref without converting failure into absence.
 *
 * `status: ok` may contain an empty map. `missing` means the ref itself is absent. `unavailable`
 * means no trustworthy result was decoded. `partial` means a prefix decoded but is deliberately
 * not safe to consume as a complete tree.
 */
export function readRefTreeResult(root, ref, pathspecs = [], {
  filter = null,
  pathFilter = null,
  runCommand = run,
  env = process.env,
  maxBatchBytes = DEFAULT_BATCH_BYTES,
  maxObjectBytes = DEFAULT_OBJECT_BYTES
} = {}) {
  const localEnv = gitEnvironment(env);
  const verified = runCommand('git', ['rev-parse', '--verify', '--quiet', `${ref}^{tree}`], {
    cwd: root, allowFailure: true, env: localEnv
  });
  if (verified.status !== 0) {
    // `--verify --quiet` reports an absent ref with status 1 and no diagnostic. A non-empty
    // diagnostic is an execution/trust/repository failure, not proof that the ref is absent.
    const unavailable = verified.timedOut || verified.error || String(verified.stderr ?? '').trim() !== ''
      || verified.status !== 1;
    return result(unavailable ? 'unavailable' : 'missing', new Map(), [diagnostic(
      verified.timedOut ? 'REF_TREE_REF_TIMEOUT'
        : verified.error?.code === 'ENOBUFS' ? 'REF_TREE_REF_OVERFLOW'
          : verified.error ? 'REF_TREE_GIT_UNAVAILABLE'
            : unavailable ? 'REF_TREE_REF_FAILED' : 'REF_TREE_REF_MISSING',
      unavailable ? `Git could not inspect ref '${ref}'.` : `Git ref '${ref}' does not exist.`, { ref }
    )], 0, 0);
  }

  // A successful rev-parse must resolve to exactly one complete tree OID. Never pass unexpected
  // stdout back into Git (or silently fall back to the movable ref) as a tree-ish.
  const treeOid = String(verified.stdout ?? '').match(/^([0-9a-f]{40}|[0-9a-f]{64})\r?\n?$/)?.[1];
  if (!treeOid) {
    return result('unavailable', new Map(), [diagnostic(
      'REF_TREE_REF_INVALID', `Git returned an invalid tree object ID for '${ref}'.`, { ref }
    )], 0, 0);
  }

  // %(objectsize) asks Git to open every blob under the pathspec, including files a later
  // filter rejects. In a blobless Story checkout that turns an otherwise local tree listing
  // into a missing-promisor-object failure (or an implicit network fetch on older Git). When a
  // caller can first select paths, list only tree metadata and size-check those selected blobs.
  const deferredSizes = typeof pathFilter === 'function';
  const listed = runCommand('git', [
    'ls-tree', '-r', '-z',
    deferredSizes
      ? '--format=%(objectmode)%x09%(objecttype)%x09%(objectname)%x09%(path)'
      : '--format=%(objectmode)%x09%(objecttype)%x09%(objectname)%x09%(objectsize)%x09%(path)',
    treeOid, '--', ...pathspecs
  ], { cwd: root, allowFailure: true, env: localEnv });
  if (listed.status !== 0) {
    return result('unavailable', new Map(), [diagnostic(
      listed.timedOut ? 'REF_TREE_LIST_TIMEOUT' : listed.error?.code === 'ENOBUFS' ? 'REF_TREE_LIST_OVERFLOW' : 'REF_TREE_LIST_FAILED',
      `Git could not list governed state at '${ref}'.`, { ref }
    )], 0, 0);
  }

  const listedEntries = [];
  const errors = [];
  for (const row of String(listed.stdout ?? '').split('\0')) {
    if (!row) continue;
    const [mode, type, oid, ...remaining] = row.split('\t');
    const rawSize = deferredSizes ? null : remaining.shift();
    const pathParts = remaining;
    const file = pathParts.join('\t');
    if (!/^[0-7]{6}$/.test(mode ?? '') || !['blob', 'commit'].includes(type)
        || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid ?? '') || oid.length !== treeOid.length
        || !file || (!deferredSizes && (!Number.isSafeInteger(Number(rawSize)) || Number(rawSize) < 0))) {
      errors.push(diagnostic('REF_TREE_LIST_INVALID', `Git returned an invalid tree entry at '${ref}'.`, { ref }));
      continue;
    }
    if (pathFilter && !pathFilter(file, Object.freeze({ oid, mode, type }))) continue;
    listedEntries.push({ oid, file, size: deferredSizes ? null : Number(rawSize), mode, type });
  }
  if (errors.length) return result('unavailable', new Map(), errors, listedEntries.length, 0);

  if (deferredSizes) {
    // Batch-check only the accepted metadata objects. This preserves the original per-object
    // admission ceiling without consulting unrelated application blobs in a partial clone.
    for (let offset = 0; offset < listedEntries.length; offset += 512) {
      const group = listedEntries.slice(offset, offset + 512);
      const checked = runCommand('git', [
        'cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'
      ], {
        cwd: root, allowFailure: true, env: localEnv,
        maxBuffer: group.length * 128 + 1024,
        input: `${group.map((entry) => entry.oid).join('\n')}\n`
      });
      if (checked.status !== 0) {
        return result('unavailable', new Map(), [diagnostic(
          checked.timedOut ? 'REF_TREE_SIZE_TIMEOUT'
            : checked.error?.code === 'ENOBUFS' ? 'REF_TREE_SIZE_OVERFLOW' : 'REF_TREE_SIZE_FAILED',
          `Git could not size governed state objects at '${ref}'.`, { ref }
        )], listedEntries.length, 0);
      }
      const lines = String(checked.stdout ?? '').trimEnd().split(/\r?\n/);
      if (lines.length !== group.length) {
        return result('unavailable', new Map(), [diagnostic(
          'REF_TREE_SIZE_INVALID', `Git returned incomplete governed-state object sizes at '${ref}'.`, { ref }
        )], listedEntries.length, 0);
      }
      for (let index = 0; index < group.length; index += 1) {
        const [oid, type, rawSize] = lines[index].split(' ');
        const size = Number(rawSize);
        if (oid !== group[index].oid || type !== group[index].type
            || !Number.isSafeInteger(size) || size < 0) {
          return result('unavailable', new Map(), [diagnostic(
            'REF_TREE_SIZE_INVALID', `Git returned an invalid governed-state object size at '${ref}'.`,
            { ref, path: group[index].file }
          )], listedEntries.length, 0);
        }
        group[index].size = size;
      }
    }
  }

  const entries = [];
  for (const { oid, file, size, mode, type } of listedEntries) {
    // Size and object identity let bounded callers make an admission decision before any blob is
    // materialized. Existing path-only filters remain source-compatible.
    if (filter && !filter(file, Object.freeze({ oid, size, mode, type }))) continue;
    if (size > maxObjectBytes) {
      errors.push(diagnostic('REF_TREE_OBJECT_TOO_LARGE', `${file} exceeds the governed-state object limit.`, {
        path: file, bytes: size, maximumBytes: maxObjectBytes
      }));
      continue;
    }
    entries.push({ oid, file, size, mode, type });
  }
  if (errors.length) return result('unavailable', new Map(), errors, entries.length, 0);
  if (!entries.length) return result('ok', new Map(), [], 0, 0);

  const contents = new Map();
  let read = 0;
  for (const group of batches(entries, Math.max(1, maxBatchBytes))) {
    const expectedBytes = group.reduce((sum, entry) => sum + entry.size, 0);
    const batch = runCommand('git', ['cat-file', '--batch'], {
      cwd: root,
      allowFailure: true,
      encoding: 'buffer',
      env: localEnv,
      maxBuffer: expectedBytes + HEADER_ALLOWANCE,
      input: `${group.map((entry) => entry.oid).join('\n')}\n`
    });
    const bytes = Buffer.isBuffer(batch.stdout) ? batch.stdout : Buffer.from(batch.stdout ?? '', 'utf8');
    const decoded = parseBatch(bytes, group);
    for (const [file, content] of decoded.contents) contents.set(file, content);
    read += decoded.contents.size;
    if (batch.status !== 0 || decoded.errors.length) {
      const failure = batch.status !== 0 ? diagnostic(
        batch.timedOut ? 'REF_TREE_BATCH_TIMEOUT' : batch.error?.code === 'ENOBUFS' ? 'REF_TREE_BATCH_OVERFLOW' : 'REF_TREE_BATCH_FAILED',
        `Git could not read all governed state objects at '${ref}'.`, { ref }
      ) : null;
      const allErrors = [...errors, ...(failure ? [failure] : []), ...decoded.errors];
      return result(read ? 'partial' : 'unavailable', contents, allErrors, entries.length, read);
    }
  }
  return result('ok', contents, [], entries.length, read);
}

/** Strict compatibility surface for consumers, such as the ledger, that require a complete map. */
export function readRefTree(root, ref, pathspecs = [], options = {}) {
  const observed = readRefTreeResult(root, ref, pathspecs, options);
  if (observed.status === 'ok' || observed.status === 'missing') return observed.contents;
  throw new SingularityFlowError(
    `Governed state at '${ref}' is ${observed.status}; it was not treated as absent. ${observed.errors[0]?.message ?? ''}`.trim(),
    {
      code: observed.status === 'partial' ? 'REF_TREE_PARTIAL' : 'REF_TREE_UNAVAILABLE',
      details: {
        ref, status: observed.status, objectsRequested: observed.objectsRequested,
        objectsRead: observed.objectsRead, errors: observed.errors
      }
    }
  );
}
