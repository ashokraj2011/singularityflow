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
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { testCommandCoversPath } from '../code-delivery-tests.mjs';
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
export async function newAndChangedTestCommands(root, commands, testPaths) {
  const whole = (command, why) => ({ ...command, testScope: { mode: MODE, whole: why } });
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
    return { ...command, argv, testScope: { mode: MODE, files: covered, baseCommand: command } };
  }));
}
