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

  // Subject discovery filters the tree by path before opening any blobs. For a bounded set of
  // ordinary records with no size-aware filter, the batch headers already supply the sizes.
  // Reuse the hash-verified reader instead of starting a second Git process just to size them.
  // Missing, oversized, malformed or truncated answers retain the sized path and its diagnostics.
  if (deferredSizes && !filter && listedEntries.length
      && listedEntries.every((entry) => entry.type === 'blob')) {
    const answers = readObjectsWithoutSizing(root, [...new Set(listedEntries.map((entry) => entry.oid))], {
      runCommand, localEnv, maxObjectBytes, maxBatchBytes
    });
    if (answers && listedEntries.every((entry) => answers.get(entry.oid)?.type === 'blob')) {
      const contents = new Map(listedEntries.map((entry) => [
        entry.file, answers.get(entry.oid).bytes.toString('utf8')
      ]));
      return result('ok', contents, [], listedEntries.length, listedEntries.length);
    }
  }

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

/**
 * Up to 256 object IDs in one `cat-file --batch`, without asking their sizes first. `[perf]`
 *
 * Most reads are a level of small trees or a handful of configuration blobs that all exist, so
 * the size check only doubled the processes. Any answer that is not a whole object within the
 * limits, verified against its ID, returns null and the caller takes the sized path, which
 * answers that object exactly as it always has.
 */
function readObjectsWithoutSizing(root, unique, { runCommand, localEnv, maxObjectBytes, maxBatchBytes }) {
  if (unique.length > 256 || !unique.every((spec) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(spec))) return null;
  const budget = Math.min(Math.max(1, maxBatchBytes), unique.length * maxObjectBytes);
  if (!Number.isSafeInteger(budget) || budget < 0) return null;
  const batch = runCommand('git', ['cat-file', '--batch'], {
    cwd: root, allowFailure: true, encoding: 'buffer', env: localEnv,
    maxBuffer: budget + HEADER_ALLOWANCE, input: `${unique.join('\n')}\n`
  });
  if (batch.status !== 0 || batch.timedOut || batch.error) return null;
  const buffer = Buffer.isBuffer(batch.stdout) ? batch.stdout : Buffer.from(batch.stdout ?? '', 'utf8');
  const answers = new Map();
  let cursor = 0;
  for (const spec of unique) {
    const newline = buffer.indexOf(0x0a, cursor);
    if (newline < 0) return null;
    const [oid, type, rawSize, extra] = buffer.toString('utf8', cursor, newline).trim().split(' ');
    const size = Number(rawSize);
    if (extra !== undefined || oid !== spec || !Number.isSafeInteger(size) || size < 0 || size > maxObjectBytes) return null;
    const start = newline + 1; const end = start + size;
    if (end >= buffer.length || buffer[end] !== 0x0a) return null;
    const body = buffer.subarray(start, end);
    const actual = createHash(oid.length === 64 ? 'sha256' : 'sha1').update(`${type} ${size}\0`).update(body).digest('hex');
    if (actual !== oid) return null;
    answers.set(spec, { status: 'ok', oid, type, size, bytes: Buffer.from(body) });
    cursor = end + 1;
  }
  return cursor === buffer.length ? answers : null;
}

/**
 * Many object reads in one or two Git processes, for scans that otherwise run several per ref.
 *
 * `specs` are `<rev>:<path>` or object IDs. Each answer is `{ status: 'ok', oid, type, size,
 * bytes }`, `{ status: 'missing' }` when the path (or ref) does not exist, `{ status: 'unavailable',
 * reason }` when the object exists but is not readable here (a blobless clone) or Git answered
 * something else, or `{ status: 'too-large', oid, size }`. A small set of object IDs is read in one
 * process (above); otherwise sizes are checked first, so an object over the limit is never read.
 * Every body is checked against its object ID before it is returned. Returns null when Git itself
 * fails, so a caller keeps its exact per-ref path for that case.
 */
export function readObjectsBatch(root, specs, {
  runCommand = run, env = process.env, maxObjectBytes = DEFAULT_OBJECT_BYTES, maxBatchBytes = DEFAULT_BATCH_BYTES, checkOnly = false
} = {}) {
  const answers = new Map();
  const unique = [...new Set(specs)];
  if (!unique.length) return answers;
  if (unique.some((spec) => typeof spec !== 'string' || !spec || /[\r\n]/u.test(spec))) return null;
  const localEnv = gitEnvironment(env);
  if (!checkOnly) {
    const unsized = readObjectsWithoutSizing(root, unique, { runCommand, localEnv, maxObjectBytes, maxBatchBytes });
    if (unsized) return unsized;
  }
  const checked = runCommand('git', ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {
    cwd: root, allowFailure: true, env: localEnv, maxBuffer: unique.length * 256 + 1024, input: `${unique.join('\n')}\n`
  });
  if (checked.status !== 0 || checked.timedOut || checked.error) return null;
  const lines = String(checked.stdout ?? '').replace(/\n$/u, '').split('\n');
  if (lines.length !== unique.length) return null;
  const wanted = [];
  for (let index = 0; index < unique.length; index += 1) {
    const spec = unique[index]; const line = lines[index];
    if (line === `${spec} missing`) {
      // A `<rev>:<path>` Git cannot resolve is an absent path; an object ID it cannot find is not.
      answers.set(spec, spec.includes(':') ? { status: 'missing' } : { status: 'unavailable', reason: 'object is not available locally' });
      continue;
    }
    const [oid, type, rawSize, extra] = line.split(' ');
    const size = Number(rawSize);
    if (extra !== undefined || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(oid ?? '') || !Number.isSafeInteger(size) || size < 0) {
      answers.set(spec, { status: 'unavailable', reason: line.endsWith(' missing') ? 'object is not available locally' : `Git answered '${line.slice(0, 120)}'` });
      continue;
    }
    if (checkOnly) { answers.set(spec, { status: 'ok', oid, type, size, bytes: null }); continue; }
    if (size > maxObjectBytes) { answers.set(spec, { status: 'too-large', oid, size }); continue; }
    answers.set(spec, { status: 'pending', oid, type, size });
    wanted.push({ oid, type, size });
  }
  const objects = new Map();
  const distinct = [...new Map(wanted.map((entry) => [entry.oid, entry])).values()];
  for (const group of batches(distinct, Math.max(1, maxBatchBytes))) {
    const expected = group.reduce((sum, entry) => sum + entry.size, 0);
    const batch = runCommand('git', ['cat-file', '--batch'], {
      cwd: root, allowFailure: true, encoding: 'buffer', env: localEnv,
      maxBuffer: expected + HEADER_ALLOWANCE, input: `${group.map((entry) => entry.oid).join('\n')}\n`
    });
    if (batch.status !== 0 || batch.timedOut || batch.error) return null;
    const buffer = Buffer.isBuffer(batch.stdout) ? batch.stdout : Buffer.from(batch.stdout ?? '', 'utf8');
    let cursor = 0;
    for (const entry of group) {
      const newline = buffer.indexOf(0x0a, cursor);
      if (newline < 0) return null;
      const [oid, type, rawSize] = buffer.toString('utf8', cursor, newline).trim().split(' ');
      const size = Number(rawSize);
      if (oid !== entry.oid || type !== entry.type || size !== entry.size) return null;
      const start = newline + 1; const end = start + size;
      if (end >= buffer.length || buffer[end] !== 0x0a) return null;
      const body = buffer.subarray(start, end);
      const actual = createHash(oid.length === 64 ? 'sha256' : 'sha1').update(`${type} ${size}\0`).update(body).digest('hex');
      if (actual !== oid) return null;
      objects.set(oid, Buffer.from(body));
      cursor = end + 1;
    }
    if (cursor !== buffer.length) return null;
  }
  for (const [spec, answer] of answers) {
    if (answer.status === 'pending') answers.set(spec, { status: 'ok', oid: answer.oid, type: answer.type, size: answer.size, bytes: objects.get(answer.oid) });
  }
  return answers;
}

/** The entries of one tree object: `{ mode, name, oid }`, in Git's order. Null when malformed. */
export function treeEntries(bytes, oidLength = 40) {
  const entries = [];
  const width = oidLength / 2;
  let cursor = 0;
  while (cursor < bytes.length) {
    const space = bytes.indexOf(0x20, cursor);
    const nul = space < 0 ? -1 : bytes.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 1 + width > bytes.length) return null;
    entries.push({
      mode: bytes.toString('utf8', cursor, space),
      name: bytes.toString('utf8', space + 1, nul),
      oid: bytes.subarray(nul + 1, nul + 1 + width).toString('hex')
    });
    cursor = nul + 1 + width;
  }
  return entries;
}
