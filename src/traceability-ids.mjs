import { javascriptSourceComments } from './javascript-source-comments.mjs';

/** The clause identities that an approved specification may define. */
export const GOVERNED_CLAUSE_TYPES = Object.freeze(['REQ', 'BEH', 'IFC', 'AC', 'CON']);
export const GOVERNED_CLAUSE_TYPE_PATTERN = GOVERNED_CLAUSE_TYPES.join('|');

const NAMESPACE = '[A-Z0-9][A-Z0-9._-]{0,63}';
const QUALIFIED_ID = new RegExp(
  `^${NAMESPACE}:(?:${GOVERNED_CLAUSE_TYPE_PATTERN})-\\d{3}$`, 'i'
);

export function normalizeQualifiedClauseId(value) {
  const text = String(value ?? '').trim();
  return QUALIFIED_ID.test(text) ? text.toUpperCase() : null;
}

/** Exact prose identities; never match a suffix of another namespace or a longer ID. */
export function qualifiedClauseMatches(text) {
  const pattern = new RegExp(
    `(?<![A-Za-z0-9._:-])${NAMESPACE}:(?:${GOVERNED_CLAUSE_TYPE_PATTERN})-\\d{3}(?![A-Za-z0-9_:-]|\\.[A-Za-z0-9._:-])`, 'gi'
  );
  return [...String(text ?? '').matchAll(pattern)];
}

export function qualifiedClauseIds(text) {
  return new Set(qualifiedClauseMatches(text).map(match => match[0].toUpperCase()));
}

/**
 * Read explicit source-comment witnesses, never identifiers from executable text or strings.
 * Legacy bare and NFR annotations remain observable to older World Models, but only the
 * qualified governed form is suitable for a new code-delivery publication contract.
 */
export function scanSourceClauseTags(source, { legacy = false, sourcePath = null } = {}) {
  const text = String(source ?? '');
  const typePattern = legacy ? `${GOVERNED_CLAUSE_TYPE_PATTERN}|NFR` : GOVERNED_CLAUSE_TYPE_PATTERN;
  const identity = legacy
    ? `(?:${NAMESPACE}:)?(?:${typePattern})-\\d{3}`
    : `${NAMESPACE}:(?:${typePattern})-\\d{3}`;
  const annotation = new RegExp(
    `^\\s*(?:(?:\\/\\/|#|\\/\\*+|\\*|<!--|--)\\s*)(?:[-*]\\s*)?@(ac|clause)\\s*:\\s*(${identity})(?![A-Za-z0-9._:-])`,
    'i'
  );
  // Preserve polyglot comment syntax. JavaScript/JSX gets lexical provenance so literal text
  // cannot become a witness, including multiline templates and JSX attributes/children.
  const javascript = /\.(?:[cm]?[jt]sx?|[cm][jt]s)$/iu.test(sourcePath ?? '')
    || (sourcePath == null && /\{\s*\/\*/u.test(text));
  const comments = javascript ? javascriptSourceComments(text, {
    jsx: !/\.(?:[cm]?ts)$/iu.test(sourcePath ?? '')
  }) : null;
  const result = [];
  const seen = new Set();
  const lineOffsets = [];
  let offset = 0;
  let commentIndex = 0;
  const decode = (match, line) => {
    const clauseId = match[2].toUpperCase();
    if (match[1].toLowerCase() === 'ac' && !/(?:^|:)AC-\d{3}$/.test(clauseId)) return;
    if (!legacy && !normalizeQualifiedClauseId(clauseId)) return;
    const tag = match[1].toLowerCase();
    const key = `${line}:${clauseId}:${tag}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push({ clauseId, line, tag });
  };
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    lineOffsets.push(offset);
    const match = annotation.exec(line);
    const at = offset + (match ? match[0].indexOf('@') : 0);
    while (comments && comments[commentIndex]?.end <= at) commentIndex += 1;
    const comment = comments?.[commentIndex];
    if (match && (!comments || (comment?.start <= at && at < comment.end))) decode(match, index + 1);
    offset += line.length + 1;
  }
  // A JSX expression has a real block-comment token, not a leading '/' on its source line.
  // Read only its comment bytes; markup after the closing brace is never evidence.
  for (const comment of comments ?? []) {
    if (!comment.jsxContainer) continue;
    let low = 0;
    let high = lineOffsets.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (lineOffsets[middle] <= comment.start) low = middle + 1;
      else high = middle;
    }
    const firstLine = low;
    text.slice(comment.start, comment.end).split('\n').forEach((line, index) => {
      const match = annotation.exec(line);
      if (match) decode(match, firstLine + index);
    });
  }
  return result.sort((left, right) => left.line - right.line);
}
