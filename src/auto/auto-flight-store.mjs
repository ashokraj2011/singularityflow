/** Machine-local Auto flight state. All mutations are serialized by a repository-wide subject lock. */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { gitCommonDir } from '../git.mjs';
import { canonicalJson, recordSha256 } from '../records.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { withSubjectLock } from '../subject-lock.mjs';
import { nowIso, SingularityFlowError, writeAtomic } from '../util.mjs';

const FLIGHT_ID = /^AFL-[A-F0-9]{26}$/;
const CHECKPOINT = /^sha256:[a-f0-9]{64}$/;
export const AUTO_FLIGHT_STATUSES = Object.freeze([
  'running', 'paused', 'waiting-human', 'halted', 'completed', 'discarded'
]);

function localRoot(root) { return path.join(gitCommonDir(root), 'singularity-flow', 'auto-flights'); }
function flightDirectory(root, id) { return path.join(localRoot(root), id); }
function stateFile(root, id) { return path.join(flightDirectory(root, id), 'state.json'); }
function reportFile(root, id) { return path.join(flightDirectory(root, id), 'report.json'); }

function validateFlightId(value) {
  const id = String(value ?? '').trim();
  if (!FLIGHT_ID.test(id)) throw new SingularityFlowError(`Invalid Auto flight ID '${id}'.`, { code: 'AUTO_FLIGHT_NOT_FOUND' });
  return id;
}

function stateHash(state) {
  const copy = structuredClone(state);
  delete copy.recordSha256;
  return recordSha256(copy);
}

function checkpointHash(state) {
  return `sha256:${recordSha256({
    flightId: state.flightId, planSha256: state.planSha256, status: state.status,
    workId: state.story.workId, phase: state.story.phase, position: state.position, counters: state.counters,
    checkpointSequence: state.checkpointSequence, stopReason: state.stopReason
  })}`;
}

function seal(state) {
  const next = structuredClone(state);
  next.checkpointSha256 = checkpointHash(next);
  next.recordSha256 = stateHash(next);
  return next;
}

export async function createAutoFlightState(root, value) {
  const id = validateFlightId(value.flightId);
  return withSubjectLock(root, { kind: 'auto-flight', id }, async () => {
    try {
      const existing = await readAutoFlightState(root, id);
      if (existing.planSha256 !== value.planSha256) throw new SingularityFlowError(`Auto flight '${id}' already exists for another Plan.`, { code: 'AUTO_FLIGHT_CONFLICT' });
      return existing;
    } catch (error) {
      if (error.code !== 'AUTO_FLIGHT_NOT_FOUND') throw error;
    }
    const createdAt = nowIso();
    const state = seal({
      schemaVersion: currentSchemaVersion('auto-flight-state'), kind: 'auto-flight-state', mode: 'auto',
      flightId: id, planId: value.planId, planSha256: value.planSha256,
      capabilityId: value.capabilityId ?? null,
      status: value.status ?? 'paused',
      story: structuredClone(value.story), worktree: value.worktree,
      scopePrediction: structuredClone(value.scopePrediction ?? []),
      position: value.position ?? 'story-created',
      execution: structuredClone(value.execution),
      counters: { modelInvocations: 0, authoringAttempts: {}, phasesCompleted: 0, touchedPaths: 0, touchedChanges: 0 },
      checkpointSequence: 1, checkpointSha256: null,
      stopReason: value.stopReason ?? 'story-created',
      nextAction: value.nextAction ?? 'Review the Story and resume with the exact checkpoint hash.',
      createdAt, updatedAt: createdAt, recordSha256: null
    });
    await writeAtomic(stateFile(root, id), canonicalJson(state), { mode: 0o600 });
    return state;
  });
}

export async function readAutoFlightState(root, value) {
  const id = validateFlightId(value);
  let raw;
  try { raw = await readFile(stateFile(root, id), 'utf8'); }
  catch (error) {
    throw new SingularityFlowError(`Auto flight '${id}' is not available in this repository.`, {
      code: 'AUTO_FLIGHT_NOT_FOUND', cause: error
    });
  }
  const state = readRecord('auto-flight-state', raw).record;
  if (state.flightId !== id || state.recordSha256 !== stateHash(state) || state.checkpointSha256 !== checkpointHash(state)) {
    throw new SingularityFlowError(`Auto flight '${id}' failed its integrity check.`, { code: 'AUTO_FLIGHT_CORRUPT' });
  }
  return state;
}

export async function mutateAutoFlightState(root, value, mutate) {
  const id = validateFlightId(value);
  return withSubjectLock(root, { kind: 'auto-flight', id }, async () => {
    const current = await readAutoFlightState(root, id);
    const draft = structuredClone(current);
    const result = await mutate(draft, current);
    const next = result ?? draft;
    if (!AUTO_FLIGHT_STATUSES.includes(next.status)) throw new SingularityFlowError(`Invalid Auto flight status '${next.status}'.`);
    next.schemaVersion = currentSchemaVersion('auto-flight-state');
    next.checkpointSequence = current.checkpointSequence + 1;
    next.updatedAt = nowIso();
    const sealed = seal(next);
    await writeAtomic(stateFile(root, id), canonicalJson(sealed), { mode: 0o600 });
    return sealed;
  });
}

export async function pauseAutoFlight(root, id) {
  return mutateAutoFlightState(root, id, (state) => {
    if (['completed', 'discarded'].includes(state.status)) throw new SingularityFlowError(`Auto flight '${id}' is ${state.status}.`, { code: 'AUTO_FLIGHT_TERMINAL' });
    state.status = 'paused'; state.stopReason = 'human-paused';
    state.nextAction = 'Resume with the exact checkpoint hash when ready.';
  });
}

export async function resumeAutoFlight(root, id, confirmation) {
  if (!CHECKPOINT.test(String(confirmation ?? ''))) {
    throw new SingularityFlowError('Auto resume requires --confirm <CHECKPOINT-SHA256>.', { code: 'AUTO_CHECKPOINT_REQUIRED' });
  }
  return mutateAutoFlightState(root, id, (state, current) => {
    if (confirmation !== current.checkpointSha256) throw new SingularityFlowError(`Checkpoint mismatch for '${id}'.`, {
      code: 'AUTO_CHECKPOINT_STALE', details: { expected: current.checkpointSha256 }
    });
    if (['halted', 'completed', 'discarded'].includes(state.status)) {
      throw new SingularityFlowError(`Auto flight '${id}' is ${state.status} and cannot resume.`, { code: 'AUTO_FLIGHT_TERMINAL' });
    }
    state.status = 'running'; state.stopReason = 'human-resumed';
    state.nextAction = 'Run the next bounded Auto step; the next model attempt remains single-shot.';
  });
}

export async function haltAutoFlight(root, id, reason = 'human-halted') {
  return mutateAutoFlightState(root, id, (state) => {
    if (['completed', 'discarded'].includes(state.status)) throw new SingularityFlowError(`Auto flight '${id}' is ${state.status}.`, { code: 'AUTO_FLIGHT_TERMINAL' });
    state.status = 'halted'; state.stopReason = reason; state.nextAction = 'Create a replacement Plan to continue autonomous work.';
  });
}

export async function discardAutoFlight(root, id, confirmation) {
  if (confirmation !== id) throw new SingularityFlowError(`Discard requires --confirm ${id}.`, { code: 'AUTO_CONFIRMATION_REQUIRED' });
  return mutateAutoFlightState(root, id, (state) => {
    if (state.status === 'running') throw new SingularityFlowError('Pause or halt a running flight before discarding it.', { code: 'AUTO_FLIGHT_RUNNING' });
    state.status = 'discarded'; state.stopReason = 'human-discarded';
    state.nextAction = 'The governed Story and Git history remain intact; only this authorization is closed.';
  });
}

/** Atomically consumes the one allowed authoring attempt before a model process can start. */
export async function authorizeAutoAuthoringAttempt(root, id, phase) {
  return mutateAutoFlightState(root, id, (state) => {
    if (state.status !== 'running') throw new SingularityFlowError(`Auto flight '${id}' is ${state.status}; no model may start.`, { code: 'AUTO_FLIGHT_NOT_RUNNING' });
    const attempts = state.counters.authoringAttempts[phase] ?? 0;
    if (attempts >= state.execution.ceilings.maximumAuthoringAttemptsPerPhase) {
      state.status = 'halted'; state.stopReason = 'authoring-attempt-exhausted';
      state.nextAction = 'A human must replace the Plan; Auto will not retry this phase.';
      return;
    }
    if (state.counters.modelInvocations >= state.execution.ceilings.maximumModelInvocations) {
      state.status = 'halted'; state.stopReason = 'model-invocation-ceiling';
      state.nextAction = 'A human must replace the Plan or finish the Story manually.';
      return;
    }
    state.counters.authoringAttempts[phase] = attempts + 1;
    state.counters.modelInvocations += 1;
    state.stopReason = 'authoring-attempt-authorized';
    state.nextAction = 'Exactly one governed model invocation may now run for this phase.';
  });
}

export function buildAutoFlightReport(state) {
  const core = {
    schemaVersion: currentSchemaVersion('auto-flight-report'), kind: 'auto-flight-report', mode: 'auto',
    flightId: state.flightId, planId: state.planId, planSha256: state.planSha256,
    status: state.status, stopReason: state.stopReason, nextAction: state.nextAction,
    counters: structuredClone(state.counters),
    scope: {
      predicted: { status: 'predicted', paths: structuredClone(state.scopePrediction ?? []) },
      observed: {
        status: Array.isArray(state.observedPaths) ? 'exact' : 'unavailable',
        paths: structuredClone(state.observedPaths ?? [])
      }
    },
    accounting: {
      tokens: structuredClone(state.token ?? { assurance: 'unavailable', totalTokens: null }),
      cost: { assurance: 'unavailable', amount: null }
    },
    checkpointSha256: state.checkpointSha256
  };
  return { ...core, reportSha256: `sha256:${recordSha256(core)}` };
}

export async function persistAutoFlightReport(root, state) {
  const report = buildAutoFlightReport(state);
  await writeAtomic(reportFile(root, state.flightId), canonicalJson(report), { mode: 0o600 });
  return report;
}

export async function readAutoFlightReport(root, value) {
  const id = validateFlightId(value);
  const report = readRecord('auto-flight-report', await readFile(reportFile(root, id), 'utf8')).record;
  const copy = structuredClone(report);
  delete copy.reportSha256;
  if (report.flightId !== id || report.reportSha256 !== `sha256:${recordSha256(copy)}`) {
    throw new SingularityFlowError(`Auto flight report '${id}' failed its integrity check.`, {
      code: 'AUTO_FLIGHT_CORRUPT'
    });
  }
  return report;
}

export function renderAutoFlightReport(state, report = buildAutoFlightReport(state)) {
  return [
    `# Auto flight ${state.flightId}`,
    '', `- Status: **${state.status}**`, `- Plan: ${state.planId}`, `- Plan hash: \`${state.planSha256}\``,
    `- Story: ${state.story.workId}`, `- Current phase: ${state.story.phase ?? 'unknown'}`,
    `- Checkpoint: \`${state.checkpointSha256}\``, `- Stop reason: ${state.stopReason}`,
    `- Model invocations authorized: ${state.counters.modelInvocations}`,
    `- Predicted scope: ${report.scope.predicted.paths.join(', ') || 'none'}`,
    `- Observed scope (${report.scope.observed.status}): ${report.scope.observed.paths.join(', ') || 'none'}`,
    `- Token accounting (${report.accounting.tokens.assurance}): ${report.accounting.tokens.totalTokens ?? 'unavailable'}`,
    `- Cost accounting: unavailable`,
    `- Report hash: \`${report.reportSha256}\``,
    '', '## Next action', '', state.nextAction
  ].join('\n');
}

export async function listAutoFlights(root) {
  const names = await readdir(localRoot(root)).catch(() => []);
  const states = [];
  for (const name of names.filter((entry) => FLIGHT_ID.test(entry))) {
    const state = await readAutoFlightState(root, name).catch(() => null);
    if (state) states.push(state);
  }
  return states.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}
