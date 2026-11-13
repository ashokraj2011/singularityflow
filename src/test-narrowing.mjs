/**
 * Narrowed test runs [TCE:REQ-020].
 *
 * A gate run proves a module only when it ran the module's tests. Focused tests (`.only`, `fit`,
 * `fdescribe`), filters (`-k`, `-m`, `--grep`, `-t`, `-Dtest`, `--shard`, …) in the command or in
 * the pinned script behind it, skipped tests, and fewer tests than the first passing run of the
 * same pin in this Story all passed before. Each gate run now records `narrowing` on its attempt
 * [TCE:REQ-021], and a narrowed run that passed is refused with CODE_TEST_NARROWED, naming each
 * reason [TCE:REQ-022], unless a person who approves the step accepted that narrowing
 * (`decision test-narrowing`) [TCE:REQ-023]. The decision is bound to the command's pin and to the
 * narrowing it saw, and covers a later run of the same pin whose narrowing is the same or smaller:
 * no new filter or focused test, no more skipped tests, no larger shortfall below the baseline.
 * Decisions and revocations are append-only in `workflow.testNarrowings`; the review packet and the
 * test summary show an accepted narrowing with its reason [TCE:REQ-024]. Pure apart from reading the
 * changed test files for focused tests, and the base commit's scripts and test files.
 *
 * Narrowing is what the Story adds (owner decision, 2026-10-25): a filter already in the same script
 * on the Story's base commit (one a guessed command carries in its argv, in every script that has it
 * now), or a focused test already in the base version of a test file, is the
 * team's own setup, recorded as `standing` and never a reason; skipped tests are a reason only when
 * the Story's changed test files add skip markers or a run skips more than the pin's first passing run.
 *
 * A path a script names is a narrowing the same way (owner decision, 2026-11-06), but only when it drops
 * something: the base commit's test files that the same script reached and it no longer does. With none
 * left out it is recorded on the attempt (`paths`) and shown, and refuses nothing, so bin-opr's
 * `vitest run src` with every test under src passes while `jest src/one` is a person's decision. A file the
 * base commit's own runner configuration never collected was never reached (src/test-collection-limits.mjs).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { committedFilesAtRevisions, committedTreePaths } from './git.mjs';
import { readRepositoryManifest } from './repository-manifest.mjs';
import { NODE_TEXT_DIGESTS } from './records.mjs';
import {testNarrowingPolicies} from './kernel/test-recovery.mjs';
import { countedRecords } from './presence/counted.mjs';
import { collectionConfigNames, collectionLimit } from './test-collection-limits.mjs';
import { commandTokens, launcherName, packageScriptName, shellSegments } from './test-command-pins.mjs';
import { selectingRunner, SELECTING_RUNNERS } from './test-runners.mjs';
import { SingularityFlowError } from './util.mjs';
import { tokenizeJavaScript } from './verification/javascript-declarations.mjs';

const narrowingValues=testNarrowingPolicies(NODE_TEXT_DIGESTS);
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_FOCUS_FILES = 256;
const JAVASCRIPT = /\.(?:[cm]?[jt]sx?)$/iu;
const SUITES = new Set(['describe', 'context', 'suite', 'it', 'test', 'specify']);
// The options that select a subset of a runner's tests [TCE:REQ-021], from its row. `--project` is a person's
// choice in a configured or accepted command, and a narrowing only in a guessed one.
const GENERIC_FILTERS = Object.freeze(['--grep', '--testNamePattern', '--testPathPattern', '--shard', '--only', '--filter', '--tests', '--test-name-pattern', '--test-only']);
const FILTERS = Object.freeze({ ...Object.fromEntries(Object.entries(SELECTING_RUNNERS).map(([key, row]) => [key, row.filters])), generic: GENERIC_FILTERS });
const VALUELESS = new Set([...Object.values(SELECTING_RUNNERS).flatMap((row) => row.valueless), '--only']);

/** The runner one command runs and the arguments it receives; `script` for npm/pnpm/yarn/bun scripts. */
function runnerOf(tokens) {
  const name = launcherName(tokens[0]);
  if (['npx', 'pnpx', 'bunx'].includes(name)) {
    const at = tokens.slice(1).findIndex((token) => !token.startsWith('-'));
    return at < 0 ? { runner: 'generic', args: [] } : runnerOf(tokens.slice(at + 1));
  }
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(name) && ['exec', 'dlx', 'x'].includes(tokens[1])) return runnerOf(tokens.slice(2));
  if (packageScriptName(tokens)) return { runner: 'script', args: tokens.slice(1) };
  if (['python', 'python3', 'py'].includes(name)) {
    const at = tokens.findIndex((token, index) => tokens[index - 1] === '-m');
    return tokens[at] === 'pytest' ? { runner: 'pytest', args: tokens.slice(at + 1) } : { runner: 'generic', args: tokens.slice(1) };
  }
  return { runner: selectingRunner(name) ?? 'generic', args: tokens.slice(1) };
}

function optionFilters(args, runner, source, { inferred }) {
  const options = FILTERS[runner] ?? FILTERS.generic;
  const found = [];
  for (const [index, token] of args.entries()) {
    for (const option of options) {
      if (option === '--project' && !inferred) continue;
      if (token === option) {
        const next = args[index + 1];
        found.push({ option, value: VALUELESS.has(option) || next === undefined || next.startsWith('-') ? null : next, source });
      } else if (token.startsWith(`${option}=`)) found.push({ option, value: token.slice(option.length + 1), source });
    }
  }
  return found;
}

/** The runner that receives arguments appended to package script `name`: its last command's. */
function forwardedRunner(scripts, name, depth = 0) {
  const text = scripts.get(name);
  const last = text == null ? null : commandTokens(shellSegments(text).at(-1) ?? []);
  if (!last?.length || depth > 8) return 'generic';
  const { runner } = runnerOf(last);
  return runner === 'script' ? forwardedRunner(scripts, packageScriptName(last), depth + 1) : runner;
}

/**
 * The test-selecting options in a command's argv and in the scripts its pin resolves through,
 * each with where it was written. Arguments after `--` reach the script's runner.
 */
export function commandFilters(argv, scripts = [], { inferred = false } = {}) {
  const byName = new Map(scripts.map((script) => [String(script.source ?? '').split('#scripts.')[1], script.text]));
  const filters = [];
  const segment = (tokens, source, fallback) => {
    const { runner, args } = runnerOf(commandTokens(tokens));
    if (runner !== 'script') return optionFilters(args, runner, source, { inferred });
    const at = args.indexOf('--');
    return at < 0 ? [] : optionFilters(args.slice(at + 1), fallback, source, { inferred });
  };
  filters.push(...segment((argv ?? []).map(String), 'argv', forwardedRunner(byName, packageScriptName((argv ?? []).map(String)))));
  for (const script of scripts) {
    for (const tokens of shellSegments(script.text)) filters.push(...segment(tokens, script.source, 'generic'));
  }
  return filters;
}

/** Focused declarations (`describe.only`, `it.only`, `test.only`, `fit`, `fdescribe`) in one source text. */
export function focusedDeclarations(text) {
  let tokens;
  try { tokens = tokenizeJavaScript(text); } catch {
    // Unreadable as JavaScript: still find the plain call forms, line by line.
    return String(text).split(/\r?\n/u).flatMap((line, index) => (/(?:^|[^.\w$])(?:(?:describe|context|suite|it|test|specify)\.only|fdescribe|fit)\s*\(/u.test(line)
      ? [{ line: index + 1, name: null }] : []));
  }
  const found = [];
  const code = tokens.filter((token) => token.type !== 'comment');
  for (const [index, token] of code.entries()) {
    if (token.type !== 'identifier' || code[index - 1]?.value === '.') continue;
    let open = -1;
    if (SUITES.has(token.value) && code[index + 1]?.value === '.' && code[index + 2]?.value === 'only' && code[index + 3]?.value === '(') open = index + 3;
    else if (['fit', 'fdescribe'].includes(token.value) && code[index + 1]?.value === '(') open = index + 1;
    if (open < 0) continue;
    const title = code[open + 1];
    found.push({ line: token.line, name: ['string', 'template'].includes(title?.type) ? title.value ?? null : null });
  }
  return found;
}

/** Focused tests in the changed test files a command covers, each with its file, line and title. */
export async function focusedTests(root, files) {
  const focused = [];
  for (const file of [...new Set(files)].filter((entry) => JAVASCRIPT.test(entry)).sort().slice(0, MAX_FOCUS_FILES)) {
    let text;
    try { text = (await readRepositoryManifest(root, file, { maxBytes: MAX_SOURCE_BYTES })).bytes.toString('utf8'); } catch { continue; }
    focused.push(...focusedDeclarations(text).map((entry) => ({ path: file, ...entry })));
  }
  return focused;
}

const covered = (file, roots) => (roots ?? []).some((root) => root === '.' || file === root || file.startsWith(`${root.replace(/\/$/u, '')}/`));

// Skip markers in a test source, by language: `it.skip(`, `{ skip: true }`, `xit(`, `test.fixme(`, `@pytest.mark.skip`,
// `@unittest.skip`, `pytest.skip(`, `@Disabled`, `@Ignore`, `[Ignore]`, `Skip = "…"`, `t.Skip(`.
const SKIP_MARKER = /\b(?:describe|context|suite|it|test|specify)\.(?:skip|fixme)\s*\(|\bx(?:it|test|describe|context)\s*\(|\{\s*skip\s*:\s*(?!false\b)|@pytest\.mark\.skip(?:if)?\b|@unittest\.skip\w*|\bpytest\.skip\s*\(|@(?:Disabled|Ignore)\b|\[Ignore\b|\bSkip\s*=\s*"|\bt\.Skip(?:f|Now)?\s*\(/gu;
const skipMarkers = (text) => (String(text ?? '').match(SKIP_MARKER) ?? []).length;
const filterAt = (filter) => `${filter.source}|${filter.option}=${filter.value ?? ''}`;

/** The base commit's text of each file a command's scripts, or the changed test files, came from. */
function baseTexts(root, baseCommit, files) {
  if (!baseCommit || !files.length) return new Map();
  try {
    return new Map([...committedFilesAtRevisions(root, [...new Set(files)].map((file) => ({ key: file, ref: baseCommit, path: file })),
      { maximumObjectBytes: MAX_SOURCE_BYTES, maximumBytes: 8 * MAX_SOURCE_BYTES })].map(([file, bytes]) => [file, bytes.toString('utf8')]));
  } catch { return new Map(); }
}

/** The same scripts as they stood on the base commit (`dir/package.json#scripts.name`), where they did. */
function baseScripts(texts, scripts) {
  return scripts.flatMap((script) => {
    const [file, name] = String(script.source ?? '').split('#scripts.');
    if (!name || !texts.has(file)) return [];
    let parsed;
    try { parsed = JSON.parse(texts.get(file)); } catch { return []; }
    const text = parsed?.scripts?.[name];
    return typeof text === 'string' ? [{ ...script, text }] : [];
  });
}

/** The scripts of a package.json's text, by name. */
function packageScripts(text) {
  let parsed = null;
  try { parsed = JSON.parse(text ?? 'null'); } catch { /* not readable there: it has none */ }
  return new Map(Object.entries(parsed?.scripts ?? {}).filter(([, script]) => typeof script === 'string'));
}

/**
 * What a gate knows before a command runs: the filters and focused tests this Story added (those already
 * on the base commit are `standing`), the skip markers its changed test files added, and the pin's baseline.
 */
export async function narrowingFacts(root, command, { scripts = [], testPaths = [], baseline = null, inferred = false, baseCommit = null, acceptedPaths = [] } = {}) {
  const tests = testPaths.filter((file) => covered(file, command.affectedRoots));
  const scriptFiles = scripts.map((script) => String(script.source ?? '').split('#scripts.')[0]).filter((file) => file && file !== 'argv');
  const filters = commandFilters(command.argv, scripts, { inferred });
  // A guessed command that runs a script's runner alone carries that script's own filters in its argv.
  const carried = inferred ? filters.filter((filter) => filter.source === 'argv') : [];
  const manifest = carried.length ? path.posix.join(command.workingDirectory ?? '.', 'package.json') : null;
  const base = baseTexts(root, baseCommit, [...scriptFiles, ...(manifest ? [manifest] : []),
    ...tests.filter((file) => JAVASCRIPT.test(file) || /\.(?:py|java|kt|cs|go)$/iu.test(file))]);
  const standingFilters = new Set(baseCommit ? commandFilters(command.argv, baseScripts(base, scripts), { inferred })
    .filter((filter) => filter.source !== 'argv').map(filterAt) : []);
  if (base.has(manifest)) {
    const before = packageScripts(base.get(manifest));
    const now = packageScripts(await readRepositoryManifest(root, manifest, { maxBytes: MAX_SOURCE_BYTES }).then(({ bytes }) => bytes.toString('utf8')).catch(() => null));
    const has = (text, filter) => commandFilters([], [{ source: 'argv', text }], { inferred }).some((entry) => filterAt(entry) === filterAt(filter));
    for (const filter of carried) {
      const carriers = [...now].filter(([, text]) => has(text, filter));
      if (carriers.length && carriers.every(([name]) => before.has(name) && has(before.get(name), filter))) standingFilters.add(filterAt(filter));
    }
  }
  const focused = await focusedTests(root, tests);
  const standingFocus = new Set(tests.flatMap((file) => (base.has(file) && JAVASCRIPT.test(file) ? focusedDeclarations(base.get(file)) : [])
    .map((entry) => `${file}|${entry.name ?? ''}`)));
  const addedSkips = [];
  for (const file of tests) {
    let text;
    try { text = (await readRepositoryManifest(root, file, { maxBytes: MAX_SOURCE_BYTES })).bytes.toString('utf8'); } catch { continue; }
    const added = skipMarkers(text) - skipMarkers(base.get(file));
    if (added > 0) addedSkips.push({ path: file, added });
  }
  const paths = addedPathNarrowing(root, command, { scripts, baseCommit, inferred });
  // A re-pin a person accepted showed them exactly what these paths leave out, so it is not asked of them twice.
  const seen = (entry) => acceptedPaths.some((accepted) => accepted.runner === entry.runner && accepted.operands?.join(' ') === entry.operands.join(' '));
  const dropping = paths.filter((entry) => entry.droppedCount > 0 && !seen(entry)).map((entry) => ({ option: 'path', value: entry.operands.join(' '), source: entry.source,
    droppedCount: entry.droppedCount, dropped: entry.dropped, tests: entry.tests, ...(entry.unreadConfig ? { unreadConfig: entry.unreadConfig } : {}) }));
  return {
    filters: [...filters.filter((filter) => !standingFilters.has(filterAt(filter))), ...dropping],
    ...(paths.length ? { paths } : {}),
    focused: focused.filter((entry) => !standingFocus.has(`${entry.path}|${entry.name ?? ''}`)),
    standing: {
      filters: filters.filter((filter) => standingFilters.has(filterAt(filter))),
      focused: focused.filter((entry) => standingFocus.has(`${entry.path}|${entry.name ?? ''}`))
    },
    addedSkips,
    baseline: Number.isInteger(baseline?.discovered) ? baseline.discovered : null,
    baselineSkipped: Number.isInteger(baseline?.skipped) ? baseline.skipped : null
  };
}

// ---------------------------------------------------------------------------------------------
// A path a script names: `vitest run src`, `jest src/one`, `pytest tests/unit`, `go test ./pkg/...`.
// Options select by name and these by place, and `jest src/one` looked to the check exactly like
// `vitest run src`: no option, no filter, and in bin-opr no decision saw it.

// What a runner reads as a word of its own before its operands, for the runners whose paths this reads.
const RUNNER_VERBS = Object.freeze(Object.fromEntries(Object.entries(SELECTING_RUNNERS).filter(([, row]) => row.verbs).map(([key, row]) => [key, row.verbs])));
// Options that take a separate value, which is then no operand; the ones that are themselves a place stay one.
const PLACE_OPTIONS = new Set(['--dir', '--roots', '--rootDir']);
const VALUE_OPTIONS = new Set([...PLACE_OPTIONS, '-c', '--config', '--reporter', '-r', '--root', '--outputFile', '--environment', '--pool', '--maxWorkers', '--minWorkers',
  '--testTimeout', '--hookTimeout', '--mode', '--reporter-option', '--reporter-options', '-O', '--require', '--import', '--timeout', '-t', '--workers', '-j', '--retries', '--output',
  '-p', '-o', '--junitxml', '--rootdir', '--confcutdir', '--ignore', '--cov', '--test-reporter', '--test-reporter-destination', '--test-concurrency', '--test-timeout',
  '-coverprofile', '-covermode', '-count', '-timeout', '-tags', '-parallel', '-exec', '--env-file']);
// A selecting option's value is the option's; its filter is already read above.
for (const option of Object.values(FILTERS).flat()) if (!VALUELESS.has(option)) VALUE_OPTIONS.add(option);
// Options known to take no value, so the word after them is a place for certain.
const FLAG_OPTIONS = new Set(['--test', '--json', '-json', '--ci', '--coverage', '--verbose', '-v', '-q', '-x', '-s', '--silent', '--passWithNoTests', '--runInBand', '-i', '--no-cache',
  '-race', '-cover', '--headed', '--forbid-only', '--globals', '--run']);
const TEST_FILES = Object.freeze(Object.fromEntries(Object.entries(SELECTING_RUNNERS).filter(([, row]) => row.testFiles).map(([key, row]) => [key, row.testFiles])));
// What a runner matches an operand against: part of the path, or the path itself.
const MATCHES_ANYWHERE = new Set(Object.entries(SELECTING_RUNNERS).filter(([, row]) => row.matchesAnywhere).map(([key]) => key));
const SKIPPED_FOLDER = /(?:^|\/)(?:node_modules|dist|build|coverage)\//u;
const MAX_LISTED_DROPS = 20;
const MAX_DROP_CANDIDATES_READ = 200;

const cleanOperand = (value) => String(value).replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '').replace(/::.*$/u, '');

/** The runner a command's tokens start and the operands that select its tests by place, or null where a runner has none. */
export function pathOperands(tokens) {
  const { runner, args } = runnerOf(commandTokens(tokens));
  const verbs = RUNNER_VERBS[runner];
  if (!verbs) return null;
  if (runner === 'node' && !args.includes('--test')) return null;
  const operands = [];
  // A word after an option this cannot read may be that option's value (`--bail 1`): a place only if the tree has it.
  const unsure = [];
  let first = true;
  let afterUnknownOption = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--') continue;
    if (token.startsWith('-')) {
      first = false;
      afterUnknownOption = false;
      const [name, value] = token.split(/=(.*)/su);
      if (value !== undefined) { if (PLACE_OPTIONS.has(name)) operands.push(cleanOperand(value)); continue; }
      if (VALUE_OPTIONS.has(token)) { const next = args[index += 1]; if (PLACE_OPTIONS.has(token) && next) operands.push(cleanOperand(next)); }
      else afterUnknownOption = !FLAG_OPTIONS.has(token);
      continue;
    }
    if (first && verbs.includes(token)) { first = false; continue; }
    first = false;
    // `go test ./...` names every package; `.` alone names the folder a runner would start from anyway.
    if (runner === 'go' ? token === './...' : token === '.' || token === './') continue;
    (afterUnknownOption ? unsure : operands).push(cleanOperand(token));
    afterUnknownOption = false;
  }
  return { runner, operands, unsure };
}

/** Whether a test file, relative to its command's folder, is one a runner's operand selects. */
function operandSelects(runner, operand, file) {
  if (runner === 'go') {
    const whole = operand.endsWith('/...');
    const folder = (whole ? operand.slice(0, -4) : operand);
    const parent = path.posix.dirname(file);
    return whole ? parent === folder || parent.startsWith(`${folder}/`) : parent === folder;
  }
  if (MATCHES_ANYWHERE.has(runner)) {
    if (runner === 'jest') { try { return new RegExp(operand, 'u').test(file); } catch { /* read as the text it is */ } }
    return file.includes(operand);
  }
  if (/[*?[{]/u.test(operand)) {
    const pattern = operand.replace(/[.+^$()|\\]/gu, '\\$&').replace(/\*\*\/?/gu, '\u0000').replace(/\*/gu, '[^/]*').replace(/\?/gu, '[^/]')
      .replace(/\{([^}]*)\}/gu, (_, list) => `(?:${list.replaceAll(',', '|')})`).replaceAll('\u0000', '(?:.*/)?');
    try { return new RegExp(`^${pattern}$`, 'u').test(file); } catch { return false; }
  }
  return file === operand || file.startsWith(`${operand}/`);
}

// Where a runner looks with no operand. Mocha reads ./test alone, so a test file elsewhere was never its to drop.
const DEFAULT_PLACE = Object.freeze(Object.fromEntries(Object.entries(SELECTING_RUNNERS).filter(([, row]) => row.defaultPlace).map(([key, row]) => [key, row.defaultPlace])));

/** Which of the base commit's test files one runner reaches with these operands; with none, wherever it looks by default or its configuration says. */
function selectedBy(runner, operands, files, limit = null) {
  const places = operands.length ? operands : limit?.ownPlace ? [] : DEFAULT_PLACE[runner] ?? [];
  // pytest's `testpaths` applies only when a run names no place of its own; the others' configuration always does.
  const inConfiguration = limit?.accepts && !(limit.operandsWin && operands.length) ? files.filter(limit.accepts) : files;
  return places.length ? inConfiguration.filter((file) => places.some((operand) => operandSelects(runner, operand, file))) : inConfiguration;
}

/** What the runner's own configuration limited it to at the base commit, read only once something would read as dropped. */
function baseCollectionLimit(root, baseCommit, folder, runner) {
  let listed;
  try { listed = committedTreePaths(root, baseCommit, [folder === '.' || !folder ? '.' : folder]); } catch { return null; }
  const prefix = folder === '.' || !folder ? '' : `${folder}/`;
  const names = listed.filter((file) => file.startsWith(prefix) && !file.slice(prefix.length).includes('/')).map((file) => file.slice(prefix.length));
  const texts = baseTexts(root, baseCommit, collectionConfigNames(runner, names).map((name) => `${prefix}${name}`));
  return collectionLimit(runner, names, (name) => texts.get(`${prefix}${name}`) ?? null);
}

/** The test files of the command's folder at the base commit that this runner would take, relative to that folder, or null when Git cannot say. */
function baseTestFiles(root, baseCommit, directory, runner) {
  let listed;
  try { listed = committedTreePaths(root, baseCommit, [directory === '.' || !directory ? '.' : directory]); } catch { return null; }
  const inside = directory === '.' || !directory ? (file) => file : (file) => file.slice(directory.length + 1);
  const candidates = listed.filter((file) => TEST_FILES[runner].test(file) && !SKIPPED_FOLDER.test(file));
  const importsPlaywright = (text) => /['"]@playwright\/test['"]/u.test(text ?? '');
  // Each runner counts only its own: Playwright's specs say so, and a unit runner never ran them.
  if (runner === 'playwright') {
    const texts = baseTexts(root, baseCommit, candidates.slice(0, MAX_DROP_CANDIDATES_READ));
    return candidates.filter((file) => importsPlaywright(texts.get(file))).map(inside);
  }
  if (!['vitest', 'jest', 'mocha'].includes(runner)) return candidates.map(inside);
  const texts = baseTexts(root, baseCommit, candidates.filter((file) => /\.(?:spec|e2e)\.|(?:^|\/)(?:e2e|playwright)\//u.test(file)).slice(0, MAX_DROP_CANDIDATES_READ));
  return candidates.filter((file) => !importsPlaywright(texts.get(file)) && !/\.cy\.[cm]?[jt]sx?$/u.test(file)).map(inside);
}

/**
 * The paths a Story's scripts or guessed command now name that the same place did not name on the base
 * commit, each with what they leave out of the tests the base commit had. Nothing is dropped when every
 * test file there is still selected: `vitest run src` with all tests under src is recorded, and passes.
 * Where the base commit cannot be read this says nothing, as a filter it cannot see would.
 */
export function addedPathNarrowing(root, command, { scripts = [], baseCommit = null, inferred = false } = {}) {
  // A run of only the new tests names its files by a person's choice of scope; `whole` runs as written.
  if (!baseCommit || command.testScope?.files) return [];
  const directory = command.workingDirectory ?? '.';
  const manifest = path.posix.join(directory, 'package.json');
  const scriptFiles = scripts.map((script) => String(script.source ?? '').split('#scripts.')[0]).filter(Boolean);
  const texts = baseTexts(root, baseCommit, [...new Set([...scriptFiles, manifest])]);
  const baseFor = (source) => {
    const [file, name] = String(source).split('#scripts.');
    return name ? packageScripts(texts.get(file) ?? null).get(name) ?? null : null;
  };
  const runnersAtBase = [...packageScripts(texts.get(manifest) ?? null).values()].flatMap((text) => shellSegments(text).map(pathOperands).filter(Boolean));
  const found = [];
  const look = (now, source, before) => {
    if (!now?.operands.length && !now?.unsure?.length) return;
    // Where this script had no such place, or the runner had none: what it now leaves out of the base's tests.
    const earlier = before ?? runnersAtBase.filter((entry) => entry.runner === now.runner);
    if (!earlier.length) return; // The Story added this suite, so it took nothing away.
    const folder = source === 'argv' ? directory : path.posix.dirname(String(source).split('#scripts.')[0]);
    const files = baseTestFiles(root, baseCommit, folder, now.runner);
    if (!files) return;
    const operands = [...now.operands, ...now.unsure.filter((word) => files.some((file) => file === word || file.startsWith(`${word}/`)))];
    const added = operands.filter((operand) => !earlier.some((entry) => entry.operands.includes(operand)));
    if (!added.length) return;
    const measured = (limit) => {
      const reached = new Set(earlier.flatMap((entry) => selectedBy(entry.runner in TEST_FILES ? entry.runner : now.runner, entry.operands, files, limit)));
      const had = files.filter((file) => reached.has(file));
      // A test file the Story removed is its own change, which this run did not leave out.
      return { had, left: had.filter((file) => !selectedBy(now.runner, operands, [file]).length && existsSync(path.join(root, folder, file))) };
    };
    let { had, left } = measured(null);
    // A test file the base commit's configuration never collected never ran, so it cannot be dropped. Where the
    // configuration cannot be read this way the person's route stays, and its words say this may be why.
    const limit = left.length ? baseCollectionLimit(root, baseCommit, folder, now.runner) : null;
    if (limit?.accepts || limit?.ownPlace) ({ had, left } = measured(limit));
    const unreadConfig = left.length && limit?.unread?.length ? limit.unread.map((name) => (folder === '.' ? name : `${folder}/${name}`)) : null;
    found.push({ source, runner: now.runner, operands, added, before: [...new Set(earlier.flatMap((entry) => entry.operands))],
      tests: had.length, droppedCount: left.length, dropped: left.slice(0, MAX_LISTED_DROPS), ...(unreadConfig ? { unreadConfig } : {}) });
  };
  for (const script of scripts) {
    const before = baseFor(script.source);
    const segments = shellSegments(script.text).map(pathOperands).filter(Boolean);
    for (const now of segments) look(now, script.source, before == null ? null : shellSegments(before).map((tokens) => pathOperands(tokens) ?? { runner: now.runner, operands: [] }));
  }
  // A guessed command that runs a script's runner alone carries that script's operands in its argv; a configured one
  // is a person's, and `node --test`'s files are SFlow's own list of what changed.
  if (inferred && launcherName(command.argv?.[0]) !== 'node') look(pathOperands((command.argv ?? []).map(String)), 'argv', null);
  const seen = new Set();
  return found.filter((entry) => { const key = `${entry.runner}|${entry.operands.join(' ')}`; if (seen.has(key)) return false; seen.add(key); return true; });
}

/** A path narrowing in words: "src is every test file's folder at the base commit, so none are dropped", or what is left out. */
export function pathNarrowingWords(entry) {
  const names = entry.operands.join(', ');
  if (!entry.droppedCount) {
    return entry.tests ? `${entry.source === 'argv' ? 'The command' : entry.source.replace('#scripts.', ' scripts.')} now names ${names}. Every test file it ran at the base commit (${entry.tests}) is still selected, so none are dropped.`
      : `${entry.source === 'argv' ? 'The command' : entry.source.replace('#scripts.', ' scripts.')} now names ${names}. The base commit has no test files for it, so none are dropped.`;
  }
  const shown = entry.dropped.slice(0, 5).join(', ') + (entry.droppedCount > 5 ? ` and ${entry.droppedCount - 5} more` : '');
  return `${entry.source === 'argv' ? 'The command' : entry.source.replace('#scripts.', ' scripts.')} now names ${names}, which leaves out ${entry.droppedCount} of the ${entry.tests} test files it ran at the base commit: ${shown}.${unreadConfigWords(entry)}`;
}

/** Where a configuration may have kept a test file from ever running and this cannot read it: the refusal says so, and a person decides. */
function unreadConfigWords(entry) {
  return entry.unreadConfig?.length ? ` ${entry.unreadConfig.join(', ')} at the base commit also limits what it collects in a way SFlow cannot read, so these may never have run there. If so, that is why they read as dropped, and a person can accept this with a reason.` : '';
}

/** The narrowing an attempt records: the facts known before the run and what its report counted [TCE:REQ-021]. */
export const observedNarrowing=narrowingValues.observedNarrowing;

/**
 * Whether the Story's test-policy agreement reviews reduced coverage itself (TRP `reduced-coverage`):
 * its skipped tests are that agreement's to judge, so they are no narrowing here.
 */
export const skippedByAgreement=narrowingValues.skippedByAgreement;

/** The reasons a gate refuses: a skip the test-policy agreement already accepted is not one. */
export const narrowingReasons=narrowingValues.narrowingReasons;



/** The digest of a narrowing's extent: its filters, focused tests, skipped count and shortfall. */
export const narrowingFingerprint=narrowingValues.narrowingFingerprint;

/** Whether an accepted narrowing covers an observed one: the same or smaller in every respect. */
export const narrowingCovers=narrowingValues.narrowingCovers;

/** The narrowing in plain words: "filter -k fast (package.json#scripts.test); 2 tests skipped". */
export function narrowingWords(narrowing, { skippedAccepted = false } = {}) {
  const reasons = narrowingReasons(narrowing, { skippedAccepted });
  const parts = [];
  if (reasons.includes('filter')) {
    parts.push(...narrowing.filters.map((entry) => (entry.option === 'path'
      ? `path ${entry.value} (${entry.source}) leaves out ${entry.droppedCount} of the ${entry.tests} test files of the base commit: ${(entry.dropped ?? []).slice(0, 5).join(', ')}${entry.droppedCount > 5 ? ` and ${entry.droppedCount - 5} more` : ''}${entry.unreadConfig?.length ? ` (${entry.unreadConfig.join(', ')} at the base commit limits what it collects in a way SFlow cannot read, so these may never have run there, which may be why they read as dropped)` : ''}`
      : `filter ${entry.option}${entry.value != null ? ` ${entry.value}` : ''} (${entry.source})`)));
  }
  if (reasons.includes('focused')) {
    parts.push(...narrowing.focused.map((entry) => `focused test ${entry.path}:${entry.line}${entry.name ? ` '${entry.name}'` : ''}`));
  }
  if (reasons.includes('skipped')) parts.push(`${narrowing.skipped} test(s) skipped`);
  if (reasons.includes('below-baseline')) {
    parts.push(`${narrowing.discovered} test(s) discovered, ${narrowing.shortfall} fewer than the first passing run of this pin (${narrowing.baseline})`);
  }
  return parts.join('; ');
}

/** The command a person who approves the step runs to accept a narrowed run of one command. */
export function testNarrowingCommand(workflow, { phaseId, commandId }) {
  return `singularity-flow decision test-narrowing ${workflow?.workItem?.id ?? '<WORK-ID>'} --phase ${phaseId} --command ${commandId}`
    + ' --reason "<why the narrowed run is enough for this step>"';
}

/** Why a person may not accept this attempt's narrowing, or null when they may. */
export const testNarrowingIneligibility=narrowingValues.testNarrowingIneligibility;

/** Record a person's acceptance of an attempt's narrowing; the caller found the attempt and checked authority. */
export const recordTestNarrowing=narrowingValues.recordTestNarrowing;

/** Revoke an acceptance; the record stays, and so does the revocation. */
export function recordTestNarrowingRevocation(workflow,{narrowingId,reason,actor,authorityGroup,identityAssurance=null,at}){
  const records=countedRecords(workflow,workflow.testNarrowings),known=records.some(entry=>!entry.revokes&&entry.id===narrowingId);
  return narrowingValues.recordTestNarrowingRevocation(workflow,{narrowingId,reason,actor,authorityGroup,identityAssurance,at},
    {records,revocations:known?countedRecords(workflow,workflow.testNarrowings):records});
}

/** Whether a decision is `active`, `revoked` or `expired` at `at`. */
export function testNarrowingState(workflow,decision,{at}={}){
  const records=countedRecords(workflow,workflow?.testNarrowings),revoked=records.some(entry=>entry.revokes===decision.id);
  return narrowingValues.testNarrowingState(records,decision,{at:at??(!revoked&&decision.expiresAt?Date.now():0)});
}

const decisionsFor = (workflow, phaseId, attempt) => countedRecords(workflow, workflow?.testNarrowings).filter((entry) => !entry.revokes
  && entry.phase === phaseId && entry.commandId === attempt?.commandId && entry.pinSha256 === attempt?.pin?.sha256);

/** The active decision that covers this attempt's narrowing, or null. */
export function coveringTestNarrowing(workflow, { phaseId, attempt, at, skippedAccepted = false }) {
  return decisionsFor(workflow, phaseId, attempt).reverse().find((entry) => testNarrowingState(workflow, entry, { at }) === 'active'
    && narrowingCovers(entry.narrowing, attempt.narrowing, { skippedAccepted })) ?? null;
}

/** The binding a check or execution carries for the decision that let its narrowed run through. */
export const testNarrowingBinding=narrowingValues.testNarrowingBinding;

/**
 * The gate rule [TCE:REQ-022]: null for a run that was not narrowed, the binding of the decision
 * that covers a narrowed one, else CODE_TEST_NARROWED naming each reason and the person's route.
 */
export function gateNarrowing(workflow, phase, attempt, { at, skippedAccepted = false, operation = 'publish' } = {}) {
  // Only a run that passed is judged here; one that failed, or ran no test, keeps its own refusal.
  const reasons = attempt?.status === 'passed' ? narrowingReasons(attempt.narrowing, { skippedAccepted }) : [];
  if (!reasons.length) return null;
  const decision = coveringTestNarrowing(workflow, { phaseId: phase.id, attempt, at, skippedAccepted });
  if (decision) return testNarrowingBinding(decision);
  const command = testNarrowingCommand(workflow, { phaseId: phase.id, commandId: attempt.commandId });
  const earlier = decisionsFor(workflow, phase.id, attempt).at(-1) ?? null;
  const state = earlier ? testNarrowingState(workflow, earlier, { at }) : null;
  const lapsed = !earlier ? '' : state === 'active' ? ` ${earlier.id} accepted a smaller narrowing of this pin; this run goes beyond it.`
    : ` ${earlier.id} ${state === 'expired' ? `expired on ${earlier.expiresAt.slice(0, 10)}` : 'was revoked'}.`;
  const words = narrowingWords(attempt.narrowing, { skippedAccepted });
  throw new SingularityFlowError(
    `Required test command '${attempt.commandId}' ran narrowed${operation === 'publish' ? ' before publication' : ''}: ${words}.${lapsed} `
      + `A narrowed run does not prove the module; remove the narrowing and run it again, or a person who approves ${phase.id} can accept it with a reason in their own terminal (an agent cannot): ${command}`,
    { code: 'CODE_TEST_NARROWED', details: {
      workId: workflow?.workItem?.id ?? null, phase: phase.id,
      testNarrowing: { phase: phase.id, commandId: attempt.commandId, attemptId: attempt.attemptId, reasons, words,
        fingerprint: narrowingFingerprint(attempt.narrowing), decision: earlier?.id ?? null, lapsed: earlier && state !== 'active' ? state : null, command },
      // The refusal's own route, which every surface renders: only a person who approves the step accepts it.
      nextAction: { command, label: `Remove the narrowing and run it again; or, if the narrowed run is enough for this step, a person who approves ${phase.id} `
        + 'accepts it with a reason in their own terminal or from the decision list (/sf-decide), and an agent cannot. It covers later runs of the same pin narrowed the same or less.' }
    } }
  );
}

/**
 * Why a receipt's execution does not replay its narrowing, or null: a narrowed attempt that passed
 * needs the binding of a decision recorded on the Story with these bytes, for this step, command and
 * pin, that covers the attempt and governs it at `at`. A run a test-run risk carries (no test
 * executed) is that decision's to judge.
 */
export function testNarrowingReplayProblem(workflow, execution, attempt, { phaseId, at, skippedAccepted = false } = {}) {
  const reasons = attempt?.status === 'passed' && !execution?.testRunRisk ? narrowingReasons(attempt.narrowing, { skippedAccepted }) : [];
  if (!reasons.length) return null;
  const binding = execution?.testNarrowing;
  if (!binding?.id) return `it ran narrowed (${narrowingWords(attempt.narrowing, { skippedAccepted })}) and no test-narrowing decision covers it`;
  if (!workflow) return `test-narrowing ${binding.id} cannot be verified without its Story`;
  const decision = countedRecords(workflow, workflow.testNarrowings).find((entry) => !entry.revokes && entry.id === binding.id);
  if (!decision || testNarrowingBinding(decision).sha256 !== binding.sha256) return `test-narrowing ${binding.id} is not recorded on the Story with these bytes`;
  if (decision.phase !== phaseId || decision.commandId !== attempt.commandId || decision.pinSha256 !== attempt.pin?.sha256
      || !narrowingCovers(decision.narrowing, attempt.narrowing, { skippedAccepted })) {
    return `test-narrowing ${decision.id} does not cover this run`;
  }
  const state = testNarrowingState(workflow, decision, { at });
  return state === 'active' ? null : `test-narrowing ${decision.id} is ${state}; a person who approves ${phaseId} must accept it again: `
    + testNarrowingCommand(workflow, { phaseId, commandId: attempt.commandId });
}

/** What a reviewer is told about the narrowed runs a decision let through [TCE:REQ-024]. */
export function acceptedNarrowingSummaries(workflow, entries, { at } = {}) {
  const summaries = [];
  for (const entry of entries ?? []) {
    if (!entry?.testNarrowing?.id) continue;
    const decision = countedRecords(workflow, workflow?.testNarrowings).find((record) => !record.revokes && record.id === entry.testNarrowing.id);
    if (!decision) continue;
    const active = testNarrowingState(workflow, decision, { at }) === 'active';
    summaries.push({
      id: decision.id, commandId: decision.commandId, reasons: decision.narrowing.reasons, reason: decision.reason, actor: decision.actor,
      authorityGroup: decision.authorityGroup, expiresAt: decision.expiresAt, active,
      words: `${decision.commandId} ran narrowed (${narrowingWords(decision.narrowing)}). Accepted as ${decision.id} by ${decision.actor} (${decision.authorityGroup})`
        + `${decision.expiresAt ? ` until ${decision.expiresAt.slice(0, 10)}` : ''}: ${decision.reason.replace(/[.\s]+$/u, '')}.`
        + `${active ? '' : ' No longer active, so the next gate refuses it.'}`
    });
  }
  return summaries;
}

/**
 * What the step's review shows of the runs people accepted: `acceptedRisks`, runs in which no test
 * could execute (src/test-run-risk.mjs), and `acceptedNarrowings`, narrowed runs. Before submission
 * they are read from the preflight's entries, after it from the submitted executions.
 */
export async function acceptedTestRunDecisions(workflow, phase, submitted, { at = new Date().toISOString() } = {}) {
  const evidence = phase.deliveryEvidence ?? {};
  const { acceptedTestRunSummaries } = await import('./test-run-risk.mjs');
  return {
    acceptedRisks: acceptedTestRunSummaries(workflow, phase.id, submitted ? evidence.testExecutions : evidence.testRunRisks, { at }),
    acceptedNarrowings: acceptedNarrowingSummaries(workflow, submitted ? evidence.testExecutions : evidence.preflightAttempts, { at })
  };
}

/** The narrowed runs of a step's latest attempts that no active decision covers: what a person may accept now. */
export function pendingTestNarrowings(workflow, phaseId, latestAttempts, { at } = {}) {
  return [...latestAttempts].filter((attempt) => !testNarrowingIneligibility(attempt)
    && !coveringTestNarrowing(workflow, { phaseId, attempt, at }))
    .sort((left, right) => left.commandId.localeCompare(right.commandId))
    .map((attempt) => ({ phase: phaseId, commandId: attempt.commandId, attemptId: attempt.attemptId, reasons: attempt.narrowing.reasons,
      words: narrowingWords(attempt.narrowing) }));
}

