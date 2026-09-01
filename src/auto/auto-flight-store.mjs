/** Machine-local Auto flight state. All mutations are serialized by a repository-wide subject lock. */
import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { gitCommonDir } from '../git.mjs';
import { canonicalJson, recordSha256 } from '../records.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { subjectLockPath, withSubjectLock } from '../subject-lock.mjs';
import { nowIso, run, SingularityFlowError } from '../util.mjs';
import { verifyAutoFlightContinuation } from './auto-continuation.mjs';
import {
  listAutoPrivateRecords, readAutoPrivateRecord, writeAutoPrivateRecord
} from './auto-private-store.mjs';
import { snapshotAutoP1Records, validateAutoP1Snapshot } from './auto-p1-records.mjs';

const FLIGHT_ID = /^AFL-[A-F0-9]{26}$/;
const PLAN_ID = /^APL-[A-F0-9]{26}$/;
const CHECKPOINT = /^sha256:[a-f0-9]{64}$/;
export const AUTO_FLIGHT_STATUSES = Object.freeze([
  'running', 'paused', 'waiting-human', 'manual-takeover',
  'recovery-required', 'halted', 'completed', 'discarded'
]);
const AUTO_FLIGHT_FIELDS = new Set([
  'schemaVersion', 'kind', 'mode', 'flightId', 'planId', 'planSha256', 'capabilityId',
  'status', 'story', 'worktree', 'scopePrediction', 'configuration', 'repositories',
  'operations', 'evidence', 'candidate', 'phaseContracts', 'boundaryCheckpoints',
  'worldModelReference', 'comprehensionReference',
  'boundaryCheckpoint', 'lastSuccessfulStoryRevision', 'position', 'execution', 'counters',
  'stopRequested', 'checkpointSequence', 'checkpointSha256', 'stopReason', 'nextAction',
  'createdAt', 'updatedAt', 'recordSha256', 'lastInvocationId', 'token', 'observedPaths',
  'touchedPaths', 'ceiling', 'commits', 'quality', 'approvals', 'lastError',
  'finalReportSha256', 'activePhaseRunId',
  'activeAttemptId', 'activeRefusalId', 'activeRepairPlanId', 'activeRepair', 'phaseRunIds',
  'attemptIds', 'refusalIds', 'repairAttempts', 'failureComparison', 'openHumanRequestIds',
  'humanRequestDecisions', 'executionUnit', 'executionUnitSwitches'
]);
const AUTO_REPORT_FIELDS = new Set([
  'schemaVersion', 'kind', 'mode', 'flightId', 'planId', 'planSha256', 'status',
  'stopReason', 'nextAction', 'position', 'configuration', 'repositories', 'operations',
  'commits', 'evidence', 'candidate', 'phaseContracts', 'boundaryCheckpoints',
  'worldModelReference', 'comprehensionReference',
  'lineage', 'approvalSource',
  'boundaryCheckpoint', 'lastSuccessfulStoryRevision', 'retainedUnpublishedPaths',
  'authorityTarget', 'quality', 'approvals', 'humanIntervention', 'lastError', 'counters',
  'scope', 'accounting', 'checkpointSha256', 'reportSha256'
]);
const AUTO_REPORT_LINEAGE_FAMILIES = Object.freeze([
  'auto-phase-run', 'auto-attempt', 'auto-refusal', 'auto-repair-plan',
  'auto-human-request', 'auto-token-economics-receipt', 'auto-execution-unit-switch'
]);

function localRoot(root) { return path.join(gitCommonDir(root), 'singularity-flow', 'auto-flights'); }
function flightDirectory(root, id) { return path.join(localRoot(root), id); }
function stateFile(root, id) { return path.join(flightDirectory(root, id), 'state.json'); }
function reportFile(root, id) { return path.join(flightDirectory(root, id), 'report.json'); }

async function waitForExecutionQuiescence(root, id, timeoutMs = 15_000) {
  const target = subjectLockPath(root, { kind: 'auto-flight-step', id });
  const deadline = Date.now() + timeoutMs;
  while (await lstat(target).then(() => true, (error) => error?.code === 'ENOENT' ? false : Promise.reject(error))) {
    if (Date.now() >= deadline) {
      throw new SingularityFlowError(
        `Auto flight '${id}' accepted the stop request but its active execution did not quiesce within ${timeoutMs}ms.`,
        { code: 'AUTO_STOP_TIMEOUT', details: { stopRequested: true, lock: target } }
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

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
    checkpointSequence: state.checkpointSequence, stopReason: state.stopReason,
    stopRequested: state.stopRequested ?? null,
    candidate: state.candidate ?? null,
    worldModelReference: state.worldModelReference ?? null,
    comprehensionReference: state.comprehensionReference ?? null,
    phaseContracts: state.phaseContracts ?? {},
    boundaryCheckpoints: state.boundaryCheckpoints ?? [],
    boundaryCheckpoint: state.boundaryCheckpoint ?? null
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
      configuration: structuredClone(value.configuration ?? null),
      repositories: structuredClone(value.repositories ?? []),
      operations: [],
      evidence: {},
      candidate: null,
      worldModelReference: null,
      comprehensionReference: null,
      phaseContracts: {},
      boundaryCheckpoints: [],
      boundaryCheckpoint: null,
      lastSuccessfulStoryRevision: value.story?.revision ?? null,
      position: value.position ?? 'story-created',
      execution: structuredClone(value.execution),
      counters: {
        modelInvocations: 0, authoringAttempts: {}, phasesCompleted: 0,
        touchedPaths: 0, touchedChanges: 0, totalTokens: 0, activeMilliseconds: 0
      },
      stopRequested: null,
      checkpointSequence: 1, checkpointSha256: null,
      stopReason: value.stopReason ?? 'story-created',
      nextAction: value.nextAction ?? 'Review the Story and resume with the exact checkpoint hash.',
      createdAt, updatedAt: createdAt, recordSha256: null
    });
    await writeAutoPrivateRecord(root, stateFile(root, id), 'flight-state', canonicalJson(state));
    return state;
  });
}

export async function readAutoFlightState(root, value) {
  const id = validateFlightId(value);
  const raw = await readAutoPrivateRecord(
    root, stateFile(root, id), 'flight-state', { optional: true }
  );
  if (raw == null) {
    throw new SingularityFlowError(`Auto flight '${id}' is not available in this repository.`, {
      code: 'AUTO_FLIGHT_NOT_FOUND'
    });
  }
  const state = readRecord('auto-flight-state', raw).record;
  const unknown = Object.keys(state).filter((field) => !AUTO_FLIGHT_FIELDS.has(field));
  if (state.kind !== 'auto-flight-state' || state.mode !== 'auto'
      || state.flightId !== id || !PLAN_ID.test(String(state.planId ?? ''))
      || !CHECKPOINT.test(String(state.planSha256 ?? ''))
      || unknown.length
      || state.recordSha256 !== stateHash(state)
      || state.checkpointSha256 !== checkpointHash(state)) {
    throw new SingularityFlowError(`Auto flight '${id}' failed its integrity check.`, {
      code: 'AUTO_FLIGHT_CORRUPT', details: { unknown }
    });
  }
  return state;
}

export async function mutateAutoFlightState(root, value, mutate, { expectedCheckpoint = null } = {}) {
  const id = validateFlightId(value);
  return withSubjectLock(root, { kind: 'auto-flight', id }, async () => {
    const current = await readAutoFlightState(root, id);
    if (expectedCheckpoint && current.checkpointSha256 !== expectedCheckpoint) {
      throw new SingularityFlowError(`Auto flight '${id}' changed during its active step.`, {
        code: 'AUTO_CHECKPOINT_STALE',
        details: { expected: expectedCheckpoint, actual: current.checkpointSha256 }
      });
    }
    const draft = structuredClone(current);
    const result = await mutate(draft, current);
    const next = result ?? draft;
    if (!AUTO_FLIGHT_STATUSES.includes(next.status)) throw new SingularityFlowError(`Invalid Auto flight status '${next.status}'.`);
    next.schemaVersion = currentSchemaVersion('auto-flight-state');
    next.checkpointSequence = current.checkpointSequence + 1;
    next.updatedAt = nowIso();
    const sealed = seal(next);
    await writeAutoPrivateRecord(root, stateFile(root, id), 'flight-state', canonicalJson(sealed));
    return sealed;
  });
}

async function requestStopMutation(root, id, mutate, timeoutMs = 2_000, expectedCheckpoint = null) {
  const maximumAttempts = Math.max(1, Math.ceil(timeoutMs / 20));
  let attempts = 0;
  for (;;) {
    try {
      return await mutateAutoFlightState(root, id, mutate,
        expectedCheckpoint ? { expectedCheckpoint } : {});
    }
    catch (error) {
      if (error?.code !== 'SUBJECT_LOCK_BUSY' || ++attempts >= maximumAttempts) throw error;
      // The executor holds this lock only while sealing one checkpoint. A human interrupt waits
      // for that tiny CAS window, then records stopRequested before waiting on the step lease.
      // Count actual acquisition failures rather than elapsed wall time so an event-loop stall does
      // not exhaust the budget without either side receiving a scheduling turn.
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

function terminalControlState(state, id, action) {
  if (!['halted', 'completed', 'discarded'].includes(state.status)) return;
  throw new SingularityFlowError(`Auto flight '${id}' is ${state.status} and cannot ${action}.`, {
    code: 'AUTO_FLIGHT_TERMINAL'
  });
}

async function requestQuiescentTransition(root, id, {
  kind, finalStatus, finalReason, finalNextAction,
  quiescenceTimeoutMs = 15_000, expectedCheckpoint = null
}) {
  const requestId = randomUUID();
  const requestedAt = nowIso();
  await requestStopMutation(root, id, (state) => {
    terminalControlState(state, id, kind === 'takeover' ? 'enter manual takeover' : kind);
    if (state.status === 'recovery-required') {
      throw new SingularityFlowError(
        `Auto flight '${id}' requires recovery before another control transition.`,
        { code: 'AUTO_RECOVERY_REQUIRED', details: { stopRequested: state.stopRequested ?? null } }
      );
    }
    // Preserve the established interrupt ordering: make the requested resting state and stop token
    // durable before waiting on the complete-step lease. The executor can therefore observe and
    // account an interrupt while this command waits. Failure to prove quiescence below replaces
    // this provisional resting state with recovery-required before the command returns an error.
    state.status = finalStatus;
    state.stopReason = finalReason;
    state.stopRequested = { kind, requestId, requestedAt };
    state.nextAction = finalNextAction;
  }, 2_000, expectedCheckpoint);
  try {
    await waitForExecutionQuiescence(root, id, quiescenceTimeoutMs);
  } catch (error) {
    if (error?.code !== 'AUTO_STOP_TIMEOUT') throw error;
    const recovery = await requestStopMutation(root, id, (state) => {
      if (state.stopRequested?.requestId !== requestId) return state;
      state.status = 'recovery-required';
      state.stopReason = `${kind}-quiescence-unproven`;
      state.nextAction = 'Inspect and stop the active execution owner, then run governed Auto recovery.';
      state.lastError = {
        code: error.code,
        message: error.message
      };
    });
    error.details = {
      ...(error.details ?? {}),
      flightId: id,
      status: recovery.status,
      checkpointSha256: recovery.checkpointSha256,
      stopRequested: recovery.stopRequested ?? null
    };
    throw error;
  }
  let quiesced = await requestStopMutation(root, id, (state) => {
    if (state.stopRequested?.requestId !== requestId || state.status !== finalStatus) {
      throw new SingularityFlowError(`Auto flight '${id}' changed while '${kind}' was proving quiescence.`, {
        code: 'AUTO_CHECKPOINT_STALE', details: { status: state.status }
      });
    }
    state.stopRequested = { ...state.stopRequested, quiescedAt: nowIso() };
  });
  try {
    if (finalStatus === 'halted') {
      const report = await persistAutoFlightReport(root, quiesced);
      quiesced = await requestStopMutation(root, id, (state) => {
        if (state.checkpointSha256 !== quiesced.checkpointSha256
            || state.stopRequested?.requestId !== requestId) {
          throw new SingularityFlowError(`Auto flight '${id}' changed before its final report was bound.`, {
            code: 'AUTO_CHECKPOINT_STALE'
          });
        }
        state.finalReportSha256 = report.reportSha256;
      });
    }
    const { publishAutoBoundaryCheckpoint } = await import('./auto-checkpoint.mjs');
    const pointer = await publishAutoBoundaryCheckpoint(
      quiesced.worktree, quiesced,
      'human-boundary', { operationalRoot: root }
    );
    return requestStopMutation(root, id, (state) => {
      if (state.checkpointSha256 !== quiesced.checkpointSha256
          || state.stopRequested?.requestId !== requestId) {
        throw new SingularityFlowError(`Auto flight '${id}' changed while its governed stop checkpoint was published.`, {
          code: 'AUTO_CHECKPOINT_STALE'
        });
      }
      const localPointer = {
        checkpointClass: pointer.checkpointClass, path: pointer.path,
        checkpointSha256: pointer.checkpointSha256, commit: pointer.commit,
        eventId: pointer.eventId, phase: pointer.phase, position: pointer.position,
        createdAt: pointer.createdAt
      };
      state.boundaryCheckpoints = [...(state.boundaryCheckpoints ?? []), localPointer];
      state.boundaryCheckpoint = localPointer;
      state.lastSuccessfulStoryRevision = pointer.commit;
      state.commits = { ...(state.commits ?? {}), controlCheckpoint: pointer.commit };
    });
  } catch (error) {
    const recovery = await requestStopMutation(root, id, (state) => {
      if (state.stopRequested?.requestId !== requestId) return state;
      state.status = 'recovery-required';
      state.stopReason = `${kind}-checkpoint-publication-failed`;
      state.nextAction = 'Repair or synchronize Story publication, then recover from the last governed Auto checkpoint.';
      state.lastError = {
        code: error.code ?? 'AUTO_CHECKPOINT_PUBLICATION_FAILED', message: error.message
      };
    });
    throw new SingularityFlowError(
      `Auto flight '${id}' quiesced, but its governed ${kind} checkpoint could not be published.`, {
        code: 'AUTO_CHECKPOINT_PUBLICATION_FAILED', cause: error,
        details: {
          flightId: id, status: recovery.status,
          checkpointSha256: recovery.checkpointSha256
        }
      }
    );
  }
}

export async function pauseAutoFlight(root, id, options = {}) {
  return requestQuiescentTransition(root, id, {
    kind: 'pause', finalStatus: 'paused', finalReason: 'human-paused',
    finalNextAction: 'Resume with the exact checkpoint hash when ready.',
    quiescenceTimeoutMs: options.quiescenceTimeoutMs,
    expectedCheckpoint: options.expectedCheckpoint ?? null
  });
}

export async function resumeAutoFlight(root, id, confirmation) {
  if (!CHECKPOINT.test(String(confirmation ?? ''))) {
    throw new SingularityFlowError('Auto resume requires --confirm <CHECKPOINT-SHA256>.', { code: 'AUTO_CHECKPOINT_REQUIRED' });
  }
  let current = await readAutoFlightState(root, id);
  if (confirmation !== current.checkpointSha256) throw new SingularityFlowError(`Checkpoint mismatch for '${id}'.`, {
    code: 'AUTO_CHECKPOINT_STALE', details: { expected: current.checkpointSha256 }
  });
  if (!['paused', 'waiting-human', 'manual-takeover'].includes(current.status)) {
    const code = current.status === 'recovery-required' ? 'AUTO_RECOVERY_REQUIRED' : 'AUTO_FLIGHT_TERMINAL';
    throw new SingularityFlowError(`Auto flight '${id}' is ${current.status} and cannot resume.`, {
      code, details: { stopRequested: current.stopRequested ?? null }
    });
  }
  if ((current.openHumanRequestIds ?? []).length) {
    throw new SingularityFlowError(
      `Auto flight '${id}' has an unanswered Human Request and cannot resume.`, {
        code: 'AUTO_HUMAN_REQUEST_REQUIRED',
        details: { requestIds: current.openHumanRequestIds }
      }
    );
  }
  if (current.stopRequested && !current.stopRequested.quiescedAt) {
    throw new SingularityFlowError(`Auto flight '${id}' is still stopping and cannot resume yet.`, {
      code: 'AUTO_STOP_IN_PROGRESS', details: { stopRequested: current.stopRequested }
    });
  }
  await waitForExecutionQuiescence(root, id);
  current = await readAutoFlightState(root, id);
  if (confirmation !== current.checkpointSha256) {
    throw new SingularityFlowError(`Checkpoint mismatch for '${id}'.`, {
      code: 'AUTO_CHECKPOINT_STALE', details: { expected: current.checkpointSha256 }
    });
  }
  if (!['paused', 'waiting-human', 'manual-takeover'].includes(current.status)
      || (current.stopRequested && !current.stopRequested.quiescedAt)) {
    throw new SingularityFlowError(`Auto flight '${id}' changed before resume.`, {
      code: 'AUTO_CHECKPOINT_STALE', details: { status: current.status }
    });
  }
  if ((current.openHumanRequestIds ?? []).length) {
    throw new SingularityFlowError(
      `Auto flight '${id}' gained an unanswered Human Request before resume.`, {
        code: 'AUTO_HUMAN_REQUEST_REQUIRED',
        details: { requestIds: current.openHumanRequestIds }
      }
    );
  }
  const continuation = await verifyAutoFlightContinuation(root, current);
  if (current.status === 'waiting-human' && current.position === 'submitted'
      && !continuation.phaseTransition) {
    throw new SingularityFlowError(
      `Auto flight '${id}' is waiting for the governed phase decision.`, {
        code: 'AUTO_HUMAN_BOUNDARY_PENDING',
        details: { phase: current.story.phase }
      }
    );
  }
  if (continuation.phaseTransition) {
    const { publishAutoBoundaryCheckpoint } = await import('./auto-checkpoint.mjs');
    const transition = continuation.phaseTransition;
    if (transition.kind === 'story-complete') {
      let completed = await mutateAutoFlightState(root, id, (state) => {
        if (state.story.phase !== transition.from) {
          throw new SingularityFlowError(`Auto flight '${id}' changed before completion reconciliation.`, {
            code: 'AUTO_CHECKPOINT_STALE'
          });
        }
        state.counters.phasesCompleted = (state.counters.phasesCompleted ?? 0) + 1;
        state.operations = [...(state.operations ?? []), {
          operation: 'complete-story', phase: transition.from, outcome: 'succeeded',
          commit: transition.currentHead, checkpointSha256: null
        }];
        state.stopRequested = null;
        state.status = 'completed';
        state.stopReason = 'story-complete';
        state.nextAction = 'The ratified Auto Story reached its governed completion boundary.';
      }, { expectedCheckpoint: current.checkpointSha256 });
      const report = await persistAutoFlightReport(root, completed);
      completed = await mutateAutoFlightState(root, id, (state) => {
        state.finalReportSha256 = report.reportSha256;
      }, { expectedCheckpoint: completed.checkpointSha256 });
      const pointer = await publishAutoBoundaryCheckpoint(
        completed.worktree, completed, 'completion', {
          definition: continuation.definition, workflow: continuation.workflow,
          operationalRoot: root
        }
      );
      return mutateAutoFlightState(root, id, (state) => {
        const localPointer = {
          checkpointClass: pointer.checkpointClass, path: pointer.path,
          checkpointSha256: pointer.checkpointSha256, commit: pointer.commit,
          eventId: pointer.eventId, phase: pointer.phase, position: pointer.position,
          createdAt: pointer.createdAt
        };
        state.boundaryCheckpoints = [...(state.boundaryCheckpoints ?? []), localPointer];
        state.boundaryCheckpoint = localPointer;
        state.lastSuccessfulStoryRevision = pointer.commit;
        state.story.revision = pointer.commit;
        state.commits = { ...(state.commits ?? {}), completionCheckpoint: pointer.commit };
      }, { expectedCheckpoint: completed.checkpointSha256 });
    }
    const pointer = await publishAutoBoundaryCheckpoint(
      current.worktree,
      current,
      'phase-boundary',
      {
        definition: continuation.definition, workflow: continuation.workflow,
        operationalRoot: root
      }
    );
    return mutateAutoFlightState(root, id, (state) => {
      if (state.story.phase !== transition.from) {
        throw new SingularityFlowError(`Auto flight '${id}' changed before phase reconciliation.`, {
          code: 'AUTO_CHECKPOINT_STALE'
        });
      }
      const localPointer = {
        checkpointClass: pointer.checkpointClass, path: pointer.path,
        checkpointSha256: pointer.checkpointSha256, commit: pointer.commit,
        eventId: pointer.eventId, phase: pointer.phase, position: pointer.position,
        createdAt: pointer.createdAt
      };
      state.boundaryCheckpoints = [...(state.boundaryCheckpoints ?? []), localPointer];
      state.boundaryCheckpoint = localPointer;
      state.lastSuccessfulStoryRevision = pointer.commit;
      state.commits = { ...(state.commits ?? {}), phaseBoundary: pointer.commit };
      state.counters.phasesCompleted = (state.counters.phasesCompleted ?? 0) + 1;
      state.operations = [...(state.operations ?? []), {
        operation: 'complete-phase',
        phase: transition.from, outcome: 'succeeded', commit: pointer.commit,
        checkpointSha256: pointer.checkpointSha256
      }];
      state.stopRequested = null;
      state.story.phase = transition.to;
      state.story.revision = pointer.commit;
      state.position = 'story-created';
      state.candidate = null;
      state.worldModelReference = null;
      state.comprehensionReference = null;
      state.activeAttemptId = null;
      state.activeRepair = null;
      if (state.execution?.pace?.mode === 'phase') {
        state.status = 'paused';
        state.stopReason = 'phase-boundary-reached';
        state.nextAction = `Phase '${transition.from}' is complete. Review it, then resume '${transition.to}' with the exact checkpoint hash.`;
      } else {
        state.status = 'running';
        state.stopReason = 'phase-continuation-authorized';
        state.nextAction = `Run the next bounded Auto step for phase '${transition.to}'.`;
      }
    }, { expectedCheckpoint: current.checkpointSha256 });
  }
  return mutateAutoFlightState(root, id, (state) => {
    if (!['paused', 'waiting-human', 'manual-takeover'].includes(state.status)) {
      throw new SingularityFlowError(`Auto flight '${id}' changed before resume.`, {
        code: 'AUTO_CHECKPOINT_STALE', details: { status: state.status }
      });
    }
    state.status = 'running'; state.stopReason = 'human-resumed'; state.stopRequested = null;
    state.nextAction = 'Run the next bounded Auto step; the next model attempt remains single-shot.';
  }, { expectedCheckpoint: current.checkpointSha256 });
}

export async function haltAutoFlight(root, id, reason = 'human-halted', options = {}) {
  return requestQuiescentTransition(root, id, {
    kind: 'halt', finalStatus: 'halted', finalReason: reason,
    finalNextAction: 'Create a replacement Plan to continue autonomous work.',
    quiescenceTimeoutMs: options.quiescenceTimeoutMs,
    expectedCheckpoint: options.expectedCheckpoint ?? null
  });
}

export async function takeoverAutoFlight(root, id, options = {}) {
  return requestQuiescentTransition(root, id, {
    kind: 'takeover', finalStatus: 'manual-takeover', finalReason: 'human-manual-takeover',
    finalNextAction: 'Continue manually in the preserved managed Story worktree, or resume with the exact checkpoint hash.',
    quiescenceTimeoutMs: options.quiescenceTimeoutMs,
    expectedCheckpoint: options.expectedCheckpoint ?? null
  });
}

export async function discardAutoFlight(root, id, confirmation) {
  if (confirmation !== id) throw new SingularityFlowError(`Discard requires --confirm ${id}.`, { code: 'AUTO_CONFIRMATION_REQUIRED' });
  const initial = await readAutoFlightState(root, id);
  if (initial.status === 'running') throw new SingularityFlowError('Pause or halt a running flight before discarding it.', { code: 'AUTO_FLIGHT_RUNNING' });
  if (initial.status === 'recovery-required') throw new SingularityFlowError(
    'Auto execution quiescence is unproven; recover the flight before discarding its worktree.',
    { code: 'AUTO_RECOVERY_REQUIRED' }
  );
  await waitForExecutionQuiescence(root, id);
  return withSubjectLock(root, { kind: 'auto-flight-step', id }, async () => {
    const current = await readAutoFlightState(root, id);
    if (current.status === 'running' || current.status === 'recovery-required'
        || (current.stopRequested && !current.stopRequested.quiescedAt)) {
      throw new SingularityFlowError(`Auto flight '${id}' is not safely quiesced for discard.`, {
        code: current.status === 'recovery-required' ? 'AUTO_RECOVERY_REQUIRED' : 'AUTO_STOP_IN_PROGRESS'
      });
    }
    const managedRoot = path.join(gitCommonDir(root), 'singularity-flow', 'auto-worktrees', id);
    const managedWorktree = path.resolve(current.worktree);
    if (managedWorktree !== managedRoot && !managedWorktree.startsWith(`${managedRoot}${path.sep}`)) {
      throw new SingularityFlowError(`Auto flight '${id}' worktree is outside its managed root.`, { code: 'AUTO_FLIGHT_CORRUPT' });
    }
    const removed = run('git', ['worktree', 'remove', '--force', '--', managedWorktree], { cwd: root, allowFailure: true });
    if (removed.status !== 0 && !/not a working tree|does not exist/i.test(removed.stderr || removed.stdout)) {
      throw new SingularityFlowError(`Auto worktree cleanup failed: ${(removed.stderr || removed.stdout).trim()}`, {
        code: 'AUTO_DISCARD_FAILED'
      });
    }
    const remote = run('git', ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${current.story.branch}`], {
      cwd: root, allowFailure: true
    }).status === 0;
    if (!remote) run('git', ['branch', '-D', '--', current.story.branch], { cwd: root, allowFailure: true });
    return mutateAutoFlightState(root, id, (state) => {
      state.status = 'discarded'; state.stopReason = 'human-discarded';
      state.stopRequested = { kind: 'discard', requestedAt: nowIso(), quiescedAt: nowIso() };
      state.nextAction = remote
        ? 'The published Story branch remains on the remote; the managed worktree was removed.'
        : 'The unpublished managed worktree and local Story branch were removed.';
    }, { expectedCheckpoint: current.checkpointSha256 });
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

function emptyReportLineage() {
  return Object.fromEntries(AUTO_REPORT_LINEAGE_FAMILIES.map((family) => [family, []]));
}

function validateReportLineage(flightId, value) {
  try {
    return structuredClone(validateAutoP1Snapshot(flightId, value ?? emptyReportLineage()));
  } catch (cause) {
    throw new SingularityFlowError('Auto flight report contains invalid typed lineage.', {
      code: 'AUTO_FLIGHT_CORRUPT', cause,
      details: { lineageCode: cause?.code ?? null }
    });
  }
}

function economicsAccounting(lineage, state) {
  const receipts = lineage['auto-token-economics-receipt'];
  const sum = (selector) => receipts.reduce((total, receipt) => {
    const value = selector(receipt);
    return Number.isSafeInteger(value) && value >= 0 ? total + value : total;
  }, 0);
  const allKnown = (selector) => receipts.length > 0 && receipts.every((receipt) => {
    const value = selector(receipt);
    return Number.isSafeInteger(value) && value >= 0;
  });
  const knownSum = (selector) => allKnown(selector) ? sum(selector) : null;
  const providerTokensKnown = allKnown((entry) => entry.input.providerTokens)
    && allKnown((entry) => entry.output.providerTokens);
  const providerCostKnown = receipts.length > 0
    && receipts.every((entry) => entry.cost.assurance === 'provider-reported'
      && Number.isFinite(entry.cost.amount) && entry.cost.amount >= 0);
  const receiptTotalTokens = providerTokensKnown
    ? sum((entry) => entry.input.providerTokens) + sum((entry) => entry.output.providerTokens)
    : null;
  const legacyTokensExact = receipts.length === 0 && state.token?.assurance === 'exact';
  return {
    tokens: {
      assurance: providerTokensKnown || legacyTokensExact ? 'exact' : 'unavailable',
      totalTokens: providerTokensKnown
        ? receiptTotalTokens : legacyTokensExact ? state.counters.totalTokens : null
    },
    observations: {
      receipts: receipts.length,
      pending: receipts.filter((entry) => entry.quality.verification === 'pending').length,
      passed: receipts.filter((entry) => entry.quality.verification === 'passed').length,
      failed: receipts.filter((entry) => entry.quality.verification === 'failed').length,
      promptBytes: knownSum((entry) => entry.input.promptBytes),
      estimatedInputTokens: knownSum((entry) => entry.input.estimatedTokens),
      providerInputTokens: knownSum((entry) => entry.input.providerTokens),
      cachedTokens: knownSum((entry) => entry.input.cachedTokens),
      estimatedOutputTokens: knownSum((entry) => entry.output.estimatedTokens),
      providerOutputTokens: knownSum((entry) => entry.output.providerTokens)
    },
    cost: {
      assurance: providerCostKnown ? 'provider-reported' : 'unavailable',
      amount: providerCostKnown
        ? receipts.reduce((total, entry) => total + entry.cost.amount, 0) : null
    }
  };
}

function phaseApprovalSnapshot(workflow) {
  return (workflow.phaseOrder ?? []).map((phaseId) => {
    const phase = workflow.phases?.[phaseId] ?? {};
    return {
      phase: phaseId,
      generation: Number.isSafeInteger(phase.generation) ? phase.generation : null,
      status: phase.status ?? null,
      disposition: phase.approvalDisposition ?? null,
      decisions: structuredClone(phase.approvals ?? [])
    };
  });
}

async function currentApprovalSnapshot(state) {
  try {
    const [{ loadDefinition }, { loadStoryAggregate }, { workflowPath }] = await Promise.all([
      import('../config.mjs'), import('../state-stores.mjs'), import('../state.mjs')
    ]);
    const definition = await loadDefinition(state.worktree);
    const authorityPath = workflowPath(state.worktree, definition, state.story.workId);
    const relative = path.relative(state.worktree, authorityPath);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Story authority path escaped the managed worktree');
    }
    const branchResult = run('git', ['branch', '--show-current'], {
      cwd: state.worktree, allowFailure: true
    });
    const statusResult = run('git', [
      'status', '--porcelain=v1', '--untracked-files=all', '--', relative
    ], { cwd: state.worktree, allowFailure: true });
    if (branchResult.status !== 0 || branchResult.stdout.trim() !== state.story.branch
        || statusResult.status !== 0 || statusResult.stdout.trim()) {
      throw new Error('Story approval authority is not a clean branch-backed record');
    }
    const workflow = await loadStoryAggregate(state.worktree, definition, state.story.workId);
    if (workflow.workItem?.id !== state.story.workId) throw new Error('Story authority mismatch');
    return { source: 'story-authority', approvals: phaseApprovalSnapshot(workflow) };
  } catch {
    // A final report must remain available after a worktree is removed or configuration becomes
    // temporarily unreadable. In that case retain only the approval references already sealed in
    // the last governed flight checkpoint; never invent a replacement decision.
    return {
      source: 'flight-checkpoint', approvals: structuredClone(state.approvals ?? [])
    };
  }
}

export function buildAutoFlightReport(state, {
  lineage: lineageInput = null,
  approvals: approvalsInput = state.approvals ?? [],
  approvalSource = 'flight-checkpoint'
} = {}) {
  const lineage = validateReportLineage(state.flightId, lineageInput);
  if (!['story-authority', 'flight-checkpoint'].includes(approvalSource)) {
    throw new SingularityFlowError(`Invalid Auto report approval source '${approvalSource}'.`, {
      code: 'AUTO_FLIGHT_CORRUPT'
    });
  }
  const accounting = economicsAccounting(lineage, state);
  const core = {
    schemaVersion: currentSchemaVersion('auto-flight-report'), kind: 'auto-flight-report', mode: 'auto',
    flightId: state.flightId, planId: state.planId, planSha256: state.planSha256,
    status: state.status, stopReason: state.stopReason, nextAction: state.nextAction,
    position: state.position,
    configuration: structuredClone(state.configuration ?? null),
    repositories: structuredClone(state.repositories ?? []),
    operations: structuredClone(state.operations ?? []),
    commits: structuredClone(state.commits ?? {}),
    evidence: structuredClone(state.evidence ?? {}),
    candidate: structuredClone(state.candidate ?? null),
    worldModelReference: structuredClone(state.worldModelReference ?? null),
    comprehensionReference: structuredClone(state.comprehensionReference ?? null),
    lineage,
    approvalSource,
    phaseContracts: structuredClone(state.phaseContracts ?? {}),
    boundaryCheckpoints: structuredClone(state.boundaryCheckpoints ?? []),
    boundaryCheckpoint: structuredClone(state.boundaryCheckpoint ?? null),
    lastSuccessfulStoryRevision: state.lastSuccessfulStoryRevision ?? null,
    retainedUnpublishedPaths: [
      'halted', 'paused', 'manual-takeover', 'recovery-required'
    ].includes(state.status)
      ? structuredClone(state.observedPaths ?? []) : [],
    authorityTarget: state.status === 'waiting-human'
      ? structuredClone(state.execution?.until ?? null) : null,
    quality: structuredClone(state.quality ?? []),
    approvals: structuredClone(approvalsInput),
    humanIntervention: state.stopReason?.startsWith('human-')
      || ['waiting-human', 'manual-takeover', 'recovery-required'].includes(state.status)
      ? { required: true, reason: state.stopReason, requested: state.stopRequested ?? null }
      : { required: false, reason: null, requested: null },
    lastError: structuredClone(state.lastError ?? null),
    counters: structuredClone(state.counters),
    scope: {
      predicted: { status: 'predicted', paths: structuredClone(state.scopePrediction ?? []) },
      observed: {
        status: Array.isArray(state.observedPaths) ? 'exact' : 'unavailable',
        paths: structuredClone(state.observedPaths ?? [])
      }
    },
    accounting: {
      ...accounting,
      activeMilliseconds: state.counters.activeMilliseconds ?? 0,
      elapsedMilliseconds: Math.max(0, Date.parse(state.updatedAt) - Date.parse(state.createdAt))
    },
    checkpointSha256: state.checkpointSha256
  };
  return { ...core, reportSha256: `sha256:${recordSha256(core)}` };
}

/** Build a read-only report projection from the exact current flight and its typed local lineage. */
export async function projectAutoFlightReport(root, state) {
  const before = await readAutoFlightState(root, state.flightId);
  if (state.recordSha256 !== stateHash(state)
      || before.recordSha256 !== state.recordSha256
      || before.checkpointSha256 !== state.checkpointSha256) {
    throw new SingularityFlowError(
      `Auto flight '${state.flightId}' changed before its report could be projected.`, {
        code: 'AUTO_CHECKPOINT_STALE',
        details: { expected: state.checkpointSha256, actual: before.checkpointSha256 }
      }
    );
  }
  const [lineage, approvalSnapshot] = await Promise.all([
    snapshotAutoP1Records(root, state.flightId), currentApprovalSnapshot(state)
  ]);
  const after = await readAutoFlightState(root, state.flightId);
  if (after.recordSha256 !== before.recordSha256
      || after.checkpointSha256 !== before.checkpointSha256) {
    throw new SingularityFlowError(
      `Auto flight '${state.flightId}' changed while its report was projected.`, {
        code: 'AUTO_CHECKPOINT_STALE',
        details: { expected: before.checkpointSha256, actual: after.checkpointSha256 }
      }
    );
  }
  return buildAutoFlightReport(state, {
    lineage, approvals: approvalSnapshot.approvals, approvalSource: approvalSnapshot.source
  });
}

export async function persistAutoFlightReport(root, state) {
  return withSubjectLock(root, { kind: 'auto-flight-report', id: state.flightId }, async () => {
    const currentState = await readAutoFlightState(root, state.flightId);
    if (state.recordSha256 !== stateHash(state)
        || currentState.recordSha256 !== state.recordSha256
        || currentState.checkpointSha256 !== state.checkpointSha256) {
      throw new SingularityFlowError(
        `Auto flight '${state.flightId}' changed before its report could be sealed.`, {
          code: 'AUTO_CHECKPOINT_STALE',
          details: {
            expected: state.checkpointSha256,
            actual: currentState.checkpointSha256
          }
        }
      );
    }
    const existingBytes = await readAutoPrivateRecord(
      root, reportFile(root, state.flightId), 'flight-report', { optional: true }
    );
    const existing = existingBytes == null ? null : await readAutoFlightReport(root, state.flightId);
    const terminal = ['halted', 'completed'].includes(state.status);
    if (state.finalReportSha256 != null) {
      if (!existing || existing.reportSha256 !== state.finalReportSha256) {
        throw new SingularityFlowError(
          `Auto flight '${state.flightId}' is bound to a missing or different final report.`, {
            code: 'AUTO_FLIGHT_CORRUPT',
            details: { expected: state.finalReportSha256, actual: existing?.reportSha256 ?? null }
          }
        );
      }
      return existing;
    }
    if (terminal && existing && ['halted', 'completed'].includes(existing.status)) {
      if (existing.planSha256 !== state.planSha256 || existing.status !== state.status
          || existing.checkpointSha256 !== state.checkpointSha256) {
        throw new SingularityFlowError(
          `Auto flight '${state.flightId}' already has a different immutable final report.`, {
            code: 'AUTO_FLIGHT_REPORT_CONFLICT',
            details: {
              reportSha256: existing.reportSha256, status: existing.status,
              reportCheckpointSha256: existing.checkpointSha256,
              stateCheckpointSha256: state.checkpointSha256
            }
          }
        );
      }
      return existing;
    }
    if (!terminal && existing && ['halted', 'completed'].includes(existing.status)) return existing;
    const report = await projectAutoFlightReport(root, state);
    // A terminal report is written once. A pre-existing non-terminal projection may be replaced
    // exactly once by that final record; every subsequent call returns the sealed bytes above.
    await writeAutoPrivateRecord(
      root, reportFile(root, state.flightId), 'flight-report', canonicalJson(report),
      { immutable: terminal && existing == null }
    );
    return report;
  });
}

/** Restore the exact governed final report into disposable local report storage. */
export async function restoreAutoFlightReport(root, value) {
  const id = validateFlightId(value?.flightId);
  const report = readRecord('auto-flight-report', value).record;
  validateReportLineage(id, report.lineage);
  const copy = structuredClone(report);
  delete copy.reportSha256;
  const unknown = Object.keys(report).filter((field) => !AUTO_REPORT_FIELDS.has(field));
  if (report.kind !== 'auto-flight-report' || report.mode !== 'auto'
      || report.flightId !== id || !PLAN_ID.test(String(report.planId ?? ''))
      || !CHECKPOINT.test(String(report.planSha256 ?? ''))
      || !['story-authority', 'flight-checkpoint'].includes(report.approvalSource)
      || !Array.isArray(report.approvals)
      || unknown.length
      || report.reportSha256 !== `sha256:${recordSha256(copy)}`) {
    throw new SingularityFlowError(`Auto flight report '${id}' failed its governed integrity check.`, {
      code: 'AUTO_FLIGHT_CORRUPT', details: { unknown }
    });
  }
  return withSubjectLock(root, { kind: 'auto-flight-report', id }, async () => {
    const raw = await readAutoPrivateRecord(
      root, reportFile(root, id), 'flight-report', { optional: true }
    );
    if (raw != null) {
      const existing = await readAutoFlightReport(root, id);
      if (existing.reportSha256 === report.reportSha256) return existing;
      if (['halted', 'completed'].includes(existing.status)) {
        throw new SingularityFlowError(
          `Auto flight '${id}' already has a different immutable final report.`, {
            code: 'AUTO_FLIGHT_REPORT_CONFLICT',
            details: { expected: report.reportSha256, actual: existing.reportSha256 }
          }
        );
      }
    }
    await writeAutoPrivateRecord(
      root, reportFile(root, id), 'flight-report', canonicalJson(report),
      { immutable: raw == null && ['halted', 'completed'].includes(report.status) }
    );
    return report;
  });
}

export async function readAutoFlightReport(root, value) {
  const id = validateFlightId(value);
  const raw = await readAutoPrivateRecord(root, reportFile(root, id), 'flight-report');
  let stored;
  try { stored = JSON.parse(raw); }
  catch (error) {
    throw new SingularityFlowError(`Auto flight report '${id}' is not valid JSON: ${error.message}`, {
      code: 'AUTO_FLIGHT_CORRUPT'
    });
  }
  const storedCore = structuredClone(stored);
  delete storedCore.reportSha256;
  if (stored.reportSha256 !== `sha256:${recordSha256(storedCore)}`) {
    throw new SingularityFlowError(`Auto flight report '${id}' failed its historical integrity check.`, {
      code: 'AUTO_FLIGHT_CORRUPT'
    });
  }
  const report = readRecord('auto-flight-report', stored).record;
  validateReportLineage(id, report.lineage);
  const copy = structuredClone(report);
  delete copy.reportSha256;
  const unknown = Object.keys(report).filter((field) => !AUTO_REPORT_FIELDS.has(field));
  if (report.kind !== 'auto-flight-report' || report.mode !== 'auto'
      || report.flightId !== id || !PLAN_ID.test(String(report.planId ?? ''))
      || !CHECKPOINT.test(String(report.planSha256 ?? ''))
      || !['story-authority', 'flight-checkpoint'].includes(report.approvalSource)
      || !Array.isArray(report.approvals)
      || unknown.length
      || report.reportSha256 !== `sha256:${recordSha256(copy)}`) {
    throw new SingularityFlowError(`Auto flight report '${id}' failed its integrity check.`, {
      code: 'AUTO_FLIGHT_CORRUPT', details: { unknown }
    });
  }
  return report;
}

export function renderAutoFlightReport(state, report = buildAutoFlightReport(state)) {
  const lineage = report.lineage ?? emptyReportLineage();
  return [
    `# Auto flight ${state.flightId}`,
    '', `- Status: **${state.status}**`, `- Plan: ${state.planId}`, `- Plan hash: \`${state.planSha256}\``,
    `- Story: ${state.story.workId}`, `- Current phase: ${state.story.phase ?? 'unknown'}`,
    `- Checkpoint: \`${state.checkpointSha256}\``, `- Stop reason: ${state.stopReason}`,
    `- Model invocations authorized: ${state.counters.modelInvocations}`,
    `- Phase runs: ${lineage['auto-phase-run'].length}`,
    `- Attempts: ${lineage['auto-attempt'].length}`,
    `- Refusals / Repair Plans: ${lineage['auto-refusal'].length} / ${lineage['auto-repair-plan'].length}`,
    `- Human Requests: ${lineage['auto-human-request'].length}`,
    `- Execution Unit switches: ${lineage['auto-execution-unit-switch'].length}`,
    `- Token-economics receipts: ${lineage['auto-token-economics-receipt'].length}`,
    `- Predicted scope: ${report.scope.predicted.paths.join(', ') || 'none'}`,
    `- Observed scope (${report.scope.observed.status}): ${report.scope.observed.paths.join(', ') || 'none'}`,
    `- Token accounting (${report.accounting.tokens.assurance}): ${report.accounting.tokens.totalTokens ?? 'unavailable'}`,
    `- Cost accounting (${report.accounting.cost.assurance}): ${report.accounting.cost.amount ?? 'unavailable'}`,
    `- Report hash: \`${report.reportSha256}\``,
    '', '## Next action', '', state.nextAction
  ].join('\n');
}

export async function listAutoFlights(root) {
  const names = (await listAutoPrivateRecords(root, localRoot(root))).map((entry) => entry.name);
  const states = [];
  const corrupt = [];
  for (const name of names.filter((entry) => FLIGHT_ID.test(entry))) {
    try { states.push(await readAutoFlightState(root, name)); }
    catch (error) {
      if (error?.code !== 'AUTO_FLIGHT_NOT_FOUND') corrupt.push({ flightId: name, code: error.code, message: error.message });
    }
  }
  if (corrupt.length) throw new SingularityFlowError(
    `Auto concurrency cannot be proven because ${corrupt.length} flight record(s) are unreadable.`,
    { code: 'AUTO_FLIGHT_CORRUPT', details: { corrupt } }
  );
  return states.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}
