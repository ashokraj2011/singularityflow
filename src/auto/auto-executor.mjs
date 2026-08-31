/** One thin-pilot Auto phase step. Model execution is allowed only under `auto.flight-step`. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

import { verifyClarificationRecord } from '../clarifications.mjs';
import { loadDefinition } from '../config.mjs';
import { head } from '../git.mjs';
import { generationTaskForPhase } from '../model-tasks.mjs';
import { invokeModel, resolveModelProvider } from '../model-runner.mjs';
import { loadStoryAggregate } from '../state-stores.mjs';
import { SingularityFlowError } from '../util.mjs';
import { composePhasePrompt } from '../worldmodel.mjs';
import { buildRepositoryChangeSet } from '../repository-change-set.mjs';
import { evaluateStoryProtectedPaths } from '../configuration-materialization.mjs';
import { applicationChangeSetProjection, applicationPathContext } from '../work-intervals.mjs';
import { withSubjectLock } from '../subject-lock.mjs';
import { readAutoPlan, revalidateAutoPlan } from './auto-plan.mjs';
import { AUTO_AUTHORING_TOOLS } from './auto-policy.mjs';
import {
  authorizeAutoAuthoringAttempt, mutateAutoFlightState, persistAutoFlightReport, readAutoFlightState
} from './auto-flight-store.mjs';

const BIN = fileURLToPath(new URL('../../bin/singularity-flow.mjs', import.meta.url));

function allowedPath(actual, predicted) {
  return predicted.some((candidate) => actual === candidate || actual.startsWith(`${candidate.replace(/\/$/, '')}/`));
}

function tokenObservation(usage) {
  const total = Number(usage?.totalTokens ?? usage?.total_tokens);
  const available = Number.isSafeInteger(total) && total >= 0;
  return { assurance: available ? 'exact' : 'unavailable', totalTokens: available ? total : null };
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

function childLifecycle(root, args, { signal = null, timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: root, env: process.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']
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
  const deadline = Date.now() + timeoutMs;
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
      if (error.code === 'AUTO_CHECKPOINT_STALE' || Date.now() >= deadline) throw error;
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
  const completed = await mutateAutoExecutorState(root, flightId, (draft) => {
    draft.status = 'completed';
    draft.stopReason = 'requested-boundary-reached';
    draft.nextAction = `The ratified Auto boundary '${boundary}:${phaseId}' was reached; inspect the governed Story.`;
  }, { expectedCheckpoint: state.checkpointSha256 });
  const report = await persistAutoFlightReport(root, completed);
  return mutateAutoExecutorState(root, flightId, (draft) => {
    draft.finalReportSha256 = report.reportSha256;
  }, { expectedCheckpoint: completed.checkpointSha256, expectedStatuses: ['completed'] });
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
      return await stop(root, flightId, status, reason, nextAction, extra, {
        activeMilliseconds,
        mutateState: mutateAutoExecutorState
      });
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
  if (confirmation !== state.checkpointSha256) throw new SingularityFlowError(`Auto step checkpoint mismatch for '${flightId}'.`, {
    code: 'AUTO_CHECKPOINT_STALE', details: { expected: state.checkpointSha256 }
  });
  if (state.status !== 'running') throw new SingularityFlowError(`Auto flight '${flightId}' is ${state.status}.`, {
    code: 'AUTO_FLIGHT_NOT_RUNNING', details: { nextAction: state.nextAction }
  });
  const plan = await readAutoPlan(root, state.planId);
  try { await revalidateAutoPlan(root, plan); }
  catch (error) {
    return stopActive('halted', 'plan-drift', 'Create and ratify a replacement Plan before continuing.', {
      lastError: { code: error.code ?? 'AUTO_PLAN_STALE', message: error.message }
    });
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
  let definition;
  let workflow;
  let phase;
  try {
    definition = await loadDefinition(worktree);
    workflow = await loadStoryAggregate(worktree, definition, state.story.workId);
    phase = workflow.phases[workflow.currentPhase];
    if (!phase || phase.id !== state.story.phase) throw new SingularityFlowError('Story phase changed outside the Auto flight.', { code: 'AUTO_FLIGHT_STALE' });
    if (workflow.executionOrigin?.flightId !== flightId || workflow.executionOrigin?.planSha256 !== state.planSha256) {
      throw new SingularityFlowError('Story Auto origin does not match the flight.', { code: 'AUTO_FLIGHT_STALE' });
    }
    const clarification = await verifyClarificationRecord(worktree, definition, workflow, phase);
    if (clarification.errors.length) {
      return stopActive('waiting-human', 'clarification-required', clarification.errors[0]);
    }
  } catch (error) {
    if (error.code === 'AUTO_FLIGHT_STALE') {
      return stopActive('halted', 'external-state-change', 'Inspect the governed Story and create a replacement Plan.', {
        lastError: { code: error.code, message: error.message }
      });
    }
    throw error;
  }

  // A crash after authoring is not permission for a second model call. Only the publish/submit
  // continuation is replayable; an attempt without an authored checkpoint halts for inspection.
  if ((state.counters.authoringAttempts[phase.id] ?? 0) > 0 && state.position === 'story-created') {
    return stopActive('halted', 'authoring-attempt-state-uncertain',
      'Inspect the retained worktree. Auto will not guess whether a prior model attempt changed it.');
  }

  if (state.position === 'story-created') {
    let attemptConsumed = false;
    try {
      await runLifecycle(worktree, ['prepare', phase.id]);
      await assertActive(root, flightId, state.checkpointSha256);
      // Auto enters the same durable generation boundary as an interactive author before any model
      // can touch source. Publishing without this intent made Auto a privileged bypass of the
      // code-generation assurance contract.
      await runLifecycle(worktree, ['phase', 'begin', phase.id]);
      await assertActive(root, flightId, state.checkpointSha256);
      workflow = await loadStoryAggregate(worktree, definition, state.story.workId);
      phase = workflow.phases[phase.id];
      const task = generationTaskForPhase(definition, phase.id);
      const composed = await composePhasePrompt(worktree, {
        workId: state.story.workId, phase: phase.id, agent: phase.defaultAgent
      });
      if (state.execution.ceilings.tokenBudget.assurance === 'exact-required') {
        return stopActive('halted', 'token-assurance-unavailable',
          'Exact remaining token budget cannot be proven before invocation; finish manually or ratify a best-available Plan.', {
            token: { assurance: 'unavailable', totalTokens: null },
            ceiling: state.execution.ceilings.tokenBudget
          });
      }
      state = await authorizeAutoAuthoringAttempt(root, flightId, phase.id);
      if (state.status !== 'running') return state;
      attemptConsumed = true;
      let authoringCheckpoint = state.checkpointSha256;
      const provider = resolveModelProvider(definition);
      const prompt = [
        composed.trimEnd(), '', '# Ratified Auto execution boundary', '',
        `- Flight: ${flightId}`,
        `- Plan: ${plan.planId} (${plan.planSha256})`,
        `- Requirement: ${plan.requirement.text}`,
        `- Predicted repository paths: ${plan.proposal.predictedPaths.join(', ') || 'none'}`,
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
          tools: { mode: 'allowlist', names: [...AUTO_AUTHORING_TOOLS] },
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
      const applicationChangeSet = applicationChangeSetProjection(
        changeSet, applicationPathContext(definition, workflow)
      );
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
      const authoringActiveMilliseconds = Date.now() - activeAccountedAt;
      activeAccountedAt = Date.now();
      state = await mutateAutoExecutorState(root, flightId, (draft) => {
        draft.position = 'authored';
        draft.counters.touchedPaths = files.length;
        draft.counters.touchedChanges = applicationEntries.length;
        draft.observedPaths = files;
        draft.lastInvocationId = invocation.invocationId;
        draft.evidence = { ...(draft.evidence ?? {}), changeSetDigest: applicationChangeSet.digest };
        draft.operations = [...(draft.operations ?? []), {
          operation: 'author', phase: phase.id, outcome: 'succeeded',
          invocationId: invocation.invocationId, changeSetDigest: applicationChangeSet.digest
        }];
        draft.token = token;
        draft.counters.activeMilliseconds = (draft.counters.activeMilliseconds ?? 0) + authoringActiveMilliseconds;
        draft.stopReason = 'authoring-complete';
        draft.nextAction = 'Publish the exact authored generation through the normal lifecycle operation.';
      }, { expectedCheckpoint: authoringCheckpoint });
    } catch (error) {
      const humanStop = await stoppedByHuman(root, flightId, error, activeAccountedAt);
      if (humanStop) return humanStop;
      return stopActive('halted', attemptConsumed ? 'authoring-failed' : 'authoring-preflight-failed',
        attemptConsumed
          ? 'Inspect the retained worktree and finish manually or create a replacement Plan; Auto will not retry.'
          : 'Repair the deterministic preflight and resume with the exact checkpoint; no authoring attempt was consumed.', {
          lastError: { code: error.code ?? 'MODEL_PROVIDER_FAILED', message: error.message }
        });
    }
  }

  if (state.position === 'authored') {
    try {
      await assertActive(root, flightId, state.checkpointSha256);
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
        ], { signal: controller.signal, timeoutMs: remainingActiveMs });
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
          operation: 'publish', phase: phase.id, outcome: 'succeeded', commit: head(worktree)
        }];
        draft.nextAction = 'Submit the published generation through the normal lifecycle operation.';
      }, { expectedCheckpoint: state.checkpointSha256 });
      const boundary = await finishAtBoundary(root, flightId, state, phase.id, 'published');
      if (boundary) return boundary;
    } catch (error) {
      const humanStop = await stoppedByHuman(root, flightId, error, activeAccountedAt);
      if (humanStop) return humanStop;
      return stopActive('halted', 'publication-failed',
        'Repair the retained worktree and continue manually; the autonomous authoring attempt is already consumed.', {
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
        draft.counters.phasesCompleted += completed.status === 'approved' ? 1 : 0;
        draft.counters.activeMilliseconds = (draft.counters.activeMilliseconds ?? 0) + submissionActiveMilliseconds;
        const submittedBoundary = selectorReached(draft.execution.until, phase.id, 'submitted');
        const completedBoundary = selectorReached(draft.execution.until, phase.id, 'phase-complete')
          && completed.status === 'approved';
        draft.status = submittedBoundary || completedBoundary ? 'completed' : waiting ? 'waiting-human' : 'completed';
        draft.stopReason = submittedBoundary || completedBoundary
          ? 'requested-boundary-reached'
          : waiting ? 'approval-required' : 'requested-boundary-reached';
        draft.nextAction = waiting && !submittedBoundary
          ? `Review and decide phase '${phase.id}' through the normal human approval path.`
          : 'The thin single-phase flight is complete; inspect the governed Story for the next phase.';
      }, { expectedCheckpoint: state.checkpointSha256 });
      const report = await persistAutoFlightReport(root, stopped);
      return mutateAutoExecutorState(root, flightId, (draft) => {
        draft.finalReportSha256 = report.reportSha256;
      }, { expectedStatuses: [stopped.status] });
    } catch (error) {
      const humanStop = await stoppedByHuman(root, flightId, error, activeAccountedAt);
      if (humanStop) return humanStop;
      return stopActive('halted', 'verification-or-submission-failed',
        'Inspect the ordinary lifecycle failure and retained worktree. Auto will not retry.', {
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
