/** Verify the governed identities required before an Auto flight can continue. */
import path from 'node:path';

import { loadDefinition } from '../config.mjs';
import { branch, gitCommonDir, head } from '../git.mjs';
import { loadStoryAggregate } from '../state-stores.mjs';
import { posix, run, SingularityFlowError } from '../util.mjs';
import {
  assertCredentialFreeRemote, configuredRemoteIdentity, remoteFingerprint
} from '../git-remote-diagnostics.mjs';
import { readVerifiedAcceptedAutoBinding } from './auto-origin.mjs';
import { readAutoPlan } from './auto-plan.mjs';

function contained(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Start-time Plan checks intentionally include TTL, caller checkout HEAD, and the remote base.
 * Those values must not be re-applied to a running flight: main advancing or the planning TTL
 * expiring does not invalidate the already-created Story. This verifier instead binds continuation
 * to the accepted governed Plan and the exact Story worktree created from it.
 */
export async function verifyAutoFlightContinuation(root, state) {
  const managedRoot = path.join(
    gitCommonDir(root), 'singularity-flow', 'auto-worktrees', state.flightId
  );
  if (!contained(managedRoot, state.worktree)) {
    throw new SingularityFlowError('The Auto worktree is outside its flight-managed root.', {
      code: 'AUTO_FLIGHT_BINDING_MISMATCH'
    });
  }
  // A Change Flight Plan may materialize the application repository as a dedicated clone below
  // the managed flight root rather than as a linked worktree of the workspace/control checkout.
  // Containment plus the accepted Plan's repository authority is the identity proof; requiring an
  // equal Git common directory would incorrectly reject that supported topology.
  if (branch(state.worktree) !== state.story.branch) {
    throw new SingularityFlowError('The Auto worktree branch no longer matches the governed Story.', {
      code: 'AUTO_FLIGHT_BINDING_MISMATCH',
      details: { expected: state.story.branch, actual: branch(state.worktree) }
    });
  }

  const definition = await loadDefinition(state.worktree);
  const workflow = await loadStoryAggregate(state.worktree, definition, state.story.workId);
  const binding = await readVerifiedAcceptedAutoBinding(
    state.worktree, definition, workflow, state
  );
  let plan;
  if (binding.compatibility?.protocol === 'packet-v1-no-repair') {
    // A stored v2 Plan cannot authorize a new flight, but its exact committed packet-v1
    // ratification can resume this already-bound flight under the strictly reduced no-repair
    // projection verified by auto-origin.
    plan = binding.acceptedPlan;
  } else {
    try { plan = await readAutoPlan(root, state.planId); }
    catch (error) {
      // Machine-local Plans are disposable. A clone/crash recovery is authorized by the committed
      // accepted Plan and ratification, not by recreating private bytes outside the Story.
      if (error?.code !== 'AUTO_PLAN_NOT_FOUND') throw error;
      plan = binding.acceptedPlan;
    }
  }
  if (plan.planSha256 !== state.planSha256) {
    throw new SingularityFlowError('The local Auto Plan no longer matches the flight.', {
      code: 'AUTO_FLIGHT_BINDING_MISMATCH'
    });
  }
  if (binding.acceptedPlan.planSha256 !== plan.planSha256) {
    throw new SingularityFlowError('The local Plan and governed accepted Plan differ.', {
      code: 'AUTO_FLIGHT_BINDING_MISMATCH'
    });
  }
  const repository = plan.repositories?.[0];
  const configured = configuredRemoteIdentity(state.worktree, repository?.remote ?? 'origin', {
    direction: 'fetch'
  });
  let expectedRemote = null;
  try {
    expectedRemote = repository?.remoteUrl
      ? assertCredentialFreeRemote(repository.remoteUrl)
      : plan.bindings?.repository
        ? assertCredentialFreeRemote(plan.bindings.repository)
        : null;
  } catch { /* readAutoPlan normally rejects this first; keep the continuation boundary closed */ }
  const expectedFingerprint = repository?.remoteFingerprint
    ?? (expectedRemote ? remoteFingerprint(expectedRemote) : null);
  if (!configured.url || configured.ambiguous || !expectedFingerprint
      || configured.fingerprint !== expectedFingerprint) {
    throw new SingularityFlowError('The Auto worktree repository authority no longer matches the accepted Plan.', {
      code: 'AUTO_FLIGHT_BINDING_MISMATCH',
      details: { repository: repository?.id ?? null }
    });
  }
  if (state.configuration?.storyConfigSha256
      && workflow.resolution?.configSha256 !== state.configuration.storyConfigSha256) {
    throw new SingularityFlowError('The Story configuration snapshot changed after Auto start.', {
      code: 'AUTO_PLAN_AMENDMENT_REQUIRED',
      details: {
        expected: state.configuration.storyConfigSha256,
        actual: workflow.resolution?.configSha256 ?? null
      }
    });
  }
  const currentHead = head(state.worktree);
  let phaseTransition = null;
  if (workflow.currentPhase !== state.story.phase) {
    const rail = plan.story?.phaseRail ?? [];
    const previousIndex = rail.indexOf(state.story.phase);
    const nextIndex = workflow.currentPhase == null ? rail.length : rail.indexOf(workflow.currentPhase);
    const previousPhase = workflow.phases?.[state.story.phase];
    const adjacent = previousIndex >= 0 && nextIndex === previousIndex + 1;
    const terminal = workflow.currentPhase == null && previousIndex === rail.length - 1
      && ['complete', 'completed'].includes(workflow.status);
    if ((!adjacent && !terminal) || previousPhase?.status !== 'approved') {
      throw new SingularityFlowError(
        `The governed Story moved from phase '${state.story.phase}' to '${workflow.currentPhase}'. Create a continuation Plan before Auto resumes.`,
        {
          code: 'AUTO_PLAN_AMENDMENT_REQUIRED',
          details: { previousPhase: state.story.phase, currentPhase: workflow.currentPhase }
        }
      );
    }
    await verifyGovernedPhaseAdvance(state.worktree, definition, workflow, state, currentHead);
    phaseTransition = Object.freeze({
      kind: terminal ? 'story-complete' : 'phase-advanced',
      from: state.story.phase, to: workflow.currentPhase, currentHead
    });
  } else if (state.lastSuccessfulStoryRevision && currentHead !== state.lastSuccessfulStoryRevision) {
    throw new SingularityFlowError('The governed Story revision changed after the last Auto checkpoint.', {
      code: 'AUTO_CHECKPOINT_STALE',
      details: { expected: state.lastSuccessfulStoryRevision, actual: currentHead }
    });
  }
  return Object.freeze({ plan, definition, workflow, binding, currentHead, phaseTransition });
}

async function verifyGovernedPhaseAdvance(root, definition, workflow, state, currentHead) {
  const prior = state.lastSuccessfulStoryRevision;
  const workflowRelative = posix(path.join(
    definition.workItemRoot ?? 'singularity/work-items', state.story.workId, 'workflow.json'
  ));
  if (prior && prior === currentHead) {
    const shown = run('git', ['show', `${currentHead}:${workflowRelative}`], {
      cwd: root, allowFailure: true
    });
    let committedWorkflow = null;
    if (shown.status === 0) {
      try { committedWorkflow = JSON.parse(shown.stdout); }
      catch { /* rejected by the exact checks below */ }
    }
    const latest = [...(committedWorkflow?.publicationProjections ?? [])].reverse()[0]?.event;
    if (state.commits?.submission === currentHead
        && latest?.type === 'approval-requested'
        && latest.phaseId === state.story.phase
        && committedWorkflow?.phases?.[state.story.phase]?.status === 'approved'
        && committedWorkflow.currentPhase === workflow.currentPhase
        && committedWorkflow.status === workflow.status) return;
    throw new SingularityFlowError('The phase changed without a distinct governed approval boundary.', {
      code: 'AUTO_CHECKPOINT_STALE'
    });
  }
  if (!prior || run('git', ['merge-base', '--is-ancestor', prior, currentHead], {
    cwd: root, allowFailure: true
  }).status !== 0) {
    throw new SingularityFlowError('The phase advance does not extend the last Auto Story revision.', {
      code: 'AUTO_CHECKPOINT_STALE'
    });
  }
  const itemPrefix = `${posix(path.dirname(workflowRelative))}/`;
  const revisions = run('git', ['rev-list', '--reverse', `${prior}..${currentHead}`], {
    cwd: root, allowFailure: true
  }).stdout.trim().split(/\s+/).filter(Boolean);
  if (!revisions.length) {
    throw new SingularityFlowError('The governed phase advance has no committed transition.', {
      code: 'AUTO_CHECKPOINT_STALE'
    });
  }
  let previousIds = new Set();
  const priorWorkflow = run('git', ['show', `${prior}:${workflowRelative}`], {
    cwd: root, allowFailure: true
  });
  if (priorWorkflow.status === 0) {
    try {
      previousIds = new Set((JSON.parse(priorWorkflow.stdout).publicationProjections ?? [])
        .map((entry) => entry.event?.eventId).filter(Boolean));
    } catch { /* malformed prior authority fails through the new-event checks below */ }
  }
  let approvalCount = 0;
  for (const revision of revisions) {
    const changed = run('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', revision], {
      cwd: root, allowFailure: true
    }).stdout.split('\0').filter(Boolean).map(posix);
    if (changed.some((entry) => !entry.startsWith(itemPrefix))) {
      throw new SingularityFlowError('The phase-advance tail contains changes outside governed Story state.', {
        code: 'AUTO_CHECKPOINT_STALE', details: { revision }
      });
    }
    const shown = run('git', ['show', `${revision}:${workflowRelative}`], {
      cwd: root, allowFailure: true
    });
    if (shown.status !== 0) {
      throw new SingularityFlowError('The phase-advance commit lacks governed Story state.', {
        code: 'AUTO_CHECKPOINT_STALE', details: { revision }
      });
    }
    let aggregate;
    try { aggregate = JSON.parse(shown.stdout); }
    catch {
      throw new SingularityFlowError('The phase-advance Story state is malformed.', {
        code: 'AUTO_CHECKPOINT_STALE', details: { revision }
      });
    }
    const projections = aggregate.publicationProjections ?? [];
    const introduced = projections.filter((entry) => !previousIds.has(entry.event?.eventId));
    if (introduced.length !== 1) {
      throw new SingularityFlowError('The phase-advance commit is not one exact lifecycle transaction.', {
        code: 'AUTO_CHECKPOINT_STALE', details: { revision }
      });
    }
    const event = introduced[0].event;
    const approved = event?.type === 'phase-approved' && event.phaseId === state.story.phase;
    const autoCheckpoint = event?.type === 'evidence-recorded'
      && event.payload?.kind === 'auto-boundary-checkpoint'
      && event.payload?.flightId === state.flightId;
    if (!approved && !autoCheckpoint) {
      throw new SingularityFlowError('The phase-advance tail contains an unrelated lifecycle event.', {
        code: 'AUTO_CHECKPOINT_STALE', details: { revision, eventType: event?.type ?? null }
      });
    }
    if (approved) approvalCount += 1;
    previousIds = new Set(projections.map((entry) => entry.event?.eventId).filter(Boolean));
  }
  if (approvalCount !== 1) {
    throw new SingularityFlowError('The phase advance is not bound to one exact phase approval.', {
      code: 'AUTO_CHECKPOINT_STALE'
    });
  }
}
