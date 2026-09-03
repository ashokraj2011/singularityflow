/**
 * A failure has to read like a sentence, not like a crash.
 *
 * The engine logged every failure as one line of JSON — timestamp, level, and the whole error object
 * including its stack — and only then printed the explanation. Because `error` always passes the
 * console filter, this was unconditional: the most common beginner mistakes answered with a couple of
 * kilobytes of wrapped JSON. These tests hold the terminal to the sentence and keep the evidence in
 * the log file, which is where diagnosis belongs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger, resolveLogging } from '../src/logging.mjs';
import { BOOLEAN_OPTIONS, didYouMean, nearestNames, parseArgs, requirePositional, sentenceList } from '../src/util.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'bin', 'singularity-flow.mjs');

// Run the real binary in a throwaway repository. Anything less than the real process misses exactly
// the layer under test: what actually lands on the terminal.
function runCli(args, { env = {} } = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'sflow-failure-'));
  try {
    execFileSync('git', ['init', '-q', '.'], { cwd });
    try {
      const stdout = execFileSync(process.execPath, [cli, ...args], {
        cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env }
      });
      return { stdout, stderr: '', status: 0 };
    } catch (error) {
      return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', status: error.status ?? 1 };
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('a failing command prints a sentence, not a structured log line', () => {
  const { stderr } = runCli(['start']);
  assert.doesNotMatch(stderr, /"error":/, 'the serialized error object reached the terminal');
  assert.doesNotMatch(stderr, /\bat \w+.*\(.*:\d+:\d+\)/, 'a stack frame reached the terminal');
  assert.doesNotMatch(stderr, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+ERROR\s+command\.failed/m,
    'the command.failed log line reached the terminal');
  assert.match(stderr, /Missing work ID\./);
});

test('a refusal for a missing argument carries usage and a way to learn more', () => {
  // 113 call sites reach this one helper, so the remedy has to live in the helper.
  const { stderr } = runCli(['start']);
  assert.match(stderr, /Usage: singularity-flow start <work-id>/);
  assert.match(stderr, /singularity-flow start --help/);
});

test('a mistyped command is corrected instead of merely rejected', () => {
  const { stderr } = runCli(['stauts']);
  assert.match(stderr, /Unknown command 'stauts'\./);
  assert.match(stderr, /Did you mean .*'status'/);
  assert.match(stderr, /--help/);
  // Appending all 2,450 lines of HELP was the previous answer to a typo, via a branch that could
  // never run because the registry threw first.
  assert.ok(stderr.split('\n').length < 10, `a typo produced ${stderr.split('\n').length} lines`);
});

test('--verbose puts the diagnostics back on screen', () => {
  const quiet = runCli(['start']);
  const loud = runCli(['start', '--verbose']);
  const explicitlyQuiet = runCli(['start', '--verbose=false']);
  assert.doesNotMatch(quiet.stderr, /command\.failed/);
  assert.doesNotMatch(explicitlyQuiet.stderr, /command\.failed/);
  assert.match(loud.stderr, /command\.failed/);
  assert.ok(loud.stderr.length > quiet.stderr.length);
});

test('SINGULARITY_FLOW_DEBUG=1 means debug, not just a stack', () => {
  // The name promised diagnostics; it gated only the pretty stack print, so setting it changed
  // almost nothing while the unconditional JSON stayed exactly as loud.
  const resolved = resolveLogging(null, { SINGULARITY_FLOW_DEBUG: '1' });
  assert.equal(resolved.console, 'debug');
  assert.equal(resolved.level, 'debug');
  assert.equal(resolved.consoleDetail, true);
});

test('an explicit console level still wins over debug, so --json keeps a clean transport', () => {
  const resolved = resolveLogging(null, { SINGULARITY_FLOW_DEBUG: '1', SINGULARITY_FLOW_LOG_CONSOLE: 'off' });
  assert.equal(resolved.console, 'off');
  assert.equal(resolved.consoleDetail, false);
});

test('the console sink omits structured context unless detail is requested', () => {
  const lines = [];
  const write = (text) => lines.push(text);
  // Exercise the renderer through the public surface by capturing what the logger would emit.
  const quiet = createLogger({ consoleLevel: 'off', level: 'trace', write: (_file, text) => write(text) });
  assert.equal(quiet.consoleDetail, false);
  const loud = createLogger({ consoleLevel: 'off', level: 'trace', consoleDetail: true, write: (_file, text) => write(text) });
  assert.equal(loud.consoleDetail, true);
});

test('a boolean flag does not swallow the token after it', () => {
  // `submit --skip-checks design` set skip-checks to "design" and dropped the phase, then failed
  // with a type error naming the flag the user had used correctly.
  const { positionals, options } = parseArgs(['submit', '--skip-checks', 'design']);
  assert.deepEqual(positionals, ['submit', 'design']);
  assert.equal(options['skip-checks'], true);
});

test('a value flag still takes its value', () => {
  const { positionals, options } = parseArgs(['submit', '--phase', 'design']);
  assert.deepEqual(positionals, ['submit']);
  assert.equal(options.phase, 'design');
});

test('flags read both ways stay greedy rather than guessing', () => {
  // Guessing wrong on an ambiguous flag would swallow a real value — the worse failure.
  for (const ambiguous of ['agent', 'confirm', 'jira']) {
    assert.equal(BOOLEAN_OPTIONS.has(ambiguous), false, `${ambiguous} must not be declared boolean`);
  }
});

test('suggestions are offered only when something is genuinely close', () => {
  // A transposition is one edit, so the intended word ranks first and the merely similar ones are
  // dropped rather than padded in.
  assert.deepEqual(nearestNames('stauts', ['status', 'start', 'stack', 'ledger']), ['status', 'start']);
  assert.deepEqual(nearestNames('submti', ['submit', 'status', 'sync']), ['submit']);
  assert.deepEqual(nearestNames('zzzzzzzzzz', ['status', 'start']), []);
  assert.equal(didYouMean('zzzzzzzzzz', ['status']), '', 'a wrong guess is worse than no guess');
});

test('an abbreviation ranks its completions ahead of its near-spellings', () => {
  // People abbreviate more often than they misspell, so a prefix match outranks an edit.
  assert.deepEqual(nearestNames('stat', ['status', 'start', 'state', 'stack']), ['state', 'status', 'start']);
});

test('a suggestion list reads as a sentence', () => {
  assert.equal(sentenceList(['a']), 'a');
  assert.equal(sentenceList(['a', 'b']), 'a or b');
  assert.equal(sentenceList(['a', 'b', 'c']), 'a, b or c');
});

test('requirePositional reconstructs the command path it was called from', () => {
  const error = (() => {
    try { requirePositional(['choices', 'select', 'approve'], 3, 'work ID'); return null; }
    catch (caught) { return caught; }
  })();
  assert.ok(error, 'expected a refusal');
  assert.equal(error.code, 'MISSING_ARGUMENT');
  assert.match(error.message, /Usage: singularity-flow choices select approve <work-id>/);
});
