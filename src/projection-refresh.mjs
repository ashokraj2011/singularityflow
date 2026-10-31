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

// A refresh lease older than this, held by a process that is not this one, reads as not renewed: it is
// reported with its reviewed release, never taken over (A5). The cache lease bound, so reading the
// lease file by its path judges a refresh lease the same way.
export const REFRESH_LEASE_STALE_MS = 15 * 60_000;
// How long a read with no record waits for another process's refresh of it: as long as a refresh may
// take (the foreground replay's own bound), so a slow network is not read once per waiting process
// (U3). Only while that process runs here and holds the lease; an owner that cannot be proven running
// is not waited for, and only a dead one is taken over.
const REFRESH_WAIT_MS = 120_000;
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

/**
 * The refusal a failed refresh would have been, bounded: its code, stage, Git diagnosis and the
 * product's advice for it, never its raw output. The advice is what a person acts on when the cause
 * is not one a retry ends (A3).
 */
function refreshError(error) {
  const remote = error?.details?.remoteFailure;
  return { code: String(error?.code ?? 'REFRESH_FAILED'),
    message: String(error?.message ?? error).replace(/\s+/gu, ' ').trim().slice(0, REFRESH_ERROR_CHARS),
    ...(error?.outcomeClass ? { outcomeClass: error.outcomeClass } : {}),
    ...(remote ? { remoteFailure: { stage: remote.stage ?? null, classification: remote.failure?.classification ?? null,
      code: remote.failure?.code ?? null, retryable: remote.failure?.retryable === true,
      timedOut: remote.evidence?.timedOut === true,
      ...(typeof remote.failure?.advice === 'string' ? { advice: remote.failure.advice.slice(0, 300) } : {}) } } : {}) };
}

/** A verified record of this authority served as it stands, with what refreshes it (SDA §8, §17). */
export function serveLastKnown({ root, settings, file, found, observe }, backgroundRefresh) {
  const attempt = readRefreshAttempt(file);
  const failed = attempt?.error && Date.parse(attempt.failedAt ?? '') > found.checkedAt ? attempt : null;
  incrementCommandCounter('repository-checks.last-known');
  observe(root, settings, 'last-known', found.checkedAt, null, { freshness: failed ? 'refresh-failed' : 'stale',
    completeness: 'complete', acceptedRevision: found.acceptedRevision,
    ...(failed ? { refreshError: failed.error, refreshFailedAt: failed.failedAt } : {}), backgroundRefresh });
  return found.value;
}

/** Start one replay of the read behind a stale record, unless one runs or recently failed. */
export async function refreshBehind(directory, file, refreshRecipe, env, found) {
  if (String(env.SINGULARITY_FLOW_INDEX_REFRESH ?? '').toLowerCase() === 'off') return 'off';
  if (!refreshRecipe) return 'unavailable';
  try {
    const { inspectFileLease } = await import('./file-lease.mjs');
    // A refresh running here answers soon. A lease no running process here can be proven to hold
    // (another machine's, or one left behind) does not stop the replay, which reads without it (A5).
    const lease = await inspectFileLease(projectionSidecars(file).lease, { staleMs: REFRESH_LEASE_STALE_MS });
    if (lease.state === 'busy' && lease.active) return 'in-flight';
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
 * One refresh per record across processes (SDA-AC-014). The refresh holds the record's lease. A read
 * that finds it held by a process running here:
 * - with a last-known record, serves that record (stale, `in-flight`) and never waits on the network,
 *   unless checks are set to always verify;
 * - with none, waits for that refresh (up to `REFRESH_WAIT_MS`), then takes the record it wrote when
 *   nothing it depends on has changed since.
 * An explicit refresh waits too, then makes its own observation. A lease no running process here can
 * be proven to hold is not waited for (A5). When the authority cannot be reached, a record already
 * held is served as `refresh-failed`.
 */
export async function coalescedRefresh({ root, settings, directory, file, key, authority, explicit, forced = explicit, replay, found,
  observeStamp, observe, prepareDirectory, restamp, refreshRecipe = null, outcome = null }, compute) {
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
  const inFlight = () => serveLastKnown({ root, settings, file, found, observe }, 'in-flight');
  let lease = null;
  if (await prepareDirectory(directory).catch(() => false)) {
    const { acquireFileLease, inspectFileLease } = await import('./file-lease.mjs');
    const acquire = () => acquireFileLease(leaseFile, { staleMs: REFRESH_LEASE_STALE_MS }).catch(() => null);
    const running = async () => {
      let held = await inspectFileLease(leaseFile, { staleMs: REFRESH_LEASE_STALE_MS }).catch(() => null);
      // A lease read while its owner writes it can look unverifiable for a moment: look once more.
      if (held?.state === 'unverifiable') {
        await new Promise((resolve) => setTimeout(resolve, 25));
        held = await inspectFileLease(leaseFile, { staleMs: REFRESH_LEASE_STALE_MS }).catch(() => null);
      }
      return held?.state === 'busy' && held.active === true;
    };
    lease = await acquire();
    if (lease && !replay) {
      // That refresh can also finish between this read's look at the record and this lease.
      const shared = newerShared();
      if (shared && shared.stamp === observeStamp()) {
        await lease.release().catch(() => {});
        return serveShared(shared);
      }
    }
    if (!lease && await running()) {
      if (replay) return found ? found.value : compute();
      incrementCommandCounter('repository-checks.refresh-waits');
      // A read that must be fresh, or checks set to always verify, never serve a record in place of a read.
      if (found && !forced && settings.mode !== 'always') {
        const shared = newerShared();
        return shared && shared.stamp === observeStamp() ? serveShared(shared) : inFlight();
      }
      const deadline = Date.now() + REFRESH_WAIT_MS;
      while (Date.now() < deadline && await running()) await new Promise((resolve) => setTimeout(resolve, 50));
      const current = observeStamp();
      const shared = newerShared();
      if (shared && current && shared.stamp === current) return serveShared(shared);
      restamp();
      lease = await acquire();
      // Still running past the bound: the record it is replacing answers rather than a second read (U3).
      if (!lease && found && settings.mode !== 'always' && await running()) return inFlight();
    }
  }
  try {
    const value = await compute();
    const now = new Date().toISOString();
    // Every successful refresh replaces the record and clears the kept error; a partial one is
    // recorded as partial and clears nothing (A7); one not kept says why.
    if (outcome?.kept === 'stored') {
      if (found || replay || readRefreshAttempt(file)) {
        await writeRefreshAttempt(directory, file, { succeededAt: now, error: null, failedAt: null,
          partialAt: null, partialReason: null, notKeptAt: null, notKeptReason: null });
      }
    } else if (outcome?.kept === 'partial') {
      await writeRefreshAttempt(directory, file, { partialAt: now, partialReason: outcome.reason, ...(found ? {} : firstRead(refreshRecipe)) });
    } else if (outcome?.kept === 'not-kept' && (found || replay)) {
      await writeRefreshAttempt(directory, file, { notKeptAt: now, notKeptReason: outcome.reason });
    }
    return value;
  } catch (error) {
    if (!authorityUnavailable(error)) throw error;
    const failedAt = new Date().toISOString();
    // A first read that failed is what `index status` names until a read succeeds (A4).
    await writeRefreshAttempt(directory, file, { failedAt, error: refreshError(error), ...(found ? {} : firstRead(refreshRecipe)) });
    if (!found) throw error;
    incrementCommandCounter('repository-checks.refresh-failed');
    observe(root, settings, 'last-known', found.checkedAt, null, { freshness: 'refresh-failed', completeness: 'complete',
      acceptedRevision: found.acceptedRevision,
      refreshError: refreshError(error), refreshFailedAt: failedAt });
    return found.value;
  } finally { await lease?.release().catch(() => {}); }
}

/** Which read an attempt with no record yet belongs to, so `index status` can name it. */
function firstRead(refreshRecipe) {
  return Array.isArray(refreshRecipe?.argv) ? { read: refreshRecipe.argv.slice(0, 2).join(' '), cwd: refreshRecipe.cwd ?? null } : {};
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
    // A listing of another repository named by URL is never this one's, whatever directory it ran in (A6).
    if (typeof cwd !== 'string' || !inside(cwd) || !found.authority || typeof found.binding?.authority?.repositoryUrl === 'string'
        || ![remoteAuthority([cwd], env), remoteAuthority([cwd, repository], env)].includes(found.authority)) continue;
    if (!newest || found.checkedAt > newest.found.checkedAt) newest = { file, found };
  }
  if (!newest) return null;
  const { file, found } = newest;
  const settings = repositoryCheckSettings(repository, { env });
  const attempt = readRefreshAttempt(file);
  const failed = attempt?.error && Date.parse(attempt.failedAt ?? '') > found.checkedAt ? attempt.error : null;
  // Fresh only within the interval of cached checks: manual refresh never expires a record, so its
  // age is reported as stale, not as verified now (A12).
  const expired = settings.mode !== 'cached' || found.age >= settings.intervalMinutes * 60_000;
  // The last refresh came back incomplete: the record stands, and the list is not called complete (A7).
  const partial = Date.parse(attempt?.partialAt ?? '') > found.checkedAt;
  return { freshness: failed ? 'refresh-failed' : expired ? 'stale' : 'fresh',
    checkedAt: new Date(found.checkedAt).toISOString(), acceptedRevision: found.acceptedRevision,
    completeness: partial ? 'partial' : 'complete', ...(failed ? { refreshError: failed } : {}) };
}

/** The remote URLs of the checkout at `root`, as its Git configuration file names them; no process. */
export function checkoutRemoteUrls(root) {
  return [...new Set((configuredRemoteUrls(root) ?? []).map((entry) => entry.url))];
}
