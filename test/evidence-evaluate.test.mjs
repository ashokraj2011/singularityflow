import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateEvidence } from '../src/evidence/evaluate.mjs';
import { evidenceGraph } from '../src/evidence/graph.mjs';
import { COMPLETION_LABELS, lifecycleWords } from '../src/evidence/labels.mjs';
import { matrixCsv, matrixMarkdown, matrixPage, matrixText } from '../src/evidence/matrix.mjs';
import { storyPullRequestBody } from '../src/pull-request.mjs';
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

/** A tagged file in a module whose runner only counts tests: it can reach module-observed. */
const countsWitness = (clauseId, testSource) => ({
  clauseId, testSource, profile: 'module-counts-v1', commandId: 'unit', identity: null, logicalTestId: null, gaps: ['ADAPTER_COUNTS_ONLY']
});
/** The exact Jest test a tag sits on: it can reach exact-local-observed. */
const jestWitness = (clauseId, name, { suitePath = ['value'], gaps = [], parameters = null } = {}) => ({
  clauseId, testSource: 'test/value.test.js', profile: 'jest-static-v2', commandId: 'unit', resultAdapter: 'jest-json',
  identity: { framework: 'jest', suitePath, name }, logicalTestId: `sha256:${name}`, declarationSha256: 'b'.repeat(64),
  supportSha256: null, line: 3, parameters, skipped: false, exact: gaps.length === 0, gaps
});
const occurrence = (name, outcome = 'passed', extra = {}) => ({ suitePath: ['value'], name, outcome, durationMs: 1, ...extra });
const MODULE_WITNESSES = [countsWitness(AC1, 'test/one.test.mjs'), countsWitness(AC2, 'test/two.test.mjs')];

function delivery({
  implementation = 'implementation', tests = { discovered: 2, passed: 2, failed: 0, skipped: 0 }, status = 'passed', recovery = null, ready = true,
  witnesses = MODULE_WITNESSES, occurrences = [], unattachedTags = []
} = {}) {
  const bindings = [...new Map(witnesses.map((entry) => [`${entry.clauseId} ${entry.testSource}`, { clauseId: entry.clauseId, testSource: entry.testSource }])).values()];
  const record = { attemptId: 'TA-0123456789abcdef0123', status, exitCode: status === 'passed' ? 0 : 1, terminal: true, tests, occurrences };
  return {
    phaseId: implementation, generation: 1, status: ready ? 'ready' : 'pending-tests',
    testRecovery: recovery,
    acceptanceCriteria: { bindings, witnesses, unattachedTags },
    receipt: ready ? {
      status: 'ready',
      traceability: { bindings: bindings.map((binding) => ({ ...binding, commandId: 'unit' })), witnesses, unattachedTags }
    } : { status: 'pending-tests', traceability: { bindings: [] } },
    executions: ready ? [{ commandId: 'unit', kind: 'test-execution', status, record }] : [],
    preflight: ready ? [] : [{ commandId: 'unit', record: { ...record, purpose: 'preflight' } }]
  };
}

const evaluate = (parts, options) => evaluateEvidence(evidenceGraph(parts), options);
const row = (evaluation, id) => evaluation.rows.find((entry) => entry.id === id);

test('a test-only requirement has linked delivery trace without counting that trace as test execution', () => {
  const maps = records();
  maps.planned[0].claims[REQ] = { expectedPaths: [], tests: ['test/one.test.mjs'], fulfillment: 'test-only' };
  maps.observed[0].claims[REQ] = { observedPaths: [], testResults: ['test/one.test.mjs'], verdict: 'matched' };
  const result = evaluate({ workflow: story({ code: 'in_progress' }), records: maps, deliveries: [] });
  const implementation = row(result, REQ).obligations.find((entry) => entry.responsibility === 'implement');
  assert.equal(implementation.status, 'met');
  assert.equal(implementation.fulfillment, 'test-only');
  assert.equal(implementation.facets.coverage, 'linked');
  assert.equal(row(result, AC1).obligations.find((entry) => entry.responsibility === 'verify').facets.execution, 'not-run');
  assert.notEqual(result.decision.gate, 'allow', 'test-file trace must not waive required execution');
  maps.observed[0].claims[REQ].testResults = ['test/other.test.mjs'];
  const wrong = row(evaluate({ workflow: story(), records: maps, deliveries: [] }), REQ)
    .obligations.find((entry) => entry.responsibility === 'implement');
  assert.notEqual(wrong.status, 'met');
  assert.equal(wrong.facets.coverage, 'unlinked');
});

test('approved inspection must cite the exact criterion, not another Story or a longer identifier', () => {
  const phase = id => ({ id, status: 'approved', generation: 1, approvalPolicy: policy, approvals: [approval('alice')] });
  const workflow = { workItem: { id: W }, status: 'closed', currentPhase: null,
    phaseOrder: ['spec', 'build', 'review'], phases: { spec: phase('spec'), build: phase('build'), review: phase('review') },
    resolution: { obligationGraph: { nodes: [
      { id: 'spec', responsibilities: ['scope', 'plan'] }, { id: 'build', responsibilities: ['implement'] },
      { id: 'review', responsibilities: ['verify', 'review'] }
    ] } } };
  const records = { indexes: [{ phase: 'spec', generation: 1,
    clauses: [{ id: AC1, type: 'AC', bodySha256: 'a'.repeat(64) }] }], planned: [], observed: [] };
  for (const [text, expected] of [[`Reviewed OTHER-${AC1} only.`, 'missing'],
    [`Reviewed ${AC1}0.`, 'missing'], [`Reviewed ${AC1}-OTHER.`, 'missing'],
    [`Reviewed [${AC1}].`, 'satisfied'], [`Reviewed ${AC1.toLowerCase()}.`, 'satisfied']]) {
    const result = evaluate({ workflow, records, inspections: [{ phaseId: 'review', text }] });
    assert.equal(row(result, AC1).result, expected, text);
    assert.equal(result.decision.gate, expected === 'satisfied' ? 'allow' : 'block');
  }
});

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

  const missing = evaluate({ workflow: story(), records: records(), deliveries: [delivery({ witnesses: [countsWitness(AC1, 'test/one.test.mjs')] })] });
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

  const closed = evaluate({ workflow: story({ status: 'closed', currentPhase: null }), records: records(), deliveries: [delivery()] });
  assert.equal(closed.lifecycle.words, 'Every step decided');
  assert.equal(closed.completion.label, COMPLETION_LABELS.notEvaluated);
});

test('only a decision-mode terminal evaluation that allows the end can produce the Complete labels', () => {
  const parts = { workflow: story({ status: 'closed', currentPhase: null }), records: records(), deliveries: [delivery()] };
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
  assert.match(text, /"exact-local-observed" means the criterion's own test was found passing/);
  const csv = matrixCsv(matrixPage(evaluation).rows).split('\n');
  assert.equal(csv.length, 4);
  assert.match(csv[2], /^"EV-1:AC-001","AC",".*","inconclusive","declared"/);
});

test('the pull request summary repeats the evaluation and claims nothing beyond it', () => {
  const evaluation = evaluate({ workflow: story(), records: records(), deliveries: [delivery({ tests: { discovered: 3, passed: 2, failed: 0, skipped: 1 } })] });
  const summary = matrixMarkdown(evaluation, { limit: 2 });
  assert.match(summary, /^- Completion: \*\*Incomplete — verification pending or insufficient\*\* \(2 inconclusive\)/);
  assert.match(summary, /- Lifecycle: In progress at Testing/);
  assert.match(summary, /- Rows: 3 — 2 inconclusive · 1 satisfied/);
  assert.match(summary, /- Assurance floor: .*; 0 criterion row\(s\) joined to an exact test result; 2 rest on a module test command/);
  assert.match(summary, /- Open obligations \(2\):\n  - `OBL:EV-1:verify:AC-001` is inconclusive\n  - `OBL:EV-1:verify:AC-002` is inconclusive/);
  assert.doesNotMatch(summary, /all tests passed|requirements satisfied/i);
  const body = storyPullRequestBody(story(), null, { evidence: summary });
  assert.match(body, /### Evidence\n\n- Completion: \*\*Incomplete/);
  assert.match(storyPullRequestBody(story(), null, {}), /### Evidence\n\n_The evidence matrix could not be evaluated for this preview\._/);
});

test('an exact test verifies its criterion only through its own result, at exact-local-observed', () => {
  const evaluation = evaluate({
    workflow: story(), records: records(),
    deliveries: [delivery({ witnesses: [jestWitness(AC1, 'adds'), countsWitness(AC2, 'test/two.test.mjs')], occurrences: [occurrence('adds'), occurrence('subtracts')] })]
  });
  const verify = row(evaluation, AC1).obligations.find((entry) => entry.responsibility === 'verify');
  assert.equal(row(evaluation, AC1).result, 'satisfied');
  assert.equal(row(evaluation, AC1).assurance, 'exact-local-observed');
  assert.deepEqual(verify.assuranceFacets, { identity: 'source-bound', execution: 'exact-local-observed' });
  assert.equal(verify.requiredAssurance, 'exact-local-observed', 'D2: the strongest the module runner can reach');
  assert.equal(row(evaluation, AC1).verification.association, 'exact-test');
  assert.deepEqual(row(evaluation, AC1).verification.witnesses.map((entry) => [entry.test, entry.outcome, entry.attemptId]),
    [["'value › adds' in test/value.test.js", 'passed', 'TA-0123456789abcdef0123']]);
  assert.equal(row(evaluation, AC2).assurance, 'module-observed', 'a counts-only module stays at module-observed');
  assert.deepEqual(row(evaluation, AC2).obligations.find((entry) => entry.responsibility === 'verify').assuranceFacets,
    { identity: 'declared', execution: 'module-observed' });
  assert.equal(evaluation.summary.testCaseResults, '1 criterion row(s) joined to an exact test result; 1 rest on a module test command');
  assert.equal(evaluation.summary.assuranceFloor, 'module-observed');
  assert.match(matrixText({ evaluation, page: matrixPage(evaluation) }), /exact test · passed/);
});

test('a tagged file with unrelated passing tests does not satisfy an exact criterion (E2G #7)', () => {
  const unrelated = evaluate({
    workflow: story(), records: records(),
    deliveries: [delivery({ witnesses: [jestWitness(AC1, 'adds'), countsWitness(AC2, 'test/two.test.mjs')], occurrences: [occurrence('subtracts'), occurrence('multiplies')] })]
  });
  assert.equal(row(unrelated, AC1).result, 'missing');
  assert.notEqual(row(unrelated, AC1).assurance, 'module-observed');
  assert.ok(unrelated.findings.some((entry) => entry.code === 'EVIDENCE_TEST_NOT_RUN' && entry.message.includes("'value › adds'")));
  assert.equal(unrelated.decision.gate, 'block');

  const offTest = evaluate({
    workflow: story(), records: records(),
    deliveries: [delivery({
      witnesses: [countsWitness(AC2, 'test/two.test.mjs')], occurrences: [occurrence('subtracts')],
      unattachedTags: [{ testSource: 'test/value.test.js', line: 1, clauseIds: [AC1], code: 'TAG_NOT_ON_DECLARATION', message: 'not above a test' }]
    })]
  });
  assert.equal(row(offTest, AC1).result, 'missing');
  assert.ok(offTest.findings.some((entry) => entry.code === 'EVIDENCE_TAG_NOT_ON_TEST' && entry.message.includes('test/value.test.js:1')));
});

test('skipped, filtered, missing, ambiguous and flaky exact tests stay unverified (E2G #8)', () => {
  const judge = (occurrences, witness = jestWitness(AC1, 'adds'), extra = {}) => {
    const evaluation = evaluate({
      workflow: story(), records: records(),
      deliveries: [delivery({ witnesses: [witness, countsWitness(AC2, 'test/two.test.mjs')], occurrences, ...extra })]
    });
    return { row: row(evaluation, AC1), codes: evaluation.findings.map((entry) => entry.code), gate: evaluation.decision.gate };
  };
  const cases = [
    ['skipped', [occurrence('adds', 'skipped')], 'missing', 'EVIDENCE_TEST_SKIPPED', 'skipped'],
    ['filtered out of the run', [occurrence('subtracts')], 'missing', 'EVIDENCE_TEST_NOT_RUN', 'missing'],
    ['ambiguous', [occurrence('adds'), occurrence('adds')], 'inconclusive', 'EVIDENCE_TEST_AMBIGUOUS', 'ambiguous'],
    ['flaky', [occurrence('adds', 'passed', { flaky: true })], 'inconclusive', 'EVIDENCE_TEST_FLAKY', 'flaky'],
    ['failed', [occurrence('adds', 'failed')], 'failed', 'EVIDENCE_TEST_FAILED', 'failed']
  ];
  for (const [label, occurrences, result, code, execution] of cases) {
    const judged = judge(occurrences, jestWitness(AC1, 'adds'), label === 'failed' ? { status: 'failed', tests: { discovered: 1, passed: 0, failed: 1, skipped: 0 } } : {});
    assert.equal(judged.row.result, result, label);
    assert.ok(judged.codes.includes(code), `${label}: ${judged.codes.join(', ')}`);
    assert.equal(judged.row.verification.execution, execution, label);
    assert.equal(judged.gate, 'block', label);
  }
  const dynamic = judge([occurrence('adds 1')], jestWitness(AC1, 'adds %i', { gaps: ['PARAMETERS_DYNAMIC'], parameters: { kind: 'dynamic', count: null } }));
  assert.equal(dynamic.row.result, 'inconclusive');
  assert.ok(dynamic.codes.includes('EVIDENCE_TEST_IDENTITY_INCONCLUSIVE'));
  const failedRun = judge([occurrence('adds')], jestWitness(AC1, 'adds'), { status: 'failed', tests: { discovered: 2, passed: 1, failed: 1, skipped: 0 } });
  assert.equal(failedRun.row.result, 'failed', 'a pass inside a failed run does not count');
  assert.match(failedRun.row.findings.find((entry) => entry.code === 'EVIDENCE_TEST_FAILED').message, /a pass inside a failed run does not count/);
});

test('a parameterized declaration passes only when every static instance passed', () => {
  const witness = jestWitness(AC1, 'adds %i', { parameters: { kind: 'static', count: 2, titlePattern: '^adds \\d+$' } });
  const all = evaluate({ workflow: story(), records: records(), deliveries: [delivery({ witnesses: [witness, countsWitness(AC2, 'test/two.test.mjs')], occurrences: [occurrence('adds 1'), occurrence('adds 2')] })] });
  assert.equal(row(all, AC1).result, 'satisfied');
  const one = evaluate({ workflow: story(), records: records(), deliveries: [delivery({ witnesses: [witness, countsWitness(AC2, 'test/two.test.mjs')], occurrences: [occurrence('adds 1')] })] });
  assert.equal(row(one, AC1).result, 'missing');
});

test('a Story requiring more than a module runner can show reads an assurance shortfall, not a pass', () => {
  const evaluation = evaluate({ workflow: story(), records: records(), deliveries: [delivery()] }, { requiredAssurance: 'exact-local-observed' });
  assert.equal(row(evaluation, AC1).result, 'inconclusive');
  assert.equal(row(evaluation, AC1).obligations.find((entry) => entry.responsibility === 'verify').requiredAssurance, 'exact-local-observed');
  assert.ok(evaluation.findings.some((entry) => entry.code === 'EVIDENCE_ASSURANCE_SHORTFALL' && entry.message.includes('module-observed')));
});

test('a published delivery shows what its preflight run observed while it is still pending', () => {
  const evaluation = evaluate({
    workflow: story({ code: 'in_progress', currentPhase: 'implementation', codeApprovals: [] }), records: records({ observed: false }),
    deliveries: [delivery({ ready: false, witnesses: [jestWitness(AC1, 'adds')], occurrences: [occurrence('adds')] })]
  });
  assert.equal(row(evaluation, AC1).result, 'pending');
  assert.equal(row(evaluation, AC1).verification.execution, 'passed');
  assert.deepEqual(row(evaluation, AC1).verification.witnesses.map((entry) => entry.outcome), ['passed']);
});

test('lifecycle words never claim completion', () => {
  assert.equal(lifecycleWords({ status: 'in_progress', currentPhase: null, pendingDecision: { label: 'Ship it?' } }), 'Waiting for a decision: Ship it?');
  assert.equal(lifecycleWords({ status: 'not_started', currentPhase: null }), 'Not started');
});
