/**
 * What this change does [CSP, docs/SPEC-CSP-CHANGE-STORY-PAGE-v1.md]: the page's builder on a real Git repository and a
 * Story's records, with no CLI. SFlow's facts (files, functions, criteria, tests and the run), Copilot's checked English,
 * the "not described yet" fallback, the withheld text and the reasons' sources.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildChangeStory, changeStorySummary, documentDecisions, renderChangeStory, writeChangeStoryPage } from '../src/change-story-page.mjs';
import { changeStorySummaryOf, readChangeStoryPage } from '../src/change-story-read.mjs';
import { functionChanges, testCaseChanges } from '../src/change-story-functions.mjs';
import { xpl2TextWithheld } from '../src/comprehension/xpl2/narration.mjs';
import { inventedValue } from './helpers/invented-secrets.mjs';

const W = 'GRAPH-12';
const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

const BEFORE_GRAPH = [
  'export function parseFunction(text) {', '  return new Function(\'x\', `return ${text}`);', '}', '',
  'export function render(points) {', '  return points.length;', '}', '',
  'export function legacyParse(text) {', '  return Number(text);', '}', ''].join('\n');
const AFTER_GRAPH = [
  `// @clause:${W}:AC-001 plots the typed function`,
  'export function parseFunction(text) {', '  try {', '    return { run: new Function(\'x\', `return ${text}`) };', '  } catch (error) {', '    return { error: error.message };', '  }', '}', '',
  'export function render(points) {', '  return points.length;', '}', '',
  'export function plot(text) {', '  const parsed = parseFunction(text);', '  return parsed.error ? [] : sample(parsed.run);', '}', '',
  'function sample(run) {', '  const points = [];', '  for (let x = -10; x <= 10; x += 0.05) points.push([x, run(x)]);', '  return points;', '}', ''].join('\n');
const BEFORE_TEST = ['import test from \'node:test\';', 'import assert from \'node:assert/strict\';', 'import { render } from \'../src/graph.mjs\';', '',
  'test(\'renders points\', () => {', '  assert.equal(render([1]), 1);', '});', ''].join('\n');
const AFTER_TEST = ['import test from \'node:test\';', 'import assert from \'node:assert/strict\';', 'import { plot, render } from \'../src/graph.mjs\';', '',
  'test(\'renders points\', () => {', '  assert.equal(render([1, 2]), 2);', '});', '', `// @ac:${W}:AC-001`,
  'test(\'plots a parabola\', () => {', '  assert.ok(plot(\'x * x\').length > 0);', '});', ''].join('\n');

async function story(t, { explanation = null, runs = null, settled = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-change-story-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Page Tester');
  git(root, 'config', 'user.email', 'page.tester@example.invalid');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, 'src/graph.mjs'), BEFORE_GRAPH);
  await writeFile(path.join(root, 'src/old-axis.mjs'), 'export function axis() {\n  return 0;\n}\n');
  await writeFile(path.join(root, 'test/graph.test.mjs'), BEFORE_TEST);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  const baseCommit = git(root, 'rev-parse', 'HEAD');
  await writeFile(path.join(root, 'src/graph.mjs'), AFTER_GRAPH);
  await writeFile(path.join(root, 'src/axis.mjs'), `// @clause:${W}:AC-002 labels the axes\nexport function label(value) {\n  return String(value);\n}\n`);
  await rm(path.join(root, 'src/old-axis.mjs'));
  await writeFile(path.join(root, 'test/graph.test.mjs'), AFTER_TEST);
  const item = path.join(root, 'singularity/work-items', W);
  await mkdir(path.join(item, 'artifacts/intake'), { recursive: true });
  await mkdir(path.join(item, 'artifacts/plan'), { recursive: true });
  await mkdir(path.join(item, 'artifacts/implementation'), { recursive: true });
  await writeFile(path.join(item, 'source.json'), JSON.stringify({ description: 'Let a person type a function and see its graph. It must never crash on a typo. A third sentence is left out.' }));
  await writeFile(path.join(item, 'artifacts/intake/intake.md'), [`# ${W} — intake`, '', '## Acceptance criteria', '',
    '| Clause | Observable outcome |', '|---|---|', `| [${W}:AC-001] | Typing x * x draws a parabola. |`, `| [${W}:AC-002] | The axes are labelled. |`, ''].join('\n'));
  await writeFile(path.join(item, 'artifacts/plan/plan.md'), ['# Plan', '', '## Changes', '', '- Not a decision.', '', '## Decisions', '',
    '<!-- sflow:guidance a comment, never a decision -->', '1. Sample 400 points between -10 and 10, because a smooth line needs no more.', '2. Return an error message instead of throwing.', '',
    '## Risks', '', '- Not a decision either.', ''].join('\n'));
  if (explanation) await writeFile(path.join(item, 'artifacts/implementation/change-explanation.json'), JSON.stringify(explanation));
  const workflow = {
    workItem: { id: W, title: 'Plot a function', baseCommit },
    phaseOrder: ['intake', 'plan', 'implementation', 'testing'],
    phases: {
      intake: { id: 'intake', label: 'Intake', status: 'approved', generation: 1, requiredArtifact: { path: 'artifacts/intake/intake.md', kind: 'requirements' },
        artifacts: [{ path: `singularity/work-items/${W}/artifacts/intake/intake.md`, kind: 'requirements' }] },
      plan: { id: 'plan', label: 'Plan', status: 'approved', generation: 1, requiredArtifact: { path: 'artifacts/plan/plan.md', kind: 'plan' } },
      implementation: { id: 'implementation', label: 'Code', status: 'awaiting_approval', generation: 1,
        requiredArtifact: { path: 'artifacts/implementation/implementation-summary.md', kind: 'implementation-summary' },
        deliveryEvidence: {
          testPaths: ['test/graph.test.mjs'],
          changeSet: { entries: [{ status: 'modified', oldPath: 'src/graph.mjs', newPath: 'src/graph.mjs' }, { status: 'added', oldPath: null, newPath: 'src/axis.mjs' },
            { status: 'deleted', oldPath: 'src/old-axis.mjs', newPath: null }, { status: 'modified', oldPath: 'test/graph.test.mjs', newPath: 'test/graph.test.mjs' },
            { status: 'modified', oldPath: '.vscode/settings.json', newPath: '.vscode/settings.json' }] },
          ...(runs ? { preflightAttempts: runs } : {})
        } },
      testing: { id: 'testing', label: 'Testing', status: 'not_started', generation: 0, requiredArtifact: { path: 'artifacts/testing/testing.md', kind: 'test-evidence' } }
    },
    ...(settled ? { settledDecisions: settled } : {})
  };
  return { root, workflow, item };
}

const GOOD = {
  how: 'When the person types in the Graph tab, the text goes to the parser, which turns it into a function the app can run. The plot then runs that function at points between minus ten and ten and joins them into a line.',
  functions: {
    'src/graph.mjs': {
      parseFunction: { does: 'Turns the typed text into a function the app can run', needs: 'the typed text', gives: 'the function, or a short error message',
        changed: 'before, a typo made it crash; now it gives back an error message instead' },
      plot: { does: 'Draws the typed function as a line', needs: 'the typed text', gives: 'the points of the line' },
      render: { does: 'Not changed, so this entry names nothing in the change' },
      legacyParse: { does: 'Read a number; see https://example.invalid/docs for more' }
    },
    'src/elsewhere.mjs': { anything: { does: 'A file this change does not hold' } }
  },
  reasons: ['The plot keeps the last good line while the person is still typing.', { text: 'A reason about a file the change does not hold.', file: 'src/elsewhere.mjs' }]
};

test('SFlow\'s facts: each delivered file, its functions, its criteria and its tests, against the Story\'s base [CSP:REQ-001]', async (t) => {
  const { root, workflow } = await story(t, { explanation: GOOD });
  const model = await buildChangeStory(root, {}, workflow);
  assert.deepEqual(model.files.map((file) => [file.path, file.change, file.test]),
    [['src/axis.mjs', 'new', false], ['src/graph.mjs', 'edited', false], ['src/old-axis.mjs', 'removed', false], ['test/graph.test.mjs', 'edited', true]],
    'an editor\'s settings are never part of the change');
  const graph = model.files.find((file) => file.path === 'src/graph.mjs');
  assert.deepEqual(graph.functions.map((entry) => [entry.display, entry.change, entry.helperOf ?? null]),
    [['parseFunction', 'edited', null], ['plot', 'new', null], ['sample', 'new', 'plot:function'], ['legacyParse', 'removed', null]]);
  assert.deepEqual(graph.criteria, [`${W}:AC-001`]);
  assert.deepEqual(model.files.find((file) => file.path === 'src/axis.mjs').criteria, [`${W}:AC-002`]);
  const tests = model.files.find((file) => file.test);
  assert.deepEqual(tests.cases, [{ name: 'renders points', change: 'edited', criteria: [] }, { name: 'plots a parabola', change: 'new', criteria: [`${W}:AC-001`] }]);
  assert.deepEqual(model.asked.criteria.map((clause) => clause.id), [`${W}:AC-001`, `${W}:AC-002`]);
  assert.match(model.asked.criteria[0].text, /Typing x \* x draws a parabola/u);
  assert.equal(model.asked.request, 'Let a person type a function and see its graph. It must never crash on a typo.');
});

test('Copilot\'s English is shown once checked; a function with none reads "not described yet" [CSP:REQ-002, REQ-003]', async (t) => {
  const { root, workflow } = await story(t, { explanation: GOOD });
  const model = await buildChangeStory(root, {}, workflow);
  const page = renderChangeStory(model);
  assert.match(page, /^\*\*Edited\*\* `src\/graph\.mjs` \(serves `GRAPH-12:AC-001`\)$/mu);
  assert.match(page, /^- \*\*Edited\*\* `parseFunction`: Turns the typed text into a function the app can run\. It needs the typed text\. It gives back the function, or a short error message\. What changed: before, a typo made it crash; now it gives back an error message instead\.$/mu);
  assert.match(page, /^- \*\*New\*\* `plot`: Draws the typed function as a line\. .* Also adds a small helper, `sample`, used only here\.$/mu);
  assert.doesNotMatch(page, /^- \*\*New\*\* `sample`/mu, 'a single-use helper folds under its caller');
  // The entry with a link is withheld, so the removed function reads as not described; the entries naming nothing in the change are dropped.
  assert.match(page, /^- \*\*Removed\*\* `legacyParse`: not described yet\.$/mu);
  assert.doesNotMatch(page, /example\.invalid|elsewhere/u);
  assert.match(page, /^\*\*New\*\* `src\/axis\.mjs` \(serves `GRAPH-12:AC-002`\)$/mu);
  assert.match(page, /^- \*\*New\*\* `label`: not described yet\.$/mu);
  assert.match(page, /^Removed: `src\/old-axis\.mjs` and `legacyParse` from `src\/graph\.mjs`\.$/mu);
  assert.match(page, /^\*\*Removed\*\* `src\/old-axis\.mjs`\n\n- \*\*Removed\*\* `axis`: not described yet\.\n\nRemoved:/mu, 'a removed file has its block too, last');
  assert.match(page, /^When the person types in the Graph tab/mu);
  assert.equal(model.withheld, 4, 'the link, the unchanged function, the other file\'s entry and the reason about it');
  assert.match(page, /SFlow did not show 4 notes from the code step/u);

  // No explanation at all: every fact is still there, and every function reads "not described yet".
  const bare = await story(t);
  const plain = renderChangeStory(await buildChangeStory(bare.root, {}, bare.workflow));
  assert.match(plain, /^Not described yet: the code step wrote no explanation SFlow could show\.$/mu);
  assert.match(plain, /^- \*\*Edited\*\* `parseFunction`: not described yet\.$/mu);
  for (const heading of ['## 1. What we had to do', '## 2. How it works', '## 3. Why we did it this way', '## 4. What we changed', '## 5. How it was tested']) {
    assert.ok(plain.includes(heading), heading);
  }
  assert.doesNotMatch(plain, /## 6\. Outside the plan/u, 'no record of code outside the plan, no section');
});

test('a text with markup, a link or a secret\'s shape is withheld by XPL2\'s check [CSP:REQ-003]', async (t) => {
  assert.deepEqual(xpl2TextWithheld('It adds two numbers and gives back their sum.'), []);
  assert.ok(xpl2TextWithheld('See https://example.invalid/x').includes('commentary-markup'));
  assert.ok(xpl2TextWithheld('It calls `eval` on the text').includes('commentary-markup'));
  assert.ok(xpl2TextWithheld(`It uses the key ${inventedValue('AKIA', 'Z7QX3B5N8M2K4L6P')} to sign`).includes('commentary-secret-shaped'));
  assert.ok(xpl2TextWithheld('x'.repeat(50), { maximumCharacters: 20 }).includes('commentary-oversized'));
  const { root, workflow } = await story(t, { explanation: { how: '<b>bold</b> words', functions: {}, reasons: [] } });
  const model = await buildChangeStory(root, {}, workflow);
  assert.equal(model.how, null);
  assert.equal(model.withheld, 1);
});

test('the reasons come from the approved plan first, then Copilot\'s own, each with its source [CSP:REQ-004]', async (t) => {
  const { root, workflow } = await story(t, { explanation: GOOD });
  const page = renderChangeStory(await buildChangeStory(root, {}, workflow));
  assert.match(page, /^- Sample 400 points between -10 and 10, because a smooth line needs no more\. \(plan, decision 1\)$/mu);
  assert.match(page, /^- Return an error message instead of throwing\. \(plan, decision 2\)$/mu);
  assert.match(page, /^- The plot keeps the last good line while the person is still typing\. \(Copilot's reason\)$/mu);
  assert.doesNotMatch(page, /Not a decision/u);
  assert.deepEqual(documentDecisions(['## Alternatives and decisions', '', '| Decision | Why |', '|---|---|', '| Use a canvas | It is fast |', '', '- Keep the old parser', '', '## Next', '- no'].join('\n'))
    .map((entry) => entry.text), ['Use a canvas; It is fast', 'Keep the old parser']);
});

test('the tests section waits for SFlow\'s own run, then says what it found [CSP:REQ-006]', async (t) => {
  const waiting = await story(t);
  const before = await buildChangeStory(waiting.root, {}, waiting.workflow);
  assert.equal(before.tests.ran, false);
  assert.match(renderChangeStory(before), /^Tests not run yet: SFlow runs them when Testing is published, and this page says what it found\.$/mu);
  assert.match(changeStorySummary(before), /tests not run yet\.$/u);
  const ran = await story(t, { runs: [{ commandId: 'unit', status: 'passed', counts: { passed: 2, failed: 0, skipped: 0 } }] });
  const after = await buildChangeStory(ran.root, {}, ran.workflow);
  assert.match(renderChangeStory(after), /^SFlow ran them on the delivered code \(Code version 1\): 2 passed\.$/mu);
  assert.equal(changeStorySummary(after), '3 files and 5 functions changed, 2 tests; SFlow\'s run: 2 passed.');
});

test('files changed outside the plan are listed from WCB\'s record, by Copilot with its reason or by you', async (t) => {
  const settled = [{ id: 'S-1', kind: 'plan-accounting', by: 'sflow', phase: 'implementation', subject: 'file:src/axis.mjs',
    effect: { file: 'src/axis.mjs', class: 'out-of-plan', writer: 'copilot', reason: 'the labels needed their own module' } },
  { id: 'S-2', kind: 'plan-accounting', by: 'sflow', phase: 'implementation', subject: 'file:README.md', effect: { file: 'README.md', class: 'out-of-plan', writer: 'person' } }];
  const { root, workflow } = await story(t, { settled });
  const page = renderChangeStory(await buildChangeStory(root, {}, workflow));
  assert.match(page, /^## 6\. Outside the plan\n\n- `README\.md`: by you\n- `src\/axis\.mjs`: by Copilot: the labels needed their own module$/mu);
});

test('the page is written in the Story\'s folder with its summary line, and read back [CSP:REQ-005]', async (t) => {
  const { root, workflow, item } = await story(t, { explanation: GOOD });
  const written = await writeChangeStoryPage(root, {}, workflow);
  assert.equal(written.path, `singularity/work-items/${W}/CHANGE-STORY.md`);
  assert.equal(written.written, true);
  const text = await readFile(path.join(item, 'CHANGE-STORY.md'), 'utf8');
  assert.match(text, /^# What this change does: GRAPH-12, "Plot a function"$/mu);
  assert.equal(changeStorySummaryOf(text), written.summary);
  assert.equal((await writeChangeStoryPage(root, {}, workflow)).written, false, 'the same records write the same bytes');
  const read = await readChangeStoryPage(root, {}, workflow);
  assert.equal(read.summary, written.summary);
  assert.equal(read.path, written.path);
  // No code step with a published version: no page.
  const none = structuredClone(workflow);
  none.phases.implementation.generation = 0;
  assert.equal(await buildChangeStory(root, {}, none), null);
});

test('functions and tests are found in Java and Python too, by name and text', async () => {
  const java = await functionChanges('src/Cart.java', 'class Cart {\n  int add(int x) {\n    return x;\n  }\n  void old() {}\n}\n',
    'class Cart {\n  int add(int x) {\n    return x + 1;\n  }\n  int total() {\n    return 2;\n  }\n}\n');
  assert.deepEqual(java.functions.map((entry) => [entry.display, entry.change]), [['Cart.add', 'edited'], ['Cart.total', 'new'], ['Cart.old', 'removed']]);
  const python = await functionChanges('cart.py', 'def add(x):\n    return x\n', 'def add(x):\n    return x + 1\n\ndef total():\n    return 2\n');
  assert.deepEqual(python.functions.map((entry) => [entry.display, entry.change]), [['add', 'edited'], ['total', 'new']]);
  assert.deepEqual((await functionChanges('notes.txt', 'a', 'b')).read, false);
  assert.deepEqual((await testCaseChanges('CartTest.java', null, 'class CartTest {\n  @Test\n  void addsOne() {\n    assertEquals(2, add(1));\n  }\n}\n')).map((entry) => entry.name), ['addsOne']);
  assert.deepEqual((await testCaseChanges('test_cart.py', null, 'def test_adds():\n    assert add(1) == 2\n')).map((entry) => entry.name), ['test_adds']);
});

test('a later version\'s page keeps the files only an earlier version changed, from that version\'s change set', async (t) => {
  const { root, workflow, item } = await story(t);
  const code = workflow.phases.implementation;
  code.generation = 2;
  // Version 2 changed only the graph module; version 1's record holds the new axis module and the removed one.
  code.deliveryEvidence.changeSet.entries = code.deliveryEvidence.changeSet.entries.filter((entry) => entry.newPath === 'src/graph.mjs');
  code.deliveryEvidence.changeSetPath = `singularity/work-items/${W}/context/code-delivery/implementation-gen2-changes.json`;
  await mkdir(path.join(item, 'context/code-delivery'), { recursive: true });
  await writeFile(path.join(item, 'context/code-delivery/implementation-gen1-changes.json'), JSON.stringify({ entries: [
    { status: 'added', oldPath: null, newPath: 'src/axis.mjs' }, { status: 'deleted', oldPath: 'src/old-axis.mjs', newPath: null }] }));
  const model = await buildChangeStory(root, {}, workflow);
  assert.deepEqual(model.files.map((file) => [file.path, file.change]), [['src/axis.mjs', 'new'], ['src/graph.mjs', 'edited'], ['src/old-axis.mjs', 'removed']]);
  assert.match(renderChangeStory(model), /^Tests not run yet/mu);
});
