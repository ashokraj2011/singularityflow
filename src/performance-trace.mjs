/** Opt-in, content-free operation traces. Loaded only when detailed tracing is requested. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const scope = new AsyncLocalStorage();
export const TRACE_FORMAT = 1;
export const PERFORMANCE_CATEGORIES = Object.freeze(['network', 'git-local', 'copilot', 'file', 'node', 'workflow', 'external', 'waiting']);
const categories = new Set(PERFORMANCE_CATEGORIES);
const identifier = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const namePattern = /^[a-z][a-z0-9.-]{0,79}$/u;
const bounded = (value, fallback, maximum) => Number.isSafeInteger(Number(value)) && Number(value) > 0
  ? Math.min(Number(value), maximum) : fallback;
const round = value => Math.round(value * 1000) / 1000;

export function traceIdentifier(value) { return typeof value === 'string' && identifier.test(value) ? value : null; }

function attributes(value = {}) {
  const result = {};
  for (const key of ['bytes', 'items', 'attempt', 'queueMs', 'launchMs', 'firstByteMs', 'parseMs']) {
    if (Number.isFinite(value[key]) && value[key] >= 0) result[key] = round(value[key]);
  }
  if (['hit', 'miss', 'reuse', 'none'].includes(value.cache)) result.cache = value.cache;
  if (['cold', 'prewarmed', 'warm', 'unknown'].includes(value.temperature)) result.temperature = value.temperature;
  return result;
}

function outcome(value) {
  if (value?.timedOut || value?.error?.code === 'ETIMEDOUT'
      || typeof value?.transport?.code === 'string' && value.transport.code.endsWith('_TIMEOUT')) return 'timeout';
  if (value?.cancelled || value?.aborted || value?.error?.name === 'AbortError') return 'cancelled';
  if (value?.blocked) return 'blocked';
  if (value?.error || value?.transport?.outcome === 'failed' || value?.transport?.outcome === 'retry'
      || Number.isInteger(value?.status) && value.status !== 0 && (value.status < 200 || value.status >= 400)) return 'error';
  return 'success';
}

export function createPerformanceTrace({ command = 'command', invocationId = randomUUID(),
  actionId = process.env.SINGULARITY_FLOW_PERF_ACTION_ID,
  parentSpanId = process.env.SINGULARITY_FLOW_PERF_PARENT_SPAN_ID,
  started = process.hrtime.bigint(), clock = process.hrtime.bigint, wallClock = Date.now,
  maxSpans = process.env.SINGULARITY_FLOW_PERF_MAX_SPANS, temperature = 'unknown' } = {}) {
  const limit = bounded(maxSpans, 2048, 8192);
  const created = clock();
  const startedAt = wallClock() - Number(created - started) / 1e6;
  const rootSpanId = randomUUID();
  const spans = [];
  let droppedSpans = 0, sequence = 0, sealed = null;
  const cpu = process.cpuUsage();
  const rssStart = process.memoryUsage().rss;
  const elapsed = () => Math.max(0, Number(clock() - started) / 1e6);
  const trace = {
    actionId: traceIdentifier(actionId) ?? randomUUID(), invocationId, rootSpanId,
    run(action) {
      return scope.getStore()?.trace === trace ? action() : scope.run({ trace, parent: rootSpanId, depth: 0 }, action);
    },
    begin(category, name, fields = {}) {
      if (sealed || !categories.has(category) || !namePattern.test(String(name)) || spans.length >= limit) {
        droppedSpans++;
        return { end() {}, run: action => action() };
      }
      const current = scope.getStore();
      const span = { id: randomUUID(), parentId: current?.trace === trace ? current.parent : rootSpanId,
        depth: current?.trace === trace ? current.depth + 1 : 1,
        sequence: sequence++, category, name, startMs: elapsed(), endMs: null, outcome: 'incomplete',
        attributes: attributes(fields), kind: 'operation' };
      spans.push(span);
      let ended = false;
      return {
        run: action => scope.run({ trace, parent: span.id, depth: span.depth }, action),
        end(value, error) {
          if (ended || sealed) return;
          ended = true;
          span.endMs = elapsed();
          try {
            const code = typeof error?.code === 'string' ? error.code : '';
            span.outcome = error ? code === 'ENOENT' ? 'not-found' : error.name === 'AbortError' || code.endsWith('_CANCELLED') ? 'cancelled'
              : code === 'ETIMEDOUT' || code.endsWith('_TIMEOUT') ? 'timeout' : 'error' : outcome(value);
            if (error && ['Error', 'TypeError', 'SyntaxError', 'AbortError', 'SingularityFlowError'].includes(error.name)) span.errorClass = error.name;
            Object.assign(span.attributes, attributes(value?.performance));
            if (/^(?:file\.read|http\.download)/u.test(name)) {
              if (typeof value === 'string') span.attributes.bytes = Buffer.byteLength(value);
              else if (Buffer.isBuffer(value)) span.attributes.bytes = value.length;
              else if (Number.isSafeInteger(value?.size) && value.size >= 0) span.attributes.bytes = value.size;
            }
          } catch { span.outcome = 'unknown'; /* A provider's metric getters cannot replace its result/error. */ }
        }
      };
    },
    measure(category, name, action, fields) {
      const span = trace.begin(category, name, fields);
      return span.run(() => {
        try {
          const value = action();
          if (value && typeof value.then === 'function') return value.then(result => { span.end(result); return result; }, error => { span.end(null, error); throw error; });
          span.end(value);
          return value;
        } catch (error) { span.end(null, error); throw error; }
      });
    },
    stage(name, startMs, endMs) {
      if (sealed || spans.length >= limit) { droppedSpans++; return; }
      if (!namePattern.test(name)) return;
      spans.push({ id: randomUUID(), parentId: rootSpanId, sequence: sequence++, depth: 0,
        kind: 'stage', category: name === 'execute' ? 'workflow' : name === 'worker-queue' ? 'waiting' : 'node', name,
        startMs, endMs, outcome: 'success', attributes: {} });
    },
    finish({ firstFeedbackMs = null, outcome: result = 'success', counters = {}, operationId = null, commandClass = 'unknown' } = {}) {
      if (sealed) return sealed;
      const durationMs = elapsed();
      const cpuUsed = process.cpuUsage(cpu);
      sealed = { schemaVersion: TRACE_FORMAT, resultType: 'sflow-performance-trace',
        actionId: trace.actionId, invocationId, rootSpanId, parentSpanId: traceIdentifier(parentSpanId),
        command: namePattern.test(command) ? command : 'command',
        operationId: typeof operationId === 'string' && namePattern.test(operationId) ? operationId : null,
        commandClass: ['read', 'mutation'].includes(commandClass) ? commandClass : 'unknown',
        startedAt: new Date(startedAt).toISOString(), durationMs,
        firstFeedbackMs, outcome: result, platform: process.platform, architecture: process.arch,
        temperature: ['cold', 'warm', 'prewarmed'].includes(temperature) ? temperature : 'unknown',
        cpu: { userMs: cpuUsed.user / 1000, systemMs: cpuUsed.system / 1000, scope: 'collector-lifetime' },
        memory: { rssStartBytes: rssStart, rssEndBytes: process.memoryUsage().rss },
        spans: spans.map(span => ({ ...span, startMs: round(span.startMs),
          endMs: round(span.endMs ?? durationMs) })), droppedSpans,
        counters: Object.fromEntries(Object.entries(counters).filter(([key, value]) => namePattern.test(key) && Number.isSafeInteger(value) && value >= 0)),
        coverage: { status: droppedSpans || spans.some(span => span.endMs === null || span.outcome === 'unknown') ? 'partial' : 'instrumented-boundaries',
          fileAccess: 'shared-and-targeted-boundaries-only', nativeCopilot: 'unavailable-unless-host-exported',
          gitRemote: 'whole-operation-not-pure-network', preNodeStartup: 'host-observation-required',
          cpu: 'process-aggregate-not-per-category', postExitUi: 'host-observation-required',
          persistence: 'excluded-after-command-window' } };
      return sealed;
    }
  };
  return trace;
}

function union(intervals) {
  let total = 0, end = -Infinity;
  for (const [left, right] of intervals.sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, right - Math.max(left, end));
    end = Math.max(end, right);
  }
  return total;
}

/** Never sum overlapping service durations into user wall time. Different parallel leaves are overlap. */
export function summarizePerformanceTrace(trace) {
  const duration = Math.max(0, trace.durationMs);
  const spans = trace.spans.filter(span => categories.has(span.category) && Number.isFinite(span.startMs) && Number.isFinite(span.endMs))
    .map(span => ({ ...span, startMs: Math.max(0, Math.min(duration, span.startMs)), endMs: Math.max(0, Math.min(duration, span.endMs)) }))
    .filter(span => span.endMs >= span.startMs);
  const rows = Object.fromEntries(PERFORMANCE_CATEGORIES.map(category => [category,
    { category, calls: 0, inclusiveServiceMs: 0, exclusiveServiceMs: 0, wallMs: 0, bytes: 0, errors: 0,
      notFound: 0, timeouts: 0, cancellations: 0, blocked: 0, cacheHits: 0, retries: 0 }]));
  const operations = spans.filter(span => span.kind !== 'stage');
  const parents = new Map(operations.map(span => [span.id, span.parentId]));
  const children = new Map();
  for (const span of operations) {
    if (!children.has(span.parentId)) children.set(span.parentId, []);
    children.get(span.parentId).push(span);
  }
  for (const span of operations) {
    const row = rows[span.category]; row.calls++;
    row.inclusiveServiceMs += span.endMs - span.startMs;
    row.bytes += span.attributes?.bytes ?? 0;
    if (!['success', 'blocked', 'not-found'].includes(span.outcome)) row.errors++;
    if (span.outcome === 'not-found') row.notFound++;
    if (span.outcome === 'timeout') row.timeouts++;
    if (span.outcome === 'cancelled') row.cancellations++;
    if (span.outcome === 'blocked') row.blocked++;
    if (['hit', 'reuse'].includes(span.attributes?.cache)) row.cacheHits++;
    if (span.attributes?.attempt > 1) row.retries++;
    const intervals = (children.get(span.id) ?? [])
      .map(child => [Math.max(span.startMs, child.startMs), Math.min(span.endMs, child.endMs)]).filter(([a, b]) => b >= a);
    row.exclusiveServiceMs += Math.max(0, span.endMs - span.startMs - union(intervals));
  }
  // Sweep endpoints instead of repeatedly comparing every pair of active spans. Diagnostic
  // processing stays bounded even for thousands of simultaneous requests. Cyclic imported
  // parent links are tolerated, never followed indefinitely.
  const events = spans.filter(span => span.endMs > span.startMs).flatMap(span => [
    { at: span.startMs, start: true, span }, { at: span.endMs, start: false, span }
  ]).sort((a, b) => a.at - b.at || Number(a.start) - Number(b.start));
  const active = new Map(), descendants = new Map(), leafCategories = new Map();
  const stages = new Map();
  let previous = 0;
  const leaf = (span, change) => leafCategories.set(span.category, (leafCategories.get(span.category) ?? 0) + change);
  const ancestors = (span, change) => {
    const seen = new Set([span.id]); let cursor = parents.get(span.id);
    while (parents.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      const old = descendants.get(cursor) ?? 0, next = Math.max(0, old + change);
      descendants.set(cursor, next);
      if (active.has(cursor) && (old === 0) !== (next === 0)) leaf(active.get(cursor), next === 0 ? 1 : -1);
      cursor = parents.get(cursor);
    }
  };
  let overlapMs = 0, unattributedMs = 0;
  const charge = right => {
    const leaves = [...leafCategories].filter(([, count]) => count > 0).map(([category]) => category);
    if (!leaves.length && !active.size) leaves.push(...[...stages].filter(([, count]) => count > 0).map(([category]) => category));
    if (!leaves.length) unattributedMs += right - previous;
    else if (leaves.length > 1) overlapMs += right - previous;
    else rows[leaves[0]].wallMs += right - previous;
    previous = right;
  };
  for (const event of events) {
    charge(event.at);
    const span = event.span;
    if (span.kind === 'stage') {
      if (span.name !== 'execute') stages.set(span.category, (stages.get(span.category) ?? 0) + (event.start ? 1 : -1));
      continue;
    }
    if (event.start) {
      ancestors(span, 1); active.set(span.id, span);
      if (!(descendants.get(span.id) ?? 0)) leaf(span, 1);
    } else {
      if (!(descendants.get(span.id) ?? 0)) leaf(span, -1);
      active.delete(span.id); ancestors(span, -1);
    }
  }
  charge(duration);
  return { durationMs: round(duration), firstFeedbackMs: trace.firstFeedbackMs,
    categories: Object.values(rows).map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'number' ? round(value) : value]))),
    overlapMs: round(overlapMs), unattributedMs: round(unattributedMs),
    coverage: trace.coverage, droppedSpans: trace.droppedSpans,
    note: 'Category wall time + overlap + unattributed equals elapsed time. Service time may exceed elapsed time. Node wall time is not CPU time.' };
}
