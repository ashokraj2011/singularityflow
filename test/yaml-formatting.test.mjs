import test from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { preserveYamlFormatting } from '../src/yaml-formatting.mjs';
import { YAML_OUTPUT } from '../src/util.mjs';

const ORIGINAL = [
  'version: 1',
  '# Work types people maintain by hand.',
  'workTypes:',
  '  classic:',
  '    label: Classic',
  '    description: Intake, code, testing, and code checking with committed test',
  '      receipts, the guarded manual pilot, and explicit reviewer feedback.',
  '    phases: [intake, implementation,',
  '      testing, conformance]',
  '  feature:',
  '    label: Feature',
  '    phaseOverrides:',
  '      design: { inputs: [requirements] }',
  '    notes: |',
  '      Kept as a block.',
  '      Two lines.',
  ''
].join('\n');

function edit(original, change) {
  const document = YAML.parseDocument(original);
  change(document);
  return preserveYamlFormatting(original, document.toString(YAML_OUTPUT));
}

test('an edit to one key leaves folded values, multi-line flow lists, padding and comments as written', () => {
  const merged = edit(ORIGINAL, (document) => document.setIn(['workTypes', 'feature', 'label'], 'Feature work'));
  assert.equal(merged, ORIGINAL.replace('    label: Feature\n', '    label: Feature work\n'));
});

test('a key added beside folded values is the only new line, and the folded values stay folded', () => {
  const merged = edit(ORIGINAL, (document) => document.setIn(['workTypes', 'classic', 'owner'], 'platform'));
  const lines = merged.split('\n');
  assert.deepEqual(lines.filter((line) => !ORIGINAL.split('\n').includes(line)), ['    owner: platform']);
  assert.match(merged, /committed test\n {6}receipts, the guarded/);
  assert.deepEqual(YAML.parse(merged).workTypes.classic.owner, 'platform');
});

test('an edited folded value is written by the library, and everything around it keeps its form', () => {
  const merged = edit(ORIGINAL, (document) => document.setIn(['workTypes', 'classic', 'description'], 'Short now.'));
  assert.match(merged, /\n {4}description: Short now\.\n {4}phases: \[intake, implementation,\n {6}testing, conformance\]\n/);
  assert.match(merged, /design: \{ inputs: \[requirements\] \}/);
  assert.equal(YAML.parse(merged).workTypes.classic.description, 'Short now.');
});

test('the library rendering is used whenever the replay would not parse to the same data', () => {
  const broken = 'a: [1,\n  2\n';
  const rendered = 'a: [ 1, 2 ]\n';
  assert.equal(preserveYamlFormatting(broken, rendered), rendered, 'an original the library cannot parse cleanly is not replayed');
  const merged = edit(ORIGINAL, (document) => document.deleteIn(['workTypes', 'classic']));
  assert.deepEqual(YAML.parse(merged), { version: 1, workTypes: { feature: YAML.parse(ORIGINAL).workTypes.feature } });
  assert.match(merged, /design: \{ inputs: \[requirements\] \}/);
});

test('a file the library folded at 80 columns, with values on the line after their key, keeps that layout', () => {
  const long = 'Intake, code, testing, and code checking with committed test receipts and explicit reviewer feedback.';
  const folded = YAML.parseDocument(`workTypes:\n  classic:\n    label: Classic\n    description: ${long}\n    phases: [intake, implementation, testing, conformance, verification, release, convergence, planning]\n  feature:\n    label: Feature\n`).toString();
  assert.match(folded, /committed test\n {6}receipts and explicit/, 'the library folds the long value');
  assert.match(folded, /phases:\n {6}\[\n {8}intake,\n/, 'and writes the long flow list under its key, an item a line');
  const merged = edit(folded, (document) => document.setIn(['workTypes', 'feature', 'label'], 'Feature work'));
  assert.equal(merged, folded.replace('    label: Feature\n', '    label: Feature work\n'));
});
