/** Content-free, machine-local Evidence Packet usage telemetry. */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { gitCommonDir } from './git.mjs';
import { recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { nowIso, writeAtomic } from './util.mjs';

function telemetryRoot(root) { return path.join(gitCommonDir(root), 'singularity-flow', 'evidence-packets', 'telemetry'); }
function telemetryFile(root, packetId) { return path.join(telemetryRoot(root), `${packetId}.json`); }

const ALLOWED = new Set([
  'schemaVersion', 'packetId', 'workId', 'flightPlanId', 'phase', 'generation',
  'sourceRevision', 'includedBytes', 'estimatedTokens', 'estimationMethod',
  'omittedItems', 'omissionClasses', 'unavailableItems', 'unavailableCodes',
  'expansionRequests', 'expandedBytes', 'expandedEstimatedTokens', 'expansions',
  'observationRawBytes', 'observationIncludedBytes', 'cacheKey', 'contextManifestSha256',
  'providerInputTokens', 'providerCachedInputTokens', 'provider', 'requestedModel',
  'resolvedModel', 'modelResolutionAssurance', 'captureCoverage', 'correlation',
  'tokenEconomyMode', 'tokenEconomyProfile', 'tokenEconomyConfigurationDigest',
  'cacheManifestId', 'itemUsage', 'knowledge', 'outcome'
]);

function contentFree(record) {
  const unknown = Object.keys(record).filter((key) => !ALLOWED.has(key));
  if (unknown.length) throw new Error(`Context packet telemetry contains disallowed fields: ${unknown.join(', ')}`);
  return record;
}

function omissionCount(omissions) {
  return omissions.reduce((total, entry) => total + (Number.isInteger(entry.count) ? entry.count : 1), 0);
}

function omissionClasses(omissions) {
  const totals = {};
  for (const entry of omissions) {
    for (const [name, count] of Object.entries(entry.omissionClasses ?? {})) {
      totals[name] = Number(totals[name] ?? 0) + Number(count ?? 0);
    }
  }
  return totals;
}

function knowledgeEntry(entry = {}) {
  return {
    recordSha256: entry.recordSha256 ?? null,
    kind: entry.kind ?? null,
    reasonCode: entry.reasonCode ?? null,
    explanation: entry.explanation ?? null,
    provenanceSha256: entry.provenanceSha256 ?? null,
    provenanceReferences: (entry.provenanceReferences ?? []).map((reference) => ({
      workId: reference.workId ?? null,
      artifact: reference.artifact ?? null,
      artifactSha256: reference.artifactSha256 ?? null,
      approvedRevision: reference.approvedRevision ?? null
    })),
    provenanceReferenceCount: Number.isInteger(entry.provenanceReferenceCount)
      ? entry.provenanceReferenceCount : null,
    provenanceReferencesTruncated: Number.isInteger(entry.provenanceReferencesTruncated)
      ? entry.provenanceReferencesTruncated : null,
    provenanceReferenceLimit: Number.isInteger(entry.provenanceReferenceLimit)
      ? entry.provenanceReferenceLimit : null,
    validity: entry.validity ? {
      status: entry.validity.status ?? 'unavailable',
      validFrom: entry.validity.validFrom ?? null,
      validUntil: entry.validity.validUntil ?? null
    } : { status: 'unavailable', validFrom: null, validUntil: null },
    scopeMatch: typeof entry.scopeMatch === 'boolean' ? entry.scopeMatch : null,
    supersession: entry.supersession ? {
      status: entry.supersession.status ?? 'unavailable',
      supersededBy: entry.supersession.supersededBy ?? null
    } : { status: 'unavailable', supersededBy: null },
    representation: entry.representation ?? null,
    bytes: Number.isFinite(entry.bytes) ? entry.bytes : null,
    tokens: Number.isFinite(entry.tokens) ? entry.tokens : null,
    tokenCountStatus: entry.tokenCountStatus ?? 'unavailable'
  };
}

function knowledgeTelemetry(value) {
  if (!value) {
    return {
      schemaVersion: 1,
      resultType: 'bounded-knowledge-projection',
      recallEngine: null,
      status: 'not-enrolled',
      authority: 'unavailable',
      limits: null,
      selected: [],
      omitted: [],
      omissions: { total: 0, byReason: {}, detail: null, omittedSetSha256: null },
      guidance: null,
      manifestSha256: null
    };
  }
  return {
    schemaVersion: value.schemaVersion ?? 1,
    resultType: value.resultType ?? 'bounded-knowledge-projection',
    recallEngine: value.recallEngine ?? null,
    status: value.status ?? 'unavailable',
    authority: value.authority ?? 'untrusted-guidance-only',
    limits: value.limits ? {
      maxEntries: value.limits.maxEntries ?? null,
      maxBytes: value.limits.maxBytes ?? null,
      maxOmissionDetails: value.limits.maxOmissionDetails ?? null,
      maxProvenanceReferences: value.limits.maxProvenanceReferences ?? null
    } : null,
    selected: (value.selected ?? []).map(knowledgeEntry),
    omitted: (value.omitted ?? []).map(knowledgeEntry),
    omissions: {
      total: Number(value.omissions?.total ?? 0),
      byReason: Object.fromEntries(Object.entries(value.omissions?.byReason ?? {})
        .map(([reason, count]) => [reason, Number(count)])),
      detail: value.omissions?.detail ? {
        limit: Number(value.omissions.detail.limit ?? 0),
        retained: Number(value.omissions.detail.retained ?? 0),
        truncated: Number(value.omissions.detail.truncated ?? 0),
        complete: value.omissions.detail.complete === true
      } : null,
      omittedSetSha256: value.omissions?.omittedSetSha256 ?? null
    },
    guidance: value.guidance ? {
      trust: value.guidance.trust ?? 'untrusted-data',
      representation: value.guidance.representation ?? null,
      entries: Number(value.guidance.entries ?? 0),
      bytes: Number(value.guidance.bytes ?? 0)
    } : null,
    manifestSha256: value.manifestSha256 ?? null
  };
}

export async function recordContextPacketTelemetry(root, packet, { providerTelemetry = null } = {}) {
  const observation = packet.observation ?? null;
  const providerObserved = providerTelemetry?.source === 'provider';
  const prior = await readFile(telemetryFile(root, packet.packetId))
    .then((bytes) => readRecord('context-packet-telemetry', bytes).record)
    .catch(() => null);
  const record = contentFree({
    schemaVersion: currentSchemaVersion('context-packet-telemetry'),
    packetId: packet.packetId,
    workId: packet.binding.workId ?? null,
    flightPlanId: packet.binding.flightPlanId ?? null,
    phase: packet.binding.phase ?? null,
    generation: packet.binding.generation ?? null,
    sourceRevision: packet.binding.sourceRevision ?? null,
    includedBytes: packet.budget.includedContentBytes,
    estimatedTokens: packet.budget.estimatedInputTokens,
    estimationMethod: packet.budget.estimationMethod,
    omittedItems: omissionCount(packet.omissions),
    omissionClasses: omissionClasses(packet.omissions),
    unavailableItems: packet.unavailable.length,
    unavailableCodes: [...new Set(packet.unavailable.map((entry) => entry.code).filter(Boolean))].sort(),
    expansionRequests: Number(prior?.expansionRequests ?? 0),
    expandedBytes: prior ? prior.expandedBytes ?? null : 0,
    expandedEstimatedTokens: prior ? prior.expandedEstimatedTokens ?? null : 0,
    expansions: prior?.expansions ?? [],
    observationRawBytes: observation?.rawBytes ?? null,
    observationIncludedBytes: observation?.includedBytes ?? null,
    cacheKey: packet.contextManifest.cacheKey,
    contextManifestSha256: recordSha256(packet.contextManifest),
    providerInputTokens: providerObserved && Number.isFinite(providerTelemetry.inputTokens)
      ? providerTelemetry.inputTokens : prior?.providerInputTokens ?? null,
    providerCachedInputTokens: providerObserved && Number.isFinite(providerTelemetry.cachedInputTokens)
      ? providerTelemetry.cachedInputTokens : prior?.providerCachedInputTokens ?? null,
    provider: providerTelemetry?.provider ?? prior?.provider ?? null,
    requestedModel: providerTelemetry?.requestedModel ?? prior?.requestedModel ?? null,
    resolvedModel: providerTelemetry?.resolvedModel ?? prior?.resolvedModel ?? null,
    modelResolutionAssurance: providerTelemetry?.resolvedModel
      ? providerTelemetry.modelResolutionAssurance ?? (providerObserved ? 'provider-reported' : 'host-observed')
      : prior?.modelResolutionAssurance ?? 'unavailable',
    captureCoverage: providerObserved && Number.isFinite(providerTelemetry.inputTokens)
      ? 'partial' : prior?.captureCoverage ?? 'estimated',
    correlation: structuredClone(packet.correlation ?? {
      workspaceId: null, storyId: packet.binding.workId ?? null,
      workType: packet.binding.workType ?? null, phase: packet.binding.phase ?? null,
      generation: packet.binding.generation ?? null, intervalId: packet.binding.intervalId ?? null,
      goalId: null, flightPlanId: packet.binding.flightPlanId ?? null,
      operationId: packet.binding.operationId ?? null, packetId: packet.packetId,
      launchId: null, sessionId: null
    }),
    tokenEconomyMode: packet.tokenEconomy?.mode ?? packet.binding.tokenEconomyMode ?? null,
    tokenEconomyProfile: packet.tokenEconomy?.profile ?? packet.binding.tokenEconomyProfile ?? null,
    tokenEconomyConfigurationDigest: packet.tokenEconomy?.configurationDigest
      ?? packet.binding.tokenEconomyConfigurationDigest ?? null,
    cacheManifestId: packet.contextManifest.cacheManifestId ?? null,
    itemUsage: (packet.items ?? []).map((item) => ({
      itemDigest: recordSha256({ itemId: item.itemId }),
      bytes: item.bytes,
      estimatedTokens: Number.isFinite(item.estimatedTokens) ? item.estimatedTokens : Math.ceil(item.bytes / 4),
      mandatory: item.mandatory === true,
      cacheClass: item.cacheClass ?? 'variable'
    })),
    // Explicit projection: the untrusted guidance payload is intentionally not a telemetry field.
    knowledge: knowledgeTelemetry(packet.knowledge),
    outcome: packet.outcome ? {
      ...structuredClone(packet.outcome),
      contextExpansions: Number(prior?.outcome?.contextExpansions ?? packet.outcome.contextExpansions ?? 0)
    } : prior?.outcome ?? null
  });
  await writeAtomic(telemetryFile(root, packet.packetId), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return record;
}

export async function recordContextExpansionRequest(root, packetId, {
  handleKind = 'unknown', itemId = null, includedBytes = null,
  estimatedTokens = null, expandedAt = nowIso()
} = {}) {
  let record;
  try { record = readRecord('context-packet-telemetry', await readFile(telemetryFile(root, packetId))).record; }
  catch { return null; }
  const requestIndex = Number(record.expansionRequests ?? 0) + 1;
  const bytes = Number.isFinite(includedBytes) ? includedBytes : 0;
  const tokens = Number.isFinite(estimatedTokens) ? estimatedTokens : Math.ceil(bytes / 4);
  const expansion = {
    expansionId: `expand-${recordSha256({ packetId, requestIndex, handleKind, itemId, bytes }).slice(0, 20)}`,
    handleKind,
    subjectDigest: itemId == null ? null : recordSha256({ itemId }),
    includedBytes: bytes,
    estimatedTokens: tokens,
    expandedAt
  };
  const next = contentFree({
    ...record,
    expansionRequests: requestIndex,
    expandedBytes: record.expandedBytes == null ? null : Number(record.expandedBytes) + bytes,
    expandedEstimatedTokens: record.expandedEstimatedTokens == null
      ? null : Number(record.expandedEstimatedTokens) + tokens,
    expansions: [...(record.expansions ?? []), expansion].slice(-128),
    outcome: record.outcome ? {
      ...record.outcome,
      contextExpansions: Number(record.outcome.contextExpansions ?? 0) + 1
    } : null
  });
  await writeAtomic(telemetryFile(root, packetId), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

export async function contextPacketTelemetryRecords(root, {
  workId = null, phase = null, packetId = null
} = {}) {
  const names = await readdir(telemetryRoot(root)).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
  const records = [];
  for (const name of names.filter((value) => /^ctx-[a-f0-9]{20}\.json$/.test(value))) {
    const record = await readFile(path.join(telemetryRoot(root), name))
      .then((bytes) => readRecord('context-packet-telemetry', bytes).record)
      .catch(() => null);
    if (!record) continue;
    if (workId && record.workId !== workId) continue;
    if (phase && record.phase !== phase) continue;
    if (packetId && record.packetId !== packetId) continue;
    records.push(record);
  }
  records.sort((left, right) => left.packetId.localeCompare(right.packetId));
  return records;
}

export async function contextPacketTelemetryForWork(root, workId) {
  const records = await contextPacketTelemetryRecords(root, { workId });
  return {
    packets: records.length,
    includedBytes: records.reduce((total, record) => total + Number(record.includedBytes ?? 0), 0),
    estimatedTokens: records.reduce((total, record) => total + Number(record.estimatedTokens ?? 0), 0),
    expansionRequests: records.reduce((total, record) => total + Number(record.expansionRequests ?? 0), 0),
    expandedBytes: records.every((record) => Number.isFinite(record.expandedBytes))
      ? records.reduce((total, record) => total + record.expandedBytes, 0) : null,
    expandedEstimatedTokens: records.every((record) => Number.isFinite(record.expandedEstimatedTokens))
      ? records.reduce((total, record) => total + record.expandedEstimatedTokens, 0) : null,
    providerInputTokens: records.length && records.every((record) => Number.isFinite(record.providerInputTokens))
      ? records.reduce((total, record) => total + record.providerInputTokens, 0) : null,
    providerCachedInputTokens: records.length && records.every((record) => Number.isFinite(record.providerCachedInputTokens))
      ? records.reduce((total, record) => total + record.providerCachedInputTokens, 0) : null
  };
}
