import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createLogger, filterLogEntries, logFilePath, normalizeLogging, normalizeLogLevel,
  parseLogLines, redact, REDACTED, resolveLogging
} from '../src/logging.mjs';

async function logger(overrides = {}) {
  const gitDirectory = await mkdtemp(path.join(os.tmpdir(), 'sflow-logging-'));
  return { gitDirectory, log: createLogger({ gitDirectory, level: 'all', consoleLevel: 'off', ...overrides }) };
}

async function entries(gitDirectory) {
  return parseLogLines(await readFile(logFilePath(gitDirectory), 'utf8'));
}

test('levels are ordered and the names people actually type are accepted', () => {
  assert.equal(normalizeLogLevel('all'), 'trace');
  assert.equal(normalizeLogLevel('verbose'), 'debug');
  assert.equal(normalizeLogLevel('silent'), 'off');
  assert.equal(normalizeLogLevel('WARNING'), 'warn');
  // An unusable value must not silently disable logging.
  assert.equal(normalizeLogLevel('nonsense'), 'info');
  assert.equal(normalizeLogLevel(undefined, 'error'), 'error');
});

test('the file sink honours its level independently of the console sink', async () => {
  const { gitDirectory, log } = await logger({ level: 'warn', consoleLevel: 'off' });
  log.error('a.error');
  log.warn('a.warn');
  log.info('a.info');
  log.debug('a.debug');
  const written = await entries(gitDirectory);
  assert.deepEqual(written.map((entry) => entry.event), ['a.error', 'a.warn']);
});

test('secrets are redacted by key and by shape, including inside free text', async () => {
  const { gitDirectory, log } = await logger();
  log.info('jira.connect', 'authorizing with Bearer abcdefghijklmnopqrst', {
    token: 'plain-secret',
    apiKey: 'another-secret',
    nested: { password: 'hunter2', authorization: 'Basic zzzz', note: 'the pat is ghp_abcdefghijklmnopqrstuvwxyz01' },
    safe: 'keep-me'
  });
  const raw = await readFile(logFilePath(gitDirectory), 'utf8');
  for (const secret of ['plain-secret', 'another-secret', 'hunter2', 'Basic zzzz', 'ghp_abcdefghijklmnopqrstuvwxyz01', 'Bearer abcdefghijklmnopqrst']) {
    assert.equal(raw.includes(secret), false, `leaked ${secret}`);
  }
  const [entry] = await entries(gitDirectory);
  assert.equal(entry.token, REDACTED);
  assert.equal(entry.nested.password, REDACTED);
  assert.equal(entry.safe, 'keep-me');
});

test('redaction survives cycles, depth, and error objects without throwing', () => {
  const cyclic = { name: 'root' };
  cyclic.self = cyclic;
  assert.equal(redact(cyclic).self, '[circular]');
  const deep = { a: { b: { c: { d: { e: { f: { g: 'too far' } } } } } } };
  assert.equal(JSON.stringify(redact(deep)).includes('[depth limit]'), true);
  const source = new Error('boom');
  source.code = 'CONVERGENCE_INVALID';
  source.details = {
    iteration: 1,
    path: 'singularity/work-items/WRK-1/context/convergence/iteration-1.json',
    currentBindingsSha256: 'a'.repeat(64),
    token: 'must-not-leak',
    diagnostic: 'private prompt text must-not-leak',
    url: 'https://person:office-password@example.invalid/repo.git'
  };
  source.details.parent = source;
  const failure = redact(source);
  assert.equal(failure.name, 'Error');
  assert.equal(failure.message, 'boom');
  assert.equal(failure.code, 'CONVERGENCE_INVALID');
  assert.equal(failure.details.iteration, 1);
  assert.equal(failure.details.path, 'singularity/work-items/WRK-1/context/convergence/iteration-1.json');
  assert.equal(failure.details.currentBindingsSha256, 'a'.repeat(64));
  assert.equal(JSON.stringify(failure).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(failure).includes('office-password'), false);

  const unrelated = new Error('unrelated');
  unrelated.code = 'SOME_OTHER_ERROR';
  unrelated.details = { innocentName: 'raw private prompt must-not-leak' };
  assert.equal(redact(unrelated).details, undefined, 'arbitrary Error.details entered the activity log');
  assert.equal(redact('https://person:office-password@example.invalid/repo.git').includes('office-password'), false);
});

test('child loggers inherit bound context so every entry carries its subject', async () => {
  const { gitDirectory, log } = await logger({ context: { command: 'initiative' } });
  log.child({ initiativeId: 'SF-E1' }).child({ phase: 'epic-planning' }).info('phase.prepared');
  const [entry] = await entries(gitDirectory);
  assert.equal(entry.command, 'initiative');
  assert.equal(entry.initiativeId, 'SF-E1');
  assert.equal(entry.phase, 'epic-planning');
});

test('time records the outcome and rethrows the original failure', async () => {
  const { gitDirectory, log } = await logger();
  await log.time('work.ok', async () => 'value', { subject: 'a' });
  await assert.rejects(() => log.time('work.bad', async () => { throw new Error('nope'); }), /nope/);
  const written = await entries(gitDirectory);
  const events = written.map((entry) => entry.event);
  assert.ok(events.includes('work.ok.ok'), events.join(','));
  assert.ok(events.includes('work.bad.failed'), events.join(','));
  const failed = written.find((entry) => entry.event === 'work.bad.failed');
  assert.equal(failed.level, 'error');
  assert.equal(typeof failed.durationMs, 'number');
});

test('the log rotates and retains only the configured generations', async () => {
  const { gitDirectory, log } = await logger({ maxBytes: 4096, keep: 3 });
  for (let index = 0; index < 400; index += 1) log.info('bulk', 'padding entry long enough to grow the file quickly', { index });
  const file = logFilePath(gitDirectory);
  assert.ok(statSync(file).size < 4096 * 2);
  assert.equal(existsSync(`${file}.1`), true);
  assert.equal(existsSync(`${file}.3`), true);
  // keep: 3 means .4 must never appear, or the log grows without bound.
  assert.equal(existsSync(`${file}.4`), false);
});

test('logging never writes to stdout, because the CLI emits JSON there', async () => {
  // fd 1 belongs to command output. A logger that writes there corrupts every --json consumer,
  // which has already shipped as a bug once.
  const source = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'logging.mjs'), 'utf8');
  assert.equal(source.includes('const STDERR_FD = 2'), true);
  assert.equal(/process\.stdout|writeSync\(1/.test(source), false);
});

test('environment overrides committed configuration for a single command', () => {
  const committed = { logging: { level: 'error', console: 'off' } };
  assert.equal(resolveLogging(committed, {}).level, 'error');
  // One variable raises both sinks, which is what someone debugging expects.
  const raised = resolveLogging(committed, { SINGULARITY_FLOW_LOG_LEVEL: 'all' });
  assert.equal(raised.level, 'trace');
  assert.equal(raised.console, 'trace');
  // The console can be raised on its own without touching the file level.
  const console = resolveLogging(committed, { SINGULARITY_FLOW_LOG_CONSOLE: 'debug' });
  assert.equal(console.level, 'error');
  assert.equal(console.console, 'debug');
});

test('configuration is validated rather than silently ignored', () => {
  assert.throws(() => normalizeLogging({ nope: true }), /unknown field 'nope'/);
  assert.throws(() => normalizeLogging({ maxBytes: 10 }), /at least 4096/);
  assert.throws(() => normalizeLogging({ keep: 0 }), /between 1 and 20/);
  assert.deepEqual(normalizeLogging({ level: 'all' }).level, 'trace');
});

test('filtering selects by level, event, and time, and a truncated line is reported not dropped', () => {
  const parsed = parseLogLines([
    JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', level: 'info', event: 'command.start' }),
    JSON.stringify({ ts: '2026-01-02T00:00:00.000Z', level: 'error', event: 'hook.guard.deny' }),
    '{"ts":"2026-01-03T00:00:00.000Z","level":"info","eve'
  ].join('\n'));
  assert.equal(parsed.length, 3);
  // A process that died mid-write leaves a partial line; hiding it would hide the crash.
  assert.equal(parsed[2].event, 'log.unreadable');
  assert.deepEqual(filterLogEntries(parsed, { level: 'error' }).map((entry) => entry.event), ['hook.guard.deny', 'log.unreadable']);
  assert.deepEqual(filterLogEntries(parsed, { event: 'hook' }).map((entry) => entry.event), ['hook.guard.deny']);
  assert.equal(filterLogEntries(parsed, { since: '2026-01-02T00:00:00.000Z' }).length, 2);
});

test('a repository without a resolvable Git directory still logs to stderr', () => {
  // Losing diagnostics is worse than having no file, so the logger degrades instead of throwing.
  const log = createLogger({ gitDirectory: null, level: 'all', consoleLevel: 'off' });
  assert.equal(log.file, null);
  assert.doesNotThrow(() => log.error('detached.error', 'no repository'));
});
