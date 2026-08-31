/**
 * Private, machine-local memory for My Work.
 *
 * This store is intentionally outside every workspace and Git directory. It records only closed,
 * bounded outcome facts; it cannot supply lifecycle evidence, approval authority, or a publication
 * input. All Git observation is offline and read-only.
 */
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  appendFile, chmod, mkdir, readdir, readFile, rm, stat
} from 'node:fs/promises';

import { gitCommonDir, gitDir } from './git.mjs';
import { recordSha256 } from './records.mjs';
import { localChangesFor } from './gateway/planners/work-continue.mjs';
import {
  activeWorkspaceFile, workspaceMemberContextForRepository, workspaceRegistryFile
} from './workspace-context.mjs';
import {
  exists, nowIso, run, SingularityFlowError, writeAtomic
} from './util.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';

export const LOCAL_WORK_JOURNAL_SCHEMA_VERSION = currentSchemaVersion('local-work-journal');
export const JOURNAL_MODES = Object.freeze(['off', 'sflow-only', 'workspace-facts', 'enhanced']);
export const DEFAULT_JOURNAL_SETTINGS = Object.freeze({
  schemaVersion: LOCAL_WORK_JOURNAL_SCHEMA_VERSION,
  mode: 'workspace-facts',
  paused: false,
  retentionDays: 30,
  timeZone: null,
  fileSaves: false,
  vscodeTasks: true,
  debugSessions: false,
  copilotAggregates: false,
  promptContent: 'never',
  remoteSync: 'never'
});

const EVENT_KINDS = new Set([
  'work-started', 'work-resumed', 'phase-started', 'checkpoint', 'published', 'submitted',
  'reopened', 'completed', 'abandoned', 'artifact-recorded', 'test-result', 'check-result',
  'build-result', 'reproduction', 'verification', 'evidence-recorded', 'finding', 'challenge',
  'git-observation', 'review', 'rework', 'workspace-recovery', 'publication-recovery', 'repair'
]);
const FACT_KEYS = new Set([
  'branch', 'head', 'dirty', 'changedPaths', 'stagedPaths', 'localAhead', 'remoteEvidence',
  'mergeState', 'stashCount', 'pendingPublication', 'outcome', 'count', 'phase'
]);
const REMOTE_EVIDENCE = new Set(['confirmed', 'not-confirmed', 'unavailable']);
const MERGE_STATES = new Set(['none', 'merge', 'rebase', 'cherry-pick', 'revert']);
const OUTCOMES = new Set(['succeeded', 'failed', 'passed', 'refused', 'blocked', 'cancelled', 'completed']);

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function localWorkJournalRoot(env = process.env, home = os.homedir()) {
  return path.resolve(env.SINGULARITY_FLOW_LOCAL_JOURNAL
    || path.join(path.dirname(workspaceRegistryFile(env, home)), 'local-work-journal'));
}

export function journalWorkspaceKey(workspaceId) {
  const id = String(workspaceId ?? '').trim();
  if (!id) throw new SingularityFlowError('The local journal requires a workspace identity.');
  return sha256(`workspace:${id}`);
}

function repositoryKey(repositoryId) {
  return sha256(`repository:${String(repositoryId ?? 'unknown').trim()}`);
}

function settingsFile(root) { return path.join(root, 'preferences.json'); }
function workspaceDirectory(root, workspaceKey) { return path.join(root, 'workspaces', workspaceKey); }
function eventDirectory(root, workspaceKey) { return path.join(workspaceDirectory(root, workspaceKey), 'events'); }
function summaryDirectory(root, workspaceKey) { return path.join(workspaceDirectory(root, workspaceKey), 'summaries'); }
function eventFile(root, workspaceKey, date) { return path.join(eventDirectory(root, workspaceKey), `${date}.jsonl`); }

function localTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch { return 'UTC'; }
}

function validTimeZone(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).format();
    return value.trim();
  } catch { return null; }
}

export function journalDate(at = new Date(), timeZone = localTimeZone()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(at);
  const value = Object.fromEntries(parts.map((entry) => [entry.type, entry.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => {});
}

export async function readJournalSettings({ env = process.env, home = os.homedir() } = {}) {
  const root = localWorkJournalRoot(env, home);
  let stored = {};
  try { stored = readRecord('local-work-journal', await readFile(settingsFile(root))).record; }
  catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new SingularityFlowError(`Unable to read local journal settings: ${error.message}`);
    }
  }
  const mode = JOURNAL_MODES.includes(stored.mode) ? stored.mode : DEFAULT_JOURNAL_SETTINGS.mode;
  const retentionDays = Number.isInteger(stored.retentionDays)
    && stored.retentionDays >= 1 && stored.retentionDays <= 365
    ? stored.retentionDays : DEFAULT_JOURNAL_SETTINGS.retentionDays;
  return Object.freeze({
    ...DEFAULT_JOURNAL_SETTINGS,
    ...stored,
    schemaVersion: LOCAL_WORK_JOURNAL_SCHEMA_VERSION,
    mode,
    paused: stored.paused === true,
    retentionDays,
    timeZone: validTimeZone(stored.timeZone) ?? localTimeZone(),
    promptContent: 'never',
    remoteSync: 'never',
    fileSaves: false
  });
}

export async function updateJournalSettings(updates = {}, options = {}) {
  const current = await readJournalSettings(options);
  if (updates.mode != null && !JOURNAL_MODES.includes(updates.mode)) {
    throw new SingularityFlowError(`Journal mode must be one of ${JOURNAL_MODES.join(', ')}.`);
  }
  if (updates.retentionDays != null
    && (!Number.isInteger(updates.retentionDays) || updates.retentionDays < 1 || updates.retentionDays > 365)) {
    throw new SingularityFlowError('Journal retention must be an integer from 1 to 365 days.');
  }
  if (updates.timeZone != null) {
    if (!validTimeZone(updates.timeZone)) throw new SingularityFlowError(`Unknown time zone '${updates.timeZone}'.`);
  }
  const next = {
    ...current,
    ...updates,
    schemaVersion: LOCAL_WORK_JOURNAL_SCHEMA_VERSION,
    promptContent: 'never', remoteSync: 'never', fileSaves: false
  };
  const root = localWorkJournalRoot(options.env, options.home);
  await ensurePrivateDirectory(root);
  await writeAtomic(settingsFile(root), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await chmod(settingsFile(root), 0o600).catch(() => {});
  return Object.freeze(next);
}

function boundedText(value, label, maximum = 128) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!text || text.length > maximum) throw new SingularityFlowError(`Journal ${label} is invalid.`);
  return text;
}

function sanitizeFacts(input = {}) {
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (!FACT_KEYS.has(key)) continue;
    if (key === 'branch' || key === 'phase') {
      output[key] = boundedText(value, key);
    } else if (key === 'outcome') {
      if (OUTCOMES.has(value)) output[key] = value;
    } else if (key === 'head') {
      if (!/^[a-f0-9]{7,64}$/i.test(String(value ?? ''))) continue;
      output[key] = String(value).toLowerCase();
    } else if (key === 'remoteEvidence') {
      if (REMOTE_EVIDENCE.has(value)) output[key] = value;
    } else if (key === 'mergeState') {
      if (MERGE_STATES.has(value)) output[key] = value;
    } else if (typeof value === 'boolean') output[key] = value;
    else if (Number.isInteger(value) && value >= 0 && value <= 1_000_000) output[key] = value;
  }
  return Object.freeze(output);
}

function normalizedEvent({
  workspaceId, repositoryId, workId = null, kind, summaryCode, facts = {}, at = nowIso(),
  correlationId = null
}) {
  if (!EVENT_KINDS.has(kind)) throw new SingularityFlowError(`Unsupported local journal event '${kind}'.`);
  if (!/^journal\.[a-z0-9.-]+$/.test(String(summaryCode ?? ''))) {
    throw new SingularityFlowError('Journal events require a catalog-style summary code.');
  }
  const workspaceKey = journalWorkspaceKey(workspaceId);
  const safeFacts = sanitizeFacts(facts);
  // A caller may bind an event to an authoritative operation receipt without placing that receipt,
  // argv, prompt text, or any other potentially sensitive value in the journal. Manual captures
  // retain their content-based deduplication; automatic captures use this one-way correlation so a
  // retried command invocation is a distinct local fact while replaying the same receipt is not.
  const correlation = correlationId ? sha256(`correlation:${String(correlationId)}`) : null;
  const stable = JSON.stringify({
    workspaceKey, repository: repositoryKey(repositoryId), workId, kind, summaryCode,
    facts: safeFacts, correlation
  });
  const core = {
    schemaVersion: LOCAL_WORK_JOURNAL_SCHEMA_VERSION,
    id: `jrn_${sha256(stable).slice(0, 24)}`,
    at: new Date(at).toISOString(),
    zone: localTimeZone(),
    workspace: workspaceKey,
    repository: repositoryKey(repositoryId),
    ...(workId ? { workId: boundedText(workId, 'work ID') } : {}),
    kind,
    summaryCode,
    facts: safeFacts,
    ...(correlation ? { correlation } : {}),
    references: Object.freeze(workId ? [{ kind: 'work', id: boundedText(workId, 'work ID') }] : []),
    privacy: Object.freeze({ localOnly: true, remoteSync: 'never', evidence: false })
  };
  return Object.freeze({
    ...core,
    integrity: Object.freeze({ algorithm: 'sha256', sha256: recordSha256(core) })
  });
}

async function existingIds(file) {
  try {
    return new Set((await readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line).id]; } catch { return []; }
    }));
  } catch (error) {
    if (error?.code === 'ENOENT') return new Set();
    throw error;
  }
}

async function enforceRetention(root, workspaceKey, settings, today) {
  let names = [];
  try { names = await readdir(eventDirectory(root, workspaceKey)); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - settings.retentionDays);
  const expired = names.filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .map((name) => name.slice(0, 10)).filter((date) => date < cutoff.toISOString().slice(0, 10)).sort();
  if (!expired.length) return null;
  const date = expired[0];
  await rm(eventFile(root, workspaceKey, date), { force: true });
  await rm(path.join(summaryDirectory(root, workspaceKey), `${date}.json`), { force: true });
  return date;
}

export async function appendJournalEvent(input, options = {}) {
  const settings = await readJournalSettings(options);
  if (settings.paused || settings.mode === 'off') return { stored: false, reason: 'capture-disabled' };
  const event = normalizedEvent(input);
  const root = localWorkJournalRoot(options.env, options.home);
  const date = journalDate(new Date(event.at), settings.timeZone);
  const directory = eventDirectory(root, event.workspace);
  await ensurePrivateDirectory(directory);
  const file = eventFile(root, event.workspace, date);
  if ((await existingIds(file)).has(event.id)) return { stored: false, reason: 'duplicate', event };
  await appendFile(file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
  await enforceRetention(root, event.workspace, settings, date);
  return { stored: true, event };
}

async function pendingPublication(root) {
  const directories = [...new Set([gitCommonDir(root), gitDir(root)])]
    .map((directory) => path.join(directory, 'singularity-flow', 'pending-publication'));
  for (const directory of directories) {
    try {
      if ((await readdir(directory)).some((name) => name.endsWith('.json'))) return true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return false;
}

async function mergeState(root) {
  const directory = gitDir(root);
  for (const [name, file] of [
    ['merge', 'MERGE_HEAD'], ['rebase', 'rebase-merge'], ['rebase', 'rebase-apply'],
    ['cherry-pick', 'CHERRY_PICK_HEAD'], ['revert', 'REVERT_HEAD']
  ]) if (await exists(path.join(directory, file))) return name;
  return 'none';
}

function outputInteger(root, args) {
  const result = run('git', args, { cwd: root, allowFailure: true });
  const value = Number.parseInt(result.stdout.trim(), 10);
  return result.status === 0 && Number.isInteger(value) && value >= 0 ? value : 0;
}

function outputPathCount(root, args) {
  const result = run('git', args, { cwd: root, allowFailure: true });
  return result.status === 0 ? result.stdout.split('\0').filter(Boolean).length : 0;
}

/** Capture one bounded, offline snapshot of a registered repository. */
export async function observeRepository(root, { workspaceId, repositoryId, workId = null } = {}, options = {}) {
  const repositoryRoot = path.resolve(root);
  const journalRoot = localWorkJournalRoot(options.env, options.home);
  const relative = path.relative(repositoryRoot, journalRoot);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new SingularityFlowError('The local journal must be stored outside the repository worktree.');
  }
  const changes = localChangesFor(root);
  const branchResult = run('git', ['branch', '--show-current'], { cwd: root, allowFailure: true });
  const headResult = run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, allowFailure: true });
  const upstream = run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], {
    cwd: root, allowFailure: true
  });
  let localAhead = 0;
  let remoteEvidence = 'unavailable';
  if (upstream.status === 0 && upstream.stdout.trim()) {
    localAhead = outputInteger(root, ['rev-list', '--count', `${upstream.stdout.trim()}..HEAD`]);
    const contained = run('git', ['merge-base', '--is-ancestor', 'HEAD', upstream.stdout.trim()], {
      cwd: root, allowFailure: true
    });
    remoteEvidence = contained.status === 0 ? 'confirmed' : 'not-confirmed';
  } else if (headResult.status === 0) remoteEvidence = 'not-confirmed';
  return appendJournalEvent({
    workspaceId, repositoryId, workId, kind: 'git-observation',
    summaryCode: 'journal.git-observed',
    facts: {
      branch: branchResult.stdout.trim() || 'detached',
      head: headResult.stdout.trim(),
      dirty: changes?.dirty ?? false,
      changedPaths: changes?.files ?? 0,
      stagedPaths: outputPathCount(root, ['diff', '--cached', '--name-only', '-z', '--no-textconv']),
      localAhead,
      remoteEvidence,
      mergeState: await mergeState(root),
      stashCount: outputInteger(root, ['rev-list', '--count', 'refs/stash']),
      pendingPublication: await pendingPublication(root)
    }
  }, options);
}

export async function readJournalEvents(workspaceId, date, options = {}) {
  const settings = await readJournalSettings(options);
  const root = localWorkJournalRoot(options.env, options.home);
  const key = journalWorkspaceKey(workspaceId);
  const selectedDate = date ?? journalDate(new Date(), settings.timeZone);
  let text = '';
  try { text = await readFile(eventFile(root, key, selectedDate), 'utf8'); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const events = [];
  const malformed = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line) continue;
    try {
      const event = readRecord('local-work-journal', line).record;
      const { integrity, ...core } = event ?? {};
      const validIntegrity = integrity?.algorithm === 'sha256'
        && integrity.sha256 === recordSha256(core);
      if (event.privacy?.localOnly === true && validIntegrity) {
        events.push(event);
      } else malformed.push(index + 1);
    } catch { malformed.push(index + 1); }
  }
  return { settings, root, workspaceKey: key, date: selectedDate, events, malformed };
}

function summaryFor(event) {
  if (event.kind === 'git-observation') {
    if (event.facts.pendingPublication) return 'A publication is waiting for recovery.';
    if (event.facts.mergeState && event.facts.mergeState !== 'none') return `A ${event.facts.mergeState} is in progress.`;
    if (event.facts.dirty) return `${event.facts.changedPaths ?? 0} changed path(s) remain local.`;
    if (event.facts.remoteEvidence === 'not-confirmed') return 'The current commit is not confirmed on the remote.';
    return 'Repository state was checked locally.';
  }
  const labels = {
    'work-started': 'Governed work started', 'work-resumed': 'Governed work resumed',
    'phase-started': 'Phase work started', completed: 'Work completed', abandoned: 'Work abandoned',
    verification: 'Verification recorded', reproduction: 'Failure reproduced', reopened: 'Phase reopened',
    checkpoint: 'Local checkpoint recorded', published: 'Generation published', submitted: 'Phase submitted',
    review: 'Review decision recorded', rework: 'Rework requested', challenge: 'Governed change recorded',
    repair: 'Repair outcome recorded', 'publication-recovery': 'Publication recovery completed',
    'test-result': 'Test outcome recorded', 'check-result': 'Check outcome recorded'
  };
  return labels[event.kind] ?? 'Governed work progressed';
}

export async function journalToday(workspaceId, { date = null, ...options } = {}) {
  const read = await readJournalEvents(workspaceId, date, options);
  const ordered = [...read.events].sort((left, right) => left.at.localeCompare(right.at));
  const work = new Map();
  const attention = [];
  for (const event of ordered) {
    const summary = { id: event.id, at: event.at, kind: event.kind, workId: event.workId ?? null, text: summaryFor(event) };
    if (event.kind === 'git-observation' && (
      event.facts.dirty || event.facts.pendingPublication || event.facts.mergeState !== 'none'
      || event.facts.remoteEvidence === 'not-confirmed')) attention.push(summary);
    else work.set(event.workId ?? event.id, summary);
  }
  return Object.freeze({
    schemaVersion: LOCAL_WORK_JOURNAL_SCHEMA_VERSION,
    resultType: 'local-work-journal-day',
    generatedAt: nowIso(),
    date: read.date,
    timeZone: read.settings.timeZone,
    privacy: Object.freeze({ localOnly: true, remoteSync: 'never', label: 'Stored locally · Never pushed' }),
    capture: Object.freeze({ mode: read.settings.mode, paused: read.settings.paused }),
    summaries: Object.freeze([...work.values()].slice(-3).reverse()),
    attention: Object.freeze(attention.slice(-3).reverse()),
    totalEvents: ordered.length,
    malformedLines: Object.freeze(read.malformed)
  });
}

/** The preceding calendar date, independent of daylight-saving transitions. */
export function previousJournalDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ''))) {
    throw new SingularityFlowError('Journal date must use YYYY-MM-DD.');
  }
  const instant = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 10) !== date) {
    throw new SingularityFlowError('Journal date must be a real calendar date.');
  }
  instant.setUTCDate(instant.getUTCDate() - 1);
  return instant.toISOString().slice(0, 10);
}

/**
 * Bounded return memory for Home and Copilot.
 *
 * Both days are read from the same private store and selected with its configured time zone. The
 * context never reconstructs lifecycle state and never claims that a missing event means work did
 * not happen. Yesterday is deliberately present even after today's first event so a host/model
 * switch cannot make the stopping point disappear halfway through the day.
 */
export async function dailyReturnContext(workspaceId, { now = new Date(), ...options } = {}) {
  const settings = await readJournalSettings(options);
  const todayDate = journalDate(now, settings.timeZone);
  const yesterdayDate = previousJournalDate(todayDate);
  const [today, yesterday] = await Promise.all([
    journalToday(workspaceId, { ...options, date: todayDate }),
    journalToday(workspaceId, { ...options, date: yesterdayDate })
  ]);
  return Object.freeze({
    schemaVersion: LOCAL_WORK_JOURNAL_SCHEMA_VERSION,
    resultType: 'local-work-journal-return-context',
    generatedAt: nowIso(),
    timeZone: settings.timeZone,
    privacy: Object.freeze({ localOnly: true, remoteSync: 'never', label: 'Stored locally · Never pushed' }),
    today,
    yesterday: yesterday.totalEvents ? yesterday : null
  });
}

const COMMAND_EVENT = Object.freeze({
  start: 'work-started', 'story.start': 'work-started',
  resume: 'work-resumed', 'story.fetch': 'work-resumed',
  prepare: 'phase-started', submit: 'submitted', 'story.submit': 'submitted',
  approve: 'review', reject: 'rework', 'story.rework': 'rework', reopen: 'reopened',
  finalize: 'completed', 'story.finalize': 'completed', cancel: 'abandoned',
  'story.interval.checkpoint': 'checkpoint', 'story.checks': 'check-result',
  'story.converge': 'verification', 'story.converge.assisted': 'verification',
  'fix.request': 'repair', 'repair.authorize': 'repair', 'repair.attempt': 'repair',
  sync: 'publication-recovery',
  'story.intent-amendment.propose': 'challenge', 'story.intent-amendment.decide': 'challenge'
});

function phaseForCommand(operationId, positionals, options) {
  const option = options?.phase ?? options?.['phase-id'];
  if (typeof option === 'string' && option.trim()) return option.trim();
  if (operationId === 'phase' && positionals[1] === 'publish') return positionals[2] ?? null;
  if (['prepare', 'submit', 'approve', 'reject', 'reopen'].includes(operationId)) {
    return positionals[1] ?? null;
  }
  return null;
}

function workIdForResult(result, context, options) {
  const candidates = [
    result?.subject?.id, result?.data?.workId, result?.data?.work?.id, result?.workId,
    options?.['work-id'], options?.workId, context?.storyId
  ];
  return candidates.find((value) => typeof value === 'string' && value.trim())?.trim() ?? null;
}

/**
 * Record a successful authoritative CLI outcome without joining the operation transaction.
 *
 * This is intentionally best-effort and called only after the command handler returns. A journal
 * failure can neither fail nor replay the governed operation. Only an explicit closed operation
 * map is captured; read commands and newly added mutations remain absent until deliberately
 * classified here.
 */
export async function captureCommandOutcome({
  root, operationId, positionals = [], options = {}, result = null,
  startedAt = nowIso(), env = process.env, home = os.homedir()
} = {}) {
  if (!root) return { stored: false, reason: 'no-repository' };
  let kind = COMMAND_EVENT[operationId] ?? null;
  if (operationId === 'phase') kind = positionals[1] === 'publish' ? 'published' : null;
  if (!kind) return { stored: false, reason: 'operation-not-captured' };
  if (['failed', 'refused', 'blocked', 'cancelled'].includes(result?.outcome?.status)) {
    return { stored: false, reason: 'operation-not-successful' };
  }
  const context = await workspaceMemberContextForRepository(
    root, activeWorkspaceFile(env, home), workspaceRegistryFile(env, home)
  );
  if (!context) return { stored: false, reason: 'repository-not-active' };
  const phase = phaseForCommand(operationId, positionals, options);
  return appendJournalEvent({
    workspaceId: context.workspaceId,
    repositoryId: context.repositoryId,
    workId: workIdForResult(result, context, options),
    kind,
    summaryCode: `journal.${kind}`,
    facts: { outcome: 'succeeded', ...(phase ? { phase } : {}) },
    at: startedAt,
    correlationId: `${operationId}:${startedAt}`
  }, { env, home });
}

export async function deleteJournalDay(workspaceId, date, options = {}) {
  const root = localWorkJournalRoot(options.env, options.home);
  const key = journalWorkspaceKey(workspaceId);
  await rm(eventFile(root, key, date), { force: true });
  await rm(path.join(summaryDirectory(root, key), `${date}.json`), { force: true });
  return { deleted: true, date, workspaceKey: key };
}

export async function deleteAllJournal(options = {}) {
  const root = localWorkJournalRoot(options.env, options.home);
  await rm(path.join(root, 'workspaces'), { recursive: true, force: true });
  return { deleted: true, scope: 'all-local-journal-history' };
}

export async function journalDoctor(options = {}) {
  const root = localWorkJournalRoot(options.env, options.home);
  const registryParent = path.dirname(workspaceRegistryFile(options.env, options.home));
  const findings = [];
  const relative = path.relative(registryParent, root);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    findings.push({ id: 'location', state: 'attention', detail: 'Journal uses an explicit machine-local path outside the workspace-registry directory.' });
  } else findings.push({ id: 'location', state: 'ready', detail: 'Journal is beside the machine-local workspace registry.' });
  try {
    const details = await stat(root);
    findings.push({ id: 'directory', state: details.isDirectory() ? 'ready' : 'blocked', detail: details.isDirectory() ? 'Journal directory is readable.' : 'Journal path is not a directory.' });
    if (process.platform !== 'win32') {
      findings.push({ id: 'permissions', state: (details.mode & 0o077) === 0 ? 'ready' : 'attention', detail: `Directory permissions are ${(details.mode & 0o777).toString(8)}.` });
    }
  } catch (error) {
    findings.push({ id: 'directory', state: error?.code === 'ENOENT' ? 'ready' : 'blocked', detail: error?.code === 'ENOENT' ? 'Journal has not stored anything yet.' : error.message });
  }
  findings.push({ id: 'network', state: 'ready', detail: 'Journal capture has no network operation.' });
  findings.push({ id: 'privacy', state: 'ready', detail: 'Prompt content, source bytes, command output, and remote sync are disabled.' });
  return Object.freeze({
    schemaVersion: LOCAL_WORK_JOURNAL_SCHEMA_VERSION,
    resultType: 'local-work-journal-doctor',
    location: 'machine-state/local-work-journal',
    findings: Object.freeze(findings),
    healthy: findings.every((entry) => entry.state !== 'blocked')
  });
}

/** Publication and export code can use this closed containment check as a fail-closed guard. */
export function isLocalJournalPath(candidate, options = {}) {
  const root = localWorkJournalRoot(options.env, options.home);
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
