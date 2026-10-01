/**
 * Where a Story document's bytes are kept.
 *
 * `git`, the default, commits them under the Story's `inputs/`. `local` keeps them on this machine
 * only, in the repository's Git directory, and commits only the document's name, size and SHA-256.
 * The bytes live beside, not inside, the Singularity Flow runtime directory: they are the only copy
 * of someone's file, while the runtime directory holds state a factory reset may discard. Every worktree of a clone shares that
 * directory, so an isolated Story worktree sees what its launch checkout stored. Another clone or
 * another machine does not: there the document is unavailable, and every reader says so rather than
 * pretending it is empty.
 *
 * The store is content-addressed (`<WORK-ID>/<sha256>/<file name>`), created owner-only, and never
 * follows a symbolic link; a read is verified against the committed SHA-256 before it is used.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gitCommonDir } from './git.mjs';
import { SingularityFlowError } from './util.mjs';

export { DOCUMENT_STORAGE_KINDS, assertDocumentStoragePolicy, resolveDocumentStorage } from './document-storage-policy.mjs';

const LOCAL_STORE_DIRECTORY = 'singularity-flow-documents';
// Where builds before the store moved kept it: inside the runtime directory a factory reset removes.
const LEGACY_LOCAL_DIRECTORY = ['singularity-flow', 'local-documents'];
const LOCAL_KEY = /^[a-f0-9]{64}\/[A-Za-z0-9._-]{1,255}$/u;
const WORK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function fail(message, code, details) {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

export function isLocalDocument(record) {
  return record?.type === 'file' && record?.storage?.kind === 'local';
}

/** The directory holding this clone's machine-only document bytes, shared by all its worktrees. */
export function localDocumentStoreDirectory(root) {
  return path.join(gitCommonDir(root), LOCAL_STORE_DIRECTORY);
}

/** Where an earlier build kept them, inside the runtime directory. */
export function legacyLocalDocumentStoreDirectory(root) {
  return path.join(gitCommonDir(root), ...LEGACY_LOCAL_DIRECTORY);
}

async function directoryState(directory) {
  const info = await lstat(directory).catch((error) => (['ENOENT', 'ENOTDIR'].includes(error?.code) ? null : Promise.reject(error)));
  if (!info) return 'missing';
  return info.isDirectory() && !info.isSymbolicLink() ? 'directory' : 'unsafe';
}

async function sameFileBytes(left, right) {
  const [a, b] = await Promise.all([readRegularFile(left), readRegularFile(right)]);
  return Boolean(a && b && a.equals(b));
}

async function readRegularFile(file) {
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    return (await handle.stat()).isFile() ? await handle.readFile() : null;
  } catch { return null; } finally { await handle?.close().catch(() => {}); }
}

/**
 * Move what `source` holds into `target`, entry by entry. The store is content-addressed, so an
 * entry already in both is the same file: the older copy is removed only once its bytes are seen to
 * match. Symbolic links are never followed or moved.
 */
async function mergeStore(source, target) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    const existing = await lstat(to).catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error)));
    if (!existing) await rename(from, to);
    else if (entry.isDirectory() && existing.isDirectory() && !existing.isSymbolicLink()) await mergeStore(from, to);
    else if (entry.isFile() && existing.isFile() && await sameFileBytes(from, to)) await rm(from);
  }
  await rmdir(source).catch(() => {});
}

/**
 * Move a store an earlier build kept inside the runtime directory to where it lives now, so a
 * factory reset never takes it. Both are in the same Git directory, so each move is a rename.
 */
export async function migrateLegacyLocalDocumentStore(root) {
  const legacy = legacyLocalDocumentStoreDirectory(root);
  if (await directoryState(legacy) !== 'directory') return { moved: false };
  const target = localDocumentStoreDirectory(root);
  const state = await directoryState(target);
  if (state === 'unsafe') fail(`Machine-local document storage must be a real directory: ${target}`, 'DOCUMENT_LOCAL_STORE_UNSAFE');
  if (state === 'missing') await rename(legacy, target);
  else await mergeStore(legacy, target);
  return { moved: true };
}

/** The verified store directory, created owner-only when asked, or null when there is none yet. */
async function localStore(root, { create = false } = {}) {
  await migrateLegacyLocalDocumentStore(root);
  const base = localDocumentStoreDirectory(root);
  if (!(await realDirectory(base, { create }))) return null;
  const [realCommon, realBase] = await Promise.all([realpath(gitCommonDir(root)), realpath(base)]);
  if (realBase !== path.join(realCommon, LOCAL_STORE_DIRECTORY)) {
    fail(`Machine-local document storage must be a real directory: ${base}`, 'DOCUMENT_LOCAL_STORE_UNSAFE');
  }
  return base;
}

function checkedWorkId(workId) {
  if (!WORK_ID.test(String(workId ?? ''))) fail(`'${workId}' is not a Story identifier the local document store accepts.`, 'DOCUMENT_LOCAL_STORE_INVALID');
  return String(workId);
}

/** The committed key of a machine-local document: `<sha256>/<file name>`, nothing that locates a machine. */
export function localDocumentKey(sha256, filename) {
  const key = `${sha256}/${filename}`;
  if (!LOCAL_KEY.test(key)) fail(`'${filename}' cannot name a machine-local document.`, 'DOCUMENT_LOCAL_STORE_INVALID');
  return key;
}

export function validLocalDocumentKey(key) {
  return LOCAL_KEY.test(String(key ?? ''));
}

async function realDirectory(directory, { create }) {
  let info = await lstat(directory).catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error)));
  if (!info) {
    if (!create) return false;
    try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
    info = await lstat(directory);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    fail(`Machine-local document storage must be a real directory: ${directory}`, 'DOCUMENT_LOCAL_STORE_UNSAFE');
  }
  return true;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Keep verified bytes on this machine and return the key the catalog commits. Storing bytes that
 * are already there under the same key is a no-op after verifying them.
 */
export async function storeLocalDocument(root, workId, { bytes, sha256: expected, filename }) {
  const actual = sha256(bytes);
  if (actual !== expected) fail('Document bytes changed before they could be kept on this machine.', 'STORY_DOCUMENT_CHANGED');
  const key = localDocumentKey(expected, filename);
  const base = await localStore(root, { create: true });
  const storyDirectory = path.join(base, checkedWorkId(workId));
  await realDirectory(storyDirectory, { create: true });
  const hashDirectory = path.join(storyDirectory, expected);
  await realDirectory(hashDirectory, { create: true });
  const target = path.join(hashDirectory, filename);
  const existing = await lstat(target).catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error)));
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) fail(`Machine-local document storage holds something other than a file at ${key}.`, 'DOCUMENT_LOCAL_STORE_UNSAFE');
    const stored = await readVerified(target, { size: bytes.length, sha256: expected });
    if (!stored) fail(`Machine-local document ${key} does not match the bytes being stored.`, 'DOCUMENT_LOCAL_STORE_UNSAFE');
    return { key };
  }
  const temporary = path.join(hashDirectory, `.${randomUUID()}.partial`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  return { key };
}

async function readVerified(file, { size, sha256: expected }) {
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || (Number.isInteger(size) && info.size !== size)) return null;
    const bytes = await handle.readFile();
    return sha256(bytes) === expected ? bytes : null;
  } catch (error) {
    if (['ENOENT', 'ELOOP', 'EISDIR', 'ENOTDIR'].includes(error?.code)) return null;
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function locate(root, workId, record) {
  if (!validLocalDocumentKey(record?.storage?.key)) return { status: 'unavailable', reason: 'invalid-key' };
  const base = await localStore(root);
  if (!base) return { status: 'unavailable', reason: 'missing' };
  const file = path.join(base, checkedWorkId(workId), ...record.storage.key.split('/'));
  const info = await lstat(file).catch((error) => (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? null : Promise.reject(error)));
  if (!info) return { status: 'unavailable', reason: 'missing' };
  if (info.isSymbolicLink() || !info.isFile()) return { status: 'changed', reason: 'not-a-file' };
  // The store must be where it claims to be, not reached through a linked directory.
  const [realBase, realFile] = await Promise.all([realpath(base).catch(() => null), realpath(file).catch(() => null)]);
  const relative = realBase && realFile ? path.relative(realBase, realFile) : null;
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return { status: 'changed', reason: 'outside-store' };
  return { status: info.size === record.size ? 'available' : 'changed', reason: info.size === record.size ? null : 'size', file };
}

/**
 * Whether this checkout holds a machine-local document: `available`, `unavailable` (never here,
 * or removed) or `changed` (present but not the committed bytes). Computed on every read and never
 * committed: the answer differs by machine. `verify` hashes the bytes; without it a matching size
 * is taken as available, which is what a listing needs.
 */
export async function localDocumentAvailability(root, workId, record, { verify = false } = {}) {
  const located = await locate(root, workId, record);
  if (located.status !== 'available' || !verify) return located.status;
  return (await readVerified(located.file, record)) ? 'available' : 'changed';
}

function unavailableMessage(record, status) {
  const who = record.addedBy?.name ?? record.addedBy?.login ?? record.addedBy?.email ?? 'the person who added it';
  const name = record.name ? ` (${record.name})` : '';
  return status === 'changed'
    ? `Document '${record.id}'${name} is kept on this machine only, and the copy here no longer matches its committed SHA-256 ${record.sha256}. Re-attach the original file.`
    : `Document '${record.id}'${name} is kept only on the machine where ${who} added it; this checkout does not have its bytes (SHA-256 ${record.sha256}). Ask them for the file, or ask them to commit it there with singularity-flow documents store ${record.id} --store git.`;
}

/** The verified bytes of a machine-local document and where they are, or a refusal saying why not. */
export async function readLocalDocument(root, workId, record) {
  const located = await locate(root, workId, record);
  if (located.status === 'available') {
    const bytes = await readVerified(located.file, record);
    if (bytes) return { bytes, absolutePath: located.file };
    located.status = 'changed';
  }
  fail(unavailableMessage(record, located.status),
    located.status === 'changed' ? 'DOCUMENT_LOCAL_CHANGED' : 'DOCUMENT_LOCAL_UNAVAILABLE',
    { documentId: record.id, sha256: record.sha256, availability: located.status });
}

export { unavailableMessage as localDocumentUnavailableMessage };
