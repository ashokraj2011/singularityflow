import test from 'node:test';
import assert from 'node:assert/strict';
import { createNamespaceSqliteFixture } from './helpers/namespace-sqlite-fixture.mjs';
import { namespaceStoreConformance, putTransaction } from './helpers/namespace-conformance.mjs';
import { createSqliteNamespaceStore } from '../src/sda/sqlite-namespace-adapter.mjs';
import { selectSharedStateAuthority } from '../src/sda/shared-state-contract.mjs';
import { selectLifecycleAuthority } from '../src/sda/lifecycle-authority-contract.mjs';

namespaceStoreConformance('SQLite namespace store', createNamespaceSqliteFixture);
namespaceStoreConformance('application journal on SQLite', () => createNamespaceSqliteFixture({ application: true }));

test('a separate database handle resumes exact revisions, receipts and retained snapshot pages', async t => {
  const f = await createNamespaceSqliteFixture(); let other;
  t.after(async () => { other?.close(); await f.cleanup(); });
  const scope = { projectId: 'project-a' }, original = putTransaction('first', 'stories/a', 'a');
  const accepted = await f.adapter.transact(scope, original);
  for (const key of ['b', 'c']) await f.adapter.transact(scope, putTransaction(`seed-${key}`, `stories/${key}`, key));
  const page = await f.adapter.list(scope, 'state', { limit: 1 });
  other = await createSqliteNamespaceStore({ filename: f.filename, binding: { kind: 'shared' } });
  assert.deepEqual((await other.inspectOperation(scope, 'first')).receipt, accepted.receipt);
  assert.equal((await other.transact(scope, original)).replayed, true);
  const next = await other.list(scope, 'state', { limit: 1, continuation: page.continuation });
  assert.equal(next.snapshot, page.snapshot); assert.equal(next.entries[0].value, 'b');
  assert.equal((await f.controls.events(scope)).length, 3);
});

test('machine-local database bindings isolate devices and all new stores remain outside installed Git authority', async t => {
  const f = await createNamespaceSqliteFixture(); t.after(f.cleanup);
  const scope = { projectId: 'project-a' };
  const first = (await f.controls.fork({ kind: 'machine-local', deviceId: 'first' })).adapter;
  const other = (await f.controls.fork({ kind: 'machine-local', deviceId: 'second' })).adapter;
  await first.transact(scope, putTransaction('upload', 'attachments/photo', { localReference: 'one' }, { namespace: 'local' }));
  assert.equal((await other.read(scope, 'local', 'attachments/photo')).status, 'missing');
  await assert.rejects(f.adapter.read(scope, 'local', 'attachments/photo'), { code: 'SDA_NAMESPACE_UNSUPPORTED' });
  for (const select of [selectSharedStateAuthority, selectLifecycleAuthority]) {
    assert.throws(() => select(f.adapter), { code: 'SDA_ADAPTER_CONTRACT_MISMATCH' });
  }
});
