/** Workspace-local, content-free measurements for the deterministic help resolver. */
import path from 'node:path';
import {
  appendFile, chmod, mkdir, open, readFile, stat, unlink
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import {
  activeWorkspaceFile, workspaceMemberContextForRepository, workspaceRegistryFile
} from './workspace-context.mjs';
import { gitDir } from './git.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { SingularityFlowError, writeAtomic } from './util.mjs';

const DIRECTORY = 'help-metrics';
const LOG = 'events.jsonl';
const SETTINGS = 'settings.json';
const LOCK = 'write.lock';
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAXIMUM_BYTES = 4 * 1024 * 1024;
const LOCK_RETRIES = 250;
const LOCK_RETRY_MS = 20;
const LOCK_STALE_MS = 5 * 60_000;
const SURFACES = new Set(['chat', 'help-center', 'cli', 'error-link']);
const INTENTS = new Set(['concept', 'procedure', 'diagnose', 'compare', 'command-discovery', 'recover']);
const OUTCOMES = new Set(['resolved', 'ambiguous', 'no-match', 'unavailable']);
const ACTIONS = new Set(['followup-opened', 'command-copied', 'command-prefilled', 'topic-opened', 'error-explained']);
const SAFE_ID = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => {});
}

async function withLock(directory, callback) {
  await privateDirectory(directory);
  const lockFile = path.join(directory, LOCK);
  const token = `${process.pid}:${randomUUID()}`;
  let handle = null;
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      handle = await open(lockFile, 'wx', 0o600);
      await handle.writeFile(token);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const info = await stat(lockFile).catch(() => null);
      if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await unlink(lockFile).catch(() => {});
        continue;
      }
      await delay(LOCK_RETRY_MS);
    }
  }
  if (!handle) throw new SingularityFlowError('Help-metrics storage is busy. Retry the command.', {
    code: 'HELP_METRICS_LOCK_BUSY'
  });
  try { return await callback(); }
  finally {
    await handle.close().catch(() => {});
    const owner = await readFile(lockFile, 'utf8').catch(() => null);
    if (owner === token) await unlink(lockFile).catch(() => {});
  }
}

async function location(root) {
  const workspace = await workspaceMemberContextForRepository(
    root, activeWorkspaceFile(), workspaceRegistryFile()
  );
  const directory = workspace
    ? path.join(workspace.workspacePath, '.singularity-flow', DIRECTORY)
    : path.join(gitDir(root), 'singularity-flow', DIRECTORY);
  return {
    scope: workspace ? 'workspace' : 'repository',
    directory,
    logFile: path.join(directory, LOG),
    settingsFile: path.join(directory, SETTINGS)
  };
}

function defaults() {
  return {
    enabled: true,
    retentionDays: DEFAULT_RETENTION_DAYS,
    maximumBytes: DEFAULT_MAXIMUM_BYTES,
    updatedAt: null,
    lastPrunedAt: null
  };
}

async function readSettings(file) {
  try {
    const value = readRecord('help-metrics-settings', await readFile(file)).record;
    return {
      enabled: value.enabled !== false,
      retentionDays: Number.isInteger(value.retentionDays) && value.retentionDays >= 1 && value.retentionDays <= 365
        ? value.retentionDays : DEFAULT_RETENTION_DAYS,
      maximumBytes: Number.isSafeInteger(value.maximumBytes) && value.maximumBytes >= 1024
        ? value.maximumBytes : DEFAULT_MAXIMUM_BYTES,
      updatedAt: value.updatedAt ?? null,
      lastPrunedAt: value.lastPrunedAt ?? null
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return defaults();
    throw new SingularityFlowError(`Help-metrics settings are invalid: ${error.message}`, {
      code: 'HELP_METRICS_SETTINGS_INVALID'
    });
  }
}

async function writeSettings(file, value) {
  await writeAtomic(file, `${JSON.stringify({
    schemaVersion: currentSchemaVersion('help-metrics-settings'),
    enabled: value.enabled,
    retentionDays: value.retentionDays,
    maximumBytes: value.maximumBytes,
    updatedAt: value.updatedAt,
    lastPrunedAt: value.lastPrunedAt
  }, null, 2)}\n`);
  await chmod(file, 0o600).catch(() => {});
}

function safeEnum(value, allowed, field) {
  if (!allowed.has(value)) throw new SingularityFlowError(`Unknown help-metrics ${field} '${value}'.`, {
    code: 'HELP_METRICS_EVENT_INVALID'
  });
  return value;
}

function safeId(value, field, { nullable = false } = {}) {
  if (value == null && nullable) return null;
  const normalized = String(value ?? '').trim();
  if (!SAFE_ID.test(normalized) || normalized.length > 96) {
    throw new SingularityFlowError(`Help-metrics ${field} must be a bounded lower-case identifier.`, {
      code: 'HELP_METRICS_EVENT_INVALID'
    });
  }
  return normalized;
}

function eventRecord(input, now = new Date()) {
  const allowed = new Set([
    'surface', 'intent', 'outcome', 'topicId', 'matchedBy', 'latencyMs', 'answerBytes', 'actionCategory'
  ]);
  for (const key of Object.keys(input ?? {})) {
    if (!allowed.has(key)) throw new SingularityFlowError(`Help-metrics refuses unrecognized field '${key}'.`, {
      code: 'HELP_METRICS_EVENT_INVALID'
    });
  }
  const latencyMs = Number(input.latencyMs ?? 0);
  const answerBytes = Number(input.answerBytes ?? 0);
  if (!Number.isSafeInteger(latencyMs) || latencyMs < 0 || latencyMs > 3_600_000
      || !Number.isSafeInteger(answerBytes) || answerBytes < 0 || answerBytes > 65_536) {
    throw new SingularityFlowError('Help-metrics latencyMs or answerBytes is outside its bounded range.', {
      code: 'HELP_METRICS_EVENT_INVALID'
    });
  }
  return Object.freeze({
    schemaVersion: currentSchemaVersion('help-metrics-event'),
    timestamp: now.toISOString(),
    surface: safeEnum(input.surface, SURFACES, 'surface'),
    intent: safeEnum(input.intent, INTENTS, 'intent'),
    outcome: safeEnum(input.outcome, OUTCOMES, 'outcome'),
    topicId: safeId(input.topicId, 'topicId', { nullable: true }),
    matchedBy: safeId(input.matchedBy, 'matchedBy'),
    latencyMs,
    answerBytes,
    actionCategory: input.actionCategory == null
      ? null : safeEnum(input.actionCategory, ACTIONS, 'actionCategory')
  });
}

async function records(file) {
  const source = await readFile(file, 'utf8').catch((error) => error?.code === 'ENOENT' ? '' : Promise.reject(error));
  const values = [];
  const warnings = [];
  for (const [index, line] of source.split('\n').entries()) {
    if (!line.trim()) continue;
    try { values.push(readRecord('help-metrics-event', line).record); }
    catch (error) { warnings.push(`Help-metrics line ${index + 1} is unreadable: ${error.message}`); }
  }
  return { values, warnings };
}

async function prune(target, config, now = new Date()) {
  const loaded = await records(target.logFile);
  const cutoff = now.getTime() - config.retentionDays * 24 * 60 * 60_000;
  let kept = loaded.values.filter((record) => Date.parse(record.timestamp) >= cutoff);
  while (kept.length && Buffer.byteLength(kept.map((record) => JSON.stringify(record)).join('\n') + '\n') > config.maximumBytes) {
    kept = kept.slice(1);
  }
  await writeAtomic(target.logFile, kept.length ? `${kept.map((record) => JSON.stringify(record)).join('\n')}\n` : '');
  await chmod(target.logFile, 0o600).catch(() => {});
  return { ...config, lastPrunedAt: now.toISOString() };
}

export async function recordHelpMetric(root, input, { now = new Date() } = {}) {
  const target = await location(root);
  return withLock(target.directory, async () => {
    let config = await readSettings(target.settingsFile);
    if (!config.enabled) return { recorded: false, reason: 'disabled', ...target };
    const record = eventRecord(input, now);
    await appendFile(target.logFile, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(target.logFile, 0o600).catch(() => {});
    const info = await stat(target.logFile);
    const pruneDue = !config.lastPrunedAt || now.getTime() - Date.parse(config.lastPrunedAt) >= 24 * 60 * 60_000
      || info.size > config.maximumBytes;
    if (pruneDue) {
      config = await prune(target, config, now);
      await writeSettings(target.settingsFile, { ...config, updatedAt: config.updatedAt ?? now.toISOString() });
    }
    return { recorded: true, record, ...target };
  });
}

function counts(values, field) {
  const result = {};
  for (const value of values) {
    const key = value[field] ?? 'none';
    result[key] = (result[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

export async function helpMetricsStatus(root) {
  const target = await location(root);
  const config = await readSettings(target.settingsFile);
  const loaded = await records(target.logFile);
  const info = await stat(target.logFile).catch(() => null);
  return {
    enabled: config.enabled,
    scope: target.scope,
    logFile: target.logFile,
    count: loaded.values.length,
    bytes: info?.size ?? 0,
    retentionDays: config.retentionDays,
    maximumBytes: config.maximumBytes,
    lastRecordedAt: loaded.values.at(-1)?.timestamp ?? null,
    outcomes: counts(loaded.values, 'outcome'),
    intents: counts(loaded.values, 'intent'),
    topics: counts(loaded.values.filter((record) => record.topicId), 'topicId'),
    surfaces: counts(loaded.values, 'surface'),
    actions: counts(loaded.values.filter((record) => record.actionCategory), 'actionCategory'),
    unresolvedIntents: counts(loaded.values.filter((record) => ['ambiguous', 'no-match'].includes(record.outcome)), 'intent'),
    ambiguousIntents: counts(loaded.values.filter((record) => record.outcome === 'ambiguous'), 'intent'),
    noMatchIntents: counts(loaded.values.filter((record) => record.outcome === 'no-match'), 'intent'),
    warnings: loaded.warnings
  };
}

export async function setHelpMetrics(root, enabled) {
  const target = await location(root);
  await withLock(target.directory, async () => {
    const config = await readSettings(target.settingsFile);
    await writeSettings(target.settingsFile, { ...config, enabled: Boolean(enabled), updatedAt: new Date().toISOString() });
  });
  return helpMetricsStatus(root);
}

export async function clearHelpMetrics(root) {
  const target = await location(root);
  let removed = 0;
  await withLock(target.directory, async () => {
    const loaded = await records(target.logFile);
    removed = loaded.values.length;
    await writeAtomic(target.logFile, '');
    await chmod(target.logFile, 0o600).catch(() => {});
  });
  return { ...(await helpMetricsStatus(root)), removed };
}
