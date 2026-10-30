/**
 * Shared routine verification results, not authorization or lifecycle receipts.
 * Explicitly selected entry/read operations alone opt in. Publication, approval, tests,
 * worktree scope, and source/evidence validation continue through their fresh owners.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { serialize, deserialize } from 'node:v8';
import path from 'node:path';
import { freshGitFactsRequired, gitFactCheckout, gitFactFingerprint, gitFactRequest, gitFactSnapshot } from './git-fact-cache.mjs';
import { repositoryCheckKey, repositoryCheckSettings, repositoryCheckPreferencesFile } from './repository-check-settings.mjs';
import { operationContext } from './operation-context.mjs';
import { incrementCommandCounter } from './dx-timing-context.mjs';
import { BUILD_INFO } from './build-info.mjs';

const FORMAT = 1;
export const PROJECTION_RECORD_FORMAT = FORMAT;
const MAXIMUM_BYTES = 12 * 1024 * 1024;
const MAXIMUM_PAYLOAD_BYTES = 8 * 1024 * 1024;
const PROVENANCE_KINDS = new Set(['accepted-workflow', 'story-rejection-audit']);
const refresh = new AsyncLocalStorage();
const observations = new Map();
const pending = new Map();
const ROUTINE = new Set(['phase.enter', 'phase.enter.compose', 'nextsteps', 'session.open',
  'session.open-local', 'session.current', 'session.status', 'session.context', 'check']);
// The refresh flag is how a replayed read finds its own record, so it stays out of the record key.
const PRESENTATION_ENV = new Set(['_', 'SHLVL', 'NODE_COMPILE_CACHE', 'SINGULARITY_FLOW_AGENT_OUTPUT',
  'SINGULARITY_FLOW_OUTPUT_TIMING', 'SINGULARITY_FLOW_PROGRESS', 'SINGULARITY_FLOW_REFUSAL_ENVELOPE',
  'SINGULARITY_FLOW_INDEX_REFRESH']);
/**
 * Browsing projections that serve last-known state (SDA §8, M2). An expired record is served at once
 * as `stale` while a replay of its read refreshes it; a refresh the authority cannot answer keeps the
 * record as `refresh-failed` with the real error. Verification results (every other kind) never do:
 * an expired or disproved one is recomputed, and its refusal stands.
 */
export const LAST_KNOWN_KINDS = Object.freeze(['session-listing', 'story-intake-catalog']);
const lastKnownKinds = new Set(LAST_KNOWN_KINDS);
const HOST_ENV = /^(?:GIT_|SINGULARITY_FLOW_|LC_|PATH$|HOME$|USERPROFILE$|HOMEDRIVE$|HOMEPATH$|XDG_CONFIG_HOME$|LANG$|DEVELOPER_DIR$|SYSTEMROOT$|PROGRAMDATA$|COMSPEC$)/iu;

export function routineRepositoryChecksAllowed() {
  const context = operationContext();
  return Boolean(context && context.operationStack.every(id => ROUTINE.has(id)));
}

export function withFreshRepositoryChecks(callback) { return refresh.run({ roots: new Set() }, callback); }

function cacheDirectory(root) {
  const checkout = gitFactCheckout(root);
  return checkout ? path.join(checkout.gitDir, 'singularity-flow', 'cache', 'repository-checks') : null;
}

function owned(info) {
  return !info.isSymbolicLink() && (typeof process.getuid !== 'function'
    || info.uid === process.getuid() && (info.mode & 0o077) === 0);
}

function safeDirectory(directory) {
  try {
    const info = lstatSync(directory);
    if (!info.isDirectory() || !owned(info)) return false;
    for (const parent of [path.dirname(directory), path.dirname(path.dirname(directory))]) {
      const stat = lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()
          || typeof process.getuid === 'function' && (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0)) return false;
    }
    return true;
  } catch { return false; }
}

async function prepareDirectory(directory) {
  // Do not recursively follow a pre-existing cache-parent symlink before checking it.
  for (const parent of [path.dirname(path.dirname(directory)), path.dirname(directory), directory]) {
    try { await mkdir(parent, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = lstatSync(parent);
    if (!info.isDirectory() || info.isSymbolicLink()
        || typeof process.getuid === 'function' && (info.uid !== process.getuid() || (info.mode & 0o022) !== 0)) return false;
  }
  return safeDirectory(directory);
}

function readJson(file, maximum = MAXIMUM_BYTES) {
  let fd;
  try {
    if (!safeDirectory(path.dirname(file))) return null;
    const info = lstatSync(file);
    if (!info.isFile() || !owned(info) || info.nlink !== 1 || info.size > maximum) return null;
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || !owned(opened) || opened.size > maximum || opened.ino !== info.ino) return null;
    return JSON.parse(readFileSync(fd, 'utf8'));
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * A verified record for this key, whatever its age or dependencies. A negative age (the clock moved
 * back) or a payload that fails its digest is no record at all, so it can never be served.
 * `decode: false` verifies the payload without deserializing it, for a reader of the record alone.
 */
export function readProjectionRecord(file, key, now = Date.now(), { decode = true } = {}) {
  const record = readJson(file);
  if (!record) return null;
  const age = now - record.checkedAt;
  if (record.format !== FORMAT || (key !== null && record.key !== key) || !Number.isFinite(age) || age < 0
      || typeof record.payload !== 'string' || typeof record.sha256 !== 'string') return null;
  try {
    const payload = Buffer.from(record.payload, 'base64');
    if (createHash('sha256').update(payload).digest('hex') !== record.sha256) return null;
    return { value: decode ? deserialize(payload) : undefined, checkedAt: record.checkedAt, stamp: record.stamp, age,
      sha256: record.sha256, authority: record.authority ?? null, acceptedRevision: acceptedRevisionOf(record.acceptedRevision),
      kind: record.kind ?? null, refresh: record.refresh ?? null, bytes: payload.byteLength };
  } catch { return null; }
}

const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/**
 * The shared revision a last-known record was computed from (SDA §14 `acceptedRevision`): the
 * ledger snapshot commit a Story list read, the configuration authority commit a catalog read.
 * Null when neither is known, as for a record an older build wrote.
 */
function acceptedRevisionOf(value) {
  const commit = (candidate) => typeof candidate === 'string' && COMMIT_ID.test(candidate) ? candidate : null;
  const ledgerCommit = commit(value?.ledgerCommit);
  const authorityCommit = commit(value?.authorityCommit);
  return ledgerCommit || authorityCommit ? { ledgerCommit, authorityCommit } : null;
}

/** Each remote URL a checkout's Git configuration names, read from the file with no Git process. */
export function configuredRemoteUrls(root) {
  const checkout = gitFactCheckout(root);
  if (!checkout) return null;
  let text = '';
  try { text = readFileSync(path.join(checkout.commonDir, 'config'), 'utf8'); } catch { /* no configuration, no remote */ }
  const remotes = [];
  let section = null;
  for (const line of text.split(/\r?\n/u)) {
    const header = /^\s*\[\s*remote\s+"([^"]*)"\s*\]/u.exec(line);
    if (header) { section = header[1]; continue; }
    if (/^\s*\[/u.test(line)) { section = null; continue; }
    const url = section === null ? null : /^\s*(url|pushurl)\s*=\s*(.*?)\s*$/iu.exec(line);
    if (url) remotes.push({ remote: section, key: url[1].toLowerCase(), url: url[2] });
  }
  return remotes;
}

/**
 * Which authority a last-known record answers for: the repositories it was read in and the remote
 * URLs their Git configuration names, read from the files with no Git process. A changed remote or
 * another selected repository ends last-known eligibility (SDA §8: an authority change).
 */
export function remoteAuthority(roots) {
  const remotes = [];
  for (const root of new Set(roots.filter(Boolean).map((entry) => path.resolve(entry)))) {
    const configured = configuredRemoteUrls(root);
    if (!configured) { remotes.push([root, null, null, null]); continue; }
    for (const entry of configured) remotes.push([root, entry.remote, entry.key, entry.url]);
  }
  return repositoryCheckKey(remotes.map((entry) => JSON.stringify(entry)).sort());
}

function freshRecord(found, stamp, settings) {
  return Boolean(found && stamp && found.stamp === stamp
    && !(settings.mode === 'cached' && found.age >= settings.intervalMinutes * 60_000));
}

/** The refresh lease and the last refresh attempt sit beside their record. */
export function projectionSidecars(file) {
  const base = file.replace(/\.json$/u, '');
  return { lease: `${base}.lease`, attempt: `${base}.refresh.json` };
}

/** What the last refresh of a record did: when a background one started, and the error a failed one kept. */
export function readRefreshAttempt(file) {
  const attempt = readJson(projectionSidecars(file).attempt, 64 * 1024);
  return attempt?.format === FORMAT ? attempt : null;
}

async function pruneProvenanceSlots(directory, prefix, current) {
  const candidates = [];
  for (const name of await readdir(directory)) {
    if (!name.startsWith(prefix) || !/^[a-f0-9]{64}\.json$/u.test(name.slice(prefix.length))) continue;
    const file = path.join(directory, name);
    try {
      const info = lstatSync(file);
      if (info.isFile() && owned(info) && info.nlink === 1) candidates.push({ file, modified: info.mtimeMs });
    } catch { /* Another request can retire a cache slot concurrently. */ }
  }
  candidates.sort((a, b) => Number(b.file === current) - Number(a.file === current) || b.modified - a.modified);
  for (const entry of candidates.slice(4)) await unlink(entry.file).catch(() => {});
}

/** No Git processes: reuse the existing cross-platform HEAD/config/object visibility observers. */
function dependencyStamp(root, files, env, advisoryPreview = false, metadataOnly = false, directory = cacheDirectory(root)) {
  const request = gitFactRequest(advisoryPreview ? ['rev-parse', 'HEAD'] : ['log', '--format=%H', 'HEAD', '--', '.'], { cwd: root, env });
  const observed = metadataOnly ? new Map() : gitFactSnapshot(request);
  if (!observed || [...observed.values()].some(value => value === null)) return null;
  const checkout = gitFactCheckout(root);
  for (const file of [...(metadataOnly ? [] : [path.join(checkout.gitDir, 'index')]),
    path.join(directory, 'refresh'),
    ...files]) {
    const stamp = gitFactFingerprint(file);
    if (stamp === null) return null;
    observed.set(file, stamp);
  }
  return repositoryCheckKey([...observed]);
}

/**
 * `freshness` (SDA §8): `fresh` within the interval or just verified, `stale` past it and served while
 * a refresh runs behind it, `refresh-failed` when the authority could not be reached (`refreshError`
 * keeps why). Records are stored only complete, so a served record is `complete`. `acceptedRevision`
 * is the shared revision the record was computed from (SDA §14).
 */
function observe(root, settings, source, checkedAt, reason = null, consistency = null) {
  const result = { mode: settings.mode, intervalMinutes: settings.intervalMinutes, source,
    checkedAt: new Date(checkedAt).toISOString(), ageMs: Math.max(0, Date.now() - checkedAt),
    ...(reason ? { reason } : {}), ...(consistency ?? {}), scope: 'accepted-workflow-configuration',
    refresh: { command: 'singularity-flow check --json', copilotCommand: '/sf-check', modelFreeCommand: '@sflow /check' } };
  if (observations.size >= 512) observations.clear();
  observations.set(path.resolve(root), result);
  return result;
}

export function repositoryCheckStatus(root) {
  const known = observations.get(path.resolve(root));
  return known ? { ...known, ageMs: Math.max(0, Date.now() - Date.parse(known.checkedAt)) }
    : { ...repositoryCheckSettings(root), source: 'fresh-only', scope: 'accepted-workflow-configuration',
      reason: 'No reusable accepted-snapshot verification was needed by this request.',
      refresh: { command: 'singularity-flow check --json', copilotCommand: '/sf-check', modelFreeCommand: '@sflow /check' } };
}

/** Successes only. A change during verification is never published as a reusable observation. */
export async function cachedRepositoryCheck(root, { kind, identity, files = [], env = process.env }, verify) {
  if (!routineRepositoryChecksAllowed()) return verify();
  return cachedCheck(root, { kind, identity, files, env }, verify);
}

/** Advisory intake only. Never consumed as publication, test or approval authority. */
export async function cachedStoryReadinessPreview(root, { identity, files = [], env = process.env, settingsRoot = root }, verify) {
  return cachedCheck(root, { kind: 'story-readiness-preview', identity, files, env, settingsRoot,
    accept: value => value?.preflight?.passed === true }, verify);
}

/** Selection inventory only. A complete catalog is still not Story-start authority. */
export async function cachedStoryIntakeCatalog(root, { identity, files = [], env = process.env, settingsRoot = root, refreshRecipe = null }, verify) {
  return cachedCheck(root, { kind: 'story-intake-catalog', identity, files, env, settingsRoot, refreshRecipe,
    revision: value => ({ authorityCommit: value?.intake?.authorityCommit }),
    accept: value => value?.choicesComplete === true && Array.isArray(value.intake?.storyWorkflows)
      && !value.unreachable?.length && !value.intake.workflowReason && !value.intake.workflowCatalogReason }, verify);
}

/** Where the session listings of this machine are kept. */
export function sessionListingDirectory(env = process.env) {
  return path.join(path.dirname(repositoryCheckPreferencesFile(env)), 'cache', 'session-listings');
}

/** The repository-check projections of the checkout at `root`, or null outside one. */
export function repositoryCheckDirectory(root) { return cacheDirectory(root); }

/** Browsing only, including metadata-only workspace repositories. Never an attachment proof. */
export async function cachedSessionListing(root, { identity, files = [], env = process.env, settingsRoot = root, refreshRecipe = null }, verify) {
  return cachedCheck(root, { kind: 'session-listing', identity, files, env, settingsRoot, metadataOnly: true, refreshRecipe,
    storageDirectory: sessionListingDirectory(env),
    partition: repositoryCheckKey(identity), firstReadLocal: true,
    revision: value => ({ ledgerCommit: value?.discovered?.ledgerCommit }),
    accept: value => Array.isArray(value?.discovered?.items) && value.discovered.count === value.discovered.items.length
      && !value.discovered.unavailableCount && !value.discovered.unavailable?.length
      // Read from the remote only because the clone was unreadable: never reused once it is readable.
      && value.discovered.localClone?.available !== false }, verify);
}

async function cachedCheck(root, { kind, identity, files, env, settingsRoot = root, accept = () => true,
  metadataOnly = false, storageDirectory = null, partition = null, firstReadLocal = false, refreshRecipe = null,
  revision = () => null }, verify) {
  const settings = repositoryCheckSettings(settingsRoot, { env });
  const advisoryPreview = metadataOnly || kind === 'story-readiness-preview' || kind === 'story-intake-catalog';
  const lastKnown = lastKnownKinds.has(kind);
  // A replayed read (index-refresh-launcher.mjs) recomputes its record and never serves it.
  const replay = lastKnown && env.SINGULARITY_FLOW_INDEX_REFRESH === '1';
  const directory = storageDirectory ?? cacheDirectory(root);
  const explicit = Boolean(refresh.getStore());
  const forced = Boolean(explicit || freshGitFactsRequired() || replay);
  // Invalidate the old observation before an explicit check. If that check refuses, the next
  // routine entry must not silently resurrect the successful observation it just disproved.
  if (refresh.getStore() && directory && !refresh.getStore().roots.has(directory)) {
    refresh.getStore().roots.add(directory);
    try {
      if (await prepareDirectory(directory)) {
        const temporary = path.join(directory, `.${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, randomUUID(), { flag: 'wx', mode: 0o600 });
          await rename(temporary, path.join(directory, 'refresh'));
        } finally { await unlink(temporary).catch(() => {}); }
      }
    } catch { /* Refresh still runs the original verifier if cache invalidation is unavailable. */ }
  }
  if (advisoryPreview && settings.mode === 'always' && !lastKnown) {
    incrementCommandCounter('repository-checks.refreshes');
    const value = await verify();
    observe(root, settings, 'fresh', Date.now());
    return value;
  }
  const runtime = { node: process.versions.node, v8: process.versions.v8, platform: process.platform, arch: process.arch };
  const key = repositoryCheckKey({ format: FORMAT, root: path.resolve(root), build: BUILD_INFO, runtime, kind, identity,
    // Includes machine/environment inputs without writing credentials or raw environment values.
    environment: repositoryCheckKey(Object.entries(env).filter(([name]) => HOST_ENV.test(name) && !PRESENTATION_ENV.has(name))
      .sort(([a], [b]) => a.localeCompare(b))) });
  const observeStamp = () => directory ? dependencyStamp(root, files, env, advisoryPreview, metadataOnly, directory) : null;
  let stamp = observeStamp();
  // Four exact provenance identities prevent raw/normalized input thrashing without unbounded storage.
  const provenancePrefix = PROVENANCE_KINDS.has(kind) ? `provenance-${repositoryCheckKey(kind).slice(0, 16)}-` : null;
  const file = directory ? path.join(directory, provenancePrefix ? `${provenancePrefix}${key}.json`
    : `${repositoryCheckKey({ kind, runtime, ...(partition ? { partition } : {}) })}.json`) : null;
  let missing = false;
  try { if (file) lstatSync(file); } catch (error) { missing = error.code === 'ENOENT'; }
  // Last-known kinds read their record whatever its age; verification kinds only when it may be a hit.
  const found = file && (lastKnown || !forced && settings.mode !== 'always' && stamp) ? readProjectionRecord(file, key) : null;
  const authority = lastKnown ? remoteAuthority([root, settingsRoot]) : null;
  // Only a record of this same authority may stand in for a refresh.
  const lastKnownRecord = lastKnown && found?.authority === authority ? found : null;
  if (!forced && settings.mode !== 'always' && freshRecord(found, stamp, settings)) {
    incrementCommandCounter('repository-checks.hits');
    observe(root, settings, 'cache', found.checkedAt, null, lastKnown
      ? { freshness: 'fresh', completeness: 'complete', acceptedRevision: found.acceptedRevision } : null);
    return found.value;
  }
  // Expired, with nothing it depends on changed here: serve it now and refresh behind it (SDA §17:
  // an expired advisory read never waits on the network). A failed refresh keeps its error beside it.
  if (lastKnownRecord && !forced && settings.mode === 'cached' && stamp && found.stamp === stamp) {
    const attempt = readRefreshAttempt(file);
    const failed = attempt?.error && Date.parse(attempt.failedAt ?? '') > found.checkedAt ? attempt : null;
    incrementCommandCounter('repository-checks.last-known');
    observe(root, settings, 'last-known', found.checkedAt, null, { freshness: failed ? 'refresh-failed' : 'stale',
      completeness: 'complete', acceptedRevision: found.acceptedRevision,
      ...(failed ? { refreshError: failed.error, refreshFailedAt: failed.failedAt } : {}),
      backgroundRefresh: await (await import('./projection-refresh.mjs')).refreshBehind(directory, file, refreshRecipe, env, found) });
    return found.value;
  }
  // Coalesce only an identical immutable/configuration read, never whole commands or worktree state.
  const pendingKey = `${file}:${key}:${stamp}:${forced ? randomUUID() : 'routine'}`;
  if (pending.has(pendingKey)) return deserialize(serialize(await pending.get(pendingKey)));
  const compute = async () => {
    incrementCommandCounter('repository-checks.refreshes');
    const value = firstReadLocal ? await verify({ allowLocal: missing && !forced && settings.mode !== 'always' }) : await verify();
    const checkedAt = Date.now();
    observe(root, settings, 'fresh', checkedAt, stamp ? null : 'Dependency observation unavailable; verification was fresh.',
      lastKnown ? { freshness: 'fresh', completeness: accept(value) ? 'complete' : 'partial',
        acceptedRevision: acceptedRevisionOf(revision(value)) } : null);
    if (!accept(value) || !stamp || observeStamp() !== stamp) return value;
    let temporary;
    try {
      if (typeof value?.bytes === 'number' && value.bytes > MAXIMUM_PAYLOAD_BYTES) return value;
      if (!await prepareDirectory(directory)) return value;
      const payload = serialize(value);
      if (payload.byteLength > MAXIMUM_PAYLOAD_BYTES) return value;
      const record = JSON.stringify({ format: FORMAT, key, stamp, checkedAt,
        kind, ...(lastKnown ? { authority, acceptedRevision: acceptedRevisionOf(revision(value)),
          ...(refreshRecipe ? { refresh: refreshRecipe } : {}) } : {}),
        sha256: createHash('sha256').update(payload).digest('hex'), payload: payload.toString('base64') });
      if (Buffer.byteLength(record) > MAXIMUM_BYTES) return value;
      temporary = path.join(directory, `.${randomUUID()}.tmp`);
      // schema-transient: bounded private acceleration cache, never authority or lifecycle state.
      await writeFile(temporary, record, { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
      if (provenancePrefix) await pruneProvenanceSlots(directory, provenancePrefix, file);
    } catch { /* An unavailable cache never blocks the original verification. */ }
    finally { if (temporary) await unlink(temporary).catch(() => {}); }
    return value;
  };
  // The refresh machinery loads only for a last-known record that must be recomputed.
  const promise = lastKnown && file
    ? import('./projection-refresh.mjs').then(({ coalescedRefresh }) => coalescedRefresh({
      root, settings, directory, file, key, authority, explicit, replay, found: lastKnownRecord, observeStamp, observe, prepareDirectory,
      restamp: (next) => { stamp = next; }
    }, compute))
    : compute();
  pending.set(pendingKey, promise);
  try { return await promise; } finally { pending.delete(pendingKey); }
}
