import assert from 'node:assert/strict';
import test from 'node:test';
import { convergenceFacts } from '../src/convergence.mjs';
import { evidenceGraph } from '../src/evidence/graph.mjs';
import { evaluateEvidence } from '../src/evidence/evaluate.mjs';
import {
  deriveObservedClaimMap, derivePlannedClaimMap, evaluateSpecCoverage,
  mergeObservedClaimRecords, mergePlannedClaimRecords, validatePlannedEvidenceTypes
} from '../src/specifications.mjs';
import { parseVerificationContracts } from '../src/verification/contracts.mjs';

const ID = 'MIX:REQ-001';
const png = 'singularity/work-items/MIX/evidence/screen.png';
const codePlan = { phase: 'design', claims: { [ID]: {
  fulfillment: 'modified', expectedPaths: ['src/value.mjs'], tests: ['test/value.test.mjs'], steps: ['build']
} } };
const testPlan = { phase: 'test-design', claims: { [ID]: {
  fulfillment: 'test-only', expectedPaths: [], tests: ['test/regression.test.mjs'], steps: ['test-build']
} } };
const code = { phase: 'build', claims: { [ID]: { observedPaths: ['src/value.mjs'],
  testResults: ['test/value.test.mjs'], commits: [], verdict: 'matched' } } };
const tests = { phase: 'test-build', claims: { [ID]: { observedPaths: [],
  testResults: ['test/regression.test.mjs'], commits: [], verdict: 'matched' } } };
const indexes = [{ phase: 'scope', clauses: [{ id: ID, type: 'REQ', body: 'Deliver the approved value.' }] }];
const workflow = { workItem: { id: 'MIX' }, phaseOrder: ['scope', 'design', 'build', 'test-design', 'test-build'],
  phases: Object.fromEntries(['scope', 'design', 'build', 'test-design', 'test-build'].map((id) => [id, {
    id, status: 'approved', generation: 1, approvalPolicy: { mode: 'none' },
    requiredArtifact: { kind: ['build', 'test-build'].includes(id) ? 'implementation-summary' : 'markdown' }
  }])), resolution: { plannedClaims: { mode: 'required', clausePhases: ['scope'], owners: { build: 'design', 'test-build': 'test-design' } } } };

test('mixed fulfillment retains every owner obligation, independent of record order', () => {
  for (const planned of [[codePlan, testPlan], [testPlan, codePlan]]) {
    const merged = mergePlannedClaimRecords(planned);
    assert.equal(merged[ID].fulfillment, undefined, 'no last-writer fulfillment');
    assert.equal(merged[ID].obligations.length, 2);
    const records = { indexes, planned, observed: [code, tests] };
    assert.equal(mergeObservedClaimRecords(records.observed, merged, { workflow })[ID].verdict, 'matched');
    assert.equal(evaluateSpecCoverage(records, ['src/value.mjs', 'test/value.test.mjs', 'test/regression.test.mjs'], {}, { workflow }).complete, true);
    assert.deepEqual(convergenceFacts({ ...records, workflow, reconciliation: { findings: [] } }), []);
    const matrix = evaluateEvidence(evidenceGraph({ workflow, records }));
    const implement = matrix.rows.find((row) => row.id === ID).obligations.find((item) => item.responsibility === 'implement');
    assert.equal(implement.status, 'met');
    assert.equal(implement.fulfillment, 'mixed');
  }
});

test('one owner cannot satisfy another owner even when all file names are in the union', () => {
  const misplaced = { ...code, claims: { [ID]: { ...code.claims[ID], testResults: [...code.claims[ID].testResults, ...tests.claims[ID].testResults] } } };
  const records = { indexes, planned: [codePlan, testPlan], observed: [misplaced] };
  assert.deepEqual(evaluateSpecCoverage(records, [], {}, { workflow }).unimplemented, [ID]);
  assert.ok(convergenceFacts({ ...records, workflow, reconciliation: { findings: [] } }).some((fact) => fact.kind === 'absent-observed-claim'));
  // Omitted explicit steps use the pinned owner topology, not global evidence proximity.
  const withoutSteps = records.planned.map((record) => ({ ...record, claims: { [ID]: { ...record.claims[ID], steps: [] } } }));
  assert.deepEqual(evaluateSpecCoverage({ ...records, planned: withoutSteps }, [], {}, { workflow }).unimplemented, [ID]);
});

test('same-owner partial intervals still accumulate exact source and test delivery', () => {
  const plan = { ...codePlan, claims: { [ID]: { ...codePlan.claims[ID], expectedPaths: ['src/a.mjs', 'src/b.mjs'] } } };
  const first = { ...code, claims: { [ID]: { ...code.claims[ID], observedPaths: ['src/a.mjs'], verdict: 'partial' } } };
  const second = { ...code, claims: { [ID]: { ...code.claims[ID], observedPaths: ['src/b.mjs'], verdict: 'partial' } } };
  assert.equal(mergeObservedClaimRecords([first, second], mergePlannedClaimRecords([plan]), { workflow })[ID].verdict, 'matched');
});

test('retained evidence uses its exact typed hash, never source tags or a pretend executable test', () => {
  const planned = { claims: { [ID]: { fulfillment: 'evidence', expectedPaths: [png], tests: [],
    testDisposition: 'not-applicable', testReason: 'Human inspection witnesses the retained screenshot.' } } };
  const delivery = { fulfillment: { obligations: [{ clauseId: ID, fulfillment: 'evidence', paths: [
    { path: png, state: 'present', sha256: 'a'.repeat(64) }
  ] }] } };
  validatePlannedEvidenceTypes(planned.claims, { evidenceRoot: 'singularity/work-items/MIX/evidence' });
  const observed = deriveObservedClaimMap(planned, delivery, { requireSourceBindings: true });
  assert.deepEqual(observed.claims[ID].observedPaths, [png]);
  assert.equal(observed.claims[ID].verdict, 'matched');
  delivery.fulfillment.obligations[0].paths[0].sha256 = null;
  assert.equal(deriveObservedClaimMap(planned, delivery).claims[ID], undefined);
  assert.throws(() => validatePlannedEvidenceTypes(planned.claims, { evidenceRoot: 'singularity/work-items/OTHER/evidence' }), /this Story/);
  const table = (expected, tested) => `## Planned implementation evidence\n\n| Clause | Expected paths | Planned tests |\n|---|---|---|\n| ${ID} | \`${expected}\` | \`${tested}\` |\n`;
  assert.throws(() => derivePlannedClaimMap(table('src/value.mjs', png), { clauseIds: [ID] }), /not an executable test/);
  assert.throws(() => derivePlannedClaimMap(table(png, 'test/value.test.mjs'), { clauseIds: [ID] }), /not product source/);
  // Application asset images and an application's evidence module remain valid source paths.
  assert.doesNotThrow(() => derivePlannedClaimMap(table('src/evidence/image.svg', 'test/value.test.mjs'), { clauseIds: [ID] }));
  assert.doesNotThrow(() => derivePlannedClaimMap(table('src/value.mjs', 'test/evidence/value.test.mjs'), { clauseIds: [ID] }));
});

test('an evidence criterion requires an actual primary visual/inspection verification contract', () => {
  const ac = 'MIX:AC-001';
  const plannedClaims = { [ac]: { fulfillment: 'evidence', expectedPaths: [png], tests: [], testDisposition: 'not-applicable' } };
  assert.throws(() => parseVerificationContracts('', { clauseIds: [ac], plannedClaims }), /file presence alone/);
  const contracts = parseVerificationContracts(`## Verification contracts\n\n| Criterion | Slot | Method | Witness |\n|---|---|---|---|\n| ${ac} | screen | visual | \`desktop value\` |\n`, { clauseIds: [ac], plannedClaims });
  assert.equal(contracts[0].slots[0].method, 'visual');
});
