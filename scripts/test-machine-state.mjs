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
 * The suite runner and the VS Code host tests both apply every entry of src/machine-state-locations.mjs,
 * the one list (`workflow walk` applies it too). Locations derived from
 * one of these follow it: caches beside the lead registry, the outbox, journal and bootstrap state
 * beside the workspace registry, Copilot boundaries beside the Copilot mode file, and session
 * listings beside the repository-check preferences. test/test-machine-state.test.mjs fails when
 * src/ or apps/vscode/src gains a home-directory default that no entry there redirects.
 *
 * Everything else under the home directory is covered by giving the run a home of its own (see
 * isolatedHomeEnvironment).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ISOLATED_RUN_SWITCHES, MACHINE_STATE_LOCATIONS } from '../src/machine-state-locations.mjs';

export { MACHINE_STATE_LOCATIONS };

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
 * Playwright's installed browsers under the developer's home, when there are any. A browser is a
 * program pinned by Playwright's own version, not state a test could read or leave behind, and no test
 * installs one, so moving HOME must not hide it: a test needing one would never run on any machine.
 */
function installedBrowsers(env, home) {
  if (env.PLAYWRIGHT_BROWSERS_PATH || process.platform === 'win32') return {};
  const cache = process.platform === 'darwin' ? path.join(home, 'Library', 'Caches') : env.XDG_CACHE_HOME || path.join(home, '.cache');
  const browsers = path.join(cache, 'ms-playwright');
  return existsSync(browsers) ? { PLAYWRIGHT_BROWSERS_PATH: browsers } : {};
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
  return { set: { HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: gitConfig, ...installedBrowsers(env, previousHome) }, unset };
}

/**
 * `env` as a test run sees it: its own machine state under `root` and a home of its own.
 * Automatic workspace cleanup is off: a background worker launched by a fixture's `workspace use`
 * or `session open` would outlive the test and race its fixture's removal. Background index
 * refreshes are off for the same reason: a stale listing would replay its read after the test ended
 * (src/index-refresh-launcher.mjs). Tests of either pass their own environment.
 */
export function isolatedTestEnvironment(root, env = process.env) {
  const { set, unset } = isolatedHomeEnvironment(root, env);
  const isolated = { ...env, ...isolatedMachineEnvironment(root), ...set, ...ISOLATED_RUN_SWITCHES };
  for (const name of unset) delete isolated[name];
  return isolated;
}
