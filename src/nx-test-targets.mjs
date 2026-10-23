/**
 * An Nx project's Playwright target as its structured test runner.
 *
 * Nx keeps a project's targets in its project.json, or infers them from a plugin nx.json names,
 * instead of package.json scripts. A changed e2e spec therefore resolved to the workspace's root
 * package.json, no runner was inferred, and publication refused with
 * CODE_DELIVERY_TEST_COMMAND_REQUIRED although `nx run <project>:e2e` passed.
 *
 * An e2e project names the applications it tests in `implicitDependencies` (Nx's own convention,
 * and what `nx affected` follows), so its target also covers those projects when they sit beside it.
 * Only project.json, nx.json and the presence of a Playwright config are read; nothing runs.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { readRepositoryManifest, repositoryManifestExists } from './repository-manifest.mjs';

const PLAYWRIGHT_EXECUTORS = new Set(['@nx/playwright:playwright', '@nrwl/playwright:playwright']);
const RUN_COMMANDS_EXECUTORS = new Set(['nx:run-commands', '@nx/workspace:run-commands', '@nrwl/workspace:run-commands']);
const PLAYWRIGHT_CONFIGS = ['ts', 'js', 'mts', 'mjs', 'cts', 'cjs'].map((extension) => `playwright.config.${extension}`);
const PROJECT_NAME = /^@?[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
// No colon: `nx run` reads project:target:configuration.
const TARGET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
// A plain `playwright test` with simple arguments; shell composition is not trustworthy evidence.
const PLAYWRIGHT_COMMAND = /^(?:npx (?:--no-install )?)?playwright test(?: [A-Za-z0-9_./=-]+)*$/u;
// Package managers that run the workspace's own nx binary and never download one.
const NX_LAUNCHERS = Object.freeze({ npm: ['npx', '--no-install', 'nx'], pnpm: ['pnpm', 'exec', 'nx'], yarn: ['yarn', 'nx'] });
const MAX_SIBLINGS = 256;

const join = (directory, name) => path.posix.join(directory === '.' ? '' : directory, name);

async function json(root, relative) {
  try {
    const value = JSON.parse((await readRepositoryManifest(root, relative)).bytes.toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
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

function playwrightTarget(value) {
  if (!value || typeof value !== 'object') return false;
  if (PLAYWRIGHT_EXECUTORS.has(value.executor)) return true;
  const command = value.executor === undefined ? value.command
    : RUN_COMMANDS_EXECUTORS.has(value.executor) && value.options?.commands === undefined ? value.options?.command ?? value.command : undefined;
  return typeof command === 'string' && PLAYWRIGHT_COMMAND.test(command.trim());
}

/** The project's Playwright target: `e2e` when it has several, null when it has none or several others. */
async function projectPlaywrightTarget(root, directory, { workspace, project }) {
  const targets = project.targets && typeof project.targets === 'object' ? project.targets : {};
  const found = new Set(Object.entries(targets).filter(([target, value]) => TARGET_NAME.test(target) && playwrightTarget(value)).map(([target]) => target));
  // Nx 17+ infers the target from the project's playwright.config.* when nx.json registers the
  // plugin. A plugin limited by include/exclude globs is left to an approved command.
  const nx = await json(root, join(workspace, 'nx.json'));
  for (const entry of Array.isArray(nx?.plugins) ? nx.plugins : []) {
    const plugin = typeof entry === 'string' ? { plugin: entry } : entry;
    if (plugin?.plugin !== '@nx/playwright/plugin' || plugin.include !== undefined || plugin.exclude !== undefined) continue;
    const target = plugin.options?.targetName ?? 'e2e';
    const declared = targets[target];
    // A project.json entry with its own executor or command replaces the inferred target.
    if (!TARGET_NAME.test(target) || (declared && (declared.executor || declared.command) && !playwrightTarget(declared))) continue;
    for (const config of PLAYWRIGHT_CONFIGS) {
      if (await repositoryManifestExists(root, join(directory, config))) { found.add(target); break; }
    }
  }
  return found.has('e2e') ? 'e2e' : found.size === 1 ? [...found][0] : null;
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
async function playwrightTester(root, directory) {
  const own = await nxProject(root, directory);
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

/** The directory of the Nx project whose Playwright target tests `directory`, or null. */
export async function nxPlaywrightProjectDirectory(root, directory) {
  return (await playwrightTester(root, directory))?.directory ?? null;
}

/**
 * `nx run <project>:<target>` from the workspace root, with the JSON reporter the kernel binds to the
 * result path (PLAYWRIGHT_JSON_OUTPUT_FILE). The cache is skipped so the tests really run.
 * `packageManager(workspace, manifest)` names the workspace's package manager.
 */
export async function nxPlaywrightTestCommand(root, moduleRoot, { packageManager }) {
  const found = await playwrightTester(root, moduleRoot);
  if (!found) return null;
  // The target also tests the projects beside it that it names in implicitDependencies.
  const covers = [found.directory, ...(await siblingProjects(root, found.directory))
    .filter((sibling) => sibling.workspace === found.workspace && dependsOn(found.project, sibling.name)).map((sibling) => sibling.directory)];
  const manifest = await json(root, join(found.workspace, 'package.json')) ?? {};
  const launcher = NX_LAUNCHERS[await packageManager(found.workspace, manifest)];
  if (!launcher) return null;
  const slug = found.directory === '.' ? '' : `${found.directory.replaceAll('/', '-')}-`;
  return {
    id: found.directory === '.' ? 'playwright-tests' : `${found.directory}-playwright-tests`, kind: 'test',
    argv: [...launcher, 'run', `${found.name}:${found.target}`, '--skip-nx-cache', '--reporter=json'],
    workingDirectory: found.workspace, affectedRoots: covers, modelPolicy: 'never',
    result: { adapter: 'playwright-json', path: `.sflow/results/${slug}playwright-tests.json`, minimumDiscovered: 1 }
  };
}
