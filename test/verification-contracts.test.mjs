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

test('mixed-case contract criteria use canonical identity without changing witness paths or source objects', () => {
  const canonical = parse(table(`| \`vc-1:ac-001\` | unit | test | \`test/value.test.js\` | | | | |`));
  assert.equal(canonical[0].clauseId, AC1);
  const input = [{ ...canonical[0], clauseId: 'Vc-1:aC-001' }];
  assert.deepEqual(normalizeVerificationContracts(input), canonical);
  assert.equal(input[0].clauseId, 'Vc-1:aC-001');
  assert.throws(() => normalizeVerificationContracts([...canonical, ...input]),
    error => error.code === 'SPEC_VERIFICATION_CONTRACT_INVALID');
  assert.throws(() => normalizeVerificationContracts([{ ...canonical[0], clauseId: 'vc-1:ac-001-extra' }]),
    error => error.code === 'SPEC_VERIFICATION_CONTRACT_INVALID');
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
const records_ = (contracts) => records(contracts);
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

test('an inspection or visual witness binds the exact file, a full checklist and the reviewer, and stops counting when the file changes', async () => {
  const { recordWitness, witnessContextBinding, witnessRecordResults, WITNESS_CHECKLIST } = await import('../src/verification/witness-records.mjs');
  const contracts = parse(table(
    `| \`${AC1}\` | unit | test | \`test/value.test.js\` | | | | |`,
    `| \`${AC1}\` | docs | inspection | \`docs/value.md\` | | | | |`,
    `| \`${AC1}\` | screen | visual | \`checkout\` | | | | |`
  ));
  const slots = Object.fromEntries(contracts[0].slots.map((slot) => [slot.slot, slot]));
  const yes = Object.fromEntries(WITNESS_CHECKLIST.map((item) => [item, 'yes']));
  const common = { clauseId: AC1, sha256: `sha256:${'d'.repeat(64)}`, reason: 'Read the value section end to end.', actor: 'carol', authorityGroup: 'reviewers', at: NOW };
  const workflow = {};
  assert.throws(() => recordWitness(workflow, { ...common, slot: slots.unit, file: 'test/value.test.js', answers: yes }), /no inspection or visual slot/);
  assert.throws(() => recordWitness(workflow, { ...common, slot: slots.docs, file: 'docs/other.md', answers: yes }), /inspects docs\/value\.md, not docs\/other\.md/);
  assert.throws(() => recordWitness(workflow, { ...common, slot: slots.docs, file: 'docs/value.md', answers: { 'states-the-outcome': 'yes' } }), /Answer every checklist item/);
  assert.throws(() => recordWitness(workflow, { ...common, slot: slots.docs, file: 'docs/value.md', answers: yes, reason: 'ok' }), (error) => error.code === 'WITNESS_RECORD_REASON_REQUIRED');
  const inspected = recordWitness(workflow, { ...common, slot: slots.docs, file: 'docs/value.md', answers: yes });
  assert.equal(inspected.id, 'WIT-001');
  assert.equal(inspected.outcome, 'met');
  const visual = recordWitness(workflow, { ...common, slot: slots.screen, file: 'evidence/checkout.png', answers: { ...yes, 'matches-the-criterion': 'no' } });
  assert.equal(visual.target, 'checkout');
  assert.equal(visual.outcome, 'failed');
  const current = new Map([['docs/value.md', common.sha256], ['evidence/checkout.png', common.sha256]]);
  const binding = { contextBinding: witnessContextBinding(workflow) };
  const results = Object.fromEntries(witnessRecordResults(workflow.witnessRecords, current, binding).map((entry) => [entry.slot, entry]));
  assert.equal(results.docs.status, 'met');
  assert.equal(results.screen.status, 'failed');
  assert.match(results.screen.message, /matches-the-criterion/);
  const changed = witnessRecordResults(workflow.witnessRecords, new Map([['docs/value.md', `sha256:${'e'.repeat(64)}`]]), binding);
  assert.equal(changed.find((entry) => entry.slot === 'docs').status, 'missing');
  // The evaluator credits a met inspection slot, and only while its bytes are current.
  const docsOnly = parse(table(`| \`${AC1}\` | unit | test | \`test/value.test.js\` | | | | |`, `| \`${AC1}\` | docs | inspection | \`docs/value.md\` | | | | |`));
  const graph = (records) => evaluateEvidence(evidenceGraph({ workflow: story(), records: records_(docsOnly), deliveries: [delivery([witness('adds')], [occurrence('adds')])], witnessRecords: records }), { at: NOW });
  assert.equal(verifyRow(graph(witnessRecordResults(workflow.witnessRecords, current, binding))).result, 'satisfied');
  assert.equal(verifyRow(graph(changed)).result, 'missing');
  workflow.phases = { implementation: { generation: 2, generationCommit: 'a'.repeat(40), deliveryEvidence: { sourceTreeSha256: 'b'.repeat(64) } } };
  const newCandidate = witnessRecordResults(workflow.witnessRecords, current, { contextBinding: witnessContextBinding(workflow) });
  assert.ok(newCandidate.every((entry) => entry.status === 'missing'), 'unchanged screenshot bytes cannot reuse another candidate review');
});

test('a retained evidence witness requires exact published bytes, including mixed obligations', async () => {
  const { recordWitness, WITNESS_CHECKLIST } = await import('../src/verification/witness-records.mjs');
  const file = 'singularity/work-items/VERIFY/evidence/screen.png';
  const sha256 = 'd'.repeat(64);
  const retained = { fulfillment: 'evidence', expectedPaths: [file] };
  const input = { clauseId: AC1, slot: { slot: 'screen', method: 'visual', witness: { target: 'checkout' } },
    file, sha256: `sha256:${sha256}`, plannedClaim: { obligations: [retained, { fulfillment: 'test-only' }] },
    answers: Object.fromEntries(WITNESS_CHECKLIST.map((item) => [item, 'yes'])),
    reason: 'Inspected the exact image published for this candidate.', actor: 'carol', authorityGroup: 'reviewers', at: NOW };
  const workflow = { phases: { build: { generation: 1, generationCommit: 'a'.repeat(40),
    deliveryEvidence: { fulfillment: [{ clauseId: AC1, fulfillment: 'evidence', paths: [{ path: file, state: 'present', sha256 }] }] } } } };
  assert.throws(() => recordWitness(workflow, { ...input, sha256: `sha256:${'e'.repeat(64)}` }),
    (error) => error.code === 'WITNESS_EVIDENCE_UNPUBLISHED');
  assert.throws(() => recordWitness({ phases: {} }, input), (error) => error.code === 'WITNESS_EVIDENCE_UNPUBLISHED');
  assert.equal(workflow.witnessRecords, undefined, 'refusals must not append a decision');
  assert.equal(recordWitness(workflow, input).outcome, 'met');
});
