/** One thin-pilot Auto phase step. Model execution is allowed only under `auto.flight-step`. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyClarificationRecord } from '../clarifications.mjs';
import { loadDefinition } from '../config.mjs';
import { changedFiles } from '../git.mjs';
import { generationTaskForPhase } from '../model-tasks.mjs';
import { invokeModel, resolveModelProvider } from '../model-runner.mjs';
import { loadStoryAggregate, preparePhase, saveStoryDraft } from '../state-stores.mjs';
import { run, SingularityFlowError } from '../util.mjs';
import { composePhasePrompt } from '../worldmodel.mjs';
import { readAutoPlan, revalidateAutoPlan } from './auto-plan.mjs';
import { AUTO_AUTHORING_TOOLS } from './auto-policy.mjs';
import {
  authorizeAutoAuthoringAttempt, mutateAutoFlightState, persistAutoFlightReport, readAutoFlightState
} from './auto-flight-store.mjs';

const BIN = fileURLToPath(new URL('../../bin/singularity-flow.mjs', import.meta.url));

function allowedPath(actual, predicted) {
  return predicted.some((candidate) => actual === candidate || actual.startsWith(`${candidate.replace(/\/$/, '')}/`));
}

function storyControlPath(definition, workId, candidate) {
  const prefix = `${definition.workItemRoot ?? 'singularity/work-items'}/${workId}/`;
  return candidate.startsWith(prefix);
}

function tokenObservation(usage) {
  const total = Number(usage?.totalTokens ?? usage?.total_tokens);
  const available = Number.isSafeInteger(total) && total >= 0;
  return { assurance: available ? 'exact' : 'unavailable', totalTokens: available ? total : null };
}

async function stop(root, id, status, reason, nextAction, extra = {}) {
  return mutateAutoFlightState(root, id, (state) => {
    state.status = status;
    state.stopReason = reason;
    state.nextAction = nextAction;
    Object.assign(state, extra);
  });
}

function childLifecycle(root, args) {
  const result = run(process.execPath, [BIN, ...args], {
    cwd: root, allowFailure: true, timeoutMs: 30 * 60 * 1000, maxBuffer: 8 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new SingularityFlowError((result.stderr || result.stdout || `Lifecycle command failed: ${args.join(' ')}`).trim(), {
      code: 'AUTO_LIFECYCLE_STEP_FAILED', details: { command: ['singularity-flow', ...args], status: result.status }
    });
  }
  return result;
}

function actualProtectedPaths(definition, workflow, files) {
  const protectedPaths = [...new Set([
    'singularity/workflow.yml', 'singularity/capabilities.yml',
    ...(definition.governance?.protectedPaths ?? []),
    ...(workflow.resolution?.capability?.policy?.protectedPaths ?? [])
  ])];
  return files.filter((file) => protectedPaths.some((guard) => file === guard || file.startsWith(`${guard.replace(/\/$/, '')}/`)));
}

export async function executeAutoFlightStep(root, flightId, confirmation) {
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
    return stop(root, flightId, 'halted', 'plan-drift', 'Create and ratify a replacement Plan before continuing.', {
      lastError: { code: error.code ?? 'AUTO_PLAN_STALE', message: error.message }
    });
  }

  const elapsedMinutes = (Date.now() - Date.parse(state.createdAt)) / 60_000;
  if (elapsedMinutes >= state.execution.ceilings.maximumElapsedMinutes) {
    return stop(root, flightId, 'halted', 'elapsed-time-ceiling',
      'Create and ratify a replacement Plan; the elapsed authorization window has expired.', {
        ceiling: { name: 'maximumElapsedMinutes', maximum: state.execution.ceilings.maximumElapsedMinutes, consumed: elapsedMinutes }
      });
  }
  if (state.counters.phasesCompleted >= state.execution.ceilings.maximumPhases) {
    return stop(root, flightId, 'halted', 'phase-ceiling',
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
      return stop(root, flightId, 'waiting-human', 'clarification-required', clarification.errors[0]);
    }
  } catch (error) {
    if (error.code === 'AUTO_FLIGHT_STALE') {
      return stop(root, flightId, 'halted', 'external-state-change', 'Inspect the governed Story and create a replacement Plan.', {
        lastError: { code: error.code, message: error.message }
      });
    }
    throw error;
  }

  // A crash after authoring is not permission for a second model call. Only the publish/submit
  // continuation is replayable; an attempt without an authored checkpoint halts for inspection.
  if ((state.counters.authoringAttempts[phase.id] ?? 0) > 0 && state.position === 'story-created') {
    return stop(root, flightId, 'halted', 'authoring-attempt-state-uncertain',
      'Inspect the retained worktree. Auto will not guess whether a prior model attempt changed it.');
  }

  if (state.position === 'story-created') {
    let attemptConsumed = false;
    try {
      await preparePhase(worktree, definition, workflow, phase.id);
      await saveStoryDraft(worktree, definition, workflow);
      workflow = await loadStoryAggregate(worktree, definition, state.story.workId);
      phase = workflow.phases[phase.id];
      const task = generationTaskForPhase(definition, phase.id);
      const composed = await composePhasePrompt(worktree, {
        workId: state.story.workId, phase: phase.id, agent: phase.defaultAgent, task
      });
      if (state.execution.ceilings.tokenBudget.assurance === 'exact-required') {
        return stop(root, flightId, 'halted', 'token-assurance-unavailable',
          'Exact remaining token budget cannot be proven before invocation; finish manually or ratify a best-available Plan.', {
            token: { assurance: 'unavailable', totalTokens: null },
            ceiling: state.execution.ceilings.tokenBudget
          });
      }
      state = await authorizeAutoAuthoringAttempt(root, flightId, phase.id);
      if (state.status !== 'running') return state;
      attemptConsumed = true;
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
      const invocation = await invokeModel({
        provider: provider.provider,
        providerConfig: provider.providerConfig,
        task,
        cwd: path.resolve(worktree), allowedRoots: [path.resolve(worktree)],
        prompt: { text: prompt }, channel: 'auto-phase-authoring',
        subject: {
          kind: 'story', id: state.story.workId, phase: phase.id,
          generation: Number(phase.generation ?? 0) + 1,
          generationIntentId: phase.generationIntent?.id ?? null,
          flightId, planSha256: plan.planSha256
        },
        tools: { mode: 'allowlist', names: [...AUTO_AUTHORING_TOOLS] },
        limits: {
          timeoutMs: Math.min(20, state.execution.ceilings.maximumActiveMinutes) * 60 * 1000,
          outputBytes: 4 * 1024 * 1024
        }
      });
      const token = tokenObservation(invocation.usage);
      if (state.execution.ceilings.tokenBudget.assurance === 'exact-required' && token.assurance !== 'exact') {
        return stop(root, flightId, 'halted', 'token-assurance-unavailable',
          'Finish manually or ratify a Plan whose token policy permits best-available assurance.', {
            token, lastInvocationId: invocation.invocationId
          });
      }
      if (token.totalTokens != null && token.totalTokens > state.execution.ceilings.tokenBudget.maximum) {
        return stop(root, flightId, 'halted', 'token-budget-breached',
          `The one invocation used ${token.totalTokens} tokens; the Plan maximum is ${state.execution.ceilings.tokenBudget.maximum}.`, {
            token, lastInvocationId: invocation.invocationId
          });
      }
      const files = changedFiles(worktree).sort();
      const protectedPaths = actualProtectedPaths(definition, workflow, files);
      if (protectedPaths.length) {
        return stop(root, flightId, 'halted', 'protected-path-contact',
          `Review retained worktree changes to protected paths: ${protectedPaths.join(', ')}.`, {
            touchedPaths: files, lastInvocationId: invocation.invocationId
          });
      }
      const outside = files.filter((file) => !storyControlPath(definition, state.story.workId, file)
        && !allowedPath(file, plan.proposal.predictedPaths));
      if (outside.length) {
        return stop(root, flightId, 'halted', 'scope-expansion',
          `Review retained worktree changes outside the ratified prediction: ${outside.join(', ')}.`, {
            touchedPaths: files, lastInvocationId: invocation.invocationId
          });
      }
      if (files.length > state.execution.ceilings.maximumTouchedPaths) {
        return stop(root, flightId, 'halted', 'touched-path-ceiling',
          `The worktree has ${files.length} touched paths; the Plan maximum is ${state.execution.ceilings.maximumTouchedPaths}.`, {
            touchedPaths: files, lastInvocationId: invocation.invocationId
          });
      }
      if (files.length > state.execution.ceilings.maximumTouchedChanges) {
        return stop(root, flightId, 'halted', 'touched-change-ceiling',
          `The canonical change set has ${files.length} changed entries; the Plan maximum is ${state.execution.ceilings.maximumTouchedChanges}.`, {
            touchedPaths: files, lastInvocationId: invocation.invocationId
          });
      }
      if (phase.generationPolicy?.producer === 'deterministic') {
        // Re-render after source authoring so the kernel-owned summary names the actual paths. The
        // model cannot claim authorship of or smuggle prose into this artifact.
        await preparePhase(worktree, definition, workflow, phase.id);
        await saveStoryDraft(worktree, definition, workflow);
      }
      state = await mutateAutoFlightState(root, flightId, (draft) => {
        draft.position = 'authored';
        draft.counters.touchedPaths = files.length;
        draft.counters.touchedChanges = files.length;
        draft.observedPaths = files.filter((file) => !storyControlPath(definition, state.story.workId, file));
        draft.lastInvocationId = invocation.invocationId;
        draft.token = token;
        draft.stopReason = 'authoring-complete';
        draft.nextAction = 'Publish the exact authored generation through the normal lifecycle operation.';
      });
    } catch (error) {
      return stop(root, flightId, 'halted', attemptConsumed ? 'authoring-failed' : 'authoring-preflight-failed',
        attemptConsumed
          ? 'Inspect the retained worktree and finish manually or create a replacement Plan; Auto will not retry.'
          : 'Repair the deterministic preflight and resume with the exact checkpoint; no authoring attempt was consumed.', {
          lastError: { code: error.code ?? 'MODEL_PROVIDER_FAILED', message: error.message }
        });
    }
  }

  if (state.position === 'authored') {
    try {
      const deterministic = phase.generationPolicy?.producer === 'deterministic';
      childLifecycle(worktree, [
        'phase', 'publish', phase.id,
        '--authored', deterministic ? 'deterministic' : 'governed-agent',
        '--channel', deterministic ? 'kernel-generator' : 'kernel-model'
      ]);
      state = await mutateAutoFlightState(root, flightId, (draft) => {
        draft.position = 'published'; draft.stopReason = 'generation-published';
        draft.nextAction = 'Submit the published generation through the normal lifecycle operation.';
      });
    } catch (error) {
      return stop(root, flightId, 'halted', 'publication-failed',
        'Repair the retained worktree and continue manually; the autonomous authoring attempt is already consumed.', {
          lastError: { code: error.code ?? 'AUTO_LIFECYCLE_STEP_FAILED', message: error.message }
        });
    }
  }

  if (state.position === 'published') {
    try {
      childLifecycle(worktree, ['submit', phase.id]);
      const current = await loadStoryAggregate(worktree, definition, state.story.workId);
      const completed = current.phases[phase.id];
      const waiting = completed.status === 'awaiting_approval';
      const stopped = await mutateAutoFlightState(root, flightId, (draft) => {
        draft.position = 'submitted';
        draft.counters.phasesCompleted += completed.status === 'approved' ? 1 : 0;
        draft.status = waiting ? 'waiting-human' : 'completed';
        draft.stopReason = waiting ? 'approval-required' : 'requested-boundary-reached';
        draft.nextAction = waiting
          ? `Review and decide phase '${phase.id}' through the normal human approval path.`
          : 'The thin single-phase flight is complete; inspect the governed Story for the next phase.';
      });
      const report = await persistAutoFlightReport(root, stopped);
      return mutateAutoFlightState(root, flightId, (draft) => {
        draft.finalReportSha256 = report.reportSha256;
      });
    } catch (error) {
      return stop(root, flightId, 'halted', 'verification-or-submission-failed',
        'Inspect the ordinary lifecycle failure and retained worktree. Auto will not retry.', {
          lastError: { code: error.code ?? 'AUTO_LIFECYCLE_STEP_FAILED', message: error.message }
        });
    }
  }
  return readAutoFlightState(root, flightId);
}
