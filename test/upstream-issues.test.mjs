import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideUpstreamIssue, discrepancyItemSha256, openUpstreamIssues, raiseUpstreamIssue, upstreamIssueAuthorities,
  upstreamIssueStates, upstreamIssueTerminalBlockers
} from '../src/upstream-issues.mjs';

const AT = '2026-10-12T00:00:00.000Z';
function story() {
  return { workItem: { id: 'UPI-STORY' }, status: 'in_progress', currentPhase: 'implementation',
    phaseOrder: ['specification', 'planning', 'implementation', 'verification'],
    phases: {
      specification: { id: 'specification', status: 'approved', generation: 1, approvalPolicy: { authorities: ['product'] },
        artifacts: [{ path: 'spec.md', sha256: 'a'.repeat(64) }] },
      planning: { id: 'planning', status: 'approved', generation: 2, approvalPolicy: { authorities: ['architects'], requiredAuthorities: ['leads'] } },
      implementation: { id: 'implementation', status: 'in_progress', generation: 1 },
      verification: { id: 'verification', status: 'not_started', generation: 0 }
    } };
}
const raise = (workflow, overrides = {}) => raiseUpstreamIssue(workflow, { phase: 'planning', about: 'AC-002',
  problem: 'The plan has no row for AC-002, so nothing tests it.', raisedBy: 'dev@example.test', at: AT, ...overrides });
const decide = (workflow, overrides = {}) => decideUpstreamIssue(workflow, { issue: 'UPI-001', outcome: 'dismiss',
  reason: 'AC-002 is covered by the regression suite already.', actor: 'lead@example.test', authorityGroup: 'architects', at: AT, ...overrides });

test('an issue is raised against an earlier step from the current one and never edits that step', () => {
  const workflow = story();
  const before = JSON.stringify(workflow.phases);
  const issue = raise(workflow, { authored: 'governed-agent', agent: 'developer', proposed: 'plan-correction' });
  assert.equal(issue.id, 'UPI-001');
  assert.deepEqual(issue.raisedIn, { phase: 'implementation', status: 'in_progress', generation: 1 });
  assert.equal(issue.producerGeneration, 2);
  assert.equal(JSON.stringify(workflow.phases), before);
  assert.equal(raise(workflow, { phase: 'specification' }).producerArtifacts[0].path, 'spec.md');
  assert.deepEqual(openUpstreamIssues(workflow).map(({ issue: entry }) => entry.id), ['UPI-001', 'UPI-002']);
  assert.deepEqual(upstreamIssueAuthorities(workflow, 'planning'), ['architects', 'leads']);
});

test('only an earlier step that ran can be raised against, with a real problem statement', () => {
  const workflow = story();
  assert.throws(() => raise(workflow, { phase: 'implementation' }), { code: 'UPSTREAM_ISSUE_NOT_EARLIER' });
  assert.throws(() => raise(workflow, { phase: 'verification' }), { code: 'UPSTREAM_ISSUE_NOT_EARLIER' });
  assert.throws(() => raise(workflow, { phase: 'nowhere' }), { code: 'UPSTREAM_ISSUE_INVALID' });
  const unrun = story();
  unrun.phases.planning = { ...unrun.phases.planning, status: 'not_started', generation: 0 };
  assert.throws(() => raise(unrun), { code: 'UPSTREAM_ISSUE_NOT_EARLIER' });
  assert.throws(() => raise(workflow, { problem: 'too short' }), { code: 'UPSTREAM_ISSUE_INVALID' });
  assert.throws(() => raise(workflow, { about: '' }), { code: 'UPSTREAM_ISSUE_INVALID' });
  assert.equal(workflow.upstreamIssues?.length ?? 0, 0);
});

test('decisions close an issue; a plan correction must be the earlier step\'s own, and an accepted risk expires', () => {
  const workflow = story();
  raise(workflow); raise(workflow, { about: 'REQ-001' }); raise(workflow, { about: 'AC-004' });
  assert.throws(() => decide(workflow, { outcome: 'plan-correction', link: 'PRC-001' }), { code: 'UPSTREAM_ISSUE_INVALID' });
  workflow.planAmendments = [{ kind: 'plan-row-correction', id: 'PRC-001', ownerPhase: 'specification', upstreamIssue: null },
    { kind: 'plan-row-correction', id: 'PRC-002', ownerPhase: 'planning', upstreamIssue: 'UPI-003' },
    { kind: 'plan-row-correction', id: 'PRC-003', ownerPhase: 'planning', upstreamIssue: null }];
  assert.throws(() => decide(workflow, { outcome: 'plan-correction', link: 'PRC-001' }), /corrects specification/u);
  assert.throws(() => decide(workflow, { outcome: 'plan-correction', link: 'PRC-002' }), /recorded for UPI-003/u);
  assert.equal(decide(workflow, { outcome: 'plan-correction', link: 'PRC-003' }).link, 'PRC-003');
  assert.throws(() => decide(workflow), { code: 'UPSTREAM_ISSUE_DECIDED' });
  // An amendment closes an issue only once that same step's approvers approved it.
  assert.throws(() => decide(workflow, { issue: 'UPI-002', outcome: 'amend', link: 'FAM-001' }), /approved forward amendment/u);
  workflow.forwardAmendments = [{ id: 'FAM-001', phase: 'planning' }, { id: 'FAM-002', phase: 'specification' }];
  workflow.forwardAmendmentDecisions = [{ amendment: 'FAM-002', decision: 'approved' }];
  assert.throws(() => decide(workflow, { issue: 'UPI-002', outcome: 'amend', link: 'FAM-001' }), /approved forward amendment/u);
  assert.throws(() => decide(workflow, { issue: 'UPI-002', outcome: 'amend', link: 'FAM-002' }), /amends specification/u);
  workflow.forwardAmendmentDecisions.push({ amendment: 'FAM-001', decision: 'approved' });
  assert.equal(decide(structuredClone(workflow), { issue: 'UPI-002', outcome: 'amend', link: 'FAM-001' }).link, 'FAM-001');
  assert.throws(() => decide(workflow, { issue: 'UPI-002', outcome: 'accept-risk' }), { code: 'UPSTREAM_ISSUE_RISK_EXPIRY_REQUIRED' });
  assert.throws(() => decide(workflow, { issue: 'UPI-002', outcome: 'accept-risk', expiresAt: '2027-03-01' }), { code: 'UPSTREAM_ISSUE_RISK_EXPIRY_REQUIRED' });
  assert.throws(() => decide(workflow, { issue: 'UPI-002', expiresAt: '2026-11-01' }), /only with --outcome accept-risk/u);
  assert.throws(() => decide(workflow, { issue: 'UPI-002', reason: 'no' }), { code: 'UPSTREAM_ISSUE_REASON_REQUIRED' });
  assert.throws(() => decide(workflow, { issue: 'UPI-002', outcome: 'return', link: null }), /change request/u);
  decide(workflow, { issue: 'UPI-002', outcome: 'accept-risk', expiresAt: '2026-11-01' });
  assert.deepEqual(openUpstreamIssues(workflow, AT).map(({ issue }) => issue.id), ['UPI-003']);
  // Once the risk lapses the issue is open again, and a fresh decision closes it.
  const later = '2026-11-02T00:00:00.000Z';
  assert.deepEqual(upstreamIssueStates(workflow, later).map((entry) => entry.status), ['decided', 'expired', 'open']);
  decide(workflow, { issue: 'UPI-002', outcome: 'dismiss', at: later });
  assert.deepEqual(openUpstreamIssues(workflow, later).map(({ issue }) => issue.id), ['UPI-003']);
});

test('completion names each open issue with the exact command its owners run', () => {
  const workflow = story();
  assert.deepEqual(upstreamIssueTerminalBlockers(workflow), []);
  raise(workflow);
  const [blocker] = upstreamIssueTerminalBlockers(workflow);
  assert.equal(blocker.code, 'UPSTREAM_ISSUES_OPEN');
  assert.match(blocker.message, /UPI-001 about planning \(AC-002\) is not decided/u);
  assert.match(blocker.command, /^singularity-flow upstream-issue decide UPI-001 --work-id UPI-STORY --outcome /u);
  decide(workflow);
  assert.deepEqual(upstreamIssueTerminalBlockers(workflow), []);
});

test('a recorded discrepancy has one digest however it is spaced', () => {
  assert.equal(discrepancyItemSha256('planning', 'a  b\n c'), discrepancyItemSha256('planning', 'a b c'));
  assert.notEqual(discrepancyItemSha256('planning', 'a b c'), discrepancyItemSha256('specification', 'a b c'));
});
