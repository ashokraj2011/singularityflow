/**
 * A criterion whose test was skipped in a run a step approver accepted could not execute any test
 * (`decision test-risk`) reads satisfied with an exception, never passed. A skip in any other
 * command's run, or with no accepted decision, still verifies nothing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateEvidence } from '../src/evidence/evaluate.mjs';
import { evidenceGraph } from '../src/evidence/graph.mjs';

const W = 'EV-2';
const AC1 = `${W}:AC-001`;
const policy = { mode: 'required', minimum: 1, authorities: ['reviewers'], requiredAuthorities: [] };
const approval = (login) => ({ decision: 'approved', actor: { login }, authorityGroup: 'reviewers', at: '2026-10-02T00:00:00Z' });

const story = () => ({
  workItem: { id: W, title: 'Skipped evidence fixture' }, status: 'in_progress', currentPhase: 'testing',
  phaseOrder: ['intake', 'implementation', 'testing'],
  resolution: { plannedClaims: { mode: 'required', clausePhases: ['intake'], owners: { implementation: 'intake' } } },
  phases: {
    intake: { id: 'intake', label: 'Intake', status: 'approved', generation: 1, approvalPolicy: policy, approvals: [approval('reviewerone')], requiredArtifact: { kind: 'requirements' } },
    implementation: { id: 'implementation', label: 'Code', status: 'approved', generation: 1, approvalPolicy: policy, approvals: [approval('reviewertwo')],
      generationPolicy: { task: 'code' }, requiredArtifact: { kind: 'implementation-summary' } },
    testing: { id: 'testing', label: 'Testing', status: 'in_progress', generation: 1, approvalPolicy: policy, approvals: [], requiredArtifact: { kind: 'test-evidence' } }
  }
});
const records = () => ({
  indexes: [{ workId: W, phase: 'intake', generation: 1, clauses: [{ id: AC1, type: 'AC', source: { path: 'intake.md', line: 5 }, bodySha256: 'a'.repeat(64), dependsOn: [] }] }],
  planned: [{ workId: W, phase: 'intake', generation: 1, kind: 'planned', claims: {
    [AC1]: { expectedPaths: ['src/value.mjs'], tests: ['test/value.test.js'], testDisposition: 'applicable', testReason: null } } }],
  observed: [{ workId: W, phase: 'implementation', generation: 1, kind: 'observed', claims: {
    [AC1]: { observedPaths: ['src/value.mjs'], testResults: ['test/value.test.js'], commits: [], verdict: 'matched' } } }],
  acceptance: []
});
const witness = {
  clauseId: AC1, testSource: 'test/value.test.js', profile: 'jest-static-v2', commandId: 'integration', resultAdapter: 'jest-json',
  identity: { framework: 'jest', suitePath: ['value'], name: 'reads the row' }, logicalTestId: 'sha256:reads', declarationSha256: 'b'.repeat(64),
  supportSha256: null, line: 3, parameters: null, skipped: false, exact: true, gaps: []
};
// The whole suite skipped itself: no database here. The run exited 0 and is recorded as failed.
const delivery = (recovery) => {
  const record = { attemptId: 'TA-0123456789abcdef0123', status: 'failed', exitCode: 0, terminal: true,
    tests: { discovered: 1, passed: 0, failed: 0, skipped: 1 },
    occurrences: [{ suitePath: ['value'], name: 'reads the row', outcome: 'skipped', durationMs: 0 }] };
  const bindings = [{ clauseId: AC1, testSource: witness.testSource }];
  return {
    phaseId: 'implementation', generation: 1, status: 'ready', testRecovery: recovery,
    acceptanceCriteria: { bindings, witnesses: [witness], unattachedTags: [] },
    receipt: { status: 'ready', traceability: { bindings: bindings.map((binding) => ({ ...binding, commandId: 'integration' })), witnesses: [witness], unattachedTags: [] } },
    executions: [{ commandId: 'integration', kind: 'test-execution', status: 'failed', record }],
    preflight: []
  };
};
const judge = (recovery) => {
  const evaluation = evaluateEvidence(evidenceGraph({ workflow: story(), records: records(), deliveries: [delivery(recovery)] }));
  return { row: evaluation.rows.find((entry) => entry.id === AC1), codes: evaluation.findings.map((entry) => entry.code) };
};
const accepted = (commandIds) => ({ disposition: 'accepted-risk', observedOutcome: 'unavailable', source: 'test-run-risk',
  decisions: ['TRR-001'], commandIds });

test('a skipped criterion in the accepted command run is an exception; anywhere else it verifies nothing', () => {
  const carried = judge(accepted(['integration']));
  assert.equal(carried.row.result, 'satisfied-with-exception');
  assert.ok(!carried.codes.includes('EVIDENCE_TEST_SKIPPED'), carried.codes.join(', '));

  const otherCommand = judge(accepted(['unit']));
  assert.equal(otherCommand.row.result, 'missing', 'a skip in a command the decision does not name is not carried');
  assert.ok(otherCommand.codes.includes('EVIDENCE_TEST_SKIPPED'));

  const noDecision = judge(null);
  assert.equal(noDecision.row.result, 'missing');
  assert.ok(noDecision.codes.includes('EVIDENCE_TEST_SKIPPED'));

  // A test-recovery acceptance of an observed failure does not carry a skipped criterion this way.
  const recovery = judge({ disposition: 'accepted-risk', observedOutcome: 'failed' });
  assert.equal(recovery.row.result, 'missing');
});
