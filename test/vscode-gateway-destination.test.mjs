import test from 'node:test';
import assert from 'node:assert/strict';

const { gatewayDestination } = await import('../apps/vscode/src/gateway-destination.ts');

test('a review packet opens the existing governed Approvals surface', () => {
  assert.equal(gatewayDestination({
    operation: { id: 'review.packet' },
    data: { surface: 'approvals', requestedWork: { id: 'WRK-42', kind: 'story' } }
  }), 'singularityFlow.openApprovals');
});

test('gateway destination routing is closed to unrelated or malformed results', () => {
  assert.equal(gatewayDestination({ operation: { id: 'work.handoff' }, data: { surface: 'approvals' } }), null);
  assert.equal(gatewayDestination({ operation: { id: 'review.packet' }, data: { surface: 'elsewhere' } }), null);
  assert.equal(gatewayDestination(null), null);
});
