import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gitCommonDir } from './git.mjs';
import { exists, nowIso, snapshot, writeJson } from './util.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { listTelemetryLaunches, telemetryRawPath, telemetryWorktreeId } from './telemetry-provision.mjs';

const CURSOR_SCHEMA = currentSchemaVersion('telemetry-cursor');
const RECORD_SCHEMA = currentSchemaVersion('phase-telemetry');

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

export async function copilotTelemetryStatus(root) {
  const raw = rawTelemetryPath(root);
  const info = await stat(raw).catch(() => null);
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
  if (!info?.isFile()) warnings.push('The repository telemetry file does not exist.');
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

function cursorKey(workflow, phase, generation = phase.generation + 1) {
  return `${workflow.workItem.id}:${phase.id}:${generation}`;
}

async function loadCursors(root) {
  const file = cursorsPath(root);
  if (!(await exists(file))) return { schemaVersion: CURSOR_SCHEMA, cursors: {} };
  return readRecord('telemetry-cursor', await readFile(file)).record;
}

export async function beginTelemetryCapture(root, workflow, phase) {
  const generation = phase.generation + 1;
  const key = cursorKey(workflow, phase, generation);
  const state = await loadCursors(root);
  if (state.cursors[key]) return state.cursors[key];
  const raw = rawTelemetryPath(root);
  const info = await stat(raw).catch(() => null);
  const cursor = { workId: workflow.workItem.id, phase: phase.id, generation, offset: info?.size ?? 0, startedAt: nowIso() };
  state.cursors[key] = cursor;
  await writeJson(cursorsPath(root), state);
  return cursor;
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
  const model = attributes['gen_ai.response.model'] ?? attributes['gen_ai.request.model'] ?? node.model ?? (fallbackModel || null);
  const provider = attributes['gen_ai.provider.name'] ?? node.provider ?? 'github-copilot';
  const inputTokens = finite(attributes['gen_ai.usage.input_tokens']);
  const outputTokens = finite(attributes['gen_ai.usage.output_tokens']);
  const cachedInputTokens = finite(attributes['gen_ai.usage.cache_read.input_tokens']);
  const cacheWriteInputTokens = finite(attributes['gen_ai.usage.cache_creation.input_tokens']);
  const providerCost = finite(attributes['github.copilot.cost']);
  if (!model && inputTokens == null && outputTokens == null && providerCost == null) return null;
  const startedAt = timestamp(node.startTimeUnixNano ?? node.startTimeUnixNanos ?? node.startTime ?? attributes['gen_ai.request.start_time']);
  const completedAt = timestamp(node.endTimeUnixNano ?? node.endTimeUnixNanos ?? node.endTime ?? attributes['gen_ai.response.end_time']);
  return { provider: String(provider), model: model ? String(model) : 'unknown', inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens, providerCost, startedAt, completedAt };
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
  const spans = [], warnings = [], privacyDiagnostics = [];
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
  }
  return { spans, warnings, privacyDiagnostics };
}

function groupedUsage(spans) {
  const groups = new Map();
  for (const span of spans) {
    const key = `${span.provider}\0${span.model}`;
    const group = groups.get(key) ?? { provider: span.provider, model: span.model, spans: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, providerCost: 0, tokenSpans: 0, costSpans: 0, startedAt: null, completedAt: null };
    group.spans += 1;
    for (const field of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteInputTokens']) if (span[field] != null) group[field] += span[field];
    if (span.inputTokens != null || span.outputTokens != null) group.tokenSpans += 1;
    if (span.providerCost != null) { group.providerCost += span.providerCost; group.costSpans += 1; }
    if (span.startedAt && (!group.startedAt || span.startedAt < group.startedAt)) group.startedAt = span.startedAt;
    if (span.completedAt && (!group.completedAt || span.completedAt > group.completedAt)) group.completedAt = span.completedAt;
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    source: 'copilot-otel', provider: group.provider, model: group.model,
    inputTokens: group.tokenSpans ? group.inputTokens : null,
    outputTokens: group.tokenSpans ? group.outputTokens : null,
    cachedInputTokens: group.tokenSpans ? group.cachedInputTokens : null,
    cacheWriteInputTokens: group.tokenSpans ? group.cacheWriteInputTokens : null,
    totalTokens: group.tokenSpans ? group.inputTokens + group.outputTokens : null,
    providerCost: group.costSpans ? group.providerCost : null,
    costStatus: !group.costSpans ? 'unavailable' : group.costSpans === group.spans ? 'exact' : 'partial',
    spans: group.spans, startedAt: group.startedAt, completedAt: group.completedAt
  }));
}

export async function collectCopilotUsage(root, workflow, phase, { generation } = {}) {
  const raw = rawTelemetryPath(root);
  const info = await stat(raw).catch(() => null);
  const state = await loadCursors(root);
  const key = cursorKey(workflow, phase, generation);
  const cursor = state.cursors[key] ?? { offset: info?.size ?? 0, startedAt: nowIso(), missing: true };
  const since = Date.parse(cursor.startedAt);
  const launches = (await listTelemetryLaunches(root, { storyId: workflow.workItem.id }))
    .filter((launch) => !phase?.id || !launch.phase || launch.phase === phase.id)
    .filter((launch) => launch.worktreeId === telemetryWorktreeId(root))
    .filter((launch) => !Number.isFinite(since) || Date.parse(launch.startedAt) >= since);
  const launchSpans = [];
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
      : { spans: [], warnings: [], privacyDiagnostics: [] };
    if (launchInfo?.isFile()) launchBytes += launchInfo.size;
    launchSpans.push(...parsed.spans);
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
  let legacyBytes = 0;
  if (!spans.length && info?.isFile()) {
    const start = cursor.offset <= info.size ? cursor.offset : 0;
    const buffer = await readFile(raw);
    const parsed = parseCopilotTelemetry(buffer.subarray(start).toString('utf8'));
    spans = parsed.spans.filter((span) => !Number.isFinite(since) || !span.completedAt || Date.parse(span.completedAt) >= since);
    legacyBytes = info.size - start;
    warnings.push(...parsed.warnings);
    privacyDiagnostics.push(...parsed.privacyDiagnostics);
  }
  if (cursor.missing) warnings.push('Telemetry cursor was missing; only spans matching the active phase time window were considered.');
  if (!spans.length) warnings.push('No completed Copilot chat spans were available before publication.');
  return {
    usage: groupedUsage(spans), spans: spans.length, rawBytes: launchBytes + legacyBytes,
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

export async function recordPhaseTelemetry(root, workflow, phase, usage, capture, { itemDirectory, itemRelative }) {
  const relative = path.posix.join(itemRelative, 'telemetry', `${phase.id}-gen${phase.generation}.json`);
  const absolute = path.join(itemDirectory, 'telemetry', `${phase.id}-gen${phase.generation}.json`);
  const record = {
    schemaVersion: RECORD_SCHEMA, workId: workflow.workItem.id, workType: workflow.workItem.workType,
    phase: phase.id, generation: phase.generation, capturedAt: nowIso(), source: capture.source,
    rawTraceCommitted: false, spanCount: capture.spans ?? 0, rawBytesRead: capture.rawBytes ?? 0,
    startedAt: capture.startedAt ?? null, completedAt: capture.completedAt ?? null,
    pending: Boolean(capture.pending), warnings: capture.warnings ?? [],
    privacyDiagnostics: capture.privacyDiagnostics ?? [], launches: capture.launches ?? [], usage
  };
  await writeJson(absolute, record); const info = await snapshot(absolute);
  const costs = usage.map((item) => item.providerCost).filter(Number.isFinite);
  return {
    generation: phase.generation, path: relative, sha256: info.sha256,
    status: telemetryQualification(capture, usage),
    models: [...new Set(usage.map((item) => item.model).filter(Boolean))],
    providerCost: costs.length ? costs.reduce((sum, value) => sum + value, 0) : null,
    record
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
  return { errors: [], passes: [`telemetry audit: ${phase.id} generation ${generation} (${context.status})`] };
}
