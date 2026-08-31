/** Verify the governed identities required before an Auto flight can continue. */
import path from 'node:path';

import { loadDefinition } from '../config.mjs';
import { branch, gitCommonDir, head } from '../git.mjs';
import { loadStoryAggregate } from '../state-stores.mjs';
import { SingularityFlowError } from '../util.mjs';
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

  const plan = await readAutoPlan(root, state.planId);
  if (plan.planSha256 !== state.planSha256) {
    throw new SingularityFlowError('The local Auto Plan no longer matches the flight.', {
      code: 'AUTO_FLIGHT_BINDING_MISMATCH'
    });
  }
  const definition = await loadDefinition(state.worktree);
  const workflow = await loadStoryAggregate(state.worktree, definition, state.story.workId);
  const binding = await readVerifiedAcceptedAutoBinding(
    state.worktree, definition, workflow, state
  );
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
  if (workflow.currentPhase !== state.story.phase) {
    throw new SingularityFlowError(
      `The governed Story moved from phase '${state.story.phase}' to '${workflow.currentPhase}'. Create a continuation Plan before Auto resumes.`,
      {
        code: 'AUTO_PLAN_AMENDMENT_REQUIRED',
        details: { previousPhase: state.story.phase, currentPhase: workflow.currentPhase }
      }
    );
  }
  const currentHead = head(state.worktree);
  if (state.lastSuccessfulStoryRevision && currentHead !== state.lastSuccessfulStoryRevision) {
    throw new SingularityFlowError('The governed Story revision changed after the last Auto checkpoint.', {
      code: 'AUTO_CHECKPOINT_STALE',
      details: { expected: state.lastSuccessfulStoryRevision, actual: currentHead }
    });
  }
  return Object.freeze({ plan, definition, workflow, binding, currentHead });
}
