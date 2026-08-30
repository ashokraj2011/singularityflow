/** Read-only Context X-Ray projection. It never reconciles, expands context, or invokes a model. */
import { contextPacketTelemetryRecords } from './context-packet-telemetry.mjs';
import { listTelemetryLaunches } from './telemetry-provision.mjs';
import { tokenLedgerProjection } from './token-ledger.mjs';
import { SingularityFlowError } from './util.mjs';

function unavailable(code, reason, action) {
  return Object.freeze({ code, reason, action });
}

function knowledgeEntry(entry = {}) {
  return Object.freeze({
    recordSha256: entry.recordSha256 ?? null,
    kind: entry.kind ?? null,
    reasonCode: entry.reasonCode ?? null,
    explanation: entry.explanation ?? null,
    provenanceSha256: entry.provenanceSha256 ?? null,
    provenanceReferences: Object.freeze((entry.provenanceReferences ?? []).map((reference) => Object.freeze({
      workId: reference.workId ?? null,
      artifact: reference.artifact ?? null,
      artifactSha256: reference.artifactSha256 ?? null,
      approvedRevision: reference.approvedRevision ?? null
    }))),
    provenanceReferenceCount: Number.isInteger(entry.provenanceReferenceCount)
      ? entry.provenanceReferenceCount : null,
    provenanceReferencesTruncated: Number.isInteger(entry.provenanceReferencesTruncated)
      ? entry.provenanceReferencesTruncated : null,
    provenanceReferenceLimit: Number.isInteger(entry.provenanceReferenceLimit)
      ? entry.provenanceReferenceLimit : null,
    validity: Object.freeze({
      status: entry.validity?.status ?? 'unavailable',
      validFrom: entry.validity?.validFrom ?? null,
      validUntil: entry.validity?.validUntil ?? null
    }),
    scopeMatch: typeof entry.scopeMatch === 'boolean' ? entry.scopeMatch : null,
    supersession: Object.freeze({
      status: entry.supersession?.status ?? 'unavailable',
      supersededBy: entry.supersession?.supersededBy ?? null
    }),
    representation: entry.representation ?? null,
    bytes: Number.isFinite(entry.bytes) ? entry.bytes : null,
    tokens: Number.isFinite(entry.tokens) ? entry.tokens : null,
    tokenCountStatus: entry.tokenCountStatus ?? 'unavailable'
  });
}

function knowledgeProjection(records) {
  const packets = records.filter((record) => record.knowledge
    && (record.knowledge.limits || record.knowledge.manifestSha256
      || record.knowledge.selected?.length || record.knowledge.omitted?.length)).map((record) => {
    const knowledge = record.knowledge;
    return Object.freeze({
      packetId: record.packetId,
      status: knowledge.status ?? 'unavailable',
      authority: knowledge.authority ?? 'untrusted-guidance-only',
      limits: knowledge.limits ? Object.freeze({
        maxEntries: knowledge.limits.maxEntries ?? null,
        maxBytes: knowledge.limits.maxBytes ?? null,
        maxOmissionDetails: knowledge.limits.maxOmissionDetails ?? null,
        maxProvenanceReferences: knowledge.limits.maxProvenanceReferences ?? null
      }) : null,
      selected: Object.freeze((knowledge.selected ?? []).map(knowledgeEntry)),
      omitted: Object.freeze((knowledge.omitted ?? []).map(knowledgeEntry)),
      omissions: Object.freeze({
        total: Number(knowledge.omissions?.total ?? 0),
        byReason: Object.freeze({ ...(knowledge.omissions?.byReason ?? {}) }),
        detail: knowledge.omissions?.detail ? Object.freeze({
          limit: Number(knowledge.omissions.detail.limit ?? 0),
          retained: Number(knowledge.omissions.detail.retained ?? 0),
          truncated: Number(knowledge.omissions.detail.truncated ?? 0),
          complete: knowledge.omissions.detail.complete === true
        }) : null,
        omittedSetSha256: knowledge.omissions?.omittedSetSha256 ?? null
      }),
      guidance: knowledge.guidance ? Object.freeze({
        trust: knowledge.guidance.trust ?? 'untrusted-data',
        representation: knowledge.guidance.representation ?? null,
        entries: Number(knowledge.guidance.entries ?? 0),
        bytes: Number(knowledge.guidance.bytes ?? 0)
      }) : null,
      manifestSha256: knowledge.manifestSha256 ?? null
    });
  });
  const byReason = {};
  for (const packet of packets) {
    for (const [reason, count] of Object.entries(packet.omissions.byReason)) {
      byReason[reason] = Number(byReason[reason] ?? 0) + Number(count ?? 0);
    }
  }
  return Object.freeze({
    packets: Object.freeze(packets),
    selected: packets.reduce((total, packet) => total + packet.selected.length, 0),
    omitted: packets.reduce((total, packet) => total + packet.omissions.total, 0),
    byReason: Object.freeze(Object.fromEntries(Object.entries(byReason).sort(([left], [right]) => left.localeCompare(right))))
  });
}

export async function contextXray(root, workflow, {
  phase = null, packetId = null, defaultToCurrentPhase = true
} = {}) {
  const selectedPhase = phase ?? (defaultToCurrentPhase ? workflow.currentPhase ?? null : null);
  if (phase && !workflow.phases[phase]) {
    throw new SingularityFlowError(`Context X-Ray phase '${phase}' is not part of ${workflow.workItem.id}.`, {
      code: 'CXR_NO_ACTIVE_WORK'
    });
  }
  const records = await contextPacketTelemetryRecords(root, {
    workId: workflow.workItem.id,
    phase: selectedPhase,
    packetId
  });
  if (packetId && !records.length) {
    throw new SingularityFlowError(`Context packet '${packetId}' was not found for ${workflow.workItem.id}.`, {
      code: 'CXR_PACKET_NOT_FOUND',
      details: { nextAction: 'Request a current Evidence Packet, then open Context X-Ray again.' }
    });
  }
  const ledger = tokenLedgerProjection(workflow, records, { phase: selectedPhase });
  const knowledge = knowledgeProjection(records);
  const launches = (await listTelemetryLaunches(root, { storyId: workflow.workItem.id }))
    .filter((launch) => !selectedPhase || !launch.phase || launch.phase === selectedPhase)
    .map((launch) => ({
      launchId: launch.launchId,
      provider: launch.provider,
      runtime: launch.runtime,
      host: launch.host,
      surface: launch.surface,
      captureStatus: launch.captureStatus,
      startedAt: launch.startedAt,
      endedAt: launch.endedAt
    }));
  const gaps = [];
  if (!ledger.models.length) gaps.push(unavailable(
    'CXR_USAGE_UNAVAILABLE',
    'No reconciled provider usage is recorded for this phase.',
    'Finish the instrumented agent turn and run telemetry reconciliation.'
  ));
  if (!ledger.models.some((entry) => entry.resolved)) gaps.push(unavailable(
    'CXR_MODEL_UNAVAILABLE',
    'The host did not expose a resolved model identity.',
    'Open telemetry doctor to inspect model identity coverage.'
  ));
  if (!ledger.packets.length) gaps.push(unavailable(
    'CXR_PACKET_NOT_FOUND',
    'No machine-local Evidence Packet telemetry is retained for this phase.',
    'Request the governed context packet before inspecting X-Ray.'
  ));
  return Object.freeze({
    schemaVersion: 1, // schema-transient: Context X-Ray is a read-only projection
    kind: 'context-xray',
    work: Object.freeze({
      id: workflow.workItem.id,
      title: workflow.workItem.title ?? workflow.workItem.id,
      status: workflow.status,
      phase: selectedPhase,
      generation: selectedPhase ? workflow.phases[selectedPhase]?.generation ?? null : null
    }),
    launches: Object.freeze(launches),
    ledger,
    knowledge,
    gaps: Object.freeze(gaps),
    provenance: Object.freeze({
      providerUsage: 'governed phase telemetry',
      sflowContext: 'machine-local content-free Evidence Packet telemetry',
      reconciliation: 'not performed by this read'
    })
  });
}

function metricText(metric, unit = 'tokens') {
  if (!metric || metric.status === 'unavailable') return 'unavailable';
  return `${metric.value.toLocaleString('en-US')} ${unit} (${metric.status}; ${metric.assurance})`;
}

export function contextXrayText(xray) {
  const ledger = xray.ledger;
  const model = ledger.models.at(-1) ?? null;
  const lines = [
    `CONTEXT X-RAY · ${xray.work.id}`,
    '',
    `Phase             ${xray.work.phase ?? 'complete'}${xray.work.generation == null ? '' : ` · generation ${xray.work.generation}`}`,
    `Agent surface     ${xray.launches.at(-1)?.surface ?? 'unavailable'}`,
    `Requested model   ${model?.requested ?? 'unavailable'}`,
    `Resolved model    ${model?.resolved ?? 'unavailable'}${model ? ` (${model.resolvedAssurance})` : ''}`,
    '',
    `Provider input    ${metricText(ledger.totals.inputTokens)}`,
    `Provider cached   ${metricText(ledger.totals.cachedInputTokens)}`,
    `Provider uncached ${metricText(ledger.totals.uncachedInputTokens)}`,
    `Provider output   ${metricText(ledger.totals.outputTokens)}`,
    '',
    `SFlow packets     ${ledger.packets.length}`,
    `Initial context   ${metricText(ledger.totals.sflowEstimatedTokens, 'estimated tokens')}`,
    `Expanded context  ${metricText(ledger.totals.expandedBytes, 'bytes')}`,
    `Delivered context ${metricText(ledger.totals.deliveredContextTokens, 'estimated tokens')}`,
    `Unique context    ${metricText(ledger.totals.uniqueContextTokens, 'estimated tokens')}`,
    `Coverage          exact ${ledger.coverage.exact} · partial ${ledger.coverage.partial} · estimated ${ledger.coverage.estimated} · unavailable ${ledger.coverage.unavailable}`
  ];
  if (ledger.packets.length) {
    lines.push('', 'Packets');
    for (const packet of ledger.packets) {
      lines.push(`- ${packet.packetId} · ${metricText(packet.estimatedTokens, 'estimated tokens')} · ${packet.tokenEconomy.mode ?? 'mode unavailable'}/${packet.tokenEconomy.profile ?? 'profile unavailable'} · omitted ${packet.omittedItems} · unavailable ${packet.unavailableItems} · expansions ${packet.expansionRequests}`);
    }
  }
  if (xray.knowledge?.packets.length) {
    lines.push('', 'Knowledge guidance');
    for (const packet of xray.knowledge.packets) {
      const detail = packet.omissions.detail?.truncated
        ? ` · omission detail ${packet.omissions.detail.retained}/${packet.omissions.total} (${packet.omissions.detail.truncated} truncated)`
        : '';
      const omissionDigest = packet.omissions.omittedSetSha256
        ? ` · omission digest ${packet.omissions.omittedSetSha256}` : '';
      lines.push(`- ${packet.packetId} · ${packet.status} · selected ${packet.selected.length} · omitted ${packet.omissions.total}${detail}${omissionDigest} · ${packet.guidance?.bytes ?? 0} bytes · manifest ${packet.manifestSha256 ?? 'unavailable'}`);
      for (const entry of [...packet.selected, ...packet.omitted]) {
        const provenance = entry.provenanceReferences.map((reference) =>
          `${reference.workId ?? 'work unavailable'}:${reference.artifact ?? 'artifact unavailable'}@${reference.artifactSha256?.slice(0, 12) ?? 'hash unavailable'}`
        ).join(', ') || 'provenance unavailable';
        const provenanceDetail = entry.provenanceReferenceCount == null
          ? ''
          : ` · provenance refs ${entry.provenanceReferences.length}/${entry.provenanceReferenceCount}${entry.provenanceReferencesTruncated ? ` (${entry.provenanceReferencesTruncated} truncated)` : ''}`;
        lines.push(`  - ${entry.recordSha256?.slice(0, 12) ?? 'record unavailable'} · ${entry.kind ?? 'kind unavailable'} · ${entry.reasonCode ?? 'reason unavailable'} · validity ${entry.validity.status} · scope ${entry.scopeMatch == null ? 'unavailable' : entry.scopeMatch ? 'match' : 'mismatch'} · supersession ${entry.supersession.status} · ${entry.bytes ?? 'unavailable'} bytes · ${provenance}${provenanceDetail}`);
      }
    }
  }
  if (ledger.outcomes.length) {
    lines.push('', 'Outcomes');
    for (const outcome of ledger.outcomes) {
      lines.push(`- ${outcome.packetId} · ${outcome.completed ? 'completed' : 'incomplete'} · verification ${outcome.verification} · retries ${outcome.agentRetries ?? 'unavailable'} · missing-context ${outcome.missingContextIncidents ?? 'unavailable'}`);
    }
  }
  if (xray.gaps.length) {
    lines.push('', 'Unavailable');
    for (const gap of xray.gaps) lines.push(`- ${gap.code}: ${gap.reason} ${gap.action}`);
  }
  return lines.join('\n');
}
