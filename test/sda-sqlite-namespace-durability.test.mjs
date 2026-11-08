import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rename, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteNamespaceStore } from '../src/sda/sqlite-namespace-adapter.mjs';
import { putTransaction } from './helpers/namespace-conformance.mjs';

const binding = { kind: 'shared' }, scope = { projectId: 'native-project' };
const childFile = fileURLToPath(new URL('./helpers/namespace-sqlite-child.mjs', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const scopeKey = hash(JSON.stringify(scope));

async function fixture(t, options = {}) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-sqlite-native-'));
  const filename = path.join(parent, 'state.sqlite'), connections = [];
  t.after(async () => { for (const close of connections) close(); await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const adapter = await createSqliteNamespaceStore({ filename, binding, create: true, ...options });
  connections.push(() => adapter.close());
  return { parent, filename, adapter, async reopen() {
    const next = await createSqliteNamespaceStore({ filename, binding, ...options }); connections.push(() => next.close()); return next;
  }, inspect(action) { const db = new DatabaseSync(filename); try { return action(db); } finally { db.close(); } } };
}

async function child(request, { env = process.env } = {}) {
  const processChild = spawn(process.execPath, ['--experimental-test-module-mocks', '--no-warnings', childFile, JSON.stringify(request)], {
    env, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '', stderr = '';
  processChild.stdout.on('data', chunk => { stdout += chunk; }); processChild.stderr.on('data', chunk => { stderr += chunk; });
  const result = await new Promise((resolve, reject) => { processChild.once('error', reject); processChild.once('close', (code, signal) => resolve({ code, signal })); });
  if (result.signal) return { ...result, stderr };
  assert.equal(result.code, 0, stderr);
  return JSON.parse(stdout);
}

test('a process killed before SQL COMMIT leaves no record, head, event or receipt and retry succeeds', async t => {
  const f = await fixture(t), transaction = putTransaction('before', 'stories/one', 1);
  assert.equal((await child({ filename: f.filename, scope, transaction, fault: 'before-commit' })).signal, 'SIGKILL');
  const resumed = await f.reopen();
  assert.equal((await resumed.read(scope, 'state', 'stories/one')).status, 'missing');
  assert.equal((await resumed.inspectOperation(scope, 'before')).status, 'missing');
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) AS n FROM sflow_ns_heads').get().n), 0);
  assert.equal((await resumed.transact(scope, transaction)).replayed, false);
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) AS n FROM sflow_ns_entries').get().n), 1);
});

test('a process killed after SQL COMMIT resumes one accepted transaction with the original receipt', async t => {
  const f = await fixture(t), transaction = putTransaction('after', 'stories/one', 1);
  assert.equal((await child({ filename: f.filename, scope, transaction, fault: 'after-commit' })).signal, 'SIGKILL');
  const resumed = await f.reopen(), inspected = await resumed.inspectOperation(scope, 'after');
  assert.equal(inspected.status, 'committed');
  const replay = await resumed.transact(scope, transaction);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, inspected.receipt);
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) AS n FROM sflow_ns_entries').get().n), 1);
  assert.deepEqual(await resumed.verify(scope), { valid: true, errors: [] });
});

test('a lost acknowledgement after real COMMIT is unknown while a definite refused write leaves no accepted effect', async t => {
  for (const fault of ['lost-response', 'refused-write']) await t.test(fault, async t => {
    const f = await fixture(t), transaction = putTransaction('result', 'stories/one', 1);
    const result = await child({ filename: f.filename, scope, transaction, fault });
    const uncertain = fault === 'lost-response';
    assert.equal(result.code, uncertain ? 'SDA_NAMESPACE_OUTCOME_UNKNOWN' : 'SDA_NAMESPACE_UNAVAILABLE');
    assert.equal(result.causeCode, uncertain ? 'ETIMEDOUT' : 'EACCES');
    assert.equal(result.details.stage, 'database-commit');
    const resumed = await f.reopen();
    assert.equal((await resumed.inspectOperation(scope, 'result')).status, uncertain ? 'committed' : 'missing');
    assert.equal((await resumed.transact(scope, transaction)).replayed, uncertain);
    assert.equal(f.inspect(db => db.prepare('SELECT count(*) AS n FROM sflow_ns_entries').get().n), 1);
  });
});

test('independent processes cannot both extend the same revision', async t => {
  const f = await fixture(t);
  await f.adapter.transact(scope, putTransaction('seed', 'stories/one', 0));
  const version = (await f.adapter.read(scope, 'state', 'stories/one')).record.version;
  const results = await Promise.all([1, 2].map(value => child({ filename: f.filename, scope,
    transaction: putTransaction(`writer-${value}`, 'stories/one', value, { version }) })));
  assert.equal(results.filter(value => value.ok).length, 1, JSON.stringify(results));
  assert.equal(results.find(value => !value.ok).code, 'SDA_NAMESPACE_REVISION_CONFLICT');
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) AS n FROM sflow_ns_entries').get().n), 2);
  assert.deepEqual(await f.adapter.verify(scope), { valid: true, errors: [] });
});

test('independent first workers initialize one database and retain all nonconflicting transactions', async t => {
  const f = await fixture(t), filename = path.join(f.parent, 'initialization.sqlite');
  const results = await Promise.all([1, 2, 3, 4].map(value => child({ filename, scope, create: true,
    transaction: putTransaction(`initial-${value}`, `stories/${value}`, value) })));
  assert.equal(results.filter(value => value.ok).length, 4, JSON.stringify(results));
  const resumed = await createSqliteNamespaceStore({ filename, binding });
  try {
    assert.deepEqual(await resumed.verify(scope), { valid: true, errors: [] });
    for (const value of [1, 2, 3, 4]) assert.equal((await resumed.read(scope, 'state', `stories/${value}`)).record.value, value);
  } finally { resumed.close(); }
});

test('a transient BUSY during mode negotiation reopens one store identity before any application write', async t => {
  const f = await fixture(t), transaction = putTransaction('open-retry', 'stories/one', 1);
  const result = await child({ filename: f.filename, scope, transaction, fault: 'open-busy-once' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.openAttempts, 2); assert.equal(result.openBusyCalls, 2); assert.equal(result.openStoreIds.length, 1);
  const resumed = await f.reopen(), accepted = await resumed.inspectOperation(scope, transaction.operationId);
  assert.deepEqual(accepted.receipt, result.result.receipt);
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) AS n FROM sflow_ns_entries').get().n), 1);
});

test('opening retry exhaustion preserves SQLITE_BUSY and cannot record the application transaction', async t => {
  const f = await fixture(t), transaction = putTransaction('open-exhausted', 'stories/one', 1);
  const result = await child({ filename: f.filename, scope, transaction, fault: 'open-busy-always', busyTimeoutMs: 30 });
  assert.equal(result.ok, false); assert.equal(result.code, 'SDA_NAMESPACE_UNAVAILABLE');
  assert.equal(result.causeCode, 'ERR_SQLITE_ERROR'); assert.equal(result.sqliteCode, 5); assert.equal(result.details.stage, 'database-open');
  assert.equal(result.openStoreIds.length, 1);
  assert.equal((await f.adapter.inspectOperation(scope, transaction.operationId)).status, 'missing');
  assert.equal((await f.adapter.transact(scope, transaction)).replayed, false);
});

test('opening retries cannot mask permission failures or turn them into contention', async t => {
  const f = await fixture(t), transaction = putTransaction('open-denied', 'stories/one', 1);
  const result = await child({ filename: f.filename, scope, transaction, fault: 'open-denied' });
  assert.equal(result.ok, false); assert.equal(result.code, 'SDA_NAMESPACE_UNAVAILABLE');
  assert.equal(result.causeCode, 'EACCES'); assert.equal(result.openAttempts, 1);
  assert.equal((await f.adapter.inspectOperation(scope, transaction.operationId)).status, 'missing');
});

test('a bounded real database lock preserves SQLITE_BUSY and permits the same operation after release', async t => {
  const f = await fixture(t, { busyTimeoutMs: 25 });
  const holder = spawn(process.execPath, [childFile, JSON.stringify({ filename: f.filename, hold: true })], { stdio: ['pipe', 'pipe', 'pipe'] });
  const completion = new Promise((resolve, reject) => { holder.once('error', reject); holder.once('close', code => resolve(code)); });
  try {
    await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('error', reject); holder.once('exit', () => reject(new Error('holder exited before readiness'))); });
    const transaction = putTransaction('locked', 'stories/one', 1);
    await assert.rejects(f.adapter.transact(scope, transaction), error => error.code === 'SDA_NAMESPACE_UNAVAILABLE'
      && (error.cause.errcode & 255) === 5 && error.details.stage === 'database-commit');
    holder.stdin.end('release'); assert.equal(await completion, 0);
    assert.equal((await f.adapter.inspectOperation(scope, 'locked')).status, 'missing');
    assert.equal((await f.adapter.transact(scope, transaction)).replayed, false);
  } finally { holder.stdin.end(); await completion; }
});

test('truncated accepted history, malformed JSON and changed bytes are corrupt rather than missing', async t => {
  for (const fault of ['delete-tail', 'delete-all', 'invalid-json', 'changed-bytes']) await t.test(fault, async t => {
    const f = await fixture(t);
    for (const value of [1, 2]) await f.adapter.transact(scope, putTransaction(`seed-${value}`, `stories/${value}`, value));
    f.inspect(db => {
      if (fault === 'delete-tail') db.prepare('DELETE FROM sflow_ns_entries WHERE scope_key = ? AND seq = 2').run(scopeKey);
      if (fault === 'delete-all') db.prepare('DELETE FROM sflow_ns_entries WHERE scope_key = ?').run(scopeKey);
      if (fault === 'invalid-json') db.prepare('UPDATE sflow_ns_entries SET body = ? WHERE scope_key = ? AND seq = 1').run('{', scopeKey);
      if (fault === 'changed-bytes') db.prepare('UPDATE sflow_ns_entries SET sha256 = ? WHERE scope_key = ? AND seq = 1').run('0'.repeat(64), scopeKey);
    });
    assert.equal((await f.adapter.verify(scope)).valid, false);
    await assert.rejects(f.adapter.read(scope, 'state', 'stories/1'), { code: 'SDA_NAMESPACE_CORRUPT' });
    await assert.rejects(f.adapter.inspectOperation(scope, 'seed-1'), { code: 'SDA_NAMESPACE_CORRUPT' });
  });
});

test('future manifest and entry versions retain upgrade diagnostics and are never rewritten', async t => {
  for (const kind of ['manifest', 'entry']) await t.test(kind, async t => {
    const f = await fixture(t);
    await f.adapter.transact(scope, putTransaction('seed', 'stories/one', 1));
    const expected = f.inspect(db => {
      const row = db.prepare(kind === 'manifest' ? 'SELECT body FROM sflow_ns_meta WHERE slot = 1'
        : 'SELECT body FROM sflow_ns_entries WHERE seq = 1 AND scope_key = ?').get(...(kind === 'manifest' ? [] : [scopeKey]));
      const value = JSON.parse(row.body); value.schemaVersion = 2; const bytes = JSON.stringify(value);
      if (kind === 'manifest') db.prepare('UPDATE sflow_ns_meta SET body = ? WHERE slot = 1').run(bytes);
      else {
        db.prepare('UPDATE sflow_ns_entries SET body = ?, sha256 = ? WHERE scope_key = ? AND seq = 1').run(bytes, hash(bytes), scopeKey);
        db.prepare('UPDATE sflow_ns_heads SET sha256 = ? WHERE scope_key = ?').run(hash(bytes), scopeKey);
      }
      return bytes;
    });
    await assert.rejects(f.adapter.read(scope, 'state', 'stories/one'), error => error.code === 'SDA_NAMESPACE_UNSUPPORTED'
      && error.cause.code === 'SCHEMA_VERSION_FUTURE');
    const actual = f.inspect(db => db.prepare(kind === 'manifest' ? 'SELECT body FROM sflow_ns_meta WHERE slot = 1'
      : 'SELECT body FROM sflow_ns_entries WHERE seq = 1 AND scope_key = ?').get(...(kind === 'manifest' ? [] : [scopeKey])).body);
    assert.equal(actual, expected);
  });
});

test('missing, unrelated and symlink database bindings are refused without replacing user data', async t => {
  const f = await fixture(t), missing = path.join(f.parent, 'missing.sqlite');
  await assert.rejects(createSqliteNamespaceStore({ filename: missing, binding }), error => error.code === 'SDA_NAMESPACE_UNAVAILABLE'
    && error.cause.code === 'ENOENT');
  const incomplete = path.join(f.parent, 'incomplete.sqlite'); await writeFile(incomplete, '');
  await assert.rejects(createSqliteNamespaceStore({ filename: incomplete, binding }), error => error.code === 'SDA_NAMESPACE_UNAVAILABLE'
    && error.details.stage === 'database-initialization');
  const completed = await createSqliteNamespaceStore({ filename: incomplete, binding, create: true });
  try { assert.equal((await completed.read(scope, 'state', 'stories/one')).status, 'missing'); } finally { completed.close(); }
  const file = path.join(f.parent, 'application.txt'); await writeFile(file, 'original user data');
  await assert.rejects(createSqliteNamespaceStore({ filename: file, binding, create: true }));
  assert.equal(await readFile(file, 'utf8'), 'original user data');
  const databaseFile = path.join(f.parent, 'application.sqlite'), db = new DatabaseSync(databaseFile);
  db.exec("CREATE TABLE application_data (value TEXT); INSERT INTO application_data VALUES ('preserved');"); db.close();
  const before = await readFile(databaseFile);
  await assert.rejects(createSqliteNamespaceStore({ filename: databaseFile, binding, create: true }), { code: 'SDA_NAMESPACE_CORRUPT' });
  assert.deepEqual(await readFile(databaseFile), before);
  const linked = path.join(f.parent, 'linked.sqlite'); await symlink(f.filename, linked);
  await assert.rejects(createSqliteNamespaceStore({ filename: linked, binding }), { code: 'SDA_NAMESPACE_INPUT_INVALID' });
});

test('moving or closing an active database never turns accepted work into an empty successful read', async t => {
  const f = await fixture(t);
  await f.adapter.transact(scope, putTransaction('seed', 'stories/one', 1));
  f.adapter.close();
  await assert.rejects(f.adapter.read(scope, 'state', 'stories/one'), { code: 'SDA_NAMESPACE_UNAVAILABLE' });
  const resumed = await f.reopen();
  assert.equal((await resumed.read(scope, 'state', 'stories/one')).record.value, 1);
  await rename(f.filename, f.filename + '.kept');
  await assert.rejects(resumed.read(scope, 'state', 'stories/one'), error => error.code === 'SDA_NAMESPACE_UNAVAILABLE'
    && error.cause.code === 'ENOENT');
});

test('database storage executes in a separate process with no Git or other programs on PATH', async t => {
  const f = await fixture(t), env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key]; env.PATH = '';
  const result = await child({ filename: f.filename, scope, transaction: putTransaction('no-git', 'stories/one', 1) }, { env });
  assert.equal(result.ok, true); assert.equal((await f.adapter.inspectOperation(scope, 'no-git')).status, 'committed');
});
