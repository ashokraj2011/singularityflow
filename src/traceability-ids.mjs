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

/**
 * Read explicit source-comment witnesses, never identifiers from executable text or strings.
 * Legacy bare and NFR annotations remain observable to older World Models, but only the
 * qualified governed form is suitable for a new code-delivery publication contract.
 */
export function scanSourceClauseTags(source, { legacy = false } = {}) {
  const typePattern = legacy ? `${GOVERNED_CLAUSE_TYPE_PATTERN}|NFR` : GOVERNED_CLAUSE_TYPE_PATTERN;
  const identity = legacy
    ? `(?:${NAMESPACE}:)?(?:${typePattern})-\\d{3}`
    : `${NAMESPACE}:(?:${typePattern})-\\d{3}`;
  const annotation = new RegExp(
    `^\\s*(?:(?:\\/\\/|#|\\/\\*+|\\*|<!--|--)\\s*)(?:[-*]\\s*)?@(ac|clause)\\s*:\\s*(${identity})(?![A-Za-z0-9._:-])`,
    'i'
  );
  return String(source ?? '').split(/\r?\n/).flatMap((line, index) => {
    const match = annotation.exec(line);
    if (!match) return [];
    const clauseId = match[2].toUpperCase();
    if (match[1].toLowerCase() === 'ac' && !/(?:^|:)AC-\d{3}$/.test(clauseId)) return [];
    if (!legacy && !normalizeQualifiedClauseId(clauseId)) return [];
    return [{ clauseId, line: index + 1, tag: match[1].toLowerCase() }];
  });
}
