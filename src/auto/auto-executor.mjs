/** One thin-pilot Auto phase step. Model execution is allowed only under `auto.flight-step`. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

import { verifyClarificationRecord } from '../clarifications.mjs';
import { phaseRequiresCodeDelivery } from '../code-delivery-policy.mjs';
import { resolveDeliveryQualityCommands } from '../delivery-evidence.mjs';
import { head } from '../git.mjs';
import { verifyGroundingRecord } from '../grounding.mjs';
import { generationTaskForPhase } from '../model-tasks.mjs';
import { invokeModel, resolveModelProvider } from '../model-runner.mjs';
import { loadStoryAggregate } from '../state-stores.mjs';
import { recordSha256 } from '../records.mjs';
import { SingularityFlowError } from '../util.mjs';
import { composePhasePrompt } from '../worldmodel.mjs';
import { buildRepositoryChangeSet } from '../repository-change-set.mjs';
import { evaluateStoryProtectedPaths } from '../configuration-materialization.mjs';
import { applicationChangeSetProjection, applicationPathContext } from '../work-intervals.mjs';
import { withSubjectLock } from '../subject-lock.mjs';
import { verifyAutoFlightContinuation } from './auto-continuation.mjs';
import { AUTO_AUTHORING_TOOLS } from './auto-policy.mjs';
import { publishAutoBoundaryCheckpoint } from './auto-checkpoint.mjs';
import {
  assertCompatibleAutoPhaseContract, autoPhaseContractKey, buildAutoPhaseContract
} from './auto-phase-contract.mjs';
import {
  assertAutoCandidateMatches, autoAttemptId, autoCandidateEnvironment,
  discoverAutoCandidateRecoveryAuthority, freezeAutoCandidate,
  observeAutoCandidateWorktree, readAutoCandidateBinding,
  readAutoCandidateVerification, verifyAutoCandidate
} from './auto-candidate.mjs';
import {
  beginAutoAttemptLineage, ensureAutoClarificationRequest, recordAutoAttemptAuthored,
  recordAutoAttemptCompleted, recordAutoAttemptPublished, recordAutoAttemptRefusal
} from './auto-p1-lineage.mjs';
import {
  authorizeAutoAuthoringAttempt, mutateAutoFlightState, persistAutoFlightReport, readAutoFlightState
} from './auto-flight-store.mjs';

const BIN = fileURLToPath(new URL('../../bin/singularity-flow.mjs', import.meta.url));
const SHA256 = /^sha256:[a-f0-9]{64}$/;

function allowedPath(actual, predicted) {
  return predicted.some((candidate) => actual === candidate || actual.startsWith(`${candidate.replace(/\/$/, '')}/`));
}

function tokenObservation(usage) {
  const total = Number(usage?.totalTokens ?? usage?.total_tokens);
  const available = Number.isSafeInteger(total) && total >= 0;
  return { assurance: available ? 'exact' : 'unavailable', totalTokens: available ? total : null };
}

function autoWorldModelReference(grounding) {
  const record = grounding?.record;
  if (!record) return null;
  return Object.freeze({
    protocol: 'auto-world-model-reference-v1',
    path: grounding.path,
    workId: record.workId,
    phase: record.phase,
    generation: record.generation,
    agent: record.agent,
    worldModelCommit: record.worldModelCommit,
    manifestSha256: `sha256:${record.manifestSha256}`,
    renderedSha256: `sha256:${record.renderedSha256}`,
    modelSourceTreeSha256: record.modelSourceTreeSha256,
    composedSourceTreeSha256: record.composedSourceTreeSha256,
    fresh: record.fresh === true && record.stale !== true
  });
}

function candidateRecoveryAuthority(state, phase, disposition) {
  const baseCheckpointSha256 = state.boundaryCheckpoint?.checkpointSha256 ?? null;
  if (!SHA256.test(String(baseCheckpointSha256 ?? ''))) {
    throw new SingularityFlowError(
      'Auto Candidate freeze has no governed boundary from which recovery can be proven.', {
        code: 'AUTO_CANDIDATE_RECOVERY_INVALID'
      }
    );
  }
  return {
    phase: phase.id,
    baseCheckpointSha256,
    disposition,
    attemptNumber: state.counters.authoringAttempts[phase.id] ?? 0,
    modelInvocations: state.counters.modelInvocations ?? 0,
    remote: state.repositories?.[0]?.remote ?? 'origin'
  };
}

function candidateStateProjection(binding) {
  return {
    candidateId: binding.candidateId,
    candidateSha256: binding.candidateSha256,
    bindingSha256: binding.bindingSha256,
    attemptId: binding.attemptId,
    applicationChangeSetDigest: binding.applicationChangeSetDigest,
    applicationResourceDigest: binding.applicationResourceDigest
  };
}

function candidateTouchedPaths(binding) {
  return [...new Set(binding.resourceManifest.entries.flatMap((entry) => (
    [entry.oldPath, entry.newPath].filter(Boolean)
  )))].sort();
}

async function stop(root, id, status, reason, nextAction, extra = {}, {
  activeMilliseconds = 0,
  mutateState = mutateAutoFlightState
} = {}) {
  return mutateState(root, id, (state) => {
    state.status = status;
    state.stopReason = reason;
    state.nextAction = nextAction;
    Object.assign(state, extra);
    state.counters.activeMilliseconds = (state.counters.activeMilliseconds ?? 0)
      + Math.max(0, activeMilliseconds);
  });
}

function childLifecycle(root, args, {
  signal = null, timeoutMs = 30 * 60 * 1000, env = null
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: root, env: { ...process.env, ...(env ?? {}) },
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = ''; let stderr = ''; let bytes = 0; let finished = false; let hardKillTimer = null;
    const limit = 8 * 1024 * 1024;
    const terminate = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T'], {
          stdio: 'ignore', windowsHide: true, timeout: 5_000
        });
        if (killed.error || killed.status !== 0) child.kill('SIGTERM');
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); }
        catch { child.kill('SIGTERM'); }
      }
      hardKillTimer ??= setTimeout(() => {
        if (child.exitCode != null || child.signalCode != null || !child.pid) return;
        if (process.platform === 'win32') {
          spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore', windowsHide: true, timeout: 5_000
          });
          return;
        }
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }, 2_000);
    };
    const onAbort = () => terminate();
    const timeout = setTimeout(terminate, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    const append = (current, chunk) => {
      bytes += chunk.length;
      if (bytes > limit) terminate();
      return bytes <= limit ? `${current}${chunk.toString('utf8')}` : current;
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.once('error', (error) => {
      if (finished) return;
      finished = true; clearTimeout(timeout); if (hardKillTimer) clearTimeout(hardKillTimer); signal?.removeEventListener('abort', onAbort);
      reject(new SingularityFlowError(`Unable to start lifecycle command: ${error.message}`, {
        code: 'AUTO_LIFECYCLE_STEP_FAILED', cause: error
      }));
    });
    child.once('close', (status, childSignal) => {
      if (finished) return;
      finished = true; clearTimeout(timeout); if (hardKillTimer) clearTimeout(hardKillTimer); signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new SingularityFlowError('Auto lifecycle step was cancelled.', { code: 'AUTO_STOP_REQUESTED' }));
      if (bytes > limit) return reject(new SingularityFlowError('Auto lifecycle output exceeded 8388608 bytes.', { code: 'AUTO_LIFECYCLE_STEP_FAILED' }));
      if (status !== 0) return reject(new SingularityFlowError(
        (stderr || stdout || `Lifecycle command failed: ${args.join(' ')}`).trim(), {
          code: 'AUTO_LIFECYCLE_STEP_FAILED',
          details: { command: ['singularity-flow', ...args], status, signal: childSignal }
        }
      ));
      resolve({ status, stdout, stderr, signal: childSignal });
    });
  });
}

function lifecycleJson(result, operation) {
  try { return JSON.parse(String(result?.stdout ?? '').trim()); }
  catch (error) {
    throw new SingularityFlowError(
      `Auto ${operation} did not return its exact JSON authority: ${error.message}`, {
        code: 'AUTO_LIFECYCLE_STEP_FAILED', cause: error
      }
    );
  }
}

/**
 * A confirmed repair may follow a publication/refusal that consumed the prior generation intent.
 * Reuse an exact still-open intent, otherwise use the ordinary guarded rollover preview and its
 * current application digest before any repair model receives write authority.
 */
async function ensureAutoRepairGeneration({
  root, worktree, flightId, state, definition, workflow, phase, runLifecycle
}) {
  let currentWorkflow = workflow;
  let currentPhase = phase;
  const expectedOpen = () => currentPhase.generationIntent?.status === 'open'
    && Number(currentPhase.generationIntent.generation) === Number(currentPhase.generation ?? 0) + 1
    && SHA256.test(String(currentPhase.generationIntent.receiptSha256 ?? ''));
  if (!phaseRequiresCodeDelivery(currentPhase)) {
    await runLifecycle(worktree, ['prepare', currentPhase.id]);
    await assertActive(root, flightId, state.checkpointSha256);
    currentWorkflow = await loadStoryAggregate(worktree, definition, state.story.workId);
    return { workflow: currentWorkflow, phase: currentWorkflow.phases[currentPhase.id] };
  }
  if (!expectedOpen()) {
    let cleanBeginError = null;
    try {
      await runLifecycle(worktree, ['phase', 'begin', currentPhase.id, '--json']);
      await assertActive(root, flightId, state.checkpointSha256);
    } catch (error) {
      cleanBeginError = error;
    }
    currentWorkflow = await loadStoryAggregate(worktree, definition, state.story.workId);
    currentPhase = currentWorkflow.phases[currentPhase.id];
    if (!expectedOpen() && Number(currentPhase.generation ?? 0) > 0) {
      let previewResult;
      try {
        previewResult = await runLifecycle(
          worktree, ['phase', 'rollover', currentPhase.id, '--json']
        );
      } catch {
        // A clean begin failure that has no guarded rollover is the authoritative refusal. Do not
        // reinterpret arbitrary lifecycle failures as permission to adopt changed source.
        throw cleanBeginError ?? new SingularityFlowError(
          `Auto repair begin did not create an open intent for '${currentPhase.id}'.`, {
            code: 'AUTO_GENERATION_INTENT_UNBOUND'
          }
        );
      }
      await assertActive(root, flightId, state.checkpointSha256);
      const preview = lifecycleJson(previewResult, 'repair generation rollover preview');
      if (preview.phase !== currentPhase.id
          || Number(preview.fromGeneration) !== Number(currentPhase.generation)
          || Number(preview.toGeneration) !== Number(currentPhase.generation) + 1
          || !SHA256.test(String(preview.confirmation ?? ''))
          || preview.mutates !== false) {
        throw new SingularityFlowError(
          `Auto repair generation rollover preview for '${currentPhase.id}' is not exact.`, {
            code: 'AUTO_LIFECYCLE_STEP_FAILED'
          }
        );
      }
      await runLifecycle(worktree, [
        'phase', 'rollover', currentPhase.id,
        '--confirm', preview.confirmation, '--json'
      ]);
    } else if (!expectedOpen()) {
      // The normal begin boundary remains fail-closed for dirty initial work; Auto never invents an
      // adoption confirmation or weakens repository dirty-start policy.
      throw cleanBeginError ?? new SingularityFlowError(
        `Auto repair begin did not create an open intent for '${currentPhase.id}'.`, {
          code: 'AUTO_GENERATION_INTENT_UNBOUND'
        }
      );
    }
  }
  await assertActive(root, flightId, state.checkpointSha256);
  currentWorkflow = await loadStoryAggregate(worktree, definition, state.story.workId);
  currentPhase = currentWorkflow.phases[currentPhase.id];
  if (!expectedOpen()) {
    throw new SingularityFlowError(
      `Auto repair could not bind a new open generation intent for '${currentPhase.id}'.`, {
        code: 'AUTO_GENERATION_INTENT_UNBOUND'
      }
    );
  }
  // Once the exact next intent exists, refresh deterministic artifacts/grounding under that
  // generation. Preparing earlier is intentionally refused by the lifecycle after publication.
  await runLifecycle(worktree, ['prepare', currentPhase.id]);
  await assertActive(root, flightId, state.checkpointSha256);
  currentWorkflow = await loadStoryAggregate(worktree, definition, state.story.workId);
  currentPhase = currentWorkflow.phases[currentPhase.id];
  if (!expectedOpen()) {
    throw new SingularityFlowError(
      `Auto repair prepare changed the open generation intent for '${currentPhase.id}'.`, {
        code: 'AUTO_GENERATION_INTENT_UNBOUND'
      }
    );
  }
  return { workflow: currentWorkflow, phase: currentPhase };
}

async function assertActive(root, flightId, expectedCheckpoint = null) {
  const current = await readAutoFlightState(root, flightId);
  if (expectedCheckpoint && current.checkpointSha256 !== expectedCheckpoint) {
    throw new SingularityFlowError('Auto flight changed during its active step.', { code: 'AUTO_CHECKPOINT_STALE' });
  }
  if (current.status !== 'running' || current.stopRequested) {
    throw new SingularityFlowError(`Auto flight '${flightId}' received a stop request.`, { code: 'AUTO_STOP_REQUESTED' });
  }
  return current;
}

function autoStopRequested(flightId, current) {
  return new SingularityFlowError(`Auto flight '${flightId}' received a stop request.`, {
    code: 'AUTO_STOP_REQUESTED',
    details: {
      status: current?.status ?? null,
      stopRequested: current?.stopRequested ?? null,
      checkpointSha256: current?.checkpointSha256 ?? null
    }
  });
}

/**
 * The one state-CAS path used by an executor after it has consumed authoring authorization.
 *
 * A human interrupt deliberately acquires the short state lock while the executor continues to
 * own its complete-step lease. Lock contention is therefore coordination, not an Auto failure.
 * Retry the bounded lock overlap, but never advance a stale executor checkpoint after a durable
 * pause/halt became visible.
 */
export async function mutateAutoExecutorState(root, flightId, mutate, {
  expectedCheckpoint = null,
  expectedStatuses = ['running'],
  allowStopRequested = false,
  timeoutMs = 2_000
} = {}) {
  // Count actual failed acquisitions rather than wall-clock delay. A busy CI host or suspended
  // event loop can consume two seconds without giving either participant a scheduling turn; using
  // that elapsed time as the retry budget leaked SUBJECT_LOCK_BUSY even though the human stop was
  // already queued. The attempt ceiling remains bounded while measuring real contention.
  const maximumAttempts = Math.max(1, Math.ceil(timeoutMs / 20));
  let attempts = 0;
  const statusSet = new Set(expectedStatuses);
  for (;;) {
    const current = await readAutoFlightState(root, flightId);
    if ((!allowStopRequested && current.stopRequested) || !statusSet.has(current.status)) {
      throw autoStopRequested(flightId, current);
    }
    if (expectedCheckpoint && current.checkpointSha256 !== expectedCheckpoint) {
      throw new SingularityFlowError('Auto flight changed during its active step.', {
        code: 'AUTO_CHECKPOINT_STALE',
        details: { expected: expectedCheckpoint, actual: current.checkpointSha256 }
      });
    }
    try {
      return await mutateAutoFlightState(root, flightId, mutate, { expectedCheckpoint });
    } catch (error) {
      if (!['SUBJECT_LOCK_BUSY', 'AUTO_CHECKPOINT_STALE'].includes(error?.code)) throw error;
      const observed = await readAutoFlightState(root, flightId);
      if ((!allowStopRequested && observed.stopRequested) || !statusSet.has(observed.status)) {
        throw autoStopRequested(flightId, observed);
      }
      // A changed checkpoint with no stop is a real competing mutation. The complete-step lease
      // means it cannot be another legitimate executor, so never adopt and overwrite it.
      if (error.code === 'AUTO_CHECKPOINT_STALE' || ++attempts >= maximumAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

function cancellationMonitor(root, flightId, controller) {
  let checking = false;
  const timer = setInterval(async () => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    try {
      const current = await readAutoFlightState(root, flightId);
      if (current.status !== 'running' || current.stopRequested) controller.abort();
    } catch { controller.abort(); }
    finally { checking = false; }
  }, 100);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function stoppedByHuman(root, flightId, error, activeSince) {
  if (![
    'AUTO_STOP_REQUESTED', 'MODEL_CANCELLED', 'AUTO_CHECKPOINT_STALE',
    'SUBJECT_LOCK_BUSY', 'AUTO_FLIGHT_NOT_RUNNING'
  ].includes(error?.code)) return null;
  // The interrupt is durable before pause/halt waits for the step lease. The executor can observe
  // that new checkpoint while the interrupt command is still releasing the short-lived state
  // lock. Treat that as ordinary coordination, not as an authoring failure. A stale checkpoint is
  // retried as well so a concurrent pause-to-halt escalation cannot lose final time accounting.
  const deadline = Date.now() + 2_000;
  for (;;) {
    const current = await readAutoFlightState(root, flightId);
    if (current.status === 'running' && !current.stopRequested) return null;
    try {
      return await mutateAutoExecutorState(root, flightId, (draft) => {
        draft.counters.activeMilliseconds = (draft.counters.activeMilliseconds ?? 0)
          + Math.max(0, Date.now() - activeSince);
      }, {
        expectedCheckpoint: current.checkpointSha256,
        expectedStatuses: [...new Set([current.status, 'paused', 'halted'])],
        allowStopRequested: true
      });
    } catch (mutationError) {
      if (!['SUBJECT_LOCK_BUSY', 'AUTO_CHECKPOINT_STALE'].includes(mutationError?.code)
          || Date.now() >= deadline) throw mutationError;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

function selectorReached(until, phaseId, boundary) {
  return until?.phase === phaseId && until?.kind === boundary;
}

async function finishAtBoundary(root, flightId, state, phaseId, boundary) {
  if (!selectorReached(state.execution.until, phaseId, boundary)) return null;
  let completed = await mutateAutoExecutorState(root, flightId, (draft) => {
    draft.status = 'completed';
    draft.stopReason = 'requested-boundary-reached';
    draft.nextAction = `The ratified Auto boundary '${boundary}:${phaseId}' was reached; inspect the governed Story.`;
  }, { expectedCheckpoint: state.checkpointSha256 });
  completed = await attachFinalReport(root, completed);
  completed = await persistGovernedBoundary(root, completed, 'completion');
  return completed;
}

async function persistGovernedBoundary(root, state, checkpointClass, options = {}) {
  const pointer = await publishAutoBoundaryCheckpoint(
    state.worktree, state, checkpointClass, { ...options, operationalRoot: root }
  );
  return mutateAutoExecutorState(root, state.flightId, (draft) => {
    const localPointer = {
      checkpointClass: pointer.checkpointClass, path: pointer.path,
      checkpointSha256: pointer.checkpointSha256, commit: pointer.commit,
      eventId: pointer.eventId, phase: pointer.phase, position: pointer.position,
      createdAt: pointer.createdAt
    };
    draft.boundaryCheckpoints = [...(draft.boundaryCheckpoints ?? []), localPointer];
    draft.boundaryCheckpoint = localPointer;
    draft.lastSuccessfulStoryRevision = pointer.commit;
    draft.commits = { ...(draft.commits ?? {}), [`${checkpointClass}Checkpoint`]: pointer.commit };
  }, {
    expectedCheckpoint: state.checkpointSha256,
    expectedStatuses: [state.status],
    allowStopRequested: state.status !== 'running'
  });
}

async function attachFinalReport(root, state) {
  if (!['halted', 'completed'].includes(state.status)) return state;
  const report = await persistAutoFlightReport(root, state);
  if (state.finalReportSha256 === report.reportSha256) return state;
  return mutateAutoExecutorState(root, state.flightId, (draft) => {
    draft.finalReportSha256 = report.reportSha256;
  }, {
    expectedCheckpoint: state.checkpointSha256,
    expectedStatuses: [state.status],
    allowStopRequested: true
  });
}

async function pauseAtStepBoundary(root, flightId, state, phaseId, boundary) {
  if (state.execution?.pace?.mode !== 'step') return null;
  return mutateAutoExecutorState(root, flightId, (draft) => {
    draft.status = 'paused';
    draft.stopReason = 'step-boundary-reached';
    draft.stopRequested = null;
    draft.nextAction = `Review '${boundary}' for phase '${phaseId}', then resume with the exact checkpoint hash.`;
  }, { expectedCheckpoint: state.checkpointSha256 });
}

function protectedPathEvaluation(definition, workflow, changeSet) {
  const protectedPaths = [...new Set([
    'singularity/workflow.yml', 'singularity/capabilities.yml',
    ...(definition.governance?.protectedPaths ?? []),
    ...(workflow.resolution?.capability?.policy?.protectedPaths ?? [])
  ])];
  return evaluateStoryProtectedPaths(changeSet, protectedPaths, workflow);
}

async function executeAutoFlightStepLocked(root, flightId, confirmation, runtime = {}) {
  let activeAccountedAt = Date.now();
  const stopActive = async (status, reason, nextAction, extra = {}) => {
    const activeSince = activeAccountedAt;
    const now = Date.now();
    const activeMilliseconds = now - activeAccountedAt;
    activeAccountedAt = now;
    try {
      const stopped = await stop(root, flightId, status, reason, nextAction, extra, {
        activeMilliseconds,
        mutateState: mutateAutoExecutorState
      });
      const reported = await attachFinalReport(root, stopped);
      const checkpointClass = status === 'completed' ? 'completion'
        : ['waiting-human', 'halted'].includes(status) ? 'human-boundary' : 'recovery';
      try { return await persistGovernedBoundary(root, reported, checkpointClass); }
      catch (checkpointError) {
        return mutateAutoExecutorState(root, flightId, (draft) => {
          draft.status = 'recovery-required';
          draft.stopReason = 'governed-checkpoint-publication-failed';
          draft.nextAction = 'Repair or synchronize Story publication, then recover from the last governed Auto checkpoint.';
          draft.lastError = {
            code: checkpointError.code ?? 'AUTO_CHECKPOINT_PUBLICATION_FAILED',
            message: checkpointError.message
          };
        }, {
          expectedCheckpoint: reported.checkpointSha256,
          expectedStatuses: [reported.status],
          allowStopRequested: true
        });
      }
    } catch (error) {
      const humanStop = await stoppedByHuman(root, flightId, error, activeSince);
      if (humanStop) return humanStop;
      throw error;
    }
  };
  const runLifecycle = runtime.childLifecycle ?? childLifecycle;
  const runModel = runtime.invokeModel ?? invokeModel;
  const boundary = runtime.boundary ?? (async () => {});
  let state = await readAutoFlightState(root, flightId);
  let activeAttempt = null;
  const preserveFailedAuthoringCandidate = async ({ phase, workflow, plan, error }) => {
    if (!activeAttempt || !phaseRequiresCodeDelivery(phase)) return state;
    let current = await readAutoFlightState(root, flightId);
    if (current.candidate?.candidateId) return current;
    const pathContext = applicationPathContext(
      continuation.definition, workflow
    );
    const baselineCommit = phase.generationIntent?.baseline?.commit
      ?? plan.repositories[0].baseCommit;
    const changeSet = await buildRepositoryChangeSet(current.worktree, {
      baseCommit: baselineCommit,
      subject: { kind: 'story', id: current.story.workId, phase: phase.id }
    });
    const applicationChangeSet = applicationChangeSetProjection(changeSet, pathContext);
    if (!applicationChangeSet.entries.length) return current;
    const files = [...new Set(applicationChangeSet.entries.flatMap((entry) => [
      entry.oldPath, entry.newPath
    ]).filter(Boolean))].sort();
    const candidate = await freezeAutoCandidate(current.worktree, {
      flightId,
      attemptId: activeAttempt.attemptId,
      baselineCommit,
      pathContext,
      executionUnitId: current.executionUnit?.id ?? 'configured-provider',
      attemptKind: activeAttempt.attemptKind === 'repair'
        ? 'repair-authoring' : 'phase-authoring',
      recoveryAuthority: candidateRecoveryAuthority(
        current, phase, 'preserved-after-failure'
      )
    });
    current = await readAutoFlightState(root, flightId);
    current = await mutateAutoExecutorState(root, flightId, (draft) => {
      draft.candidate = {
        candidateId: candidate.candidateId,
        candidateSha256: candidate.candidateSha256,
        bindingSha256: candidate.bindingSha256,
        attemptId: candidate.attemptId,
        applicationChangeSetDigest: candidate.applicationChangeSetDigest,
        applicationResourceDigest: candidate.applicationResourceDigest
      };
      draft.observedPaths = files;
      draft.counters.touchedPaths = files.length;
      draft.counters.touchedChanges = applicationChangeSet.entries.length;
      draft.evidence = {
        ...(draft.evidence ?? {}),
        changeSetDigest: applicationChangeSet.digest,
        candidateSha256: candidate.candidateSha256,
        candidateBindingSha256: candidate.bindingSha256
      };
      draft.operations = [...(draft.operations ?? []), {
        operation: 'candidate-freeze', phase: phase.id,
        outcome: 'preserved-after-failure',
        candidateId: candidate.candidateId,
        candidateSha256: candidate.candidateSha256,
        bindingSha256: candidate.bindingSha256,
        failureCode: error?.code ?? 'MODEL_PROVIDER_FAILED'
      }];
    }, {
      expectedCheckpoint: current.checkpointSha256,
      expectedStatuses: [current.status],
      allowStopRequested: true
    });
    // Model failure or cancellation after a write is itself a crash boundary. Make the retained
    // Candidate reachable from remote authority before returning a refusal or honoring a stop.
    return persistGovernedBoundary(root, current,
      current.status === 'running' ? 'phase-boundary' : 'human-boundary');
  };
  if (confirmation !== state.checkpointSha256) throw new SingularityFlowError(`Auto step checkpoint mismatch for '${flightId}'.`, {
    code: 'AUTO_CHECKPOINT_STALE', details: { expected: state.checkpointSha256 }
  });
  if (state.status !== 'running') throw new SingularityFlowError(`Auto flight '${flightId}' is ${state.status}.`, {
    code: 'AUTO_FLIGHT_NOT_RUNNING', details: { nextAction: state.nextAction }
  });
  let continuation;
  try { continuation = await verifyAutoFlightContinuation(root, state); }
  catch (error) {
    return stopActive('halted', 'continuation-binding-mismatch',
      'Inspect the governed Story binding and create a continuation or replacement Plan before continuing.', {
      lastError: { code: error.code ?? 'AUTO_PLAN_STALE', message: error.message }
    });
  }
  let { plan } = continuation;

  // A human may approve the submitted phase between Auto invocations. That is an authorized
  // adjacent transition, not an external-state violation. Persist the completed phase boundary,
  // reconcile the local projection, and either pause at the configured pace or continue on the
  // exact same ratified rail.
  if (continuation.phaseTransition) {
    const transition = continuation.phaseTransition;
    if (transition.kind === 'story-complete') {
      state = await mutateAutoExecutorState(root, flightId, (draft) => {
        draft.counters.phasesCompleted = (draft.counters.phasesCompleted ?? 0) + 1;
        draft.status = 'completed';
        draft.stopReason = 'story-complete';
        draft.nextAction = 'The ratified Auto Story reached its governed completion boundary.';
      }, { expectedCheckpoint: state.checkpointSha256 });
      state = await attachFinalReport(root, state);
      return persistGovernedBoundary(root, state, 'completion', {
        definition: continuation.definition, workflow: continuation.workflow
      });
    }
    state = await persistGovernedBoundary(root, state, 'phase-boundary', {
      definition: continuation.definition, workflow: continuation.workflow
    });
    state = await mutateAutoExecutorState(root, flightId, (draft) => {
      draft.counters.phasesCompleted = (draft.counters.phasesCompleted ?? 0) + 1;
      draft.operations = [...(draft.operations ?? []), {
        operation: 'complete-phase', phase: transition.from, outcome: 'succeeded',
        commit: draft.lastSuccessfulStoryRevision,
        checkpointSha256: draft.boundaryCheckpoint?.checkpointSha256 ?? null
      }];
      draft.story.phase = transition.to;
      draft.story.revision = draft.lastSuccessfulStoryRevision;
      draft.position = 'story-created';
      draft.candidate = null;
      draft.worldModelReference = null;
      draft.comprehensionReference = null;
      draft.activePhaseRunId = null;
      draft.activeAttemptId = null;
      draft.activeRefusalId = null;
      draft.activeRepairPlanId = null;
      draft.activeRepair = null;
      draft.finalReportSha256 = null;
      const pause = ['phase', 'step'].includes(draft.execution?.pace?.mode);
      draft.status = pause ? 'paused' : 'running';
      draft.stopReason = draft.execution?.pace?.mode === 'phase'
        ? 'phase-boundary-reached'
        : draft.execution?.pace?.mode === 'step'
          ? 'step-boundary-reached' : 'phase-continuation-authorized';
      draft.nextAction = pause
        ? `Review completed phase '${transition.from}', then resume '${transition.to}' with the exact checkpoint hash.`
        : `Continue the ratified rail at phase '${transition.to}'.`;
    }, { expectedCheckpoint: state.checkpointSha256 });
    if (state.status !== 'running') return state;
    continuation = await verifyAutoFlightContinuation(root, state);
    ({ plan } = continuation);
  }

  const elapsedMinutes = (Date.now() - Date.parse(state.createdAt)) / 60_000;
  if (elapsedMinutes >= state.execution.ceilings.maximumElapsedMinutes) {
    return stopActive('halted', 'elapsed-time-ceiling',
      'Create and ratify a replacement Plan; the elapsed authorization window has expired.', {
        ceiling: { name: 'maximumElapsedMinutes', maximum: state.execution.ceilings.maximumElapsedMinutes, consumed: elapsedMinutes }
      });
  }
  const maximumActiveMs = state.execution.ceilings.maximumActiveMinutes * 60 * 1000;
  if ((state.counters.activeMilliseconds ?? 0) >= maximumActiveMs) {
    return stopActive('halted', 'active-time-ceiling',
      'Create and ratify a replacement Plan; the cumulative active-time budget is exhausted.', {
        ceiling: { name: 'maximumActiveMinutes', maximum: maximumActiveMs, consumed: state.counters.activeMilliseconds ?? 0 }
      });
  }
  if (state.counters.phasesCompleted >= state.execution.ceilings.maximumPhases) {
    return stopActive('halted', 'phase-ceiling',
      'Create and ratify a replacement Plan to authorize another phase.', {
        ceiling: { name: 'maximumPhases', maximum: state.execution.ceilings.maximumPhases, consumed: state.counters.phasesCompleted }
      });
  }

  const worktree = state.worktree;
  let { definition, workflow } = continuation;
  let phase;
  try {
    phase = workflow.phases[workflow.currentPhase];
    if (!phase || phase.id !== state.story.phase) throw new SingularityFlowError('Story phase changed outside the Auto flight.', { code: 'AUTO_FLIGHT_STALE' });
    if (workflow.executionOrigin?.flightId !== flightId || workflow.executionOrigin?.planSha256 !== state.planSha256) {
      throw new SingularityFlowError('Story Auto origin does not match the flight.', { code: 'AUTO_FLIGHT_STALE' });
    }
    const clarification = await verifyClarificationRecord(worktree, definition, workflow, phase);
    if (clarification.errors.length) {
      const stopped = await stopActive('waiting-human', 'clarification-required', clarification.errors[0]);
      return (await ensureAutoClarificationRequest(root, flightId, clarification.errors[0])).flight ?? stopped;
    }
  } catch (error) {
    if (error.code === 'AUTO_FLIGHT_STALE') {
      return stopActive('halted', 'external-state-change', 'Inspect the governed Story and create a replacement Plan.', {
        lastError: { code: error.code, message: error.message }
      });
    }
    throw error;
  }

  // Freeze publishes an immutable attempt journal before returning. Reconcile that authority before
  // the uncertain-attempt guard so a process exit on the next instruction never triggers a second
  // model invocation. A failure-preservation journal remains a human boundary; only a journal that
  // was created after all authored scope checks can enter the ordinary verification continuation.
  const consumedAttempt = (state.counters.authoringAttempts[phase.id] ?? 0) > 0;
  if (consumedAttempt && !state.candidate
      && ['story-created', 'repair-authorized'].includes(state.position)) {
    let recovered;
    try {
      recovered = await discoverAutoCandidateRecoveryAuthority(worktree, {
        flightId,
        phase: phase.id,
        baseCheckpointSha256: state.boundaryCheckpoint?.checkpointSha256,
        remote: state.repositories?.[0]?.remote ?? 'origin'
      });
    } catch (error) {
      return stopActive('recovery-required', 'candidate-recovery-authority-unavailable',
        'The authoring attempt was consumed, but its immutable Candidate recovery authority could not be verified. Repair remote access and recover; Auto will not invoke a model again.', {
          lastError: {
            code: error.code ?? 'AUTO_CANDIDATE_RECOVERY_FAILED', message: error.message
          }
        });
    }
    if (recovered) {
      const expectedBaseline = phase.generationIntent?.baseline?.commit
        ?? plan.repositories[0].baseCommit;
      const binding = recovered.binding;
      if (binding.repository.baselineCommit !== expectedBaseline
          || (state.activeAttemptId && state.activeAttemptId !== binding.attemptId)
          || recovered.attemptNumber !== state.counters.authoringAttempts[phase.id]
          || recovered.modelInvocations !== state.counters.modelInvocations) {
        return stopActive('recovery-required', 'candidate-recovery-binding-mismatch',
          'The retained Candidate does not bind the current governed generation and was not adopted.', {
            lastError: {
              code: 'AUTO_CANDIDATE_RECOVERY_CONFLICT',
              message: 'Candidate attempt or baseline differs from the current Auto authority.'
            }
          });
      }
      const files = candidateTouchedPaths(binding);
      state = await mutateAutoExecutorState(root, flightId, (draft) => {
        draft.candidate = candidateStateProjection(binding);
        draft.observedPaths = files;
        draft.counters.touchedPaths = files.length;
        draft.counters.touchedChanges = binding.resourceManifest.entries.length;
        draft.evidence = {
          ...(draft.evidence ?? {}),
          changeSetDigest: binding.applicationChangeSetDigest,
          candidateSha256: binding.candidateSha256,
          candidateBindingSha256: binding.bindingSha256
        };
        draft.operations = [...(draft.operations ?? []), {
          operation: 'candidate-freeze', phase: phase.id,
          outcome: recovered.disposition === 'authored'
            ? 'recovered-after-crash' : 'recovered-preserved-after-failure',
          candidateId: binding.candidateId,
          candidateSha256: binding.candidateSha256,
          bindingSha256: binding.bindingSha256
        }];
        if (recovered.disposition === 'authored') {
          draft.position = 'authored';
          draft.stopReason = 'candidate-freeze-recovered';
          draft.nextAction = 'Verify and publish the exact recovered Candidate; no model will be invoked.';
        } else {
          draft.status = 'waiting-human';
          draft.stopReason = 'failed-authoring-candidate-recovered';
          draft.nextAction = 'Review the exact preserved Candidate and choose a bounded repair or manual takeover.';
        }
      }, { expectedCheckpoint: state.checkpointSha256 });
      if (recovered.disposition !== 'authored') {
        return persistGovernedBoundary(root, state, 'human-boundary');
      }
      try {
        const observed = await observeAutoCandidateWorktree(
          worktree, binding, applicationPathContext(definition, workflow)
        );
        assertAutoCandidateMatches(binding, observed);
      } catch (error) {
        return stopActive('recovery-required', 'candidate-worktree-diverged',
          'The exact Candidate is retained remotely, but the working tree changed after the crash. Review or restore the retained Candidate; Auto will not invoke a model again.', {
            lastError: { code: error.code ?? 'AUTO_CANDIDATE_CHANGED', message: error.message }
          });
      }
      if (state.activeAttemptId) {
        await recordAutoAttemptAuthored(root, flightId, state.activeAttemptId, {
          invocation: { invocationId: state.lastInvocationId ?? null, usage: {} },
          candidateSha256: binding.candidateSha256,
          worldModelReference: state.worldModelReference ?? null,
          comprehensionReference: state.comprehensionReference ?? null
        });
      }
      state = await persistGovernedBoundary(root, state, 'phase-boundary');
    }
  }

  // A crash before a Candidate was durably frozen is not permission for a second model call.
  if (consumedAttempt && !state.candidate
      && ['story-created', 'repair-authorized'].includes(state.position)) {
    return stopActive('halted', 'authoring-attempt-state-uncertain',
      'Inspect the retained worktree. Auto will not guess whether a prior model attempt changed it.');
  }

  if (['story-created', 'repair-authorized'].includes(state.position)) {
    const repairAttempt = state.position === 'repair-authorized';
    let attemptConsumed = false;
    try {
      if (!repairAttempt) {
        await runLifecycle(worktree, ['prepare', phase.id]);
        await assertActive(root, flightId, state.checkpointSha256);
        // Auto enters the same durable generation boundary as an interactive author before any model
        // can touch source. Publishing without this intent made Auto a privileged bypass of the
        // code-generation assurance contract.
        if (phaseRequiresCodeDelivery(phase)) {
          await runLifecycle(worktree, ['phase', 'begin', phase.id]);
          await assertActive(root, flightId, state.checkpointSha256);
        }
      } else {
        ({ workflow, phase } = await ensureAutoRepairGeneration({
          root, worktree, flightId, state, definition, workflow, phase, runLifecycle
        }));
      }
      if (!repairAttempt) {
        workflow = await loadStoryAggregate(worktree, definition, state.story.workId);
        phase = workflow.phases[phase.id];
      }
      const task = generationTaskForPhase(definition, phase.id);
      const composed = await composePhasePrompt(worktree, {
        workId: state.story.workId, phase: phase.id, agent: phase.defaultAgent
      });
      const grounding = await verifyGroundingRecord(
        worktree, definition, workflow, phase, { agent: phase.defaultAgent }
      );
      if (grounding.errors.length) {
        throw new SingularityFlowError(
          `Auto grounding authority is not ready: ${grounding.errors.join('; ')}`, {
            code: 'AUTO_GROUNDING_REFERENCE_INVALID',
            details: { phase: phase.id, path: grounding.path }
          }
        );
      }
      const worldModelReference = autoWorldModelReference(grounding);
      if (phase.generationPolicy?.producer === 'deterministic'
          && !phaseRequiresCodeDelivery(phase)) {
        const deterministicActiveMilliseconds = Date.now() - activeAccountedAt;
        activeAccountedAt = Date.now();
        state = await mutateAutoExecutorState(root, flightId, (draft) => {
          draft.position = 'authored';
          draft.worldModelReference = structuredClone(worldModelReference);
          draft.comprehensionReference = null;
          draft.candidate = null;
          draft.stopReason = 'deterministic-authoring-complete';
          draft.nextAction = `Publish kernel-authored phase '${phase.id}' through the normal lifecycle operation.`;
          draft.operations = [...(draft.operations ?? []), {
            operation: 'prepare', phase: phase.id, outcome: 'succeeded',
            producer: 'deterministic', invocationId: null
          }];
          draft.counters.activeMilliseconds = (draft.counters.activeMilliseconds ?? 0)
            + deterministicActiveMilliseconds;
        }, { expectedCheckpoint: state.checkpointSha256 });
        state = await persistGovernedBoundary(root, state, 'phase-boundary');
        const stepBoundary = await pauseAtStepBoundary(
          root, flightId, state, phase.id, 'authored'
        );
        if (stepBoundary) return stepBoundary;
        return executeAutoFlightStepLocked(
          root, flightId, state.checkpointSha256, runtime
        );
      }
      if (state.execution.ceilings.tokenBudget.assurance === 'exact-required') {
        return stopActive('halted', 'token-assurance-unavailable',
          'Exact remaining token budget cannot be proven before invocation; finish manually or ratify a best-available Plan.', {
            token: { assurance: 'unavailable', totalTokens: null },
            ceiling: state.execution.ceilings.tokenBudget
          });
      }
      const selectedDefinition = state.executionUnit?.id
        ? { ...definition, models: { ...definition.models, defaultProvider: state.executionUnit.id } }
        : definition;
      const provider = resolveModelProvider(selectedDefinition);
      const phaseContractState = {
        ...state, worldModelReference,
        // CMP is observe-only until a reviewed comprehension receipt is supplied by the phase.
        comprehensionReference: null
      };
      const phaseContract = await buildAutoPhaseContract(worktree, {
        state: phaseContractState, plan, definition, workflow, phase, task, composed, provider
      });
      const phaseContractKey = autoPhaseContractKey(phase.id, phaseContract, {
        repairPlanId: repairAttempt ? state.activeRepairPlanId : null
      });
      state = await mutateAutoExecutorState(root, flightId, (draft) => {
        const existing = draft.phaseContracts?.[phaseContractKey] ?? null;
        assertCompatibleAutoPhaseContract(existing, phaseContract, phaseContractKey);
        draft.phaseContracts = {
          ...(draft.phaseContracts ?? {}), [phaseContractKey]: structuredClone(phaseContract)
        };
        draft.worldModelReference = structuredClone(worldModelReference);
        draft.comprehensionReference = null;
        draft.evidence = {
          ...(draft.evidence ?? {}), phaseContractSha256: phaseContract.contractSha256
        };
      }, { expectedCheckpoint: state.checkpointSha256 });
      state = await authorizeAutoAuthoringAttempt(root, flightId, phase.id);
      if (state.status !== 'running') {
        // Ceiling enforcement inside the atomic authorization CAS is terminal. It still needs the
        // same immutable report and governed resting checkpoint as every other halt.
        if (state.status === 'halted') {
          state = await attachFinalReport(root, state);
          try { return await persistGovernedBoundary(root, state, 'human-boundary'); }
          catch (checkpointError) {
            return mutateAutoExecutorState(root, flightId, (draft) => {
              draft.status = 'recovery-required';
              draft.stopReason = 'governed-checkpoint-publication-failed';
              draft.nextAction = 'Repair Story publication, then recover from the last governed Auto checkpoint.';
              draft.lastError = {
                code: checkpointError.code ?? 'AUTO_CHECKPOINT_PUBLICATION_FAILED',
                message: checkpointError.message
              };
            }, {
              expectedCheckpoint: state.checkpointSha256,
              expectedStatuses: ['halted'], allowStopRequested: true
            });
          }
        }
        return state;
      }
      attemptConsumed = true;
      const lineage = await beginAutoAttemptLineage(root, flightId, {
        phase, phaseContract
      });
      state = lineage.state;
      activeAttempt = lineage.attempt;
      let authoringCheckpoint = state.checkpointSha256;
      const prompt = [
        composed.trimEnd(), '', '# Ratified Auto execution boundary', '',
        `- Flight: ${flightId}`,
        `- Attempt: ${activeAttempt.attemptId} (${activeAttempt.attemptKind})`,
        `- Plan: ${plan.planId} (${plan.planSha256})`,
        `- Requirement: ${plan.requirement.text}`,
        `- Predicted repository paths: ${plan.proposal.predictedPaths.join(', ') || 'none'}`,
        ...(repairAttempt ? [
          `- Exact Repair Plan: ${state.activeRepair?.repairPlanId} (${state.activeRepair?.repairPlanSha256})`,
          `- Repair objective: ${state.activeRepair?.objective}`,
          `- Repair write scope: ${(state.activeRepair?.writeScope ?? []).join(', ') || 'none'}`,
          `- Required repair evidence: ${(state.activeRepair?.requiredEvidence ?? []).join('; ') || 'none'}`,
          '- This is the only authorized repair attempt. Do not expand scope or repeat prior work.'
        ] : []),
        '- Work only in this managed worktree. Do not commit, push, approve, waive policy, answer clarification, change lifecycle state, or run Singularity Flow commands.',
        phase.generationPolicy?.producer === 'deterministic'
          ? '- Implement and test the requirement. Do not edit the phase artifact; the kernel will regenerate its deterministic summary from your changes.'
          : '- Implement and test the requirement, and completely author the configured phase artifact. Do not leave placeholders.'
      ].join('\n');
      const controller = new AbortController();
      const stopMonitoring = cancellationMonitor(root, flightId, controller);
      let invocation;
      try {
        const invocationBudgetMs = maximumActiveMs - (state.counters.activeMilliseconds ?? 0)
          - Math.max(0, Date.now() - activeAccountedAt);
        if (invocationBudgetMs <= 0) {
          return stopActive('halted', 'active-time-ceiling',
            'The cumulative active-time budget was exhausted before model authoring.');
        }
        await boundary('model-start', { root, worktree, flightId, phase: phase.id });
        await assertActive(root, flightId, authoringCheckpoint);
        invocation = await runModel({
          provider: provider.provider,
          providerConfig: provider.providerConfig,
          task,
          cwd: path.resolve(worktree), allowedRoots: [path.resolve(worktree)],
          prompt: { text: prompt }, channel: 'auto-phase-authoring', signal: controller.signal,
          subject: {
            kind: 'story', id: state.story.workId, phase: phase.id,
            generation: Number(phase.generationIntent?.generation ?? (Number(phase.generation ?? 0) + 1)),
            generationIntentId: phase.generationIntent?.id ?? null,
            flightId, planSha256: plan.planSha256
          },
          tools: {
            mode: 'allowlist', names: [...AUTO_AUTHORING_TOOLS],
            scope: {
              readRoots: phaseContract.readRoots,
              writeRoots: phaseContract.writeRoots
            }
          },
          limits: {
            timeoutMs: Math.min(20 * 60 * 1000, invocationBudgetMs),
            outputBytes: 4 * 1024 * 1024
          }
        });
        await boundary('model-complete', { root, worktree, flightId, phase: phase.id, invocation });
      } finally { stopMonitoring(); }
      await assertActive(root, flightId, authoringCheckpoint);
      const token = tokenObservation(invocation.usage);
      const invocationActiveMilliseconds = Date.now() - activeAccountedAt;
      activeAccountedAt = Date.now();
      state = await mutateAutoExecutorState(root, flightId, (draft) => {
        draft.lastInvocationId = invocation.invocationId;
        draft.token = token;
        draft.counters.totalTokens = (draft.counters.totalTokens ?? 0) + (token.totalTokens ?? 0);
        draft.counters.activeMilliseconds = (draft.counters.activeMilliseconds ?? 0)
          + invocationActiveMilliseconds;
      }, { expectedCheckpoint: authoringCheckpoint });
      authoringCheckpoint = state.checkpointSha256;
      if (state.execution.ceilings.tokenBudget.assurance === 'exact-required' && token.assurance !== 'exact') {
        return stopActive('halted', 'token-assurance-unavailable',
          'Finish manually or ratify a Plan whose token policy permits best-available assurance.', {
            token, lastInvocationId: invocation.invocationId
          });
      }
      const cumulativeTokens = state.counters.totalTokens ?? 0;
      if (token.totalTokens != null && cumulativeTokens > state.execution.ceilings.tokenBudget.maximum) {
        return stopActive('halted', 'token-budget-breached',
          `The flight used ${cumulativeTokens} cumulative tokens; the Plan maximum is ${state.execution.ceilings.tokenBudget.maximum}.`, {
            token, lastInvocationId: invocation.invocationId
          });
      }
      const changeSet = await buildRepositoryChangeSet(worktree, {
        baseCommit: plan.repositories[0].baseCommit,
        subject: { kind: 'story', id: state.story.workId, phase: phase.id }
      });
      const protectedResult = protectedPathEvaluation(definition, workflow, changeSet);
      const pathContext = applicationPathContext(definition, workflow);
      const applicationChangeSet = applicationChangeSetProjection(changeSet, pathContext);
      const applicationEntries = applicationChangeSet.entries;
      const files = [...new Set(applicationEntries.flatMap((entry) => [entry.oldPath, entry.newPath]).filter(Boolean))].sort();
      const protectedPaths = protectedResult.violations.map((violation) => violation.path);
      if (protectedPaths.length) {
        return stopActive('halted', 'protected-path-contact',
          `Review retained worktree changes to protected paths: ${protectedPaths.join(', ')}.`, {
            touchedPaths: files, lastInvocationId: invocation.invocationId
          });
      }
      const outside = files.filter((file) => !allowedPath(file, plan.proposal.predictedPaths));
      if (outside.length) {
        return stopActive('halted', 'scope-expansion',
          `Review retained worktree changes outside the ratified prediction: ${outside.join(', ')}.`, {
            touchedPaths: files, lastInvocationId: invocation.invocationId
          });
      }
      if (files.length > state.execution.ceilings.maximumTouchedPaths) {
        return stopActive('halted', 'touched-path-ceiling',
          `The worktree has ${files.length} touched paths; the Plan maximum is ${state.execution.ceilings.maximumTouchedPaths}.`, {
            touchedPaths: files, lastInvocationId: invocation.invocationId
          });
      }
      if (applicationEntries.length > state.execution.ceilings.maximumTouchedChanges) {
        return stopActive('halted', 'touched-change-ceiling',
          `The canonical change set has ${applicationEntries.length} changed entries; the Plan maximum is ${state.execution.ceilings.maximumTouchedChanges}.`, {
            touchedPaths: files, lastInvocationId: invocation.invocationId
          });
      }
      if (phase.generationPolicy?.producer === 'deterministic') {
        // Re-render after source authoring so the kernel-owned summary names the actual paths. The
        // model cannot claim authorship of or smuggle prose into this artifact.
        await runLifecycle(worktree, ['prepare', phase.id]);
        await assertActive(root, flightId, authoringCheckpoint);
      }
      // Quiescence is established by the complete-step lease: the model process has exited and no
      // other Auto executor can enter this flight. Freeze the exact application source tree and
      // resource delta into content-addressed Git objects outside the mutable worktree before any
      // verification or publication authority can be created.
      const candidateAttemptId = activeAttempt?.attemptId ?? autoAttemptId({
        flightId,
        phase: phase.id,
        attemptNumber: state.counters.authoringAttempts[phase.id] ?? 1,
        generationIntentId: phase.generationIntent?.id ?? null
      });
      const candidateBaselineCommit = phase.generationIntent?.baseline?.commit
        ?? plan.repositories[0].baseCommit;
      const candidate = phaseRequiresCodeDelivery(phase) ? await freezeAutoCandidate(worktree, {
        flightId,
        attemptId: candidateAttemptId,
        baselineCommit: candidateBaselineCommit,
        pathContext,
        executionUnitId: state.executionUnit?.id ?? provider.provider,
        attemptKind: activeAttempt?.attemptKind === 'repair' ? 'repair-authoring' : 'phase-authoring',
        recoveryAuthority: candidateRecoveryAuthority(state, phase, 'authored')
      }) : null;
      await assertActive(root, flightId, authoringCheckpoint);
      const authoringActiveMilliseconds = Date.now() - activeAccountedAt;
      activeAccountedAt = Date.now();
      state = await mutateAutoExecutorState(root, flightId, (draft) => {
        draft.position = 'authored';
        draft.counters.touchedPaths = files.length;
        draft.counters.touchedChanges = applicationEntries.length;
        draft.observedPaths = files;
        draft.lastInvocationId = invocation.invocationId;
        draft.candidate = candidate ? {
          candidateId: candidate.candidateId,
          candidateSha256: candidate.candidateSha256,
          bindingSha256: candidate.bindingSha256,
          attemptId: candidate.attemptId,
          applicationChangeSetDigest: candidate.applicationChangeSetDigest,
          applicationResourceDigest: candidate.applicationResourceDigest
        } : null;
        draft.evidence = {
          ...(draft.evidence ?? {}),
          changeSetDigest: applicationChangeSet.digest,
          candidateSha256: candidate?.candidateSha256 ?? null,
          candidateBindingSha256: candidate?.bindingSha256 ?? null
        };
        draft.operations = [...(draft.operations ?? []), {
          operation: 'author', phase: phase.id, outcome: 'succeeded',
          invocationId: invocation.invocationId, changeSetDigest: applicationChangeSet.digest
        }, ...(candidate ? [{
          operation: 'candidate-freeze', phase: phase.id, outcome: 'succeeded',
          candidateId: candidate.candidateId, candidateSha256: candidate.candidateSha256,
          bindingSha256: candidate.bindingSha256
        }] : [])];
        draft.token = token;
        draft.counters.activeMilliseconds = (draft.counters.activeMilliseconds ?? 0) + authoringActiveMilliseconds;
        draft.stopReason = 'authoring-complete';
        draft.nextAction = 'Publish the exact authored generation through the normal lifecycle operation.';
      }, { expectedCheckpoint: authoringCheckpoint });
      await recordAutoAttemptAuthored(root, flightId, activeAttempt.attemptId, {
        invocation, candidateSha256: candidate?.candidateSha256 ?? null,
        worldModelReference: state.worldModelReference ?? null,
        comprehensionReference: state.comprehensionReference ?? null
      });
      // Freeze is a crash boundary. Retain the immutable Candidate remotely and bind the complete
      // sealed binding into Story authority before verification or publication can begin. A lost
      // local `.git` store can therefore resume publication without another model invocation.
      state = await persistGovernedBoundary(root, state, 'phase-boundary');
      const stepBoundary = await pauseAtStepBoundary(root, flightId, state, phase.id, 'authored');
      if (stepBoundary) return stepBoundary;
    } catch (error) {
      if (attemptConsumed && activeAttempt) {
        try {
          state = await preserveFailedAuthoringCandidate({
            phase, workflow, plan, error
          });
        } catch (preservationError) {
          return stopActive('recovery-required', 'candidate-preservation-failed',
            'The model may have changed application bytes, but Auto could not seal them into recoverable authority. Inspect the retained worktree before any continuation.', {
              lastError: {
                code: preservationError.code ?? 'AUTO_CANDIDATE_PRESERVATION_FAILED',
                message: preservationError.message
              }
            });
        }
      }
      const humanStop = await stoppedByHuman(root, flightId, error, activeAccountedAt);
      if (humanStop) return humanStop;
      let refusal = null;
      if (attemptConsumed && activeAttempt) refusal = await recordAutoAttemptRefusal(root, flightId, {
        attemptId: activeAttempt.attemptId, phase: phase.id, gate: 'authoring',
        code: error.code ?? 'MODEL_PROVIDER_FAILED', message: error.message,
        candidateSha256: state.candidate?.candidateSha256 ?? null,
        verificationReceiptSha256: state.candidate?.verificationReceiptSha256 ?? null,
        changedPaths: state.observedPaths ?? [], repairScope: state.activeRepair?.writeScope ?? state.scopePrediction ?? []
      });
      return stopActive(refusal?.secondFailure ? 'halted' : attemptConsumed ? 'waiting-human' : 'halted',
        refusal?.secondFailure ? 'repair-attempt-exhausted' : attemptConsumed ? 'repair-review-required' : 'authoring-preflight-failed',
        refusal?.secondFailure
          ? 'Take over the preserved Story manually; Auto will not run another repair.'
          : attemptConsumed
            ? `Review refusal ${refusal?.refusal.refusalId}; Auto will not repair until its exact Repair Plan is confirmed.`
            : 'Repair the deterministic preflight and resume with the exact checkpoint; no authoring attempt was consumed.', {
          lastError: { code: error.code ?? 'MODEL_PROVIDER_FAILED', message: error.message }
        });
    }
  }

  if (state.position === 'authored') {
    try {
      await assertActive(root, flightId, state.checkpointSha256);
      let candidate = null;
      let candidateVerification = null;
      if (phaseRequiresCodeDelivery(phase)) {
        if (!state.candidate?.candidateId || !state.candidate?.candidateSha256) {
          throw new SingularityFlowError('Auto publication has no frozen Candidate authority.', {
            code: 'AUTO_CANDIDATE_NOT_FOUND'
          });
        }
        candidate = await readAutoCandidateBinding(worktree, {
          flightId, candidateId: state.candidate.candidateId
        });
        const candidateObservation = await observeAutoCandidateWorktree(
          worktree, candidate, applicationPathContext(definition, workflow)
        );
        assertAutoCandidateMatches(candidate, candidateObservation);
        const commands = await resolveDeliveryQualityCommands(worktree, phase);
        candidateVerification = await verifyAutoCandidate(worktree, candidate, {
          commands, pathContext: applicationPathContext(definition, workflow)
        });
        const verificationActiveMilliseconds = Date.now() - activeAccountedAt;
        activeAccountedAt = Date.now();
        state = await mutateAutoExecutorState(root, flightId, (draft) => {
          draft.candidate = {
            ...draft.candidate,
            verificationReceiptSha256: candidateVerification.verificationReceiptSha256
          };
          draft.evidence = {
            ...(draft.evidence ?? {}),
            candidateVerificationSha256: candidateVerification.verificationReceiptSha256
          };
          draft.operations = [...(draft.operations ?? []), {
            operation: 'candidate-verify', phase: phase.id, outcome: 'succeeded',
            candidateSha256: candidate.candidateSha256,
            verificationReceiptSha256: candidateVerification.verificationReceiptSha256
          }];
          draft.counters.activeMilliseconds = (draft.counters.activeMilliseconds ?? 0)
            + verificationActiveMilliseconds;
          draft.stopReason = 'candidate-verified';
        }, { expectedCheckpoint: state.checkpointSha256 });
        // Verification is also immutable authority. Checkpoint it before the publication child
        // process so a crash cannot silently rerun tests or lose the exact receipt being bound.
        state = await persistGovernedBoundary(root, state, 'phase-boundary');
      }
      const remainingActiveMs = maximumActiveMs - (state.counters.activeMilliseconds ?? 0)
        - Math.max(0, Date.now() - activeAccountedAt);
      if (remainingActiveMs <= 0) {
        return stopActive('halted', 'active-time-ceiling',
          'The cumulative active-time budget was exhausted before publication.');
      }
      const deterministic = phase.generationPolicy?.producer === 'deterministic';
      const controller = new AbortController();
      const stopMonitoring = cancellationMonitor(root, flightId, controller);
      try {
        await runLifecycle(worktree, [
          'phase', 'publish', phase.id,
          '--authored', deterministic ? 'deterministic' : 'governed-agent',
          '--channel', deterministic ? 'kernel-generator' : 'kernel-model'
        ], {
          signal: controller.signal,
          timeoutMs: remainingActiveMs,
          env: candidate ? autoCandidateEnvironment(candidate, candidateVerification) : null
        });
      } finally { stopMonitoring(); }
      await assertActive(root, flightId, state.checkpointSha256);
      const publicationActiveMilliseconds = Date.now() - activeAccountedAt;
      activeAccountedAt = Date.now();
      state = await mutateAutoExecutorState(root, flightId, (draft) => {
        draft.position = 'published'; draft.stopReason = 'generation-published';
        draft.counters.activeMilliseconds = (draft.counters.activeMilliseconds ?? 0) + publicationActiveMilliseconds;
        draft.commits = { ...(draft.commits ?? {}), generation: head(worktree) };
        draft.lastSuccessfulStoryRevision = head(worktree);
        draft.operations = [...(draft.operations ?? []), {
          operation: 'publish', phase: phase.id, outcome: 'succeeded', commit: head(worktree),
          candidateSha256: candidate?.candidateSha256 ?? null,
          candidateBindingSha256: candidate?.bindingSha256 ?? null,
          candidateVerificationSha256: candidateVerification?.verificationReceiptSha256 ?? null
        }];
        draft.nextAction = 'Submit the published generation through the normal lifecycle operation.';
      }, { expectedCheckpoint: state.checkpointSha256 });
      if (state.activeAttemptId) await recordAutoAttemptPublished(root, flightId, state.activeAttemptId, {
        generation: Number(phase.generation ?? phase.generationIntent?.generation ?? 0) || null,
        candidateSha256: state.candidate?.candidateSha256 ?? null,
        verificationReceiptSha256: state.candidate?.verificationReceiptSha256 ?? null,
        publicationReceiptSha256: `sha256:${recordSha256({
          flightId, phase: phase.id, commit: state.commits?.generation ?? null
        })}`
      });
      state = await persistGovernedBoundary(root, state, 'publication-boundary');
      const boundary = await finishAtBoundary(root, flightId, state, phase.id, 'published');
      if (boundary) return boundary;
      const stepBoundary = await pauseAtStepBoundary(root, flightId, state, phase.id, 'published');
      if (stepBoundary) return stepBoundary;
    } catch (error) {
      const failedVerificationSha256 = error?.details?.verificationReceiptSha256 ?? null;
      if (failedVerificationSha256 && state.candidate?.candidateId) {
        try {
          const failedVerification = await readAutoCandidateVerification(worktree, {
            flightId,
            candidateId: state.candidate.candidateId,
            verificationReceiptSha256: failedVerificationSha256
          });
          state = await mutateAutoExecutorState(root, flightId, (draft) => {
            draft.candidate = {
              ...draft.candidate,
              verificationReceiptSha256: failedVerification.verificationReceiptSha256
            };
            draft.evidence = {
              ...(draft.evidence ?? {}),
              candidateVerificationSha256: failedVerification.verificationReceiptSha256
            };
            draft.operations = [...(draft.operations ?? []), {
              operation: 'candidate-verify', phase: phase.id, outcome: 'failed',
              candidateSha256: draft.candidate.candidateSha256,
              verificationReceiptSha256: failedVerification.verificationReceiptSha256
            }];
          }, { expectedCheckpoint: state.checkpointSha256 });
          // The failed receipt is immutable evidence too. Make it remote-reconstructible before
          // creating the refusal that names the verification failure.
          state = await persistGovernedBoundary(root, state, 'phase-boundary');
        } catch (preservationError) {
          return stopActive('recovery-required', 'verification-receipt-preservation-failed',
            'Auto could not bind the failed Candidate verification receipt into governed authority. Repair recovery state before continuing.', {
              lastError: {
                code: preservationError.code ?? 'AUTO_CANDIDATE_VERIFICATION_CORRUPT',
                message: preservationError.message
              }
            });
        }
      }
      const humanStop = await stoppedByHuman(root, flightId, error, activeAccountedAt);
      if (humanStop) return humanStop;
      const refusal = state.activeAttemptId ? await recordAutoAttemptRefusal(root, flightId, {
        attemptId: state.activeAttemptId, phase: phase.id, gate: 'generation-publication',
        code: error.code ?? 'AUTO_LIFECYCLE_STEP_FAILED', message: error.message,
        candidateSha256: state.candidate?.candidateSha256 ?? null,
        verificationReceiptSha256: state.candidate?.verificationReceiptSha256 ?? null,
        changedPaths: state.observedPaths ?? [], repairScope: state.scopePrediction ?? []
      }) : null;
      return stopActive(refusal?.secondFailure ? 'halted' : 'waiting-human',
        refusal?.secondFailure ? 'repair-attempt-exhausted' : 'repair-review-required',
        refusal?.secondFailure
          ? 'Take over the preserved Story manually; Auto will not run another repair.'
          : `Review refusal ${refusal?.refusal.refusalId}; confirm at most one bounded repair or take over.`, {
          lastError: { code: error.code ?? 'AUTO_LIFECYCLE_STEP_FAILED', message: error.message }
        });
    }
  }

  if (state.position === 'published') {
    try {
      await assertActive(root, flightId, state.checkpointSha256);
      const remainingActiveMs = maximumActiveMs - (state.counters.activeMilliseconds ?? 0)
        - Math.max(0, Date.now() - activeAccountedAt);
      if (remainingActiveMs <= 0) {
        return stopActive('halted', 'active-time-ceiling',
          'The cumulative active-time budget was exhausted before submission.');
      }
      const controller = new AbortController();
      const stopMonitoring = cancellationMonitor(root, flightId, controller);
      try { await runLifecycle(worktree, ['submit', phase.id], { signal: controller.signal, timeoutMs: remainingActiveMs }); }
      finally { stopMonitoring(); }
      await assertActive(root, flightId, state.checkpointSha256);
      const submissionActiveMilliseconds = Date.now() - activeAccountedAt;
      activeAccountedAt = Date.now();
      const current = await loadStoryAggregate(worktree, definition, state.story.workId);
      const completed = current.phases[phase.id];
      if (phaseRequiresCodeDelivery(completed)
          && (completed.deliveryEvidence?.autoCandidate?.candidateSha256
            !== state.candidate?.candidateSha256
            || completed.deliveryEvidence?.autoCandidate?.bindingSha256
              !== state.candidate?.bindingSha256
            || completed.deliveryEvidence?.autoCandidateVerification?.verificationReceiptSha256
              !== state.candidate?.verificationReceiptSha256)) {
        throw new SingularityFlowError(
          'Submitted delivery evidence is not bound to the frozen Auto Candidate.',
          { code: 'AUTO_CANDIDATE_SUBMISSION_MISMATCH' }
        );
      }
      const submittedPacket = [...(current.lineage?.submissions ?? [])].reverse().find((entry) =>
        entry.phase === phase.id && Number(entry.generation) === Number(completed.generation)) ?? null;
      const waiting = completed.status === 'awaiting_approval';
      const stopped = await mutateAutoExecutorState(root, flightId, (draft) => {
        draft.position = 'submitted';
        draft.commits = { ...(draft.commits ?? {}), submission: head(worktree) };
        draft.lastSuccessfulStoryRevision = head(worktree);
        draft.evidence = {
          ...(draft.evidence ?? {}),
          changeSetDigest: completed.deliveryEvidence?.changeSet?.digest ?? draft.evidence?.changeSetDigest ?? null,
          reviewPacketSha256: submittedPacket?.packetSha256 ?? null,
          artifactSetSha256: submittedPacket?.projection?.submissionEvidence?.artifactSetSha256 ?? null
        };
        draft.operations = [...(draft.operations ?? []), {
          operation: 'submit', phase: phase.id, outcome: 'succeeded', commit: head(worktree),
          reviewPacketSha256: submittedPacket?.packetSha256 ?? null
        }];
        draft.quality = (completed.checks ?? []).map((check) => ({
          id: check.id, status: check.status, requirement: check.requirement ?? 'required'
        }));
        draft.approvals = (completed.approvals ?? []).filter((approval) => !approval.invalidatedAt).map((approval) => ({
          decision: approval.decision, authorityGroup: approval.authorityGroup ?? null,
          actor: approval.actor ?? null, at: approval.at ?? null
        }));
        draft.counters.activeMilliseconds = (draft.counters.activeMilliseconds ?? 0) + submissionActiveMilliseconds;
        const submittedBoundary = selectorReached(draft.execution.until, phase.id, 'submitted');
        const completedBoundary = selectorReached(draft.execution.until, phase.id, 'phase-complete')
          && completed.status === 'approved';
        draft.status = submittedBoundary || completedBoundary
          ? 'completed' : waiting ? 'waiting-human' : 'running';
        draft.stopReason = submittedBoundary || completedBoundary
          ? 'requested-boundary-reached'
          : waiting ? 'approval-required' : 'phase-decision-recorded';
        draft.nextAction = waiting && !submittedBoundary
          ? `Review and decide phase '${phase.id}' through the normal human approval path.`
          : draft.status === 'running'
            ? 'Continue across the exact governed phase boundary.'
            : 'The ratified Auto endpoint was reached; inspect the governed Story.';
      }, { expectedCheckpoint: state.checkpointSha256 });
      if (stopped.activeAttemptId) await recordAutoAttemptCompleted(root, flightId, stopped.activeAttemptId, {
        candidateSha256: stopped.candidate?.candidateSha256 ?? null,
        verificationReceiptSha256: stopped.candidate?.verificationReceiptSha256 ?? null,
        publicationReceiptSha256: `sha256:${recordSha256({
          flightId, phase: phase.id, generation: completed.generation,
          commit: stopped.commits?.submission ?? null, packetSha256: submittedPacket?.packetSha256 ?? null
        })}`
      });
      if (stopped.status === 'waiting-human') {
        // The final report is immutable and authority-backed at a terminal boundary. A
        // waiting-human summary would necessarily become stale after the human decision and must
        // not occupy that final-report slot.
        return persistGovernedBoundary(root, stopped, 'human-boundary');
      }
      if (stopped.status === 'completed') {
        const reported = await attachFinalReport(root, stopped);
        return persistGovernedBoundary(root, reported, 'completion');
      }
      const next = await verifyAutoFlightContinuation(root, stopped);
      if (!next.phaseTransition) {
        return stopActive('halted', 'phase-transition-missing',
          'Submission completed without one exact adjacent governed phase transition.', {
            lastError: { code: 'AUTO_CHECKPOINT_STALE', message: 'No adjacent phase transition was recorded.' }
          });
      }
      if (next.phaseTransition.kind === 'story-complete') {
        let completed = await mutateAutoExecutorState(root, flightId, (draft) => {
          draft.counters.phasesCompleted = (draft.counters.phasesCompleted ?? 0) + 1;
          draft.status = 'completed';
          draft.stopReason = 'story-complete';
          draft.nextAction = 'The ratified Auto Story reached its governed completion boundary.';
        }, {
          expectedCheckpoint: stopped.checkpointSha256,
          expectedStatuses: ['running']
        });
        completed = await attachFinalReport(root, completed);
        return persistGovernedBoundary(root, completed, 'completion', {
          definition: next.definition, workflow: next.workflow
        });
      }
      let checkpointed = await persistGovernedBoundary(root, stopped, 'phase-boundary', {
        definition: next.definition, workflow: next.workflow
      });
      checkpointed = await mutateAutoExecutorState(root, flightId, (draft) => {
        draft.counters.phasesCompleted = (draft.counters.phasesCompleted ?? 0) + 1;
        draft.story.phase = next.phaseTransition.to;
        draft.story.revision = draft.lastSuccessfulStoryRevision;
        draft.position = 'story-created';
        draft.candidate = null;
        draft.worldModelReference = null;
        draft.comprehensionReference = null;
        draft.activeAttemptId = null;
        draft.activeRepair = null;
        const pauseForPhase = draft.execution?.pace?.mode === 'phase';
        const pauseForStep = draft.execution?.pace?.mode === 'step';
        draft.status = pauseForPhase || pauseForStep ? 'paused' : 'running';
        draft.stopReason = pauseForPhase ? 'phase-boundary-reached'
          : pauseForStep ? 'step-boundary-reached' : 'phase-continuation-authorized';
        draft.nextAction = draft.status === 'running'
          ? `Continue the ratified rail at phase '${next.phaseTransition.to}'.`
          : `Review completed phase '${next.phaseTransition.from}', then resume '${next.phaseTransition.to}' with the exact checkpoint hash.`;
      }, {
        expectedCheckpoint: checkpointed.checkpointSha256,
        expectedStatuses: ['running']
      });
      if (checkpointed.status === 'running'
          && checkpointed.execution?.pace?.mode === 'continuous') {
        return executeAutoFlightStepLocked(
          root, flightId, checkpointed.checkpointSha256, runtime
        );
      }
      return checkpointed;
    } catch (error) {
      const humanStop = await stoppedByHuman(root, flightId, error, activeAccountedAt);
      if (humanStop) return humanStop;
      const refusal = state.activeAttemptId ? await recordAutoAttemptRefusal(root, flightId, {
        attemptId: state.activeAttemptId, phase: phase.id, gate: 'verification-or-submission',
        code: error.code ?? 'AUTO_LIFECYCLE_STEP_FAILED', message: error.message,
        candidateSha256: state.candidate?.candidateSha256 ?? null,
        changedPaths: state.observedPaths ?? [], repairScope: state.scopePrediction ?? []
      }) : null;
      return stopActive(refusal?.secondFailure ? 'halted' : 'waiting-human',
        refusal?.secondFailure ? 'repair-attempt-exhausted' : 'repair-review-required',
        refusal?.secondFailure
          ? 'Take over the preserved Story manually; Auto will not run another repair.'
          : `Review refusal ${refusal?.refusal.refusalId}; confirm at most one bounded repair or take over.`, {
          lastError: { code: error.code ?? 'AUTO_LIFECYCLE_STEP_FAILED', message: error.message }
        });
    }
  }
  return readAutoFlightState(root, flightId);
}

/** Hold one durable step lease from checkpoint validation through the final state transition. */
export async function executeAutoFlightStep(root, flightId, confirmation, runtime = {}) {
  return withSubjectLock(root, { kind: 'auto-flight-step', id: flightId }, () =>
    executeAutoFlightStepLocked(root, flightId, confirmation, runtime));
}
