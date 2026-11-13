/**
 * A test plan a person can read, and the early checks beside it.
 *
 * `tests plan` named each command by its ID and argv. Why SFlow chose that command, how finely it reads
 * the results, and what it saw and did not use were all left to be worked out. And an agent learned that
 * a runner was missing, that dependencies were not installed or that one runner collects another's
 * specs only by failing at the end of the step (bin-opr, ws-graph, myl-graph; study of 2026-11-06).
 *
 * Everything here only reads: no test runs and nothing is installed or written. An early check says what
 * it found and what a person can do, and it never refuses: only the existing gates refuse. A check that
 * cannot read what it needs says nothing, so a line here is always something seen in this checkout.
 */
import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readRepositoryManifest } from './repository-manifest.mjs';
import { launcherName, resolveTestCommand, SCRIPT_RUNNERS, unwrapRunner } from './test-command-resolution.mjs';
import { runnerNamed, runnerNameOfAdapter, runnerNameOfLauncher, runnerOfLauncher, TEST_RUNNERS, TOOLS_ON_PATH } from './test-runners.mjs';
import { profileForCommand, profileIsExact } from './verification/profiles.mjs';

const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_SCANNED_ENTRIES = 4000;
const MAX_SHOWN_PATHS = 40;
const MAX_SCRIPT_WORDS = 200;
const JAVASCRIPT_TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
// A path that says what it needs: Playwright's or Cypress's own names, or an end-to-end folder.
const BROWSER_TEST_PATH = /(?:^|\/)(?:e2e|playwright|cypress)\/|\.(?:e2e|pw|cy)\.[cm]?[jt]sx?$/u;
const SKIPPED_FOLDERS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'singularity', '.sflow', 'test-results', 'playwright-report']);

export const fileReads = (root) => ({
  read: async (relative) => {
    try { return (await readRepositoryManifest(root, relative, { maxBytes: MAX_TEXT_BYTES })).bytes.toString('utf8'); } catch { return null; }
  },
  list: async (relative) => {
    try { return (await readdir(path.join(root, relative), { withFileTypes: true })).map((entry) => ({ name: entry.name, directory: entry.isDirectory() })); } catch { return []; }
  }
});
const joined = (directory, name) => (directory === '.' || !directory ? name : path.posix.join(directory, name));
const where = (directory) => (directory === '.' || !directory ? 'the repository root' : directory);
const shownScript = (text) => (String(text).length > MAX_SCRIPT_WORDS ? `${String(text).slice(0, MAX_SCRIPT_WORDS)}…` : String(text));
const major = (version) => Number(/^v?(\d+)/u.exec(String(version ?? ''))?.[1]) || null;
const isFile = (file) => stat(file).then((entry) => entry.isFile(), () => false);
const isDirectory = (file) => stat(file).then((entry) => entry.isDirectory(), () => false);
const check = (id, words, action, extra = {}) => ({ id, words, action, ...extra });

function parsedManifest(text) {
  try { const value = JSON.parse(text ?? 'null'); return value && typeof value === 'object' ? value : null; } catch { return null; }
}

const isBrowserRunner = (name) => runnerNamed(name)?.level === 'browser';

const dependenciesOf = (manifest) => ({ ...manifest?.dependencies, ...manifest?.devDependencies, ...manifest?.optionalDependencies, ...manifest?.peerDependencies });

/** What a command resolves through: its package scripts and each runner step it reaches. Never rejects. */
async function resolved(command, reads) {
  const answer = await resolveTestCommand((command.argv ?? []).map(String), { directory: command.workingDirectory ?? '.', ...reads })
    .catch(() => ({ packages: [], runs: [] }));
  return { packages: answer.packages, runs: answer.runs,
    launchers: [...new Set(answer.runs.map((run) => launcherName(unwrapRunner(run.tokens)[0])).filter(Boolean))] };
}

/** The runner of a command in a person's words, from its report format, else what it starts. */
function runnerName(command, launchers) {
  const adapted = runnerNameOfAdapter(command.result?.adapter);
  if (adapted) return adapted;
  const argv = (command.argv ?? []).map(String);
  if (argv.includes('pytest')) return 'pytest';
  for (const name of launchers) if (runnerNameOfLauncher(name)) return runnerNameOfLauncher(name);
  return runnerNameOfLauncher(launcherName(argv[0])) ?? launchers[0] ?? launcherName(argv[0]) ?? null;
}

/** Why this command: where a person approved it, or the file SFlow read it from. */
async function whyThisCommand(command, { packages, provenance, runner, reads }) {
  if (provenance === 'story-decision') return { source: 'story-decision', why: `A person accepted it for this Story${command.storyDecision?.id ? ` (${command.storyDecision.id})` : ''}.` };
  if (provenance === 'configured') return { source: 'configured', why: 'Configured in singularity/workflow.yml, which a person approved.' };
  const scripts = packages.flatMap((entry) => entry.scripts.map((script) => ({ ...script, file: entry.manifestPath })));
  if (scripts.length) {
    const [first, last] = [scripts[0], scripts.at(-1)];
    return { source: 'found', why: `Found in ${first.file} scripts.${first.name}, which runs ${shownScript(last.text)}.` };
  }
  const directory = command.workingDirectory ?? '.';
  for (const name of runnerNamed(runner)?.buildFiles ?? []) if (await reads.read(joined(directory, name)) != null) return { source: 'found', why: `Found from ${joined(directory, name)}.` };
  if (isBrowserRunner(runner)) {
    const config = (await reads.list(directory)).find((entry) => /^(?:playwright|cypress)\.config\./u.test(entry.name));
    if (config) return { source: 'found', why: `Found from ${joined(directory, config.name)} and its dependency, with no script for it.` };
  }
  return { source: 'found', why: `Found in ${where(directory)}.` };
}

/**
 * One command in a person's words: its runner, whether it reads each test or only counts, where it came
 * from and why, and what it covers. `provenance` is how the gate holds it (test-execution-handoff).
 */
export async function describeTestCommand(root, command, { provenance = command.provenance ?? null, reads = fileReads(root) } = {}) {
  const { packages, launchers } = await resolved(command, reads);
  const runner = runnerName(command, launchers);
  const exact = profileIsExact(profileForCommand(command));
  const { source, why } = await whyThisCommand(command, { packages, provenance, runner, reads });
  return {
    runner, level: isBrowserRunner(runner) ? 'browser' : 'other',
    title: `${isBrowserRunner(runner) ? 'Browser tests' : 'Tests'}${runner ? ` (${runner})` : ''}`,
    source, why,
    results: exact ? 'each-test' : 'counts',
    resultsWords: exact ? 'Reads each test by name.' : 'Reads test counts only, so a criterion rests on the whole suite.',
    covers: [...(command.affectedRoots ?? [])],
    coversWords: `Covers ${[...(command.affectedRoots ?? [])].map(where).join(', ') || 'no folder'}.`
  };
}

/**
 * What SFlow saw and does not run: a suite a configured or accepted command's folder also declares (it
 * hides them, and nothing else says so), and a runner the package plainly shows that SFlow has no reader for.
 */
export async function suitesNotUsed(root, commands, { reads = fileReads(root) } = {}) {
  const [{ resolveAffectedModule }, { moduleTestCommands, unreadRunnerOfPackage }] = await Promise.all([
    import('./code-delivery-tests.mjs'), import('./test-module-markers.mjs')]);
  const seen = [];
  for (const directory of new Set(commands.map((command) => command.workingDirectory ?? '.'))) {
    const running = commands.filter((command) => (command.workingDirectory ?? '.') === directory);
    const unread = await unreadRunnerOfPackage(root, directory).catch(() => null);
    if (unread) seen.push({ runner: unread.runner, workingDirectory: directory, why: `${unread.words}, and SFlow has no reader for its results, so it does not run it.` });
    const held = running.find((command) => ['configured', 'story-decision'].includes(command.provenance));
    if (!held) continue;
    const declared = await resolveAffectedModule(root, joined(directory, 'sflow-plan-probe')).then((module) => moduleTestCommands(root, module)).catch(() => []);
    const runners = new Set();
    for (const command of running) runners.add(runnerName(command, (await resolved(command, reads)).launchers));
    for (const suite of declared) {
      const runner = runnerName(suite, (await resolved(suite, reads)).launchers);
      if (runners.has(runner)) continue;
      seen.push({ id: suite.id, runner, argv: [...suite.argv], workingDirectory: directory,
        why: `${held.id} is ${held.provenance === 'configured' ? 'configured' : 'accepted'} for ${where(directory)}, so SFlow runs only that and not this ${runner} suite.` });
    }
  }
  return seen;
}

/** TypeScript tests under a runner the package names and SFlow cannot read: say that, not that no runner was found. */
export async function assertNoUnreadRunner(root, tests) {
  const [{ unreadRunnerOfPackage }, { SingularityFlowError }, { testSetupRoute }] = await Promise.all([import('./test-module-markers.mjs'), import('./util.mjs'), import('./code-delivery-tests.mjs')]);
  const named = await unreadRunnerOfPackage(root, path.posix.dirname(tests[0]));
  if (!named) return;
  throw new SingularityFlowError(`${named.words}, whose results SFlow cannot read yet, so no test command was inferred for ${tests.join(', ')}. `
    + 'Configure an approved test command that writes a report SFlow reads (kind: test, argv, workingDirectory, affectedRoots and a result adapter).',
  { code: 'TEST_MODULE_UNCOVERED', details: testSetupRoute({ paths: tests, runner: named.runner }) });
}

/** Which suite covers each path: the files changed so far, else the plan's. Bounded for reading. */
export async function pathCoverage(root, commands, { changed = [], planned = [] } = {}) {
  const [{ testCommandCoversPath }, { commandForTestFile }] = await Promise.all([import('./code-delivery-tests.mjs'), import('./test-module-markers.mjs')]);
  const from = changed.length ? 'changed' : planned.length ? 'planned' : null;
  const paths = [...new Set(changed.length ? changed : planned)].sort();
  const covered = [];
  const uncovered = [];
  for (const file of paths) {
    const command = commands.some((entry) => testCommandCoversPath(entry, file))
      ? await commandForTestFile(root, commands, file).catch(() => null) : null;
    if (command) covered.push({ path: file, command: command.id }); else uncovered.push(file);
  }
  return { from, total: paths.length, covered: covered.slice(0, MAX_SHOWN_PATHS), uncovered: uncovered.slice(0, MAX_SHOWN_PATHS) };
}

// ---------------------------------------------------------------------------------------------
// Early checks: each says what it found and what a person can do, and none of them refuses.

/** The install command a package's lockfile implies, looking up from its folder to the repository root. */
async function installCommand(directory, reads) {
  for (let at = directory; ; at = path.posix.dirname(at)) {
    const names = new Set((await reads.list(at)).map((entry) => entry.name));
    if (names.has('pnpm-lock.yaml')) return 'pnpm install --frozen-lockfile';
    if (names.has('bun.lock') || names.has('bun.lockb')) return 'bun install --frozen-lockfile';
    if (names.has('yarn.lock')) {
      const yarn = /^yarn@(\d+)/iu.exec(String(parsedManifest(await reads.read(joined(at, 'package.json')))?.packageManager ?? ''))?.[1];
      return `yarn install ${Number(yarn) >= 2 ? '--immutable' : '--frozen-lockfile'}`;
    }
    if (names.has('package-lock.json') || names.has('npm-shrinkwrap.json')) return 'npm ci';
    if (at === '.') return 'npm install';
  }
}

/** The folders a Node package's commands look in, from its own up to the repository root. */
function upFrom(directory) {
  const folders = [];
  for (let at = directory; ; at = path.posix.dirname(at)) { folders.push(at); if (at === '.') return folders; }
}

// What a Node command's steps start from node_modules/.bin: its runner, or what wraps it.
const NODE_RUNNER_BINARIES = new Set([...['vitest', 'jest', 'mocha', 'playwright', 'cypress', 'karma', 'ng'].flatMap((key) => TEST_RUNNERS[key].launchers), 'nyc', 'c8', 'tsx']);

/** Whether the runners a Node command reaches are installed here: the first run otherwise stops with "command not found". */
async function dependencyChecks(root, commands, reads) {
  const found = [];
  const seen = new Set();
  for (const command of commands) {
    const directory = command.workingDirectory ?? '.';
    if (!SCRIPT_RUNNERS.has(launcherName(command.argv?.[0])) && !NODE_RUNNER_BINARIES.has(launcherName(command.argv?.[0])) && !['npx', 'pnpx', 'bunx'].includes(launcherName(command.argv?.[0]))) continue;
    const manifest = parsedManifest(await reads.read(joined(directory, 'package.json')));
    const binaries = (await resolved(command, reads)).launchers.filter((name) => NODE_RUNNER_BINARIES.has(name));
    if (!manifest && !binaries.length) continue;
    const folders = upFrom(directory);
    let installed = false;
    for (const folder of folders) if (await isDirectory(path.join(root, folder, 'node_modules'))) installed = true;
    const missing = [];
    for (const binary of binaries) {
      let present = false;
      for (const folder of folders) if (await isFile(path.join(root, folder, 'node_modules', '.bin', binary))) present = true;
      if (!present) missing.push(binary);
    }
    const key = `${directory}|${installed}|${missing.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const install = await installCommand(directory, reads);
    if (!installed && (binaries.length || Object.keys(dependenciesOf(manifest)).length)) {
      found.push(check('dependencies-not-installed', `Dependencies are not installed in ${where(directory)}, so the first test run would stop with "command not found".`,
        `Run ${install} in ${where(directory)}. A new Story checkout starts without them.`, { command: install, workingDirectory: directory }));
    } else if (missing.length) {
      const declared = Object.keys(dependenciesOf(manifest));
      const undeclared = missing.filter((binary) => !declared.includes(binary) && !declared.includes(`@${binary}/test`));
      found.push(check('runner-not-installed', `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not installed in ${where(directory)}, though ${command.id} starts ${missing.length === 1 ? 'it' : 'them'}.`,
        undeclared.length ? `${joined(directory, 'package.json')} does not depend on ${undeclared.join(', ')} either: add ${undeclared.length === 1 ? 'it' : 'them'} to its dev dependencies and the plan, then run ${install}.` : `Run ${install} in ${where(directory)}.`,
        { command: install, workingDirectory: directory }));
    }
  }
  return found;
}

/** A tool a gate would start by name that is not on this machine's PATH; pytest is asked, as its import is what fails. */
async function toolChecks(root, commands, environment) {
  const found = [];
  const seen = new Set();
  for (const command of commands) {
    const directory = command.workingDirectory ?? '.';
    const launcher = launcherName(command.argv?.[0]);
    const key = `${directory}|${launcher}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { onPath, runnerFamily, runnerToolchain } = await import('./test-toolchain.mjs');
    const { installs } = runnerOfLauncher(launcher) ?? {};
    if (installs && !await isFile(path.join(root, directory, installs.file))) {
      found.push(check('dependencies-not-installed', `${joined(directory, installs.file)} is not there, so ${command.id} would stop at its first run. A new Story checkout starts without it.`,
        `Run ${installs.command} in ${where(directory)}.`, { command: installs.command, workingDirectory: directory }));
      continue;
    }
    if (TOOLS_ON_PATH[launcher]) {
      if (!await onPath(launcher, environment, path.join(root, directory))) {
        found.push(check('tool-not-found', `${TOOLS_ON_PATH[launcher]} (${launcher}) is not on this machine's PATH, and ${command.id} starts it.`, `Install ${TOOLS_ON_PATH[launcher]} here, or run this step where it is installed.`));
      }
      continue;
    }
    if (runnerFamily(command) !== 'python' || !(command.argv ?? []).includes('pytest')) continue;
    const versions = await runnerToolchain(command, { cwd: path.join(root, directory), environment }).catch(() => null);
    if (versions && !versions.python) found.push(check('tool-not-found', `${command.argv[0]} is not on this machine's PATH, and ${command.id} starts it.`, 'Install Python here, or give the repository the environment it expects (.venv).'));
    else if (versions && !versions.pytest) found.push(check('tool-not-found', `pytest is not installed for ${command.argv[0]}, so ${command.id} would stop with "No module named pytest".`, `Install what ${where(directory)} asks for (its requirements or pyproject), or run ${command.argv[0]} -m pip install pytest in its environment.`));
  }
  return found;
}

/** A simple npm range and a version: `>=20`, `^22.1`, `20.x`, `18 || 20`. Undefined when the range is beyond this reading. */
export function nodeRangeAccepts(range, version) {
  const parts = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(String(version ?? ''))?.slice(1).map(Number);
  if (!parts) return undefined;
  const compare = (other) => { for (let at = 0; at < 3; at += 1) { if (parts[at] !== (other[at] ?? 0)) return parts[at] - (other[at] ?? 0); } return 0; };
  let understood = true;
  const alternatives = String(range).split('||').map((alternative) => {
    const words = alternative.trim().split(/\s+/u).filter(Boolean);
    if (!words.length) return true;
    return words.every((word) => {
      const match = /^(>=|<=|>|<|=|\^|~)?v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/u.exec(word);
      if (!match) { understood = false; return false; }
      const [, operator = '', ...rest] = match;
      const wanted = rest.map((value) => (value === undefined || value === 'x' || value === '*' ? null : Number(value)));
      const floor = wanted.map((value) => value ?? 0);
      if (operator === '>=') return compare(floor) >= 0;
      if (operator === '<=') return compare(floor) <= 0;
      if (operator === '>') return compare(floor) > 0;
      if (operator === '<') return compare(floor) < 0;
      if (operator === '^') return parts[0] === floor[0] && compare(floor) >= 0;
      if (operator === '~') return parts[0] === floor[0] && (wanted[1] === null || parts[1] === floor[1]) && compare(floor) >= 0;
      return wanted.every((value, at) => value === null || value === parts[at]);
    });
  });
  return understood ? alternatives.some(Boolean) : undefined;
}

/** A bounded walk of a folder's files, skipping what no test lives in. */
async function repositoryFiles(root, directory, { accept, limit = MAX_SHOWN_PATHS } = {}) {
  const found = [];
  const pending = [directory];
  let visited = 0;
  while (pending.length && found.length < limit && visited < MAX_SCANNED_ENTRIES) {
    const folder = pending.shift();
    let entries = [];
    try { entries = await readdir(path.join(root, folder), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      visited += 1;
      const relative = joined(folder, entry.name);
      if (entry.isDirectory()) { if (!SKIPPED_FOLDERS.has(entry.name) && !entry.name.startsWith('.')) pending.push(relative); continue; }
      if (entry.isFile() && accept(relative)) found.push(relative);
      if (found.length >= limit) break;
    }
  }
  return found;
}

/** Whether a runner's configuration file, or its package.json key, says where its tests are. */
function limitsCollection(text, runner) {
  const { keys, within } = runnerNamed(runner).collection;
  return new RegExp(`\\b(?:${keys.join('|')})\\b${within ? '\\s*:' : ''}`, 'u').test(String(text ?? ''));
}

const unitRunnerConfigured = (runner, name) => runnerNamed(runner).pins.config.some((pattern) => pattern.test(name));

/** The Vitest or Jest step a package runs, as its tokens, or null. */
async function unitRunnerStep(commands, directory, reads) {
  for (const command of commands.filter((entry) => (entry.workingDirectory ?? '.') === directory)) {
    for (const run of (await resolved(command, reads)).runs) {
      const tokens = unwrapRunner(run.tokens);
      const name = runnerNameOfLauncher(launcherName(tokens[0]));
      if (name === 'Vitest' || name === 'Jest') return { name, tokens };
    }
  }
  return null;
}

/**
 * One runner collecting another's files: Vitest and Jest take every `*.spec.*` they reach, a Playwright
 * spec among them, and that run fails even when each of its own tests passes (bin-opr: 31 passed, exit 1).
 */
async function collectionChecks(root, commands, { planned = [], reads }) {
  const found = [];
  for (const directory of new Set(commands.map((command) => command.workingDirectory ?? '.'))) {
    const unit = await unitRunnerStep(commands, directory, reads);
    if (!unit) continue;
    const entries = await reads.list(directory);
    const manifest = parsedManifest(await reads.read(joined(directory, 'package.json')));
    const configNames = entries.filter((entry) => unitRunnerConfigured(unit.name, entry.name)).map((entry) => entry.name);
    const configs = await Promise.all(configNames.map((name) => reads.read(joined(directory, name))));
    if (configs.some((text) => limitsCollection(text, unit.name)) || (unit.name === 'Jest' && limitsCollection(JSON.stringify(manifest?.jest ?? null), 'Jest'))) continue;
    // A script that already names where its tests are (`vitest run src`) keeps them apart.
    const operands = unit.tokens.slice(1).filter((token) => !token.startsWith('-') && !['run', 'watch', 'related'].includes(token));
    const reached = (file) => {
      const relative = directory === '.' ? file : file.slice(directory.length + 1);
      return !operands.length || operands.some((operand) => relative.includes(operand.replace(/^\.\//u, '')));
    };
    const onDisk = await repositoryFiles(root, directory, { limit: 400, accept: (file) => JAVASCRIPT_TEST.test(file) && BROWSER_TEST_PATH.test(file) });
    const specs = [];
    for (const file of onDisk) if (/['"]@playwright\/test['"]/u.test(await reads.read(file) ?? '')) specs.push(file);
    for (const file of planned) {
      if (!specs.includes(file) && JAVASCRIPT_TEST.test(file) && BROWSER_TEST_PATH.test(file) && !/\.cy\.|(?:^|\/)cypress\//u.test(file)
        && (directory === '.' || file.startsWith(`${directory}/`))) specs.push(file);
    }
    const collected = specs.filter(reached).sort();
    if (!collected.length) continue;
    const shown = collected.slice(0, 3).join(', ') + (collected.length > 3 ? ` and ${collected.length - 3} more` : '');
    const config = configNames[0] ? joined(directory, configNames[0]) : joined(directory, unit.name === 'Vitest' ? 'vite.config.js' : 'jest.config.js');
    found.push(check('runner-collects-other-tests', `${unit.name} would also collect ${shown}, a browser spec. Its run then fails with "Playwright Test did not expect test() to be called here", even when every ${unit.name} test passes.`,
      `Keep browser specs out of ${unit.name}'s reach with ${unit.name === 'Vitest' ? 'test.include or test.exclude' : 'testMatch or testPathIgnorePatterns'} in ${config}, and name that file in the plan's supporting files so the change is planned.`,
      { runner: unit.name, paths: collected.slice(0, MAX_SHOWN_PATHS), config }));
  }
  return found;
}

/** A planned test that plainly needs a browser runner the package does not have yet. */
async function plannedRunnerChecks({ planned = [], reads, moduleOf }) {
  const found = [];
  const byFolder = new Map();
  for (const file of planned.filter((entry) => JAVASCRIPT_TEST.test(entry) && BROWSER_TEST_PATH.test(entry))) {
    const directory = await moduleOf(file);
    if (!byFolder.has(directory)) byFolder.set(directory, []);
    byFolder.get(directory).push(file);
  }
  for (const [directory, files] of byFolder) {
    const dependencies = Object.keys(dependenciesOf(parsedManifest(await reads.read(joined(directory, 'package.json')))));
    const has = (name) => dependencies.includes(name);
    if (has('@playwright/test') || has('playwright') || has('cypress')) continue;
    const manifest = joined(directory, 'package.json');
    found.push(check('planned-runner-missing', `The plan names ${files.slice(0, 3).join(', ')}, which reads as a browser test, but ${manifest} has no Playwright or Cypress yet.`,
      `Adding one changes ${manifest}, its lockfile and the runner's configuration: name them in the plan's supporting files. SFlow then finds the new suite on its own; no test configuration is needed.`,
      { paths: files.slice(0, MAX_SHOWN_PATHS), workingDirectory: directory }));
  }
  return found;
}

/** Where Playwright keeps its browsers: its own variable, else its per-user cache. */
function playwrightBrowsersFolder(environment, platform = process.platform, home = environment.HOME ?? os.homedir()) {
  const set = environment.PLAYWRIGHT_BROWSERS_PATH;
  if (set === '0') return null; // Beside the package, which this check does not read.
  if (set) return set;
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches', 'ms-playwright');
  if (platform === 'win32') return path.join(environment.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'ms-playwright');
  return path.join(environment.XDG_CACHE_HOME ?? path.join(home, '.cache'), 'ms-playwright');
}

/** Playwright with no browser downloaded: every test fails with "Executable doesn't exist". */
async function browserChecks(commands, { environment, reads }) {
  const playwright = [];
  for (const command of commands) {
    if (command.result?.adapter === 'playwright-json' || (await resolved(command, reads)).launchers.includes('playwright')) playwright.push(command);
  }
  if (!playwright.length) return [];
  const folder = playwrightBrowsersFolder(environment);
  if (!folder) return [];
  const names = await readdir(folder).catch(() => []);
  if (names.some((name) => /^(?:chromium|chrome|firefox|webkit)(?:[-_]|$)/u.test(name))) return [];
  return [check('browser-not-installed', `Playwright has no browser downloaded on this machine, so ${playwright[0].id} would fail with "Executable doesn't exist".`,
    'Run npx playwright install chromium, or the browser the Playwright configuration names. It downloads a browser; the repository does not change.', { command: 'npx playwright install chromium' })];
}

/** A Vitest step whose DOM environment Node 25's own `localStorage` stands in front of. */
async function usesVitestDomStorage(root, directory, commands, reads) {
  const unit = await unitRunnerStep(commands, directory, reads);
  if (unit?.name !== 'Vitest') return false;
  const names = (await reads.list(directory)).filter((entry) => unitRunnerConfigured('Vitest', entry.name)).map((entry) => entry.name);
  const texts = await Promise.all(names.map((name) => reads.read(joined(directory, name))));
  if (!texts.some((text) => /\benvironment\s*:\s*['"](?:jsdom|happy-dom)['"]/u.test(String(text ?? '')))) return false;
  const files = await repositoryFiles(root, directory, { limit: 200, accept: (file) => /\.[cm]?[jt]sx?$/u.test(file) });
  for (const file of files) if (/\b(?:localStorage|sessionStorage)\b/u.test(await reads.read(file) ?? '')) return true;
  return false;
}

/** A Node that does not suit the repository: asked for by name, or one known to break what it uses. */
export async function nodeVersionChecks(root, commands, { environment, reads }) {
  const { runnerFamily, nodeVersion } = await import('./test-toolchain.mjs');
  const node = commands.filter((command) => runnerFamily(command) === 'node');
  if (!node.length) return [];
  const { installedNodeVersions, nodeVersionNote, requestedNodeVersion } = await import('./project-node-version.mjs');
  const found = [];
  for (const directory of new Set(node.map((command) => command.workingDirectory ?? '.'))) {
    const cwd = path.join(root, directory);
    const requested = await requestedNodeVersion({ cwd, root, environment }).catch(() => null);
    if (requested?.status === 'not-installed' || requested?.status === 'not-a-version') {
      // A version file naming what is not installed is answered by installing it, or by a person changing it to what is.
      const here = requested.status === 'not-installed' && requested.file === '.nvmrc' ? await installedNodeVersions(environment).catch(() => []) : [];
      const asks = parsedManifest(await reads.read(joined(directory, 'package.json')))?.engines?.node;
      const newest = here.find((version) => typeof asks !== 'string' || nodeRangeAccepts(asks, version) !== false);
      found.push(check('node-version', nodeVersionNote(requested), `Install the version it asks for, or change ${requested.file}.`,
        { file: requested.file, ...(newest ? { pin: { file: '.nvmrc', version: String(major(newest)), node: newest, replaces: requested.wanted } } : {}) }));
      continue;
    }
    // SFlow runs tests on what a version file asks for, so the Node below is only for a repository with none.
    if (requested) continue;
    const version = await nodeVersion('node', { cwd, environment });
    if (!version) { found.push(check('tool-not-found', `No Node was found on this machine's PATH, and ${node[0].id} needs it.`, 'Install Node here, or run this step where it is installed.')); continue; }
    const others = await installedNodeVersions(environment).catch(() => []);
    const installed = others.filter((other) => major(other) !== major(version)).slice(0, 3);
    const offer = installed.length ? ` Also installed here: Node ${installed.join(', ')}.` : '';
    // The one a person can pin: installed here and suiting what the repository asks, never a guess at a path (node-pin.mjs).
    const pin = (node) => (node ? { pin: { file: '.nvmrc', version: String(major(node)), node } } : {});
    const range = parsedManifest(await reads.read(joined(directory, 'package.json')))?.engines?.node;
    if (typeof range === 'string' && nodeRangeAccepts(range, version) === false) {
      // When the range accepts one installed major only, the repository named the answer: SFlow settles the pin
      // with this evidence instead of asking (node-version-settle.mjs) [owner, 2026-11-13].
      const accepted = others.filter((other) => nodeRangeAccepts(range, other) === true);
      const named = new Set(accepted.map(major)).size === 1 ? { source: { file: joined(directory, 'package.json'), field: 'engines.node', range } } : {};
      const offered = pin(accepted[0]);
      found.push(check('node-version', `${joined(directory, 'package.json')} asks for Node ${range}, and tests here would run on Node ${version}.${offer}`,
        'Switch Node before starting, or a person pins it: a .nvmrc in the repository makes SFlow run tests on that version. It is a repository change, so name it in the plan.',
        { node: version, installed, ...(offered.pin ? { pin: { ...offered.pin, ...named } } : {}) }));
      continue;
    }
    if (major(version) >= 25 && await usesVitestDomStorage(root, directory, node, reads)) {
      found.push(check('node-version', `Tests here would run on Node ${version}, whose own localStorage stands in front of the DOM environment's under Vitest. Tests that use localStorage then fail with errors such as "Cannot read properties of undefined (reading 'clear')", and the change is not the cause.${offer}`,
        'Do not stub localStorage to get past it. Switch Node before starting, or a person pins an earlier one: a .nvmrc in the repository makes SFlow run tests on that version. It is a repository change, so name it in the plan.', { node: version, installed, ...pin(others.find((other) => major(other) < 25)) }));
    }
  }
  return found;
}

/**
 * What would surprise someone at the end of this step, found before it starts. Each entry is
 * `{ id, words, action }`; never a refusal, and it never rejects: a check that fails to read says nothing.
 */
export async function earlyTestChecks(root, commands, { planned = [], environment = process.env } = {}) {
  const reads = fileReads(root);
  const moduleOf = async (file) => {
    const { resolveAffectedModule } = await import('./code-delivery-tests.mjs');
    return resolveAffectedModule(root, file).then((module) => module.root ?? '.', () => '.');
  };
  const guarded = async (found) => { try { return await found(); } catch { return []; } };
  const plannedTests = [...new Set(planned)];
  return (await Promise.all([
    guarded(() => dependencyChecks(root, commands, reads)),
    guarded(() => toolChecks(root, commands, environment)),
    guarded(() => nodeVersionChecks(root, commands, { environment, reads })),
    guarded(() => plannedRunnerChecks({ planned: plannedTests, reads, moduleOf })),
    guarded(() => collectionChecks(root, commands, { planned: plannedTests, reads })),
    guarded(() => browserChecks(commands, { environment, reads }))
  ])).flat();
}

// ---------------------------------------------------------------------------------------------

const commandLine = (command) => (command.argv ?? []).join(' ');

/** The plan in words, for `tests plan` without --json. */
export function testPlanText(plan) {
  const scope = plan.scope.kind === 'story' ? `${plan.scope.workId} step ${plan.scope.phase}` : `capability ${plan.scope.capability}`;
  const count = plan.commands.length;
  const lines = [];
  if (plan.stopped) lines.push(`SFlow has no test command for ${scope} yet: ${plan.stopped.words}`);
  else if (!count) lines.push(`SFlow has no test command for ${scope} yet.`);
  else lines.push(`${plan.prospective ? `Once the plan's files change, for ${scope} SFlow will run` : `For ${scope} SFlow will run`} ${count === 1 ? 'one test suite' : `${count} test suites`}:`);
  for (const command of plan.commands) {
    const environments = (command.environments ?? []).map((entry) => `${entry.name}${entry.default ? ' (default)' : ''}: ${entry.status}`).join(', ');
    lines.push('', `  ${command.title ?? command.id}`, `    ${commandLine(command)}, in ${where(command.workingDirectory)}${environments ? ` · ${environments}` : ''}`);
    lines.push(`    ${[command.why, command.resultsWords, command.coversWords].filter(Boolean).join(' ')}`);
    if (command.pin) lines.push(`    ${command.pin.words}`);
    lines.push(`    ID ${command.id}`);
  }
  if (plan.paths?.from) {
    const name = plan.paths.from === 'changed' ? 'changed so far' : 'the plan names';
    lines.push('', `  ${plan.paths.total} ${plan.paths.total === 1 ? 'file' : 'files'} ${name}: ${plan.paths.uncovered.length ? `no suite covers ${plan.paths.uncovered.join(', ')}.` : 'each is covered by a suite above.'}`);
  }
  if (plan.notUsed?.length) {
    lines.push('', '  Seen and not used');
    for (const entry of plan.notUsed) lines.push(`    ${entry.argv ? `${entry.argv.join(' ')}: ` : ''}${entry.why}`);
  }
  if (plan.earlyChecks?.length) {
    lines.push('', '  Before you start (none of these stops the step; only the gates refuse)');
    for (const entry of plan.earlyChecks) lines.push(`    ${entry.words}`, `      What to do: ${entry.action}`);
  }
  lines.push('', `Run: singularity-flow tests run${plan.scope.kind === 'story' ? ` --work-id ${plan.scope.workId} --phase ${plan.scope.phase}` : ` --capability ${plan.scope.capability}`}`);
  return lines.join('\n');
}
