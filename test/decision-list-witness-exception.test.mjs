/**
 * A witness exception whose date passed has its own row on the Decide card [owner, 2026-11-28]. EVIDENCE_WITNESS_EXCEPTION_EXPIRED
 * always said "a person who approves the step renews it on the Decide card", and the card had no row for it: the only way was
 * `decision witness-exception` with a mapping digest typed in a terminal. The row records the renewal through that command's own
 * function, with the person's date and reason; one renewed past today, or not yet lapsed, has no row.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { decisionPacket, EFFECT_ORDER } from '../src/decision-list.mjs';
import { PERSON_STEPS } from '../src/person-step-catalog.mjs';

const W = 'WXR-1';
const MAPPING = `sha256:${'b'.repeat(64)}`;
const AT = '2026-11-28T09:00:00.000Z';
const AUTHORITIES = { engineers: { label: 'Engineers', allowAnyGitIdentity: true, members: [] } };
const ME = { name: 'Person', email: 'person@example.invalid' };

function story({ expiresAt = '2026-11-20T00:00:00.000Z', renewals = [] } = {}) {
  return {
    workItem: { id: W, workType: 'custom' }, status: 'in_progress', currentPhase: 'verify', phaseOrder: ['build', 'verify'], history: [],
    resolution: { approvalAuthorities: AUTHORITIES },
    witnessExceptionRenewals: renewals,
    phases: {
      build: { id: 'build', label: 'Build', status: 'approved', generation: 1, approvalPolicy: { authorities: ['engineers'], minimum: 1 },
        approvals: [{ decision: 'approved', generation: 1, witnessMappings: [{ decision: 'exception', mappingSha256: MAPPING, clauseId: `${W}:AC-001`, expiresAt }] }] },
      verify: { id: 'verify', label: 'Verify', status: 'in_progress', generation: 1, approvals: [], approvalPolicy: { authorities: ['engineers'], minimum: 1 } }
    }
  };
}
const list = (workflow) => decisionPacket(workflow, { phaseId: 'verify' }, { authorities: AUTHORITIES, actor: ME, at: AT });

test('a lapsed witness exception is a row the card records: renew it until a date, with the person\'s reason', () => {
  const packet = list(story());
  const item = packet.items.find((entry) => entry.kind === 'witness-exception');
  assert.ok(item, JSON.stringify(packet.items.map((entry) => entry.kind)));
  assert.match(item.title, /^Renew Build's witness exception for /u);
  assert.match(item.why, /until 2026-11-20, which has passed, so the Story cannot end on it\. Only Build's approvers can renew it\./u);
  assert.equal(item.holds, 'story-end', 'it holds only the Story\'s end');
  const [renew] = item.options;
  assert.equal(renew.id, 'renew-exception');
  assert.deepEqual(renew.effects, [{ kind: 'witness-exception-renewal', phase: 'build', generation: 1, mappingSha256: MAPPING, clauseId: `${W}:AC-001` }]);
  assert.deepEqual(Object.keys(renew.needs).sort(), ['expires', 'reason']);
  assert.equal(renew.needs.reason.minimum, 10, 'the command\'s own limit');
  assert.equal(renew.decidedBy.allowed, true);
  assert.equal(renew.recordable, undefined, 'recorded by the card, never a terminal step');
  assert.equal(item.answer.where, 'card');
  // SF Guard signs it on the card, as in a terminal: its family names the effect the list writes.
  assert.ok(EFFECT_ORDER.includes('witness-exception-renewal'));
  assert.equal(PERSON_STEPS.find((row) => row.id === 'witness-exception').effect, 'witness-exception-renewal');
});

test('an exception renewed past today, or not lapsed yet, has no row', () => {
  assert.equal(list(story({ expiresAt: '2026-12-20T00:00:00.000Z' })).items.some((entry) => entry.kind === 'witness-exception'), false);
  const renewed = story({ renewals: [{ id: 'WXR-001', phase: 'build', generation: 1, mappingSha256: MAPPING, expiresAt: '2026-12-31T23:59:59.999Z' }] });
  assert.equal(list(renewed).items.some((entry) => entry.kind === 'witness-exception'), false);
});
