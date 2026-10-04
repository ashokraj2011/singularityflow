/**
 * Copilot activity counted from the spans a metered launch exports, and what it costs in premium
 * requests.
 *
 * Many Copilot plans leave token counts off their spans, but every span still says that a request,
 * a model call or a tool call happened, which model was asked for and which one answered. GitHub
 * bills one premium request for each prompt a person sends, multiplied by the rate of the model
 * that served it; the model round trips and tool calls an agent then makes on its own are not
 * billed. These counts are what a report can chart when tokens are unavailable.
 *
 * Everything here is pure and content-free: model names, counts, error classes and times. Nothing
 * reads a prompt, a response, a tool argument or a tool result.
 */

const AUTO_MODEL = /^(?:copilot-)?auto$/;
// What a provider appends to name one build of a model: a date, a four-digit snapshot, or a
// preview/latest channel with its date. `-mini`, `-nano` or `-5` name a different model.
const BUILD_SUFFIX = /^(?:\d{4}|\d{6}|\d{8}|\d{4}-\d{2}-\d{2}|(?:preview|latest|exp|experimental)(?:-\d{2,4}){0,3})$/;
const EVENT_LIMIT = 20;

/** A model name compared without case, provider prefix or separator style. */
export function copilotModelKey(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return text.slice(text.lastIndexOf('/') + 1).replace(/[\s._]+/g, '-');
}

/**
 * True when both names are one model, allowing for one being a dated or preview build of the
 * other: `model-alpha-1.5` and `model-alpha-1-5-20250929` are the same model, while `gpt-5`
 * and `gpt-5-mini` are not.
 */
export function sameCopilotModel(left, right) {
  const a = copilotModelKey(left);
  const b = copilotModelKey(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return longer.startsWith(`${shorter}-`) && BUILD_SUFFIX.test(longer.slice(shorter.length + 1));
}

export function isAutoModel(value) {
  return AUTO_MODEL.test(copilotModelKey(value));
}

/**
 * Copilot answered with a different model than the one asked for. When a premium allowance runs
 * out, Copilot keeps working on an included model, so this is the observable sign of quota
 * depletion. `auto` asks Copilot to choose, so whatever answers it is not a substitution.
 */
export function modelSubstituted(requested, resolved) {
  if (!requested || !resolved || isAutoModel(requested)) return false;
  return !sameCopilotModel(requested, resolved);
}

/**
 * `error.type` is meant to be a low-cardinality class: an exception name, an HTTP status, `_OTHER`.
 * Anything longer or freer than that could be a message, and messages can carry content.
 */
export function boundedErrorType(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(text) ? text : 'error';
}

/** Whether a failed call's error class says the allowance or the rate limit stopped it. */
export function quotaEventKind(errorType) {
  const text = String(errorType ?? '');
  if (/quota|premium|exhaust|insufficient|entitlement|billing|payment|402/i.test(text)) return 'quota-exceeded';
  if (/429|rate[_.:-]?limit|too[_.:-]?many|throttl/i.test(text)) return 'rate-limited';
  return null;
}

/**
 * One summary for the activity of a capture, from content-free span entries
 * `{operation, traceId, requestedModel, resolvedModel, turns, maxPromptTokens, failed, errorType, at}`.
 *
 * A request is counted only from a request span, never inferred from model calls, so a host that
 * exports no request spans reports requests as unavailable rather than as a guess. Trace IDs are
 * used to join a request to its model calls and are never returned.
 */
export function summarizeCopilotActivity(activities = []) {
  const entries = activities.filter(Boolean);
  if (!entries.length) return null;
  const requests = entries.filter((entry) => entry.operation === 'invoke_agent');
  const calls = entries.filter((entry) => entry.operation === 'chat');
  const tools = entries.filter((entry) => entry.operation === 'execute_tool');

  const callModelsByTrace = new Map();
  const callsByTrace = new Map();
  for (const call of calls) {
    if (!call.traceId) continue;
    callsByTrace.set(call.traceId, (callsByTrace.get(call.traceId) ?? 0) + 1);
    const model = call.resolvedModel ?? call.requestedModel;
    if (!model) continue;
    if (!callModelsByTrace.has(call.traceId)) callModelsByTrace.set(call.traceId, new Set());
    callModelsByTrace.get(call.traceId).add(model);
  }
  const requestsByTrace = new Map();
  for (const request of requests) {
    if (request.traceId) requestsByTrace.set(request.traceId, (requestsByTrace.get(request.traceId) ?? 0) + 1);
  }
  // A turn is one model round trip of an agent's loop. Copilot Chat reports the count on the
  // request span; where it does not, the model calls under a request's own trace are its turns.
  // A trace shared by several requests cannot say which call belongs to which, so it says nothing.
  const turnsFor = (request) => {
    if (Number.isSafeInteger(request.turns)) return { value: request.turns, reported: true };
    if (request.traceId && requestsByTrace.get(request.traceId) === 1 && callsByTrace.has(request.traceId)) {
      return { value: callsByTrace.get(request.traceId), reported: false };
    }
    return null;
  };
  const requestsByModel = new Map();
  for (const request of requests) {
    const traced = [...(callModelsByTrace.get(request.traceId) ?? [])];
    // Billed at the rate of the model that served it: the answering model when the span names
    // one, the requested model unless that was `auto`, and the trace's only model as a last resort.
    const model = request.resolvedModel
      ?? (request.requestedModel && !isAutoModel(request.requestedModel) ? request.requestedModel : null)
      ?? (traced.length === 1 ? traced[0] : null)
      ?? request.requestedModel
      ?? 'unknown';
    requestsByModel.set(model, (requestsByModel.get(model) ?? 0) + 1);
  }

  const events = new Map();
  const note = (kind, entry, { requestedModel = null, resolvedModel = null, errorType = null } = {}) => {
    const key = JSON.stringify([kind, entry.operation, requestedModel, resolvedModel, errorType]);
    const event = events.get(key) ?? {
      kind, operation: entry.operation, requestedModel, resolvedModel, errorType,
      count: 0, firstAt: null, lastAt: null
    };
    event.count += 1;
    if (entry.at && (!event.firstAt || entry.at < event.firstAt)) event.firstAt = entry.at;
    if (entry.at && (!event.lastAt || entry.at > event.lastAt)) event.lastAt = entry.at;
    events.set(key, event);
  };
  for (const call of calls) {
    if (modelSubstituted(call.requestedModel, call.resolvedModel)) note('model-substituted', call, call);
  }
  // A failed tool call is an ordinary step in an agent's loop; a failed request or model call is
  // not, so only those become events.
  for (const entry of [...requests, ...calls]) {
    if (entry.failed) note(quotaEventKind(entry.errorType) ?? 'failed', entry, entry);
  }
  const ordered = [...events.values()].sort((left, right) =>
    String(left.firstAt ?? '').localeCompare(String(right.firstAt ?? ''))
    || left.kind.localeCompare(right.kind) || right.count - left.count);

  const limits = new Map();
  for (const call of calls) {
    const model = call.resolvedModel ?? call.requestedModel;
    if (!model || !Number.isSafeInteger(call.maxPromptTokens) || call.maxPromptTokens <= 0) continue;
    limits.set(model, Math.max(limits.get(model) ?? 0, call.maxPromptTokens));
  }
  const turns = requests.map(turnsFor).filter(Boolean);
  return {
    source: 'copilot-otel',
    requests: requests.length ? requests.length : null,
    turns: turns.length ? turns.reduce((total, entry) => total + entry.value, 0) : null,
    // How many requests the turn count covers, and whether any came from counting model calls.
    turnsCounted: turns.length,
    turnsAssurance: !turns.length ? 'unavailable' : turns.every((entry) => entry.reported) ? 'provider-reported' : 'derived-from-model-calls',
    modelCalls: calls.length ? calls.length : null,
    toolCalls: tools.length,
    failedRequests: requests.filter((entry) => entry.failed).length,
    failedModelCalls: calls.filter((entry) => entry.failed).length,
    failedToolCalls: tools.filter((entry) => entry.failed).length,
    requestsByModel: [...requestsByModel].map(([model, count]) => ({ model, requests: count }))
      .sort((left, right) => left.model.localeCompare(right.model)),
    promptLimits: [...limits].map(([model, maxPromptTokens]) => ({ model, maxPromptTokens }))
      .sort((left, right) => left.model.localeCompare(right.model)),
    events: ordered.slice(0, EVENT_LIMIT),
    omittedEvents: Math.max(0, ordered.length - EVENT_LIMIT)
  };
}

/** The configured multiplier for a model, matching its dated builds; null when none is set. */
export function premiumMultiplierFor(multipliers, model) {
  if (!multipliers || typeof multipliers !== 'object' || !model) return null;
  if (Number.isFinite(multipliers[model])) return multipliers[model];
  let best = null;
  for (const [name, value] of Object.entries(multipliers)) {
    if (!Number.isFinite(value) || !sameCopilotModel(name, model)) continue;
    if (!best || name.length > best.name.length) best = { name, value };
  }
  return best ? best.value : null;
}

/**
 * Premium requests as GitHub counts them: one per request, times the serving model's multiplier.
 * The multipliers are configuration because GitHub changes them; a model without one leaves the
 * estimate partial instead of being counted at some assumed rate.
 */
export function estimatePremiumRequests(requestsByModel = [], multipliers = null) {
  const counted = (requestsByModel ?? []).filter((entry) => Number.isSafeInteger(entry?.requests) && entry.requests > 0);
  if (!counted.length) return { value: null, status: 'unavailable', missingModels: [] };
  let value = 0;
  let priced = 0;
  const missing = new Set();
  for (const { model, requests } of counted) {
    const multiplier = premiumMultiplierFor(multipliers, model);
    if (multiplier == null) { missing.add(model); continue; }
    value += requests * multiplier;
    priced += 1;
  }
  return {
    value: priced ? Math.round(value * 100) / 100 : null,
    status: !priced ? 'unavailable' : missing.size ? 'partial' : 'estimated',
    missingModels: [...missing].sort()
  };
}
