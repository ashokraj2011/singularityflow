import assert from 'node:assert/strict';
import test from 'node:test';
import { agentAct } from '../src/agent-output.mjs';
import { approvalHoldOwner } from '../src/approval-check.mjs';
import { loadApprovalPacket } from '../src/commands/approval-packet.mjs';
import { accountedAmendmentPaths, planAmendmentRecord, recordPlanAmendment } from '../src/plan-amendments.mjs';
import { evaluateSpecCoverage } from '../src/specifications.mjs';

const clauseId = 'TEST-ONLY:AC-001';
const original = { expectedPaths: [], tests: ['src/components/Graph.test.jsx'], fulfillment: 'test-only' };
const amend = (workflow, path) => recordPlanAmendment(workflow, {
  changes: [{ kind: 'add-location', clauseId, path }], reason: 'The test setup repairs browser storage for the approved graph regression.',
  actor: 'reviewer@example.invalid', authorityGroup: 'plan-reviewers', at: '2026-11-02T00:00:00.000Z', plan: { [clauseId]: original }
});

test('a plan approver can account for a test-only setup path without changing the clause or claiming execution', () => {
  const workflow = { workItem: { id: 'TEST-ONLY' }, phaseOrder: ['design', 'build'],
    resolution: { plannedClaims: { owners: { build: 'design' } } }, phases: { design: { generation: 1 } } };
  const before = structuredClone(original);
  const amendment = amend(workflow, 'src/test/setup.js');
  assert.equal(amendment.id, 'PAM-001');
  const record = planAmendmentRecord(workflow);
  assert.deepEqual(accountedAmendmentPaths([record]), ['src/test/setup.js']);
  assert.deepEqual(record.claims, {}, 'accounting neither creates a requirement nor certifies a test');
  assert.deepEqual(original, before);
  const records = { indexes: [{ clauses: [{ id: clauseId, type: 'AC' }] }],
    planned: [{ phase: 'design', generation: 1, claims: { [clauseId]: original } }, record],
    observed: [{ phase: 'build', generation: 1, claims: { [clauseId]: {
      observedPaths: [], testResults: ['src/components/Graph.test.jsx'], commits: [], verdict: 'matched'
    } } }] };
  const coverage = evaluateSpecCoverage(records, ['src/components/Graph.test.jsx', 'src/test/setup.js'], { mode: 'enforce', coverage: 'enforce' });
  assert.deepEqual(coverage.unclaimedChangedPaths, []);
  assert.deepEqual(coverage.unimplemented, []);
  assert.equal(coverage.complete, true);
  const noExecution = evaluateSpecCoverage({ ...records, observed: [] }, ['src/test/setup.js'], { mode: 'enforce', coverage: 'enforce' });
  assert.equal(noExecution.complete, false, 'an amendment alone cannot substitute for the primary test');
});

test('test-only accounting never admits product files or invalid paths', () => {
  for (const file of ['src/Graph.jsx', 'src/contests/value.js', 'src/test/*.js', '../test/setup.js', '/test/setup.js', 'C:\\test\\setup.js', 'C:test/setup.js']) {
    const workflow = {};
    assert.throws(() => amend(workflow, file), { code: 'PLAN_AMENDMENT_INVALID' });
    assert.equal(workflow.planAmendments, undefined);
  }
});

test('a scope-only approval hold belongs to plan authority; incomplete delivery still belongs to its author', () => {
  const coverage = { unclaimedChangedPaths: ['src/test/setup.js'], unimplemented: [], withdrawnButClaimed: [], invalidEvidence: [] };
  const error = coverage => ({ code: 'SPEC_COVERAGE_INCOMPLETE', details: { coverage } });
  assert.equal(approvalHoldOwner(error(coverage)), 'someone-decides');
  for (const key of ['unimplemented', 'withdrawnButClaimed', 'invalidEvidence']) {
    assert.equal(approvalHoldOwner(error({ ...coverage, [key]: ['unresolved'] })), 'author-repairs');
  }
  assert.equal(approvalHoldOwner(error({ unclaimedChangedPaths: ['src/test/setup.js'] })), 'author-repairs', 'missing facts are not a verified scope-only hold');
});

test('known approval holds return an exact decision-list route without creating a receipt or reading documents', async () => {
  const holds = [{ code: 'SPEC_COVERAGE_INCOMPLETE', owner: 'someone-decides', action: { command: 'singularity-flow decision plan TEST-ONLY --add-location <clause>=src/test/setup.js --reason <why>' } }];
  const readiness = { classification: 'already-submitted', approvalCheck: { ready: false, holds }, owedDecisions: [{ clause: clauseId, method: 'visual' }] };
  const calls = [];
  const result = await loadApprovalPacket({ workId: 'TEST-ONLY', cwd: '/fixture', fetch: true }, { runStep: async argv => {
    calls.push(argv); return { ok: true, value: readiness };
  } });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['status', 'TEST-ONLY', '--submission-readiness', '--json']);
  assert.equal(result.begun, false);
  assert.equal(result.approvalPacket.review, null);
  assert.equal(result.approvalPacket.readiness, readiness);
  const act = agentAct(result);
  assert.equal(act.state, 'blocked');
  assert.equal(act.do.copilot, '/sf-decide TEST-ONLY');
  assert.equal(act.do.shell, 'singularity-flow decisions TEST-ONLY --for-agent --json');
  assert.equal(act.do.vscode, null);
  assert.ok(act.read.includes('approvalPacket.readiness.owedDecisions'));
  assert.match(act.said, /Only approvalCheck\.holds block this approval; report owed items separately/);
});

test('ready approval still loads and binds its receipt and exact documents, without granting approval', async () => {
  const calls = [];
  const values = [{ classification: 'already-submitted', approvalCheck: { ready: true, holds: [] },
    owedDecisions: [{ clause: clauseId, method: 'visual', holdsApproval: false }] },
    { token: 'receipt', approvalContext: { phase: 'build' } }, { reviewBinding: { generation: 1 } }];
  const result = await loadApprovalPacket({ workId: 'TEST-ONLY', cwd: '/fixture', fetch: true }, { runStep: async argv => {
    calls.push(argv); return { ok: true, value: values[calls.length - 1] };
  } });
  assert.deepEqual(calls, [['status', 'TEST-ONLY', '--submission-readiness', '--json'],
    ['choices', 'begin', 'approve', 'TEST-ONLY', '--fetch', '--json'], ['phase', 'show', 'build', '--for-agent', '--json']]);
  assert.equal(result.token, 'receipt');
  assert.deepEqual(result.approvalPacket.review, values[2]);
  assert.equal(calls.some(argv => argv[0] === 'approve' || argv[1] === 'answer'), false);
});

test('terminal obligations and pending decisions still stop before an approval receipt', async () => {
  for (const classification of ['terminal-obligations-required', 'decisions-required']) {
    let calls = 0;
    const result = await loadApprovalPacket({ workId: 'TEST-ONLY', cwd: '/fixture' }, { runStep: async () => {
      calls++; return { ok: true, value: { classification } };
    } });
    assert.equal(calls, 1);
    assert.equal(result.reason, classification);
    assert.equal(result.begun, false);
  }
});
