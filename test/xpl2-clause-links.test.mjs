/**
 * Clause links in a change explanation: `@clause` comments link changed code to a clause, `@ac`
 * comments link changed tests to a criterion, and a clause's specification text links it to the
 * clauses it names. Every link is read from the capture itself (the changed files' own bytes and
 * the Story's specification artifacts), never inferred from names or adjacency.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { buildComprehensionChangeSet } from '../src/comprehension/code-scope.mjs';
import { readStoryClauseSources } from '../src/comprehension/xpl2/clause-sources.mjs';
import { patchAddedLines, readChangeSourceTags } from '../src/comprehension/xpl2/source-tags.mjs';
import { explainXpl2Subject } from '../src/comprehension/xpl2/subjects.mjs';
import { cliJson, comprehensionSlice, createChangeRepository, isolatedHome, xpl2InputFor } from './helpers/xpl2-fixture.mjs';
import { attribute, mapBlock, renderExplorer } from './helpers/xpl2-html.mjs';

const CART_BEFORE = [
  '// @clause:OLD-1:REQ-001 keeps the legacy rounding rule',
  'export function total(items) {',
  '  return items.length;',
  '}',
  ''
].join('\n');
const CART_AFTER = [
  '// @clause:OLD-1:REQ-001 keeps the legacy rounding rule',
  '// @clause:FIX-1:REQ-001 — sums item prices instead of counting items',
  'export function total(items) {',
  '  return items.reduce((sum, item) => sum + item.price, 0);',
  '}',
  ''
].join('\n');

async function taggedChange(t) {
  return createChangeRepository(t, {
    baseline: { 'src/cart.js': CART_BEFORE, 'test/cart.test.js': "import test from 'node:test';\n" },
    change: {
      'src/cart.js': CART_AFTER,
      'src/discount.js': '// @clause:FIX-1:REQ-002\nexport const discount = 0.1;\n',
      'test/cart.test.js': "import test from 'node:test';\n// @ac:FIX-1:AC-001\ntest('total sums prices', () => {});\n"
    }
  });
}

test('only the patch\'s own added lines count as written by the change', () => {
  const patch = [
    'diff --git a/a.js b/a.js', '--- a/a.js', '+++ b/a.js',
    '@@ -1,4 +1,5 @@', ' keep', '-old', '+new one', '+new two', '', ' tail', '\\ No newline at end of file',
    '@@ -20 +21,2 @@', '-x', '+y', '+z', ''
  ].join('\n');
  const added = patchAddedLines({ status: 'available', patch, files: [{ pathAfter: 'a.js', patchStart: 0, patchEnd: patch.length }] });
  // The empty line is a context line printed without its space (diff.suppressBlankEmpty).
  assert.deepEqual([...added.get('a.js')].sort((a, b) => a - b), [2, 3, 21, 22]);
  assert.equal(patchAddedLines({ status: 'unavailable', patch: null, files: [] }).size, 0);
});

test('change explanations retain real JSX clause notes without treating rendered text as tags', async (t) => {
  const { root } = await createChangeRepository(t, {
    baseline: { 'src/App.jsx': 'export const App = () => <div />;\n' },
    change: { 'src/App.jsx': [
      'export const App = () => <div title="/* @clause:FIX-1:REQ-999 */">',
      '/* @clause:FIX-1:REQ-998 rendered text is not a comment */',
      '{/* @clause:fix-1:req-001 connects the shared conversion control */}<Keypad />',
      '</div>;',
      ''
    ].join('\n') }
  });
  const slice = await comprehensionSlice(root);
  const view = slice.explanationView;
  const notes = view.statements.filter(entry => entry.kind === 'clause-tag');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].arguments.clauseId, 'FIX-1:REQ-001');
  assert.equal(notes[0].arguments.path, 'src/App.jsx');
  assert.equal(notes[0].arguments.line, 3);
  assert.match(notes[0].text, /author's note “connects the shared conversion control”/u);
  assert.equal(notes[0].text.includes('Keypad'), false);
});

test('tags in the changed files link code and tests to clauses, with the author\'s note', async (t) => {
  const { root } = await taggedChange(t);
  const slice = await comprehensionSlice(root);
  const view = slice.explanationView;
  const node = (id) => view.nodes.find((entry) => entry.id === id);
  const fileId = (file) => view.inventory.files.find((entry) => entry.path === file).fileId;
  const edges = (type) => view.relationships.filter((edge) => edge.type === type);

  assert.equal(view.sources.find((source) => source.id === 'SRC-TAGS')?.properties.integrity, 'verified');
  assert.deepEqual(edges('source-tags-clause').map((edge) => [edge.from, edge.to, edge.qualifier]).sort(), [
    [fileId('src/cart.js'), 'clause:FIX-1:REQ-001', 'added'],
    [fileId('src/discount.js'), 'clause:FIX-1:REQ-002', 'added']
  ].sort(), 'a tag already in the file for work no Story here declares is not shown');
  assert.equal(node('clause:OLD-1:REQ-001'), undefined);
  assert.equal(node('clause:FIX-1:REQ-001').status, 'not-declared-here');

  const note = view.statements.find((entry) => entry.kind === 'clause-tag' && entry.arguments.clauseId === 'FIX-1:REQ-001');
  assert.equal(note.about, 'clause:FIX-1:REQ-001');
  assert.deepEqual({ path: note.arguments.path, line: note.arguments.line, placement: note.arguments.placement },
    { path: 'src/cart.js', line: 2, placement: 'added' });
  assert.match(note.text, /author's note “sums item prices instead of counting items”/u);
  assert.match(view.statements.find((entry) => entry.arguments?.clauseId === 'FIX-1:REQ-002').text, /with no note/u);

  const testNode = view.nodes.find((entry) => entry.kind === 'test' && entry.label === 'test/cart.test.js');
  assert.ok(edges('test-source-tags-clause').some((edge) => edge.from === testNode.id && edge.to === 'clause:FIX-1:AC-001'));
  assert.ok(edges('test-source-in-change').some((edge) => edge.from === testNode.id && edge.to === fileId('test/cart.test.js')));
  assert.equal(view.inventory.counts.clauseTags, 2);
  assert.equal(view.inventory.counts.acceptanceTags, 1);
  // A change whose author wrote down the clause it serves is not a change with no recorded reason.
  assert.equal(view.attention.filter((entry) => entry.category === 'missing-explanation').length, 0);
});

test('the terminal change view prints the links', async (t) => {
  const { root } = await taggedChange(t);
  const home = await isolatedHome(t);
  const result = cliJson(root, home, ['explain', '--subject', 'change']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /src\/cart\.js:2 tags FIX-1:REQ-001 \(added by this change\) with the author's note/u);
  assert.match(result.stdout, /test\/cart\.test\.js:2 tags acceptance criterion FIX-1:AC-001/u);
  assert.match(result.stdout, /2 @clause tag\(s\) · 1 @ac tag\(s\)/u);
});

test('a file edited after the capture moves the snapshot instead of mixing two moments', async (t) => {
  const { root, base } = await taggedChange(t);
  const { changeSet } = await buildComprehensionChangeSet(root, { baseCommit: base, subject: { kind: 'comprehension-observation' } });
  await writeFile(path.join(root, 'src/discount.js'), '// @clause:FIX-1:REQ-009\nexport const discount = 0.2;\n');
  await assert.rejects(readChangeSourceTags(root, changeSet, null), { code: 'CMP_SNAPSHOT_CHANGED' });
});

test('a clause\'s specification text links it to the clauses it names, across artifacts', async (t) => {
  const scope = '# Scope\n\n- [FIX-1:REQ-001] Totals sum item prices.\n';
  const design = '# Design\n\n- [FIX-1:IFC-001] total(items) returns the sum FIX-1:REQ-001 requires.\n';
  const { root, base } = await createChangeRepository(t, {
    baseline: { 'docs/scope.md': scope, 'docs/design.md': design, 'src/cart.js': CART_BEFORE },
    change: { 'src/cart.js': CART_AFTER }
  });
  const workflow = {
    workItem: { id: 'FIX-1' }, phaseOrder: ['scope', 'design'],
    phases: {
      scope: { status: 'approved', artifacts: [{ path: 'docs/scope.md', kind: 'requirements' }] },
      design: { status: 'in_progress', artifacts: [{ path: 'docs/design.md', kind: 'requirements' }] }
    }
  };
  const clauseSources = await readStoryClauseSources(root, workflow);
  // The design cites a clause the scope artifact declares; it is not a corrupt artifact.
  assert.deepEqual(clauseSources.artifacts.map((artifact) => artifact.status), ['read', 'read']);
  assert.deepEqual(clauseSources.artifacts[1].clauses[0].dependsOn, ['FIX-1:REQ-001']);

  const { input } = await xpl2InputFor(root, base, { workflow, clauseSources });
  const view = explainXpl2Subject(input, { subject: 'change' });
  assert.deepEqual(view.relationships.filter((edge) => edge.type === 'clause-cites-clause').map((edge) => [edge.from, edge.to]),
    [['clause:FIX-1:IFC-001', 'clause:FIX-1:REQ-001']]);
  assert.match(view.statements.find((entry) => entry.kind === 'clause-cites').text,
    /FIX-1:IFC-001 names FIX-1:REQ-001 in its specification text \(docs\/design\.md:3\)/u);
  assert.equal(view.inventory.counts.clauseCitations, 1);

  // Asking about the cited clause reaches the clause that cites it.
  const asked = explainXpl2Subject(input, { subject: 'clause', id: 'FIX-1:REQ-001' });
  assert.ok(asked.selection.nodes.includes('clause:FIX-1:IFC-001'));
  assert.ok(asked.statements.filter((entry) => asked.selection.statements.includes(entry.id))
    .some((entry) => entry.kind === 'clause-cites'));
});

test('the Change Explorer draws tag and citation links and names a file\'s own tags instead of a missing reason', async (t) => {
  const { root } = await taggedChange(t);
  const slice = await comprehensionSlice(root);
  const view = slice.explanationView;
  const html = renderExplorer(view, { patch: slice.diff.patch, patchFiles: slice.diff.files });
  const rail = (file) => html.match(new RegExp(`<strong>${file.replaceAll('.', '\\.')}</strong><span class="xpl-sub">([^<]*)</span>`, 'u'))?.[1];
  assert.match(rail('src/cart.js'), /@clause FIX-1:REQ-001$/u);
  assert.match(rail('src/discount.js'), /opaque resource · @clause FIX-1:REQ-002$/u, 'a new file keeps saying its content is not projected');
  assert.match(rail('test/cart.test.js'), /@ac FIX-1:AC-001$/u);
  const edges = JSON.parse(attribute(html, 'data-edges'));
  assert.ok(edges.some((edge) => edge.style === 'proposed' && edge.toNode === 'clause:FIX-1:REQ-001'), 'a declared @clause tag is drawn');
  // Tagged files sit in the Changed code column, linked, not under "Also changed".
  assert.match(mapBlock(html), /data-column="code"[^>]*>[\s\S]*?src\/cart\.js/u);
  assert.match(html, /Declared tag \(@clause in code, @ac in tests\)/u);
});
