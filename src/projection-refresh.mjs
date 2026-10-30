/**
 * Refreshing a last-known projection (SDA §8, M2): the cross-process lease, the replay behind a stale
 * answer, and the last refresh attempt kept beside its record. Loaded only when a Story list or
 * intake catalog record must be recomputed or served stale, so a cache hit never pays for it, and by
 * a local read that reports where its repository's Story list stands (SDA §14, `lastKnownStoryList`).
 */
import { randomUUID } from 'node:crypto';
import { readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { incrementCommandCounter } from './dx-timing-context.mjs';
import {
  PROJECTION_RECORD_FORMAT as FORMAT, configuredRemoteUrls, projectionSidecars, readProjectionRecord, readRefreshAttempt,
  remoteAuthority, sessionListingDirectory
} from './repository-check-cache.mjs';
import { repositoryCheckSettings } from './repository-check-settings.mjs';

const REFRESH_LEASE_STALE_MS = 10 * 60_000;
// How long a read waits for another process's refresh of the same record before doing its own.
const COALESCE_WAIT_MS = 30_000;
// A failed background refresh is not started again for this long; reads keep serving last-known.
const BACKGROUND_RETRY_MS = 60_000;
const REFRESH_ERROR_CHARS = 600;

export async function writeRefreshAttempt(directory, file, update) {
  let temporary;
  try {
    const next = { ...(readRefreshAttempt(file) ?? {}), ...update, format: FORMAT };
    temporary = path.join(directory, `.${randomUUID()}.tmp`);
    // schema-transient: the last refresh attempt of a disposable projection; never authority.
    await writeFile(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
    await rename(temporary, projectionSidecars(file).attempt);
  } catch { /* Best effort: the record itself is unaffected. */ }
  finally { if (temporary) await unlink(temporary).catch(() => {}); }
}

/** Only an authority that could not be reached leaves last-known state standing; any other refusal is the answer. */
function authorityUnavailable(error) {
  const code = String(error?.code ?? '');
  return code === 'SESSION_STATE_REFRESH_UNAVAILABLE' || /^REMOTE_[A-Z0-9_]+$/u.test(code)
    || Boolean(error?.details?.remoteFailure);
}

/** The refusal a failed refresh would have been, bounded: its code, stage and Git diagnosis, never its raw output. */
function refreshError(error) {
  const remote = error?.details?.remoteFailure;
  return { code: String(error?.code ?? 'REFRESH_FAILED'),
    message: String(error?.message ?? error).replace(/\s+/gu, ' ').trim().slice(0, REFRESH_ERROR_CHARS),
    ...(error?.outcomeClass ? { outcomeClass: error.outcomeClass } : {}),
    ...(remote ? { remoteFailure: { stage: remote.stage ?? null, classification: remote.failure?.classification ?? null,
      code: remote.failure?.code ?? null, retryable: remote.failure?.retryable === true,
      timedOut: remote.evidence?.timedOut === true } } : {}) };
}

async function waitForRefreshLease(leaseFile, inspect, deadline) {
  while (Date.now() < deadline) {
    const state = await inspect(leaseFile).catch(() => ({ state: 'missing' }));
    if (state.state !== 'busy') return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Start one replay of the read behind a stale record, unless one runs or recently failed. */
export async function refreshBehind(directory, file, refreshRecipe, env, found) {
  if (String(env.SINGULARITY_FLOW_INDEX_REFRESH ?? '').toLowerCase() === 'off') return 'off';
  if (!refreshRecipe) return 'unavailable';
  try {
    const { inspectFileLease } = await import('./file-lease.mjs');
    if ((await inspectFileLease(projectionSidecars(file).lease)).state === 'busy') return 'in-flight';
    const attempt = readRefreshAttempt(file);
    const started = Date.parse(attempt?.backgroundStartedAt ?? '');
    if (Number.isFinite(started) && Date.now() - started >= 0 && Date.now() - started < BACKGROUND_RETRY_MS
        && started > found.checkedAt) return 'recently-started';
    const { launchIndexRefresh } = await import('./index-refresh-launcher.mjs');
    await writeRefreshAttempt(directory, file, { backgroundStartedAt: new Date().toISOString() });
    return launchIndexRefresh(refreshRecipe, env) ? 'started' : 'unavailable';
  } catch { return 'unavailable'; }
}

/**
 * One refresh per record across processes (SDA-AC-014). The refresh holds the record's lease; a
 * routine read that finds it held waits, then takes the record that refresh wrote when nothing it
 * depends on has changed since. An explicit refresh waits too, then makes its own observation. When
 * the authority cannot be reached, a record already held is served as `refresh-failed`.
 */
export async function coalescedRefresh({ root, settings, directory, file, key, authority, explicit, replay, found, observeStamp,
  observe, prepareDirectory, restamp }, compute) {
  const { lease: leaseFile } = projectionSidecars(file);
  // Another process's refresh answers this read when its record is newer than the one this read
  // judged, for the same authority; a waiter that started late must not miss it (SDA-AC-014).
  const newerShared = () => {
    if (explicit) return null;
    const shared = readProjectionRecord(file, key);
    return shared && shared.stamp && shared.authority === authority && shared.checkedAt > (found?.checkedAt ?? -Infinity) ? shared : null;
  };
  const serveShared = (shared) => {
    incrementCommandCounter('repository-checks.shared');
    observe(root, settings, 'shared', shared.checkedAt, null, { freshness: 'fresh', completeness: 'complete',
      acceptedRevision: shared.acceptedRevision });
    return shared.value;
  };
  let lease = null;
  if (await prepareDirectory(directory).catch(() => false)) {
    const { acquireFileLease, inspectFileLease } = await import('./file-lease.mjs');
    const acquire = () => acquireFileLease(leaseFile, { staleMs: REFRESH_LEASE_STALE_MS }).catch(() => null);
    lease = await acquire();
    if (!lease && replay) return found ? found.value : compute();
    if (lease && !replay) {
      // That refresh can also finish between this read's look at the record and this lease.
      const shared = newerShared();
      if (shared && shared.stamp === observeStamp()) {
        await lease.release().catch(() => {});
        return serveShared(shared);
      }
    }
    if (!lease) {
      const waited = Date.now();
      incrementCommandCounter('repository-checks.refresh-waits');
      await waitForRefreshLease(leaseFile, inspectFileLease, waited + COALESCE_WAIT_MS);
      const current = observeStamp();
      const shared = newerShared();
      if (shared && current && shared.stamp === current) return serveShared(shared);
      restamp(current);
      lease = await acquire();
    }
  }
  try {
    const value = await compute();
    if (found || replay) await writeRefreshAttempt(directory, file, { succeededAt: new Date().toISOString(), error: null, failedAt: null });
    return value;
  } catch (error) {
    if (!authorityUnavailable(error)) throw error;
    const failedAt = new Date().toISOString();
    await writeRefreshAttempt(directory, file, { failedAt, error: refreshError(error) });
    if (!found) throw error;
    incrementCommandCounter('repository-checks.refresh-failed');
    observe(root, settings, 'last-known', found.checkedAt, null, { freshness: 'refresh-failed', completeness: 'complete',
      acceptedRevision: found.acceptedRevision,
      refreshError: refreshError(error), refreshFailedAt: failedAt });
    return found.value;
  } finally { await lease?.release().catch(() => {}); }
}

/**
 * How the Story list of the repository at `root` last stood against its authority (SDA §14), read
 * from the read index alone: no Git process, no network, no payload decoded. The newest verified
 * listing whose read ran in this repository, for the authority its configuration still names, with
 * the freshness `index status` reports for it. Null when there is none: never synchronized.
 */
export async function lastKnownStoryList(root, { env = process.env, now = Date.now() } = {}) {
  const repository = path.resolve(root);
  const inside = (child) => {
    const relative = path.relative(repository, path.resolve(child));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };
  const directory = sessionListingDirectory(env);
  let newest = null;
  for (const name of await readdir(directory).catch(() => [])) {
    if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
    const file = path.join(directory, name);
    const found = readProjectionRecord(file, null, now, { decode: false });
    const cwd = found?.kind === 'session-listing' ? found.refresh?.cwd : null;
    // The read ran here, alone or with this repository selected; a changed remote ends the record.
    if (typeof cwd !== 'string' || !inside(cwd)
        || ![remoteAuthority([cwd]), remoteAuthority([cwd, repository])].includes(found.authority)) continue;
    if (!newest || found.checkedAt > newest.found.checkedAt) newest = { file, found };
  }
  if (!newest) return null;
  const { file, found } = newest;
  const settings = repositoryCheckSettings(repository, { env });
  const attempt = readRefreshAttempt(file);
  const failed = attempt?.error && Date.parse(attempt.failedAt ?? '') > found.checkedAt ? attempt.error : null;
  const expired = settings.mode === 'always'
    || settings.mode === 'cached' && found.age >= settings.intervalMinutes * 60_000;
  return { freshness: failed ? 'refresh-failed' : expired ? 'stale' : 'fresh',
    checkedAt: new Date(found.checkedAt).toISOString(), acceptedRevision: found.acceptedRevision, completeness: 'complete',
    ...(failed ? { refreshError: failed } : {}) };
}

/** The remote URLs of the checkout at `root`, as its Git configuration file names them; no process. */
export function checkoutRemoteUrls(root) {
  return [...new Set((configuredRemoteUrls(root) ?? []).map((entry) => entry.url))];
}
