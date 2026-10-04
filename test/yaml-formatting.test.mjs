import test from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import {
  preserveYamlFormatting, renderDataPreservingFormatting, renderPreservingFormatting
} from '../src/yaml-formatting.mjs';
import { changedLines } from './helpers/folded-yaml.mjs';
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

test('a document is rendered and replayed with one set of options, so only the edit changes', () => {
  const long = 'Intake, code, testing, and code checking with committed test receipts and explicit reviewer feedback.';
  // One value folded by the library's defaults and one written on a single long line by a person.
  const folded = YAML.parseDocument(`workTypes:\n  classic:\n    label: Classic\n    description: ${long}\n`).toString();
  const original = `${folded}  feature:\n    label: Feature\n    description: ${long}\n`;
  const document = YAML.parseDocument(original);
  document.setIn(['workTypes', 'feature', 'label'], 'Feature work');
  const expected = original.replace('    label: Feature\n', '    label: Feature work\n');
  assert.equal(renderPreservingFormatting(original, document), expected);
  assert.equal(renderPreservingFormatting(original, document, {}), expected, 'the library defaults on both sides');
  // Rendered with the defaults but compared with YAML_OUTPUT, the long line is folded too.
  assert.notEqual(preserveYamlFormatting(original, document.toString()), expected);
  assert.equal(renderPreservingFormatting(null, document), document.toString(YAML_OUTPUT), 'a new file is the rendering');
});

const MAINTAINED = [
  '# Configuration people maintain by hand.',
  'version: 1',
  'name: "Payments"  # quoted on purpose',
  'phases: [intake, design, build]',
  'reviewers:',
  '  # The lead reviews first.',
  '  - name: Ada',
  '    email: ada@example.test',
  '  - name: Grace',
  '    email: grace@example.test',
  'repositories: {}',
  'retired: true',
  ''
].join('\n');

function patched(original, change, options) {
  const data = YAML.parse(original);
  change(data);
  const merged = renderDataPreservingFormatting(original, data, options);
  assert.deepEqual(YAML.parse(merged), data, 'the text holds exactly the data');
  return changedLines(original, merged);
}

test('plain data written back changes only what changed, keeping quoting, comments and list layout', () => {
  assert.deepEqual(patched(MAINTAINED, (data) => { data.name = 'Payments platform'; }), {
    removed: ['name: "Payments"  # quoted on purpose'], added: ['name: "Payments platform" # quoted on purpose']
  });
  assert.deepEqual(patched(MAINTAINED, (data) => { data.phases[1] = 'architecture'; }), {
    removed: ['phases: [intake, design, build]'], added: ['phases: [intake, architecture, build]']
  });
  assert.deepEqual(patched(MAINTAINED, (data) => { data.reviewers.push({ name: 'Linus', email: 'linus@example.test' }); }), {
    removed: [], added: ['  - name: Linus', '    email: linus@example.test']
  });
  assert.deepEqual(patched(MAINTAINED, (data) => { data.reviewers.splice(1, 1); }), {
    removed: ['  - name: Grace', '    email: grace@example.test'], added: []
  });
  assert.deepEqual(patched(MAINTAINED, (data) => { delete data.retired; data.owner = 'platform'; }), {
    removed: ['retired: true'], added: ['owner: platform']
  });
});

test('an empty flow collection filled with data becomes a block collection', () => {
  assert.deepEqual(patched(MAINTAINED, (data) => { data.repositories.api = { url: 'https://git.example.test/api.git' }; }), {
    removed: ['repositories: {}'], added: ['repositories:', '  api:', '    url: https://git.example.test/api.git']
  });
});

test('a change made to a normalized reading writes only the change, not the normalization', () => {
  // A reader filled in a default the file never wrote; the change is to another field.
  const normalized = { ...YAML.parse(MAINTAINED), timeoutMinutes: 30 };
  const changed = { ...structuredClone(normalized), retired: false };
  const merged = renderDataPreservingFormatting(MAINTAINED, changed, { before: normalized });
  assert.deepEqual(changedLines(MAINTAINED, merged), { removed: ['retired: true'], added: ['retired: false'] });
  assert.equal(YAML.parse(merged).timeoutMinutes, undefined);
  assert.equal(renderDataPreservingFormatting(null, { a: [1, 2] }), 'a:\n  - 1\n  - 2\n', 'a new file is the rendering');
});

test('a folded file written back from plain data keeps every folded value', () => {
  const folded = YAML.parseDocument(ORIGINAL).toString();
  const merged = renderDataPreservingFormatting(folded, { ...YAML.parse(folded), version: 2 });
  assert.deepEqual(changedLines(folded, merged), { removed: ['version: 1'], added: ['version: 2'] });
});
