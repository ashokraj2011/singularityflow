/** Existing SGOS v1 conformance journey, shared unchanged by every concrete store. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {assertSgosOperationalStoreAdapter,SGOS_OPERATIONAL_STORE_SPI_VERSION,SGOS_OPERATIONAL_STORE_CAPABILITIES} from '../../src/sgos/operational-contract.mjs';
const hash=value=>'sha256:'+createHash('sha256').update(value).digest('hex');

export async function exerciseOperationalStore(factory, {
  expectedPurposes = ['simulation', 'test']
} = {}) {
  const source = factory('conformance-store');
  assert.equal(assertSgosOperationalStoreAdapter(source), source);
  assert.equal(source.spiVersion, SGOS_OPERATIONAL_STORE_SPI_VERSION);
  assert.deepEqual(source.capabilities, SGOS_OPERATIONAL_STORE_CAPABILITIES);
  assert.deepEqual(source.descriptor().purposes, expectedPurposes);
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
