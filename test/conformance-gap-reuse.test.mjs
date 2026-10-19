import assert from 'node:assert/strict';
import test from 'node:test';

import { conformanceGapDecisions, conformanceGapRefusal } from '../src/upstream-routes.mjs';
import { inspectConformanceVerdictAdvisories, verdictSummaryBlock } from '../src/conformance-readiness.mjs';

const workflow = {
  workItem: { id: 'BIN-501' },
  phaseOrder: ['specification', 'implementation', 'verification', 'release'],
  phases: {
    specification: { id: 'specification', status: 'approved', order: 0 },
    implementation: { id: 'implementation', status: 'approved', order: 1, writeScope: 'source-and-artifact', generation: { task: 'code' } },
    verification: { id: 'verification', status: 'approved', order: 2 },
    release: { id: 'release', status: 'awaiting_approval', order: 3 }
  },
  upstreamIssues: [],
  upstreamIssueDecisions: []
};

// The view `activeEvidenceReuse` returns for an approved, still-bound decision.
const reuse = {
  id: 'ERU-001', phase: 'verification', state: 'active', attemptId: 'TA-bbef1890ef2f7ef6828b', recordedBy: 'implementation',
  clauses: ['BIN-501:REQ-001', 'BIN-501:REQ-002'], runByThisStep: false, expiresAt: null,
  label: 'reused: TA-bbef1890ef2f7ef6828b recorded by implementation at 2dd03049408a; approved for verification by a reviewer (ERU-001), not a run by verification'
};

const gaps = [
  { clauseId: 'BIN-501:REQ-001', verdict: 'partial', line: 3 },
  { clauseId: 'BIN-501:AC-001', verdict: 'partial', line: 5 }
];

test('an approved evidence reuse decides the gaps of the clauses it covers, labelled as the earlier step\'s run', () => {
  const [covered, open] = conformanceGapDecisions(workflow, 'release', gaps, { reused: [reuse] });
  assert.equal(covered.status, 'decided');
  assert.equal(covered.issue, 'ERU-001');
  assert.equal(covered.outcome, 'evidence-reuse');
  assert.match(covered.reuse, /recorded by implementation .*not a run by verification/u);
  assert.equal(open.status, 'unraised', 'a clause the reused run does not cover still needs a person\'s decision');
});

test('approval and the gate stay refused for the uncovered clause only', () => {
  const refusal = conformanceGapRefusal(workflow, 'release', gaps, { reused: [reuse] });
  assert.deepEqual(refusal.gaps.map((gap) => gap.clauseId), ['BIN-501:AC-001']);
  assert.equal(conformanceGapRefusal(workflow, 'release', gaps.slice(0, 1), { reused: [reuse] }), null);
  assert.equal(conformanceGapRefusal(workflow, 'release', gaps.slice(0, 1)).gaps.length, 1, 'without the reuse the gap is open');
});

test('the advisory and the verdict summary say the gap is covered by reuse, never that this step ran tests', () => {
  const report = [
    '| Clause | Evidence | Verdict |', '|---|---|---|',
    '| `BIN-501:REQ-001` | implementation run | partial — no Verification run recorded |',
    '| `BIN-501:AC-001` | screenshot | partial — visual review pending |'
  ].join('\n');
  const advisories = inspectConformanceVerdictAdvisories(report, { workflow, phaseId: 'release', reused: [reuse] })
    .filter((entry) => entry.code === 'conformance.verdict-incomplete');
  const byClause = Object.fromEntries(advisories.map((entry) => [entry.clauseId, entry]));
  assert.equal(byClause['BIN-501:REQ-001'].requiredBefore, null);
  assert.equal(byClause['BIN-501:AC-001'].requiredBefore, 'approve');
  const block = verdictSummaryBlock(report, workflow, 'release', { reused: [reuse] });
  assert.match(block, /`BIN-501:REQ-001`: partial; covered by ERU-001: reused: TA-bbef1890ef2f7ef6828b recorded by implementation/u);
  assert.doesNotMatch(block, /verification ran|tests passed/iu);
});
