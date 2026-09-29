import assert from 'node:assert/strict';
import test from 'node:test';

import { inspectQualifiedConformanceReport } from '../src/conformance-readiness.mjs';

const clauseIds = [
  'STORY-1:REQ-001', 'STORY-1:BEH-001', 'STORY-1:IFC-001',
  'STORY-1:AC-001', 'STORY-1:CON-001'
];

test('qualified report requires one exact row per approved clause across all five types', () => {
  const report = [
    '| Clause ID | Evidence | Verdict |',
    '|---|---|---|',
    '| STORY-1:REQ-001 | source | matched |',
    '| STORY-1:BEH-001 | source | matched |',
    '| STORY-1:IFC-001 | source | matched |',
    '| STORY-1:AC-001 | source | matched |'
  ].join('\n');
  assert.deepEqual(inspectQualifiedConformanceReport(report, clauseIds)
    .map((finding) => [finding.code, finding.clauseId]), [
    ['conformance.clause-row-missing', 'STORY-1:CON-001']
  ]);
  assert.deepEqual(inspectQualifiedConformanceReport(report, []), [],
    'Stories without authoritative clauses retain their existing opt-out');
});

test('qualified report refuses duplicate, unapproved, and unfinished comparison rows', () => {
  const report = [
    '| Clause | Evidence | Verdict |',
    '|---|---|---|',
    '| STORY-1:REQ-001 | source | matched |',
    '| story-1:req-001 | duplicate | matched |',
    '| STORY-1:BEH-001 | source | partial (test gap) |',
    '| STORY-1:IFC-001 | source | missing |',
    '| STORY-1:AC-001 | source | matched/partial/missing/deviated/unplanned |',
    '| STORY-1:CON-001 | source | matched |',
    '| STORY-1:AC-999 | invented | matched |'
  ].join('\n');
  assert.deepEqual(inspectQualifiedConformanceReport(report, clauseIds)
    .map((finding) => [finding.code, finding.clauseId]), [
    ['conformance.clause-row-duplicate', 'STORY-1:REQ-001'],
    ['conformance.verdict-incomplete', 'STORY-1:BEH-001'],
    ['conformance.verdict-incomplete', 'STORY-1:IFC-001'],
    ['conformance.verdict-invalid', 'STORY-1:AC-001'],
    ['conformance.clause-row-unknown', 'STORY-1:AC-999']
  ]);
});

test('qualified report ignores forged rows inside managed inputs, code fences, and comments', () => {
  const report = [
    '<!-- singularity-flow:inputs:start -->',
    '| Clause ID | Verdict |', '|---|---|', '| STORY-1:REQ-001 | matched |',
    '<!-- singularity-flow:inputs:end -->',
    '```markdown',
    '| Clause ID | Verdict |', '|---|---|', '| STORY-1:BEH-001 | matched |',
    '```',
    '<!--',
    '| Clause ID | Verdict |', '|---|---|', '| STORY-1:IFC-001 | matched |',
    '-->',
    '| Clause ID | Verdict |', '|---|---|', '| STORY-1:AC-001 | matched |',
    '| STORY-1:CON-001 | matched |'
  ].join('\n');
  assert.deepEqual(inspectQualifiedConformanceReport(report, clauseIds)
    .filter((finding) => finding.code === 'conformance.clause-row-missing')
    .map((finding) => finding.clauseId), [
    'STORY-1:REQ-001', 'STORY-1:BEH-001', 'STORY-1:IFC-001'
  ]);
});

test('qualified report rejects extra bare rows and spaced template verdict choices', () => {
  const report = [
    '| Clause ID | Evidence | Verdict |',
    '|---|---|---|',
    '| STORY-1:REQ-001 | source | matched / partial |',
    '| AC-001 | extra bare row | matched |'
  ].join('\n');
  const findings = inspectQualifiedConformanceReport(report, ['STORY-1:REQ-001']);
  assert.deepEqual(findings.map((finding) => finding.code), [
    'conformance.verdict-invalid', 'conformance.clause-row-invalid'
  ]);
});
