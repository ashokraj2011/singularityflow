export function workspaceLandingPage(result, experienceMode) {
  if (['create', 'saved-needs-repair'].includes(result?.workspaceSetup?.mode)) return 'workspaces';
  return experienceMode === 'business' ? 'epics' : 'workspaces';
}
