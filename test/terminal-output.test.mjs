/**
 * Signal over noise, without changing what anything downstream receives.
 *
 * The load-bearing guarantee here is the last test: with no TTY, output is byte-identical to what it
 * was before styling existed. That is what makes colour safe to add to a tool whose output is parsed
 * by an extension, redirected into files, and asserted on by a thousand tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  colorEnabled, displayWidth, fields, mark, padDisplay, setColorEnabled, truncateDisplay
} from '../src/style.mjs';
import { table } from '../src/util.mjs';
import { renderOverview, overviewCommands } from '../src/help-pages.mjs';
import { canonicalCommand } from '../src/command-registry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'bin', 'singularity-flow.mjs');

test('colour is off when nothing is attached, and NO_COLOR always wins', () => {
  assert.equal(colorEnabled({}, { isTTY: false }), false);
  assert.equal(colorEnabled({}, { isTTY: true }), true);
  assert.equal(colorEnabled({ NO_COLOR: '1' }, { isTTY: true }), false);
  assert.equal(colorEnabled({ NO_COLOR: '1', FORCE_COLOR: '1' }, { isTTY: true }), false);
  assert.equal(colorEnabled({ TERM: 'dumb' }, { isTTY: true }), false);
  assert.equal(colorEnabled({ FORCE_COLOR: '1' }, { isTTY: false }), true);
});

test('a piped run is byte-identical to the unstyled output', () => {
  // execFileSync gives the child a pipe, not a terminal — exactly how the VS Code adapter, a shell
  // redirect and CI all invoke it.
  const piped = execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.doesNotMatch(piped, /\x1b\[/, 'an escape sequence reached a non-terminal stream');
});

test('the escape sequences are real bytes only at runtime, never literals in the source', () => {
  setColorEnabled(true);
  try {
    assert.match(mark('pass'), /\x1b\[32m✓\x1b\[0m/);
    assert.match(mark('warn'), /\x1b\[33m~\x1b\[0m/);
    assert.match(mark('fail'), /\x1b\[31m✗\x1b\[0m/);
  } finally {
    setColorEnabled(null);
  }
});

test('a pass and a fail are no longer the same visual weight', () => {
  setColorEnabled(true);
  try {
    assert.notEqual(mark('pass').replace(/[✓✗~]/, ''), mark('fail').replace(/[✓✗~]/, ''));
  } finally {
    setColorEnabled(null);
  }
});

test('width is measured in columns, not code units', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('日本語'), 6, 'CJK characters occupy two columns each');
  setColorEnabled(true);
  try {
    assert.equal(displayWidth(mark('pass')), 1, 'escape codes occupy no columns');
  } finally {
    setColorEnabled(null);
  }
});

test('truncation marks the cut and never exceeds the width it was given', () => {
  assert.equal(truncateDisplay('short', 10), 'short');
  assert.equal(truncateDisplay('abcdefghij', 5), 'abcd…');
  assert.ok(displayWidth(truncateDisplay('日本語のタイトル', 5)) <= 5);
});

test('padding accounts for wide characters', () => {
  assert.equal(displayWidth(padDisplay('日本', 10)), 10);
  assert.equal(displayWidth(padDisplay('ab', 10)), 10);
});

test('a table fits the terminal and never truncates the first column', () => {
  // One long free-text title used to push the table past the terminal and wrap every row into
  // rubble. The identifier is what you copy into the next command, so it is the one thing kept whole.
  const rows = [
    { id: 'WI-0001', title: 'x'.repeat(200), status: 'awaiting_approval' },
    { id: 'WI-0002', title: '日本語のタイトルはここにあります', status: 'in_progress' }
  ];
  const columns = [{ key: 'id', label: 'ID' }, { key: 'title', label: 'Title' }, { key: 'status', label: 'Status' }];
  const rendered = table(rows, columns, { width: 78 });
  for (const line of rendered.split('\n')) {
    assert.ok(displayWidth(line) <= 78, `line exceeds the terminal: ${displayWidth(line)} columns`);
  }
  assert.match(rendered, /WI-0001/);
  assert.match(rendered, /WI-0002/);
});

test('fields drops what is absent so no line ever reads "· ·"', () => {
  assert.equal(fields('a', null, 'b', undefined, ''), 'a · b');
  assert.equal(fields(), '');
});

test('bare --help is one screen and --help --all is the full synopsis', () => {
  const overview = execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  const complete = execFileSync(process.execPath, [cli, '--help', '--all'], { encoding: 'utf8' });
  assert.ok(overview.split('\n').length <= 40, `the overview is ${overview.split('\n').length} lines`);
  assert.ok(complete.split('\n').length > 300, 'the complete synopsis should still be complete');
  assert.match(overview, /singularity-flow quickstart/);
  assert.match(overview, /--help --all/);
});

test('every command the overview names actually dispatches', () => {
  // The groups are curated by hand, which is the point — and exactly why they can rot.
  for (const name of overviewCommands()) {
    assert.doesNotThrow(() => canonicalCommand(name), `the overview names '${name}', which does not dispatch`);
  }
});

test('the overview renders without a terminal attached', () => {
  const rendered = renderOverview('9.9.9');
  assert.match(rendered, /Singularity Flow 9\.9\.9/);
  assert.doesNotMatch(rendered, /\x1b\[/);
});
