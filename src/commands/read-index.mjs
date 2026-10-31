/**
 * `singularity-flow index status|refresh|rebuild|verify` (SDA §14, M2).
 *
 * The read index is the advisory projections reads are served from (ADR 0017): the repository-check
 * records of this checkout and the machine's session listings, each with its freshness, its last
 * refresh and whether a refresh is running, plus the pending pushes of this repository.
 * - status reads them and changes nothing. It says when a record cannot be used here (another build
 *   wrote it, its checkout moved, its remote changed) and names a refresh lease no running process
 *   here holds, with its review and reviewed release (`lock show-file`, `lock release-file`).
 * - refresh replays each record's read now (src/index-refresh-launcher.mjs); a record that cannot be
 *   refreshed keeps its last-known state and says why.
 * - rebuild discards what cannot be trusted, used here or replayed, and refreshes the rest. It touches
 *   only these projections: never a draft, a journal, a pending push or a Story. A refresh lease is
 *   removed only when its owner is proven stopped; any other is reported with its reviewed release.
 * - verify checks every record's integrity here, and with --authority replays the replayable ones
 *   to compare them with what the authority answers now.
 * None of it is authority: a final governed check reads the authority itself (SDA §6.2).
 */
import { readdir, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { optionBoolean, platformPathWithin, SingularityFlowError } from '../util.mjs';

const SUBCOMMANDS = Object.freeze(['status', 'refresh', 'rebuild', 'verify']);
const OPTIONS = Object.freeze({ status: ['json', 'all'], refresh: ['json', 'all'], rebuild: ['json', 'all'],
  verify: ['json', 'all', 'authority'] });
const RECORD = /^(?:provenance-[a-f0-9]{16}-)?[a-f0-9]{64}\.json$/u;
const SIDECAR = /^((?:provenance-[a-f0-9]{16}-)?[a-f0-9]{64})\.(lease|refresh\.json)$/u;
// Why a verified record cannot answer here (A1); the next read of it replaces it.
const NOT_USABLE = Object.freeze({
  'earlier-build': 'an earlier build of singularity-flow wrote it',
  'another-build': 'another build of singularity-flow wrote it',
  moved: 'it was read in a checkout that has moved',
  'directory-gone': 'the folder its read ran in is gone',
  'authority-changed': 'its repository now names another remote'
});
const ANOTHER_ENVIRONMENT = 'Another environment reads it (VS Code, or a terminal with another PATH); that surface refreshes it.';

function fail(message, code = 'INDEX_COMMAND_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

// A read records the directory it ran in as that process spelled it; on Windows that can be an 8.3
// short name, while the root here is the one Git reports. Both are compared canonically.
const inside = platformPathWithin;

async function scope() {
  const { repoRoot } = await import('../git-execution.mjs');
  let root = null;
  try { root = repoRoot(process.cwd()); } catch { /* Outside a repository only the machine's listings are in scope. */ }
  return root;
}

/** Whether this process can serve a verified record, and if not why (A1). */
async function standing(found, place, root, cache) {
  if (!found) return { usable: false, reason: 'unverifiable' };
  const binding = found.binding;
  if (!binding) return { usable: false, reason: 'earlier-build' };
  if (binding.build !== cache.PROJECTION_BUILD) return { usable: false, reason: 'another-build' };
  const where = typeof binding.root === 'string' ? await realpath(binding.root).catch(() => null) : null;
  if (!where) return { usable: false, reason: place === 'repository' ? 'moved' : 'directory-gone' };
  if (place === 'repository' && root && where !== await realpath(root).catch(() => path.resolve(root))) return { usable: false, reason: 'moved' };
  if (found.authority != null && cache.lastKnownAuthority(binding.authority) !== found.authority) {
    return { usable: false, reason: 'authority-changed' };
  }
  return { usable: true, environment: binding.environment === cache.projectionEnvironment().slice(0, 16) ? 'this' : 'another' };
}

/**
 * A refresh lease as a person reads it (A5): `refreshing` (its owner runs here and can still finish),
 * `held` (no running process here can be proven to hold it: another machine's, or one left behind;
 * only a person's reviewed release ends it), `left-by-stopped-process` (its owner is proven stopped;
 * the next refresh takes it over), or `unverifiable`. Null when there is none.
 */
async function leaseStanding(file) {
  const { inspectFileLease } = await import('../file-lease.mjs');
  const { REFRESH_LEASE_STALE_MS } = await import('../projection-refresh.mjs');
  const lease = await inspectFileLease(file, { staleMs: REFRESH_LEASE_STALE_MS }).catch(() => ({ state: 'missing' }));
  if (lease.state === 'missing') return null;
  const state = lease.state === 'reclaimable' ? 'left-by-stopped-process' : lease.active ? 'refreshing'
    : lease.state === 'busy' ? 'held' : 'unverifiable';
  let owner = null;
  if (lease.owner) {
    const { describeLeaseOwner } = await import('../lease-liveness.mjs');
    owner = describeLeaseOwner(lease.owner, lease.liveness);
  }
  return { file, state, ...(owner ? { owner, token: lease.token } : {}),
    ...(lease.liveness ? { liveness: { state: lease.liveness.state, reason: lease.liveness.reason } } : {}),
    ...(state === 'held' || state === 'unverifiable' ? { review: lease.showCommand ?? `singularity-flow lock show-file ${JSON.stringify(file)}` } : {}),
    ...(lease.releaseCommand ? { release: lease.releaseCommand } : {}) };
}

/** Every projection record in scope, read and verified, with its sidecars. */
async function projections(root, { all = false } = {}) {
  const cache = await import('../repository-check-cache.mjs');
  const { repositoryCheckSettings } = await import('../repository-check-settings.mjs');
  const settings = repositoryCheckSettings(root ?? process.cwd());
  const places = [
    ...(root && cache.repositoryCheckDirectory(root) ? [{ place: 'repository', directory: cache.repositoryCheckDirectory(root) }] : []),
    { place: 'session-listings', directory: cache.sessionListingDirectory() }
  ];
  const records = []; const attempts = []; const leases = [];
  const mine = (place, cwd) => place === 'repository' || all || Boolean(root && typeof cwd === 'string' && inside(cwd, root));
  for (const { place, directory } of places) {
    const names = await readdir(directory).catch(() => []);
    const present = new Set(names.filter((name) => RECORD.test(name)).map((name) => name.slice(0, -'.json'.length)));
    for (const name of names) {
      const sidecar = SIDECAR.exec(name);
      if (!sidecar || present.has(sidecar[1])) continue;
      const file = path.join(directory, name);
      if (sidecar[2] === 'lease') {
        // A first refresh holds its lease before its record exists: never an orphan to remove (U2).
        const lease = await leaseStanding(file);
        if (lease && (place === 'repository' || all || root)) leases.push({ place, ...lease });
        continue;
      }
      const attempt = cache.readRefreshAttempt(path.join(directory, `${sidecar[1]}.json`));
      if (mine(place, attempt?.cwd)) attempts.push({ place, file, attempt });
    }
    for (const base of present) {
      const file = path.join(directory, `${base}.json`);
      const found = cache.readProjectionRecord(file, null);
      // A listing belongs to the repository its read ran in; one that never said is shown with --all.
      // One that cannot be verified cannot say whose it is, so every scope shows it (A4).
      if (place === 'session-listings' && found && !mine(place, found.refresh?.cwd)) continue;
      const attempt = cache.readRefreshAttempt(file);
      const lease = await leaseStanding(cache.projectionSidecars(file).lease);
      const info = await stat(file).catch(() => null);
      records.push({ place, file, found, attempt, lease, standing: await standing(found, place, root, cache), bytes: info?.size ?? null });
    }
  }
  return { settings, records, attempts, leases };
}

function freshness({ found, attempt }, settings) {
  if (!found) return null;
  if (attempt?.error && Date.parse(attempt.failedAt ?? '') > found.checkedAt) return 'refresh-failed';
  // Fresh only within the interval of cached checks; manual refresh never expires a record (A12).
  if (settings.mode !== 'cached') return 'stale';
  return found.age >= settings.intervalMinutes * 60_000 ? 'stale' : 'fresh';
}

async function guidance(error, retry) {
  const { refreshFailureGuidance } = await import('../git-remote-diagnostics.mjs');
  return refreshFailureGuidance(error, { retry });
}

async function describe(entry, settings) {
  const { found, attempt } = entry;
  const failed = Boolean(found && attempt?.error && Date.parse(attempt.failedAt ?? '') > found.checkedAt);
  const partial = Boolean(found && Date.parse(attempt?.partialAt ?? '') > found.checkedAt);
  return {
    place: entry.place, record: path.basename(entry.file),
    integrity: found ? 'verified' : 'unverifiable',
    ...(found ? { kind: found.kind ?? 'verification', checkedAt: new Date(found.checkedAt).toISOString(),
      ageMs: Math.round(found.age), freshness: freshness(entry, settings), ...(settings.mode === 'manual' ? { refresh: 'manual' } : {}),
      replayable: Boolean(found.refresh), ...(found.refresh ? { read: found.refresh.argv.slice(0, 2).join(' ') } : {}),
      usable: entry.standing.usable,
      ...(entry.standing.usable ? (entry.standing.environment === 'another' ? { environment: 'another' } : {})
        : { notUsable: entry.standing.reason }) } : {}),
    refreshing: entry.lease?.state === 'refreshing', ...(entry.lease ? { refreshLease: entry.lease } : {}),
    bytes: entry.bytes,
    ...(attempt?.error ? { lastRefreshError: attempt.error, lastRefreshFailedAt: attempt.failedAt } : {}),
    ...(failed ? { refreshGuidance: (await guidance(attempt.error, 'singularity-flow index refresh')).text || null } : {}),
    ...(attempt?.succeededAt ? { lastRefreshAt: attempt.succeededAt } : {}),
    ...(partial ? { lastRefreshPartialAt: attempt.partialAt, lastRefreshPartial: attempt.partialReason ?? null } : {})
  };
}

/** The first reads of this repository that failed, or came back incomplete, and why (A4). */
async function firstReadFailures(attempts) {
  const failures = [];
  for (const { attempt } of attempts) {
    if (!attempt?.read || (!attempt.error && !attempt.partialAt)) continue;
    const failedAt = attempt.error ? attempt.failedAt : attempt.partialAt;
    const advice = attempt.error ? await guidance(attempt.error, 'singularity-flow index refresh') : null;
    failures.push({ read: attempt.read, at: failedAt ?? null,
      ...(attempt.error ? { error: attempt.error, cause: advice.cause, guidance: advice.text || 'Retry with: singularity-flow index refresh.' }
        : { partial: attempt.partialReason ?? null, guidance: 'Retry with: singularity-flow index refresh.' }) });
  }
  return failures;
}

async function pendingOperations(root) {
  if (!root) return { pushes: [] };
  try {
    const { transportIntentsForRepository } = await import('../transport-intents.mjs');
    const intents = await transportIntentsForRepository(root);
    return { pushes: intents.map((intent) => ({ id: intent.intentId ?? intent.id, status: intent.status,
      targetRef: intent.targetRef ?? null })), retry: 'singularity-flow sync' };
  } catch (error) { return { pushes: [], unavailable: String(error?.code ?? error?.message ?? error) }; }
}

async function storySummaries(root) {
  if (!root) return null;
  const { gitCommonDir } = await import('../git-execution.mjs');
  const file = path.join(gitCommonDir(root), 'singularity-flow', 'story-summaries.json');
  const info = await stat(file).catch(() => null);
  return { file, present: Boolean(info), bytes: info?.size ?? null };
}

/** The line a failed read printed that says why: its refusal, not timing or progress output. */
function failureDetail(run) {
  if (run.error) return run.error;
  const lines = String(run.stderr ?? '').split('\n').map((line) => line.trim())
    .filter((line) => line && !line.startsWith('[sflow '));
  return lines[0] ?? null;
}

/** Replay one record's read in the foreground, and what it did to the record. */
async function replay(entry) {
  const cache = await import('../repository-check-cache.mjs');
  const { runIndexRefresh } = await import('../index-refresh-launcher.mjs');
  const before = entry.found;
  if (!before?.refresh) return { outcome: 'not-replayable' };
  if (!await stat(before.refresh.cwd).catch(() => null)) return { outcome: 'not-replayable', reason: 'The directory its read ran in is gone.' };
  // Its own environment's file: a replay from here writes this environment's record, not that one.
  if (entry.standing?.environment === 'another') return { outcome: 'unchanged', reason: ANOTHER_ENVIRONMENT };
  const started = Date.now();
  const run = await runIndexRefresh(before.refresh);
  const after = cache.readProjectionRecord(entry.file, null);
  const attempt = cache.readRefreshAttempt(entry.file);
  const since = (value) => Date.parse(value ?? '') >= started - 1_000;
  if (after && after.checkedAt > before.checkedAt) return { outcome: 'refreshed', after };
  if (attempt?.error && since(attempt.failedAt)) return { outcome: 'refresh-failed', error: attempt.error, kept: 'last-known' };
  // An incomplete answer never replaces a complete record (A7).
  if (since(attempt?.partialAt)) return { outcome: 'partial', reason: attempt.partialReason ?? null, kept: 'last-known' };
  if (since(attempt?.notKeptAt)) return { outcome: 'unchanged', reason: attempt.notKeptReason ?? null };
  const lease = await leaseStanding(cache.projectionSidecars(entry.file).lease);
  return { outcome: 'unchanged', ...(run.status !== 0 ? { exitStatus: run.status, detail: failureDetail(run) } : {}),
    ...(lease?.state === 'refreshing' ? { reason: 'Another refresh of this record was running.' } : {}) };
}

/** First synchronization: the reads a person runs first, for the repository this runs in. */
async function firstReads(root, records) {
  if (!root) return [];
  const replayed = new Set(records.filter((entry) => entry.found?.refresh && inside(entry.found.refresh.cwd, root))
    .map((entry) => entry.found.refresh.argv.slice(0, 2).join(' ')));
  const { runIndexRefresh } = await import('../index-refresh-launcher.mjs');
  const results = [];
  for (const argv of [['session', 'candidates', '--json'], ['workspace', 'branches', '--intake', '--json']]) {
    if (replayed.has(argv.slice(0, 2).join(' '))) continue;
    const run = await runIndexRefresh({ argv, cwd: process.cwd() });
    results.push({ read: argv.slice(0, 2).join(' '), outcome: run.status === 0 ? 'synchronized' : 'unavailable',
      ...(run.status !== 0 ? { detail: failureDetail(run) } : {}) });
  }
  return results;
}

async function removeRecord(file) {
  const { projectionSidecars } = await import('../repository-check-cache.mjs');
  await rm(file, { force: true });
  await rm(projectionSidecars(file).attempt, { force: true });
}

/**
 * A refresh lease is removed only when its owner is proven stopped, through the same reclaim every
 * acquisition uses (U2): a first refresh still running, or a lease no running process here can be
 * proven to hold, stays for its owner or for a person's reviewed release (A5).
 */
async function clearStoppedLease(lease) {
  if (lease?.state !== 'left-by-stopped-process') return false;
  const { acquireFileLease } = await import('../file-lease.mjs');
  const { REFRESH_LEASE_STALE_MS } = await import('../projection-refresh.mjs');
  const taken = await acquireFileLease(lease.file, { staleMs: REFRESH_LEASE_STALE_MS }).catch(() => null);
  if (!taken) return false;
  await taken.release().catch(() => {});
  return true;
}

/** The leases a person must review, from records and from sidecars without a record. */
function leasesToReview(records, leases) {
  return [...records.map((entry) => entry.lease), ...leases].filter((lease) => lease && ['held', 'unverifiable'].includes(lease.state));
}

export async function indexCommand(positionals, options = {}) {
  const subcommand = positionals[1] ?? 'status';
  if (!SUBCOMMANDS.includes(subcommand)) {
    fail(`Unknown index subcommand '${subcommand}'. Supported: ${SUBCOMMANDS.join(', ')}.`, 'UNKNOWN_SUBCOMMAND',
      { command: 'index', subcommand, available: [...SUBCOMMANDS] });
  }
  const unknown = Object.keys(options).filter((key) => ![...OPTIONS[subcommand], 'timings'].includes(key)).sort();
  if (unknown.length) fail(`index ${subcommand} does not accept ${unknown.map((key) => `--${key}`).join(', ')}. Use: ${OPTIONS[subcommand].map((key) => `--${key}`).join(', ')}.`);
  if (positionals.length > 2) fail(`index ${subcommand} takes no argument.`);
  const root = await scope();
  const all = optionBoolean(options, 'all');
  const { settings, records, attempts, leases } = await projections(root, { all });
  const base = { schemaVersion: 1, resultType: `sflow-index-${subcommand}`, repositoryPath: root,
    settings: { mode: settings.mode, intervalMinutes: settings.intervalMinutes }, scope: all ? 'machine' : 'repository' };
  const rebuildCommand = `singularity-flow index rebuild${all ? ' --all' : ''}`;
  if (subcommand === 'status') {
    const failures = await firstReadFailures(attempts);
    const projected = [];
    for (const entry of records) projected.push(await describe(entry, settings));
    return { ...base, projections: projected,
      ...(leases.length ? { leases } : {}),
      storySummaries: await storySummaries(root), pendingOperations: await pendingOperations(root),
      ...(failures.length ? { firstReads: failures } : {}),
      // After a failed first read, its cause and fix stand in for "run the refresh" (A4).
      ...(records.length || failures.length ? {} : { firstSynchronization: 'singularity-flow index refresh' }) };
  }
  if (subcommand === 'refresh') {
    const refreshed = [];
    for (const entry of records.filter((item) => item.found?.refresh)) {
      const { after, ...result } = await replay(entry);
      refreshed.push({ record: path.basename(entry.file), read: entry.found.refresh.argv.slice(0, 2).join(' '), ...result });
    }
    const reads = await firstReads(root, records);
    // A first read that failed against the authority kept its cause beside the record it lacks.
    const after = await projections(root, { all });
    const causes = await firstReadFailures(after.attempts);
    for (const item of reads.filter((entry) => entry.outcome === 'unavailable')) {
      const cause = causes.find((entry) => entry.read === item.read && entry.error);
      if (cause) Object.assign(item, { error: cause.error, guidance: cause.guidance });
    }
    return { ...base, refreshed, firstReads: reads,
      skipped: records.filter((item) => !item.found?.refresh).length,
      ...(leasesToReview(after.records, after.leases).length ? { leases: leasesToReview(after.records, after.leases) } : {}) };
  }
  if (subcommand === 'rebuild') {
    const results = [];
    for (const entry of records) {
      const record = path.basename(entry.file);
      const lease = entry.lease;
      if (!entry.found) {
        await removeRecord(entry.file); await clearStoppedLease(lease);
        results.push({ record, outcome: 'discarded', reason: 'unverifiable' });
        continue;
      }
      if (!entry.standing.usable) {
        // A record this process cannot use is discarded, not kept as if it answered (A1, A10).
        await removeRecord(entry.file); await clearStoppedLease(lease);
        results.push({ record, kind: entry.found.kind ?? 'verification', outcome: 'discarded', reason: `Not usable here: ${NOT_USABLE[entry.standing.reason]}.` });
        continue;
      }
      if (entry.standing.environment === 'another') {
        results.push({ record, kind: entry.found.kind ?? 'verification', outcome: 'kept', reason: ANOTHER_ENVIRONMENT });
        continue;
      }
      if (!entry.found.refresh) {
        await removeRecord(entry.file); await clearStoppedLease(lease);
        results.push({ record, kind: entry.found.kind ?? 'verification', outcome: 'discarded', reason: 'Its next read verifies again.' });
        continue;
      }
      await clearStoppedLease(lease);
      const { after, ...result } = await replay(entry);
      results.push({ record, kind: entry.found.kind, ...result });
    }
    for (const { file } of attempts) await rm(file, { force: true });
    let leasesRemoved = 0;
    for (const lease of leases) if (await clearStoppedLease(lease)) leasesRemoved += 1;
    const summaries = await storySummaries(root);
    if (summaries?.present) await rm(summaries.file, { force: true });
    const review = leasesToReview((await projections(root, { all })).records, leases);
    return { ...base, rebuilt: results, orphanSidecarsRemoved: attempts.length + leasesRemoved,
      ...(review.length ? { leases: review } : {}),
      storySummaries: summaries?.present ? 'discarded; the next listing proves each row again' : 'absent',
      preserved: 'Drafts, journals, pending pushes and Story state are not part of the index and were not touched.' };
  }
  // verify
  const checked = [];
  for (const entry of records) {
    const item = { record: path.basename(entry.file), place: entry.place, integrity: entry.found ? 'verified' : 'unverifiable',
      ...(entry.found && !entry.standing.usable ? { notUsable: entry.standing.reason } : {}),
      ...(entry.standing?.environment === 'another' ? { environment: 'another' } : {}) };
    if (entry.found && optionBoolean(options, 'authority') && entry.found.refresh) {
      const { after, ...result } = await replay(entry);
      item.authority = result.outcome === 'refreshed'
        ? (after.sha256 === entry.found.sha256 ? 'matches' : 'changed')
        : result.outcome === 'refresh-failed' ? 'unavailable' : result.outcome === 'partial' ? 'partial' : 'not-compared';
      if (result.error) item.error = result.error;
      if (result.reason) item.reason = result.reason;
    }
    checked.push(item);
  }
  const problems = checked.filter((item) => item.integrity !== 'verified').length;
  const review = leasesToReview(records, leases);
  return { ...base, ok: problems === 0, problems, checked,
    orphanSidecars: attempts.length + leases.filter((lease) => lease.state === 'left-by-stopped-process').length,
    ...(review.length ? { leases: review } : {}),
    // The rebuild that reaches what this verify read: with --all, the machine's (A4).
    ...(problems ? { repair: rebuildCommand } : {}) };
}

function leaseLine(lease) {
  if (lease.state === 'refreshing') return null;
  if (lease.state === 'left-by-stopped-process') return `    refresh lease ${lease.file}: left by a stopped process; the next refresh takes it over (index rebuild removes it).`;
  return `    refresh lease ${lease.file}: held by ${lease.owner ?? 'an unreadable owner'}; no running process here can be shown to hold it, and it is never taken over by age.`
    + ` Review it with: ${lease.review}.${lease.release ? ` If it is not in use, release it with: ${lease.release}` : ''}`;
}

function printResult(result) {
  const say = (line) => console.log(line);
  say(`Read index (${result.scope}): repository checks ${result.settings.mode}${result.settings.mode === 'manual' ? ' (refreshed only by hand)' : ''}, every ${result.settings.intervalMinutes} minutes.`);
  if (result.resultType === 'sflow-index-status') {
    if (result.firstSynchronization) say(`No projections yet. First synchronization: ${result.firstSynchronization}`);
    for (const item of result.firstReads ?? []) {
      say(`  ${item.read}: never synchronized; the first read ${item.error ? `failed at ${item.at} (${item.cause})` : `came back incomplete at ${item.at}${item.partial ? ` (${item.partial})` : ''}`}. ${item.guidance}`);
    }
    for (const item of result.projections) {
      const minutes = Math.round((item.ageMs ?? 0) / 60_000);
      say(`  ${item.read ?? item.kind ?? 'record'}: ${item.integrity === 'verified'
        ? `${item.freshness}${item.refresh === 'manual' ? ' (refresh is manual)' : ''}, checked ${item.checkedAt} (${minutes} minutes ago)`
          + `${item.refreshing ? ', refreshing now' : ''}`
          + `${item.lastRefreshError && item.freshness === 'refresh-failed' ? `, last refresh failed (${item.lastRefreshError.code}${item.lastRefreshError.remoteFailure?.code ? `: ${item.lastRefreshError.remoteFailure.code}` : ''})` : ''}`
          + `${item.lastRefreshPartialAt ? `, last refresh incomplete${item.lastRefreshPartial ? ` (${item.lastRefreshPartial})` : ''}` : ''}`
        : 'unverifiable (index rebuild discards it)'}`);
      if (item.refreshGuidance) say(`    ${item.refreshGuidance}`);
      if (item.notUsable) say(`    Not usable here: ${NOT_USABLE[item.notUsable]}. The next read replaces it; index rebuild discards it.`);
      if (item.environment === 'another') say(`    ${ANOTHER_ENVIRONMENT}`);
      if (item.refreshLease && leaseLine(item.refreshLease)) say(leaseLine(item.refreshLease));
    }
    for (const lease of result.leases ?? []) if (leaseLine(lease)) say(leaseLine(lease));
    const pushes = result.pendingOperations.pushes;
    say(pushes.length ? `Pending pushes: ${pushes.map((push) => `${push.id} (${push.status})`).join(', ')}. Retry: ${result.pendingOperations.retry}`
      : 'No pending pushes for this repository.');
  } else if (result.resultType === 'sflow-index-refresh') {
    if (!result.refreshed.length && !result.firstReads.length) say('Nothing to refresh.');
    for (const item of [...result.refreshed, ...result.firstReads]) {
      say(`  ${item.read}: ${item.outcome}${item.error ? ` (${item.error.code}${item.error.remoteFailure?.code ? `: ${item.error.remoteFailure.code}` : ''}${item.kept ? '; the last-known state is kept' : ''})` : ''}`
        + `${item.reason ? ` (${item.reason})` : ''}${item.detail ? `: ${item.detail}` : ''}`);
      if (item.guidance) say(`    ${item.guidance}`);
    }
    for (const lease of result.leases ?? []) if (leaseLine(lease)) say(leaseLine(lease));
  } else if (result.resultType === 'sflow-index-rebuild') {
    for (const item of result.rebuilt) say(`  ${item.kind ?? 'record'}: ${item.outcome}${item.reason ? ` (${item.reason})` : ''}`);
    for (const lease of result.leases ?? []) if (leaseLine(lease)) say(leaseLine(lease));
    say(result.preserved);
  } else {
    say(result.ok ? `All ${result.checked.length} records verified.` : `${result.problems} record(s) cannot be verified. Repair: ${result.repair}`);
    for (const item of result.checked.filter((entry) => entry.authority)) say(`  ${item.record}: ${item.authority}${item.reason ? ` (${item.reason})` : ''}`);
    for (const item of result.checked.filter((entry) => entry.notUsable)) say(`  ${item.record}: not usable here (${NOT_USABLE[item.notUsable]}); ${result.repair ?? `singularity-flow index rebuild${result.scope === 'machine' ? ' --all' : ''}`} discards it.`);
    for (const lease of result.leases ?? []) if (leaseLine(lease)) say(leaseLine(lease));
  }
}

export async function run(_argv, { positionals, options = {} }) {
  const result = await indexCommand(positionals, options);
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else printResult(result);
  if (result.resultType === 'sflow-index-verify' && !result.ok) process.exitCode = 1;
  return result;
}
