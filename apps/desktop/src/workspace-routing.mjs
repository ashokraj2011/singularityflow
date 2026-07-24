export function workspaceLandingPage(result, experienceMode) {
  if (result?.workspaceSetup?.mode === 'create') return 'workspaces';
  return experienceMode === 'business' ? 'epics' : 'workspaces';
}
