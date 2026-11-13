import { nowIso } from './util.mjs';
import { automaticApprovalDisposition } from './lifecycle-transitions.mjs';
import { estimatePremiumRequests } from './copilot-activity.mjs';

const DECISION_EVENTS = new Set(['phase_approved', 'phase_self_approved', 'phase_rejected', 'phase-approval-waived']);
const COMPLETION_EVENTS = new Set(['phase_approved', 'phase_self_approved', 'phase-approval-waived', 'phase_completed_without_approval']);
// Recorded about a phase without anyone working on it then: they do not move the work.
const BOOKKEEPING_EVENTS = new Set(['phase_telemetry_reconciled', 'phase_assigned', 'phase_retained']);

function timestamp(value) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function compareEvents(left, right) {
  return (timestamp(left?.at) ?? Number.MAX_SAFE_INTEGER) - (timestamp(right?.at) ?? Number.MAX_SAFE_INTEGER);
}

export function humanizeDuration(milliseconds) {
  if (milliseconds == null || !Number.isFinite(milliseconds) || milliseconds < 0) return '—';
  const seconds = milliseconds / 1000;
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 36) return `${(Math.round(hours * 10) / 10).toFixed(1)}h`;
  const days = hours / 24;
  return `${(Math.round(days * 10) / 10).toFixed(1)}d`;
}

function usageCost(record, pricing) {
  if (Number.isFinite(record.providerCost)) return { value: record.providerCost, complete: record.costStatus !== 'partial', source: 'provider' };
  if (record.status !== 'exact') return null;
  const price = pricing?.[record.model];
  if (!price) return null;
  const components = [
    [record.inputTokens, price.input],
    [record.outputTokens, price.output],
    [record.cachedInputTokens, price.cachedInput]
  ].filter(([tokens]) => Number.isFinite(tokens));
  if (!components.length) return null;
  const priced = components.filter(([, rate]) => Number.isFinite(rate));
  if (!priced.length) return null;
  return {
    value: priced.reduce((sum, [tokens, rate]) => sum + (tokens / 1_000_000) * rate, 0),
    complete: priced.length === components.length,
    source: 'pricing'
  };
}

function phaseEvents(history, phaseId) {
  return (history ?? []).filter((event) => event.phase === phaseId).toSorted(compareEvents);
}

function waitingTime(events, reportTime) {
  let waitingMs = 0;
  const cycles = [];
  let pendingSubmit = null;
  for (const event of events) {
    if (event.event === 'phase_submitted') pendingSubmit = event;
    else if (pendingSubmit && DECISION_EVENTS.has(event.event)) {
      const start = timestamp(pendingSubmit.at);
      const end = timestamp(event.at);
      if (start != null && end != null && end >= start) {
        waitingMs += end - start;
        cycles.push({ submittedAt: pendingSubmit.at, decidedAt: event.at, decision: event.event, waitedMs: end - start });
      }
      pendingSubmit = null;
    }
  }
  const openStart = timestamp(pendingSubmit?.at);
  if (openStart != null && reportTime != null && reportTime >= openStart) waitingMs += reportTime - openStart;
  return { waitingMs, cycles, openSubmission: pendingSubmit?.at ?? null };
}

function phaseWindow(phase, events, reportTime) {
  const candidates = [timestamp(phase.startedAt), timestamp(events[0]?.at)].filter((value) => value != null);
  const start = candidates.length ? Math.min(...candidates) : null;
  const active = ['in_progress', 'awaiting_approval'].includes(phase.status);
  const end = active ? reportTime : timestamp(phase.approvedAt) ?? timestamp(events.at(-1)?.at);
  const elapsedMs = start != null && end != null && end >= start ? end - start : null;
  return { start, end, elapsedMs };
}

function actorLabel(actor) {
  if (typeof actor === 'string') return actor;
  return actor?.login ?? actor?.email ?? actor?.name ?? 'unknown';
}

function tokenStatus(usage, exactRecords) {
  if (!usage.length) return 'none';
  if (!exactRecords.length) return 'unavailable';
  return exactRecords.length === usage.length ? 'exact' : 'partial';
}

function usageByModel(records, pricing = null) {
  const aggregates = new Map();
  for (const record of records) {
    const provider = record.provider || 'unavailable';
    const model = record.model || 'unavailable';
    const key = JSON.stringify([provider, model]);
    const aggregate = aggregates.get(key) ?? {
      provider,
      model,
      records: 0,
      exactRecords: 0,
      unavailableRecords: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      inputTokenRecords: 0,
      outputTokenRecords: 0,
      cachedInputTokenRecords: 0,
      cost: 0,
      pricedRecords: 0,
      fullyPricedRecords: 0,
      providerCostRecords: 0,
      configuredPriceRecords: 0
    };
    aggregate.records += 1;
    aggregate[record.status === 'exact' ? 'exactRecords' : 'unavailableRecords'] += 1;
    aggregate.totalTokens += record.totalTokens ?? 0;
    for (const field of ['inputTokens', 'outputTokens', 'cachedInputTokens']) {
      if (record.status === 'exact' && Number.isFinite(record[field])) {
        aggregate[field] += record[field];
        aggregate[`${field.replace(/s$/, '')}Records`] += 1;
      }
    }
    const priced = record.status === 'exact' ? usageCost(record, pricing) : null;
    if (priced) {
      aggregate.cost += priced.value;
      aggregate.pricedRecords += 1;
      if (priced.complete) aggregate.fullyPricedRecords += 1;
      aggregate[priced.source === 'provider' ? 'providerCostRecords' : 'configuredPriceRecords'] += 1;
    }
    aggregates.set(key, aggregate);
  }
  return [...aggregates.values()].map((aggregate) => ({
    ...aggregate,
    inputTokens: aggregate.inputTokenRecords ? aggregate.inputTokens : null,
    outputTokens: aggregate.outputTokenRecords ? aggregate.outputTokens : null,
    cachedInputTokens: aggregate.cachedInputTokenRecords ? aggregate.cachedInputTokens : null,
    cost: aggregate.pricedRecords ? aggregate.cost : null,
    costStatus: !aggregate.pricedRecords
      ? 'unavailable'
      : aggregate.fullyPricedRecords === aggregate.records ? 'exact' : 'partial'
  })).sort((left, right) => `${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`));
}

/**
 * A count summed over the generations a model helped with. `none` means no such generation,
 * `unavailable` that none of them reported the count, `partial` that only some did.
 */
function countMetric(values) {
  if (!values.length) return { value: null, status: 'none' };
  const entries = values.map((value) => (value != null && typeof value === 'object' ? value : { value, partial: false }));
  const known = entries.filter((entry) => Number.isFinite(entry.value));
  if (!known.length) return { value: null, status: 'unavailable' };
  return {
    value: known.reduce((sum, entry) => sum + entry.value, 0),
    status: known.length === entries.length && known.every((entry) => !entry.partial) ? 'observed' : 'partial'
  };
}

/** Phase metrics combined into Story totals, keeping `partial` wherever a phase was partial. */
function combineMetrics(metrics) {
  const relevant = metrics.filter((metric) => metric && metric.status !== 'none');
  if (!relevant.length) return { value: null, status: 'none' };
  const known = relevant.filter((metric) => metric.value != null);
  if (!known.length) return { value: null, status: 'unavailable' };
  return {
    value: known.reduce((sum, metric) => sum + metric.value, 0),
    status: known.length === relevant.length && known.every((metric) => metric.status === 'observed') ? 'observed' : 'partial'
  };
}

function combinePremium(estimates) {
  const relevant = estimates.filter((estimate) => estimate && estimate.status !== 'none');
  const missingModels = [...new Set(relevant.flatMap((estimate) => estimate.missingModels ?? []))].sort();
  if (!relevant.length) return { value: null, status: 'none', missingModels };
  const known = relevant.filter((estimate) => estimate.value != null);
  if (!known.length) return { value: null, status: 'unavailable', missingModels };
  // Copilot's own count (from its session logs) is observed; beside an estimate the sum is an estimate.
  const complete = known.length === relevant.length && known.every((estimate) => ['estimated', 'observed'].includes(estimate.status));
  return {
    value: Math.round(known.reduce((sum, estimate) => sum + estimate.value, 0) * 100) / 100,
    status: !complete ? 'partial' : known.every((estimate) => estimate.status === 'observed') ? 'observed' : 'estimated',
    missingModels
  };
}

/**
 * What Copilot did for one phase, from the activity and prompt size its telemetry records carry.
 *
 * Model calls also come from the chat-span count every telemetry record has always stored, so
 * Stories captured before activity counting still chart them. Nothing here is converted to zero:
 * a generation that was not captured makes a count partial or unavailable.
 */
const CAPTURE_GAP_REASONS = {
  'no-metered-session': 'not-metered', disabled: 'disabled', conflict: 'conflict', 'awaiting-export': 'pending'
};

/**
 * Why a model-assisted generation has no activity. Publication records the gap from the
 * generation's launches. Older records only have a status, and a `pending` one cannot say whether
 * a launch is still exporting or none ran, so it is reported as unconfirmed rather than guessed.
 */
function uncapturedReason(entry) {
  if (entry.captureGap) return CAPTURE_GAP_REASONS[entry.captureGap] ?? 'not-metered';
  if (entry.status === 'pending') return 'unconfirmed';
  if (entry.status === 'disabled' || entry.status === 'conflict') return entry.status;
  return 'older-record';
}

const plural = (count, one, many = `${one}s`) => (count === 1 ? one : many);

const CAPTURE_NOTES = [
  ['pending', (count) => `${count} ${plural(count, 'generation')} ${plural(count, 'is', 'are')} waiting to be recorded; run \`singularity-flow telemetry reconcile\` once Copilot has finished the turn.`],
  ['unconfirmed', (count) => `${count} ${plural(count, 'generation')} ${plural(count, 'has', 'have')} no Copilot activity. For work in a session started with \`singularity-flow copilot\`, run \`singularity-flow telemetry reconcile\`; Copilot Chat in VS Code is counted only on a computer where counting is on.`],
  ['disabled', (count) => `${count} ${plural(count, 'generation')} ran with local capture turned off; run \`singularity-flow telemetry enable\` to accept it.`],
  ['conflict', (count) => `${count} ${plural(count, 'generation')} found an OpenTelemetry setup SFlow would not override; see \`singularity-flow telemetry probe\`.`],
  ['not-metered', (count) => `${count} ${plural(count, 'generation')} ran without a metered Copilot session. Copilot reports requests, turns and calls to SFlow for sessions started with \`singularity-flow copilot\` (in VS Code, Continue with Copilot CLI) after \`singularity-flow telemetry enable\`, and for Copilot Chat in VS Code on a computer where counting is on.`],
  ['older-record', (count) => `${count} ${plural(count, 'generation')} ${plural(count, 'was', 'were')} published before SFlow counted Copilot activity.`]
];

const CHAT_NOT_COUNTED = 'Copilot Chat in VS Code is not counted on this computer. Turn it on with "Singularity Flow: Count Copilot Chat Usage"; requests made before then cannot be recovered.';
// When Copilot's session logs were read, a phase they hold nothing for was not worked in Copilot CLI
// or VS Code's Copilot agent on this computer: no launch setting would have counted it. [owner, 2026-11-13]
const NOT_IN_SESSION_LOGS = (count) => `${count} ${plural(count, 'generation')} ${plural(count, 'has', 'have')} no Copilot activity on this computer: Copilot's session logs (Copilot CLI and VS Code's Copilot agent) hold none for ${plural(count, 'its phase', 'their phases')}. Work done on another computer, or in a tool that writes no session log, is not counted here.`;

/** One sentence per reason, with what to do about it, for every surface that shows the counts. */
function copilotCaptureNotes(uncaptured, { chatCounted = false, sessionsRead = false } = {}) {
  const notes = CAPTURE_NOTES.filter(([reason]) => uncaptured[reason])
    .map(([reason, note]) => (reason === 'not-metered' && sessionsRead ? NOT_IN_SESSION_LOGS : note)(uncaptured[reason]));
  return !chatCounted && (uncaptured['not-metered'] || uncaptured.unconfirmed) ? [...notes, CHAT_NOT_COUNTED] : notes;
}

/**
 * Which phase was being worked on at a moment, from the Story's history: a completed phase hands
 * work to the next one, and a send-back to the phase it names. Before the Story began, or after its
 * last phase completed, none was. Copilot Chat requests and the model calls in Copilot's session
 * logs are both placed with it, so the two never disagree about a phase.
 */
function phaseAtTime(workflow, history) {
  const order = workflow.phaseOrder;
  const timeline = [];
  const begun = timestamp(history[0]?.at);
  if (begun != null && order.length) timeline.push({ at: begun, phase: order[0] });
  for (const event of history) {
    const at = timestamp(event.at);
    if (at == null || !order.includes(event.phase) || BOOKKEEPING_EVENTS.has(event.event)) continue;
    const phase = COMPLETION_EVENTS.has(event.event) ? order[order.indexOf(event.phase) + 1] ?? null
      : event.event === 'phase_rejected' ? (order.includes(rejectionTarget(event.detail)) ? rejectionTarget(event.detail) : event.phase)
        : event.phase;
    timeline.push({ at, phase });
  }
  return (value) => {
    const at = timestamp(value);
    return at == null ? null : timeline.findLast((entry) => entry.at <= at)?.phase ?? null;
  };
}

/** Which phase each Copilot Chat request was made in (see phaseAtTime). */
function copilotChatByPhase(phaseAt, requests) {
  const phases = new Map();
  for (const request of requests ?? []) {
    const phase = phaseAt(request.at);
    if (!phase) continue;
    const entry = phases.get(phase) ?? {
      requests: 0, failedRequests: 0, modelCalls: 0, inputTokens: null, outputTokens: null,
      cachedInputTokens: null, cacheWriteInputTokens: null, nanoAiu: null, models: new Map()
    };
    entry.requests += 1;
    entry.failedRequests += request.failed ? 1 : 0;
    entry.modelCalls += request.modelCalls ?? 0;
    for (const field of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'nanoAiu']) {
      if (Number.isFinite(request[field])) entry[field] = (entry[field] ?? 0) + request[field];
    }
    const model = request.model ?? 'unknown';
    entry.models.set(model, (entry.models.get(model) ?? 0) + 1);
    phases.set(phase, entry);
  }
  return new Map([...phases].map(([phase, entry]) => [phase, {
    ...entry, models: undefined,
    requestsByModel: [...entry.models].map(([model, count]) => ({ model, requests: count }))
  }]));
}

const SESSION_FIELDS = Object.freeze([['inputTokens', 'inputTokens'], ['cacheReadTokens', 'cachedInputTokens'],
  ['cacheWriteTokens', 'cacheWriteInputTokens'], ['outputTokens', 'outputTokens']]);

const TALLY_COUNTS = Object.freeze(['modelCalls', 'requests', 'premiumRequests', 'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens',
  'outputTokens', 'intervals', 'activity', 'turns', 'toolCalls', 'failedToolCalls', 'subagents', 'autoPicks', 'autoFallbacks']);
const TALLY_CLASSES = Object.freeze(['toolFailures', 'modelChanges', 'errors']);
const SESSION_EVENT_LIMIT = 20;

/** Model calls and activity from Copilot's session logs, added up: per phase, per model and for the Story. */
function sessionTally() {
  return { ...Object.fromEntries(TALLY_COUNTS.map((field) => [field, 0])), ...Object.fromEntries(TALLY_CLASSES.map((field) => [field, {}])),
    nanoAiu: null, sessions: new Set(), models: new Map(), notable: new Map() };
}

const modelTally = (tally, model) => {
  const key = model ?? 'unknown';
  if (!tally.models.has(key)) tally.models.set(key, sessionTally());
  return tally.models.get(key);
};

/** One quota or model event, grouped like the ones Copilot's spans give (see copilotEventLine). */
function noteSessionEvent(tally, at, kind, { operation = 'invoke_agent', requestedModel = null, resolvedModel = null, errorType = null } = {}) {
  const key = JSON.stringify([kind, requestedModel, resolvedModel, errorType]);
  const event = tally.notable.get(key) ?? { generation: null, source: 'copilot-session-logs', kind, operation, requestedModel, resolvedModel,
    errorType, count: 0, firstAt: null, lastAt: null };
  event.count += 1;
  if (at && (!event.firstAt || at < event.firstAt)) event.firstAt = at;
  if (at && (!event.lastAt || at > event.lastAt)) event.lastAt = at;
  tally.notable.set(key, event);
}

function addSessionCall(tally, call, { byModel = true } = {}) {
  // An interval from an older Copilot carries only premium requests and AIU, never a call or tokens.
  if (call.kind === 'checkpoint') tally.intervals += 1;
  else {
    tally.modelCalls += 1;
    tally.requests += call.initiator === 'user' ? 1 : 0;
    for (const [from, to] of SESSION_FIELDS) if (Number.isFinite(call[from])) tally[to] += call[from];
  }
  if (Number.isFinite(call.premiumRequests)) tally.premiumRequests += call.premiumRequests;
  if (Number.isFinite(call.nanoAiu)) tally.nanoAiu = (tally.nanoAiu ?? 0) + call.nanoAiu;
  if (call.session) tally.sessions.add(call.session);
  if (!byModel) return;
  if (call.resolvedModel) noteSessionEvent(tally, call.at, 'model-substituted', { operation: 'chat', requestedModel: call.model, resolvedModel: call.resolvedModel });
  addSessionCall(modelTally(tally, call.model), call, { byModel: false });
}

const bump = (counts, key) => { counts[key] = (counts[key] ?? 0) + 1; };

/**
 * One activity record from Copilot's session logs (src/copilot-session-usage.mjs activityRecord).
 * Quota and model events are what Copilot's spans call them: a request refused over quota or rate
 * limited, or failed; a model call answered by another model; and, only the logs can say, Auto
 * falling back from its pick and Copilot changing the model on its own. A person's or VS Code's
 * model change and Auto's ordinary picks are counted beside them, not as events. [owner, 2026-11-13]
 */
function addSessionEvent(tally, event, { byModel = true } = {}) {
  tally.activity += 1;
  if (event.session) tally.sessions.add(event.session);
  const perModel = byModel && ['tool', 'subagent', 'auto-pick'].includes(event.kind) ? modelTally(tally, event.model) : null;
  if (event.kind === 'turn') tally.turns += 1;
  else if (event.kind === 'tool') {
    tally.toolCalls += 1;
    if (event.failure) { tally.failedToolCalls += 1; bump(tally.toolFailures, event.failure); }
  } else if (event.kind === 'subagent') tally.subagents += 1;
  else if (event.kind === 'auto-pick') {
    tally.autoPicks += 1;
    if (event.fallback) {
      tally.autoFallbacks += 1;
      if (byModel) noteSessionEvent(tally, event.at, 'auto-fallback', { resolvedModel: event.model ?? null });
    }
  } else if (event.kind === 'model-change') {
    bump(tally.modelChanges, event.source ?? 'other');
    if (byModel && event.source === 'automatic') noteSessionEvent(tally, event.at, 'model-switched', { requestedModel: event.from ?? null, resolvedModel: event.model ?? null });
  } else if (event.kind === 'error') {
    const errorType = event.error ?? 'other';
    bump(tally.errors, errorType);
    const kind = errorType === 'quota' ? 'quota-exceeded' : errorType === 'rate_limit' ? 'rate-limited' : 'failed';
    if (byModel) noteSessionEvent(tally, event.at, kind, { errorType });
  }
  if (perModel) addSessionEvent(perModel, event, { byModel: false });
}

/** The quota and model events a tally holds, oldest first, and how many groups were left out. */
function sessionEvents(tally) {
  const ordered = [...tally.notable.values()].sort((left, right) => String(left.firstAt ?? '').localeCompare(String(right.firstAt ?? ''))
    || left.kind.localeCompare(right.kind) || right.count - left.count);
  return { events: ordered.slice(0, SESSION_EVENT_LIMIT), omitted: Math.max(0, ordered.length - SESSION_EVENT_LIMIT),
    count: ordered.reduce((sum, event) => sum + event.count, 0) };
}

const sumOf = (counts) => Object.values(counts).reduce((sum, value) => sum + value, 0);
/** Where the logs hold model calls (or an older Copilot's intervals) for a phase: its usage source. */
const usageTally = (tally) => (tally && (tally.modelCalls || tally.intervals) ? tally : null);
/** Where the logs hold turns, tool calls or other activity for a phase: its activity source. */
const activityTally = (tally) => (tally?.activity ? tally : null);

const percent = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : null);

/** A tally's usage: Copilot's own counts, with the cache-hit share of input tokens. */
function usageCounts(tally) {
  return {
    modelCalls: tally.modelCalls,
    requests: tally.requests,
    premiumRequests: Math.round(tally.premiumRequests * 100) / 100,
    inputTokens: tally.inputTokens,
    cachedInputTokens: tally.cachedInputTokens,
    uncachedInputTokens: Math.max(0, tally.inputTokens - tally.cachedInputTokens),
    cacheWriteInputTokens: tally.cacheWriteInputTokens,
    outputTokens: tally.outputTokens,
    // Copilot counts cache reads and writes inside the input tokens.
    cacheHitShare: percent(tally.cachedInputTokens, tally.inputTokens),
    aiu: aiuMetric(tally.nanoAiu).value
  };
}

/**
 * What a tally reports: the usage, the activity (agent turns, tool calls with failures by Copilot's
 * code, sub-agents, model changes by who made them, Auto's picks, errors by class, and the quota and
 * model events among them), and per model the usage with the activity that names a model.
 */
function sessionUsage(tally) {
  return {
    ...usageCounts(tally),
    sessions: tally.sessions.size,
    intervalsWithoutCalls: tally.intervals,
    turns: tally.turns,
    toolCalls: tally.toolCalls,
    failedToolCalls: tally.failedToolCalls,
    toolFailures: { ...tally.toolFailures },
    subagents: tally.subagents,
    modelChanges: sumOf(tally.modelChanges),
    modelChangesBySource: { ...tally.modelChanges },
    autoPicks: tally.autoPicks,
    autoFallbacks: tally.autoFallbacks,
    errors: { ...tally.errors },
    quotaAndModelEvents: sessionEvents(tally).count,
    byModel: [...tally.models].map(([model, entry]) => ({ model, ...usageCounts(entry), toolCalls: entry.toolCalls,
      failedToolCalls: entry.failedToolCalls, subagents: entry.subagents, autoPicks: entry.autoPicks }))
      .sort((left, right) => right.premiumRequests - left.premiumRequests || right.modelCalls - left.modelCalls
        || right.toolCalls - left.toolCalls || left.model.localeCompare(right.model))
  };
}

/**
 * Which phase each model call and activity record in Copilot's session logs was made in, by its
 * time, and the calls outside the Story.
 */
function copilotSessionsByPhase(phaseAt, calls, events) {
  const phases = new Map();
  const tallyAt = (at) => {
    const phase = phaseAt(at);
    if (phase && !phases.has(phase)) phases.set(phase, sessionTally());
    return phase ? phases.get(phase) : null;
  };
  let outside = 0;
  for (const call of calls ?? []) {
    const tally = tallyAt(call.at);
    if (tally) addSessionCall(tally, call); else outside += 1;
  }
  for (const event of events ?? []) {
    const tally = tallyAt(event.at);
    if (tally) addSessionEvent(tally, event);
  }
  return { phases, outside };
}

/**
 * What Copilot's session logs on this computer say about the Story, or why they say nothing. Null
 * when the caller did not read them (a work command never does).
 */
function copilotSessionsSummary(copilotSessions, sessionsByPhase) {
  if (!copilotSessions) return null;
  const story = sessionTally();
  const entries = [...sessionsByPhase.phases];
  for (const [, tally] of entries) mergeTally(story, tally);
  const found = entries.length > 0;
  const reason = found ? null
    : copilotSessions.read === false ? copilotSessions.reason ?? 'not-read'
      : !copilotSessions.repositorySessions ? 'no-repository-session'
        : !(copilotSessions.calls ?? []).length && !(copilotSessions.events ?? []).length ? 'no-branch-session' : 'outside-story';
  const summary = {
    source: 'copilot-session-logs',
    found,
    reason,
    explanation: null,
    branch: copilotSessions.branch ?? null,
    syncedAt: copilotSessions.syncedAt ?? null,
    since: copilotSessions.since ?? null,
    pendingSessions: copilotSessions.pending ?? 0,
    // Where the logs are the only source of requests, model calls, premium requests and AIU, and
    // where of turns, tool calls and quota and model events (see phaseCopilot).
    coveredPhases: entries.filter(([, tally]) => usageTally(tally)).map(([id]) => id),
    activityPhases: entries.filter(([, tally]) => activityTally(tally)).map(([id]) => id),
    callsOutsideStory: sessionsByPhase.outside,
    ...(found ? sessionUsage(story) : {})
  };
  // One sentence for every surface that shows why the logs hold nothing for the Story.
  summary.explanation = found ? null : `Copilot's session logs: ${sessionsReason(summary)}${summary.pendingSessions
    ? ` ${summary.pendingSessions} session${summary.pendingSessions === 1 ? ' is' : 's are'} still being read; the next report adds what ${summary.pendingSessions === 1 ? 'it holds' : 'they hold'}.` : ''}`;
  return summary;
}

function mergeTally(into, from) {
  for (const field of TALLY_COUNTS) into[field] += from[field];
  for (const field of TALLY_CLASSES) for (const [key, value] of Object.entries(from[field])) into[field][key] = (into[field][key] ?? 0) + value;
  if (from.nanoAiu != null) into.nanoAiu = (into.nanoAiu ?? 0) + from.nanoAiu;
  for (const session of from.sessions) into.sessions.add(session);
  for (const [model, entry] of from.models) mergeTally(modelTally(into, model), entry);
  for (const [key, event] of from.notable) {
    const known = into.notable.get(key);
    if (!known) { into.notable.set(key, { ...event }); continue; }
    known.count += event.count;
    if (event.firstAt && (!known.firstAt || event.firstAt < known.firstAt)) known.firstAt = event.firstAt;
    if (event.lastAt && (!known.lastAt || event.lastAt > known.lastAt)) known.lastAt = event.lastAt;
  }
}

/**
 * What this computer counted of Copilot Chat for the Story: whether it counts at all, since when, and
 * the share of input tokens read from Copilot's cache (where both counts were reported).
 */
function copilotChatSummary(copilotChat, phases) {
  if (!copilotChat?.since) return { counted: false, since: null, syncedAt: null, requests: 0, cachedShare: null };
  const chats = phases.map((phase) => phase.copilot.chat).filter(Boolean);
  const input = chats.reduce((sum, chat) => sum + (chat.inputTokens ?? 0), 0);
  const cached = chats.reduce((sum, chat) => sum + (chat.cachedInputTokens ?? 0), 0);
  return {
    counted: true,
    since: copilotChat.since,
    syncedAt: copilotChat.syncedAt ?? null,
    requests: chats.reduce((sum, chat) => sum + chat.requests, 0),
    cachedShare: input && chats.some((chat) => chat.cachedInputTokens != null) ? Math.round((cached / input) * 100) : null
  };
}

/** A count with Copilot Chat's share added: what Copilot Chat recorded is observed, never estimated. */
function withChatCount(metric, chat, field) {
  if (!chat?.requests) return metric;
  const value = chat[field] ?? 0;
  if (metric.status === 'none' || metric.value == null) return { value, status: 'observed' };
  return { value: metric.value + value, status: metric.status };
}

/** Copilot's billed usage in AI units, from the nano-AIU it reports per model call. */
function aiuMetric(nanoAiu) {
  return nanoAiu == null ? { value: null, status: 'none' } : { value: Math.round(nanoAiu / 1e7) / 100, status: 'observed' };
}

/** Older Copilot versions recorded intervals without calls: a count beside one is partial. */
function sessionCount(tally, value) {
  return { value, status: tally.intervals ? 'partial' : 'observed' };
}

/**
 * Where Copilot's session logs hold model calls for a phase, they are its source for requests, model
 * calls, premium requests and AIU, and neither OpenTelemetry feed adds to them: a session started
 * through `singularity-flow copilot`, and VS Code's Copilot agent, write both, so adding them would
 * count the same requests twice. [owner, 2026-11-13] The same holds for activity: where the logs
 * hold turns or tool calls for a phase, they are its only source of turns, tool calls, failed
 * requests and quota and model events. Failed model calls (the logs keep none) and the prompt size
 * (SFlow's composition) still come from the spans.
 */
function phaseCopilot(phase, premiumMultipliers, chat = null, sessions = null) {
  const logUsage = usageTally(sessions);
  const activity = activityTally(sessions);
  if (logUsage) chat = null;
  const logEvents = activity ? sessionEvents(activity) : null;
  const observed = (value) => ({ value, status: 'observed' });
  const generations = (phase.telemetry ?? [])
    .filter((entry) => entry.status !== 'not-invoked')
    .toSorted((left, right) => left.generation - right.generation);
  const usage = phase.usage ?? [];
  const metric = (field) => countMetric(generations.map((entry) => {
    const value = entry.activity?.[field];
    // Turns can cover only some of a generation's requests; the sum is then a partial count.
    if (field === 'turns' && Number.isFinite(value)) {
      return { value, partial: Number.isSafeInteger(entry.activity.turnsCounted) && entry.activity.turnsCounted < (entry.activity.requests ?? 0) };
    }
    if (Number.isFinite(value)) return value;
    if (field !== 'modelCalls') return null;
    const spans = usage.filter((record) => record.generation === entry.generation).map((record) => record.spans);
    return spans.length && spans.every(Number.isSafeInteger) && spans.some((count) => count > 0)
      ? spans.reduce((sum, count) => sum + count, 0) : null;
  }));
  // With Copilot Chat counted, a generation that has no session activity was worked in Copilot Chat:
  // its requests are already in Copilot Chat's count, so it does not make the estimate partial.
  const premiumRequests = combinePremium([
    ...generations.filter((entry) => !chat?.requests || entry.activity).map((entry) => (entry.activity?.requestsByModel?.length
      ? estimatePremiumRequests(entry.activity.requestsByModel, premiumMultipliers)
      : { value: null, status: 'unavailable', missingModels: [] })),
    ...(chat?.requests ? [estimatePremiumRequests(chat.requestsByModel, premiumMultipliers)] : [])
  ]);
  const prompts = generations.filter((entry) => entry.prompt?.bytes != null);
  const latest = prompts.at(-1) ?? null;
  const limits = (latest?.activity?.promptLimits ?? []).map((entry) => entry.maxPromptTokens).filter(Number.isSafeInteger);
  const limitTokens = limits.length ? Math.min(...limits) : null;
  return {
    status: chat?.requests || sessions ? 'observed'
      : !generations.length ? 'none'
        : generations.every((entry) => entry.activity) ? 'observed'
          : generations.some((entry) => entry.activity) ? 'partial' : 'unavailable',
    generations: generations.length,
    capturedGenerations: generations.filter((entry) => entry.activity).length,
    uncaptured: chat?.requests || sessions ? {} : generations.filter((entry) => !entry.activity).reduce((counts, entry) => {
      const reason = uncapturedReason(entry);
      return { ...counts, [reason]: (counts[reason] ?? 0) + 1 };
    }, {}),
    requests: logUsage ? sessionCount(logUsage, logUsage.requests) : withChatCount(metric('requests'), chat, 'requests'),
    turns: activity ? observed(activity.turns) : metric('turns'),
    // Whether any generation counted turns from model calls rather than Copilot's own turn count.
    turnsDerived: !activity && generations.some((entry) => entry.activity?.turnsAssurance === 'derived-from-model-calls'),
    modelCalls: logUsage ? sessionCount(logUsage, logUsage.modelCalls) : withChatCount(metric('modelCalls'), chat, 'modelCalls'),
    toolCalls: activity ? observed(activity.toolCalls) : metric('toolCalls'),
    failedRequests: activity ? observed(sumOf(activity.errors)) : withChatCount(metric('failedRequests'), chat, 'failedRequests'),
    failedModelCalls: metric('failedModelCalls'),
    failedToolCalls: activity ? observed(activity.failedToolCalls) : metric('failedToolCalls'),
    premiumRequests: logUsage ? { value: Math.round(logUsage.premiumRequests * 100) / 100, status: 'observed', missingModels: [] } : premiumRequests,
    billedAiu: aiuMetric(logUsage ? logUsage.nanoAiu : chat?.nanoAiu ?? null),
    chat: chat?.requests ? {
      requests: chat.requests, modelCalls: chat.modelCalls, inputTokens: chat.inputTokens,
      outputTokens: chat.outputTokens, cachedInputTokens: chat.cachedInputTokens,
      cacheWriteInputTokens: chat.cacheWriteInputTokens
    } : null,
    sessions: sessions ? sessionUsage(sessions) : null,
    // Whether the turns, tool calls and quota and model events come from Copilot's session logs.
    sessionActivity: Boolean(activity),
    events: logEvents ? logEvents.events : generations.flatMap((entry) => (entry.activity?.events ?? [])
      .map((event) => ({ generation: entry.generation, ...event }))),
    // Occurrences, not groups: two substituted calls are two events listed on one line.
    eventCount: logEvents ? logEvents.count : generations.reduce((sum, entry) => sum + (entry.activity?.events ?? [])
      .reduce((count, event) => count + event.count, 0), 0),
    omittedEvents: logEvents ? logEvents.omitted : generations.reduce((sum, entry) => sum + (entry.activity?.omittedEvents ?? 0), 0),
    prompt: latest ? {
      generation: latest.generation,
      bytes: latest.prompt.bytes,
      estimatedTokens: latest.prompt.estimatedTokens,
      maximumBytes: latest.prompt.maximumBytes ?? null,
      maximumEstimatedTokens: latest.prompt.maximumEstimatedTokens ?? null,
      budgetMode: latest.prompt.budgetMode ?? null,
      originalBytes: latest.prompt.originalBytes ?? null,
      omittedSections: latest.prompt.omittedSections ?? 0,
      overBudget: latest.prompt.maximumBytes != null && latest.prompt.bytes > latest.prompt.maximumBytes,
      largestBytes: Math.max(...prompts.map((entry) => entry.prompt.bytes)),
      limitTokens,
      limitShare: limitTokens ? Math.round((latest.prompt.estimatedTokens / limitTokens) * 100) : null
    } : null
  };
}

/** `CR-001 returned to design: ...` → `design`; older or custom details name no target. */
function rejectionTarget(detail) {
  return /\breturned to ([A-Za-z0-9_.-]+):/.exec(String(detail ?? ''))?.[1] ?? null;
}

/**
 * `copilotChat` is this computer's Copilot Chat requests for the Story's branch, and
 * `copilotSessions` the model calls Copilot's session logs hold for it
 * (src/copilot-session-usage.mjs). Both are read by the caller; a work command passes neither.
 */
export function deriveReport(workflow, {
  pricing = null, premiumMultipliers = null, now = nowIso(), copilotChat = null, copilotSessions = null
} = {}) {
  const reportTime = timestamp(now);
  const history = [...(workflow.history ?? [])].sort(compareEvents);
  const phaseAt = phaseAtTime(workflow, history);
  const chatByPhase = copilotChatByPhase(phaseAt, copilotChat?.requests);
  const sessionsByPhase = copilotSessionsByPhase(phaseAt, copilotSessions?.calls, copilotSessions?.events);
  const phases = workflow.phaseOrder.map((id) => {
    const phase = workflow.phases[id];
    const events = phaseEvents(history, id);
    const measuredWait = waitingTime(events, reportTime);
    // Only the disposition of the phase's current completion counts: a waiver an earlier round
    // recorded does not describe a phase people approved since, or one still in progress.
    const disposition = automaticApprovalDisposition(phase);
    // A deterministic policy waiver is not a human review queue. Older event streams may contain
    // a submission immediately before the waiver, so make the reporting distinction explicit
    // instead of allowing that interval to inflate approval latency.
    const wait = disposition === 'policy_waived'
      ? { waitingMs: 0, cycles: [], openSubmission: null }
      : measuredWait;
    const window = phaseWindow(phase, events, reportTime);
    const activeMs = window.elapsedMs != null ? Math.max(0, window.elapsedMs - wait.waitingMs) : null;
    const usage = phase.usage ?? [];
    const exactRecords = usage.filter((record) => record.status === 'exact');
    const tokens = exactRecords.reduce((sum, record) => sum + (record.totalTokens ?? 0), 0);
    const costs = exactRecords.map((record) => usageCost(record, pricing)).filter((value) => value != null);
    const pricedRecords = costs.length;
    const fullyPricedRecords = costs.filter((item) => item.complete).length;
    const rejections = events
      .filter((event) => event.event === 'phase_rejected')
      .map((event) => ({
        at: event.at, actor: actorLabel(event.actor), agent: event.agent, detail: event.detail ?? '',
        returnedTo: rejectionTarget(event.detail)
      }));
    // Sent back here by a later phase's reviewer: each one is another iteration of this phase.
    const sentBack = history.filter((event) => event.event === 'phase_rejected' && event.phase !== id
      && rejectionTarget(event.detail) === id).length;
    const selfApprovals = (phase.approvals ?? []).filter((item) => item.selfApproval && !item.invalidatedAt).length;
    const checks = (phase.checks ?? []).map((check) => {
      const startedAt = timestamp(check.startedAt);
      const completedAt = timestamp(check.completedAt);
      return {
        command: check.command,
        status: check.status,
        durationMs: startedAt != null && completedAt != null && completedAt >= startedAt ? completedAt - startedAt : null
      };
    });
    return {
      id,
      label: phase.label,
      status: phase.status,
      approvalDisposition: disposition
        ?? ((phase.approvals ?? []).some((item) => !item.invalidatedAt && item.decision === 'approved') ? 'human_approved' : null),
      generations: phase.generation ?? 0,
      sentBack,
      elapsedMs: window.elapsedMs,
      activeMs,
      flowTimeExcludingApprovalWaitMs: activeMs,
      waitingMs: wait.waitingMs || (window.elapsedMs != null ? 0 : null),
      openSubmission: wait.openSubmission,
      approvals: (phase.approvals ?? []).filter((item) => !item.invalidatedAt && item.decision === 'approved').length,
      selfApprovals,
      rejections,
      usageRecords: usage.length,
      pendingTelemetry: (phase.telemetry ?? []).filter((item) => item.status === 'pending').length,
      tokens,
      tokenStatus: tokenStatus(usage, exactRecords),
      models: [...new Set(usage.map((record) => record.model).filter(Boolean))],
      modelUsage: usageByModel(usage, pricing),
      agents: [...new Set(usage.map((record) => record.agent).filter(Boolean))],
      cost: costs.length ? costs.reduce((sum, item) => sum + item.value, 0) : null,
      costStatus: !pricedRecords ? 'unavailable' : fullyPricedRecords === usage.length ? 'exact' : 'partial',
      checks,
      cycles: wait.cycles,
      copilot: phaseCopilot(phase, premiumMultipliers, chatByPhase.get(id) ?? null, sessionsByPhase.phases.get(id) ?? null)
    };
  });

  const startCandidates = [timestamp(history[0]?.at), ...workflow.phaseOrder.map((id) => timestamp(workflow.phases[id].startedAt))].filter((value) => value != null);
  const startedAt = startCandidates.length ? Math.min(...startCandidates) : null;
  const approvalTimes = workflow.phaseOrder.map((id) => timestamp(workflow.phases[id].approvedAt)).filter((value) => value != null);
  const completedAt = workflow.status === 'closed' && approvalTimes.length
    ? Math.max(...approvalTimes)
    : workflow.status === 'cancelled'
      ? timestamp(workflow.cancellation?.cancelledAt)
      : null;
  const effectiveEnd = completedAt ?? reportTime;
  const elapsedMs = startedAt != null && effectiveEnd != null && effectiveEnd >= startedAt ? effectiveEnd - startedAt : null;
  const waitingMs = phases.reduce((sum, phase) => sum + (phase.waitingMs ?? 0), 0);
  const costValues = phases.map((phase) => phase.cost).filter((value) => value != null);
  const costPhases = phases.filter((phase) => phase.usageRecords > 0);
  const allUsage = workflow.phaseOrder.flatMap((id) => workflow.phases[id].usage ?? []);
  const modelUsage = usageByModel(allUsage, pricing);
  const pricedRecords = modelUsage.reduce((sum, item) => sum + item.pricedRecords, 0);
  const fullyPricedRecords = modelUsage.reduce((sum, item) => sum + item.fullyPricedRecords, 0);
  const prompted = phases.filter((phase) => phase.copilot.prompt);
  const largestPrompt = prompted.toSorted((left, right) => right.copilot.prompt.bytes - left.copilot.prompt.bytes)[0] ?? null;
  const copilotStatuses = phases.map((phase) => phase.copilot.status).filter((status) => status !== 'none');
  const uncaptured = phases.reduce((counts, phase) => {
    for (const [reason, count] of Object.entries(phase.copilot.uncaptured)) counts[reason] = (counts[reason] ?? 0) + count;
    return counts;
  }, {});
  // Each phase's billed usage from the one source that counts it there (see phaseCopilot).
  const billedNanoAiu = workflow.phaseOrder.map((id) => (usageTally(sessionsByPhase.phases.get(id)) ?? chatByPhase.get(id))?.nanoAiu ?? null);
  const copilot = {
    status: !copilotStatuses.length ? 'none'
      : copilotStatuses.every((status) => status === 'observed') ? 'observed'
        : copilotStatuses.every((status) => status === 'unavailable') ? 'unavailable' : 'partial',
    ...Object.fromEntries(['requests', 'turns', 'modelCalls', 'toolCalls', 'failedRequests', 'failedModelCalls', 'failedToolCalls']
      .map((field) => [field, combineMetrics(phases.map((phase) => phase.copilot[field]))])),
    turnsDerived: phases.some((phase) => phase.copilot.turnsDerived),
    premiumRequests: combinePremium(phases.map((phase) => phase.copilot.premiumRequests)),
    premiumMultipliersConfigured: Boolean(premiumMultipliers && Object.keys(premiumMultipliers).length),
    billedAiu: aiuMetric(billedNanoAiu.some((value) => value != null) ? billedNanoAiu.reduce((sum, value) => sum + (value ?? 0), 0) : null),
    chat: copilotChatSummary(copilotChat, phases),
    sessions: copilotSessionsSummary(copilotSessions, sessionsByPhase),
    events: phases.flatMap((phase) => phase.copilot.events.map((event) => ({ phase: phase.id, ...event }))),
    // Quota and model events come from Copilot's session logs and metered sessions; Copilot Chat's counts carry none.
    eventsObserved: phases.some((phase) => phase.copilot.capturedGenerations > 0 || phase.copilot.sessionActivity),
    eventCount: phases.reduce((sum, phase) => sum + phase.copilot.eventCount, 0),
    omittedEvents: phases.reduce((sum, phase) => sum + phase.copilot.omittedEvents, 0),
    largestPrompt: largestPrompt ? {
      phase: largestPrompt.id,
      bytes: largestPrompt.copilot.prompt.bytes,
      estimatedTokens: largestPrompt.copilot.prompt.estimatedTokens
    } : null,
    promptsOverBudget: prompted.filter((phase) => phase.copilot.prompt.overBudget).map((phase) => phase.id),
    uncaptured,
    captureNotes: copilotCaptureNotes(uncaptured, { chatCounted: Boolean(copilotChat?.since), sessionsRead: Boolean(copilotSessions?.read) })
  };
  const bottleneck = phases
    .filter((phase) => phase.waitingMs != null && phase.waitingMs > 0)
    .sort((left, right) => right.waitingMs - left.waitingMs)[0] ?? null;

  return {
    schemaVersion: 1,
    generatedAt: now,
    workItem: {
      id: workflow.workItem.id,
      title: workflow.workItem.title ?? null,
      workType: workflow.workItem.workType ?? null,
      branch: workflow.workItem.branch ?? null,
      status: workflow.status
    },
    startedAt: startedAt != null ? new Date(startedAt).toISOString() : null,
    completedAt: completedAt != null ? new Date(completedAt).toISOString() : null,
    elapsedMs,
    waitingMs,
    activeMs: elapsedMs != null ? Math.max(0, elapsedMs - waitingMs) : null,
    flowTimeExcludingApprovalWaitMs: elapsedMs != null ? Math.max(0, elapsedMs - waitingMs) : null,
    reworkCycles: phases.reduce((sum, phase) => sum + Math.max(0, phase.generations - 1), 0),
    sentBack: phases.reduce((sum, phase) => sum + phase.sentBack, 0),
    rejections: phases.flatMap((phase) => phase.rejections.map((item) => ({ phase: phase.id, ...item }))),
    selfApprovals: phases.reduce((sum, phase) => sum + phase.selfApprovals, 0),
    sequenceOverrides: workflow.sequenceOverrides ?? [],
    tokens: {
      total: phases.reduce((sum, phase) => sum + phase.tokens, 0),
      exactRecords: workflow.usage?.exactRecords ?? null,
      unavailableRecords: workflow.usage?.unavailableRecords ?? null,
      byAgent: workflow.usage?.byAgent ?? {},
      byPhase: workflow.usage?.byPhase ?? {},
      byModel: modelUsage
    },
    cost: costValues.length ? costValues.reduce((sum, value) => sum + value, 0) : null,
    costStatus: costPhases.some((phase) => phase.costStatus === 'partial') || (costValues.length && costPhases.some((phase) => phase.costStatus === 'unavailable')) ? 'partial' : costValues.length ? 'exact' : 'unavailable',
    costCoverage: {
      usageRecords: allUsage.length,
      exactUsageRecords: allUsage.filter((record) => record.status === 'exact').length,
      pendingRecords: phases.reduce((sum, phase) => sum + phase.pendingTelemetry, 0),
      pricedRecords,
      fullyPricedRecords,
      providerCostRecords: modelUsage.reduce((sum, item) => sum + item.providerCostRecords, 0),
      configuredPriceRecords: modelUsage.reduce((sum, item) => sum + item.configuredPriceRecords, 0),
      missingModels: modelUsage.filter((item) => item.costStatus !== 'exact').map((item) => `${item.provider}/${item.model}`)
    },
    copilot,
    bottleneck: bottleneck ? {
      phase: bottleneck.id,
      waitingMs: bottleneck.waitingMs,
      share: elapsedMs ? Math.round((bottleneck.waitingMs / elapsedMs) * 100) : null
    } : null,
    phases
  };
}

function money(value) {
  return value == null ? '—' : `$${value.toFixed(2)}`;
}

function tokenCell(phase) {
  if (phase.tokenStatus === 'none') return '—';
  if (phase.tokenStatus === 'unavailable') return 'unavailable';
  return `${phase.tokens.toLocaleString('en-US')}${phase.tokenStatus === 'partial' ? '*' : ''}`;
}

function modelCell(phase) {
  if (!phase.modelUsage.length) return '—';
  return phase.modelUsage.map(({ provider, model }) => `${provider}/${model}`).join(', ');
}

function costCell(phase) {
  if (phase.cost == null) return '—';
  return `${money(phase.cost)}${phase.costStatus === 'partial' ? '*' : ''}`;
}

function approvalDispositionLabel(phase) {
  return ({
    human_approved: 'human approved',
    policy_waived: 'policy waived',
    not_required: 'not required'
  })[phase.approvalDisposition] ?? '—';
}

/** The headline token figure: exact where the provider reported any, and said plainly when none did. */
function tokenSummary(report) {
  const cost = report.cost != null ? ` (~${money(report.cost)}${report.costStatus === 'partial' ? ', partial pricing' : ''})` : '';
  if (!report.costCoverage.exactUsageRecords && report.costCoverage.usageRecords) return `tokens unavailable (the provider did not report them)${cost}`;
  return `${report.tokens.total.toLocaleString('en-US')} exact tokens${cost}`;
}

/** An aggregate's tokens, or `unavailable` when none of its records were exact. */
function aggregateTokens(aggregate) {
  return aggregate.exactRecords ? aggregate.totalTokens.toLocaleString('en-US') : 'unavailable';
}

function countCell(metric) {
  if (!metric || metric.status === 'none') return '—';
  if (metric.value == null) return 'unavailable';
  return `${metric.value.toLocaleString('en-US')}${metric.status === 'partial' ? '*' : ''}`;
}

function premiumValue(value) {
  return Number.isInteger(value) ? value.toLocaleString('en-US') : value.toFixed(2);
}

function premiumCell(premium) {
  if (!premium || premium.status === 'none') return '—';
  if (premium.value == null) return 'unavailable';
  // Copilot's own count from its session logs is not an estimate.
  return `${premium.status === 'observed' ? '' : '~'}${premiumValue(premium.value)}${premium.status === 'partial' ? '*' : ''}`;
}

function sizeLabel(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function promptCell(prompt) {
  if (!prompt) return '—';
  const notes = [];
  if (prompt.overBudget) notes.push(`over its ${sizeLabel(prompt.maximumBytes)} budget`);
  else if (prompt.omittedSections) notes.push(`${prompt.omittedSections} section${prompt.omittedSections === 1 ? '' : 's'} left out to fit`);
  if (prompt.limitShare != null) notes.push(`${prompt.limitShare}% of the model's prompt limit`);
  return `${sizeLabel(prompt.bytes)} (~${prompt.estimatedTokens.toLocaleString('en-US')} tokens)${notes.length ? `, ${notes.join(', ')}` : ''}`;
}

function toolCell(phase) {
  const cell = countCell(phase.copilot.toolCalls);
  const failed = phase.copilot.failedToolCalls?.value;
  return failed ? `${cell} (${failed} failed)` : cell;
}

function aiuCell(metric) {
  return metric?.value == null ? '—' : metric.value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** Where this computer's Copilot Chat counts come from, or how to start counting them. */
function copilotChatLine(chat) {
  if (!chat?.counted) return null;
  const parts = [`Copilot Chat on this computer: ${chat.requests} request${chat.requests === 1 ? '' : 's'} for this Story, counted since ${chat.since}`];
  if (chat.cachedShare != null) parts.push(`${chat.cachedShare}% of their input tokens read from Copilot's cache`);
  return `${parts.join('; ')}. Other people's Copilot Chat use is not included.`;
}

function hasCopilotSection(report) {
  return Boolean(report.copilot) && (report.copilot.status !== 'none'
    || report.phases.some((phase) => phase.copilot?.prompt || phase.sentBack));
}

const tokenCount = (value) => (value == null ? '—' : value.toLocaleString('en-US'));
const shareCell = (value) => (value == null ? '—' : `${value}%`);

/** Why Copilot's session logs hold nothing for the Story, in plain words. */
function sessionsReason(sessions) {
  const branch = sessions.branch ? `branch \`${sessions.branch}\`` : 'this Story\'s branch';
  return ({
    'no-session-logs': 'Copilot has written no session logs on this computer: no Copilot CLI or VS Code Copilot agent session has run here.',
    'not-read': 'Copilot\'s session logs have not been read for this repository yet; `singularity-flow report` and `singularity-flow telemetry sessions sync` read them.',
    unreadable: 'Copilot\'s session logs could not be read on this computer; `singularity-flow telemetry sessions sync` shows what it found.',
    'no-repository-session': 'no Copilot session on this computer has worked in this repository.',
    'no-branch-session': `no Copilot session on this computer has worked on ${branch} in this repository.`,
    'outside-story': `Copilot made ${sessions.callsOutsideStory} model call${sessions.callsOutsideStory === 1 ? '' : 's'} on ${branch}, all before this Story began or after it finished.`
  })[sessions.reason] ?? 'Copilot\'s session logs hold nothing for this Story.';
}

const counted = (value, one, many = `${one}s`) => `${value.toLocaleString('en-US')} ${value === 1 ? one : many}`;

/** The headline of the session-log counts: premium requests, calls, cache hits, AIU, turns and tool calls. */
function sessionsTotals(sessions) {
  return [
    `${premiumValue(sessions.premiumRequests)} premium request${sessions.premiumRequests === 1 ? '' : 's'}`,
    `${sessions.requests.toLocaleString('en-US')} request${sessions.requests === 1 ? '' : 's'} you sent`,
    `${sessions.modelCalls.toLocaleString('en-US')} model call${sessions.modelCalls === 1 ? '' : 's'}`,
    `${tokenCount(sessions.inputTokens)} input tokens${sessions.cacheHitShare != null ? `, ${sessions.cacheHitShare}% read from Copilot's cache` : ''}`,
    ...(sessions.aiu != null ? [`${aiuCell({ value: sessions.aiu })} AIU`] : []),
    ...(sessions.activityPhases?.length ? [counted(sessions.turns, 'agent turn'),
      `${counted(sessions.toolCalls, 'tool call')}${sessions.failedToolCalls ? ` (${sessions.failedToolCalls.toLocaleString('en-US')} failed)` : ''}`,
      counted(sessions.quotaAndModelEvents, 'quota or model event')] : [])
  ].join(' · ');
}

const MODEL_CHANGE_SOURCES = Object.freeze({ person: 'by a person', host: 'by VS Code or at start-up', agent: 'by the agent', automatic: 'by Copilot on its own', other: 'for another reason' });

/** What the activity counts hold beyond the tables: failures by code, sub-agents, model changes, Auto. */
function sessionsActivityNote(sessions) {
  const parts = [];
  const failures = Object.entries(sessions.toolFailures ?? {}).map(([code, count]) => `${count.toLocaleString('en-US')} ${code}`);
  if (failures.length) parts.push(`tool calls that did not succeed, by Copilot's code: ${failures.join(', ')}`);
  if (sessions.subagents) parts.push(`${counted(sessions.subagents, 'sub-agent')} started`);
  const changes = Object.entries(sessions.modelChangesBySource ?? {}).map(([source, count]) => `${count.toLocaleString('en-US')} ${MODEL_CHANGE_SOURCES[source] ?? source}`);
  if (changes.length) parts.push(`the model changed ${counted(sessions.modelChanges, 'time')} (${changes.join(', ')})`);
  if (sessions.autoPicks) parts.push(`Auto picked a model ${counted(sessions.autoPicks, 'time')}${sessions.autoFallbacks ? `, falling back ${counted(sessions.autoFallbacks, 'time')}` : ''}`);
  const errors = Object.entries(sessions.errors ?? {}).map(([type, count]) => `${count.toLocaleString('en-US')} ${type}`);
  if (errors.length) parts.push(`errors Copilot recorded, by class: ${errors.join(', ')}`);
  return parts.length ? `${parts.join('; ')}.`.replace(/^./u, (first) => first.toUpperCase()) : null;
}

/** Notes beside the session-log counts: where they come from, and the rule that keeps them single. */
function sessionsNotes(report) {
  const sessions = report.copilot.sessions;
  const labels = (ids) => ids.map((id) => `\`${id}\``).join(', ');
  const activity = sessions.activityPhases ?? [];
  const same = activity.length === sessions.coveredPhases.length && activity.every((id) => sessions.coveredPhases.includes(id));
  const usageSources = 'requests, model calls, premium requests and AIU';
  const activitySources = 'turns, tool calls and quota and model events';
  const sources = same ? `in ${labels(activity)} these logs are the only source of requests, turns, model and tool calls, premium requests, AIU and quota and model events`
    : [sessions.coveredPhases.length ? `in ${labels(sessions.coveredPhases)} these logs are the only source of ${usageSources}` : null,
      activity.length ? `in ${labels(activity)} ${sessions.coveredPhases.length ? 'they are' : 'these logs are'} the only source of ${activitySources}` : null]
      .filter(Boolean).join(', and ');
  const notes = [
    `From Copilot's own session logs on this computer (Copilot CLI and VS Code's Copilot agent) for branch \`${sessions.branch}\`${sessions.syncedAt ? `, read ${sessions.syncedAt}` : ''}; other people's use is not included. Premium requests are the requests a person sent, as Copilot accounts them: calls the agent made on its own cost none. Cache hit is the share of input tokens Copilot read from its prompt cache; uncached input includes cache writes.`,
    `Never counted twice: ${sources}. Copilot's OpenTelemetry (sessions started with \`singularity-flow copilot\`, Copilot Chat in VS Code) counts only in phases the logs do not cover.`
  ];
  if (activity.length) notes.push(`An agent turn is one model round trip, a sub-agent's included. Quota and model events are the requests Copilot refused over quota or as rate limited, or that failed, calls another model answered, Auto falling back from its pick and Copilot changing the model on its own. How much of the premium allowance is left is not counted: only some Copilot versions write it, for the whole account.`);
  const activityNote = activity.length ? sessionsActivityNote(sessions) : null;
  if (activityNote) notes.push(activityNote);
  if (sessions.intervalsWithoutCalls) notes.push(`Older Copilot versions recorded only running totals for ${sessions.intervalsWithoutCalls} interval${sessions.intervalsWithoutCalls === 1 ? '' : 's'}: their premium requests and AIU are counted, without model calls or tokens.`);
  if (sessions.callsOutsideStory) notes.push(`${sessions.callsOutsideStory} model call${sessions.callsOutsideStory === 1 ? '' : 's'} on this branch fell before the Story began or after it finished, and ${sessions.callsOutsideStory === 1 ? 'is' : 'are'} not counted.`);
  if (sessions.pendingSessions) notes.push(`${sessions.pendingSessions} Copilot session${sessions.pendingSessions === 1 ? ' is' : 's are'} still being read; the next report adds what ${sessions.pendingSessions === 1 ? 'it holds' : 'they hold'}.`);
  return notes;
}

const SESSION_PHASE_COLUMNS = ['Premium requests', 'Requests', 'Model calls', 'Input tokens', 'Cached', 'Uncached', 'Cache writes', 'Output tokens', 'Cache hit', 'AIU'];
const SESSION_MODEL_COLUMNS = ['Premium requests', 'Requests', 'Model calls', 'Input tokens', 'Cached', 'Uncached', 'Output tokens', 'Cache hit', 'AIU',
  'Tool calls', 'Sub-agents', 'Auto picks'];

function sessionCells(usage, { cacheWrites = true } = {}) {
  if (!usage) return (cacheWrites ? SESSION_PHASE_COLUMNS : SESSION_MODEL_COLUMNS).map(() => '—');
  return [premiumValue(usage.premiumRequests), tokenCount(usage.requests), tokenCount(usage.modelCalls), tokenCount(usage.inputTokens),
    tokenCount(usage.cachedInputTokens), tokenCount(usage.uncachedInputTokens), ...(cacheWrites ? [tokenCount(usage.cacheWriteInputTokens)] : []),
    tokenCount(usage.outputTokens), shareCell(usage.cacheHitShare), usage.aiu == null ? '—' : aiuCell({ value: usage.aiu }),
    // Per model: the activity that names a model (a turn names none).
    ...(cacheWrites ? [] : [`${tokenCount(usage.toolCalls)}${usage.failedToolCalls ? ` (${usage.failedToolCalls} failed)` : ''}`, tokenCount(usage.subagents), tokenCount(usage.autoPicks)])];
}

function sessionsMarkdown(report) {
  const sessions = report.copilot?.sessions;
  if (!sessions) return [];
  const lines = ['## Copilot premium requests and cache use', ''];
  if (!sessions.found) return [...lines, `_${sessions.explanation}_`, ''];
  lines.push(sessionsTotals(sessions), '');
  lines.push(`| Phase | ${SESSION_PHASE_COLUMNS.join(' | ')} |`, `|${['Phase', ...SESSION_PHASE_COLUMNS].map(() => '---').join('|')}|`);
  for (const phase of report.phases) lines.push(`| ${phase.label} (\`${phase.id}\`) | ${sessionCells(phase.copilot.sessions).join(' | ')} |`);
  lines.push('', `| Model | ${SESSION_MODEL_COLUMNS.join(' | ')} |`, `|${['Model', ...SESSION_MODEL_COLUMNS].map(() => '---').join('|')}|`);
  for (const model of sessions.byModel) lines.push(`| ${model.model} | ${sessionCells(model, { cacheWrites: false }).join(' | ')} |`);
  lines.push('');
  for (const note of sessionsNotes(report)) lines.push(`_${note}_`, '');
  return lines;
}

function sessionsHtml(report) {
  const sessions = report.copilot?.sessions;
  if (!sessions) return '';
  if (!sessions.found) return `<h2>Copilot premium requests and cache use</h2>\n<p class="note">${codeSpans(escapeHtml(sessions.explanation))}</p>`;
  const head = (first, columns) => `<thead><tr><th>${first}</th>${columns.map((column) => `<th>${column}</th>`).join('')}</tr></thead>`;
  const row = (label, cells) => `<tr><td>${escapeHtml(label)}</td>${cells.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`;
  return `<h2>Copilot premium requests and cache use</h2>
<p>${escapeHtml(sessionsTotals(sessions))}</p>
<table>${head('Phase', SESSION_PHASE_COLUMNS)}<tbody>${report.phases.map((phase) => row(phase.label, sessionCells(phase.copilot.sessions))).join('')}</tbody></table>
<table>${head('Model', SESSION_MODEL_COLUMNS)}<tbody>${sessions.byModel.map((model) => row(model.model, sessionCells(model, { cacheWrites: false }))).join('')}</tbody></table>
${sessionsNotes(report).map((note) => `<p class="note">${codeSpans(escapeHtml(note))}</p>`).join('\n')}`;
}

/**
 * One sentence per quota, substitution or failure event, for both renderings. An event from
 * Copilot's session logs belongs to a phase, not to one generation.
 */
function copilotEventLine(event) {
  const where = `${event.phase}${event.generation != null ? ` generation ${event.generation}` : ''}${event.firstAt ? `, from ${event.firstAt}` : ''}`;
  const calls = `${event.count} ${event.operation === 'invoke_agent' ? 'request' : 'model call'}${event.count === 1 ? '' : 's'}`;
  const times = `${event.count} time${event.count === 1 ? '' : 's'}`;
  if (event.kind === 'model-substituted') return `${where}: Copilot answered ${calls} for ${event.requestedModel} with ${event.resolvedModel}. The premium allowance may have run out.`;
  if (event.kind === 'model-switched') return `${where}: Copilot changed the model from ${event.requestedModel} to ${event.resolvedModel} on its own, ${times}.`;
  if (event.kind === 'auto-fallback') return `${where}: Auto fell back to ${event.resolvedModel} instead of the model it picked, ${times}.`;
  if (event.kind === 'quota-exceeded') return `${where}: ${calls} failed because the allowance was exhausted (${event.errorType}).`;
  if (event.kind === 'rate-limited') return `${where}: ${calls} ${event.count === 1 ? 'was' : 'were'} rate limited (${event.errorType}).`;
  return `${where}: ${calls} failed (${event.errorType ?? 'error'}).`;
}

const OTEL_FEEDS = 'the spans Copilot exports for launches through `singularity-flow copilot`, and the local file Copilot Chat in VS Code writes on a computer where counting is on';

/**
 * Where the section's counts come from, as true for this report: Copilot's own session logs where
 * they cover a phase, the older OpenTelemetry feeds elsewhere, and the multiplier estimate only
 * where a premium-request count is still estimated. [owner, 2026-11-13]
 */
function copilotSources(report) {
  const logs = Boolean(report.copilot.sessions?.found);
  const estimated = report.phases.some((phase) => !['none', 'observed'].includes(phase.copilot.premiumRequests.status));
  const estimate = 'estimated as requests times `tokens.premiumMultipliers`; GitHub\'s billing is authoritative';
  return [
    logs ? `Counts come from Copilot's own session logs on this computer, which Copilot CLI and VS Code's Copilot agent write with no setup. A phase the logs do not cover is counted from ${OTEL_FEEDS}; no phase is counted from both.`
      : `Counts come from ${OTEL_FEEDS}. Copilot's own session logs on this computer hold nothing for this Story.`,
    'A turn is one model round trip; where Copilot\'s spans do not report the count, it is the model calls under the request.',
    logs && !estimated ? 'Premium requests are Copilot\'s own count.'
      : logs ? `Premium requests are Copilot's own count where the logs cover a phase, and elsewhere ${estimate}.` : `Premium requests are ${estimate}.`,
    'Billed (AIU) is the usage Copilot reports for its model calls.',
    'The phase prompt is the prompt sflow composed for the latest generation: exact bytes, tokens estimated as bytes ÷ 4. Copilot adds its own instructions, tools and history to it.'
  ].join(' ');
}

export function renderMarkdown(report) {
  const item = report.workItem;
  const lines = [`# ${item.id}${item.title ? ` — ${item.title}` : ''}${item.workType ? ` (${item.workType})` : ''}`, ''];
  lines.push([
    report.completedAt
      ? `${item.status === 'cancelled' ? 'Cancelled after' : 'Completed in'} ${humanizeDuration(report.elapsedMs)}`
      : `In progress for ${humanizeDuration(report.elapsedMs)}`,
    `${report.phases.length} phases`,
    `${report.reworkCycles} rework cycle${report.reworkCycles === 1 ? '' : 's'}`,
    ...(report.sentBack ? [`${report.sentBack} send-back${report.sentBack === 1 ? '' : 's'}`] : []),
    tokenSummary(report)
  ].join(' · '), '');
  lines.push('| Phase | Status | Decision | Active | Waiting | Gens | Provider / model | Tokens | Cost |');
  lines.push('|-------|--------|----------|--------|---------|------|------------------|--------|------|');
  for (const phase of report.phases) {
    lines.push(`| ${phase.label} (\`${phase.id}\`) | ${phase.status} | ${approvalDispositionLabel(phase)} | ${humanizeDuration(phase.activeMs)} | ${humanizeDuration(phase.waitingMs)} | ${phase.generations} | ${modelCell(phase)} | ${tokenCell(phase)} | ${costCell(phase)} |`);
  }
  lines.push('');
  if (report.bottleneck) {
    const share = report.bottleneck.share != null ? `, ${report.bottleneck.share}% of elapsed` : '';
    lines.push(`**Bottleneck:** approval latency on \`${report.bottleneck.phase}\` (${humanizeDuration(report.bottleneck.waitingMs)}${share}).`, '');
  }
  if (hasCopilotSection(report)) {
    const copilot = report.copilot;
    lines.push('## Copilot activity by phase', '');
    const totals = [
      copilot.requests.value != null ? `${countCell(copilot.requests)} requests` : null,
      copilot.premiumRequests.value != null ? `${premiumCell(copilot.premiumRequests)} premium requests (${copilot.premiumRequests.status === 'observed' ? 'Copilot\'s count' : 'estimated'})` : null,
      copilot.billedAiu?.value != null ? `${aiuCell(copilot.billedAiu)} AIU billed (Copilot-reported)` : null,
      copilot.turns.value != null ? `${countCell(copilot.turns)} turns` : null,
      copilot.eventCount ? `${copilot.eventCount} quota or model event${copilot.eventCount === 1 ? '' : 's'}` : null,
      copilot.largestPrompt ? `largest phase prompt ${sizeLabel(copilot.largestPrompt.bytes)} in \`${copilot.largestPrompt.phase}\`` : null
    ].filter(Boolean);
    if (totals.length) lines.push(totals.join(' · '), '');
    lines.push('| Phase | Gens | Sent back | Requests | Turns | Model calls | Tool calls | Premium requests | Billed (AIU) | Phase prompt |');
    lines.push('|-------|------|-----------|----------|-------|-------------|------------|------------------|--------------|-----------------|');
    for (const phase of report.phases) {
      lines.push(`| ${phase.label} (\`${phase.id}\`) | ${phase.generations} | ${phase.sentBack} | ${countCell(phase.copilot.requests)} | ${countCell(phase.copilot.turns)} | ${countCell(phase.copilot.modelCalls)} | ${toolCell(phase)} | ${premiumCell(phase.copilot.premiumRequests)} | ${aiuCell(phase.copilot.billedAiu)} | ${promptCell(phase.copilot.prompt)} |`);
    }
    lines.push('');
    const chatLine = copilotChatLine(copilot.chat);
    if (chatLine) lines.push(`_${chatLine}_`, '');
    if (copilot.events.length) {
      lines.push('**Quota and model events:**', '');
      for (const event of copilot.events) lines.push(`- ${copilotEventLine(event)}`);
      if (copilot.omittedEvents) lines.push(`- ${copilot.omittedEvents} more event group${copilot.omittedEvents === 1 ? '' : 's'} not listed.`);
      lines.push('');
    }
    if (copilot.captureNotes.length) {
      lines.push('**Why some counts are unavailable:**', '');
      for (const note of copilot.captureNotes) lines.push(`- ${note}`);
      lines.push('');
    }
    if (copilot.premiumRequests.missingModels.length) {
      lines.push(`_Premium requests are ${copilot.premiumRequests.value == null ? 'unavailable' : 'partial'}: no \`tokens.premiumMultipliers\` entry for ${copilot.premiumRequests.missingModels.join(', ')}._`, '');
    }
    lines.push(`_${copilotSources(report)} \`*\` marks a count some generations did not report; \`unavailable\` means none did._`, '');
  }
  lines.push(...sessionsMarkdown(report));
  if (report.selfApprovals) lines.push(`**Sign-off note:** ${report.selfApprovals} active self-approval${report.selfApprovals === 1 ? '' : 's'}; these are not independent reviews.`, '');
  if (report.sequenceOverrides.length) lines.push(`**Sign-off note:** ${report.sequenceOverrides.length} confirmed soft sequence override${report.sequenceOverrides.length === 1 ? '' : 's'}; review the audit details below.`, '');
  if (report.rejections.length) {
    lines.push('## Rework history', '');
    for (const rejection of report.rejections) lines.push(`- ${rejection.at} — \`${rejection.phase}\` rejected by ${rejection.actor} (agent ${rejection.agent ?? 'unavailable'}): ${rejection.detail}`);
    lines.push('');
  }
  if (report.sequenceOverrides.length) {
    lines.push('## Soft sequence overrides', '', '| Time | Gate | Action | Phase | Actor / agent | Reason |', '|------|------|--------|-------|----------------------|--------|');
    for (const override of report.sequenceOverrides) {
      const actor = actorLabel(override.actor);
      lines.push(`| ${override.at} | ${override.gate} | ${override.action} | ${override.requestedPhase ?? override.before?.currentPhase ?? '—'} | ${actor} / ${override.agent ?? 'unknown'} | ${override.reason ?? '—'} |`);
    }
    lines.push('');
  }
  const agents = Object.entries(report.tokens.byAgent);
  if (agents.length) {
    lines.push('## Token usage by agent', '', '| agent | Records | Exact | Tokens |', '|--------------|---------|-------|--------|');
    for (const [agent, aggregate] of agents) lines.push(`| ${agent} | ${aggregate.records} | ${aggregate.exactRecords} | ${aggregateTokens(aggregate)} |`);
    lines.push('');
  }
  if (report.tokens.byModel.length) {
    lines.push('## Token usage by model', '', '| Provider | Model | Records | Exact | Unavailable | Tokens |', '|----------|-------|---------|-------|-------------|--------|');
    for (const aggregate of report.tokens.byModel) lines.push(`| ${aggregate.provider} | ${aggregate.model} | ${aggregate.records} | ${aggregate.exactRecords} | ${aggregate.unavailableRecords} | ${aggregateTokens(aggregate)} |`);
    lines.push('');
  }
  if (report.phases.some((phase) => phase.tokenStatus === 'partial')) lines.push('_* Token totals are partial because one or more provider records were unavailable._', '');
  if (report.costStatus === 'partial') lines.push('_* Cost is partial because pricing or exact usage was unavailable for one or more records._', '');
  lines.push(`_Durations are wall-clock elapsed time, including nights and weekends. Generated ${report.generatedAt} by singularity-flow._`);
  return `${lines.join('\n')}\n`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

/**
 * Horizontal bars, one row per phase. `limitKey` draws a dashed line at a row's own limit (a
 * prompt budget), and `note` adds text after the value (a quota marker). A row whose value is
 * missing shows its `missing` text instead of a bar, so an unmeasured phase never reads as zero.
 */
function barChart(rows, { valueKey, labelKey, formatValue, color, limitKey = null, note = null, missing = null }) {
  const values = rows.map((row) => row[valueKey]);
  const limits = limitKey ? rows.map((row) => row[limitKey]).filter(Number.isFinite) : [];
  const max = Math.max(...values.map((value) => value ?? 0), ...limits, 1);
  const barHeight = 22;
  const gap = 8;
  const labelWidth = 170;
  const chartWidth = 420;
  const height = rows.length * (barHeight + gap);
  const bars = rows.map((row, index) => {
    const value = row[valueKey];
    const y = index * (barHeight + gap);
    const label = `<text x="0" y="${y + 15}" font-size="12" fill="#333">${escapeHtml(row[labelKey])}</text>`;
    if (value == null && missing) {
      const extra = note ? note(row) : '';
      return `${label}<text x="${labelWidth}" y="${y + 15}" font-size="12" fill="#888">${escapeHtml(missing(row))}${extra ? ` ${escapeHtml(extra)}` : ''}</text>`;
    }
    const width = Math.max(2, Math.round(((value ?? 0) / max) * chartWidth));
    const limit = limitKey && Number.isFinite(row[limitKey])
      ? `<line x1="${labelWidth + Math.round((row[limitKey] / max) * chartWidth)}" x2="${labelWidth + Math.round((row[limitKey] / max) * chartWidth)}" y1="${y - 2}" y2="${y + barHeight + 2}" stroke="#c0392b" stroke-width="2" stroke-dasharray="4 3"></line>` : '';
    const extra = note ? note(row) : '';
    return `${label}<rect x="${labelWidth}" y="${y}" width="${width}" height="${barHeight}" rx="3" fill="${color}"></rect>${limit}<text x="${labelWidth + width + 6}" y="${y + 15}" font-size="12" fill="#555">${escapeHtml(formatValue(value ?? 0, row))}${extra ? ` ${escapeHtml(extra)}` : ''}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${labelWidth + chartWidth + 150} ${height}" width="100%" height="${height}" xmlns="http://www.w3.org/2000/svg" role="img">${bars}</svg>`;
}

/** Two bars per phase, for counts read side by side (requests and turns, model and tool calls). */
function pairedBarChart(rows, { labelKey, series, missing }) {
  const max = Math.max(...rows.flatMap((row) => series.map((entry) => row[entry.key] ?? 0)), 1);
  const barHeight = 12;
  const empty = (row) => series.every((entry) => row[entry.key] == null);
  const heightOf = (row) => (empty(row) ? 22 : barHeight * series.length + 10);
  const offsets = rows.reduce((list, row, index) => [...list, index ? list[index - 1] + heightOf(rows[index - 1]) : 20], []);
  const labelWidth = 170;
  const chartWidth = 420;
  const height = rows.reduce((sum, row) => sum + heightOf(row), 20);
  const legend = series.map((entry, index) => `<rect x="${labelWidth + index * 120}" y="0" width="10" height="10" fill="${entry.color}"></rect><text x="${labelWidth + index * 120 + 14}" y="9" font-size="11" fill="#555">${escapeHtml(entry.label)}</text>`).join('');
  const bars = rows.map((row, index) => {
    const y = offsets[index];
    const label = `<text x="0" y="${y + barHeight}" font-size="12" fill="#333">${escapeHtml(row[labelKey])}</text>`;
    if (empty(row)) {
      return `${label}<text x="${labelWidth}" y="${y + barHeight}" font-size="12" fill="#888">${escapeHtml(missing(row))}</text>`;
    }
    return label + series.map((entry, offset) => {
      const value = row[entry.key];
      const top = y + offset * barHeight;
      if (value == null) return `<text x="${labelWidth}" y="${top + barHeight - 2}" font-size="10" fill="#888">${escapeHtml(entry.label)} unavailable</text>`;
      const width = Math.max(2, Math.round((value / max) * chartWidth));
      return `<rect x="${labelWidth}" y="${top}" width="${width}" height="${barHeight - 2}" rx="2" fill="${entry.color}"></rect><text x="${labelWidth + width + 6}" y="${top + barHeight - 2}" font-size="11" fill="#555">${value.toLocaleString('en-US')}</text>`;
    }).join('');
  }).join('');
  return `<svg viewBox="0 0 ${labelWidth + chartWidth + 90} ${height}" width="100%" height="${height}" xmlns="http://www.w3.org/2000/svg" role="img">${legend}${bars}</svg>`;
}

function codeSpans(escaped) {
  return escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
}

function copilotMissing(phase) {
  if (phase.copilot.status === 'none') return 'no model-assisted generation';
  return phase.copilot.status === 'unavailable' ? 'not captured' : 'unavailable';
}

function copilotHtml(report) {
  if (!hasCopilotSection(report)) return '';
  const copilot = report.copilot;
  const rows = report.phases.map((phase) => ({
    label: phase.label,
    copilot: phase.copilot,
    requests: phase.copilot.requests.value,
    turns: phase.copilot.turns.value,
    modelCalls: phase.copilot.modelCalls.value,
    toolCalls: phase.copilot.toolCalls.value,
    premium: phase.copilot.premiumRequests.value,
    events: phase.copilot.eventCount,
    promptBytes: phase.copilot.prompt?.bytes ?? null,
    promptBudget: phase.copilot.prompt?.maximumBytes ?? null
  }));
  const activityChart = pairedBarChart(rows, {
    labelKey: 'label', missing: (row) => copilotMissing(row),
    series: [
      { key: 'requests', label: 'Requests', color: '#4f6df5' },
      { key: 'turns', label: 'Turns', color: '#9b59b6' },
      { key: 'modelCalls', label: 'Model calls', color: '#2fa66a' },
      { key: 'toolCalls', label: 'Tool calls', color: '#e0a526' }
    ]
  });
  const premiumChart = barChart(rows, {
    valueKey: 'premium', labelKey: 'label', color: '#d35400',
    // Copilot's own count, from its session logs, is not an estimate.
    formatValue: (value, row) => `${row.copilot.premiumRequests.status === 'observed' ? '' : '~'}${premiumValue(value)}`,
    note: (row) => (row.events ? `⚠ ${row.events} quota/model event${row.events === 1 ? '' : 's'}` : ''),
    missing: (row) => (row.copilot.status === 'none' ? 'no model-assisted generation'
      : row.copilot.requests.value == null ? 'requests not captured' : 'no multiplier configured')
  });
  const promptChart = barChart(rows, {
    valueKey: 'promptBytes', labelKey: 'label', color: '#16a085', limitKey: 'promptBudget',
    formatValue: (value) => sizeLabel(value),
    note: (row) => (row.promptBudget == null ? '' : `of ${sizeLabel(row.promptBudget)} budget${row.copilot.prompt?.overBudget ? ', over it' : ''}`),
    missing: () => 'no composed prompt'
  });
  const tableRows = report.phases.map((phase) => `<tr><td>${escapeHtml(phase.label)}</td><td>${phase.generations}</td><td>${phase.sentBack}</td><td>${escapeHtml(countCell(phase.copilot.requests))}</td><td>${escapeHtml(countCell(phase.copilot.turns))}</td><td>${escapeHtml(countCell(phase.copilot.modelCalls))}</td><td>${escapeHtml(toolCell(phase))}</td><td>${escapeHtml(premiumCell(phase.copilot.premiumRequests))}</td><td>${escapeHtml(aiuCell(phase.copilot.billedAiu))}</td><td>${escapeHtml(promptCell(phase.copilot.prompt))}</td></tr>`).join('');
  const chatLine = copilotChatLine(copilot.chat);
  const events = copilot.events.length
    ? `<h3>Quota and model events</h3><ul>${copilot.events.map((event) => `<li>${escapeHtml(copilotEventLine(event))}</li>`).join('')}${copilot.omittedEvents ? `<li>${copilot.omittedEvents} more event group${copilot.omittedEvents === 1 ? '' : 's'} not listed.</li>` : ''}</ul>` : '';
  const captureNotes = copilot.captureNotes.length
    ? `<h3>Why some counts are unavailable</h3><ul>${copilot.captureNotes.map((note) => `<li>${codeSpans(escapeHtml(note))}</li>`).join('')}</ul>` : '';
  const missing = copilot.premiumRequests.missingModels.length
    ? `<p class="note">Premium requests are ${copilot.premiumRequests.value == null ? 'unavailable' : 'partial'}: no <code>tokens.premiumMultipliers</code> entry for ${escapeHtml(copilot.premiumRequests.missingModels.join(', '))}.</p>` : '';
  return `<h2>Copilot activity by phase</h2>
<table><thead><tr><th>Phase</th><th>Gens</th><th>Sent back</th><th>Requests</th><th>Turns</th><th>Model calls</th><th>Tool calls</th><th>Premium requests</th><th>Billed (AIU)</th><th>Phase prompt</th></tr></thead><tbody>${tableRows}</tbody></table>
${chatLine ? `<p class="note">${escapeHtml(chatLine)}</p>` : ''}
<h3>Requests, turns, model and tool calls</h3>
${activityChart}
<h3>${copilot.premiumRequests.status === 'observed' ? 'Premium requests' : 'Estimated premium requests'}</h3>
${premiumChart}
<h3>Phase prompt size</h3>
<p class="note">Dashed red line: the phase's prompt budget.</p>
${promptChart}
${captureNotes}
${events}
${missing}
<p class="note">${codeSpans(escapeHtml(copilotSources(report)))} * marks a count some generations did not report; "unavailable" means none did.</p>`;
}

export function renderHtml(report) {
  const item = report.workItem;
  const elapsedChart = barChart(report.phases, { valueKey: 'elapsedMs', labelKey: 'label', formatValue: humanizeDuration, color: '#4f6df5' });
  const tokenRows = report.phases.map((phase) => ({ ...phase, reportedTokens: ['exact', 'partial'].includes(phase.tokenStatus) ? phase.tokens : null }));
  const tokenChart = barChart(tokenRows, {
    valueKey: 'reportedTokens', labelKey: 'label', formatValue: (value) => value.toLocaleString('en-US'), color: '#2fa66a',
    missing: (phase) => (phase.tokenStatus === 'none' ? 'no model usage recorded' : 'unavailable: the provider did not report tokens')
  });
  const rows = report.phases.map((phase) => `<tr><td>${escapeHtml(phase.label)}</td><td>${escapeHtml(phase.status)}</td><td>${escapeHtml(approvalDispositionLabel(phase))}</td><td>${humanizeDuration(phase.activeMs)}</td><td>${humanizeDuration(phase.waitingMs)}</td><td>${phase.generations}</td><td>${escapeHtml(modelCell(phase))}</td><td>${escapeHtml(tokenCell(phase))}</td><td>${escapeHtml(costCell(phase))}</td></tr>`).join('');
  const modelRows = report.tokens.byModel.map((aggregate) => `<tr><td>${escapeHtml(aggregate.provider)}</td><td>${escapeHtml(aggregate.model)}</td><td>${aggregate.records}</td><td>${aggregate.exactRecords}</td><td>${aggregate.unavailableRecords}</td><td>${aggregateTokens(aggregate)}</td></tr>`).join('');
  const modelTable = modelRows ? `<h2>Token usage by model</h2>\n<table><thead><tr><th>Provider</th><th>Model</th><th>Records</th><th>Exact</th><th>Unavailable</th><th>Tokens</th></tr></thead><tbody>${modelRows}</tbody></table>` : '';
  const bottleneck = report.bottleneck ? `<p><strong>Bottleneck:</strong> approval latency on <code>${escapeHtml(report.bottleneck.phase)}</code> (${humanizeDuration(report.bottleneck.waitingMs)}${report.bottleneck.share != null ? `, ${report.bottleneck.share}% of elapsed` : ''}).</p>` : '';
  const governance = [
    report.selfApprovals ? `<p><strong>Sign-off note:</strong> ${report.selfApprovals} active self-approval${report.selfApprovals === 1 ? '' : 's'}; these are not independent reviews.</p>` : '',
    report.sequenceOverrides.length ? `<p><strong>Sign-off note:</strong> ${report.sequenceOverrides.length} confirmed soft sequence override${report.sequenceOverrides.length === 1 ? '' : 's'}.</p>` : ''
  ].join('');
  const overrideRows = report.sequenceOverrides.map((override) => `<tr><td>${escapeHtml(override.at)}</td><td>${escapeHtml(override.gate)}</td><td>${escapeHtml(override.action)}</td><td>${escapeHtml(override.requestedPhase ?? override.before?.currentPhase ?? '—')}</td><td>${escapeHtml(actorLabel(override.actor))} / ${escapeHtml(override.agent ?? 'unknown')}</td><td>${escapeHtml(override.reason ?? '—')}</td></tr>`).join('');
  const copilotSection = copilotHtml(report);
  const overrideTable = overrideRows ? `<h2>Soft sequence overrides</h2>\n<table><thead><tr><th>Time</th><th>Gate</th><th>Action</th><th>Phase</th><th>Actor / agent</th><th>Reason</th></tr></thead><tbody>${overrideRows}</tbody></table>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(item.id)} workflow report</title>
<style>
body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 60rem; padding: 0 1rem; color: #222; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; font-size: 14px; }
th { background: #f5f5f7; }
h2 { margin-top: 2rem; }
footer { color: #777; font-size: 12px; margin-top: 2rem; }
.note { color: #666; font-size: 13px; }
</style>
</head>
<body>
<h1>${escapeHtml(item.id)}${item.title ? ` — ${escapeHtml(item.title)}` : ''}</h1>
<p>${report.completedAt ? `${item.status === 'cancelled' ? 'Cancelled after' : 'Completed in'} ${humanizeDuration(report.elapsedMs)}` : `In progress for ${humanizeDuration(report.elapsedMs)}`} · ${report.reworkCycles} rework cycle${report.reworkCycles === 1 ? '' : 's'}${report.sentBack ? ` · ${report.sentBack} send-back${report.sentBack === 1 ? '' : 's'}` : ''} · ${escapeHtml(tokenSummary(report))}</p>
${bottleneck}
${governance}
<h2>Phases</h2>
<table><thead><tr><th>Phase</th><th>Status</th><th>Decision</th><th>Active</th><th>Waiting</th><th>Gens</th><th>Provider / model</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Elapsed time by phase</h2>
${elapsedChart}
<h2>Tokens by phase</h2>
${tokenChart}
${modelTable}
${copilotSection}
${sessionsHtml(report)}
${overrideTable}
<footer>Durations are wall-clock elapsed time, including nights and weekends. Generated ${escapeHtml(report.generatedAt)} by singularity-flow.</footer>
</body>
</html>
`;
}
