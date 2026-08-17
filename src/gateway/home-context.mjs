import {
  activeWorkspaceFile, buildWorkspaceContext, readActiveWorkspaceContext, workspaceRegistryFile
} from '../workspace-context.mjs';
import { workspaceStatus } from '../workspace.mjs';
import { SingularityFlowError } from '../util.mjs';

async function workspaceContext(workspaceReference) {
  const registry = workspaceRegistryFile();
  if (workspaceReference) return buildWorkspaceContext(registry, workspaceReference);
  const active = await readActiveWorkspaceContext(activeWorkspaceFile(), registry, { refresh: true });
  if (!active) throw new SingularityFlowError(
    "No workspace is active. Select one with 'singularity-flow workspace use <WORKSPACE>' first."
  );
  return active;
}

/** Resolve the repository every developer-facing projection is about, once. */
export async function developerRepository(workspaceReference = null) {
  const context = await workspaceContext(workspaceReference);
  const status = await workspaceStatus(context.workspacePath);
  const selected = status.repositories.find((item) => item.id === context.repositoryId)
    ?? status.repositories.find((item) => item.id === status.workspace.leadRepository)
    ?? status.repositories[0];
  if (!selected) throw new SingularityFlowError(`Workspace '${context.workspaceId}' has no repositories.`);
  return { context, status, selected, root: selected.absolutePath ?? null };
}

/** Compatibility name retained for the existing Home command. */
export const homeRepository = developerRepository;
