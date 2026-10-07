/** Derive selection from the actual editor tab, never from the last command clicked. */
export function sidebarDestination(viewType: string | null, home = false): string | null {
  if (!viewType) return null;
  // VS Code may qualify the tab's view type with its extension-host prefix.
  const type = viewType.slice(viewType.lastIndexOf('singularityFlow.'));
  if (type === 'singularityFlow.result') return home ? 'my-work' : null;
  const routes: Record<string, string> = {
    'singularityFlow.workspaceStories': 'stories',
    'singularityFlow.stories': 'stories',
    'singularityFlow.artifacts': 'artifacts',
    'singularityFlow.dashboard': 'story-analytics',
    'singularityFlow.reviews': 'reviews',
    'singularityFlow.approvals': 'reviews',
    'singularityFlow.capabilityProposals': 'reviews',
    'singularityFlow.workspaces': 'workspace-manage',
    'singularityFlow.configurationCenter': 'configuration-center',
    'singularityFlow.helpCenter': 'help-tools',
    'singularityFlow.workspaceLogs': 'activity-tools'
  };
  return routes[type] ?? null;
}
