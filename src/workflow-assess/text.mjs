/**
 * What a piece of agent, skill, instruction or template text says, sentence by sentence, each with
 * its exact place in its file: the units `workflow assess` judges (src/workflow-assess/checks.mjs).
 * Pure and deterministic: no model reads anything here.
 *
 * A file is read as Markdown: frontmatter, code, tables and HTML comments are not instructions,
 * except a template's `<!-- sflow:guidance ... -->` note, which its author reads. Prose and list
 * items are split into blocks (a paragraph or one list item) and blocks into sentences. Every
 * sentence keeps its exact text and offsets in the file, so a finding quotes it as written and a
 * suggested edit replaces exactly it.
 */

export const bytesOf = (text) => Buffer.byteLength(String(text ?? ''), 'utf8');
/** About four characters a token, as the skill budgets count. */
export const tokensOf = (text) => Math.ceil(String(text ?? '').length / 4);

const FENCE = /^\s*(`{3,}|~{3,})/u;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/u;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/u;
const GUIDANCE_OPEN = /<!--\s*sflow:guidance\b/u;

/** The text after a file's frontmatter, and the line (1-based) it starts on. */
export function bodyOf(text) {
  const value = String(text ?? '').replace(/^﻿/u, '');
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u.exec(value);
  if (!match) return { body: value, offset: 0, startLine: 1 };
  return { body: value.slice(match[0].length), offset: match[0].length, startLine: match[0].split('\n').length - (match[0].endsWith('\n') ? 0 : 1) };
}

/** Each line's offset in `text` (index 0 is line 1), and one past the end. */
function lineOffsets(text) {
  const offsets = [0];
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) offsets.push(index + 1);
  return offsets;
}

/**
 * The lines of a file from `from` (an offset where its body starts), each with what it is:
 * blank, heading, fence, code, table, comment, guidance (a template's note to its author),
 * list (an item's first line), prose, or quote.
 */
export function markdownLines(text, { from = 0 } = {}) {
  const source = String(text ?? '');
  const offsets = lineOffsets(source);
  const lines = [];
  let fence = null;
  let comment = null;
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index];
    if (start < from) continue;
    const end = index + 1 < offsets.length ? offsets[index + 1] - 1 : source.length;
    const raw = source.slice(start, end).replace(/\r$/u, '');
    const entry = { line: index + 1, start, end: start + raw.length, text: raw, kind: 'prose' };
    if (fence) {
      entry.kind = FENCE.test(raw) && raw.trim().startsWith(fence) ? 'fence' : 'code';
      if (entry.kind === 'fence') fence = null;
    } else if (comment) {
      entry.kind = comment;
      if (raw.includes('-->')) comment = null;
    } else if (FENCE.test(raw)) {
      entry.kind = 'fence';
      fence = FENCE.exec(raw)[1].slice(0, 3);
    } else if (!raw.trim()) entry.kind = 'blank';
    else if (HEADING.test(raw)) {
      const [, level, title] = HEADING.exec(raw);
      entry.kind = 'heading';
      entry.heading = { level: level.length, title: title.trim() };
    } else if (/^\s*\|/u.test(raw)) entry.kind = 'table';
    else if (/^\s*<!--/u.test(raw)) {
      entry.kind = GUIDANCE_OPEN.test(raw) ? 'guidance' : 'comment';
      if (!raw.includes('-->')) comment = entry.kind;
    } else if (/^\s*>/u.test(raw)) entry.kind = 'quote';
    else if (LIST_ITEM.test(raw)) entry.kind = 'list';
    lines.push(entry);
  }
  return lines;
}

const BLOCK_KINDS = new Set(['prose', 'list', 'guidance', 'quote']);

/**
 * Blocks of instruction text: a paragraph, one list item with its continuation lines, or one
 * guidance note. Each with its section (the heading above it) and its exact span in the file.
 */
export function textBlocks(lines) {
  const blocks = [];
  let section = null;
  let current = null;
  const close = () => { if (current) blocks.push(current); current = null; };
  for (const entry of lines) {
    if (entry.kind === 'heading') { close(); section = { title: entry.heading.title, level: entry.heading.level, line: entry.line }; continue; }
    if (!BLOCK_KINDS.has(entry.kind)) { close(); continue; }
    const startsNew = !current || entry.kind === 'list' || entry.kind === 'guidance' || current.kind === 'guidance'
      || (current.kind === 'quote') !== (entry.kind === 'quote');
    if (startsNew) {
      close();
      current = { kind: entry.kind, start: entry.start, end: entry.end, line: entry.line, endLine: entry.line, section };
    } else Object.assign(current, { end: entry.end, endLine: entry.line });
  }
  close();
  return blocks;
}

// A sentence ends at . ! ? (after any closing quote or bracket) followed by space and a capital,
// a digit, a quote, a backtick or a bracket; "e.g." and the like never end one.
const SENTENCE_END = /[.!?;:]?[.!?](?:["'”’)\]`*_]*)(?=\s+["'“‘(\[`*_]*[A-Z0-9`]|\s*$)/gu;
const NOT_AN_END = /\b(?:e\.g|i\.e|etc|vs|cf|approx|incl|no|fig|ch|sec)\.$/iu;

/** The sentences of one block, each with its exact text and offsets in `text`. */
export function blockSentences(text, block) {
  const raw = text.slice(block.start, block.end);
  let lead = 0;
  const marker = block.kind === 'guidance' ? /^\s*<!--\s*sflow:guidance\s*/u.exec(raw) : block.kind === 'list' ? LIST_ITEM.exec(raw) : block.kind === 'quote' ? /^\s*>\s*/u.exec(raw) : /^\s*/u.exec(raw);
  if (marker) lead = marker[0].length;
  let tail = raw.length;
  if (block.kind === 'guidance') {
    const close = raw.lastIndexOf('-->');
    if (close >= 0) tail = close;
  }
  while (tail > lead && /\s/u.test(raw[tail - 1])) tail -= 1;
  const sentences = [];
  let start = lead;
  const body = raw.slice(0, tail);
  for (const match of body.matchAll(SENTENCE_END)) {
    const end = match.index + match[0].length;
    if (end <= start) continue;
    if (NOT_AN_END.test(body.slice(Math.max(start, end - 8), end))) continue;
    sentences.push([start, end]);
    start = end;
    while (start < tail && /\s/u.test(raw[start])) start += 1;
  }
  if (start < tail) sentences.push([start, tail]);
  return sentences.filter(([from, to]) => raw.slice(from, to).trim()).map(([from, to]) => {
    const exact = raw.slice(from, to);
    return { exact, text: exact.replace(/\s+/gu, ' ').trim(), start: block.start + from, end: block.start + to };
  });
}

const STOP = new Set(['a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'with', 'and', 'or', 'any', 'all', 'your', 'you', 'it', 'its', 'this',
  'that', 'these', 'those', 'be', 'is', 'are', 'was', 'were', 'been', 'if', 'as', 'at', 'by', 'from', 'into', 'than', 'then', 'there', 'their',
  'them', 'they', 'we', 'us', 'our', 'so', 'such', 'each', 'every', 'also', 'just', 'please', 'which', 'who', 'what', 'when', 'where', 'how',
  'can', 'will', 'would', 'should', 'may', 'might', 'must', 'do', 'does', 'did', 'has', 'have', 'had', 'one', 'own', 'only', 'very', 'about']);

/** Fold a word to a stem: plurals, -ing, -ed and a final e, so "overriding" and "override" match. */
function stem(word) {
  let value = word;
  if (value.length > 5 && value.endsWith('ing')) value = value.slice(0, -3);
  else if (value.length > 4 && value.endsWith('ed')) value = value.slice(0, -2);
  else if (value.length > 3 && value.endsWith('s') && !value.endsWith('ss')) value = value.slice(0, -1);
  if (value.length > 4 && value.endsWith('e')) value = value.slice(0, -1);
  return value;
}

/** The words a sentence is about: lower case, without filler, stemmed; negations kept. */
export function contentWords(text) {
  return (String(text ?? '').toLowerCase().replace(/<[^>]+>/gu, ' ').match(/[a-z0-9]+/gu) ?? [])
    .filter((word) => !STOP.has(word)).map(stem);
}

export const wordCount = (text) => (String(text ?? '').match(/[A-Za-z0-9][A-Za-z0-9'’-]*/gu) ?? []).length;

/** How alike two word lists are: shared distinct words over all distinct words. */
export function similarity(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** How much of `part` is in `whole`: its distinct words that `whole` has. */
export function containment(part, whole) {
  const a = new Set(part);
  const b = new Set(whole);
  if (!a.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / a.size;
}

/** Two sentences say the same thing: nearly the same words, enough of them to be a rule. */
export function sameSentence(left, right, { threshold = 0.75, minimum = 5 } = {}) {
  if (new Set(left).size < minimum || new Set(right).size < minimum) return false;
  return similarity(left, right) >= threshold;
}

// Wording that leaves the agent to guess what is meant.
const VAGUE = /\b(as (?:needed|required|appropriate|applicable|necessary|much as possible)|if (?:needed|necessary|appropriate|applicable|possible|relevant)|where (?:appropriate|applicable|possible|relevant|needed)|when (?:appropriate|necessary|needed|relevant)|and so (?:on|forth)|etc\.?|best practices?|try to|if you can|somehow|some kind of|properly|appropriately|reasonabl[ey]|sufficient(?:ly)?|adequate(?:ly)?|high[- ]quality|good enough|in a good way|TBD)\b/iu;
const CONDITION = /\b(if|when|whenever|unless|except|otherwise|in case|provided that|only if|as long as)\b/giu;

/** The vague phrase in a sentence, or null. */
export const vaguePhrase = (text) => VAGUE.exec(String(text ?? ''))?.[0] ?? null;
/** How many conditions one sentence sets. */
export const conditionCount = (text) => (String(text ?? '').match(CONDITION) ?? []).length;

/**
 * The sections of a file by heading, each with its bytes up to the next heading of the same or
 * a higher level: what makes a long text long.
 */
export function sectionsOf(text, lines) {
  const headings = lines.filter((entry) => entry.kind === 'heading');
  const last = lines.at(-1);
  return headings.map((entry, index) => {
    const next = headings.slice(index + 1).find((other) => other.heading.level <= entry.heading.level);
    const end = next ? next.start : last ? last.end : entry.end;
    return { title: entry.heading.title, level: entry.heading.level, line: entry.line, endLine: next ? next.line - 1 : last?.line ?? entry.line,
      bytes: bytesOf(text.slice(entry.start, end)) };
  });
}

/** Every line offset of a text, for turning an offset into its 1-based line. */
export function lineOf(text, offset) {
  let line = 1;
  for (let index = text.indexOf('\n'); index >= 0 && index < offset; index = text.indexOf('\n', index + 1)) line += 1;
  return line;
}

/** How many times `part` occurs in `text`. */
export function occurrences(text, part) {
  if (!part) return 0;
  let count = 0;
  for (let index = text.indexOf(part); index >= 0; index = text.indexOf(part, index + 1)) count += 1;
  return count;
}
