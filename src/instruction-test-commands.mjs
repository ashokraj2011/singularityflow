/**
 * Test commands a team already wrote down, read when a capability's tests are set up and completed
 * into commands SFlow can run and read [TCE:REQ-060..063].
 *
 * Sources: AGENTS.md, a coding tool's root instruction file (`<TOOL>.md` beside its `.<tool>/` folder,
 * matched by that shape as team import matches it, so no tool is named), .github/copilot-instructions.md,
 * .github/instructions/*.md, skills (SKILL.md under .github/skills, skills/ and every `.<tool>/skills`), CI
 * workflows (`run:` steps of .github/workflows/*.yml), Makefile test targets, scripts/test* and
 * package scripts. Every read is bounded and nothing is executed; no model reads anything, a shell
 * line is parsed by fixed rules. `VAR=x` prefixes become `env`, `cd dir &&` becomes
 * `workingDirectory`, the runner is found under its wrapper (npx, pnpm exec, yarn, ./mvnw, ./gradlew,
 * python -m), and the record is completed with the module its folder belongs to (`affectedRoots`) and
 * the runner's reporter arguments and result, from the inference publication itself uses
 * (code-delivery-tests.mjs, nx-test-targets.mjs). A secret-looking value is never kept: only its name
 * is reported, for singularity/environments.yml. Each candidate keeps its file and line and, when it
 * cannot be completed, says why.
 *
 * A candidate is only ever a proposal. `capability test-setup` previews it, a person confirms it and a
 * configuration approver activates it; team import and Build with Copilot use the same completer for
 * the checks they write, which are reviewed the same way.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

import { declaredMavenModules, inferModuleTestCommand, normalizeRequiredTestCommand, resolveAffectedModule } from './code-delivery-tests.mjs';
import { ENVIRONMENT_DECLARATION_PATH } from './environment-declaration.mjs';
import { normalizeExternalCommand } from './external-command-policy.mjs';
import { classifyCommand, scanGuidanceText } from './guidance-scan.mjs';
import { readRepositoryManifest, repositoryManifestExists } from './repository-manifest.mjs';
import { classifyVariable, looksSecretName, looksSecretValue } from './secret-looking.mjs';
import { blockedPath, EXCLUDED_DIRECTORIES, recognizeFormat } from './team-import/formats.mjs';

const LIMITS = Object.freeze({ files: 200, fileBytes: 256 * 1024, candidates: 200, skillDepth: 3, nxDirectories: 2_000 });
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/su;
const RESULTS = '.sflow/results';
/**
 * The reporter a runner called directly gets: the arguments inference (inferModuleTestCommand) adds to
 * the same runner, its adapter and report extension. A package script or Nx target is completed by
 * inference itself; only a direct call needs this, and a test pins it to inference's arguments. It is
 * kept here rather than shared, because every lifecycle command loads code-delivery-tests.mjs.
 */
const TEST_REPORTERS = Object.freeze({
  jest: { adapter: 'jest-json', extension: 'json', arguments: (report) => ['--json', '--outputFile', report] },
  vitest: { adapter: 'vitest-json', extension: 'json', arguments: (report) => ['--reporter=json', `--outputFile=${report}`] },
  playwright: { adapter: 'playwright-json', extension: 'json', arguments: () => ['--reporter=json'] },
  pytest: { adapter: 'junit-xml', extension: 'xml', arguments: (report) => [`--junitxml=${report}`] },
  go: { adapter: 'go-test-json', extension: 'jsonl', arguments: () => ['-json'] },
  dotnet: { adapter: 'dotnet-trx', extension: null, arguments: (directory) => ['--logger', 'trx', '--results-directory', directory] }
});

/** For the test that pins the reporter arguments to inference's. */
export const DIRECT_RUNNER_REPORTERS = TEST_REPORTERS;
const NODE_SYSTEMS = ['node', 'nx'];
const UNSUPPORTED_TOOLS = new Set(['karma', 'jasmine', 'ava', 'tap', 'tox', 'nox', 'detox', 'phpunit', 'rspec']);
// Runners inference reads only from the package script that runs them, with the word that makes each a test run.
const SCRIPT_RUNNERS = Object.freeze({ mocha: null, cypress: 'run', ng: 'test', 'react-scripts': 'test' });
const PACKAGE_COMMANDS = new Set(['install', 'i', 'ci', 'add', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade', 'audit', 'link',
  'publish', 'pack', 'init', 'create', 'outdated', 'list', 'ls', 'why', 'version', 'config', 'cache', 'dedupe', 'prune', 'rebuild']);
const SCRIPT_NAME = /^(?:test|tests|unit|e2e|integration|spec)(?:[:._-][\w:.-]*)?$|^[\w.-]+[:_-](?:test|tests|unit|e2e|spec)$/iu;
const MAKE_TARGET = /^(?:test|tests|check|unit|e2e|integration|spec)(?:[-_.:][\w.-]+)?$|^[\w.-]+[-_](?:test|tests|e2e)$/iu;

const program = (word) => path.posix.basename(String(word ?? '').replaceAll('\\', '/')).toLowerCase().replace(/\.(?:cmd|exe|bat|ps1)$/u, '');
const plainArgument = (value) => /^[A-Za-z0-9_./:@=+,%-]+$/u.test(value);
const shown = (argv) => argv.map((value) => (plainArgument(value) ? value : `'${value.replaceAll("'", "'\\''")}'`)).join(' ');

/** A record ID from the command as written, the way team import and Build with Copilot name checks. */
export function writtenCommandId(argv, directory = '.') {
  return [directory && directory !== '.' ? directory : null, ...argv].filter(Boolean).join(' ').toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-').replace(/^-+/u, '').slice(0, 60).replace(/-+$/u, '') || 'tests';
}

function inside(base, target) {
  if (typeof target !== 'string' || !target || target.startsWith('/') || target.startsWith('~') || /^[A-Za-z]:/u.test(target) || target.includes('\\')) return null;
  const joined = path.posix.normalize(path.posix.join(base && base !== '.' ? base : '', target));
  return joined === '..' || joined.startsWith('../') ? null : joined.replace(/\/+$/u, '') || '.';
}

/**
 * Shell words of one line: quotes and backslashes resolved, operators kept apart. A word that the
 * shell would expand (`$VAR`, `$(…)`, backticks, unquoted globs, `~`) is `dynamic`: its value is
 * not what would run, so it never becomes a literal argument or variable.
 */
function tokenize(text) {
  const tokens = [];
  let word = null; let dynamic = false; let quotedStart = false;
  const push = () => {
    if (word !== null) tokens.push({ type: 'word', value: word, dynamic, quotedStart });
    word = null; dynamic = false; quotedStart = false;
  };
  for (let index = 0; index < text.length;) {
    const character = text[index];
    if (character === ' ' || character === '\t') { push(); index += 1; continue; }
    if (character === '#' && word === null) break;
    if (character === "'") {
      const end = text.indexOf("'", index + 1);
      if (end < 0) return { error: 'it has an unclosed quote' };
      if (word === null) quotedStart = true;
      word = (word ?? '') + text.slice(index + 1, end);
      index = end + 1;
      continue;
    }
    if (character === '"') {
      let value = ''; let at = index + 1;
      for (; at < text.length && text[at] !== '"'; at += 1) {
        if (text[at] === '\\' && '"\\$`'.includes(text[at + 1] ?? '')) { value += text[at + 1]; at += 1; continue; }
        if (text[at] === '$' || text[at] === '`') dynamic = true;
        value += text[at];
      }
      if (at >= text.length) return { error: 'it has an unclosed quote' };
      if (word === null) quotedStart = true;
      word = (word ?? '') + value;
      index = at + 1;
      continue;
    }
    if (character === '\\') { word = (word ?? '') + (text[index + 1] ?? ''); index += 2; continue; }
    const rest = text.slice(index);
    const operator = /^(?:&&|\|\||>>|&>|>|<<?|\||;|&|\(|\))/u.exec(rest) ?? (word === null ? /^[12]>(?:&[12])?/u.exec(rest) : null);
    if (operator) { push(); tokens.push({ type: 'operator', value: operator[0] }); index += operator[0].length; continue; }
    if ('$`*?['.includes(character) || (character === '~' && word === null)) dynamic = true;
    word = (word ?? '') + character;
    index += 1;
  }
  push();
  return { tokens };
}

/**
 * One written shell line as the plain commands it runs, split at `&&`. `cd DIR` sets the directory
 * of the commands after it, `export NAME=value` and leading `NAME=value` set variables, and `env` is
 * unwrapped. Any other composition (a pipe, `;`, `||`, a redirection, a subshell) is not one
 * command, so the line gives a reason instead. `state` carries `cd` and `export` from one line of a
 * script or code block to the next. Variables are `{ value, dynamic, secret }`.
 */
export function parseCommandLine(text, state = {}) {
  let directory = state.directory === undefined ? '.' : state.directory;
  const env = { ...(state.env ?? {}) };
  const tokenized = tokenize(String(text ?? '').trim().replace(/^[$>]\s+/u, ''));
  if (tokenized.error) return { commands: [], reason: `The line cannot be read as one command: ${tokenized.error}.`, state: { directory, env } };
  const segments = [[]];
  for (const token of tokenized.tokens) {
    if (token.type === 'word') segments.at(-1).push(token);
    else if (token.value === '&&') segments.push([]);
    else return { commands: [], reason: `The line is composed with \`${token.value}\`; a test command is one program with its arguments.`, state: { directory, env } };
  }
  const commands = [];
  for (const words of segments) {
    if (!words.length) continue;
    if (words[0].value === 'cd' && !words[0].quotedStart) {
      const next = words.length === 2 && !words[1].dynamic ? inside(directory ?? '.', words[1].value) : null;
      directory = next;
      if (next == null) return { commands, reason: `\`cd ${words.slice(1).map((word) => word.value).join(' ')}\` does not name a folder inside the repository.`, state: { directory, env } };
      continue;
    }
    if (words[0].value === 'export' && !words[0].quotedStart) {
      for (const word of words.slice(1)) {
        const assignment = !word.quotedStart && ASSIGNMENT.exec(word.value);
        if (assignment) env[assignment[1]] = { value: assignment[2], dynamic: word.dynamic };
      }
      continue;
    }
    let start = words[0].value === 'env' && !words[0].quotedStart ? 1 : 0;
    const assigned = {};
    for (; start < words.length; start += 1) {
      const assignment = !words[start].quotedStart && ASSIGNMENT.exec(words[start].value);
      if (!assignment) break;
      assigned[assignment[1]] = { value: assignment[2], dynamic: words[start].dynamic };
    }
    const argv = words.slice(start);
    // `NAME=value` alone sets a shell variable the next program does not see.
    if (!argv.length) continue;
    commands.push({ argv: argv.map((word) => word.value), dynamic: argv.filter((word) => word.dynamic).map((word) => word.value),
      env: { ...env, ...assigned }, directory });
  }
  return { commands, reason: null, state: { directory, env } };
}

/** Whether a test command's `env` may set this name: the command validator's own rule. */
function settableVariable(name) {
  try { normalizeExternalCommand({ id: 'x', argv: ['x'], env: { [name]: 'x' } }); return true; } catch { return false; }
}

/** The literal variables a command keeps, the secret names it may not keep, and what was left out and why. */
function literalVariables(variables) {
  const env = {}; const secrets = []; const notes = [];
  for (const name of Object.keys(variables).sort()) {
    const { value, dynamic = false, secret = false, scope = null } = variables[name];
    if (secret || classifyVariable(name, String(value ?? '')).kind === 'secret') { secrets.push(name); continue; }
    if (dynamic) { notes.push(`${name} is set from another variable there, so it is not captured; set it in env, or declare it in ${ENVIRONMENT_DECLARATION_PATH}.`); continue; }
    if (!settableVariable(name)) {
      // A CI job's own tool settings (NODE_VERSION) are not the tests' variables; only a line's own are worth a note.
      if (scope !== 'ci') notes.push(`${name} is reserved for the operating system or SFlow, so a test command does not set it; it is left out.`);
      continue;
    }
    if (String(value).length > 4_096 || /[\u0000-\u001f\u007f]/u.test(String(value))) { notes.push(`${name} is not a short literal value; it is left out.`); continue; }
    env[name] = String(value);
  }
  if (secrets.length) {
    notes.push(`${secrets.join(', ')} ${secrets.length === 1 ? 'looks' : 'look'} like ${secrets.length === 1 ? 'a secret' : 'secrets'}, so the value was not read: `
      + `declare ${secrets.length === 1 ? 'it' : 'them'} as a secret in ${ENVIRONMENT_DECLARATION_PATH}, bind it on the machine that runs the tests, and link this command to that environment.`);
  }
  return { env, secrets, notes };
}

function secretArgument(value) {
  const option = /^-{0,2}D?([A-Za-z_][\w.-]*)=(.+)$/su.exec(value);
  if (option && /^\$\{?[A-Za-z_]\w*\}?$/u.test(option[2])) return false;
  return (option && looksSecretName(option[1])) || looksSecretValue(value);
}

/**
 * The program a command runs under its wrappers: npm/pnpm/yarn/bun scripts, npx/bunx, pnpm exec,
 * yarn exec, python -m, uv/poetry/pipenv run. `{ skip: true }` is something that is not a test run
 * (an install, `playwright install`); it is dropped without a candidate.
 */
function recognize(argv, scripts) {
  const first = program(argv[0]);
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(first)) {
    let at = 1; let prefix = null;
    for (; at < argv.length && argv[at].startsWith('-'); at += 1) {
      if (['--prefix', '-C', '--dir', '--cwd'].includes(argv[at])) { prefix = argv[at + 1] ?? null; at += 1; }
      else if (/^--(?:prefix|dir|cwd)=/u.test(argv[at])) prefix = argv[at].replace(/^--[a-z]+=/u, '');
    }
    const sub = argv[at];
    const script = (name, from) => ({ runner: 'script', script: name, extras: argv.slice(from), prefix });
    if (!sub) return { skip: true };
    if (first === 'npm' && ['test', 't', 'tst'].includes(sub)) return script('test', at + 1);
    if (['run', 'run-script', 'rum', 'urn'].includes(sub)) return argv[at + 1] ? script(argv[at + 1], at + 2) : { skip: true };
    if (PACKAGE_COMMANDS.has(sub)) return { skip: true };
    if ((first === 'npm' && ['exec', 'x'].includes(sub)) || (first === 'pnpm' && ['exec', 'dlx'].includes(sub))
        || (first === 'yarn' && ['exec', 'dlx'].includes(sub)) || (first === 'bun' && sub === 'x')) {
      let tool = at + 1;
      while (tool < argv.length && argv[tool].startsWith('-') && argv[tool] !== '--') tool += 1;
      if (argv[tool] === '--') tool += 1;
      return { ...recognizeTool(argv, tool), prefix };
    }
    if (first === 'bun' && sub === 'test') return { reason: 'bun test is Bun\'s own runner, whose results SFlow cannot read yet; give the command in full.' };
    if (first === 'npm' || first === 'bun') return { reason: `\`${argv.slice(0, at + 1).join(' ')}\` is not a test run SFlow recognises.` };
    if (sub === 'test' || sub === 't' || (scripts && Object.hasOwn(scripts, sub))) return script(sub === 't' ? 'test' : sub, at + 1);
    return { ...recognizeTool(argv, at), prefix };
  }
  if (first === 'npx' || first === 'bunx') {
    let tool = 1;
    for (; tool < argv.length && argv[tool].startsWith('-'); tool += 1) {
      if (['-c', '--call'].includes(argv[tool])) return { reason: 'npx -c runs a shell string; give the command it runs instead.' };
      if (['-p', '--package'].includes(argv[tool])) tool += 1;
    }
    return recognizeTool(argv, tool);
  }
  if (/^(?:python[0-9.]*|py)$/u.test(first)) {
    const module = argv.indexOf('-m');
    if (module > 0 && argv[module + 1] === 'pytest') return { runner: 'pytest', at: module + 1 };
    return { reason: 'It runs a Python program that is not pytest; give the command in full with its reporter.' };
  }
  if (['uv', 'poetry', 'pipenv', 'pdm', 'hatch', 'rye'].includes(first) && argv[1] === 'run') return recognizeTool(argv, 2);
  return recognizeTool(argv, 0);
}

function recognizeTool(argv, at) {
  const tool = program(argv[at]);
  const sub = argv[at + 1];
  if (!tool) return { skip: true };
  if (tool === 'playwright') return sub === 'test' ? { runner: 'playwright', at } : { skip: true };
  if (tool === 'jest') return { runner: 'jest', at };
  if (tool === 'vitest') return ['watch', 'dev', 'bench'].includes(sub) ? { skip: true } : { runner: 'vitest', at };
  if (tool === 'pytest' || tool === 'py.test') return { runner: 'pytest', at };
  if (tool === 'mvn' || tool === 'mvnw') return { runner: 'maven', at };
  if (tool === 'gradle' || tool === 'gradlew') return { runner: 'gradle', at };
  if (tool === 'go') return sub === 'test' ? { runner: 'go', at } : { skip: true };
  if (tool === 'dotnet') return sub === 'test' ? { runner: 'dotnet', at } : { skip: true };
  if (tool === 'swift') return sub === 'test' ? { runner: 'swift', at } : { skip: true };
  if (tool === 'nx') return { runner: 'nx', at };
  if (tool === 'node') {
    return argv.slice(at + 1).some((value) => value === '--test' || value.startsWith('--test='))
      ? { runner: 'node-test', at } : { reason: 'It runs a Node program, not node --test; SFlow cannot see which tests it runs.' };
  }
  if (tool === 'cargo') return { reason: 'cargo test needs an explicit command with a structured result adapter (cargo JSON lines); give it in full.' };
  if (tool === 'xcodebuild') return { reason: 'Xcode tests need an approved scheme, destination and result bundle; SFlow never guesses them. Give the command in full.' };
  if (tool === 'make') return { reason: 'It runs a Makefile target; SFlow reads the commands of that target from the Makefile instead.' };
  if (Object.hasOwn(SCRIPT_RUNNERS, tool)) return !SCRIPT_RUNNERS[tool] || sub === SCRIPT_RUNNERS[tool] ? { runner: 'script-runner', tool, at } : { skip: true };
  if (UNSUPPORTED_TOOLS.has(tool)) return { reason: `SFlow does not complete ${tool} commands yet; give the command in full with its reporter and result.` };
  if (/\.(?:sh|ps1|py|js|mjs|cjs)$/u.test(String(argv[at])) || ['bash', 'sh', 'zsh', 'pwsh'].includes(tool)) {
    return { reason: 'It runs a script, and SFlow does not guess what a script runs (it reads scripts/test* itself).' };
  }
  return { reason: `${argv[at]} is not a test runner SFlow recognises.` };
}

/** The module a folder belongs to for this ecosystem, `null` when no build file of it owns the folder. */
async function moduleOf(root, directory, systems) {
  try {
    const module = await resolveAffectedModule(root, path.posix.join(directory === '.' ? '' : directory, '__sflow_instruction__'));
    return systems.includes(module.system) ? module : null;
  } catch (error) {
    const shared = error?.code === 'TEST_MODULE_AMBIGUOUS' ? (error.details?.systems ?? []).find((system) => systems.includes(system)) : null;
    if (shared) return { root: error.details.directory, system: shared, manifest: null };
    if (['TEST_MODULE_UNCOVERED', 'TEST_MODULE_AMBIGUOUS'].includes(error?.code)) return null;
    throw error;
  }
}

/** The command's arguments without the reporter options it brought; SFlow's own reporter replaces them. */
function withoutReporterOptions(argv, notes) {
  const kept = [];
  const valued = new Set(['--reporter', '--outputFile', '--output-file', '--junitxml', '--junit-xml', '--logger', '--results-directory']);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const name = value.split('=')[0];
    if (valued.has(name) || ['--json', '-json'].includes(value)) {
      notes.push(`Its own ${name} option is replaced by the reporter SFlow reads.`);
      if (!value.includes('=') && valued.has(name)) index += 1;
      continue;
    }
    kept.push(value);
  }
  return kept;
}

const resultPath = (from, to) => path.posix.join(path.posix.relative(from === '.' ? '' : from, to === '.' ? '' : to) || '.', '');

/** A direct Node runner (playwright, jest, vitest, node --test) with SFlow's reporter added. */
function nodeRunnerArgv(runner, argv, at, report, notes, { packageScript = false } = {}) {
  // Inside a package script node_modules/.bin is on PATH; outside it the local bin is reached through npx.
  const launcher = packageScript && at === 0 && runner !== 'node-test' ? ['npx', '--no-install'] : [];
  const head = [...launcher, ...argv.slice(0, at + 1)];
  let tail = argv.slice(at + 1);
  if (runner === 'node-test') return [...head, ...tail];
  tail = withoutReporterOptions(tail, notes);
  if (runner === 'vitest' && !tail.some((value) => value === 'run' || value === '--run')) tail = ['run', ...tail];
  return [...head, ...tail, ...TEST_REPORTERS[runner].arguments(report)];
}

/** Arguments after the script name go to the script: after npm's `--`, straight after a yarn script. */
function withScriptArguments(record, extras, notes) {
  const kept = withoutReporterOptions(extras[0] === '--' ? extras.slice(1) : extras, notes);
  if (!kept.length) return record;
  const argv = [...record.argv];
  const separator = argv.indexOf('--');
  if (separator >= 0) argv.splice(separator + 1, 0, ...kept);
  else if (program(argv[0]) === 'yarn') argv.splice(2, 0, ...kept);
  else if (['npm', 'pnpm', 'bun'].includes(program(argv[0]))) argv.splice(argv[1] === 'run' ? 3 : 2, 0, '--', ...kept);
  else return null;
  return { ...record, argv };
}

/** Where an Nx project with this name lives: a bounded walk for its project.json. */
async function nxProjectDirectory(root, name) {
  const queue = ['']; let visited = 0;
  while (queue.length && visited < LIMITS.nxDirectories) {
    const directory = queue.shift();
    visited += 1;
    let entries;
    try { entries = await readdir(path.join(root, directory), { withFileTypes: true }); } catch { continue; }
    if (entries.some((entry) => entry.isFile() && entry.name === 'project.json')) {
      try {
        const project = JSON.parse((await readRepositoryManifest(root, path.posix.join(directory, 'project.json'), { maxBytes: LIMITS.fileBytes })).bytes.toString('utf8'));
        if (project?.name === name) return directory || '.';
      } catch { /* an unreadable project.json names no project */ }
    }
    if (directory.split('/').length > 5) continue;
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && !EXCLUDED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) {
        queue.push(directory ? `${directory}/${entry.name}` : entry.name);
      }
    }
  }
  return null;
}

/** Complete one recognised command; `{ record }` or `{ reason }`, with notes either way. */
/** Inference that declines to guess (rather than fails); the inspection reports these, never throws them. */
const INFERENCE_REFUSALS = new Set(['TEST_MODULE_UNCOVERED', 'TEST_MODULE_AMBIGUOUS', 'GRADLE_TEST_TARGET_REQUIRED', 'RUST_TEST_ADAPTER_REQUIRED', 'XCODE_TEST_TARGET_REQUIRED']);

async function completeRecognized(root, command, recognized, { platform, packageScript, scripts }) {
  const notes = [];
  const directory = recognized.prefix ? inside(command.directory, recognized.prefix) : command.directory;
  if (directory == null) return { reason: 'It runs in a folder outside the repository.', notes };
  const argv = command.argv;
  const record = (fields, affectedRoots) => ({ record: { id: null, kind: 'test', ...fields, affectedRoots, modelPolicy: 'never' }, notes });
  const roots = async (systems, label) => {
    const module = await moduleOf(root, directory, systems);
    if (module) return [module.root];
    notes.push(`No ${label} build file owns ${directory}, so the command covers ${directory} itself.`);
    return [directory];
  };
  // Reports are written below the folder the command runs in, as inference writes them.
  const result = (runner) => ({ adapter: TEST_REPORTERS[runner].adapter, path: `${RESULTS}/${runner}-tests.${TEST_REPORTERS[runner].extension}`, minimumDiscovered: 1 });
  switch (recognized.runner) {
    case 'script': {
      const module = await moduleOf(root, directory, NODE_SYSTEMS);
      if (!module || module.system !== 'node') return { reason: `No package.json owns ${directory}, so there is no '${recognized.script}' script to run.`, notes };
      let manifest = null;
      try { manifest = JSON.parse((await readRepositoryManifest(root, path.posix.join(module.root === '.' ? '' : module.root, 'package.json'))).bytes.toString('utf8')); } catch { /* inference reports it */ }
      if (typeof manifest?.scripts?.[recognized.script] !== 'string') return { reason: `${module.root}/package.json has no '${recognized.script}' script.`.replace(/^\.\//u, ''), notes };
      const inferred = await inferModuleTestCommand(root, { root: module.root, system: 'node', manifest: 'package.json' }, { platform, nodeScript: recognized.script });
      if (inferred) {
        const completed = withScriptArguments(inferred, recognized.extras, notes);
        if (!completed) return { reason: 'The script runs through Nx, which takes no extra arguments here; give the command in full.', notes };
        if (['npm', 'pnpm', 'yarn', 'bun'].includes(program(inferred.argv[0])) && program(inferred.argv[0]) !== program(argv[0])) {
          notes.push(`It runs with ${inferred.argv[0]}, the package manager this module's lockfile names.`);
        }
        const { id: _id, ...fields } = completed;
        return { record: { id: null, ...fields }, notes };
      }
      // A script SFlow cannot infer from its runner may still be one plain runner call: read its text.
      if (!packageScript) {
        const parsed = parseCommandLine(manifest.scripts[recognized.script], { directory: module.root, env: command.env });
        const only = parsed.commands.length === 1 && !parsed.reason ? parsed.commands[0] : null;
        const inner = only ? recognize(only.argv, manifest.scripts) : null;
        if (inner && ['playwright', 'jest', 'vitest'].includes(inner.runner) && !recognized.extras.length) {
          notes.push(`It is the '${recognized.script}' script, run directly: ${shown(only.argv)}.`);
          const completed = await completeRecognized(root, only, inner, { platform, packageScript: true, scripts: manifest.scripts });
          return { ...completed, variables: only.env, notes: [...notes, ...completed.notes] };
        }
      }
      const unread = (await import('./test-module-markers.mjs')).unreadRunnerOfScript(manifest.scripts[recognized.script]);
      return { reason: unread ? `The '${recognized.script}' script runs ${unread}, whose results SFlow cannot read yet; give the command in full with a reporter SFlow reads.`
        : `The '${recognized.script}' script does not run a test runner SFlow reads results from (Jest, Vitest, Mocha, Angular Karma, Playwright, Cypress, node --test).`, notes };
    }
    case 'script-runner': {
      const module = await moduleOf(root, directory, NODE_SYSTEMS);
      const manifestPath = path.posix.join(module?.root && module.root !== '.' ? module.root : '', 'package.json');
      let manifest = null;
      try { manifest = JSON.parse((await readRepositoryManifest(root, manifestPath)).bytes.toString('utf8')); } catch { /* it has no scripts to name */ }
      const words = [recognized.tool, ...(SCRIPT_RUNNERS[recognized.tool] ? [SCRIPT_RUNNERS[recognized.tool]] : [])];
      const plain = argv.length === recognized.at + words.length;
      const script = Object.entries(manifest?.scripts ?? {}).find(([, text]) => typeof text === 'string' && new RegExp(`(?:^|[\\s/])${words.join(' ')}(?:\\s|$)`, 'u').test(text))?.[0] ?? null;
      if (plain && script) {
        notes.push(`The '${script}' script runs it, and SFlow adds its report there.`);
        const completed = await completeRecognized(root, command, { runner: 'script', script, extras: [], prefix: recognized.prefix }, { platform, packageScript, scripts });
        return { ...completed, notes: [...notes, ...completed.notes] };
      }
      return { reason: `SFlow adds ${recognized.tool}'s report through a package script, and ${plain ? `no script in ${manifestPath} runs it` : 'this call has arguments of its own'}. `
        + 'Make a package script run it as written, or give the command in full with its reporter and result.', notes };
    }
    case 'playwright': case 'jest': case 'vitest': {
      return record({ argv: nodeRunnerArgv(recognized.runner, argv, recognized.at, result(recognized.runner).path, notes, { packageScript }),
        workingDirectory: directory, result: result(recognized.runner) }, await roots(NODE_SYSTEMS, 'Node'));
    }
    case 'node-test': return record({ argv: [...argv], workingDirectory: directory,
      result: { adapter: 'node-tap', path: `${RESULTS}/node-tests.tap`, minimumDiscovered: 1 } }, await roots(NODE_SYSTEMS, 'Node'));
    case 'pytest': {
      const report = result('pytest');
      return record({ argv: [...argv.slice(0, recognized.at + 1), ...withoutReporterOptions(argv.slice(recognized.at + 1), notes), ...TEST_REPORTERS.pytest.arguments(report.path)],
        workingDirectory: directory, result: report }, await roots(['python'], 'Python'));
    }
    case 'go': {
      const rest = argv.slice(recognized.at + 2).filter((value) => value !== '-json');
      return record({ argv: [...argv.slice(0, recognized.at + 2), ...TEST_REPORTERS.go.arguments(), ...rest], workingDirectory: directory,
        result: result('go') }, await roots(['go'], 'Go'));
    }
    case 'dotnet': return record({ argv: [...argv.slice(0, recognized.at + 2), ...withoutReporterOptions(argv.slice(recognized.at + 2), notes),
      ...TEST_REPORTERS.dotnet.arguments('TestResults')], workingDirectory: directory,
    result: { adapter: TEST_REPORTERS.dotnet.adapter, path: 'TestResults', minimumDiscovered: 1 } }, await roots(['dotnet'], '.NET'));
    case 'swift': {
      if (argv.length !== recognized.at + 2) return { reason: 'swift test with arguments is not completed; give the command in full with its xunit output.', notes };
      const module = await moduleOf(root, directory, ['swift']);
      if (!module) return { reason: `No Package.swift owns ${directory}.`, notes };
      const { id: _id, ...fields } = await inferModuleTestCommand(root, module, { platform });
      return { record: { id: null, ...fields }, notes };
    }
    case 'maven': return completeMaven(root, argv, recognized.at, directory, notes);
    case 'gradle': return completeGradle(root, argv, recognized.at, directory, notes);
    case 'nx': return completeNx(root, argv, recognized.at, directory, notes, { platform, scripts });
    default: return { reason: 'It is not a test runner SFlow recognises.', notes };
  }
}

async function completeMaven(root, argv, at, directory, notes) {
  const valued = new Set(['-pl', '--projects', '-f', '--file', '-P', '--activate-profiles', '-T', '--threads', '-s', '--settings', '-gs', '--global-settings',
    '-t', '--toolchains', '-l', '--log-file', '-rf', '--resume-from', '-b', '--builder', '-D', '--define']);
  let projects = null; let file = null; const goals = [];
  for (let index = at + 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (valued.has(value)) {
      if (['-pl', '--projects'].includes(value)) projects = argv[index + 1] ?? null;
      if (['-f', '--file'].includes(value)) file = argv[index + 1] ?? null;
      index += 1;
    } else if (!value.startsWith('-')) goals.push(value);
  }
  if (!goals.some((goal) => ['test', 'verify', 'install', 'package', 'integration-test', 'deploy'].includes(goal))) {
    return { reason: 'It runs no Maven phase that runs tests (test, verify, install).', notes };
  }
  if (projects && (projects.includes(',') || projects.includes(':'))) {
    return { reason: `It builds the modules ${projects} by list or artifact; propose one command per module folder.`, notes };
  }
  const module = inside(directory, projects ?? (file ? path.posix.dirname(file) : '.'));
  if (!module || !await repositoryManifestExists(root, path.posix.join(module === '.' ? '' : module, 'pom.xml'))) {
    return { reason: `No pom.xml is at ${module ?? projects ?? file}, the module it builds.`, notes };
  }
  const pom = path.posix.join(module === '.' ? '' : module, 'pom.xml');
  if (declaredMavenModules((await readRepositoryManifest(root, pom)).bytes.toString('utf8')).length) {
    return { reason: `${pom} is a reactor: each module writes its own reports, and one report path cannot read them all. Propose one command per module folder (-pl <module> -am).`, notes };
  }
  return { record: { id: null, kind: 'test', argv: [...argv], workingDirectory: directory, affectedRoots: [module], modelPolicy: 'never',
    result: { adapter: 'junit-xml', path: path.posix.join(resultPath(directory, module), 'target/surefire-reports'), minimumDiscovered: 1 } }, notes };
}

async function completeGradle(root, argv, at, directory, notes) {
  const valued = new Set(['-p', '--project-dir', '-x', '--exclude-task', '--tests', '-c', '--settings-file', '-b', '--build-file', '-I', '--init-script',
    '-g', '--gradle-user-home', '--console', '--warning-mode', '--max-workers', '--priority']);
  let projectDirectory = '.'; const tasks = [];
  for (let index = at + 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (valued.has(value)) { if (['-p', '--project-dir'].includes(value)) projectDirectory = argv[index + 1] ?? '.'; index += 1; }
    else if (!value.startsWith('-')) tasks.push(value);
  }
  const testing = [...new Set(tasks.filter((task) => /(?:^|:)(?:test|check|build)$/u.test(task)).map((task) => task.replace(/:?(?:test|check|build)$/u, '')))];
  if (!testing.length) return { reason: 'It runs no Gradle task that runs tests (test, check, build).', notes };
  if (testing.length > 1) return { reason: `It tests several projects (${testing.map((entry) => entry || '.').join(', ')}); propose one command per project.`, notes };
  const module = inside(inside(directory, projectDirectory) ?? '.', testing[0].replace(/^:/u, '').replaceAll(':', '/') || '.');
  const base = module === '.' ? '' : module;
  if (!module || !(await repositoryManifestExists(root, path.posix.join(base, 'build.gradle')) || await repositoryManifestExists(root, path.posix.join(base, 'build.gradle.kts')))) {
    return { reason: `No build.gradle is at ${module ?? testing[0]}; a custom project layout is not guessed.`, notes };
  }
  return { record: { id: null, kind: 'test', argv: [...argv], workingDirectory: directory, affectedRoots: [module], modelPolicy: 'never',
    result: { adapter: 'junit-xml', path: path.posix.join(resultPath(directory, module), 'build/test-results/test'), minimumDiscovered: 1 } }, notes };
}

async function completeNx(root, argv, at, directory, notes, { platform }) {
  const rest = argv.slice(at + 1).filter((value) => !value.startsWith('-'));
  const [project, target] = rest[0] === 'run' ? String(rest[1] ?? '').split(':') : [rest[1], rest[0]];
  if (['affected', 'run-many'].includes(rest[0]) || !project || !target) return { reason: 'It runs several Nx projects; propose each project\'s target on its own.', notes };
  const projectDirectory = await nxProjectDirectory(root, project);
  if (!projectDirectory) return { reason: `No project.json names the Nx project '${project}'.`, notes };
  const inferred = await inferModuleTestCommand(root, { root: projectDirectory, system: 'nx', manifest: 'project.json' }, { platform, nodeScript: target === 'test' ? 'test' : 'e2e' });
  if (!inferred?.argv.includes(`${project}:${target}`)) return { reason: `SFlow infers no structured result for ${project}:${target}; give the command in full.`, notes };
  if (inferred.workingDirectory !== directory) notes.push(`Nx runs it from the workspace root, ${inferred.workingDirectory}.`);
  const { id: _id, ...fields } = inferred;
  return { record: { id: null, ...fields }, notes };
}

/**
 * Complete one written test command (`text`, or an `argv` whose leading `NAME=value` words are
 * variables) into a full record [TCE:REQ-062]: `{ command, runner, env, secrets, notes }`, or
 * `{ reason, secrets, notes }` when it cannot be completed, or `null` when it is not a test run at
 * all. `directory` is the folder it is written for, relative to the repository root. `id` names the
 * record; by default it is made from the command as written.
 */
export async function completeWrittenTestCommand(root, { text = null, argv = null, directory = '.', env = {}, id = null } = {}, {
  platform = process.platform, packageScript = false, scripts = null, anyRunner = false
} = {}) {
  const written = argv ? argv.map((value) => {
    const assignment = ASSIGNMENT.exec(value);
    if (plainArgument(value)) return value;
    const quote = (part) => `'${part.replaceAll("'", "'\\''")}'`;
    return assignment ? `${assignment[1]}=${quote(assignment[2])}` : quote(value);
  }).join(' ') : text;
  const parsed = parseCommandLine(written, { directory, env });
  if (parsed.reason) return { reason: parsed.reason, secrets: [], notes: [] };
  const tests = parsed.commands.filter((command) => classifyCommand(command.argv.join(' ')) === 'test'
    || (anyRunner && recognize(command.argv, scripts).runner === 'script'));
  const command = tests.at(-1);
  if (!command) return null;
  const notes = tests.length > 1 ? [`The line runs ${tests.length} test commands; this is the last, ${shown(command.argv)}.`] : [];
  const refuse = (reason, runner = null) => {
    const variables = literalVariables(command.env);
    return { ...(runner ? { runner } : {}), reason, secrets: variables.secrets, notes: [...variables.notes, ...notes] };
  };
  if (command.directory == null) return refuse('The folder it runs in is set by a shell expression, so it is not known.');
  if (command.dynamic.length) return refuse(`It uses ${command.dynamic.map((value) => `\`${value}\``).join(', ')}, which the shell expands, so the exact arguments are not known.`);
  if (command.argv.some(secretArgument)) return refuse(`An argument looks like a secret, so it was not read; pass it through ${ENVIRONMENT_DECLARATION_PATH} instead.`);
  const recognized = recognize(command.argv, scripts);
  if (recognized.skip) return null;
  if (recognized.reason) return refuse(recognized.reason);
  // A written command inference cannot complete is a candidate with its reason, never a refusal of the
  // whole inspection: an ambiguous package refused the very inspection its refusal names (2026-10-29).
  let completed;
  try { completed = await completeRecognized(root, command, recognized, { platform, packageScript, scripts }); }
  catch (error) {
    if (!INFERENCE_REFUSALS.has(error.code)) throw error;
    return refuse(error.message);
  }
  // A package script read as its runner call brings the variables that script sets.
  const variables = literalVariables({ ...command.env, ...(completed.variables ?? {}) });
  const base = { runner: recognized.runner, secrets: variables.secrets, notes: [...variables.notes, ...notes, ...completed.notes] };
  if (!completed.record) return { ...base, reason: completed.reason };
  const record = { id: id ?? writtenCommandId(command.argv, command.directory), kind: 'test', argv: completed.record.argv,
    ...(Object.keys(variables.env).length ? { env: variables.env } : {}), workingDirectory: completed.record.workingDirectory,
    affectedRoots: completed.record.affectedRoots, modelPolicy: 'never', result: completed.record.result };
  // The same contract publication holds a test command to: argv, a structured report, nothing suppressed.
  try { normalizeRequiredTestCommand(record); }
  catch (error) { return { ...base, reason: String(error?.message ?? error) }; }
  return { ...base, command: record };
}

// --- Reading the sources -----------------------------------------------------------------------

async function directoryEntries(root, relative) {
  try { return await readdir(path.join(root, relative), { withFileTypes: true }); } catch { return []; }
}

/** The files read, in a fixed order, each with what it is and the folder its commands are written for. */
async function instructionFiles(root, sourceRoots) {
  const files = []; const seen = new Set();
  const add = (file, kind, base) => {
    if (seen.has(file) || blockedPath(file)) return;
    seen.add(file);
    files.push({ file, kind, base });
  };
  const folders = [...new Set(['.', ...sourceRoots])];
  for (const folder of folders) {
    const prefix = folder === '.' ? '' : `${folder}/`;
    const names = new Set((await directoryEntries(root, folder)).filter((entry) => entry.isFile()).map((entry) => entry.name));
    if (names.has('AGENTS.md')) add(`${prefix}AGENTS.md`, 'agents-md', folder);
    // `<TOOL>.md` beside `.<tool>/` is that tool's instruction file (team-import/formats.mjs).
    const tools = new Set((await directoryEntries(root, folder)).filter((entry) => entry.isDirectory() && entry.name.startsWith('.')).map((entry) => entry.name.slice(1)));
    for (const name of [...names].sort()) if (recognizeFormat(name, tools) === 'tool-instructions') add(`${prefix}${name}`, 'tool-instructions', folder);
    for (const name of ['Makefile', 'makefile', 'GNUmakefile']) if (names.has(name)) add(`${prefix}${name}`, 'makefile', folder);
    if (names.has('package.json')) add(`${prefix}package.json`, 'package-script', folder);
    for (const entry of await directoryEntries(root, `${prefix}scripts`)) {
      if (entry.isFile() && /^test/iu.test(entry.name)) add(`${prefix}scripts/${entry.name}`, 'script', folder);
    }
  }
  const github = new Set((await directoryEntries(root, '.github')).map((entry) => entry.name));
  if (github.has('copilot-instructions.md')) add('.github/copilot-instructions.md', 'copilot-instructions', '.');
  for (const entry of await directoryEntries(root, '.github/instructions')) {
    if (entry.isFile() && /\.md$/iu.test(entry.name)) add(`.github/instructions/${entry.name}`, 'instructions', '.');
  }
  for (const entry of await directoryEntries(root, '.github/workflows')) {
    if (entry.isFile() && /\.ya?ml$/iu.test(entry.name)) add(`.github/workflows/${entry.name}`, 'ci-workflow', '.');
  }
  const skillFolders = ['skills', ...(await directoryEntries(root, '.')).filter((entry) => entry.isDirectory() && entry.name.startsWith('.')
    && !EXCLUDED_DIRECTORIES.has(entry.name) && !['.git', '.sflow'].includes(entry.name)).map((entry) => `${entry.name}/skills`)];
  const walk = async (folder, depth) => {
    for (const entry of await directoryEntries(root, folder)) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isFile() && entry.name === 'SKILL.md') add(`${folder}/SKILL.md`, 'skill', '.');
      else if (entry.isDirectory() && depth < LIMITS.skillDepth && !EXCLUDED_DIRECTORIES.has(entry.name)) await walk(`${folder}/${entry.name}`, depth + 1);
    }
  };
  for (const folder of skillFolders.sort()) await walk(folder, 1);
  return { list: files.slice(0, LIMITS.files), truncated: files.length > LIMITS.files };
}

function scalarLines(node, text, lineCounter) {
  const start = lineCounter.linePos(node.range[0]).line;
  const block = node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED';
  const value = String(node.value ?? '');
  const lines = node.type === 'BLOCK_FOLDED' ? [value.replace(/\n/gu, ' ')] : value.split('\n');
  return lines.map((line, index) => ({ text: line, line: start + (block ? 1 : 0) + (node.type === 'BLOCK_FOLDED' ? 0 : index) }));
}

/** Literal variables of a CI scope: a `${{ secrets.X }}` value is a secret name, any other expression is not literal. */
function ciVariables(map) {
  const variables = {};
  if (!YAML.isMap(map)) return variables;
  for (const pair of map.items) {
    const name = String(pair.key?.value ?? pair.key ?? '');
    const value = YAML.isScalar(pair.value) ? String(pair.value.value ?? '') : '';
    if (!name) continue;
    variables[name] = /\$\{\{\s*secrets\./u.test(value) ? { value: '', secret: true, scope: 'ci' } : { value, dynamic: /\$\{\{/u.test(value), scope: 'ci' };
  }
  return variables;
}

/** Each written command line of one source: `{ text, line, directory, env }`. */
function writtenLines(source, text) {
  const lines = [];
  if (['agents-md', 'tool-instructions', 'copilot-instructions', 'instructions', 'skill'].includes(source.kind)) {
    for (const found of scanGuidanceText(text).commands) {
      if (found.category !== 'test') continue;
      lines.push({ text: found.command, line: found.line, directory: inside(source.base, found.directory ?? '.'),
        shown: found.directory ? `cd ${found.directory} && ${found.command}` : found.command });
    }
    return lines;
  }
  if (source.kind === 'ci-workflow') {
    const lineCounter = new YAML.LineCounter();
    let document;
    try { document = YAML.parseDocument(text, { lineCounter }); } catch { return lines; }
    if (document.errors.length) return lines;
    const workflowEnv = ciVariables(document.get('env', true));
    const jobs = document.get('jobs', true);
    for (const job of YAML.isMap(jobs) ? jobs.items : []) {
      if (!YAML.isMap(job.value)) continue;
      const jobEnv = { ...workflowEnv, ...ciVariables(job.value.get('env', true)) };
      const defaults = job.value.getIn(['defaults', 'run', 'working-directory']);
      const steps = job.value.get('steps', true);
      for (const step of YAML.isSeq(steps) ? steps.items : []) {
        if (!YAML.isMap(step)) continue;
        const run = step.get('run', true);
        if (!YAML.isScalar(run)) continue;
        const shell = String(step.get('shell') ?? 'bash');
        if (!/^(?:bash|sh)\b/u.test(shell)) continue;
        const workingDirectory = String(step.get('working-directory') ?? defaults ?? '.');
        const env = { ...jobEnv, ...ciVariables(step.get('env', true)) };
        let state = { directory: inside('.', workingDirectory), env: {} };
        let pending = null;
        for (const entry of scalarLines(run, text, lineCounter)) {
          const joined = pending ? { ...pending, text: `${pending.text} ${entry.text.trim()}` } : entry;
          if (/\\\s*$/u.test(joined.text)) { pending = { ...joined, text: joined.text.replace(/\\\s*$/u, '') }; continue; }
          pending = null;
          if (!joined.text.trim()) continue;
          lines.push({ text: joined.text, line: joined.line, directory: state.directory, env: { ...env, ...state.env } });
          state = parseCommandLine(joined.text, state).state;
        }
      }
    }
    return lines;
  }
  const all = text.split(/\r?\n/u);
  if (source.kind === 'makefile') {
    for (let index = 0; index < all.length; index += 1) {
      const target = /^([A-Za-z0-9_.\-/ ]+?)\s*:(?![:=])/u.exec(all[index]);
      if (!target || all[index].startsWith('\t') || !target[1].split(/\s+/u).some((name) => MAKE_TARGET.test(name))) continue;
      for (let at = index + 1; at < all.length && (all[at].startsWith('\t') || !all[at].trim()); at += 1) {
        let recipe = all[at].replace(/^\t+/u, '');
        const line = at + 1;
        while (/\\\s*$/u.test(recipe) && at + 1 < all.length) { at += 1; recipe = `${recipe.replace(/\\\s*$/u, '')} ${all[at].trim()}`; }
        recipe = recipe.replace(/^[@+-]+/u, '').trim();
        // Each recipe line runs in a shell of its own, from the Makefile's folder; `$(X)` is make's.
        if (recipe) lines.push({ text: recipe.replace(/\$\(([^)]*)\)|\$\{([^}]*)\}/gu, '$$$1$2'), line, directory: source.base });
      }
    }
    return lines;
  }
  if (source.kind === 'script') {
    let state = { directory: source.base, env: {} };
    all.forEach((raw, index) => {
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith('#') || /^set\s+-/u.test(trimmed)) return;
      // The usual first line of a repository script: run from the repository root.
      if (/^cd\s+"?\$\(dirname\s+"?\$\{?0\}?"?\)"?(?:\/\.\.)?"?\/?$/u.test(trimmed)) { state = { ...state, directory: source.base }; return; }
      lines.push({ text: trimmed, line: index + 1, directory: state.directory, env: state.env });
      state = parseCommandLine(trimmed, state).state;
    });
    return lines;
  }
  if (source.kind === 'package-script') {
    let manifest;
    try { manifest = JSON.parse(text); } catch { return lines; }
    for (const name of Object.keys(manifest?.scripts ?? {})) {
      if (!SCRIPT_NAME.test(name) || /^(?:pre|post)/u.test(name) || typeof manifest.scripts[name] !== 'string') continue;
      const line = all.findIndex((entry) => entry.includes(JSON.stringify(name))) + 1;
      lines.push({ text: name === 'test' ? 'npm test' : `npm run ${name}`, line: line || 1, directory: source.base, scripts: manifest.scripts });
    }
  }
  return lines;
}

/** The text as it was written, with every secret-looking value replaced, so nothing secret is repeated. */
function redacted(text, written) {
  let safe = String(text);
  const parsed = parseCommandLine(safe, { directory: '.', env: {} });
  for (const command of parsed.commands) {
    for (const [name, variable] of Object.entries(command.env)) {
      if (variable.value && classifyVariable(name, variable.value).kind === 'secret') safe = safe.split(variable.value).join('***');
    }
    for (const value of command.argv) if (secretArgument(value)) safe = safe.split(value.replace(/^[^=]*=/u, '')).join('***');
  }
  for (const [name, variable] of Object.entries(written.env ?? {})) {
    if (variable.value && classifyVariable(name, variable.value).kind === 'secret') safe = safe.split(variable.value).join('***');
  }
  return safe.slice(0, 300);
}

/**
 * Read and complete the test commands written in the repository's instructions, skills, CI
 * workflows, Makefiles, scripts/test* and package scripts [TCE:REQ-061..063]. `sourceRoots` are the
 * module folders being set up: their own AGENTS.md, tool instruction file, Makefile, scripts and package.json
 * are read beside the repository's. Returns `{ candidates, sources, truncated }`; a candidate is
 * `{ id, status: 'complete'|'incomplete', source: { kind, file, line }, written, runner?, command?,
 * reason?, secrets?, notes? }`.
 */
export async function readInstructionTestCommands(root, { sourceRoots = ['.'], platform = process.platform } = {}) {
  const files = await instructionFiles(root, sourceRoots);
  const candidates = []; const keys = new Set(); const ids = new Set();
  let truncated = files.truncated;
  for (const source of files.list) {
    let text;
    try { text = (await readRepositoryManifest(root, source.file, { maxBytes: LIMITS.fileBytes })).bytes.toString('utf8'); } catch { continue; }
    for (const written of writtenLines(source, text)) {
      if (candidates.length >= LIMITS.candidates) { truncated = true; break; }
      if (written.directory == null) continue;
      if (source.kind !== 'package-script' && classifyCommand(written.text) !== 'test') continue;
      const completed = await completeWrittenTestCommand(root, { text: written.text, directory: written.directory, env: written.env ?? {} },
        { platform, scripts: written.scripts ?? null, anyRunner: source.kind === 'package-script' });
      if (!completed) continue;
      const key = JSON.stringify(completed.command ? [completed.command.argv, completed.command.env ?? {}, completed.command.workingDirectory] : [source.file, written.line]);
      if (keys.has(key)) continue;
      keys.add(key);
      const stem = completed.command?.id ?? writtenCommandId(parseCommandLine(written.text).commands.at(-1)?.argv ?? [written.text], written.directory);
      let id = stem;
      for (let index = 2; ids.has(id); index += 1) id = `${stem}-${index}`;
      ids.add(id);
      candidates.push({
        id, status: completed.command ? 'complete' : 'incomplete',
        source: { kind: source.kind, file: source.file, line: written.line },
        written: redacted(written.shown ?? written.text, written),
        ...(completed.runner ? { runner: completed.runner } : {}),
        ...(completed.command ? { command: { ...completed.command, id } } : { reason: completed.reason }),
        ...(completed.secrets.length ? { secrets: completed.secrets } : {}),
        ...(completed.notes.length ? { notes: completed.notes } : {})
      });
    }
  }
  return { candidates, sources: files.list.map((entry) => entry.file), truncated };
}
