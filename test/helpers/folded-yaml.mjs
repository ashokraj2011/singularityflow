/**
 * Configuration files laid out the way the YAML library writes them with its default options.
 *
 * Writers that re-rendered a whole file with `String(document)` left files like this in real
 * repositories: long values folded at 80 columns, flow collections padded, and a flow collection
 * longer than 80 columns spread over several lines. A writer that keeps a file's formatting has to
 * keep this layout as well as a hand-written one, so these tests start from it.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import YAML from 'yaml';
import { lineOperations } from '../../src/yaml-formatting.mjs';
import { YAML_OUTPUT } from '../../src/util.mjs';

/** A description long enough to be folded at 80 columns. */
export const LONG_DESCRIPTION = 'Kept exactly as the people who maintain this file wrote it, across '
  + 'several lines, because a writer that changes another key has no reason to touch it.';

/**
 * Rewrite a YAML file the way the library lays it out by default, after an optional change to the
 * document (to give it a long value, say), and return the new text.
 */
export async function foldYamlFile(file, change = null) {
  const document = YAML.parseDocument(await readFile(file, 'utf8'));
  if (change) change(document);
  const text = document.toString();
  assertFolded(text);
  await writeFile(file, text, 'utf8');
  return text;
}

/**
 * The text with the first value of `key` that the library folded written back on one line, the way a
 * person writes it. A file then has both layouts: a writer rendering with YAML_OUTPUT would join the
 * folded values, and one rendering with the library's defaults would fold this one again.
 */
export function unfoldFirst(text, key = 'description') {
  const document = YAML.parseDocument(text);
  let found = null;
  YAML.visit(document, {
    Pair(_, pair) {
      const name = YAML.isScalar(pair.key) ? pair.key.value : pair.key;
      if (found || name !== key || !YAML.isScalar(pair.value)) return;
      const [start, end] = pair.value.range;
      if (text.slice(start, end).includes('\n')) found = { start, end, value: pair.value.value };
    }
  });
  assert.ok(found, `the fixture has a folded ${key}`);
  const line = JSON.stringify(found.value);
  assert.ok(line.length > 80);
  return { text: text.slice(0, found.start) + line + text.slice(found.end), line };
}

/** The text has values written over several lines, which a whole-file rendering would join. */
export function assertFolded(text) {
  const joined = YAML.parseDocument(text).toString(YAML_OUTPUT);
  assert.ok(joined.split('\n').length < text.split('\n').length,
    'the fixture has values written over several lines');
}

/** The lines an edit removed and the lines it added, by line diff. */
export function changedLines(before, after) {
  const a = before.split('\n'); const b = after.split('\n');
  const removed = []; const added = [];
  for (const [kind, index] of lineOperations(a, b)) {
    if (kind === '-') removed.push(a[index]);
    if (kind === '+') added.push(b[index]);
  }
  return { removed, added };
}
