import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplicationNamespaceStore } from '../src/sda/application-namespace-adapter.mjs';
import { createNamespaceSqliteFixture } from './helpers/namespace-sqlite-fixture.mjs';
import { putTransaction } from './helpers/namespace-conformance.mjs';

const profile = { id: 'application-adapter', qualification: 'test-only', binding: { kind: 'shared' } };
const scope = { projectId: 'project-a' };

test('application bindings reject another protocol, device, unknown options and incomplete ports before calling storage', async t => {
  const f = await createNamespaceSqliteFixture(); t.after(f.cleanup);
  let calls = 0;
  const journal = { ...f.journal, read() { calls += 1; throw new Error('must not read'); } };
  for (const port of [{ ...journal, contract: 'unversioned' }, { ...journal, append: null },
    { ...journal, manifest: { ...journal.manifest, binding: { kind: 'machine-local', deviceId: 'another' } } }]) {
    assert.throws(() => createApplicationNamespaceStore(profile, { journal: port }));
  }
  assert.throws(() => createApplicationNamespaceStore({ ...profile, root: '/another-checkout' }, { journal }));
  assert.equal(calls, 0);
});

test('a differently scoped observation is a port refusal, never a missing record or empty successful page', async t => {
  const f = await createNamespaceSqliteFixture(); t.after(f.cleanup);
  const journal = { ...f.journal, async read(...args) {
    const value = await f.journal.read(...args); return { ...value, scope: { projectId: 'another-project' } };
  } };
  const adapter = createApplicationNamespaceStore(profile, { journal });
  for (const read of [() => adapter.read(scope, 'state', 'stories/one'), () => adapter.list(scope, 'state', { limit: 1 }),
    () => adapter.inspectOperation(scope, 'one')]) {
    await assert.rejects(read(), error => error.code === 'SDA_NAMESPACE_UNSUPPORTED' && error.details.stage === 'journal-observation');
  }
});

test('an invalid receipt after real acceptance is unknown and recoverable through the original operation', async t => {
  const f = await createNamespaceSqliteFixture(); t.after(f.cleanup);
  let substitute = true;
  const journal = { ...f.journal, async append(...args) {
    const result = await f.journal.append(...args);
    if (result.accepted && substitute) {
      substitute = false; return { ...result, receipt: { ...result.receipt, scope: { projectId: 'other' } } };
    }
    return result;
  } };
  const adapter = createApplicationNamespaceStore(profile, { journal });
  const transaction = putTransaction('retained', 'stories/one', { value: 'accepted' });
  await assert.rejects(adapter.transact(scope, transaction), error => error.code === 'SDA_NAMESPACE_OUTCOME_UNKNOWN'
    && error.details.operationId === 'retained' && error.details.stage === 'journal-receipt');
  const inspected = await adapter.inspectOperation(scope, 'retained');
  assert.equal(inspected.status, 'committed');
  const replay = await adapter.transact(scope, transaction);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, inspected.receipt);
  assert.equal((await f.controls.events(scope)).length, 1);
});

test('real application errors preserve identity, native cause and stage without being retried', async t => {
  const f = await createNamespaceSqliteFixture(); t.after(f.cleanup);
  const cause = Object.assign(new Error('application deadline elapsed'), { code: 'ETIMEDOUT' });
  const failure = Object.freeze(Object.assign(new Error('application store unavailable', { cause }), {
    code: 'APPLICATION_DATABASE_UNAVAILABLE', details: Object.freeze({ stage: 'database-query', timedOut: true })
  }));
  let calls = 0;
  const adapter = createApplicationNamespaceStore(profile, { journal: { ...f.journal, read() { calls += 1; throw failure; } } });
  await assert.rejects(adapter.read(scope, 'state', 'stories/one'), error => error === failure && error.cause === cause);
  assert.equal(calls, 1);
});

test('invalid application values and mismatched namespace-map keys cannot become successful JSON or empty listings', async t => {
  const f = await createNamespaceSqliteFixture(); t.after(f.cleanup);
  await f.adapter.transact(scope, putTransaction('seed', 'stories/one', { value: 1 }));
  for (const kind of ['date-value', 'namespace-map']) {
    const journal = { ...f.journal, async read(...args) {
      const view = await f.journal.read(...args), [key, record] = [...view.state.records][0];
      view.state.records.set(key, kind === 'date-value' ? { ...record, value: new Date(0) }
        : { ...record, namespace: 'config' });
      return view;
    } };
    const adapter = createApplicationNamespaceStore(profile, { journal });
    for (const invoke of [() => adapter.read(scope, 'state', 'stories/one'), () => adapter.list(scope, 'state', { limit: 1 })]) {
      await assert.rejects(invoke(), { code: 'SDA_NAMESPACE_UNSUPPORTED' });
    }
  }
  assert.deepEqual((await f.adapter.read(scope, 'state', 'stories/one')).record.value, { value: 1 });
});
