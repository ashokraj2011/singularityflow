/**
 * Which statements in a Story's sources are requirements [E2G-006, D11].
 *
 * Deterministic and pure. A statement is normative when its structure says so: an entry in the
 * Story's acceptance criteria, requirements or constraints, a list item or table row under a
 * requirements, acceptance criteria or constraints heading, a Given/When/Then scenario, or a
 * sentence anywhere that uses a strong modal (must, must not, shall, shall not, is required to).
 * "Should" and "may" are not requirements here. Completeness is claimed only relative to this
 * identified set; reviewers may propose more, and a person decides.
 */
import { createHash } from 'node:crypto';

const STRONG_MODAL = /\b(?:must(?:\s+not)?|shall(?:\s+not)?|(?:is|are)\s+required\s+to|cannot\s+be\s+allowed)\b/iu;
const SCENARIO = /^\s*(?:given|when|then)\b/iu;
const NORMATIVE_HEADING = /\b(?:requirements?|acceptance\s+criteria|constraints?|must\s+haves?)\b/iu;
const ANCHOR = /\[[A-Z0-9][A-Z0-9_-]*:[A-Z]+-\d+\]/gu;
const HAS_ANCHOR = /\[[A-Z0-9][A-Z0-9_-]*:[A-Z]+-\d+\]/u;

/** The comparable form of a statement: anchors, markup and case removed, whitespace collapsed. */
export function normalizeStatement(text) {
  return String(text ?? '')
    .replace(ANCHOR, ' ')
    .replace(/[`*_>#|]/gu, ' ')
    .replace(/^\s*(?:[-+]|\d+[.)])\s+/u, '')
    .replace(/\[\s?[xX ]?\s?\]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^[\u2014\u2013-]+\s*/u, '')
    .replace(/[.;:,!]+$/u, '')
    .toLocaleLowerCase('en-US');
}

/** A statement's identity: the SHA-256 of its normalized form. */
export function statementSha256(text) {
  return createHash('sha256').update(normalizeStatement(text)).digest('hex');
}

/** The inventory item ID of a statement from one source. */
export function scopeItemId(sourceId, text) {
  return `SRI-${createHash('sha256').update(`${sourceId}\u0000${normalizeStatement(text)}`).digest('hex').slice(0, 12)}`;
}

function sentences(text) {
  return String(text).split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/u).map((entry) => entry.trim()).filter(Boolean);
}

/**
 * The normative statements in one Markdown or plain-text source, with the line each starts on.
 * Fenced code, HTML comments and table separators are skipped.
 */
export function extractNormativeStatements(text, { sourceId }) {
  const found = [];
  const lines = String(text ?? '').split(/\r?\n/u);
  let fenced = false;
  let comment = false;
  let normativeSection = false;
  const add = (statement, line, signal) => {
    const normalized = normalizeStatement(statement);
    if (normalized.length < 3) return;
    found.push({ sourceId, line, text: statement.replace(/\s+/gu, ' ').trim(), statementSha256: statementSha256(statement), signal });
  };
  lines.forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (/^(?:```|~~~)/u.test(trimmed)) { fenced = !fenced; return; }
    if (fenced) return;
    if (comment) { if (trimmed.includes('-->')) comment = false; return; }
    if (trimmed.startsWith('<!--')) { if (!trimmed.includes('-->')) comment = true; return; }
    const heading = /^#{1,6}\s+(.+)$/u.exec(trimmed);
    if (heading) { normativeSection = NORMATIVE_HEADING.test(heading[1]); return; }
    if (!trimmed) return;
    if (/^\|?\s*:?-{3,}/u.test(trimmed)) return;
    const listItem = /^(?:[-+*]|\d+[.)])\s+(.+)$/u.exec(trimmed);
    const tableRow = trimmed.startsWith('|') ? trimmed.replace(/^\||\|$/gu, '').split('|').map((cell) => cell.trim()).filter(Boolean).join(' — ') : null;
    if (normativeSection && (listItem || tableRow)) {
      // A header row of a table names its columns; it states nothing.
      if (tableRow && /^\|?\s*(?:clause|id|criterion|requirement)\b/iu.test(trimmed) && !HAS_ANCHOR.test(trimmed)) return;
      add(listItem ? listItem[1] : tableRow, line, 'structured');
      return;
    }
    if (SCENARIO.test(trimmed)) { add(trimmed, line, 'scenario'); return; }
    for (const sentence of sentences(listItem ? listItem[1] : trimmed)) {
      if (STRONG_MODAL.test(sentence)) add(sentence, line, 'modal');
    }
  });
  // One statement is one item, however often a source repeats it.
  const seen = new Set();
  return found.filter((entry) => (seen.has(entry.statementSha256) ? false : seen.add(entry.statementSha256)));
}

/**
 * The normative statements in a Story's pinned source record: every acceptance criterion,
 * requirement and constraint entry is a requirement by structure, and any other field contributes
 * its strong-modal sentences.
 */
export function storySourceStatements(source, { sourceId = 'story' } = {}) {
  const found = [];
  const entries = (value) => (Array.isArray(value) ? value : value ? [value] : []).map((entry) => (typeof entry === 'string' ? entry : entry?.text ?? entry?.description ?? '')).filter(Boolean);
  for (const [field, signal] of [['acceptanceCriteria', 'structured'], ['requirements', 'structured'], ['constraints', 'structured']]) {
    for (const entry of entries(source?.[field])) {
      found.push({ sourceId, line: null, field, text: String(entry).replace(/\s+/gu, ' ').trim(), statementSha256: statementSha256(entry), signal });
    }
  }
  for (const field of ['description', 'desiredOutcome', 'notes']) {
    for (const entry of entries(source?.[field])) {
      for (const statement of extractNormativeStatements(entry, { sourceId }).filter((item) => item.signal !== 'structured')) {
        found.push({ ...statement, line: null, field });
      }
    }
  }
  const seen = new Set();
  return found.filter((entry) => normalizeStatement(entry.text).length >= 3
    && (seen.has(entry.statementSha256) ? false : seen.add(entry.statementSha256)));
}
