import assert from 'node:assert/strict';
import test from 'node:test';

import { approvalRequirementsMet, storyApprovalView } from '../src/approval-authority.mjs';

const policy = { mode: 'required', minimum: 2, authorities: ['reviewers', 'security'], requiredAuthorities: ['security'] };
const approval = (actor, authorityGroup = 'reviewers', extra = {}) => ({ decision: 'approved', actor, authorityGroup, ...extra });
const awaiting = (approvals) => ({
  currentPhase: 'design',
  phases: { design: { id: 'design', status: 'awaiting_approval', approvalPolicy: policy, approvals } }
});

test('the approval view is the engine rule: distinct people by their compared identity, and every required group', () => {
  // The same person twice, by email case and by login, is one approver.
  const sameTwice = awaiting([approval({ email: 'Ann@Example.com' }), approval({ email: 'ann@example.com' })]);
  assert.deepEqual(storyApprovalView(sameTwice), { phase: 'design', minimum: 2, distinct: 1, remainingAuthorities: ['security'], met: false });

  const twoWithoutSecurity = awaiting([approval({ email: 'ann@example.com' }), approval({ login: 'bob' })]);
  assert.deepEqual(storyApprovalView(twoWithoutSecurity).remainingAuthorities, ['security']);
  assert.equal(storyApprovalView(twoWithoutSecurity).met, false);

  const met = awaiting([approval({ email: 'ann@example.com' }), approval({ login: 'sec' }, 'security')]);
  assert.equal(storyApprovalView(met).met, true);
  assert.equal(storyApprovalView(met).met, approvalRequirementsMet(policy, met.phases.design.approvals));

  // An invalidated approval no longer counts; a phase not awaiting approval has no view.
  const invalidated = awaiting([approval({ email: 'ann@example.com' }), approval({ login: 'sec' }, 'security', { invalidatedAt: '2026-10-03T00:00:00Z' })]);
  assert.equal(storyApprovalView(invalidated).met, false);
  assert.equal(storyApprovalView({ currentPhase: 'design', phases: { design: { status: 'approved' } } }), null);
  assert.equal(storyApprovalView({ currentPhase: null, phases: {} }), null);
});
