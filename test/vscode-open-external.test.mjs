/**
 * VS Code opens a `Uri` as `encodeURI(uri.toString(true))`, which encodes an address a second time: in the real VS Code
 * check of 2026-11-24 a marketplace issue body's `#` arrived as `%2523`, and an `&` or `+` in a query would split or
 * change it. Given a string, VS Code opens the address as written (extHostWindow.openUri keeps it). So every page the
 * extension opens in the person's browser is handed to VS Code as the string SFlow wrote.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'vscode', 'src');

async function sources(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sources(file));
    else if (/\.ts$/u.test(entry.name)) files.push(file);
  }
  return files;
}

test('every address the extension opens in a browser is handed to VS Code as the string SFlow wrote', async () => {
  const parsed = []; const opens = [];
  for (const file of await sources(sourceRoot)) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(/env\.openExternal\(([^\n]*)/gu)) opens.push({ file: path.relative(sourceRoot, file), call: match[1] });
    if (/openExternal\(\s*vscode\.Uri\.parse/u.test(text)) parsed.push(path.relative(sourceRoot, file));
  }
  assert.deepEqual(parsed, [], 'never vscode.env.openExternal(vscode.Uri.parse(…))');
  const encoded = opens.filter(({ call }) => !/^\w+(?:\.\w+)* as unknown as vscode\.Uri\)/u.test(call));
  assert.deepEqual(encoded, [], 'each opens its string: openExternal(url as unknown as vscode.Uri)');
  assert.ok(opens.length >= 9, `the nine places that open a page are found (${opens.length})`);
});
