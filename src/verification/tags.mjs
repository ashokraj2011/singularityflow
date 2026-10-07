/**
 * The one acceptance-criterion tag vocabulary [E2G-015].
 *
 * A test is tied to a criterion by an `@ac:<NAMESPACE>:AC-NNN` marker in a comment placed directly
 * above the test's declaration: line comments (`//`, `#`) or the lines of a block comment, with no
 * blank line between the comment and the declaration. The older `@sflow-ac` spelling and JUnit
 * `@Tag("sflow-ac:…")` annotations are not part of the vocabulary and bind nothing. A marker that is
 * not directly above a declaration ties the criterion to nothing exact.
 */

import { normalizeQualifiedClauseId, clauseTagsInComment } from '../traceability-ids.mjs';

/** True for a namespace-qualified acceptance-criterion ID such as `PAY-1:AC-001`. */
export function isQualifiedAcceptanceId(value) {
  return /:AC-\d{3}$/u.test(normalizeQualifiedClauseId(value) ?? '');
}

/** The qualified criterion IDs named by `@ac:` markers in one comment's text. */
export function acceptanceTagsInComment(text) {
  return clauseTagsInComment(text).filter(entry => entry.tag === 'ac').map(entry => entry.clauseId);
}

/** Whether a whitespace run between two comments, or a comment and code, keeps them adjacent. */
export function adjacentWhitespace(text) {
  return /^[ \t\r]*\n?[ \t\r]*$/u.test(String(text ?? ''));
}

/**
 * The criterion tags directly above a line in plain source lines: walk upward through contiguous
 * comment lines (no blank line) and collect their markers. Used for languages whose parser reports
 * a declaration's start offset but not its comments.
 */
export function acceptanceTagsAboveLine(lines, lineIndex) {
  const ids = [];
  const commentLines = [];
  let inBlock = false;
  for (let index = lineIndex - 1; index >= 0; index -= 1) {
    const line = String(lines[index] ?? '').trim();
    if (!line) break;
    if (inBlock) {
      commentLines.push(index);
      if (line.startsWith('/*')) inBlock = false;
      ids.unshift(...acceptanceTagsInComment(line));
      continue;
    }
    if (line.startsWith('//') || line.startsWith('#')) {
      commentLines.push(index);
      ids.unshift(...acceptanceTagsInComment(line));
      continue;
    }
    if (line.endsWith('*/')) {
      commentLines.push(index);
      ids.unshift(...acceptanceTagsInComment(line));
      inBlock = !line.startsWith('/*');
      continue;
    }
    break;
  }
  return { clauseIds: [...new Set(ids)], firstCommentLine: commentLines.length ? Math.min(...commentLines) : null };
}

/** Every `@ac:` marker in a file's comment lines, with its 1-based line, wherever it is. */
export function acceptanceTagLines(source) {
  const found = [];
  const lines = String(source ?? '').split(/\r?\n/u);
  let inBlock = false;
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    const comment = inBlock || line.startsWith('//') || line.startsWith('#') || line.startsWith('/*') || line.startsWith('*');
    if (line.startsWith('/*') && !line.includes('*/')) inBlock = true;
    else if (inBlock && line.includes('*/')) inBlock = false;
    if (!comment) continue;
    for (const clauseId of acceptanceTagsInComment(line)) found.push({ clauseId, line: index + 1 });
  }
  return found;
}
