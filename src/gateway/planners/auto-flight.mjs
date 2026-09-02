/** Read-only AUT v2 projections for hosts. Mutations remain ordinary CLI/kernel operations. */
import { listAutoFlights, projectAutoFlightReport } from '../../auto/auto-flight-store.mjs';
import { readAutoPlan } from '../../auto/auto-plan.mjs';
import { buildAutoPlanPacket } from '../../auto/auto-plan-packet.mjs';
import {
  autoFlightProductProjection, findAutoFlightForStory
} from '../../auto/auto-p1-control.mjs';
import { SingularityFlowError } from '../../util.mjs';
import { noEffects, sflowResult } from '../result.mjs';

function flightCard(projection) {
  const { flight, current } = projection;
  const candidate = flight.candidate?.candidateId || flight.candidate?.candidateSha256 ? {
    candidateId: flight.candidate.candidateId ?? null,
    candidateSha256: flight.candidate.candidateSha256 ?? null
  } : null;
  const cards = [];
  const ceilings = flight.execution?.ceilings ?? {};
  const providerInputTokens = projection.economics.length > 0
    && projection.economics.every((entry) => Number.isSafeInteger(entry.input?.providerTokens))
    ? projection.economics.reduce((total, entry) => total + entry.input.providerTokens, 0)
    : null;
  cards.push({
    kind: flight.status === 'running' ? 'running'
      : flight.status === 'manual-takeover' ? 'takeover' : 'status',
    mode: 'auto', flightId: flight.flightId, planId: flight.planId,
    status: flight.status, position: flight.position,
    story: flight.story, checkpointSha256: flight.checkpointSha256,
    executionUnit: flight.executionUnit ?? null, candidate,
    progress: {
      phasesCompleted: flight.counters?.phasesCompleted ?? 0,
      maximumPhases: ceilings.maximumPhases ?? null,
      phaseRuns: projection.phaseRuns.length,
      currentAttempt: current.attempt?.attemptNumber ?? null,
      currentAttemptStatus: current.attempt?.status ?? null,
      maximumAttemptsPerPhase: ceilings.maximumAuthoringAttemptsPerPhase ?? null
    },
    budget: {
      touchedPaths: flight.counters?.touchedPaths ?? 0,
      maximumTouchedPaths: ceilings.maximumTouchedPaths ?? null,
      modelInvocations: flight.counters?.modelInvocations ?? 0,
      maximumModelInvocations: ceilings.maximumModelInvocations ?? null,
      providerInputTokens,
      maximumInputTokens: ceilings.tokenBudget?.maximum ?? null,
      tokenAssurance: providerInputTokens == null ? 'unavailable' : 'provider-reported'
    },
    stopReason: flight.stopReason, nextAction: flight.nextAction
  });
  if (current.refusal) cards.push({
    kind: 'refusal', mode: 'auto', flightId: flight.flightId, planId: flight.planId,
    status: flight.status, story: flight.story, candidate,
    refusalId: current.refusal.refusalId,
    refusalSha256: current.refusal.refusalSha256, gate: current.refusal.gate,
    code: current.refusal.code, repair: current.refusal.repair,
    preserved: current.refusal.preserved,
    primaryNextAction: current.refusal.primaryNextAction
  });
  for (const request of projection.humanRequests.filter((entry) => entry.status === 'open')) cards.push({
    kind: 'needs-you', mode: 'auto', flightId: flight.flightId, planId: flight.planId,
    status: flight.status, story: flight.story, candidate,
    requestId: request.requestId, requestSha256: request.requestSha256,
    requestType: request.requestType, title: request.title, detail: request.detail,
    options: request.options
  });
  return cards;
}

function planReviewCard(plan, packet) {
  const verification = plan.executionHost?.verification ?? {};
  return {
    kind: 'plan', mode: 'auto', planId: plan.planId, planSha256: plan.planSha256,
    packetSha256: packet.packetSha256, story: structuredClone(plan.story),
    title: plan.proposal?.title ?? null,
    requirement: plan.requirement?.text ?? null,
    inferences: {
      assumptions: [...(plan.proposal?.assumptions ?? [])],
      unresolvedDecisions: [...(plan.proposal?.unresolvedDecisions ?? [])]
    },
    status: plan.safety?.startable ? 'startable' : 'review-required',
    phaseRail: [...(plan.story?.phaseRail ?? [])],
    scope: {
      status: plan.scope?.status ?? null,
      predictedRead: [...(packet.scope?.predictedRead ?? [])],
      predictedWrite: [...(packet.scope?.predictedWrite ?? [])],
      protected: [...(packet.scope?.protected ?? [])],
      forbidden: [...(packet.scope?.forbidden ?? [])]
    },
    evidenceReadiness: {
      status: verification.status ?? 'unavailable',
      commandIds: [...(verification.commandIds ?? [])],
      acceptanceCriteria: [...(packet.evidence ?? [])]
    },
    ceilings: structuredClone(plan.execution?.ceilings ?? {}),
    execution: {
      profile: plan.execution?.profile?.resolved ?? 'story',
      pace: plan.execution?.pace?.source ?? plan.execution?.pace?.mode ?? null,
      until: plan.execution?.until?.source ?? plan.execution?.until?.kind ?? null,
      executionUnit: plan.executionHost?.id ?? null
    },
    humanStops: structuredClone(plan.humanBoundaries?.stopPoints ?? []),
    capability: plan.capability == null ? null : structuredClone(plan.capability),
    repositories: structuredClone(plan.repositories ?? [])
  };
}

export async function autoFlightRead({ operation, arguments: args = {}, subject = null, root = null } = {}) {
  if (!root) throw new SingularityFlowError('Auto flight reads require an exact repository root.', {
    code: 'AUTO_FLIGHT_NO_ROOT'
  });
  if (operation.id === 'auto.show-plan') {
    const plan = await readAutoPlan(root, args.planId);
    const packet = buildAutoPlanPacket(plan);
    return sflowResult({
      kind: 'read', operation: { id: operation.id, classification: 'read' }, subject,
      outcome: { status: 'succeeded', messageId: 'gateway.read', slots: { planId: plan.planId } },
      effects: noEffects(),
      why: [{ code: 'work.from-governed-records', source: 'deterministic', reference: plan.planSha256, slots: { count: '1' } }],
      warnings: [], next: [], restState: 'informational',
      data: { auto: { planId: plan.planId, cards: [planReviewCard(plan, packet)] } }
    });
  }
  if (operation.id === 'auto.list') {
    const flights = (await listAutoFlights(root)).slice(0, 50);
    return sflowResult({
      kind: 'read', operation: { id: operation.id, classification: 'read' }, subject,
      outcome: { status: 'succeeded', messageId: 'gateway.read', slots: { count: String(flights.length) } },
      effects: noEffects(),
      why: [{ code: 'work.from-governed-records', source: 'deterministic', reference: null, slots: { count: String(flights.length) } }],
      warnings: [], next: [], restState: 'informational',
      data: { auto: { cards: flights.map((flight) => ({
        kind: flight.status === 'running' ? 'running'
          : flight.status === 'manual-takeover' ? 'takeover' : 'status',
        flightId: flight.flightId, story: flight.story, status: flight.status,
        position: flight.position, checkpointSha256: flight.checkpointSha256,
        stopReason: flight.stopReason, nextAction: flight.nextAction
      })) } }
    });
  }
  const state = operation.id === 'auto.continue'
    ? await findAutoFlightForStory(root, args.workId)
    : null;
  const flightId = state?.flightId ?? args.flightId;
  const projection = await autoFlightProductProjection(root, flightId);
  const report = operation.id === 'auto.report'
    ? await projectAutoFlightReport(root, projection.flight) : null;
  const cards = flightCard(projection);
  if (report) cards.push({
    kind: 'report', mode: 'auto', flightId: report.flightId, planId: report.planId,
    story: projection.flight.story, status: 'available', reportSha256: report.reportSha256,
    candidate: report.candidate ?? null,
    qualityFloor: report.qualityFloor ?? null,
    outcomeMetrics: report.outcomeMetrics ?? null,
    accounting: report.accounting ?? null,
    report
  });
  return sflowResult({
    kind: 'read', operation: { id: operation.id, classification: 'read' },
    subject: subject ?? { kind: 'story', id: projection.flight.story.workId },
    outcome: { status: 'succeeded', messageId: 'gateway.read', slots: { flightId } },
    effects: noEffects(),
    why: [{
      code: 'work.from-governed-records', source: 'deterministic',
      reference: projection.flight.checkpointSha256, slots: { count: String(cards.length) }
    }],
    warnings: [], next: [], restState: 'informational',
    data: {
      auto: {
        flightId, story: projection.flight.story, status: projection.flight.status,
        phaseRun: projection.current.phaseRun, attempt: projection.current.attempt,
        references: projection.references, cards
      }
    }
  });
}
