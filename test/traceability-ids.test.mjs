import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GOVERNED_CLAUSE_TYPES, normalizeQualifiedClauseId, scanSourceClauseTags
} from '../src/traceability-ids.mjs';
import { isQualifiedAcceptanceId, acceptanceTagsInComment } from '../src/verification/tags.mjs';

test('governed clause identity is qualified, exact, and case-insensitive', () => {
  assert.deepEqual(GOVERNED_CLAUSE_TYPES, ['REQ', 'BEH', 'IFC', 'AC', 'CON']);
  assert.equal(normalizeQualifiedClauseId('work-1:beh-003'), 'WORK-1:BEH-003');
  assert.equal(isQualifiedAcceptanceId('hEx-LaSt:ac-001'), true);
  assert.deepEqual(acceptanceTagsInComment('// @ac:hEx-LaSt:aC-001'), ['HEX-LAST:AC-001']);
  for (const invalid of ['OTHER-HEX-LAST:AC-001-extra', 'HEX-LAST:REQ-001', 'AC-001']) {
    assert.equal(isQualifiedAcceptanceId(invalid), false);
  }
  for (const invalid of ['REQ-001', 'WORK-1:NFR-001', 'WORK-1:REQ-1', 'WORK-1:REQ-001-extra']) {
    assert.equal(normalizeQualifiedClauseId(invalid), null);
  }
});

test('strict source tags read leading comments, not executable text or malformed IDs', () => {
  const source = [
    '// @clause:work-1:REQ-001',
    'const text = "@clause:WORK-1:REQ-002";',
    '# @clause:WORK-1:BEH-003',
    '/* @clause:WORK-1:IFC-004 */',
    '* @clause:WORK-1:CON-005',
    '// @ac:WORK-1:AC-006',
    '// @ac:WORK-1:REQ-007',
    '// @clause:WORK-1:NFR-008',
    '// @clause:REQ-009',
    '// @clause:WORK-1:REQ-010-extra',
    '<!-- @clause:WORK-1:IFC-011 -->',
    '-- @clause:WORK-1:CON-012',
    '// @clause:WORK-1:REQ-013:forged'
  ].join('\n');
  assert.deepEqual(scanSourceClauseTags(source).map(({ clauseId, line }) => [clauseId, line]), [
    ['WORK-1:REQ-001', 1], ['WORK-1:BEH-003', 3], ['WORK-1:IFC-004', 4],
    ['WORK-1:CON-005', 5], ['WORK-1:AC-006', 6],
    ['WORK-1:IFC-011', 11], ['WORK-1:CON-012', 12]
  ]);
  assert.deepEqual(scanSourceClauseTags(source, { legacy: true }).map(({ clauseId }) => clauseId), [
    'WORK-1:REQ-001', 'WORK-1:BEH-003', 'WORK-1:IFC-004', 'WORK-1:CON-005',
    'WORK-1:AC-006', 'WORK-1:NFR-008', 'REQ-009', 'WORK-1:IFC-011', 'WORK-1:CON-012'
  ]);
});
