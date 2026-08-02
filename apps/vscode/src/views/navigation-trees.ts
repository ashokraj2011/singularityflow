/**
 * The two things a person navigates rather than reads: their workspaces, and what the organisation
 * builds.
 *
 * Both were panels, which was the wrong home for them. A panel is a page you open, act on, and
 * close; these are structures you keep in view while doing something else, and both are trees
 * already — capabilities literally so, workspaces as directories holding repositories. Putting them
 * in the sidebar also puts "add one here" where the thing it would be added to is.
 *
 * Kept free of any `vscode` import so the shape can be tested without an editor.
 */
import type { CapabilityNode, DesktopSnapshot } from '../cli/snapshot.ts';
import type { WorkspaceEntry } from './workspaces-model.ts';
import { workspaceRows } from './workspaces-model.ts';
import type { TreeNode } from './tree-model.ts';

/**
 * The workspaces on this machine, each opening into what it holds.
 *
 * The working directory is the description rather than a child, because it is what distinguishes
 * two rows at a glance and the rule that no two may share one is only checkable by eye if they sit
 * in the same column.
 */
export function buildWorkspaceTree(entries: WorkspaceEntry[]): TreeNode[] {
  const rows = workspaceRows(entries);
  if (!rows.length) {
    return [{
      kind: 'message',
      id: 'workspaces:empty',
      label: 'No workspaces yet',
      description: 'create one',
      tooltip: 'A workspace is a working directory and the capabilities worked on in it.',
      icon: 'info',
      contextValue: 'sflow.workspaces.empty'
    }];
  }

  return rows.map((row) => ({
    kind: 'group' as const,
    id: `workspace:${row.path}`,
    label: row.name,
    description: row.collides ? 'shares a directory' : row.active ? 'active' : undefined,
    tooltip: row.collides
      ? `${row.directory}\n\nAnother workspace occupies this directory. Two sets of governed state writing into one tree is not a conflict to resolve later.`
      : row.directory,
    icon: row.collides ? 'warning' : row.active ? 'check' : 'root-folder',
    contextValue: 'sflow.workspace',
    // Carried so the commands acting on this row never have to re-read the registry to find out
    // which one was clicked. Opening a workspace means opening its lead repository: that is where
    // the map, the governed state and every command's configuration live.
    path: row.directory,
    openPath: row.leadRepositoryPath || row.directory,
    children: [
      {
        kind: 'message' as const,
        id: `workspace:${row.path}:directory`,
        label: row.directory,
        icon: 'folder',
        contextValue: 'sflow.workspace.directory'
      },
      ...(row.lead ? [{
        kind: 'repository' as const,
        id: `workspace:${row.path}:lead`,
        label: row.lead,
        description: 'lead',
        tooltip: 'Holds the capability map and the governed state branch.',
        icon: 'repo'
      }] : [])
    ]
  }));
}

/**
 * What the organisation builds, as the tree it already is.
 *
 * A capability that names a repository is a leaf that ships; one that does not groups the
 * capabilities beneath it. That distinction decides the icon, because it is the only structural
 * fact about a capability that matters to a reader scanning the tree.
 */
export function buildCapabilityTree(
  snapshot: DesktopSnapshot | null,
  unavailable: string | null = null
): TreeNode[] {
  if (unavailable) {
    return [{
      kind: 'message', id: 'capabilities:unavailable', label: unavailable,
      tooltip: 'The capability map lives in singularity/capabilities.yml in the lead repository.',
      icon: 'info'
    }];
  }
  if (!snapshot) {
    return [{ kind: 'message', id: 'capabilities:loading', label: 'Reading the repository…', icon: 'loading~spin' }];
  }

  const map = snapshot.capabilityMap;
  if (map?.error) {
    return [{
      kind: 'message', id: 'capabilities:error', label: map.error, icon: 'error',
      contextValue: 'sflow.capabilities.invalid'
    }];
  }
  if (!map?.capabilities?.length) {
    return [{
      kind: 'message',
      id: 'capabilities:empty',
      label: 'Nothing describes what this organisation builds',
      description: 'add one',
      tooltip: `The lead repository holds the map, in ${snapshot.capabilityMapPath ?? 'singularity/capabilities.yml'}.`,
      icon: 'info',
      contextValue: 'sflow.capabilities.empty'
    }];
  }

  const toNode = (capability: CapabilityNode): TreeNode => ({
    // Whether a capability ships is decided by naming a repository, not by what its `kind` says.
    kind: capability.repository ? 'repository' : 'group',
    id: `capability:${capability.id}`,
    label: capability.name,
    description: capability.repository ?? undefined,
    tooltip: [
      capability.description,
      capability.repository ? `Ships from ${capability.repository}.` : 'Groups the capabilities beneath it.',
      capability.jira?.projectKey ? `Jira ${capability.jira.projectKey}` : null,
      capability.teams?.length ? `Teams: ${capability.teams.join(', ')}` : null
    ].filter(Boolean).join('\n'),
    icon: capability.repository ? 'repo' : 'type-hierarchy',
    // A capability that ships cannot contain anything, so only a grouping offers "add one inside".
    contextValue: capability.repository ? 'sflow.capability.delivery' : 'sflow.capability',
    children: capability.children.map(toNode)
  });

  return map.capabilities.map(toNode);
}

/** The capability id a tree node stands for, or null for anything else. */
export function capabilityIdOf(node: { id?: unknown } | undefined): string | null {
  const id = typeof node?.id === 'string' ? node.id : '';
  return id.startsWith('capability:') ? id.slice('capability:'.length) : null;
}

/** The workspace directory a tree node stands for, or null for anything else. */
export function workspacePathOf(node: { id?: unknown; path?: unknown } | undefined): string | null {
  if (typeof node?.path === 'string' && node.path) return node.path;
  const id = typeof node?.id === 'string' ? node.id : '';
  return id.startsWith('workspace:') ? id.slice('workspace:'.length).split(':')[0]! : null;
}
