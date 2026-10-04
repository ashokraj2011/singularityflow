/** A small, editor-independent read model for the Navigator's current context and next step. */
import type { RepositorySnapshot } from '../cli/snapshot.ts';
import type { WorkspaceEntry } from './workspaces-model.ts';

export type SidebarNextActionId = 'setup-wizard' | 'workspace-switch' | 'work-start' | 'my-work';

export interface SidebarNavigation {
  workspace: { name: string; repository?: string } | null;
  subject?: { id: string; kind: 'Story' | 'Initiative'; phase: string | null };
  next: { label: string; description: string; actionId: SidebarNextActionId } | null;
}

function lastPathSegment(value: string | null | undefined): string | undefined {
  const segments = value?.trim().replace(/[\\/]+$/u, '').split(/[\\/]/u);
  return segments?.at(-1) || undefined;
}

/**
 * Suggest an action only when the available read proves its precondition. A missing lifecycle
 * projection cannot prove that there is no Story, and a selected but unavailable repository cannot
 * start governed work. Proposals are not part of either input and are never guessed from absence.
 */
export function deriveSidebarNavigation(
  entries: readonly WorkspaceEntry[],
  snapshot: RepositorySnapshot | null,
  options: { loading?: boolean; verifiedContext?: { workspaceId?: string | null; root: string } | null } = {}
): SidebarNavigation {
  const selected = entries.filter((entry) => Boolean(entry.active));
  if (selected.length > 1) return { workspace: null, next: null };
  const entry = selected[0];
  if (!entry) {
    const available = entries.some((candidate) => !candidate.archivedAt);
    return {
      workspace: null,
      next: options.loading ? null : {
        label: available ? 'Choose a workspace' : 'Guided start',
        description: available ? 'Resume a workspace already on this machine.'
          : 'Map a capability and create a workspace.',
        actionId: available ? 'workspace-switch' : 'setup-wizard'
      }
    };
  }

  // An old editor snapshot must not be presented as work in the newly selected workspace.
  const normalized = (value: string) => {
    const slash = value.replace(/\\/g, '/').replace(/\/+$/u, '');
    return /^[a-z]:\//i.test(slash) ? slash.toLowerCase() : slash;
  };
  if (snapshot?.repository?.root && entry.path) {
    const root = normalized(snapshot.repository.root);
    const workspaceRoot = normalized(entry.path);
    const leadRoot = entry.leadRepositoryPath ? normalized(entry.leadRepositoryPath) : null;
    const verifiedMember = options.verifiedContext?.workspaceId === entry.id
      && normalized(options.verifiedContext.root) === root;
    if (!verifiedMember && root !== workspaceRoot && root !== leadRoot && !root.startsWith(`${workspaceRoot}/`)) snapshot = null;
  }
  const repository = lastPathSegment(snapshot?.repository?.root)
    ?? lastPathSegment(entry.leadRepositoryPath);
  const workspace = {
    name: entry.name.trim() || entry.id || lastPathSegment(entry.path) || 'Workspace',
    ...(repository ? { repository } : {})
  };
  if (entry.archivedAt || entry.repositoryState && entry.repositoryState !== 'ready') {
    return { workspace, next: null };
  }
  if (!snapshot || snapshot.included && !snapshot.included.includes('lifecycle')) {
    return { workspace, next: null };
  }
  if (snapshot.workflow?.workItem?.id || snapshot.initiative) {
    const story = snapshot.workflow;
    const detail = story
      ? `Story ${story.workItem.id}${story.currentPhase ? ` · ${story.currentPhase}` : ''}`
      : `Initiative ${snapshot.initiative?.state?.initiative?.id ?? ''}`.trim();
    return {
      workspace,
      subject: { id: story?.workItem.id ?? snapshot.initiative?.state?.initiative?.id ?? '',
        kind: story ? 'Story' : 'Initiative', phase: story?.currentPhase ?? null },
      next: {
        label: 'Continue current work',
        description: detail,
        actionId: 'my-work'
      }
    };
  }
  if (snapshot.selectedWorkId || snapshot.selectedInitiativeId) {
    return { workspace, next: null };
  }
  return {
    workspace,
    next: {
      label: 'Start new work',
      description: 'Begin the first governed work item in this workspace.',
      actionId: 'work-start'
    }
  };
}
