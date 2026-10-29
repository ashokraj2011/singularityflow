/**
 * Two show-stoppers from the 2026-10-27 per-phase blocker audit, each with a way through.
 *
 * - A lone author whose steps forbid self-approval: Story start let it begin, and only at approval
 *   did anyone learn nobody could ever approve, with the groups pinned for the life of the Story.
 * - A pinned loopback target whose port changed: "never replaced; start a new Story", while the
 *   coding guidance starts the application on a free port.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { assertApprovalPolicyAttainable, eligibleApprovers } from '../src/approval-authority.mjs';
import { loopbackPortChange, targetOriginPlan } from '../src/commands/story-target-origin.mjs';
import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';

const creator = { name: 'Author', email: 'author@example.invalid' };
const authorities = (members, extra = {}) => ({ reviewers: { label: 'Reviewers', members, ...extra } });
const policy = (allowSelfApproval) => ({ mode: 'required', authorities: ['reviewers'], requiredAuthorities: [], minimum: 1, allowSelfApproval });

test('Story start refuses a step only its author could approve, and names the configuration fixes', () => {
  const lone = authorities([{ email: 'author@example.invalid' }]);
  const refused = (() => { try { assertApprovalPolicyAttainable(lone, policy(false), 'implementation', { creator }); } catch (error) { return error; } })();
  assert.equal(refused?.code, 'APPROVAL_POLICY_UNATTAINABLE');
  assert.equal(refused.details.selfApprovalExcluded, true);
  assert.match(refused.message, /forbids self-approval, and author@example\.invalid, who starts this Story and publishes its steps, is the only identity reviewers lists/u);
  // Allowed: self-approval on, another person listed, or a group open to any identity.
  assert.doesNotThrow(() => assertApprovalPolicyAttainable(lone, policy(true), 'implementation', { creator }));
  assert.doesNotThrow(() => assertApprovalPolicyAttainable(authorities([{ email: 'author@example.invalid' }, { email: 'other@example.invalid' }]), policy(false), 'implementation', { creator }));
  assert.doesNotThrow(() => assertApprovalPolicyAttainable(authorities([], { allowAnyGitIdentity: true }), policy(false), 'implementation', { creator }));

  const plan = refusalRemediationPlan(refused, ['start', 'US-1']);
  assert.deepEqual(plan.steps.slice(0, 2).map((entry) => entry.id), ['add-approver', 'allow-self-approval']);
  assert.match(plan.steps[0].label, /Add another person to reviewers/u);
  assert.equal(plan.steps[1].command, 'singularity-flow configuration add-current-identity --target story:reviewers --self-approval on --json');
});

test('at approval, a Story nobody else can approve says so and names a way to a Story that can finish', () => {
  const lone = authorities([{ email: 'author@example.invalid' }]);
  const details = { phase: 'implementation', workId: 'US-1', ...eligibleApprovers(lone, policy(false), { exclude: ['author@example.invalid'] }) };
  assert.deepEqual(details.eligibleApprovers, []);
  const plan = refusalRemediationPlan({ code: 'APPROVAL_SELF_APPROVAL_PROHIBITED', message: 'prohibited', details }, ['approve', 'implementation']);
  assert.deepEqual(plan.steps.map((entry) => entry.id).slice(0, 3), ['no-other-approver', 'refresh-approvers', 'allow-self-approval']);
  assert.match(plan.steps[0].label, /cannot be approved in this Story as its approval groups stand/u);
  // Another person added through the configuration reaches this Story by a refresh (2026-10-29).
  assert.equal(plan.steps[1].command, 'singularity-flow story approvers refresh US-1 --reason <REASON>');
  // Someone else listed, or a group open to any identity: the ordinary "ask another member".
  const open = { ...details, ...eligibleApprovers(authorities([], { allowAnyGitIdentity: true }), policy(false)) };
  assert.equal(open.anyIdentity, true);
  assert.equal(refusalRemediationPlan({ code: 'APPROVAL_SELF_APPROVAL_PROHIBITED', message: 'prohibited', details: open }, ['approve']).steps[0].id, 'ask-other-approver');
});

// A group nobody is listed in (empty from the start, or its only member left) said "ask a member"
// of it; the way through is the configuration, then an approver refresh of this Story (2026-10-29).
test('at approval, a group with nobody listed says so and names the configuration and the approver refresh', () => {
  const empty = authorities([]);
  const details = { phase: 'implementation', workId: 'US-1', identity: 'author@example.invalid',
    ...eligibleApprovers(empty, policy(true), { exclude: ['author@example.invalid'] }) };
  const plan = refusalRemediationPlan({ code: 'APPROVAL_IDENTITY_NOT_AUTHORIZED', message: 'not a member', details }, ['approve', 'implementation']);
  assert.deepEqual(plan.steps.map((entry) => entry.id).slice(0, 3), ['no-approver-listed', 'propose-joining-group', 'refresh-approvers']);
  assert.equal(plan.steps[2].command, 'singularity-flow story approvers refresh US-1 --reason <REASON>');
  assert.match(plan.steps[0].label, /Nobody is listed in .* so implementation cannot be approved in it/u);
  assert.equal(plan.steps[1].command, 'singularity-flow configuration add-current-identity --target story:reviewers --json');
  // Someone listed: the ordinary identity check and "ask a member".
  const listed = { ...details, ...eligibleApprovers(authorities([{ email: 'other@example.invalid' }]), policy(true), { exclude: ['author@example.invalid'] }) };
  assert.equal(refusalRemediationPlan({ code: 'APPROVAL_IDENTITY_NOT_AUTHORIZED', message: 'not a member', details: listed }, ['approve']).steps[0].id, 'check-approval-identity');
});

test('a pinned loopback target is replaced when only its port changed, never for another host', () => {
  assert.equal(loopbackPortChange('http://localhost:5173', 'http://localhost:5174'), true);
  assert.equal(loopbackPortChange('http://127.0.0.1:3000', 'http://localhost:3001'), false, 'another host name is another target');
  assert.equal(loopbackPortChange('https://staging.example.test', 'https://staging.example.test:8443'), false, 'only this machine\'s loopback address');
  assert.equal(loopbackPortChange('http://localhost:5173', 'https://localhost:5173'), false);
  const workflow = (origins) => ({ workItem: { id: 'LOOP-1' }, phaseOrder: ['testing'],
    phases: { testing: { id: 'testing', mcp: { requireSmoke: true, requiredServers: ['playwright'] } } },
    mcpAuthorizations: { playwright: { origins } }, resolution: { approvalAuthorities: {} } });
  const plan = targetOriginPlan(workflow(['http://localhost:5173']), 'http://localhost:5174', { revision: 'abc' });
  assert.deepEqual(plan.replaces, { playwright: ['http://localhost:5173'] });
  assert.deepEqual(plan.servers, ['playwright']);
  assert.throws(() => targetOriginPlan(workflow(['http://localhost:5173']), 'https://other.example.test', { revision: 'abc' }),
    (error) => error.code === 'STORY_TARGET_ORIGIN_ALREADY_PINNED' && /replaced only by the same loopback address on another port/u.test(error.message));
});
