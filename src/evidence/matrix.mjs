/**
 * The read-only evidence matrix [E2G-029]: one row per requirement or acceptance criterion, with
 * plan, implementation, verification and result cells and the six facets of its obligations.
 *
 * Paged, because one specification may hold thousands of clauses. Every renderer reads the same
 * evaluation, so the terminal, CSV and JSON can never disagree about a row.
 */
import { table } from '../util.mjs';
import { FACETS } from './vocabulary.mjs';

export const DEFAULT_PAGE_SIZE = 50;
export const MAXIMUM_PAGE_SIZE = 500;

/** Parse `--facet NAME=VALUE` (or a bare NAME, which only shows that facet). */
export function parseFacetFilter(value) {
  if (value == null) return null;
  const [name, wanted = null] = String(value).split('=');
  if (!FACETS.includes(name)) throw new Error(`--facet must name one of ${FACETS.join(', ')}.`);
  return { name, value: wanted };
}

function rowFacetValues(row, name) {
  return [...new Set(row.obligations.map((entry) => entry.facets[name]).filter((value) => value && value !== 'not-applicable'))];
}

/** One page of rows after the row and facet filters. Page numbers start at 1. */
export function matrixPage(evaluation, { row = null, facet = null, result = null, page = 1, pageSize = DEFAULT_PAGE_SIZE } = {}) {
  const size = Math.min(Math.max(Number(pageSize) || DEFAULT_PAGE_SIZE, 1), MAXIMUM_PAGE_SIZE);
  const wantedRow = row ? String(row).toUpperCase() : null;
  const filter = typeof facet === 'string' ? parseFacetFilter(facet) : facet;
  let rows = evaluation.rows;
  if (wantedRow) {
    rows = rows.filter((entry) => entry.id === wantedRow || entry.id.endsWith(`:${wantedRow}`));
    if (!rows.length) throw new Error(`No row ${row} is in the evidence matrix of ${evaluation.workId}.`);
  }
  if (result) rows = rows.filter((entry) => entry.result === result);
  if (filter?.value) rows = rows.filter((entry) => rowFacetValues(entry, filter.name).includes(filter.value));
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(Math.max(Number(page) || 1, 1), pages);
  return {
    workId: evaluation.workId,
    total: rows.length,
    page: current,
    pages,
    pageSize: size,
    filter: { row: wantedRow, facet: filter, result },
    rows: rows.slice((current - 1) * size, current * size)
  };
}

function count(value, noun) {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

function planCell(row) {
  if (!row.plan) return row.obligations.find((entry) => entry.responsibility === 'plan')?.status === 'pending' ? 'not planned yet' : 'not planned';
  const tests = row.plan.testDisposition === 'not-applicable' ? 'tests n/a' : count(row.plan.tests.length, 'test');
  return `${count(row.plan.expectedPaths.length, 'path')} · ${tests}`;
}

function implementationCell(row) {
  const obligation = row.obligations.find((entry) => entry.responsibility === 'implement');
  if (obligation?.status === 'not-applicable') return 'no code step';
  if (obligation?.status === 'met') return obligation.fulfillment === 'test-only' ? 'tests only' : 'matched';
  if (obligation?.status === 'partial') return row.implementation?.verdict ?? 'partial';
  return obligation?.status === 'missing' ? 'missing' : 'not yet';
}

function verificationCell(row) {
  const verification = row.verification ?? {};
  if (row.type !== 'AC') {
    return verification.criteria?.length ? `via ${count(verification.criteria.length, 'criterion').replace(/criterions$/, 'criteria')}` : 'no criterion';
  }
  if (verification.testDisposition === 'not-applicable') return 'tests n/a';
  if (verification.association === 'none') return 'no tagged test';
  // Exact tests are named by their own result; a tagged file only by its module command's.
  const outcome = {
    passed: verification.association === 'test-file-tag' ? 'module passed' : 'passed', failed: 'failed', unavailable: 'no result',
    flaky: 'flaky', ambiguous: 'ambiguous', inconclusive: 'not exact', skipped: 'skipped', missing: 'not in the run',
    'passed-with-skips': `${verification.skippedTests} skipped`, 'not-run': 'not run yet'
  }[verification.execution] ?? verification.execution;
  const kind = { 'exact-test': 'exact test', mixed: 'exact test + tag', 'test-file-tag': 'tag' }[verification.association] ?? verification.association;
  return `${kind} · ${outcome}`;
}

function resultCell(row) {
  const words = {
    satisfied: 'satisfied', 'satisfied-with-exception': 'satisfied with exception', failed: 'failed',
    inconclusive: 'inconclusive', missing: 'missing', pending: 'pending'
  }[row.result] ?? row.result;
  return ['satisfied', 'satisfied-with-exception'].includes(row.result) && row.assurance !== 'not-applicable'
    ? `${words} (${row.assurance})` : words;
}

/** Flat cells for one row, shared by the terminal and CSV renderers. */
export function matrixCells(row) {
  return { row: row.id, type: row.type, plan: planCell(row), implementation: implementationCell(row), verification: verificationCell(row), result: resultCell(row) };
}

/** The scope status in words: three separate states, and never a claim of correctness [E2G-007]. */
function scopeLine(scope) {
  return `${scope.words.structure}; ${scope.words.review}; ${scope.words.correctness}`;
}

/** Narrow-terminal rendering of one page. */
export function matrixText({ evaluation, page }) {
  const results = evaluation.summary.results;
  const counts = Object.entries(results).filter(([, count]) => count > 0).map(([result, count]) => `${count} ${result}`).join(' · ') || 'no rows';
  const lines = [
    '',
    `Evidence matrix — ${evaluation.workId}${evaluation.title ? `: ${evaluation.title}` : ''}`,
    `Lifecycle: ${evaluation.lifecycle.words}`,
    `Completion: ${evaluation.completion.label}${evaluation.completion.reasons.length ? ` (${evaluation.completion.reasons.join('; ')})` : ''}`,
    `Required assurance: ${evaluation.requiredAssurance.level} (${evaluation.requiredAssurance.source})`,
    ...(evaluation.summary.scope ? [`Scope: ${scopeLine(evaluation.summary.scope)}`] : []),
    ...(evaluation.summary.scopeRevision?.changes ? [`Scope revision: ${evaluation.summary.scopeRevision.words}`] : []),
    ''
  ];
  if (page.rows.length) {
    lines.push(table(page.rows.map(matrixCells), [
      { key: 'row', label: 'ROW' }, { key: 'plan', label: 'PLAN' }, { key: 'implementation', label: 'IMPLEMENTED' },
      { key: 'verification', label: 'VERIFIED' }, { key: 'result', label: 'RESULT' }
    ]));
  } else {
    lines.push(evaluation.summary.rows ? 'No row matches the filter.' : 'No requirement or acceptance criterion is indexed for this Story yet.');
  }
  lines.push('', `${counts} — page ${page.page} of ${page.pages} (${page.total} row(s))`);
  const attention = page.rows.flatMap((row) => row.findings).slice(0, 10);
  if (attention.length) lines.push('', 'Needs attention:', ...attention.map((entry) => `  - ${entry.message}`));
  const loadProblems = evaluation.findings.filter((entry) => entry.category === 'records');
  if (loadProblems.length) lines.push('', 'Evidence that could not be read:', ...loadProblems.map((entry) => `  - ${entry.message}`));
  lines.push('', "\"module-observed\" means the test command covering a criterion's tagged test file passed; \"exact-local-observed\" means the criterion's own test was found passing in the local run of the published candidate.");
  return lines.join('\n');
}

/**
 * The matrix as a short Markdown summary for a pull request: the completion label exactly as the
 * evaluation states it, the results, the assurance it rests on, and the first open obligations.
 * It never says more than the rows do.
 */
export function matrixMarkdown(evaluation, { limit = 5 } = {}) {
  const results = Object.entries(evaluation.summary.results).filter(([, count]) => count > 0)
    .map(([result, count]) => `${count} ${result}`).join(' · ') || 'no rows';
  const open = evaluation.rows.flatMap((row) => row.obligations
    .filter((obligation) => ['missing', 'partial', 'pending', 'failed', 'inconclusive'].includes(obligation.status))
    .map((obligation) => `\`${obligation.id}\` is ${obligation.status}`));
  const lines = [
    `- Completion: **${evaluation.completion.label}**${evaluation.completion.reasons.length ? ` (${evaluation.completion.reasons.join('; ')})` : ''}`,
    `- Lifecycle: ${evaluation.lifecycle.words}`,
    `- Rows: ${evaluation.summary.rows} — ${results}`,
    `- Assurance floor: ${evaluation.summary.assuranceFloor ?? 'none'}; ${evaluation.summary.testCaseResults}`,
    ...(evaluation.summary.scope ? [`- Scope: ${scopeLine(evaluation.summary.scope)}`] : []),
    ...(evaluation.summary.scopeRevision?.changes ? [`- Scope revision: ${evaluation.summary.scopeRevision.words}`] : [])
  ];
  if (open.length) {
    lines.push(`- Open obligations (${open.length}):`, ...open.slice(0, limit).map((entry) => `  - ${entry}`));
    if (open.length > limit) lines.push(`  - …and ${open.length - limit} more`);
  }
  lines.push(`- Full matrix: \`singularity-flow evidence matrix\``);
  return lines.join('\n');
}

export function matrixCsv(rows) {
  const quote = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return [
    ['row', 'type', 'plan', 'implementation', 'verification', 'result', 'assurance', ...FACETS].map(quote).join(','),
    ...rows.map((row) => {
      const cells = matrixCells(row);
      const facets = FACETS.map((name) => rowFacetValues(row, name).join(';'));
      return [cells.row, cells.type, cells.plan, cells.implementation, cells.verification, row.result, row.assurance, ...facets].map(quote).join(',');
    })
  ].join('\n');
}
