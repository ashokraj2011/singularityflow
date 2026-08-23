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

function metricText(metric, suffix = 'tokens') {
  if (!metric || metric.status === 'unavailable') return 'unavailable';
  return `${metric.value.toLocaleString('en-US')} ${suffix} · ${metric.status} · ${metric.assurance}`;
}

export function tokenLedgerText(ledger) {
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
