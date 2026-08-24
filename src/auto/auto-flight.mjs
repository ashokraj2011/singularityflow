/** Auto start transaction: exact Plan ratification -> isolated governed Story -> paused flight. */
import { createHash } from 'node:crypto';
import path from 'node:path';

import { startChangeFlightPlan } from '../change-flight-plan.mjs';
import { gitCommonDir } from '../git.mjs';
import { nowIso, SingularityFlowError } from '../util.mjs';
import { autoExecutionOrigin } from './auto-origin.mjs';
import {
  claimAutoAuthorization, finishAutoAuthorization, ratifyAutoPlan
} from './auto-plan.mjs';
import { createAutoFlightState, listAutoFlights } from './auto-flight-store.mjs';
import { withSubjectLock } from '../subject-lock.mjs';

function flightId(plan) {
  const digest = createHash('sha256').update(`${plan.planSha256}\0${nowIso()}\0${process.pid}`).digest('hex');
  return `AFL-${digest.slice(0, 26).toUpperCase()}`;
}

async function startAutoFlightLocked(root, planId, confirmation) {
  const { plan, authorization } = await ratifyAutoPlan(root, planId, confirmation);
  const active = (await listAutoFlights(root)).filter((state) => ['running', 'paused', 'waiting-human'].includes(state.status));
  if (active.length >= plan.execution.concurrency.maximumPerWorkspace) {
    throw new SingularityFlowError('Auto workspace concurrency is already at its configured maximum.', {
      code: 'AUTO_FLIGHT_BUSY', details: { active: active.map((state) => state.flightId) }
    });
  }
  if (plan.capability) {
    const capabilityActive = active.filter((state) => state.capabilityId === plan.capability.id);
    if (capabilityActive.length >= plan.execution.concurrency.maximumPerCapability) {
      throw new SingularityFlowError(`Auto capability '${plan.capability.id}' is already at its configured maximum.`, {
        code: 'AUTO_FLIGHT_BUSY', details: { active: capabilityActive.map((state) => state.flightId) }
      });
    }
  }
  const id = authorization.recovery === 'reconstruct-flight' && authorization.flightId
    ? authorization.flightId
    : flightId(plan);
  const repository = plan.repositories[0];
  const worktree = path.join(gitCommonDir(root), 'singularity-flow', 'auto-worktrees', id, repository.id);
  const claimed = await claimAutoAuthorization(root, plan, authorization, id);
  try {
    const started = await startChangeFlightPlan(root, plan.bindings.flightPlanId, {
      confirm: plan.bindings.flightPlanId,
      acceptPartial: plan.scope.status === 'partial',
      workId: plan.story.workId,
      workType: plan.story.workType,
      baseBranch: repository.baseBranch,
      worktree,
      auto: {
        plan,
        ratification: claimed,
        flightId: id,
        executionOrigin: autoExecutionOrigin({ flightId: id, planId: plan.planId, planSha256: plan.planSha256 })
      }
    });
    const firstPhase = started.workflow?.currentPhase ?? plan.story.phaseRail[0] ?? null;
    const waiting = plan.proposal.unresolvedDecisions.length > 0
      || plan.humanBoundaries?.firstPhaseClarificationRequired === true;
    const state = await createAutoFlightState(root, {
      flightId: id, planId: plan.planId, planSha256: plan.planSha256,
      status: waiting ? 'waiting-human' : 'running',
      story: { workId: plan.story.workId, branch: started.branch, phase: firstPhase },
      capabilityId: plan.capability?.id ?? null,
      worktree: started.worktree,
      scopePrediction: plan.proposal.predictedPaths,
      configuration: {
        workflowSha256: plan.bindings.workflowSha256,
        executionHostDescriptorSha256: plan.executionHost?.driver?.descriptorSha256 ?? null
      },
      repositories: plan.repositories,
      execution: plan.execution,
      stopReason: waiting ? 'first-human-boundary' : 'authorized-start',
      nextAction: waiting
        ? 'Resolve the Plan questions in governed clarification records; Auto will not answer them.'
        : 'Run the one authorized phase step; any failure halts without retry.'
    });
    await finishAutoAuthorization(root, plan.planId, id, { success: true });
    return { plan, flight: state, story: started };
  } catch (error) {
    await finishAutoAuthorization(root, plan.planId, id, { success: false }).catch(() => {});
    if (error?.code === 'CFP_WORK_ALREADY_EXISTS' && /Branch '.+' already exists/.test(error.message)) {
      throw new SingularityFlowError(
        `Confirmed Auto destination branch '${plan.story.branch}' now exists; the Plan must be replaced.`,
        { code: 'AUTO_BRANCH_COLLISION', details: { nextAction: 'Create and review a new Auto Plan with another Work ID.' }, cause: error }
      );
    }
    if (error instanceof SingularityFlowError) throw error;
    throw new SingularityFlowError(`Auto start did not complete: ${error.message}`, {
      code: 'AUTO_START_INCOMPLETE', details: { planId: plan.planId }, cause: error
    });
  }
}

/** Serialize concurrency admission, authorization claim, Story start, and flight creation. */
export async function startAutoFlight(root, planId, confirmation) {
  return withSubjectLock(root, { kind: 'auto-workspace', id: 'concurrency' }, () =>
    startAutoFlightLocked(root, planId, confirmation));
}
