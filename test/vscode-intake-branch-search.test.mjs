/** Drive the actual intake script over the branch controls rendered by the actual form. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  EMPTY_INTAKE_FORM, INTAKE_SCRIPT, intakeHtml, intakeRegions, intakeProblems, intakeCommand, storyPreflightCommand
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

test('intake pins hard/soft quality mode and changes invalidate the approved preview', async () => {
  const { intakePlanInputKey } = await import('../apps/vscode/src/views/intake-form.ts');
  const hard = form({ baseBranch: 'main' }); const soft = { ...hard, qualityGateMode: 'soft' };
  assert.equal(hard.qualityGateMode, 'hard');
  assert.match(intakeHtml(soft), /data-quality-gate-mode value="soft" checked/);
  for (const build of [intakeCommand, storyPreflightCommand]) {
    const args = build(soft); assert.equal(args[args.indexOf('--gate-mode') + 1], 'soft');
  }
  assert.notEqual(intakePlanInputKey(hard), intakePlanInputKey(soft));
});
const decode = (text) => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attribute = (html, name) => decode(new RegExp(`\\s${name}="([^"]*)"`).exec(html)?.[1] ?? '');

const workflowForm = (overrides = {}) => form({
  storyWorkflows: [
    { id: 'feature', label: 'Feature', description: 'Ship a feature', phases: ['intake', 'implementation'] },
    { id: 'demo-web', label: 'Demo café', description: 'Compare screenshots', phases: ['test', 'repair'] },
    { id: 'custom', label: 'Team <script> & review', description: 'Inspect code', phases: ['review'] }
  ], availableStoryWorkflows: [{ id: 'packaged', label: 'Packaged test', description: 'Install first', phases: ['test'] }],
  favouriteWorkflows: ['demo-web'], ...overrides
});

/** Minimal browser-like controls, populated from HTML rather than a second branch catalog. */
function mount(intake = form(), priorState = {}) {
  const html = intakeHtml(intake);
  const handlers = {};
  const windowHandlers = {};
  const messages = [];
  let state = structuredClone(priorState);
  const element = (data = {}) => ({
    dataset: data, hidden: false, disabled: false, scrollTop: 0, value: '', attributes: {}, children: [], listeners: {},
    getAttribute(name) { return this.attributes[name] ?? null; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    addEventListener(name, listener) { this.listeners[name] = listener; },
    appendChild(node) {
      if (node.parent) node.parent.children = node.parent.children.filter((child) => child !== node);
      node.parent = this; this.children.push(node); return node;
    },
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
      if (selector === 'input[data-work-type]:checked') return workflowRows.find((row) => row.input?.checked)?.input ?? null;
      return controls[selector] ?? null;
    },
    querySelectorAll(selector) {
      if (selector.startsWith('input[data-field]')) return Object.values(controls).filter((el) => el.dataset?.field);
      return selector === '[data-base-branch-choice]' ? rows : selector === '[data-workflow-search-text]' ? workflowRows : [];
    }
  };
  const rows = [...html.matchAll(/<label\b[^>]*data-base-branch-choice[^>]*>([\s\S]*?)<\/label>/g)].map(([markup]) => {
    const row = element({ baseBranchChoice: '', baseBranchName: attribute(markup, 'data-base-branch-name'), baseBranchSearchText: attribute(markup, 'data-base-branch-search-text') });
    const tag = markup.match(/<input\b[^>]*>/)[0];
    const input = element({ baseBranch: attribute(tag, 'data-base-branch') });
    input.value = attribute(tag, 'value');
    input.checked = /\schecked(?=[\s>])/.test(tag);
    input.closest = (selector) => selector === '[data-base-branch-choice]' ? row : null;
    row.input = input;
    return row;
  });
  const controls = {};
  const workflowRows = [...html.matchAll(/<article\b[^>]*data-workflow-search-text[^>]*>([\s\S]*?)<\/article>/g)].map(([markup]) => {
    const row = element({ workflowSearchText: attribute(markup, 'data-workflow-search-text'),
      ...(markup.includes('data-workflow-choice=') ? { workflowChoice: attribute(markup, 'data-workflow-choice') } : {}) });
    const radio = markup.match(/<input\b[^>]*>/)?.[0];
    if (radio) {
      row.input = element({ workType: attribute(radio, 'data-work-type') });
      row.input.value = attribute(radio, 'value'); row.input.checked = /\schecked(?=[\s>])/.test(radio);
      row.input.closest = (selector) => selector === '[data-workflow-choice]' ? row : null;
      const tag = markup.match(/<button\b[^>]*data-workflow-favourite[^>]*>/)[0];
      row.favourite = element({ workflowFavourite: attribute(tag, 'data-workflow-favourite') });
      row.favourite.setAttribute('aria-pressed', attribute(tag, 'aria-pressed'));
    }
    row.querySelector = (selector) => selector === '[data-workflow-favourite]' ? row.favourite : null;
    return row;
  });
  for (const name of ['search', 'search-button', 'search-clear', 'count', 'empty', 'selected', 'favourites-empty', 'favourite-list', 'other-list', 'other']) {
    if (html.includes(`data-workflow-${name}`)) controls[`[data-workflow-${name}]`] = element({
      ['workflow' + name.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('')]: ''
    });
  }
  const other = controls['[data-workflow-other]'];
  if (other) {
    other.open = false; other.summary = element(); other.querySelector = (selector) => selector === 'summary' ? other.summary : null;
  }
  for (const name of ['search', 'exact', 'clear', 'count', 'empty', 'selected']) {
    if (html.includes(`data-base-branch-${name}`)) controls[`[data-base-branch-${name}]`] = element({
      [`baseBranch${name[0].toUpperCase()}${name.slice(1)}`]: ''
    });
  }
  for (const [id, html] of Object.entries(intakeRegions(intake))) {
    controls['[data-intake-region="' + id + '"]'] = { innerHTML: html };
  }
  controls['.intake-view'] = element();
  const window = {
    scrollY: 0, addEventListener(name, handler) { (windowHandlers[name] ??= []).push(handler); }, scrollTo(_x, y) { this.scrollY = y; },
    __sfVscode: {
      getState: () => structuredClone(state), setState: (value) => { state = structuredClone(value); },
      postMessage: (message) => { messages.push(JSON.parse(JSON.stringify(message))); }
    }
  };
  runInNewContext(INTAKE_SCRIPT, { window, document, setTimeout });
  assert.deepEqual(messages.splice(0), [{ type: 'intakeReady' }], 'one view-only handshake, not a readiness/Git call');
  const dispatch = (name, target) => { for (const handler of handlers[name] ?? []) handler({ target }); };
  const search = controls['[data-base-branch-search]'];
  return {
    html, rows, search, messages, controls, document, window, workflowRows,
    element,
    patch(data) { for (const handler of windowHandlers.message ?? []) handler({ data: { type: 'intakePatch', ...data } }); },
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
    exact(checked) {
      const toggle = controls['[data-base-branch-exact]']; toggle.checked = checked; dispatch('change', toggle);
    },
    workflowType(query) {
      const control = controls['[data-workflow-search]']; control.focus(); control.value = query;
      control.setSelectionRange(query.length, query.length); dispatch('input', control);
    },
    workflowClear() { dispatch('click', controls['[data-workflow-search-clear]']); },
    favourite(id) { dispatch('click', workflowRows.find((row) => row.dataset.workflowChoice === id).favourite); },
    workflowSelect(id) {
      workflowRows.forEach((row) => { if (row.input) row.input.checked = row.input.value === id; });
      dispatch('change', workflowRows.find((row) => row.input?.checked).input);
    },
    select(branch) {
      rows.forEach((row) => { row.input.checked = row.input.value === branch; });
      dispatch('change', rows.find((row) => row.input.checked).input);
    }
  };
}

test('intake favourites are first; other installed workflows are initially collapsed and packaged choices stay unavailable', () => {
  const view = mount(workflowForm());
  assert.equal(view.controls['[data-workflow-other]'].open, false);
  assert.deepEqual(view.controls['[data-workflow-favourite-list]'].children.map((row) => row.input.value), ['demo-web']);
  assert.deepEqual(view.controls['[data-workflow-other-list]'].children.map((row) => row.input.value), ['feature', 'custom']);
  assert.equal(view.controls['[data-workflow-other]'].summary.textContent, 'Other workflows (2)');
  assert.match(view.html, /aria-label="Favourite Team &lt;script&gt; &amp; review"/);
  const packaged = view.workflowRows.find((row) => !row.input);
  assert.equal(packaged.favourite, undefined); assert.match(view.html, /aria-disabled="true" data-available-workflow="packaged"/);
  assert.deepEqual(view.messages, []);
});

test('a progress patch keeps a large catalog, search, focus and scroll without reloading the document', () => {
  const view = mount(form({ baseBranchChoices: Array.from({ length: 1_000 }, (_, index) => choice('feature/' + index)) }));
  view.type('feature/99'); view.selectText(2, 7); view.window.scrollY = 480;
  const rows = view.rows;
  const catalog = view.controls['[data-intake-region="base"]'].innerHTML;
  view.patch({ sequence: 1, regions: [{ id: 'status', html: '<p>Creating the Story checkout…</p>' }], busy: true });
  assert.equal(view.controls['[data-intake-region="status"]'].innerHTML, '<p>Creating the Story checkout…</p>');
  assert.equal(view.controls['[data-intake-region="base"]'].innerHTML, catalog);
  assert.equal(view.rows, rows);
  assert.equal(view.document.activeElement, view.search);
  assert.equal(view.search.value, 'feature/99'); assert.equal(view.search.selectionStart, 2);
  assert.equal(view.window.scrollY, 480);
  assert.equal(view.controls['.intake-view'].attributes['aria-busy'], 'true');
  assert.deepEqual(view.messages, []);
  view.patch({ sequence: 0, regions: [{ id: 'status', html: 'stale' }] });
  assert.equal(view.controls['[data-intake-region="status"]'].innerHTML, '<p>Creating the Story checkout…</p>');
});

test('background patches retain in-transit text, while explicit user actions use host-authored values', () => {
  const view = mount();
  const title = view.element({ field: 'title' }); title.value = 'Locally typed new title';
  view.controls['[data-field="title"]'] = title; title.focus();
  Object.defineProperty(view.controls['[data-intake-region="identification"]'], 'innerHTML', {
    set() { title.value = 'Returned host value'; }, get() { return ''; }, configurable: true
  });
  view.patch({ sequence: 1, regions: [{ id: 'identification', html: 'background' }], preserveDraft: true });
  assert.equal(title.value, 'Locally typed new title');
  view.patch({ sequence: 2, regions: [{ id: 'identification', html: 'explicit' }], preserveDraft: false });
  assert.equal(title.value, 'Returned host value');
});

test('missing patch roots request a view-only reload without partially applying the packet', () => {
  const view = mount(); const status = view.controls['[data-intake-region="status"]'].innerHTML;
  view.patch({ sequence: 1, regions: [{ id: 'status', html: 'new' }, { id: 'missing', html: 'bad' }] });
  assert.equal(view.controls['[data-intake-region="status"]'].innerHTML, status);
  assert.deepEqual(view.messages, [{ type: 'intakeReload' }]);
});

test('progress-only region changes do not resend workflows or thousands of branch rows', () => {
  const intake = form({ baseBranchChoices: Array.from({ length: 1_000 }, (_, index) => choice('branch/' + index)),
    baseBranch: 'branch/1', basePreflightPassed: true, busy: true, startStep: 'Verifying readiness' });
  const before = intakeRegions(intake);
  const after = intakeRegions({ ...intake, startStep: 'Publishing the Story' });
  const changed = Object.keys(after).filter((id) => before[id] !== after[id]);
  assert.deepEqual(changed, ['actions'], 'the start step is shown in the sticky bar, so only it is resent');
  assert.ok(Buffer.byteLength(after.actions) < Buffer.byteLength(intakeHtml(intake)) / 10);
  assert.match(after.actions, /Publishing the Story…/);
});

test('the Start button and what is still needed stay in a sticky bar that is patched by its region id', async () => {
  const blocked = form({ id: '', title: '' });
  const regions = intakeRegions(blocked);
  assert.equal(Object.keys(regions).at(-1), 'actions', 'the bar is the last region, so it sticks to the bottom');
  const needed = intakeProblems(blocked).filter((problem) => !problem.endsWith('…')).length;
  assert.ok(needed > 1);
  assert.match(regions.actions, new RegExp(`data-focus-field="region:status">${needed} things still needed</button>`),
    'a short count that takes the reader to the full list');
  assert.match(regions.actions, /<button type="button" data-submit="start" disabled>/);
  assert.doesNotMatch(regions.status, /data-submit="start"/, 'one Start button on the page, in the bar');
  assert.match(regions.status, /Before this can start/, 'the full list stays in its own region');
  const html = intakeHtml(blocked);
  assert.equal([...html.matchAll(/data-submit="start"/g)].length, 1);
  assert.match(html, /<div data-intake-region="actions"><div class="sf-start-bar" role="group" aria-label="Start Story">/);

  const readyForm = form({ baseBranch: 'main', basePreflightPassed: true, description: 'Retry failed charges.' });
  assert.deepEqual(intakeProblems(readyForm), []);
  const ready = intakeRegions(readyForm);
  assert.match(ready.actions, /Ready to start/);
  assert.match(ready.actions, /<button type="button" data-submit="start" >/);
  assert.match(intakeRegions({ ...readyForm, description: '' }).actions, />1 thing still needed</);
  // A read in flight is not counted as needed: the bar says it is checking.
  assert.match(intakeRegions({ ...readyForm, basePreflightPassed: false, basePreflightChecking: true }).actions,
    /role="status" aria-live="polite">Checking…<\/p>/);

  // The page script replaces the bar like any other region.
  const view = mount(blocked);
  view.patch({ sequence: 1, regions: [{ id: 'actions', html: ready.actions }] });
  assert.equal(view.controls['[data-intake-region="actions"]'].innerHTML, ready.actions);
  assert.deepEqual(view.messages, [], 'a known region id never asks for a reload');

  const { THEME_STYLE } = await import('../apps/vscode/src/views/theme.ts');
  assert.match(THEME_STYLE, /\[data-intake-region="actions"\] \{ position: sticky; bottom: 0;/,
    'the sticky rule is on the region itself, so replacing its content keeps it pinned');
});

test('workflow search is local, opens other choices for results and preserves selection, caret and query across redraw', () => {
  const view = mount(workflowForm());
  view.workflowType('cafe\u0301');
  assert.deepEqual(view.workflowRows.filter((row) => !row.hidden).map((row) => row.input?.value), ['demo-web']);
  assert.equal(view.controls['[data-workflow-other]'].open, true);
  assert.match(view.controls['[data-workflow-selected]'].textContent, /feature.*hidden by the search/);
  assert.deepEqual(view.messages, []);
  const next = mount(workflowForm(), view.state());
  assert.equal(next.controls['[data-workflow-search]'].value, 'cafe\u0301');
  assert.equal(next.document.activeElement, next.controls['[data-workflow-search]']);
  assert.equal(next.document.activeElement.selectionStart, 'cafe\u0301'.length);
  next.workflowType('.*'); assert.equal(next.controls['[data-workflow-empty]'].hidden, false);
  next.workflowClear(); assert.ok(next.workflowRows.every((row) => !row.hidden));
  assert.equal(next.controls['[data-workflow-other]'].open, false);
  assert.equal(next.workflowRows.find((row) => row.input?.checked).input.value, 'feature');
});

test('starring and unstarring only persists personal favourites, without choosing a workflow or sending readiness calls', () => {
  const view = mount(workflowForm());
  view.favourite('feature');
  assert.deepEqual(view.controls['[data-workflow-favourite-list]'].children.map((row) => row.input.value), ['feature', 'demo-web']);
  view.favourite('demo-web');
  assert.deepEqual(view.controls['[data-workflow-favourite-list]'].children.map((row) => row.input.value), ['feature']);
  assert.equal(view.workflowRows.find((row) => row.input?.checked).input.value, 'feature');
  assert.deepEqual(view.messages, [
    { type: 'workflowFavourite', value: 'feature', favourite: true },
    { type: 'workflowFavourite', value: 'demo-web', favourite: false }
  ]);
  view.workflowType('demo'); view.workflowSelect('demo-web');
  assert.deepEqual(view.messages.at(-1), { type: 'workType', value: 'demo-web' }, 'selection uses the existing governed route');
});

test('favourites are UI preferences, not Story intent, and stale favourites do not create selectable choices', async () => {
  const { intakePlanInputKey } = await import('../apps/vscode/src/views/intake-form.ts');
  const intake = workflowForm(); const saved = { ...intake, favouriteWorkflows: ['deleted-workflow', 'custom'] };
  assert.equal(intakePlanInputKey(saved), intakePlanInputKey(intake));
  assert.deepEqual(intakeCommand(saved), intakeCommand(intake));
  assert.deepEqual(storyPreflightCommand(saved), storyPreflightCommand(intake));
  const view = mount(saved);
  assert.deepEqual(view.controls['[data-workflow-favourite-list]'].children.map((row) => row.input.value), ['custom']);
  assert.doesNotMatch(view.html, /data-workflow-choice="deleted-workflow"/);
  const noFavourites = mount(workflowForm({ favouriteWorkflows: [] }));
  assert.equal(noFavourites.controls['[data-workflow-favourites-empty]'].hidden, false);
});

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

test('exact branch matching is a local, persisted toggle over full case-sensitive branch names only', () => {
  const view = mount(form({ baseBranch: 'main', baseBranchChoices: [
    ...choices, choice('main-backup'), choice('Main'), choice('story-main', { workId: 'main', title: 'main' })
  ] }));
  view.type('main');
  assert.deepEqual(view.visible(), ['main', 'main-backup', 'Main', 'story-main']);
  view.exact(true);
  assert.deepEqual(view.visible(), ['main']);
  assert.equal(view.state().intakeView.branchExact, true);
  view.type('PAY-12'); assert.deepEqual(view.visible(), [], 'Story IDs do not match branch names');
  view.type('.*'); assert.deepEqual(view.visible(), [], 'not a regular expression');
  view.type('Main'); assert.deepEqual(view.visible(), ['Main']);
  view.type('main');
  const restored = mount(form({ baseBranchChoices: [choice('main'), choice('main-backup')] }), view.state());
  assert.equal(restored.controls['[data-base-branch-exact]'].checked, true);
  assert.deepEqual(restored.visible(), ['main']);
  restored.patch({ sequence: 1, regions: [{ id: 'base', html: 'refreshed catalog' }] });
  assert.deepEqual(restored.visible(), ['main'], 'catalog replacement preserves exact matching');
  view.exact(false); assert.equal(view.visible().length, 4);
  view.exact(true); view.clear(); assert.equal(view.visible().length, 7, 'empty query shows every offered branch');
  assert.equal(view.rows.find(row => row.input.value === 'main').input.checked, true, 'filtering never selects or clears a base');
  assert.deepEqual(view.messages, [], 'toggling, searching and restoring never call Git or readiness');
  assert.match(view.html, /data-base-branch-exact[\s\S]*?Exact match/);
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
    assert.ok(!args.includes('--accept-test-risk') && !args.includes('--test-policy-confirm'));
  }
  assert.ok(!intakeCommand(intake).includes('--test-baseline-disposition'),
    'an undiscovered policy gets no mutation agreement flags');
  const preview = storyPreflightCommand(intake);
  assert.equal(preview[preview.indexOf('--test-baseline-disposition') + 1], 'fix',
    'read-only discovery evaluates default choices, never failure acceptance');
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
