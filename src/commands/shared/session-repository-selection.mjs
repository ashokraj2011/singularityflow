/** Repository selection shared by session adapters; no selection is mutated here. */
import path from 'node:path';
import { SingularityFlowError } from '../../util.mjs';
import { repoRoot } from '../../git.mjs';
import { WORKFLOW_PATH } from '../../config.mjs';
import { readWorkspace } from '../../workspace-manifest.mjs';
import { workspaceRegistryFile, activeWorkspaceFile, buildWorkspaceContext, readActiveWorkspaceContext } from '../../workspace-context.mjs';
import { sessionRepositoryAuthority } from './session-repository-authority.mjs';
import { boundExecutionContextRoot } from '../../execution-context-scope.mjs';

export async function resolveSessionRepository({
  workspaceReference = null, repositoryId = null, localStoryOnly = false, remoteProbe = true
} = {}) {
  // An existing managed checkout proves its governance through its accepted Story aggregate.
  // Resolving that local candidate must not probe a remote for configuration authority.
  const governed = (candidate) => localStoryOnly
    ? candidate ? { source: 'local-story-candidate', remote: null } : null
    : sessionRepositoryAuthority(candidate, { remoteProbe });

  if (repositoryId != null && workspaceReference == null) throw new SingularityFlowError(
    '--repository requires --workspace for session candidates or attach.',
    { code: 'SESSION_WORKSPACE_SELECTION_REQUIRED' }
  );

  // An exact workspace/repository selector is independent of the host's current directory. In
  // particular, VS Code may be rooted in a different Story worktree when its Inbox opens a remote
  // Story from another mapped repository. This read does not change the active local selection.
  const explicit = workspaceReference == null ? null : await buildWorkspaceContext(
    workspaceRegistryFile(), workspaceReference, { repositoryId, detectStory: false }
  );
  if (explicit && repositoryId == null
      && Object.keys((await readWorkspace(explicit.workspacePath)).repositories).length > 1) {
    throw new SingularityFlowError(
      `Workspace '${explicit.workspaceName}' contains multiple repositories. Choose one with --repository <ID>.`,
      { code: 'SESSION_REPOSITORY_SELECTION_REQUIRED' }
    );
  }

  let cwdRoot = null;
  if (!explicit) {
    const bound = boundExecutionContextRoot() ? { repositoryPath: boundExecutionContextRoot() } : null;
    try { cwdRoot = repoRoot(bound?.repositoryPath); }
    catch (error) {
      if (bound) throw new SingularityFlowError('The surface checkout is unavailable. Repair it before opening a Story.', {
        code: 'EXECUTION_CONTEXT_ROOT_UNAVAILABLE'
      });
    }
    const actual = cwdRoot ? await (await import('node:fs/promises')).realpath(cwdRoot) : null;
    if (bound && actual !== await (await import('node:fs/promises')).realpath(bound.repositoryPath)) {
      throw new SingularityFlowError('The surface checkout identity changed.', { code: 'EXECUTION_CONTEXT_ROOT_MISMATCH' });
    }
    const cwdAuthority = await governed(cwdRoot);
    if (cwdAuthority || bound && localStoryOnly) {
      return { root: cwdRoot, resolvedFrom: 'working-directory', workspaceId: null, authority: cwdAuthority };
    }
  }

  let context = explicit;
  if (explicit) {
    // Intake can materialize a branch-local clone while the manifest still points to the original
    // (possibly blobless) clone. Reuse only a verified selection of this exact workspace member.
    const selected = await readActiveWorkspaceContext(activeWorkspaceFile(), workspaceRegistryFile(), { refresh: false }).catch(() => null);
    if (selected?.branchCheckout && selected.workspaceId === explicit.workspaceId
        && selected.repositoryId === explicit.repositoryId && selected.workspacePath
        && path.resolve(selected.workspacePath) === path.resolve(explicit.workspacePath)) {
      const active = await readActiveWorkspaceContext(activeWorkspaceFile(), workspaceRegistryFile()).catch(() => null);
      if (active?.selectionStatus === 'ready' && active.branchCheckout) {
        context = { ...explicit, ...active, repositoryPath: active.canonicalRepositoryPath,
          repositoryState: 'ready' };
      }
    }
  }
  if (!context) {
    try {
      context = await readActiveWorkspaceContext(activeWorkspaceFile(), workspaceRegistryFile());
    } catch { /* An unreadable or stale selection is a miss, not a failure of the command. */ }
  }

  if (!context) {
    return {
      root: null,
      reason: 'no-workspace-selected',
      detail: 'Select a workspace with `singularity-flow session workspace <workspace>`.'
    };
  }
  if (context.repositoryState !== 'ready') {
    // Candidates can inspect a deferred repository without cloning. Attach will preflight the
    // exact Story before materializing only this reviewed workspace member.
    return {
      root: null,
      reason: 'workspace-repository-not-ready',
      workspaceContext: context,
      detail: `Workspace '${context.workspaceName}' repository '${context.repositoryId}' is ${context.repositoryState}. `
        + `Run \`singularity-flow workspace repair ${context.workspacePath}\`.`
    };
  }
  const workspaceRoot = context.canonicalRepositoryPath ?? context.repositoryPath;
  const workspaceAuthority = await governed(workspaceRoot);
  if (!workspaceAuthority) {
    return {
      root: null,
      reason: 'workspace-repository-not-initialized',
      detail: `Workspace '${context.workspaceName}' repository '${context.repositoryId}' has no ${WORKFLOW_PATH}.`
    };
  }
  return {
    root: path.resolve(explicit ? workspaceRoot : context.repositoryPath),
    resolvedFrom: explicit ? 'explicit-workspace' : 'active-workspace',
    workspaceId: context.workspaceId,
    authority: workspaceAuthority,
    workspaceContext: context
  };
}
