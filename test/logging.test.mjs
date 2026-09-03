import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createLogger, filterLogEntries, logFilePath, normalizeLogging, normalizeLogLevel,
  parseLogLines, redact, redactCommandArgv, REDACTED, resolveLogging
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

  const legacy = redact({
    remote: 'https://example.test/repo?signature=legacy-query-secret',
    note: 'Provider failed for https://example.test/repo?signature=embedded-query-secret',
    relative: 'Provider failed //example.test/repo?signature=scheme-relative-secret',
    malformed: 'Provider failed https:/alice:malformed-secret@example.test/repo',
    combined: 'Provider failed https://alice:password@example.test/repo?signature=combined-secret#frag',
    relativeCombined: 'Provider failed //alice:password@example.test/repo?signature=relative-combined-secret#frag'
  });
  assert.equal(legacy.remote, 'https://example.test/repo');
  assert.match(legacy.note, /https:\/\/example\.test\/repo/);
  assert.doesNotMatch(JSON.stringify(legacy), /legacy-query-secret|embedded-query-secret|scheme-relative-secret|malformed-secret|combined-secret|relative-combined-secret|signature=|password@/);
  for (const message of [
    'provider says password=office-secret',
    'provider says access_token=office-secret',
    'provider says password = office-secret',
    'provider says access_token : office-secret',
    'provider says authorization=Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==',
    'http.extraHeader="Authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ=="',
    "http.extraHeader='Authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ=='",
    'provider says password=TOP/LEAKMARK',
    'provider says credential=domain\\user:LEAKMARK',
    'provider says ext::LEAKMARK',
    'provider says cookie="office secret"',
    'provider says selection-receipt=office-secret',
    'provider {"password":"LEAKMARK"}',
    'provider {\\\\\\"password\\\\\\":\\\\\\"LEAKMARK\\\\\\"}',
    'provider {"access_token":"LEAKMARK"}',
    'provider password="abc\\\"LEAKMARK" tail',
    'fatal /tmp/alice:LEAKMARK@host/repo',
    'fatal ./x//LEAKMARK@host/repo',
    'Cookie: sid=LEAKMARK; remember=LEAKMARK',
    'password\n=LEAKMARK',
    'password\u0000=LEAKMARK',
    'password\u0085=LEAKMARK',
    'password\u202e=LEAKMARK',
    'pass\u0000word=LEAKMARK',
    'pass\u0085word=LEAKMARK',
    'pass\u202eword=LEAKMARK',
    'pass\u200bword=LEAKMARK',
    'pass\ufeffword=LEAKMARK',
    'pass\u001b[31mword=LEAKMARK',
    'pass\u009b31mword=LEAKMARK',
    'password\\=LEAKMARK',
    'password\\:LEAKMARK',
    "fatal https://alice:PREFIX'LEAKMARK@example.test/repo",
    "fatal https:alice:PREFIX'LEAKMARK@example.test/repo",
    'fatal ssh:alice:PREFIX<LEAKMARK@example.test/repo',
    'fatal remote "ext::sh -c echo LEAKMARK" failed',
    '-----BEGIN PRIVATE KEY-----\nLEAKMARK\n-----END PRIVATE KEY-----'
  ]) {
    assert.doesNotMatch(redact(message), /office-secret|office secret|QWxhZGRpb|LEAKMARK/);
  }
  const huge = `${'password=x;'.repeat(20_000)}${'A'.repeat(100_000)}`;
  const bounded = redact(huge);
  assert.ok(bounded.length < 2_200);
  assert.match(bounded, /\[truncated \d+ chars\]/);
  assert.doesNotMatch(bounded, /password=x/);
  const boundary = redact(`${'A'.repeat(1980)} ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`);
  assert.doesNotMatch(boundary, /ghp_|ABCDEFGHIJ/);
  const crossingRemote = redact(`${'A'.repeat(1980)} alice:LEAKMARK${'X'.repeat(700)}@host:repo`);
  assert.doesNotMatch(crossingRemote, /LEAKMARK/);
});

test('CLI argv redaction removes rejected remote and option secrets before durable logging', () => {
  const projected = redactCommandArgv([
    'workspace', 'doctor', '--network',
    '--repository', 'ssh://git@example.test/repo?access_token=short-secret',
    '--lead=https://alice:office-secret@example.test/platform.git',
    '--token', 'another-short-secret',
    '--access-token=access-secret',
    'git@example.test:team/repo#fragment-secret'
  ]);
  assert.deepEqual(projected.slice(0, 4), ['workspace', 'doctor', '--network', '--repository']);
  assert.equal(projected[4], 'ssh://example.test/repo');
  assert.equal(projected[5], '--lead=https://example.test/platform.git');
  assert.equal(projected[6], '--token');
  assert.equal(projected[7], REDACTED);
  assert.equal(projected[8], '--access-token=[redacted]');
  assert.equal(projected[9], 'git@example.test:team/repo[redacted-url-suffix]');
  assert.doesNotMatch(JSON.stringify(projected), /short-secret|office-secret|access-secret|fragment-secret/);

  for (const malformed of [
    'https:/alice:malformed-secret@example.test/repo',
    'https:alice:malformed-secret@example.test/repo',
    'http:\\alice:malformed-secret@example.test/repo'
  ]) {
    assert.doesNotMatch(JSON.stringify(redactCommandArgv([
      'workspace', 'doctor', '--repository', malformed
    ])), /malformed-secret/, malformed);
  }
  for (const unsafe of [
    'ext::password=office-secret',
    '-password=office-secret',
    'foo://host/password=office-secret'
  ]) {
    assert.deepEqual(redactCommandArgv([
      'workspace', 'doctor', '--repository', unsafe
    ]).at(-1), '[redacted-remote]');
    assert.doesNotMatch(JSON.stringify(redactCommandArgv([
      'workspace', 'doctor', `--repository=${unsafe}`
    ])), /office-secret/);
  }
  assert.equal(redactCommandArgv([
    'workspace', 'doctor', '--repository', 'x://MARKER@host/one-letter-secret'
  ]).at(-1), '[redacted-remote]');
  assert.doesNotMatch(JSON.stringify(redactCommandArgv([
    'bootstrap', ' https://example.test/repo?signature=positional-secret'
  ])), /positional-secret/);
  assert.deepEqual(redactCommandArgv([
    'workspace', 'doctor', '--repository', 'C:\\work\\repo',
    '--repository', 'D:/work/repo', '--repository', 'Git.Example:team/repo.git',
    '--repository', '/tmp/repo#release', '--repository', '../repo?literal',
    '--repository', 'ssh://git@Git.Example/repo.git',
    '--repository', 'HTTPS://Git.Example:443/repo.git',
    '--repository', 'https://git.example'
  ]).slice(-15), [
    'C:\\work\\repo', '--repository', 'D:/work/repo', '--repository', 'Git.Example:team/repo.git',
    '--repository', '/tmp/repo#release', '--repository', '../repo?literal',
    '--repository', 'ssh://git@Git.Example/repo.git',
    '--repository', 'HTTPS://Git.Example:443/repo.git',
    '--repository', 'https://git.example'
  ]);
  for (const sensitivePath of [
    './https://alice:office-secret@example.test/repo?signature=signed',
    './https:/alice:office-secret@example.test/repo',
    '/tmp/https:alice:office-secret@example.test/repo',
    './http:\\alice:office-secret@example.test/repo',
    './alice:office-secret@example.test/repo',
    '/tmp/alice:office-secret@example.test/repo',
    '/tmp/ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
    '/tmp/cache/password=office-secret',
    '/tmp/cache/cookie=office-secret',
    '/tmp/github-token=office-secret',
    '/tmp/identity-token=office-secret',
    '/tmp/selection-receipt=office-secret',
    '/tmp/access-key=office-secret',
    '/tmp/cookie = office-secret'
  ]) {
    const result = redactCommandArgv(['workspace', 'doctor', '--repository', sensitivePath]);
    assert.notEqual(result.at(-1), sensitivePath);
    assert.doesNotMatch(JSON.stringify(result), /office-secret|signature=signed|ghp_|password=/);
  }
  for (const keyedSecret of ['password', 'access_token', 'signature', 'cookie']) {
    assert.equal(redactCommandArgv([
      'workspace', 'doctor', '--repository', `${keyedSecret}=office-secret`
    ]).at(-1), '[redacted-remote]');
    assert.equal(redactCommandArgv([`${keyedSecret}=office-secret`]).at(-1), `${keyedSecret}=[redacted]`);
  }
  const collided = redactCommandArgv([
    'action', 'execute', 'plan-1', '--authorization', '--repository',
    'https://git.example/safe.git', 'actual-auth-secret'
  ]);
  assert.notEqual(collided.at(-2), 'https://git.example/safe.git');
  assert.equal(collided.at(-1), '[redacted]');
  assert.doesNotMatch(JSON.stringify(collided), /actual-auth-secret/);
  for (const command of [
    ['--client-secret=LEAKMARK'],
    ['--jira-token', 'LEAKMARK'],
    ['client_secret=LEAKMARK'],
    ['--proxy-password=LEAKMARK'],
    ['--aws-access-key', 'LEAKMARK'],
    ['--label=x=password=LEAKMARK'],
    ['--repository', '--ext::password=LEAKMARK'],
    ['--authorization', '--title', 'SAFE', 'actual-auth-secret'],
    ['--authorization', '--title=9ac6d4a8-4b84-4cd4-9b17-4b10eaab8899'],
    ['--authorization', '--title=arbitrary-auth-secret'],
    ['--authorization', '--', 'actual-auth-secret'],
    ['--authorization', '--client_secret', 'LEAKMARK'],
    ['--authorization', '--access_token', 'LEAKMARK'],
    ['--authorization', '--proxy_password', 'LEAKMARK'],
    ['--authorization', '--LEAKMARK'],
    ['--authorization', '---LEAKMARK'],
    ['--pass\u200bword', 'LEAKMARK'],
    ['--pass\u0000word', 'LEAKMARK'],
    ['--pass\u0085word', 'LEAKMARK'],
    ['--pass\u202eword', 'LEAKMARK'],
    ['--pass\u001b[31mword', 'LEAKMARK'],
    ['--repository', '--title', 'SAFE', '/tmp/alice:LEAKMARK@host/repo'],
    ['--repository', './x//LEAKMARK@host/repo'],
    ['--label={"password":"LEAKMARK"}'],
    ['--label={"access_token":"LEAKMARK"}'],
    ['http.extraHeader="Authorization: Basic LEAKMARK"']
  ]) assert.doesNotMatch(JSON.stringify(redactCommandArgv(command)), /LEAKMARK|actual-auth-secret/);
  assert.deepEqual(redactCommandArgv(['status', 'A'.repeat(100_000)]), ['status', REDACTED]);
  assert.deepEqual(redactCommandArgv([
    '--repository', 'foo=bar=baz', '--repository', 'a//b', '--repository', '/tmp/a//b',
    '--repository', 'git@example.test:repo@v2.git',
    '--repository', 'https://example.test/team:release@candidate.git',
    '--repository', '/tmp/team:release@candidate.git'
  ]).slice(-11), [
    'foo=bar=baz', '--repository', 'a//b', '--repository', '/tmp/a//b',
    '--repository', 'git@example.test:repo@v2.git',
    '--repository', 'https://example.test/team:release@candidate.git',
    '--repository', '/tmp/team:release@candidate.git'
  ]);
  for (const compound of [
    'service=https:/alice:compound-secret@example.test/repo',
    'service=ext::password=compound-secret',
    'service=-password=compound-secret'
  ]) {
    assert.doesNotMatch(JSON.stringify(redactCommandArgv([
      'workspace', 'create', '--repository', compound,
      `--repository=${compound}`
    ])), /compound-secret/);
  }

  const scpCredential = 'alice:scp-secret@example.test:team/repo.git';
  assert.equal(redactCommandArgv([
    'workspace', 'doctor', '--repository', scpCredential
  ]).at(-1), '[redacted-remote]');
  assert.doesNotMatch(JSON.stringify(redactCommandArgv([
    'workspace', 'doctor', `--repository=${scpCredential}`
  ])), /scp-secret/);

  const deeplyKeyed = `${'a='.repeat(12_000)}x`;
  assert.doesNotThrow(() => redactCommandArgv([
    'workspace', 'doctor', '--repository', deeplyKeyed
  ]));
  assert.match(redactCommandArgv([
    'workspace', 'doctor', '--repository', deeplyKeyed
  ]).at(-1), /^\[redacted-remote\]$/);

  for (const [option, remote] of [
    ['--lead-repository', 'ext::password=lead-secret'],
    ['--organisation', '//alice:organisation-secret@example.test/platform.git?token=x']
  ]) {
    const combined = redactCommandArgv(['capability', 'map', `${option}=${remote}`]);
    assert.doesNotMatch(JSON.stringify(combined), /lead-secret|organisation-secret|token=x/);
  }
  for (const controlled of [
    '//host/path\npassword=office-secret',
    '/tmp/repo\u001b]0;PWN\u0007'
  ]) {
    assert.equal(redactCommandArgv([
      'workspace', 'doctor', '--repository', controlled
    ]).at(-1), '[redacted-remote]');
  }

  for (const receiptCommand of [
    ['choices', 'answer', 'story-receipt-secret', 'choice', 'answer'],
    ['initiative', 'choices', 'status', 'initiative-receipt-secret'],
    ['epic', 'review-choice', 'answer', 'epic-receipt-secret', 'choice', 'answer']
  ]) {
    const redacted = redactCommandArgv(receiptCommand);
    assert.doesNotMatch(JSON.stringify(redacted), /receipt-secret/);
    assert.ok(redacted.includes(REDACTED));
  }

  const capability = '9ac6d4a8-3c90-4bdb-9fed-43441dc3a79f';
  for (const malformedCapabilityCommand of [
    ['choices', '--bogus', 'status', capability],
    ['approve', 'WRK-1', '--selection-receipt', '--json', capability],
    ['action', 'execute', 'plan-1', '--authorization', '--json', capability],
    ['action', 'execute', 'plan-1', '--authorization', '--json', 'arbitrary-auth-secret']
  ]) {
    const redacted = redactCommandArgv(malformedCapabilityCommand);
    assert.doesNotMatch(JSON.stringify(redacted), new RegExp(capability));
    assert.ok(redacted.includes(REDACTED));
  }
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
  const capability = '9ac6d4a8-3c90-4bdb-9fed-43441dc3a79f';
  for (const storagePath of [
    `/repo/.git/singularity-flow/choices/${capability}.json`,
    `/repo/.git/singularity-flow/action-authorizations/${capability}.json.consuming-1-local`
  ]) {
    assert.doesNotMatch(JSON.stringify(redact(new Error(`EACCES: ${storagePath}`))), new RegExp(capability));
  }
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
  assert.match(parsed[2].rawSha256, /^[a-f0-9]{64}$/);
  assert.equal(parsed[2].raw, undefined);
  assert.deepEqual(filterLogEntries(parsed, { level: 'error' }).map((entry) => entry.event), ['hook.guard.deny', 'log.unreadable']);
  assert.deepEqual(filterLogEntries(parsed, { event: 'hook' }).map((entry) => entry.event), ['hook.guard.deny']);
  assert.equal(filterLogEntries(parsed, { since: '2026-01-02T00:00:00.000Z' }).length, 2);
});

test('an unreadable legacy log line exposes only content-free evidence', () => {
  const secret = 'truncated-authorization-secret';
  const [entry] = parseLogLines(
    `{"event":"command.start","argv":["action","execute","--authorization","${secret}"`
  );
  assert.equal(entry.event, 'log.unreadable');
  assert.match(entry.rawSha256, /^[a-f0-9]{64}$/);
  assert.ok(entry.rawBytes > 0);
  assert.doesNotMatch(JSON.stringify(entry), new RegExp(secret));
});

test('legacy log reads redact command capabilities that predate write-side protection', () => {
  const legacy = parseLogLines(JSON.stringify({
    ts: '2026-01-01T00:00:00.000Z', level: 'info', event: 'command.start',
    argv: [
      'choices', 'status', 'legacy-receipt-secret',
      '--authorization', 'legacy-authorization-secret',
      '--repository=https://alice:legacy-url-secret@example.test/repo.git?signature=x'
    ]
  }));
  assert.equal(legacy[0].argv[2], REDACTED);
  assert.equal(legacy[0].argv[4], REDACTED);
  assert.doesNotMatch(JSON.stringify(legacy),
    /legacy-receipt-secret|legacy-authorization-secret|legacy-url-secret|signature=x/);
});

test('a repository without a resolvable Git directory still logs to stderr', () => {
  // Losing diagnostics is worse than having no file, so the logger degrades instead of throwing.
  const log = createLogger({ gitDirectory: null, level: 'all', consoleLevel: 'off' });
  assert.equal(log.file, null);
  assert.doesNotThrow(() => log.error('detached.error', 'no repository'));
});
