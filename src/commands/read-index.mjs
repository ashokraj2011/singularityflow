/**
 * `singularity-flow index status|refresh|rebuild|verify` (SDA §14, M2).
 *
 * The read index is the advisory projections reads are served from (ADR 0017): the repository-check
 * records of this checkout and the machine's session listings, each with its freshness, its last
 * refresh and whether a refresh is running, plus the pending pushes of this repository.
 * - status reads them and changes nothing.
 * - refresh replays each record's read now (src/index-refresh-launcher.mjs); a record that cannot be
 *   refreshed keeps its last-known state and says why.
 * - rebuild discards what cannot be trusted or replayed and refreshes the rest. It touches only these
 *   projections: never a draft, a journal, a pending push or a Story.
 * - verify checks every record's integrity here, and with --authority replays the replayable ones
 *   to compare them with what the authority answers now.
 * None of it is authority: a final governed check reads the authority itself (SDA §6.2).
 */
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { optionBoolean, SingularityFlowError } from '../util.mjs';

const SUBCOMMANDS = Object.freeze(['status', 'refresh', 'rebuild', 'verify']);
const OPTIONS = Object.freeze({ status: ['json', 'all'], refresh: ['json', 'all'], rebuild: ['json', 'all'],
  verify: ['json', 'all', 'authority'] });
const RECORD = /^(?:provenance-[a-f0-9]{16}-)?[a-f0-9]{64}\.json$/u;
const SIDECAR = /^((?:provenance-[a-f0-9]{16}-)?[a-f0-9]{64})\.(?:lease|refresh\.json)$/u;

function fail(message, code = 'INDEX_COMMAND_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function inside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function scope() {
  const { repoRoot } = await import('../git-execution.mjs');
  let root = null;
  try { root = repoRoot(process.cwd()); } catch { /* Outside a repository only the machine's listings are in scope. */ }
  return root;
}

/** Every projection record in scope, read and verified, with its sidecars. */
async function projections(root, { all = false } = {}) {
  const cache = await import('../repository-check-cache.mjs');
  const { repositoryCheckSettings } = await import('../repository-check-settings.mjs');
  const { inspectFileLease } = await import('../file-lease.mjs');
  const settings = repositoryCheckSettings(root ?? process.cwd());
  const places = [
    ...(root && cache.repositoryCheckDirectory(root) ? [{ place: 'repository', directory: cache.repositoryCheckDirectory(root) }] : []),
    { place: 'session-listings', directory: cache.sessionListingDirectory() }
  ];
  const records = []; const orphans = [];
  for (const { place, directory } of places) {
    const names = await readdir(directory).catch(() => []);
    const present = new Set(names.filter((name) => RECORD.test(name)).map((name) => name.slice(0, -'.json'.length)));
    for (const name of names) {
      const sidecar = SIDECAR.exec(name);
      if (sidecar && !present.has(sidecar[1])) orphans.push(path.join(directory, name));
    }
    for (const base of present) {
      const file = path.join(directory, `${base}.json`);
      const found = cache.readProjectionRecord(file, null);
      // A listing belongs to the repository its read ran in; one that never said is shown with --all.
      if (place === 'session-listings' && !all && !(root && found?.refresh?.cwd && inside(found.refresh.cwd, root))) continue;
      const attempt = cache.readRefreshAttempt(file);
      const lease = await inspectFileLease(cache.projectionSidecars(file).lease).catch(() => ({ state: 'missing' }));
      const info = await stat(file).catch(() => null);
      records.push({ place, file, found, attempt, refreshing: lease.state === 'busy', bytes: info?.size ?? null });
    }
  }
  return { settings, records, orphans };
}

function freshness({ found, attempt }, settings) {
  if (!found) return null;
  if (attempt?.error && Date.parse(attempt.failedAt ?? '') > found.checkedAt) return 'refresh-failed';
  if (settings.mode === 'always') return 'stale';
  return settings.mode === 'cached' && found.age >= settings.intervalMinutes * 60_000 ? 'stale' : 'fresh';
}

function describe(entry, settings) {
  const { found, attempt } = entry;
  return {
    place: entry.place, record: path.basename(entry.file),
    integrity: found ? 'verified' : 'unverifiable',
    ...(found ? { kind: found.kind ?? 'verification', checkedAt: new Date(found.checkedAt).toISOString(),
      ageMs: Math.round(found.age), freshness: freshness(entry, settings),
      replayable: Boolean(found.refresh), ...(found.refresh ? { read: found.refresh.argv.slice(0, 2).join(' ') } : {}) } : {}),
    refreshing: entry.refreshing, bytes: entry.bytes,
    ...(attempt?.error ? { lastRefreshError: attempt.error, lastRefreshFailedAt: attempt.failedAt } : {}),
    ...(attempt?.succeededAt ? { lastRefreshAt: attempt.succeededAt } : {})
  };
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

/** Replay one record's read in the foreground, and what it did to the record. */
async function replay(entry) {
  const cache = await import('../repository-check-cache.mjs');
  const { runIndexRefresh } = await import('../index-refresh-launcher.mjs');
  const before = entry.found;
  if (!before?.refresh) return { outcome: 'not-replayable' };
  if (!await stat(before.refresh.cwd).catch(() => null)) return { outcome: 'not-replayable', reason: 'The directory its read ran in is gone.' };
  const started = Date.now();
  const run = await runIndexRefresh(before.refresh);
  const after = cache.readProjectionRecord(entry.file, null);
  const attempt = cache.readRefreshAttempt(entry.file);
  if (after && after.checkedAt > before.checkedAt) return { outcome: 'refreshed', after };
  if (attempt?.error && Date.parse(attempt.failedAt ?? '') >= started - 1_000) {
    return { outcome: 'refresh-failed', error: attempt.error, kept: 'last-known' };
  }
  return { outcome: 'unchanged', ...(run.status !== 0 ? { exitStatus: run.status, detail: run.error ?? run.stderr?.trim().split('\n').at(-1) ?? null } : {}),
    ...(entry.refreshing ? { reason: 'Another refresh of this record was running.' } : {}) };
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
      ...(run.status !== 0 ? { detail: run.error ?? run.stderr?.trim().split('\n').at(-1) ?? null } : {}) });
  }
  return results;
}

async function removeRecord(file) {
  const { projectionSidecars } = await import('../repository-check-cache.mjs');
  await rm(file, { force: true });
  await rm(projectionSidecars(file).attempt, { force: true });
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
  const { settings, records, orphans } = await projections(root, { all });
  const base = { schemaVersion: 1, resultType: `sflow-index-${subcommand}`, repositoryPath: root,
    settings: { mode: settings.mode, intervalMinutes: settings.intervalMinutes }, scope: all ? 'machine' : 'repository' };
  if (subcommand === 'status') {
    return { ...base, projections: records.map((entry) => describe(entry, settings)),
      storySummaries: await storySummaries(root), pendingOperations: await pendingOperations(root),
      ...(records.length ? {} : { firstSynchronization: 'singularity-flow index refresh' }) };
  }
  if (subcommand === 'refresh') {
    const refreshed = [];
    for (const entry of records.filter((item) => item.found?.refresh)) {
      const { after, ...result } = await replay(entry);
      refreshed.push({ record: path.basename(entry.file), read: entry.found.refresh.argv.slice(0, 2).join(' '), ...result });
    }
    return { ...base, refreshed, firstReads: await firstReads(root, records),
      skipped: records.filter((item) => !item.found?.refresh).length };
  }
  if (subcommand === 'rebuild') {
    const results = [];
    for (const entry of records) {
      const record = path.basename(entry.file);
      if (!entry.found) { await removeRecord(entry.file); results.push({ record, outcome: 'discarded', reason: 'unverifiable' }); continue; }
      if (!entry.found.refresh) {
        await removeRecord(entry.file);
        results.push({ record, kind: entry.found.kind ?? 'verification', outcome: 'discarded', reason: 'Its next read verifies again.' });
        continue;
      }
      const { after, ...result } = await replay(entry);
      results.push({ record, kind: entry.found.kind, ...result });
    }
    for (const file of orphans) await rm(file, { force: true });
    const summaries = await storySummaries(root);
    if (summaries?.present) await rm(summaries.file, { force: true });
    return { ...base, rebuilt: results, orphanSidecarsRemoved: orphans.length,
      storySummaries: summaries?.present ? 'discarded; the next listing proves each row again' : 'absent',
      preserved: 'Drafts, journals, pending pushes and Story state are not part of the index and were not touched.' };
  }
  // verify
  const checked = [];
  for (const entry of records) {
    const item = { record: path.basename(entry.file), place: entry.place, integrity: entry.found ? 'verified' : 'unverifiable' };
    if (entry.found && optionBoolean(options, 'authority') && entry.found.refresh) {
      const { after, ...result } = await replay(entry);
      item.authority = result.outcome === 'refreshed'
        ? (after.sha256 === entry.found.sha256 ? 'matches' : 'changed')
        : result.outcome === 'refresh-failed' ? 'unavailable' : 'not-compared';
      if (result.error) item.error = result.error;
    }
    checked.push(item);
  }
  const problems = checked.filter((item) => item.integrity !== 'verified').length;
  return { ...base, ok: problems === 0, problems, checked, orphanSidecars: orphans.length,
    ...(problems ? { repair: 'singularity-flow index rebuild' } : {}) };
}

function printResult(result) {
  const say = (line) => console.log(line);
  say(`Read index (${result.scope}): repository checks ${result.settings.mode}, every ${result.settings.intervalMinutes} minutes.`);
  if (result.resultType === 'sflow-index-status') {
    if (!result.projections.length) say('No projections yet. First synchronization: singularity-flow index refresh');
    for (const item of result.projections) {
      say(`  ${item.read ?? item.kind ?? 'record'}: ${item.integrity === 'verified'
        ? `${item.freshness}, checked ${item.checkedAt}${item.refreshing ? ', refreshing now' : ''}${item.lastRefreshError ? `, last refresh failed (${item.lastRefreshError.code})` : ''}`
        : 'unverifiable (index rebuild discards it)'}`);
    }
    const pushes = result.pendingOperations.pushes;
    say(pushes.length ? `Pending pushes: ${pushes.map((push) => `${push.id} (${push.status})`).join(', ')}. Retry: ${result.pendingOperations.retry}`
      : 'No pending pushes for this repository.');
  } else if (result.resultType === 'sflow-index-refresh') {
    if (!result.refreshed.length && !result.firstReads.length) say('Nothing to refresh.');
    for (const item of [...result.refreshed, ...result.firstReads]) {
      say(`  ${item.read}: ${item.outcome}${item.error ? ` (${item.error.code}; the last-known state is kept)` : ''}`);
    }
  } else if (result.resultType === 'sflow-index-rebuild') {
    for (const item of result.rebuilt) say(`  ${item.kind ?? 'record'}: ${item.outcome}${item.reason ? ` (${item.reason})` : ''}`);
    say(result.preserved);
  } else {
    say(result.ok ? `All ${result.checked.length} records verified.` : `${result.problems} record(s) cannot be verified. Repair: ${result.repair}`);
    for (const item of result.checked.filter((entry) => entry.authority)) say(`  ${item.record}: ${item.authority}`);
  }
}

export async function run(_argv, { positionals, options = {} }) {
  const result = await indexCommand(positionals, options);
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else printResult(result);
  if (result.resultType === 'sflow-index-verify' && !result.ok) process.exitCode = 1;
  return result;
}
