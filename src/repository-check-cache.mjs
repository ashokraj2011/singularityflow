/**
 * Shared routine verification results, not authorization or lifecycle receipts.
 * Explicitly selected entry/read operations alone opt in. Publication, approval, tests,
 * worktree scope, and source/evidence validation continue through their fresh owners.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { serialize, deserialize } from 'node:v8';
import path from 'node:path';
import { freshGitFactsRequired, gitFactCheckout, gitFactFingerprint, gitFactRequest, gitFactSnapshot } from './git-fact-cache.mjs';
import { repositoryCheckKey, repositoryCheckSettings } from './repository-check-settings.mjs';
import { operationContext } from './operation-context.mjs';
import { incrementCommandCounter } from './dx-timing-context.mjs';
import { BUILD_INFO } from './build-info.mjs';

const FORMAT = 1;
const MAXIMUM_BYTES = 12 * 1024 * 1024;
const MAXIMUM_PAYLOAD_BYTES = 8 * 1024 * 1024;
const refresh = new AsyncLocalStorage();
const observations = new Map();
const pending = new Map();
const ROUTINE = new Set(['phase.enter', 'phase.enter.compose', 'nextsteps', 'session.open',
  'session.open-local', 'session.current', 'session.status', 'session.context', 'check']);
const PRESENTATION_ENV = new Set(['_', 'SHLVL', 'NODE_COMPILE_CACHE', 'SINGULARITY_FLOW_AGENT_OUTPUT',
  'SINGULARITY_FLOW_OUTPUT_TIMING', 'SINGULARITY_FLOW_PROGRESS']);
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

function readCache(file, key, stamp, settings, now) {
  let fd;
  try {
    if (!safeDirectory(path.dirname(file))) return null;
    const info = lstatSync(file);
    if (!info.isFile() || !owned(info) || info.nlink !== 1 || info.size > MAXIMUM_BYTES) return null;
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || !owned(opened) || opened.size > MAXIMUM_BYTES || opened.ino !== info.ino) return null;
    const record = JSON.parse(readFileSync(fd, 'utf8'));
    const age = now - record.checkedAt;
    if (record.format !== FORMAT || record.key !== key || record.stamp !== stamp
        || !Number.isFinite(age) || age < 0
        || settings.mode === 'cached' && age >= settings.intervalMinutes * 60_000
        || typeof record.payload !== 'string' || typeof record.sha256 !== 'string') return null;
    const payload = Buffer.from(record.payload, 'base64');
    if (createHash('sha256').update(payload).digest('hex') !== record.sha256) return null;
    return { value: deserialize(payload), checkedAt: record.checkedAt };
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** No Git processes: reuse the existing cross-platform HEAD/config/object visibility observers. */
function dependencyStamp(root, files, env, advisoryPreview = false) {
  const request = gitFactRequest(advisoryPreview ? ['rev-parse', 'HEAD'] : ['log', '--format=%H', 'HEAD', '--', '.'], { cwd: root, env });
  const observed = gitFactSnapshot(request);
  if (!observed || [...observed.values()].some(value => value === null)) return null;
  const checkout = gitFactCheckout(root);
  for (const file of [path.join(checkout.gitDir, 'index'),
    path.join(checkout.gitDir, 'singularity-flow', 'cache', 'repository-checks', 'refresh'),
    ...files]) {
    const stamp = gitFactFingerprint(file);
    if (stamp === null) return null;
    observed.set(file, stamp);
  }
  return repositoryCheckKey([...observed]);
}

function observe(root, settings, source, checkedAt, reason = null) {
  const result = { mode: settings.mode, intervalMinutes: settings.intervalMinutes, source,
    checkedAt: new Date(checkedAt).toISOString(), ageMs: Math.max(0, Date.now() - checkedAt),
    ...(reason ? { reason } : {}), scope: 'accepted-workflow-configuration',
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

async function cachedCheck(root, { kind, identity, files, env, settingsRoot = root, accept = () => true }, verify) {
  const settings = repositoryCheckSettings(settingsRoot, { env });
  const advisoryPreview = kind === 'story-readiness-preview';
  const directory = cacheDirectory(root);
  const forced = Boolean(refresh.getStore() || freshGitFactsRequired());
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
  if (advisoryPreview && settings.mode === 'always') {
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
  const stamp = directory ? dependencyStamp(root, files, env, advisoryPreview) : null;
  const file = directory ? path.join(directory, `${repositoryCheckKey({ kind, runtime })}.json`) : null;
  const cached = !forced && settings.mode !== 'always' && stamp
    ? readCache(file, key, stamp, settings, Date.now()) : null;
  if (cached) {
    incrementCommandCounter('repository-checks.hits');
    observe(root, settings, 'cache', cached.checkedAt);
    return cached.value;
  }
  // Coalesce only an identical immutable/configuration read, never whole commands or worktree state.
  const pendingKey = `${file}:${key}:${stamp}:${forced ? randomUUID() : 'routine'}`;
  if (pending.has(pendingKey)) return deserialize(serialize(await pending.get(pendingKey)));
  const compute = async () => {
    incrementCommandCounter('repository-checks.refreshes');
    const value = await verify();
    const checkedAt = Date.now();
    observe(root, settings, 'fresh', checkedAt, stamp ? null : 'Dependency observation unavailable; verification was fresh.');
    if (!accept(value) || !stamp || dependencyStamp(root, files, env, advisoryPreview) !== stamp) return value;
    let temporary;
    try {
      if (typeof value?.bytes === 'number' && value.bytes > MAXIMUM_PAYLOAD_BYTES) return value;
      if (!await prepareDirectory(directory)) return value;
      const payload = serialize(value);
      if (payload.byteLength > MAXIMUM_PAYLOAD_BYTES) return value;
      const record = JSON.stringify({ format: FORMAT, key, stamp, checkedAt,
        sha256: createHash('sha256').update(payload).digest('hex'), payload: payload.toString('base64') });
      if (Buffer.byteLength(record) > MAXIMUM_BYTES) return value;
      temporary = path.join(directory, `.${randomUUID()}.tmp`);
      // schema-transient: bounded private acceleration cache, never authority or lifecycle state.
      await writeFile(temporary, record, { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
    } catch { /* An unavailable cache never blocks the original verification. */ }
    finally { if (temporary) await unlink(temporary).catch(() => {}); }
    return value;
  };
  const promise = compute(); pending.set(pendingKey, promise);
  try { return await promise; } finally { pending.delete(pendingKey); }
}
