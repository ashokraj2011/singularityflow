/**
 * Reference repositories fetched while the person is still describing the Story. `[perf]`
 *
 * A Story's read-only references were fetched inside Start: for the measured Story an 11 MiB
 * depth-1 pack, several seconds of the start. The intake form knows a reference as soon as its row
 * is complete, so the same depth-1 fetch can run then, into a machine-local store keyed by the
 * repository and the exact commit. Start still resolves every pin itself and, when the store holds
 * exactly that commit, fetches it from there instead of from the network. Git verifies the identity
 * of every object on that local fetch, and the tree-safety checks, detached checkout and
 * verification run exactly as before. The store is only an accelerator: anything missing,
 * incomplete or different is fetched from the network as it always was.
 *
 * Layout: `<git-common-dir>/singularity-flow/reference-prefetch/v1/<key>/` holds a bare repository
 * and a plain-text completion marker written last. A fill works in a private directory and renames
 * it into place, so a crash leaves only an abandoned fill directory, which is removed later. At
 * most eight entries and 512 MiB are kept, least recently used first out.
 */
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { incrementCommandCounter } from './dx-command-timing.mjs';
import { gitTimeouts, runRemoteGitAsync } from './git-execution.mjs';
import { assertCredentialFreeRemote, frozenRemoteTransport, remoteFingerprint } from './git-remote-diagnostics.mjs';
import { prepareSharedPublicationStorage, sharedPublicationStorageDirectory } from './publication-storage.mjs';
import { run } from './util.mjs';

export const REFERENCE_PREFETCH_MAX_ENTRIES = 8;
export const REFERENCE_PREFETCH_MAX_BYTES = 512 * 1024 * 1024;
const DIRECTORY = 'reference-prefetch';
const VERSION = 'v1';
const MARKER = 'COMPLETE';
const PIN_REF = 'refs/prefetch/pin';
const ABANDONED_FILL_MS = 30 * 60_000;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const ENTRY = /^[0-9a-f]{40}$/u;

function entryKey(repository, commit) {
  return createHash('sha256').update(`${remoteFingerprint(repository)}\0${commit}`).digest('hex').slice(0, 40);
}

async function realDirectory(target) {
  const info = await lstat(target).catch(() => null);
  return Boolean(info?.isDirectory() && !info.isSymbolicLink());
}

async function directoryBytes(target) {
  let total = 0;
  for (const entry of await readdir(target, { withFileTypes: true }).catch(() => [])) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(child);
    else if (entry.isFile()) total += (await stat(child).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

function parseMarker(text) {
  const fields = Object.fromEntries(String(text).split('\n').filter(Boolean).map((line) => {
    const space = line.indexOf(' ');
    return space < 0 ? [line, ''] : [line.slice(0, space), line.slice(space + 1)];
  }));
  return { commit: fields.commit ?? null, repository: fields.repository ?? null, bytes: Number(fields.bytes) };
}

async function completeEntry(entryDirectory, repository, commit) {
  if (!await realDirectory(entryDirectory)) return null;
  const marker = await readFile(path.join(entryDirectory, MARKER), 'utf8').catch(() => null);
  if (marker === null) return null;
  const parsed = parseMarker(marker);
  if (parsed.commit !== commit || parsed.repository !== `sha256:${remoteFingerprint(repository)}`) return null;
  const bare = path.join(entryDirectory, 'repository');
  return await realDirectory(bare) ? { bare, bytes: parsed.bytes } : null;
}

/** The stored copy of exactly this commit of exactly this repository, if one is complete. */
export async function prefetchedReferenceSource(root, { repository, commit }) {
  if (!OBJECT_ID.test(String(commit ?? ''))) return null;
  let url;
  try { url = assertCredentialFreeRemote(repository); } catch { return null; }
  const store = path.join(sharedPublicationStorageDirectory(root, DIRECTORY), VERSION);
  const entryDirectory = path.join(store, entryKey(url, commit));
  const entry = await completeEntry(entryDirectory, url, commit).catch(() => null);
  if (!entry) return null;
  // Most recently used entries survive pruning.
  const now = new Date();
  await utimes(path.join(entryDirectory, MARKER), now, now).catch(() => {});
  return entry.bare;
}

/** Keep the newest complete entries within the entry and byte bounds; drop abandoned fills. */
async function prune(store, now = Date.now()) {
  const names = await readdir(store).catch(() => []);
  const complete = [];
  for (const name of names) {
    const target = path.join(store, name);
    if (name.startsWith('.fill-')) {
      const info = await lstat(target).catch(() => null);
      if (info && now - info.mtimeMs > ABANDONED_FILL_MS) await rm(target, { recursive: true, force: true });
      continue;
    }
    if (!ENTRY.test(name)) continue;
    const marker = await stat(path.join(target, MARKER)).catch(() => null);
    if (!marker) {
      await rm(target, { recursive: true, force: true });
      continue;
    }
    const parsed = parseMarker(await readFile(path.join(target, MARKER), 'utf8').catch(() => ''));
    complete.push({ target, used: marker.mtimeMs, bytes: Number.isFinite(parsed.bytes) ? parsed.bytes : 0 });
  }
  complete.sort((left, right) => right.used - left.used);
  let bytes = 0;
  for (const [index, entry] of complete.entries()) {
    bytes += entry.bytes;
    if (index >= REFERENCE_PREFETCH_MAX_ENTRIES || bytes > REFERENCE_PREFETCH_MAX_BYTES) {
      await rm(entry.target, { recursive: true, force: true });
      incrementCommandCounter('reference.prefetch-evicted');
    }
  }
}

/**
 * Fetch exactly this commit of this repository into the store, unless it is already there.
 * Never throws for a network or storage problem: the start simply fetches as it always did.
 */
export async function prefetchReferenceRepository(root, { repository, commit }, {
  env = process.env, runGit = runRemoteGitAsync
} = {}) {
  if (!OBJECT_ID.test(String(commit ?? ''))) return { status: 'declined', reason: 'commit' };
  let url;
  try { url = assertCredentialFreeRemote(repository); } catch { return { status: 'declined', reason: 'repository' }; }
  let store;
  try {
    store = path.join(await prepareSharedPublicationStorage(root, DIRECTORY, 'Reference prefetch'), VERSION);
    await mkdir(store, { recursive: true, mode: 0o700 });
    if (!await realDirectory(store)) return { status: 'declined', reason: 'storage' };
  } catch {
    return { status: 'declined', reason: 'storage' };
  }
  const key = entryKey(url, commit);
  const entryDirectory = path.join(store, key);
  if (await completeEntry(entryDirectory, url, commit)) {
    const now = new Date();
    await utimes(path.join(entryDirectory, MARKER), now, now).catch(() => {});
    return { status: 'present' };
  }
  const fill = path.join(store, `.fill-${key}-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    const bare = path.join(fill, 'repository');
    await mkdir(bare, { recursive: true, mode: 0o700 });
    run('git', ['init', '--bare', '--quiet', bare], { cwd: fill });
    const transport = frozenRemoteTransport(url, { env });
    const fetched = await runGit(['fetch', '--depth=1', '--no-tags', transport.remote, commit], {
      cwd: bare, env: transport.env, operation: 'remote-configuration',
      timeoutMs: gitTimeouts(env).configuration, allowFailure: true
    });
    if (fetched.status !== 0) {
      await rm(fill, { recursive: true, force: true });
      return { status: 'declined', reason: 'unreachable' };
    }
    // An advertised tip, so a later local fetch of this exact commit is an ordinary request.
    const pinned = run('git', ['update-ref', PIN_REF, commit], { cwd: bare, allowFailure: true });
    const present = run('git', ['cat-file', '-e', `${commit}^{commit}`], {
      cwd: bare, allowFailure: true, env: { ...process.env, GIT_NO_LAZY_FETCH: '1' }
    });
    if (pinned.status !== 0 || present.status !== 0) {
      await rm(fill, { recursive: true, force: true });
      return { status: 'declined', reason: 'incomplete' };
    }
    const bytes = await directoryBytes(bare);
    await writeFile(path.join(fill, MARKER),
      `commit ${commit}\nrepository sha256:${remoteFingerprint(url)}\nbytes ${bytes}\n`, { mode: 0o600 });
    try {
      await rename(fill, entryDirectory);
    } catch {
      // Another fill of the same commit finished first; either copy is the same objects.
      await rm(fill, { recursive: true, force: true });
      return { status: await completeEntry(entryDirectory, url, commit) ? 'present' : 'declined', reason: null };
    }
    incrementCommandCounter('reference.prefetch-filled');
    await prune(store);
    return { status: 'prefetched' };
  } catch {
    await rm(fill, { recursive: true, force: true }).catch(() => {});
    return { status: 'declined', reason: 'storage' };
  }
}

/** Whether any stored copy of this repository exists, so resolving its pin first is worth a listing. */
export async function hasPrefetchedReference(root, repository) {
  let url;
  try { url = assertCredentialFreeRemote(repository); } catch { return false; }
  const store = path.join(sharedPublicationStorageDirectory(root, DIRECTORY), VERSION);
  const names = await readdir(store).catch(() => []);
  const expected = `sha256:${remoteFingerprint(url)}`;
  for (const name of names) {
    if (!ENTRY.test(name)) continue;
    const marker = await readFile(path.join(store, name, MARKER), 'utf8').catch(() => null);
    if (marker && parseMarker(marker).repository === expected) return true;
  }
  return false;
}
