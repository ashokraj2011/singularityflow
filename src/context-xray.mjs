/** Read-only Context X-Ray projection. It never reconciles, expands context, or invokes a model. */
import { contextPacketTelemetryRecords } from './context-packet-telemetry.mjs';
import { listTelemetryLaunches } from './telemetry-provision.mjs';
import { tokenLedgerProjection } from './token-ledger.mjs';
import { SingularityFlowError } from './util.mjs';

function unavailable(code, reason, action) {
  return Object.freeze({ code, reason, action });
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
