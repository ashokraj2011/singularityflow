import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateEvidence } from '../src/evidence/evaluate.mjs';
import { evidenceGraph } from '../src/evidence/graph.mjs';
import {
  contractRequiresTestTag, effectiveContract, mergedVerificationContracts, normalizeVerificationContracts,
  parseVerificationContracts, witnessMappingCore, witnessMappingSha256
} from '../src/verification/contracts.mjs';

const W = 'VC-1';
const AC1 = `${W}:AC-001`;
const AC2 = `${W}:AC-002`;
const planned = {
  [AC1]: { expectedPaths: ['src/value.js'], tests: ['test/value.test.js', 'test/other.test.js'], testDisposition: 'applicable', testReason: null },
  [AC2]: { expectedPaths: ['docs/runbook.md'], tests: [], testDisposition: 'not-applicable', testReason: 'documentation only' }
};
const table = (...rows) => ['# Plan', '', '## Verification contracts', '',
  '| Criterion | Slot | Method | Witness | Role | Required assurance | Combination | Reason |', '|---|---|---|---|---|---|---|---|', ...rows, ''].join('\n');
const parse = (markdown) => parseVerificationContracts(markdown, { clauseIds: [AC1, AC2], plannedClaims: planned });

test('a plan states each criterion\'s witness slots in its own table, validated before any code exists', () => {
  const contracts = parse(table(
    `| \`${AC1}\` | unit | test | \`test/value.test.js\` | primary | exact-local-observed | all | |`,
    `| \`${AC1}\` | review | inspection | \`docs/value.md\` | supporting | | all | |`,
    `| \`${AC2}\` | runbook | inspection | \`docs/runbook.md\` | | | | |`
  ));
  assert.deepEqual(contracts.map((entry) => [entry.clauseId, entry.combination, entry.slots.map((slot) => `${slot.slot}:${slot.method}:${slot.role}`)]), [
    [AC1, 'all', ['review:inspection:supporting', 'unit:test:primary']],
    [AC2, 'all', ['runbook:inspection:primary']]
  ]);
  assert.deepEqual(normalizeVerificationContracts(contracts), contracts);
  // Fenced examples are never contracts.
  assert.deepEqual(parse(['## Verification contracts', '', '```', `| Criterion | Slot | Method | Witness |`, '```', ''].join('\n')), []);
});

test('contracts that could never verify honestly are refused with what to change', () => {
  const refused = (markdown, pattern) => assert.throws(() => parse(markdown), (error) => error.code === 'SPEC_VERIFICATION_CONTRACT_INVALID' && pattern.test(error.message), String(pattern));
  refused(table(`| \`${W}:AC-009\` | unit | test | \`test/value.test.js\` | | | | |`), /not a criterion of this Story/);
  refused(table(`| \`${AC1}\` | perf | measurement | \`bench/value.js\` | | | | |`), /cannot verify yet; use test, inspection, visual/);
  refused(table(`| \`${AC1}\` | unit | test | \`test/value.test.js\` | | | | |`, `| \`${AC1}\` | unit | inspection | \`docs/a.md\` | | | | |`), /slot unit more than once/);
  refused(table(`| \`${AC1}\` | review | inspection | \`docs/a.md\` | supporting | | | |`), /only supporting witnesses/);
  refused(table(`| \`${AC1}\` | unit | test | \`test/value.test.js\` | | | any | |`), /say why one alternative is enough/);
  refused(table(`| \`${AC1}\` | unit | test | \`test/value.test.js\` | | | all | |`, `| \`${AC1}\` | other | test | \`test/other.test.js\` | | | any | Either suite proves it fully. |`), /both all and any/);
  refused(table(`| \`${AC1}\` | unit | test | \`test/missing.test.js\` | | | | |`), /not among its planned tests/);
  refused(table(`| \`${AC1}\` | unit | test | \`test/value.test.js\` | | exact-authenticated | | |`), /needs qualified execution/);
  refused(table(`| \`${AC2}\` | unit | test | \`test/value.test.js\` | | | | |`), /plans no tests \(not-applicable\)/);
  refused(table(`| \`${AC1}\` | unit | test | \`test/*.test.js\` | | | | |`), /one exact repository-relative path/);
});

test('a criterion without a contract keeps the default one test slot; only test slots need an @ac tag', () => {
  const contracts = mergedVerificationContracts([{ verificationContracts: parse(table(`| \`${AC1}\` | review | inspection | \`docs/value.md\` | | | | |`)) }]);
  const stated = effectiveContract(AC1, contracts, planned[AC1]);
  assert.equal(stated.stated, true);
  assert.equal(contractRequiresTestTag(stated), false, 'an inspection-only criterion needs no @ac tag');
  const fallback = effectiveContract(AC1, new Map(), planned[AC1]);
  assert.deepEqual(fallback.slots.map((slot) => [slot.slot, slot.method, slot.role]), [['tests', 'test', 'primary']]);
  assert.equal(contractRequiresTestTag(fallback), true);
  assert.equal(effectiveContract(AC2, new Map(), planned[AC2]), null, 'reviewed not-applicable tests have no contract');
});

// Evaluator fixtures: one code step delivering exact Jest tests for AC-001.
const policy = { mode: 'required', minimum: 1, authorities: ['reviewers'], requiredAuthorities: [] };
function story(witnessMappings = []) {
  return {
    workItem: { id: W, title: 'Contracts' }, status: 'in_progress', currentPhase: 'testing',
    phaseOrder: ['intake', 'implementation', 'testing'],
    resolution: { plannedClaims: { mode: 'required', clausePhases: ['intake'], owners: { implementation: 'intake' } } },
    phases: {
      intake: { id: 'intake', status: 'approved', generation: 1, approvalPolicy: policy, approvals: [{ decision: 'approved', actor: { login: 'a' } }], requiredArtifact: { kind: 'requirements' } },
      implementation: { id: 'implementation', status: 'approved', generation: 1, approvalPolicy: policy, generationPolicy: { task: 'code' }, requiredArtifact: { kind: 'implementation-summary' },
        approvals: [{ decision: 'approved', actor: { login: 'b' }, witnessMappings }] },
      testing: { id: 'testing', status: 'in_progress', generation: 1, approvalPolicy: policy, approvals: [], requiredArtifact: { kind: 'test-evidence' } }
    }
  };
}
const BODY = 'b'.repeat(64);
const witness = (name, testSource = 'test/value.test.js') => ({
  clauseId: AC1, testSource, profile: 'jest-static-v2', commandId: 'unit', identity: { framework: 'jest', suitePath: [], name },
  logicalTestId: `sha256:${name.length.toString(16).padStart(64, '0')}`, declarationSha256: 'c'.repeat(64), supportSha256: null, line: 2, parameters: null, gaps: []
});
const occurrence = (name, outcome = 'passed') => ({ suitePath: [], name, outcome, durationMs: 1 });
function records(contracts = []) {
  return {
    indexes: [{ workId: W, phase: 'intake', generation: 1, clauses: [{ id: AC1, type: 'AC', source: { path: 'intake.md', line: 3 }, bodySha256: BODY, dependsOn: [] }] }],
    planned: [{ workId: W, phase: 'intake', generation: 1, kind: 'planned', claims: { [AC1]: planned[AC1] }, ...(contracts.length ? { verificationContracts: contracts } : {}) }],
    observed: [{ workId: W, phase: 'implementation', generation: 1, kind: 'observed', claims: { [AC1]: { observedPaths: ['src/value.js'], testResults: ['test/other.test.js', 'test/value.test.js'], commits: [], verdict: 'matched' } } }]
  };
}
function delivery(witnesses, occurrences) {
  const bindings = [...new Set(witnesses.map((entry) => entry.testSource))].map((testSource) => ({ clauseId: AC1, testSource, commandId: 'unit' }));
  return {
    phaseId: 'implementation', generation: 1, status: 'ready', testRecovery: null,
    acceptanceCriteria: { bindings, witnesses, unattachedTags: [] },
    receipt: { status: 'ready', traceability: { bindings, witnesses, unattachedTags: [] } },
    executions: [{ commandId: 'unit', kind: 'test-execution', status: 'passed', record: { attemptId: 'TA-00000000000000000001', status: 'passed', exitCode: 0, terminal: true, tests: { discovered: occurrences.length, passed: occurrences.length, failed: 0, skipped: 0 }, occurrences } }],
    preflight: []
  };
}
const verifyRow = (evaluation) => evaluation.rows.find((row) => row.id === AC1);
const verifyOf = (evaluation) => verifyRow(evaluation).obligations.find((entry) => entry.responsibility === 'verify');
const NOW = '2026-10-03T10:00:00.000Z';
const run = ({ contracts = [], witnesses = [witness('adds')], occurrences = [occurrence('adds')], mappings = [] } = {}) =>
  evaluateEvidence(evidenceGraph({ workflow: story(mappings), records: records(contracts), deliveries: [delivery(witnesses, occurrences)] }), { at: NOW });

test('every primary slot must be met under all; a supporting slot is shown but never decides', () => {
  const contracts = parse(table(
    `| \`${AC1}\` | unit | test | \`test/value.test.js\` | primary | | all | |`,
    `| \`${AC1}\` | docs | inspection | \`docs/value.md\` | primary | | all | |`,
    `| \`${AC1}\` | other | test | \`test/other.test.js\` | supporting | | all | |`
  ));
  const evaluation = run({ contracts });
  assert.equal(verifyRow(evaluation).result, 'missing', 'the inspection slot has no record yet');
  assert.ok(evaluation.findings.some((entry) => entry.code === 'EVIDENCE_INSPECTION_MISSING' && entry.message.includes('docs/value.md')));
  assert.deepEqual(verifyRow(evaluation).verification.contract.slots.map((slot) => [slot.slot, slot.role, slot.status]), [
    ['docs', 'primary', 'missing'], ['other', 'supporting', 'missing'], ['unit', 'primary', 'met']
  ]);
  const testsOnly = parse(table(`| \`${AC1}\` | unit | test | \`test/value.test.js\` | | | | |`, `| \`${AC1}\` | other | test | \`test/other.test.js\` | supporting | | | |`));
  assert.equal(verifyRow(run({ contracts: testsOnly })).result, 'satisfied', 'a missing supporting witness never blocks');
});

test('any is met by one primary slot, and its assurance is the strongest met slot', () => {
  const contracts = parse(table(
    `| \`${AC1}\` | unit | test | \`test/value.test.js\` | | | any | Either suite proves the value on its own. |`,
    `| \`${AC1}\` | other | test | \`test/other.test.js\` | | | any | |`
  ));
  const evaluation = run({ contracts, witnesses: [witness('adds'), witness('also adds', 'test/other.test.js')], occurrences: [occurrence('adds', 'failed'), occurrence('also adds')] });
  assert.equal(verifyOf(evaluation).status, 'met');
  assert.equal(verifyRow(evaluation).assurance, 'exact-local-observed');
});

test('a reviewer\'s adequacy decision rules a test out or excepts it, and a lapsed exception stops counting', () => {
  const contract = effectiveContract(AC1, new Map(), planned[AC1]);
  const sha = witnessMappingSha256(witnessMappingCore(witness('adds'), { clauseBodySha256: BODY, contract }));
  const ruledOut = run({ mappings: [{ mappingSha256: sha, decision: 'not-applicable', reason: 'checks something else' }] });
  assert.equal(verifyOf(ruledOut).status, 'missing');
  assert.ok(ruledOut.findings.some((entry) => entry.code === 'EVIDENCE_WITNESS_NOT_APPLICABLE'));
  const excepted = run({ mappings: [{ mappingSha256: sha, decision: 'exception', reason: 'no boundary case yet', expiresAt: '2026-11-01T00:00:00.000Z' }] });
  assert.equal(verifyRow(excepted).result, 'satisfied-with-exception');
  assert.equal(verifyOf(excepted).facets.exception, 'witness-exception');
  const lapsed = run({ mappings: [{ mappingSha256: sha, decision: 'exception', reason: 'no boundary case yet', expiresAt: '2026-10-01T00:00:00.000Z' }] });
  assert.equal(verifyOf(lapsed).status, 'missing');
  assert.ok(lapsed.findings.some((entry) => entry.code === 'EVIDENCE_WITNESS_EXCEPTION_EXPIRED'));
  const accepted = run({ mappings: [{ mappingSha256: sha, decision: 'satisfied' }] });
  assert.equal(verifyRow(accepted).result, 'satisfied');
});

test('a plan may require less than the runner can reach, but never more than it can reach', () => {
  const modest = parse(table(`| \`${AC1}\` | unit | test | \`test/value.test.js\` | | module-observed | | |`));
  assert.equal(verifyOf(run({ contracts: modest })).status, 'met');
  const counts = { ...witness('adds'), profile: 'module-counts-v1', identity: null, logicalTestId: null, gaps: ['ADAPTER_COUNTS_ONLY'] };
  const strict = parse(table(`| \`${AC1}\` | unit | test | \`test/value.test.js\` | | exact-local-observed | | |`));
  const shortfall = run({ contracts: strict, witnesses: [counts] });
  assert.equal(verifyOf(shortfall).status, 'inconclusive');
  assert.ok(shortfall.findings.some((entry) => entry.code === 'EVIDENCE_ASSURANCE_SHORTFALL'));
});
