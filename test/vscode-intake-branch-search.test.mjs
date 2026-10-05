/** Drive the actual intake script over the branch controls rendered by the actual form. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  EMPTY_INTAKE_FORM, INTAKE_SCRIPT, intakeHtml, intakeProblems, intakeCommand, storyPreflightCommand
} from '../apps/vscode/src/views/intake-form.ts';

const choice = (branch, story) => ({ branch, story, present: 1, total: 1, everywhere: true, missingFrom: [] });
const choices = [
  choice('main'),
  choice('feature/payments', { workId: 'PAY-12', title: 'Retry failed charges' }),
  choice('release/2026-10'),
  choice('feature/café')
];
const form = (overrides = {}) => ({
  ...EMPTY_INTAKE_FORM, shape: 'story', id: 'new-story', title: 'New Story',
  storyWorkflows: [{ id: 'feature', label: 'Feature', description: '', phases: ['intake'] }],
  workType: 'feature', baseRemote: 'origin', baseBranchChoices: choices, ...overrides
});
const decode = (text) => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attribute = (html, name) => decode(new RegExp(`\\s${name}="([^"]*)"`).exec(html)?.[1] ?? '');

/** Minimal browser-like controls, populated from HTML rather than a second branch catalog. */
function mount(intake = form(), priorState = {}) {
  const html = intakeHtml(intake);
  const handlers = {};
  const messages = [];
  let state = structuredClone(priorState);
  const element = (data = {}) => ({
    dataset: data, hidden: false, disabled: false, scrollTop: 0, value: '',
    hasAttribute(name) {
      const key = name.replace(/^data-/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      return Object.hasOwn(this.dataset, key);
    },
    closest(selector) { return this.hasAttribute(selector.slice(1, -1)) ? this : null; },
    focus() { document.activeElement = this; },
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  });
  const document = {
    activeElement: element(),
    addEventListener(name, handler) { (handlers[name] ??= []).push(handler); },
    querySelector(selector) {
      if (selector === 'input[data-base-branch]:checked') return rows.find((row) => row.input.checked)?.input ?? null;
      return controls[selector] ?? null;
    },
    querySelectorAll(selector) { return selector === '[data-base-branch-choice]' ? rows : []; }
  };
  const rows = [...html.matchAll(/<label\b[^>]*data-base-branch-choice[^>]*>([\s\S]*?)<\/label>/g)].map(([markup]) => {
    const row = element({ baseBranchChoice: '', baseBranchSearchText: attribute(markup, 'data-base-branch-search-text') });
    const tag = markup.match(/<input\b[^>]*>/)[0];
    const input = element({ baseBranch: attribute(tag, 'data-base-branch') });
    input.value = attribute(tag, 'value');
    input.checked = /\schecked(?=[\s>])/.test(tag);
    input.closest = (selector) => selector === '[data-base-branch-choice]' ? row : null;
    row.input = input;
    return row;
  });
  const controls = {};
  for (const name of ['search', 'clear', 'count', 'empty', 'selected']) {
    if (html.includes(`data-base-branch-${name}`)) controls[`[data-base-branch-${name}]`] = element({
      [`baseBranch${name[0].toUpperCase()}${name.slice(1)}`]: ''
    });
  }
  const window = {
    scrollY: 0, addEventListener() {}, scrollTo(_x, y) { this.scrollY = y; },
    __sfVscode: {
      getState: () => structuredClone(state), setState: (value) => { state = structuredClone(value); },
      postMessage: (message) => { messages.push(JSON.parse(JSON.stringify(message))); }
    }
  };
  runInNewContext(INTAKE_SCRIPT, { window, document, setTimeout });
  const dispatch = (name, target) => { for (const handler of handlers[name] ?? []) handler({ target }); };
  const search = controls['[data-base-branch-search]'];
  return {
    html, rows, search, messages, controls, document, window,
    state: () => structuredClone(state),
    visible: () => rows.filter((row) => !row.hidden).map((row) => row.input.value),
    type(query) {
      search.focus();
      search.value = query;
      search.setSelectionRange(query.length, query.length);
      dispatch('input', search);
    },
    selectText(start, end) { search.setSelectionRange(start, end); dispatch('select', search); },
    clear() { dispatch('click', controls['[data-base-branch-clear]']); },
    select(branch) {
      rows.forEach((row) => { row.input.checked = row.input.value === branch; });
      dispatch('change', rows.find((row) => row.input.checked).input);
    }
  };
}

test('every offered Story base list has a labelled search, count, clear action and radio group', () => {
  for (const baseBranchChoices of [choices, [choice('main')]]) {
    const view = mount(form({ baseBranchChoices }));
    assert.match(view.html, /<label for="story-base-branch-search">Search branches/);
    assert.match(view.html, /type="search"[^>]*data-base-branch-search/);
    assert.match(view.html, /aria-controls="story-base-branch-choices" aria-describedby="story-base-branch-count"/);
    assert.match(view.html, /data-base-branch-count role="status" aria-live="polite"/);
    assert.match(view.html, /id="story-base-branch-choices" role="radiogroup" aria-label="Story base branch"/);
    assert.equal(view.controls['[data-base-branch-count]'].textContent, `${baseBranchChoices.length} of ${baseBranchChoices.length} branches`);
    assert.equal(view.controls['[data-base-branch-clear]'].disabled, true);
    assert.ok(view.rows.every((row) => !row.input.checked), 'even a sole match is not selected automatically');
  }
});

test('branch filtering is case-insensitive, literal, and searches Story IDs and titles locally', () => {
  const view = mount();
  for (const query of ['  PAYMENTS  ', 'pay-12', 'FAILED charges']) {
    view.type(query);
    assert.deepEqual(view.visible(), ['feature/payments']);
    assert.equal(view.controls['[data-base-branch-count]'].textContent, '1 of 4 branches');
    assert.ok(view.rows.every((row) => !row.input.checked));
  }
  view.type('cafe\u0301');
  assert.deepEqual(view.visible(), ['feature/café'], 'canonically equivalent Unicode matches');
  view.type('.*');
  assert.deepEqual(view.visible(), [], 'query is not executed as a regular expression');
  assert.deepEqual(view.messages, [], 'searching does not call the host, preflight, or Git');
  assert.ok(intakeProblems(form()).includes('Choose the remote base branch from which the Story branch will be created.'));
});

test('no results and clear are recoverable without changing the selected base', () => {
  const view = mount(form({ baseBranch: 'main' }));
  view.type('missing-branch');
  assert.deepEqual(view.visible(), []);
  assert.equal(view.controls['[data-base-branch-empty]'].hidden, false);
  assert.equal(view.controls['[data-base-branch-count]'].textContent, '0 of 4 branches');
  assert.equal(view.controls['[data-base-branch-selected]'].textContent,
    'Selected base: main. This selection is hidden by the search.');
  assert.equal(view.rows[0].input.checked, true);
  view.clear();
  assert.deepEqual(view.visible(), choices.map((entry) => entry.branch));
  assert.equal(view.controls['[data-base-branch-empty]'].hidden, true);
  assert.equal(view.controls['[data-base-branch-selected]'].textContent, 'Selected base: main.');
  assert.equal(view.controls['[data-base-branch-clear]'].disabled, true);
  assert.equal(view.search.value, '');
  assert.equal(view.document.activeElement, view.search, 'clear returns focus to the search');
  assert.equal(view.state().intakeView.branchSearch, '');
  assert.deepEqual(view.messages, []);
});

test('choosing a filtered result still sends only the existing authoritative branch-selection message', () => {
  const view = mount();
  view.type('payments');
  view.select('feature/payments');
  assert.deepEqual(view.messages, [{ type: 'baseBranch', value: 'feature/payments' }]);
  assert.equal(view.controls['[data-base-branch-selected]'].textContent, 'Selected base: feature/payments.');
});

test('background catalog/readiness redraw preserves search, focus, caret and re-filters new results', () => {
  const view = mount();
  view.window.scrollY = 420;
  view.type('feature/');
  view.selectText(2, 5);
  const saved = view.state();
  const redrawn = mount(form({ baseBranchChoices: [...choices, choice('feature/new'), choice('fix/new')] }), saved);
  assert.equal(redrawn.search.value, 'feature/');
  assert.deepEqual(redrawn.visible(), ['feature/payments', 'feature/café', 'feature/new']);
  assert.equal(redrawn.controls['[data-base-branch-count]'].textContent, '3 of 6 branches');
  assert.equal(redrawn.document.activeElement, redrawn.search);
  assert.equal(redrawn.search.selectionStart, 2);
  assert.equal(redrawn.search.selectionEnd, 5);
  assert.equal(redrawn.window.scrollY, 420);
  assert.deepEqual(redrawn.messages, []);
  assert.ok(redrawn.rows.every((row) => !row.input.checked));
});

test('branch and Story names are escaped and search values never become executable markup', () => {
  const branch = 'feature/<script>&"billing';
  const title = '<img src=x onerror="alert(1)">';
  const view = mount(form({ baseBranchChoices: [choice(branch, { workId: 'PAY-1', title })], baseBranch: branch }));
  assert.doesNotMatch(view.html, /<script>|<img src=x/);
  assert.match(view.html, /feature\/&lt;script&gt;&amp;&quot;billing/);
  view.type('<script>&"');
  assert.deepEqual(view.visible(), [branch]);
  assert.equal(view.controls['[data-base-branch-selected]'].textContent, `Selected base: ${branch}.`);
  view.type('<img src=x');
  assert.deepEqual(view.visible(), [branch]);
  assert.deepEqual(view.messages, []);
});

test('large catalogs filter without host calls or disturbing the selected base', () => {
  const many = Array.from({ length: 1500 }, (_, index) => choice(`feature/module-${index}`));
  const view = mount(form({ baseBranchChoices: many, baseBranch: 'feature/module-10' }));
  view.type('module-1499');
  assert.deepEqual(view.visible(), ['feature/module-1499']);
  assert.equal(view.controls['[data-base-branch-count]'].textContent, '1 of 1500 branches');
  assert.equal(view.rows[10].input.checked, true);
  assert.deepEqual(view.messages, []);
});

test('branch search is absent for other work shapes or a catalog that is still unavailable', () => {
  for (const overrides of [
    { shape: 'epic' }, { shape: 'initiative' },
    { baseBranchChoices: [], catalogStatus: 'loading' },
    { baseBranchReason: 'Cannot read branches' }
  ]) {
    const view = mount(form(overrides));
    assert.equal(view.search, undefined);
    assert.deepEqual(view.messages, []);
  }
});

test('filtered rows stay hidden despite the shared choice layout and long catalogs scroll', async () => {
  const styles = await readFile(new URL('../apps/vscode/src/views/webview.ts', import.meta.url), 'utf8');
  assert.match(styles, /\.base-branch-choices > \[hidden\] \{ display: none !important; \}/);
  assert.match(styles, /\.base-branch-choices \{ max-height: 24rem; overflow-y: auto;/);
});

test('baseline and ongoing scope are independent explicit choices, not implied risk acceptance', () => {
  const intake = form({ baseBranch: 'main', baselinePolicy: 'choice', readinessBaseline: 'defer',
    testExecutionMode: 'all-configured' });
  const view = mount(intake);
  assert.match(view.html, /Existing-test baseline/);
  assert.match(view.html, /value="defer" checked\s*>/);
  assert.match(view.html, /All configured tests/);
  assert.doesNotMatch(view.html, /data-baseline-run/);
  for (const args of [intakeCommand(intake), storyPreflightCommand(intake)]) {
    assert.equal(args[args.indexOf('--readiness-baseline') + 1], 'defer');
    assert.equal(args[args.indexOf('--test-execution-mode') + 1], 'all-configured');
    assert.ok(!args.includes('--accept-test-risk') && !args.includes('--test-baseline-disposition'));
  }
  const strict = intakeHtml({ ...intake, baselinePolicy: 'required', readinessBaseline: 'reuse' });
  assert.doesNotMatch(strict, /data-readiness-baseline value="defer"\s+disabled/);
  assert.match(strict, /Test setup, missing results and existing failures do not block Story creation/);
  assert.match(intakeHtml({ ...intake, readinessBaseline: 'run' }), /Review baseline commands/);
});

test('reviewed-run choice waits for the exact selected base and never starts while baseline runs', () => {
  const intake = form({ baseBranch: 'main', readinessBaseline: 'run', baselineRunCommit: null,
    baseTestReadiness: { repositories: [{ id: 'application', baseCommit: 'a'.repeat(40) }] } });
  const baselineProblem = value => intakeProblems(value).some(problem => /Review and run the selected baseline/.test(problem));
  assert.equal(baselineProblem(intake), true);
  assert.equal(baselineProblem({ ...intake, baselineRunCommit: 'a'.repeat(40) }), false);
  assert.equal(baselineProblem({ ...intake, baselineRunCommit: 'b'.repeat(40) }), true);
  assert.ok(intakeProblems({ ...intake, baselineRunning: true }).some(problem => /Wait for the reviewed baseline/.test(problem)));
});
