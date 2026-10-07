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

/** Shared marker vocabulary; callers must establish comment provenance separately. */
export function clauseTagsInComment(text, { legacy = false } = {}) {
  const types = legacy ? `${GOVERNED_CLAUSE_TYPE_PATTERN}|NFR` : GOVERNED_CLAUSE_TYPE_PATTERN;
  const identity = legacy ? `(?:${NAMESPACE}:)?(?:${types})-\\d{3}` : `${NAMESPACE}:(?:${types})-\\d{3}`;
  const marker = new RegExp(`(?:^|[\\s*/#!-])@(ac|clause)\\s*:\\s*(${identity})(?![A-Za-z0-9._:-])`, 'giu');
  const result = [];
  const seen = new Set();
  for (const match of String(text ?? '').matchAll(marker)) {
    const tag = match[1].toLowerCase();
    const clauseId = match[2].toUpperCase();
    if (tag === 'ac' && !/(?:^|:)AC-\d{3}$/u.test(clauseId)) continue;
    const key = `${tag}:${clauseId}`;
    if (!seen.has(key)) { seen.add(key); result.push({ tag, clauseId }); }
  }
  return result;
}

/**
 * Read explicit source-comment witnesses, never identifiers from executable text or strings.
 * Legacy bare and NFR annotations remain observable to older World Models, but only the
 * qualified governed form is suitable for a new code-delivery publication contract.
 */
export function scanSourceClauseTags(source, { legacy = false, sourcePath = null } = {}) {
  const text = String(source ?? '');
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
  const decode = ({ clauseId, tag }, line) => {
    const key = `${line}:${clauseId}:${tag}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push({ clauseId, line, tag });
  };
  const lines = text.split('\n');
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1;
  }
  // Parse every marker in each lexical comment, never bytes following its closing delimiter.
  // Keep the leading-comment convention; comment-only JSX containers also permit inline tags.
  for (const comment of comments ?? []) {
    let low = 0;
    let high = lineOffsets.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (lineOffsets[middle] <= comment.start) low = middle + 1;
      else high = middle;
    }
    const firstLine = low;
    text.slice(comment.start, comment.end).split('\n').forEach((line, index) => {
      if (index === 0 && !comment.jsxContainer
          && !/^\s*$/u.test(text.slice(lineOffsets[firstLine - 1], comment.start))) return;
      for (const tag of clauseTagsInComment(line, { legacy })) decode(tag, firstLine + index);
    });
  }
  if (!comments) lines.forEach((line, index) => {
    const prefix = /^\s*(\/\/|#|\/\*+|\*|<!--|--)/u.exec(line);
    if (!prefix) return;
    const close = prefix[1] === '<!--' ? '-->' : /^\*/u.test(prefix[1]) || prefix[1].startsWith('/*') ? '*/' : null;
    const end = close ? line.indexOf(close, prefix[0].length) : -1;
    for (const tag of clauseTagsInComment(end < 0 ? line : line.slice(0, end), { legacy })) decode(tag, index + 1);
  });
  return result.sort((left, right) => left.line - right.line);
}
