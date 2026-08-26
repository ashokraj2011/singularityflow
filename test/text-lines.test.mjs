/**
 * The replacement has to agree with what it replaced, at every offset.
 *
 * Six modules carried `text.slice(0, index).split('\n').length` — correct, and quadratic: it copies
 * the file up to the offset and splits it, once per regex match. On the repository-facts and AST
 * extraction paths that runs over every source file in a world-model build, and `MAX_SCAN_BYTES`
 * lets a single file be 512 KB, so one dense module can do a couple of hundred megabytes of copying
 * to answer questions about itself.
 *
 * A faster line lookup that is off by one somewhere is worse than a slow one, because every citation
 * this produces points a reader at the wrong line and nothing fails.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { lineNumbers } from '../src/text-lines.mjs';

/** What was there before, kept as the oracle rather than as a description of it. */
const previous = (text, index) => text.slice(0, index).split('\n').length;

test('every offset in every shape agrees with the implementation this replaced', () => {
  const texts = [
    '',
    'one line, no newline',
    'a\nbb\n\nccc\nd',
    '\n\n\n',
    'trailing newline\n',
    // Non-ASCII: the offsets are string indices in both, so an emoji must not shift the answer.
    'héllo\nwörld 🙂\nlast',
    `${'x'.repeat(300)}\n${'y'.repeat(300)}`
  ];
  for (const text of texts) {
    const lineAt = lineNumbers(text);
    for (let offset = 0; offset <= text.length; offset += 1) {
      assert.equal(lineAt(offset), previous(text, offset),
        `disagreed at offset ${offset} of ${JSON.stringify(text.slice(0, 24))}`);
    }
  }
});

test('an offset outside the text is clamped rather than thrown', () => {
  /**
   * Every caller is reporting the position of something it already found in this string, so an
   * out-of-range offset is a caller bug — and throwing here would turn a wrong citation into a
   * failed world-model build, which is a worse trade than a clamped line number.
   */
  const lineAt = lineNumbers('a\nb\nc');
  assert.equal(lineAt(9999), 3);
  assert.equal(lineAt(-5), 1);
});

test('the scan happens once, not once per lookup', () => {
  /**
   * The whole saving is in hoisting, so the factory shape is the fix. A `line(text, offset)`
   * signature would be a drop-in that quietly reintroduced the cost, which is why there isn't one.
   */
  const text = `${'a'.repeat(50_000)}\n${'b'.repeat(50_000)}`;
  const lineAt = lineNumbers(text);
  const started = process.hrtime.bigint();
  for (let index = 0; index < 20_000; index += 1) lineAt(text.length - 1);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  // Twenty thousand lookups at the far end of a 100 KB string. The previous shape copies 100 KB
  // each time — two gigabytes of copying — and cannot come close to this on any machine.
  assert.ok(elapsedMs < 250, `20,000 lookups took ${elapsedMs.toFixed(1)}ms; the scan is not hoisted`);
});
