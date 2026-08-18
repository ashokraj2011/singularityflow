import test from 'node:test';
import assert from 'node:assert/strict';

import {
  healerReceipt, runWorkspaceHealer, workspaceHealerRegistry
} from '../src/workspace-healers.mjs';

test('the workspace healer registry is closed and every automatic healer is bounded', () => {
  const registry = workspaceHealerRegistry();
  assert.ok(registry.length >= 6);
  assert.equal(new Set(registry.map((entry) => entry.id)).size, registry.length);
  for (const healer of registry) {
    assert.match(healer.level, /^H[1-5]$/);
    assert.equal(healer.attempts, 1);
    assert.ok(healer.preconditions.length);
    assert.ok(healer.verify.length);
    assert.ok(healer.rollback);
  }
});

test('a self-heal receipt requires passing postcondition evidence', () => {
  assert.throws(() => healerReceipt('expired-bootstrap-lease'), (error) => {
    assert.equal(error.code, 'WORKSPACE_HEALER_PROOF_REQUIRED');
    return true;
  });
  const receipt = healerReceipt('expired-bootstrap-lease', {
    postconditions: [{ id: 'bootstrap-lease-acquired', status: 'pass' }],
    proof: { expiredLeaseRemoved: true }
  });
  assert.equal(receipt.level, 'H1');
  assert.equal(receipt.proof.expiredLeaseRemoved, true);
});

test('healers cannot invoke other healers recursively', async () => {
  await assert.rejects(() => runWorkspaceHealer('missing-derived-index', async () => {
    await runWorkspaceHealer('runtime-projection-drift', async () => ({
      postconditions: [{ id: 'runtime-projection-matches-package', status: 'pass' }]
    }));
    return { postconditions: [{ id: 'derived-index-matches-source', status: 'pass' }] };
  }), (error) => {
    assert.equal(error.code, 'WORKSPACE_HEALER_RECURSION_REFUSED');
    return true;
  });
});
