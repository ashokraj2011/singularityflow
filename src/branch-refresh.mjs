import { SingularityFlowError, run } from './util.mjs';
import { assertClean, branch, hasRemote, head, validBranch } from './git.mjs';
import { runRemoteGitAsync } from './git-execution.mjs';

function git(root, args, { allowFailure = false } = {}) {
  return run('git', args, { cwd: root, allowFailure });
}

function count(root, range) {
  return Number(git(root, ['rev-list', '--count', range]).stdout.trim() || 0);
}

/**
 * Refresh the checked-out branch without rebasing, merging, resetting, or force-pushing.
 * A diverged branch is deliberately left untouched for a person to resolve.
 */
export async function refreshBranch(root, {
  remote = 'origin', branchName = null, runRemoteCommand = runRemoteGitAsync
} = {}) {
  assertClean(root);
  const current = branch(root);
  const target = branchName ?? current;
  validBranch(root, target);
  if (target !== current) {
    throw new SingularityFlowError(`Branch refresh only updates the checked-out branch. Currently on '${current}', not '${target}'. Switch explicitly and retry.`);
  }
  if (!hasRemote(root, remote)) throw new SingularityFlowError(`Git remote '${remote}' is not configured.`);

  const before = head(root);
  const fetched = await runRemoteCommand([
    'fetch', '--prune', remote, `+refs/heads/${target}:refs/remotes/${remote}/${target}`
  ], { cwd: root, operation: 'remote-configuration', allowFailure: true });
  if (fetched.status !== 0) {
    const detail = fetched.failure?.advice
      ?? String(fetched.stderr || fetched.stdout || 'Git fetch failed.').trim();
    throw new SingularityFlowError(`Unable to fetch ${remote}/${target}: ${detail}`, {
      code: fetched.failure?.code ?? 'GIT_REMOTE_UNAVAILABLE',
      details: {
        operation: 'remote-configuration',
        timedOut: fetched.timedOut === true,
        retryable: fetched.failure?.retryable === true
      }
    });
  }
  const remoteRef = `${remote}/${target}`;
  const remoteHead = git(root, ['rev-parse', '--verify', remoteRef], { allowFailure: true });
  if (remoteHead.status !== 0) throw new SingularityFlowError(`Remote branch '${remoteRef}' does not exist.`);
  const incoming = remoteHead.stdout.trim();

  if (before === incoming) {
    return { status: 'up-to-date', branch: target, remote, before, after: before, ahead: 0, behind: 0 };
  }
  if (git(root, ['merge-base', '--is-ancestor', before, incoming], { allowFailure: true }).status === 0) {
    git(root, ['merge', '--ff-only', remoteRef]);
    return {
      status: 'fast-forwarded', branch: target, remote, before, after: head(root),
      ahead: 0, behind: count(root, `${before}..${incoming}`)
    };
  }
  if (git(root, ['merge-base', '--is-ancestor', incoming, before], { allowFailure: true }).status === 0) {
    return {
      status: 'ahead', branch: target, remote, before, after: before,
      ahead: count(root, `${incoming}..${before}`), behind: 0
    };
  }
  throw new SingularityFlowError(
    `${target} has diverged from ${remoteRef}. Nothing was changed. Resolve it explicitly with a reviewed rebase or merge; Singularity Flow will never reset or force-push it.`
  );
}
