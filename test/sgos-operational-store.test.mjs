import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SGOS_OPERATIONAL_STORE_CAPABILITIES,
  SGOS_OPERATIONAL_STORE_SPI_VERSION,
  assertSgosOperationalStoreAdapter,
  assertSgosOperationalStoreSelection,
  createFilesystemSgosOperationalStore,
  createMemorySgosOperationalStore
} from '../src/sgos/operational-store.mjs';

const hash = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

async function exerciseOperationalStore(factory) {
  const source = factory('conformance-store');
  assert.equal(assertSgosOperationalStoreAdapter(source), source);
  assert.equal(source.spiVersion, SGOS_OPERATIONAL_STORE_SPI_VERSION);
  assert.deepEqual(source.capabilities, SGOS_OPERATIONAL_STORE_CAPABILITIES);
  assert.deepEqual(source.descriptor().purposes, ['simulation', 'test']);
  assert.equal(source.descriptor().authorityEligible, false);

  const initial = await source.read();
  assert.equal(initial.revision, 0);
  const first = await source.transact({
    expectedRevision: initial.revision,
    expectedStateSha256: initial.stateSha256,
    changes: [{ op: 'put', key: 'task/one', value: { state: 'ready' } }]
  });
  const second = await source.transact({
    expectedRevision: first.revision,
    expectedStateSha256: first.stateSha256,
    changes: [
      { op: 'put', key: 'task/one', value: { state: 'running' } },
      { op: 'put', key: 'receipt/one', value: { observed: true } }
    ]
  });
  assert.equal((await source.verify()).eventCount, 2);

  const backup = await source.exportBackup();
  const destination = factory('conformance-store');
  const restorePlan = await destination.planRestore(backup);
  assert.equal(restorePlan.mode, 'fast-forward');
  await assert.rejects(() => destination.restore({ backup, confirmationSha256: hash('wrong') }),
    (error) => error.code === 'SGOS_OPERATIONAL_RESTORE_STALE');
  const restored = await destination.restore({
    backup, confirmationSha256: restorePlan.confirmationSha256
  });
  assert.equal(restored.restored, true);
  assert.deepEqual(await destination.read(), second);

  const rollbackPlan = await destination.planRollback(1);
  await assert.rejects(() => destination.rollback({
    revision: 1, confirmationSha256: hash('wrong')
  }), (error) => error.code === 'SGOS_OPERATIONAL_ROLLBACK_STALE');
  const rolledBack = await destination.rollback({
    revision: 1, confirmationSha256: rollbackPlan.confirmationSha256
  });
  assert.equal(rolledBack.revision, 3,
    'rollback appends a new event instead of erasing operational history');
  const afterRollback = await destination.read();
  assert.deepEqual(afterRollback.entries, first.entries);
  assert.equal((await destination.verify()).eventCount, 3);

  const beforeRace = await destination.read();
  const race = await Promise.allSettled([1, 2].map((value) => destination.transact({
    expectedRevision: beforeRace.revision,
    expectedStateSha256: beforeRace.stateSha256,
    changes: [{ op: 'put', key: 'race/winner', value }]
  })));
  assert.equal(race.filter((entry) => entry.status === 'fulfilled').length, 1);
  const loser = race.find((entry) => entry.status === 'rejected');
  assert.equal(loser.reason.code, 'SGOS_OPERATIONAL_CAS_MISMATCH');
  assert.equal((await destination.verify()).eventCount, 4);

  return { source, destination, backup };
}

test('the alternate in-memory Operational Store passes the unchanged bounded conformance journey',
  async () => {
    await exerciseOperationalStore((storeId) => createMemorySgosOperationalStore({ storeId }));
  });

test('the durable filesystem Operational Store passes the unchanged bounded conformance journey',
  async (t) => {
    const parent = await mkdtemp(join(tmpdir(), 'sflow-operational-store-'));
    t.after(() => rm(parent, { recursive: true, force: true }));
    let sequence = 0;
    await exerciseOperationalStore((storeId) => createFilesystemSgosOperationalStore({
      storeId, root: join(parent, `store-${sequence += 1}`)
    }));
  });

test('independent filesystem adapters serialize writers and recover stale locks and orphan staging',
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'sflow-operational-race-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const first = createFilesystemSgosOperationalStore({
      storeId: 'shared-store', root, staleLockMs: 1_000
    });
    const second = createFilesystemSgosOperationalStore({
      storeId: 'shared-store', root, staleLockMs: 1_000
    });
    const initial = await first.read();
    const results = await Promise.allSettled([first, second].map((store, index) => store.transact({
      expectedRevision: initial.revision,
      expectedStateSha256: initial.stateSha256,
      changes: [{ op: 'put', key: 'race/winner', value: index }]
    })));
    assert.equal(results.filter((entry) => entry.status === 'fulfilled').length, 1);
    assert.equal(results.find((entry) => entry.status === 'rejected').reason.code,
      'SGOS_OPERATIONAL_CAS_MISMATCH');
    assert.deepEqual(await first.read(), await second.read());

    const storeRoot = join(root, 'shared-store');
    await writeFile(join(storeRoot, 'writer.lock'), JSON.stringify({
      pid: 999_999_999, nonce: 'abandoned', createdAtMs: 0
    }));
    const old = new Date(Date.now() - 5_000);
    await utimes(join(storeRoot, 'writer.lock'), old, old);
    await writeFile(join(storeRoot, 'events', '.interrupted.tmp'), '{partial');
    const before = await first.read();
    const after = await first.transact({
      expectedRevision: before.revision,
      expectedStateSha256: before.stateSha256,
      changes: [{ op: 'put', key: 'recovered', value: true }]
    });
    assert.equal(after.revision, 2);
    assert.equal((await first.doctor()).status, 'ready');
    assert.equal((await readdir(join(storeRoot, 'events'))).includes('.interrupted.tmp'), true,
      'orphan staging remains visibly non-authoritative and is ignored by replay');
  });

test('filesystem lineage corruption is refused without publishing another event', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sflow-operational-corrupt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createFilesystemSgosOperationalStore({ storeId: 'corrupt-store', root });
  const initial = await store.read();
  await store.transact({
    expectedRevision: initial.revision,
    expectedStateSha256: initial.stateSha256,
    changes: [{ op: 'put', key: 'safe', value: true }]
  });
  const eventsRoot = join(root, 'corrupt-store', 'events');
  const [eventName] = (await readdir(eventsRoot)).filter((name) => name.endsWith('.json'));
  const path = join(eventsRoot, eventName);
  const event = JSON.parse(await readFile(path, 'utf8'));
  event.changes[0].value = false;
  await writeFile(path, JSON.stringify(event));
  await assert.rejects(() => store.verify(),
    (error) => error.code === 'SGOS_OPERATIONAL_STORE_CORRUPT');
  await assert.rejects(() => store.transact({
    expectedRevision: 1,
    expectedStateSha256: hash('irrelevant'),
    changes: [{ op: 'put', key: 'later', value: true }]
  }), (error) => error.code === 'SGOS_OPERATIONAL_STORE_CORRUPT');
  assert.equal((await readdir(eventsRoot)).filter((name) => name.endsWith('.json')).length, 1);
});

test('operational backup, bounds, and partial failures preserve the last verified head', async () => {
  const store = createMemorySgosOperationalStore({ storeId: 'failure-store' });
  const initial = await store.read();
  await assert.rejects(() => store.transact({
    expectedRevision: initial.revision,
    expectedStateSha256: initial.stateSha256,
    changes: [{ op: 'put', key: 'too-large', value: 'x'.repeat(8 * 1024 * 1024 + 1) }]
  }), (error) => error.code === 'SGOS_OPERATIONAL_STORE_LIMIT');
  assert.deepEqual(await store.read(), initial,
    'a rejected write cannot publish a partial head or event');

  const changed = await store.transact({
    expectedRevision: initial.revision,
    expectedStateSha256: initial.stateSha256,
    changes: [{ op: 'put', key: 'safe', value: true }]
  });
  const tampered = await store.exportBackup();
  tampered.head.entries.safe = false;
  const before = await store.read();
  await assert.rejects(() => store.planRestore(tampered),
    (error) => error.code === 'SGOS_OPERATIONAL_BACKUP_INVALID');
  assert.deepEqual(await store.read(), before);
  assert.deepEqual(before, changed);
});

test('the alternate Operational Store cannot become Program or lifecycle authority', () => {
  const store = createMemorySgosOperationalStore({ storeId: 'selection-store' });
  const profile = hash('approved-storage-profile');
  assert.equal(assertSgosOperationalStoreSelection(store, {
    purpose: 'simulation',
    programStorageProfileSha256: profile,
    selectedStorageProfileSha256: profile
  }), store);
  for (const input of [
    { purpose: 'runtime', programStorageProfileSha256: profile, selectedStorageProfileSha256: profile },
    { purpose: 'simulation', programStorageProfileSha256: profile, selectedStorageProfileSha256: hash('other') }
  ]) {
    assert.throws(() => assertSgosOperationalStoreSelection(store, input), (error) => {
      assert.equal(error.code, 'SGOS_OPERATIONAL_STORE_SELECTION_REFUSED');
      return true;
    });
  }

  const counterfeit = {
    ...store,
    capabilities: { ...store.capabilities, authorityEligible: true }
  };
  assert.throws(() => assertSgosOperationalStoreAdapter(counterfeit), (error) => {
    assert.equal(error.code, 'SGOS_OPERATIONAL_ADAPTER_INVALID');
    return true;
  });
});
