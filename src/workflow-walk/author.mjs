/**
 * The walk's stub author: deterministic, model-free text for a step's draft, as an agent that read
 * the step's template would write it for the walk's one small change (the value module returns 2).
 *
 * It fills the template the step was prepared from, so a custom template is walked as its team wrote
 * it: every TODO, angle-bracket placeholder and empty table cell gets plain words, a table column
 * gets a value its header asks for (a path, a planned test, an outcome), a `TODO: a/b/c` choice takes
 * its first option, and a section that only says what belongs in it gets a sentence. Per-clause
 * tables get one row per clause the Story has (a template's example rows name clauses the Story may
 * not have). Only what the platform itself requires and the template does not hold is added, and
 * each addition is named so the walk can report it: clause anchors in a step that defines clauses,
 * the planned-claims table in a step that plans a code step, an S1 scenario a scenario table cites.
 */
export const SOURCE_PATH = 'src/value.mjs';
export const TEST_PATH = 'test/value.test.mjs';

const ANCHOR = /\[([A-Z][A-Z0-9]*-\d+):([A-Z][A-Z0-9]*-\d{3,})\]/gu;
const BACKTICKED_CLAUSE = /`([A-Z][A-Z0-9]*-\d+):([A-Z][A-Z0-9]*-\d{3,})`/gu;
const ANY_CLAUSE = /([A-Z][A-Z0-9]*-\d+):([A-Z][A-Z0-9]*-\d{3,})/u;

/** The clauses a draft defines: its `[WORK:REQ-001]` anchors, in order (an example in inline code defines nothing). */
export function definedClauses(text, workId) {
  const found = [];
  for (const match of stripIgnored(text).replace(/`[^`\n]*`/gu, '').matchAll(ANCHOR)) {
    if (match[1] === workId && !found.includes(`${match[1]}:${match[2]}`)) found.push(`${match[1]}:${match[2]}`);
  }
  return found;
}

/** Every clause a draft defines or names, in order: anchors and backticked IDs. */
export function draftClauses(text, workId) {
  const found = definedClauses(text, workId);
  for (const match of stripIgnored(text).matchAll(BACKTICKED_CLAUSE)) {
    if (match[1] === workId && !found.includes(`${match[1]}:${match[2]}`)) found.push(`${match[1]}:${match[2]}`);
  }
  return found;
}

const stripIgnored = (text) => String(text).replace(/<!--[\s\S]*?-->/gu, '').replace(/^(```|~~~)[\s\S]*?^\1/gmu, '');

const topicOf = (heading) => String(heading ?? '').replace(/^#+\s*/u, '').replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/gu, ' ').trim().toLowerCase();

/**
 * Plain words for a placeholder under `heading`. With `cite`, a step that is neither defining nor
 * planning the clauses names each one with the test that proves it, as a verifying step does.
 */
function sentence(heading, { cite = false, clauses = [] } = {}) {
  const topic = topicOf(heading);
  const cited = cite && clauses.length ? ` ${clauses.map((clause) => `\`${clause}\``).join(', ')} ${clauses.length === 1 ? 'is' : 'are'} proved by \`${TEST_PATH}\` against \`${SOURCE_PATH}\`.` : '';
  return `The value module returns the approved value 2 to every caller${topic ? `; this covers ${topic}` : ''}.${cited}`;
}

// Each clause a draft states says something of its own: a draft whose clauses repeat one sentence is refused.
const CLAUSE_SENTENCES = Object.freeze([
  'The value module returns the approved value 2', 'A caller that reads the value sees 2', 'The value stays 2 for every later read',
  'Reading the value needs no setup by the caller', 'The value module exports exactly one value', 'The value is the number 2, not a string',
  'A failed read reports its cause instead of a guessed value', 'The value module keeps no state between reads',
  'The value is available as soon as the module loads', 'Reading the value never changes it'
]);

/** Words for an angle-bracket placeholder, by what it names. */
function placeholderPhrase(inner) {
  const text = inner.trim().toLowerCase();
  if (/^[a-z]+(?:\|[a-z]+)+$/u.test(text)) return text.split('|')[0];
  if (/role|actor|who/u.test(text)) return 'a caller of the value module';
  if (/situation|scenario/u.test(text)) return 'A caller reads the approved value';
  if (/starting state|before|context|state/u.test(text)) return 'the value module is loaded';
  if (/actor does|action|does this/u.test(text)) return 'the caller reads the value';
  if (/outcome|result|then|expected|observable|requirement|behaviou?r/u.test(text)) return 'the value module returns the approved value 2';
  if (/name/u.test(text)) return 'the walk Story';
  return 'the value module returns 2';
}

/** A cell's words, from its column header and its hint. */
function cellValue(header, hint, { heading, clauses, clause }) {
  const name = String(header ?? '').toLowerCase();
  const options = /^\s*([a-z][a-z-]*(?:\s*\/\s*[a-z][a-z-]*)+)\s*$/u.exec(hint ?? '');
  if (options) return options[1].split('/')[0].trim();
  if (/^\s*(?:clause|criterion|requirement id|id)\s*$/u.test(name)) return clause ?? (clauses[0] ? `\`${clauses[0]}\`` : '-');
  if (/test/u.test(name)) return `\`${TEST_PATH}\``;
  if (/path|file|source|surface|component|module/u.test(name)) return `\`${SOURCE_PATH}\``;
  if (/fulfil/u.test(name)) return 'modified';
  if (/verdict|status/u.test(name)) return 'matched';
  if (/outcome/u.test(name) && !/observable/u.test(name)) return 'success';
  if (/method/u.test(name)) return 'test';
  if (/priority/u.test(name)) return 'P1';
  if (/scenario/u.test(name)) return 'S1';
  if (/step/u.test(name)) return '-';
  if (/evidence|proof|witness/u.test(name)) return `\`${TEST_PATH}\` passed on the recorded run`;
  return sentence(heading).replace(/\.$/u, '');
}

const splitRow = (line) => line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((cell) => cell.trim());
const joinRow = (cells) => `| ${cells.join(' | ')} |`;
const PLACEHOLDER = /<(?!!--|\/|br\b|https?:|[a-z]+:\/\/)([^<>\n]{1,160})>/gu;
const isSeparator = (cells) => cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
const hasPlaceholder = (value) => /\bTODO\b|\bTBD\b|<(?!!--)[^<>\n]{1,160}>|…/u.test(value);

function fillText(value, heading, options) {
  // A line that states a clause gets its own sentence.
  if (/\[[A-Z][A-Z0-9]*-\d+:[A-Z][A-Z0-9]*-\d{3,}\]/u.test(value) && options.counter) {
    const words = CLAUSE_SENTENCES[options.counter.next % CLAUSE_SENTENCES.length];
    options.counter.next += 1;
    let blank = 0;
    const phrase = () => ['callers reading the approved value 2', 'a read that returns 2', 'the value module', 'any change outside the value module'][blank++ % 4];
    return value.replace(/TODO:[^|\n]*?(?=\s*\[[A-Z][A-Z0-9]*-\d+:[A-Z])/u, words)
      .replace(/\b(?:TODO|TBD)\b/gu, phrase)
      .replace(PLACEHOLDER, () => words.charAt(0).toLowerCase() + words.slice(1)).replace(/…/gu, 'the value module returns 2');
  }
  return value
    .replace(/TODO:\s*([a-z][a-z-]*(?:\s*\/\s*[a-z][a-z-]*)+)(?=\s*(?:\||$))/gu, (whole, choices) => choices.split('/')[0].trim())
    // A TODO's hint runs to the end of its line, or to a clause anchor the line keeps.
    .replace(/TODO:[^|\n]*?(?=\s*\[[A-Z][A-Z0-9]*-\d+:[A-Z]|\s*\||$)/gmu, sentence(heading, options).replace(/\.$/u, ''))
    .replace(/\b(?:TODO|TBD)\b/gu, 'None for this change')
    .replace(PLACEHOLDER, (whole, inner) => placeholderPhrase(inner))
    .replace(/…/gu, 'the value module returns 2');
}

/** Lines of a markdown document with the state a filler needs: which are comments, code, headings, tables. */
function* walkLines(lines) {
  let fence = false; let comment = false; let heading = '';
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (comment) { if (trimmed.includes('-->')) comment = false; yield { index, kind: 'ignored', heading }; continue; }
    if (trimmed.startsWith('<!--')) { if (!trimmed.includes('-->')) comment = true; yield { index, kind: 'ignored', heading }; continue; }
    if (/^(```|~~~)/u.test(trimmed)) { fence = !fence; yield { index, kind: 'ignored', heading }; continue; }
    if (fence) { yield { index, kind: 'ignored', heading }; continue; }
    if (/^#{1,6}\s/u.test(trimmed)) { heading = trimmed; yield { index, kind: 'heading', heading }; continue; }
    yield { index, kind: trimmed.startsWith('|') ? 'table' : trimmed ? 'text' : 'blank', heading };
  }
}

/** Every table: its header, separator and row line indexes. */
function tablesOf(lines) {
  const tables = []; let current = null;
  for (const line of walkLines(lines)) {
    if (line.kind !== 'table') { current = null; continue; }
    const cells = splitRow(lines[line.index]);
    if (!current) { current = { header: cells, headerIndex: line.index, rows: [], heading: line.heading }; tables.push(current); continue; }
    if (isSeparator(cells) && !current.rows.length && current.separatorIndex == null) { current.separatorIndex = line.index; continue; }
    current.rows.push(line.index);
  }
  return tables.filter((table) => table.separatorIndex != null);
}

const clauseColumn = (header) => header.findIndex((cell) => /^(?:clause|criterion|requirement|acceptance criterion|clause id)$/iu.test(cell.trim()));
const isPlanTable = (header) => header.some((cell) => /expected paths/iu.test(cell)) && header.some((cell) => /planned tests/iu.test(cell));

/**
 * The template's draft with every placeholder filled. `clauses` are the Story's clauses known before
 * this step; `defines` says this step defines clauses (its anchors stay its own), `cite` that it
 * verifies them (its words name each clause with the test that proves it).
 */
export function fillDocument(text, { clauses = [], cite = false, defines = false, workId = null } = {}) {
  const lines = String(text).split('\n');
  const continuation = new Set();
  const counter = { next: 0 };
  for (const line of walkLines(lines)) {
    const value = lines[line.index];
    if (continuation.has(line.index)) continue;
    if (line.kind === 'heading' && hasPlaceholder(value)) lines[line.index] = fillText(value, '', {});
    if (line.kind !== 'text' || !hasPlaceholder(value)) continue;
    // A TODO paragraph is the author's to replace whole: its wrapped lines go with it.
    if (/^\s*TODO:/u.test(value) && !/\[[A-Z][A-Z0-9]*-\d+:/u.test(value)) {
      for (let next = line.index + 1; next < lines.length && lines[next].trim() && !/^\s*(?:#|\||[-*+] |\d+\. |<!--|```)/u.test(lines[next]); next += 1) continuation.add(next);
      lines[line.index] = sentence(line.heading, { cite, clauses });
      continue;
    }
    lines[line.index] = fillText(value, line.heading, { cite, clauses, counter });
  }
  for (const index of [...continuation].sort((left, right) => right - left)) lines.splice(index, 1);
  // The Story's clauses after this draft: what it defines, else what it was given.
  const own = defines && workId ? definedClauses(lines.join('\n'), workId) : [];
  const story = [...new Set([...clauses, ...own])];
  for (const table of tablesOf(lines).reverse()) {
    const column = clauseColumn(table.header);
    const plan = isPlanTable(table.header);
    const namesClauses = column >= 0 && table.rows.some((index) => ANY_CLAUSE.test(splitRow(lines[index])[column] ?? ''));
    // A defining table keeps its own anchors; any other per-clause table gets one row per Story clause.
    const defining = column >= 0 && table.rows.some((index) => /\[[A-Z][A-Z0-9]*-\d+:/u.test(splitRow(lines[index])[column] ?? ''));
    if (namesClauses && !defining && story.length && (plan || !defines)) {
      const pattern = splitRow(lines[table.rows[0]]);
      const rows = story.map((clause) => {
        const existing = table.rows.map((index) => splitRow(lines[index])).find((cells) => (cells[column] ?? '').includes(clause));
        const cells = (existing ?? pattern).map((cell, at) => (at === column ? `\`${clause}\`` : cell));
        // The stub's plan is its own: each clause lands in the value module and is proved by its test.
        const planned = (at) => plan && /expected paths|planned tests|fulfil/iu.test(table.header[at] ?? '');
        return joinRow(cells.map((cell, at) => (planned(at) || hasPlaceholder(cell) || (!existing && at !== column && ANY_CLAUSE.test(cell))
          ? cellValue(table.header[at], /TODO:\s*(.*)$/u.exec(cell)?.[1] ?? '', { heading: table.heading, clauses: story, clause: `\`${clause}\`` }) : cell)));
      });
      lines.splice(table.rows[0], table.rows.length, ...rows);
      continue;
    }
    for (const index of table.rows) {
      const cells = splitRow(lines[index]);
      if (!cells.some(hasPlaceholder)) continue;
      lines[index] = joinRow(cells.map((cell, at) => (hasPlaceholder(cell)
        ? cellValue(table.header[at], /TODO:\s*(.*)$/u.exec(cell)?.[1] ?? '', { heading: table.heading, clauses: story }) : cell)));
    }
  }
  return lines.join('\n');
}

/** Under each `##` section that holds no words of the author's yet, one sentence (a template of prompts only). */
export function answerSections(text, { cite = false, clauses = [] } = {}) {
  const lines = String(text).split('\n');
  const headings = [...walkLines(lines)].filter((line) => line.kind === 'heading' && /^##\s/u.test(lines[line.index].trim())).map((line) => line.index);
  for (const index of headings.reverse()) {
    let end = index + 1;
    while (end < lines.length && !/^#{1,2}\s/u.test(lines[end].trim())) end += 1;
    while (end > index + 1 && !lines[end - 1].trim()) end -= 1;
    lines.splice(end, 0, '', sentence(lines[index], { cite, clauses }));
  }
  return lines.join('\n');
}

/** An S1 scenario in the platform's Given/When/Then form, for a draft whose scenario table cites S1 and that has none. */
export function scenarioSection(text) {
  const lines = String(text).split('\n');
  if (/^#{2,4}\s+S1\b/mu.test(text) || !/\|\s*S1\s*\|/u.test(text)) return null;
  const at = lines.findIndex((line) => /^##\s+.*scenarios?\s*$/iu.test(line.trim()));
  const block = ['', '### S1 — A caller reads the approved value', '', '**Priority:** P1', '', '- **Given** the value module is loaded',
    '  **When** a caller reads the value', '  **Then** the caller receives the approved value 2', ''];
  if (at < 0) return `${text}\n## User scenarios\n${block.join('\n')}`;
  let end = at + 1;
  while (end < lines.length && !/^#{1,2}\s/u.test(lines[end].trim())) end += 1;
  lines.splice(end, 0, ...block);
  return lines.join('\n');
}

/** A requirements section with two anchored clauses, for a clause step whose template has none. */
export function clauseSection(workId) {
  return ['', '## Requirements', '', `- The value module returns the approved value 2. [${workId}:REQ-001]`,
    `- Every caller reads the approved value 2. [${workId}:AC-001]`, ''].join('\n');
}

/** The platform's planned-claims table: one row per clause, the walk's one source file and test. */
export function plannedClaimsSection(clauses) {
  return ['', '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests | Fulfillment |', '|---|---|---|---|',
    ...clauses.map((clause) => `| \`${clause}\` | \`${SOURCE_PATH}\` | \`${TEST_PATH}\` | modified |`), ''].join('\n');
}

/** Whether a draft already holds a planned-claims table (a header naming expected paths and planned tests). */
export function hasPlannedClaimsTable(text) {
  return String(text).split('\n').some((line) => line.trim().startsWith('|') && /expected paths/iu.test(line) && /planned tests/iu.test(line));
}

/**
 * The code step's change: the value module returns 2, each clause tagged where it lands and in its
 * test. A Story with no clauses (a workflow that defines none) gets the change untagged.
 */
export function codeChange(clauses, { pass = 1 } = {}) {
  const again = pass > 1 ? `, as pass ${pass} of this step confirms` : '';
  return {
    [SOURCE_PATH]: `${clauses.map((clause) => `// @clause:${clause} returns the approved value to its callers${again}\n`).join('')}export const value = 2;\n`,
    [TEST_PATH]: ["import test from 'node:test';", "import assert from 'node:assert/strict';", "import { value } from '../src/value.mjs';", '',
      ...clauses.map((clause) => `// @ac:${clause}`), "test('the value module returns the approved value', () => assert.equal(value, 2));", ''].join('\n')
  };
}
