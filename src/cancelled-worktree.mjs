import { branch, changedFiles, checkout, head, refExists, refHead } from './git.mjs';
import { restoreAgentSession, restoreCopilotSession } from './session.mjs';
import { nowIso, run, SingularityFlowError } from './util.mjs';

function storyBranch(workflow) {
  return String(workflow?.workItem?.branch ?? workflow?.workItem?.id ?? '').trim();
}

function baseBranch(config, workflow) {
  return String(workflow?.workItem?.baseBranch ?? config?.defaultBaseBranch ?? 'main').trim();
}

/**
 * Describe the reversible checkout release after a Story has been cancelled.
 *
 * Cancellation itself remains a lifecycle-only transaction. Releasing is deliberately separate:
 * stashing somebody's source edits and switching their checkout needs a second, explicit decision.
 */
export function cancelledWorktreeReleasePlan(root, config, workflow) {
  if (workflow?.status !== 'cancelled') {
    throw new SingularityFlowError(`Story '${workflow?.workItem?.id ?? 'unknown'}' is not cancelled and cannot be released.`, {
      code: 'CANCELLED_WORKTREE_NOT_TERMINAL'
    });
  }
  const currentBranch = branch(root);
  const archivedBranch = storyBranch(workflow);
  if (!archivedBranch || currentBranch !== archivedBranch) {
    throw new SingularityFlowError(
      `Cancelled Story '${workflow.workItem.id}' is preserved on '${archivedBranch || 'an unknown branch'}', but the current branch is '${currentBranch}'. `
      + 'Release must run from the preserved cancelled checkout so it cannot stash another branch by mistake.',
      { code: 'CANCELLED_WORKTREE_BRANCH_MISMATCH' }
    );
  }
  const destination = baseBranch(config, workflow);
  if (!destination || destination === archivedBranch) {
    throw new SingularityFlowError(`Cancelled Story '${workflow.workItem.id}' has no distinct base branch to return to.`, {
      code: 'CANCELLED_WORKTREE_BASE_INVALID'
    });
  }
  const remote = String(workflow.workItem.baseRemote ?? config?.git?.remote ?? 'origin').trim() || 'origin';
  const localBase = refExists(root, `refs/heads/${destination}`);
  const remoteBase = refExists(root, `refs/remotes/${remote}/${destination}`);
  if (!localBase && !remoteBase) {
    throw new SingularityFlowError(
      `Base branch '${destination}' is unavailable locally and at ${remote}/${destination}. Fetch or repair the base branch before releasing the cancelled checkout.`,
      { code: 'CANCELLED_WORKTREE_BASE_MISSING' }
    );
  }
  const paths = changedFiles(root);
  return Object.freeze({
    schemaVersion: 1,
    workId: workflow.workItem.id,
    status: workflow.status,
    branch: archivedBranch,
    head: head(root),
    baseBranch: destination,
    remote,
    changedPaths: paths,
    changedPathCount: paths.length,
    action: paths.length ? 'stash-and-return' : 'return',
    confirmation: workflow.workItem.id,
    ready: true,
    applied: false,
    preservation: {
      archivedBranch: 'preserved',
      governedHistory: 'preserved',
      localChanges: paths.length ? 'named-stash' : 'none'
    }
  });
}

/** Apply a freshly recomputed release plan; callers must enforce exact human confirmation. */
export async function releaseCancelledWorktree(root, config, workflow) {
  const plan = cancelledWorktreeReleasePlan(root, config, workflow);
  let stashSha = null;
  let stashMessage = null;
  if (plan.changedPaths.length) {
    const previousStash = refHead(root, 'refs/stash');
    stashMessage = `[${plan.workId}][cancelled] preserved before returning to ${plan.baseBranch}`;
    run('git', ['stash', 'push', '--include-untracked', '--message', stashMessage], { cwd: root });
    stashSha = refHead(root, 'refs/stash');
    const remaining = changedFiles(root);
    if (!stashSha || stashSha === previousStash || remaining.length) {
      throw new SingularityFlowError(
        `Could not prove that all ${plan.changedPathCount} changed path(s) were preserved. The checkout was not switched.`
        + (stashSha && stashSha !== previousStash
          ? ` A partial stash may exist at ${stashSha}; recover it with git stash apply --index ${stashSha}.`
          : ''),
        {
          code: 'CANCELLED_WORKTREE_STASH_FAILED',
          details: {
            remainingPaths: remaining,
            stashSha: stashSha && stashSha !== previousStash ? stashSha : null,
            recoveryCommand: stashSha && stashSha !== previousStash ? `git stash apply --index ${stashSha}` : null
          }
        }
      );
    }
  }
  try {
    checkout(root, plan.baseBranch, {
      base: plan.baseBranch, existingOnly: true, remote: plan.remote, fetch: false
    });
  } catch (error) {
    throw new SingularityFlowError(
      `The cancelled Story changes were ${stashSha ? `preserved at stash commit ${stashSha}, but ` : ''}the checkout could not return to '${plan.baseBranch}': ${error.message}`,
      {
        code: 'CANCELLED_WORKTREE_SWITCH_FAILED', cause: error,
        details: { stashSha, recoveryCommand: stashSha ? `git stash apply --index ${stashSha}` : null }
      }
    );
  }
  // The lifecycle remains in Git; only the machine-local selection is released. A new Story start
  // will establish its own exact session instead of inheriting the cancelled phase agent.
  let sessionWarning = null;
  try {
    await restoreAgentSession(root, null);
    await restoreCopilotSession(root, null);
  } catch (error) {
    // The Git outcome is already durable and safe. Do not misreport the release as failed after the
    // branch changed; the next session reconciliation can clear an old local selection.
    sessionWarning = `The checkout was released, but its machine-local session could not be cleared: ${error.message}`;
  }
  return Object.freeze({
    ...plan,
    applied: true,
    releasedAt: nowIso(),
    currentBranch: branch(root),
    stashSha,
    stashMessage,
    recoveryCommand: stashSha ? `git stash apply --index ${stashSha}` : null,
    sessionWarning
  });
}
