// FPL M5 in VS Code (docs/SPEC-FPL-FOUR-PLACES-v1.md §3.1, §3.6, §5; REQ-001 to REQ-003, REQ-032 to REQ-035; A19 to A21): the
// four places are the sidebar's default, Advanced shows today's Navigator byte for byte, `classic` keeps it first with the
// places one row away, a one-time notice offers Switch back, five commands open each place, and places-map.ts says where
// every command and destination is.
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, rmSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

import { needsYouListFrom, placePanelBody, needsYouPlaceBody, PLACE_INTROS, PLACE_TABS, placesHeaderHtml } from '../apps/vscode/src/views/needs-you-page.ts';
import { LIBRARY_ROUTES, LibraryPlace, libraryPanelHtml } from '../apps/vscode/src/views/library-place.ts';
import { ADVANCED_ROUTES, PLACES_GROUPS, PLACES_MAP } from '../apps/vscode/src/views/places-map.ts';
import { PRIMARY_NAVIGATION, sidebarBody } from '../apps/vscode/src/views/sidebar-page.ts';
import { CONFIGURATION_TABS } from '../apps/vscode/src/views/configuration-center-model.ts';
import { workPanelHtml, workListFrom } from '../apps/vscode/src/views/work-page.ts';

const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(REPOSITORY, 'apps/vscode/package.json'), 'utf8'));
const PLACE_COMMAND_IDS = ['singularityFlow.places.work', 'singularityFlow.places.needsYou', 'singularityFlow.places.rules',
  'singularityFlow.places.library', 'singularityFlow.places.advanced'];

/** The `when` clauses the navigation view's title uses: `a && !b && view == c`, with the keys given. */
function holds(when, keys) {
  return (when ?? '').split('&&').map((part) => part.trim()).filter(Boolean).every((part) => {
    const view = /^view == ([\w.]+)$/u.exec(part);
    if (view) return keys.view === view[1];
    return part.startsWith('!') ? !keys[part.slice(1)] : Boolean(keys[part]);
  });
}
const titleActions = (keys) => manifest.contributes.menus['view/title'].filter((entry) => holds(entry.when, { view: 'singularityFlow.navigation', ...keys }));

test('REQ-034: the places are the default; classic stays a choice; the setting changes no data and no command', () => {
  const setting = manifest.contributes.configuration.properties['singularityFlow.navigation.layout'];
  assert.equal(setting.default, 'places');
  assert.deepEqual(setting.enum, ['places', 'classic']);
  assert.match(setting.enumDescriptions[0], /^The four places: Work[^]*Needs you[^]*Rules[^]*Library[^]*Advanced[^]*today's Navigator\.$/u);
  assert.equal(setting.enumDescriptions[1], 'Today\'s Navigator first, with the four places one row away.');
  assert.match(setting.description, /changes no data and no command/u);
  // REQ-001: the Run tree stays its own view, shown only with run configurations, and collapsed by default.
  const run = manifest.contributes.views.singularityFlowNavigator.find((view) => view.id === 'singularityFlow.run');
  assert.deepEqual({ when: run.when, visibility: run.visibility }, { when: 'singularityFlow.runConfigurations', visibility: 'collapsed' });
  // The navigation view keeps its ID, so pins and its position survive the upgrade.
  assert.equal(manifest.contributes.views.singularityFlowNavigator[0].id, 'singularityFlow.navigation');
});

test('A19, REQ-033: five new commands, each in the palette with its title; today\'s title actions with classic, Refresh, Ask SFlow and Advanced with the places', () => {
  const commands = new Map(manifest.contributes.commands.map((entry) => [entry.command, entry]));
  assert.deepEqual(PLACE_COMMAND_IDS.map((id) => commands.get(id)?.title), ['Singularity Flow: Open Work', 'Singularity Flow: Open Needs You',
    'Singularity Flow: Open Rules', 'Singularity Flow: Open Library', 'Singularity Flow: Advanced (Today\'s Navigator)']);
  for (const id of PLACE_COMMAND_IDS) {
    assert.ok(commands.get(id).icon, `${id} has an icon for the title bar`);
    assert.equal(manifest.contributes.menus.commandPalette.some((entry) => entry.command === id), false, `${id} is never hidden from the palette`);
  }
  // The title bar: with classic (or no places open), exactly today's; with the places, Refresh, Ask SFlow and Advanced.
  const shown = (keys) => titleActions(keys).map((entry) => `${entry.command.replace('singularityFlow.', '')}@${entry.group}`);
  assert.deepEqual(shown({ 'singularityFlow.repositoryActive': true }), ['refresh@navigation@0', 'startTask@navigation@1', 'openChangeExplorer@navigation@1',
    'openCodeExplainer@navigation@2', 'openCodeExplanation@1_explain@1', 'openComprehensionCenter@1_explain@2', 'updateSflow@2_maintain@0', 'upgradeOrRepair@2_maintain@1']);
  const places = shown({ 'singularityFlow.repositoryActive': true, 'singularityFlow.fourPlaces': true });
  assert.deepEqual(places.filter((entry) => entry.includes('@navigation')), ['refresh@navigation@0', 'askSFlow@navigation@1', 'places.advanced@navigation@2'],
    'nothing else sits above the tabs [REQ-002]');
  // Today's explainers stay one click away, in the title bar's "…" menu.
  assert.deepEqual(places.filter((entry) => !entry.includes('@navigation')).sort(), ['openChangeExplorer@1_explain@0', 'openCodeExplainer@1_explain@0',
    'openCodeExplanation@1_explain@1', 'openComprehensionCenter@1_explain@2', 'openRepositoryKnowledge@1_explain@3', 'updateSflow@2_maintain@0', 'upgradeOrRepair@2_maintain@1']);
  // Every other menu is as before: no other menu names the places, their commands or their key.
  for (const [menu, entries] of Object.entries(manifest.contributes.menus)) {
    if (menu === 'view/title') continue;
    for (const entry of entries) assert.doesNotMatch(`${entry.command} ${entry.when ?? ''}`, /singularityFlow\.places\.|singularityFlow\.fourPlaces/u, `${menu}: ${entry.command}`);
  }
  const navigationTitle = manifest.contributes.menus['view/title'].filter((entry) => /view == singularityFlow\.navigation\b/u.test(entry.when));
  assert.equal(navigationTitle.filter((entry) => /fourPlaces/u.test(entry.when)).length, 8, 'only the navigation view\'s title knows the places');
  assert.equal(commands.get('singularityFlow.askSFlow').title, 'Singularity Flow: Ask SFlow', 'Ask SFlow keeps its title; it gains a title-bar icon');
});

test('REQ-035, A20: places-map.ts names every contributed command, and every Navigator, Studio and Configuration destination', async () => {
  const contributed = manifest.contributes.commands.map((entry) => entry.command);
  const missing = contributed.filter((id) => !PLACES_MAP.has(id));
  assert.deepEqual(missing, [], `add a line to apps/vscode/src/views/places-map.ts for: ${missing.join(', ')}`);
  const stale = [...PLACES_MAP.keys()].filter((id) => !contributed.includes(id));
  assert.deepEqual(stale, [], 'a line for a command that is no longer contributed');
  assert.equal(PLACES_MAP.size, contributed.length);
  assert.deepEqual(PLACES_GROUPS.slice(0, 2), ['Starting and following work', 'A Story\'s step actions']);
  for (const line of PLACES_MAP.values()) {
    assert.ok(line.advanced, `${line.command} says where it is under Advanced or in the palette`);
    assert.equal(line.place === null, line.there === null, `${line.command}: a place has its words, and words have their place`);
  }
  // The places' own commands open the places; the daily routes are found there.
  assert.equal(PLACES_MAP.get('singularityFlow.startTask').place, 'work');
  assert.equal(PLACES_MAP.get('singularityFlow.marketplace').place, 'library');
  assert.equal(PLACES_MAP.get('singularityFlow.openInbox').place, 'needs-you');
  assert.equal(PLACES_MAP.get('singularityFlow.openWorkflowStudio').place, 'rules');
  assert.equal(PLACES_MAP.get('singularityFlow.askSFlow').place, 'header');
  assert.equal(PLACES_MAP.get('singularityFlow.sfGuard').place, null, 'SF Guard stays in the palette');
  // Every destination of today's Navigator, Studio's 11 views and the Configuration Center's 8 tabs has its route.
  const sidebar = await readFile(path.join(REPOSITORY, 'apps/vscode/src/views/sidebar.ts'), 'utf8');
  const tools = [...sidebar.matchAll(/'([\w-]+)': \{ title: '[^']+', ids: \[([^\]]*)\] \}/gu)].flatMap((match) => [match[1], ...match[2].match(/[\w-]+/gu)]);
  const studio = (await readFile(path.join(REPOSITORY, 'apps/vscode/src/views/workflow-studio-page.ts'), 'utf8'))
    .match(/export const STUDIO_FOCUS_VIEWS = Object\.freeze\(\[([^\]]*)\]/u)[1].match(/[\w-]+/gu);
  const named = (kind) => new Set(ADVANCED_ROUTES.filter((entry) => entry.kind === kind).map((entry) => entry.id));
  for (const id of [...PRIMARY_NAVIGATION.map((item) => item.id), ...tools]) assert.ok(named('navigator').has(id), `Navigator destination ${id} has a route`);
  assert.deepEqual([...named('configuration')], [...CONFIGURATION_TABS]);
  assert.deepEqual([...named('studio')], studio);
  // At most two clicks from Advanced; Studio's views other than Workflows take a third (Configuration, Workflow Studio, the
  // view), since today's Navigator has no Workflow Studio row and A21 keeps it byte for byte.
  const over = ADVANCED_ROUTES.filter((entry) => entry.clicks.length > 2);
  assert.deepEqual(over.map((entry) => `${entry.kind}:${entry.id}`), studio.filter((id) => id !== 'home').map((id) => `studio:${id}`));
  assert.ok(over.every((entry) => entry.clicks.length === 3));
});

test('REQ-001, REQ-002: the header names the workspace and its repositories; each place says what it holds; Advanced is the last row', () => {
  const list = needsYouListFrom({ resultType: 'sflow-needs-you', items: [], shown: 0, counts: {}, checked: null, lines: [],
    workspace: { id: 'shop', name: 'shop' }, scope: { repositories: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] } });
  assert.equal(list.repositories, 3);
  assert.equal(placesHeaderHtml(list), '<header class="places-head"><button type="button" class="places-workspace" data-places="workspace" aria-label="shop · 3 repositories: choose another workspace">shop · 3 repositories <span aria-hidden="true">▾</span></button></header>');
  assert.match(placesHeaderHtml(null, 'shop'), />shop <span aria-hidden="true">▾<\/span><\/button>/u, 'before the first read, the window\'s workspace');
  assert.match(placesHeaderHtml(null, null), />Choose a workspace <span/u);
  for (const tab of PLACE_TABS) {
    const body = placePanelBody(tab, list, '<p>panel</p>');
    assert.doesNotMatch(body, /title=/u, `${tab}: nothing is shown only on hover`);
    assert.ok(body.startsWith('<header class="places-head">'), 'nothing sits above the header and the tabs');
    assert.ok(body.indexOf('role="tablist"') < body.indexOf('id="place-panel"'));
    assert.match(body, new RegExp(`<p class="places-intro">${PLACE_INTROS[tab].replace(/[.?*+()[\]\\]/gu, '\\$&').replace(/'/gu, '&#39;')}</p><p>panel</p>`, 'u'));
    assert.match(body, /data-places="advanced">Advanced: today's Navigator, with every other SFlow screen<\/button><\/p>$/u);
    assert.ok(PLACE_INTROS[tab].length <= 160, `${tab}: one short line`);
  }
  // Empty places say what to do: Needs you offers Continue with why; Work points at its box.
  assert.match(needsYouPlaceBody(list), /Nothing waits on you now\. Continue sends your open Story on to its next step in Copilot chat\. <button type="button" class="needs-you-more" data-continue="1">Continue<\/button>/u);
  assert.match(workPanelHtml(workListFrom({ resultType: 'sflow-work-list', inProgress: [], doneThisWeek: [], lines: [] })), /Nothing of yours is in flight\. Say what you want done above, then Start\./u);
});

test('Library: until M4, the place opens today\'s Marketplace page, All skills and Add your own agent folder… through their commands', async () => {
  const html = libraryPanelHtml();
  assert.match(html, /<button type="button" class="library-open" data-library="marketplace">Open the Library<\/button>/u);
  assert.match(html, /data-library="skills">All skills, with what each one is used in</u);
  assert.match(html, /data-library="agent">Add your own agent folder…</u);
  assert.doesNotMatch(html, /coming|soon|later/iu, 'no promise of what is not built');
  const ran = [];
  const library = new LibraryPlace({ command: async (id) => { ran.push(id); } });
  for (const open of ['marketplace', 'skills', 'agent']) assert.equal(library.receive({ action: 'library', open }), true);
  assert.equal(library.receive({ action: 'library', open: 'constructor' }), false, 'only its own buttons');
  assert.equal(library.receive({ action: 'tab', tab: 'library' }), false);
  assert.deepEqual(ran, Object.values(LIBRARY_ROUTES).map((route) => route.command));
  for (const id of ran) assert.ok(manifest.contributes.commands.some((entry) => entry.command === id), `${id} is contributed`);
  library.activate();
  assert.deepEqual(ran.length, 3, 'opening the tab opens nothing');
});

test('the walkthrough and the help topic name the four places, and every link is one click', async () => {
  const walkthrough = manifest.contributes.walkthroughs[0];
  const step = walkthrough.steps.find((entry) => entry.id === 'places');
  assert.ok(step, 'a walkthrough step for the four places');
  assert.ok(walkthrough.steps.indexOf(step) < walkthrough.steps.findIndex((entry) => entry.id === 'intake'));
  assert.ok(step.completionEvents.includes('onCommand:singularityFlow.places.work'));
  const media = path.join(REPOSITORY, 'apps/vscode', step.media.markdown);
  assert.ok(existsSync(media));
  const markdown = await readFile(media, 'utf8');
  for (const word of ['**Work**', '**Needs you**', '**Rules**', '**Library**', '**Advanced**', '**Switch back**']) assert.ok(markdown.includes(word), word);
  for (const [, command] of markdown.matchAll(/\(command:([\w.]+)/gu)) {
    assert.ok(command === 'workbench.action.openSettings' || manifest.contributes.commands.some((entry) => entry.command === command), command);
  }
  const topic = await readFile(path.join(REPOSITORY, 'docs/topics/copilot-and-surfaces.md'), 'utf8');
  assert.match(topic, /\*\*VS Code:\*\* the SFlow icon opens on four places: \*\*Work\*\*/u);
  assert.match(topic, /\*\*Advanced\*\*[^\n]*today's Navigator/u);
});

// ------------------------------------------------------------ the sidebar and the places, against a `vscode` stub

const STUB = '__sflowPlacesVscode';
let loaded = null;
/** views/sidebar.ts and views/needs-you.ts bundled with `vscode` left to a stub this test drives. */
function loadPlaces() {
  loaded ??= (async () => {
    const api = { said: [], answers: {}, ViewColumn: { Active: 1, Beside: 2 }, Uri: { file: (fsPath) => ({ fsPath }) },
      commands: { executeCommand: async (id, ...args) => { api.said.push(['command', id, ...args]); } },
      window: { state: { focused: true }, showQuickPick: async () => undefined, showInformationMessage: async () => undefined,
        createWebviewPanel: () => { throw new Error('no page opens in this test'); } },
      env: { clipboard: { writeText: async () => {} } } };
    globalThis[STUB] = api;
    const shim = 'data:text/javascript,' + encodeURIComponent(`const api = globalThis.${STUB};
      export const ViewColumn = api.ViewColumn, Uri = api.Uri, commands = api.commands, window = api.window, env = api.env;`);
    register('data:text/javascript,' + encodeURIComponent(`
      export async function resolve(specifier, context, nextResolve) {
        if (specifier === 'vscode') return { url: ${JSON.stringify(shim)}, shortCircuit: true };
        return nextResolve(specifier, context);
      }`));
    const out = await mkdtemp(path.join(os.tmpdir(), 'sflow-places-'));
    process.once('exit', () => rmSync(out, { recursive: true, force: true }));
    await build({ entryPoints: [path.join(REPOSITORY, 'apps/vscode/src/views/sidebar.ts'), path.join(REPOSITORY, 'apps/vscode/src/views/needs-you.ts')],
      bundle: true, platform: 'node', format: 'esm', external: ['vscode'], outdir: out, outExtension: { '.js': '.mjs' }, logLevel: 'silent' });
    return { api, sidebar: await import(pathToFileURL(path.join(out, 'sidebar.mjs')).href), places: await import(pathToFileURL(path.join(out, 'needs-you.mjs')).href) };
  })();
  return loaded;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const memento = (values = {}) => ({ values, get: (key) => values[key], update: async (key, value) => { values[key] = value; } });
function fakeView() {
  const view = { listeners: [], posted: [], title: undefined, description: undefined, badge: undefined,
    webview: { html: '', options: {}, cspSource: 'stub', onDidReceiveMessage: (listener) => { view.listeners.push(listener); return { dispose() {} }; },
      postMessage: async (message) => { view.posted.push(message); return true; }, asWebviewUri: (uri) => uri },
    send: (message) => { for (const listener of view.listeners) listener(message); } };
  return view;
}
const NAVIGATION = { workspace: { name: 'shop', repository: 'shop-web' }, next: null };
/** What today's Navigator paints for this provider's inputs: sidebarBody's own output. */
const navigatorFor = (navigation) => sidebarBody({ navigation, freshness: null, loading: false, active: null, pending: null, pendingLabel: undefined,
  menuCollapsed: false, promptLog: undefined, favorites: [] });

function fakeHost() {
  const runs = [];
  const client = { run: async (argv) => { runs.push(argv); return { resultType: 'sflow-needs-you', items: [], shown: 0, counts: {}, lines: [],
    checked: { at: '2026-11-28T10:42:00Z', words: 'Checked 10:42 · 2 repositories' }, workspace: { id: 'shop', name: 'shop' }, scope: { repositories: [{}, {}] } }; } };
  return { runs, host: { client, output: { appendLine() {} }, bind: () => client, approve: async () => false, decide: async () => null, refresh: async () => {},
    continueTask: async () => {}, continueAfterDecision: async () => {}, sendChat: async () => {}, waitUntilIdle: async () => {}, showRefusal: () => {} } };
}

test('A21: Advanced paints today\'s Navigator byte for byte under "← The four places"; the view is titled by the place shown', async () => {
  const { sidebar, places, api } = await loadPlaces();
  const provider = new sidebar.SidebarViewProvider(memento({ 'singularityFlow.navigationFavorites.v2': [] }));
  const view = fakeView();
  provider.resolveWebviewView(view);
  provider.setNavigation(NAVIGATION);
  await tick();
  // No places (a window with no repository): the Navigator alone, exactly as before M5.
  assert.ok(view.webview.html.includes(`<body>${navigatorFor(NAVIGATION)}\n`), 'without places, today\'s Navigator and nothing else');
  assert.equal(view.title, undefined, 'the view keeps its contributed name');

  const { host } = fakeHost();
  const place = new places.NeedsYouPlace(host, () => provider.placesChanged());
  place.setPart('library', new LibraryPlace({ command: async () => {} }));
  provider.setPlaces(place);
  await tick();
  assert.equal(view.title, 'Work', 'the sidebar opens on Work');
  assert.equal(view.description, 'shop', 'its description is the workspace');
  assert.match(view.webview.html, /<header class="places-head">[^]*role="tablist"/u);
  // Advanced, from the last row or the title action: today's sidebarBody, unchanged, with the row back at its top.
  view.send({ type: 'places', action: 'advanced' });
  await tick();
  assert.equal(view.title, 'Advanced');
  assert.ok(view.webview.html.includes(`<body>${sidebar.placesRowHtml(true)}${navigatorFor(NAVIGATION)}\n`), 'Advanced is today\'s Navigator, byte for byte');
  assert.match(sidebar.placesRowHtml(true), /data-places="back">← The four places</u);
  view.send({ type: 'places', action: 'back' });
  await tick();
  assert.equal(view.title, 'Work', '← The four places goes back to the place shown before');
  // The tabs and the commands show each place; the header opens the workspace switcher.
  for (const [tab, title] of [['needs-you', 'Needs you'], ['rules', 'Rules'], ['library', 'Library']]) {
    view.send({ type: 'places', action: 'tab', tab });
    await tick();
    assert.equal(view.title, title);
  }
  assert.match(view.webview.html, /data-library="marketplace">Open the Library/u, 'the Library tab is today\'s Marketplace page, one button away');
  place.show('advanced');
  await tick();
  assert.equal(place.shown, 'advanced');
  place.show('work');
  view.send({ type: 'places', action: 'workspace' });
  await tick();
  assert.deepEqual(api.said.at(-1), ['command', 'singularityFlow.switchWorkspace']);
  // Leaving the places gives the view back its name.
  provider.setPlaces(null);
  await tick();
  assert.equal(view.title, 'Navigator');
  assert.equal(view.description, undefined);
  place.dispose();
});

test('REQ-034: classic shows today\'s Navigator first, with the four places one row away', async () => {
  const { sidebar } = await loadPlaces();
  const provider = new sidebar.SidebarViewProvider(memento({ 'singularityFlow.navigationFavorites.v2': [] }));
  const view = fakeView();
  provider.resolveWebviewView(view);
  provider.setNavigation(NAVIGATION);
  let opened = 0;
  provider.setPlacesOpener(() => { opened += 1; });
  await tick();
  assert.ok(view.webview.html.includes(`<body>${sidebar.placesRowHtml(false)}${navigatorFor(NAVIGATION)}\n`), 'the Navigator first, unchanged, under one row');
  assert.match(sidebar.placesRowHtml(false), /data-places="open">The four places: Work, Needs you, Rules and Library</u);
  view.send({ type: 'places', action: 'open' });
  assert.equal(opened, 1, 'the row opens the places');
  view.send({ type: 'places', action: 'tab', tab: 'work' });
  assert.equal(opened, 1, 'only the row opens them');
  // The layout reads VS Code's own value, its default included; anything but `places` keeps today's Navigator.
  assert.equal(sidebar.sidebarLayout({ get: () => 'places' }), 'places');
  assert.equal(sidebar.sidebarLayout({ get: () => 'classic' }), 'classic');
  assert.equal(sidebar.sidebarLayout({ get: () => undefined }), 'classic');
});

test('the one-time notice: only for a person who never chose a layout, once, and Switch back sets classic', async () => {
  const { sidebar } = await loadPlaces();
  const settings = (chosen = {}) => {
    const updates = [];
    return { updates, inspect: () => ({ key: 'singularityFlow.navigation.layout', defaultValue: 'places', ...chosen }),
      update: async (...args) => { updates.push(args); } };
  };
  const shown = [];
  const show = (answer) => async (message, action) => { shown.push([message, action]); return answer; };
  // Never chosen: one line, with Switch back; a dismissal keeps the places.
  const state = memento();
  const kept = settings();
  assert.equal(await sidebar.offerPlacesNotice(kept, state, show(undefined)), false);
  assert.deepEqual(shown, [['SFlow now shows four places; everything else is under Advanced.', 'Switch back']]);
  assert.equal(state.values['singularityFlow.placesNotice.v1'], true);
  assert.deepEqual(kept.updates, []);
  // Once: the next window says nothing.
  assert.equal(await sidebar.offerPlacesNotice(settings(), state, show('Switch back')), false);
  assert.equal(shown.length, 1);
  // Switch back is an undo: classic, for this person's VS Code.
  const undone = settings();
  assert.equal(await sidebar.offerPlacesNotice(undone, memento(), show('Switch back')), true);
  assert.deepEqual(undone.updates, [['navigation.layout', 'classic', true]]);
  // A layout set anywhere is a choice: no notice, and it is kept.
  for (const chosen of [{ globalValue: 'classic' }, { workspaceValue: 'classic' }, { workspaceFolderValue: 'places' }, { globalValue: 'places' }]) {
    const explicit = settings(chosen);
    assert.equal(await sidebar.offerPlacesNotice(explicit, memento(), show('Switch back')), false);
    assert.deepEqual(explicit.updates, []);
  }
  assert.equal(shown.length, 2);
  // A host that cannot say whether it was chosen gets no notice.
  assert.equal(await sidebar.offerPlacesNotice({ update: async () => {} }, memento(), show('Switch back')), false);
});

test('the extension starts the places by default, keeps classic\'s first row, registers the five commands and offers the notice once', async () => {
  const extension = await readFile(path.join(REPOSITORY, 'apps/vscode/src/extension.ts'), 'utf8');
  assert.match(extension, /\.\.\.PLACE_COMMANDS\.map\(\(\[id\]\) => id\)\n {2}\];/u, 'the five commands answer in every window [REQ-033]');
  for (const id of PLACE_COMMAND_IDS) assert.ok(extension.includes(`'${id}'`), id);
  // A place's command opens the places (with classic too); Advanced with none open is the Navigator already shown.
  assert.match(extension, /for \(const \[id, view\] of PLACE_COMMANDS\) \{\n {4}handlers\.set\(id, async \(\) => \{\n {6}if \(view !== 'advanced'\) syncPlaces\(true\);\n {6}needsYouPlace\?\.show\(view\);/u);
  assert.match(extension, /sidebar\.setPlacesOpener\(\(\) => syncPlaces\(true\)\);\n {2}syncPlaces\(\);/u);
  assert.match(extension, /const syncPlaces = \(on = sidebarLayout\(vscode\.workspace\.getConfiguration\('singularityFlow'\)\) === 'places'\): void => \{/u);
  assert.match(extension, /if \(needsYouPlace\) \{\n {4}void offerPlacesNotice\(vscode\.workspace\.getConfiguration\('singularityFlow'\), context\.globalState,/u);
  assert.match(extension, /executeCommand\('setContext', FOUR_PLACES_CONTEXT, true\)/u);
  assert.match(extension, /executeCommand\('setContext', FOUR_PLACES_CONTEXT, false\)/u);
  assert.match(extension, /export const FOUR_PLACES_CONTEXT = 'singularityFlow\.fourPlaces';/u);
  assert.match(extension, /place\.setPart\('library', new \(lazyPanels\(\)\.LibraryPlace\)\(/u);
  const lazy = await readFile(path.join(REPOSITORY, 'apps/vscode/src/lazy-panels-runtime.ts'), 'utf8');
  assert.match(lazy, /export \{ LibraryPlace \} from '\.\/views\/library-place\.ts';/u);
});
