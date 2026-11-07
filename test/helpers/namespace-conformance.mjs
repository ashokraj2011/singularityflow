/**
 * Reusable namespace-store conformance. A fixture supplies adapter, cleanup, and controls for fault
 * injection, another binding, retained-event/receipt inspection, corruption and snapshot expiry.
 * Future adapters run this same suite; controls model backend failures, not production API methods.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { namespaceError, namespaceStoreOutcome, validateNamespaceStore } from '../../src/sda/namespace/index.mjs';

const A = Object.freeze({ projectId: 'project-a' });
const B = Object.freeze({ projectId: 'project-b' });
const refused = expected => error => {
  assert.equal(namespaceStoreOutcome(error), expected, `${error.code}: ${error.message}`);
  return true;
};

export function putTransaction(operationId, key, value, { namespace = 'state', version = null, immutable = false } = {}) {
  return { operationId, preconditions: [{ namespace, key, version }],
    changes: [{ op: 'put', namespace, key, value, immutable }],
    events: [{ eventId: `event-${operationId}`, eventType: 'record.changed', namespace, payload: { key } }] };
}

export function namespaceStoreConformance(label, createFixture) {
  const run = (name, body) => test(`${label}: ${name}`, async t => {
    const fixture = await createFixture();
    t.after(() => fixture.cleanup());
    validateNamespaceStore(fixture.adapter);
    await body(fixture);
  });
  const read = async (adapter, key, scope = A, namespace = 'state') => (await adapter.read(scope, namespace, key)).record;
  const count = async (controls, scope = A) => [(await controls.events(scope)).length, (await controls.receipts(scope)).length];

  run('missing data is explicit, while a stored null is present', async ({ adapter, controls }) => {
    assert.deepEqual(await adapter.read(A, 'state', 'stories/one'), { status: 'missing', record: null });
    assert.deepEqual(await adapter.inspectOperation(A, 'create'), { status: 'missing', receipt: null });
    await adapter.transact(A, putTransaction('create', 'stories/one', null));
    const found = await adapter.read(A, 'state', 'stories/one');
    assert.equal(found.status, 'present');
    assert.equal(found.record.value, null);
    assert.equal(typeof found.record.version, 'string');
    assert.deepEqual(await count(controls), [1, 1]);
  });

  run('projects and namespaces isolate keys and operation IDs', async ({ adapter }) => {
    await adapter.transact(A, putTransaction('same-operation', 'same/key', 'A-state'));
    await adapter.transact(B, putTransaction('same-operation', 'same/key', 'B-state'));
    await adapter.transact(A, putTransaction('configuration', 'same/key', 'A-config', { namespace: 'config' }));
    assert.equal((await read(adapter, 'same/key')).value, 'A-state');
    assert.equal((await read(adapter, 'same/key', B)).value, 'B-state');
    assert.equal((await read(adapter, 'same/key', A, 'config')).value, 'A-config');
    assert.deepEqual(await adapter.inspectOperation(B, 'configuration'), { status: 'missing', receipt: null });
  });

  run('an explicit absent precondition cannot overwrite an existing record', async ({ adapter, controls }) => {
    await adapter.transact(A, putTransaction('create', 'stories/one', { generation: 1 }));
    const before = await read(adapter, 'stories/one');
    await assert.rejects(adapter.transact(A, putTransaction('stale-create', 'stories/one', { generation: 2 })), refused('REVISION_CONFLICT'));
    assert.deepEqual(await read(adapter, 'stories/one'), before);
    assert.deepEqual(await count(controls), [1, 1]);
  });

  run('malformed transactions fail before changing any records, events or receipts', async ({ adapter, controls }) => {
    const transaction = putTransaction('invalid', 'stories/one', 'must-not-land');
    for (const input of [
      { ...transaction, preconditions: [] },
      { ...transaction, preconditions: [{ namespace: 'state', key: 'stories/one' }] },
      { ...transaction, force: true },
      { ...transaction, changes: [...transaction.changes, ...transaction.changes] }
    ]) await assert.rejects(adapter.transact(A, input), refused('invalid'));
    assert.equal(await read(adapter, 'stories/one'), null);
    assert.equal((await adapter.inspectOperation(A, 'invalid')).status, 'missing');
    assert.deepEqual(await count(controls), [0, 0]);
  });

  run('only one concurrent writer can extend the same opaque revision', async ({ adapter, controls }) => {
    await adapter.transact(A, putTransaction('create', 'stories/one', 0));
    const { version } = await read(adapter, 'stories/one');
    const results = await Promise.allSettled([1, 2].map(value => adapter.transact(A,
      putTransaction(`writer-${value}`, 'stories/one', value, { version }))));
    assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
    refused('REVISION_CONFLICT')(results.find(value => value.status === 'rejected').reason);
    assert.ok([1, 2].includes((await read(adapter, 'stories/one')).value));
    assert.deepEqual(await count(controls), [2, 2]);
  });

  run('a stale read dependency aborts the whole record/event/receipt transaction', async ({ adapter, controls }) => {
    await adapter.transact(A, putTransaction('config-1', 'approved', 1, { namespace: 'config' }));
    const { version } = await read(adapter, 'approved', A, 'config');
    await adapter.transact(A, putTransaction('config-2', 'approved', 2, { namespace: 'config', version }));
    const transaction = putTransaction('dependent', 'stories/one', 'must-not-land');
    transaction.preconditions.push({ namespace: 'config', key: 'approved', version });
    transaction.preconditions.push({ namespace: 'state', key: 'stories/two', version: null });
    transaction.changes.push({ op: 'put', namespace: 'state', key: 'stories/two', value: 'also-refused', immutable: false });
    await assert.rejects(adapter.transact(A, transaction), refused('REVISION_CONFLICT'));
    assert.equal(await read(adapter, 'stories/one'), null);
    assert.equal(await read(adapter, 'stories/two'), null);
    assert.equal((await adapter.inspectOperation(A, 'dependent')).status, 'missing');
    assert.deepEqual(await count(controls), [2, 2]);
  });

  run('retries compare intent and return the same receipt without duplicate events', async ({ adapter, controls }) => {
    const transaction = putTransaction('idempotent', 'stories/one', { b: 2, a: 1 });
    const first = await adapter.transact(A, transaction);
    const reordered = putTransaction('idempotent', 'stories/one', { a: 1, b: 2 });
    const again = await adapter.transact(A, reordered);
    assert.equal(again.replayed, true);
    assert.deepEqual(again.receipt, first.receipt);
    await assert.rejects(adapter.transact(A, putTransaction('idempotent', 'stories/one', { a: 9 })), refused('OPERATION_ID_REUSE'));
    assert.deepEqual(await count(controls), [1, 1]);
  });

  run('replaying an old operation never rolls a newer record back', async ({ adapter }) => {
    const original = putTransaction('first', 'stories/one', 'first');
    const first = await adapter.transact(A, original);
    const { version } = await read(adapter, 'stories/one');
    await adapter.transact(A, putTransaction('second', 'stories/one', 'second', { version }));
    assert.deepEqual((await adapter.transact(A, original)).receipt, first.receipt);
    assert.equal((await read(adapter, 'stories/one')).value, 'second');
  });

  run('immutable configuration versions cannot be replaced, downgraded or deleted', async ({ adapter, controls }) => {
    const original = putTransaction('version-1', 'versions/v1', { workflow: 'pinned' }, { namespace: 'config', immutable: true });
    const first = await adapter.transact(A, original);
    const before = await read(adapter, 'versions/v1', A, 'config');
    for (const immutable of [true, false]) {
      await assert.rejects(adapter.transact(A, putTransaction(`replace-${immutable}`, 'versions/v1', 'changed',
        { namespace: 'config', version: before.version, immutable })), refused('immutable'));
    }
    await assert.rejects(adapter.transact(A, { operationId: 'delete-version',
      preconditions: [{ namespace: 'config', key: 'versions/v1', version: before.version }],
      changes: [{ op: 'delete', namespace: 'config', key: 'versions/v1' }], events: [] }), refused('immutable'));
    const batch = putTransaction('immutable-batch', 'approved/new', 'must-not-land', { namespace: 'config' });
    batch.preconditions.push({ namespace: 'config', key: 'versions/v1', version: before.version });
    batch.changes.push({ op: 'put', namespace: 'config', key: 'versions/v1', value: 'changed', immutable: false });
    await assert.rejects(adapter.transact(A, batch), refused('immutable'));
    assert.equal(await read(adapter, 'approved/new', A, 'config'), null);
    assert.deepEqual((await adapter.transact(A, original)).receipt, first.receipt);
    assert.deepEqual(await read(adapter, 'versions/v1', A, 'config'), before);
    assert.deepEqual(await count(controls), [1, 1]);
  });

  run('delete and recreate do not recycle a prior revision', async ({ adapter }) => {
    await adapter.transact(A, putTransaction('create', 'stories/one', 'first'));
    const { version } = await read(adapter, 'stories/one');
    await adapter.transact(A, { operationId: 'delete', preconditions: [{ namespace: 'state', key: 'stories/one', version }],
      changes: [{ op: 'delete', namespace: 'state', key: 'stories/one' }], events: [] });
    assert.equal(await read(adapter, 'stories/one'), null);
    await adapter.transact(A, putTransaction('recreate', 'stories/one', 'first'));
    assert.notEqual((await read(adapter, 'stories/one')).version, version);
    await assert.rejects(adapter.transact(A, putTransaction('old-writer', 'stories/one', 'stale', { version })), refused('REVISION_CONFLICT'));
  });

  run('event collisions cannot partially publish a record or receipt', async ({ adapter, controls }) => {
    const first = putTransaction('first', 'stories/one', 'first');
    await adapter.transact(A, first);
    const colliding = putTransaction('second', 'stories/two', 'must-not-land');
    colliding.events = first.events;
    await assert.rejects(adapter.transact(A, colliding), refused('OPERATION_ID_REUSE'));
    assert.equal(await read(adapter, 'stories/two'), null);
    assert.equal((await adapter.inspectOperation(A, 'second')).status, 'missing');
    assert.deepEqual(await count(controls), [1, 1]);
  });

  run('a lost acknowledgement is inspectable and safe to replay', async ({ adapter, controls }) => {
    await controls.loseNextCommitResponse();
    const transaction = putTransaction('unknown', 'stories/one', 'retained');
    await assert.rejects(adapter.transact(A, transaction), error => {
      refused('OUTCOME_UNKNOWN')(error);
      assert.equal(error.cause.code, 'ETIMEDOUT');
      assert.deepEqual(error.details, { operationId: 'unknown', stage: 'acknowledgement', timedOut: true });
      return true;
    });
    const inspected = await adapter.inspectOperation(A, 'unknown');
    assert.equal(inspected.status, 'committed');
    assert.deepEqual((await adapter.transact(A, transaction)).receipt, inspected.receipt);
    assert.deepEqual(await count(controls), [1, 1]);
  });

  run('failure before commit leaves no partial records, events or receipt', async ({ adapter, controls }) => {
    const cause = Object.assign(new Error('fixture file is not accessible'), { code: 'EACCES' });
    const failure = namespaceError('Storage is unavailable.', 'SDA_NAMESPACE_UNAVAILABLE', { stage: 'commit', timedOut: false }, cause);
    await controls.failNext('beforeCommit', failure);
    const transaction = putTransaction('retry', 'stories/one', 'retained');
    await assert.rejects(adapter.transact(A, transaction), error => error === failure);
    assert.equal(await read(adapter, 'stories/one'), null);
    assert.equal((await adapter.inspectOperation(A, 'retry')).status, 'missing');
    assert.deepEqual(await count(controls), [0, 0]);
    assert.equal((await adapter.transact(A, transaction)).status, 'committed');
  });

  run('read/list/inspection errors retain their real cause instead of reporting empty data', async ({ adapter, controls }) => {
    for (const [method, invoke] of [
      ['read', () => adapter.read(A, 'state', 'stories/one')],
      ['list', () => adapter.list(A, 'state', { limit: 1 })],
      ['inspectOperation', () => adapter.inspectOperation(A, 'operation')]
    ]) {
      const cause = Object.assign(new Error('fixture deadline elapsed'), { code: 'ETIMEDOUT' });
      const error = namespaceError('The backend did not answer.', 'SDA_NAMESPACE_UNAVAILABLE', { stage: method, timedOut: true }, cause);
      await controls.failNext(method, error);
      await assert.rejects(invoke(), observed => observed === error && observed.cause === cause && observed.details.timedOut);
    }
  });

  run('cancellation before commit has no effects, including cancellation during a pending call', async ({ adapter, controls }) => {
    const cancelled = new AbortController();
    cancelled.abort();
    const options = { signal: cancelled.signal };
    for (const invoke of [
      () => adapter.read(A, 'state', 'stories/one', options),
      () => adapter.list(A, 'state', { limit: 1 }, options),
      () => adapter.transact(A, putTransaction('cancelled', 'stories/one', 1), options),
      () => adapter.inspectOperation(A, 'cancelled', options), () => adapter.verify(A, options)
    ]) await assert.rejects(invoke(), refused('cancelled'));
    const during = new AbortController();
    const pending = adapter.transact(A, putTransaction('during', 'stories/one', 1), { signal: during.signal });
    during.abort();
    await assert.rejects(pending, refused('cancelled'));
    assert.equal(await read(adapter, 'stories/one'), null);
    assert.deepEqual(await count(controls), [0, 0]);
  });

  run('cancellation after commit never claims that the accepted transaction was undone', async ({ adapter, controls }) => {
    const controller = new AbortController();
    await controls.afterNextCommit(() => controller.abort());
    const result = await adapter.transact(A, putTransaction('accepted', 'stories/one', 1), { signal: controller.signal });
    assert.equal(result.status, 'committed');
    assert.deepEqual((await adapter.inspectOperation(A, 'accepted')).receipt, result.receipt);
  });

  run('pagination stays on one snapshot through inserts, updates and deletes', async ({ adapter }) => {
    for (const key of ['a', 'b', 'c', 'd', 'e']) await adapter.transact(A, putTransaction(`seed-${key}`, `stories/${key}`, key));
    const first = await adapter.list(A, 'state', { prefix: 'stories/', limit: 2 });
    await adapter.transact(A, putTransaction('seed-f', 'stories/f', 'f'));
    const before = await read(adapter, 'stories/c');
    await adapter.transact(A, putTransaction('update-c', 'stories/c', 'updated', { version: before.version }));
    const last = await read(adapter, 'stories/e');
    await adapter.transact(A, { operationId: 'delete-e', preconditions: [{ namespace: 'state', key: 'stories/e', version: last.version }],
      changes: [{ op: 'delete', namespace: 'state', key: 'stories/e' }], events: [] });
    const second = await adapter.list(A, 'state', { prefix: 'stories/', limit: 2, continuation: first.continuation });
    const third = await adapter.list(A, 'state', { prefix: 'stories/', limit: 2, continuation: second.continuation });
    assert.equal(first.snapshot, second.snapshot);
    assert.equal(second.snapshot, third.snapshot);
    assert.deepEqual([...first.entries, ...second.entries, ...third.entries].map(record => record.value), ['a', 'b', 'c', 'd', 'e']);
    assert.equal(third.complete, true);
    assert.equal(third.continuation, null);
    assert.deepEqual((await adapter.list(A, 'state', { prefix: 'stories/c', limit: 2 })).entries.map(record => record.value), ['updated']);
  });

  run('continuations are bound to project, namespace, prefix and limit, and expire explicitly', async ({ adapter, controls }) => {
    for (const key of ['a', 'b', 'c']) await adapter.transact(A, putTransaction(`seed-${key}`, `stories/${key}`, key));
    const { continuation } = await adapter.list(A, 'state', { prefix: 'stories/', limit: 1 });
    for (const invoke of [
      () => adapter.list(B, 'state', { prefix: 'stories/', limit: 1, continuation }),
      () => adapter.list(A, 'config', { prefix: 'stories/', limit: 1, continuation }),
      () => adapter.list(A, 'state', { prefix: 'other/', limit: 1, continuation }),
      () => adapter.list(A, 'state', { prefix: 'stories/', limit: 2, continuation }),
      () => adapter.list(A, 'state', { limit: 1, continuation: 'unissued-token' })
    ]) await assert.rejects(invoke(), refused('continuation-invalid'));
    await controls.expireSnapshots();
    await assert.rejects(adapter.list(A, 'state', { prefix: 'stories/', limit: 1, continuation }), refused('continuation-expired'));
  });

  run('page limits are bounded and ordering is case-sensitive code-point order', async ({ adapter }) => {
    for (const limit of [0, 1.5, adapter.descriptor.limits.maxPage + 1]) {
      await assert.rejects(adapter.list(A, 'state', { limit }), refused('limit-invalid'));
    }
    for (const [index, key] of ['stories/a', 'stories/A'].entries()) await adapter.transact(A, putTransaction(`order-${index}`, key, key));
    const page = await adapter.list(A, 'state', { limit: 2 });
    assert.deepEqual(page.entries.map(record => record.key), ['stories/A', 'stories/a']);
  });

  run('caller values and returned records do not mutate retained data by alias', async ({ adapter }) => {
    const value = { nested: { number: 1 } };
    const pending = adapter.transact(A, putTransaction('detached', 'stories/one', value));
    value.nested.number = 99;
    await pending;
    const first = await read(adapter, 'stories/one');
    try { first.value.nested.number = 42; } catch (error) { assert.ok(error instanceof TypeError); }
    assert.equal((await read(adapter, 'stories/one')).value.nested.number, 1);
  });

  run('corrupt storage fails integrity checks and never becomes a missing or empty answer', async ({ adapter, controls }) => {
    await adapter.transact(A, putTransaction('corrupt', 'stories/one', 'retained'));
    await controls.corruptRecord(A, 'state', 'stories/one');
    const result = await adapter.verify(A);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length);
    await assert.rejects(adapter.read(A, 'state', 'stories/one'), refused('corrupt'));
    await assert.rejects(adapter.list(A, 'state', { limit: 1 }), refused('corrupt'));
    await assert.rejects(adapter.inspectOperation(A, 'corrupt'), refused('corrupt'));
  });
}
