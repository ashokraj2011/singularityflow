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
 * on the Story's base commit, or a focused test already in the base version of a test file, is the
 * team's own setup, recorded as `standing` and never a reason; skipped tests are a reason only when
 * the Story's changed test files add skip markers or a run skips more than the pin's first passing run.
 */
import { committedFilesAtRevisions } from './git.mjs';
import { readRepositoryManifest } from './repository-manifest.mjs';
import { recordSha256 } from './records.mjs';
import { countedRecords } from './presence/counted.mjs';
import { commandTokens, launcherName, packageScriptName, shellSegments } from './test-command-pins.mjs';
import { SingularityFlowError } from './util.mjs';
import { tokenizeJavaScript } from './verification/javascript-declarations.mjs';

const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_FOCUS_FILES = 256;
const JAVASCRIPT = /\.(?:[cm]?[jt]sx?)$/iu;
const SUITES = new Set(['describe', 'context', 'suite', 'it', 'test', 'specify']);
// The options that select a subset of a runner's tests [TCE:REQ-021]. `--project` is a person's
// choice in a configured or accepted command, and a narrowing only in a guessed one.
const FILTERS = Object.freeze({
  jest: ['-t', '--testNamePattern', '--testPathPattern', '--testPathPatterns', '--shard', '-o', '--onlyChanged', '--changedSince',
    '--findRelatedTests', '--onlyFailures', '--selectProjects'],
  vitest: ['-t', '--testNamePattern', '--shard', '--changed', '--related', '--project'],
  mocha: ['-g', '--grep', '-f', '--fgrep', '--invert'],
  playwright: ['-g', '--grep', '--grep-invert', '--shard', '--project', '--only-changed', '--last-failed'],
  cypress: ['--spec'],
  pytest: ['-k', '-m', '--lf', '--last-failed', '--deselect', '--sw', '--stepwise'],
  maven: ['-Dtest', '-Dit.test', '-Dgroups', '-DexcludedGroups'],
  gradle: ['--tests'],
  go: ['-run', '-skip', '-short'],
  dotnet: ['--filter'],
  node: ['--test-name-pattern', '--test-skip-pattern', '--test-only', '--test-shard'],
  generic: ['--grep', '--testNamePattern', '--testPathPattern', '--shard', '--only', '--filter', '--tests', '--test-name-pattern', '--test-only']
});
const VALUELESS = new Set(['-o', '--onlyChanged', '--onlyFailures', '--lf', '--last-failed', '--sw', '--stepwise', '--test-only', '--only',
  '--invert', '-short', '--changed', '--only-changed']);
const RUNNERS = Object.freeze({ jest: 'jest', 'react-scripts': 'jest', vitest: 'vitest', mocha: 'mocha', playwright: 'playwright', cypress: 'cypress',
  pytest: 'pytest', 'py.test': 'pytest', tox: 'pytest', nox: 'pytest', mvn: 'maven', mvnw: 'maven', gradle: 'gradle', gradlew: 'gradle',
  go: 'go', dotnet: 'dotnet', node: 'node' });

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
  return { runner: RUNNERS[name] ?? 'generic', args: tokens.slice(1) };
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

/**
 * What a gate knows before a command runs: the filters and focused tests this Story added (those already
 * on the base commit are `standing`), the skip markers its changed test files added, and the pin's baseline.
 */
export async function narrowingFacts(root, command, { scripts = [], testPaths = [], baseline = null, inferred = false, baseCommit = null } = {}) {
  const tests = testPaths.filter((file) => covered(file, command.affectedRoots));
  const scriptFiles = scripts.map((script) => String(script.source ?? '').split('#scripts.')[0]).filter((file) => file && file !== 'argv');
  const base = baseTexts(root, baseCommit, [...scriptFiles, ...tests.filter((file) => JAVASCRIPT.test(file) || /\.(?:py|java|kt|cs|go)$/iu.test(file))]);
  const standingFilters = new Set(baseCommit ? commandFilters(command.argv, baseScripts(base, scripts), { inferred })
    .filter((filter) => filter.source !== 'argv').map(filterAt) : []);
  const filters = commandFilters(command.argv, scripts, { inferred });
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
  return {
    filters: filters.filter((filter) => !standingFilters.has(filterAt(filter))),
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

/** The narrowing an attempt records: the facts known before the run and what its report counted [TCE:REQ-021]. */
export function observedNarrowing(facts, tests) {
  const skipped = Number(tests?.skipped) || 0;
  const discovered = Number.isInteger(tests?.discovered) ? tests.discovered : null;
  const baseline = Number.isInteger(facts?.baseline) ? facts.baseline : null;
  const shortfall = baseline != null && discovered != null ? Math.max(0, baseline - discovered) : 0;
  const filters = facts?.filters ?? [];
  const focused = facts?.focused ?? [];
  // Skipped tests the team already had are not this Story's narrowing: only added skip markers, or more
  // skipped than the pin's first passing run, are.
  const skipsAdded = skipped > 0 && ((facts?.addedSkips ?? []).length > 0
    || (Number.isInteger(facts?.baselineSkipped) && skipped > facts.baselineSkipped));
  return {
    reasons: [...(filters.length ? ['filter'] : []), ...(focused.length ? ['focused'] : []), ...(skipsAdded ? ['skipped'] : []),
      ...(shortfall > 0 ? ['below-baseline'] : [])],
    filters, focused, skipped, discovered, baseline, shortfall,
    ...(facts?.standing && (facts.standing.filters.length || facts.standing.focused.length) ? { standing: facts.standing } : {}),
    ...(facts?.addedSkips?.length ? { addedSkips: facts.addedSkips } : {})
  };
}

/**
 * Whether the Story's test-policy agreement reviews reduced coverage itself (TRP `reduced-coverage`):
 * its skipped tests are that agreement's to judge, so they are no narrowing here.
 */
export function skippedByAgreement(workflow) {
  return Boolean((workflow?.testRecovery || workflow?.resolution?.testRecovery?.enabled === true)
    && workflow?.resolution?.testRecovery?.enabledRiskCategories?.includes('reduced-coverage'));
}

/** The reasons a gate refuses: a skip the test-policy agreement already accepted is not one. */
export function narrowingReasons(narrowing, { skippedAccepted = false } = {}) {
  return (narrowing?.reasons ?? []).filter((reason) => !(skippedAccepted && reason === 'skipped'));
}

const filterKey = (filter) => `${filter.option}=${filter.value ?? ''}`;
const focusKey = (entry) => `${entry.path}|${entry.name ?? ''}`;

/** The digest of a narrowing's extent: its filters, focused tests, skipped count and shortfall. */
export function narrowingFingerprint(narrowing) {
  return `sha256:${recordSha256({
    filters: [...new Set((narrowing?.filters ?? []).map(filterKey))].sort(),
    focused: [...new Set((narrowing?.focused ?? []).map(focusKey))].sort(),
    skipped: narrowing?.skipped ?? 0, shortfall: narrowing?.shortfall ?? 0
  })}`;
}

/** Whether an accepted narrowing covers an observed one: the same or smaller in every respect. */
export function narrowingCovers(accepted, observed, { skippedAccepted = false } = {}) {
  const filters = new Set((accepted?.filters ?? []).map(filterKey));
  const focused = new Set((accepted?.focused ?? []).map(focusKey));
  return (observed?.filters ?? []).every((entry) => filters.has(filterKey(entry)))
    && (observed?.focused ?? []).every((entry) => focused.has(focusKey(entry)))
    && (skippedAccepted || (observed?.skipped ?? 0) <= (accepted?.skipped ?? 0))
    && (observed?.shortfall ?? 0) <= (accepted?.shortfall ?? 0);
}

/** The narrowing in plain words: "filter -k fast (package.json#scripts.test); 2 tests skipped". */
export function narrowingWords(narrowing, { skippedAccepted = false } = {}) {
  const reasons = narrowingReasons(narrowing, { skippedAccepted });
  const parts = [];
  if (reasons.includes('filter')) {
    parts.push(...narrowing.filters.map((entry) => `filter ${entry.option}${entry.value != null ? ` ${entry.value}` : ''} (${entry.source})`));
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
export function testNarrowingIneligibility(attempt) {
  if (!attempt) return 'no run of this command is recorded for the step in this checkout yet; publish or submit it first so its narrowed run is recorded';
  if (attempt.status !== 'passed') return `its latest run is ${attempt.status}; only a narrowed run that passed is accepted, a failing one is fixed`;
  if (!attempt.pin?.sha256) return 'its latest run was recorded without a command pin; run it again';
  if (!narrowingReasons(attempt.narrowing).length) return 'its latest run was not narrowed';
  return null;
}

function textBetween(value, minimum, maximum, option, what) {
  const text = String(value ?? '').trim();
  if (text.length < minimum || text.length > maximum) {
    throw new SingularityFlowError(`Say ${what} in ${minimum} to ${maximum} characters with ${option}.`, { code: 'TEST_NARROWING_INVALID' });
  }
  return text;
}

/** Record a person's acceptance of an attempt's narrowing; the caller found the attempt and checked authority. */
export function recordTestNarrowing(workflow, { phaseId, attempt, reason, expires = null, actor, authorityGroup, identityAssurance = null, at }) {
  const ineligible = testNarrowingIneligibility(attempt);
  if (ineligible) {
    throw new SingularityFlowError(`The narrowing of ${attempt?.commandId ?? 'this test command'} cannot be accepted: ${ineligible}.`, {
      code: 'TEST_NARROWING_NOT_ELIGIBLE', details: { phase: phaseId, commandId: attempt?.commandId ?? null }
    });
  }
  const text = textBetween(reason, 20, 1000, '--reason', 'why the narrowed run is enough for this step');
  let expiresAt = null;
  if (expires != null) {
    const expiry = /^\d{4}-\d{2}-\d{2}$/u.test(String(expires)) ? new Date(`${expires}T23:59:59.999Z`) : null;
    if (!expiry || Number.isNaN(expiry.getTime()) || expiry <= new Date(at)) {
      throw new SingularityFlowError('--expires must be a date from today on (YYYY-MM-DD); without it the acceptance lasts until the Story ends.', { code: 'TEST_NARROWING_INVALID' });
    }
    expiresAt = expiry.toISOString();
  }
  const { reasons, filters, focused, skipped, discovered, baseline, shortfall } = attempt.narrowing;
  workflow.testNarrowings ??= [];
  const decision = {
    id: `TNR-${String(workflow.testNarrowings.filter((entry) => !entry.revokes).length + 1).padStart(3, '0')}`,
    phase: phaseId, commandId: attempt.commandId, pinSha256: attempt.pin.sha256,
    narrowing: { reasons, filters, focused, skipped, discovered, baseline, shortfall }, fingerprint: narrowingFingerprint(attempt.narrowing),
    observation: { attemptId: attempt.attemptId }, reason: text, expiresAt, actor, authorityGroup, identityAssurance, at
  };
  workflow.testNarrowings.push(decision);
  return decision;
}

/** Revoke an acceptance; the record stays, and so does the revocation. */
export function recordTestNarrowingRevocation(workflow, { narrowingId, reason, actor, authorityGroup, identityAssurance = null, at }) {
  const target = countedRecords(workflow, workflow.testNarrowings).find((entry) => !entry.revokes && entry.id === narrowingId);
  if (!target) throw new SingularityFlowError(`This Story has no test-narrowing decision ${narrowingId}.`, { code: 'TEST_NARROWING_UNKNOWN' });
  if (countedRecords(workflow, workflow.testNarrowings).some((entry) => entry.revokes === narrowingId)) {
    throw new SingularityFlowError(`${narrowingId} is already revoked.`, { code: 'TEST_NARROWING_REVOKED' });
  }
  const revocation = { revokes: narrowingId, phase: target.phase, commandId: target.commandId,
    reason: textBetween(reason, 20, 1000, '--reason', 'why the acceptance is revoked'), actor, authorityGroup, identityAssurance, at };
  workflow.testNarrowings.push(revocation);
  return revocation;
}

/** Whether a decision is `active`, `revoked` or `expired` at `at`. */
export function testNarrowingState(workflow, decision, { at } = {}) {
  if (countedRecords(workflow, workflow?.testNarrowings).some((entry) => entry.revokes === decision.id)) return 'revoked';
  if (decision.expiresAt && new Date(decision.expiresAt) <= new Date(at ?? Date.now())) return 'expired';
  return 'active';
}

const decisionsFor = (workflow, phaseId, attempt) => countedRecords(workflow, workflow?.testNarrowings).filter((entry) => !entry.revokes
  && entry.phase === phaseId && entry.commandId === attempt?.commandId && entry.pinSha256 === attempt?.pin?.sha256);

/** The active decision that covers this attempt's narrowing, or null. */
export function coveringTestNarrowing(workflow, { phaseId, attempt, at, skippedAccepted = false }) {
  return decisionsFor(workflow, phaseId, attempt).reverse().find((entry) => testNarrowingState(workflow, entry, { at }) === 'active'
    && narrowingCovers(entry.narrowing, attempt.narrowing, { skippedAccepted })) ?? null;
}

/** The binding a check or execution carries for the decision that let its narrowed run through. */
export function testNarrowingBinding(decision) {
  return { id: decision.id, sha256: `sha256:${recordSha256(decision)}` };
}

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

