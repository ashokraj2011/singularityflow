/**
 * Every machine-wide location Singularity Flow keeps outside a repository, as the variable that
 * redirects it and the name it takes under a folder of its own. scripts/test-machine-state.mjs gives
 * each test run these under its own folder, and `workflow walk` (src/workflow-walk/sandbox.mjs) gives
 * its throwaway Story the same, so neither ever reads or writes a person's ~/.singularity-flow.
 * test/test-machine-state.test.mjs fails when src/ gains a home-directory default no entry redirects.
 */
export const MACHINE_STATE_LOCATIONS = Object.freeze({
  SINGULARITY_FLOW_WORKSPACE_REGISTRY: 'workspaces.json',
  SINGULARITY_FLOW_ACTIVE_WORKSPACE: 'active-workspace.json',
  // The Story index (src/story-index.mjs) follows the workspace registry when this is unset.
  SINGULARITY_FLOW_STORY_INDEX: 'story-index.json',
  SINGULARITY_FLOW_LEAD_REGISTRY: 'leads.json',
  SINGULARITY_FLOW_REPOSITORY_CHECK_PREFERENCES: 'repository-checks.json',
  SINGULARITY_FLOW_COPILOT_MODE_FILE: 'copilot-mode.json',
  SINGULARITY_FLOW_PRESENTATION_PROFILE_FILE: 'presentation-profile.json',
  SINGULARITY_FLOW_AST_PREFERENCE_FILE: 'ast-preference.json',
  SINGULARITY_FLOW_AST_PACK_ROOT: 'ast-packs',
  SINGULARITY_FLOW_COPILOT_TELEMETRY_SETUP_FILE: 'copilot-otel.sh',
  SINGULARITY_FLOW_TELEMETRY_PREFERENCES: 'telemetry-preferences.json',
  SINGULARITY_FLOW_COPILOT_CHAT_OTEL_FILE: 'copilot-chat-otel.jsonl',
  SINGULARITY_FLOW_TEAM_IMPORT_STATE: 'team-imports',
  // Every --for-agent result a test's commands keep (src/agent-result-keeper.mjs).
  SINGULARITY_FLOW_AGENT_RESULTS: 'agent-results',
  // The short codes a person types to confirm a reviewed action, each with its command (src/confirm-code.mjs).
  SINGULARITY_FLOW_CONFIRM_CODES: 'confirm-codes',
  SINGULARITY_FLOW_WORKFLOW_BUILD_STATE: 'workflow-builds',
  SINGULARITY_FLOW_REPOSITORY_CATALOG: 'repository-catalog',
  SINGULARITY_FLOW_LOCAL_MODE_ROOT: 'local-mode',
  SINGULARITY_FLOW_LOCAL_EXPORT_ROOT: 'local-mode-exports',
  SINGULARITY_FLOW_VSCODE_RESET_MARKER: 'vscode-fresh-reset-pending.json',
  // The install record and the build-currency answer every session entry reads (src/build-currency.mjs).
  SINGULARITY_FLOW_INSTALLATIONS_DIR: 'installations',
  // The machine ID every lease owner records (src/lease-liveness.mjs).
  SINGULARITY_FLOW_MACHINE_ID_FILE: 'machine-id',
  SINGULARITY_FLOW_HOME: 'home'
});

/**
 * Background work an isolated run turns off, so nothing it starts outlives it: automatic workspace
 * cleanup and background index refreshes. The test runner and `workflow walk` apply these too.
 */
export const ISOLATED_RUN_SWITCHES = Object.freeze({
  SINGULARITY_FLOW_AUTOMATIC_CLEANUP: 'off',
  SINGULARITY_FLOW_INDEX_REFRESH: 'off'
});
