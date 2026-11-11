/**
 * Test runs keep their machine state out of the developer's home.
 *
 * src/machine-state-locations.mjs lists the variable that redirects every machine-wide location. The
 * sweep below finds each `~/.singularity-flow` default in the shipped sources and requires one of
 * those variables to guard it, so a new default cannot quietly send test fixtures home. The child
 * run proves the redirect where the leak was seen: a session listing under a sentinel HOME. The
 * run's own home covers what Singularity Flow does not own (~/.copilot, npm, Git's global config).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { configuredPersonalTerms } from '../scripts/documentation-privacy.mjs';
import {
  isolatedMachineEnvironment, isolatedTestEnvironment, MACHINE_STATE_LOCATIONS
} from '../scripts/test-machine-state.mjs';
import { createSessionListingFixture } from '../scripts/session-listing-benchmark.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/*
 * Installed-product lifecycle records. They are located from an injected home directory, written
 * only for a stamped installed build (never from a source checkout), and their tests pass a
 * temporary home. Factory reset and uninstall remove the machine-state directory itself.
 */
const PRODUCT_LIFECYCLE_FILES = new Set([
  'src/configuration-review-pass.mjs', 'src/factory-reset.mjs', 'src/product-alignment-gate.mjs',
  'src/product-alignment.mjs', 'src/product-requirement-gate.mjs', 'src/product-uninstall.mjs', 'src/reinstall.mjs'
]);
const HOME_DEFAULT = /path\.(?:join|resolve)\(\s*(?:os\.homedir\(\)|homedir\(\)|home|homeDirectory)\s*,\s*'\.singularity-flow'\s*(?:,\s*'([^']+)')?/g;
const VARIABLE = /SINGULARITY_FLOW_[A-Z0-9_]+/g;
const NAMED_VARIABLE = /const\s+([A-Z][A-Z0-9_]*)\s*=\s*'(SINGULARITY_FLOW_[A-Z0-9_]+)'/g;
// The variables a default falls back from are read in the same expression, a few lines above it.
const WINDOW_LINES = 6;

async function shippedSources() {
  const sources = [];
  for (const [directory, extension] of [['src', '.mjs'], ['apps/vscode/src', '.ts']]) {
    for (const entry of await readdir(path.join(root, directory), { recursive: true })) {
      if (!entry.endsWith(extension)) continue;
      const relative = path.posix.join(directory, entry.split(path.sep).join('/'));
      sources.push({ relative, text: await readFile(path.join(root, relative), 'utf8') });
    }
  }
  return sources;
}

/** Each home default with the redirect variables named in the statement that falls back to it. */
function homeDefaults({ relative, text }) {
  const lines = text.split('\n');
  const named = new Map([...text.matchAll(NAMED_VARIABLE)].map((match) => [match[1], match[2]]));
  return [...text.matchAll(HOME_DEFAULT)].map((match) => {
    const line = text.slice(0, match.index).split('\n').length;
    const window = lines.slice(Math.max(0, line - 1 - WINDOW_LINES), line + match[0].split('\n').length - 1).join('\n');
    const variables = new Set(window.match(VARIABLE) ?? []);
    for (const [constant, variable] of named) if (new RegExp(`\\b${constant}\\b`).test(window)) variables.add(variable);
    return { location: `${relative}:${line}`, relative, segment: match[1] ?? null, variables: [...variables] };
  });
}

test('every home-directory default for machine state is redirected by the suite runner', async () => {
  const defaults = (await shippedSources()).flatMap(homeDefaults);
  assert.ok(defaults.length >= 20, `the sweep found only ${defaults.length} defaults; its pattern no longer matches the sources`);
  const unredirected = defaults.filter(({ relative, segment, variables }) => {
    if (variables.some((variable) => Object.hasOwn(MACHINE_STATE_LOCATIONS, variable))) return false;
    return !(PRODUCT_LIFECYCLE_FILES.has(relative) && !variables.length && (segment == null || segment === 'installations'));
  });
  assert.deepEqual(unredirected.map(({ location, variables }) => `${location} ${variables.join(' ') || '(no variable)'}`), [],
    'Add the variable that redirects each location to src/machine-state-locations.mjs, or give it one.');
});

test('every redirect variable is still read by the shipped sources', async () => {
  // The list itself names every variable; a variable only it names is read by nobody.
  const text = (await shippedSources()).filter((source) => source.relative !== 'src/machine-state-locations.mjs').map((source) => source.text).join('\n');
  const named = new Set([...text.matchAll(NAMED_VARIABLE)].map((match) => match[2]));
  const unread = Object.keys(MACHINE_STATE_LOCATIONS)
    .filter((variable) => !named.has(variable) && !new RegExp(`\\b${variable}\\b`).test(text));
  assert.deepEqual(unread, []);
});

test('the suite runner and the VS Code host tests apply the whole list and a home of their own', async () => {
  assert.match(await readFile(path.join(root, 'scripts/run-test-suite.mjs'), 'utf8'), /isolatedTestEnvironment\(machineState\)/u);
  const host = await readFile(path.join(root, 'test/vscode-host.test.mjs'), 'utf8');
  assert.match(host, /isolatedMachineEnvironment\(machineState\)/u);
  assert.match(host, /isolatedHomeEnvironment\(machineState\)/u);
});

test('a test run still finds the browsers Playwright installed, and only those', async (t) => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'sflow-test-browsers-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const developer = path.join(state, 'developer');
  const env = (extra = {}) => isolatedTestEnvironment(path.join(state, 'run'), { PATH: process.env.PATH, HOME: developer, ...extra });
  assert.equal(Object.hasOwn(env(), 'PLAYWRIGHT_BROWSERS_PATH'), false, 'nothing installed, nothing to find');
  assert.equal(env({ PLAYWRIGHT_BROWSERS_PATH: path.join(state, 'chosen') }).PLAYWRIGHT_BROWSERS_PATH, path.join(state, 'chosen'));
  if (process.platform === 'win32') return; // LOCALAPPDATA, where they live on Windows, does not move with HOME.
  const browsers = path.join(developer, ...(process.platform === 'darwin' ? ['Library', 'Caches'] : ['.cache']), 'ms-playwright');
  await mkdir(browsers, { recursive: true });
  assert.equal(env().PLAYWRIGHT_BROWSERS_PATH, browsers);
});

test('a test run gets a home of its own, and nothing points back into the developer\'s', async (t) => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'sflow-test-home-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const developer = path.join(state, 'developer');
  const env = isolatedTestEnvironment(path.join(state, 'run'), {
    PATH: process.env.PATH, HOME: developer, npm_config_cache: path.join(developer, '.npm'),
    npm_config_userconfig: path.join(developer, '.npmrc'), npm_config_prefix: path.join(state, 'prefix'),
    npm_config_user_agent: 'npm/11', XDG_CONFIG_HOME: path.join(developer, '.config'),
    COPILOT_HOME: path.join(developer, '.copilot'), SINGULARITY_FLOW_TEST_IDENTITY: 'Kept'
  });
  const home = path.join(state, 'run', 'test-home');
  assert.equal(env.HOME, home);
  assert.equal(env.USERPROFILE, home);
  for (const name of ['npm_config_cache', 'npm_config_userconfig', 'XDG_CONFIG_HOME', 'COPILOT_HOME']) {
    assert.equal(Object.hasOwn(env, name), false, `${name} still points into the developer's home`);
  }
  assert.equal(env.npm_config_prefix, path.join(state, 'prefix'));
  assert.equal(env.npm_config_user_agent, 'npm/11');
  assert.equal(env.SINGULARITY_FLOW_TEST_IDENTITY, 'Kept');
  assert.equal(env.SINGULARITY_FLOW_REPOSITORY_CHECK_PREFERENCES, path.join(state, 'run', 'repository-checks.json'));
  // No fixture command starts a background cleanup worker that outlives its test.
  assert.equal(env.SINGULARITY_FLOW_AUTOMATIC_CLEANUP, 'off');

  // Children see it: Node's home directory and Git's global identity both come from the new home.
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("node:os").homedir())'], { env, encoding: 'utf8' });
  assert.equal(child.stdout, home);
  const identity = Object.fromEntries(['user.name', 'user.email'].map((key) => [key,
    spawnSync('git', ['config', '--global', key], { env, encoding: 'utf8' }).stdout.trim()]));
  assert.deepEqual(identity, { 'user.name': 'Singularity Flow Test', 'user.email': 'test@example.invalid' });
  // A check run inside the suite therefore finds no personal terms, rather than flagging the fixture.
  assert.deepEqual(configuredPersonalTerms({ name: identity['user.name'], email: identity['user.email'], homeDirectory: home }), []);
});

test('a session listing under the runner\'s machine state writes nothing into the home directory', async (t) => {
  const f = await createSessionListingFixture(); t.after(f.cleanup);
  const home = path.join(f.directory, 'home');
  const state = path.join(f.directory, 'machine');
  await mkdir(home);
  // The fixture's registry and selection hold its workspace and are already outside the home.
  const {
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: _registry, SINGULARITY_FLOW_ACTIVE_WORKSPACE: _selection,
    SINGULARITY_FLOW_LEAD_REGISTRY: _leads, ...machine
  } = isolatedMachineEnvironment(state);
  const sentinel = { ...machine, HOME: home, USERPROFILE: home };
  for (let attempt = 0; attempt < 2; attempt++) {
    const listed = await f.invoke({ extra: sentinel });
    assert.equal(listed.child.status, 0, listed.child.stderr + listed.child.stdout);
  }
  assert.equal(existsSync(path.join(home, '.singularity-flow')), false, 'the listing wrote machine state into HOME');
  assert.ok((await readdir(path.join(state, 'cache', 'session-listings'))).length > 0,
    'the listing cache must land beside the redirected repository-check preferences');

  // Without the redirect the same listing reaches the home default, so the sentinel would see a leak.
  const leaked = await f.invoke({ extra: { ...sentinel, SINGULARITY_FLOW_REPOSITORY_CHECK_PREFERENCES: '' } });
  assert.equal(leaked.child.status, 0, leaked.child.stderr + leaked.child.stdout);
  assert.ok((await readdir(path.join(home, '.singularity-flow', 'cache', 'session-listings'))).length > 0);
});
