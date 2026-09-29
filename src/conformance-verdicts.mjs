import { normalizeQualifiedClauseId } from './traceability-ids.mjs';
import { parseMarkdownStructure } from './markdown-structure.mjs';
import { authoredArtifactText } from './publication-preflight.mjs';

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

export function blockingConformanceVerdicts(markdown) {
  const identified = conformanceTableRows(markdown);
  // Historical custom reports may predate named comparison headers. Preserve the former
  // fifth-column interpretation only when no named comparison table is present at all.
  const rows = identified.length ? identified : visibleTableLines(markdown).flatMap((line) => {
    const cells = tableCells(line);
    return cells?.length >= 5 ? [{ clauseId: plainCell(cells[0]), verdict: plainCell(cells[4]).toLowerCase() }] : [];
  });
  return rows.flatMap(({ clauseId, verdict }) => {
    const status = /^(missing|partial)(?:\s|\(|$)/u.exec(verdict)?.[1];
    return status && BLOCKING.has(status) ? [{ clauseId, verdict: status }] : [];
  });
}
