/** Structural scenario coverage, not a judgment that prose implements the requested behavior. */
import { parseMarkdownStructure } from './markdown-structure.mjs';
import { normalizeQualifiedClauseId } from './traceability-ids.mjs';

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
    text: fields.map(field => field.text).join(' ') });
    index = end - 1;
  }
  return groups;
}

/** A declared matrix is checked exactly; lexical failure hints are always advisories only. */
export function inspectSpecificationScenarios(markdown, clauses, { required = false } = {}) {
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
  if (required && !declared) add('scenario-coverage-required', 'Add ## Scenario coverage with Clause | Scenario | Outcome and map each behavior/acceptance clause to a complete Given/When/Then scenario.');
  if (sections.length > 1) add('scenario-coverage-duplicate', 'Use one ## Scenario coverage table, not multiple competing coverage sections.', { line: sections[1].line });
  if (declared) {
    const section = sections[0];
    const lines = visible.slice(section.contentStart, section.end).split('\n');
    const firstLine = visible.slice(0, section.contentStart).split('\n').length;
    const header = lines.findIndex(line => /^\|\s*Clause\s*\|\s*Scenario\s*\|\s*Outcome\s*\|\s*$/iu.test(line.trim()));
    if (header < 0 || !/^\|[\s:|\-]+\|$/u.test(lines[header + 1]?.trim() ?? '')) {
      add('scenario-coverage-format', 'Scenario coverage needs a Markdown table with Clause | Scenario | Outcome and a separator row.', { line: section.line });
    } else {
      for (let index = header + 2; index < lines.length && /^\s*\|/u.test(lines[index]); index += 1) {
        const line = firstLine + index;
        const cells = lines[index].trim().split('|').slice(1, -1).map(cell => cell.trim().replace(/^`([^`]+)`$/u, '$1'));
        const clauseId = normalizeQualifiedClauseId(cells[0]);
        const scenarioId = String(cells[1] ?? '').toUpperCase();
        const outcome = String(cells[2] ?? '').toLowerCase();
        if (cells.length !== 3 || !clauseId || !/^S\d+$/u.test(scenarioId) || !OUTCOMES.has(outcome)) {
          add('scenario-coverage-row-invalid', 'Use one exact clause ID, S-number scenario ID, and success/failure/boundary/empty outcome per row.', { line });
          continue;
        }
        if (!clauseById.has(clauseId)) add('scenario-coverage-clause-unknown', `${clauseId} is not declared by this specification.`, { line, clauseId });
        const key = `${clauseId}:${scenarioId}:${outcome}`;
        if (seen.has(key)) add('scenario-coverage-row-duplicate', `Duplicate scenario coverage row for ${clauseId}, ${scenarioId}, ${outcome}.`, { line, clauseId, scenarioId });
        seen.add(key);
        const scenario = scenarios.get(scenarioId);
        if (!scenario) add('scenario-coverage-scenario-missing', `${clauseId} references missing ${scenarioId}; author that scenario from the pinned request and clarifications.`, { line, clauseId, scenarioId });
        else if (!scenario.complete) add('scenario-acceptance-incomplete', `${scenarioId} needs substantive Given, When and Then fields in every acceptance case; Then must state an observable outcome.`, { line: scenario.line, clauseId, scenarioId });
        rows.push({ clauseId, scenarioId, outcome });
      }
    }
    for (const clause of clauses.filter(clause => clause.type !== 'CON')) {
      if (!rows.some(row => row.clauseId === clause.id)) add('scenario-coverage-clause-missing', `${clause.id} has no scenario coverage row; map its stated obligation, without inventing or expanding scope.`, { line: clause.source?.line, clauseId: clause.id });
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
