/**
 * Bounded, read-only Auto projection for Home and Story Return.
 *
 * Auto's detailed records are machine-local operational projections. Home may summarize them, but
 * it must never translate an unreadable private record into "no Auto work". This reader therefore
 * returns an explicit unavailable projection on any integrity/read failure and exposes only stable
 * identifiers, status, and exact CLI routes. Raw private records and their diagnostics never enter
 * a gateway result.
 */
import {
  listAutoFlights, readAutoFlightReport
} from '../auto/auto-flight-store.mjs';
import { autoFlightProductProjection } from '../auto/auto-p1-control.mjs';

export const MAX_HOME_AUTO_FLIGHTS = 5;
export const MAX_HOME_AUTO_CARDS = 12;

function selectedRank(flight, workId) {
  if (workId && flight.story?.workId === workId) return 0;
  if (flight.status === 'waiting-human') return 1;
  if (flight.status === 'recovery-required') return 2;
  if (flight.status === 'manual-takeover') return 3;
  if (flight.status === 'running') return 4;
  return 5;
}

function statusCommand(flight, projection) {
  const id = flight.flightId;
  const workId = flight.story?.workId;
  const openRequest = projection?.humanRequests?.find((entry) => entry.status === 'open');
  if (openRequest || flight.status === 'waiting-human') {
    return `singularity-flow auto needs-you ${id}`;
  }
  if (flight.status === 'paused') {
    return `singularity-flow auto resume ${id} --confirm ${flight.checkpointSha256}`;
  }
  if (flight.status === 'recovery-required' && workId) {
    return `singularity-flow auto recover ${workId} --flight ${id}`;
  }
  if (flight.status === 'manual-takeover' || flight.finalReportSha256) {
    return `singularity-flow auto report ${id}`;
  }
  if (flight.status === 'running') return `singularity-flow auto pause ${id}`;
  return `singularity-flow auto status ${id}`;
}

function candidateReference(value) {
  if (!value?.candidateId && !value?.candidateSha256) return null;
  return {
    candidateId: value.candidateId ?? null,
    candidateSha256: value.candidateSha256 ?? null
  };
}

function summaryCard(projection) {
  const { flight } = projection;
  const ceilings = flight.execution?.ceilings ?? {};
  const providerInputTokens = projection.economics.length > 0
    && projection.economics.every((entry) => Number.isSafeInteger(entry.input?.providerTokens))
    ? projection.economics.reduce((total, entry) => total + entry.input.providerTokens, 0)
    : null;
  return {
    kind: flight.status === 'running' ? 'running'
      : flight.status === 'manual-takeover' ? 'takeover' : 'status',
    mode: 'auto',
    flightId: flight.flightId,
    planId: flight.planId,
    status: flight.status,
    position: flight.position,
    story: {
      workId: flight.story?.workId ?? null,
      phase: flight.story?.phase ?? null
    },
    checkpointSha256: flight.checkpointSha256,
    executionUnit: flight.executionUnit ?? null,
    progress: {
      phasesCompleted: flight.counters?.phasesCompleted ?? 0,
      maximumPhases: ceilings.maximumPhases ?? null,
      phaseRuns: projection.phaseRuns.length,
      currentAttempt: projection.current.attempt?.attemptNumber ?? null,
      currentAttemptStatus: projection.current.attempt?.status ?? null,
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
    candidate: candidateReference(flight.candidate),
    stopReason: flight.stopReason ?? null,
    nextAction: flight.nextAction ?? null,
    command: statusCommand(flight, projection)
  };
}

function refusalCard(flight, refusal) {
  const command = `singularity-flow auto repair ${flight.flightId} --refusal ${refusal.refusalId}`;
  return {
    kind: 'refusal', mode: 'auto', flightId: flight.flightId, planId: flight.planId,
    status: flight.status, story: flight.story,
    refusalId: refusal.refusalId, gate: refusal.gate, code: refusal.code,
    repair: refusal.repair ?? null,
    preserved: refusal.preserved ?? null,
    candidate: candidateReference(flight.candidate),
    nextAction: command, command
  };
}

function requestCard(flight, request) {
  const command = `singularity-flow auto needs-you ${flight.flightId}`;
  return {
    kind: 'needs-you', mode: 'auto', flightId: flight.flightId, planId: flight.planId,
    status: flight.status, story: flight.story,
    requestId: request.requestId, requestSha256: request.requestSha256,
    requestType: request.requestType, title: request.title, detail: request.detail,
    options: request.options,
    candidate: candidateReference(flight.candidate),
    nextAction: command, command
  };
}

async function reportCard(root, flight) {
  if (!flight.finalReportSha256) return null;
  try {
    const report = await readAutoFlightReport(root, flight.flightId);
    if (report.reportSha256 !== flight.finalReportSha256) throw new Error('report binding mismatch');
    const command = `singularity-flow auto report ${flight.flightId}`;
    return {
      kind: 'report', mode: 'auto', flightId: flight.flightId, planId: report.planId,
      story: flight.story, status: 'available', candidate: candidateReference(report.candidate),
      reportSha256: report.reportSha256,
      qualityFloor: report.qualityFloor ?? null,
      outcomeMetrics: report.outcomeMetrics ?? null,
      accounting: report.accounting ?? null,
      nextAction: command, command
    };
  } catch {
    const workId = flight.story?.workId;
    const command = workId
      ? `singularity-flow auto recover ${workId} --flight ${flight.flightId}`
      : 'singularity-flow doctor';
    return {
      kind: 'unavailable', flightId: flight.flightId, status: 'report-unavailable',
      story: { workId: workId ?? null, phase: flight.story?.phase ?? null },
      nextAction: command, command
    };
  }
}

function unavailableProjection() {
  return Object.freeze({
    availability: 'unavailable', total: null, shown: 0, omitted: null,
    cards: Object.freeze([Object.freeze({
      kind: 'unavailable', status: 'records-unavailable',
      nextAction: 'singularity-flow doctor', command: 'singularity-flow doctor'
    })])
  });
}

/**
 * Read Auto work associated with this repository and preferentially show the selected Story.
 * Every list is bounded. Any unreadable flight/P1 record makes the whole projection explicitly
 * unavailable, because a partial list would falsely claim that omitted Needs You/refusal state did
 * not exist.
 */
export async function autoHomeSummary(root, {
  workId = null, maximumFlights = MAX_HOME_AUTO_FLIGHTS,
  maximumCards = MAX_HOME_AUTO_CARDS
} = {}) {
  let flights;
  try { flights = await listAutoFlights(root); }
  catch { return unavailableProjection(); }

  const ordered = flights.map((flight, index) => ({ flight, index }))
    .sort((left, right) => selectedRank(left.flight, workId) - selectedRank(right.flight, workId)
      || left.index - right.index)
    .slice(0, maximumFlights).map((entry) => entry.flight);
  const cards = [];
  for (const flight of ordered) {
    let projection;
    try { projection = await autoFlightProductProjection(root, flight.flightId); }
    catch { return unavailableProjection(); }
    cards.push(summaryCard(projection));
    if (projection.current.refusal) cards.push(refusalCard(flight, projection.current.refusal));
    for (const request of projection.humanRequests.filter((entry) => entry.status === 'open')) {
      cards.push(requestCard(flight, request));
    }
    const report = await reportCard(root, flight);
    if (report) cards.push(report);
    if (cards.length >= maximumCards) break;
  }
  const bounded = cards.slice(0, maximumCards).map((card) => Object.freeze(card));
  return Object.freeze({
    availability: bounded.some((card) => card.kind === 'unavailable') ? 'partial' : 'available',
    total: flights.length, shown: ordered.length,
    omitted: Math.max(0, flights.length - ordered.length),
    selectedWorkId: workId,
    cards: Object.freeze(bounded)
  });
}
