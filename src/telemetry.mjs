import { nextPhaseGeneration } from './phase-generation.mjs';
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gitCommonDir } from './git.mjs';
import { combineUsageMetrics, providerTokenArithmetic, usageMetric } from './model-usage-contract.mjs';
import { boundedErrorType, summarizeCopilotActivity } from './copilot-activity.mjs';
import { exists, nowIso, snapshot, writeJson } from './util.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { listTelemetryLaunches, telemetryRawPath, telemetryWorktreeId } from './telemetry-provision.mjs';
import { withSubjectLock } from './subject-lock.mjs';

const CURSOR_SCHEMA = currentSchemaVersion('telemetry-cursor');
const RECORD_SCHEMA = currentSchemaVersion('phase-telemetry');
const CURSOR_SUBJECT = Object.freeze({ kind: 'telemetry-cursor', id: 'shared' });

async function managedTelemetrySetup() {
  const file = process.env.SINGULARITY_FLOW_COPILOT_TELEMETRY_SETUP_FILE
    ? path.resolve(process.env.SINGULARITY_FLOW_COPILOT_TELEMETRY_SETUP_FILE)
    : path.join(os.homedir(), '.singularity-flow', 'copilot-otel.sh');
  let source = null;
  try { source = await readFile(file, 'utf8'); } catch { /* An organization may configure telemetry without the managed wrapper. */ }
  const installed = source != null;
  // Current installers provide a named compatibility helper and never shadow `copilot`. The Node
  // launcher performs the final per-launch provisioning after disclosure and conflict checks.
  const current = installed && source.includes('singularity-flow copilot');
  return { path: file, installed, current };
}

function rawTelemetryPath(root) {
  const configured = process.env.COPILOT_OTEL_FILE_EXPORTER_PATH;
  return configured ? path.resolve(root, configured) : path.join(gitCommonDir(root), 'singularity-flow', 'copilot-otel.jsonl');
}

export async function copilotTelemetryStatus(root = null) {
  const raw = root ? rawTelemetryPath(root) : null;
  const info = raw ? await stat(raw).catch(() => null) : null;
  const setup = await managedTelemetrySetup();
  const fileConfigured = Boolean(process.env.COPILOT_OTEL_FILE_EXPORTER_PATH);
  const externalEndpoint = Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
  const explicitlyEnabled = String(process.env.COPILOT_OTEL_ENABLED ?? '').toLowerCase() === 'true';
  let spans = 0; const warnings = [];
  if (info?.isFile() && info.size) {
    const parsed = parseCopilotTelemetry(await readFile(raw, 'utf8'));
    spans = parsed.spans.length;
    warnings.push(...parsed.warnings);
  }
  if (externalEndpoint && !fileConfigured) warnings.push('An OTLP endpoint is configured, but Singularity Flow requires the Copilot file exporter for repository-scoped collection.');
  if (!fileConfigured && !externalEndpoint && !explicitlyEnabled && !spans) warnings.push('This process was started without Copilot OpenTelemetry configuration.');
  if (setup.installed && !setup.current) warnings.push('The installed Singularity Flow Copilot helper is legacy and shadows manual Copilot launches; rerun install.sh to replace it.');
  if (!root) warnings.push('No repository is selected; repository-scoped legacy telemetry is unavailable.');
  else if (!info?.isFile()) warnings.push('The repository telemetry file does not exist.');
  else if (!info.size) warnings.push('The repository telemetry file is empty; finish a Copilot turn before checking again.');
  else if (!spans) warnings.push('The telemetry file contains no completed Copilot chat spans.');
  return {
    enabled: fileConfigured || externalEndpoint || explicitlyEnabled,
    fileConfigured,
    externalEndpoint,
    explicitlyEnabled,
    path: raw,
    exists: Boolean(info?.isFile()),
    bytes: info?.isFile() ? info.size : 0,
    completedChatSpans: spans,
    ready: Boolean(info?.isFile()) && spans > 0,
    setup,
    warnings
  };
}

function cursorsPath(root) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'telemetry-cursors.json');
}

function cursorKey(workflow, phase, generation = nextPhaseGeneration(phase)) {
  return `${workflow.workItem.id}:${phase.id}:${generation}`;
}

async function loadCursors(root) {
  const file = cursorsPath(root);
  if (!(await exists(file))) return { schemaVersion: CURSOR_SCHEMA, cursors: {} };
  return readRecord('telemetry-cursor', await readFile(file)).record;
}

function cursorWarning(action, error) {
  const code = typeof error?.code === 'string' ? error.code : 'local-state-unavailable';
  console.warn(
    `Warning: optional Copilot telemetry cursor ${action} was skipped (${code}); `
    + 'phase work continues and usage will be reported as unavailable or partial.'
  );
}

async function withCursorLock(root, operation) {
  let lastError = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try { return await withSubjectLock(root, CURSOR_SUBJECT, operation); }
    catch (error) {
      lastError = error;
      if (error?.code !== 'SUBJECT_LOCK_BUSY') throw error;
      // Machine-local cursor updates are tiny. Bounded retry prevents two Story worktrees from
      // losing one another's read-modify-write without letting optional telemetry stall a phase.
      await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
    }
  }
  throw lastError;
}

/** Snapshot only one Story's machine-local telemetry cursors for draft rollback. */
export async function captureTelemetryCursorsForWorkItem(root, workId) {
  try {
    return await withCursorLock(root, async () => {
      const prefix = `${String(workId)}:`;
      const state = await loadCursors(root);
      return Object.fromEntries(Object.entries(state.cursors ?? {})
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key, structuredClone(value)]));
    });
  } catch (error) {
    cursorWarning('snapshot', error);
    return null;
  }
}

/** Restore one Story's cursors without clobbering concurrent cursor state for other Stories. */
export async function restoreTelemetryCursorsForWorkItem(root, workId, snapshot = null) {
  if (snapshot == null) return { restored: false, skipped: true };
  try {
    return await withCursorLock(root, async () => {
      const prefix = `${String(workId)}:`;
      const state = await loadCursors(root);
      for (const key of Object.keys(state.cursors ?? {})) {
        if (key.startsWith(prefix)) delete state.cursors[key];
      }
      Object.assign(state.cursors, structuredClone(snapshot));
      await writeJson(cursorsPath(root), state);
      return { restored: true, skipped: false };
    });
  } catch (error) {
    // Cursor state is optional observation bookkeeping. Durable Story rollback already succeeded,
    // so local telemetry cleanup must never relabel that authoritative recovery as failed.
    cursorWarning('restore', error);
    return { restored: false, skipped: true };
  }
}

export async function beginTelemetryCapture(root, workflow, phase) {
  const generation = nextPhaseGeneration(phase);
  const key = cursorKey(workflow, phase, generation);
  const raw = rawTelemetryPath(root);
  const info = await stat(raw).catch(() => null);
  const cursor = { workId: workflow.workItem.id, phase: phase.id, generation, offset: info?.size ?? 0, startedAt: nowIso() };
  try {
    return await withCursorLock(root, async () => {
      const state = await loadCursors(root);
      if (state.cursors[key]) return state.cursors[key];
      state.cursors[key] = cursor;
      await writeJson(cursorsPath(root), state);
      return cursor;
    });
  } catch (error) {
    cursorWarning('write', error);
    return { ...cursor, persistence: 'unavailable' };
  }
}

function decoded(value) {
  if (value == null || typeof value !== 'object') return value;
  for (const key of ['stringValue', 'intValue', 'integerValue', 'doubleValue', 'boolValue']) if (value[key] != null) return value[key];
  if (value.arrayValue?.values) return value.arrayValue.values.map(decoded);
  if (value.kvlistValue?.values) return Object.fromEntries(value.kvlistValue.values.map((item) => [item.key, decoded(item.value)]));
  return value;
}

function attributeMap(value) {
  if (Array.isArray(value)) return Object.fromEntries(value.filter((item) => item?.key).map((item) => [item.key, decoded(item.value)]));
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decoded(item)]));
}

function finite(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestamp(value) {
  if (value == null) return null;
  // OpenTelemetry JS writes span times as `[seconds, nanoseconds]`.
  if (Array.isArray(value)) {
    const [seconds, nanoseconds = 0] = value.map(Number);
    return value.length === 2 && Number.isFinite(seconds) && Number.isFinite(nanoseconds)
      ? new Date(seconds * 1000 + nanoseconds / 1_000_000).toISOString() : null;
  }
  try {
    if (typeof value === 'bigint' || /^\d{16,}$/.test(String(value))) return new Date(Number(BigInt(value) / 1_000_000n)).toISOString();
  } catch { return null; }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function spanFrom(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  const attributes = attributeMap(node.attributes ?? node.attributeMap);
  const operation = attributes['gen_ai.operation.name'] ?? node.operationName ?? node.name;
  if (operation !== 'chat' && !String(node.name ?? '').startsWith('chat ')) return null;
  const fallbackModel = String(node.name ?? '').replace(/^chat\s+/, '');
  const requestedModel = attributes['gen_ai.request.model'] ?? null;
  const providerResolvedModel = attributes['gen_ai.response.model'] ?? null;
  const hostObservedModel = providerResolvedModel ? null : (node.model ?? (fallbackModel || null));
  const resolvedModel = providerResolvedModel ?? hostObservedModel;
  const resolvedModelAssurance = providerResolvedModel
    ? 'provider-reported' : hostObservedModel ? 'host-observed' : 'unavailable';
  const model = resolvedModel ?? requestedModel;
  const provider = attributes['gen_ai.provider.name'] ?? node.provider ?? 'github-copilot';
  const inputTokens = finite(attributes['gen_ai.usage.input_tokens']);
  const outputTokens = finite(attributes['gen_ai.usage.output_tokens']);
  const cachedInputTokens = finite(attributes['gen_ai.usage.cache_read.input_tokens']);
  const cacheWriteInputTokens = finite(attributes['gen_ai.usage.cache_creation.input_tokens']);
  const providerCost = finite(attributes['github.copilot.cost']);
  if (!model && inputTokens == null && outputTokens == null && providerCost == null) return null;
  const startedAt = timestamp(node.startTimeUnixNano ?? node.startTimeUnixNanos ?? node.startTime ?? attributes['gen_ai.request.start_time']);
  const completedAt = timestamp(node.endTimeUnixNano ?? node.endTimeUnixNanos ?? node.endTime ?? attributes['gen_ai.response.end_time']);
  return {
    provider: String(provider),
    model: model ? String(model) : 'unknown',
    requestedModel: requestedModel ? String(requestedModel) : null,
    resolvedModel: resolvedModel ? String(resolvedModel) : null,
    resolvedModelAssurance,
    inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens, providerCost,
    startedAt, completedAt
  };
}

function boundedModel(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  return text && text.length <= 128 && !/[\r\n\0]/.test(text) ? text : null;
}

function activityOperation(node, attributes) {
  const declared = attributes['gen_ai.operation.name'] ?? node.operationName;
  if (declared != null) return ['invoke_agent', 'chat', 'execute_tool'].includes(String(declared)) ? String(declared) : null;
  return /^(invoke_agent|chat|execute_tool)(?:\s|$)/.exec(String(node.name ?? ''))?.[1] ?? null;
}

function requestTurns(node, attributes) {
  const declared = finite(attributes['copilot_chat.turn_count']);
  if (declared != null && declared >= 0) return Math.trunc(declared);
  const turns = Array.isArray(node.events) ? node.events.filter((event) => event?.name === 'copilot_chat.agent.turn').length : 0;
  return turns || null;
}

/**
 * The content-free facts of one request, model-call or tool span: what kind of span, which model
 * was asked for and which answered, how many turns a request took, the model's prompt limit,
 * whether it failed and with which error class. The trace ID only joins a request to its model
 * calls in memory; it is never recorded.
 */
function activityFrom(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  const attributes = attributeMap(node.attributes ?? node.attributeMap);
  const operation = activityOperation(node, attributes);
  if (!operation) return null;
  const errorType = boundedErrorType(attributes['error.type']);
  const statusCode = node.status?.code;
  const failed = errorType != null || statusCode === 2 || statusCode === 'STATUS_CODE_ERROR' || statusCode === 'ERROR';
  const maxPromptTokens = finite(attributes['copilot_chat.request.max_prompt_tokens']);
  return {
    operation,
    traceId: typeof node.traceId === 'string' ? node.traceId
      : typeof node.spanContext?.traceId === 'string' ? node.spanContext.traceId : null,
    requestedModel: boundedModel(attributes['gen_ai.request.model']),
    // Only a provider-reported answering model counts: a chat span's name carries the requested
    // model, so reading it as the answer would hide every substitution.
    resolvedModel: boundedModel(attributes['gen_ai.response.model']),
    turns: operation === 'invoke_agent' ? requestTurns(node, attributes) : null,
    maxPromptTokens: operation === 'chat' && maxPromptTokens != null && maxPromptTokens > 0 ? Math.trunc(maxPromptTokens) : null,
    failed,
    errorType: failed ? errorType ?? 'error' : null,
    at: timestamp(node.endTimeUnixNano ?? node.endTimeUnixNanos ?? node.endTime)
      ?? timestamp(node.startTimeUnixNano ?? node.startTimeUnixNanos ?? node.startTime)
  };
}

function activitiesIn(value, output = [], seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);
  const activity = activityFrom(value); if (activity) output.push(activity);
  if (Array.isArray(value)) value.forEach((item) => activitiesIn(item, output, seen));
  else Object.values(value).forEach((item) => activitiesIn(item, output, seen));
  return output;
}

function spansIn(value, output = [], seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);
  const span = spanFrom(value); if (span) output.push(span);
  if (Array.isArray(value)) value.forEach((item) => spansIn(item, output, seen));
  else Object.values(value).forEach((item) => spansIn(item, output, seen));
  return output;
}

export function parseCopilotTelemetry(text) {
  const source = String(text ?? '');
  const spans = [], activities = [], warnings = [], privacyDiagnostics = [];
  const lines = source.split(/\r?\n/);
  const sensitive = /(?:prompt|completion(?:[_ -]?text)?|messages?|system[_ -]?prompt|source[_ -]?code|file[_ -]?content|tool[_ -]?(?:input|output|arguments?|results?)|http[_ -]?body|private[_ -]?key|connection[_ -]?string|(?:conversation|session)[_. -]?id)/i;
  const hasSensitive = (value, seen = new Set()) => {
    if (typeof value === 'string') return sensitive.test(value);
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    return Object.entries(value).some(([key, item]) => sensitive.test(key) || hasSensitive(item, seen));
  };
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let value;
    try { value = JSON.parse(line); } catch {
      const incompleteTail = index === lines.length - 1 && !source.endsWith('\n');
      warnings.push(incompleteTail
        ? 'ignored incomplete telemetry tail; it will be retried at the next boundary'
        : `quarantined malformed telemetry record at line ${index + 1}`);
      continue;
    }
    if (hasSensitive(value)) privacyDiagnostics.push(`dropped disallowed telemetry attributes at line ${index + 1}`);
    spans.push(...spansIn(value));
    activities.push(...activitiesIn(value));
  }
  return { spans, activities, warnings, privacyDiagnostics };
}

export function groupedUsage(spans) {
  const groups = new Map();
  for (const span of spans) {
    const key = `${span.provider}\0${span.requestedModel ?? ''}\0${span.resolvedModel ?? ''}\0${span.resolvedModelAssurance}`;
    const group = groups.get(key) ?? {
      provider: span.provider, model: span.model,
      requestedModel: span.requestedModel, resolvedModel: span.resolvedModel,
      resolvedModelAssurance: span.resolvedModelAssurance,
      spans: 0, observations: {
        inputTokens: [], outputTokens: [], cachedInputTokens: [],
        cacheWriteInputTokens: [], providerCost: []
      },
      startedAt: null, completedAt: null
    };
    group.spans += 1;
    for (const field of Object.keys(group.observations)) {
      group.observations[field].push(span[field] == null
        ? usageMetric(null)
        : usageMetric(span[field], { assurance: 'provider-reported' }));
    }
    if (span.startedAt && (!group.startedAt || span.startedAt < group.startedAt)) group.startedAt = span.startedAt;
    if (span.completedAt && (!group.completedAt || span.completedAt > group.completedAt)) group.completedAt = span.completedAt;
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const observations = Object.fromEntries(Object.entries(group.observations)
      .map(([field, values]) => [field, combineUsageMetrics(values, { assurance: 'provider-reported' })]));
    const arithmetic = providerTokenArithmetic({
      inputTokens: observations.inputTokens,
      outputTokens: observations.outputTokens,
      cachedInputTokens: observations.cachedInputTokens
    });
    const availableCore = [observations.inputTokens, observations.outputTokens]
      .filter((metric) => metric.value != null);
    const status = availableCore.length === 2 && availableCore.every((metric) => metric.status === 'exact')
      ? 'exact' : availableCore.length ? 'partial' : 'unavailable';
    return {
      source: 'copilot-otel', provider: group.provider, model: group.model,
      requestedModel: group.requestedModel,
      resolvedModel: group.resolvedModel,
      resolvedModelAssurance: group.resolvedModelAssurance,
      status,
      inputTokens: observations.inputTokens.value,
      outputTokens: observations.outputTokens.value,
      cachedInputTokens: observations.cachedInputTokens.value,
      cacheWriteInputTokens: observations.cacheWriteInputTokens.value,
      totalTokens: arithmetic.totalProviderTokens.value,
      providerCost: observations.providerCost.value,
      costStatus: observations.providerCost.status,
      observations,
      spans: group.spans, startedAt: group.startedAt, completedAt: group.completedAt
    };
  });
}

export async function collectCopilotUsage(root, workflow, phase, { generation } = {}) {
  const raw = rawTelemetryPath(root);
  const info = await stat(raw).catch(() => null);
  let state;
  let cursorUnavailable = false;
  try { state = await loadCursors(root); }
  catch {
    state = { schemaVersion: CURSOR_SCHEMA, cursors: {} };
    cursorUnavailable = true;
  }
  const key = cursorKey(workflow, phase, generation);
  const cursor = state.cursors[key] ?? { offset: info?.size ?? 0, startedAt: nowIso(), missing: true };
  const since = Date.parse(cursor.startedAt);
  const launches = (await listTelemetryLaunches(root, { storyId: workflow.workItem.id }))
    .filter((launch) => !phase?.id || !launch.phase || launch.phase === phase.id)
    .filter((launch) => launch.worktreeId === telemetryWorktreeId(root))
    .filter((launch) => !Number.isFinite(since) || Date.parse(launch.startedAt) >= since);
  const launchSpans = [];
  const launchActivities = [];
  const launchResults = [];
  const warnings = [];
  const privacyDiagnostics = [];
  let launchBytes = 0;
  for (const launch of launches) {
    const absolute = telemetryRawPath(root, launch);
    if (!absolute) continue;
    const launchInfo = await stat(absolute).catch(() => null);
    const parsed = launchInfo?.isFile()
      ? parseCopilotTelemetry(await readFile(absolute, 'utf8'))
      : { spans: [], activities: [], warnings: [], privacyDiagnostics: [] };
    if (launchInfo?.isFile()) launchBytes += launchInfo.size;
    launchSpans.push(...parsed.spans);
    launchActivities.push(...parsed.activities);
    warnings.push(...parsed.warnings);
    privacyDiagnostics.push(...parsed.privacyDiagnostics);
    launchResults.push({
      launchId: launch.launchId, surface: launch.surface, host: launch.host, runtime: launch.runtime,
      provisioningMode: launch.provisioningMode, configurationDigest: launch.configurationDigest,
      captureStatus: parsed.spans.length > 0
        ? 'captured'
        : launch.captureStatus === 'configured' ? 'partial' : launch.captureStatus,
      observedEvents: parsed.spans.length
    });
  }
  let spans = launchSpans;
  let activities = launchActivities;
  let legacyBytes = 0;
  if (!spans.length && info?.isFile()) {
    const start = cursor.offset <= info.size ? cursor.offset : 0;
    const buffer = await readFile(raw);
    const parsed = parseCopilotTelemetry(buffer.subarray(start).toString('utf8'));
    spans = parsed.spans.filter((span) => !Number.isFinite(since) || !span.completedAt || Date.parse(span.completedAt) >= since);
    // Launch activity without usable usage spans still describes the launch; only fill the gap.
    if (!activities.length) activities = parsed.activities.filter((entry) => !Number.isFinite(since) || !entry.at || Date.parse(entry.at) >= since);
    legacyBytes = info.size - start;
    warnings.push(...parsed.warnings);
    privacyDiagnostics.push(...parsed.privacyDiagnostics);
  }
  if (cursorUnavailable) warnings.push('Telemetry cursor state was unreadable; only spans matching the active phase time window were considered.');
  else if (cursor.missing) warnings.push('Telemetry cursor was missing; only spans matching the active phase time window were considered.');
  if (!spans.length) warnings.push('No completed Copilot chat spans were available before publication.');
  return {
    usage: groupedUsage(spans), activity: summarizeCopilotActivity(activities),
    spans: spans.length, rawBytes: launchBytes + legacyBytes,
    startedAt: cursor.startedAt, completedAt: nowIso(), warnings, privacyDiagnostics,
    launches: launchResults
  };
}

function telemetryQualification(capture, usage) {
  if (capture.source === 'not-invoked') return 'not-invoked';
  if (capture.pending) return 'pending';
  const statuses = (capture.launches ?? []).map((launch) => launch.captureStatus);
  const captured = statuses.filter((status) => status === 'captured').length;
  const incomplete = statuses.length - captured;
  if (captured && incomplete) return 'partial';
  if (!captured && statuses.includes('conflict')) return 'conflict';
  if (!captured && statuses.some((status) => ['disabled-by-user', 'disclosure-required'].includes(status))) return 'disabled';
  if (!captured && statuses.length) return 'unavailable';
  const exact = usage.filter((item) => item.status === 'exact').length;
  return !exact ? 'unavailable' : exact === usage.length ? 'exact' : 'partial';
}

/**
 * The governed prompt sflow composed for this generation, measured from its committed snapshot.
 *
 * This is what sflow handed to Copilot: exact bytes, with tokens estimated as bytes / 4 because the
 * host's tokenizer is not available here. Copilot adds its own instructions, tool definitions and
 * chat history, which no client can see, so the size is a floor on what the model read. A
 * generation without a composition receipt has no size, and reading one never fails publication.
 */
async function composedPromptSummary(workflow, phase, itemDirectory) {
  try {
    const name = `${phase.id}-gen${phase.generation}`;
    const receipt = readRecord('prompt-injection', await readFile(path.join(itemDirectory, 'context', `${name}.json`))).record;
    if (receipt.workId !== workflow.workItem.id || receipt.phase !== phase.id || receipt.generation !== phase.generation) return null;
    const snapshotInfo = await stat(path.join(itemDirectory, 'context', 'prompts', `${name}.md`));
    if (!snapshotInfo.isFile()) return null;
    // A composition's budget nests its policy (`promptBudget.policy.maximumBytes`); read a flat
    // summary too, so a hand-built or older record still states its limits.
    const budget = receipt.promptBudget ?? {};
    const policy = budget.policy && typeof budget.policy === 'object' ? budget.policy : budget;
    const integer = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
    return {
      source: 'sflow-composition',
      bytes: snapshotInfo.size,
      estimatedTokens: Math.ceil(snapshotInfo.size / 4),
      estimation: 'UTF-8 bytes divided by four, rounded up',
      maximumBytes: integer(policy.maximumBytes),
      maximumEstimatedTokens: integer(policy.maximumEstimatedPromptTokens),
      budgetMode: typeof policy.mode === 'string' ? policy.mode : null,
      originalBytes: integer(budget.originalBytes),
      omittedSections: Array.isArray(budget.omitted) ? budget.omitted.length : 0
    };
  } catch {
    return null;
  }
}

/**
 * Why a Copilot generation captured no activity, read from its own launches. A publication with no
 * spans is always `pending`, whatever the cause, so the status alone cannot tell work in native
 * Copilot Chat (no SFlow launch ran) from capture that was declined, an OpenTelemetry setup SFlow
 * kept, or a launch that has not exported its finished turn yet.
 */
export function telemetryCaptureGap(capture, activity) {
  if (activity || capture?.source !== 'copilot-otel') return null;
  const statuses = (capture.launches ?? []).map((launch) => launch.captureStatus);
  if (!statuses.length) return 'no-metered-session';
  if (statuses.some((status) => ['disabled-by-user', 'disclosure-required'].includes(status))) return 'disabled';
  if (statuses.includes('conflict')) return 'conflict';
  return 'awaiting-export';
}

const PENDING_NOTES = {
  'no-metered-session': 'No Copilot session started through SFlow ran for this phase. Telemetry will be reconciled automatically on the next submit action only if Copilot exports to this repository; native Copilot Chat sends SFlow nothing, so requests, turns and calls stay unavailable.',
  disabled: 'Copilot activity capture was off for this phase; run singularity-flow telemetry enable to measure the next generation.',
  conflict: 'An existing OpenTelemetry setup kept Copilot activity from SFlow; see singularity-flow telemetry probe.'
};

/** What to expect after publishing a generation that captured no activity, by why it has none. */
export function pendingTelemetryNote(captureGap) {
  return PENDING_NOTES[captureGap]
    ?? 'Telemetry will be reconciled automatically on the next submit action, after Copilot exports this completed turn.';
}

export async function recordPhaseTelemetry(root, workflow, phase, usage, capture, { itemDirectory, itemRelative }) {
  const relative = path.posix.join(itemRelative, 'telemetry', `${phase.id}-gen${phase.generation}.json`);
  const absolute = path.join(itemDirectory, 'telemetry', `${phase.id}-gen${phase.generation}.json`);
  // A phase authored without a model sent no prompt, whatever was composed beforehand.
  const prompt = capture.source === 'not-invoked' ? null : await composedPromptSummary(workflow, phase, itemDirectory);
  const activity = capture.activity ?? null;
  const record = {
    schemaVersion: RECORD_SCHEMA, workId: workflow.workItem.id, workType: workflow.workItem.workType,
    phase: phase.id, generation: phase.generation, capturedAt: nowIso(), source: capture.source,
    rawTraceCommitted: false, spanCount: capture.spans ?? 0, rawBytesRead: capture.rawBytes ?? 0,
    startedAt: capture.startedAt ?? null, completedAt: capture.completedAt ?? null,
    pending: Boolean(capture.pending), warnings: capture.warnings ?? [],
    privacyDiagnostics: capture.privacyDiagnostics ?? [], launches: capture.launches ?? [], usage,
    activity, prompt
  };
  await writeJson(absolute, record); const info = await snapshot(absolute);
  const costs = usage.map((item) => item.providerCost).filter(Number.isFinite);
  return {
    generation: phase.generation, path: relative, sha256: info.sha256,
    status: telemetryQualification(capture, usage),
    models: [...new Set(usage.map((item) => item.model).filter(Boolean))],
    providerCost: costs.length ? costs.reduce((sum, value) => sum + value, 0) : null,
    activity, prompt,
    captureGap: telemetryCaptureGap(capture, activity),
    record
  };
}

/**
 * The workflow-state summary of one generation's telemetry. Activity and prompt size are copied
 * only when the record has them, so a phase without either keeps the summary it always had.
 */
export function phaseTelemetrySummary(telemetry) {
  return {
    generation: telemetry.generation, path: telemetry.path, sha256: telemetry.sha256, status: telemetry.status,
    models: telemetry.models, providerCost: telemetry.providerCost,
    ...(telemetry.activity ? { activity: telemetry.activity } : {}),
    ...(telemetry.prompt ? { prompt: telemetry.prompt } : {}),
    ...(telemetry.captureGap ? { captureGap: telemetry.captureGap } : {})
  };
}

export async function verifyPhaseTelemetry(root, workflow, phase, generation) {
  const context = (phase.telemetry ?? []).find((item) => item.generation === generation);
  if (!context) return { errors: [`telemetry record missing for ${phase.id} generation ${generation}`], passes: [] };
  const current = await snapshot(path.join(root, context.path));
  if (!current.exists) return { errors: [`telemetry file missing: ${context.path}`], passes: [] };
  if (current.sha256 !== context.sha256) return { errors: [`telemetry integrity failed: ${context.path}`], passes: [] };
  let record;
  try { record = readRecord('phase-telemetry', await readFile(path.join(root, context.path))).record; }
  catch (error) {
    if (String(error?.code ?? '').startsWith('SCHEMA_')) throw error;
    return { errors: [`telemetry record is invalid JSON: ${context.path}`], passes: [] };
  }
  if (record.workId !== workflow.workItem.id || record.phase !== phase.id || record.generation !== generation) return { errors: [`telemetry record identity mismatch: ${context.path}`], passes: [] };
  const expectedUsage = (phase.usage ?? []).filter((item) => item.generation === generation);
  if (JSON.stringify(record.usage) !== JSON.stringify(expectedUsage)) return { errors: [`telemetry usage differs from workflow state: ${context.path}`], passes: [] };
  for (const field of ['activity', 'prompt']) {
    if (JSON.stringify(record[field] ?? null) !== JSON.stringify(context[field] ?? null)) {
      return { errors: [`telemetry ${field} differs from workflow state: ${context.path}`], passes: [] };
    }
  }
  // Older summaries predate the gap; a recorded one must be the one the record's launches give.
  if (context.captureGap != null && context.captureGap !== telemetryCaptureGap(record, record.activity ?? null)) {
    return { errors: [`telemetry captureGap differs from workflow state: ${context.path}`], passes: [] };
  }
  return { errors: [], passes: [`telemetry audit: ${phase.id} generation ${generation} (${context.status})`] };
}
