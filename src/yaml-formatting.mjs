/**
 * Keeping a hand-maintained YAML file's own formatting across a programmatic edit.
 *
 * The YAML library re-renders a whole document: flow maps lose their padding, comments move to the
 * indentation of the next key, and a value written over several lines (a folded description, a flow
 * list broken across lines) is joined onto one. An edit to one key then shows up as a diff across the
 * file. These helpers replay only the edit onto the original text.
 */
import YAML from 'yaml';
import { YAML_OUTPUT } from './util.mjs';

/**
 * Line operations turning `a` into `b`: `[' ', i]` keeps a[i], `['-', i]` drops a[i], `['+', j]`
 * adds b[j]. The common head and tail are matched first, so the table only covers the edited
 * region; a region too large for the table becomes one replacement.
 */
export function lineOperations(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length; let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const operations = [];
  for (let index = 0; index < start; index += 1) operations.push([' ', index]);
  const lengthA = endA - start; const lengthB = endB - start;
  const cols = lengthB + 1;
  if ((lengthA + 1) * cols <= 4_000_000) {
    const table = new Uint32Array((lengthA + 1) * cols);
    for (let i = lengthA - 1; i >= 0; i -= 1) {
      for (let j = lengthB - 1; j >= 0; j -= 1) {
        table[i * cols + j] = a[start + i] === b[start + j] ? table[(i + 1) * cols + j + 1] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
      }
    }
    let i = 0; let j = 0;
    while (i < lengthA || j < lengthB) {
      if (i < lengthA && j < lengthB && a[start + i] === b[start + j]) { operations.push([' ', start + i]); i += 1; j += 1; }
      else if (j < lengthB && (i >= lengthA || table[i * cols + j + 1] >= table[(i + 1) * cols + j])) { operations.push(['+', start + j]); j += 1; }
      else { operations.push(['-', start + i]); i += 1; }
    }
  } else {
    for (let i = start; i < endA; i += 1) operations.push(['-', i]);
    for (let j = start; j < endB; j += 1) operations.push(['+', j]);
  }
  for (let index = endA; index < a.length; index += 1) operations.push([' ', index]);
  return operations;
}

/**
 * A text's lines in the units a layout keeps together. A value that can be written on one line but
 * spans several here (a folded description, a flow list broken across lines, a value on the line
 * after its key) is one unit; every other line is a unit of its own. One document has the same units
 * in any layout, so the units of two layouts of it correspond one to one.
 */
function lineUnits(text, document) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) if (text[index] === '\n') starts.push(index + 1);
  const lineOf = (offset) => {
    let low = 0; let high = starts.length - 1;
    while (low < high) { const middle = (low + high + 1) >> 1; if (starts[middle] <= offset) low = middle; else high = middle - 1; }
    return low;
  };
  const spans = [];
  // A scalar other than a block scalar (| or >), and a flow list or map, render on one line.
  const oneLine = (node) => (YAML.isScalar(node) && node.type !== 'BLOCK_LITERAL' && node.type !== 'BLOCK_FOLDED')
    || (YAML.isCollection(node) && node.flow);
  const span = (from, node) => {
    if (!Array.isArray(node?.range)) return;
    const first = lineOf(from); const last = lineOf(Math.max(node.range[0], node.range[1] - 1));
    if (last > first) spans.push([first, last]);
  };
  YAML.visit(document, {
    // Such a value may also start on the line after its key, and the rendering joins the two.
    Pair(key, pair) {
      if (!oneLine(pair.value)) return undefined;
      span((pair.key?.range ?? pair.value.range)[0], pair.value);
      return YAML.visit.SKIP;
    },
    Scalar(key, node) { if (oneLine(node)) span(node.range?.[0] ?? 0, node); },
    Map(key, node) { if (node.flow) { span(node.range?.[0] ?? 0, node); return YAML.visit.SKIP; } return undefined; },
    Seq(key, node) { if (node.flow) { span(node.range?.[0] ?? 0, node); return YAML.visit.SKIP; } return undefined; }
  });
  spans.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
  const groups = [];
  let line = 0; let next = 0;
  while (line < starts.length) {
    while (next < spans.length && spans[next][0] < line) next += 1;
    if (next < spans.length && spans[next][0] === line) { groups.push([line, spans[next][1]]); line = spans[next][1] + 1; next += 1; }
    else { groups.push([line, line]); line += 1; }
  }
  const lines = text.split('\n');
  return groups.map(([first, last]) => lines.slice(first, last + 1).join('\n'));
}

function unitsOf(text) {
  try {
    const document = YAML.parseDocument(text);
    return document.errors?.length ? null : lineUnits(text, document);
  } catch {
    return null;
  }
}

/**
 * Keep a YAML file's own formatting on every line an edit did not touch.
 *
 * Rendering the unedited document with the options `edited` was rendered with gives a baseline whose
 * units (see lineUnits) correspond to the original's one to one. The baseline-to-edited diff of those
 * units is exactly the edit, so it is replayed onto the original text instead. When the
 * correspondence or the parsed result is not exact, the library's own rendering is used unchanged.
 */
export function preserveYamlFormatting(original, edited, options = YAML_OUTPUT) {
  let document;
  try { document = YAML.parseDocument(original); } catch { return edited; }
  if (document.errors?.length) return edited;
  const source = lineUnits(original, document);
  const before = unitsOf(document.toString(options)); const after = unitsOf(edited);
  if (!before || !after || source.length !== before.length) return edited;
  const merged = lineOperations(before, after)
    .filter(([kind]) => kind !== '-')
    .map(([kind, index]) => (kind === ' ' ? source[index] : after[index]))
    .join('\n');
  try {
    return JSON.stringify(YAML.parse(merged)) === JSON.stringify(YAML.parse(edited)) ? merged : edited;
  } catch {
    return edited;
  }
}

/**
 * Write an edited document back over the text it was parsed from.
 *
 * The comparison in preserveYamlFormatting is only exact when both sides are rendered with the same
 * options, so they are given once, here. With no original (a file being created) the library's
 * rendering is the file.
 */
export function renderPreservingFormatting(original, document, options = YAML_OUTPUT) {
  const rendered = document.toString(options);
  return original == null ? rendered : preserveYamlFormatting(original, rendered, options);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

/** Equal as data. A map's key order is not a difference: the file keeps its own. */
function sameData(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const dataOf = (document, node) => (YAML.isNode(node) ? node.toJS(document) : node);
const keyOf = (pair) => String(YAML.isScalar(pair.key) ? pair.key.value : pair.key);

/** An empty `{}` or `[]` says nothing about how its contents should be laid out, so it is not kept. */
const reusable = (node) => YAML.isCollection(node) && node.items.length > 0;

/** A new node for a value, carrying the comments and blank line of the node it replaces. */
function replacement(document, node, value) {
  const created = document.createNode(value, { aliasDuplicateObjects: false });
  if (YAML.isNode(node)) {
    if (node.commentBefore) created.commentBefore = node.commentBefore;
    if (node.spaceBefore) created.spaceBefore = node.spaceBefore;
    if (node.comment && YAML.isScalar(node) && YAML.isScalar(created)) created.comment = node.comment;
    if (reusable(node) && YAML.isCollection(created)) created.flow = node.flow;
  }
  return created;
}

/**
 * The items of a list made to be `values`. Unchanged items keep their nodes; an item that changed
 * in place is updated in place, so a list keeps its comments and its flow or block layout.
 */
function patchSequence(document, sequence, current, values) {
  const operations = lineOperations(current.map((value) => JSON.stringify(canonical(value))),
    values.map((value) => JSON.stringify(canonical(value))));
  const items = [];
  let removed = []; let added = [];
  const flush = () => {
    added.forEach((index, position) => items.push(position < removed.length
      ? syncNode(document, sequence.items[removed[position]], values[index])
      : replacement(document, null, values[index])));
    removed = []; added = [];
  };
  for (const [kind, index] of operations) {
    if (kind === ' ') { flush(); items.push(sequence.items[index]); }
    else if (kind === '-') removed.push(index);
    else added.push(index);
  }
  flush();
  sequence.items = items;
}

/** A node made to hold exactly `value`, reusing as much of it as already does. */
function syncNode(document, node, value) {
  const current = dataOf(document, node);
  if (sameData(current, value)) return node;
  if (YAML.isMap(node) && reusable(node) && isRecord(value)) return patchNode(document, node, current, value);
  if (YAML.isSeq(node) && reusable(node) && Array.isArray(value)) {
    patchSequence(document, node, current, value);
    return node;
  }
  // A scalar of the same type keeps its node, and with it its quoting and trailing comment.
  if (YAML.isScalar(node) && node.value !== null && value !== null && typeof value !== 'object'
      && typeof node.value === typeof value) {
    node.value = value;
    return node;
  }
  return replacement(document, node, value);
}

function patchNode(document, node, before, after) {
  if (sameData(before, after)) return node;
  if (!(YAML.isMap(node) && reusable(node) && isRecord(before) && isRecord(after))) {
    return syncNode(document, node, after);
  }
  for (const key of Object.keys(before)) {
    if (after[key] !== undefined) continue;
    const index = node.items.findIndex((pair) => keyOf(pair) === key);
    if (index >= 0) node.items.splice(index, 1);
  }
  for (const [key, value] of Object.entries(after)) {
    if (value === undefined) continue;
    const known = before[key] !== undefined;
    if (known && sameData(before[key], value)) continue;
    const pair = node.items.find((entry) => keyOf(entry) === key);
    if (!pair) node.items.push(document.createPair(key, replacement(document, null, value)));
    else pair.value = known ? patchNode(document, pair.value, before[key], value) : syncNode(document, pair.value, value);
  }
  return node;
}

/**
 * Apply the change from `before` to `after` to a parsed document, node by node.
 *
 * For code that edits plain data rather than the document. Only what differs between the two is
 * written: a changed scalar keeps its node, a list keeps the items that did not change, and a key
 * added to a map goes after the keys already there. Everything else, comments included, stays as
 * parsed. `before` is normally the document's own data. It may instead be a normalized reading of
 * it, and then a field the normalization added or reshaped is left as the file has it unless the
 * change itself touches it.
 */
export function patchYamlDocument(document, before, after) {
  document.contents = patchNode(document, document.contents, before, after);
  return document;
}

/**
 * The text of `original` changed to hold `data`, with every line the change did not touch as it
 * was written. For writers that hold the file as plain data. `before` is passed when `data` was
 * derived from a normalized reading of the file rather than from the file itself (see
 * patchYamlDocument). The library's own rendering of `data` is returned for a file being created,
 * and whenever the patched document would not hold exactly `data`.
 */
export function renderDataPreservingFormatting(original, data, { before, options = YAML_OUTPUT } = {}) {
  const rendered = () => YAML.stringify(data, options);
  if (original == null) return rendered();
  let document;
  try { document = YAML.parseDocument(original); } catch { return rendered(); }
  if (document.errors?.length) return rendered();
  patchYamlDocument(document, before === undefined ? document.toJS() : before, data);
  if (before === undefined && !sameData(document.toJS(), data)) return rendered();
  return renderPreservingFormatting(original, document, options);
}
