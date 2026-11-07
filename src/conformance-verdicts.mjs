import { clauseMentionPattern, normalizeQualifiedClauseId } from './foundation/traceability-ids.mjs';
import { parseMarkdownStructure } from './kernel/artifact-content.mjs';
import { authoredArtifactText } from './publication-preflight.mjs';
import { discrepancyItemSha256 } from './records.mjs';

const BLOCKING = new Set(['missing', 'partial']);
const CLAUSE_HEADERS = new Set(['clause id', 'clause', 'id', 'criterion', 'specification clause']);

function tableCells(line) {
  const text = String(line).trim();
  if (!text.startsWith('|') || !text.endsWith('|')) return null;
  const cells = [];
  let cell = '';
  for (let index = 1; index < text.length; index += 1) {
    if (text[index] === '\\' && text[index + 1] === '|') {
      cell += '|';
      index += 1;
    } else if (text[index] === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += text[index];
    }
  }
  return cells;
}

function plainCell(cell) {
  return String(cell).replaceAll('`', '').replace(/^\*+|\*+$/g, '').trim();
}

function heading(cell) {
  return plainCell(cell).toLowerCase().replace(/\s+/g, ' ');
}

function separator(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function fenceMarker(line) {
  const match = String(line).match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
  return match ? { character: match[1][0], length: match[1].length, rest: match[2] } : null;
}

function visibleTableLines(markdown) {
  let fence = null;
  const authored = authoredArtifactText(markdown, { preserveLines: true });
  return parseMarkdownStructure(authored).visibleText.split(/\r?\n/).map((line) => {
    const marker = fenceMarker(line);
    if (fence) {
      if (marker?.character === fence.character && marker.length >= fence.length
          && /^[ \t]*$/u.test(marker.rest)) fence = null;
      return '';
    }
    if (marker) {
      fence = marker;
      return '';
    }
    return line;
  });
}

/** Read only comparison tables that identify their clause and verdict columns in the header. */
export function conformanceTableRows(markdown) {
  const rows = [];
  let candidate = null;
  let columns = null;
  for (const [index, line] of visibleTableLines(markdown).entries()) {
    const cells = tableCells(line);
    if (!cells) {
      candidate = null;
      columns = null;
      continue;
    }
    if (separator(cells)) {
      if (candidate && cells.length === candidate.length) {
        const headers = candidate.map(heading);
        const clause = headers.findIndex((value) => CLAUSE_HEADERS.has(value));
        const verdict = headers.findIndex((value) => value === 'verdict');
        columns = clause >= 0 && verdict >= 0 ? { clause, verdict } : null;
      } else columns = null;
      candidate = null;
      continue;
    }
    if (!columns) {
      candidate = cells;
      continue;
    }
    if (cells.length <= Math.max(columns.clause, columns.verdict)) continue;
    rows.push({
      clauseId: plainCell(cells[columns.clause]),
      verdict: plainCell(cells[columns.verdict]).toLowerCase(),
      line: index + 1
    });
  }
  return rows;
}

/**
 * Tables whose header lacks a clause column or a Verdict column, so none of their rows is read. A
 * "Status" column read as no rows at all, and the report then said every clause had no row
 * (2026-10-29). Returns each such table's line and header.
 */
export function unreadConformanceTables(markdown) {
  const found = [];
  let candidate = null;
  for (const [index, line] of visibleTableLines(markdown).entries()) {
    const cells = tableCells(line);
    if (!cells) { candidate = null; continue; }
    if (separator(cells)) {
      if (candidate && cells.length === candidate.cells.length) {
        const headers = candidate.cells.map(heading);
        if (!headers.some((value) => CLAUSE_HEADERS.has(value)) || !headers.includes('verdict')) found.push({ line: candidate.line, header: candidate.cells });
      }
      candidate = null;
      continue;
    }
    candidate = candidate ? candidate : { line: index + 1, cells };
  }
  return found;
}

/** Require an individual qualified row, not an incidental identifier elsewhere in prose. */
export function missingQualifiedConformanceRows(markdown, expectedIds) {
  const reported = new Set(conformanceTableRows(markdown)
    .map((row) => normalizeQualifiedClauseId(row.clauseId)).filter(Boolean));
  return [...new Set(expectedIds)].filter((id) => !reported.has(normalizeQualifiedClauseId(id)));
}

export function duplicateQualifiedConformanceRows(markdown) {
  const seen = new Set(), duplicates = new Set();
  for (const row of conformanceTableRows(markdown)) {
    const id = normalizeQualifiedClauseId(row.clauseId);
    if (!id) continue;
    if (seen.has(id)) duplicates.add(id);
    else seen.add(id);
  }
  return [...duplicates];
}

/** Partial and missing table verdicts with the line each is stated on. */
function incompleteVerdictRows(markdown) {
  const identified = conformanceTableRows(markdown);
  // Historical custom reports may predate named comparison headers. Preserve the former
  // fifth-column interpretation only when no named comparison table is present at all.
  const rows = identified.length ? identified : visibleTableLines(markdown).flatMap((line, index) => {
    const cells = tableCells(line);
    return cells?.length >= 5 ? [{ clauseId: plainCell(cells[0]), verdict: plainCell(cells[4]).toLowerCase(), line: index + 1 }] : [];
  });
  return rows.flatMap(({ clauseId, verdict, line }) => {
    const status = /^(missing|partial)(?:\s|\(|$)/u.exec(verdict)?.[1];
    return status && BLOCKING.has(status) ? [{ clauseId, verdict: status, line }] : [];
  });
}

export function blockingConformanceVerdicts(markdown) {
  return incompleteVerdictRows(markdown).map(({ clauseId, verdict }) => ({ clauseId, verdict }));
}

/**
 * Each clause the report's table honestly calls partial or missing, once, with its line. The gap
 * may bind to an existing issue owned by an earlier step; it never stops report publication, and a
 * person decides the gap before approval. No issue/decision is written by this reader.
 */
export function conformanceVerdictGaps(markdown, { workflow = null, phaseId = null } = {}) {
  const seen = new Set();
  const gaps = incompleteVerdictRows(markdown).flatMap((row) => {
    const clauseId = normalizeQualifiedClauseId(row.clauseId) ?? row.clauseId;
    if (!clauseId || seen.has(clauseId.toUpperCase())) return [];
    seen.add(clauseId.toUpperCase());
    return [{ clauseId, verdict: row.verdict, line: row.line ?? null }];
  });
  if (!workflow || !phaseId || !gaps.length) return gaps;
  return linkReportIssues(markdown, workflow, phaseId, gaps);
}

/**
 * Bind a row to existing issues from authored references, never proximity or a phase name alone.
 * Legacy reports sometimes say "both clauses" instead of spelling out IDs. That is unambiguous
 * only for a two-clause table and an issue filed from this exact discrepancy item. An arbitrary
 * section issue, another report, a changed item or a larger table cannot claim those clauses.
 * These are derived read facts, not new records and never authority to edit an approved report.
 */
function linkReportIssues(markdown, workflow, phaseId, gaps) {
  const lines = visibleTableLines(markdown);
  const clauses = new Set(conformanceTableRows(markdown).map((row) => normalizeQualifiedClauseId(row.clauseId) ?? row.clauseId));
  // The issue already retains the exact item text and its filing digest. Verify those bytes are
  // still in the authored section instead of loading the full authoring/ownership parser on a
  // read path. Table items use the same cell separator and backtick removal as their filing reader.
  const section = (lines.join('\n').split(/^##\s+Upstream discrepancies\s*$/imu)[1]?.split(/^#{1,2}\s/mu)[0] ?? '').split('\n')
    .map((line) => tableCells(line)?.map((cell) => cell.replaceAll('`', '').trim()).filter(Boolean).join(' — ') ?? line)
    .join('\n').replace(/\s+/gu, ' ').trim();
  const artifact = workflow.phases?.[phaseId]?.requiredArtifact?.path;
  const suffix = artifact ? `/${workflow.workItem.id}/${artifact}` : null;
  const issues = workflow.upstreamIssues ?? [];
  const bound = issues.filter((issue) => {
    const text = String(issue.problem ?? '').replace(/\s+/gu, ' ').trim();
    return clauses.size === 2 && /\bboth\s+(?:of\s+the\s+)?clauses\b/iu.test(String(issue.impact ?? '').replace(/[`*_]/gu, ''))
      && text && section.includes(text) && suffix && issue.source?.path?.endsWith(suffix)
      && issue.source.itemSha256 === discrepancyItemSha256(issue.phase, issue.problem);
  });
  return gaps.map((gap) => {
    const row = lines[(gap.line ?? 0) - 1] ?? '';
    const ids = row.match(/(?<![\w:-])UPI-\d{3,}(?![\w-])/gu) ?? [];
    const explicit = issues.filter((issue) => ids.includes(issue.id));
    const linked = explicit.length ? explicit : bound;
    return linked.length ? { ...gap, issueRefs: [...new Set(linked.map((issue) => issue.id))] } : gap;
  });
}

const PROSE_SECTION = /^(?:upstream discrepancies|impact\b.*)$/iu;
const STATED_VERDICT = /\b(partial|missing)\b/giu;
const NOT_STATED = /\b(?:not|no|never|no longer|previously|formerly|was|were|isn't|aren't|wasn't|weren't)\s+(?:yet\s+|still\s+)?$/iu;
const NEAR = 100;

/** Sentences under `## Upstream discrepancies` and any Impact heading, outside comments and fences. */
function discrepancyStatements(markdown) {
  const statements = [];
  let section = null;
  let level = 0;
  let block = [];
  const flush = () => {
    if (section && block.length) {
      for (const text of block.join(' ').split(/(?<=[.;!?])\s+/u)) if (text.trim()) statements.push({ section, text: text.trim() });
    }
    block = [];
  };
  for (const line of visibleTableLines(markdown)) {
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/u.exec(line);
    if (heading) {
      flush();
      if (section && heading[1].length <= level) section = null;
      if (!section && PROSE_SECTION.test(heading[2].trim())) {
        section = /^impact/iu.test(heading[2].trim()) ? 'Impact' : 'Upstream discrepancies';
        level = heading[1].length;
      }
      continue;
    }
    if (!section) continue;
    if (!line.trim()) {
      flush();
      continue;
    }
    if (/^\s*(?:[-*+]|\d+[.)]|\|)\s*/u.test(line)) flush();
    block.push(line.trim());
  }
  flush();
  return statements;
}

/**
 * Clauses the table calls matched while the report's own discrepancy or Impact text calls them
 * partial or missing, close to their exact ID in one sentence. Conservative on purpose: a negated
 * or past-tense mention ("no longer partial", "was missing") is not a contradiction.
 */
export function contradictedConformanceVerdicts(markdown) {
  const statements = discrepancyStatements(markdown);
  if (!statements.length) return [];
  const seen = new Set();
  const found = [];
  for (const row of conformanceTableRows(markdown)) {
    if (!/^matched(?:\s|\(|$)/u.test(row.verdict)) continue;
    const clauseId = normalizeQualifiedClauseId(row.clauseId) ?? row.clauseId;
    if (!clauseId || seen.has(clauseId.toUpperCase())) continue;
    const mention = clauseMentionPattern(clauseId);
    for (const statement of statements) {
      const positions = [...statement.text.matchAll(mention)].map((match) => match.index);
      const stated = positions.length ? [...statement.text.matchAll(STATED_VERDICT)].find((match) =>
        !NOT_STATED.test(statement.text.slice(Math.max(0, match.index - 30), match.index))
        && positions.some((position) => Math.abs(position - match.index) <= NEAR)) : null;
      if (!stated) continue;
      seen.add(clauseId.toUpperCase());
      found.push({ clauseId, verdict: 'matched', stated: stated[1].toLowerCase(), section: statement.section,
        line: row.line, excerpt: statement.text.length > 200 ? `${statement.text.slice(0, 199)}…` : statement.text });
      break;
    }
  }
  return found;
}
