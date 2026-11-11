/**
 * Template guidance: what a step's template tells its author, never part of the document itself.
 *
 * Guidance is an HTML comment whose text starts with `sflow:guidance`, each paragraph on one line:
 *
 *     <!-- sflow:guidance What this specification takes as true without proving. -->
 *
 * A comment that also holds an example (a table, a fenced or indented block) is a block, with each
 * paragraph still on one line:
 *
 *     <!-- sflow:guidance
 *     Use this syntax:
 *
 *         [NEEDS CLARIFICATION: <one question>]
 *     -->
 *
 * One line per paragraph, because an agent quotes a paragraph as one line when it edits around it,
 * and a paragraph wrapped at 100 characters never matches that quote. A comment, because every
 * kernel reader already skips comments (src/markdown-structure.mjs): a section holding only guidance
 * is empty, a clause anchor inside guidance is no clause, and no conformance check counts it.
 *
 * Publication removes it (stripTemplateGuidance), so the published document, which a reviewer, an
 * approver and every later step read, never carries it. An author who deletes guidance changes
 * nothing. A template's other lines (TODO placeholders, `<placeholder>` slots, tables, lists) are the
 * author's to replace and are never guidance.
 */
import { parseMarkdownStructure } from './markdown-structure.mjs';

export const TEMPLATE_GUIDANCE_MARKER = 'sflow:guidance';
const GUIDANCE_COMMENT = /^<!--[ \t]*sflow:guidance(?=[\s]|-->)/u;
// Comments the kernel writes or reads (metadata, inputs, verdict summary, managed blocks): never guidance.
const MANAGED_COMMENT = /^<!--[ \t]*(?:singularity-flow:|sflow:|sflow-|managed-by:)/u;

/** Each closed guidance comment in `text`, as `{ start, end, line }` offsets; comments in code are not comments. */
export function templateGuidanceComments(text) {
  const source = String(text ?? '');
  return parseMarkdownStructure(source).comments
    .filter((comment) => comment.closed && GUIDANCE_COMMENT.test(source.slice(comment.start, comment.end)));
}

/**
 * The text without its guidance. A guidance comment alone on its lines takes those lines with it,
 * and the blank line it leaves between two paragraphs; one inside a line leaves the rest of the line.
 * Everything else, the author's own comments included, keeps its exact bytes.
 */
export function stripTemplateGuidance(text) {
  const source = String(text ?? '');
  const comments = templateGuidanceComments(source);
  if (!comments.length) return { text: source, removed: 0 };
  let output = '';
  let cursor = 0;
  for (const comment of comments) {
    if (comment.start < cursor) continue;
    const lineStart = source.lastIndexOf('\n', comment.start - 1) + 1;
    const newline = source.indexOf('\n', comment.end);
    const lineEnd = newline < 0 ? source.length : newline + 1;
    const wholeLines = lineStart >= cursor
      && !source.slice(lineStart, comment.start).trim()
      && !source.slice(comment.end, lineEnd).trim();
    if (!wholeLines) {
      output += source.slice(cursor, comment.start);
      cursor = comment.end + (/[ \t]$/u.test(output) && /^[ \t]/u.test(source.slice(comment.end)) ? 1 : 0);
      continue;
    }
    output += source.slice(cursor, lineStart);
    cursor = lineEnd;
    // The blank line between the paragraphs around it is enough: drop the second one.
    const blankBefore = output === '' || /(?:^|\n)[ \t]*\r?\n$/u.test(output);
    const blankAfter = /^[ \t]*\r?\n/u.exec(source.slice(cursor));
    if (blankBefore && blankAfter) cursor += blankAfter[0].length;
  }
  output += source.slice(cursor);
  return { text: output, removed: comments.length };
}

// -------------------------------------------------------------------------------------------------
// Writing guidance in the marked, one-line form

const FENCE = /^ {0,3}(`{3,}|~{3,})/u;
// Lines that are structure, not a prose paragraph: headings, lists, tables, quotes, HTML, code,
// rules and the kernel's own tokens.
const STRUCTURAL = /^(?:[ \t]|#|[-*+][ \t]|\d+[.)][ \t]|\||>|<[A-Za-z/!?]|`{3}|~{3}|(?:-{3,}|={3,}|\*{3,}|_{3,})[ \t]*$|\{\{(?:inputs|metadata)\}\})/u;
// A field the document keeps, with its label in bold (`**Priority:** P1`, `**Status.** Proposed`).
const FIELD = /^\*\*[^*\n]+(?:[:.]\*\*|\*\*[:.])/u;
// What the author fills in is never guidance: a TODO line, a clause anchor, a `<slot>`.
const AUTHOR_SLOT = /\b(?:TODO|TBD|FIXME)\b|\[[^\]\n]*:(?:REQ|BEH|IFC|AC|CON)-\d{3}\]|\{\{(?:inputs|metadata)\}\}/u;
const ANGLE_SLOT = /<[^<>\n]+>/u;
const words = (line) => line.trim().split(/\s+/u).filter(Boolean).length;
const withoutCode = (line) => line.replace(/`[^`\n]*`/gu, '``');

/** Whether a visible prose paragraph reads as guidance to the author rather than text for the document. */
function readsAsGuidance(lines) {
  const joined = lines.map((line) => line.trim()).join(' ');
  const visible = withoutCode(joined);
  return !AUTHOR_SLOT.test(visible) && !ANGLE_SLOT.test(visible) && words(joined) >= 4;
}

/** A comment's content lines as paragraphs: prose joined to one line each, examples kept verbatim. */
function commentParagraphs(lines) {
  const out = [];
  let prose = [];
  let fence = null;
  let example = false;
  const flush = () => { if (prose.length) out.push({ prose: true, text: prose.map((line) => line.trim()).join(' ') }); prose = []; };
  for (const line of lines) {
    if (fence) {
      out.push({ prose: false, text: line });
      if (FENCE.test(line) && line.trim().startsWith(fence)) fence = null;
      continue;
    }
    const opened = FENCE.exec(line);
    if (opened) { flush(); fence = opened[1][0].repeat(3); example = true; out.push({ prose: false, text: line }); continue; }
    if (!line.trim()) { flush(); out.push({ blank: true }); continue; }
    if (/^(?: {4}|\t)/u.test(line) || /^\s*(?:\||[-*+][ \t]|\d+[.)][ \t])/u.test(line)) {
      flush(); example = true; out.push({ prose: false, text: line }); continue;
    }
    prose.push(line);
  }
  flush();
  while (out.length && out[0].blank) out.shift();
  while (out.length && out.at(-1).blank) out.pop();
  return { paragraphs: out.filter((entry, index) => !(entry.blank && out[index - 1]?.blank)), example };
}

/** One guidance comment, as the marked form writes it. */
function guidanceComment(paragraphs, example) {
  const prose = paragraphs.filter((entry) => entry.prose);
  if (!example && prose.length === paragraphs.filter((entry) => !entry.blank).length) {
    return prose.map((entry) => `<!-- ${TEMPLATE_GUIDANCE_MARKER} ${entry.text} -->`).join('\n\n').split('\n');
  }
  return [`<!-- ${TEMPLATE_GUIDANCE_MARKER}`, ...paragraphs.map((entry) => (entry.blank ? '' : entry.text)), '-->'];
}

/**
 * The template with its guidance written the marked, one-line way, and what changed: each change is
 * `{ line, endLine, kind, replacement }` (1-based, inclusive), where `kind` is `unmarked` (visible
 * prose or a plain comment publication would keep) or `wrapped` (marked guidance, or a TODO line,
 * wrapped over several lines). With `mark` false (a template no author writes) wrapped lines are
 * only joined. Deterministic; applying it twice changes nothing more.
 */
export function markTemplateGuidance(text, { mark = true } = {}) {
  const source = String(text ?? '');
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/u);
  const out = [];
  const changes = [];
  let index = 0;
  let fence = null;
  const record = (from, to, kind, replacement) => {
    changes.push({ line: from + 1, endLine: to + 1, kind, replacement: replacement.join('\n') });
    out.push(...replacement);
  };
  while (index < lines.length) {
    const line = lines[index];
    if (fence) {
      out.push(line);
      if (FENCE.test(line) && line.trim().startsWith(fence)) fence = null;
      index += 1;
      continue;
    }
    const opened = FENCE.exec(line);
    if (opened) { fence = opened[1][0].repeat(3); out.push(line); index += 1; continue; }

    // A comment that starts a line and ends a line. One the kernel owns, or any with `mark` false,
    // stays exactly as written.
    if (/^<!--/u.test(line)) {
      let end = index;
      while (end < lines.length && !lines[end].includes('-->')) end += 1;
      const closing = lines[end] ?? '';
      if (end >= lines.length || closing.slice(closing.indexOf('-->') + 3).trim()) { out.push(line); index += 1; continue; }
      const marked = GUIDANCE_COMMENT.test(line);
      // A comment the kernel owns, or one holding a commented-out clause or TODO, is not guidance.
      const block = lines.slice(index, end + 1).join('\n');
      if (!mark || (!marked && (MANAGED_COMMENT.test(line) || AUTHOR_SLOT.test(withoutCode(block))))) {
        out.push(...lines.slice(index, end + 1));
        index = end + 1;
        continue;
      }
      const body = block
        .replace(/^<!--[ \t]*(?:sflow:guidance\b)?[ \t]*/u, '')
        .replace(/[ \t]*-->[ \t]*$/u, '');
      const { paragraphs, example } = commentParagraphs(body.split('\n'));
      const replacement = guidanceComment(paragraphs, example);
      const original = lines.slice(index, end + 1);
      if (replacement.join('\n') !== original.join('\n')) record(index, end, marked ? 'wrapped' : 'unmarked', replacement);
      else out.push(...original);
      index = end + 1;
      continue;
    }

    // A visible paragraph: lines at column 0 that are not structure. A field keeps its label and is
    // only joined; with `mark` false (a template no author writes) nothing is marked either.
    if (line.trim() && (!STRUCTURAL.test(line) || FIELD.test(line))) {
      let end = index;
      while (end + 1 < lines.length && lines[end + 1].trim() && !STRUCTURAL.test(lines[end + 1])
        && !FIELD.test(lines[end + 1]) && !FENCE.test(lines[end + 1])) end += 1;
      const paragraph = lines.slice(index, end + 1);
      const joined = paragraph.map((entry) => entry.trim()).join(' ');
      if (mark && !FIELD.test(line) && readsAsGuidance(paragraph)) {
        record(index, end, 'unmarked', [`<!-- ${TEMPLATE_GUIDANCE_MARKER} ${joined} -->`]);
      }
      else if (paragraph.length > 1) record(index, end, 'wrapped', [joined]);
      else out.push(line);
      index = end + 1;
      continue;
    }
    out.push(line);
    index += 1;
  }
  return { text: out.join(eol), changes };
}
