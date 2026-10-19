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
}

export interface TestSummaryCase {
  command: string; suite: string | null; name: string; file: string | null; line: number | null;
  outcome: string; durationMs: number | null; clauses: string[];
}

export interface TestSummaryHistory {
  runId: string; at: string | null; evidenceClass: string; environment: string | null; label: string | null;
  totals: TestSummaryTotals;
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
  return ['tests', 'summary', ...scope, ...(runId ? ['--run', required(runId, 'Run ID', RUN_ID)] : []), '--json'];
}

export function totalsFrom(value: unknown): TestSummaryTotals {
  const totals = record(value) ?? {};
  return {
    discovered: count(totals.discovered), passed: count(totals.passed), failed: count(totals.failed),
    skipped: count(totals.skipped), flaky: count(totals.flaky), durationMs: count(totals.durationMs)
  };
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
      return command && id ? [{
        id, kind: text(command.kind), adapter: text(command.adapter), status: text(command.status),
        exitCode: typeof command.exitCode === 'number' ? command.exitCode : null,
        perCase: command.perCase !== false, note: text(command.note)
      }] : [];
    }),
    cases: (Array.isArray(value.cases) ? value.cases : []).flatMap((item) => {
      const entry = record(item);
      const name = text(entry?.name);
      if (!entry || !name) return [];
      return [{
        command: text(entry.command) ?? '', suite: text(entry.suite), name,
        file: text(entry.file), line: typeof entry.line === 'number' && Number.isInteger(entry.line) && entry.line > 0 ? entry.line : null,
        outcome: text(entry.outcome) ?? 'unknown',
        durationMs: typeof entry.durationMs === 'number' && entry.durationMs >= 0 ? entry.durationMs : null,
        clauses: Array.isArray(entry.clauses) ? entry.clauses.filter((clause): clause is string => typeof clause === 'string' && clause.length > 0) : []
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
    })
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

/** The files the page may open: only those a case on it names. */
export function caseFiles(summary: TestSummary | null): Set<string> {
  return new Set((summary?.cases ?? []).flatMap((entry) => (entry.file ? [entry.file] : [])));
}

export interface CaseRow {
  name: string; suite: string | null; outcome: string; outcomePill: 'ok' | 'bad' | 'wait' | '';
  duration: string; file: string | null; line: number | null; location: string | null; clauses: string[];
}

export interface CommandTable {
  id: string; kind: string | null; adapter: string | null; status: string | null; exitCode: number | null;
  perCase: boolean; note: string | null; rows: CaseRow[]; total: number;
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
}

const PILLS: Record<string, CaseRow['outcomePill']> = { passed: 'ok', failed: 'bad', flaky: 'wait' };

function row(entry: TestSummaryCase): CaseRow {
  return {
    name: entry.name, suite: entry.suite, outcome: entry.outcome, outcomePill: PILLS[entry.outcome] ?? '',
    duration: formatDuration(entry.durationMs), file: entry.file, line: entry.line,
    location: entry.file ? `${entry.file}${entry.line ? `:${entry.line}` : ''}` : null, clauses: entry.clauses
  };
}

export const targetTitle = (target: TestSummaryTarget): string => target.kind === 'capability'
  ? `Test summary · ${target.capability}` : `Test summary · ${target.workId}${target.phase ? ` · ${target.phase}` : ''}`;

export function buildTestSummaryView(summary: TestSummary | null, options: {
  target: TestSummaryTarget; filters?: TestSummaryFilters; busy?: boolean; error?: string | null; notice?: string | null;
}): TestSummaryView {
  const filters = options.filters ?? { failedOnly: false, untagged: false };
  const base = {
    busy: options.busy === true, error: options.error ?? null, notice: options.notice ?? null,
    title: targetTitle(options.target), filters,
    scope: options.target.kind === 'capability'
      ? `Capability ${options.target.capability}: local runs on this computer`
      : `Story ${options.target.workId}${options.target.phase ? `, step ${options.target.phase}` : ''}`
  };
  if (!summary) {
    return { ...base, available: false, run: null, totals: null, totalsLine: null, shown: 0, total: 0, commands: [], runs: [], truncated: false, untagged: 0 };
  }
  const shownCases = filterCases(summary.cases, filters);
  const listed = new Set(summary.commands.map((command) => command.id));
  const extra = [...new Set(summary.cases.map((entry) => entry.command).filter((id) => !listed.has(id)))]
    .map((id): TestSummaryCommand => ({ id: id || 'other', kind: null, adapter: null, status: null, exitCode: null, perCase: true, note: null }));
  const commands = [...summary.commands, ...extra].map((command): CommandTable => ({
    ...command,
    rows: shownCases.filter((entry) => (entry.command || 'other') === command.id).map(row),
    total: summary.cases.filter((entry) => (entry.command || 'other') === command.id).length
  }));
  const run = summary.run;
  const countsNote = run && run.countsForStep === false
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
    untagged: summary.untagged
  };
}
