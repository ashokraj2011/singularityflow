import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blockingConformanceVerdicts,
  conformanceTableRows,
  duplicateQualifiedConformanceRows,
  missingQualifiedConformanceRows
} from '../src/conformance-verdicts.mjs';

test('benchmark conformance reads Verdict from its sixth column, not Test evidence', () => {
  const report = [
    '| Criterion | Intake evidence | Design evidence | Code evidence | Test evidence | Verdict |',
    '|---|---|---|---|---|---|',
    '| `APP:REQ-001` | reviewed | approved | src/main.ts | passing test | missing |',
    '| `APP:AC-001` | reviewed | approved | src/main.ts | partial test evidence | matched |'
  ].join('\n');
  assert.deepEqual(blockingConformanceVerdicts(report), [
    { clauseId: 'APP:REQ-001', verdict: 'missing' }
  ]);
});

test('conformance parser handles common and mobile table layouts and ignores unrelated tables', () => {
  const report = [
    '| ID | Screen/component | Approved requirement | Code evidence | Test evidence | Visual evidence | Verdict | Deviation |',
    '|---|---|---|---|---|---|---|---|',
    '| `APP:IFC-001` | checkout | approved | src/ui.ts | pass | screenshot | partial (visual gap) | pending |',
    '',
    '| Flow | Approved screens/states | Implemented | Visually verified | Missing/deviated |',
    '|---|---|---|---|---|',
    '| checkout | approved | yes | yes | missing |',
    '',
    '| Clause ID | Requirement | Code evidence | Test evidence | Verdict | Deviation |',
    '|---|---|---|---|---|---|',
    '| `APP:AC-001` | use \\| escaping | src/ui.ts | pass | matched | none |'
  ].join('\n');
  assert.deepEqual(blockingConformanceVerdicts(report), [
    { clauseId: 'APP:IFC-001', verdict: 'partial' }
  ]);
  assert.deepEqual(conformanceTableRows(report).map((row) => row.clauseId), [
    'APP:IFC-001', 'APP:AC-001'
  ]);
  assert.equal(conformanceTableRows(report).at(-1).verdict, 'matched');
});

test('qualified completeness requires exact individual comparison rows', () => {
  const report = [
    'The implementation references APP:REQ-002 in prose.',
    '| Clause ID | Requirement | Code evidence | Test evidence | Verdict |',
    '|---|---|---|---|---|',
    '| `APP:REQ-001` | approved | src/a.ts | tests/a.test.ts | matched |',
    '| `APP:REQ-002 / APP:AC-001` | grouped | src/a.ts | tests/a.test.ts | matched |'
  ].join('\n');
  assert.deepEqual(missingQualifiedConformanceRows(report, [
    'APP:REQ-001', 'APP:REQ-002', 'APP:AC-001', 'APP:BEH-001', 'APP:IFC-001', 'APP:CON-001'
  ]), [
    'APP:REQ-002', 'APP:AC-001', 'APP:BEH-001', 'APP:IFC-001', 'APP:CON-001'
  ]);
});

test('a malformed or unheaded table cannot satisfy qualified completeness', () => {
  const report = [
    '| `APP:REQ-001` | approved | matched |',
    '|---|---|---|',
    '| `APP:AC-001` | approved | matched |',
    '',
    '| Clause ID | Requirement | Verdict |',
    '|---|---|---|',
    '| `APP:CON-001` | approved | matched |'
  ].join('\n');
  assert.deepEqual(missingQualifiedConformanceRows(report, [
    'APP:REQ-001', 'APP:AC-001', 'APP:CON-001'
  ]), ['APP:REQ-001', 'APP:AC-001']);
});

test('legacy reports with unknown headers retain fifth-column blocking semantics', () => {
  const report = [
    '| Old ID | Intent | Code | Tests | Status |',
    '|---|---|---|---|---|',
    '| APP:AC-001 | approved | src/a.ts | pass | partial |'
  ].join('\n');
  assert.deepEqual(blockingConformanceVerdicts(report), [
    { clauseId: 'APP:AC-001', verdict: 'partial' }
  ]);
  assert.deepEqual(missingQualifiedConformanceRows(report, ['APP:AC-001']), ['APP:AC-001']);
});

test('fenced and commented-out tables cannot satisfy governed clause rows', () => {
  const report = [
    '<!-- singularity-flow:inputs:start -->',
    '| Clause ID | Requirement | Verdict |',
    '|---|---|---|',
    '| APP:IFC-001 | copied upstream | matched |',
    '<!-- singularity-flow:inputs:end -->',
    '```markdown',
    '| Clause ID | Requirement | Verdict |',
    '|---|---|---|',
    '| APP:REQ-001 | forged | matched |',
    '```',
    '<!--',
    '| Clause ID | Requirement | Verdict |',
    '|---|---|---|',
    '| APP:AC-001 | forged | matched |',
    '-->',
    '| Clause ID | Requirement | Verdict |',
    '|---|---|---|',
    '| APP:CON-001 | approved | matched |'
  ].join('\n');
  assert.deepEqual(missingQualifiedConformanceRows(report, [
    'APP:REQ-001', 'APP:AC-001', 'APP:IFC-001', 'APP:CON-001'
  ]), ['APP:REQ-001', 'APP:AC-001', 'APP:IFC-001']);
});

test('duplicate qualified rows remain visible to the terminal gate', () => {
  const report = [
    '| Clause ID | Requirement | Verdict |',
    '|---|---|---|',
    '| APP:REQ-001 | approved | matched |',
    '| app:req-001 | duplicate | matched |'
  ].join('\n');
  assert.deepEqual(duplicateQualifiedConformanceRows(report), ['APP:REQ-001']);
});

test('spec-driven release Clause table uses the same qualified row contract', () => {
  const report = [
    '| Clause | Evidence | Verdict |',
    '|---|---|---|',
    '| `APP:BEH-001` | verified test | matched |',
    '',
    '| Article | Type | Verdict | Recorded by |',
    '|---|---|---|---|',
    '| `CONSTITUTION:CON-001` | security | missing | reviewer |'
  ].join('\n');
  assert.deepEqual(missingQualifiedConformanceRows(report, ['APP:BEH-001', 'APP:IFC-001']), ['APP:IFC-001']);
  assert.deepEqual(blockingConformanceVerdicts(report), []);
});
