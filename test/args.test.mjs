import test from 'node:test';
import assert from 'node:assert/strict';
import { optionBoolean, optionString, parseArgs } from '../src/util.mjs';

test('parseArgs handles positionals, values, equals, and no-flags', () => {
  const parsed = parseArgs(['start', 'ABC-123', '--title', 'Demo', '--base=main', '--no-commit']);
  assert.deepEqual(parsed.positionals, ['start', 'ABC-123']);
  assert.equal(optionString(parsed.options, 'title'), 'Demo');
  assert.equal(optionString(parsed.options, 'base'), 'main');
  assert.equal(optionBoolean(parsed.options, 'commit', true), false);
});

test('parseArgs supports repeated options', () => {
  const parsed = parseArgs(['x', '--tag', 'one', '--tag', 'two']);
  assert.deepEqual(parsed.options.tag, ['one', 'two']);
  assert.equal(optionString(parsed.options, 'tag'), 'two');
});
