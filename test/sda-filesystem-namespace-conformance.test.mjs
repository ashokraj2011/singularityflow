import test from 'node:test';
import assert from 'node:assert/strict';
import { createNamespaceFilesystemFixture } from './helpers/namespace-filesystem-fixture.mjs';
import { namespaceStoreConformance, putTransaction } from './helpers/namespace-conformance.mjs';
import { createFilesystemNamespaceStore } from '../src/sda/filesystem-namespace-adapter.mjs';
import { selectSharedStateAuthority } from '../src/sda/shared-state-contract.mjs';
import { selectLifecycleAuthority } from '../src/sda/lifecycle-authority-contract.mjs';

namespaceStoreConformance('filesystem namespace store', createNamespaceFilesystemFixture);

test('another handle resumes exact revisions, receipts and snapshot pages without replaying effects', async t => {
  const f = await createNamespaceFilesystemFixture(); t.after(f.cleanup);
  const scope = { projectId: 'project-a' };
  const tx = putTransaction('first', 'stories/a', 'a');
  const first = await f.adapter.transact(scope, tx);
  for (const key of ['b', 'c']) await f.adapter.transact(scope, putTransaction(`seed-${key}`, `stories/${key}`, key));
  const page = await f.adapter.list(scope, 'state', { limit: 1 });
  const resumed = await createFilesystemNamespaceStore({ root: f.root, binding: { kind: 'shared' }, limits: { maxPage: 2 } });
  assert.deepEqual((await resumed.inspectOperation(scope, 'first')).receipt, first.receipt);
  assert.deepEqual((await resumed.transact(scope, tx)).receipt, first.receipt);
  const next = await resumed.list(scope, 'state', { limit: 1, continuation: page.continuation });
  assert.equal(next.snapshot, page.snapshot);
  assert.equal(next.entries[0].value, 'b');
  assert.deepEqual(await resumed.verify(scope), { valid: true, errors: [] });
  assert.equal((await f.controls.events(scope)).length, 3);
});

test('machine-local stores remain separate and cannot become either installed Git authority', async t => {
  const f = await createNamespaceFilesystemFixture(); t.after(f.cleanup);
  const scope = { projectId: 'project-a' };
  const first = (await f.controls.fork({ kind: 'machine-local', deviceId: 'one' })).adapter;
  const second = (await f.controls.fork({ kind: 'machine-local', deviceId: 'two' })).adapter;
  await first.transact(scope, putTransaction('upload', 'attachments/photo', { bytes: 'local' }, { namespace: 'local' }));
  assert.equal((await second.read(scope, 'local', 'attachments/photo')).status, 'missing');
  const same = (await f.controls.fork({ kind: 'machine-local', deviceId: 'one' })).adapter;
  assert.equal((await same.read(scope, 'local', 'attachments/photo')).record.value.bytes, 'local');
  for (const invoke of [() => f.adapter.read(scope, 'local', 'attachments/photo'),
    () => first.transact(scope, putTransaction('wrong', 'stories/one', 1))]) {
    await assert.rejects(invoke(), { code: 'SDA_NAMESPACE_UNSUPPORTED' });
  }
  for (const select of [selectSharedStateAuthority, selectLifecycleAuthority]) {
    assert.throws(() => select(f.adapter), { code: 'SDA_ADAPTER_CONTRACT_MISMATCH' });
  }
});

test('event-only commits retain one receipt and reject event identity reuse after reopening', async t => {
  const f = await createNamespaceFilesystemFixture(); t.after(f.cleanup);
  const scope = { projectId: 'events' };
  const tx = { operationId: 'event-only', preconditions: [], changes: [],
    events: [{ eventId: 'event-one', eventType: 'audit.recorded', namespace: 'state', payload: { result: 1 } }] };
  const result = await f.adapter.transact(scope, tx);
  const resumed = await createFilesystemNamespaceStore({ root: f.root, binding: { kind: 'shared' } });
  assert.equal((await resumed.transact(scope, tx)).replayed, true);
  assert.deepEqual((await resumed.inspectOperation(scope, 'event-only')).receipt, result.receipt);
  await assert.rejects(resumed.transact(scope, { ...tx, operationId: 'other' }), { code: 'SDA_NAMESPACE_EVENT_ID_REUSED' });
  assert.equal((await f.controls.events(scope)).length, 1);
});
