/**
 * Which plan rows a file departure can be accepted under, and why a named row is left out [owner, 2026-11-19]: the
 * check the decision list, `decision departure` and recordPlanAmendment share, so no screen or command offers a choice
 * the record would refuse. Pure; loaded only where departures are decided, never on a lifecycle command's eager path.
 */
import { isTestAutomationPath } from './source-boundary.mjs';
import { SingularityFlowError } from './util.mjs';

/** Whether a plan row can take these files, as recordPlanAmendment checks it: a test-only row takes only tests and test support. */
export function rowTakesPaths(row, paths) {
  return !(row?.testOnly || row?.fulfillment === 'test-only') || (paths ?? []).every(isTestAutomationPath);
}

/** The row a clause names: its own ID, or the one row whose full ID ends with a short one (AC-001), as decision plan reads it. */
function rowNamed(rows, clauseId) {
  const id = String(clauseId ?? '').toUpperCase();
  const exact = rows.find((row) => String(row.clauseId).toUpperCase() === id);
  if (exact || id.includes(':')) return exact ?? null;
  const ending = rows.filter((row) => String(row.clauseId).includes(':') && String(row.clauseId).toUpperCase().split(':').at(-1) === id);
  return ending.length === 1 ? ending[0] : null;
}

/**
 * The clauses a file departure names, split by whether their plan row can take its files: `takes` can; `testOnly` only
 * checks tests and the files are not all tests; `noRow` names no row of the plan. `rows` are planRowsOf's rows, every one.
 */
export function clausesTakingPaths(clauses, rows, paths) {
  const fit = { takes: [], testOnly: [], noRow: [] };
  for (const clauseId of clauses ?? []) {
    const row = rowNamed(rows ?? [], clauseId);
    (!row ? fit.noRow : rowTakesPaths(row, paths) ? fit.takes : fit.testOnly).push(clauseId);
  }
  return fit;
}

/** The values each plan row change names besides its row [office laptop, 2026-11-19]: a correction needs every one. */
export const ROW_CHANGE_VALUES = Object.freeze({ 'set-fulfillment': ['fulfillment'], 'add-test': ['test'], 'replace-test': ['from', 'to'],
  'replace-location': ['from', 'to'], 'remove-location': ['path'], 'add-row': [] });
/** The fulfillment kinds a plan row takes (specifications.mjs FULFILLMENT_TYPES, which a test holds this to), the usual ones first. */
export const ROW_FULFILLMENTS = Object.freeze(['modified', 'new', 'test-only', 'existing', 'removed', 'document', 'configuration', 'evidence']);

/** The values a row change leaves out (or names wrongly, for a fulfillment), or [] when it is complete. */
export function rowChangeMissing(change) {
  return (ROW_CHANGE_VALUES[change?.op] ?? []).filter((key) => !String(change?.[key] ?? '').trim()
    || (key === 'fulfillment' && !ROW_FULFILLMENTS.includes(String(change.fulfillment))));
}

const wordList = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/**
 * Why the files are not added to the named rows clausesTakingPaths left out, in plain words: "AC-002 only checks
 * tests, so these files are not added to it." `mode` is 'is' (before), 'was' (after) or 'cannot'; '' when none.
 */
export function leftOutWords({ testOnly = [], noRow = [] }, { name = (id) => id, subject, plural = false, mode = 'is' }) {
  const verb = mode === 'cannot' ? 'cannot be' : mode === 'was' ? `${plural ? 'were' : 'was'} not` : `${plural ? 'are' : 'is'} not`;
  const to = (ids) => (ids.length === 1 ? 'it' : 'them');
  return [testOnly.length ? `${wordList(testOnly.map(name))} only ${testOnly.length === 1 ? 'checks' : 'check'} tests, so ${subject} ${verb} added to ${to(testOnly)}.` : '',
    noRow.length ? `${wordList(noRow.map(name))} ${noRow.length === 1 ? 'has' : 'have'} no row in the plan, so ${subject} ${verb} added to ${to(noRow)}.` : '']
    .filter(Boolean).join(' ');
}

/** Every row of the plan as planRowsOf shows one, however long the plan: a named clause is looked up among all of them. */
export function allPlanRows(planned) {
  return Object.entries(planned ?? {}).map(([clauseId, claim]) => ({ clauseId,
    ...(claim.observableResult ? { result: String(claim.observableResult).slice(0, 120) } : {}),
    ...(claim.fulfillment === 'test-only' ? { testOnly: true } : {}) }));
}

/**
 * A refused add-location, said with the rows that can take the file and the filled command for each, so the refusal is
 * never a dead end [owner, 2026-11-19]. Its code stays PLAN_AMENDMENT_INVALID; any other refusal is returned as it was.
 */
export function explainedAmendmentRefusal(error, { workId, plan = {}, changes = [] }) {
  const clauseId = error?.details?.clauseId;
  const file = changes.find((change) => change.kind === 'add-location' && String(change.clauseId ?? '').toUpperCase() === clauseId)?.path;
  if (error?.code !== 'PLAN_AMENDMENT_INVALID' || !clauseId || typeof file !== 'string' || !/^[\w./@+-]+$/u.test(file)) return error;
  const rows = Object.keys(plan).filter((id) => id !== clauseId && rowTakesPaths(plan[id], [file]));
  const routes = rows.slice(0, 3).map((id) => ({ label: `Add ${file} to ${id} instead.`, command: `singularity-flow decision plan ${workId} --fetch --add-location ${id}=${file} --reason "<REASON>"` }));
  const message = plan[clauseId] && !rowTakesPaths(plan[clauseId], [file])
    ? `${clauseId} only checks tests (test-only): only a test or test-support file can be added to it, and ${file} is not one. ${rows.length
      ? `Add it to a row that can take it instead: ${rows.slice(0, 12).join(', ')}.` : 'No other row of the plan can take it: every row only checks tests.'}`
    : error.message;
  return new SingularityFlowError(message, { code: error.code, details: { ...error.details, path: file, rows, recoveryCommands: routes } });
}

/**
 * A plan row change in plain words, with its exact rows, as every host shows it before a person keeps it: on the card,
 * and in chat as the question's text [owner, 2026-11-19].
 */
export function rowChangeWords(change = {}) {
  const row = change.clauseId ?? 'a row';
  switch (change.op) {
    case 'set-fulfillment': return String(change.fulfillment ?? '').trim() ? `${row} becomes ${change.fulfillment}` : `${row}'s fulfillment changes (what it becomes was not named)`;
    case 'add-row': return `a row is added for ${row}`;
    case 'remove-location': return `${change.path} is taken out of ${row}'s row`;
    case 'replace-location': return `${row}'s row names ${change.to} instead of ${change.from}`;
    case 'add-test': return `${change.test} is added to ${row}'s tests`;
    case 'replace-test': return `${row}'s test ${change.from} becomes ${change.to}`;
    default: return `${row}'s row changes (${change.op ?? 'unknown'})`;
  }
}
