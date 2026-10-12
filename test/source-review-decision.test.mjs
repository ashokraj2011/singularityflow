import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceReviewDecisionPacket, assertSourceReviewDecisionConfirmation } from '../src/source-review-decision.mjs';

function input() {
  return { workflow: { workItem: { id: 'REVIEW-1' }, phases: { 'team-scope': { generation: 2 } } },
    phaseId: 'team-scope', status: { generation: 2, status: 'correction-required', reportSha256: 'a'.repeat(64),
      pendingDispositions: [{ id: 'not-applicable:REVIEW-1:REQ-004', reason: 'Visual proof, no executable test.' },
        { id: 'not-applicable:REVIEW-1:AC-004', reason: 'Separate exception.' }] },
    findingId: 'not-applicable:REVIEW-1:REQ-004', reason: 'not needed',
    actor: { email: 'human@example.test' }, authority: { authorityGroup: 'quality-reviewers' } };
}

test('decision preparation is read-only and retains the exact human-decision route', () => {
  const values = input(); const before = structuredClone(values);
  const packet = sourceReviewDecisionPacket(values);
  assert.deepEqual(values, before);
  assert.deepEqual(packet.effects, { stateChanged: false, filesChanged: false, publicationCreated: false });
  assert.ok(packet.commandGuidance.copilotCommand.startsWith('/sf-review-decide team-scope'));
  assert.ok(packet.commandGuidance.argv.includes(packet.packetSha256));
  assert.equal(packet.commandGuidance.modelFreeCommand, null);
  assert.doesNotThrow(() => assertSourceReviewDecisionConfirmation(packet, packet.packetSha256));
  assert.equal(packet.binding.finding.id, values.findingId, 'another pending exception is never decided implicitly');
});

test('any reviewed binding, reason or human identity change invalidates confirmation', () => {
  const confirmed = sourceReviewDecisionPacket(input()).packetSha256;
  for (const change of [value => { value.workflow.workItem.id = 'OTHER'; },
    value => { value.phaseId = 'team-other'; value.workflow.phases['team-other'] = { generation: 2 }; },
    value => { value.status.generation = value.workflow.phases['team-scope'].generation = 3; },
    value => { value.status.reportSha256 = 'b'.repeat(64); },
    value => { value.status.pendingDispositions[0].reason = 'Changed contract'; },
    value => { value.findingId = value.status.pendingDispositions[1].id; },
    value => { value.reason = 'Different consent'; },
    value => { value.actor.email = 'other@example.test'; },
    value => { value.authority.authorityGroup = 'other-group'; }]) {
    const values = input(); change(values);
    assert.throws(() => assertSourceReviewDecisionConfirmation(sourceReviewDecisionPacket(values), confirmed),
      { code: 'SOURCE_REVIEW_DECISION_STALE' });
  }
});

test('stale, superseded, absent or non-pending findings cannot become decision packets', () => {
  for (const change of [value => { value.status.status = 'stale'; },
    value => { value.status.generation = 1; }, value => { value.status.reportSha256 = null; },
    value => { value.status.pendingDispositions = []; }]) {
    const values = input(); change(values);
    assert.throws(() => sourceReviewDecisionPacket(values), { code: 'SOURCE_REVIEW_DISPOSITION_NOT_PENDING' });
  }
  const packet = sourceReviewDecisionPacket(input());
  assert.throws(() => assertSourceReviewDecisionConfirmation(packet, undefined), { code: 'SOURCE_REVIEW_DECISION_STALE' });
});

test('preparation never claims readiness without human authority and a usable exact command', () => {
  for (const change of [value => { value.actor = {}; }, value => { value.authority = null; }]) {
    const values = input(); change(values);
    assert.throws(() => sourceReviewDecisionPacket(values), { code: 'SOURCE_REVIEW_DISPOSITION_AUTHORITY_REQUIRED' });
  }
  for (const reason of ['A line\nbreak', 'x'.repeat(3000), '<reason>']) {
    assert.throws(() => sourceReviewDecisionPacket({ ...input(), reason }),
      { code: 'SOURCE_REVIEW_DISPOSITION_COMMAND_UNAVAILABLE' });
  }
});
