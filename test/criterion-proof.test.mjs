/**
 * For each criterion, how many tests prove it and whether each asserts [CQF:REQ-033], in the review packet
 * and in `tests summary`, which the approval card reads. Static syntax, read at publication; it refuses nothing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTestSummary, testSummaryText } from '../src/test-summary.mjs';
import { criterionProof } from '../src/verification/criterion-proof.mjs';

const witness = (clauseId, name, line, assertions, extra = {}) => ({ clauseId, testSource: 'test/pay.test.mjs', line,
  identity: { framework: 'node:test', suitePath: ['Pay'], name }, ...(assertions ? { assertions } : {}), ...extra });
const adequate = { count: 2, tautological: 0, adequacy: 'adequate' };

test('each criterion counts the tests that prove it, owed ones with none included, and says whether each asserts', () => {
  const proof = criterionProof({ acceptanceCriteria: { required: ['W-1:AC-001', 'W-1:AC-002', 'W-1:AC-003', 'W-1:AC-004'], witnesses: [
    witness('W-1:AC-001', 'pays', 4, adequate), witness('W-1:AC-001', 'pays twice', 9, adequate),
    witness('W-1:AC-002', 'refunds', 14, { count: 0, tautological: 0, adequacy: 'missing' }), witness('W-1:AC-002', 'refunds twice', 18, { count: 1, tautological: 1, adequacy: 'tautological' }),
    witness('W-1:AC-004', 'ships', 22, null), witness('W-1:AC-005', 'logs', 30, adequate, { skipped: true })] } });
  assert.deepEqual(proof.map((entry) => entry.words), [
    'W-1:AC-001: 2 tests prove it; each asserts',
    "W-1:AC-002: 2 tests prove it; 'Pay › refunds', 'Pay › refunds twice' assert nothing",
    'W-1:AC-003: no test proves it',
    'W-1:AC-004: 1 test proves it; its assertions were not read',
    'W-1:AC-005: 1 test proves it; 1 skipped'
  ]);
  assert.deepEqual(proof.map((entry) => [entry.clauseId, entry.tests, entry.asserting, entry.silent, entry.unread]),
    [['W-1:AC-001', 2, 2, 0, 0], ['W-1:AC-002', 2, 0, 2, 0], ['W-1:AC-003', 0, 0, 0, 0], ['W-1:AC-004', 1, 0, 0, 1], ['W-1:AC-005', 1, 0, 0, 0]]);
  assert.deepEqual(proof[1].witnesses.map((entry) => [entry.test, entry.line, entry.asserts, entry.adequacy, entry.assertions]),
    [['Pay › refunds', 14, false, 'missing', 0], ['Pay › refunds twice', 18, false, 'tautological', 0]]);
  assert.equal(proof[3].witnesses[0].asserts, null);
  assert.equal(criterionProof({ acceptanceCriteria: { required: [], witnesses: [witness('W-1:AC-009', 'only', 3, { count: 1, tautological: 1, adequacy: 'tautological' })] } })[0].words,
    "W-1:AC-009: 1 test proves it; 'Pay › only' asserts only a literal");
  assert.deepEqual(criterionProof(null), []);
  assert.deepEqual(criterionProof({}), []);
});

test('tests summary carries each criterion\'s proof in its JSON and its text', () => {
  const proof = criterionProof({ acceptanceCriteria: { required: ['W-1:AC-001'], witnesses: [witness('W-1:AC-001', 'pays', 4, { count: 0, tautological: 0, adequacy: 'missing' })] } });
  const summary = buildTestSummary({ scope: { kind: 'story', workId: 'W-1', phase: 'implement' }, run: { id: 'TA-1', label: 'Run by publication' }, entries: [], criterionProof: proof });
  assert.equal(summary.criterionProof[0].silent, 1);
  assert.match(testSummaryText(summary), /\nCriteria:\n {2}W-1:AC-001: 1 test proves it; 'Pay › pays' asserts nothing\n/u);
  assert.equal('criterionProof' in buildTestSummary({ scope: { kind: 'story', workId: 'W-1', phase: 'implement' }, run: null, entries: [] }), false);
});
