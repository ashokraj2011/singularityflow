import assert from 'node:assert/strict';
import test from 'node:test';
import { sharedSessionReadEligible } from '../src/session-read-service.mjs';

function ordinary(id = 'custom-future-phase') {
  return { workflowSnapshot: {}, currentPhase: id,
    phases: { [id]: { id, status: 'in_progress', generation: 0 } }, resolution: { phases: [] } };
}

test('shared reads are phase-name neutral and restricted to ordinary accepted open drafts', () => {
  for (const id of ['specification', 'planning', 'implementation', 'convergence', 'verification', 'release', 'custom-future-phase']) {
    assert.equal(sharedSessionReadEligible(ordinary(id)), true, id);
  }
  const published = ordinary(); published.phases[published.currentPhase].generation = 1;
  assert.equal(sharedSessionReadEligible(published), false);
  const legacy = ordinary(); delete legacy.workflowSnapshot;
  assert.equal(sharedSessionReadEligible(legacy), false);
  const closed = ordinary(); closed.currentPhase = null;
  assert.equal(sharedSessionReadEligible(closed), false);
  const submitted = ordinary(); submitted.phases[submitted.currentPhase].status = 'submitted';
  assert.equal(sharedSessionReadEligible(submitted), false);
});

test('remote output records and required deliveries keep the original isolated dependency checks', () => {
  const remote = ordinary();
  remote.phases[remote.currentPhase].remoteOutputs = [{ agent: 'remote', resource: 'design', generation: 1, target: 'design.md' }];
  assert.equal(sharedSessionReadEligible(remote), false);
  const delivery = ordinary(); delivery.resolution.phases = [{ afterStep: [{ required: true }] }];
  assert.equal(sharedSessionReadEligible(delivery), false);
});
