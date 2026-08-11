import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { gitDir } from './git.mjs';
import { logFilePath, parseLogLines } from './logging.mjs';
import { parseCopilotTelemetry } from './telemetry.mjs';
import { readWorkspace } from './workspace.mjs';
import {
  activeWorkspaceFile, readActiveWorkspaceContext, workspaceRegistryFile
} from './workspace-context.mjs';
import { SingularityFlowError } from './util.mjs';

export const WORKSPACE_LOG_SCHEMA_VERSION = 1;
export const WORKSPACE_LOG_SOURCES = Object.freeze(['activity', 'prompt', 'telemetry', 'workspace']);

function isoTimestamp(value) {
  if (value == null || value === '') return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function severity(value, fallback = 'info') {
  const level = String(value ?? '').trim().toLowerCase();
  if (level === 'warning') return 'warn';
  return ['error', 'warn', 'info', 'debug'].includes(level) ? level : fallback;
}

function safeDetails(value) {
  if (!value || typeof value !== 'object') return {};
  const output = { ...value };
  delete output.prompt;
  delete output.raw;
  delete output.spans;
  return output;
}

async function textIfFile(file) {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return null;
  return readFile(file, 'utf8');
}

function entry(input, sequence) {
  return {
    id: input.id,
    timestamp: isoTimestamp(input.timestamp),
    source: input.source,
    severity: severity(input.severity),
    repositoryId: input.repositoryId ?? null,
    workId: input.workId ?? null,
    phase: input.phase ?? null,
    agent: input.agent ?? null,
    event: input.event ?? null,
    summary: input.summary ?? input.event ?? 'Log entry',
    durationMs: Number.isFinite(Number(input.durationMs)) ? Number(input.durationMs) : null,
    details: safeDetails(input.details),
    sourcePath: input.sourcePath,
    _sequence: sequence
  };
}

export function compareWorkspaceLogEntries(left, right) {
  const leftTime = left.timestamp ? Date.parse(left.timestamp) : Number.NEGATIVE_INFINITY;
  const rightTime = right.timestamp ? Date.parse(right.timestamp) : Number.NEGATIVE_INFINITY;
  if (leftTime !== rightTime) return rightTime - leftTime;
  return String(left.source).localeCompare(String(right.source))
    || String(left.repositoryId ?? '').localeCompare(String(right.repositoryId ?? ''))
    || Number(left._sequence ?? 0) - Number(right._sequence ?? 0);
}

function matches(entryValue, requested) {
  return !requested || String(entryValue ?? '').toLocaleLowerCase('en-US')
    === String(requested).toLocaleLowerCase('en-US');
}

function filterEntries(entries, filters) {
  const since = filters.since ? Date.parse(filters.since) : null;
  if (filters.since && !Number.isFinite(since)) {
    throw new SingularityFlowError(`--since must be an ISO timestamp; received '${filters.since}'.`);
  }
  const query = String(filters.text ?? '').trim().toLocaleLowerCase('en-US');
  return entries.filter((item) => {
    if (filters.source && filters.source !== 'all' && item.source !== filters.source) return false;
    if (!matches(item.repositoryId, filters.repository)) return false;
    if (!matches(item.workId, filters.workId)) return false;
    if (!matches(item.phase, filters.phase)) return false;
    if (!matches(item.agent, filters.agent)) return false;
    if (!matches(item.severity, filters.level)) return false;
    if (since != null && (!item.timestamp || Date.parse(item.timestamp) < since)) return false;
    if (query) {
      const haystack = `${item.event ?? ''} ${item.summary ?? ''} ${JSON.stringify(item.details)}`
        .toLocaleLowerCase('en-US');
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

function malformedEntry(source, repositoryId, file, line, raw, sequence) {
  return entry({
    id: `${source}:${repositoryId ?? 'workspace'}:${line}`,
    source,
    severity: 'warn',
    repositoryId,
    event: `${source}.malformed`,
    summary: `Malformed ${source} record on line ${line}`,
    details: { line, preview: String(raw).slice(0, 240) },
    sourcePath: file
  }, sequence);
}

function promptEntries(text, file, repositoryByPath, warnings, startSequence) {
  const output = [];
  let sequence = startSequence;
  for (const [index, line] of String(text).split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    sequence += 1;
    let record;
    try { record = JSON.parse(line); }
    catch {
      warnings.push(`Prompt audit ${file} contains invalid JSON on line ${index + 1}.`);
      output.push(malformedEntry('prompt', null, file, index + 1, line, sequence));
      continue;
    }
    const repositoryId = record.repositoryPath
      ? repositoryByPath.get(path.resolve(record.repositoryPath)) ?? null
      : null;
    output.push(entry({
      id: `prompt:${record.id ?? index + 1}`,
      timestamp: record.recordedAt,
      source: 'prompt', severity: 'info', repositoryId,
      workId: record.workId, phase: record.phase, agent: record.agent,
      event: 'prompt.captured', summary: record.task || `Prompt composed for ${record.phase ?? 'unknown phase'}`,
      details: {
        promptAuditId: record.id ?? null, workType: record.workType ?? null,
        generation: record.generation ?? null, promptSha256: record.promptSha256 ?? null,
        bytes: record.bytes ?? null, redactions: record.redactions ?? 0,
        supportingEvidence: record.supportingEvidence ?? [], references: record.references ?? []
      },
      sourcePath: file
    }, sequence));
  }
  return { entries: output, sequence };
}

function activityEntries(text, file, repositoryId, warnings, startSequence) {
  const output = [];
  let sequence = startSequence;
  for (const [index, record] of parseLogLines(text).entries()) {
    sequence += 1;
    if (record.event === 'log.unreadable') warnings.push(`${file} contains an unreadable record on line ${index + 1}.`);
    output.push(entry({
      id: `activity:${repositoryId}:${index + 1}`,
      timestamp: record.ts, source: 'activity', severity: record.level, repositoryId,
      workId: record.workId ?? record.workItemId, phase: record.phase ?? record.phaseId,
      agent: record.agent ?? record.persona, event: record.event,
      summary: record.msg ?? record.message ?? record.event,
      durationMs: record.durationMs,
      details: Object.fromEntries(Object.entries(record).filter(([key]) => !['ts', 'level', 'event', 'msg', 'message'].includes(key))),
      sourcePath: file
    }, sequence));
  }
  return { entries: output, sequence };
}

function telemetryEntries(text, file, repositoryId, warnings, startSequence) {
  const parsed = parseCopilotTelemetry(text);
  warnings.push(...parsed.warnings.map((warning) => `${file}: ${warning}`));
  const output = [];
  let sequence = startSequence;
  for (const [index, span] of parsed.spans.entries()) {
    sequence += 1;
    output.push(entry({
      id: `telemetry:${repositoryId}:${index + 1}`,
      timestamp: span.completedAt ?? span.startedAt,
      source: 'telemetry', severity: 'info', repositoryId,
      event: 'copilot.turn', summary: `${span.provider} · ${span.model}`,
      durationMs: span.startedAt && span.completedAt
        ? Math.max(0, Date.parse(span.completedAt) - Date.parse(span.startedAt)) : null,
      details: {
        provider: span.provider, model: span.model, startedAt: span.startedAt,
        completedAt: span.completedAt, inputTokens: span.inputTokens,
        outputTokens: span.outputTokens, cachedInputTokens: span.cachedInputTokens,
        cacheWriteInputTokens: span.cacheWriteInputTokens,
        providerCost: span.providerCost, costAvailable: span.providerCost != null
      }, sourcePath: file
    }, sequence));
  }
  return { entries: output, sequence };
}

function workspaceEntries(journal, file, warnings, startSequence) {
  const output = [];
  let sequence = startSequence;
  for (const [index, operation] of (journal.operations ?? []).entries()) {
    sequence += 1;
    output.push(entry({
      id: `workspace:${operation.id ?? index + 1}`,
      timestamp: operation.completedAt ?? operation.startedAt ?? journal.completedAt ?? journal.startedAt,
      source: 'workspace',
      severity: ['failed', 'error'].includes(operation.status) ? 'error'
        : ['pending', 'warning'].includes(operation.status) ? 'warn' : 'info',
      repositoryId: operation.repository ?? operation.repositoryId,
      event: `workspace.${operation.action ?? 'operation'}`,
      summary: operation.error || `${operation.action ?? 'Workspace operation'} ${operation.status ?? 'recorded'}`,
      details: operation, sourcePath: file
    }, sequence));
  }
  if (!Array.isArray(journal.operations)) warnings.push(`${file} has no operations array.`);
  return { entries: output, sequence };
}

export async function collectWorkspaceLogs({
  env = process.env, home, source = 'all', repository, workId, phase, agent, level, since,
  text, limit = 500
} = {}) {
  if (source !== 'all' && !WORKSPACE_LOG_SOURCES.includes(source)) {
    throw new SingularityFlowError(`Log source must be all, ${WORKSPACE_LOG_SOURCES.join(', ')}.`);
  }
  if (level && !['error', 'warn', 'info', 'debug'].includes(level)) {
    throw new SingularityFlowError('Log level must be error, warn, info, or debug.');
  }
  const context = await readActiveWorkspaceContext(
    activeWorkspaceFile(env, home), workspaceRegistryFile(env, home), { refresh: false }
  );
  if (!context) throw new SingularityFlowError('No workspace is active. Select a workspace before reading workspace logs.');
  const workspace = await readWorkspace(context.workspacePath);
  const warnings = [];
  const entries = [];
  const sources = [];
  let sequence = 0;
  const repositoryByPath = new Map();
  const repositories = Object.entries(workspace.repositories).map(([id, definition]) => ({
    id, path: path.resolve(workspace.path, definition.path)
  }));
  for (const item of repositories) repositoryByPath.set(path.resolve(item.path), item.id);

  if (source === 'all' || source === 'activity' || source === 'telemetry') {
    for (const item of repositories) {
      if (repository && item.id !== repository) continue;
      let directory;
      try { directory = gitDir(item.path); }
      catch (error) {
        warnings.push(`Repository '${item.id}' is unavailable: ${error.message}`);
        continue;
      }
      if (source === 'all' || source === 'activity') {
        const file = logFilePath(directory); sources.push({ source: 'activity', repositoryId: item.id, path: file });
        try {
          const content = await textIfFile(file);
          if (content != null) {
            const parsed = activityEntries(content, file, item.id, warnings, sequence);
            entries.push(...parsed.entries); sequence = parsed.sequence;
          }
        } catch (error) { warnings.push(`Unable to read activity log for '${item.id}': ${error.message}`); }
      }
      if (source === 'all' || source === 'telemetry') {
        const file = path.join(directory, 'singularity-flow', 'copilot-otel.jsonl');
        sources.push({ source: 'telemetry', repositoryId: item.id, path: file });
        try {
          const content = await textIfFile(file);
          if (content != null) {
            const parsed = telemetryEntries(content, file, item.id, warnings, sequence);
            entries.push(...parsed.entries); sequence = parsed.sequence;
          }
        } catch (error) { warnings.push(`Unable to read Copilot telemetry for '${item.id}': ${error.message}`); }
      }
    }
  }

  if (source === 'all' || source === 'prompt') {
    const file = path.join(workspace.path, '.singularity-flow', 'prompt-audit', 'prompts.jsonl');
    sources.push({ source: 'prompt', repositoryId: null, path: file });
    try {
      const content = await textIfFile(file);
      if (content != null) {
        const parsed = promptEntries(content, file, repositoryByPath, warnings, sequence);
        entries.push(...parsed.entries); sequence = parsed.sequence;
      }
    } catch (error) { warnings.push(`Unable to read workspace prompt audit: ${error.message}`); }
  }

  if (source === 'all' || source === 'workspace') {
    const file = path.join(workspace.path, workspace.directories?.logs ?? 'logs', 'workspace-materialization.json');
    sources.push({ source: 'workspace', repositoryId: null, path: file });
    try {
      const content = await textIfFile(file);
      if (content != null) {
        try {
          const parsed = workspaceEntries(JSON.parse(content), file, warnings, sequence);
          entries.push(...parsed.entries); sequence = parsed.sequence;
        } catch (error) {
          warnings.push(`Workspace materialization log is malformed: ${error.message}`);
          entries.push(malformedEntry('workspace', null, file, 1, content, ++sequence));
        }
      }
    } catch (error) { warnings.push(`Unable to read workspace materialization log: ${error.message}`); }
  }

  for (const item of entries) if (!item.timestamp) warnings.push(`Log entry '${item.id}' has a missing or invalid timestamp and was sorted last.`);
  const filtered = filterEntries(entries.sort(compareWorkspaceLogEntries), {
    source, repository, workId, phase, agent, level, since, text
  });
  const requestedLimit = Number(limit);
  const capped = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 5000) : 500;
  return {
    schemaVersion: WORKSPACE_LOG_SCHEMA_VERSION,
    workspace: { id: workspace.id, path: workspace.path },
    generatedAt: new Date().toISOString(),
    entries: filtered.slice(0, capped).map(({ _sequence, ...item }) => item),
    total: filtered.length,
    limit: capped,
    sources,
    warnings: [...new Set(warnings)]
  };
}
