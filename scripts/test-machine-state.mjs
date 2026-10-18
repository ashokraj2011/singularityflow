/**
 * Machine-wide state that a test run must never share with the developer.
 *
 * Singularity Flow keeps per-person state outside every repository: the workspace registry and
 * selection, preferences, caches and local stores. Each location defaults to a file or directory
 * under `~/.singularity-flow` and is redirected by one variable. A test that reaches a default reads
 * the developer's own selection and preferences, and writes its fixtures into their home. VS Code
 * host tests once left hundreds of session listings naming temporary checkouts in
 * `~/.singularity-flow/cache/session-listings`, because nothing redirected the repository-check
 * preferences that the listing cache sits beside.
 *
 * The suite runner and the VS Code host tests both apply every entry here. Locations derived from
 * one of these follow it: caches beside the lead registry, the outbox, journal and bootstrap state
 * beside the workspace registry, Copilot boundaries beside the Copilot mode file, and session
 * listings beside the repository-check preferences. test/test-machine-state.test.mjs fails when
 * src/ or apps/vscode/src gains a home-directory default that no entry here redirects.
 */
import path from 'node:path';

export const MACHINE_STATE_LOCATIONS = Object.freeze({
  SINGULARITY_FLOW_WORKSPACE_REGISTRY: 'workspaces.json',
  SINGULARITY_FLOW_ACTIVE_WORKSPACE: 'active-workspace.json',
  SINGULARITY_FLOW_LEAD_REGISTRY: 'leads.json',
  SINGULARITY_FLOW_REPOSITORY_CHECK_PREFERENCES: 'repository-checks.json',
  SINGULARITY_FLOW_COPILOT_MODE_FILE: 'copilot-mode.json',
  SINGULARITY_FLOW_PRESENTATION_PROFILE_FILE: 'presentation-profile.json',
  SINGULARITY_FLOW_AST_PREFERENCE_FILE: 'ast-preference.json',
  SINGULARITY_FLOW_AST_PACK_ROOT: 'ast-packs',
  SINGULARITY_FLOW_COPILOT_TELEMETRY_SETUP_FILE: 'copilot-otel.sh',
  SINGULARITY_FLOW_TELEMETRY_PREFERENCES: 'telemetry-preferences.json',
  SINGULARITY_FLOW_TEAM_IMPORT_STATE: 'team-imports',
  SINGULARITY_FLOW_WORKFLOW_BUILD_STATE: 'workflow-builds',
  SINGULARITY_FLOW_REPOSITORY_CATALOG: 'repository-catalog',
  SINGULARITY_FLOW_LOCAL_MODE_ROOT: 'local-mode',
  SINGULARITY_FLOW_LOCAL_EXPORT_ROOT: 'local-mode-exports',
  SINGULARITY_FLOW_VSCODE_RESET_MARKER: 'vscode-fresh-reset-pending.json',
  SINGULARITY_FLOW_HOME: 'home'
});

/** Every machine-wide location under `root`, as the variables that redirect them. */
export function isolatedMachineEnvironment(root) {
  return Object.fromEntries(Object.entries(MACHINE_STATE_LOCATIONS)
    .map(([name, relative]) => [name, path.join(root, relative)]));
}
