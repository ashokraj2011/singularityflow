import { nowIso } from './util.mjs';

const DECISION_EVENTS = new Set(['phase_approved', 'phase_self_approved', 'phase_rejected']);

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
      cost: 0,
      pricedRecords: 0,
      fullyPricedRecords: 0,
      providerCostRecords: 0,
      configuredPriceRecords: 0
    };
    aggregate.records += 1;
    aggregate[record.status === 'exact' ? 'exactRecords' : 'unavailableRecords'] += 1;
    aggregate.totalTokens += record.totalTokens ?? 0;
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
    cost: aggregate.pricedRecords ? aggregate.cost : null,
    costStatus: !aggregate.pricedRecords
      ? 'unavailable'
      : aggregate.fullyPricedRecords === aggregate.records ? 'exact' : 'partial'
  })).sort((left, right) => `${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`));
}

export function deriveReport(workflow, { pricing = null, now = nowIso() } = {}) {
  const reportTime = timestamp(now);
  const history = [...(workflow.history ?? [])].sort(compareEvents);
  const phases = workflow.phaseOrder.map((id) => {
    const phase = workflow.phases[id];
    const events = phaseEvents(history, id);
    const wait = waitingTime(events, reportTime);
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
      .map((event) => ({ at: event.at, actor: actorLabel(event.actor), persona: event.persona, detail: event.detail ?? '' }));
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
      generations: phase.generation ?? 0,
      elapsedMs: window.elapsedMs,
      activeMs,
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
      personas: [...new Set(usage.map((record) => record.persona).filter(Boolean))],
      cost: costs.length ? costs.reduce((sum, item) => sum + item.value, 0) : null,
      costStatus: !pricedRecords ? 'unavailable' : fullyPricedRecords === usage.length ? 'exact' : 'partial',
      checks,
      cycles: wait.cycles
    };
  });

  const startCandidates = [timestamp(history[0]?.at), ...workflow.phaseOrder.map((id) => timestamp(workflow.phases[id].startedAt))].filter((value) => value != null);
  const startedAt = startCandidates.length ? Math.min(...startCandidates) : null;
  const approvalTimes = workflow.phaseOrder.map((id) => timestamp(workflow.phases[id].approvedAt)).filter((value) => value != null);
  const completedAt = workflow.status === 'complete' && approvalTimes.length ? Math.max(...approvalTimes) : null;
  const effectiveEnd = completedAt ?? reportTime;
  const elapsedMs = startedAt != null && effectiveEnd != null && effectiveEnd >= startedAt ? effectiveEnd - startedAt : null;
  const waitingMs = phases.reduce((sum, phase) => sum + (phase.waitingMs ?? 0), 0);
  const costValues = phases.map((phase) => phase.cost).filter((value) => value != null);
  const costPhases = phases.filter((phase) => phase.usageRecords > 0);
  const allUsage = workflow.phaseOrder.flatMap((id) => workflow.phases[id].usage ?? []);
  const modelUsage = usageByModel(allUsage, pricing);
  const pricedRecords = modelUsage.reduce((sum, item) => sum + item.pricedRecords, 0);
  const fullyPricedRecords = modelUsage.reduce((sum, item) => sum + item.fullyPricedRecords, 0);
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
    reworkCycles: phases.reduce((sum, phase) => sum + Math.max(0, phase.generations - 1), 0),
    rejections: phases.flatMap((phase) => phase.rejections.map((item) => ({ phase: phase.id, ...item }))),
    selfApprovals: phases.reduce((sum, phase) => sum + phase.selfApprovals, 0),
    sequenceOverrides: workflow.sequenceOverrides ?? [],
    tokens: {
      total: phases.reduce((sum, phase) => sum + phase.tokens, 0),
      exactRecords: workflow.usage?.exactRecords ?? null,
      unavailableRecords: workflow.usage?.unavailableRecords ?? null,
      byPersona: workflow.usage?.byPersona ?? {},
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

export function renderMarkdown(report) {
  const item = report.workItem;
  const lines = [`# ${item.id}${item.title ? ` — ${item.title}` : ''}${item.workType ? ` (${item.workType})` : ''}`, ''];
  lines.push([
    report.completedAt ? `Completed in ${humanizeDuration(report.elapsedMs)}` : `In progress for ${humanizeDuration(report.elapsedMs)}`,
    `${report.phases.length} phases`,
    `${report.reworkCycles} rework cycle${report.reworkCycles === 1 ? '' : 's'}`,
    `${report.tokens.total.toLocaleString('en-US')} exact tokens${report.cost != null ? ` (~${money(report.cost)}${report.costStatus === 'partial' ? ', partial pricing' : ''})` : ''}`
  ].join(' · '), '');
  lines.push('| Phase | Status | Active | Waiting | Gens | Provider / model | Tokens | Cost |');
  lines.push('|-------|--------|--------|---------|------|------------------|--------|------|');
  for (const phase of report.phases) {
    lines.push(`| ${phase.label} (\`${phase.id}\`) | ${phase.status} | ${humanizeDuration(phase.activeMs)} | ${humanizeDuration(phase.waitingMs)} | ${phase.generations} | ${modelCell(phase)} | ${tokenCell(phase)} | ${costCell(phase)} |`);
  }
  lines.push('');
  if (report.bottleneck) {
    const share = report.bottleneck.share != null ? `, ${report.bottleneck.share}% of elapsed` : '';
    lines.push(`**Bottleneck:** approval latency on \`${report.bottleneck.phase}\` (${humanizeDuration(report.bottleneck.waitingMs)}${share}).`, '');
  }
  if (report.selfApprovals) lines.push(`**Governance note:** ${report.selfApprovals} active self-approval${report.selfApprovals === 1 ? '' : 's'}; these are not independent reviews.`, '');
  if (report.sequenceOverrides.length) lines.push(`**Governance note:** ${report.sequenceOverrides.length} confirmed soft sequence override${report.sequenceOverrides.length === 1 ? '' : 's'}; review the audit details below.`, '');
  if (report.rejections.length) {
    lines.push('## Rework history', '');
    for (const rejection of report.rejections) lines.push(`- ${rejection.at} — \`${rejection.phase}\` rejected by ${rejection.actor} (${rejection.persona ?? 'unknown persona'}): ${rejection.detail}`);
    lines.push('');
  }
  if (report.sequenceOverrides.length) {
    lines.push('## Soft sequence overrides', '', '| Time | Gate | Action | Phase | Actor / persona | Reason |', '|------|------|--------|-------|-----------------|--------|');
    for (const override of report.sequenceOverrides) {
      const actor = actorLabel(override.actor);
      lines.push(`| ${override.at} | ${override.gate} | ${override.action} | ${override.requestedPhase ?? override.before?.currentPhase ?? '—'} | ${actor} / ${override.persona ?? 'unknown'} | ${override.reason ?? '—'} |`);
    }
    lines.push('');
  }
  const personas = Object.entries(report.tokens.byPersona);
  if (personas.length) {
    lines.push('## Token usage by persona', '', '| Persona | Records | Exact | Tokens |', '|---------|---------|-------|--------|');
    for (const [persona, aggregate] of personas) lines.push(`| ${persona} | ${aggregate.records} | ${aggregate.exactRecords} | ${aggregate.totalTokens.toLocaleString('en-US')} |`);
    lines.push('');
  }
  if (report.tokens.byModel.length) {
    lines.push('## Token usage by model', '', '| Provider | Model | Records | Exact | Unavailable | Tokens |', '|----------|-------|---------|-------|-------------|--------|');
    for (const aggregate of report.tokens.byModel) lines.push(`| ${aggregate.provider} | ${aggregate.model} | ${aggregate.records} | ${aggregate.exactRecords} | ${aggregate.unavailableRecords} | ${aggregate.totalTokens.toLocaleString('en-US')} |`);
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

function barChart(rows, { valueKey, labelKey, formatValue, color }) {
  const max = Math.max(...rows.map((row) => row[valueKey] ?? 0), 1);
  const barHeight = 22;
  const gap = 8;
  const labelWidth = 170;
  const chartWidth = 420;
  const height = rows.length * (barHeight + gap);
  const bars = rows.map((row, index) => {
    const value = row[valueKey] ?? 0;
    const width = Math.max(2, Math.round((value / max) * chartWidth));
    const y = index * (barHeight + gap);
    return `<text x="0" y="${y + 15}" font-size="12" fill="#333">${escapeHtml(row[labelKey])}</text><rect x="${labelWidth}" y="${y}" width="${width}" height="${barHeight}" rx="3" fill="${color}"></rect><text x="${labelWidth + width + 6}" y="${y + 15}" font-size="12" fill="#555">${escapeHtml(formatValue(value))}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${labelWidth + chartWidth + 90} ${height}" width="100%" height="${height}" xmlns="http://www.w3.org/2000/svg" role="img">${bars}</svg>`;
}

export function renderHtml(report) {
  const item = report.workItem;
  const elapsedChart = barChart(report.phases, { valueKey: 'elapsedMs', labelKey: 'label', formatValue: humanizeDuration, color: '#4f6df5' });
  const tokenChart = barChart(report.phases, { valueKey: 'tokens', labelKey: 'label', formatValue: (value) => value.toLocaleString('en-US'), color: '#2fa66a' });
  const rows = report.phases.map((phase) => `<tr><td>${escapeHtml(phase.label)}</td><td>${escapeHtml(phase.status)}</td><td>${humanizeDuration(phase.activeMs)}</td><td>${humanizeDuration(phase.waitingMs)}</td><td>${phase.generations}</td><td>${escapeHtml(modelCell(phase))}</td><td>${escapeHtml(tokenCell(phase))}</td><td>${escapeHtml(costCell(phase))}</td></tr>`).join('');
  const modelRows = report.tokens.byModel.map((aggregate) => `<tr><td>${escapeHtml(aggregate.provider)}</td><td>${escapeHtml(aggregate.model)}</td><td>${aggregate.records}</td><td>${aggregate.exactRecords}</td><td>${aggregate.unavailableRecords}</td><td>${aggregate.totalTokens.toLocaleString('en-US')}</td></tr>`).join('');
  const modelTable = modelRows ? `<h2>Token usage by model</h2>\n<table><thead><tr><th>Provider</th><th>Model</th><th>Records</th><th>Exact</th><th>Unavailable</th><th>Tokens</th></tr></thead><tbody>${modelRows}</tbody></table>` : '';
  const bottleneck = report.bottleneck ? `<p><strong>Bottleneck:</strong> approval latency on <code>${escapeHtml(report.bottleneck.phase)}</code> (${humanizeDuration(report.bottleneck.waitingMs)}${report.bottleneck.share != null ? `, ${report.bottleneck.share}% of elapsed` : ''}).</p>` : '';
  const governance = [
    report.selfApprovals ? `<p><strong>Governance note:</strong> ${report.selfApprovals} active self-approval${report.selfApprovals === 1 ? '' : 's'}; these are not independent reviews.</p>` : '',
    report.sequenceOverrides.length ? `<p><strong>Governance note:</strong> ${report.sequenceOverrides.length} confirmed soft sequence override${report.sequenceOverrides.length === 1 ? '' : 's'}.</p>` : ''
  ].join('');
  const overrideRows = report.sequenceOverrides.map((override) => `<tr><td>${escapeHtml(override.at)}</td><td>${escapeHtml(override.gate)}</td><td>${escapeHtml(override.action)}</td><td>${escapeHtml(override.requestedPhase ?? override.before?.currentPhase ?? '—')}</td><td>${escapeHtml(actorLabel(override.actor))} / ${escapeHtml(override.persona ?? 'unknown')}</td><td>${escapeHtml(override.reason ?? '—')}</td></tr>`).join('');
  const overrideTable = overrideRows ? `<h2>Soft sequence overrides</h2>\n<table><thead><tr><th>Time</th><th>Gate</th><th>Action</th><th>Phase</th><th>Actor / persona</th><th>Reason</th></tr></thead><tbody>${overrideRows}</tbody></table>` : '';
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
</style>
</head>
<body>
<h1>${escapeHtml(item.id)}${item.title ? ` — ${escapeHtml(item.title)}` : ''}</h1>
<p>${report.completedAt ? `Completed in ${humanizeDuration(report.elapsedMs)}` : `In progress for ${humanizeDuration(report.elapsedMs)}`} · ${report.reworkCycles} rework cycle${report.reworkCycles === 1 ? '' : 's'} · ${report.tokens.total.toLocaleString('en-US')} exact tokens${report.cost != null ? ` (~${money(report.cost)}${report.costStatus === 'partial' ? ', partial pricing' : ''})` : ''}</p>
${bottleneck}
${governance}
<h2>Phases</h2>
<table><thead><tr><th>Phase</th><th>Status</th><th>Active</th><th>Waiting</th><th>Gens</th><th>Provider / model</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Elapsed time by phase</h2>
${elapsedChart}
<h2>Tokens by phase</h2>
${tokenChart}
${modelTable}
${overrideTable}
<footer>Durations are wall-clock elapsed time, including nights and weekends. Generated ${escapeHtml(report.generatedAt)} by singularity-flow.</footer>
</body>
</html>
`;
}
