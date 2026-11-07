import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openNativeSqliteDatabase } from '../src/sda/sqlite-native.mjs';
import { createSqliteContentStore } from '../src/sda/sqlite-content-adapter.mjs';
import { contentReference, validateContentStore } from '../src/sda/content/contract.mjs';

const scope = { projectId: 'project-one' }, binding = { kind: 'shared' };
const reference = (bytes, namespace = 'evidence') => ({ namespace, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const childFile = fileURLToPath(new URL('./helpers/content-sqlite-child.mjs', import.meta.url));
async function contentChild(request) {
  const child = spawn(process.execPath, ['--no-warnings', childFile, JSON.stringify(request)], {
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, killSignal: 'SIGKILL'
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
  });
  if (result.signal) return { ...result, checkpoint: stdout.trim() };
  assert.equal(result.code, 0, stderr);
  return { ...result, result: JSON.parse(stdout) };
}
async function fixture(t, { hooks = {}, selectedBinding = binding } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-content-test-')), filename = path.join(directory, 'content.db');
  const database = await openNativeSqliteDatabase(filename), opened = [database];
  t.after(async () => { for (const connection of opened) { try { connection.close(); } catch {} } await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const port = { exec(sql) { hooks.beforeExec?.(sql); const result = database.exec(sql); hooks.afterExec?.(sql); return result; },
    prepare(sql) { const statement = database.prepare(sql); return Object.fromEntries(['get','all','run'].map(method => [method, (...args) => {
      hooks.beforeStatement?.(sql, method); const result = statement[method](...args); hooks.afterStatement?.(sql, method); return result;
    }])); } };
  const store = createSqliteContentStore({ database: port, binding: selectedBinding, create: true });
  return { database, filename, store, hooks, async reopen() { const connection = await openNativeSqliteDatabase(filename); opened.push(connection);
    return createSqliteContentStore({ database: connection, binding: selectedBinding }); } };
}

test('large immutable bytes remain separate from metadata limits and resume on another database connection', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(2_097_153, 97); bytes[65_536] = 255; bytes[bytes.length - 1] = 0;
  const write = await f.store.put(scope, 'evidence', bytes);
  assert.equal(write.reused, false); assert.deepEqual(write.reference, reference(bytes));
  const reopened = await f.reopen(), read = await reopened.read(scope, write.reference, { maximumBytes: 7 });
  assert.equal(read.status, 'present'); assert.equal(read.truncated, true); assert.deepEqual(read.data, bytes.subarray(0, 7));
  assert.deepEqual(await reopened.put(scope, 'evidence', bytes), { reference: write.reference, reused: true });
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM sflow_content_objects').get().n, 1);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM sflow_content_chunks').get().n, 33);
  assert.equal(validateContentStore(f.store), f.store);
});

test('missing, empty, project-isolated and namespace-isolated content stay distinct', async t => {
  const f = await fixture(t), empty = Buffer.alloc(0), ref = reference(empty);
  assert.deepEqual(await f.store.read(scope, ref), { status: 'missing', reference: ref, data: null });
  await f.store.put(scope, 'evidence', empty);
  const present = await f.store.read(scope, ref); assert.equal(present.status, 'present'); assert.equal(present.data.length, 0); assert.equal(present.truncated, false);
  assert.equal((await f.store.read({ projectId: 'another' }, ref)).status, 'missing');
  assert.equal((await f.store.read(scope, { ...ref, namespace: 'config' })).status, 'missing');
  await assert.rejects(f.store.read(scope, { ...ref, namespace: 'local' }), { code: 'SDA_CONTENT_UNSUPPORTED' });
});

test('caller buffers and returned prefixes cannot mutate retained bytes by alias', async t => {
  const f = await fixture(t), bytes = Buffer.from('retained');
  const pending = f.store.put(scope, 'evidence', bytes); bytes.fill(120); const written = await pending;
  const read = await f.store.read(scope, written.reference); assert.equal(read.data.toString(), 'retained'); read.data.fill(121);
  assert.equal((await f.store.read(scope, written.reference)).data.toString(), 'retained');
});

test('a zero-byte preview still verifies every retained chunk and refuses corruption beyond the preview', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(131_073, 65), { reference: ref } = await f.store.put(scope, 'evidence', bytes);
  const preview = await f.store.read(scope, ref, { maximumBytes: 0 }); assert.equal(preview.data.length, 0); assert.equal(preview.truncated, true);
  f.database.prepare('UPDATE sflow_content_chunks SET content=? WHERE chunk_index=2').run(Buffer.from([66]));
  await assert.rejects(f.store.read(scope, ref, { maximumBytes: 0 }), { code: 'SDA_CONTENT_CORRUPT' });
  await assert.rejects(f.store.put(scope, 'evidence', bytes), { code: 'SDA_CONTENT_CORRUPT' });
});

test('a deleted tail or missing chunk never becomes a missing whole object', async t => {
  const f = await fixture(t), { reference: ref } = await f.store.put(scope, 'evidence', Buffer.alloc(65_537, 1));
  f.database.exec('DELETE FROM sflow_content_chunks WHERE chunk_index=1');
  await assert.rejects(f.store.read(scope, ref), { code: 'SDA_CONTENT_CORRUPT' });
});

test('failed chunk staging rolls back metadata and all bytes with the actual original cause', async t => {
  const hooks = {}, f = await fixture(t, { hooks }), bytes = Buffer.alloc(65_537, 1), cause = Object.assign(new Error('actual storage denial'), { code: 'EACCES' });
  hooks.afterStatement = (sql, method) => { if (method === 'run' && sql.startsWith('INSERT INTO sflow_content_chunks')) throw cause; };
  await assert.rejects(f.store.put(scope, 'evidence', bytes), error => error.code === 'SDA_CONTENT_UNAVAILABLE' && error.cause === cause);
  hooks.afterStatement = null;
  assert.equal((await f.store.read(scope, reference(bytes))).status, 'missing');
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM sflow_content_chunks').get().n, 0);
});

test('lost commit acknowledgement remains unknown and is reconciled by the exact content reference', async t => {
  const hooks = {}, f = await fixture(t, { hooks }), bytes = Buffer.alloc(65_537, 17), ref = reference(bytes);
  const cause = Object.assign(new Error('commit acknowledgement timed out'), { code: 'ETIMEDOUT' });
  hooks.afterExec = sql => { if (sql === 'COMMIT') { hooks.afterExec = null; throw cause; } };
  await assert.rejects(f.store.put(scope, 'evidence', bytes), error => error.code === 'SDA_CONTENT_OUTCOME_UNKNOWN'
    && error.outcomeClass === 'OUTCOME_UNKNOWN' && error.cause === cause && error.details.reference.sha256 === ref.sha256);
  assert.equal((await f.store.read(scope, ref)).status, 'present');
  assert.equal((await f.store.put(scope, 'evidence', bytes)).reused, true);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM sflow_content_objects').get().n, 1);
});

test('cancellation before acceptance rolls back, and cancellation after confirmed commit does not undo bytes', async t => {
  const hooks = {}, f = await fixture(t, { hooks }), bytes = Buffer.alloc(65_537, 19), controller = new AbortController();
  hooks.afterStatement = (sql, method) => { if (method === 'run' && sql.startsWith('INSERT INTO sflow_content_chunks')) controller.abort(); };
  await assert.rejects(f.store.put(scope, 'evidence', bytes, { signal: controller.signal }), { code: 'SDA_CONTENT_CANCELLED' });
  hooks.afterStatement = null; assert.equal((await f.store.read(scope, reference(bytes))).status, 'missing');
  const after = new AbortController(); hooks.afterExec = sql => { if (sql === 'COMMIT') after.abort(); };
  assert.equal((await f.store.put(scope, 'evidence', bytes, { signal: after.signal })).reused, false);
  hooks.afterExec = null; assert.equal((await f.store.read(scope, reference(bytes))).status, 'present');
});

test('unsupported future manifests are read-only and never silently reinitialized', async t => {
  const f = await fixture(t), row = f.database.prepare('SELECT value FROM sflow_content_manifest').get();
  const future = JSON.stringify({ ...JSON.parse(row.value), schemaVersion: 2 });
  f.database.prepare('UPDATE sflow_content_manifest SET value=?').run(future);
  assert.throws(() => createSqliteContentStore({ database: f.database, binding, create: true }), error => error.code === 'SDA_CONTENT_UNSUPPORTED' && error.cause.code === 'SCHEMA_VERSION_FUTURE');
  assert.equal(f.database.prepare('SELECT value FROM sflow_content_manifest').get().value, future);
});

test('application tables are preserved, and owned triggers or changed schemas are refused before writes', async t => {
  const f = await fixture(t); f.database.exec("CREATE TABLE application_data(value TEXT); INSERT INTO application_data VALUES('preserve');");
  await f.store.put(scope, 'config', Buffer.from('configuration'));
  assert.equal(f.database.prepare('SELECT value FROM application_data').get().value, 'preserve');
  f.database.exec("CREATE TRIGGER unexpected_content_hook AFTER INSERT ON sflow_content_objects BEGIN UPDATE application_data SET value='changed'; END");
  await assert.rejects(f.store.put(scope, 'state', Buffer.from('state')), { code: 'SDA_CONTENT_UNSUPPORTED' });
  assert.equal(f.database.prepare('SELECT value FROM application_data').get().value, 'preserve');
});

test('an exclusive namespace journal cannot become the content database', async t => {
  const f = await fixture(t); f.database.exec('CREATE TABLE sflow_ns_meta(value TEXT)');
  assert.throws(() => createSqliteContentStore({ database: f.database, binding, create: true }), { code: 'SDA_CONTENT_UNSUPPORTED' });
});

test('unsafe durability, invalid references, closed connections and missing initialization retain explicit errors', async t => {
  const f = await fixture(t), bytes = Buffer.from('data'), ref = reference(bytes);
  for (const bad of [{ ...ref, bytes: -1 }, { ...ref, sha256: '../file' }, { ...ref, root: '/another' }]) {
    assert.throws(() => contentReference(bad));
    await assert.rejects(f.store.read(scope, bad));
  }
  f.database.exec('PRAGMA synchronous=OFF');
  await assert.rejects(f.store.put(scope, 'evidence', bytes), { code: 'SDA_CONTENT_UNSUPPORTED' });
  assert.equal(Object.values(f.database.prepare('PRAGMA synchronous').get())[0], 0);
  f.database.close();
  await assert.rejects(f.store.read(scope, ref), error => error.code === 'SDA_CONTENT_UNAVAILABLE' && error.cause?.code === 'ERR_INVALID_STATE');
});

test('a caller-owned application transaction is never rolled back by a failed nested operation', async t => {
  const f = await fixture(t); f.database.exec("CREATE TABLE application_data(value TEXT); BEGIN; INSERT INTO application_data VALUES('pending');");
  const bytes = Buffer.from('data');
  for (const invoke of [() => f.store.put(scope, 'evidence', bytes), () => f.store.read(scope, reference(bytes)),
    () => createSqliteContentStore({ database: f.database, binding, create: true })]) {
    await assert.rejects(async () => invoke(), { code: 'SDA_CONTENT_UNAVAILABLE' });
    assert.equal(f.database.prepare('SELECT value FROM application_data').get().value, 'pending');
  }
  f.database.exec('ROLLBACK'); assert.equal(f.database.prepare('SELECT count(*) AS n FROM application_data').get().n, 0);
});

for (const fault of ['before-commit', 'after-commit']) test(`a process killed ${fault} resumes one whole immutable object or no object`, async t => {
  const f = await fixture(t), bytes = Buffer.alloc(131_073, 43), ref = reference(bytes);
  const outcome = await contentChild({ filename: f.filename, scope, bytes: bytes.length, fault });
  assert.equal(outcome.signal, 'SIGKILL'); assert.equal(outcome.checkpoint, fault);
  const resumed = await f.reopen(), read = await resumed.read(scope, ref);
  const accepted = fault === 'after-commit';
  assert.equal(read.status, accepted ? 'present' : 'missing');
  if (accepted) assert.deepEqual(read.data, bytes);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM sflow_content_objects').get().n, accepted ? 1 : 0);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM sflow_content_chunks').get().n, accepted ? 3 : 0);
  assert.equal((await resumed.put(scope, 'evidence', bytes)).reused, accepted);
});

test('concurrent first processes initialize one store and accept identical large bytes once', async t => {
  const f = await fixture(t), filename = path.join(path.dirname(f.filename), 'concurrent.db'), bytes = Buffer.alloc(2_097_153, 43);
  const outcomes = await Promise.all([1, 2].map(() => contentChild({ filename, scope, bytes: bytes.length, create: true })));
  assert.deepEqual(outcomes.map(outcome => outcome.result.reused).sort(), [false, true]);
  assert.deepEqual(outcomes[0].result.reference, outcomes[1].result.reference);
  const database = await openNativeSqliteDatabase(filename);
  try {
    const store = createSqliteContentStore({ database, binding });
    assert.deepEqual((await store.read(scope, reference(bytes))).data, bytes);
    assert.equal(database.prepare('SELECT count(*) AS n FROM sflow_content_manifest').get().n, 1);
    assert.equal(database.prepare('SELECT count(*) AS n FROM sflow_content_objects').get().n, 1);
    assert.equal(database.prepare('SELECT count(*) AS n FROM sflow_content_chunks').get().n, 33);
  } finally { database.close(); }
});

test('lost initialization acknowledgement preserves the exact accepted store identity on reopen', async t => {
  const f = await fixture(t), filename = path.join(path.dirname(f.filename), 'initialize.db'), database = await openNativeSqliteDatabase(filename);
  const cause = Object.assign(new Error('initialization acknowledgement lost'), { code: 'ETIMEDOUT' });
  let observed;
  try {
    const port = { prepare: database.prepare.bind(database), exec(sql) {
      const result = database.exec(sql);
      if (sql === 'COMMIT') throw cause;
      return result;
    } };
    assert.throws(() => createSqliteContentStore({ database: port, binding, create: true }), error => {
      observed = error;
      return error.code === 'SDA_CONTENT_OUTCOME_UNKNOWN' && error.outcomeClass === 'OUTCOME_UNKNOWN' && error.cause === cause;
    });
    const accepted = database.prepare('SELECT value FROM sflow_content_manifest').get().value;
    assert.equal(JSON.parse(accepted).storeId, observed.details.storeId);
    const store = createSqliteContentStore({ database, binding });
    assert.equal((await store.put(scope, 'config', Buffer.from('retained'))).reused, false);
    assert.equal(database.prepare('SELECT value FROM sflow_content_manifest').get().value, accepted);
  } finally { database.close(); }
});
