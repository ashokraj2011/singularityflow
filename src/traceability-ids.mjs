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
