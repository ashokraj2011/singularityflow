/** Read-only Token Ledger projection over existing phase and Evidence Packet telemetry. */
import {
  combineUsageMetrics, estimateUtf8Tokens, observationCompression,
  providerTokenArithmetic, usageMetric
} from './model-usage-contract.mjs';

function assuranceFor(record) {
  if (record.source === 'copilot-otel') return 'provider-reported';
  if (record.source === 'usage-json') return 'self-reported';
  return record.status === 'unavailable' ? 'unavailable' : 'host-observed';
}

function metricFrom(record, field) {
  const structured = record.observations?.[field];
  if (structured) return usageMetric(structured.value, structured);
  if (!Number.isFinite(record[field])) return usageMetric(null);
  return usageMetric(record[field], {
    status: record[`${field}Status`] ?? 'exact',
    assurance: record[`${field}Assurance`] ?? assuranceFor(record)
  });
}

function modelEntry(record) {
  const inputTokens = metricFrom(record, 'inputTokens');
  const outputTokens = metricFrom(record, 'outputTokens');
  const cachedInputTokens = metricFrom(record, 'cachedInputTokens');
  const cacheWriteInputTokens = metricFrom(record, 'cacheWriteInputTokens');
  const reasoningTokens = metricFrom(record, 'reasoningTokens');
  const providerCost = metricFrom(record, 'providerCost');
  const reportedTotalTokens = metricFrom(record, 'totalTokens');
  const arithmetic = providerTokenArithmetic({
    inputTokens, outputTokens, cachedInputTokens, reasoningTokens,
    reasoningIsSeparate: record.reasoningIsSeparate === true
  });
  const legacyResolved = record.source === 'copilot-otel' && record.model ? record.model : null;
  const resolved = record.resolvedModel ?? legacyResolved;
  let totalProviderTokens = arithmetic.totalProviderTokens;
  if (reportedTotalTokens.value != null && (
    totalProviderTokens.value == null
    || reportedTotalTokens.status === 'exact' && totalProviderTokens.status !== 'exact'
  )) totalProviderTokens = reportedTotalTokens;
  if (reportedTotalTokens.status === 'exact' && totalProviderTokens.status === 'exact'
      && reportedTotalTokens.value !== totalProviderTokens.value) {
    totalProviderTokens = usageMetric(null, { reason: 'reported total conflicts with input/output arithmetic' });
  }
  return Object.freeze({
    provider: record.provider ?? null,
    requested: record.requestedModel ?? null,
    resolved,
    resolvedAssurance: record.resolvedModelAssurance
      ?? (resolved ? 'host-observed' : 'unavailable'),
    source: record.source ?? null,
    generation: record.generation ?? null,
    inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens,
    reasoningTokens, providerCost,
    reportedTotalTokens,
    uncachedInputTokens: arithmetic.uncachedInputTokens,
    totalProviderTokens
  });
}

function packetEntry(record) {
  const compression = observationCompression(record.observationRawBytes, record.observationIncludedBytes);
  return Object.freeze({
    packetId: record.packetId,
    correlation: record.correlation ?? null,
    flightPlanId: record.flightPlanId ?? null,
    phase: record.phase ?? null,
    generation: record.generation ?? null,
    includedBytes: usageMetric(record.includedBytes, { assurance: 'sflow-measured' }),
    estimatedTokens: Number.isFinite(record.estimatedTokens)
      ? usageMetric(record.estimatedTokens, { status: 'estimated', assurance: 'sflow-estimated' })
      : estimateUtf8Tokens(record.includedBytes),
    estimationMethod: record.estimationMethod ?? 'utf8-bytes-divided-by-four',
    omittedItems: record.omittedItems ?? 0,
    omissionClasses: record.omissionClasses ?? {},
    unavailableItems: record.unavailableItems ?? 0,
    unavailableCodes: record.unavailableCodes ?? [],
    expansionRequests: record.expansionRequests ?? 0,
    expandedBytes: Number.isFinite(record.expandedBytes)
      ? usageMetric(record.expandedBytes, { assurance: 'sflow-measured' }) : usageMetric(null),
    expandedEstimatedTokens: Number.isFinite(record.expandedEstimatedTokens)
      ? usageMetric(record.expandedEstimatedTokens, { status: 'estimated', assurance: 'sflow-estimated' })
      : usageMetric(null),
    expansions: record.expansions ?? [],
    observation: {
      rawBytes: Number.isFinite(record.observationRawBytes)
        ? usageMetric(record.observationRawBytes, { assurance: 'sflow-measured' }) : usageMetric(null),
      deliveredBytes: Number.isFinite(record.observationIncludedBytes)
        ? usageMetric(record.observationIncludedBytes, { assurance: 'sflow-measured' }) : usageMetric(null),
      ...compression
    },
    cacheKey: record.cacheKey ?? null,
    contextManifestSha256: record.contextManifestSha256 ?? null,
    cacheManifestId: record.cacheManifestId ?? null,
    tokenEconomy: {
      mode: record.tokenEconomyMode ?? null,
      profile: record.tokenEconomyProfile ?? null,
      configurationDigest: record.tokenEconomyConfigurationDigest ?? null
    },
    itemUsage: record.itemUsage ?? [],
    provider: {
      id: record.provider ?? null,
      requestedModel: record.requestedModel ?? null,
      resolvedModel: record.resolvedModel ?? null,
      resolutionAssurance: record.modelResolutionAssurance ?? 'unavailable',
      captureCoverage: record.captureCoverage ?? 'estimated'
    },
    outcome: record.outcome ?? null
  });
}

function uniqueContextMetric(packets) {
  const unique = new Map();
  for (const packet of packets) {
    for (const item of packet.itemUsage) {
      if (!item.itemDigest || !Number.isFinite(item.estimatedTokens)) continue;
      unique.set(item.itemDigest, Math.max(unique.get(item.itemDigest) ?? 0, item.estimatedTokens));
    }
    for (const expansion of packet.expansions) {
      if (!expansion.subjectDigest || !Number.isFinite(expansion.estimatedTokens)) continue;
      unique.set(expansion.subjectDigest, Math.max(unique.get(expansion.subjectDigest) ?? 0, expansion.estimatedTokens));
    }
  }
  return unique.size
    ? usageMetric([...unique.values()].reduce((total, value) => total + value, 0), {
      status: 'estimated', assurance: 'sflow-estimated'
    })
    : usageMetric(null, { reason: 'packet item digests unavailable' });
}

function coverageSplit(models, packets) {
  const split = { exact: 0, partial: 0, estimated: 0, unavailable: 0 };
  for (const model of models) split[model.totalProviderTokens.status] += 1;
  for (const packet of packets) split[packet.provider.captureCoverage] += 1;
  return Object.freeze(split);
}

export function tokenLedgerProjection(workflow, packetRecords = [], { phase = null } = {}) {
  const selectedPhases = workflow.phaseOrder
    .filter((phaseId) => !phase || phaseId === phase)
    .map((phaseId) => workflow.phases[phaseId])
    .filter(Boolean);
  const models = selectedPhases.flatMap((entry) => entry.usage ?? []).map(modelEntry);
  const packets = packetRecords.filter((record) => !phase || record.phase === phase).map(packetEntry);
  const totals = {
    inputTokens: combineUsageMetrics(models.map((entry) => entry.inputTokens)),
    outputTokens: combineUsageMetrics(models.map((entry) => entry.outputTokens)),
    cachedInputTokens: combineUsageMetrics(models.map((entry) => entry.cachedInputTokens)),
    cacheWriteInputTokens: combineUsageMetrics(models.map((entry) => entry.cacheWriteInputTokens)),
    providerCost: combineUsageMetrics(models.map((entry) => entry.providerCost)),
    totalProviderTokens: combineUsageMetrics(models.map((entry) => entry.totalProviderTokens)),
    sflowIncludedBytes: combineUsageMetrics(packets.map((entry) => entry.includedBytes), { assurance: 'sflow-measured' }),
    sflowEstimatedTokens: combineUsageMetrics(packets.map((entry) => entry.estimatedTokens), { assurance: 'sflow-estimated' }),
    expandedBytes: combineUsageMetrics(packets.map((entry) => entry.expandedBytes), { assurance: 'sflow-measured' }),
    deliveredContextTokens: combineUsageMetrics(packets.flatMap((entry) => [
      entry.estimatedTokens, entry.expandedEstimatedTokens
    ]), { assurance: 'sflow-estimated' }),
    uniqueContextTokens: uniqueContextMetric(packets)
  };
  const arithmetic = providerTokenArithmetic({
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cachedInputTokens: totals.cachedInputTokens
  });
  return Object.freeze({
    schemaVersion: 1, // schema-transient: read-only Token Ledger projection, never persisted
    kind: 'token-ledger',
    workId: workflow.workItem.id,
    phase,
    models,
    packets,
    outcomes: packets.filter((packet) => packet.outcome).map((packet) => Object.freeze({
      packetId: packet.packetId, operationId: packet.correlation?.operationId ?? null,
      ...packet.outcome
    })),
    coverage: coverageSplit(models, packets),
    totals: Object.freeze({ ...totals, uncachedInputTokens: arithmetic.uncachedInputTokens })
  });
}

function offsetLabel(offsetMinutes) {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

/** Resolve one local calendar day to an exact half-open UTC interval. */
export function dailyTokenLedgerPeriod({ now = new Date(), offsetMinutes = null } = {}) {
  const instant = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new TypeError('Daily Token Ledger requires a valid date.');
  const effectiveOffset = offsetMinutes == null ? -instant.getTimezoneOffset() : Number(offsetMinutes);
  if (!Number.isInteger(effectiveOffset) || effectiveOffset < -14 * 60 || effectiveOffset > 14 * 60) {
    throw new TypeError('Daily Token Ledger offset must be an integer from -840 through 840 minutes.');
  }
  const shifted = new Date(instant.getTime() + effectiveOffset * 60 * 1000);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const day = shifted.getUTCDate();
  const start = Date.UTC(year, month, day) - effectiveOffset * 60 * 1000;
  const end = Date.UTC(year, month, day + 1) - effectiveOffset * 60 * 1000;
  return Object.freeze({
    date: `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    timezone: `utc-offset:${offsetLabel(effectiveOffset)}`,
    offsetMinutes: effectiveOffset,
    startAt: new Date(start).toISOString(),
    endAt: new Date(end).toISOString()
  });
}

function withinPeriod(value, period) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    && timestamp >= Date.parse(period.startAt)
    && timestamp < Date.parse(period.endAt);
}

function auditUsageRecord(record) {
  return {
    ...(record.usage ?? {}),
    source: 'model-invocation-audit',
    provider: record.provider ?? null,
    requestedModel: record.requestedModel ?? record.modelSelection?.requestedModel ?? null,
    resolvedModel: record.model ?? record.routing?.resolvedModel ?? null,
    resolvedModelAssurance: record.modelSelection?.assurance ?? 'host-observed',
    generation: record.subject?.generation ?? null
  };
}

/**
 * Aggregate one machine-local day without exposing Story IDs, packet IDs, paths, prompts, model
 * names, or per-person observations. Failed invocations remain counted because they may cost tokens.
 */
export function dailyTokenLedgerProjection(modelRecords = [], packetRecords = [], {
  period = dailyTokenLedgerPeriod()
} = {}) {
  const models = modelRecords.filter((record) => withinPeriod(record.startedAt, period));
  const packets = packetRecords.filter((record) => withinPeriod(record.recordedAt, period));
  const ledger = tokenLedgerProjection({
    workItem: { id: 'machine-local-day' },
    phaseOrder: ['daily'],
    phases: { daily: { usage: models.map(auditUsageRecord) } }
  }, packets);
  const statusCounts = { completed: 0, failed: 0, interrupted: 0, started: 0, other: 0 };
  for (const record of models) {
    const status = Object.hasOwn(statusCounts, record.status) ? record.status : 'other';
    statusCounts[status] += 1;
  }
  return Object.freeze({
    schemaVersion: 1, // schema-transient: read-only daily Token Ledger projection
    kind: 'daily-token-ledger',
    period: Object.freeze({ ...period }),
    activity: Object.freeze({
      modelInvocations: models.length,
      contextPackets: packets.length,
      undatedInvocationsExcluded: modelRecords.filter((record) => !Number.isFinite(Date.parse(record.startedAt))).length,
      legacyPacketsExcluded: packetRecords.filter((record) => !record.recordedAt).length,
      invocationStatuses: Object.freeze(statusCounts)
    }),
    coverage: ledger.coverage,
    totals: ledger.totals,
    privacy: Object.freeze({
      contentFree: true,
      excludes: Object.freeze([
        'prompts', 'responses', 'paths', 'work-ids', 'packet-ids', 'git-identities', 'model-names'
      ])
    })
  });
}

function metricText(metric, suffix = 'tokens') {
  if (!metric || metric.status === 'unavailable') return 'unavailable';
  return `${metric.value.toLocaleString('en-US')} ${suffix} · ${metric.status} · ${metric.assurance}`;
}

export function tokenLedgerText(ledger) {
  if (ledger.kind === 'daily-token-ledger') {
    return [
      `TOKEN LEDGER · ${ledger.period.date} · ${ledger.period.timezone}`,
      '',
      `Provider input       ${metricText(ledger.totals.inputTokens)}`,
      `Provider output      ${metricText(ledger.totals.outputTokens)}`,
      `Provider cached      ${metricText(ledger.totals.cachedInputTokens)}`,
      `Provider total       ${metricText(ledger.totals.totalProviderTokens)}`,
      `SFlow packet context ${metricText(ledger.totals.sflowEstimatedTokens, 'estimated tokens')}`,
      `Delivered context    ${metricText(ledger.totals.deliveredContextTokens, 'estimated tokens')}`,
      `Unique context       ${metricText(ledger.totals.uniqueContextTokens, 'estimated tokens')}`,
      '',
      `Invocations: ${ledger.activity.modelInvocations} · Packets: ${ledger.activity.contextPackets}`,
      `Invocation outcomes: completed ${ledger.activity.invocationStatuses.completed} · failed ${ledger.activity.invocationStatuses.failed} · interrupted ${ledger.activity.invocationStatuses.interrupted} · active ${ledger.activity.invocationStatuses.started}`,
      `Coverage: exact ${ledger.coverage.exact} · partial ${ledger.coverage.partial} · estimated ${ledger.coverage.estimated} · unavailable ${ledger.coverage.unavailable}`,
      ...(ledger.activity.legacyPacketsExcluded
        ? [`Historical packets without timestamps excluded: ${ledger.activity.legacyPacketsExcluded}`] : []),
      ...(ledger.activity.undatedInvocationsExcluded
        ? [`Historical invocations without timestamps excluded: ${ledger.activity.undatedInvocationsExcluded}`] : []),
      'Content-free machine-local aggregate; no prompts, paths, Story IDs, identities, or model names.'
    ].join('\n');
  }
  const lines = [
    `TOKEN LEDGER · ${ledger.workId}${ledger.phase ? ` · ${ledger.phase}` : ''}`,
    '',
    `Provider input       ${metricText(ledger.totals.inputTokens)}`,
    `Provider output      ${metricText(ledger.totals.outputTokens)}`,
    `Provider cached      ${metricText(ledger.totals.cachedInputTokens)}`,
    `Provider uncached    ${metricText(ledger.totals.uncachedInputTokens)}`,
    `Provider total       ${metricText(ledger.totals.totalProviderTokens)}`,
    `SFlow packet context ${metricText(ledger.totals.sflowEstimatedTokens, 'estimated tokens')}`,
    `Delivered context    ${metricText(ledger.totals.deliveredContextTokens, 'estimated tokens')}`,
    `Unique context       ${metricText(ledger.totals.uniqueContextTokens, 'estimated tokens')}`,
    `SFlow expansions     ${metricText(ledger.totals.expandedBytes, 'bytes')}`,
    '',
    `Models: ${ledger.models.length || 'none'} · Packets: ${ledger.packets.length}`,
    `Coverage: exact ${ledger.coverage.exact} · partial ${ledger.coverage.partial} · estimated ${ledger.coverage.estimated} · unavailable ${ledger.coverage.unavailable}`
  ];
  for (const model of ledger.models) {
    lines.push(`- ${model.provider ?? 'provider unavailable'} · requested ${model.requested ?? 'unavailable'} · resolved ${model.resolved ?? 'unavailable'} (${model.resolvedAssurance})`);
  }
  return lines.join('\n');
}
