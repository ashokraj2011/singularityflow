/** Auto start transaction: exact Plan ratification -> isolated governed Story -> paused flight. */
import { createHash } from 'node:crypto';
import path from 'node:path';

import { adhocStatus } from '../adhoc/session.mjs';
import { applicationPathContext } from '../application-paths.mjs';
import { startChangeFlightPlan } from '../change-flight-plan.mjs';
import { loadDefinition } from '../config.mjs';
import { gitCommonDir, head } from '../git.mjs';
import { nowIso, SingularityFlowError } from '../util.mjs';
import { applicationChangeSetProjection } from '../work-intervals.mjs';
import {
  assertAutoCandidateMatches, autoAttemptId, freezeAutoCandidate,
  observeAutoCandidateWorktree, publishAutoCandidateAuthority
} from './auto-candidate.mjs';
import {
  assertAutoRequirementSourceCurrent, completeAdhocAutoPromotion
} from './auto-entry-modes.mjs';
import { autoExecutionOrigin } from './auto-origin.mjs';
import { publishAutoBoundaryCheckpoint } from './auto-checkpoint.mjs';
import {
  claimAutoAuthorization, finishAutoAuthorization, ratifyAutoPlan
} from './auto-plan.mjs';
import {
  createAutoFlightState, listAutoFlights, mutateAutoFlightState
} from './auto-flight-store.mjs';
import { withSubjectLock } from '../subject-lock.mjs';

function flightId(plan) {
  const digest = createHash('sha256').update(`${plan.planSha256}\0${nowIso()}\0${process.pid}`).digest('hex');
  return `AFL-${digest.slice(0, 26).toUpperCase()}`;
}

function candidateProjection(binding) {
  return {
    candidateId: binding.candidateId,
    candidateSha256: binding.candidateSha256,
    bindingSha256: binding.bindingSha256,
    attemptId: binding.attemptId,
    applicationChangeSetDigest: binding.applicationChangeSetDigest,
    applicationResourceDigest: binding.applicationResourceDigest
  };
}

function candidatePaths(binding) {
  return [...new Set(binding.resourceManifest.entries.flatMap((entry) => (
    [entry.oldPath, entry.newPath].filter(Boolean)
  )))].sort();
}

async function freezeAdhocAdoption(root, plan, id) {
  const source = plan.requirement?.source;
  if (source?.kind !== 'adhoc') return null;
  await assertAutoRequirementSourceCurrent(root, source);
  const status = await adhocStatus(root, source.sessionId);
  const definition = await loadDefinition(root);
  const pathContext = applicationPathContext(definition);
  const expectedChangeSet = applicationChangeSetProjection(
    status.changeSet.repositoryChangeSet, pathContext
  );
  const expectedPaths = [...new Set(expectedChangeSet.entries.flatMap((entry) => (
    [entry.oldPath, entry.newPath].filter(Boolean)
  )))].sort();
  const binding = await freezeAutoCandidate(root, {
    flightId: id,
    attemptId: autoAttemptId({
      flightId: id, phase: 'adhoc-adoption', attemptNumber: 1,
      generationIntentId: source.intentSha256
    }),
    baselineCommit: source.baselineCommit,
    pathContext,
    executionUnitId: 'pre-auto-adhoc',
    attemptKind: 'manual-adoption'
  });
  await assertAutoRequirementSourceCurrent(root, source);
  const observation = await observeAutoCandidateWorktree(root, binding, pathContext);
  assertAutoCandidateMatches(binding, observation);
  const actualPaths = candidatePaths(binding);
  if (binding.repository.baselineCommit !== plan.repositories[0].baseCommit
      || JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new SingularityFlowError(
      'The immutable Ad Hoc Candidate does not match the ratified repository base and effect set.', {
        code: 'AUTO_ADHOC_CANDIDATE_MISMATCH',
        details: {
          expectedBase: plan.repositories[0].baseCommit,
          actualBase: binding.repository.baselineCommit,
          expectedPaths, actualPaths
        }
      }
    );
  }
  await publishAutoCandidateAuthority(root, binding, {
    remote: plan.repositories[0].remote
  });
  return {
    binding,
    evidence: {
      kind: 'auto-adhoc-adoption', status: 'pending',
      sessionId: source.sessionId,
      origin: 'pre-auto-adhoc',
      intentProvenance: 'discovered-at-landing',
      intentSha256: source.intentSha256,
      changeSetSha256: source.changeSetSha256,
      repositoryChangeSetSha256: source.repositoryChangeSetSha256,
      candidateId: binding.candidateId,
      candidateSha256: binding.candidateSha256,
      bindingSha256: binding.bindingSha256,
      materializedPhase: null,
      publishedPhase: null
    }
  };
}

async function startAutoFlightLocked(root, planId, confirmation, options = {}) {
  const { plan, authorization } = await ratifyAutoPlan(root, planId, confirmation);
  const active = (await listAutoFlights(root)).filter((state) => [
    'running', 'paused', 'waiting-human', 'manual-takeover', 'recovery-required'
  ].includes(state.status));
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
    // Seal confirmed pre-Auto bytes before Story creation. The retained Candidate is published by
    // exact object ID and later materialized only at the first code-delivery phase.
    const adoption = await freezeAdhocAdoption(root, plan, id);
    const started = await startChangeFlightPlan(root, plan.bindings.flightPlanId, {
      confirm: plan.bindings.flightPlanId,
      acceptPartial: plan.scope.status === 'partial',
      workId: plan.story.workId,
      workType: plan.story.workType,
      baseBranch: repository.baseBranch,
      worktree,
      recoverClaim: authorization.recovery === 'reconstruct-flight',
      ...(typeof options.afterWorktreeCreated === 'function'
        ? { afterWorktreeCreated: options.afterWorktreeCreated } : {}),
      ...(typeof options.afterStoryStarted === 'function'
        ? { afterStoryStarted: options.afterStoryStarted } : {}),
      ...(typeof options.beforeStartReceipt === 'function'
        ? { beforeStartReceipt: options.beforeStartReceipt } : {}),
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
    let state = await createAutoFlightState(root, {
      flightId: id, planId: plan.planId, planSha256: plan.planSha256,
      status: waiting ? 'waiting-human' : 'running',
      story: {
        workId: plan.story.workId, branch: started.branch, phase: firstPhase,
        revision: head(started.worktree)
      },
      capabilityId: plan.capability?.id ?? null,
      worktree: started.worktree,
      scopePrediction: plan.proposal.predictedPaths,
      configuration: {
        workflowSha256: plan.bindings.workflowSha256,
        storyConfigSha256: started.workflow?.resolution?.configSha256 ?? null,
        configurationSource: structuredClone(started.workflow?.resolution?.configurationSource ?? null),
        executionHostDescriptorSha256: plan.executionHost?.driver?.descriptorSha256 ?? null
      },
      repositories: plan.repositories,
      execution: plan.execution,
      candidate: adoption ? candidateProjection(adoption.binding) : null,
      evidence: adoption ? { adoption: adoption.evidence } : {},
      stopReason: waiting ? 'first-human-boundary' : 'authorized-start',
      nextAction: waiting
        ? 'Resolve the Plan questions in governed clarification records; Auto will not answer them.'
        : 'Run the one authorized phase step; any failure halts without retry.'
    });
    // The local .git flight projection is disposable. Commit a first reconstructible authority
    // checkpoint before declaring start complete, even when Auto is about to run immediately.
    // A recovered running start deliberately rests as paused until its exact rebuilt checkpoint is
    // reviewed and resumed.
    const initial = await publishAutoBoundaryCheckpoint(
      started.worktree, state,
      waiting ? 'human-boundary' : 'phase-boundary',
      { definition: started.definition, workflow: started.workflow, operationalRoot: root }
    );
    state = await mutateAutoFlightState(root, id, (draft) => {
      const pointer = {
        checkpointClass: initial.checkpointClass, path: initial.path,
        checkpointSha256: initial.checkpointSha256, commit: initial.commit,
        eventId: initial.eventId, phase: initial.phase, position: initial.position,
        createdAt: initial.createdAt
      };
      draft.boundaryCheckpoints = [pointer];
      draft.boundaryCheckpoint = pointer;
      draft.lastSuccessfulStoryRevision = initial.commit;
      draft.story.revision = initial.commit;
      draft.commits = { ...(draft.commits ?? {}), startCheckpoint: initial.commit };
    }, { expectedCheckpoint: state.checkpointSha256 });
    if (adoption) {
      await completeAdhocAutoPromotion(root, plan.requirement.source, {
        flightId: id, workId: plan.story.workId
      });
    }
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
export async function startAutoFlight(root, planId, confirmation, options = {}) {
  return withSubjectLock(root, { kind: 'auto-workspace', id: 'concurrency' }, () =>
    startAutoFlightLocked(root, planId, confirmation, options));
}
