import assert from 'node:assert/strict';
import test from 'node:test';

import { intentAmendmentDecisionEvent } from '../src/commands/story.mjs';

const authority = {
  actor: { name: 'Reviewer', email: 'reviewer@example.test' },
  agent: 'product-owner',
  authorityGroup: 'product-approvers',
  identityAssurance: 'git-config'
};

function event(result, decision = 'approve') {
  return intentAmendmentDecisionEvent(result, {
    proposalId: 'AMD-001',
    proposalSha256: 'a'.repeat(64),
    decision,
    generation: result.applied ? 2 : 1
  });
}

test('every amendment decision uses the just-recorded authority and no prior review packet', () => {
  for (const result of [
    { applied: true, reached: true, eventDecision: authority, decisionSha256: 'b'.repeat(64) },
    { applied: false, reached: false, eventDecision: authority, decisionSha256: 'c'.repeat(64) },
    { applied: false, reached: true, eventDecision: authority, decisionSha256: 'd'.repeat(64) }
  ]) {
    const projected = event(result, result.reached && !result.applied ? 'reject' : 'approve');
    assert.deepEqual(projected.actor, authority.actor);
    assert.equal(projected.agent, authority.agent);
    assert.equal(projected.authorityGroup, authority.authorityGroup);
    assert.equal(projected.identityAssurance, authority.identityAssurance);
    assert.equal(projected.payload.reviewPacketSha256, null);
    assert.equal(projected.payload.decisionSha256, result.decisionSha256);
    assert.equal('syntheticGeneration' in projected.payload, result.applied);
  }
});

test('an amendment event fails closed without its decision evidence', () => {
  assert.throws(
    () => event({ applied: false, reached: true, eventDecision: authority }),
    (error) => error.code === 'INTENT_AMENDMENT_DECISION_EVIDENCE_MISSING'
  );
});
