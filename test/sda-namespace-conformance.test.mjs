import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NAMESPACE_STORE_CONTRACT, namespaceStoreOutcome, validateNamespaceStore
} from '../src/sda/namespace/index.mjs';
import { selectSharedStateAuthority } from '../src/sda/shared-state-contract.mjs';
import { selectLifecycleAuthority } from '../src/sda/lifecycle-authority-contract.mjs';
import { createNamespaceMemoryFixture } from './helpers/namespace-memory-adapter.mjs';
import { namespaceStoreConformance, putTransaction } from './helpers/namespace-conformance.mjs';

namespaceStoreConformance('namespace memory reference', createNamespaceMemoryFixture);

test('the reference adapter declares draft/test-only status and cannot become an existing authority', t => {
  const fixture = createNamespaceMemoryFixture();
  t.after(() => fixture.cleanup());
  assert.equal(fixture.adapter.descriptor.contract, NAMESPACE_STORE_CONTRACT);
  assert.equal(fixture.adapter.descriptor.qualification, 'test-only');
  assert.equal(validateNamespaceStore(fixture.adapter), fixture.adapter);
  for (const select of [selectSharedStateAuthority, selectLifecycleAuthority]) {
    assert.throws(() => select(fixture.adapter), error => error.code === 'SDA_ADAPTER_CONTRACT_MISMATCH');
  }
});

test('local bindings isolate devices and cannot read or write shared namespaces', async t => {
  const fixture = createNamespaceMemoryFixture();
  t.after(() => fixture.cleanup());
  const scope = { projectId: 'same-project' };
  const first = fixture.controls.fork({ kind: 'machine-local', deviceId: 'device-a' }).adapter;
  const second = fixture.controls.fork({ kind: 'machine-local', deviceId: 'device-b' }).adapter;
  const sameDevice = fixture.controls.fork({ kind: 'machine-local', deviceId: 'device-a' }).adapter;
  await first.transact(scope, putTransaction('upload', 'attachments/document', { localReference: 'document-1' }, { namespace: 'local' }));
  assert.equal((await first.read(scope, 'local', 'attachments/document')).status, 'present');
  assert.equal((await sameDevice.read(scope, 'local', 'attachments/document')).status, 'present');
  assert.equal((await second.read(scope, 'local', 'attachments/document')).status, 'missing');
  await second.transact(scope, putTransaction('upload', 'attachments/document', { localReference: 'document-2' }, { namespace: 'local' }));
  assert.equal((await first.read(scope, 'local', 'attachments/document')).record.value.localReference, 'document-1');
  assert.equal((await second.read(scope, 'local', 'attachments/document')).record.value.localReference, 'document-2');
  for (const invoke of [
    () => fixture.adapter.read(scope, 'local', 'attachments/document'),
    () => fixture.adapter.transact(scope, putTransaction('shared-upload', 'attachments/document', 'content', { namespace: 'local' })),
    () => first.read(scope, 'state', 'stories/one'),
    () => first.transact(scope, putTransaction('shared-state', 'stories/one', 'state'))
  ]) await assert.rejects(invoke(), error => namespaceStoreOutcome(error) === 'unsupported');
});

test('an event-only transaction is retained and replayed once', async t => {
  const fixture = createNamespaceMemoryFixture();
  t.after(() => fixture.cleanup());
  const scope = { projectId: 'events-project' };
  const transaction = { operationId: 'event-only', preconditions: [], changes: [],
    events: [{ eventId: 'event-one', eventType: 'audit.recorded', namespace: 'state', payload: { recorded: true } }] };
  const first = await fixture.adapter.transact(scope, transaction);
  const again = await fixture.adapter.transact(scope, transaction);
  assert.deepEqual(again.receipt, first.receipt);
  assert.deepEqual(first.receipt.records, []);
  assert.equal(fixture.controls.events(scope).length, 1);
});
