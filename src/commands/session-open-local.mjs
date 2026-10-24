/** Existing local selection transaction, isolated from remote attachment and context handlers. */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { optionBoolean, optionString, requirePositional, SingularityFlowError } from '../util.mjs';
import { workspaceRegistryFile, activeWorkspaceFile, readActiveWorkspaceContext, activateWorkspaceContext, activateWorkspaceStoryContext } from '../workspace-context.mjs';
import { gitCommonDir, branch, head, changes, fastForwardTo, fetchRemote, hasRemote, isAncestor, refHead } from '../git.mjs';
import { gitAnswer } from './shared/git-answer.mjs';
import { samePlatformPath } from '../story-worktree.mjs';
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { activateWorkItemSession, agentSessionStatus } from '../session.mjs';
import { resolveSessionRepository } from './shared/session-repository-selection.mjs';
import { withCommandObservability } from '../command-observability.mjs';
import { withCommandConfirmation } from '../command-confirmation.mjs';

export async function run(argv, { positionals, options }) {
  return withCommandObservability(positionals[0], argv, options,
    () => withCommandConfirmation(options, () => openLocalSessionCommand(positionals, options)));
}

/**
 * Bring the Story's own checkout up to date before it is used: fetch its branch and fast-forward
 * when it is behind and clean. Nothing is merged, rebased, reset, stashed or discarded. Behind with
 * uncommitted changes, or diverged, stops with the next step. A remote that cannot be reached does
 * not hide a readable checkout: it opens as it is, and the result says it was not synchronized.
 */
async function synchronizeLocalStory(checkout, workId) {
  const storyBranch = branch(checkout);
  const configured = storyBranch ? gitAnswer(checkout, ['config', '--get', `branch.${storyBranch}.remote`], 'Story branch remote', { absentStatus: 1 })?.trim() : null;
  const remote = configured && configured !== '.' ? configured : 'origin';
  if (!storyBranch || !hasRemote(checkout, remote)) return { status: 'no-remote', remote: null };
  try {
    await fetchRemote(checkout, remote, { respectPartialClone: true, branches: [storyBranch] });
  } catch (error) {
    return { status: 'unavailable', remote, code: error.code ?? null,
      reason: `The remote could not be reached, so ${workId} was opened as it is and may be behind ${remote}/${storyBranch}: ${error.message}` };
  }
  const remoteRef = `${remote}/${storyBranch}`;
  const remoteHead = refHead(checkout, `refs/remotes/${remoteRef}`);
  const localHead = head(checkout);
  if (!remoteHead) return { status: 'not-on-remote', remote, head: localHead };
  if (remoteHead === localHead) return { status: 'current', remote, head: localHead };
  const [ahead, behind] = (gitAnswer(checkout, ['rev-list', '--left-right', '--count', `HEAD...${remoteRef}`], 'Story checkout divergence') ?? '0 0').trim().split(/\s+/u).map(Number);
  if (isAncestor(checkout, remoteHead, localHead)) return { status: 'ahead', remote, head: localHead, ahead };
  const unchanged = 'Nothing was merged, rebased, reset, stashed or discarded.';
  if (!isAncestor(checkout, localHead, remoteHead)) throw new SingularityFlowError(
    `The local checkout of ${workId} at ${checkout} and ${remoteRef} have diverged (${ahead} local, ${behind} remote commits). ${unchanged} `
    + `Compare them with \`git -C ${JSON.stringify(checkout)} log --oneline --left-right HEAD...${remoteRef}\`, publish or preserve the local commits, then run /sf-session ${workId} again.`,
    { code: 'SESSION_LOCAL_SYNC_DIVERGED', details: { workId, repositoryPath: checkout, remote, ahead, behind } });
  if (changes(checkout).trim()) throw new SingularityFlowError(
    `The local checkout of ${workId} at ${checkout} is ${behind} commit(s) behind ${remoteRef} and has uncommitted changes. ${unchanged} `
    + `Commit or set the changes aside yourself, then run /sf-session ${workId} again.`,
    { code: 'SESSION_LOCAL_SYNC_DIRTY', details: { workId, repositoryPath: checkout, remote, behind } });
  let moved = null;
  try { moved = fastForwardTo(checkout, remoteRef); } catch { /* reported below */ }
  if (moved !== remoteHead) throw new SingularityFlowError(
    `The local checkout of ${workId} could not fast-forward to ${remoteRef}. ${unchanged}`,
    { code: 'SESSION_LOCAL_SYNC_DIVERGED', details: { workId, repositoryPath: checkout, remote } });
  return { status: 'fast-forwarded', remote, from: localHead, head: remoteHead, behind };
}

export async function openLocalSessionCommand(positionals, options) {
  const agentEntry = options['for-agent'] != null ? await import('../session-agent-entry.mjs') : null;
  const paused = agentEntry?.sessionAgentEntryGuard(positionals, options);
  if (paused) return console.log(JSON.stringify(paused));
  if (optionBoolean(options, 'table')) throw new SingularityFlowError('Use --table only with session candidates, without --json.', { code: 'SESSION_TABLE_FORMAT_INVALID' });
  const workspaceReference = optionString(options, 'workspace');
  const selectedRepositoryId = optionString(options, 'repository');
  const repositoryUrl = optionString(options, 'repository-url');
  const configurationUrl = optionString(options, 'configuration-url');
  if (repositoryUrl != null && workspaceReference != null) throw new SingularityFlowError('Choose either --repository-url or --workspace, not both.', { code: 'SESSION_REMOTE_URL_COMMAND_INVALID' });
  if (configurationUrl != null && repositoryUrl == null) throw new SingularityFlowError('--configuration-url requires --repository-url for session candidates.', { code: 'SESSION_REMOTE_URL_COMMAND_INVALID' });
  if (repositoryUrl != null) throw new SingularityFlowError('--repository-url is available only for session candidates.', { code: 'SESSION_REMOTE_URL_COMMAND_INVALID' });
  const workId = requirePositional(positionals, 2, 'work ID');
  const resolved = await resolveSessionRepository({
    workspaceReference, repositoryId: selectedRepositoryId, localStoryOnly: true
  });
  if (!resolved.root) throw new SingularityFlowError(
    `No ready repository is available for local Story '${workId}'. Select its exact workspace and repository, or use session attach to materialize it.`,
    { code: 'SESSION_LOCAL_REPOSITORY_UNAVAILABLE' }
  );
  let root = resolved.workspaceContext?.canonicalRepositoryPath ?? resolved.root;
  // The Story's one checkout may be in another clone of this workspace: open that one, and refuse
  // another workspace's (story-index.mjs). Git's worktree list cannot see across clones.
  const indexed = await (await import('../story-index.mjs')).storyCheckoutForOpen(workId, {
    root, workspaceId: resolved.workspaceContext?.workspaceId ?? null, operation: 'session open-local' });
  if (indexed) root = indexed.entry.checkoutPath;
  // Every Story checkout below reads this repository's objects; offloaded ones block with no limit.
  const unreadable = await (await import('./session.mjs')).unreadableGitStorage(root);
  if (unreadable) throw (await import('./shared/session-storage-refusal.mjs')).offloadedRepositoryRefusal(
    unreadable, { workId, workspaceContext: resolved.workspaceContext ?? null, operation: 'open' });
  const { listStoryWorktrees } = await import('../story-worktree.mjs');
  const commonDir = gitCommonDir(root);
  const matches = [];
  // Verifying a Story is the expensive step, and only a checkout holding this Story's state can
  // match. Try those first; any other layout falls back to verifying every registered checkout.
  const registeredWorktrees = indexed ? [{ repositoryPath: indexed.entry.checkoutPath, branch: indexed.entry.branch }]
    : listStoryWorktrees(root);
  const holding = registeredWorktrees.filter((entry) => existsSync(path.join(entry.repositoryPath, 'singularity/work-items', workId, 'workflow.json')));
  for (const registered of holding.length ? holding : registeredWorktrees) {
    const checkout = registered.repositoryPath;
    try {
      // The Git worktree registry supplies paths, never a webview or caller-supplied path.
      // A same-named Story in another workspace repository cannot satisfy this selection.
      if (!samePlatformPath(gitCommonDir(checkout), commonDir)
          || branch(checkout) !== registered.branch) continue;
      const accepted = await loadAcceptedStoryExecution(checkout);
      const workflow = accepted.workflow;
      if (workflow.workItem?.id !== workId
          || workflow.workItem?.branch !== registered.branch
          || (workflow.lineage?.canonicalBranch ?? registered.branch) !== registered.branch) continue;
      matches.push({ checkout, accepted });
    } catch {
      // A stale or damaged registered worktree is not an authority for local selection.
      // Remote attachment remains available and retains its strict synchronization gate.
    }
  }
  if (matches.length !== 1) throw new SingularityFlowError(
    matches.length
      ? `More than one managed checkout claims Story '${workId}'. Inspect the registered worktrees before selecting it.`
      : `No verified managed checkout owns local Story '${workId}'. Use session attach to synchronize or materialize it.`,
    { code: matches.length ? 'SESSION_LOCAL_STORY_AMBIGUOUS' : 'SESSION_LOCAL_STORY_UNAVAILABLE' }
  );
  const { checkout } = matches[0];
  let { accepted } = matches[0];
  // A repository-local caller may win resolution even while the machine's selected workspace
  // points at another repository. Refuse that ambiguity before changing phase session metadata.
  if (!workspaceReference && !indexed) {
    const active = await readActiveWorkspaceContext(
      activeWorkspaceFile(), workspaceRegistryFile(), { refresh: false }
    );
    if (active && !samePlatformPath(
      gitCommonDir(active.canonicalRepositoryPath ?? active.repositoryPath), commonDir
    )) throw new SingularityFlowError(
      `Local Story '${workId}' belongs to a different repository than the active workspace. Select its exact workspace and repository before opening it.`,
      { code: 'SESSION_LOCAL_WORKSPACE_MISMATCH' }
    );
  }
  const remoteSync = await synchronizeLocalStory(checkout, workId);
  // A fast-forward can move the Story's phase; read it again from the bytes now checked out.
  if (remoteSync.status === 'fast-forwarded') {
    accepted = await loadAcceptedStoryExecution(checkout);
    if (accepted.workflow.workItem?.id !== workId) throw new SingularityFlowError(
      `After fast-forwarding, the checkout at ${checkout} no longer holds Story '${workId}'.`, { code: 'SESSION_LOCAL_STORY_UNAVAILABLE' });
  }
  const session = await activateWorkItemSession(checkout, accepted.definition, accepted.workflow);
  const readiness = await agentSessionStatus(checkout, accepted.definition, accepted.workflow);
  if (!readiness.ready) throw new SingularityFlowError(
    `Local Story '${workId}' could not bind its current phase agent. No Git state was changed.`,
    { code: 'SESSION_LOCAL_AGENT_UNAVAILABLE' }
  );
  if (workspaceReference && resolved.workspaceContext) await activateWorkspaceContext(
    workspaceRegistryFile(), activeWorkspaceFile(), resolved.workspaceContext.workspacePath ?? resolved.workspaceContext.workspaceId,
    { repositoryId: resolved.workspaceContext.repositoryId, detectStory: false }
  );
  const selection = await activateWorkspaceStoryContext(
    activeWorkspaceFile(), workspaceRegistryFile(), checkout,
    { storyId: workId, selectionSource: 'session-open-local' }
  );
  if (!selection) {
    const active = await readActiveWorkspaceContext(
      activeWorkspaceFile(), workspaceRegistryFile(), { refresh: false }
    );
    if (resolved.workspaceContext || active) throw new SingularityFlowError(
      `Local Story '${workId}' could not be selected in its mapped workspace repository. No Git state was changed.`,
      { code: 'SESSION_LOCAL_WORKSPACE_MISMATCH' }
    );
  }
  await import('../story-index.mjs').then((index) => index.recordStoryCheckout(checkout, { source: 'session-open' })).catch(() => {});
  const result = {
    ready: true, localOnly: true,
    remoteSynchronized: ['current', 'fast-forwarded', 'ahead'].includes(remoteSync.status), remoteSync,
    workId, branch: branch(checkout), head: head(checkout), repositoryPath: checkout,
    workspaceId: selection?.workspaceId ?? resolved.workspaceId ?? null,
    repositoryId: selection?.repositoryId ?? null,
    phase: accepted.workflow.currentPhase, status: accepted.workflow.status,
    agent: session.selectedAgent ?? readiness.activeAgent ?? null,
    materialization: remoteSync.status === 'fast-forwarded' ? 'fast-forwarded-managed-story-worktree' : 'opened-existing-managed-story-worktree'
  };
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
  const synced = {
    current: `It matches ${remoteSync.remote}/${result.branch}.`,
    'fast-forwarded': `Fast-forwarded ${remoteSync.behind} commit(s) from ${remoteSync.remote}/${result.branch}.`,
    ahead: `It has ${remoteSync.ahead} local commit(s) not yet on ${remoteSync.remote}/${result.branch}.`,
    'not-on-remote': `${remoteSync.remote} has no ${result.branch} branch yet.`,
    'no-remote': 'It has no remote to synchronize with.',
    unavailable: remoteSync.reason
  }[remoteSync.status];
  console.log(`Opened local Story ${workId} at ${checkout}. ${synced}`);
  return result;
}
