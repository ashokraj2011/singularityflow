import { nowIso } from './util.mjs';
import { automaticApprovalDisposition } from './lifecycle-transitions.mjs';
import { estimatePremiumRequests } from './copilot-activity.mjs';

const DECISION_EVENTS = new Set(['phase_approved', 'phase_self_approved', 'phase_rejected', 'phase-approval-waived']);

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
  return {
    value: Math.round(known.reduce((sum, estimate) => sum + estimate.value, 0) * 100) / 100,
    status: known.length === relevant.length && known.every((estimate) => estimate.status === 'estimated') ? 'estimated' : 'partial',
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
function phaseCopilot(phase, premiumMultipliers) {
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
  const premiumRequests = combinePremium(generations.map((entry) => (entry.activity?.requestsByModel?.length
    ? estimatePremiumRequests(entry.activity.requestsByModel, premiumMultipliers)
    : { value: null, status: 'unavailable', missingModels: [] })));
  const prompts = generations.filter((entry) => entry.prompt?.bytes != null);
  const latest = prompts.at(-1) ?? null;
  const limits = (latest?.activity?.promptLimits ?? []).map((entry) => entry.maxPromptTokens).filter(Number.isSafeInteger);
  const limitTokens = limits.length ? Math.min(...limits) : null;
  return {
    status: !generations.length ? 'none'
      : generations.every((entry) => entry.activity) ? 'observed'
        : generations.some((entry) => entry.activity) ? 'partial' : 'unavailable',
    generations: generations.length,
    capturedGenerations: generations.filter((entry) => entry.activity).length,
    requests: metric('requests'),
    turns: metric('turns'),
    // Whether any generation counted turns from model calls rather than Copilot's own turn count.
    turnsDerived: generations.some((entry) => entry.activity?.turnsAssurance === 'derived-from-model-calls'),
    modelCalls: metric('modelCalls'),
    toolCalls: metric('toolCalls'),
    failedRequests: metric('failedRequests'),
    failedModelCalls: metric('failedModelCalls'),
    failedToolCalls: metric('failedToolCalls'),
    premiumRequests,
    events: generations.flatMap((entry) => (entry.activity?.events ?? [])
      .map((event) => ({ generation: entry.generation, ...event }))),
    // Occurrences, not groups: two substituted calls are two events listed on one line.
    eventCount: generations.reduce((sum, entry) => sum + (entry.activity?.events ?? [])
      .reduce((count, event) => count + event.count, 0), 0),
    omittedEvents: generations.reduce((sum, entry) => sum + (entry.activity?.omittedEvents ?? 0), 0),
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

export function deriveReport(workflow, { pricing = null, premiumMultipliers = null, now = nowIso() } = {}) {
  const reportTime = timestamp(now);
  const history = [...(workflow.history ?? [])].sort(compareEvents);
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
      copilot: phaseCopilot(phase, premiumMultipliers)
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
  const copilot = {
    status: !copilotStatuses.length ? 'none'
      : copilotStatuses.every((status) => status === 'observed') ? 'observed'
        : copilotStatuses.every((status) => status === 'unavailable') ? 'unavailable' : 'partial',
    ...Object.fromEntries(['requests', 'turns', 'modelCalls', 'toolCalls', 'failedRequests', 'failedModelCalls', 'failedToolCalls']
      .map((field) => [field, combineMetrics(phases.map((phase) => phase.copilot[field]))])),
    turnsDerived: phases.some((phase) => phase.copilot.turnsDerived),
    premiumRequests: combinePremium(phases.map((phase) => phase.copilot.premiumRequests)),
    premiumMultipliersConfigured: Boolean(premiumMultipliers && Object.keys(premiumMultipliers).length),
    events: phases.flatMap((phase) => phase.copilot.events.map((event) => ({ phase: phase.id, ...event }))),
    eventCount: phases.reduce((sum, phase) => sum + phase.copilot.eventCount, 0),
    omittedEvents: phases.reduce((sum, phase) => sum + phase.copilot.omittedEvents, 0),
    largestPrompt: largestPrompt ? {
      phase: largestPrompt.id,
      bytes: largestPrompt.copilot.prompt.bytes,
      estimatedTokens: largestPrompt.copilot.prompt.estimatedTokens
    } : null,
    promptsOverBudget: prompted.filter((phase) => phase.copilot.prompt.overBudget).map((phase) => phase.id)
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
  return `~${premiumValue(premium.value)}${premium.status === 'partial' ? '*' : ''}`;
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

function hasCopilotSection(report) {
  return Boolean(report.copilot) && (report.copilot.status !== 'none'
    || report.phases.some((phase) => phase.copilot?.prompt || phase.sentBack));
}

/** One sentence per quota, substitution or failure event, for both renderings. */
function copilotEventLine(event) {
  const where = `${event.phase} generation ${event.generation}${event.firstAt ? `, from ${event.firstAt}` : ''}`;
  const calls = `${event.count} ${event.operation === 'invoke_agent' ? 'request' : 'model call'}${event.count === 1 ? '' : 's'}`;
  if (event.kind === 'model-substituted') return `${where}: Copilot answered ${calls} for ${event.requestedModel} with ${event.resolvedModel}. The premium allowance may have run out.`;
  if (event.kind === 'quota-exceeded') return `${where}: ${calls} failed because the allowance was exhausted (${event.errorType}).`;
  if (event.kind === 'rate-limited') return `${where}: ${calls} ${event.count === 1 ? 'was' : 'were'} rate limited (${event.errorType}).`;
  return `${where}: ${calls} failed (${event.errorType ?? 'error'}).`;
}

const COPILOT_SOURCES = 'Requests, turns, model calls and tool calls are counted from the spans Copilot exports for launches through `singularity-flow copilot`; native IDE chat sends SFlow none. A turn is one model round trip; where Copilot does not report the count, it is the model calls under the request. Premium requests are estimated as requests times `tokens.premiumMultipliers`; GitHub\'s billing is authoritative. The governed prompt is the prompt sflow composed for the latest generation: exact bytes, tokens estimated as bytes ÷ 4. Copilot adds its own instructions, tools and history to it.';

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
      copilot.premiumRequests.value != null ? `${premiumCell(copilot.premiumRequests)} premium requests (estimated)` : null,
      copilot.turns.value != null ? `${countCell(copilot.turns)} turns` : null,
      copilot.eventCount ? `${copilot.eventCount} quota or model event${copilot.eventCount === 1 ? '' : 's'}` : null,
      copilot.largestPrompt ? `largest governed prompt ${sizeLabel(copilot.largestPrompt.bytes)} in \`${copilot.largestPrompt.phase}\`` : null
    ].filter(Boolean);
    if (totals.length) lines.push(totals.join(' · '), '');
    lines.push('| Phase | Gens | Sent back | Requests | Turns | Model calls | Tool calls | Premium requests | Governed prompt |');
    lines.push('|-------|------|-----------|----------|-------|-------------|------------|------------------|-----------------|');
    for (const phase of report.phases) {
      lines.push(`| ${phase.label} (\`${phase.id}\`) | ${phase.generations} | ${phase.sentBack} | ${countCell(phase.copilot.requests)} | ${countCell(phase.copilot.turns)} | ${countCell(phase.copilot.modelCalls)} | ${toolCell(phase)} | ${premiumCell(phase.copilot.premiumRequests)} | ${promptCell(phase.copilot.prompt)} |`);
    }
    lines.push('');
    if (copilot.events.length) {
      lines.push('**Quota and model events:**', '');
      for (const event of copilot.events) lines.push(`- ${copilotEventLine(event)}`);
      if (copilot.omittedEvents) lines.push(`- ${copilot.omittedEvents} more event group${copilot.omittedEvents === 1 ? '' : 's'} not listed.`);
      lines.push('');
    }
    if (copilot.premiumRequests.missingModels.length) {
      lines.push(`_Premium requests are ${copilot.premiumRequests.value == null ? 'unavailable' : 'partial'}: no \`tokens.premiumMultipliers\` entry for ${copilot.premiumRequests.missingModels.join(', ')}._`, '');
    }
    lines.push(`_${COPILOT_SOURCES} \`*\` marks a count some generations did not report; \`unavailable\` means none did._`, '');
  }
  if (report.selfApprovals) lines.push(`**Governance note:** ${report.selfApprovals} active self-approval${report.selfApprovals === 1 ? '' : 's'}; these are not independent reviews.`, '');
  if (report.sequenceOverrides.length) lines.push(`**Governance note:** ${report.sequenceOverrides.length} confirmed soft sequence override${report.sequenceOverrides.length === 1 ? '' : 's'}; review the audit details below.`, '');
  if (report.rejections.length) {
    lines.push('## Rework history', '');
    for (const rejection of report.rejections) lines.push(`- ${rejection.at} — \`${rejection.phase}\` rejected by ${rejection.actor} (governed agent ${rejection.agent ?? 'unavailable'}): ${rejection.detail}`);
    lines.push('');
  }
  if (report.sequenceOverrides.length) {
    lines.push('## Soft sequence overrides', '', '| Time | Gate | Action | Phase | Actor / governed agent | Reason |', '|------|------|--------|-------|----------------------|--------|');
    for (const override of report.sequenceOverrides) {
      const actor = actorLabel(override.actor);
      lines.push(`| ${override.at} | ${override.gate} | ${override.action} | ${override.requestedPhase ?? override.before?.currentPhase ?? '—'} | ${actor} / ${override.agent ?? 'unknown'} | ${override.reason ?? '—'} |`);
    }
    lines.push('');
  }
  const agents = Object.entries(report.tokens.byAgent);
  if (agents.length) {
    lines.push('## Token usage by governed agent', '', '| governed agent | Records | Exact | Tokens |', '|--------------|---------|-------|--------|');
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
    return `${label}<rect x="${labelWidth}" y="${y}" width="${width}" height="${barHeight}" rx="3" fill="${color}"></rect>${limit}<text x="${labelWidth + width + 6}" y="${y + 15}" font-size="12" fill="#555">${escapeHtml(formatValue(value ?? 0))}${extra ? ` ${escapeHtml(extra)}` : ''}</text>`;
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
    formatValue: (value) => `~${premiumValue(value)}`,
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
  const tableRows = report.phases.map((phase) => `<tr><td>${escapeHtml(phase.label)}</td><td>${phase.generations}</td><td>${phase.sentBack}</td><td>${escapeHtml(countCell(phase.copilot.requests))}</td><td>${escapeHtml(countCell(phase.copilot.turns))}</td><td>${escapeHtml(countCell(phase.copilot.modelCalls))}</td><td>${escapeHtml(toolCell(phase))}</td><td>${escapeHtml(premiumCell(phase.copilot.premiumRequests))}</td><td>${escapeHtml(promptCell(phase.copilot.prompt))}</td></tr>`).join('');
  const events = copilot.events.length
    ? `<h3>Quota and model events</h3><ul>${copilot.events.map((event) => `<li>${escapeHtml(copilotEventLine(event))}</li>`).join('')}${copilot.omittedEvents ? `<li>${copilot.omittedEvents} more event group${copilot.omittedEvents === 1 ? '' : 's'} not listed.</li>` : ''}</ul>` : '';
  const missing = copilot.premiumRequests.missingModels.length
    ? `<p class="note">Premium requests are ${copilot.premiumRequests.value == null ? 'unavailable' : 'partial'}: no <code>tokens.premiumMultipliers</code> entry for ${escapeHtml(copilot.premiumRequests.missingModels.join(', '))}.</p>` : '';
  return `<h2>Copilot activity by phase</h2>
<table><thead><tr><th>Phase</th><th>Gens</th><th>Sent back</th><th>Requests</th><th>Turns</th><th>Model calls</th><th>Tool calls</th><th>Premium requests</th><th>Governed prompt</th></tr></thead><tbody>${tableRows}</tbody></table>
<h3>Requests, turns, model and tool calls</h3>
${activityChart}
<h3>Estimated premium requests</h3>
${premiumChart}
<h3>Governed prompt size</h3>
<p class="note">Dashed red line: the phase's prompt budget.</p>
${promptChart}
${events}
${missing}
<p class="note">${codeSpans(escapeHtml(COPILOT_SOURCES))} * marks a count some generations did not report; "unavailable" means none did.</p>`;
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
    report.selfApprovals ? `<p><strong>Governance note:</strong> ${report.selfApprovals} active self-approval${report.selfApprovals === 1 ? '' : 's'}; these are not independent reviews.</p>` : '',
    report.sequenceOverrides.length ? `<p><strong>Governance note:</strong> ${report.sequenceOverrides.length} confirmed soft sequence override${report.sequenceOverrides.length === 1 ? '' : 's'}.</p>` : ''
  ].join('');
  const overrideRows = report.sequenceOverrides.map((override) => `<tr><td>${escapeHtml(override.at)}</td><td>${escapeHtml(override.gate)}</td><td>${escapeHtml(override.action)}</td><td>${escapeHtml(override.requestedPhase ?? override.before?.currentPhase ?? '—')}</td><td>${escapeHtml(actorLabel(override.actor))} / ${escapeHtml(override.agent ?? 'unknown')}</td><td>${escapeHtml(override.reason ?? '—')}</td></tr>`).join('');
  const copilotSection = copilotHtml(report);
  const overrideTable = overrideRows ? `<h2>Soft sequence overrides</h2>\n<table><thead><tr><th>Time</th><th>Gate</th><th>Action</th><th>Phase</th><th>Actor / governed agent</th><th>Reason</th></tr></thead><tbody>${overrideRows}</tbody></table>` : '';
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
${overrideTable}
<footer>Durations are wall-clock elapsed time, including nights and weekends. Generated ${escapeHtml(report.generatedAt)} by singularity-flow.</footer>
</body>
</html>
`;
}
