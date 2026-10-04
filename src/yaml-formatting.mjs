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
 * The original lines each line of the library's rendering stands for. A value written over several
 * lines renders on one, so its span is one group; every other line is a group of its own. Null when
 * the groups do not line up with the rendering, and the caller then cannot replay the edit.
 */
function sourceGroups(original, document, renderedLines) {
  const starts = [0];
  for (let index = 0; index < original.length; index += 1) if (original[index] === '\n') starts.push(index + 1);
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
  return groups.length === renderedLines ? groups : null;
}

/**
 * Keep a YAML file's own formatting on every line an edit did not touch.
 *
 * Rendering the unedited document the same way gives a baseline whose lines correspond to the
 * original's: one to one, or one baseline line to the several original lines of a value written over
 * them. The baseline-to-edited line diff is exactly the edit, so it is replayed onto the original
 * text instead. When the correspondence or the parsed result is not exact, the library's own
 * rendering is used unchanged.
 */
export function preserveYamlFormatting(original, edited, options = YAML_OUTPUT) {
  let document;
  try { document = YAML.parseDocument(original); } catch { return edited; }
  if (document.errors?.length) return edited;
  const baseline = document.toString(options);
  const source = original.split('\n'); const before = baseline.split('\n'); const after = edited.split('\n');
  const groups = sourceGroups(original, document, before.length);
  if (!groups && source.length !== before.length) return edited;
  const kept = (index) => (groups ? source.slice(groups[index][0], groups[index][1] + 1).join('\n') : source[index]);
  const merged = lineOperations(before, after)
    .filter(([kind]) => kind !== '-')
    .map(([kind, index]) => (kind === ' ' ? kept(index) : after[index]))
    .join('\n');
  try {
    return JSON.stringify(YAML.parse(merged)) === JSON.stringify(YAML.parse(edited)) ? merged : edited;
  } catch {
    return edited;
  }
}
