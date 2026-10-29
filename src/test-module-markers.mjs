/**
 * Test inference beyond the core manifest table, loaded only where a code-delivery gate, its recovery
 * preview, test setup or readiness maps a changed path to the commands that test it: the build files of
 * ecosystems a changed path's walk must stop at [TCE:REQ-051], the `node --test` fallback's own runner
 * check [TCE:REQ-054], and the ecosystems [TCE:REQ-070]: a Node package's runners and levels, .NET test
 * projects, Maven failsafe, Python project tools, Android variants and devices, and the Playwright,
 * mocha, cargo and pytest report and declaration readers.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { inferModuleTestCommand, nearestWrapper, nodePackageManager, sourceEcosystem, testCommandCoversPath, testSetupRoute } from './code-delivery-tests.mjs';
import { readRepositoryManifest } from './repository-manifest.mjs';
import { exists, secureRepositoryPath, SingularityFlowError } from './util.mjs';
import { androidTestVariant, gradleBuildKind, GRADLE_TEST_TARGET_REASON } from './gradle-manifests.mjs';
import { acceptanceTagsAboveLine, acceptanceTagsInComment } from './verification/tags.mjs';

// [name, the ecosystem it builds, what it is]. Alone in a directory one owns everything below it; beside
// a supported manifest of another ecosystem it owns its ecosystem's files, and a native build owns none
// (the package beside it builds and tests that code). Either way the walk stops there, so an unrelated
// root manifest's tests never count as their coverage. Python's own build files infer pytest; the
// others have no structured test adapter.
const FOREIGN_MARKERS = Object.freeze([
  [/^Podfile$/u, 'swift', 'a CocoaPods'], [/^Gemfile$/u, 'ruby', 'a Ruby'], [/^composer\.json$/u, 'php', 'a PHP Composer'],
  [/^pubspec\.yaml$/u, 'dart', 'a Dart/Flutter'], [/^(?:requirements[\w.-]*\.txt|setup\.py|setup\.cfg|Pipfile|noxfile\.py)$/u, 'python'],
  [/^environment\.yml$/u, 'python', 'a conda Python'], [/\.(?:xcodeproj|xcworkspace)$/u, 'swift', 'an Xcode'],
  [/^(?:CMakeLists\.txt|meson\.build)$/u, 'native', 'a CMake or Meson']
]);
const NODE_TEST_IMPORT = /(?:\bfrom|\bimport\s*\(?|\brequire\s*\()\s*['"]node:test['"]/u;

async function markerHolds(root, directory, name) {
  const at = path.join(root, directory, name);
  if (/\.xcodeproj$/u.test(name)) return exists(path.join(at, 'project.pbxproj'));
  if (/\.xcworkspace$/u.test(name)) return exists(path.join(at, 'contents.xcworkspacedata'));
  // A conda environment declares top-level dependencies; any other environment.yml is not a build.
  if (name === 'environment.yml') {
    const manifest = await readRepositoryManifest(root, path.posix.join(directory, name)).catch(() => null);
    return /^dependencies\s*:/mu.test(manifest?.bytes.toString('utf8') ?? '');
  }
  return exists(at);
}

/**
 * The module another ecosystem's build file in `directory` makes of `relative`, beside the supported
 * `manifests` there: a Python module, a refusal naming a build no structured runner supports, or null
 * when no such build file owns the path. `names` is the directory's listing.
 */
export async function foreignBuildModule(root, directory, relative, names, manifests) {
  const where = directory || '.';
  for (const [pattern, ecosystem, label] of FOREIGN_MARKERS) {
    if ((manifests.length && sourceEcosystem(relative) !== ecosystem) || manifests.some((entry) => entry.system === ecosystem)) continue;
    const name = names.find((entry) => pattern.test(entry));
    if (!name || !await markerHolds(root, directory, name)) continue;
    if (!label) return { root: directory || '.', system: 'python', manifest: name, configured: false };
    const manifest = directory ? `${directory}/${name}` : name;
    // An Xcode test run needs a scheme, a simulator or device and a JUnit report, none of which is guessed.
    if (label === 'an Xcode') {
      throw deviceRefusal(relative, manifest, 'an Xcode project, whose tests need a scheme and a destination', {
        kind: 'test', argv: ['xcodebuild', 'test', name.endsWith('.xcworkspace') ? '-workspace' : '-project', name, '-scheme', '<scheme>',
          '-destination', '<destination>'], workingDirectory: where, affectedRoots: [where], result: { adapter: 'junit-xml', path: '<report>' },
        missing: ['scheme', 'destination', 'result.path']
      });
    }
    throw new SingularityFlowError(
      `Changed path '${relative}' belongs to ${manifest}, ${label} build with no supported structured test runner, `
      + 'so no inferred test command covers it; an unrelated manifest\'s tests never count as its coverage. '
      + 'Configure an approved test command for it (kind: test, argv, workingDirectory, affectedRoots and a result adapter).',
      { code: 'TEST_MODULE_UNCOVERED', details: testSetupRoute({ path: relative, manifest, nativeManifest: name, system: ecosystem }) }
    );
  }
  return null;
}

/**
 * A changed path whose tests need a device, a simulator or a scheme: never guessed at a gate, it is refused
 * with the command test setup proposes, naming the fields a person must supply [TCE:REQ-075].
 */
function deviceRefusal(relative, manifest, what, proposal) {
  return new SingularityFlowError(`Changed path '${relative}' belongs to ${manifest}, ${what}, so no inferred test command covers it. `
    + `capability test-setup proposes ${proposal.argv.join(' ')}; supply its ${proposal.missing.join(', ')} and approve it as a test command.`,
  { code: 'TEST_MODULE_UNCOVERED', details: testSetupRoute({ path: relative, manifest, nativeManifest: path.posix.basename(manifest), proposal }) });
}

/**
 * Refuse the `node --test` fallback for test files that do not import node:test: it would run a mocha,
 * jasmine or tap file with the wrong runner. A planned test not written yet does not decide.
 */
export async function assertNodeTestFiles(root, tests) {
  const others = [];
  for (const candidate of tests) {
    const secured = await secureRepositoryPath(root, candidate, { label: 'Test source', type: 'file' });
    if (secured.exists && !NODE_TEST_IMPORT.test(await readFile(secured.absolute, 'utf8'))) others.push(candidate);
  }
  if (others.length) {
    throw new SingularityFlowError(`Test files ${others.join(', ')} do not import node:test, and node --test would run them `
      + 'with the wrong runner, so no test command was inferred for them. Configure an approved test command for their runner '
      + '(kind: test, argv, workingDirectory, affectedRoots and a result adapter).',
    { code: 'TEST_MODULE_UNCOVERED', details: testSetupRoute({ paths: others }) });
  }
}

/**
 * Every command that tests a module: the one rule the gate, its recovery preview, test setup and the
 * whole-repository inference share. A Node package runs a command for each runner and level it
 * declares; an Nx project its unit target and the Playwright target beside it; a .NET product project the
 * test projects that reference it; any other module its one command.
 */
export async function moduleTestCommands(root, module, { platform = process.platform } = {}) {
  if (module.system === 'node') {
    const cwd = module.root === '.' ? '' : module.root;
    const manifest = JSON.parse(await packageText(root, path.posix.join(cwd, 'package.json')) || '{}');
    const commands = await nodeTestCommands(root, module, { manager: await nodePackageManager(root, module.root, manifest) });
    if (commands.length || !await exists(path.join(root, cwd, 'project.json'))) return commands;
  }
  const commands = [await inferModuleTestCommand(root, module, { platform })].filter(Boolean);
  if (module.system === 'dotnet') return (await dotnetTestCommands(root, module)) ?? commands;
  // An Android module runs its unit tests and, with src/androidTest, its device tests too.
  if (module.system === 'gradle' && commands[0]?.id === `${module.root}-gradle-tests` && commands[0].argv.at(-1).endsWith('UnitTest')) {
    const name = await exists(path.join(root, module.root, 'build.gradle')) ? 'build.gradle' : 'build.gradle.kts';
    const text = await packageText(root, path.posix.join(module.root === '.' ? '' : module.root, name));
    const wrapperRoot = await nearestWrapper(root, module.root, platform === 'win32' ? 'gradlew.bat' : 'gradlew');
    return androidTestCommands(root, module, { text, name, kind: gradleBuildKind(text), wrapperRoot, platform });
  }
  if (['node', 'nx'].includes(module.system) && commands[0]?.result?.adapter !== 'playwright-json') {
    for (const nodeScript of ['test:e2e', 'test:playwright', 'e2e']) {
      const browser = await inferModuleTestCommand(root, module, { platform, nodeScript });
      if (browser?.result?.adapter === 'playwright-json') { commands.push(browser); break; }
    }
  }
  return commands;
}

/*
 * A Node package's test commands [TCE:REQ-071]. A package declares several: unit (Jest, Vitest,
 * mocha, node:test, Create React App, Angular), end-to-end (Playwright, Cypress) and component
 * (Playwright CT, Cypress component). Every script is read through its `npm run` references and its
 * `&&`/`;` steps to the runner it starts and classified by that runner, never by its name. Each
 * runner and level is one command whose reporter arguments reach the runner itself: a runner that
 * ends its script runs through that script with them after `--`, one inside a chain runs directly
 * through the package manager's exec. Scripts that run a runner the same way collapse into one; two
 * that differ in configuration or selection, neither the whole of the other, are refused rather than
 * guessed. Only package.json, angular.json and Playwright configs are read; nothing runs.
 */
const SCRIPT_LIMITS = Object.freeze({ nodes: 256, depth: 32, bytes: 256 * 1024 });
const ENVIRONMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/u;
// Commands that start the next command they name, so a runner inside one is still that runner.
const WRAPPERS = new Set(['cross-env', 'dotenv', 'env-cmd', 'nyc', 'c8', 'npx', 'node', 'tsx', 'pnpm', 'yarn', 'exec']);
const LEVELS = ['unit', 'e2e', 'component'];
const EXEC = Object.freeze({ npm: ['npx', '--no-install'], pnpm: ['pnpm', 'exec'], yarn: ['yarn'] });
// Interactive, watching, listing or report-redirecting runs are never a gate's command.
const NOT_A_GATE = Object.freeze({
  jest: /^--(?:watch|watchAll|json|outputFile|listTests|showConfig)(?:=true)?$/u,
  vitest: /^(?:-w|--(?:watch|ui|reporter|outputFile)(?:=.*)?|watch|dev|bench|init|list|related)$/u,
  mocha: /^(?:-w|--watch)$/u, ng: /^--watch(?:=true)?$/u, playwright: /^--(?:ui|debug|list)$/u, cypress: /^$/u
});
// How a run reports or how fast it goes, never which tests it selects.
const MANNER = /^(?:--(?:coverage|ci|runInBand|silent|verbose|colors|no-colors?|headed|forbid-only|bail|detectOpenHandles|forceExit|cache|no-cache|update-snapshots|updateSnapshot|watch|watchAll|progress|no-progress|browsers?|workers|maxWorkers|retries|timeout|max-failures|reporters?|reporter-options?|quiet|record|parallel|exit|recursive)(?:=.*)?|-[iuRO])$/u;
const VALUED = new Set(['--workers', '--maxWorkers', '--retries', '--timeout', '--max-failures', '--reporter', '--reporters', '--reporter-option', '--reporter-options', '-R', '-O', '-j', '--browser', '--browsers']);
const CONFIG = new Set(['-c', '--config', '-C', '--config-file']);
const PLAYWRIGHT_CONFIG = /^playwright(?:[.-][A-Za-z0-9_-]+)*\.config\.[cm]?[jt]s$/u;
const scriptFailure = (message) => new SingularityFlowError(`Node test script graph exceeds ${message}.`, { code: 'CODE_TEST_RESULT_REQUIRED' });

/** A script's steps between `&&` and `;`, each as its words, or null for shell text this reader does not interpret. */
function scriptSteps(script) {
  const steps = [[]];
  let word = null;
  let quote = null;
  const text = String(script ?? '');
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === quote) quote = null;
      else if (quote === '"' && /[$`\\]/u.test(character)) return null;
      else word += character;
    } else if (character === "'" || character === '"') {
      quote = character;
      word ??= '';
    } else if (character === ' ' || character === '\t' || character === ';' || (character === '&' && text[index + 1] === '&')) {
      if (word !== null) steps.at(-1).push(word);
      word = null;
      if (character === ';' || character === '&') steps.push([]);
      if (character === '&') index += 1;
    } else if (/[|&<>`$\\()\r\n]/u.test(character) || (character === '#' && word === null)) return null;
    else word = (word ?? '') + character;
  }
  if (quote) return null;
  if (word !== null) steps.at(-1).push(word);
  return steps.every((step) => step.length) ? steps : null;
}

/** The package script a step runs (`npm test`, `npm run x`, `yarn x`, `pnpm run x`, `bun run x`), else null. */
function scriptReference(words, scripts) {
  const [tool, verb] = words;
  const at = tool === 'npm' ? (['test', 't'].includes(verb) ? 1 : ['run', 'run-script'].includes(verb) ? 2 : -1)
    : tool === 'bun' ? (verb === 'run' ? 2 : -1) : ['yarn', 'pnpm'].includes(tool) ? (verb === 'run' ? 2 : 1) : -1;
  const name = tool === 'npm' && at === 1 ? 'test' : words[at];
  if (at < 0 || typeof scripts[name] !== 'string' || !Object.hasOwn(scripts, name)) return null;
  // Arguments passed on to the script would change what it runs; such a reference is not followed.
  return words.slice(at + 1).every((word) => ['-s', '--silent', '--if-present'].includes(word)) ? name : null;
}

const commandName = (word) => String(word).split('/').at(-1).replace(/\.(?:[cm]?js|cmd)$/u, '');

/** The runner a step starts, past its environment words and wrappers, with where its command words begin. */
function stepRunner(words) {
  let start = 0;
  while (ENVIRONMENT_WORD.test(words[start] ?? '')) start += 1;
  for (let index = start; index < words.length; index += 1) {
    const name = commandName(words[index]);
    const next = words[index + 1];
    const runner = name === 'node' && words.slice(index + 1).some((word) => /^--test(?:=|$)/u.test(word)) ? 'node-test'
      : ['jest', 'vitest', 'mocha'].includes(name) || name === '_mocha' ? name.replace('_', '')
        : ['react-scripts', 'craco', 'react-app-rewired'].includes(name) && next === 'test' ? 'react-scripts'
          : (name === 'ng' || name === 'playwright') && next === 'test' ? name : name === 'cypress' && next === 'run' ? 'cypress' : null;
    if (runner) {
      const launchers = words.slice(start, index);
      // `npx x` without --no-install downloads a runner the package does not install.
      const bareNpx = launchers.some((word, at) => word === 'npx' && !['--no-install', '--no'].includes(launchers[at + 1]));
      return { runner, start, index, bareNpx };
    }
    // Past a wrapper, flags, flag values and the script `node` runs (whose own arguments may name the runner).
    const word = words[index];
    const previous = words[index - 1] ?? '';
    if (index === start ? !WRAPPERS.has(name) : !(WRAPPERS.has(name) || /^-|=/u.test(word) || previous.startsWith('-') || commandName(previous) === 'node')) return null;
  }
  return null;
}

/**
 * Every runner step `entry` reaches through package-script references, within the reader's bounds, with
 * the scripts on the way there (`chain`, `entry` first) and what runs before the runner on that way
 * (`prior`): each script's `pre` hook and the steps before the one that leads on.
 */
function reachedSteps(scripts, entry, stepsOf) {
  const found = [];
  const visiting = new Set();
  const visited = new Set();
  let nodes = 0;
  let bytes = 0;
  const visit = (name, depth, chain, prior) => {
    if (depth > SCRIPT_LIMITS.depth) throw scriptFailure(`depth ${SCRIPT_LIMITS.depth}`);
    if (visited.has(name) || visiting.has(name) || typeof scripts[name] !== 'string') return;
    nodes += 1;
    bytes += Buffer.byteLength(scripts[name]);
    if (nodes > SCRIPT_LIMITS.nodes || bytes > SCRIPT_LIMITS.bytes) throw scriptFailure(`${SCRIPT_LIMITS.nodes} scripts or ${SCRIPT_LIMITS.bytes} bytes`);
    visiting.add(name);
    const steps = stepsOf(name) ?? [];
    const here = [...chain, name];
    const hooked = typeof scripts[`pre${name}`] === 'string' ? [...prior, { script: name, hook: `pre${name}` }] : prior;
    for (const [index, words] of steps.entries()) {
      const before = [...hooked, ...steps.slice(0, index).map((earlier) => ({ script: name, words: earlier }))];
      const reference = scriptReference(words, scripts);
      if (reference) visit(reference, depth + 1, here, before);
      else {
        const runner = stepRunner(words);
        if (runner) found.push({ script: name, step: index, last: index === steps.length - 1, words, ...runner, chain: here, prior: before });
      }
    }
    visiting.delete(name);
    visited.add(name);
  };
  visit(entry, 0, [], []);
  return found;
}

// Commands that read the source and make nothing a test reads: linters, spell checks, clean-ups, messages.
const CHECKERS = new Set(['eslint', 'tslint', 'standard', 'xo', 'stylelint', 'oxlint', 'markdownlint', 'markdownlint-cli2', 'cspell', 'rimraf', 'echo']);

/** Whether a step makes nothing a test could read: a check, a clean-up, another test run, or a script of only those. */
function makesNothing(words, scripts, stepsOf, seen) {
  const reference = scriptReference(words, scripts);
  if (reference) return scriptMakesNothing(reference, scripts, stepsOf, seen);
  if (stepRunner(words)) return true;
  let at = 0;
  while (ENVIRONMENT_WORD.test(words[at] ?? '') || ['npx', 'bunx', 'pnpm', 'yarn', 'exec', 'dlx', '--no-install', '--no'].includes(words[at])) at += 1;
  const name = commandName(words[at] ?? '');
  const rest = words.slice(at + 1);
  if (CHECKERS.has(name)) return !rest.some((word) => /^--fix(?:=|$)/u.test(word));
  if (name === 'prettier') return rest.some((word) => ['--check', '-c', '--list-different', '-l'].includes(word)) && !rest.some((word) => ['--write', '-w'].includes(word));
  if (name === 'tsc' || name === 'vue-tsc') return rest.some((word) => /^--noEmit(?:=true)?$/u.test(word));
  if (name === 'biome') return ['lint', 'check', 'ci', 'format'].includes(rest[0]) && !rest.some((word) => /^--(?:write|apply|apply-unsafe|fix)$/u.test(word));
  return false;
}

/** Whether a script, with the hooks npm runs around it, makes nothing a test could read. */
function scriptMakesNothing(name, scripts, stepsOf, seen = new Set()) {
  if (seen.has(name)) return true;
  seen.add(name);
  const steps = stepsOf(name);
  return Boolean(steps) && steps.every((words) => makesNothing(words, scripts, stepsOf, seen))
    && [`pre${name}`, `post${name}`].every((hook) => typeof scripts[hook] !== 'string' || scriptMakesNothing(hook, scripts, stepsOf, seen));
}

/**
 * What the script a command stands for runs before its runner that the command would not: a `pre` hook or
 * an earlier step that may make what the tests read (a generated file, a build). A command that runs the
 * runner alone skips all of it; one that runs a script skips what the scripts above that one run. Checks,
 * clean-ups and other test runs are skipped safely. The script judged is the named one when it reaches
 * the runner (`test` by default), else any script that does. Null when nothing is lost.
 */
function skippedSetup(step, invokes, nodeScript, scripts, stepsOf) {
  let lost = null;
  for (const entry of step.entries.has(nodeScript) ? [nodeScript] : [...step.entries]) {
    const { chain, prior } = step.reached.get(entry);
    const from = invokes ? chain.indexOf(invokes) : -1;
    const setup = prior.filter((item) => (from < 0 || chain.indexOf(item.script) < from)
      && !(item.hook ? scriptMakesNothing(item.hook, scripts, stepsOf) : makesNothing(item.words, scripts, stepsOf, new Set())));
    if (!setup.length) return null;
    lost ??= { entry, setup };
  }
  return lost;
}

function setupSkippedError(module, candidate) {
  const { entry, setup } = candidate.skipsSetup;
  const named = setup.map((item) => (item.hook ? `\`${item.hook}\`` : `\`${item.words.join(' ')}\`${item.script === entry ? '' : ` (in ${item.script})`}`));
  const runs = `\`${candidate.step.words.slice(candidate.step.index).join(' ')}\``;
  return new SingularityFlowError(`Package script ${entry} in ${module.root} runs ${named.join(' and ')} before ${runs}. A command that adds `
    + `${candidate.runner}'s report would skip ${named.length > 1 ? 'them' : 'it'}, and the tests may need what ${named.length > 1 ? 'they make' : 'it makes'}, `
    + `so no test command was guessed. Make ${runs} the last step of ${entry} itself (later steps can move to post${entry}): SFlow then runs ${entry} `
    + 'with the report added, setup included. If the tests need none of it, propose a command that runs the runner alone with capability test-setup.',
  { code: 'TEST_MODULE_UNCOVERED', details: testSetupRoute({ directory: module.root, script: entry, setup: named }) });
}

/** What a runner's arguments select (its configuration apart), without how it reports or how fast it runs. */
function runnerArguments(words, from) {
  const selection = [];
  let config = '';
  for (let index = from; index < words.length; index += 1) {
    const [flag, value] = words[index].split(/=(.*)/su);
    if (CONFIG.has(flag)) config = value ?? words[(index += 1)] ?? '';
    else if (MANNER.test(words[index])) index += VALUED.has(words[index]) ? 1 : 0;
    else if (!['--component', '--ct', '--e2e', '--'].includes(words[index])) selection.push(words[index]);
  }
  return { config, selection };
}

async function packageText(root, relative) {
  try { return (await readRepositoryManifest(root, relative)).bytes.toString('utf8'); } catch { return ''; }
}

/** The Angular test builder `ng test` runs for the projects it names: karma, jest, or null for another or a mix. */
async function angularBuilder(root, cwd, dependencies, selection) {
  let workspace = null;
  try { workspace = JSON.parse(await packageText(root, path.posix.join(cwd, 'angular.json'))); } catch { /* none */ }
  if (!workspace?.projects) return Object.hasOwn(dependencies, 'karma') ? 'karma' : null;
  const named = selection.find((word) => !word.startsWith('-'));
  const builders = new Set(Object.entries(workspace.projects).filter(([name]) => !named || name === named)
    .map(([, project]) => (project?.architect ?? project?.targets)?.test?.builder).filter(Boolean)
    .map((builder) => (/:karma$/u.test(builder) ? 'karma' : builder === '@angular-builders/jest:run' ? 'jest' : 'other')));
  return builders.size === 1 && !builders.has('other') ? [...builders][0] : null;
}

/** One runner step as a candidate command: its level, the way it runs and the arguments that make its report. */
async function nodeCandidate(root, cwd, step, { manager, dependencies }) {
  const { runner, words, index } = step;
  const from = index + (['vitest'].includes(runner) && words[index + 1] === 'run' ? 2 : ['vitest', 'jest', 'mocha', 'node-test'].includes(runner) ? 1 : 2);
  if (runner !== 'node-test' && words.slice(index + 1).some((word) => NOT_A_GATE[runner === 'react-scripts' ? 'jest' : runner].test(word)
    || /^--pass-?[Ww]ith-?[Nn]o-?[Tt]ests$/u.test(word))) return null;
  if (['playwright', 'cypress'].includes(runner) && (step.bareNpx || !Object.keys(dependencies).some((name) => name === runner
    || (runner === 'playwright' && (name === '@playwright/test' || name.startsWith('@playwright/experimental-ct-')))))) return null;
  const { config, selection } = runnerArguments(words, from);
  let level = runner === 'cypress' && words.includes('--component') ? 'component' : ['playwright', 'cypress'].includes(runner) ? 'e2e' : 'unit';
  if (runner === 'playwright') {
    const configs = config ? [config] : ['ts', 'js', 'mts', 'mjs', 'cts', 'cjs'].map((extension) => `playwright.config.${extension}`);
    for (const name of configs) if ((await packageText(root, path.posix.join(cwd, name))).includes('@playwright/experimental-ct-')) level = 'component';
  }
  const builder = runner === 'ng' ? await angularBuilder(root, cwd, dependencies, selection) : null;
  if (runner === 'ng' && !builder) return null;
  const junitMocha = Object.hasOwn(dependencies, 'mocha-junit-reporter');
  const ownReporter = runner === 'mocha' && words.some((word) => /^(?:-[RO]|--reporter(?:-options?)?)(?:=|$)/u.test(word));
  // The script the command runs through the package manager; null when the runner runs alone.
  // node:test reports on stdout: the whole script runs, as `npm test` when it reaches the test.
  const invokes = runner === 'node-test' ? (step.entries.has('test') ? 'test' : step.script) : step.last && !ownReporter ? step.script : null;
  return {
    level, runner: builder === 'jest' ? 'ng-jest' : runner, script: step.script, config, selection, step, invokes,
    adapter: runner === 'node-test' ? 'node-tap' : runner === 'playwright' ? 'playwright-json' : runner === 'cypress' || (runner === 'mocha' && junitMocha) ? 'junit-xml'
      : runner === 'mocha' ? 'mocha-json' : runner === 'vitest' ? 'vitest-json' : builder === 'karma' ? 'karma-text' : 'jest-json',
    build(report) {
      const args = runner === 'jest' || runner === 'react-scripts' ? [
        ...(runner === 'react-scripts' && !words.includes('--watchAll=false') ? ['--watchAll=false'] : []), '--json', '--outputFile', report]
        : runner === 'vitest' ? ['--reporter=json', `--outputFile=${report}`]
          : runner === 'mocha' ? (junitMocha ? ['--reporter', 'mocha-junit-reporter', '--reporter-options', `mochaFile=${report}`]
            : ['--reporter', 'json', '--reporter-option', `output=${report}`])
            // Karma has no machine-readable reporter without a repository dependency: its bounded TOTAL line is read.
            : builder === 'karma' ? ['--watch=false', '--browsers=ChromeHeadless', '--no-progress']
              : builder === 'jest' ? ['--json', `--outputFile=${report}`]
                : runner === 'playwright' ? ['--reporter=json'] : ['--reporter', 'junit', '--reporter-options', `mochaFile=${report}/[hash].xml`];
      const invoke = (name) => (manager === 'npm' ? (name === 'test' ? ['npm', 'test'] : ['npm', 'run', name])
        : manager === 'yarn' ? ['yarn', name] : manager === 'pnpm' ? ['pnpm', name] : ['bun', 'run', name]);
      if (runner === 'node-test') return invoke(invokes);
      // npm and bun hand the script what follows `--`. pnpm (7 and later) and yarn hand it every word after
      // the script's name, `--` included, and a runner reads what follows its own `--` as test filters.
      if (invokes) return [...invoke(invokes), ...(['pnpm', 'yarn'].includes(manager) ? [] : ['--']), ...args];
      // Inside a chain, the step runs alone through the package manager's exec (never with an
      // environment prefix the shell would have applied).
      if (step.start || !EXEC[manager]) return null;
      let command = words.slice(0, index + from);
      while (['npx', 'pnpm', 'yarn', 'exec', '--no-install', '--no'].includes(command[0]) && command.length > 1) command = command.slice(1);
      const rest = words.slice(index + from).filter((word, at, all) => !(ownReporter
        && (/^(?:-[RO]|--reporter(?:-options?)?)(?:=|$)/u.test(word) || /^(?:-[RO]|--reporter(?:-options?)?)$/u.test(all[at - 1] ?? ''))));
      return [...(commandName(command[0]) === 'node' ? [] : EXEC[manager]), ...command, ...rest, ...args];
    }
  };
}

/** The test commands a Node package declares, one per runner and level (see above); `unitOnly` keeps unit runs that start nothing else. */
export async function nodeTestCommands(root, module, { manager, unitOnly = false, nodeScript = 'test' } = {}) {
  const cwd = module.root === '.' ? '' : module.root;
  const manifest = JSON.parse(await packageText(root, path.posix.join(cwd, 'package.json')) || '{}');
  const scripts = manifest.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : {};
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies };
  const parsed = new Map();
  const steps = (name) => (parsed.has(name) ? parsed.get(name) : parsed.set(name, scriptSteps(scripts[name])).get(name));
  const order = Object.keys(scripts);
  const byStep = new Map();
  for (const entry of order) {
    for (const step of reachedSteps(scripts, entry, steps)) {
      const key = `${step.script}\u0000${step.step}`;
      if (!byStep.has(key)) byStep.set(key, { ...step, entries: new Set(), reached: new Map() });
      byStep.get(key).entries.add(entry);
      byStep.get(key).reached.set(entry, step);
    }
  }
  const candidates = [];
  // npm runs pre<name> and post<name> with <name>: a hook's runner is part of that script's run (and of its
  // pin), never a command of its own.
  const hook = (name) => { const of = /^(?:pre|post)(.+)$/u.exec(name ?? '')?.[1]; return Boolean(of) && Object.hasOwn(scripts, of); };
  for (const step of byStep.values()) {
    if (hook(step.script)) continue;
    const candidate = await nodeCandidate(root, cwd, step, { manager, dependencies });
    if (!candidate?.build('_')) continue;
    // A command that would skip setup its script runs first (a pretest that generates a file the tests
    // load) passes under `npm test` and fails under the gate (office review, 2026-10-29).
    candidate.skipsSetup = skippedSetup(step, candidate.invokes, nodeScript, scripts, steps);
    candidates.push(candidate);
  }
  // A Playwright config no script runs is run directly, by its name when that is not the default.
  if (EXEC[manager] && Object.keys(dependencies).some((name) => name === 'playwright' || name.startsWith('@playwright/'))) {
    let names = [];
    try { names = (await readdir(path.join(root, cwd || '.'))).filter((name) => PLAYWRIGHT_CONFIG.test(name)).sort(); } catch { /* none */ }
    for (const name of names) {
      const level = (await packageText(root, path.posix.join(cwd, name))).includes('@playwright/experimental-ct-') ? 'component' : 'e2e';
      if (candidates.some((candidate) => candidate.runner === 'playwright' && candidate.level === level)) continue;
      const explicit = /^playwright\.config\.[cm]?[jt]s$/u.test(name) ? [] : [`--config=${name}`];
      candidates.push({ level, runner: 'playwright', script: null, config: name, selection: [], adapter: 'playwright-json', scriptless: true,
        step: { entries: new Set(), script: name }, build: () => [...EXEC[manager], 'playwright', 'test', ...explicit, '--reporter=json'] });
    }
  }
  // Readiness's unit-only run starts one unit runner and nothing else: never a browser suite, a build or
  // another stage of a chain, and never under a script whose other steps would run too.
  const browserWords = /(?:^|[^a-z])(?:playwright|cypress|e2e|acceptance|integration)(?:[^a-z]|$)/iu;
  const unitSafe = (candidate) => candidate.level === 'unit' && !browserWords.test(candidate.step.words.join(' '))
    && (steps(candidate.runner === 'node-test' && candidate.step.entries.has('test') ? 'test' : candidate.step.script)?.length === 1
      || (!candidate.step.last && candidate.runner !== 'node-test'));
  if (unitOnly) candidates.splice(0, candidates.length, ...candidates.filter(unitSafe));
  // A named script is judged by the runners it reaches. Other scripts' configurations made it ambiguous,
  // so even the inspection that suggests each one refused with the same error (office, 2026-10-29).
  if (nodeScript !== 'test') candidates.splice(0, candidates.length, ...candidates.filter((candidate) => candidate.step.entries.has(nodeScript)));
  // `test` stands for the package; among other scripts, one that skips no setup is chosen over one that would.
  const rank = (candidate) => [candidate.step.entries.has('test') ? 0 : 1, candidate.skipsSetup ? 1 : 0,
    candidate.scriptless ? order.length : order.indexOf(candidate.step.script)];
  const before = (left, right) => { const [a, b] = [rank(left), rank(right)]; return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; };
  const groups = new Map();
  for (const candidate of candidates.sort(before)) {
    const key = `${candidate.level}\u0000${candidate.runner}`;
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  const chosen = [];
  for (const group of groups.values()) {
    const identity = (candidate) => JSON.stringify([candidate.config.replace(/^\.\//u, ''), candidate.selection]);
    const distinct = [...group.reduce((kept, candidate) => (kept.has(identity(candidate)) ? kept : kept.set(identity(candidate), candidate)), new Map()).values()];
    const whole = distinct.filter((candidate) => !candidate.selection.length);
    // One run of the whole suite stands for the narrower runs of the same configuration beside it.
    if (distinct.length > 1 && !(whole.length === 1 && distinct.every((candidate) => candidate.config === whole[0].config))) {
      const names = distinct.map((candidate) => candidate.script ?? candidate.config);
      throw new SingularityFlowError(`Package scripts ${names.join(' and ')} in ${module.root} run ${group[0].runner} ${group[0].level} tests with `
        + 'different configurations or selections, and neither runs the whole of the other, so no single test command was guessed. '
        + 'A step may run several: capability test-setup suggests one per script; propose each the gate should run, each covering the folders it tests '
        + '(or give each in full: kind: test, argv, workingDirectory, affectedRoots and a result adapter).',
      { code: 'TEST_MODULE_AMBIGUOUS', details: testSetupRoute({ directory: module.root, scripts: names }) });
    }
    const pick = distinct.length > 1 ? whole[0] : distinct[0];
    if (pick.skipsSetup) throw setupSkippedError(module, pick);
    chosen.push(pick);
  }
  chosen.sort((left, right) => LEVELS.indexOf(left.level) - LEVELS.indexOf(right.level) || before(left, right));
  const commands = [];
  for (const candidate of chosen) {
    const unit = candidate.level === 'unit';
    const primary = unit && !commands.length;
    if (nodeScript !== 'test' && !candidate.step.entries.has(nodeScript)) continue;
    const name = unit ? (primary ? (candidate.runner.startsWith('ng') ? 'angular' : 'node') : candidate.runner)
      : candidate.runner + (candidate.level === 'component' ? (candidate.runner === 'cypress' ? '-component' : '-ct') : '');
    // A named script's command reports under its own name: two scripts run in one step otherwise wrote one file.
    const base = `.sflow/results/${primary ? (nodeScript !== 'test' ? nodeScript.replace(/[^A-Za-z0-9._-]/gu, '-') : 'node') : name}-tests`;
    const report = candidate.adapter === 'node-tap' ? `${base}.tap` : candidate.adapter === 'karma-text' ? `${base}.karma.txt`
      : candidate.runner === 'cypress' ? base : candidate.adapter === 'junit-xml' ? `${base}.xml` : `${base}.json`;
    commands.push({
      id: unit && name === 'node' ? `${module.root}-node-tests` : module.root === '.' ? `${name}-tests` : `${module.root}-${name}-tests`,
      kind: 'test', argv: candidate.build(report), workingDirectory: module.root, affectedRoots: [module.root], modelPolicy: 'never',
      result: { adapter: candidate.adapter, path: report, minimumDiscovered: 1 }
    });
  }
  // A composite script whose node:test run sits behind shell text this reader does not interpret still
  // runs as the whole `npm test`, as before (its exit status covers every later stage).
  if (!commands.some((command) => command.result.adapter === 'node-tap') && !commands.some((command) => command.id.endsWith('-node-tests'))
      && nodeScript === 'test' && legacyNodeTestReachable(scripts)
      && (!unitOnly || (!/[;&|]/u.test(scripts.test) && !browserWords.test(scripts.test) && /\bnode\b.*\s--test(?:\s|=|$)/iu.test(scripts.test)))) {
    commands.unshift({ id: `${module.root}-node-tests`, kind: 'test', argv: manager === 'npm' ? ['npm', 'test'] : manager === 'bun' ? ['bun', 'run', 'test'] : [manager, 'test'],
      workingDirectory: module.root, affectedRoots: [module.root], modelPolicy: 'never',
      result: { adapter: 'node-tap', path: '.sflow/results/node-tests.tap', minimumDiscovered: 1 } });
  }
  return commands;
}

/** Whether `npm test` reaches a `node --test` run through explicit package-manager references in any shell text. */
function legacyNodeTestReachable(scripts) {
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name) || typeof scripts[name] !== 'string') return false;
    seen.add(name);
    const script = scripts[name];
    return /\bnode\b[^\n]*(?:^|\s)--test(?:\s|=|$)/iu.test(script) || [...script.matchAll(
      /(?:^|&&|\|\||;)\s*(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([A-Za-z0-9:_-]+)(?=\s|$|&&|\|\||;)/gu)].some((match) => visit(match[1]));
  };
  return visit('test');
}

const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const parenDepth = (text) => [...text].reduce((depth, character) => depth + (character === '(' ? 1 : character === ')' ? -1 : 0), 0);

/**
 * The pytest tests a file declares [TCE:REQ-074]: `test*` functions at module level and `test*` methods of
 * `Test*` classes, each tied to the `@ac` tags in the comment lines directly above it or its decorators.
 * pytest names a test's class from the directory it runs in, so the identity keeps the file's whole
 * dotted module path and a report's class matches it as a dotted suffix.
 */
export function pytestDeclarations(text, { sourcePath }) {
  const lines = String(text).split('\n').map((line) => line.replace(/\r$/u, ''));
  const modulePath = sourcePath.replace(/\.py$/u, '').replaceAll('/', '.');
  const declarations = [];
  const attached = new Set();
  const blocks = [];
  let decorators = null;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (decorators?.depth > 0) {
      decorators.text += trimmed;
      decorators.depth += parenDepth(trimmed);
      continue;
    }
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = lines[index].length - lines[index].trimStart().length;
    while (blocks.length && blocks.at(-1).indent >= indent) blocks.pop();
    if (trimmed.startsWith('@')) {
      decorators ??= { start: index, text: '', depth: 0 };
      decorators.text += trimmed;
      decorators.depth = parenDepth(trimmed);
      continue;
    }
    const decorated = decorators;
    decorators = null;
    const [, kind, name] = /^(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/u.exec(trimmed) ?? [];
    if (!kind) continue;
    const test = kind === 'def' && name.startsWith('test') && blocks.every((block) => block.kind === 'class' && block.name.startsWith('Test'));
    const className = [modulePath, ...blocks.map((block) => block.name)].join('.');
    blocks.push({ indent, kind, name });
    if (!test) continue;
    const start = decorated?.start ?? index;
    for (let above = start - 1; above >= 0 && lines[above].trim().startsWith('#'); above -= 1) attached.add(above);
    let end = index + 1;
    while (end < lines.length && (!lines[end].trim() || lines[end].length - lines[end].trimStart().length > indent)) end += 1;
    const marks = decorated?.text ?? '';
    const identity = { schema: 'pytest-test-v1', framework: 'pytest', sourcePath, className, methodName: name };
    declarations.push({ ...identity, logicalTestId: digest(JSON.stringify(identity)), line: index + 1,
      declarationSha256: digest(lines.slice(start, end).join('\n')), skipped: /\bmark\.skip\b/u.test(marks),
      parameters: /\bmark\.parametrize\b/u.test(marks) ? { kind: 'dynamic', count: null } : null,
      clauseIds: acceptanceTagsAboveLine(lines, start).clauseIds,
      gaps: /\bmark\.xfail\b/u.test(marks) ? [{ code: 'INVERTED_TEST', message: 'the test is expected to fail, so a pass would mean its body failed' }] : [] });
  }
  for (const declaration of declarations) {
    if (declarations.filter((other) => other.logicalTestId === declaration.logicalTestId).length > 1) {
      declaration.gaps.push({ code: 'DUPLICATE_DECLARATION', message: 'another test in this file has the same class and name' });
    }
  }
  const unattachedTags = lines.flatMap((line, index) => {
    const clauseIds = !attached.has(index) && line.trim().startsWith('#') ? acceptanceTagsInComment(line) : [];
    return clauseIds.length ? [{ line: index + 1, clauseIds, code: 'AC_TAG_NOT_ATTACHED', message: 'the tag is not directly above a test declaration' }] : [];
  });
  return { declarations, unattachedTags, fileGaps: [] };
}

const PROJECT_FILE = /\.(?:cs|fs|vb)proj$/iu;
const UNSCANNED = new Set(['node_modules', 'bin', 'obj', 'packages', 'TestResults', 'target', 'build', 'dist', 'out']);

/** The repository's .NET project files, bounded. */
async function projectFiles(root) {
  const found = [];
  let budget = 5_000;
  const walk = async (relative, depth) => {
    let entries = [];
    try { entries = await readdir(path.join(root, relative || '.'), { withFileTypes: true }); } catch { /* unreadable */ }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (--budget < 0) return;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isFile() && PROJECT_FILE.test(entry.name)) found.push(child);
      else if (entry.isDirectory() && depth < 8 && !entry.name.startsWith('.') && !UNSCANNED.has(entry.name)) await walk(child, depth + 1);
    }
  };
  await walk('', 0);
  return found;
}

/**
 * A .NET project's test commands [TCE:REQ-072]: a test project (`*.Tests.csproj`, `*.Test.csproj`, or one
 * using a test SDK) runs itself and covers the projects it references; a product project is tested by the
 * test projects that reference it (`src/App` beside `tests/App.Tests`), and refused when none does. Null
 * for a solution, which runs as one command.
 */
export async function dotnetTestCommands(root, module) {
  if (!PROJECT_FILE.test(module.manifest ?? '')) return null;
  const own = path.posix.join(module.root === '.' ? '' : module.root, module.manifest);
  const texts = new Map();
  const text = async (file) => (texts.has(file) ? texts.get(file) : texts.set(file, await packageText(root, file)).get(file));
  const testProject = async (file) => /\.Tests?\.(?:cs|fs|vb)proj$/iu.test(file)
    || /Microsoft\.NET\.Test\.Sdk|<IsTestProject>\s*true\s*<|Sdk\s*=\s*"MSTest\.Sdk/iu.test(await text(file));
  const references = async (file) => [...(await text(file)).matchAll(/<ProjectReference\s+Include\s*=\s*"([^"$]+)"/giu)]
    .map((match) => path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1].replaceAll('\\', '/'))));
  const command = async (file) => {
    const directory = path.posix.dirname(file);
    const roots = [directory, ...(await references(file)).map((reference) => path.posix.dirname(reference))].filter((entry) => !entry.startsWith('..'));
    return { id: `${directory}-dotnet-tests`, kind: 'test',
      argv: ['dotnet', 'test', path.posix.basename(file), '--logger', 'trx', '--results-directory', 'TestResults'], workingDirectory: directory,
      affectedRoots: [...new Set(roots)], modelPolicy: 'never', result: { adapter: 'dotnet-trx', path: 'TestResults', minimumDiscovered: 1 } };
  };
  if (await testProject(own)) return [await command(own)];
  const testers = [];
  for (const file of await projectFiles(root)) {
    if (file !== own && await testProject(file) && (await references(file)).includes(own)) testers.push(await command(file));
  }
  if (testers.length) return testers;
  throw new SingularityFlowError(`${own} is not a test project and no test project references it, so no inferred test command covers `
    + 'its changes. Add a test project that references it, or configure an approved test command for it '
    + '(kind: test, argv, workingDirectory, affectedRoots and a result adapter).',
  { code: 'TEST_MODULE_UNCOVERED', details: testSetupRoute({ manifest: own, system: 'dotnet' }) });
}

const failsafeBlocks = (text) => [...text.matchAll(/<plugin>[\s\S]*?<\/plugin>/gu)].map((match) => match[0])
  .filter((block) => /<artifactId>\s*maven-failsafe-plugin\s*<\/artifactId>/u.test(block));
const bindsIntegrationTest = (block) => [...block.matchAll(/<execution>([\s\S]*?)<\/execution>/gu)]
  .some(([, execution]) => /<goal>\s*integration-test\s*<\/goal>/u.test(execution) && !/<phase>\s*none\s*<\/phase>/u.test(execution));

/**
 * Whether a Maven module's build runs the failsafe plugin's integration tests [TCE:REQ-073]: its POM or a
 * parent's declares the plugin (outside pluginManagement), and an execution binds the `integration-test`
 * goal there or in a pluginManagement entry. The plugin binds no goal by itself, so a bare declaration
 * runs nothing (office review, 2026-10-29). A parent outside the repository (spring-boot-starter-parent)
 * may bind it, so one counts as binding; a run that wrote no failsafe-reports reads surefire's
 * (code-delivery-tests.mjs).
 */
export async function mavenRunsIntegrationTests(root, moduleRoot) {
  let file = path.posix.join(moduleRoot === '.' ? '' : moduleRoot, 'pom.xml');
  let declared = false;
  let bound = false;
  for (const seen = new Set(); !seen.has(file) && seen.size < 32;) {
    seen.add(file);
    const pom = (await packageText(root, file)).replace(/<!--[\s\S]*?-->/gu, '');
    const managed = [...pom.matchAll(/<pluginManagement>([\s\S]*?)<\/pluginManagement>/gu)].map((match) => match[1]).join('\n');
    const active = pom.replace(/<pluginManagement>[\s\S]*?<\/pluginManagement>/gu, '');
    declared ||= failsafeBlocks(active).length > 0;
    bound ||= [...failsafeBlocks(active), ...failsafeBlocks(managed)].some(bindsIntegrationTest);
    const parent = /<parent>([\s\S]*?)<\/parent>/u.exec(active)?.[1];
    if (!parent) break;
    // Maven looks for a parent at <relativePath> (../pom.xml by default; empty means the repository only).
    const relative = /<relativePath\s*\/>/u.test(parent) ? '' : /<relativePath>\s*([^<]*?)\s*<\/relativePath>/u.exec(parent)?.[1] ?? '../pom.xml';
    const target = relative && path.posix.normalize(path.posix.join(path.posix.dirname(file), relative.replaceAll('\\', '/')));
    const next = target && (target.endsWith('.xml') ? target : path.posix.join(target, 'pom.xml'));
    if (!next || next.startsWith('..') || !await packageText(root, next)) {
      bound = true;
      break;
    }
    file = next;
  }
  return declared && bound;
}

/**
 * The project tool a Python module's tests run under [TCE:REQ-074]: `uv run` when a uv.lock sits at the
 * module or the workspace above it, `poetry run` when the module has a poetry.lock and no .venv of its
 * own; null for the interpreter inference picks. tox and nox environments run only when a person
 * configured them, so inference runs pytest directly.
 */
export async function pythonProjectLauncher(root, moduleRoot) {
  const cwd = moduleRoot === '.' ? '' : moduleRoot;
  for (let current = cwd; ; current = path.posix.dirname(current) === '.' ? '' : path.posix.dirname(current)) {
    if (await exists(path.join(root, current, 'uv.lock'))) return ['uv', 'run', '--locked', 'python'];
    if (!current) break;
  }
  return await exists(path.join(root, cwd, 'poetry.lock')) && !await exists(path.join(root, cwd, '.venv')) ? ['poetry', 'run', 'python'] : null;
}

const tally = (outcomes) => ({ discovered: outcomes.length, passed: outcomes.filter((status) => status === 'passed').length,
  failed: outcomes.filter((status) => status === 'failed').length, skipped: outcomes.filter((status) => status === 'skipped').length });
const observed = (name, suitePath, framework, outcome, extra) => ({ suite: null, className: null, name, fullName: [...suitePath, name].join(' '),
  ancestorTitles: suitePath, framework, outcome, ...extra, verdict: 'inconclusive', logicalTestId: null, declarationSha256: null, exact: false,
  identityStatus: 'observed-name-only' });

/**
 * A Playwright JSON report's tests, each project's run of a spec one occurrence (its describe path, file,
 * line, project and retries) [TCE:REQ-071]. A test that passed only on a retry stays flaky.
 */
function playwrightObservation(parsed) {
  const occurrences = [];
  const visitSuite = (suite, suitePath, depth = 0) => {
    if (depth > 128) throw new SingularityFlowError('Playwright result suite depth exceeds 128.', { code: 'CODE_TEST_RESULT_REQUIRED' });
    for (const spec of suite?.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const outcome = test.status;
        const execution = test.results?.at(-1)?.status ?? null;
        const state = outcome === 'skipped' || execution === 'skipped' ? 'skipped'
          : outcome === 'unexpected' || ['failed', 'timedOut', 'interrupted'].includes(execution) ? 'failed'
            : outcome === 'flaky' || outcome === 'expected' || execution === 'passed' ? 'passed' : null;
        if (!state) throw new SingularityFlowError(`Playwright result contains unknown outcome '${outcome ?? execution ?? 'absent'}'.`, { code: 'CODE_TEST_RESULT_REQUIRED' });
        const duration = (test.results ?? []).reduce((total, result) => total + (Number(result?.duration) || 0), 0);
        occurrences.push(observed(String(spec.title ?? ''), suitePath, 'playwright', state, {
          ...(state === 'passed' && outcome === 'flaky' ? { flaky: true } : {}), file: spec.file ?? null, line: Number.isInteger(spec.line) ? spec.line : null,
          project: test.projectName || null, retries: Math.max(0, (test.results ?? []).length - 1), durationMs: Math.round(duration) }));
      }
    }
    // The outermost suites are files; the describe path starts below them.
    for (const child of suite?.suites ?? []) visitSuite(child, depth ? [...suitePath, String(child.title ?? '')] : [String(child.title ?? '')], depth + 1);
  };
  for (const suite of parsed.suites ?? []) visitSuite(suite, [], 0);
  const tests = tally(occurrences.map((occurrence) => occurrence.outcome));
  const stats = parsed.stats;
  if (stats && ['expected', 'unexpected', 'flaky', 'skipped'].every((key) => Number.isInteger(stats[key]))
      && (stats.expected + stats.unexpected + stats.flaky + stats.skipped !== tests.discovered || stats.expected + stats.flaky !== tests.passed
        || stats.unexpected !== tests.failed || stats.skipped !== tests.skipped)) {
    throw new SingularityFlowError('Playwright reporter statistics differ from recursively traversed test outcomes.', { code: 'CODE_TEST_RESULT_REQUIRED' });
  }
  return { tests, occurrences };
}

/**
 * libtest's JSON lines on stdout, from `cargo test -- -Z unstable-options --format json` or `cargo nextest run
 * --message-format libtest-json`: each test's result, checked against every suite's totals [TCE:REQ-075].
 */
function cargoObservation(text) {
  const occurrences = [];
  const declared = { passed: 0, failed: 0, skipped: 0, suites: 0 };
  for (const line of text.split(/\r?\n/u).filter((entry) => entry.startsWith('{'))) {
    let event;
    try { event = JSON.parse(line); } catch { throw new SingularityFlowError('cargo JSON result has a malformed line.', { code: 'CODE_TEST_RESULT_REQUIRED' }); }
    if (event.type === 'suite' && ['ok', 'failed'].includes(event.event)) {
      declared.suites += 1;
      declared.passed += Number(event.passed) || 0; declared.failed += Number(event.failed) || 0; declared.skipped += Number(event.ignored) || 0;
    } else if (event.type === 'test' && ['ok', 'failed', 'ignored'].includes(event.event)) {
      occurrences.push(observed(String(event.name), [], 'cargo', event.event === 'ok' ? 'passed' : event.event === 'failed' ? 'failed' : 'skipped',
        { durationMs: Number.isFinite(event.exec_time) ? Math.round(event.exec_time * 1000) : null }));
    }
  }
  const tests = tally(occurrences.map((occurrence) => occurrence.outcome));
  if (!declared.suites || ['passed', 'failed', 'skipped'].some((key) => declared[key] !== tests[key])) {
    throw new SingularityFlowError('cargo JSON result has no finished suite, or its suite totals differ from its tests.', { code: 'CODE_TEST_RESULT_REQUIRED' });
  }
  return { tests, occurrences };
}

/** A mocha JSON report (`--reporter json`): each passing, failing and pending test, a failed hook among the failures. */
function mochaObservation(parsed) {
  const occurrences = [];
  for (const [list, outcome] of [['passes', 'passed'], ['failures', 'failed'], ['pending', 'skipped']]) {
    if (!Array.isArray(parsed?.[list])) throw new SingularityFlowError(`mocha JSON result has no ${list} list.`, { code: 'CODE_TEST_RESULT_REQUIRED' });
    for (const test of parsed[list]) {
      const name = String(test?.title ?? '');
      const full = String(test?.fullTitle ?? name);
      occurrences.push(observed(name, full.endsWith(name) && full !== name ? [full.slice(0, -name.length).trim()] : [], 'mocha', outcome,
        { file: typeof test?.file === 'string' ? test.file : null, durationMs: Number.isFinite(test?.duration) ? Math.round(test.duration) : null }));
    }
  }
  return { tests: tally(occurrences.map((occurrence) => occurrence.outcome)), occurrences };
}

/**
 * A Playwright, mocha or cargo report's counts and per-test occurrences, read by code-delivery-tests.mjs;
 * null for an older cargo-json summary file, which it reads itself.
 */
export function jsonTestReport(adapter, text) {
  const lines = adapter === 'cargo-json';
  if (lines && !/^\{\s*"type"\s*:\s*"suite"/mu.test(text)) return null;
  const { tests, occurrences } = (lines ? cargoObservation : adapter === 'mocha-json' ? mochaObservation : playwrightObservation)(lines ? text : JSON.parse(text));
  return { tests, testcaseObservation: { occurrences, parser: { id: 'sflow-json-observer', version: 1, framework: adapter.split('-')[0] } } };
}

/**
 * The command that runs a test file, among those covering it [TCE:REQ-071]: where a package's unit,
 * end-to-end and component commands all cover its root, the file's imports (or Cypress's file names)
 * say which runner runs it; otherwise the most specific root, then configuration order.
 */
export async function commandForTestFile(root, commands, file) {
  const depth = (command) => Math.max(...(command.affectedRoots ?? ['.']).map((entry) => (entry === '.' ? 0 : entry.split('/').length)));
  const covering = commands.filter((command) => testCommandCoversPath(command, file)).sort((left, right) => depth(right) - depth(left));
  if (covering.length < 2) return covering[0] ?? null;
  const text = await packageText(root, file);
  const browser = /(?:^|-)(?:playwright(?:-ct)?|cypress(?:-component)?)-tests$/u;
  const runner = /@playwright\/experimental-ct-/u.test(text) ? /(?:^|-)playwright-ct-tests$/u : /['"]@playwright\/test['"]/u.test(text) ? /(?:^|-)playwright-tests$/u
    : /(?:^|\/)cypress\/|\.cy\.[cm]?[jt]sx?$/u.test(file) ? (/component/u.test(file) ? /cypress-component-tests$/u : /(?:^|-)cypress-tests$/u) : null;
  return covering.find((command) => (runner ? runner.test(command.id) : !browser.test(command.id))) ?? covering[0];
}

/** The names a Gradle DSL block declares at its own level (`free { }`, `create("pixel6") { }`, `pixel6(ManagedVirtualDevice) { }`). */
function blockNames(text, block) {
  const start = text.search(new RegExp(`\\b${block}\\s*\\{`, 'u'));
  if (start < 0) return [];
  let body = text.slice(text.indexOf('{', start) + 1);
  // Collapse nested blocks, then cut the body at its own closing brace.
  while (/\{[^{}]*\}/u.test(body)) body = body.replace(/\{[^{}]*\}/gu, '<>');
  body = body.slice(0, body.indexOf('}') < 0 ? body.length : body.indexOf('}'));
  return [...body.matchAll(/(?:(?:create|register|maybeCreate)\s*\(\s*["']([A-Za-z]\w*)["']\s*\)|\b([A-Za-z]\w*)\s*(?:\([^)]*\))?)\s*<>/gu)]
    .map((match) => match[1] ?? match[2]);
}

/**
 * An Android module's test commands [TCE:REQ-075]: its variant's local unit tests (JVM, Robolectric
 * included), `:<module>:test<Variant>UnitTest`, and, when it has src/androidTest, its device tests,
 * `:<module>:connected<Variant>AndroidTest`, which run only while a device or emulator is attached.
 * Product flavors (several variants), Gradle Managed Devices and Kotlin multiplatform targets are
 * proposed with the field a person picks, never guessed.
 */
export async function androidTestCommands(root, module, { text, name, kind, wrapperRoot, platform }) {
  const below = wrapperRoot === null ? '' : path.posix.relative(wrapperRoot === '.' ? '' : wrapperRoot, module.root === '.' ? '' : module.root);
  const task = (goal) => (below ? `:${below.replaceAll('/', ':')}:${goal}` : goal);
  const argv = (goal) => [wrapperRoot === null ? 'gradle' : platform === 'win32' ? '.\\gradlew.bat' : './gradlew', task(goal)];
  const workingDirectory = wrapperRoot ?? module.root;
  const report = (directory) => path.posix.join(below, 'build', directory);
  const command = (id, goal, directory) => ({ id: `${module.root}-${id}`, kind: 'test', argv: argv(goal), workingDirectory,
    affectedRoots: [module.root], modelPolicy: 'never', result: { adapter: 'junit-xml', path: report(directory), minimumDiscovered: 1 } });
  const variant = kind.android ? androidTestVariant(text) : null;
  if (!variant) {
    const variants = kind.android ? blockNames(text, 'productFlavors').map((flavor) => `${flavor}Debug`) : ['jvm', 'all'];
    const proposal = { ...command('gradle-tests', kind.android ? `test${variants[0]?.replace(/^./u, (first) => first.toUpperCase()) ?? '<Variant>'}UnitTest` : 'jvmTest',
      'test-results'), missing: [kind.android ? 'variant' : 'target'], ...(variants.length ? { choices: variants } : {}) };
    throw new SingularityFlowError(`${GRADLE_TEST_TARGET_REASON} ${module.root}/${name} declares ${kind.android ? 'the variants' : 'the targets'} `
      + `${variants.join(', ') || '(none read)'}; capability test-setup proposes ${proposal.argv.join(' ')} for a person to confirm.`,
    { code: 'GRADLE_TEST_TARGET_REQUIRED', details: testSetupRoute({ root: module.root, manifest: name, proposal }) });
  }
  const commands = [command('gradle-tests', `test${variant}UnitTest`, `test-results/test${variant}UnitTest`)];
  if (await exists(path.join(root, module.root, 'src', 'androidTest'))) {
    const devices = /\bmanagedDevices\s*\{/u.test(text) ? [...new Set([...blockNames(text, 'localDevices'), ...blockNames(text, 'devices')])] : [];
    if (/\bmanagedDevices\s*\{/u.test(text)) {
      // A managed device boots its own emulator; which one the team gates on is theirs to choose.
      const proposal = { ...command('android-device-tests', `${devices[0] ?? '<device>'}${variant}AndroidTest`, 'outputs/androidTest-results/managedDevice'),
        missing: ['device'], ...(devices.length ? { choices: devices } : {}) };
      throw new SingularityFlowError(`${module.root}/${name} declares Gradle Managed Devices (${devices.join(', ') || 'none read'}) for its src/androidTest `
        + `tests; capability test-setup proposes ${proposal.argv.join(' ')} for a person to confirm, instead of guessing the device.`,
      { code: 'TEST_MODULE_UNCOVERED', details: testSetupRoute({ path: `${module.root}/src/androidTest`, manifest: `${module.root}/${name}`, nativeManifest: name, proposal }) });
    }
    commands.push(command('android-connected-tests', `connected${variant}AndroidTest`, 'outputs/androidTest-results/connected'));
  }
  return commands;
}

/**
 * Null when `adb devices` lists a device or emulator in state `device`, else the error that blocks a
 * connected Android run before it starts [TCE:REQ-075]. adb is the SDK's (ANDROID_HOME or
 * ANDROID_SDK_ROOT platform-tools), else the one on PATH; SFlow never starts an emulator.
 */
export async function androidDeviceUnavailable(env = process.env) {
  const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
  const bundled = sdk ? path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb') : null;
  const { runQualityCommand } = await import('./quality-command-runner.mjs');
  const listed = await runQualityCommand(bundled && await exists(bundled) ? bundled : 'adb', ['devices'], { env, timeoutMs: 10_000 });
  if (!listed.error && !listed.timedOut && listed.status === 0 && /^\S+\s+device\s*$/mu.test(String(listed.stdout).split(/\r?\n/u).slice(1).join('\n'))) return null;
  return Object.assign(new Error('ANDROID_DEVICE_UNAVAILABLE: no Android device or emulator is attached'
    + (listed.error ? ` (adb could not run: ${listed.error.code ?? listed.error.message})` : ' (adb devices lists none in state device)')
    + ', so the connected test run was not started. Start one with `emulator -avd <name>` or Android Studio\'s Device Manager and run again; '
    + 'SFlow never starts an emulator itself.'), { code: 'ANDROID_DEVICE_UNAVAILABLE' });
}
