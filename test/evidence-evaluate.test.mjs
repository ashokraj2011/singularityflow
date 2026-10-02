import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateEvidence } from '../src/evidence/evaluate.mjs';
import { evidenceGraph } from '../src/evidence/graph.mjs';
import { COMPLETION_LABELS, lifecycleWords } from '../src/evidence/labels.mjs';
import { matrixCsv, matrixPage, matrixText } from '../src/evidence/matrix.mjs';
import { obligationId } from '../src/evidence/vocabulary.mjs';

const W = 'EV-1';
const REQ = `${W}:REQ-001`;
const AC1 = `${W}:AC-001`;
const AC2 = `${W}:AC-002`;
const approval = (login, extra = {}) => ({ decision: 'approved', actor: { login }, authorityGroup: 'reviewers', at: '2026-10-02T00:00:00Z', ...extra });
const policy = { mode: 'required', minimum: 1, authorities: ['reviewers'], requiredAuthorities: [] };

function story({ code = 'approved', status = 'in_progress', currentPhase = 'testing', codeApprovals = [approval('bob')], ids = {} } = {}) {
  const intake = ids.intake ?? 'intake';
  const implementation = ids.implementation ?? 'implementation';
  const testing = ids.testing ?? 'testing';
  return {
    workItem: { id: W, title: 'Evidence fixture' },
    status, currentPhase,
    phaseOrder: [intake, implementation, testing],
    resolution: { plannedClaims: { mode: 'required', clausePhases: [intake], owners: { [implementation]: intake } } },
    phases: {
      [intake]: { id: intake, label: 'Intake', status: 'approved', generation: 1, approvalPolicy: policy, approvals: [approval('alice')], requiredArtifact: { kind: 'requirements' } },
      [implementation]: {
        id: implementation, label: 'Code', status: code, generation: 1, approvalPolicy: policy, approvals: codeApprovals,
        generationPolicy: { task: 'code' }, requiredArtifact: { kind: 'implementation-summary' }
      },
      [testing]: { id: testing, label: 'Testing', status: currentPhase === testing ? 'in_progress' : 'approved', generation: 1, approvalPolicy: policy, approvals: [], requiredArtifact: { kind: 'test-evidence' } }
    }
  };
}

function records({ ids = {}, ac2Tests = ['test/two.test.mjs'], ac2Disposition = 'applicable', observed = true } = {}) {
  const intake = ids.intake ?? 'intake';
  const implementation = ids.implementation ?? 'implementation';
  const clause = (id, type, line, dependsOn = []) => ({ id, type, source: { path: 'intake.md', line }, bodySha256: 'a'.repeat(64), dependsOn });
  return {
    indexes: [{ workId: W, phase: intake, generation: 1, clauses: [clause(REQ, 'REQ', 3), clause(AC1, 'AC', 5, [REQ]), clause(AC2, 'AC', 6)] }],
    planned: [{
      workId: W, phase: intake, generation: 1, kind: 'planned', claims: {
        [REQ]: { expectedPaths: ['src/value.mjs'], tests: [], testDisposition: 'unspecified', testReason: null },
        [AC1]: { expectedPaths: ['src/value.mjs'], tests: ['test/one.test.mjs'], testDisposition: 'applicable', testReason: null },
        [AC2]: ac2Disposition === 'not-applicable'
          ? { expectedPaths: ['src/config.json'], tests: [], testDisposition: 'not-applicable', testReason: 'configuration only' }
          : { expectedPaths: ['src/value.mjs'], tests: ac2Tests, testDisposition: 'applicable', testReason: null }
      }
    }],
    observed: observed ? [{
      workId: W, phase: implementation, generation: 1, kind: 'observed', claims: {
        [REQ]: { observedPaths: ['src/value.mjs'], testResults: [], commits: [], verdict: 'matched' },
        [AC1]: { observedPaths: ['src/value.mjs'], testResults: ['test/one.test.mjs'], commits: [], verdict: 'matched' },
        [AC2]: { observedPaths: [ac2Disposition === 'not-applicable' ? 'src/config.json' : 'src/value.mjs'], testResults: ac2Tests, commits: [], verdict: 'matched' }
      }
    }] : [],
    acceptance: []
  };
}

function delivery({ implementation = 'implementation', tests = { discovered: 2, passed: 2, failed: 0, skipped: 0 }, status = 'passed', recovery = null, ready = true } = {}) {
  return {
    phaseId: implementation, generation: 1, status: ready ? 'ready' : 'pending-tests',
    testRecovery: recovery,
    acceptanceCriteria: { bindings: [{ clauseId: AC1, testSource: 'test/one.test.mjs' }, { clauseId: AC2, testSource: 'test/two.test.mjs' }] },
    receipt: ready ? {
      status: 'ready',
      traceability: { bindings: [
        { clauseId: AC1, testSource: 'test/one.test.mjs', commandId: 'unit' },
        { clauseId: AC2, testSource: 'test/two.test.mjs', commandId: 'unit' }
      ] }
    } : { status: 'pending-tests', traceability: { bindings: [] } },
    executions: ready ? [{ commandId: 'unit', kind: 'test-execution', status, record: { status, tests } }] : []
  };
}

const evaluate = (parts, options) => evaluateEvidence(evidenceGraph(parts), options);
const row = (evaluation, id) => evaluation.rows.find((entry) => entry.id === id);

test('a delivered, tested and approved criterion is satisfied at module-observed assurance, never at more', () => {
  const evaluation = evaluate({ workflow: story(), records: records(), deliveries: [delivery()] });
  assert.equal(row(evaluation, AC1).result, 'satisfied');
  assert.equal(row(evaluation, AC1).assurance, 'module-observed');
  const verify = row(evaluation, AC1).obligations.find((entry) => entry.responsibility === 'verify');
  assert.deepEqual(verify.facets, {
    coverage: 'linked', execution: 'passed', assurance: 'module-observed', review: 'approved', freshness: 'current', exception: 'none'
  });
  assert.equal(row(evaluation, REQ).result, 'satisfied');
  assert.deepEqual(row(evaluation, REQ).verification.criteria, [AC1], 'a requirement is verified through the criteria that depend on it');
  assert.equal(evaluation.summary.assuranceFloor, 'module-observed');
  assert.equal(evaluation.decision.gate, 'allow');
  assert.equal(evaluation.completion.label, COMPLETION_LABELS.incomplete, 'a view never calls an in-flight Story complete');
});

test('a skipped test makes the criterion inconclusive, not covered', () => {
  const evaluation = evaluate({
    workflow: story(), records: records(),
    deliveries: [delivery({ tests: { discovered: 3, passed: 2, failed: 0, skipped: 1 } })]
  });
  assert.equal(row(evaluation, AC1).result, 'inconclusive');
  assert.equal(row(evaluation, AC1).assurance, 'declared');
  assert.ok(evaluation.findings.some((entry) => entry.code === 'EVIDENCE_TESTS_SKIPPED' && entry.message.includes(AC1)));
  assert.equal(evaluation.decision.gate, 'block');
});

test('a failed command fails the criterion unless a governed risk decision accepted it, and the observation stays failed', () => {
  const failed = evaluate({ workflow: story(), records: records(), deliveries: [delivery({ status: 'failed', tests: { discovered: 2, passed: 1, failed: 1, skipped: 0 } })] });
  assert.equal(row(failed, AC1).result, 'failed');
  assert.equal(failed.decision.gate, 'block');

  const accepted = evaluate({
    workflow: story(), records: records(),
    deliveries: [delivery({ status: 'failed', tests: { discovered: 2, passed: 1, failed: 1, skipped: 0 }, recovery: { disposition: 'accepted-risk', observedOutcome: 'failed' } })]
  });
  const verify = row(accepted, AC1).obligations.find((entry) => entry.responsibility === 'verify');
  assert.equal(row(accepted, AC1).result, 'satisfied-with-exception');
  assert.equal(verify.facets.execution, 'failed', 'the exception never rewrites what was observed');
  assert.equal(verify.facets.exception, 'accepted-risk');
  assert.equal(accepted.decision.gate, 'allow-with-risk');
});

test('a reviewed not-applicable test is an exception the matrix shows, not a pass', () => {
  const evaluation = evaluate({ workflow: story(), records: records({ ac2Disposition: 'not-applicable', ac2Tests: [] }), deliveries: [delivery()] });
  assert.equal(row(evaluation, AC2).result, 'satisfied-with-exception');
  assert.equal(row(evaluation, AC2).obligations.find((entry) => entry.responsibility === 'verify').facets.exception, 'not-applicable');
});

test('in-flight work is pending; work a finished step should have delivered is missing', () => {
  const inFlight = evaluate({
    workflow: story({ code: 'in_progress', currentPhase: 'implementation', codeApprovals: [] }),
    records: records({ observed: false }), deliveries: []
  });
  assert.equal(row(inFlight, AC1).result, 'pending');
  assert.equal(inFlight.lifecycle.words, 'In progress at Code');

  const untagged = delivery();
  untagged.receipt.traceability.bindings = untagged.receipt.traceability.bindings.filter((binding) => binding.clauseId !== AC2);
  const missing = evaluate({ workflow: story(), records: records(), deliveries: [untagged] });
  assert.equal(row(missing, AC2).result, 'missing');
  assert.ok(missing.findings.some((entry) => entry.code === 'EVIDENCE_WITNESS_MISSING' && entry.message.includes(AC2)));
});

test('zero criteria, a cancelled Story or a closed one with no final evaluation never reads complete', () => {
  const empty = evaluate({ workflow: story(), records: { indexes: [], planned: [], observed: [] }, deliveries: [] });
  assert.equal(empty.decision.gate, 'block');
  assert.ok(empty.findings.some((entry) => entry.code === 'EVIDENCE_NO_CRITERIA'));
  assert.equal(empty.completion.label, COMPLETION_LABELS.incomplete);

  const cancelled = evaluate({ workflow: story({ status: 'cancelled', currentPhase: null }), records: records(), deliveries: [delivery()] });
  assert.equal(cancelled.lifecycle.words, 'Cancelled');
  assert.equal(cancelled.completion.label, COMPLETION_LABELS.incomplete);
  assert.ok(cancelled.completion.reasons.includes('the Story was cancelled'));

  const closed = evaluate({ workflow: story({ status: 'complete', currentPhase: null }), records: records(), deliveries: [delivery()] });
  assert.equal(closed.lifecycle.words, 'Every step decided');
  assert.equal(closed.completion.label, COMPLETION_LABELS.notEvaluated);
});

test('only a decision-mode terminal evaluation that allows the end can produce the Complete labels', () => {
  const parts = { workflow: story({ status: 'complete', currentPhase: null }), records: records(), deliveries: [delivery()] };
  const terminal = { mode: 'decision', boundary: 'terminal', decision: { gate: 'allow' } };
  assert.equal(evaluate({ ...parts, terminal }).completion.label, COMPLETION_LABELS.complete);
  assert.equal(evaluate({ ...parts, terminal: { ...terminal, mode: 'projection' } }).completion.label, COMPLETION_LABELS.notEvaluated);
  assert.equal(evaluate({ ...parts, terminal: { ...terminal, decision: { gate: 'allow-with-risk' } } }).completion.label, COMPLETION_LABELS.completeWithExceptions);
  assert.equal(evaluate({ ...parts, records: { indexes: [], planned: [], observed: [] }, terminal }).completion.label, COMPLETION_LABELS.incomplete,
    'zero obligations is never Complete');
});

test('self-approval is shown on the review facet, and evidence that cannot be trusted makes every row inconclusive', () => {
  const self = evaluate({ workflow: story({ codeApprovals: [approval('bob', { selfApproval: true })] }), records: records(), deliveries: [delivery()] });
  assert.equal(row(self, AC1).obligations.find((entry) => entry.responsibility === 'review').facets.review, 'self-approved');

  const untrusted = evaluate({
    workflow: story(), records: records(), deliveries: [delivery()], untrusted: true,
    findings: [{ code: 'EVIDENCE_RECORDS_UNTRUSTED', category: 'records', blocking: true, obligationIds: [], message: 'binding mismatch' }]
  });
  assert.ok(untrusted.rows.every((entry) => entry.result === 'inconclusive'));
  assert.equal(untrusted.decision.gate, 'block');
});

test('renaming every step leaves every obligation ID unchanged', () => {
  const ids = { intake: 'scope', implementation: 'build', testing: 'check' };
  const renamed = evaluate({ workflow: story({ ids, currentPhase: 'check' }), records: records({ ids }), deliveries: [delivery({ implementation: 'build' })] });
  const original = evaluate({ workflow: story(), records: records(), deliveries: [delivery()] });
  const idsOf = (evaluation) => evaluation.rows.flatMap((entry) => entry.obligations.map((obligation) => obligation.id));
  assert.deepEqual(idsOf(renamed), idsOf(original));
  assert.deepEqual(renamed.rows.map((entry) => entry.result), original.rows.map((entry) => entry.result));
  assert.equal(obligationId(W, 'verify', AC1), 'OBL:EV-1:verify:AC-001');
});

test('the matrix pages, filters by row, result and facet, and renders the same rows to text and CSV', () => {
  const evaluation = evaluate({ workflow: story(), records: records(), deliveries: [delivery({ tests: { discovered: 3, passed: 2, failed: 0, skipped: 1 } })] });
  const all = matrixPage(evaluation, { pageSize: 2 });
  assert.equal(all.pages, 2);
  assert.equal(all.rows.length, 2);
  assert.deepEqual(matrixPage(evaluation, { row: 'AC-002' }).rows.map((entry) => entry.id), [AC2]);
  assert.deepEqual(matrixPage(evaluation, { result: 'inconclusive' }).rows.map((entry) => entry.id), [AC1, AC2]);
  assert.deepEqual(matrixPage(evaluation, { facet: 'execution=passed-with-skips' }).rows.map((entry) => entry.id), [AC1, AC2]);
  assert.throws(() => matrixPage(evaluation, { facet: 'colour=red' }), /--facet must name one of/);
  assert.throws(() => matrixPage(evaluation, { row: 'AC-404' }), /No row AC-404/);
  const text = matrixText({ evaluation, page: matrixPage(evaluation) });
  assert.match(text, /Evidence matrix — EV-1: Evidence fixture/);
  assert.match(text, /tag · 1 skipped/);
  assert.match(text, /Completion: Incomplete — verification pending or insufficient \(2 inconclusive\)/);
  assert.match(text, /no test-case result is joined to a criterion yet/);
  const csv = matrixCsv(matrixPage(evaluation).rows).split('\n');
  assert.equal(csv.length, 4);
  assert.match(csv[2], /^"EV-1:AC-001","AC",".*","inconclusive","declared"/);
});

test('lifecycle words never claim completion', () => {
  assert.equal(lifecycleWords({ status: 'in_progress', currentPhase: null, pendingDecision: { label: 'Ship it?' } }), 'Waiting for a decision: Ship it?');
  assert.equal(lifecycleWords({ status: 'not_started', currentPhase: null }), 'Not started');
});
