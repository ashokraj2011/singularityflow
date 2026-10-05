/**
 * The Code Explainer's model: what it counts, where it attributes a change, and what it refuses to
 * claim. The host harvests facts from the editor's language services; everything here runs on plain
 * data shaped like their answers, plus a real captured change (the XPL2 fixture).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildCodeExplainerModel, changePrompt, convertSymbols, copilotPrompt, countParameters, declaredName, diffLines,
  estimateComplexity, explanationText, exportDocument, externalLabel, flattenSymbols, hoverParts, isTestPath,
  leadingStart, maskSource, parseFilePatch, SYMBOL_KIND, symbolKey, textSymbols, visibleCode, workingDiff
} from '../apps/vscode/src/views/code-explainer-model.ts';
import { explainXpl2Subject } from '../src/comprehension/xpl2/subjects.mjs';
import { createXpl2Fixture } from './helpers/xpl2-fixture.mjs';

const symbol = (name, kind, start, end, children = [], character = 0) => ({
  name, kind, range: { start, end }, selection: { line: start, character }, children
});
const callEnd = (file, name, start, end, kind = SYMBOL_KIND.Function) => ({
  path: file, name, kind, range: { start, end }, selection: { line: start, character: 0 }
});

function baseInput(overrides = {}) {
  return {
    repository: { name: 'repo', branch: 'main', head: 'abc1234' },
    story: null,
    change: { view: null, patch: null, patchFiles: [], base: null },
    files: [], calls: [], callStatus: {}, references: [], referenceStatus: {}, hovers: {},
    focus: null, depth: 1, modelEnabled: false,
    ...overrides
  };
}

test('the line diff is the one Git computes, and it rebuilds the working text exactly', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sflow-cx-diff-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let seed = 11;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let trial = 0; trial < 120; trial += 1) {
    const before = Array.from({ length: Math.floor(random() * 30) }, () => `line ${Math.floor(random() * 6)}`);
    const after = before.slice();
    for (let edit = Math.floor(random() * 5); edit > 0; edit -= 1) {
      const at = Math.floor(random() * (after.length + 1));
      const choice = random();
      if (choice < 0.33 && after.length) after.splice(at, 1);
      else if (choice < 0.66) after.splice(at, 0, `new ${Math.floor(random() * 4)}`);
      else if (after.length) after[Math.min(at, after.length - 1)] = `changed ${Math.floor(random() * 4)}`;
    }
    const hunks = diffLines(before, after);
    const rebuilt = [];
    let next = 1;
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        if (line.b !== null) while (next < line.b) rebuilt.push(before[(next += 1) - 2]);
        if (line.k === ' ') { rebuilt.push(before[next - 1]); next += 1; }
        else if (line.k === '-') next += 1;
        else rebuilt.push(line.t);
      }
    }
    while (next <= before.length) { rebuilt.push(before[next - 1]); next += 1; }
    assert.deepEqual(rebuilt, after, `trial ${trial} rebuilds the after text`);
    await writeFile(path.join(dir, 'a'), before.length ? `${before.join('\n')}\n` : '');
    await writeFile(path.join(dir, 'b'), after.length ? `${after.join('\n')}\n` : '');
    const numstat = spawnSync('git', ['diff', '--no-index', '--numstat', '--diff-algorithm=myers', 'a', 'b'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
    const [added, removed] = numstat ? numstat.split(/\s+/).map(Number) : [0, 0];
    const lines = hunks.flatMap((hunk) => hunk.lines);
    assert.equal(lines.filter((line) => line.k === '+').length, added, `trial ${trial} adds what Git adds`);
    assert.equal(lines.filter((line) => line.k === '-').length, removed, `trial ${trial} removes what Git removes`);
  }
  const big = Array.from({ length: 2000 }, (_, index) => `row ${index}`);
  const edited = big.slice();
  edited[1500] = 'edited';
  edited.splice(10, 0, 'inserted');
  assert.deepEqual(diffLines(big, edited).map((hunk) => hunk.header), ['@@ -8,6 +8,7 @@', '@@ -1498,7 +1499,7 @@']);
});

test('a patch section keeps before and after line numbers for every line', () => {
  const hunks = parseFilePatch(['diff --git a/x b/x', '@@ -3,3 +3,4 @@ fn()', ' keep', '-old', '+new', '+more', ' tail'].join('\n'));
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0].lines, [
    { k: ' ', a: 3, b: 3, t: 'keep' }, { k: '-', a: null, b: 4, t: 'old' },
    { k: '+', a: 4, b: null, t: 'new' }, { k: '+', a: 5, b: null, t: 'more' }, { k: ' ', a: 6, b: 5, t: 'tail' }
  ]);
  assert.equal(visibleCode('a‮b\tc'), 'a[U+202E]b\tc', 'a bidirectional override is shown, a tab is kept');
});

test('complexity counts decisions in code only, and says it is an estimate', () => {
  const source = [
    'function f(a?: number, b = "if (x) && y") {',
    '  // if this were code it would count',
    '  const label = `for ${a}`;',
    '  if (a && b) return a ?? 0;',
    '  for (const item of list) { if (item?.ok || item.done) continue; }',
    '  return a > 1 ? "big" : "small";',
    '}'
  ].join('\n');
  const masked = maskSource(source, 'typescript');
  assert.equal(masked.length, source.length, 'masking keeps every column');
  assert.doesNotMatch(masked, /if this were code/);
  const estimate = estimateComplexity(source, 'typescript');
  assert.deepEqual(estimate.breakdown, { if: 2, for: 1, and: 1, or: 1, nullish: 1, ternary: 1 });
  assert.equal(estimate.complexity, 8);
  const python = estimateComplexity(['def f(x):', '    """if docs"""', '    if x and y:', '        return 1', '    elif x or z:', '        return 2', '    # while', '    return [v for v in x if v]'].join('\n'), 'python');
  assert.deepEqual(python.breakdown, { if: 3, for: 1, and: 1, or: 1 });
  assert.equal(countParameters('function f(a: Map<string, number>, b = [1, 2], c?: () => void): void'), 3);
  assert.equal(countParameters('def f()'), 0);
  assert.equal(countParameters('const x = 1'), null);
});

test('test files are recognised by the common conventions', () => {
  for (const file of ['test/retry.test.ts', 'src/__tests__/a.ts', 'pkg/a.spec.mjs', 'tests/test_app.py', 'svc/client_test.go', 'src/test/java/RetryTest.java', 'e2e/flow.e2e.ts']) {
    assert.equal(isTestPath(file), true, file);
  }
  for (const file of ['src/retry/policy.ts', 'src/contest.ts', 'docs/testing-notes.md', 'src/attestation.py']) {
    assert.equal(isTestPath(file), false, file);
  }
});

test('an outline keeps callables, folds anonymous callbacks into their function and sees through the file itself', () => {
  const lines = [
    'export const handler = (event) => {', '  const { a, b } = run(() => event);', '  return items.map((x) => x + 1);', '};',
    'const values = [1, 2].map((x) => x);', 'export class Retry {', '  wait = (n) => n * 2;', '  go() { return 1; }', '}'
  ];
  const outline = [
    symbol('handler', SYMBOL_KIND.Variable, 1, 4, [
      symbol('a', SYMBOL_KIND.Variable, 2, 2, [], 10), symbol('map() callback', SYMBOL_KIND.Function, 3, 3)
    ], 13),
    symbol('values', SYMBOL_KIND.Variable, 5, 5, [], 6),
    symbol('Retry', SYMBOL_KIND.Class, 6, 9, [symbol('wait', SYMBOL_KIND.Property, 7, 7, [], 2), symbol('go', SYMBOL_KIND.Method, 8, 8, [], 2)], 13)
  ];
  const flat = flattenSymbols(outline, lines);
  assert.deepEqual(flat.map((entry) => [entry.qualifiedName, entry.kind]), [
    ['handler', 'function'], ['Retry', 'class'], ['Retry.wait', 'method'], ['Retry.go', 'method']
  ], 'a destructured local, an anonymous callback and a non-function variable are not rows');
  const wrapped = flattenSymbols([symbol('retry.test.ts', SYMBOL_KIND.Module, 1, 9, [symbol("test('x') callback", SYMBOL_KIND.Function, 2, 4)])], lines, 200, 'retry.test.ts');
  assert.deepEqual(wrapped.map((entry) => entry.qualifiedName), ["test('x') callback"], 'a top-level test callback is a row; the file is not');
});

test('an outline read from text names functions, methods and test cases, nested by their braces or indentation', () => {
  const typescript = textSymbols(['/** Doc. */', 'export function a(x) {', '  if (x) { return 1; }', '  return 2;', '}', '', 'export class B {', '  run(n: number) {', '    return n;', '  }', '}', "test('works', () => {", '  a(1);', '});'], 'typescript');
  const shape = (list) => list.map((entry) => [entry.name, entry.range.start, entry.range.end, shape(entry.children ?? [])]);
  assert.deepEqual(shape(typescript), [['a', 2, 5, []], ['B', 7, 11, [['run', 8, 10, []]]], ["test('works')", 12, 14, []]]);
  const python = textSymbols(['class R:', '    def wait(self):', '        return 1', '', 'def top():', '    pass'], 'python');
  assert.deepEqual(shape(python), [['R', 1, 3, [['wait', 2, 3, []]]], ['top', 5, 6, []]]);
  assert.equal(leadingStart(['', '/**', ' * Doc.', ' */', '@decorator', 'function f() {}'], 6), 2, 'the doc comment and decorator above belong to it');
  assert.equal(leadingStart(['const a = 1;', '', 'function f() {}'], 3), 3);
  assert.equal(declaredName('-export async function retryWithBackoff(id) {'.slice(1)), 'retryWithBackoff');
  assert.equal(declaredName('  if (ready) {'), null);
});

test('the editor answer that carries both symbol shapes is read at the name, not the line start', () => {
  const range = (sl, sc, el, ec) => ({ start: { line: sl, character: sc }, end: { line: el, character: ec } });
  const merged = {
    name: 'calculateBackoff', kind: SYMBOL_KIND.Function, containerName: '',
    location: { uri: 'file:///x.ts', range: range(10, 0, 13, 1) },
    range: range(10, 0, 13, 1), selectionRange: range(10, 16, 10, 32), children: []
  };
  assert.deepEqual(convertSymbols([merged]), [{
    name: 'calculateBackoff', detail: null, kind: SYMBOL_KIND.Function, range: { start: 11, end: 14 },
    selection: { line: 11, character: 16 }, children: []
  }]);
  const information = { name: 'run', kind: SYMBOL_KIND.Method, containerName: 'Job', location: { range: range(4, 2, 6, 3) } };
  assert.deepEqual(convertSymbols([information]), [{
    name: 'run', kind: SYMBOL_KIND.Method, range: { start: 5, end: 7 }, selection: { line: 5, character: 2 }, container: 'Job', children: null
  }]);
  assert.equal(convertSymbols(undefined), null, 'no answer is not an empty outline');
});

test('hovers give a typed signature and documentation; external code is named by its package', () => {
  const parts = hoverParts([{ contents: [{ value: '```typescript\nfunction f(a: number): string\n```' }, { value: 'Formats it.\n\n*@param* a — [the value](https://example.test)' }] }]);
  assert.equal(parts.signature, 'function f(a: number): string');
  assert.equal(parts.doc, 'Formats it. @param a — the value');
  assert.deepEqual(hoverParts(undefined), { signature: null, doc: null });
  assert.equal(externalLabel('/repo/node_modules/@scope/pkg/dist/index.d.ts'), '@scope/pkg');
  assert.equal(externalLabel('/app/node_modules/typescript/lib/lib.es5.d.ts'), 'TypeScript standard library');
  assert.equal(externalLabel('/usr/lib/python3/json/__init__.py'), '__init__.py');
});

async function fixtureModel(t, extra = {}) {
  const fixture = await createXpl2Fixture(t);
  const view = explainXpl2Subject(fixture.input, { subject: 'change' });
  const read = async (file) => (await import('node:fs/promises')).readFile(path.join(fixture.root, file), 'utf8').then((text) => text.replace(/\n$/, '').split('\n'));
  const files = [
    { path: 'src/export/service.ts', language: 'typescript', lines: await read('src/export/service.ts'), symbols: [symbol('exportOrders', SYMBOL_KIND.Function, 1, 60, [], 16)] },
    { path: 'src/export/format.ts', language: 'typescript', lines: await read('src/export/format.ts'), symbols: [symbol('formatDate', SYMBOL_KIND.Function, 40, 42, [], 16)] },
    { path: 'src/export/filters.ts', language: 'typescript', lines: await read('src/export/filters.ts'), symbols: [symbol('filter10', SYMBOL_KIND.Variable, 10, 10, [], 13)] },
    { path: 'src/index.ts', language: 'typescript', lines: await read('src/index.ts'), symbols: [] },
    { path: 'test/export-range.test.ts', language: 'typescript', lines: ["test('range', () => {", '  exportOrders(range);', '});'], symbols: [symbol("test('range') callback", SYMBOL_KIND.Function, 1, 3)] },
    { path: 'external:TypeScript standard library', language: 'typescript', lines: null, symbols: null, external: true, label: 'TypeScript standard library' }
  ];
  const input = baseInput({
    story: {
      workId: 'ORD-418', title: 'Export orders as CSV', currentPhase: 'implementation', phaseOrder: ['specification', 'implementation'],
      phases: { specification: { status: 'approved', label: 'Specification' }, implementation: { status: 'in_progress', label: 'Implementation' } },
      approval: null, gates: { met: 3, total: 5, unmet: 1, outstanding: 2 }
    },
    change: { view, patch: fixture.diff.patch, patchFiles: fixture.diff.files, base: fixture.base },
    files,
    calls: [
      { from: callEnd('src/export/service.ts', 'exportOrders', 1, 60), to: callEnd('src/export/format.ts', 'formatDate', 40, 42), sites: [30, 12] },
      { from: callEnd('test/export-range.test.ts', "test('range') callback", 1, 3), to: callEnd('src/export/service.ts', 'exportOrders', 1, 60), sites: [2] },
      { from: callEnd('src/export/format.ts', 'formatDate', 40, 42), to: callEnd('external:TypeScript standard library', 'toISOString', 300, 300, SYMBOL_KIND.Method), sites: [41] }
    ],
    callStatus: { [symbolKey('src/export/format.ts', 40, 'formatDate')]: 'complete', [symbolKey('src/export/service.ts', 1, 'exportOrders')]: 'complete' },
    references: [{ symbol: symbolKey('src/export/service.ts', 1, 'exportOrders'), path: 'test/export-range.test.ts', line: 2 },
      { symbol: symbolKey('src/export/service.ts', 1, 'exportOrders'), path: 'src/other.ts', line: 9 }],
    referenceStatus: { [symbolKey('src/export/service.ts', 1, 'exportOrders')]: 'complete', [symbolKey('src/export/format.ts', 40, 'formatDate')]: 'complete' },
    hovers: { [symbolKey('src/export/format.ts', 40, 'formatDate')]: { signature: 'function formatDate(order: Order, timezone: string): string', doc: 'Formats an order date. More.' } },
    modelEnabled: true,
    ...extra
  });
  return { fixture, view, model: buildCodeExplainerModel(input, 'build-1'), input };
}

test('a captured change becomes changed functions, their callers, callees and tests', async (t) => {
  const { model } = await fixtureModel(t);
  const byName = (name) => model.symbols.find((entry) => entry.qualifiedName === name);
  const formatDate = byName('formatDate');
  assert.deepEqual([formatDate.status, formatDate.added, formatDate.removed, formatDate.hunks, formatDate.units], ['modified', 2, 2, 1, ['H-002']]);
  assert.deepEqual(formatDate.diff.filter((line) => line.k !== ' ').map((line) => line.k).join(''), '--++');
  assert.equal(formatDate.signature, 'function formatDate(order: Order, timezone: string): string');
  assert.equal(formatDate.signatureSource, 'language-service');
  assert.equal(formatDate.metrics.params, 2, 'parameters come from the typed signature');
  const exportOrders = byName('exportOrders');
  assert.deepEqual([exportOrders.status, exportOrders.hunks, exportOrders.units], ['modified', 2, ['H-003', 'H-004']]);
  assert.deepEqual(exportOrders.tests, [{ path: 'test/export-range.test.ts', line: 2, symbolId: byName("test('range') callback").id }],
    'only references from test files count, each pointing at the test that holds it');
  assert.equal(byName('filter10').kind, 'function', 'a variable bound to an arrow function is a function');
  assert.equal(byName("test('range') callback").role, 'test');
  assert.equal(byName('toISOString').role, 'external');
  assert.deepEqual(model.edges.map((edge) => [model.symbols.find((s) => s.id === edge.from).name, model.symbols.find((s) => s.id === edge.to).name, edge.sites]).sort(), [
    ['exportOrders', 'formatDate', [12, 30]],
    ['formatDate', 'toISOString', [41]],
    ["test('range') callback", 'exportOrders', [2]]
  ], 'one edge per caller and callee, its call sites in order');
  const index = model.modules.find((module) => module.path === 'src/index.ts');
  assert.deepEqual(model.symbols.filter((entry) => entry.moduleId === index.id).map((entry) => [entry.qualifiedName, entry.kind, entry.added, entry.removed]),
    [['(whole file)', 'file', 1, 1]], 'a code file with an empty outline changes at file level');
  const other = model.modules.find((module) => module.group && module.path === '(other files)');
  assert.deepEqual(other.symbolIds.map((id) => model.symbols.find((entry) => entry.id === id).name), ['assets/export-badge.png'],
    'files without code share one card');
  assert.equal(model.modules.find((module) => module.path === 'test/export-range.test.ts').role, 'test');
  assert.deepEqual(model.story.gates, { met: 3, total: 5, unmet: 1, outstanding: 2 }, 'the gate count is passed through, never recounted');
  assert.deepEqual(model.story.phases, { index: 2, total: 2, decided: 1 });
  assert.equal(model.change.files, 5);
  assert.equal(model.walkthrough.at(-1), model.symbols.find((entry) => entry.qualifiedName === '(whole file)').id, 'whole-file rows are read last');
  const reading = model.walkthrough.map((id) => model.symbols.find((entry) => entry.id === id).qualifiedName);
  assert.deepEqual(reading.slice(0, 3).sort(), ['exportOrders', 'filter10', 'formatDate'], 'changed functions come first');
  assert.ok(reading.indexOf('exportOrders') < reading.indexOf('formatDate'), 'the walkthrough reads a caller before the function it calls');
});

test('the explanation states facts and names what they do not prove', async (t) => {
  const { model } = await fixtureModel(t);
  const text = (name) => explanationText(model, model.symbols.find((entry) => entry.qualifiedName === name).id);
  const formatDate = text('formatDate');
  assert.match(formatDate, /`formatDate` is a function in src\/export\/format\.ts, lines 40–42 \(3 lines\)\./);
  assert.match(formatDate, /Its documentation says: “Formats an order date\.”/);
  assert.match(formatDate, /This change edits it: 2 lines added and 2 lines removed in 1 hunk \(H-002\)\./);
  assert.match(formatDate, /It is called from 1 place: exportOrders in src\/export\/service\.ts\./);
  assert.match(formatDate, /Counted from its text, not a syntax tree\./);
  assert.match(formatDate, /Requirement `ORD:AC-003` \(“Format timestamps in the user timezone\.”\) is associated with this file's change region\. That link is at file level; it does not prove this code implements it\./);
  assert.match(formatDate, /No test file refers to it/);
  assert.match(text('exportOrders'), /A reference shows a test names it, not that the test exercises this change\./);
  assert.match(text('exportOrders'), /calls 1 function: formatDate in src\/export\/format\.ts/);
  for (const sentence of model.symbols.map((entry) => explanationText(model, entry.id))) {
    assert.doesNotMatch(sentence, /\b(covered|verified|guarantees|proves that|is safe)\b/i, 'no sentence claims coverage or proof');
  }
});

test('the trace joins requirements, changed code, tests and recorded results without inventing links', async (t) => {
  const { model } = await fixtureModel(t);
  assert.equal(model.trace.available, true);
  assert.deepEqual(model.trace.requirements.map((entry) => [entry.id, entry.status, entry.modules, entry.gap]), [
    ['ORD:AC-001', 'tagged', ['m:src/export/service.ts'], null],
    ['ORD:AC-002', 'tagged', ['m:src/export/filters.ts'], null],
    ['ORD:AC-003', 'untagged', ['m:src/export/format.ts'], 'No test tag recorded']
  ]);
  assert.deepEqual(model.trace.tests.map((entry) => [entry.path, entry.requirements, entry.source]), [
    ['test/export-cancel.test.ts', ['ORD:AC-002'], 'declared-tag'],
    ['test/export-range.test.ts', ['ORD:AC-001'], 'both']
  ], 'a declared tag and a language-service reference to the same test file are one test with both sources');
  assert.deepEqual(model.trace.runs.map((run) => [run.label, run.status]), [['range-test', 'passed'], ['cancellation-test', 'passed']]);
  assert.deepEqual(model.trace.counts, { requirements: 3, tagged: 2, gaps: 1, tests: 2, runs: 2, passed: 2, failed: 0 });
  assert.ok(model.attention.length && model.attention.every((group) => group.count >= 1 && group.text));
  assert.equal(new Set(model.attention.map((group) => `${group.category}:${group.reason}`)).size, model.attention.length, 'attention is grouped by kind and reason');
});

test('a rewritten function owns its removed lines and its doc comment; a deleted function is named', () => {
  const before = ['import x from "x";', '', '/** Waits one second. */', 'export function wait(attempt) {', '  return 1000;', '}', '',
    'function sleep(ms) {', '  return new Promise((r) => setTimeout(r, ms));', '}', '', 'const LIMIT = 3;', 'const SPARE = 4;', '', 'export function tail() {', '  return LIMIT;', '}'];
  const after = ['import x from "x";', '', '/**', ' * Exponential backoff with jitter.', ' */', 'export function wait(attempt, base = 1000) {', '  return Math.random() * base * 2 ** attempt;', '}', '',
    'const LIMIT = 3;', '', 'export function tail() {', '  return LIMIT;', '}'];
  const hunks = diffLines(before, after);
  const model = buildCodeExplainerModel(baseInput({
    change: {
      view: {
        nodes: [], relationships: [], statements: [], attention: [],
        inventory: { files: [{ fileId: 'file:a', path: 'src/a.ts', pathBefore: 'src/a.ts', pathAfter: 'src/a.ts', operation: 'modified', unitIds: ['O-001'], hunks: 0, opaque: 1, sources: { before: 'ref:b', after: 'ref:a' } }],
          units: [{ unitId: 'O-001', fileId: 'file:a', path: 'src/a.ts', pathBefore: 'src/a.ts', pathAfter: 'src/a.ts', operation: 'modified', hunk: null, opaqueReason: 'opaque-content' }] }
      },
      patch: null, patchFiles: [], base: 'base', computed: { 'src/a.ts': hunks }
    },
    files: [{ path: 'src/a.ts', language: 'typescript', lines: after, symbols: [symbol('wait', SYMBOL_KIND.Function, 6, 8, [], 16), symbol('tail', SYMBOL_KIND.Function, 12, 14, [], 16)] }]
  }), 'build-2');
  const find = (name) => model.symbols.find((entry) => entry.qualifiedName === name);
  assert.deepEqual([find('wait').status, find('wait').added, find('wait').removed], ['modified', 5, 3],
    'the doc comment above it and the removed lines of its rewrite are the function\'s');
  assert.deepEqual([find('sleep').kind, find('sleep').status, find('sleep').removed], ['removed', 'removed', 4],
    'the deleted function carries its own lines and the blank line deleted with it');
  assert.equal(find('(module scope)').removed, 1, 'a constant deleted between functions is module scope, not the next function');
  assert.equal(find('tail').status, 'unchanged');
  assert.equal(model.modules[0].diffable, true, 'captured sources make an exact diff available');
  assert.equal(model.modules[0].opaque, null, 'a computed diff makes the change text, not opaque');
});

test('nothing is called deleted when the working text cannot be read, and a code file without a service gets a text outline', () => {
  const view = {
    nodes: [], relationships: [], statements: [], attention: [],
    inventory: { files: [{ fileId: 'file:a', path: 'src/a.py', pathBefore: 'src/a.py', pathAfter: 'src/a.py', operation: 'modified', unitIds: [], hunks: 1, opaque: 0 }], units: [] }
  };
  const patch = ['diff --git a/src/a.py b/src/a.py', '--- a/src/a.py', '+++ b/src/a.py', '@@ -1,3 +1,3 @@', '-def old_name(x):', '+def new_name(x):', '     return x', ' '].join('\n');
  const change = { view, patch, patchFiles: [{ pathBefore: 'src/a.py', pathAfter: 'src/a.py', patchStart: 0, patchEnd: patch.length }], base: 'b' };
  const unreadable = buildCodeExplainerModel(baseInput({ change, files: [{ path: 'src/a.py', language: 'python', lines: null, symbols: null }] }), 'x');
  assert.equal(unreadable.symbols.some((entry) => entry.kind === 'removed'), false);
  const readable = buildCodeExplainerModel(baseInput({ change, files: [{ path: 'src/a.py', language: 'python', lines: ['def new_name(x):', '    return x', ''], symbols: null }] }), 'y');
  assert.equal(readable.modules[0].symbolSource, 'text');
  assert.deepEqual(readable.symbols.map((entry) => [entry.qualifiedName, entry.status]), [['new_name', 'modified'], ['old_name', 'removed']]);
  assert.equal(readable.intelligence.languages[0].symbols, 'text');
});

test('the Story\'s own records share one folded card', () => {
  const files = ['singularity/work-items/S-1/workflow.json', 'singularity/work-items/S-1/STATUS.md', 'README.md'];
  const view = {
    nodes: [], relationships: [], statements: [], attention: [],
    inventory: { files: files.map((file, index) => ({ fileId: `file:${index}`, path: file, pathBefore: null, pathAfter: file, operation: 'added', unitIds: [`O-00${index}`], hunks: 0, opaque: 1 })), units: [] }
  };
  const model = buildCodeExplainerModel(baseInput({ change: { view, patch: null, patchFiles: [], base: 'b' } }), 'z');
  const records = model.modules.find((module) => module.path === '(story records)');
  const other = model.modules.find((module) => module.path === '(other files)');
  assert.deepEqual([records.symbolIds.length, records.collapsed, records.role], [2, true, 'other']);
  assert.deepEqual([other.symbolIds.length, other.collapsed], [1, false]);
  assert.deepEqual(model.walkthrough, [], 'documents and records are not steps of the code walkthrough');
});

test('prompts and the export carry facts, never the source or an authority', async (t) => {
  const { model } = await fixtureModel(t);
  const formatDate = model.symbols.find((entry) => entry.qualifiedName === 'formatDate');
  const prompt = copilotPrompt(model, formatDate.id);
  assert.match(prompt, /^Explain `formatDate` in src\/export\/format\.ts lines 40-42 for Story ORD-418\./);
  assert.match(prompt, /derived from the code, no model/);
  assert.match(prompt, /#file:src\/export\/format\.ts$/);
  assert.equal(copilotPrompt(model, 's:missing'), null);
  assert.match(changePrompt(model), /- `exportOrders` \(src\/export\/service\.ts:1\): modified \+2 -2; 1 callers, 1 callees/);
  const exported = exportDocument(model, '2026-10-05T00:00:00.000Z');
  assert.equal(exported.kind, 'singularity-flow-code-explanation');
  assert.equal(exported.authority, 'none');
  const text = JSON.stringify(exported);
  assert.doesNotMatch(text, /createdAt\.toISOString|formatInZone/, 'no changed source line is exported');
  assert.ok(exported.symbols.every((entry) => !('diff' in entry)));
  assert.ok(exported.symbols.find((entry) => entry.name === 'formatDate').explanation.includes('does not prove'));
});

test('a working file that cannot be read gives no diff rather than a deleted file', () => {
  assert.equal(workingDiff('a\nb\n', null, false), null, 'unreadable is not empty');
  assert.deepEqual(workingDiff('a\nb\n', null, true)[0].lines.map((line) => line.k).join(''), '--', 'a deleted file removes its lines');
  assert.deepEqual(workingDiff(null, ['x', ''], false)[0].lines.map((line) => [line.k, line.t]), [['+', 'x']], 'a new file adds its lines');
  assert.deepEqual(workingDiff('a\r\nb\r\n', ['a', 'c', ''], false)[0].lines.map((line) => line.k).join(''), ' -+', 'line endings do not count as changes');
});

test('the symbol at a requested line is named, so a rebuilt view can select it', async (t) => {
  const { model: plain } = await fixtureModel(t);
  assert.equal(plain.requested, null, 'nothing was asked for');
  const { model } = await fixtureModel(t, { focus: { path: 'src/export/format.ts', line: 41 } });
  assert.equal(model.requested, model.symbols.find((entry) => entry.qualifiedName === 'formatDate').id);
  assert.equal(model.focus, model.requested);
  const { model: between } = await fixtureModel(t, { focus: { path: 'src/export/format.ts', line: 3 } });
  assert.equal(between.requested, null, 'a line outside every function names nothing');
});
