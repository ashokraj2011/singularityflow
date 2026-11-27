// FPL M2 in VS Code (docs/SPEC-FPL-FOUR-PLACES-v1.md §3.2, REQ-004 to REQ-007, REQ-037, A8 to A10): the Work tab, its box,
// In progress and Done this week, and the one task page, built from the engine's JSON, behind the places switch.
import assert from 'node:assert/strict';
import test from 'node:test';
import { rmSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

import {
  chatRouteOf, chipsHtml, likelyPlanFrom, workListFrom, workPanelHtml, workTaskFrom, workTaskHtml, withLiveWaiting
} from '../apps/vscode/src/views/work-page.ts';
import { placesTabsHtml } from '../apps/vscode/src/views/needs-you-page.ts';

const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const chips = (states) => states.map(([label, state]) => ({ id: label.toLowerCase(), label, state, words: `${label}, ${state.replace(/-/gu, ' ')}` }));
const row = (id, extra = {}) => ({ id, title: `Title ${id}`, task: true, kind: 'fix', repository: { id: 'shop-web', name: 'shop-web' }, startedWhen: 'Monday',
  startedBy: 'Reviewer', status: 'in_progress', chips: chips([['Intake', 'done'], ['Code', 'done'], ['Tests', 'now']]),
  statusLine: `${id} is at Tests.`, standing: `${id} is at Tests.`, route: { checkout: '/work/shop-web', clone: '/work/shop-web', here: true }, ...extra });
const list = (inProgress, doneThisWeek = [], extra = {}) => ({ schemaVersion: 1, resultType: 'sflow-work-list', inProgress, doneThisWeek,
  here: { id: 'shop-web', name: 'shop-web' }, otherRepositories: 2, workspace: { id: 'shop', name: 'shop' },
  checked: { at: '2026-11-26T10:42:00Z', words: 'Checked 10:42 · 3 repositories' }, lines: ['shop-api could not be read (offline); showing 10:31.'], ...extra });

test('REQ-004: the box asks what you want done, names the window\'s repository, and offers Start with a workflow', () => {
  const html = workPanelHtml(workListFrom(list([])), { draft: 'fix the <login>', likely: 'Likely plan: code → tests.' });
  assert.match(html, /<label for="work-words"[^>]*>What do you want done\?<\/label>/u);
  assert.match(html, /value="fix the &lt;login&gt;"/u, 'the draft is kept across a repaint, escaped');
  assert.match(html, /<p id="work-likely" class="work-likely" aria-live="polite">Likely plan: code → tests\.<\/p>/u);
  assert.match(html, /In shop-web\. <button type="button" class="link" data-act="repository">Another repository…<\/button>/u);
  assert.match(html, /data-act="workflow">Start with a workflow…/u);
  assert.match(html, /Nothing of yours is in flight\./u);
  // One repository: the box names none.
  assert.doesNotMatch(workPanelHtml(workListFrom(list([], [], { otherRepositories: 0 }))), /Another repository/u);
  // The likely plan's line: called "Likely plan", without the chat's "Say … to change it".
  assert.equal(likelyPlanFrom({ resultType: 'sflow-task-likely-plan', plan: 'Plan: code → tests. You approve the plan in the intake and the code. Say "add a design step" to change it.' }),
    'Likely plan: code → tests. You approve the plan in the intake and the code.');
  assert.equal(likelyPlanFrom({ resultType: 'sflow-task-likely-plan', plan: null, why: 'SFlow cannot tell the kind.' }), null, 'no kind, no line');
  // The tab strip: Work first, then Needs you, then Advanced [REQ-001].
  const tabs = placesTabsHtml('work', null);
  assert.ok(tabs.indexOf('data-tab="work"') < tabs.indexOf('data-tab="needs-you"') && tabs.indexOf('data-tab="needs-you"') < tabs.indexOf('data-tab="advanced"'));
  assert.match(tabs, /role="tab"[^>]*aria-selected="true"[^>]*data-tab="work"/u);
});

test('REQ-005, REQ-007, REQ-037, A9: In progress rows with chips in words, the status line, its card, and Done this week', () => {
  const waiting = row('TASK-11', { repository: { id: 'shop-api', name: 'shop-api' }, statusLine: 'Waiting for you: Approve Plan?', standing: 'Waiting for Reviewers: approve Plan',
    waiting: { key: 'shop-api:TASK-11:approve:plan:1', question: 'Approve Plan?' }, chips: chips([['Intake', 'done'], ['Plan', 'waits-for-you'], ['Code', 'to-do']]) });
  const parsed = workListFrom(list([row('TASK-12'), waiting], [row('TASK-9', { status: 'closed', ended: { when: 'yesterday', where: 'checked on its branch' } })]));
  const html = workPanelHtml(parsed);
  assert.match(html, /<h2 class="work-group">In progress<\/h2>/u);
  assert.match(html, /<span class="work-title">Title TASK-12<\/span>\s*<span class="work-meta">TASK-12 · shop-web · started Monday<\/span>/u);
  // The chips: an ordered list, each state in words as well as colour, the arrows hidden from screen readers.
  assert.match(html, /<ol class="work-chips" aria-label="Plan of TASK-12"><li class="work-chip" data-state="done"><span class="work-chip-label">Intake<\/span><span class="work-chip-state">, done<\/span><\/li><li class="work-chip" data-state="done"><span class="work-arrow" aria-hidden="true">→<\/span>/u);
  assert.match(html, /<span class="work-chip-label">Tests<\/span><span class="work-chip-state">, now<\/span>/u);
  assert.match(html, /<p class="work-status">TASK-12 is at Tests\.<\/p>/u);
  // A Story with an item in Needs you says "Waiting for you: …" and opens that card [A9].
  assert.match(html, /<button type="button" class="work-waiting" data-key="shop-api:TASK-11:approve:plan:1">Waiting for you: Approve Plan\?<\/button>/u);
  assert.match(html, /<h2 class="work-group">Done this week<\/h2>[^]*TASK-9 · shop-web · checked on its branch, yesterday/u);
  assert.match(html, /data-act="stories">All Stories in this workspace/u);
  assert.match(html, /Checked 10:42 · 3 repositories/u);
  assert.match(html, /shop-api could not be read \(offline\); showing 10:31\./u);
  // The live Needs-you list decides: an item acted on leaves at once, and the row says what it waits for again [REQ-015].
  const acted = withLiveWaiting(parsed.inProgress[1], []);
  assert.equal(acted.statusLine, 'Waiting for Reviewers: approve Plan');
  assert.equal(acted.waiting, null);
  assert.equal(acted.chips[1].state, 'now');
  const held = withLiveWaiting(parsed.inProgress[0], [{ key: 'shop-web:TASK-12:approve:verification:1', question: 'Approve Tests?', story: { id: 'TASK-12' },
    repository: { id: 'shop-web' }, step: { id: 'tests' } }]);
  assert.equal(held.statusLine, 'Waiting for you: Approve Tests?');
  assert.equal(held.chips[2].state, 'waits-for-you');
  assert.equal(withLiveWaiting(parsed.inProgress[0], null), parsed.inProgress[0], 'before the first Needs-you read, the engine\'s line stands');
  // Untrusted output: a row with an ID the engine never makes is dropped.
  assert.equal(workListFrom(list([row('bad id <script>')])).inProgress.length, 0);
  assert.equal(chipsHtml([], 'x'), '');
});

const statusResult = (extra = {}) => ({ schemaVersion: 1, resultType: 'sflow-task-status', id: 'TASK-12', kind: 'fix', title: 'Title TASK-12', status: 'in_progress',
  done: false, branch: 'TASK-12', base: 'main', task: true, startedAt: '2026-11-23T09:00:00Z', startedBy: 'Reviewer',
  steps: [{ id: 'intake', label: 'Intake', status: 'approved', document: 'singularity/work-items/TASK-12/intake.md' }, { id: 'implementation', label: 'Code', status: 'in_progress', document: null }],
  chips: chips([['Intake', 'done'], ['Code', 'now']]), planNote: 'Composed from your words: a fix. The team\'s rules added the tests and your approval of the code.',
  events: [{ at: '2026-11-23T09:00:00Z', when: 'Monday', words: 'Started' }, { at: '2026-11-23T10:00:00Z', when: 'Monday', words: 'Intake approved' }],
  now: 'Code', next: 'Tests', rulesApplied: [{ rule: 'always[0]', because: 'Every code change gets tests.' }],
  addable: [{ step: 'design', label: 'Design' }, { step: 'review', label: 'Conformance review' }],
  changed: { base: 'main', files: [{ path: 'src/login.ts', added: 12, removed: 3 }], total: 1 }, ...extra });

test('REQ-006: the task page: header, buttons, the plan with Add a step, the plan note, what happened, documents, changes and rules', () => {
  const page = workTaskHtml(workListFrom(list([row('TASK-12')])).inProgress[0], workTaskFrom(statusResult()), { lessons: 2 });
  assert.match(page, /<h1 id="task-title" tabindex="-1">Title TASK-12<\/h1>/u);
  assert.match(page, /TASK-12 · Fix · from main · shop-web · started by Reviewer Monday/u);
  assert.match(page, /data-act="intake">Intake<\/button> <button type="button" class="primary" data-act="chat">Open in Copilot chat<\/button> <button type="button" class="secondary" data-act="stop">Stop the task<\/button>/u);
  assert.match(page, /<label for="task-add-step">Add a step<\/label>\s*<select id="task-add-step"><option value="design">Design<\/option><option value="review">Conformance review<\/option><\/select>/u);
  assert.match(page, /Composed from your words: a fix\. The team&#39;s rules added the tests and your approval of the code\./u);
  assert.match(page, /<h2 id="happening-title">What is happening<\/h2><ol class="task-events"><li><span class="muted">Monday<\/span> Started<\/li>/u);
  assert.match(page, /<p>Now: Code<\/p><p>Next: Tests<\/p>/u);
  assert.match(page, /data-document="singularity\/work-items\/TASK-12\/intake.md">Intake<\/button>/u);
  assert.match(page, /<span>src\/login.ts<\/span> <span class="muted">\+12 −3<\/span>/u);
  assert.match(page, /data-act="explain">Explain the change/u);
  assert.match(page, /<h2 id="rules-title">Rules applied<\/h2><ul><li>Every code change gets tests\.<\/li>/u);
  assert.match(page, /Lessons from this Story \(2\)/u);
  assert.match(page, /<div id="task-result" role="status" aria-live="polite">/u);
  assert.doesNotMatch(page, /Pause/u, 'nothing of a task runs between chat turns, so there is no Pause');
  // A22 for this page: no step ID shown as a word, no digest, no "phase", "generation" or "work item".
  assert.doesNotMatch(page.replace(/data-[a-z]+="[^"]*"/gu, '').replace(/id="[^"]*"/gu, ''), /[0-9a-f]{40}|sha256|\bphase\b|\bgeneration\b|\bwork item\b/iu);
  // A Story elsewhere: no Intake or Explain here, its route instead; a finished one has no Stop or Add a step.
  const away = row('TASK-11', { route: { checkout: null, clone: '/work/shop-api', here: false, elsewhere: { commands: ['singularity-flow session open TASK-11 --workspace shop --repository shop-api'] } } });
  const elsewhere = workTaskHtml(workListFrom(list([away])).inProgress[0], workTaskFrom(statusResult({ id: 'TASK-11' })));
  assert.doesNotMatch(elsewhere, /data-act="intake"|data-act="explain"|data-document=/u);
  assert.match(elsewhere, /TASK-11 is not open in this window\. Open it with: <code>singularity-flow session open TASK-11 --workspace shop --repository shop-api<\/code>/u);
  const finished = workTaskHtml(workListFrom(list([row('TASK-9', { status: 'closed' })])).inProgress[0], workTaskFrom(statusResult({ status: 'closed', done: true, addable: [] })));
  assert.doesNotMatch(finished, /data-act="stop"|task-add-step/u);
  // Open in Copilot chat: /sf-task for a task, the Journey's route for a classic Story, the route to it from elsewhere [A10].
  assert.deepEqual(chatRouteOf({ task: true, route: { here: true, elsewhere: [] } }), { kind: 'task', text: '/sf-task' });
  assert.deepEqual(chatRouteOf({ task: false, route: { here: true, elsewhere: [] } }), { kind: 'journey', text: 'singularityFlow.prefillNextCommand' });
  assert.equal(chatRouteOf({ task: true, route: { here: false, elsewhere: ['singularity-flow session open TASK-11'] } }).kind, 'elsewhere');
});

// ---------------------------------------------------------------------- the place and the page, against a `vscode` stub

const STUB = '__sflowWorkPlaceVscode';
let loaded = null;
/** views/work.ts bundled with `vscode` left to a stub this test drives. */
function loadWork() {
  loaded ??= (async () => {
    const api = { ViewColumn: { Active: 1, Beside: 2 }, Uri: { file: (fsPath) => ({ fsPath }) }, panels: [], said: [], answers: {},
      commands: { executeCommand: async (id, ...args) => { api.said.push(['command', id, ...args]); } },
      window: {
        createWebviewPanel: (viewType, title) => {
          const panel = { viewType, title, html: '', listeners: [], webview: { html: '', cspSource: 'stub', onDidReceiveMessage: (listener) => panel.listeners.push(listener),
            asWebviewUri: (uri) => uri }, reveal() {}, onDidDispose() {}, send: (message) => Promise.all(panel.listeners.map((listener) => listener(message))) };
          api.panels.push(panel);
          return panel;
        },
        showInputBox: async (options) => { api.said.push(['input', options.title]); return api.answers.input; },
        showWarningMessage: async (message) => { api.said.push(['warning', message]); return api.answers.warning; }
      }
    };
    globalThis[STUB] = api;
    const shim = 'data:text/javascript,' + encodeURIComponent(`const api = globalThis.${STUB};
      export const ViewColumn = api.ViewColumn, Uri = api.Uri, commands = api.commands, window = api.window;`);
    register('data:text/javascript,' + encodeURIComponent(`
      export async function resolve(specifier, context, nextResolve) {
        if (specifier === 'vscode') return { url: ${JSON.stringify(shim)}, shortCircuit: true };
        return nextResolve(specifier, context);
      }`));
    const out = await mkdtemp(path.join(os.tmpdir(), 'sflow-work-place-'));
    process.once('exit', () => rmSync(out, { recursive: true, force: true }));
    await build({ entryPoints: [path.join(REPOSITORY, 'apps/vscode/src/views/work.ts')], bundle: true, platform: 'node', format: 'esm', external: ['vscode'],
      outdir: out, outExtension: { '.js': '.mjs' }, logLevel: 'silent' });
    return { api, module: await import(pathToFileURL(path.join(out, 'work.mjs')).href) };
  })();
  return loaded;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
/** A button's work goes on after its message is taken: wait until it is done. */
const settle = async () => { for (let index = 0; index < 12; index += 1) await tick(); };

function fakeHost({ answers = {} } = {}) {
  const calls = [];
  const client = (where) => ({
    run: async (argv) => {
      calls.push(['run', where, ...argv]);
      if (argv[0] === 'work' && argv[1] === 'list') return list([row('TASK-12'), row('TASK-10', { task: false, kind: null })]);
      if (argv.includes('--plan-only')) return { resultType: 'sflow-task-likely-plan', plan: argv[1].startsWith('fix') ? 'Plan: code → tests. You approve the code. Say "add a design step" to change it.' : null };
      if (argv[0] === 'work' && argv[1] === 'status') return statusResult({ id: argv[2] });
      if (argv[0] === 'lessons') return { items: [] };
      if (argv[0] === 'work' && argv[1] === 'add') {
        if (answers.refuse) throw Object.assign(new Error('TASK-12 has a Story commit waiting to be sent; send it first, then add the step.'), { code: 'TASK_CHANGE_REFUSED' });
        return { words: `Added the ${argv[2]} step to ${argv[4]}.` };
      }
      return {};
    },
    runText: async (argv) => { calls.push(['runText', where, ...argv]); return ''; }
  });
  const host = { calls, sent: [], refusals: [], started: [], cards: [],
    client: client('window'), bind: (where) => client(where),
    startTask: async (words) => { host.started.push(words); },
    command: async (id, ...args) => { calls.push(['command', id, ...args]); },
    sendChat: async (text) => { host.sent.push(text); },
    refresh: async () => {}, openCard: (key) => host.cards.push(key), waiting: () => null,
    showRefusal: (error, headline) => host.refusals.push([headline, error.message]) };
  return host;
}

test('A8: Start sends exactly /sf-task <words> through startTask, never waiting for the likely plan; the plan line follows typing', async () => {
  const { module } = await loadWork();
  const host = fakeHost();
  const posted = [];
  const place = new module.WorkPlace(host, () => {});
  place.attach((message) => posted.push(message));
  assert.equal(place.receive({ action: 'work-start', words: '  fix the login timeout on slow networks  ' }), true);
  assert.deepEqual(host.started, ['fix the login timeout on slow networks']);
  assert.equal(host.calls.length, 0, 'Start runs nothing first: no plan, no read');
  // The extension's startTask sends exactly /sf-task <words> to the chat the person used last.
  const extension = await readFile(path.join(REPOSITORY, 'apps/vscode/src/extension.ts'), 'utf8');
  assert.match(extension, /'singularityFlow\.startTask': async \(given\?: unknown\) => \{\n\s+const words = typeof given === 'string' && given\.trim\(\) \? given/u);
  assert.match(extension, /query: `\/sf-task \$\{words\.trim\(\)\}`, isPartialQuery: false/u);
  assert.match(extension, /startTask: async \(words\) => \{ await vscode\.commands\.executeCommand\('singularityFlow\.startTask', words\); \}/u);
  // The likely plan: read for the words after the pause; only the newest words' answer is posted.
  place.receive({ action: 'work-plan', words: 'hello' });
  place.receive({ action: 'work-plan', words: 'fix the login timeout' });
  await tick();
  assert.deepEqual(host.calls.filter((call) => call.includes('--plan-only')).map((call) => call[3]), ['hello', 'fix the login timeout']);
  assert.deepEqual(posted, [{ type: 'work-likely', words: 'fix the login timeout', text: 'Likely plan: code → tests. You approve the code.' }]);
  assert.match(place.panel(), /Likely plan: code → tests\. You approve the code\./u, 'a repaint keeps the line for the same words');
  // The links: Start with a workflow, Another repository, All Stories.
  for (const [act, command] of [['workflow', 'singularityFlow.startWork'], ['repository', 'singularityFlow.switchWorkspaceRepository'], ['stories', 'singularityFlow.openWorkspaceStories']]) {
    place.receive({ action: 'work-act', act });
    assert.deepEqual(host.calls.at(-1), ['command', command]);
  }
});

test('A10: the task page adds a step through work add with its refusal\'s words, stops through cancel after its confirmation, and opens the chat', async () => {
  const { api, module } = await loadWork();
  const host = fakeHost();
  const place = new module.WorkPlace(host, () => {});
  await place.read({});
  const panelsBefore = api.panels.length;
  assert.equal(place.receive({ action: 'work-open', key: 'shop-web:TASK-12' }), true);
  await tick(); await tick();
  const panel = api.panels.at(-1);
  assert.equal(api.panels.length, panelsBefore + 1);
  assert.deepEqual(host.calls.filter((call) => call[0] === 'run' && call[3] !== 'list').map((call) => call.slice(1)),
    [['/work/shop-web', 'work', 'status', 'TASK-12', '--json'], ['/work/shop-web', 'lessons', '--story', 'TASK-12', '--json']], 'opening reads, bound to its checkout');
  assert.match(panel.webview.html, /Add a step/u);
  // A second row replaces what the one page shows [REQ-003].
  place.receive({ action: 'work-open', key: 'shop-web:TASK-10' });
  await tick(); await tick();
  assert.equal(api.panels.length, panelsBefore + 1, 'one reused page');
  place.receive({ action: 'work-open', key: 'shop-web:TASK-12' });
  await tick(); await tick();

  await panel.send({ type: 'act', act: 'add', step: 'design' }); await settle();
  assert.deepEqual(host.calls.find((call) => call[2] === 'work' && call[3] === 'add').slice(1), ['/work/shop-web', 'work', 'add', 'design', '--work-id', 'TASK-12', '--json']);
  assert.match(panel.webview.html, /Added the design step to TASK-12\./u);
  // A step work add cannot add is never sent.
  const before = host.calls.length;
  await panel.send({ type: 'act', act: 'add', step: 'intake' }); await settle();
  assert.equal(host.calls.filter((call, index) => index >= before && call[3] === 'add').length, 0);

  // Stop the task: today's cancel, after a reason and a yes; no yes, nothing runs.
  api.answers.input = 'Not needed any more';
  api.answers.warning = undefined;
  await panel.send({ type: 'act', act: 'stop' }); await settle();
  assert.equal(host.calls.filter((call) => call[0] === 'runText').length, 0, 'no yes, no cancel');
  api.answers.warning = 'Stop the task';
  await panel.send({ type: 'act', act: 'stop' }); await settle();
  assert.deepEqual(host.calls.filter((call) => call[0] === 'runText').map((call) => call.slice(1)),
    [['/work/shop-web', 'cancel', 'TASK-12', '--reason', 'Not needed any more', '--confirm', 'TASK-12']]);

  // Open in Copilot chat: /sf-task for a task here; the Journey's route (the chat's next command) for a classic Story.
  await panel.send({ type: 'act', act: 'chat' }); await settle();
  assert.deepEqual(host.sent, ['/sf-task']);
  place.receive({ action: 'work-open', key: 'shop-web:TASK-10' });
  await tick(); await tick();
  await panel.send({ type: 'act', act: 'chat' }); await settle();
  assert.deepEqual(host.calls.at(-1), ['command', 'singularityFlow.prefillNextCommand']);
  // Its card: a Needs-you key opens the card page.
  await panel.send({ type: 'card', key: 'shop-web:TASK-12:approve:plan:1' }); await settle();
  assert.deepEqual(host.cards, ['shop-web:TASK-12:approve:plan:1']);
  // Explain the change opens the Code Explainer in My change, not on its default place (spec §3.2, REQ-006).
  await panel.send({ type: 'act', act: 'explain' }); await settle();
  assert.deepEqual(host.calls.at(-1), ['command', 'singularityFlow.openCodeExplainer', { mode: 'change' }]);

  // A refusal is shown in its own words, with its route (showRefusal).
  const refusing = fakeHost({ answers: { refuse: true } });
  const other = new module.WorkPlace(refusing, () => {});
  await other.read({});
  other.receive({ action: 'work-open', key: 'shop-web:TASK-12' });
  await tick(); await tick();
  await api.panels.at(-1).send({ type: 'act', act: 'add', step: 'review' }); await settle();
  assert.deepEqual(refusing.refusals, [['Could not add the step', 'TASK-12 has a Story commit waiting to be sent; send it first, then add the step.']]);
  assert.match(api.panels.at(-1).webview.html, /send it first, then add the step\./u);
});

test('Work is off by default, lazy, first in the places, and wired with today\'s commands', async () => {
  const manifest = JSON.parse(await readFile(path.join(REPOSITORY, 'apps/vscode/package.json'), 'utf8'));
  assert.equal(manifest.contributes.configuration.properties['singularityFlow.navigation.layout'].default, 'classic', 'M5 switches the default');
  const extension = await readFile(path.join(REPOSITORY, 'apps/vscode/src/extension.ts'), 'utf8');
  assert.match(extension, /const work = new \(lazyPanels\(\)\.WorkPlace\)\(\{/u, 'loaded from the lazy panels, only while the places are on');
  assert.match(extension, /place\.setWork\(work\);/u);
  assert.match(extension, /needsYouAfterChange = \(\) => \{ void place\.read\(\{\}\); void work\.read\(\{\}\); void rules\.read\(\{\}\); \};/u, 'read again after any change made here');
  // A command's arguments reach it: "Explain the change" names the explainer's place, My change.
  assert.match(extension, /command: async \(id, \.\.\.args\) => \{ await vscode\.commands\.executeCommand\(id, \.\.\.args\); \},/u);
  assert.match(extension, /'singularityFlow\.openCodeExplainer': \(\(options\?: unknown\) => showCodeExplainer\(false, options\)\) as never,/u);
  assert.match(extension, /CodeExplainerPanel\.show\(context, store, client, \{ services, mode: codeExplainerMode\(options\) \}\)/u);
  const lazy = await readFile(path.join(REPOSITORY, 'apps/vscode/src/lazy-panels-runtime.ts'), 'utf8');
  assert.match(lazy, /export \{ WorkPlace, WorkTaskPanel \} from '\.\/views\/work\.ts';/u);
  const places = await readFile(path.join(REPOSITORY, 'apps/vscode/src/views/needs-you.ts'), 'utf8');
  assert.match(places, /private tab: PlaceTab = 'work';/u, 'the sidebar opens on Work');
  const client = await readFile(path.join(REPOSITORY, 'apps/vscode/src/cli/client.ts'), 'utf8');
  assert.match(client, /if \(args\[0\] === 'work'\) return args\.includes\('--start'\) \|\| \['add', 'skip', 'behaviour'\]\.includes\(args\[1\] \?\? ''\) \? 'mutation' : 'read';/u,
    'work add is a change; the likely plan, work list and work status read');
});
