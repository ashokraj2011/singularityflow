// A workspace that still needs setup lands on configuration; anything else lands on Epics, the
// start of the lifecycle. There is one experience now, so the landing page no longer varies by role.
export function workspaceLandingPage(result) {
  if (['create', 'saved-needs-repair'].includes(result?.workspaceSetup?.mode)) return 'workspaces';
  return 'epics';
}
