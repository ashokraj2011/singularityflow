/**
 * Only a Story's new and changed tests [TCE:REQ-093].
 *
 * `changed-and-affected` runs every test of each module the Story touches. `new-and-changed` runs
 * the test files the Story's delivery names (added, changed, or planned for its criteria) and
 * nothing else of them, by giving each guessed command those files in the way its runner takes them.
 * The command stays as it is, whole, wherever narrowing it could lose the new tests or say what is
 * not so, and the attempt records why:
 *
 * - a command the workflow or a person named runs as written: narrowing a Story's reviewed check is
 *   not a Story setting;
 * - a module with no new or changed test has nothing else to prove it with;
 * - a module with several runners, since a test file's path does not say which one runs it;
 * - a runner, or a script around it, that cannot be told to run single files.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { phaseRequiresCodeDelivery } from '../code-delivery-policy.mjs';
import { isAllowedTestAutomationPath, testCommandCoversPath } from '../code-delivery-tests.mjs';
import { commandTokens, launcherName, nodeTestRun, packageScriptName, shellSegments } from '../test-command-resolution.mjs';

const MODE = 'new-and-changed';
const CLASS_FILE = /\.(?:java|kt|kts|groovy|scala)$/iu;

const className = (file) => path.posix.basename(file).replace(/\.[^.]+$/u, '');
// npm and bun hand a script what follows `--`; pnpm and yarn every word after its name.
const forwarded = (argv) => (['npm', 'bun'].includes(launcherName(argv[0])) && packageScriptName(argv) && !argv.includes('--') ? ['--'] : []);

/** A `node --test` run takes files as operands: directly, or through a script that is that run alone with none of its own. */
async function nodeTestArgv(root, command, files) {
  const { argv, workingDirectory } = command;
  if (nodeTestRun(argv)) return argv.slice(1).some((word) => !word.startsWith('-')) ? null : [...argv, ...files];
  const name = packageScriptName(argv);
  if (!name) return null;
  let script;
  try { script = JSON.parse(await readFile(path.join(root, workingDirectory, 'package.json'), 'utf8')).scripts?.[name]; } catch { return null; }
  const steps = shellSegments(script ?? '');
  if (steps.length !== 1) return null;
  const tokens = commandTokens(steps[0]);
  if (!nodeTestRun(tokens) || tokens.slice(1).some((word) => !word.startsWith('-'))) return null;
  return [...argv, ...forwarded(argv), ...files];
}

/** `argv` told to run only `files`, relative to the command's folder; null when its runner cannot be. */
async function selectedArgv(root, command, files) {
  const { argv, result } = command;
  const launcher = launcherName(argv[0]);
  switch (result?.adapter) {
    case 'node-tap': return nodeTestArgv(root, command, files);
    // Angular's jest builder passes on no path selection.
    case 'jest-json': return argv.some((word) => word.startsWith('--outputFile=')) ? null : [...argv, ...forwarded(argv), '--runTestsByPath', ...files];
    case 'vitest-json': case 'mocha-json': case 'playwright-json': return [...argv, ...forwarded(argv), ...files];
    case 'go-test-json':
      return argv.includes('./...') ? argv.flatMap((word) => (word === './...'
        ? [...new Set(files.map((file) => `./${path.posix.dirname(file)}`.replace(/\/\.$/u, '')))] : [word])) : null;
    case 'dotnet-trx': return [...argv, '--filter', files.map((file) => `FullyQualifiedName~${className(file)}`).join('|')];
    case 'junit-xml': {
      if (argv.includes('pytest')) return [...argv, ...files];
      if (!files.every((file) => CLASS_FILE.test(file))) return null;
      // Failsafe reads another option, and a module that names no test of a selected class must still pass.
      if (['mvn', 'mvnw'].includes(launcher)) return argv.at(-1) === 'test' ? [...argv, `-Dtest=${files.map(className).join(',')}`, '-Dsurefire.failIfNoSpecifiedTests=false'] : null;
      if (['gradle', 'gradlew'].includes(launcher)) return [...argv, ...files.flatMap((file) => ['--tests', `*${className(file)}`])];
      return null;
    }
    default: return null;
  }
}

/**
 * The commands a gate runs on a Story's new and changed tests. A narrowed command carries the whole
 * one as `testScope.baseCommand`, so a whole run on the same code still stands for it; `testScope`
 * says which files ran, or why the whole command did.
 */
export async function newAndChangedTestCommands(root, commands, testPaths, { importers = [] } = {}) {
  const whole = (command, why) => ({ ...command, testScope: { mode: MODE, whole: why } });
  // The existing tests that import a changed module, at the Story's last step that runs tests [CQF:REQ-017].
  testPaths = [...new Set([...testPaths, ...importers])].sort();
  const runners = new Map();
  for (const command of commands) {
    if (command.provenance === 'inferred') for (const key of command.affectedRoots ?? []) runners.set(key, (runners.get(key) ?? 0) + 1);
  }
  return Promise.all(commands.map(async (command) => {
    if (command.provenance !== 'inferred') return whole(command, 'its workflow or a person named this command, so it runs as written');
    const covered = testPaths.filter((file) => testCommandCoversPath(command, file));
    if (!covered.length) return whole(command, 'the Story changed no test here, and its module has no other evidence');
    if ((command.affectedRoots ?? []).some((key) => runners.get(key) > 1)) return whole(command, 'its module has several test runners, and a test file\'s path does not say which one runs it');
    const folder = command.workingDirectory === '.' ? '' : command.workingDirectory;
    const argv = await selectedArgv(root, command, covered.map((file) => path.posix.relative(folder, file)));
    if (!argv) return whole(command, 'this runner, or the script around it, cannot be told to run single files');
    const imported = covered.filter((file) => importers.includes(file));
    return { ...command, argv, testScope: { mode: MODE, files: covered, ...(imported.length ? { importers: imported } : {}), baseCommand: command } };
  }));
}

/**
 * Whether `phase` is the Story's last step that runs tests: no later step it reaches is a code step or
 * runs the repository's tests. There a Story on its new and changed tests also runs, once, the existing
 * tests that import a module it changed [CQF:REQ-017].
 */
export function lastTestingStep(workflow, phase) {
  const order = workflow.phaseOrder ?? [];
  return !order.slice(order.indexOf(phase.id) + 1).some((id) => {
    const step = workflow.phases?.[id];
    const pinned = workflow.resolution?.phases?.find((entry) => entry.id === id);
    return step && step.status !== 'skipped' && (phaseRequiresCodeDelivery(step) || (pinned?.repositoryTests === 'run' && !pinned.testEvidenceFrom));
  });
}

const MAX_IMPORTER_FILES = 5_000;
const MAX_IMPORTER_BYTES = 1024 * 1024;

/**
 * The existing test files Git tracks that import one of `changed` directly, read with
 * extractModuleSpecifiers; `exclude` (the Story's own new and changed tests) is left out [CQF:REQ-017].
 */
export async function existingTestsImporting(root, changed, { exclude = [] } = {}) {
  if (!changed.length) return [];
  const [{ trackedPathListing }, { buildIncrementalVerificationGraph }] = await Promise.all([
    import('../git.mjs'), import('./incremental-verification-graph.mjs')]);
  const listing = trackedPathListing(root);
  const own = new Set(exclude);
  const tests = listing.paths.filter((file) => isAllowedTestAutomationPath(file) && !own.has(file)
    && /\.(?:[cm]?[jt]sx?)$/iu.test(file)).slice(0, MAX_IMPORTER_FILES);
  const sourceByPath = new Map();
  for (const file of tests) {
    try {
      const absolute = path.join(root, file);
      if ((await stat(absolute)).size <= MAX_IMPORTER_BYTES) sourceByPath.set(file, await readFile(absolute, 'utf8'));
    } catch { /* a file it cannot read imports nothing here */ }
  }
  const graph = buildIncrementalVerificationGraph({ files: [...changed, ...sourceByPath.keys()], sourceByPath });
  return [...new Set(changed.flatMap((file) => graph.dependentsByFile[file] ?? []).filter((file) => sourceByPath.has(file)))].sort();
}

/**
 * The existing tests that import a module the Story's code steps changed, with `delivery` the evidence of
 * a code step being published now, when it is not yet on its phase [CQF:REQ-017].
 */
export async function storyExistingImporters(root, workflow, phase = null, delivery = null) {
  const deliveries = Object.values(workflow.phases ?? {}).filter((step) => phaseRequiresCodeDelivery(step) && step.id !== phase?.id)
    .map((step) => step.deliveryEvidence).concat(delivery ?? (phase && phaseRequiresCodeDelivery(phase) ? phase.deliveryEvidence : null)).filter(Boolean);
  return existingTestsImporting(root, [...new Set(deliveries.flatMap((entry) => entry.sourcePaths ?? []))].sort(),
    { exclude: deliveries.flatMap((entry) => entry.testPaths ?? []) });
}
