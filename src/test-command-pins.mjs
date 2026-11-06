/**
 * Test command pins [TCE:REQ-010].
 *
 * A test command Singularity Flow guessed for a module is recomputed at every publication, so an
 * agent could edit the package script behind it (`"test": "jest src/one"`) and the gate would run
 * the narrower suite. Now the first gate run of a command pins it for the Story: its argv, working
 * directory, affected roots, result adapter and `definition`, the digests of the package script
 * chain and the runner configuration it resolves through [TCE:REQ-011]. Configured and
 * Story-decision commands record their definition the same way, so an edited script behind
 * `npm test` is caught too [TCE:REQ-013].
 *
 * A later gate run whose command differs from its pin is refused before it runs
 * (TEST_COMMAND_PIN_CHANGED), naming what changed [TCE:REQ-012]. Anyone may request the new pin
 * (`decision test-command [WORK-ID] --phase P --repin ID`); a person who approves the step accepts
 * it, and the next gate run records the accepted pin in place of the old one. A pin is recorded on
 * the Story when its gate commits (publication or submission); until then the step's first recorded
 * run of the command stands for it, so a refused first run cannot be followed by a quiet edit. Each
 * attempt carries the pin it ran under, and receipt replay checks that pin is the Story's
 * [TCE:REQ-014]. Pins are kept in `workflow.testCommandPins`, append-only apart from the baseline a
 * pin gains at its first passing run. The gate also gathers here what narrows each run before it
 * runs (src/test-narrowing.mjs), from the same script texts.
 * A repair may restore changed entries to the recorded generation baseline while preserving all
 * unchanged pinned entries, including a new test script. This needs no human acceptance; its exact
 * baseline and restored entries are recorded by the next successful gate, and failed attempts stay.
 *
 * What a command resolves through is read by src/test-command-resolution.mjs, which the Node reporter
 * shares: the workspace a step selects, each script it reaches and each file a runner is told to read,
 * a missing one pinned as missing (definition version 2). A pin recorded under the first rules keeps
 * them for its Story, so a Story running when they grew is not refused for it; a person's re-pin moves
 * it to the current rules. A suite the Story pinned that its module no longer declares is refused as
 * removed until a person accepts that it no longer runs [TCE:REQ-012].
 */
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { committedFilesAtRevisions, pathRevisions } from './git.mjs';
import { readRefTreeResult } from './git-ref-tree.mjs';
import { redactDiagnosticText } from './git-remote-diagnostics.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import { readRepositoryManifest } from './repository-manifest.mjs';
import { pinDiffWords, storyTestCommandState } from './story-test-commands.mjs';
import {
  SCRIPT_RUNNERS, commandTokens, launcherName, nodeTestRun, packageScriptChain, packageScriptName, repositoryRelative, resolveTestCommand,
  shellSegments, unwrapRunner
} from './test-command-resolution.mjs';
import { runnerOfLauncher } from './test-runners.mjs';
import { SingularityFlowError } from './util.mjs';

export { commandTokens, launcherName, packageScriptChain, packageScriptName, shellSegments };

const MAX_CONFIG_BYTES = 1024 * 1024;
/** The definition rules a new pin records; a pin without `definitionVersion` was recorded under version 1. */
export const DEFINITION_VERSION = 3;
// The first rules pinned one script and what sat beside it; from version 2 a pin follows what a command resolves through.
const RESOLVED_VERSION = 2;
const NODE_RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'jest', 'vitest', 'mocha', 'playwright', 'cypress', 'karma', 'ng', 'react-scripts']);
const PYTHON_RUNNERS = new Set(['python', 'python3', 'py', 'pytest', 'py.test', 'tox', 'nox', 'uv', 'poetry', 'hatch']);
// Runner configuration a Node module's tests resolve through, wherever its scripts point.
const NODE_RUNNER_CONFIG = /^(?:(?:jest|vitest|vite|playwright|cypress|karma)\.(?:config|conf)\.[cm]?[jt]s|jest\.config\.json|vitest\.workspace\.(?:[cm]?[jt]s|json)|\.mocharc\.(?:[cm]?js|jsonc?|ya?ml))$/u;
const PACKAGE_RUNNER_KEYS = ['jest', 'mocha', 'ava'];

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
// Line endings are a checkout's choice (core.autocrlf), never a change to what runs.
const textSha256 = (text) => sha256(String(text).replace(/\r\n?/gu, '\n'));
// A file or script the command names that is not there: pinned as missing, so creating it later changes the pin.
const MISSING = sha256('singularity-flow test command definition: missing\n');

/**
 * Argv as one platform reads it, so a Story worked on Windows and macOS keeps one pin: the wrapper
 * and launcher spellings inference chooses per platform (`.\mvnw.cmd`, `py -3`, `Scripts\python.exe`).
 */
export function portableArgv(argv) {
  const values = (argv ?? []).map(String);
  if (!values.length) return values;
  values[0] = values[0].replaceAll('\\', '/').replace(/\.(?:cmd|bat|exe)$/iu, '').replace(/(^|\/)Scripts\/python$/u, '$1bin/python');
  if (values[0] === 'py' && values[1] === '-3') values.splice(0, 2, 'python3');
  return values;
}

// `node --test` takes test files as operands. The files a Story adds or edits are its work, not the
// command: a pin names the runner and its flags, and its files once as `<test files>`. Pinning the
// list (and the first file's text as if it were a script) refused every Story that added a test
// (spk-e2e, 2026-10-26).
const NODE_TEST_VALUE_FLAGS = new Set(['--test-reporter', '--test-reporter-destination', '--test-name-pattern',
  '--test-skip-pattern', '--test-concurrency', '--test-timeout', '--test-shard', '--import', '--require', '-r',
  '--loader', '--experimental-loader', '--env-file']);
const nodeTestRunner = (argv) => launcherName(argv[0]) === 'node' && argv.includes('--test');

/** The test-file operands of a `node --test` argv, or none. */
function nodeTestFiles(argv) {
  const values = (argv ?? []).map(String);
  if (!nodeTestRunner(values)) return [];
  const files = [];
  for (let index = 1; index < values.length; index += 1) {
    if (values[index].startsWith('-')) { if (NODE_TEST_VALUE_FLAGS.has(values[index])) index += 1; continue; }
    files.push(values[index].replaceAll('\\', '/').replace(/^\.\//u, ''));
  }
  return files;
}

/** Argv as a pin records it: portable, and a `node --test` file list as one `<test files>`. */
export function pinnedArgv(argv) {
  const values = portableArgv(argv);
  if (!nodeTestRunner(values)) return values;
  const kept = [values[0]];
  for (let index = 1; index < values.length; index += 1) {
    if (!values[index].startsWith('-')) continue;
    kept.push(values[index]);
    if (NODE_TEST_VALUE_FLAGS.has(values[index]) && index + 1 < values.length) kept.push(values[index += 1]);
  }
  return nodeTestFiles(values).length ? [...kept, '<test files>'] : kept;
}

async function readText(root, relative) {
  try { return (await readRepositoryManifest(root, relative, { maxBytes: MAX_CONFIG_BYTES })).bytes.toString('utf8'); }
  catch { return null; }
}

// Gates and decision projections distinguish missing inputs from an unreadable definition.
// A changed file the run leaves out is read as the run sees it, at the last commit.
function definitionReads(root, { excluded = [] } = {}) {
  const left = new Set(excluded);
  return {
    read: async relative => {
      if (left.has(relative)) return baseText(root, 'HEAD', relative);
      try { return (await readRepositoryManifest(root, relative, { maxBytes: MAX_CONFIG_BYTES })).bytes.toString('utf8'); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    list: async relative => {
      let entries;
      try { entries = (await readdir(path.join(root, relative), { withFileTypes: true })).map(entry => ({ name: entry.name, directory: entry.isDirectory() })); }
      catch (error) { if (error.code === 'ENOENT') entries = []; else throw error; }
      if (!left.size) return entries;
      const prefix = relative === '.' || !relative ? '' : `${relative}/`;
      const here = [...left].filter((file) => file.startsWith(prefix) && !file.slice(prefix.length).includes('/')).map((file) => file.slice(prefix.length));
      const kept = entries.filter((entry) => !here.includes(entry.name));
      return [...kept, ...here.filter((name) => baseText(root, 'HEAD', `${prefix}${name}`) != null).map((name) => ({ name, directory: false }))];
    }
  };
}

/** The reads a gate's comparison makes: what the run about to be made will see. */
async function gateReads(root, config, workflow) {
  const need = await (await import('./candidate-isolation.mjs')).candidateIsolationNeed(root, config, workflow).catch(() => null);
  return definitionReads(root, { excluded: need?.excluded ?? [] });
}

/** A directory's entries in the checkout, as `{ name, directory }`. */
async function listEntries(root, relative) {
  try { return (await readdir(path.join(root, relative), { withFileTypes: true })).map((entry) => ({ name: entry.name, directory: entry.isDirectory() })); }
  catch { return []; }
}

/** A file as it stands on the Story's base commit, or null where it did not exist. */
function baseText(root, baseCommit, relative) {
  try {
    return committedFilesAtRevisions(root, [{ key: relative, ref: baseCommit, path: relative }], { maximumObjectBytes: MAX_CONFIG_BYTES })
      .get(relative)?.toString('utf8') ?? null;
  } catch { return null; }
}

const join = (directory, name) => (directory === '.' || !directory ? name : path.posix.join(directory, name));

/** The lines of one INI or TOML section whose header starts with `header`, or null. */
function iniSection(text, header) {
  const lines = String(text ?? '').split(/\r?\n/u);
  const kept = [];
  let inside = false;
  for (const line of lines) {
    if (/^\s*\[/u.test(line)) inside = line.trim().toLowerCase().startsWith(header);
    if (inside) kept.push(line);
  }
  return kept.length ? kept.join('\n') : null;
}

/** The surefire and failsafe plugin blocks of a POM and its test-selection properties. */
function mavenTestConfiguration(pom) {
  const text = String(pom ?? '').replace(/<!--[\s\S]*?-->/gu, '');
  const plugins = [...text.matchAll(/<plugin>[\s\S]*?<\/plugin>/gu)].map((match) => match[0])
    .filter((block) => /<artifactId>\s*maven-(?:surefire|failsafe)-plugin\s*<\/artifactId>/u.test(block))
    .map((block) => block.replace(/\s+/gu, ' ').trim());
  const properties = [...text.matchAll(/<(skipTests|skipITs|test|it\.test|groups|excludedGroups|maven\.test\.[\w.]+|surefire\.[\w.]+|failsafe\.[\w.]+)>([\s\S]*?)<\/\1>/gu)]
    .map((match) => `${match[1]}=${match[2].trim()}`);
  return plugins.length || properties.length ? [...plugins, ...properties].join('\n') : null;
}

/** The `test` task blocks of a Gradle build script. */
function gradleTestConfiguration(build) {
  const text = String(build ?? '');
  const blocks = [];
  const start = /(?:^|\n)[ \t]*(?:tasks\s*\.\s*)?(?:test|named\s*(?:<Test>)?\s*\(\s*["']test["']\s*\)|withType\s*(?:<Test>|\(\s*Test(?:::class(?:\.java)?)?\s*\)))\s*(?:\.configure\s*)?\{/gu;
  for (const match of text.matchAll(start)) {
    let depth = 0;
    const open = match.index + match[0].length - 1;
    for (let at = open; at < text.length; at += 1) {
      if (text[at] === '{') depth += 1;
      else if (text[at] === '}' && --depth === 0) { blocks.push(text.slice(match.index, at + 1).trim()); break; }
    }
  }
  return blocks.length ? blocks.join('\n') : null;
}

const sortedEntries = (entries) => {
  const key = (entry) => `${entry.path}\u0000${entry.selector ?? ''}`;
  return [...new Map(entries.map((entry) => [key(entry), entry])).values()].sort((left, right) => key(left).localeCompare(key(right)));
};

/** The value of a flag (`-f pom.xml`, `--file=pom.xml`) in argv, or null. */
const argvFlag = (argv, flags) => {
  for (let index = 1; index < argv.length; index += 1) {
    const [name, value] = argv[index].startsWith('--') && argv[index].includes('=') ? argv[index].split(/=(.*)/su) : [argv[index], null];
    if (flags.includes(name)) return value ?? argv[index + 1] ?? null;
  }
  return null;
};

/**
 * The configuration of the runners a command reaches, or null when one of them is not known to read only its
 * own: a script SFlow cannot follow may read anything, so it keeps every configuration pinned.
 */
function runnersReached(runs) {
  if (!runs.length) return null;
  const config = [];
  const keys = new Set();
  for (const run of runs) {
    if (nodeTestRun(run.tokens)) continue;
    // What can select each runner's tests is its row's [TCE:REQ-011]; one with no such column may read anything.
    const known = runnerOfLauncher(launcherName(unwrapRunner(run.tokens)[0]))?.pins;
    if (!known) return null;
    config.push(...known.config);
    for (const key of known.keys) keys.add(key);
  }
  return { config, keys };
}

/**
 * What a command resolves through [TCE:REQ-011]: each file and selector with its sha256, sorted,
 * and the script texts it runs (read by the narrowed-run check, never stored). `version` 1 is the
 * first rules, kept for the pins recorded under them.
 */
export async function commandDefinition(root, command, {
  read = (relative) => readText(root, relative), list = (relative) => listEntries(root, relative), version = DEFINITION_VERSION
} = {}) {
  if (version < RESOLVED_VERSION) return legacyCommandDefinition(root, command, { read });
  const directory = command.workingDirectory ?? '.';
  const argv = (command.argv ?? []).map(String);
  const launcher = launcherName(argv[0]);
  const entries = [];
  const scripts = [];
  const add = (relative, selector, text) => { if (text != null) entries.push({ path: relative, selector, sha256: textSha256(text) }); };
  const missing = (relative, selector) => entries.push({ path: relative, selector, sha256: MISSING });
  const whole = async (relative) => add(relative, null, await read(relative));
  // A file the command names is pinned as it is, or as missing; never left out.
  const named = async (relative) => { const text = await read(relative); if (text == null) missing(relative, null); else add(relative, null, text); };
  const nodeLauncher = SCRIPT_RUNNERS.has(launcher) || NODE_RUNNERS.has(launcher) || ['node', 'tsx'].includes(launcher);
  if (nodeLauncher) {
    const resolved = await resolveTestCommand(argv, { directory, read, list });
    // Runner configuration applies where a runner reads it: the command's directory, each package whose
    // scripts it runs, and each directory a configurable runner runs in.
    const contexts = new Set(SCRIPT_RUNNERS.has(launcher) || NODE_RUNNERS.has(launcher) ? [directory] : []);
    for (const entry of resolved.packages) {
      contexts.add(entry.directory);
      for (const script of entry.scripts) {
        add(entry.manifestPath, `scripts.${script.name}`, script.text);
        scripts.push({ source: `${entry.manifestPath}#scripts.${script.name}`, text: script.text });
      }
      for (const name of entry.missing) missing(entry.manifestPath, `scripts.${name}`);
    }
    for (const run of resolved.runs) if (!nodeTestRun(run.tokens) && NODE_RUNNERS.has(launcherName(run.tokens[0]))) contexts.add(run.directory);
    const reaches = version > RESOLVED_VERSION ? runnersReached(resolved.runs) : null;
    const keys = reaches ? PACKAGE_RUNNER_KEYS.filter((key) => reaches.keys.has(key)) : PACKAGE_RUNNER_KEYS;
    const pinsConfig = (name) => NODE_RUNNER_CONFIG.test(name) && (!reaches || reaches.config.some((pattern) => pattern.test(name)));
    for (const context of [...contexts].sort()) {
      const manifestPath = join(context, 'package.json');
      const manifestText = await read(manifestPath);
      let manifest = null;
      try { manifest = manifestText ? JSON.parse(manifestText) : null; } catch { manifest = null; }
      for (const key of keys) if (manifest?.[key] !== undefined) add(manifestPath, key, canonicalJson(manifest[key]));
      const names = (await list(context)).filter((entry) => !entry.directory && pinsConfig(entry.name)).map((entry) => entry.name);
      for (const file of names.sort()) await whole(join(context, file));
    }
    for (const file of resolved.files) await named(file.path);
    // A workspace or directory a step selects that matches nothing runs no tests: pinned as such.
    for (const entry of resolved.unresolved) missing(entry.manifestPath, entry.selector);
  } else if (['mvn', 'mvnw'].includes(launcher)) {
    const modules = argv.flatMap((value, index) => (['-pl', '--projects'].includes(argv[index - 1]) ? value.split(',') : []))
      .filter((value) => value && !value.startsWith(':') && !value.startsWith('!'));
    // `-f other/pom.xml` names the POM the build starts from.
    const file = argvFlag(argv, ['-f', '--file']);
    const start = file ? repositoryRelative(directory, file) : null;
    const startPom = start ? (/\.xml$/u.test(start) ? start : join(start, 'pom.xml')) : null;
    if (startPom && await read(startPom) == null) missing(startPom, 'test-plugins');
    const startDirectory = startPom ? path.posix.dirname(startPom) : directory;
    for (const module of ['.', ...modules]) {
      const pom = module === '.' && startPom ? startPom : join(module === '.' ? startDirectory : join(startDirectory, module), 'pom.xml');
      add(pom, 'test-plugins', mavenTestConfiguration(await read(pom)));
    }
    await whole(join(directory, '.mvn/maven.config'));
  } else if (['gradle', 'gradlew'].includes(launcher)) {
    const project = argv.find((_, index) => ['-p', '--project-dir'].includes(argv[index - 1]));
    const base = project ? join(directory, project) : directory;
    for (const file of ['build.gradle', 'build.gradle.kts']) add(join(base, file), 'test-tasks', gradleTestConfiguration(await read(join(base, file))));
  } else if (PYTHON_RUNNERS.has(launcher)) {
    await whole(join(directory, 'pytest.ini'));
    await whole(join(directory, 'conftest.py'));
    add(join(directory, 'pyproject.toml'), 'tool.pytest', iniSection(await read(join(directory, 'pyproject.toml')), '[tool.pytest'));
    add(join(directory, 'setup.cfg'), 'tool:pytest', iniSection(await read(join(directory, 'setup.cfg')), '[tool:pytest]'));
    add(join(directory, 'tox.ini'), 'pytest', iniSection(await read(join(directory, 'tox.ini')), '[pytest]'));
    // `pytest -c ci.ini` names the configuration that selects the tests.
    const config = argvFlag(argv, ['-c', '--config-file']);
    const relative = config ? repositoryRelative(directory, config) : null;
    if (relative) await named(relative);
  }
  if (!nodeLauncher) {
    // A repository script the command runs (`./scripts/test.sh`, `bash scripts/test.sh`).
    const scriptFile = ['bash', 'sh', 'zsh'].includes(launcher) ? argv.slice(1).find((value) => !value.startsWith('-')) : argv[0];
    const relative = scriptFile && /[/\\]|\.(?:sh|mjs|cjs|js|py|ps1)$/u.test(scriptFile) && !['mvnw', 'gradlew'].includes(launcher)
      ? repositoryRelative(directory, scriptFile) : null;
    if (relative) await named(relative);
  }
  return { entries: sortedEntries(entries), scripts };
}

/** Definition version 1: the package script of the working directory and the runner configuration beside it. */
async function legacyCommandDefinition(root, command, { read }) {
  const directory = command.workingDirectory ?? '.';
  const argv = (command.argv ?? []).map(String);
  const launcher = launcherName(argv[0]);
  const entries = [];
  const scripts = [];
  const add = (relative, selector, text) => { if (text != null) entries.push({ path: relative, selector, sha256: textSha256(text) }); };
  const whole = async (relative) => add(relative, null, await read(relative));
  if (SCRIPT_RUNNERS.has(launcher) || NODE_RUNNERS.has(launcher)) {
    const manifestPath = join(directory, 'package.json');
    const manifestText = await read(manifestPath);
    let manifest = null;
    try { manifest = manifestText ? JSON.parse(manifestText) : null; } catch { manifest = null; }
    const name = packageScriptName(argv);
    if (manifest && name) {
      for (const script of packageScriptChain(manifest.scripts ?? {}, name)) {
        add(manifestPath, `scripts.${script.name}`, script.text);
        scripts.push({ source: `${manifestPath}#scripts.${script.name}`, text: script.text });
      }
    }
    for (const key of PACKAGE_RUNNER_KEYS) if (manifest?.[key] !== undefined) add(manifestPath, key, canonicalJson(manifest[key]));
    let names = [];
    try { names = await readdir(path.join(root, directory)); } catch { names = []; }
    for (const file of names.filter((entry) => NODE_RUNNER_CONFIG.test(entry)).sort()) await whole(join(directory, file));
  } else if (['mvn', 'mvnw'].includes(launcher)) {
    const modules = argv.flatMap((value, index) => (['-pl', '--projects'].includes(argv[index - 1]) ? value.split(',') : []))
      .filter((value) => value && !value.startsWith(':') && !value.startsWith('!'));
    for (const module of ['.', ...modules]) {
      const pom = join(module === '.' ? directory : join(directory, module), 'pom.xml');
      add(pom, 'test-plugins', mavenTestConfiguration(await read(pom)));
    }
    await whole(join(directory, '.mvn/maven.config'));
  } else if (['gradle', 'gradlew'].includes(launcher)) {
    const project = argv.find((_, index) => ['-p', '--project-dir'].includes(argv[index - 1]));
    const base = project ? join(directory, project) : directory;
    for (const file of ['build.gradle', 'build.gradle.kts']) add(join(base, file), 'test-tasks', gradleTestConfiguration(await read(join(base, file))));
  } else if (PYTHON_RUNNERS.has(launcher)) {
    await whole(join(directory, 'pytest.ini'));
    await whole(join(directory, 'conftest.py'));
    add(join(directory, 'pyproject.toml'), 'tool.pytest', iniSection(await read(join(directory, 'pyproject.toml')), '[tool.pytest'));
    add(join(directory, 'setup.cfg'), 'tool:pytest', iniSection(await read(join(directory, 'setup.cfg')), '[tool:pytest]'));
    add(join(directory, 'tox.ini'), 'pytest', iniSection(await read(join(directory, 'tox.ini')), '[pytest]'));
  }
  // A repository script the command runs (`./scripts/test.sh`, `bash scripts/test.sh`, `node run-tests.mjs`).
  const scriptFile = nodeTestRunner(argv) ? null
    : ['bash', 'sh', 'zsh', 'node'].includes(launcher) ? argv.slice(1).find((value) => !value.startsWith('-')) : argv[0];
  if (scriptFile && /[/\\]|\.(?:sh|mjs|cjs|js|py|ps1)$/u.test(scriptFile) && !['mvnw', 'gradlew'].includes(launcher)
      && !path.posix.isAbsolute(scriptFile.replaceAll('\\', '/')) && !scriptFile.replaceAll('\\', '/').split('/').includes('..')) {
    await whole(join(directory, scriptFile.replaceAll('\\', '/').replace(/^\.\//u, '')));
  }
  return { entries: sortedEntries(entries), scripts };
}

/** Where a gate's command comes from, as its pin names it: guessed, configured, or a Story decision. */
export function pinSource(phase, command) {
  const decided = (phase?.storyTestCommands ?? []).find((entry) => entry?.id === command.id && entry.storyDecision);
  if (command.provenance === 'story-decision' && decided) {
    return { kind: 'story-decision', decision: decided.storyDecision.id, recordSha256: decided.storyDecision.sha256 };
  }
  const configured = (phase?.qualityCommands ?? []).find((entry) => entry && typeof entry === 'object' && entry.id === command.id);
  if (command.provenance === 'configured' && configured) return { kind: 'configured', recordSha256: `sha256:${recordSha256(configured)}` };
  return { kind: 'inferred' };
}

/** Pins of one source are compared with each other; a person's newer source starts a new pin. */
export function pinSourceKey(source) {
  if (source?.kind === 'story-decision') return `story-decision:${source.decision}`;
  if (source?.kind === 'configured') return `configured:${source.recordSha256}`;
  return 'inferred';
}

/** The pin a gate run of `command` would record, identified by the digest of everything it pins. */
export function pinCandidate(phase, command, definition, { version = DEFINITION_VERSION } = {}) {
  const identity = {
    commandId: command.id, source: pinSource(phase, command), argv: pinnedArgv(command.argv),
    workingDirectory: command.workingDirectory ?? '.', affectedRoots: [...(command.affectedRoots ?? [])].sort(),
    adapter: command.result?.adapter ?? null, definition,
    // Version 1 pins carry no field, so their identity and digest are exactly what was recorded.
    ...(version > 1 ? { definitionVersion: version } : {})
  };
  return { ...identity, sha256: `sha256:${recordSha256(identity)}` };
}

/** The definition rules a pin was recorded under. */
export const pinVersion = (pin) => (Number.isInteger(pin?.definitionVersion) ? pin.definitionVersion : 1);

const pinIdentity = ({ commandId, source, argv, workingDirectory, affectedRoots, adapter, definition, definitionVersion, sha256: digest }) =>
  ({ commandId, source, argv, workingDirectory, affectedRoots, adapter, definition, ...(definitionVersion > 1 ? { definitionVersion } : {}), sha256: digest });

/**
 * A pin as the current identity reads it. One recorded before `<test files>` listed its `node --test`
 * files and pinned the first file's text; read here without them, so a Story that only added or
 * edited tests since then is not asked for a re-pin.
 */
function comparablePin(pinned) {
  // Later pins name `<test files>` already; only a first-rules pin can list them.
  if (pinVersion(pinned) >= RESOLVED_VERSION) return pinned;
  const files = new Set(nodeTestFiles(pinned?.argv));
  if (!files.size) return pinned;
  const { commandId, source, workingDirectory, affectedRoots, adapter } = pinned;
  const identity = { commandId, source, argv: pinnedArgv(pinned.argv), workingDirectory, affectedRoots, adapter,
    definition: (pinned.definition ?? []).filter((entry) => !files.has(entry.path)) };
  return { ...pinned, ...identity, sha256: `sha256:${recordSha256(identity)}` };
}

/** The Story's latest recorded pin of this command and source, or null. */
export function storyPin(workflow, candidate) {
  const key = pinSourceKey(candidate.source);
  return (workflow?.testCommandPins ?? []).filter((pin) => pin.commandId === candidate.commandId && pinSourceKey(pin.source) === key).at(-1) ?? null;
}

/** The pin a gate run is compared with: the Story's, else the step's first recorded run of it. */
export function referencePin(workflow, candidate, attempts = []) {
  const recorded = storyPin(workflow, candidate);
  if (recorded) return recorded;
  const key = pinSourceKey(candidate.source);
  return attempts.find((attempt) => attempt.commandId === candidate.commandId && attempt.purpose !== 'local'
    && attempt.pin?.sha256 && pinSourceKey(attempt.pin.source) === key)?.pin ?? null;
}

/** The accepted re-pin request that admits exactly this pin and no recorded pin has used yet. */
export function acceptedRepin(workflow, candidate) {
  const used = new Set((workflow?.testCommandPins ?? []).map((pin) => pin.acceptedBy).filter(Boolean));
  return (workflow?.testCommandDecisions ?? []).find((entry) => entry.id && entry.repin?.commandId === candidate.commandId
    && !entry.repin.removed && entry.repin.sha256 === candidate.sha256 && !used.has(entry.id)
    && storyTestCommandState(workflow, entry.id)?.state === 'accepted')?.id ?? null;
}

/** What differs between a pin and a candidate: argv, directory, roots, adapter, and each definition entry. */
export function pinChanges(recorded, candidate) {
  const pinned = comparablePin(recorded);
  const changes = [];
  for (const field of ['argv', 'workingDirectory', 'affectedRoots', 'adapter']) {
    if (canonicalJson(pinned[field] ?? null) !== canonicalJson(candidate[field] ?? null)) changes.push({ field, pinned: pinned[field] ?? null, now: candidate[field] ?? null });
  }
  const key = (entry) => `${entry.path}#${entry.selector ?? ''}`;
  const before = new Map((pinned.definition ?? []).map((entry) => [key(entry), entry]));
  const after = new Map((candidate.definition ?? []).map((entry) => [key(entry), entry]));
  for (const [name, entry] of after) {
    const was = before.get(name);
    if (was && was.sha256 === entry.sha256) continue;
    const change = !was ? (entry.sha256 === MISSING ? 'named but missing' : 'added')
      : was.sha256 === MISSING ? 'created' : entry.sha256 === MISSING ? 'deleted' : 'changed';
    changes.push({ field: 'definition', path: entry.path, selector: entry.selector ?? null, change });
  }
  for (const [name, entry] of before) if (!after.has(name)) changes.push({ field: 'definition', path: entry.path, selector: entry.selector ?? null, change: 'removed' });
  return changes;
}

function restorationBase(workflow, phase, fallback = null) {
  const interval = workflow?.workIntervals?.current;
  return phase.generationIntent?.baseline?.commit
    ?? (interval?.phaseId === phase.id ? interval.sourceBaseCommit : null)
    ?? workflow?.workItem?.baseCommit ?? fallback;
}

/** What a definition entry pins, read from its file's text: null where it is not there, undefined for a selector this cannot read. */
function definitionEntryValue(selector, text) {
  let value;
  if (selector == null) value = text;
  else if (selector.startsWith('scripts.') || PACKAGE_RUNNER_KEYS.includes(selector)) {
    const manifest = JSON.parse(text);
    value = selector.startsWith('scripts.') ? manifest.scripts?.[selector.slice(8)]
      : manifest[selector] === undefined ? null : canonicalJson(manifest[selector]);
    if (typeof value !== 'string') value = null;
  } else if (selector === 'test-plugins') value = mavenTestConfiguration(text);
  else if (selector === 'test-tasks') value = gradleTestConfiguration(text);
  else if (selector === 'tool.pytest') value = iniSection(text, '[tool.pytest');
  else if (selector === 'tool:pytest') value = iniSection(text, '[tool:pytest]');
  else if (selector === 'pytest') value = iniSection(text, '[pytest]');
  else return undefined;
  return value ?? null;
}

/** The same semantic value a definition entry pins, read from its immutable baseline file. */
function baselineEntryHash(entry, text) {
  if (text == null) return MISSING;
  const value = definitionEntryValue(entry.selector, text);
  if (value === undefined) return undefined;
  return value == null ? MISSING : textSha256(value);
}

/**
 * A restoration changes only definition entries, each back to the generation's own value.
 * Unchanged entries retain their pin, including a test script first added during this generation.
 * Read only the changed baseline files; absence is proved by a complete, bounded Git tree read.
 */
function baselineRestoration(root, reference, candidate, commit) {
  if (!commit || !reference || reference.sha256 === candidate.sha256) return null;
  const changes = pinChanges(reference, candidate);
  if (!changes.length || changes.some(change => change.field !== 'definition')) return null;
  const paths = new Set(changes.map(change => change.path));
  const nonFiles = [];
  const observed = readRefTreeResult(root, commit, [...paths], {
    maxObjectBytes: MAX_CONFIG_BYTES,
    pathFilter(file, metadata) {
      if (!paths.has(file)) return false;
      if (!['100644', '100755'].includes(metadata.mode)) { nonFiles.push(file); return false; }
      return true;
    }
  });
  if (observed.status !== 'ok' || nonFiles.length) throw new SingularityFlowError(
    `Cannot verify test-definition restoration against generation baseline '${commit}'.`, {
      code: 'TEST_COMMAND_BASELINE_UNAVAILABLE', details: { baselineCommit: commit,
        paths: [...paths], status: observed.status, diagnostics: observed.errors, nonFiles }
    });
  const key = entry => `${entry.path}#${entry.selector ?? ''}`;
  const now = new Map(candidate.definition.map(entry => [key(entry), entry]));
  const definitions = [];
  for (const change of changes) {
    const expected = baselineEntryHash(change, observed.contents.get(change.path) ?? null);
    if (expected === undefined || (now.get(key(change))?.sha256 ?? MISSING) !== expected) return null;
    definitions.push({ path: change.path, selector: change.selector, sha256: expected });
  }
  return { commit, definitions };
}

/** One change in words: "argv [npm, test] → [npm, test, --, --json]", "package.json scripts.test changed". */
export function pinChangeWords(change) {
  if (change.field === 'definition') return `${change.path}${change.selector ? ` ${change.selector}` : ''} ${change.change}`;
  const show = (value) => (Array.isArray(value) ? JSON.stringify(value) : String(value));
  return `${change.field} ${show(change.pinned)} → ${show(change.now)}`;
}

const MAX_DIFF_LINES = 12;
const MAX_DIFF_LINE = 200;
const MAX_HISTORY_COMMITS = 40;

const shownValue = (text) => redactDiagnosticText(String(text).split(/\r?\n/u).map((line) => (line.length > MAX_DIFF_LINE ? `${line.slice(0, MAX_DIFF_LINE)}…` : line)).join('\n'), { multiline: true });

/** The lines two texts differ by, bounded: what a person reads of a changed configuration file. */
function changedLines(before, after) {
  const [left, right] = [String(before ?? '').split(/\r?\n/u), String(after ?? '').split(/\r?\n/u)];
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let end = 0;
  while (end < left.length - start && end < right.length - start && left[left.length - 1 - end] === right[right.length - 1 - end]) end += 1;
  const part = (lines) => {
    const middle = lines.slice(start, lines.length - end);
    return middle.slice(0, MAX_DIFF_LINES).join('\n') + (middle.length > MAX_DIFF_LINES ? `\n… and ${middle.length - MAX_DIFF_LINES} more lines` : '');
  };
  return { before: part(left), after: part(right) };
}

/** A definition entry's text as the pin bound it: the commit in the Story's history whose value has its digest, or null. */
function pinnedValue(root, entry, recorded, commits) {
  if (!recorded || recorded.sha256 === MISSING) return null;
  const history = pathRevisions(root, 'HEAD', entry.path, { limit: MAX_HISTORY_COMMITS }) ?? [];
  for (const commit of [...new Set([...commits.filter(Boolean), ...history])]) {
    const text = baseText(root, commit, entry.path);
    if (text == null) continue;
    let value;
    try { value = definitionEntryValue(entry.selector, text); } catch { continue; }
    if (value != null && textSha256(value) === recorded.sha256) return value;
  }
  return null;
}

/**
 * What a person needs to decide a changed pin: each change before and after (a script's whole text, a
 * configuration file's changed lines, bounded and redacted), and whether the change drops tests. Earlier
 * bytes are only ever shown when their digest is the pin's, so `known: false` says the Story's history
 * no longer holds them instead of guessing.
 */
export async function pinChangeDetails(root, workflow, phase, reference, candidate, { command, scripts = [], attempts = [], baseCommit = null, read = (relative) => readText(root, relative) } = {}) {
  const pinned = comparablePin(reference);
  const commits = [...attempts.filter((attempt) => attempt.pin?.sha256 === reference.sha256).map((attempt) => attempt.candidate?.commit),
    restorationBase(workflow, phase, baseCommit), baseCommit, workflow?.workItem?.baseCommit];
  const key = (entry) => `${entry.path}#${entry.selector ?? ''}`;
  const earlier = new Map((pinned.definition ?? []).map((entry) => [key(entry), entry]));
  const diff = [];
  for (const change of pinChanges(reference, candidate)) {
    if (change.field !== 'definition') {
      const shown = (value) => (Array.isArray(value) ? value.join(' ') : String(value ?? ''));
      diff.push({ field: change.field, known: true, before: shownValue(shown(change.pinned)), after: shownValue(shown(change.now)) });
      continue;
    }
    const text = await read(change.path);
    let after = null;
    try { after = text == null ? null : definitionEntryValue(change.selector, text) ?? null; } catch { after = null; }
    const before = pinnedValue(root, change, earlier.get(key(change)), commits);
    const created = change.change === 'added' || change.change === 'created' || change.change === 'named but missing';
    const known = before != null || created;
    // A whole file reads as the lines that changed; a script or a selected block is short enough to read whole.
    const texts = change.selector == null && before != null && after != null ? changedLines(before, after) : { before, after };
    diff.push({ field: 'definition', path: change.path, selector: change.selector, change: change.change, known,
      ...(change.selector == null ? { lines: true } : {}),
      before: texts.before == null ? null : shownValue(texts.before), after: texts.after == null ? null : shownValue(texts.after) });
  }
  const { addedPathNarrowing, pathNarrowingWords } = await import('./test-narrowing.mjs');
  const paths = command ? addedPathNarrowing(root, command, { scripts, baseCommit, inferred: candidate.source?.kind === 'inferred' }) : [];
  const onlyConfiguration = diff.some((entry) => entry.lines) && !paths.length;
  const dropped = paths.length ? paths.map(pathNarrowingWords).join(' ')
    : onlyConfiguration ? 'SFlow cannot tell from a configuration file whether tests are dropped. The first passing run\'s count still guards it: a later run with fewer tests is refused.'
      : 'No path or filter was added, so no test files are left out.';
  return { diff, ...(paths.length ? { pathNarrowing: paths } : {}), dropped };
}

/** The request a refusal names: anyone may make it; a person who approves the step accepts it. */
export function repinRequestCommand(workflow, phaseId, commandId) {
  return `singularity-flow decision test-command ${workflow?.workItem?.id ?? '<WORK-ID>'} --phase ${phaseId} --repin ${commandId} --reason "<why the test command changed>"`;
}

function pinChangedError(workflow, phase, pinned, candidate, details = null) {
  const changes = pinChanges(pinned, candidate).map(pinChangeWords);
  const beforeAfter = details?.diff?.length ? ` Before and after: ${details.diff.map(pinDiffWords).join('; ')}. ${details.dropped}` : '';
  const workId = workflow?.workItem?.id ?? null;
  const command = repinRequestCommand(workflow, phase.id, candidate.commandId);
  const restore = [...new Set(pinChanges(pinned, candidate).filter((change) => change.field === 'definition').map((change) => change.path))];
  const restoreWords = restore.length ? `Or restore ${restore.join(', ')} as pinned.` : 'Or restore the module as pinned.';
  return new SingularityFlowError(
    `Test command '${candidate.commandId}' changed since it was pinned for this Story${pinned.id ? ` (${pinned.id})` : ''}: `
      + `${changes.join('; ')}.${beforeAfter} A changed test command is decided by a person who approves ${phase.id}: request it with ${command}, `
      + `and they accept it (/sf-decide ${workId ?? '<WORK-ID>'}); an agent never accepts it. ${restoreWords}`,
    { code: 'TEST_COMMAND_PIN_CHANGED', details: {
      workId, phase: phase.id,
      testCommandPin: { phase: phase.id, commandId: candidate.commandId, pin: pinned.id ?? null, changes, restorePaths: restore, command,
        ...(details ? { diff: details.diff, dropped: details.dropped, ...(details.pathNarrowing ? { pathNarrowing: details.pathNarrowing } : {}) } : {}) },
      // The refusal's own route, which every surface renders: anyone requests, a person who approves accepts.
      nextAction: { command, label: `Request the new pin, saying why the test command changed; a person who approves ${phase.id} accepts it `
        + `from the decision list (/sf-decide ${workId ?? '<WORK-ID>'}), and an agent never accepts it. ${restoreWords}` }
    } }
  );
}

/** The accepted request that a person agreed this pinned suite no longer runs [TCE:REQ-012]. */
export function acceptedRemoval(workflow, pin) {
  return (workflow?.testCommandDecisions ?? []).find((entry) => entry.id && entry.repin?.removed === true
    && entry.repin.commandId === pin.commandId && entry.repin.pinned === pin.sha256
    && storyTestCommandState(workflow, entry.id)?.state === 'accepted')?.id ?? null;
}

function pinRemovedError(workflow, phase, pinned) {
  const workId = workflow?.workItem?.id ?? null;
  const command = repinRequestCommand(workflow, phase.id, pinned.commandId);
  const words = `${pinned.workingDirectory ?? '.'} no longer declares it, so its tests would stop counting unseen`;
  return new SingularityFlowError(
    `Test command '${pinned.commandId}' was pinned for this Story${pinned.id ? ` (${pinned.id})` : ''} and no longer runs: ${words}. `
      + `A removed test suite is decided by a person who approves ${phase.id}: request it with ${command}, `
      + `and they accept it (/sf-decide ${workId ?? '<WORK-ID>'}); an agent never accepts it. Or restore the suite as pinned.`,
    { code: 'TEST_COMMAND_PIN_CHANGED', details: {
      workId, phase: phase.id,
      testCommandPin: { phase: phase.id, commandId: pinned.commandId, pin: pinned.id ?? null, changes: [`removed: ${words}`], removed: true, command },
      nextAction: { command, label: `Request that ${pinned.commandId} no longer run, saying why the suite was removed; a person who approves ${phase.id} `
        + `accepts it from the decision list (/sf-decide ${workId ?? '<WORK-ID>'}), and an agent never accepts it. Or restore the suite as pinned.` }
    } }
  );
}

// Whole-repository ids (`node-tests`, `maven-tests`) name no module's suite, so a module appearing later never removes one.
const REPOSITORY_COMMAND_IDS = new Set(['node-tests', 'maven-tests', 'gradle-tests', 'go-tests', 'cargo-tests', 'python-tests', 'dotnet-tests']);

/** Whether the base commit's package declared the pinned Node suite: its script, or a script starting its runner. */
function suiteAtBase(root, baseCommit, pin) {
  const text = baseText(root, baseCommit, join(pin.workingDirectory ?? '.', 'package.json'));
  if (text == null) return false;
  let scripts;
  try { scripts = JSON.parse(text)?.scripts ?? {}; } catch { return true; }
  const script = packageScriptName(pin.argv);
  if (script && typeof scripts[script] === 'string') return true;
  const runner = launcherName(unwrapRunner(pin.argv)[0]);
  return Object.values(scripts).some((value) => typeof value === 'string'
    && shellSegments(value).some((segment) => launcherName(unwrapRunner(segment)[0]) === runner));
}

/**
 * The first inferred suite the Story pinned under the current rules that its module no longer
 * declares, or null. A module the change does not touch is not selected this time, which is not a
 * removal; neither is a suite the module still declares that this gate chose not to run, a module an
 * approved configured command now owns, or a suite the base commit never had (the Story added it).
 * Configured and Story-decision commands leave a gate only through the configuration or a person's
 * decision, so their absence is never read as a removal.
 */
async function removedSuite(root, workflow, phase, commands, attempts, deliveryEvidence, baseCommit) {
  const running = new Set(commands.map((command) => command.id));
  const latest = new Map();
  for (const pin of workflow?.testCommandPins ?? []) if (pin.source?.kind === 'inferred') latest.set(pin.commandId, pin);
  // Before a gate commits, the step's first recorded run stands for the pin, as for a changed command.
  for (const attempt of attempts) {
    if (attempt.purpose !== 'local' && attempt.pin?.sha256 && attempt.pin.source?.kind === 'inferred' && !latest.has(attempt.commandId)) latest.set(attempt.commandId, attempt.pin);
  }
  const missing = [...latest.values()].filter((pin) => !running.has(pin.commandId) && pinVersion(pin) >= RESOLVED_VERSION
    && !REPOSITORY_COMMAND_IDS.has(pin.commandId) && !acceptedRemoval(workflow, pin));
  if (!missing.length) return null;
  const [{ affectedTestModules }, { moduleTestCommands }] = await Promise.all([import('./delivery-evidence.mjs'), import('./test-module-markers.mjs')]);
  const { modules, ownedByConfiguredTest } = await affectedTestModules(root, { ...phase, deliveryEvidence: deliveryEvidence ?? phase.deliveryEvidence });
  for (const pin of missing) {
    const module = modules.find((entry) => entry.root === (pin.workingDirectory ?? '.'));
    if (!module || ownedByConfiguredTest(module.root)) continue;
    const declared = await moduleTestCommands(root, module).catch(() => null);
    if (!declared || declared.some((command) => command.id === pin.commandId)) continue;
    if (baseCommit && !suiteAtBase(root, baseCommit, pin)) continue;
    return pin;
  }
  return null;
}

/** The first passing gate run of a pin in this step, the narrowed-run check's baseline. */
function firstPassingRun(attempts, sha) {
  const attempt = attempts.find((entry) => entry.purpose !== 'local' && entry.pin?.sha256 === sha && !entry.testScope?.files
    && entry.status === 'passed' && Number.isInteger(entry.tests?.discovered));
  return attempt ? { discovered: attempt.tests.discovered, skipped: Number(attempt.tests.skipped) || 0, attemptId: attempt.attemptId } : null;
}

/** The recorded runs of one step, oldest first, that pins and baselines are read from. */
async function recordedRuns(root, config, workflow, phase) {
  const [{ stepAttempts }, { workDirRelative }] = await Promise.all([import('./verification/attempts.mjs'), import('./story-paths.mjs')]);
  return stepAttempts(root, workDirRelative(config, workflow.workItem.id), workflow.workItem.id, phase.id);
}

// What the Story changed is measured against its base: narrowing already there is the team's own [TCE:REQ-021].
const gateBaseCommit = (workflow, phase, deliveryEvidence) => deliveryEvidence?.changeSet?.base?.commit ?? phase.generationIntent?.baseline?.commit
  ?? workflow.workIntervals?.current?.sourceBaseCommit ?? null;

/** One command against its pin, exactly as a gate compares them; it refuses nothing and writes nothing. */
async function comparedPin(root, workflow, phase, command, { attempts, reads, baseCommit }) {
  const current = await commandDefinition(root, command, reads);
  const latest = pinCandidate(phase, command, current.entries);
  const recordedReference = referencePin(workflow, latest, attempts);
  const reference = recordedReference && comparablePin(recordedReference);
  // A pin keeps the rules it was recorded under: a Story running when they grew is compared as before.
  const version = reference ? pinVersion(reference) : DEFINITION_VERSION;
  const resolved = version === DEFINITION_VERSION ? current : await commandDefinition(root, command, { ...reads, version });
  let candidate = version === DEFINITION_VERSION ? latest : pinCandidate(phase, command, resolved.entries, { version });
  let { scripts } = resolved;
  let acceptedBy = reference && reference.sha256 !== candidate.sha256 ? acceptedRepin(workflow, candidate) : null;
  // A person's re-pin of an older pin admits the command under the current rules.
  if (reference && reference.sha256 !== candidate.sha256 && !acceptedBy && version !== DEFINITION_VERSION && acceptedRepin(workflow, latest)) {
    acceptedBy = acceptedRepin(workflow, latest);
    candidate = latest;
    ({ scripts } = current);
  }
  // Restore changed entries without requiring newly added, unchanged test scripts at the base.
  const restoration = !acceptedBy ? baselineRestoration(root, reference, candidate, restorationBase(workflow, phase, baseCommit)) : null;
  const restoredToBase = Boolean(restoration);
  return { candidate, reference, recordedReference, scripts, acceptedBy, restoration, restoredToBase,
    changed: Boolean(reference && reference.sha256 !== candidate.sha256 && !acceptedBy && !restoredToBase) };
}

/**
 * Where each command stands against its pin, for `tests plan`: what the next gate would find, before it
 * finds it. It compares as the gate does and never refuses; only the gate refuses.
 */
export async function testCommandPinStandings(root, config, workflow, phase, commands, deliveryEvidence = null) {
  const baseCommit = gateBaseCommit(workflow, phase, deliveryEvidence) ?? workflow.workItem?.baseCommit ?? null;
  const attempts = await recordedRuns(root, config, workflow, phase);
  const reads = await gateReads(root, config, workflow);
  const standings = new Map();
  for (const command of commands) {
    try {
      const { candidate, reference, recordedReference, scripts, acceptedBy, restoredToBase, changed } = await comparedPin(root, workflow, phase, command, { attempts, reads, baseCommit });
      if (!reference) standings.set(command.id, { status: 'not-pinned', words: 'Not pinned yet: its first gate run pins it for this Story.' });
      else if (acceptedBy) standings.set(command.id, { status: 'accepted', decision: acceptedBy, words: `Changed since it was pinned, and a person accepted this definition (${acceptedBy}).` });
      else if (restoredToBase) standings.set(command.id, { status: 'restored', words: 'What changed is back as it was at the start of this generation, so no re-pin is needed.' });
      else if (!changed) standings.set(command.id, { status: 'unchanged', words: 'Unchanged since it was pinned for this Story.' });
      else {
        const details = await pinChangeDetails(root, workflow, phase, recordedReference, candidate, { command, scripts, attempts, baseCommit, read: reads.read }).catch(() => null);
        const beforeAfter = details?.diff?.length ? ` Before and after: ${details.diff.map(pinDiffWords).join('; ')}. ${details.dropped}` : '';
        standings.set(command.id, { status: 'changed', pin: reference.id ?? null, changes: pinChanges(reference, candidate).map(pinChangeWords),
          ...(details ? { diff: details.diff, dropped: details.dropped } : {}), command: repinRequestCommand(workflow, phase.id, command.id),
          words: `Changed since it was pinned: ${pinChanges(reference, candidate).map(pinChangeWords).join('; ')}.${beforeAfter} The next gate refuses this until a person who approves ${phase.id} accepts the new pin, or it is restored.` });
      }
    } catch (error) {
      standings.set(command.id, { status: 'unknown', words: `SFlow could not compare it with its pin: ${redactDiagnosticText(String(error?.message ?? error)).slice(0, 300)}` });
    }
  }
  return standings;
}

/**
 * Check every test command a gate is about to run against its pin, before anything runs (the
 * candidate's `deliveryEvidence` names the changed test files it reads for focused tests); refuses
 * TEST_COMMAND_PIN_CHANGED for the first that changed with no accepted re-pin. Returns, per
 * command ID, the candidate pin (each attempt carries it) and how it stands, and `record`, which
 * the gate calls once it passed to write the pins of the commands that ran onto the Story.
 */
export async function gateTestCommandPins(root, config, workflow, phase, commands, deliveryEvidence = null) {
  const testPaths = deliveryEvidence?.testPaths ?? [];
  const baseCommit = gateBaseCommit(workflow, phase, deliveryEvidence);
  const attempts = await recordedRuns(root, config, workflow, phase);
  const { gateNarrowing, narrowingFacts, skippedByAgreement } = await import('./test-narrowing.mjs');
  const prepared = new Map();
  const reads = await gateReads(root, config, workflow);
  for (const command of commands) {
    const { candidate, reference, recordedReference, scripts, acceptedBy, restoration, restoredToBase, changed } = await comparedPin(root, workflow, phase, command, { attempts, reads, baseCommit });
    if (changed) {
      const details = await pinChangeDetails(root, workflow, phase, recordedReference, candidate, { command, scripts, attempts, baseCommit, read: reads.read }).catch(() => null);
      throw pinChangedError(workflow, phase, reference, candidate, details);
    }
    const recorded = storyPin(workflow, candidate);
    const baseline = (recorded?.sha256 === candidate.sha256 ? recorded.baseline : null) ?? firstPassingRun(attempts, candidate.sha256);
    // What narrows the run before it runs: filters, focused tests, and the pin's baseline [TCE:REQ-021].
    // The paths a person saw in an accepted re-pin of this pin are already their decision.
    const repinnedBy = acceptedBy ?? (recorded?.sha256 === candidate.sha256 ? recorded.acceptedBy : null);
    const acceptedPaths = repinnedBy ? storyTestCommandState(workflow, repinnedBy)?.request?.repin?.pathNarrowing ?? [] : [];
    const narrowing = await narrowingFacts(root, command, { scripts, testPaths, baseline, inferred: candidate.source.kind === 'inferred', baseCommit, acceptedPaths });
    prepared.set(command.id, { candidate, reference, acceptedBy, restoredToBase, restoration, scripts, baseline, narrowing });
  }
  // A suite the Story pinned that no longer runs at all is refused too: per-command counts cannot see it [TCE:REQ-012].
  const removed = await removedSuite(root, workflow, phase, commands, attempts, deliveryEvidence, baseCommit);
  if (removed) throw pinRemovedError(workflow, phase, removed);
  return {
    prepared,
    // What an attempt of the command records: the pin it runs under and what narrows it before it runs.
    attempt: (commandId) => ({ pin: prepared.get(commandId)?.candidate ?? null, narrowing: prepared.get(commandId)?.narrowing ?? null }),
    // The gate's rule for a passing run's recorded narrowing: null, an acceptance's binding, or CODE_TEST_NARROWED.
    narrowed: (attempt, operation) => gateNarrowing(workflow, phase, attempt,
      { at: new Date().toISOString(), operation, skippedAccepted: skippedByAgreement(workflow) }),
    record: async (aggregate, ran, { at }) => recordTestCommandPins(aggregate, phase, prepared,
      { ran, at, attempts: await recordedRuns(root, config, aggregate, phase) })
  };
}

/**
 * Write the pins of the commands a passing gate ran onto the Story: a new pin at first use, after an
 * accepted re-pin (naming the pin it replaces and the request that admitted it) or a verified return
 * of changed entries to baseline (`restoredToBase`), and a pin's baseline at its first passing run.
 */
export function recordTestCommandPins(workflow, phase, prepared, { ran, at, attempts = [] }) {
  const ranIds = new Set(ran);
  for (const [commandId, entry] of prepared) {
    if (!ranIds.has(commandId)) continue;
    const current = storyPin(workflow, entry.candidate);
    if (current?.sha256 === entry.candidate.sha256) {
      current.baseline ??= firstPassingRun(attempts, current.sha256);
      continue;
    }
    workflow.testCommandPins ??= [];
    const previous = workflow.testCommandPins.filter((pin) => pin.commandId === commandId).at(-1) ?? null;
    workflow.testCommandPins.push({
      id: `TCP-${String(workflow.testCommandPins.length + 1).padStart(3, '0')}`, phase: phase.id,
      ...pinIdentity(entry.candidate),
      ...(previous ? { replaces: previous.id } : {}), ...(entry.acceptedBy ? { acceptedBy: entry.acceptedBy } : {}),
      ...(entry.restoredToBase ? { restoredToBase: true } : {}),
      ...(entry.restoration ? { baselineRestoration: entry.restoration } : {}),
      baseline: firstPassingRun(attempts, entry.candidate.sha256), at
    });
  }
}

/**
 * What a re-pin request records for `command` as the gate resolves it now: the exact pin a person
 * accepts, by digest, and what changed from the pin it replaces. Refuses a command with no pin yet
 * (its first gate run pins it) or one unchanged since it was pinned.
 */
export async function repinRequest(root, config, workflow, phase, command) {
  const reads = await gateReads(root, config, workflow);
  const { entries } = await commandDefinition(root, command, reads);
  const candidate = pinCandidate(phase, command, entries);
  const attempts = await recordedRuns(root, config, workflow, phase);
  const recorded = referencePin(workflow, candidate, attempts);
  const reference = recorded && comparablePin(recorded);
  // An older pin is compared under its own rules, so the request names what changed in what it pinned;
  // the pin a person accepts is the current rules' one.
  const version = reference ? pinVersion(reference) : DEFINITION_VERSION;
  const compared = version === DEFINITION_VERSION ? candidate
    : pinCandidate(phase, command, (await commandDefinition(root, command, { ...reads, version })).entries, { version });
  if (!reference || reference.sha256 === compared.sha256
      || baselineRestoration(root, reference, compared, restorationBase(workflow, phase))) {
    throw new SingularityFlowError(reference
      ? `Test command ${command.id} is unchanged or its changed definition entries were restored to the generation baseline; there is nothing to re-pin.`
      : `Test command ${command.id} is not pinned for this Story yet; its first gate run pins it.`, {
      code: 'TEST_COMMAND_REPIN_UNNEEDED', details: { workId: workflow.workItem?.id ?? null, phase: phase.id,
        nextAction: { command: 'singularity-flow nextsteps --json',
          label: 'Continue from the current workflow state; no re-pin acceptance is needed.' } }
    });
  }
  const { sha256: digest, ...pin } = pinIdentity(candidate);
  const baseCommit = phase.deliveryEvidence?.changeSet?.base?.commit ?? phase.generationIntent?.baseline?.commit
    ?? workflow.workIntervals?.current?.sourceBaseCommit ?? workflow.workItem?.baseCommit ?? null;
  const { scripts } = await commandDefinition(root, command, reads);
  const details = await pinChangeDetails(root, workflow, phase, recorded, compared, { command, scripts, attempts, baseCommit, read: reads.read }).catch(() => null);
  return { commandId: command.id, sha256: digest, pinned: recorded.sha256, pin, changes: pinChanges(reference, compared).map(pinChangeWords),
    ...(details ? { diff: details.diff, dropped: details.dropped, ...(details.pathNarrowing ? { pathNarrowing: details.pathNarrowing } : {}) } : {}) };
}

/**
 * Pending re-pins are reviews of exact definitions, not permanent obligations. A verified return
 * to the existing pin needs no acceptance. Retain the request in history and expose why it is no
 * longer pending; unreadable definitions remain pending, with their actual diagnostic.
 */
export async function pendingTestCommandReviews(root, config, workflow, phase, requests, { commands = null } = {}) {
  const pending = [], inactive = [], bindings = [], unavailable = [];
  if (!requests.some(request => request.repin)) return { pending: requests, inactive, bindings, unavailable };
  try {
    const { read, list } = await gateReads(root, config, workflow);
    commands ??= (await (await import('./local-test-runs.mjs')).resolveStoryLocalTestCommands(root, config, workflow, { phaseId: phase.id })).commands;
    const attempts = await recordedRuns(root, config, workflow, phase);
    const observed = new Map();
    const pendingIdentities = new Map();
    for (const request of requests) {
      if (!request.repin) { pending.push(request); continue; }
      const command = commands.find(entry => entry.id === request.repin.commandId);
      // Removal requests and unavailable commands retain their existing owner route.
      if (request.repin.removed || !command) { pending.push(request); continue; }
      if (!observed.has(command.id)) {
        const definition = await commandDefinition(root, command, { read, list });
        const candidate = pinCandidate(phase, command, definition.entries);
        const recorded = referencePin(workflow, candidate, attempts);
        const reference = recorded && comparablePin(recorded);
        const version = reference ? pinVersion(reference) : DEFINITION_VERSION;
        const compared = version === DEFINITION_VERSION ? candidate
          : pinCandidate(phase, command, (await commandDefinition(root, command, { version, read, list })).entries, { version });
        observed.set(command.id, { candidate, reference, restored: Boolean(reference && reference.sha256 === compared.sha256),
          restoration: !acceptedRepin(workflow, candidate)
            ? baselineRestoration(root, reference, compared, restorationBase(workflow, phase)) : null });
      }
      const { candidate, reference, restored, restoration } = observed.get(command.id);
      const acceptedBy = acceptedRepin(workflow, candidate);
      const identity = canonicalJson({ phase: request.phase, commandId: command.id, repin: request.repin });
      const duplicateOf = pendingIdentities.get(identity);
      const status = restored ? 'original-definition-restored' : restoration ? 'baseline-definition-restored' : acceptedBy ? 'definition-already-accepted'
        : request.repin.sha256 !== candidate.sha256 ? 'definition-changed-since-request'
          : duplicateOf ? 'duplicate-pending-request' : 'pending';
      bindings.push({ request: request.id, status, current: candidate.sha256, reference: reference?.sha256 ?? null,
        ...(restoration ? { baselineRestoration: restoration } : {}) });
      if (status !== 'pending') inactive.push({ request: request.id, phase: request.phase, commandId: command.id, status,
        ...(acceptedBy ? { acceptedBy } : {}), ...(duplicateOf ? { duplicateOf } : {}),
        reason: restored ? 'The current test definition matches its existing pin. No re-pin or human acceptance is required; the unaccepted request remains in history.'
          : restoration ? 'Changed test-definition entries match the generation baseline; all other pinned bindings are unchanged. No re-pin acceptance is required; the request remains in history.'
          : acceptedBy ? 'An existing human decision already accepts this exact definition; this request is not another acceptance.'
            : duplicateOf ? 'The same exact re-pin is already pending under the named request; decide that request once.'
              : 'The current definition differs from this request. Diagnose the current change and review its exact request; this older request cannot admit it.' });
      else { pending.push(request); pendingIdentities.set(identity, request.id); }
    }
  } catch (error) {
    // A read failure is never interpreted as a restored definition or permission to drop a review.
    unavailable.push({ phase: phase.id, reason: error.code ?? 'test-command-definition-unavailable',
      message: error.message, ...(error.details ? { details: error.details } : {}) });
    return { pending: requests, inactive: [], bindings: [{ status: 'unavailable', reason: unavailable[0].reason }], unavailable };
  }
  return { pending, inactive, bindings, unavailable };
}

/**
 * What a request records when the step no longer runs a pinned command: the pin a person agrees no
 * longer runs, by digest, and the command as it was pinned. Null when the Story has no pin of it.
 */
export async function removalRequest(root, config, workflow, phase, commandId) {
  const pinned = (workflow?.testCommandPins ?? []).filter((entry) => entry.commandId === commandId).at(-1)
    ?? (await recordedRuns(root, config, workflow, phase)).find((attempt) => attempt.commandId === commandId && attempt.purpose !== 'local' && attempt.pin?.sha256)?.pin;
  if (!pinned) return null;
  const { sha256: digest, ...pin } = pinIdentity(pinned);
  return {
    repin: { commandId, sha256: digest, pinned: digest, pin, changes: [`removed: ${phase.id} no longer runs it`], removed: true },
    command: { id: commandId, kind: 'test', argv: pinned.argv, workingDirectory: pinned.workingDirectory, affectedRoots: pinned.affectedRoots,
      modelPolicy: 'never', result: { adapter: pinned.adapter } }
  };
}

/**
 * Why one receipt execution's attempt does not replay its pin, or the narrowing a person accepted for
 * it, against the Story (`story`: { workflow, at }).
 */
export async function attemptReplayProblems(story, receipt, execution, attempt) {
  const { skippedByAgreement, testNarrowingReplayProblem } = attempt?.narrowing ? await import('./test-narrowing.mjs') : {};
  const narrowing = attempt?.narrowing ? testNarrowingReplayProblem(story?.workflow ?? null, execution, attempt,
    { phaseId: receipt.phase, at: story?.at, skippedAccepted: skippedByAgreement(story?.workflow) }) : null;
  return [pinReplayProblem(story?.workflow ?? null, attempt), narrowing].filter(Boolean);
}

/** Why a recorded attempt's pin does not replay against its Story, or null [TCE:REQ-014]. */
export function pinReplayProblem(workflow, attempt) {
  if (!attempt?.pin) return null;
  if (!workflow) return `the command pin of ${attempt.commandId} cannot be verified without its Story`;
  const { sha256: digest, ...identity } = pinIdentity(attempt.pin);
  if (`sha256:${recordSha256(identity)}` !== digest) return `the command pin of ${attempt.commandId} differs from its own digest`;
  return (workflow.testCommandPins ?? []).some((pin) => pin.commandId === attempt.commandId && pin.sha256 === attempt.pin.sha256)
    ? null : `${attempt.commandId} ran under a command pin that is not recorded on the Story`;
}
