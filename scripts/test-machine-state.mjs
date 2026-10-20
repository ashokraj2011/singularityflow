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
 *
 * Everything else under the home directory is covered by giving the run a home of its own (see
 * isolatedHomeEnvironment).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
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
  SINGULARITY_FLOW_COPILOT_CHAT_OTEL_FILE: 'copilot-chat-otel.jsonl',
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

/*
 * A fixture identity, so fixture commits never carry the developer's name. The privacy check in
 * scripts/check.mjs derives no personal terms from it or from the home's directory name.
 */
const TEST_GIT_CONFIG = '[user]\n\tname = Singularity Flow Test\n\temail = test@example.invalid\n';
const HOME_POINTERS = /^(?:XDG_[A-Z_]+|COPILOT_HOME|npm_config_[a-z0-9_]+)$/i;

function insideDirectory(value, directory) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || !directory) return false;
  const relative = path.relative(path.resolve(directory), path.resolve(value));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * A home directory of the run's own, created empty under `root` apart from a Git identity.
 *
 * Paths Singularity Flow does not own default under the home directory too: Copilot skills and MCP
 * configuration under ~/.copilot, the `~/Singularity Workspaces` parent, npm's cache and user
 * configuration, and Git's global configuration. The developer's copies are inputs a test must not
 * read, and places it must not write. HOME and USERPROFILE (Windows) move them all. Variables that
 * still point into the old home are dropped, so each tool derives them from the new one: `npm test`
 * exports npm_config_cache and npm_config_userconfig, and a shell may export XDG_CONFIG_HOME.
 */
export function isolatedHomeEnvironment(root, env = process.env) {
  const home = path.join(root, 'test-home');
  const gitConfig = path.join(home, '.gitconfig');
  mkdirSync(home, { recursive: true });
  writeFileSync(gitConfig, TEST_GIT_CONFIG);
  const previousHome = env.HOME || env.USERPROFILE || os.homedir();
  const unset = Object.keys(env).filter((name) => HOME_POINTERS.test(name) && insideDirectory(env[name], previousHome));
  return { set: { HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: gitConfig }, unset };
}

/**
 * `env` as a test run sees it: its own machine state under `root` and a home of its own.
 * Automatic workspace cleanup is off: a background worker launched by a fixture's `workspace use`
 * or `session open` would outlive the test and race its fixture's removal. Tests of cleanup
 * pass their own environment.
 */
export function isolatedTestEnvironment(root, env = process.env) {
  const { set, unset } = isolatedHomeEnvironment(root, env);
  const isolated = { ...env, ...isolatedMachineEnvironment(root), ...set, SINGULARITY_FLOW_AUTOMATIC_CLEANUP: 'off' };
  for (const name of unset) delete isolated[name];
  return isolated;
}
