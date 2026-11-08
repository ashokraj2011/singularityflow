/**
 * The Test summary page: one read model of every test case a run recorded. [RUN, test summary]
 *
 * `tests summary --json` (resultType `sflow-test-summary`) carries the run (its evidence class, the
 * engine's label, the environment and whether it counts for the step), totals, each command's
 * status, the test cases with their requirement tags, and the run history. This module turns it
 * into tables and filters. It never relabels a run: the class names below only name the picker's
 * groups, and the engine's own label is always shown beside them.
 *
 * Pure on purpose (no `vscode` import), so the tests pin every filter and every argv.
 */

export type TestSummaryTarget =
  | { kind: 'capability'; capability: string }
  | { kind: 'story'; workId: string; phase: string | null };

export interface TestSummaryTotals { discovered: number; passed: number; failed: number; skipped: number; flaky: number; durationMs: number }

export interface TestSummaryRun {
  id: string;
  evidenceClass: string;
  label: string;
  environment: string | null;
  countsForStep: boolean | null;
  startedAt: string | null;
  commit: string | null;
  uncommittedChanges: boolean;
  ranBy: string | null;
}

export interface TestSummaryCommand {
  id: string; kind: string | null; adapter: string | null; status: string | null; exitCode: number | null;
  perCase: boolean; note: string | null;
  /** The environment it ran against, and the engine's label for it when it differs by command. */
  environment: string | null; label: string | null;
  /** The command's own totals (`tests`), which a report with totals only still gives. */
  counts: { discovered: number; passed: number; failed: number; skipped: number } | null;
  /** The engine's words when its runs on the same code and environment disagree [CQF:REQ-013]. */
  flaky: string | null;
}

export interface TestSummaryCase {
  command: string; suite: string | null; name: string; file: string | null; line: number | null;
  outcome: string; durationMs: number | null; clauses: string[];
  /** The report's failure message for the case, when it gives one. */
  message: string | null;
}

export interface TestSummaryHistory {
  runId: string; at: string | null; evidenceClass: string; environment: string | null; label: string | null;
  totals: TestSummaryTotals;
}

/**
 * Of the lines the Story changed, those the run's coverage reports mark as run [CQF:REQ-031], or why it
 * was not measured [CQF:REQ-034]. The engine's words are shown as they are; it never refuses on this page.
 */
export interface ChangedLineCoverage {
  status: 'measured' | 'not-measured';
  words: string;
  below: boolean;
  minimum: number | null;
  files: Array<{ path: string; inReport: boolean; executable: number; covered: number; percent: number | null; uncoveredLines: string; firstUncovered: number | null }>;
  clauses: Array<{ clauseId: string; executable: number; covered: number; percent: number | null; below: boolean; files: string[]; notInReport: string[] }>;
}

/** How many tests prove one criterion and whether each asserts, in the engine's words [CQF:REQ-033]. */
export interface CriterionProof {
  clauseId: string; tests: number; asserting: number; silent: number; words: string;
  witnesses: Array<{ test: string; testSource: string | null; line: number | null; asserts: boolean | null }>;
}

export interface TestSummary {
  scope: { kind: string; capability: string | null; workId: string | null; phase: string | null };
  run: TestSummaryRun | null;
  totals: TestSummaryTotals;
  commands: TestSummaryCommand[];
  cases: TestSummaryCase[];
  truncated: boolean;
  untagged: number;
  history: TestSummaryHistory[];
  changedLineCoverage: ChangedLineCoverage | null;
  criterionProof: CriterionProof[];
}

const ID = /^[a-z0-9][a-z0-9-]*$/;
const WORK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const PHASE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

const required = (value: string, label: string, pattern: RegExp): string => {
  if (!pattern.test(value)) throw new Error(`${label} is invalid: ${value}`);
  return value;
};

/** `tests summary` for the capability (local preview runs) or the Story step, optionally one run. */
export function testsSummaryArgv(target: TestSummaryTarget, runId: string | null = null): string[] {
  const scope = target.kind === 'capability'
    ? ['--capability', required(target.capability, 'Capability', ID)]
    : ['--work-id', required(target.workId, 'Work ID', WORK_ID), ...(target.phase ? ['--phase', required(target.phase, 'Phase', PHASE)] : [])];
  // One token: elsewhere `--run` is a boolean flag, so the CLI reads a separate run ID as a positional.
  return ['tests', 'summary', ...scope, ...(runId ? [`--run=${required(runId, 'Run ID', RUN_ID)}`] : []), '--json'];
}

/** `tests base` for a Story step: each command once on the commit the Story started from. */
export function testsBaseArgv(target: Extract<TestSummaryTarget, { kind: 'story' }>): string[] {
  return ['tests', 'base', '--work-id', required(target.workId, 'Work ID', WORK_ID), ...(target.phase ? ['--phase', required(target.phase, 'Phase', PHASE)] : []), '--json'];
}

export interface TestBaseAnswer {
  baseCommit: string | null;
  results: Array<{ commandId: string; words: string; verdict: string | null; reused: boolean }>;
}

/** The answer of `tests base --json`, or null when it is not one. The engine's words are shown as they are. */
export function testBaseFrom(raw: unknown): TestBaseAnswer | null {
  let value = record(raw);
  if (value && value.resultType !== 'sflow-test-base' && record(value.data)) value = record(value.data);
  if (!value || value.resultType !== 'sflow-test-base' || !Array.isArray(value.results)) return null;
  const results = value.results.flatMap((item) => {
    const entry = record(item);
    const words = text(entry?.words);
    return entry && words ? [{ commandId: text(entry.commandId) ?? 'tests', words, verdict: text(entry.verdict), reused: entry.reused === true }] : [];
  });
  return { baseCommit: text(value.baseCommit), results };
}

export function totalsFrom(value: unknown): TestSummaryTotals {
  const totals = record(value) ?? {};
  return {
    discovered: count(totals.discovered), passed: count(totals.passed), failed: count(totals.failed),
    skipped: count(totals.skipped), flaky: count(totals.flaky), durationMs: count(totals.durationMs)
  };
}

const percent = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0) : []);

export function changedLineCoverageFrom(raw: unknown): ChangedLineCoverage | null {
  const value = record(raw);
  const words = text(value?.words);
  if (!value || !words || !['measured', 'not-measured'].includes(String(value.status))) return null;
  return {
    status: value.status as ChangedLineCoverage['status'], words, below: value.below === true,
    minimum: percent(value.minimum),
    files: (Array.isArray(value.files) ? value.files : []).flatMap((item) => {
      const file = record(item);
      const path = text(file?.path);
      const uncoveredLines = typeof file?.uncoveredLines === 'string' ? file.uncoveredLines : '';
      const first = Number.parseInt(uncoveredLines, 10);
      return file && path ? [{ path, inReport: file.inReport !== false, executable: count(file.executable), covered: count(file.covered),
        percent: percent(file.percent), uncoveredLines, firstUncovered: Number.isInteger(first) && first > 0 ? first : null }] : [];
    }),
    clauses: (Array.isArray(value.clauses) ? value.clauses : []).flatMap((item) => {
      const clause = record(item);
      const clauseId = text(clause?.clauseId);
      return clause && clauseId ? [{ clauseId, executable: count(clause.executable), covered: count(clause.covered), percent: percent(clause.percent),
        below: clause.below === true, files: strings(clause.files), notInReport: strings(clause.notInReport) }] : [];
    })
  };
}

export function criterionProofFrom(raw: unknown): CriterionProof[] {
  return (Array.isArray(raw) ? raw : []).flatMap((item) => {
    const entry = record(item);
    const clauseId = text(entry?.clauseId);
    const words = text(entry?.words);
    return entry && clauseId && words ? [{ clauseId, words, tests: count(entry.tests), asserting: count(entry.asserting), silent: count(entry.silent),
      witnesses: (Array.isArray(entry.witnesses) ? entry.witnesses : []).flatMap((value) => {
        const witness = record(value);
        const test = text(witness?.test);
        return witness && test ? [{ test, testSource: text(witness.testSource), line: typeof witness.line === 'number' && witness.line > 0 ? witness.line : null,
          asserts: typeof witness.asserts === 'boolean' ? witness.asserts : null }] : [];
      }) }] : [];
  });
}

/** The read model, or null when the answer is not a test summary. A command-result envelope is opened. */
export function testSummaryFrom(raw: unknown): TestSummary | null {
  let value = record(raw);
  if (value && value.resultType !== 'sflow-test-summary' && record(value.data)) value = record(value.data);
  if (!value || value.resultType !== 'sflow-test-summary') return null;
  const scope = record(value.scope) ?? {};
  const run = record(value.run);
  return {
    scope: { kind: text(scope.kind) ?? 'capability', capability: text(scope.capability), workId: text(scope.workId), phase: text(scope.phase) },
    run: run && text(run.id) ? {
      id: text(run.id)!, evidenceClass: text(run.evidenceClass) ?? 'local-preview', label: text(run.label) ?? '',
      environment: text(run.environment),
      countsForStep: typeof run.countsForStep === 'boolean' ? run.countsForStep : null,
      startedAt: text(run.startedAt), commit: text(run.commit), uncommittedChanges: run.uncommittedChanges === true, ranBy: text(run.ranBy)
    } : null,
    totals: totalsFrom(value.totals),
    commands: (Array.isArray(value.commands) ? value.commands : []).flatMap((item) => {
      const command = record(item);
      const id = text(command?.id);
      const tests = record(command?.tests);
      const counted = tests && ['discovered', 'passed', 'failed', 'skipped'].some((key) => typeof tests[key] === 'number');
      return command && id ? [{
        id, kind: text(command.kind), adapter: text(command.adapter), status: text(command.status),
        exitCode: typeof command.exitCode === 'number' ? command.exitCode : null,
        perCase: command.perCase !== false, note: text(command.note),
        environment: text(command.environment), label: text(command.label),
        counts: counted ? { discovered: count(tests.discovered), passed: count(tests.passed), failed: count(tests.failed), skipped: count(tests.skipped) } : null,
        flaky: text(record(command.flaky)?.words)
      }] : [];
    }),
    cases: (Array.isArray(value.cases) ? value.cases : []).flatMap((item) => {
      const entry = record(item);
      if (!entry) return [];
      return [{
        command: text(entry.command) ?? '', suite: text(entry.suite), name: text(entry.name) ?? '(unnamed test case)',
        file: text(entry.file), line: typeof entry.line === 'number' && Number.isInteger(entry.line) && entry.line > 0 ? entry.line : null,
        outcome: text(entry.outcome) ?? 'unknown',
        durationMs: typeof entry.durationMs === 'number' && entry.durationMs >= 0 ? entry.durationMs : null,
        clauses: Array.isArray(entry.clauses) ? entry.clauses.filter((clause): clause is string => typeof clause === 'string' && clause.length > 0) : [],
        message: (text(entry.message) ?? text(record(entry.failure)?.message))?.slice(0, 4_000) ?? null
      }];
    }),
    truncated: value.truncated === true,
    untagged: count(value.untagged),
    history: (Array.isArray(value.history) ? value.history : []).flatMap((item) => {
      const entry = record(item);
      const runId = text(entry?.runId) ?? text(entry?.id);
      return entry && runId ? [{
        runId, at: text(entry.at) ?? text(entry.startedAt), evidenceClass: text(entry.evidenceClass) ?? 'local-preview',
        environment: text(entry.environment), label: text(entry.label), totals: totalsFrom(entry.totals)
      }] : [];
    }),
    changedLineCoverage: changedLineCoverageFrom(value.changedLineCoverage),
    criterionProof: criterionProofFrom(value.criterionProof)
  };
}

/**
 * The picker's group names. "governed" is the engine's class for runs that publish and submit make;
 * it is named for what made it. The engine's own label for the run is always shown beside it.
 */
export function evidenceClassLabel(evidenceClass: string): string {
  if (evidenceClass === 'local-preview') return 'Local preview';
  if (evidenceClass === 'local-integration') return 'Local integration run';
  if (evidenceClass === 'governed') return 'Step run (publish or submit)';
  return evidenceClass;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/** "12 passed, 1 failed, 2 skipped of 15". */
export function totalsLine(totals: TestSummaryTotals): string {
  const parts = [`${totals.passed} passed`];
  if (totals.failed) parts.push(`${totals.failed} failed`);
  if (totals.flaky) parts.push(`${totals.flaky} flaky`);
  if (totals.skipped) parts.push(`${totals.skipped} skipped`);
  return `${parts.join(', ')} of ${totals.discovered}`;
}

export interface TestSummaryFilters { failedOnly: boolean; untagged: boolean }

export function filterCases(cases: TestSummaryCase[], filters: TestSummaryFilters): TestSummaryCase[] {
  return cases.filter((entry) => (!filters.failedOnly || entry.outcome === 'failed')
    && (!filters.untagged || entry.clauses.length === 0));
}

/** The files the page may open: only those a case or a changed-line row on it names. */
export function caseFiles(summary: TestSummary | null): Set<string> {
  return new Set([...(summary?.cases ?? []).flatMap((entry) => (entry.file ? [entry.file] : [])),
    ...(summary?.changedLineCoverage?.files ?? []).map((file) => file.path),
    ...(summary?.criterionProof ?? []).flatMap((entry) => entry.witnesses.flatMap((witness) => (witness.testSource ? [witness.testSource] : [])))]);
}

export interface CaseRow {
  name: string; suite: string | null; outcome: string; outcomePill: 'ok' | 'bad' | 'wait' | '';
  duration: string; file: string | null; line: number | null; location: string | null; clauses: string[];
  /** A failed case's message as the engine bounded and redacted it [CQF:REQ-014]. */
  message: string | null;
}

export interface CommandTable {
  id: string; kind: string | null; adapter: string | null; status: string | null; exitCode: number | null;
  perCase: boolean; note: string | null; environment: string | null; label: string | null; flaky: string | null; rows: CaseRow[]; total: number;
}

export interface RunOption { id: string; label: string; title: string; selected: boolean }

export interface TestSummaryView {
  available: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  title: string;
  scope: string;
  run: (TestSummaryRun & { classLabel: string; countsNote: string | null }) | null;
  totals: TestSummaryTotals | null;
  totalsLine: string | null;
  filters: TestSummaryFilters;
  shown: number;
  total: number;
  commands: CommandTable[];
  runs: RunOption[];
  truncated: boolean;
  untagged: number;
  changedLineCoverage: ChangedLineCoverage | null;
  criterionProof: CriterionProof[];
  /** Whether a failure here also fails without the Story's change: only a Story step's failed run asks. */
  base: { offered: boolean; busy: boolean; answer: TestBaseAnswer | null; error: string | null };
}

const PILLS: Record<string, CaseRow['outcomePill']> = { passed: 'ok', failed: 'bad', flaky: 'wait' };

function row(entry: TestSummaryCase): CaseRow {
  return {
    name: entry.name, suite: entry.suite, outcome: entry.outcome, outcomePill: PILLS[entry.outcome] ?? '',
    duration: formatDuration(entry.durationMs), file: entry.file, line: entry.line,
    location: entry.file ? `${entry.file}${entry.line ? `:${entry.line}` : ''}` : null, clauses: entry.clauses,
    message: entry.outcome === 'failed' ? entry.message : null
  };
}

export const targetTitle = (target: TestSummaryTarget): string => target.kind === 'capability'
  ? `Test summary · ${target.capability}` : `Test summary · ${target.workId}${target.phase ? ` · ${target.phase}` : ''}`;

export function buildTestSummaryView(summary: TestSummary | null, options: {
  target: TestSummaryTarget; filters?: TestSummaryFilters; busy?: boolean; error?: string | null; notice?: string | null;
  base?: { busy?: boolean; answer?: TestBaseAnswer | null; error?: string | null };
}): TestSummaryView {
  const filters = options.filters ?? { failedOnly: false, untagged: false };
  const failedHere = options.target.kind === 'story' && Boolean(summary?.commands.some((command) => command.status === 'failed'));
  const baseState = { offered: failedHere || Boolean(options.base?.answer), busy: options.base?.busy === true, answer: options.base?.answer ?? null, error: options.base?.error ?? null };
  const base = {
    busy: options.busy === true, error: options.error ?? null, notice: options.notice ?? null,
    title: targetTitle(options.target), filters,
    scope: options.target.kind === 'capability'
      ? `Capability ${options.target.capability}: local runs on this computer`
      : `Story ${options.target.workId}${options.target.phase ? `, step ${options.target.phase}` : ''}`
  };
  if (!summary) {
    return { ...base, available: false, run: null, totals: null, totalsLine: null, shown: 0, total: 0, commands: [], runs: [], truncated: false, untagged: 0,
      changedLineCoverage: null, criterionProof: [], base: baseState };
  }
  const shownCases = filterCases(summary.cases, filters);
  const listed = new Set(summary.commands.map((command) => command.id));
  const extra = [...new Set(summary.cases.map((entry) => entry.command).filter((id) => !listed.has(id)))]
    .map((id): TestSummaryCommand => ({ id: id || 'other', kind: null, adapter: null, status: null, exitCode: null, perCase: true, note: null, environment: null, label: null, counts: null, flaky: null }));
  const commands = [...summary.commands, ...extra].map((command): CommandTable => ({
    ...command,
    // A command's own label only when it says something the run's does not.
    label: command.label && command.label !== summary.run?.label ? command.label : null,
    rows: shownCases.filter((entry) => (entry.command || 'other') === command.id).map(row),
    total: summary.cases.filter((entry) => (entry.command || 'other') === command.id).length
  }));
  const run = summary.run;
  // Only a Story step has a step to count for; a capability's local run is labelled by its own words.
  const countsNote = run && options.target.kind === 'story' && run.countsForStep === false
    ? (/does not count/i.test(run.label) ? run.label : `This run does not count for this step. ${run.label}`.trim())
    : null;
  const history = summary.history.some((entry) => entry.runId === run?.id) || !run ? summary.history
    : [{ runId: run.id, at: run.startedAt, evidenceClass: run.evidenceClass, environment: run.environment, label: run.label, totals: summary.totals }, ...summary.history];
  return {
    ...base,
    available: true,
    run: run ? { ...run, classLabel: evidenceClassLabel(run.evidenceClass), countsNote } : null,
    totals: summary.totals,
    totalsLine: totalsLine(summary.totals),
    shown: shownCases.length,
    total: summary.cases.length,
    commands,
    runs: history.map((listed) => listed.runId === run?.id
      ? { ...listed, environment: listed.environment ?? run.environment, label: listed.label ?? run.label } : listed).map((entry) => ({
      id: entry.runId,
      label: [evidenceClassLabel(entry.evidenceClass), entry.environment ? `environment ${entry.environment}` : null, entry.at,
        totalsLine(entry.totals)].filter(Boolean).join(' · '),
      title: entry.label ?? '',
      selected: entry.runId === run?.id
    })),
    truncated: summary.truncated,
    untagged: summary.untagged,
    changedLineCoverage: summary.changedLineCoverage,
    criterionProof: summary.criterionProof,
    base: baseState
  };
}
