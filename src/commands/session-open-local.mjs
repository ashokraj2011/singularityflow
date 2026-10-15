/** Existing local selection transaction, isolated from remote attachment and context handlers. */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { optionBoolean, optionString, requirePositional, SingularityFlowError } from '../util.mjs';
import { workspaceRegistryFile, activeWorkspaceFile, readActiveWorkspaceContext, activateWorkspaceContext, activateWorkspaceStoryContext } from '../workspace-context.mjs';
import { gitCommonDir, branch, head } from '../git.mjs';
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
  const root = resolved.workspaceContext?.canonicalRepositoryPath ?? resolved.root;
  const { listStoryWorktrees } = await import('../story-worktree.mjs');
  const commonDir = gitCommonDir(root);
  const matches = [];
  // Verifying a Story is the expensive step, and only a checkout holding this Story's state can
  // match. Try those first; any other layout falls back to verifying every registered checkout.
  const registeredWorktrees = listStoryWorktrees(root);
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
  const { checkout, accepted } = matches[0];
  // A repository-local caller may win resolution even while the machine's selected workspace
  // points at another repository. Refuse that ambiguity before changing phase session metadata.
  if (!workspaceReference) {
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
  const session = await activateWorkItemSession(checkout, accepted.definition, accepted.workflow);
  const readiness = await agentSessionStatus(checkout, accepted.definition, accepted.workflow);
  if (!readiness.ready) throw new SingularityFlowError(
    `Local Story '${workId}' could not bind its current phase agent. No Git state was changed.`,
    { code: 'SESSION_LOCAL_AGENT_UNAVAILABLE' }
  );
  if (workspaceReference && resolved.workspaceContext) await activateWorkspaceContext(
    workspaceRegistryFile(), activeWorkspaceFile(), resolved.workspaceContext.workspaceId,
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
  const result = {
    ready: true, localOnly: true, remoteSynchronized: false,
    workId, branch: branch(checkout), head: head(checkout), repositoryPath: checkout,
    workspaceId: selection?.workspaceId ?? resolved.workspaceId ?? null,
    repositoryId: selection?.repositoryId ?? null,
    phase: accepted.workflow.currentPhase, status: accepted.workflow.status,
    agent: session.selectedAgent ?? readiness.activeAgent ?? null,
    materialization: 'opened-existing-managed-story-worktree'
  };
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
  console.log(`Opened local Story ${workId} at ${checkout}. Remote synchronization was not attempted.`);
  return result;
}
