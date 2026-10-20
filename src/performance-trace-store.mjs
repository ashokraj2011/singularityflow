/** Private, bounded, read-only-reportable traces. No authority, prompts, URLs or file paths in records. */
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { PERFORMANCE_CATEGORIES, traceIdentifier, summarizePerformanceTrace } from './performance-trace.mjs';
import { readRecord, stampCurrentRecord } from './schema-migrations.mjs';

const MAXIMUM_BYTES = 4 * 1024 * 1024;
const FILE = /^[a-f0-9-]{36}(?:\.host)?\.json$/u;
const bounded = (value, fallback, max) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Math.min(Number(value), max) : fallback;
const metric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const label = value => typeof value === 'string' && /^[a-z][a-z0-9.-]{0,79}$/u.test(value) ? value : 'unknown';
const outcomes = new Set(['success', 'error', 'not-found', 'blocked', 'cancelled', 'timeout', 'incomplete', 'unknown', 'failed']);
const outcome = value => outcomes.has(value) ? value : 'unknown';
const selectedMetrics = (object, keys) => Object.fromEntries(keys.filter(key => metric(object?.[key]) != null).map(key => [key, object[key]]));
const coverage = partial => ({ status: partial ? 'partial' : 'instrumented-boundaries',
  fileAccess: 'shared-and-targeted-boundaries-only', nativeCopilot: 'unavailable-unless-host-exported',
  gitRemote: 'whole-operation-not-pure-network', preNodeStartup: 'host-observation-required',
  cpu: 'process-aggregate-not-per-category', postExitUi: 'host-observation-required', persistence: 'excluded-after-command-window' });

// Project every field; never relay unknown attributes, raw messages or objects from a diagnostic file.
function projectTrace(raw) {
  try { raw = readRecord('performance-trace', raw).record; } catch { return null; }
  if (raw.resultType !== 'sflow-performance-trace'
      || !traceIdentifier(raw.actionId) || !traceIdentifier(raw.invocationId) || !traceIdentifier(raw.rootSpanId)
      || !Array.isArray(raw.spans) || raw.spans.length > 8192 || metric(raw.durationMs) == null
      || raw.durationMs > 7 * 86400000 || !Number.isFinite(Date.parse(raw.startedAt))) return null;
  const ids = new Set();
  const spans = raw.spans.map(span => {
    if (!traceIdentifier(span?.id) || ids.has(span.id) || !PERFORMANCE_CATEGORIES.includes(span.category)
        || metric(span.startMs) == null || metric(span.endMs) == null || span.endMs < span.startMs) return null;
    ids.add(span.id);
    const attributes = selectedMetrics(span.attributes, ['bytes', 'items', 'attempt', 'queueMs', 'launchMs', 'firstByteMs', 'parseMs']);
    if (['hit', 'miss', 'reuse', 'none'].includes(span.attributes?.cache)) attributes.cache = span.attributes.cache;
    return { id: span.id, parentId: traceIdentifier(span.parentId), category: span.category, name: label(span.name),
      startMs: Math.min(raw.durationMs, span.startMs), endMs: Math.min(raw.durationMs, span.endMs),
      kind: span.kind === 'stage' ? 'stage' : 'operation', outcome: outcome(span.outcome), attributes };
  });
  if (spans.some(span => !span)) return null;
  const counters = Object.fromEntries(Object.entries(raw.counters ?? {}).filter(([key, value]) =>
    /^(?:git|cache|discovery|composition|llm|file|configuration|worker|reads)\.[a-z0-9.-]{1,60}$/u.test(key) && Number.isSafeInteger(value) && value >= 0));
  return { schemaVersion: raw.schemaVersion, resultType: raw.resultType, actionId: raw.actionId, invocationId: raw.invocationId,
    rootSpanId: raw.rootSpanId, parentSpanId: traceIdentifier(raw.parentSpanId), command: label(raw.command),
    operationId: raw.operationId == null ? null : label(raw.operationId),
    commandClass: ['read', 'mutation'].includes(raw.commandClass) ? raw.commandClass : 'unknown',
    startedAt: new Date(raw.startedAt).toISOString(), durationMs: raw.durationMs,
    firstFeedbackMs: metric(raw.firstFeedbackMs), outcome: outcome(raw.outcome),
    platform: ['win32', 'darwin', 'linux'].includes(raw.platform) ? raw.platform : 'other',
    temperature: ['cold', 'warm', 'prewarmed'].includes(raw.temperature) ? raw.temperature : 'unknown',
    cpu: { ...selectedMetrics(raw.cpu, ['userMs', 'systemMs']), scope: 'collector-lifetime' },
    memory: selectedMetrics(raw.memory, ['rssStartBytes', 'rssEndBytes']), counters, spans,
    droppedSpans: bounded(raw.droppedSpans, 0, Number.MAX_SAFE_INTEGER),
    coverage: coverage(raw.coverage?.status === 'partial') };
}

async function boundedRead(file, maximum = MAXIMUM_BYTES) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximum) throw new Error('Unsafe performance record');
    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > info.size) throw new Error('Performance record changed while reading');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}

async function safeDirectory(base, create) {
  const directory = path.join(base, 'performance');
  const parent = await lstat(base);
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Unsafe performance store parent');
  if (create) await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return null;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe performance store');
  return directory;
}

export async function writePerformanceTrace(base, trace, { now = Date.now(), env = process.env } = {}) {
  if (!traceIdentifier(trace.invocationId) || !traceIdentifier(trace.actionId)) return;
  trace = projectTrace(stampCurrentRecord('performance-trace', trace));
  if (!trace) return;
  const bytes = JSON.stringify(trace);
  if (Buffer.byteLength(bytes) > MAXIMUM_BYTES) return;
  const directory = await safeDirectory(base, true);
  const file = path.join(directory, `${trace.invocationId}.json`), temporary = `${file}.${process.pid}.partial`;
  try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
  await prune(directory, now, env);
}

async function prune(directory, now, env) {
  const limit = bounded(env.SINGULARITY_FLOW_PERF_MAX_RECORDS, 64, 512);
  const days = bounded(env.SINGULARITY_FLOW_PERF_RETENTION_DAYS, 7, 90);
  const files = await Promise.all((await readdir(directory)).filter(name => FILE.test(name)).map(async name => {
    const info = await lstat(path.join(directory, name)).catch(() => null); return info ? { name, info } : null;
  })).then(entries => entries.filter(Boolean));
  files.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
  for (const [index, entry] of files.entries()) if (index >= limit || entry.info.mtimeMs < now - days * 86400000) {
    if (entry.info.isFile() && !entry.info.isSymbolicLink()) await rm(path.join(directory, entry.name), { force: true });
  }
}

export async function readPerformanceReport(base, { actionId = null, limit = 20, includeTimeline = false } = {}) {
  if (actionId != null && !traceIdentifier(actionId)) throw new Error('Use the opaque action ID returned by a performance trace.');
  const directory = await safeDirectory(base, false).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!directory) return { resultType: 'sflow-performance-report', status: 'unavailable', traces: [], instruction: 'Enable SINGULARITY_FLOW_PERF_TRACE=1 and run the original command. No history is reconstructed.' };
  const selected = await Promise.all((await readdir(directory)).filter(name => FILE.test(name)).map(async name => {
    const info = await lstat(path.join(directory, name)).catch(() => null); return info ? { name, info } : null;
  })).then(entries => entries.filter(Boolean));
  selected.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
  const traces = [], warnings = [], hosts = new Map();
  let bytesRead = 0, remainingTimelineSpans = 8192;
  for (const entry of selected.slice(0, 512)) {
    if (traces.length >= bounded(limit, 20, 64) && !entry.name.endsWith('.host.json')) continue;
    if (!entry.info.isFile() || entry.info.isSymbolicLink() || entry.info.size > MAXIMUM_BYTES) { warnings.push('Skipped an unsafe or oversized performance record.'); continue; }
    bytesRead += entry.info.size;
    if (bytesRead > 32 * 1024 * 1024) { warnings.push('Performance report read budget reached; narrow by action or limit.'); break; }
    let trace;
    try { trace = JSON.parse(await boundedRead(path.join(directory, entry.name))); }
    catch { warnings.push('Skipped an unreadable performance record.'); continue; }
    if (entry.name.endsWith('.host.json')) {
      const host = projectHost(trace);
      if (host) hosts.set(host.parentSpanId, host);
      else warnings.push('Skipped an invalid host observation.');
      continue;
    }
    trace = projectTrace(trace);
    if (!trace) {
      warnings.push('Skipped an invalid performance record.'); continue;
    }
    if (actionId && trace.actionId !== actionId) continue;
    if (traces.length >= bounded(limit, 20, 64)) continue;
    const timeline = includeTimeline ? trace.spans.slice(0, remainingTimelineSpans) : undefined;
    remainingTimelineSpans -= timeline?.length ?? 0;
    traces.push({ actionId: trace.actionId, invocationId: trace.invocationId, parentSpanId: trace.parentSpanId, command: trace.command,
      operationId: trace.operationId, commandClass: trace.commandClass,
      startedAt: trace.startedAt, platform: trace.platform, temperature: trace.temperature, outcome: trace.outcome,
      cpu: trace.cpu, memory: trace.memory, counters: trace.counters,
      ...summarizePerformanceTrace(trace), spanCount: trace.spans.length,
      ...(includeTimeline ? { timeline, timelineTruncated: timeline.length < trace.spans.length } : {}) });
  }
  for (const trace of traces) {
    const host = hosts.get(trace.parentSpanId);
    trace.host = host?.actionId === trace.actionId ? { ...host,
      outsideCommandWindowMs: Math.max(0, (host.processMs ?? host.durationMs) - trace.durationMs) } : null;
  }
  return { resultType: 'sflow-performance-report', status: traces.length ? 'available' : 'unavailable', traces, warnings: [...new Set(warnings)],
    instruction: 'Compare like-for-like runs. Shared action IDs correlate commands; never sum overlapping service time. Native Copilot internals/token cost are unavailable. Remote Git is whole-operation time; file coverage is targeted, not exhaustive.' };
}

export function performanceReportText(report) {
  const lines = [`Performance: ${report.status}`];
  for (const trace of report.traces) {
    lines.push(`${trace.command}: ${trace.durationMs.toFixed(1)}ms · ${trace.outcome} · action ${trace.actionId}`);
    if (trace.host) lines.push(`  host: ${trace.host.durationMs.toFixed(1)}ms child window · ${trace.host.queueMs.toFixed(1)}ms queue · ${trace.host.parseMs.toFixed(1)}ms parse`);
    for (const row of trace.categories.filter(row => row.calls || row.wallMs).sort((a, b) => b.wallMs - a.wallMs)) lines.push(`  ${row.category}: ${row.wallMs.toFixed(1)}ms wall · ${row.calls} calls · ${row.exclusiveServiceMs.toFixed(1)}ms exclusive service`);
    lines.push(`  overlap: ${trace.overlapMs.toFixed(1)}ms · unattributed: ${trace.unattributedMs.toFixed(1)}ms`,
      `  physical Git spawns: ${trace.counters['git.spawns'] ?? 'unavailable'} · first feedback: ${trace.firstFeedbackMs == null ? 'unavailable' : `${trace.firstFeedbackMs.toFixed(1)}ms`}`,
      `  coverage: ${trace.coverage.status} · dropped spans: ${trace.droppedSpans}`);
  }
  lines.push(report.instruction, ...(report.warnings ?? []));
  return lines.join('\n') + '\n';
}

function projectHost(raw) {
  try { raw = readRecord('performance-trace', raw).record; } catch { return null; }
  if (raw.resultType !== 'sflow-performance-host' || !traceIdentifier(raw.actionId)
      || !traceIdentifier(raw.parentSpanId) || metric(raw.durationMs) == null) return null;
  return { schemaVersion: raw.schemaVersion, resultType: raw.resultType, actionId: raw.actionId, parentSpanId: raw.parentSpanId,
    ...selectedMetrics(raw, ['durationMs', 'launchCallMs', 'firstByteMs', 'processMs', 'parseMs', 'postCloseMs']),
    queueMs: metric(raw.queueMs) ?? 0, parseMs: metric(raw.parseMs) ?? 0, coverage: 'host-observed-child-process' };
}

/** No extra Git request. Write only into a store already created by that exact CLI checkout.
 * Linked worktrees must have reciprocal Git metadata. Never recreate a removed/reset store. */
export async function writeHostPerformanceTrace(repository, event) {
  const host = projectHost(stampCurrentRecord('performance-trace', { resultType: 'sflow-performance-host', ...event.performance,
    durationMs: event.durationMs, queueMs: event.stages?.queueMs }));
  if (!host || typeof repository !== 'string' || !path.isAbsolute(repository)) return;
  const root = await realpath(repository);
  const metadata = path.join(root, '.git'), info = await lstat(metadata);
  if (info.isSymbolicLink()) return;
  let gitDirectory;
  if (info.isDirectory()) gitDirectory = metadata;
  else if (info.isFile() && info.size < 4096) {
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/u.exec(await boundedRead(metadata, 4096));
    if (!match) return;
    gitDirectory = path.resolve(root, match[1]);
    const admin = await lstat(gitDirectory);
    if (!admin.isDirectory() || admin.isSymbolicLink()) return;
    const common = path.resolve(gitDirectory, (await boundedRead(path.join(gitDirectory, 'commondir'), 4096)).trim());
    if (path.dirname(gitDirectory) !== path.join(common, 'worktrees')) return;
    for (const parent of [common, path.dirname(gitDirectory)]) {
      const entry = await lstat(parent);
      if (!entry.isDirectory() || entry.isSymbolicLink()) return;
    }
    const back = (await boundedRead(path.join(gitDirectory, 'gitdir'), 4096)).trim();
    if (await realpath(path.resolve(gitDirectory, back)) !== metadata) return;
  } else return;
  // Existing ancestors must be real directories too; do not follow a replaced diagnostic tree.
  for (const part of ['singularity-flow', 'singularity-flow/dx']) {
    const entry = await lstat(path.join(gitDirectory, part));
    if (!entry.isDirectory() || entry.isSymbolicLink()) return;
  }
  const directory = await safeDirectory(path.join(gitDirectory, 'singularity-flow', 'dx'), false);
  if (!directory) return;
  const file = path.join(directory, `${host.parentSpanId}.host.json`), temporary = `${file}.${process.pid}.partial`;
  try { await writeFile(temporary, JSON.stringify(host), { flag: 'wx', mode: 0o600 }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
  await prune(directory, Date.now(), process.env);
}
