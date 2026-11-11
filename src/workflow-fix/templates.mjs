/**
 * What `workflow fix` drafts into a step's template. A template is copied by every Story and filled
 * by that Story's author, so a fix only ever adds structure the kernel reads, with placeholders:
 * a clause anchor on a TODO line, a planned-claims table whose cells say TODO, a section heading
 * with a TODO line. It never writes a requirement, a path or a test a person would mistake for real.
 *
 * The anchor and table forms are the kernel's own: `[{{work.id}}:REQ-001]` (the token step entry
 * renders as the Story's Work ID, src/config.mjs ARTIFACT_TEMPLATE_TOKENS) and the
 * `| Clause | Expected paths | Planned tests | Fulfillment | Observable result |` header the
 * planned-claim parser reads (src/specifications.mjs inspectPlannedClaimMap).
 */
import { ARTIFACT_TEMPLATE_TOKENS } from '../config.mjs';
import { FULFILLMENT_TYPES } from '../specifications.mjs';
import { GOVERNED_CLAUSE_TYPE_PATTERN } from '../traceability-ids.mjs';
import { PLANNED_TABLE_HEADER } from '../workflow-template-conformance.mjs';
import { addSection, addSectionAfter, appendToSection, findHeading } from './text.mjs';

const WORK_ID = ARTIFACT_TEMPLATE_TOKENS.workId;
export const REQUIREMENT_PLACEHOLDER = `- TODO: one observable requirement per line. [${WORK_ID}:REQ-001]`;
export const CRITERION_PLACEHOLDER = `- TODO: one testable criterion per line. [${WORK_ID}:AC-001]`;
const DIVIDER = '|---|---|---|---|---|';
const PATHS_TODO = 'TODO: replace with exact backticked repository-relative source paths';
const TESTS_TODO = 'TODO: replace with exact backticked repository-relative test paths';
const OBSERVABLE_TODO = 'TODO: what a person can observe when it works';

const REQUIREMENTS = /requirement/u;
const CRITERIA = /acceptance|criteri/u;
const PLANNED = /planned|implementation (?:evidence|plan)|claims/u;
// Sections that close a requirements document: new sections go before them, not after.
const CLOSING = /out of scope|non-goals|exclusions|risks|open questions|dependencies|notes|references/u;
const NAMESPACE = '(?:\\{\\{work\\.id\\}\\}|\\{\\{WORK_ID\\}\\}|[A-Za-z0-9][A-Za-z0-9._-]{0,63})';
const ANCHOR = new RegExp(`\\[(${NAMESPACE}):(${GOVERNED_CLAUSE_TYPE_PATTERN})-(\\d{3})\\]`, 'gu');
const CITED = new RegExp(`(${NAMESPACE}):(${GOVERNED_CLAUSE_TYPE_PATTERN})-(\\d{3})`, 'u');
const STEP_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const PLANNED_START = /^\|\s*clause\s*\|\s*expected paths\s*\|\s*planned tests\s*\|/iu;

/** Lines outside fenced code and HTML comments: what the kernel reads anchors from. */
function visibleLines(text) {
  let fenced = false; let comment = false;
  return String(text).split('\n').map((line) => {
    if (/^\s*(```|~~~)/u.test(line)) { fenced = !fenced; return ''; }
    if (fenced) return '';
    let shown = '';
    let rest = line;
    while (rest) {
      if (comment) {
        const close = rest.indexOf('-->');
        if (close < 0) { rest = ''; break; }
        rest = rest.slice(close + 3); comment = false;
      } else {
        const open = rest.indexOf('<!--');
        if (open < 0) { shown += rest; break; }
        shown += rest.slice(0, open); rest = rest.slice(open + 4); comment = true;
      }
    }
    return shown;
  });
}

/** The clause anchors a template defines, in order: `{ namespace, type, number, id }`, `id` as a table cites it. */
export function templateAnchors(text) {
  const anchors = [];
  for (const line of visibleLines(text)) {
    for (const match of line.replace(/`[^`]*`/gu, '').matchAll(ANCHOR)) {
      anchors.push({ namespace: match[1], type: match[2].toUpperCase(), number: match[3], id: `${match[1]}:${match[2].toUpperCase()}-${match[3]}` });
    }
  }
  return [...new Map(anchors.map((anchor) => [anchor.id, anchor])).values()];
}

/**
 * The template with a requirement and an acceptance criterion anchor, each on a TODO placeholder
 * line at the end of its section. A section that is missing is added (Requirements before the
 * closing sections, Acceptance criteria after Requirements). Everything already there stays.
 */
export function withClauseAnchors(text) {
  let next = String(text);
  const added = [];
  const requirements = appendToSection(next, REQUIREMENTS, REQUIREMENT_PLACEHOLDER);
  if (requirements != null) next = requirements;
  else {
    next = addSection(next, 'Requirements', REQUIREMENT_PLACEHOLDER, { before: findHeading(next, CRITERIA) ? CRITERIA : CLOSING });
    added.push('Requirements');
  }
  const criteria = appendToSection(next, CRITERIA, CRITERION_PLACEHOLDER);
  if (criteria != null) next = criteria;
  else {
    next = addSectionAfter(next, REQUIREMENTS, 'Acceptance criteria', CRITERION_PLACEHOLDER);
    added.push('Acceptance criteria');
  }
  return { text: next, added };
}

/** One placeholder row of the planned-claims table for a clause the template cites. */
function placeholderRow(id, { steps = false } = {}) {
  return `| \`${id}\` | ${PATHS_TODO} | ${TESTS_TODO} | new |${steps ? ' |' : ''} ${OBSERVABLE_TODO} |`;
}

/** The planned-claims table with one TODO row per clause, as the kernel reads it. */
export function plannedTable(ids, { steps = false } = {}) {
  const header = steps ? PLANNED_TABLE_HEADER.replace('| Fulfillment |', '| Fulfillment | Steps |') : PLANNED_TABLE_HEADER;
  const divider = steps ? `${DIVIDER}---|` : DIVIDER;
  return [header, divider, ...(ids.length ? ids : [`${WORK_ID}:REQ-001`]).map((id) => placeholderRow(id, { steps }))].join('\n');
}

/**
 * The template with a planned-claims table: one TODO row per clause anchor it defines (or one
 * REQ-001 row a later step's scaffold replaces with the clauses earlier steps defined), under a
 * heading about the plan when there is one, else in a new "Planned implementation evidence" section.
 */
export function withPlannedTable(text) {
  const table = plannedTable(templateAnchors(text).map((anchor) => anchor.id));
  const placed = appendToSection(String(text), PLANNED, table);
  if (placed != null) return { text: placed, added: [] };
  return { text: addSection(String(text), 'Planned implementation evidence', table, { before: CLOSING }), added: ['Planned implementation evidence'] };
}

const cellsOf = (line) => line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((cell) => cell.trim());
const isTableLine = (line) => /^\s*\|/u.test(line ?? '');
const isDivider = (line) => /^\s*\|[\s:|-]+\|\s*$/u.test(line ?? '') && /-/u.test(line);

function columnOf(name) {
  const value = name.toLowerCase();
  if (/clause/u.test(value)) return 'clause';
  if (/test/u.test(value)) return 'tests';
  if (/path|file/u.test(value)) return 'paths';
  if (/fulfil/u.test(value)) return 'fulfillment';
  if (/step/u.test(value)) return 'steps';
  if (/observ|result|outcome/u.test(value)) return 'observable';
  return null;
}

/**
 * The planned-claims table nearest `line` rebuilt in the form the kernel reads: the header in its
 * order, a divider, and one row per clause the old rows cite, each keeping the cells that were
 * there (paths, tests, a valid fulfillment, valid step IDs, the observable result) and TODO for
 * the rest. Null when no table that names a clause, paths or tests is there.
 */
export function rebuiltPlannedTable(text, line = 1) {
  const lines = String(text).split('\n');
  const headers = lines.map((entry, index) => ({ entry, index }))
    .filter(({ entry, index }) => isTableLine(entry) && !isTableLine(lines[index - 1]) && /clause/iu.test(entry) && /path|test/iu.test(entry));
  if (!headers.length) return null;
  const start = headers.reduce((best, candidate) => (Math.abs(candidate.index + 1 - line) < Math.abs(best.index + 1 - line) ? candidate : best)).index;
  let end = start;
  while (isTableLine(lines[end + 1])) end += 1;
  const columns = cellsOf(lines[start]).map(columnOf);
  const keepSteps = columns.includes('steps');
  const rows = [];
  for (const raw of lines.slice(start + 1, end + 1)) {
    if (isDivider(raw)) continue;
    const cells = cellsOf(raw);
    const cell = (name) => { const at = columns.indexOf(name); return at >= 0 ? cells[at] ?? '' : ''; };
    const clause = CITED.exec(cell('clause') || cells[0] || '');
    if (!clause) continue;
    const id = `${clause[1]}:${clause[2].toUpperCase()}-${clause[3]}`;
    const fulfillment = cell('fulfillment').replace(/^`|`$/gu, '').toLowerCase();
    const steps = cell('steps').split(/[\s,;]+/u).map((entry) => entry.replace(/^`|`$/gu, '')).filter(Boolean);
    const row = [`\`${id}\``, cell('paths') || PATHS_TODO, cell('tests') || TESTS_TODO, FULFILLMENT_TYPES.includes(fulfillment) ? fulfillment : 'new',
      ...(keepSteps ? [steps.every((entry) => STEP_ID.test(entry)) ? steps.join(', ') : ''] : []), cell('observable').replace(/\|/gu, '/') || OBSERVABLE_TODO];
    if (!rows.some((existing) => existing[0] === row[0])) rows.push(row);
  }
  const ids = rows.length ? null : templateAnchors(text).map((anchor) => anchor.id);
  const table = rows.length
    ? [plannedTable([], { steps: keepSteps }).split('\n').slice(0, 2).join('\n'), ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n')
    : plannedTable(ids, { steps: keepSteps });
  return [...lines.slice(0, start), ...table.split('\n'), ...lines.slice(end + 1)].join('\n');
}

/**
 * The anchors renumbered so each is defined once: `[{{work.id}}:<TYPE>-<NNN>]`, numbered per type
 * after the clauses in `taken` (what earlier steps' templates define). Anchors in code or comments stay.
 */
export function renumberedAnchors(text, taken = []) {
  const next = new Map();
  for (const anchor of taken) next.set(anchor.type, Math.max(next.get(anchor.type) ?? 0, Number(anchor.number)));
  const visible = visibleLines(text);
  return String(text).split('\n').map((line, index) => (visible[index] === line ? line.replace(ANCHOR, (whole, namespace, type) => {
    const kind = type.toUpperCase();
    next.set(kind, (next.get(kind) ?? 0) + 1);
    return `[${WORK_ID}:${kind}-${String(next.get(kind)).padStart(3, '0')}]`;
  }) : line)).join('\n');
}

/**
 * The planned-claims table with a Steps column after Fulfillment (or after Planned tests), empty in
 * every row for the Story's author to name each row's code step. Null when there is no such table.
 */
export function withStepsColumn(text) {
  const lines = String(text).split('\n');
  const start = lines.findIndex((line) => PLANNED_START.test(line));
  if (start < 0 || /\|\s*steps\s*\|/iu.test(lines[start])) return null;
  const at = cellsOf(lines[start]).findIndex((cell) => /fulfil/iu.test(cell)) + 1 || 3;
  for (let index = start; isTableLine(lines[index]); index += 1) {
    const cells = cellsOf(lines[index]);
    cells.splice(at, 0, index === start ? 'Steps' : isDivider(lines[index]) ? '---' : '');
    lines[index] = `| ${cells.join(' | ')} |`.replace(/\|  \|/gu, '|  |');
  }
  return lines.join('\n');
}

/** Sections a step's publication checks for, each added with a TODO line, at the end. */
export function withSections(text, sections) {
  let next = String(text);
  for (const section of sections) next = addSection(next, section, `TODO: write the ${section.toLowerCase()} for this Story.`);
  return next;
}

/**
 * The template with only tokens step entry fills: a token that means a supported one in another
 * spelling ({{ work.id }}, {{workId}}, {{WORK.ID}}) becomes it; any other becomes a TODO in words.
 */
export function withSupportedTokens(text) {
  const supported = new Set([...Object.values(ARTIFACT_TEMPLATE_TOKENS), '{{WORK_ID}}']);
  const byKey = new Map(Object.values(ARTIFACT_TEMPLATE_TOKENS).map((token) => [token.replace(/[^a-z]/giu, '').toLowerCase(), token]));
  const replaced = [];
  const next = String(text).replace(/\{\{[^{}\r\n]+\}\}/gu, (token) => {
    if (supported.has(token)) return token;
    const inner = token.slice(2, -2).trim();
    const same = byKey.get(inner.replace(/[^a-z]/giu, '').toLowerCase());
    replaced.push({ from: token, to: same ?? null });
    return same ?? `TODO (${inner})`;
  });
  return { text: next, replaced };
}
