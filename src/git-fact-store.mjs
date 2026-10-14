/**
 * The session store for Git answers: what one command proved, the next command reuses. `[perf]`
 *
 * Every command is a new process, so every command asked Git the same eight start-up questions
 * (where the repository is, what HEAD and the branch are, the object format) and every Story
 * command read the same Story objects and history again. `git-fact-cache.mjs` keeps those answers
 * in memory, tied to the files they came from; this keeps them between processes. A repository's
 * answers are loaded the first time a command asks about it, and new ones are written back when the
 * process exits. Each one is checked against its files exactly like a fresh answer before it is
 * used, so nothing here can make an answer valid; it can only save asking.
 *
 * What is stored, per repository, in a private directory under the system temporary directory:
 * repository location, HEAD and branch, history walks, object reads, ancestry, ref-name checks and
 * index listings up to 64 KiB. Configuration answers are never stored: they can carry credentials
 * (a URL with a token, an `http.extraheader`). Entries are found by the SHA-256 of their question,
 * whose raw form names `GIT_*` variables, so neither is written either. No answer is used more than
 * 15 minutes after it was recorded. One whose files changed just before it was recorded stays in
 * memory only, Git's own racy-timestamp rule: a later change made in the same timestamp tick would
 * not show. Timestamps with a fraction of a second prove a fine-grained filesystem (APFS, ext4,
 * NTFS), where the window is 50 ms; any whole-second timestamp (HFS+, FAT, some network shares)
 * widens it to 2 seconds.
 *
 * `SINGULARITY_FLOW_GIT_FACT_STORE` names another absolute directory, or `off` turns the store off;
 * `SINGULARITY_FLOW_GIT_FACT_CACHE=off` turns every reuse off. Only the CLI installs it: VS Code's
 * long-lived processes keep their answers in memory anyway.
 */
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  attachGitFactPersistence, GIT_FACT_TTL_MS, gitFactCheckout, gitFactFingerprint
} from './git-fact-cache.mjs';

const FORMAT = 1;
const STORED_KINDS = new Set(['location', 'head', 'history', 'object', 'ancestry', 'ref-format', 'index']);
const STATUS_ONE_KINDS = new Set(['head', 'ref-format', 'ancestry']);
const MAXIMUM_FILE_BYTES = 1024 * 1024;
const MAXIMUM_STORED_ENTRIES = 512;
const MAXIMUM_TEXT_BYTES = 64 * 1024;
const MAXIMUM_FILES = 300;
const COARSE_RACY_NS = 2_000_000_000n;
const FINE_RACY_NS = 50_000_000n;
const PRUNE_EVERY_MS = 10 * 60 * 1000;
const PRUNE_AFTER_MS = 20 * 60 * 1000;

let installed = false;
let storeDirectory = null;
// Common Git directory → { file, entries: id → entry, changed: id → entry }.
const stores = new Map();
// Working directory → common Git directory, or null outside a checkout.
const commonDirectories = new Map();

function ownedByUser(info) {
  return typeof process.getuid !== 'function' || info.uid === process.getuid();
}

function privateDirectory(env) {
  const configured = String(env.SINGULARITY_FLOW_GIT_FACT_STORE ?? '').trim();
  if (configured.toLowerCase() === 'off') return null;
  if (String(env.SINGULARITY_FLOW_GIT_FACT_CACHE ?? '').toLowerCase() === 'off') return null;
  // A relative path would land in whichever checkout the command ran from.
  if (configured && (!path.isAbsolute(configured) || path.parse(configured).root === configured)) return null;
  const user = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
  const base = configured || path.join(os.tmpdir(), `singularity-flow-${user}`);
  const directory = path.join(base, 'git-facts', `v${FORMAT}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // A shared temporary directory: use only directories this user owns and nobody else can open.
  for (const owned of [...(configured ? [] : [base]), path.dirname(directory), directory]) {
    const info = lstatSync(owned);
    if (!info.isDirectory() || info.isSymbolicLink() || !ownedByUser(info)
        || (typeof process.getuid === 'function' && (info.mode & 0o077) !== 0)) return null;
  }
  return directory;
}

/** Load and use the session store for this process; true when it is on. */
export function installGitFactStore(env = process.env) {
  if (installed) return storeDirectory !== null;
  installed = true;
  try { storeDirectory = privateDirectory(env); } catch { storeDirectory = null; }
  if (!storeDirectory) return false;
  attachGitFactPersistence({ lookup, record, clear });
  process.once('exit', () => { try { flushGitFactStore(); } catch { /* Only a cache. */ } });
  return true;
}

function digest(text) {
  return createHash('sha256').update(text).digest('hex');
}

function commonDirectoryOf(request) {
  if (!commonDirectories.has(request.directory)) {
    commonDirectories.set(request.directory, gitFactCheckout(request.directory)?.commonDir ?? null);
  }
  return commonDirectories.get(request.directory);
}

function storeFile(commonDir) {
  return path.join(storeDirectory, `${digest(`${process.platform}\0${commonDir}`)}.json`);
}

function fresh(recordedAt, now = Date.now()) {
  return Number.isFinite(recordedAt) && now - recordedAt <= GIT_FACT_TTL_MS && recordedAt - now <= 60_000;
}

/** A stored entry in the exact shape this module writes, or null. */
function validEntry(value, now) {
  if (!value || typeof value !== 'object' || !/^[0-9a-f]{64}$/u.test(value.id ?? '')) return null;
  const { kind, status, stdout, stderr, recordedAt, files } = value;
  if (!STORED_KINDS.has(kind) || !(status === 0 || (status === 1 && STATUS_ONE_KINDS.has(kind)))) return null;
  if (typeof stdout !== 'string' || typeof stderr !== 'string' || stdout.length > MAXIMUM_TEXT_BYTES
      || stderr.length > MAXIMUM_TEXT_BYTES || !fresh(recordedAt, now)) return null;
  if (!Array.isArray(files) || files.length > MAXIMUM_FILES || (kind !== 'ref-format' && files.length === 0)) return null;
  for (const dependency of files) {
    if (!Array.isArray(dependency) || dependency.length !== 3 || typeof dependency[0] !== 'string'
        || !path.isAbsolute(dependency[0]) || typeof dependency[1] !== 'string' || ![0, 1, 2].includes(dependency[2])) return null;
  }
  return { id: value.id, kind, status, stdout, stderr, recordedAt, files: files.map((dependency) => [...dependency]) };
}

function readStore(file, commonDir) {
  const found = new Map();
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.nlink !== 1 || !ownedByUser(info) || info.size > MAXIMUM_FILE_BYTES
        || (typeof process.getuid === 'function' && (info.mode & 0o077) !== 0)) return found;
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    if (stored?.format !== FORMAT || stored.platform !== process.platform || stored.commonDir !== commonDir
        || !Array.isArray(stored.entries)) return found;
    const now = Date.now();
    for (const value of stored.entries) {
      const entry = validEntry(value, now);
      if (entry) found.set(entry.id, entry);
    }
  } catch { /* Absent, unreadable or damaged: nothing stored. */ }
  return found;
}

function storeFor(commonDir) {
  if (!stores.has(commonDir)) {
    const file = storeFile(commonDir);
    stores.set(commonDir, { file, entries: readStore(file, commonDir), changed: new Map() });
  }
  return stores.get(commonDir);
}

function lookup(request) {
  const commonDir = commonDirectoryOf(request);
  if (!commonDir) return null;
  const entry = storeFor(commonDir).entries.get(digest(request.key));
  if (!entry || entry.kind !== request.kind || !fresh(entry.recordedAt)) return null;
  return { files: entry.files, status: entry.status, stdout: entry.stdout, stderr: entry.stderr, recordedAt: entry.recordedAt };
}

/** Whether every dependency's timestamps are old enough that a change since could not hide. */
function settled(files, recordedAt) {
  const recordedNs = BigInt(Math.floor(recordedAt)) * 1_000_000n;
  const stamps = [];
  for (const [, value] of files) {
    const parts = value.split(':');
    // `ino:size:mtime:ctime`, `dir:ino:mtime:ctime`, `objects:newest:digest`; identity and absence have none.
    for (const stamp of value.startsWith('objects:') ? [parts[1]] : parts.slice(2)) {
      if (/^\d+$/u.test(stamp ?? '') && stamp !== '0') stamps.push(BigInt(stamp));
    }
  }
  const window = stamps.every((stamp) => stamp % 1_000_000_000n !== 0n) ? FINE_RACY_NS : COARSE_RACY_NS;
  return stamps.every((stamp) => recordedNs - stamp >= window);
}

function record(request, entry) {
  if (!STORED_KINDS.has(request.kind)) return;
  if (entry.stdout.length > MAXIMUM_TEXT_BYTES || entry.stderr.length > MAXIMUM_TEXT_BYTES) return;
  if (entry.files.length > MAXIMUM_FILES || !settled(entry.files, entry.recordedAt)) return;
  const commonDir = commonDirectoryOf(request);
  if (!commonDir) return;
  const store = storeFor(commonDir);
  const stored = { id: digest(request.key), kind: request.kind, ...entry, files: entry.files.map((dependency) => [...dependency]) };
  store.entries.set(stored.id, stored);
  store.changed.set(stored.id, stored);
}

function clear() {
  stores.clear();
  commonDirectories.clear();
}

/** Merge this process's new answers into each repository's store file. */
export function flushGitFactStore() {
  if (!storeDirectory) return;
  const now = Date.now();
  const stats = new Map();
  const current = (file, mode) => {
    const key = `${mode}\0${file}`;
    if (!stats.has(key)) stats.set(key, gitFactFingerprint(file, mode));
    return stats.get(key);
  };
  for (const [commonDir, store] of stores) {
    if (!store.changed.size) continue;
    const merged = readStore(store.file, commonDir);
    for (const [id, entry] of store.changed) {
      if (!merged.has(id) || merged.get(id).recordedAt < entry.recordedAt) merged.set(id, entry);
    }
    // Keep only answers that are still current, newest first, within the size budget.
    const kept = [];
    let bytes = 0;
    for (const entry of [...merged.values()].sort((left, right) => right.recordedAt - left.recordedAt)) {
      if (!fresh(entry.recordedAt, now) || !entry.files.every(([file, value, mode]) => current(file, mode) === value)) continue;
      const size = JSON.stringify(entry).length;
      if (kept.length >= MAXIMUM_STORED_ENTRIES || bytes + size > MAXIMUM_FILE_BYTES - 4096) break;
      kept.push(entry);
      bytes += size;
    }
    const temporary = path.join(storeDirectory, `.${path.basename(store.file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify({ format: FORMAT, platform: process.platform, commonDir, entries: kept }),
        { flag: 'wx', mode: 0o600 });
      renameSync(temporary, store.file);
      store.changed.clear();
    } catch {
      try { unlinkSync(temporary); } catch { /* never written */ }
    }
  }
  prune(now);
}

/** Every ten minutes at most, remove stores and leftovers nobody has written for twenty. */
function prune(now) {
  const marker = path.join(storeDirectory, '.pruned');
  try {
    if (now - lstatSync(marker).mtimeMs < PRUNE_EVERY_MS) return;
  } catch { /* Never pruned. */ }
  try {
    writeFileSync(marker, '', { mode: 0o600 });
    for (const name of readdirSync(storeDirectory)) {
      if (!name.endsWith('.json') && !name.endsWith('.tmp')) continue;
      const file = path.join(storeDirectory, name);
      const info = lstatSync(file);
      if (info.isFile() && now - info.mtimeMs > PRUNE_AFTER_MS) unlinkSync(file);
    }
  } catch { /* Only a cache. */ }
}
