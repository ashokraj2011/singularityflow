import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAutoPlanPacket, buildAutoPlanValidation } from '../src/auto/auto-plan-packet.mjs';
import { recordSha256 } from '../src/records.mjs';

const planValue = {
  planId: `APL-${'A'.repeat(26)}`,
  mode: 'auto',
  requirement: { text: 'Add CSV export.', sha256: 'requirement-digest' },
  proposal: {
    assumptions: [], unresolvedDecisions: [], predictedPaths: ['src/report'],
    acceptanceCriteria: ['CSV export works.']
  },
  story: { workId: 'CSV-1', workType: 'feature', branch: 'CSV-1', phaseRail: ['specify', 'implement'] },
  execution: {
    profile: { requested: 'story', resolved: 'story', selectionReason: 'explicit' },
    pace: { source: 'phase' }, until: { source: 'first-human-boundary' },
    repair: { policy: 'auto-on-machine-actionable', maximumAttempts: 1 },
    ceilings: { maximumTouchedPaths: 8 }, eligibility: 'bounded'
  },
  executionHost: { id: 'copilot-cli', containment: { managedWorktree: true } },
  scope: { protectedPaths: [] },
  humanBoundaries: { firstPhaseClarificationRequired: false, stopPoints: [] },
  safety: { startable: true, reasons: [] }
};
planValue.planSha256 = `sha256:${recordSha256(planValue)}`;
const plan = Object.freeze(planValue);

test('Auto Plan validation and ratification packet are deterministic exact-hash projections', () => {
  const validation = buildAutoPlanValidation(plan);
  const packet = buildAutoPlanPacket(plan, validation);
  assert.equal(validation.status, 'valid');
  assert.match(validation.validationSha256, /^sha256:[a-f0-9]{64}$/);
  assert.match(packet.packetSha256, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(buildAutoPlanValidation(plan), validation);
  assert.deepEqual(buildAutoPlanPacket(plan), packet);
  assert.equal(packet.schemaVersion, 2);
  assert.equal(packet.planSha256, plan.planSha256);
  assert.equal(packet.execution.profile, 'story');
  assert.equal(packet.execution.repairPolicy, 'auto-on-machine-actionable');
  assert.equal(packet.execution.repairAttemptsPerPhase, 1);
});

test('unresolved Plan decisions become an explicit needs-human validation', () => {
  const unresolved = structuredClone(plan);
  unresolved.proposal.unresolvedDecisions = ['Choose the public CSV dialect.'];
  delete unresolved.planSha256;
  unresolved.planSha256 = `sha256:${recordSha256(unresolved)}`;
  const validation = buildAutoPlanValidation(unresolved);
  assert.equal(validation.status, 'needs-human');
  assert.deepEqual(validation.requiredQuestions, ['Choose the public CSV dialect.']);
  assert.notEqual(buildAutoPlanPacket(unresolved).packetSha256, buildAutoPlanPacket(plan).packetSha256);
});
