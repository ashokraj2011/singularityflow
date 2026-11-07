import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir, rename, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createFilesystemNamespaceStore } from '../src/sda/filesystem-namespace-adapter.mjs';
import { putTransaction } from './helpers/namespace-conformance.mjs';

const scope = { projectId: 'durability-project' };
const binding = { kind: 'shared' };
const childFile = fileURLToPath(new URL('./helpers/namespace-filesystem-child.mjs', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture(t, options = {}) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-namespace-durable-'));
  t.after(() => rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = path.join(parent, 'store');
  const adapter = await createFilesystemNamespaceStore({ root, binding, create: true, ...options });
  const commits = path.join(root, `project-${hash(JSON.stringify(scope))}`, 'commits');
  return { parent, root, adapter, commits,
    reopen: () => createFilesystemNamespaceStore({ root, binding, ...options }) };
}

async function child(request, { env = process.env } = {}) {
  const processChild = spawn(process.execPath, ['--experimental-test-module-mocks', '--no-warnings', childFile, JSON.stringify(request)], {
    env, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '', stderr = '';
  processChild.stdout.on('data', chunk => { stdout += chunk; });
  processChild.stderr.on('data', chunk => { stderr += chunk; });
  const { code, signal } = await new Promise((resolve, reject) => {
    processChild.once('error', reject);
    processChild.once('close', (code, signal) => resolve({ code, signal }));
  });
  if (signal) return { code, signal, stderr };
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout);
}

test('a process killed before the link leaves no accepted record, event or receipt, and retry resumes', async t => {
  const f = await fixture(t), transaction = putTransaction('before-crash', 'stories/one', 'retained');
  const crashed = await child({ root: f.root, scope, transaction, fault: 'before-link' });
  assert.equal(crashed.signal, 'SIGKILL');
  const resumed = await f.reopen();
  assert.deepEqual(await resumed.read(scope, 'state', 'stories/one'), { status: 'missing', record: null });
  assert.deepEqual(await resumed.inspectOperation(scope, transaction.operationId), { status: 'missing', receipt: null });
  const result = await resumed.transact(scope, transaction);
  assert.equal(result.replayed, false);
  assert.equal((await readdir(f.commits)).length, 1);
  assert.deepEqual(await resumed.verify(scope), { valid: true, errors: [] });
});

test('filesystem storage executes in an independent process without Git or any programs on PATH', async t => {
  const f = await fixture(t), transaction = putTransaction('no-git', 'stories/one', 1);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  env.PATH = '';
  const result = await child({ root: f.root, scope, transaction }, { env });
  assert.equal(result.ok, true);
  assert.equal(result.result.status, 'committed');
  assert.equal((await f.adapter.inspectOperation(scope, 'no-git')).status, 'committed');
});

test('a process killed after the link retains one atomic transaction and the original receipt on retry', async t => {
  const f = await fixture(t), transaction = putTransaction('after-crash', 'stories/one', 'accepted');
  assert.equal((await child({ root: f.root, scope, transaction, fault: 'after-link' })).signal, 'SIGKILL');
  const resumed = await f.reopen();
  const inspected = await resumed.inspectOperation(scope, transaction.operationId);
  assert.equal(inspected.status, 'committed');
  const replay = await resumed.transact(scope, transaction);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.receipt, inspected.receipt);
  assert.equal((await resumed.read(scope, 'state', 'stories/one')).record.value, 'accepted');
  assert.equal((await readdir(f.commits)).length, 1);
});

test('a failed directory flush after acceptance is unknown, preserves EIO, and is reconciled by operation ID', async t => {
  const f = await fixture(t), transaction = putTransaction('flush-failure', 'stories/one', 'accepted');
  const unknown = await child({ root: f.root, scope, transaction, fault: 'directory-sync' });
  assert.deepEqual(unknown, { ok: false, code: 'SDA_NAMESPACE_OUTCOME_UNKNOWN', causeCode: 'EIO',
    details: { operationId: 'flush-failure', stage: 'durability', timedOut: false } });
  const resumed = await f.reopen();
  const inspected = await resumed.inspectOperation(scope, transaction.operationId);
  assert.equal(inspected.status, 'committed');
  assert.deepEqual((await resumed.transact(scope, transaction)).receipt, inspected.receipt);
  assert.equal((await readdir(f.commits)).length, 1);
});

test('a lost link acknowledgement is unknown while a definite permission refusal accepts nothing', async t => {
  for (const fault of ['lost-link-response', 'refused-link']) {
    await t.test(fault, async t => {
      const f = await fixture(t), transaction = putTransaction('link-result', 'stories/one', 1);
      const result = await child({ root: f.root, scope, transaction, fault });
      const uncertain = fault === 'lost-link-response';
      assert.equal(result.code, uncertain ? 'SDA_NAMESPACE_OUTCOME_UNKNOWN' : 'SDA_NAMESPACE_UNAVAILABLE');
      assert.equal(result.causeCode, uncertain ? 'ETIMEDOUT' : 'EACCES');
      assert.equal(result.details.stage, uncertain ? 'publication' : 'journal-commit');
      const resumed = await f.reopen();
      assert.equal((await resumed.inspectOperation(scope, transaction.operationId)).status, uncertain ? 'committed' : 'missing');
      assert.equal((await resumed.transact(scope, transaction)).replayed, uncertain);
      assert.equal((await readdir(f.commits)).length, 1);
    });
  }
});

test('independent processes cannot both extend a stale revision or overwrite the winning slot', async t => {
  const f = await fixture(t);
  await f.adapter.transact(scope, putTransaction('seed', 'stories/one', 0));
  const version = (await f.adapter.read(scope, 'state', 'stories/one')).record.version;
  const results = await Promise.all([1, 2].map(value => child({ root: f.root, scope,
    transaction: putTransaction(`writer-${value}`, 'stories/one', value, { version }) })));
  assert.equal(results.filter(value => value.ok).length, 1);
  assert.equal(results.find(value => !value.ok).code, 'SDA_NAMESPACE_REVISION_CONFLICT');
  assert.equal((await readdir(f.commits)).length, 2);
  assert.deepEqual(await f.adapter.verify(scope), { valid: true, errors: [] });
});

test('independent first writers initialize a project atomically and retain every nonconflicting operation', async t => {
  const f = await fixture(t);
  const results = await Promise.all([1, 2, 3, 4].map(value => child({ root: f.root, scope,
    transaction: putTransaction(`initial-${value}`, `stories/${value}`, value) })));
  assert.equal(results.filter(value => value.ok).length, 4, JSON.stringify(results));
  assert.equal((await readdir(f.commits)).length, 4);
  for (const value of [1, 2, 3, 4]) assert.equal((await f.adapter.read(scope, 'state', `stories/${value}`)).record.value, value);
  assert.deepEqual(await f.adapter.verify(scope), { valid: true, errors: [] });
});

test('concurrent explicit store creation publishes one immutable identity and a reusable cursor key', async t => {
  const f = await fixture(t), root = path.join(f.parent, 'concurrently-created');
  const handles = await Promise.all([1, 2, 3, 4].map(() => createFilesystemNamespaceStore({ root, binding, create: true })));
  const before = await readFile(path.join(root, 'store.json'), 'utf8');
  await handles[0].transact(scope, putTransaction('first', 'stories/a', 1));
  await handles[1].transact(scope, putTransaction('second', 'stories/b', 2));
  const page = await handles[2].list(scope, 'state', { limit: 1 });
  const next = await handles[3].list(scope, 'state', { limit: 1, continuation: page.continuation });
  assert.equal(next.snapshot, page.snapshot);
  assert.equal(next.entries[0].value, 2);
  assert.equal(await readFile(path.join(root, 'store.json'), 'utf8'), before);
});

test('truncated, missing and symlink journal entries fail explicitly instead of yielding partial or empty data', async t => {
  for (const kind of ['truncated', 'gap', 'symlink']) {
    await t.test(kind, async t => {
      const f = await fixture(t);
      for (const value of [1, 2]) await f.adapter.transact(scope, putTransaction(`seed-${value}`, `stories/${value}`, value));
      const file = path.join(f.commits, '00000000000000000001.json');
      if (kind === 'truncated') await writeFile(file, '{"body":');
      if (kind === 'gap') await rm(file);
      if (kind === 'symlink') {
        const copy = path.join(f.parent, 'entry-copy.json');
        await rename(file, copy); await symlink(copy, file);
      }
      assert.equal((await f.adapter.verify(scope)).valid, false);
      await assert.rejects(f.adapter.read(scope, 'state', 'stories/one'), { code: 'SDA_NAMESPACE_CORRUPT' });
      await assert.rejects(f.adapter.inspectOperation(scope, 'seed-1'), { code: 'SDA_NAMESPACE_CORRUPT' });
    });
  }
});

test('real read-access errors retain their native cause and missing store identity is unavailable', async t => {
  const f = await fixture(t);
  await f.adapter.transact(scope, putTransaction('seed', 'stories/one', 1));
  const refused = await child({ root: f.root, scope, read: 'stories/one', fault: 'deny-read' });
  assert.equal(refused.code, 'SDA_NAMESPACE_UNAVAILABLE');
  assert.equal(refused.causeCode, 'EACCES');
  assert.equal(refused.details.stage, 'journal-read');
  await rename(path.join(f.root, 'store.json'), path.join(f.root, 'store.kept'));
  await assert.rejects(f.adapter.read(scope, 'state', 'stories/one'), error =>
    error.code === 'SDA_NAMESPACE_UNAVAILABLE' && error.cause.code === 'ENOENT');
  await assert.rejects(f.adapter.verify(scope), { code: 'SDA_NAMESPACE_UNAVAILABLE' });
});

test('initialization and reopen refuse unrelated files, different device bindings and incompatible storage bounds', async t => {
  const f = await fixture(t);
  const other = path.join(f.parent, 'application');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(other); await writeFile(path.join(other, 'source.js'), 'application bytes');
  await assert.rejects(createFilesystemNamespaceStore({ root: other, binding, create: true }), { code: 'SDA_NAMESPACE_INPUT_INVALID' });
  assert.equal(await readFile(path.join(other, 'source.js'), 'utf8'), 'application bytes');
  assert.deepEqual(await readdir(other), ['source.js']);
  await assert.rejects(createFilesystemNamespaceStore({ root: f.root, binding: { kind: 'machine-local', deviceId: 'other' } }),
    { code: 'SDA_NAMESPACE_INPUT_INVALID' });
  await assert.rejects(createFilesystemNamespaceStore({ root: f.root, binding, limits: { maxValueBytes: 32 } }),
    { code: 'SDA_NAMESPACE_INPUT_INVALID' });
  const before = await readFile(path.join(f.root, 'store.json'), 'utf8');
  await createFilesystemNamespaceStore({ root: f.root, binding, limits: { maxPage: 1 } });
  assert.equal(await readFile(path.join(f.root, 'store.json'), 'utf8'), before);
});

test('portable logical key spellings are values, never physical filenames', async t => {
  const f = await fixture(t);
  for (const [index, key] of ['stories/CON', 'stories/NUL', 'stories/a', 'stories/A'].entries()) {
    await f.adapter.transact(scope, putTransaction(`portable-${index}`, key, key));
    assert.equal((await f.adapter.read(scope, 'state', key)).record.value, key);
  }
  assert.deepEqual((await readdir(f.commits)).sort(), [1, 2, 3, 4].map(value => `${String(value).padStart(20, '0')}.json`));
});

test('a future durable format reports upgrade-required compatibility without rewriting or treating it as missing', async t => {
  for (const kind of ['manifest', 'entry']) {
    await t.test(kind, async t => {
      const f = await fixture(t);
      await f.adapter.transact(scope, putTransaction('seed', 'stories/one', 1));
      const file = kind === 'manifest' ? path.join(f.root, 'store.json') : path.join(f.commits, '00000000000000000001.json');
      const value = JSON.parse(await readFile(file, 'utf8'));
      if (kind === 'manifest') value.schemaVersion = 2;
      else { value.body.schemaVersion = 2; value.sha256 = hash(JSON.stringify(value.body)); }
      const bytes = JSON.stringify(value) + '\n';
      await writeFile(file, bytes);
      await assert.rejects(f.adapter.read(scope, 'state', 'stories/one'), error =>
        error.code === 'SDA_NAMESPACE_UNSUPPORTED' && error.cause.code === 'SCHEMA_VERSION_FUTURE');
      await assert.rejects(f.adapter.transact(scope, putTransaction('after-upgrade', 'stories/two', 2)),
        { code: 'SDA_NAMESPACE_UNSUPPORTED' });
      assert.equal(await readFile(file, 'utf8'), bytes);
    });
  }
});
