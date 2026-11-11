/**
 * The Markdown edits `workflow fix` drafts: sections appended to, sections added, links taken out
 * or pointed elsewhere, one line removed. Line based and deterministic; each returns the new text,
 * or null when it has nothing to do there.
 */
import { parseMarkdownStructure } from '../markdown-structure.mjs';

const MARKDOWN_LINK = /\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/gu;

/** A front matter block and the body after it, so a body can be edited and handed back as instructions. */
export function splitFrontMatter(text) {
  const match = /^(﻿?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$))([\s\S]*)$/u.exec(String(text ?? ''));
  return match ? { front: match[1], body: match[2] } : { front: '', body: String(text ?? '') };
}

/** `block` placed at `offset`, with one blank line on each side; the blank lines there are normalized. */
function insertAt(text, offset, block) {
  const before = text.slice(0, offset).replace(/\s+$/u, '');
  const after = text.slice(offset).replace(/^\s+/u, '');
  return `${before ? `${before}\n\n` : ''}${block.replace(/\s+$/u, '')}\n${after ? `\n${after}` : ''}`;
}

/**
 * The first section heading whose title matches `pattern`, or null. A document's title (its level-1
 * heading) is not a section: "# Payments requirements" is not where requirements go.
 */
export function findHeading(text, pattern) {
  return parseMarkdownStructure(text).headings.find((heading) => heading.level > 1 && pattern.test(heading.normalized)) ?? null;
}

/** `block` added at the end of the section under the first heading matching `pattern`; null when there is none. */
export function appendToSection(text, pattern, block) {
  const heading = findHeading(text, pattern);
  if (!heading) return null;
  // The section ends at the next heading of its level or higher; a deeper heading inside it stays after the block.
  const nested = parseMarkdownStructure(text).headings.find((entry) => entry.index > heading.index && entry.index < heading.end);
  return insertAt(text, nested ? nested.index : heading.end, block);
}

/** A new `## heading` section with `body`, before the first heading matching `before`, else at the end. */
export function addSection(text, heading, body, { before = null, level = 2 } = {}) {
  const block = `${'#'.repeat(level)} ${heading}\n\n${body.replace(/\s+$/u, '')}`;
  const next = before ? findHeading(text, before) : null;
  return insertAt(text, next ? next.index : text.length, block);
}

/** A new section right after the section under the first heading matching `pattern` (its subsections included); null when there is none. */
export function addSectionAfter(text, pattern, heading, body, { level = 2 } = {}) {
  const found = findHeading(text, pattern);
  if (!found) return null;
  return insertAt(text, found.end, `${'#'.repeat(level)} ${heading}\n\n${body.replace(/\s+$/u, '')}`);
}

/** Markdown links on 1-based `line` whose target (without its #fragment) is `target`. */
function linksOn(line, target) {
  return [...line.matchAll(MARKDOWN_LINK)].filter((match) => match[2].replace(/#.*$/u, '') === target);
}

/** The link to `target` on `lineNumber` replaced by its own text; the link markup goes, the words stay. */
export function unlinkTarget(text, lineNumber, target) {
  const lines = String(text).split('\n');
  const index = lineNumber - 1;
  if (!lines[index] || !linksOn(lines[index], target).length) return null;
  lines[index] = lines[index].replace(MARKDOWN_LINK, (whole, words, href) => (href.replace(/#.*$/u, '') === target ? (words.trim() || href) : whole));
  return lines.join('\n');
}

/** The link to `target` on `lineNumber` pointed at `replacement` instead, keeping any #fragment. */
export function retargetLink(text, lineNumber, target, replacement) {
  const lines = String(text).split('\n');
  const index = lineNumber - 1;
  if (!lines[index] || !linksOn(lines[index], target).length) return null;
  lines[index] = lines[index].replace(MARKDOWN_LINK, (whole, words, href) => {
    if (href.replace(/#.*$/u, '') !== target) return whole;
    const fragment = /#.*$/u.exec(href)?.[0] ?? '';
    return whole.replace(href, `${replacement}${fragment}`);
  });
  return lines.join('\n');
}

/**
 * The 1-based line that reads exactly `content`, nearest to `hint`: a line found by what it says, so
 * an edit drafted against one text still lands after earlier edits moved it. 0 when none does.
 */
export function lineNumberOf(text, content, hint = 1) {
  const lines = String(text).split('\n');
  let best = 0;
  lines.forEach((line, index) => { if (line === content && (!best || Math.abs(index + 1 - hint) < Math.abs(best - hint))) best = index + 1; });
  return best;
}

/** The text without 1-based `lineNumber`; a code fence left empty goes with it, and a doubled blank line closes up. */
export function removeLine(text, lineNumber) {
  const lines = String(text).split('\n');
  if (lineNumber < 1 || lineNumber > lines.length) return null;
  lines.splice(lineNumber - 1, 1);
  const at = lineNumber - 1;
  if (/^\s*(```|~~~)\S*\s*$/u.test(lines[at - 1] ?? '') && /^\s*(```|~~~)\s*$/u.test(lines[at] ?? '')) lines.splice(at - 1, 2);
  return lines.join('\n').replace(/\n{3,}/gu, '\n\n');
}
