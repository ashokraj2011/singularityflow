// VS Code loads this plugin twice in one session: Copilot's installed copy and VS Code's own copy of it.
// Both join, and the host refuses whichever comes second because the first holds the same canvas or tools.
// The first copy serves the session, so the second has nothing to do and leaves; that is not a failure.
const TWIN_REFUSAL = /Canvas "plugin:singularity-flow:[^"]*" is already registered|External tool name clash: .*already registered by another connection/u;

export function leaveIfTwinCopy(error) {
  if (!TWIN_REFUSAL.test(String(error?.message ?? error))) throw error;
  process.exit(0);
}
