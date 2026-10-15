/** Observations only: no receipt, cache authority, approval or estimate of billed savings. */
import { percentile } from './dx-performance.mjs';

export const COPILOT_TIMING_LAYERS = Object.freeze([
  'preHookMs', 'startupMs', 'moduleLoadMs', 'executionMs', 'postHookMs', 'modelWaitMs', 'gitMs'
]);
export const COPILOT_OPERATION_COUNTERS = Object.freeze([
  'git.requests', 'git.spawns', 'git.fact-cache-hits', 'git.fact-store-hits', 'git.remote.total',
  'cli.steps.process-spawns', 'cli.steps.read-reused', 'configuration.definition-load',
  'catalog.scans', 'files.read', 'files.bytes'
]);

function observationError(index) {
  return new Error(`Invalid optional measurements in tool event ${index}.`);
}

export function measurementSummary(values) {
  if (!values.length) return { samples: 0, total: null, p50: null, p95: null, maximum: null };
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total)) throw new Error('Measurement total exceeded its numeric bound.');
  return { samples: values.length, total, p50: percentile(values, 50), p95: percentile(values, 95),
    maximum: Math.max(...values) };
}

/** Optional exported host timings may overlap (Git is inside execution); never add the layers. */
export function nativeCopilotMeasurements(events, wallClock) {
  const layers = new Map(COPILOT_TIMING_LAYERS.map(name => [name, []]));
  const counts = new Map(COPILOT_OPERATION_COUNTERS.map(name => [name, []]));
  const runtimes = { bundled: 0, sources: 0, unknown: 0 };
  for (const [index, event] of events.entries()) {
    for (const [field, names, target, integer] of [
      ['timings', COPILOT_TIMING_LAYERS, layers, false],
      ['counters', COPILOT_OPERATION_COUNTERS, counts, true]
    ]) {
      const record = event[field];
      if (record === undefined) continue;
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw observationError(index);
      for (const name of names) {
        if (!Object.hasOwn(record, name)) continue;
        const value = record[name];
        if (!Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) throw observationError(index);
        target.get(name).push(value);
      }
    }
    const mode = event.runtimeMode ?? 'unknown';
    if (typeof mode !== 'string' || !Object.hasOwn(runtimes, mode)) throw observationError(index);
    runtimes[mode]++;
  }
  const operationCounters = Object.fromEntries([...counts].map(([name, values]) => {
    const summary = measurementSummary(values);
    if (summary.total !== null && !Number.isSafeInteger(summary.total)) throw new Error('Counter total exceeded its numeric bound.');
    return [name, { samples: summary.samples, total: summary.total }];
  }));
  return { unit: 'milliseconds', layers: Object.fromEntries([...layers].map(([name, values]) =>
    [name, measurementSummary(values)])), operationCounters, runtimeModes: runtimes,
  wallClock: wallClockMeasurement(wallClock) };
}

function wallClockMeasurement(window) {
  if (window === undefined) return { durationMs: null, source: 'unavailable' };
  const timestamp = value => typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    ? Date.parse(value) : NaN;
  const start = timestamp(window?.startedAt), end = timestamp(window?.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new Error('wallClock requires ordered ISO timestamps with explicit timezones.');
  }
  return { durationMs: end - start, source: 'exported-host-trace' };
}

const BENCHMARK_FIELDS = ['scope', 'scenarioId', 'fixtureSha256', 'platform', 'host', 'temperature', 'sampleCount'];

function benchmarkIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !['command', 'story'].includes(value.scope)
      || !['darwin', 'win32', 'linux'].includes(value.platform)
      || !['cold', 'warm'].includes(value.temperature)
      || typeof value.fixtureSha256 !== 'string'
      || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(value.fixtureSha256 ?? '')
      || !Number.isSafeInteger(value.sampleCount) || value.sampleCount < 1
      || !['scenarioId', 'host'].every(key => typeof value[key] === 'string'
        && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value[key]))) return null;
  return Object.fromEntries(BENCHMARK_FIELDS.map(key => [key,
    key === 'fixtureSha256' ? value[key].replace(/^sha256:/u, '') : value[key]]));
}

function change(before, after) {
  if (before === null || after === null) return null;
  const percent = before > 0 ? (before - after) / before * 10000 : NaN;
  return { before, after, delta: after - before,
    reductionPercent: Number.isFinite(percent) ? Math.round(percent) / 100 : null };
}

/** Only like-for-like reported fixtures may produce an observed before/after difference. */
export function compareCopilotMeasurements(beforeTrace, afterTrace, before, after) {
  const baseline = benchmarkIdentity(beforeTrace.benchmark), candidate = benchmarkIdentity(afterTrace.benchmark);
  const reasons = [];
  if (!baseline || !candidate) reasons.push('benchmark.identity-missing-or-invalid');
  else {
    for (const key of BENCHMARK_FIELDS) if (baseline[key] !== candidate[key]) reasons.push(`benchmark.mismatch.${key}`);
    if ((beforeTrace.workflow ?? null) !== (afterTrace.workflow ?? null)) reasons.push('benchmark.mismatch.workflow');
    if (baseline.scope === 'story' && (!before.completeStoryReported || !after.completeStoryReported)) {
      reasons.push('benchmark.story-incomplete');
    }
    if (baseline.scope === 'story' && JSON.stringify(beforeTrace.phaseOrder) !== JSON.stringify(afterTrace.phaseOrder)) {
      reasons.push('benchmark.mismatch.phaseOrder');
    }
  }
  return { comparable: reasons.length === 0, reasons, benchmark: baseline,
    changes: reasons.length ? null : {
      toolCalls: change(before.toolCalls, after.toolCalls),
      responseBytes: change(before.responseBytes, after.responseBytes),
      toolServiceMs: before.timedEvents === before.toolCalls && after.timedEvents === after.toolCalls
        && before.toolCalls > 0 && after.toolCalls > 0 ? change(before.durationMsSum, after.durationMsSum) : null,
      wallClockMs: change(before.measurements.wallClock.durationMs, after.measurements.wallClock.durationMs)
    },
    coverage: { before: { toolCalls: before.toolCalls, timedEvents: before.timedEvents },
      after: { toolCalls: after.toolCalls, timedEvents: after.timedEvents } },
    billedSavings: null,
    limitations: ['Benchmark identity and completion are reported, not independently attested.',
      'Tool durations and layer timings can overlap; they are not end-to-end latency.',
      'Observed differences are not statistical significance, causal attribution or billed savings.'] };
}
