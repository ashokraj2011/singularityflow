/**
 * Append-only content-addressed storage for closed REV records.
 *
 * `private` records live below the Git common directory and are never staged. `shared` records are
 * materialized into the Story evidence tree for a later, separately authorized publication. This
 * module never invokes Git, creates a commit, advances a loop head, or changes lifecycle state.
 */
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

import { gitCommonDir } from '../git.mjs';
import {
  readPrivateSidecar, writeImmutablePrivateSidecar
} from '../private-sidecar.mjs';
import { canonicalJson } from '../records.mjs';
import { withSubjectLock } from '../subject-lock.mjs';
import { SingularityFlowError } from '../util.mjs';
import {
  revisionRecordHashField, validateRevisionRecord
} from './contracts.mjs';

const HASH = /^sha256:([a-f0-9]{64})$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_BYTES = 256 * 1024;
const PRIVATE_ONLY = new Set(['revision-recovery-journal']);
const DIRECTORY_SYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF']);

function fail(code, message) { throw new SingularityFlowError(message, { code }); }
function id(value, label) {
  if (!ID.test(String(value ?? ''))) fail('REV_RECORD_STORE_SCOPE', `${label} is invalid.`);
  return value;
}
function digestPart(value, label) {
  const match = HASH.exec(String(value ?? ''));
  if (!match) fail('REV_RECORD_STORE_SCOPE', `${label} needs an exact SHA-256 digest.`);
  return match[1];
}
function scope(record) {
  if (!record.subject) fail('REV_RECORD_STORE_SCOPE', `${record.kind} lacks a Story/phase subject.`);
  return {
    workId: id(record.subject.workId, 'workId'),
    phaseId: id(record.subject.phaseId, 'phaseId'),
    generation: record.subject.phaseGeneration
  };
}
function hashOf(record) {
  return digestPart(record[revisionRecordHashField(record.kind)], `${record.kind} content hash`);
}

async function syncSharedDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (DIRECTORY_SYNC_UNSUPPORTED.has(error?.code)
        || (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error?.code))) return;
    fail('REV_RECORD_STORE_DURABILITY_UNAVAILABLE',
      'Shared REV record directory could not be durably synchronized.');
  } finally { await handle?.close().catch(() => {}); }
}

export function revisionRecordPath(root, record, { storage = 'private', loopSha256 = null } = {}) {
  const validated = validateRevisionRecord(record.kind, record);
  const selected = scope(validated);
  const filename = `${hashOf(validated)}.json`;
  if (storage === 'private') {
    return path.join(path.resolve(gitCommonDir(root)), 'singularity-flow', 'revisions',
      selected.workId, selected.phaseId, String(selected.generation), 'records', validated.kind, filename);
  }
  if (storage !== 'shared') fail('REV_RECORD_STORE_SCOPE', 'REV storage must be private or shared.');
  if (PRIVATE_ONLY.has(validated.kind)) {
    fail('REV_RECORD_STORE_PRIVATE_ONLY', `${validated.kind} may not be written into shared Story evidence.`);
  }
  const loop = digestPart(loopSha256, 'loopSha256');
  return path.join(path.resolve(root), 'singularity', 'work-items', selected.workId, 'evidence',
    'revisions', selected.phaseId, loop, 'records', validated.kind, filename);
}

async function safeSharedDirectory(root, directory, { create = false } = {}) {
  const lexicalRoot = path.resolve(root);
  const canonicalRoot = await realpath(root);
  const lexicalTarget = path.resolve(directory);
  const relative = path.relative(lexicalRoot, lexicalTarget);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('REV_RECORD_STORE_UNSAFE', 'Shared REV record directory escapes the selected repository.');
  }
  const target = path.resolve(canonicalRoot, relative);
  let cursor = canonicalRoot;
  for (const segment of relative.split(path.sep)) {
    const parent = cursor;
    cursor = path.join(cursor, segment);
    let info;
    let created = false;
    try { info = await lstat(cursor); }
    catch (error) {
      if (error?.code !== 'ENOENT' || !create) throw error;
      try { await mkdir(cursor, { mode: 0o700 }); created = true; }
      catch (mkdirError) { if (mkdirError?.code !== 'EEXIST') throw mkdirError; }
      info = await lstat(cursor);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      fail('REV_RECORD_STORE_UNSAFE', 'Shared REV record ancestor is not a real directory.');
    }
    if (created) await syncSharedDirectory(parent);
  }
  if (await realpath(directory) !== target) {
    fail('REV_RECORD_STORE_UNSAFE', 'Shared REV record directory changed identity.');
  }
  return target;
}

async function readShared(root, target, { optional = false } = {}) {
  try { await safeSharedDirectory(root, path.dirname(target)); }
  catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    throw error;
  }
  let entry;
  try {
    entry = await lstat(target);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      fail('REV_RECORD_STORE_UNSAFE', 'Shared REV record is not a real regular file.');
    }
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    throw error;
  }
  let handle;
  try {
    handle = await open(target,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino) {
      fail('REV_RECORD_STORE_UNSAFE', 'Shared REV record changed identity while it was opened.');
    }
    if (opened.size > MAX_BYTES) {
      fail('REV_RECORD_STORE_LIMIT', 'Shared REV record exceeds its byte limit.');
    }
    const bounded = Buffer.alloc(MAX_BYTES + 1);
    let offset = 0;
    while (offset < bounded.length) {
      const { bytesRead } = await handle.read(bounded, offset, bounded.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > MAX_BYTES) fail('REV_RECORD_STORE_LIMIT', 'Shared REV record exceeds its byte limit.');
    const after = await handle.stat();
    const current = await lstat(target);
    await safeSharedDirectory(root, path.dirname(target));
    if (!current.isFile() || current.isSymbolicLink()
        || current.dev !== opened.dev || current.ino !== opened.ino
        || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
        || offset !== opened.size) {
      fail('REV_RECORD_STORE_UNSAFE', 'Shared REV record changed identity or bytes while it was read.');
    }
    return bounded.subarray(0, offset);
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    if (['ELOOP', 'EMLINK'].includes(error?.code)) {
      fail('REV_RECORD_STORE_UNSAFE', 'Shared REV record is a symbolic link.');
    }
    throw error;
  } finally { await handle?.close().catch(() => {}); }
}

async function writeShared(root, target, bytes) {
  const directory = await safeSharedDirectory(root, path.dirname(target), { create: true });
  const existing = await readShared(root, target, { optional: true });
  if (existing) {
    if (!existing.equals(bytes)) fail('REV_RECORD_STORE_CONFLICT', 'Shared immutable REV record conflicts with existing bytes.');
    return false;
  }
  const temporary = path.join(directory, `.pending-${process.pid}-${randomUUID()}`);
  let handle;
  try {
    handle = await open(temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0),
      0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await safeSharedDirectory(root, path.dirname(target));
    try {
      await link(temporary, target);
      await syncSharedDirectory(directory);
    }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const raced = await readShared(root, target);
      if (!raced.equals(bytes)) fail('REV_RECORD_STORE_CONFLICT', 'Concurrent shared REV record bytes conflict.');
      return false;
    }
    if (!(await readShared(root, target)).equals(bytes)) fail('REV_RECORD_STORE_CORRUPT', 'Shared REV record changed during publication.');
    return true;
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function writeRevisionRecord(root, record, options = {}) {
  const validated = validateRevisionRecord(record.kind, record);
  const target = revisionRecordPath(root, validated, options);
  const bytes = Buffer.from(`${canonicalJson(validated)}\n`);
  if (bytes.length > MAX_BYTES) fail('REV_RECORD_STORE_LIMIT', 'REV record exceeds its storage byte limit.');
  const selected = scope(validated);
  return withSubjectLock(root, {
    kind: 'revision-record-store', id: `${selected.workId}:${selected.phaseId}:${selected.generation}`
  }, async () => {
    let created;
    if ((options.storage ?? 'private') === 'private') {
      ({ created } = await writeImmutablePrivateSidecar(root, target, bytes, {
        maximumBytes: MAX_BYTES, enforceWindowsAcl: true
      }));
    } else created = await writeShared(root, target, bytes);
    return Object.freeze({ record: validated, path: target, storage: options.storage ?? 'private', created });
  });
}

export async function readRevisionRecord(root, kind, recordSha256, {
  subject, storage = 'private', loopSha256 = null
} = {}) {
  const hashField = revisionRecordHashField(kind);
  const shell = {
    kind, subject: {
      workId: id(subject?.workId, 'workId'), phaseId: id(subject?.phaseId, 'phaseId'),
      phaseGeneration: subject?.phaseGeneration
    }, [hashField]: recordSha256
  };
  // Path projection only needs kind, subject, and the content digest; full validation occurs after read.
  const filename = `${digestPart(recordSha256, 'recordSha256')}.json`;
  const base = storage === 'private'
    ? path.join(path.resolve(gitCommonDir(root)), 'singularity-flow', 'revisions', shell.subject.workId,
      shell.subject.phaseId, String(shell.subject.phaseGeneration), 'records', kind, filename)
    : path.join(path.resolve(root), 'singularity', 'work-items', shell.subject.workId, 'evidence',
      'revisions', shell.subject.phaseId, digestPart(loopSha256, 'loopSha256'), 'records', kind, filename);
  let bytes;
  if (storage === 'private') {
    bytes = await readPrivateSidecar(root, base, {
      maximumBytes: MAX_BYTES, enforceWindowsAcl: true
    });
  }
  else if (storage === 'shared') {
    if (PRIVATE_ONLY.has(kind)) fail('REV_RECORD_STORE_PRIVATE_ONLY', `${kind} has no shared storage.`);
    bytes = await readShared(root, base);
  } else fail('REV_RECORD_STORE_SCOPE', 'REV storage must be private or shared.');
  let parsed;
  try { parsed = JSON.parse(bytes); }
  catch { fail('REV_RECORD_STORE_CORRUPT', 'Stored REV record is not valid JSON.'); }
  const record = validateRevisionRecord(kind, parsed);
  if (record[hashField] !== recordSha256
      || record.subject.workId !== shell.subject.workId
      || record.subject.phaseId !== shell.subject.phaseId
      || record.subject.phaseGeneration !== shell.subject.phaseGeneration) {
    fail('REV_RECORD_STORE_CORRUPT', 'Stored REV record differs from its selected identity or scope.');
  }
  return record;
}
