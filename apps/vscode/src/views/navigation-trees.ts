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
import type { CapabilityNode, RepositorySnapshot } from '../cli/snapshot.ts';
import type { WorkspaceEntry } from './workspaces-model.ts';
import { workspaceRows } from './workspaces-model.ts';
import type { TreeNode } from './tree-model.ts';

/**
 * The workspaces on this machine, each opening its local details.
 *
 * A workspace row used to be an expandable group. That made its chevron look like the primary
 * action and hid the actual switch command behind VS Code's tree-item behaviour. A workspace is a
 * choice, not a folder browser: one click now shows the working directory, repositories,
 * capabilities and tracker context. Selecting it for work remains an explicit check action.
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
    kind: 'action' as const,
    id: `workspace:${row.path}`,
    label: row.name,
    // "working here" rather than "active": it says what the state means for the reader rather than
    // naming the flag that holds it.
    description: row.collides ? 'shares a directory'
      : row.sharesId ? `shares the id ${row.id}`
        : row.active ? 'working here' : undefined,
    tooltip: row.collides
      ? `${row.directory}\n\nAnother workspace occupies this directory. Two sets of governed state writing into one tree is not a conflict to resolve later.`
      : `${row.directory}${row.lead ? `\nLead repository: ${row.lead}` : ''}\n\n${row.active
        ? 'Every screen is scoped to this workspace. Click to inspect its full details.'
        : 'Click to inspect this workspace. Use the check action to work in it.'}`,
    icon: row.collides || row.sharesId ? 'warning' : row.active ? 'pass-filled' : 'root-folder',
    contextValue: row.active ? 'sflow.workspace.active' : 'sflow.workspace',
    // Carried so the commands acting on this row never have to re-read the registry to find out
    // which one was clicked. Opening a workspace means opening its lead repository: that is where
    // the map, the governed state and every command's configuration live.
    path: row.directory,
    openPath: row.leadRepositoryPath || row.directory,
    runCommand: 'singularityFlow.openWorkspaces'
  }));
}

/**
 * What the organisation builds, as the tree it already is.
 *
 * A capability that names a repository is a leaf that ships; one that does not groups the
 * capabilities beneath it. That distinction decides the icon, because it is the only structural
 * fact about a capability that matters to a reader scanning the tree.
 */
/**
 * What `capability organisation --readiness --json` answers, keyed by repository id.
 *
 * Absent by default. It costs an `ls-remote` per repository, so the map renders without it and this
 * arrives afterwards — and a repository not in here means nobody asked, not that the answer is no.
 */
export type CapabilityReadiness = Record<string, {
  url?: string;
  stateBranch?: string | null;
  hasStateBranch?: boolean;
  /** Which copy a command would actually read: `state-branch`, a branch name, or nothing. */
  worldModel?: string | null;
}>;

export function buildCapabilityTree(
  snapshot: RepositorySnapshot | null,
  unavailable: string | null = null,
  readiness: CapabilityReadiness = {}
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

  const toNode = (capability: CapabilityNode): TreeNode => {
    const repositories = capability.repositories?.length
      ? capability.repositories
      : (capability.repository ? [capability.repository] : []);
    return {
      // Whether a capability ships is decided by naming a repository, not by what its `kind` says.
      kind: repositories.length ? 'repository' : 'group',
      id: `capability:${capability.id}`,
      label: capability.name,
      // The lead is the one worth naming here: it is where the governed state lives, and the others
      // are counted rather than listed because a row that lists four URLs is a row nobody reads.
      description: [
        capability.type ?? null,
        capability.leadRepository ?? repositories[0] ?? null,
        repositories.length > 1 ? `+${repositories.length - 1}` : null
      ].filter(Boolean).join(' · ') || undefined,
      tooltip: [
        capability.description,
        repositories.length
          ? `Ships from ${repositories.join(', ')}.`
          : 'Groups the capabilities beneath it.',
        capability.jira?.projectKey ? `Jira ${capability.jira.projectKey}` : null,
        capability.teams?.length ? `Teams: ${capability.teams.join(', ')}` : null
      ].filter(Boolean).join('\n'),
      icon: repositories.length ? 'repo' : 'type-hierarchy',
      // One value for every capability. There was a `.delivery` variant here, from when shipping and
      // containing were exclusive; the menu that gated "add one inside" on the plain value therefore
      // hid it from exactly the capabilities that ship — which may now contain others too.
      contextValue: 'sflow.capability',
      // What it contains first, then what it is. The tree is a map of the organisation before it is
      // a property sheet, and a "World model" row above the capabilities beneath it buries the
      // structure somebody opened this view to read.
      children: [
        ...capability.children.map(toNode),
        ...repositoryNodes(capability, repositories, readiness),
        ...worldModelNodes(capability, repositories, readiness),
        ...linkNodes(capability)
      ]
    };
  };

  return map.capabilities.map(toNode);
}

/**
 * Each repository a capability ships from, and whether it is somewhere work can actually be governed.
 *
 * The state branch is the whole answer to "can this record anything": it is the orphan ledger every
 * governed act appends to, and its absence is not visible anywhere else until a command fails.
 */
function repositoryNodes(
  capability: CapabilityNode,
  repositories: string[],
  readiness: CapabilityReadiness
): TreeNode[] {
  return repositories.map((id) => {
    const state = readiness[id];
    return {
      kind: 'repository' as const,
      id: `capability:${capability.id}:repository:${id}`,
      label: id,
      description: [
        id === capability.leadRepository ? 'lead' : null,
        // Unasked is not the same as absent, and saying "no state branch" when nobody looked would
        // be a claim about the remote that this tree has no basis for.
        state ? (state.hasStateBranch ? `${state.stateBranch} branch` : 'no state branch') : 'not checked'
      ].filter(Boolean).join(' · '),
      tooltip: [
        state?.url ?? `Repository ${id}.`,
        id === capability.leadRepository ? 'Holds the governed state for this capability.' : null
      ].filter(Boolean).join('\n'),
      icon: state && !state.hasStateBranch ? 'warning' : 'repo',
      contextValue: 'sflow.capability.repository'
    };
  });
}

/**
 * Where this capability's grounding comes from.
 *
 * A capability that ships has one model, resolved state-branch-first because that is the order every
 * reader resolves it in. A capability that groups others has no repository to hold one, so what it
 * has is the union of its children's — composed on read and stored nowhere, which is why this says
 * how many parts it is made of rather than pretending there is a file.
 */
function worldModelNodes(
  capability: CapabilityNode,
  repositories: string[],
  readiness: CapabilityReadiness
): TreeNode[] {
  const descendants = (node: CapabilityNode): string[] => [
    ...(node.repositories?.length ? node.repositories : (node.repository ? [node.repository] : [])),
    ...node.children.flatMap(descendants)
  ];
  const parts = repositories.length ? repositories : descendants(capability);
  if (!parts.length) return [];

  const checked = parts.filter((id) => readiness[id]);
  const built = checked.filter((id) => readiness[id]?.worldModel);
  const lead = capability.leadRepository ?? parts[0]!;
  const description = !checked.length
    ? 'not checked'
    : repositories.length
      ? (readiness[lead]?.worldModel ? `on ${readiness[lead]!.worldModel}` : 'not built')
      : `${built.length}/${parts.length} of its capabilities`;

  return [{
    kind: 'group',
    id: `capability:${capability.id}:world-model`,
    label: 'World model',
    description,
    tooltip: repositories.length
      ? 'Read from the state branch first and the default branch second, in that order.'
      : 'Composed from the models beneath it when something asks for it, and stored nowhere.',
    icon: built.length || !checked.length ? 'book' : 'warning',
    contextValue: 'sflow.capability.worldModel'
  }];
}

/** Whatever describes the capability or whatever it runs on, as the map records it. */
function linkNodes(capability: CapabilityNode): TreeNode[] {
  const entries = [
    ...Object.entries(capability.documentation ?? {}).map(([name, link]) => ({ name, link, icon: 'book' })),
    ...Object.entries(capability.resources ?? {}).map(([name, link]) => ({ name, link, icon: 'cloud' }))
  ];
  return entries.map(({ name, link, icon }) => ({
    kind: 'group' as const,
    id: `capability:${capability.id}:link:${name}`,
    label: name,
    description: link,
    tooltip: link,
    icon,
    contextValue: 'sflow.capability.link'
  }));
}

/**
 * The capability id a tree node stands for, or null for anything else.
 *
 * A capability now has rows beneath it — its repositories, its world model, its links — and their
 * ids are the capability's with a further segment. Those are not capabilities, and handing
 * `commerce:repository:commerce-api` to an edit command is how a screen opens on something that
 * does not exist. Capability ids are kebab-case, so a second colon is proof this is not one.
 */
export function capabilityIdOf(node: { id?: unknown } | undefined): string | null {
  const id = typeof node?.id === 'string' ? node.id : '';
  if (!id.startsWith('capability:')) return null;
  const rest = id.slice('capability:'.length);
  return rest && !rest.includes(':') ? rest : null;
}

/** The workspace directory a tree node stands for, or null for anything else. */
export function workspacePathOf(node: { id?: unknown; path?: unknown } | undefined): string | null {
  if (typeof node?.path === 'string' && node.path) return node.path;
  const id = typeof node?.id === 'string' ? node.id : '';
  return id.startsWith('workspace:') ? id.slice('workspace:'.length).split(':')[0]! : null;
}

/**
 * The capability tree of an organisation that is not the open folder.
 *
 * The map lives in the lead repository, so it exists whether or not the window has anything open —
 * and a window with nothing open is exactly where somebody needs to see it. Read from a remembered
 * lead rather than from a checkout, and labelled with where it came from so it is never mistaken for
 * the map of the folder in front of you.
 */
export function buildRemoteCapabilityTree(url: string, capabilities: CapabilityNode[]): TreeNode[] {
  const tree = buildCapabilityTree({ capabilityMap: { capabilities } } as RepositorySnapshot);
  return [{
    kind: 'message',
    id: 'capabilities:organisation',
    label: url.replace(/^.*[/:]/, '').replace(/\.git$/, ''),
    description: 'mapped organisation',
    tooltip: `Read from ${url}. Nothing is checked out; this is the map that repository holds.`,
    icon: 'organization',
    children: tree
  }];
}
