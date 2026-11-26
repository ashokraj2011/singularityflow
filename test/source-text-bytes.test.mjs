/**
 * No tracked text file holds a raw control byte (other than tab, line feed and carriage return). One raw NUL in a
 * template literal made Git treat a source file as binary: its diffs showed "Binary files differ", so a review
 * could not read the change. Write the escape (`\x00`, `\u001f`) instead; the string is the same.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEXT = ['*.mjs', '*.cjs', '*.js', '*.ts', '*.tsx', '*.md', '*.json', '*.yml', '*.yaml', '*.css', '*.html'];

const controlBytes = (bytes) => {
  const found = [];
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) found.push(index);
  }
  return found;
};

test('no tracked text file holds a raw control byte, so Git reads every one as text', () => {
  const files = execFileSync('git', ['ls-files', '-z', '--', ...TEXT], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(Boolean);
  assert.ok(files.length > 1000, `expected the repository's text files, found ${files.length}`);
  const offenders = [];
  for (const file of files) {
    let bytes;
    try { bytes = readFileSync(path.join(ROOT, file)); } catch { continue; }
    const found = controlBytes(bytes);
    if (found.length) {
      const line = bytes.subarray(0, found[0]).toString('utf8').split('\n').length;
      offenders.push(`${file}:${line} (${found.length} byte(s), first 0x${bytes[found[0]].toString(16).padStart(2, '0')})`);
    }
  }
  assert.deepEqual(offenders, [], `write the escape instead of the raw byte:\n${offenders.join('\n')}`);
});

test('the check finds a raw control byte and passes tabs and line ends', () => {
  assert.deepEqual(controlBytes(Buffer.from('a\tb\r\nc\n')), []);
  assert.deepEqual(controlBytes(Buffer.from([0x61, 0x00, 0x62, 0x1f])), [1, 3]);
});
