/**
 * Changed-line coverage [CQF:REQ-031, REQ-034]: of the lines a Story changed, those its tests' coverage
 * reports mark as run, per changed file and per clause.
 *
 * A run measured its own changed lines when it ran (coverage-reports.mjs): a reader joins the runs bound
 * to a step, so a line counts as run when any of them ran it. A clause's lines are those of the files its
 * plan names. Owner decision 4 (2026-11-08): it is shown and warns below 80%; it never refuses by default.
 * `codeDelivery.changedLineCoverage: { mode: off|warn|enforce, minimum }` sets it; only `enforce` refuses,
 * at the code step's publication, and only on a measured run. Without a report, "coverage not measured" is
 * shown, and it never refuses. Read by the review packet, `tests summary` and the approval card's data.
 */
import path from 'node:path';

import { workDir } from '../story-paths.mjs';
import { SingularityFlowError } from '../util.mjs';
import { lineRanges, rangeLines } from './coverage-reports.mjs';

export const CHANGED_LINE_COVERAGE_MODES = Object.freeze(['off', 'warn', 'enforce']);
export const DEFAULT_CHANGED_LINE_COVERAGE = Object.freeze({ mode: 'warn', minimum: 80 });

/** The Story's pinned setting, else the default: warn below 80%. */
export function changedLineCoveragePolicy(workflow) {
  return { ...DEFAULT_CHANGED_LINE_COVERAGE, ...(workflow?.resolution?.codeDelivery?.changedLineCoverage ?? {}) };
}

const percentOf = (covered, executable) => (executable ? Math.floor((covered / executable) * 1000) / 10 : null);
const below = (covered, executable, minimum) => executable > 0 && covered * 100 < minimum * executable;

/**
 * Each clause and the files its plan names, from the Story's planned claims; [] when it has no plan.
 */
export async function plannedClauseFiles(root, config, workflow) {
  try {
    const { loadActiveSpecRecords, mergePlannedClaimRecords } = await import('../specifications.mjs');
    const records = await loadActiveSpecRecords(workDir(root, config, workflow.workItem.id), workflow);
    return Object.entries(mergePlannedClaimRecords(records.planned ?? []))
      .map(([clauseId, claim]) => ({ clauseId, paths: [...new Set(claim.expectedPaths ?? [])].sort() }))
      .filter((entry) => entry.paths.length);
  } catch { return []; }
}

/**
 * The changed-line coverage of a step's runs (`attempts`, test-execution records), or null when the policy
 * is off or no run is a test run. `clauses` is plannedClauseFiles'. Pure.
 */
export function changedLineCoverage(attempts, { policy = DEFAULT_CHANGED_LINE_COVERAGE, clauses = [] } = {}) {
  if (policy.mode === 'off' || !attempts?.length) return null;
  const { mode, minimum } = policy;
  const measured = attempts.filter((attempt) => attempt.coverage?.status === 'measured');
  const reasons = attempts.filter((attempt) => attempt.coverage?.status === 'not-measured' && attempt.coverage.reason)
    .map((attempt) => `${attempt.commandId}: ${attempt.coverage.reason}`);
  const changed = measured.filter((attempt) => Array.isArray(attempt.coverage.changed?.files));
  if (!changed.length) {
    const why = measured.length ? measured.map((attempt) => `${attempt.commandId}: its report could not be read against the Story's changes${attempt.coverage.changed?.unavailable ? ` (${attempt.coverage.changed.unavailable})` : ''}`)
      : reasons.length ? reasons : ['no test command of this step wrote a coverage report SFlow reads (the one its coverage names, or one in a usual place such as coverage/lcov.info or target/site/jacoco/jacoco.xml)'];
    return { status: 'not-measured', mode, minimum, reasons: why,
      words: `Coverage not measured: ${why.join('; ')}. It refuses nothing.` };
  }
  // A line ran when any run ran it; a file is outside every report only when no run's report names it.
  const files = new Map();
  for (const attempt of changed) {
    for (const file of attempt.coverage.changed.files) {
      const entry = files.get(file.path) ?? { path: file.path, inReport: false, covered: new Set(), uncovered: new Set() };
      if (file.inReport) {
        entry.inReport = true;
        for (const line of rangeLines(file.coveredLines)) entry.covered.add(line);
        for (const line of rangeLines(file.uncoveredLines)) entry.uncovered.add(line);
      }
      files.set(file.path, entry);
    }
  }
  const perFile = [...files.values()].sort((left, right) => left.path.localeCompare(right.path)).map((entry) => {
    const uncovered = [...entry.uncovered].filter((line) => !entry.covered.has(line));
    const executable = entry.covered.size + uncovered.length;
    return { path: entry.path, inReport: entry.inReport, executable, covered: entry.covered.size, percent: percentOf(entry.covered.size, executable),
      coveredLines: lineRanges(entry.covered), uncoveredLines: lineRanges(uncovered) };
  });
  const total = (list) => {
    const executable = list.reduce((sum, file) => sum + file.executable, 0);
    const covered = list.reduce((sum, file) => sum + file.covered, 0);
    return { executable, covered, percent: percentOf(covered, executable), notInReport: list.filter((file) => !file.inReport).map((file) => file.path) };
  };
  const totals = total(perFile);
  const perClause = clauses.map(({ clauseId, paths }) => {
    const own = perFile.filter((file) => paths.includes(file.path));
    const sum = total(own);
    return { clauseId, files: own.map((file) => file.path), ...sum, below: below(sum.covered, sum.executable, minimum) || sum.notInReport.length > 0 };
  }).filter((entry) => entry.files.length);
  const short = below(totals.covered, totals.executable, minimum) || totals.notInReport.length > 0;
  const formats = [...new Set(changed.map((attempt) => attempt.coverage.format))];
  const words = [
    totals.executable ? `Changed-line coverage: ${totals.covered} of ${totals.executable} changed lines ran (${totals.percent}%)` : 'Changed-line coverage: no changed line is code a report measures',
    totals.notInReport.length ? `; no test loaded ${totals.notInReport.join(', ')}` : '',
    short ? `. Below the ${minimum}% wanted: ${mode === 'enforce' ? 'publication refuses it' : 'it warns and refuses nothing'}.` : `. At least the ${minimum}% wanted.`
  ].join('');
  return { status: 'measured', mode, minimum, formats, ...totals, below: short, files: perFile, clauses: perClause, words,
    lines: detailLines(perFile, perClause, minimum), ...(reasons.length ? { reasons } : {}) };
}

/** One line per file and per clause, under the words, for every text surface alike. */
function detailLines(files, clauses, minimum) {
  return [
    ...files.map((file) => `${file.path}: ${file.inReport ? `${file.covered} of ${file.executable} changed lines ran${file.percent == null ? '' : ` (${file.percent}%)`}`
      + `${file.uncoveredLines ? `; not run: lines ${file.uncoveredLines}` : ''}` : 'no test loaded it'}`),
    ...clauses.map((clause) => `${clause.clauseId}: ${clause.executable ? `${clause.covered} of ${clause.executable} changed lines ran (${clause.percent}%)` : 'no changed line is measured code'}`
      + `${clause.notInReport.length ? `; no test loaded ${clause.notInReport.join(', ')}` : ''}${clause.below ? `, below ${minimum}%` : ''}`)
  ];
}

/** The runs a step bound, as records: its code delivery's, else its own repository-test runs [CQF:REQ-010]. */
export async function boundStepAttempts(root, phase) {
  const { readFile } = await import('node:fs/promises');
  const { readRecord } = await import('../schema-migrations.mjs');
  const submitted = phase.deliveryEvidence?.status === 'ready';
  const own = Number(phase.stepTestRuns?.generation) === Number(phase.generation) ? phase.stepTestRuns : null;
  const bound = phase.deliveryEvidence
    ? (submitted ? phase.deliveryEvidence.testExecutions : phase.deliveryEvidence.preflightAttempts)
    : own?.testExecutions ?? own?.preflightAttempts;
  const attempts = [];
  for (const execution of bound ?? []) {
    if (execution.kind === 'phase-validation-observation' || !execution.receiptPath) continue;
    try { attempts.push(readRecord('test-execution', await readFile(path.join(root, execution.receiptPath))).record); } catch { /* unavailable: not measured */ }
  }
  return attempts;
}

/** The review packet's changed-line coverage of a step with test runs; {} for one without, or with the setting off. */
export async function changedLineCoverageReview(root, config, workflow, phase) {
  const policy = changedLineCoveragePolicy(workflow);
  if (policy.mode === 'off') return {};
  const attempts = await boundStepAttempts(root, phase);
  const coverage = changedLineCoverage(attempts, { policy, clauses: attempts.length ? await plannedClauseFiles(root, config, workflow) : [] });
  return coverage ? { changedLineCoverage: coverage } : {};
}

/**
 * Under `enforce`, a code step's publication refuses a measured run whose changed lines ran below the
 * minimum. A run that was not measured never refuses [CQF:REQ-034].
 */
export async function assertChangedLineCoverage(root, config, workflow, phase, attempts) {
  const policy = changedLineCoveragePolicy(workflow);
  if (policy.mode !== 'enforce') return;
  const coverage = changedLineCoverage(attempts, { policy, clauses: await plannedClauseFiles(root, config, workflow) });
  if (coverage?.status !== 'measured' || !coverage.below) return;
  const short = coverage.files.filter((file) => !file.inReport || file.uncoveredLines);
  throw new SingularityFlowError(`${phase.id} cannot publish: ${coverage.words.replace(/ Below the .*$/u, '')} This Story's codeDelivery.changedLineCoverage enforces at least `
    + `${coverage.minimum}%. ${short.map((file) => (file.inReport ? `${file.path} lines ${file.uncoveredLines} did not run` : `no test loaded ${file.path}`)).join('; ')}. `
    + 'Add or extend tests that run them, then publish again.', { code: 'CODE_CHANGED_LINE_COVERAGE_BELOW_MINIMUM', details: {
    phase: phase.id, changedLineCoverage: coverage,
    recoveryCommands: [`singularity-flow tests summary --work-id ${workflow.workItem.id} --phase ${phase.id}`] } });
}
