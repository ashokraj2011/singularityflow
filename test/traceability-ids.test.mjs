import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GOVERNED_CLAUSE_TYPES, normalizeQualifiedClauseId, scanSourceClauseTags
} from '../src/traceability-ids.mjs';
import { isQualifiedAcceptanceId, acceptanceTagsInComment } from '../src/verification/tags.mjs';
import { javascriptSourceComments } from '../src/javascript-source-comments.mjs';
import { scanJavaScriptDeclarations } from '../src/verification/javascript-declarations.mjs';

test('delivery and test declarations share every marker in a multi-tag comment', () => {
  const comment = '// @ac:A-HEX:AC-001 @ac:a-hex:AC-005 @ac:A-HEX:AC-006 @ac:a-hex:ac-006';
  const source = `${comment}\nit('converts the displayed integer', () => { expect(convert('255')).toBe('0xFF'); });`;
  const expected = ['A-HEX:AC-001', 'A-HEX:AC-005', 'A-HEX:AC-006'];
  assert.deepEqual(scanSourceClauseTags(source, { sourcePath: 'src/App.test.jsx' }).map(tag => tag.clauseId), expected);
  assert.deepEqual(acceptanceTagsInComment(comment), expected);
  const declarations = scanJavaScriptDeclarations(source, { sourcePath: 'src/App.test.jsx', framework: 'vitest' });
  assert.deepEqual(declarations.declarations[0].clauseIds, expected);
});

test('multi-tag scanning retains line/provenance/exact identity in JS, JSX and polyglot comments', () => {
  for (const [sourcePath, source] of [
    ['test/value.test.ts', '// @ac:ORDER:AC-001 @ac:ORDER:AC-002\r\nit("value", () => {});'],
    ['src/App.jsx', 'const node = <>{/* @clause:ORDER:REQ-001 @clause:ORDER:REQ-002 */}</>;'],
    ['test/value.py', '# @ac:ORDER:AC-001 @ac:ORDER:AC-002'],
    ['test/value.go', '/* @ac:ORDER:AC-001 @ac:ORDER:AC-002 */ "@ac:ORDER:AC-003"'],
    ['test/ValueTest.java', '/*\n * @ac:ORDER:AC-001 @ac:ORDER:AC-002\n */'],
    ['src/rule.sql', '-- @clause:ORDER:REQ-001 @clause:ORDER:REQ-002']
  ]) {
    const tags = scanSourceClauseTags(source, { sourcePath });
    assert.equal(tags.length, 2, sourcePath);
    assert.deepEqual(tags.map(tag => tag.clauseId.slice(-3)), ['001', '002'], sourcePath);
    assert.deepEqual(tags.map(tag => tag.line), sourcePath.endsWith('.java') ? [2, 2] : [1, 1]);
  }
  const source = ['/* @ac:ORDER:AC-001 */ const fake = "// @ac:ORDER:AC-002";',
    'const str = `// @ac:ORDER:AC-003 @ac:ORDER:AC-004`;',
    '// @ac:ORDER:AC-005-extra @ac:ORDER:REQ-006 @sflow-ac:ORDER:AC-007 @ac:ORDER:AC-008:forged @ac:ORDER:AC-009'].join('\n');
  assert.deepEqual(scanSourceClauseTags(source, { sourcePath: 'test/value.test.mjs' }).map(tag => tag.clauseId), ['ORDER:AC-001', 'ORDER:AC-009']);
});

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

test('JSX comment-only containers bind exact qualified clauses at their source lines', () => {
  const source = [
    'export function App() {',
    '  return <>',
    '    {/* @clause:hex-last:req-001 wires the conversion control */}<Keypad />',
    '    <section>',
    '      { /*',
    '       * @clause:HEX-LAST:REQ-002 preserves the decimal value',
    '       */ }',
    '      {/* @ac:hEx-LaSt:Ac-001 */}',
    '    </section>',
    '  </>;',
    '}',
    '// @clause:HEX-LAST:REQ-003 handles signed values'
  ].join('\r\n');
  const expected = [
    { clauseId: 'HEX-LAST:REQ-001', line: 3, tag: 'clause' },
    { clauseId: 'HEX-LAST:REQ-002', line: 6, tag: 'clause' },
    { clauseId: 'HEX-LAST:AC-001', line: 8, tag: 'ac' },
    { clauseId: 'HEX-LAST:REQ-003', line: 12, tag: 'clause' }
  ];
  assert.deepEqual(scanSourceClauseTags(source, { sourcePath: 'src/App.jsx' }), expected);
  assert.deepEqual(scanSourceClauseTags(source), expected, 'pathless callers also recognize real JSX');
  assert.deepEqual(scanSourceClauseTags(source, { sourcePath: 'src/App.tsx' }), expected);
});

test('JavaScript and JSX literal data cannot create comment witnesses', () => {
  const source = [
    'const single = \'// @clause:HEX-LAST:REQ-001\';',
    'const double = "{/* @clause:HEX-LAST:REQ-002 */}";',
    'const template = String.raw' + String.fromCharCode(96),
    '// @clause:HEX-LAST:REQ-003',
    '{/* @clause:HEX-LAST:REQ-004 */}',
    String.fromCharCode(96) + ';',
    'const pattern = /[{}]\\/\\* @clause:HEX-LAST:REQ-005 \\*\\//;',
    'const node = <div title="',
    '// @clause:HEX-LAST:REQ-006',
    '{/* @clause:HEX-LAST:REQ-007 */}',
    '">',
    '// @clause:HEX-LAST:REQ-008',
    '/* @clause:HEX-LAST:REQ-009 */',
    'It\'s literal text, not a JavaScript string.',
    '<span>{"// @clause:HEX-LAST:REQ-010"}</span>',
    '{/* @clause:HEX-LAST:REQ-011 */ 1}',
    'const text = @clause:HEX-LAST:REQ-012',
    '</div>;',
    '// @clause:HEX-LAST:REQ-013 actually is a source comment'
  ].join('\n');
  assert.deepEqual(scanSourceClauseTags(source, { sourcePath: 'src/App.jsx' }), [
    { clauseId: 'HEX-LAST:REQ-013', line: 19, tag: 'clause' }
  ]);
});

test('template interpolations and JSX attributes scan expressions, not string data', () => {
  const source = [
    'const message = ' + String.fromCharCode(96, 36, 123),
    '// @clause:HEX-LAST:REQ-001 formats the derived value',
    '42}' + String.fromCharCode(96) + ';',
    'const node = <Keypad onConvert={() => {',
    '// @clause:HEX-LAST:REQ-002 invokes the existing conversion action',
    'convert();',
    '}} title="backslash\\">',
    '{/* @clause:HEX-LAST:REQ-003 preserves conversion output */}',
    '</Keypad>;'
  ].join('\n');
  assert.deepEqual(scanSourceClauseTags(source, { sourcePath: 'src/App.jsx' }), [
    { clauseId: 'HEX-LAST:REQ-001', line: 2, tag: 'clause' },
    { clauseId: 'HEX-LAST:REQ-002', line: 5, tag: 'clause' },
    { clauseId: 'HEX-LAST:REQ-003', line: 8, tag: 'clause' }
  ]);
});

test('malformed or over-depth JavaScript/JSX cannot manufacture witnesses', () => {
  for (const source of [
    'const node = <div>{/* @clause:HEX-LAST:REQ-001 missing close',
    'const node = <div>{/* @clause:HEX-LAST:REQ-001 */}</span>;',
    'const node = <div title="{/* @clause:HEX-LAST:REQ-001 */}>',
    'const template = ' + String.fromCharCode(96) + '\n// @clause:HEX-LAST:REQ-001',
    '<div>'.repeat(140) + '{/* @clause:HEX-LAST:REQ-001 */}' + '</div>'.repeat(140)
  ]) {
    assert.deepEqual(scanSourceClauseTags(source, { sourcePath: 'src/App.jsx' }), []);
  }
  assert.deepEqual(javascriptSourceComments(' '.repeat(16 * 1024 * 1024)), []);
});

test('typed non-JSX source and existing polyglot syntax remain observable', () => {
  const source = [
    'const value = <Value>input;',
    'const identity = <T>(value: T): T => value;',
    '// @clause:HEX-LAST:REQ-001 validates typed input'
  ].join('\n');
  assert.deepEqual(scanSourceClauseTags(source, { sourcePath: 'src/input.ts' }), [
    { clauseId: 'HEX-LAST:REQ-001', line: 3, tag: 'clause' }
  ]);
  assert.deepEqual(scanSourceClauseTags([
    'const identity = <T,>(value: T): T => value;',
    'const constrained = <T extends object>(value: T): T => value;',
    'const node = <div>{/* @clause:HEX-LAST:REQ-001 displays typed input */}</div>;'
  ].join('\n'), { sourcePath: 'src/App.tsx' }), [
    { clauseId: 'HEX-LAST:REQ-001', line: 3, tag: 'clause' }
  ]);
  assert.deepEqual(scanSourceClauseTags([
    'text = "{/* fake JSX syntax */}"',
    '# @clause:HEX-LAST:REQ-001 validates input'
  ].join('\n'), { sourcePath: 'src/input.py' }), [
    { clauseId: 'HEX-LAST:REQ-001', line: 2, tag: 'clause' }
  ]);
});

test('object division and control-statement regex literals do not hide genuine following comments', () => {
  assert.deepEqual(scanSourceClauseTags([
    'const objectDivision = {} / 2;',
    'const parenthesized = ({}) / 2;',
    'if (ready) /["{}]/u.test(text);',
    'while (ready) /["{}]/u.test(text);',
    '// @clause:HEX-LAST:REQ-001 preserves the derived value',
    'const node = <div>{/* @clause:HEX-LAST:REQ-002 displays the derived value */}</div>;'
  ].join('\n'), { sourcePath: 'src/App.jsx' }), [
    { clauseId: 'HEX-LAST:REQ-001', line: 5, tag: 'clause' },
    { clauseId: 'HEX-LAST:REQ-002', line: 6, tag: 'clause' }
  ]);
});

test('Windows CRLF string continuation does not turn string text into evidence or hide later JSX', () => {
  const source = [
    'const message = "continued\\',
    '// @clause:HEX-LAST:REQ-999 still string text";',
    'const node = <div>{/* @clause:HEX-LAST:REQ-001 shows the conversion */}</div>;'
  ].join('\r\n');
  assert.deepEqual(scanSourceClauseTags(source, { sourcePath: 'src/App.jsx' }), [
    { clauseId: 'HEX-LAST:REQ-001', line: 3, tag: 'clause' }
  ]);
});
