/** Structural scenario coverage, not a judgment that prose implements the requested behavior. */
import { parseMarkdownStructure } from './markdown-structure.mjs';
import { normalizeQualifiedClauseId } from './traceability-ids.mjs';
import { shown } from './draft-diagnostics.mjs';

const OUTCOMES = new Set(['success', 'failure', 'boundary', 'empty']);
const FAILURE_HINT = /\b(?:reject(?:s|ed|ing)?|(?:return|show|display|report|raise|produce)s?\b[^.\n]{0,60}\b(?:error|failure)|(?:error|failure)\s+(?:for|when|if|on))\b/iu;
const SCENARIO = /^(S\d+)(?:\s|[—–:-]|$)/iu;

// Comments and example code cannot supply acceptance cases. Preserve offsets and line numbers;
// inline code stays visible because an observable outcome may be the literal `Error`.
function prose(markdown) {
  const authored = markdown.replace(/<!--\s*singularity-flow:inputs:start\s*-->[\s\S]*?<!--\s*singularity-flow:inputs:end\s*-->/gu,
    block => block.replace(/[^\r\n]/gu, ' '));
  const structure = parseMarkdownStructure(authored);
  let fence = null;
  const visible = structure.visibleText.split('\n').map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length
          && !marker[2].trim()) fence = null;
      return line.replace(/[^\r]/gu, ' ');
    }
    if (marker) {
      fence = { character: marker[1][0], length: marker[1].length };
      return line.replace(/[^\r]/gu, ' ');
    }
    return /^ {4}|^\t/u.test(line) ? line.replace(/[^\r]/gu, ' ') : line;
  }).join('\n');
  return { structure, visible };
}

function acceptanceCases(body) {
  const keywords = body.replace(/`+[^`\n]*`+/gu, block => ' '.repeat(block.length));
  const tokens = [...keywords.matchAll(/\b(Given|When|Then)\b/giu)];
  const groups = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index][1].toLowerCase() !== 'given') continue;
    let end = index + 1;
    while (end < tokens.length && tokens[end][1].toLowerCase() !== 'given') end += 1;
    const group = tokens.slice(index, end);
    const fields = group.map((token, offset) => ({
      name: token[1].toLowerCase(),
      text: body.slice(token.index + token[0].length, group[offset + 1]?.index
        ?? tokens[end]?.index ?? body.length).replace(/^[ *:_-]+/u, '').split(/\n\s*\n/u)[0].trim()
    }));
    groups.push({ complete: fields.length === 3 && fields.map(field => field.name).join(',') === 'given,when,then'
      && fields.every(field => /[\p{L}\p{N}]/u.test(field.text)),
    text: fields.map(field => field.text).join(' '),
    keywords: fields.map(field => field.name[0].toUpperCase() + field.name.slice(1)),
    empty: fields.filter(field => !/[\p{L}\p{N}]/u.test(field.text)).map(field => field.name[0].toUpperCase() + field.name.slice(1)) });
    index = end - 1;
  }
  return groups;
}

/** The first line, outside headings and tables, that names a scenario ID: where an author wrote it. */
function nearScenario(visible, scenarioId) {
  const pattern = new RegExp(`(?:^|[^A-Za-z0-9])${scenarioId}(?![0-9])`, 'iu');
  const lines = visible.split('\n');
  const at = lines.findIndex(line => pattern.test(line) && !/^\s*\|/u.test(line));
  return at < 0 ? null : { line: at + 1, text: lines[at], heading: /^\s*#/u.test(lines[at]) };
}

/**
 * Why a scenario's cases are incomplete. Every "when" and "then", in any case and mid-sentence, starts
 * a field, so a sentence such as "signed in when..." splits a case; the keywords found are named.
 */
function incompleteScenario(scenarioId, scenario) {
  const base = `${scenarioId} needs substantive Given, When and Then fields in every acceptance case; Then must state an observable outcome.`;
  if (!scenario.cases?.length) return `${base} No case starting with Given was found.`;
  const at = scenario.cases.findIndex(entry => !entry.complete);
  const entry = scenario.cases[at];
  if (!entry) return base;
  const order = entry.keywords.join(', ');
  return order !== 'Given, When, Then'
    ? `${base} Case ${at + 1} reads ${order}: every "given", "when" and "then", in any case and mid-sentence, starts a new field, so use each once per case, in that order, and reword the others (for example "once" or "so").`
    : `${base} Case ${at + 1} has nothing after ${entry.empty.join(' and ')}.`;
}

/** A declared matrix is checked exactly; lexical failure hints are always advisories only. */
export function inspectSpecificationScenarios(markdown, clauses, { required = false, clausesKnown = true } = {}) {
  const { structure, visible } = prose(String(markdown));
  const findings = [];
  const advisories = [];
  const add = (kind, message, details = {}) => findings.push({ kind, message, ...details });
  const scenarios = new Map();
  const sections = structure.headings.filter(heading => heading.normalized === 'scenario coverage');
  const declared = sections.length > 0;
  const scenarioHeadings = structure.headings.filter(heading => SCENARIO.test(heading.title));
  for (const [index, heading] of scenarioHeadings.entries()) {
    const match = SCENARIO.exec(heading.title);
    if (!match) continue;
    const id = match[1].toUpperCase();
    const body = visible.slice(heading.contentStart, Math.min(heading.end, scenarioHeadings[index + 1]?.index ?? visible.length));
    const cases = acceptanceCases(body);
    if (scenarios.has(id)) {
      if (declared || required) add('scenario-definition-duplicate', `${id} is declared more than once; give each situation a distinct scenario ID.`, { line: heading.line, scenarioId: id });
      scenarios.set(id, { id, complete: false, cases: [], line: heading.line });
    } else scenarios.set(id, { id, complete: cases.length > 0 && cases.every(entry => entry.complete), cases, line: heading.line });
  }

  const clauseById = new Map(clauses.map(clause => [clause.id, clause]));
  const rows = [];
  const seen = new Set();
  const refused = new Set();
  let tableRefused = false;
  if (required && !declared) add('scenario-coverage-required', 'Add ## Scenario coverage with Clause | Scenario | Outcome and map each behavior/acceptance clause to a complete Given/When/Then scenario.');
  if (sections.length > 1) add('scenario-coverage-duplicate', 'Use one ## Scenario coverage table, not multiple competing coverage sections.', { line: sections[1].line });
  if (declared) {
    const section = sections[0];
    const lines = visible.slice(section.contentStart, section.end).split('\n');
    const firstLine = visible.slice(0, section.contentStart).split('\n').length;
    const header = lines.findIndex(line => /^\|\s*Clause\s*\|\s*Scenario\s*\|\s*Outcome\s*\|\s*$/iu.test(line.trim()));
    if (header < 0 || !/^\|[\s:|\-]+\|$/u.test(lines[header + 1]?.trim() ?? '')) {
      const found = lines.find(line => /^\s*\|/u.test(line));
      tableRefused = true;
      add('scenario-coverage-format', 'Scenario coverage needs one Markdown table whose header is exactly Clause | Scenario | Outcome, followed by a separator row'
        + (found ? `; its first table row holds ${shown(found)}. Keep notes outside the table` : '') + '.', { line: section.line });
    } else {
      for (let index = header + 2; index < lines.length && /^\s*\|/u.test(lines[index]); index += 1) {
        const line = firstLine + index;
        const cells = lines[index].trim().split('|').slice(1, -1).map(cell => cell.trim().replace(/^`([^`]+)`$/u, '$1'));
        const clauseId = normalizeQualifiedClauseId(cells[0]);
        const scenarioId = String(cells[1] ?? '').toUpperCase();
        const outcome = String(cells[2] ?? '').toLowerCase();
        if (cells.length !== 3 || !clauseId || !/^S\d+$/u.test(scenarioId) || !OUTCOMES.has(outcome)) {
          const problem = cells.length !== 3 ? `it has ${cells.length} cells; Clause | Scenario | Outcome has three`
            : !clauseId ? `its Clause holds ${shown(cells[0])}; write one exact clause ID such as \`ORDER:REQ-001\``
              : !/^S\d+$/u.test(scenarioId) ? `its Scenario holds ${shown(cells[1])}; write only the scenario's number, such as \`S1\``
                : `its Outcome holds ${shown(cells[2])}; write success, failure, boundary or empty`;
          add('scenario-coverage-row-invalid', `Scenario coverage row at line ${line}: ${problem}.`, { line, ...(clauseId ? { clauseId } : {}) });
          if (clauseId) refused.add(clauseId);
          continue;
        }
        if (clausesKnown && !clauseById.has(clauseId)) add('scenario-coverage-clause-unknown', `${clauseId} is not declared by this specification.`, { line, clauseId });
        const key = `${clauseId}:${scenarioId}:${outcome}`;
        if (seen.has(key)) add('scenario-coverage-row-duplicate', `Duplicate scenario coverage row for ${clauseId}, ${scenarioId}, ${outcome}.`, { line, clauseId, scenarioId });
        seen.add(key);
        const scenario = scenarios.get(scenarioId);
        if (!scenario) {
          // A scenario counts only as a heading; one written as bold text or a list item read as missing.
          const near = nearScenario(visible, scenarioId);
          add('scenario-coverage-scenario-missing', `${clauseId} references ${scenarioId}, but no heading starts with ${scenarioId}`
            + (near ? ` (line ${near.line} holds ${shown(near.text)}, ${near.heading ? `a heading that does not start with ${scenarioId}` : 'which is not a heading'})` : '')
            + `. A scenario is a heading such as \`### ${scenarioId} — <situation>\` followed by its Given/When/Then cases; author it from the pinned request and clarifications.`, { line, clauseId, scenarioId });
        } else if (!scenario.complete) add('scenario-acceptance-incomplete', incompleteScenario(scenarioId, scenario), { line: scenario.line, clauseId, scenarioId });
        rows.push({ clauseId, scenarioId, outcome });
      }
    }
    for (const clause of clauses.filter(clause => clause.type !== 'CON')) {
      // A row refused above already says what to fix; "has no row" contradicted it.
      if (!tableRefused && !rows.some(row => row.clauseId === clause.id) && !refused.has(clause.id)) add('scenario-coverage-clause-missing', `${clause.id} has no scenario coverage row; map its stated obligation, without inventing or expanding scope.`, { line: clause.source?.line, clauseId: clause.id });
    }
  }

  for (const clause of clauses.filter(clause => FAILURE_HINT.test(clause.body))) {
    const linked = declared ? rows.filter(row => row.clauseId === clause.id && row.outcome === 'failure')
      .map(row => scenarios.get(row.scenarioId)) : [...scenarios.values()];
    if (linked.some(scenario => scenario?.complete && scenario.cases.some(entry => FAILURE_HINT.test(entry.text)))) continue;
    advisories.push({ kind: 'failure-scenario-review', clauseId: clause.id, line: clause.source?.line,
      message: `${clause.id} states rejection/error behavior but has no recognized complete failure acceptance scenario. Review the pinned request and clarifications; add a distinct Given/When/Then case with the invalid condition, action, and observable error. This lexical hint is not a semantic verdict or a new requirement.` });
  }
  return { findings, advisories, declared, scenarioCount: scenarios.size, rows };
}
