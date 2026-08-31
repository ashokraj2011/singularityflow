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

const FLIGHT_ID = /^AFL-[A-F0-9]{26}$/;
const PLAN_ID = /^APL-[A-F0-9]{26}$/;
const CHECKPOINT = /^sha256:[a-f0-9]{64}$/;
export const AUTO_FLIGHT_STATUSES = Object.freeze([
  'running', 'paused', 'waiting-human', 'manual-takeover',
  'recovery-required', 'halted', 'completed', 'discarded'
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
    stopRequested: state.stopRequested ?? null
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
  if (state.kind !== 'auto-flight-state' || state.mode !== 'auto'
      || state.flightId !== id || !PLAN_ID.test(String(state.planId ?? ''))
      || !CHECKPOINT.test(String(state.planSha256 ?? ''))
      || state.recordSha256 !== stateHash(state)
      || state.checkpointSha256 !== checkpointHash(state)) {
    throw new SingularityFlowError(`Auto flight '${id}' failed its integrity check.`, { code: 'AUTO_FLIGHT_CORRUPT' });
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

async function requestStopMutation(root, id, mutate, timeoutMs = 2_000) {
  const maximumAttempts = Math.max(1, Math.ceil(timeoutMs / 20));
  let attempts = 0;
  for (;;) {
    try { return await mutateAutoFlightState(root, id, mutate); }
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
  quiescenceTimeoutMs = 15_000
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
  });
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
  return requestStopMutation(root, id, (state) => {
    if (state.stopRequested?.requestId !== requestId || state.status !== finalStatus) {
      throw new SingularityFlowError(`Auto flight '${id}' changed while '${kind}' was proving quiescence.`, {
        code: 'AUTO_CHECKPOINT_STALE', details: { status: state.status }
      });
    }
    state.stopRequested = { ...state.stopRequested, quiescedAt: nowIso() };
  });
}

export async function pauseAutoFlight(root, id, options = {}) {
  return requestQuiescentTransition(root, id, {
    kind: 'pause', finalStatus: 'paused', finalReason: 'human-paused',
    finalNextAction: 'Resume with the exact checkpoint hash when ready.',
    quiescenceTimeoutMs: options.quiescenceTimeoutMs
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
  await verifyAutoFlightContinuation(root, current);
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
    quiescenceTimeoutMs: options.quiescenceTimeoutMs
  });
}

export async function takeoverAutoFlight(root, id, options = {}) {
  return requestQuiescentTransition(root, id, {
    kind: 'takeover', finalStatus: 'manual-takeover', finalReason: 'human-manual-takeover',
    finalNextAction: 'Continue manually in the preserved managed Story worktree, or resume with the exact checkpoint hash.',
    quiescenceTimeoutMs: options.quiescenceTimeoutMs
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

export function buildAutoFlightReport(state) {
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
    lastSuccessfulStoryRevision: state.lastSuccessfulStoryRevision ?? null,
    retainedUnpublishedPaths: [
      'halted', 'paused', 'manual-takeover', 'recovery-required'
    ].includes(state.status)
      ? structuredClone(state.observedPaths ?? []) : [],
    authorityTarget: state.status === 'waiting-human'
      ? structuredClone(state.execution?.until ?? null) : null,
    quality: structuredClone(state.quality ?? []),
    approvals: structuredClone(state.approvals ?? []),
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
      tokens: {
        assurance: state.token?.assurance ?? 'unavailable',
        totalTokens: state.token?.assurance === 'exact' ? state.counters.totalTokens : null
      },
      activeMilliseconds: state.counters.activeMilliseconds ?? 0,
      elapsedMilliseconds: Math.max(0, Date.parse(state.updatedAt) - Date.parse(state.createdAt)),
      cost: { assurance: 'unavailable', amount: null }
    },
    checkpointSha256: state.checkpointSha256
  };
  return { ...core, reportSha256: `sha256:${recordSha256(core)}` };
}

export async function persistAutoFlightReport(root, state) {
  const report = buildAutoFlightReport(state);
  await writeAutoPrivateRecord(
    root, reportFile(root, state.flightId), 'flight-report', canonicalJson(report), { immutable: true }
  );
  return report;
}

export async function readAutoFlightReport(root, value) {
  const id = validateFlightId(value);
  const raw = await readAutoPrivateRecord(root, reportFile(root, id), 'flight-report');
  const report = readRecord('auto-flight-report', raw).record;
  const copy = structuredClone(report);
  delete copy.reportSha256;
  if (report.kind !== 'auto-flight-report' || report.mode !== 'auto'
      || report.flightId !== id || !PLAN_ID.test(String(report.planId ?? ''))
      || !CHECKPOINT.test(String(report.planSha256 ?? ''))
      || report.reportSha256 !== `sha256:${recordSha256(copy)}`) {
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
