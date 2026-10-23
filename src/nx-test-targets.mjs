/**
 * An Nx project's test targets as its structured test runners.
 *
 * Nx keeps a project's targets in its project.json, or infers them from a plugin nx.json names,
 * instead of package.json scripts. A changed e2e spec therefore resolved to the workspace's root
 * package.json, no runner was inferred, and publication refused with
 * CODE_DELIVERY_TEST_COMMAND_REQUIRED although `nx run <project>:e2e` passed.
 *
 * An e2e project names the applications it tests in `implicitDependencies` (Nx's own convention,
 * and what `nx affected` follows), so its target also covers those projects when they sit beside it.
 * A project's own Jest or Vitest target runs its unit tests, beside that Playwright run. `nx run`
 * hands the report flags to the Jest executor, or appends them to a plain `jest`/`vitest` command.
 * Only project.json, nx.json and the presence of runner configs are read; nothing runs.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { readRepositoryManifest, repositoryManifestExists } from './repository-manifest.mjs';

const PLAYWRIGHT_EXECUTORS = new Set(['@nx/playwright:playwright', '@nrwl/playwright:playwright']);
const JEST_EXECUTORS = new Set(['@nx/jest:jest', '@nrwl/jest:jest']);
const RUN_COMMANDS_EXECUTORS = new Set(['nx:run-commands', '@nx/workspace:run-commands', '@nrwl/workspace:run-commands']);
const configs = (name) => ['ts', 'js', 'mts', 'mjs', 'cts', 'cjs'].map((extension) => `${name}.config.${extension}`);
const PLAYWRIGHT_CONFIGS = configs('playwright');
const PROJECT_NAME = /^@?[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
// No colon: `nx run` reads project:target:configuration.
const TARGET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
// A plain `playwright test` with simple arguments; shell composition is not trustworthy evidence.
const PLAYWRIGHT_COMMAND = /^(?:npx (?:--no-install )?)?playwright test(?: [A-Za-z0-9_./=-]+)*$/u;
// A plain `jest`, `vitest` or `vitest run` with simple arguments, never one that watches, lists, picks
// its own report, or moves Vitest's root (the report path resolves against it).
const UNIT_COMMANDS = [
  ['jest', /^(?:npx (?:--no-install )?)?jest(?: [A-Za-z0-9_./=-]+)*$/u, /(?:^| )--(?:watch\w*|json|outputFile|reporters|listTests)(?=[ =]|$)/u],
  ['vitest', /^(?:npx (?:--no-install )?)?vitest(?: run)?(?: [A-Za-z0-9_./=-]+)*$/u,
    /^(?:npx (?:--no-install )?)?vitest (?:watch|dev|bench|init|list|related)(?: |$)|(?:^| )(?:-[wrc]|--(?:watch|ui|outputFile|reporter|root|config))(?=[ =]|$)/u]
];
// The plugins that infer a target running `jest` or `vitest` in a project holding that runner's config:
// the option naming the target, and the runner.
const UNIT_PLUGINS = new Map([['@nx/jest/plugin', ['targetName', 'jest']], ['@nx/vite/plugin', ['testTargetName', 'vitest']]]);
// Package managers that run the workspace's own nx binary and never download one.
const NX_LAUNCHERS = Object.freeze({ npm: ['npx', '--no-install', 'nx'], pnpm: ['pnpm', 'exec', 'nx'], yarn: ['yarn', 'nx'] });
const MAX_SIBLINGS = 256;

const join = (directory, name) => path.posix.join(directory === '.' ? '' : directory, name);
const slug = (directory) => (directory === '.' ? '' : `${directory.replaceAll('/', '-')}-`);

async function json(root, relative) {
  try {
    const value = JSON.parse((await readRepositoryManifest(root, relative)).bytes.toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

async function anyExists(root, directory, names) {
  for (const name of names) if (await repositoryManifestExists(root, join(directory, name))) return true;
  return false;
}

/** The nearest directory from `directory` up to the repository root that holds nx.json, or null. */
async function nxWorkspaceRoot(root, directory) {
  let current = directory === '.' ? '' : directory;
  while (true) {
    if (await repositoryManifestExists(root, join(current, 'nx.json'))) return current || '.';
    if (!current) return null;
    const parent = path.posix.dirname(current);
    current = parent === '.' ? '' : parent;
  }
}

/** The plugins nx.json registers for every project; one limited by include/exclude globs is left to an approved command. */
async function workspacePlugins(root, workspace) {
  const nx = await json(root, join(workspace, 'nx.json'));
  return (Array.isArray(nx?.plugins) ? nx.plugins : []).map((entry) => (typeof entry === 'string' ? { plugin: entry } : entry))
    .filter((plugin) => plugin && typeof plugin === 'object' && plugin.include === undefined && plugin.exclude === undefined);
}

/** The Nx project at `directory`: its workspace, name and project.json, or null. */
async function nxProject(root, directory) {
  if (!await repositoryManifestExists(root, join(directory, 'project.json'))) return null;
  const workspace = await nxWorkspaceRoot(root, directory);
  if (workspace === null) return null;
  const project = await json(root, join(directory, 'project.json'));
  if (!project) return null;
  const name = typeof project.name === 'string' ? project.name : (await json(root, join(directory, 'package.json')))?.name;
  return typeof name === 'string' && PROJECT_NAME.test(name) ? { workspace, name, project } : null;
}

const projectTargets = (project) => (project.targets && typeof project.targets === 'object' ? project.targets : {});

/** The one command a run-commands target (or the `command` shorthand) runs with `nx run`'s arguments appended. */
function targetCommand(value) {
  if (value.options?.forwardAllArgs === false) return undefined;
  return value.executor === undefined ? value.command
    : RUN_COMMANDS_EXECUTORS.has(value.executor) && value.options?.commands === undefined ? value.options?.command ?? value.command : undefined;
}

function playwrightTarget(value) {
  if (!value || typeof value !== 'object') return false;
  if (PLAYWRIGHT_EXECUTORS.has(value.executor)) return true;
  const command = targetCommand(value);
  return typeof command === 'string' && PLAYWRIGHT_COMMAND.test(command.trim());
}

/** The project's Playwright target: `e2e` when it has several, null when it has none or several others. */
async function projectPlaywrightTarget(root, directory, { workspace, project }) {
  const targets = projectTargets(project);
  const found = new Set(Object.entries(targets).filter(([target, value]) => TARGET_NAME.test(target) && playwrightTarget(value)).map(([target]) => target));
  // Nx 17+ infers the target from the project's playwright.config.* when nx.json registers the plugin.
  for (const plugin of await workspacePlugins(root, workspace)) {
    if (plugin.plugin !== '@nx/playwright/plugin') continue;
    const target = plugin.options?.targetName ?? 'e2e';
    const declared = targets[target];
    // A project.json entry with its own executor or command replaces the inferred target.
    if (!TARGET_NAME.test(target) || (declared && (declared.executor || declared.command) && !playwrightTarget(declared))) continue;
    if (await anyExists(root, directory, PLAYWRIGHT_CONFIGS)) found.add(target);
  }
  return found.has('e2e') ? 'e2e' : found.size === 1 ? [...found][0] : null;
}

/** A run-commands `cwd` relative to the workspace (Nx resolves {projectRoot} and a leading {workspaceRoot}/), else null. */
function commandDirectory(cwd, projectRoot) {
  if (cwd === undefined) return '.';
  if (typeof cwd !== 'string') return null;
  const value = path.posix.normalize(cwd.replace(/^\{workspaceRoot\}\//u, '').replaceAll('{projectRoot}', projectRoot) || '.')
    .replace(/(?<=.)\/+$/u, '');
  return /[{}\\:]|^(?:\/|\.\.(?:\/|$))/u.test(value) ? null : value;
}

/** What Nx runs for a target a plugin infers as `inferred` and project.json may also declare. */
function mergedTarget(declared, inferred) {
  if (!declared || !inferred) return declared ?? inferred;
  const command = declared.executor === undefined || declared.executor === 'nx:run-commands'
    ? declared.command ?? declared.options?.command ?? declared.options?.commands : null;
  // Nx merges the entry's options into the inferred target unless it names another executor or command.
  return command !== undefined && command !== inferred.options.command ? declared
    : { ...inferred, options: { ...inferred.options, ...declared.options, command: inferred.options.command } };
}

/** The runner of a Jest or Vitest target and the directory it runs in, relative to the workspace, else null. */
function unitRunner(value, projectRoot) {
  if (!value || typeof value !== 'object') return null;
  // The executor runs Jest in the Nx process, whose directory is the workspace root.
  if (JEST_EXECUTORS.has(value.executor)) return { runner: 'jest', cwd: '.' };
  const command = targetCommand(value);
  const runner = typeof command === 'string'
    && UNIT_COMMANDS.find(([, plain, unsafe]) => plain.test(command.trim()) && !unsafe.test(command.trim()))?.[0];
  // A plain command runs in the target's `cwd`, the workspace root when it names none.
  const cwd = runner ? commandDirectory(value.options?.cwd, projectRoot) : null;
  return cwd ? { runner, cwd } : null;
}

/** Whether `directory` holds a Vitest config: vitest.config.*, or a vite.config.* with a `test` block. */
async function vitestConfig(root, directory) {
  if (await anyExists(root, directory, configs('vitest'))) return true;
  for (const config of configs('vite')) {
    if (!await repositoryManifestExists(root, join(directory, config))) continue;
    const text = await readRepositoryManifest(root, join(directory, config)).then((read) => read.bytes.toString('utf8'), () => '');
    // @nx/vite/plugin infers no test target from a vite.config.* without one.
    if (/\btest\s*:/u.test(text)) return true;
  }
  return false;
}

/**
 * The project's Jest or Vitest target: `test` when it has several, null when it has none, several
 * others, or a `test` target of another kind (another target would test only part of the project).
 */
async function projectUnitTarget(root, directory, { workspace, project }) {
  const projectRoot = path.posix.relative(workspace === '.' ? '' : workspace, directory) || '.';
  const targets = projectTargets(project);
  // A later plugin's target replaces an earlier one's of the same name, as Nx merges them.
  const inferred = new Map();
  for (const plugin of await workspacePlugins(root, workspace)) {
    const [option, runner] = UNIT_PLUGINS.get(plugin.plugin) ?? [];
    const target = plugin.options?.[option] ?? 'test';
    if (!runner || typeof target !== 'string' || !TARGET_NAME.test(target)) continue;
    if (runner === 'jest' ? await anyExists(root, directory, configs('jest')) : await vitestConfig(root, directory)) {
      inferred.set(target, { executor: 'nx:run-commands', options: { command: runner, cwd: projectRoot } });
    }
  }
  const found = new Map();
  for (const target of new Set([...Object.keys(targets), ...inferred.keys()])) {
    const unit = TARGET_NAME.test(target) && unitRunner(mergedTarget(Object.hasOwn(targets, target) ? targets[target] : undefined, inferred.get(target)), projectRoot);
    if (unit) found.set(target, unit);
  }
  const named = Object.hasOwn(targets, 'test') || inferred.has('test');
  const target = found.has('test') ? 'test' : found.size === 1 && !named ? [...found.keys()][0] : null;
  return target && { target, ...found.get(target) };
}

/** The Nx projects in the directories beside `directory`, by name (bounded). */
async function siblingProjects(root, directory) {
  if (directory === '.') return [];
  const parent = path.posix.dirname(directory);
  let entries;
  try { entries = await readdir(path.join(root, parent), { withFileTypes: true }); } catch { return []; }
  const projects = [];
  for (const entry of entries.filter((item) => item.isDirectory() && !item.name.startsWith('.') && item.name !== 'node_modules')
    .map((item) => item.name).sort().slice(0, MAX_SIBLINGS)) {
    const sibling = join(parent, entry);
    if (sibling === directory) continue;
    const project = await nxProject(root, sibling).catch(() => null);
    if (project) projects.push({ directory: sibling, ...project });
  }
  return projects;
}

const dependsOn = (project, name) => Array.isArray(project.implicitDependencies) && project.implicitDependencies.includes(name);

/**
 * The Nx project whose Playwright target tests the project at `directory`: itself, else the e2e
 * project beside it that names it in implicitDependencies (`<name>-e2e` when there are several).
 */
async function playwrightTester(root, directory, own) {
  if (!own) return null;
  const target = await projectPlaywrightTarget(root, directory, own);
  if (target) return { ...own, directory, target };
  const testers = [];
  for (const sibling of await siblingProjects(root, directory)) {
    if (sibling.workspace !== own.workspace || !dependsOn(sibling.project, own.name)) continue;
    const siblingTarget = await projectPlaywrightTarget(root, sibling.directory, sibling);
    if (siblingTarget) testers.push({ ...sibling, target: siblingTarget });
  }
  return testers.length === 1 ? testers[0] : testers.find((sibling) => sibling.name === `${own.name}-e2e`) ?? null;
}

/**
 * The directory that owns an Nx project's tests: the project itself when it has a Jest or Vitest
 * target, else the project whose Playwright target tests it, else null.
 */
export async function nxTestProjectDirectory(root, directory) {
  const own = await nxProject(root, directory);
  if (own && await projectUnitTarget(root, directory, own)) return directory;
  return (await playwrightTester(root, directory, own))?.directory ?? null;
}

async function launcher(root, workspace, packageManager) {
  return NX_LAUNCHERS[await packageManager(workspace, await json(root, join(workspace, 'package.json')) ?? {})] ?? null;
}

/**
 * The project's own Jest or Vitest target, with its JSON report written where the runner resolves the
 * path: Jest against its process directory (the workspace for the executor), Vitest against its root,
 * which is the command's directory. The kernel reads the report relative to the workspace.
 */
async function unitCommand(root, directory, packageManager) {
  const own = await nxProject(root, directory);
  const found = own && await projectUnitTarget(root, directory, own);
  const nx = found && await launcher(root, own.workspace, packageManager);
  if (!nx) return null;
  const report = `.sflow/results/${slug(directory)}${found.runner}-tests.json`;
  const outputFile = `--outputFile=${found.cwd === '.' ? report : path.posix.relative(found.cwd, report)}`;
  return {
    id: directory === '.' ? `${found.runner}-tests` : `${directory}-${found.runner}-tests`, kind: 'test',
    argv: [...nx, 'run', `${own.name}:${found.target}`, '--skip-nx-cache',
      ...(found.runner === 'jest' ? ['--json', outputFile] : ['--run', '--reporter=json', outputFile])],
    workingDirectory: own.workspace, affectedRoots: [directory], modelPolicy: 'never',
    result: { adapter: `${found.runner}-json`, path: report, minimumDiscovered: 1 }
  };
}

/**
 * `nx run <project>:<target>` from the workspace root, with the JSON reporter the kernel binds to the
 * result path (PLAYWRIGHT_JSON_OUTPUT_FILE). The cache is skipped so the tests really run.
 */
async function playwrightCommand(root, moduleRoot, packageManager) {
  const found = await playwrightTester(root, moduleRoot, await nxProject(root, moduleRoot));
  if (!found) return null;
  // The target also tests the projects beside it that it names in implicitDependencies.
  const covers = [found.directory, ...(await siblingProjects(root, found.directory))
    .filter((sibling) => sibling.workspace === found.workspace && dependsOn(found.project, sibling.name)).map((sibling) => sibling.directory)];
  const nx = await launcher(root, found.workspace, packageManager);
  if (!nx) return null;
  return {
    id: found.directory === '.' ? 'playwright-tests' : `${found.directory}-playwright-tests`, kind: 'test',
    argv: [...nx, 'run', `${found.name}:${found.target}`, '--skip-nx-cache', '--reporter=json'],
    workingDirectory: found.workspace, affectedRoots: covers, modelPolicy: 'never',
    result: { adapter: 'playwright-json', path: `.sflow/results/${slug(found.directory)}playwright-tests.json`, minimumDiscovered: 1 }
  };
}

/**
 * The test command of the Nx project at `moduleRoot`: its own Jest or Vitest target, else (unless
 * `unitOnly`) the Playwright target that tests it. A `nodeScript` other than `test` names a browser
 * script, so it asks for that Playwright target alone: the separate run publication adds beside a
 * unit command. `packageManager(workspace, manifest)` names the workspace's package manager.
 */
export async function nxTestCommand(root, moduleRoot, { packageManager, unitOnly = false, nodeScript = 'test' }) {
  const unit = nodeScript === 'test' ? await unitCommand(root, moduleRoot, packageManager) : null;
  return unit ?? (unitOnly ? null : playwrightCommand(root, moduleRoot, packageManager));
}
