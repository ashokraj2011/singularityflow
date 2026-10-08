/**
 * The explain menus: where a person finds the code explanation, and what "Explain This Change"
 * selects once it is open.
 *
 * The explanation was reachable only from the Command Palette and the bottom of Help → More, so
 * people asked where it was. These hold the new menus to the manifest (each entry appears only
 * while a governed repository is selected and names a command that exists), and hold the focused
 * open to the engine's own line rule, so the editor can never select a different change than
 * `explain --subject line` names.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { EXPLORER_SCRIPT, resolveExplorerFocus } from '../apps/vscode/src/views/change-explorer.ts';
import { sidebarBody } from '../apps/vscode/src/views/sidebar-page.ts';
import { menuResource, repositoryRelativePath } from '../apps/vscode/src/explain-target.ts';
import { explainXpl2Subject } from '../src/comprehension/xpl2/subjects.mjs';
import { createXpl2Fixture } from './helpers/xpl2-fixture.mjs';
import { attribute, renderExplorer } from './helpers/xpl2-html.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'apps/vscode/package.json'), 'utf8'));
const { menus, submenus = [] } = manifest.contributes;
const commandTitles = new Map(manifest.contributes.commands.map((entry) => [entry.command, entry]));
const REPOSITORY = 'singularityFlow.repositoryActive';

test('the explanation opens from the editor, Explorer, Source Control and the sidebar', async () => {
  assert.deepEqual(submenus.map((entry) => [entry.id, entry.label]), [
    ['singularityFlow.editorMenu', 'Singularity Flow'],
    ['singularityFlow.explorerMenu', 'Singularity Flow']
  ]);
  const placed = (menu, key) => (menus[menu] ?? []).find((entry) => entry.submenu === key || entry.command === key);
  assert.ok(placed('editor/context', 'singularityFlow.editorMenu'), 'right-click in a file');
  assert.match(placed('explorer/context', 'singularityFlow.explorerMenu').when, /!explorerResourceIsFolder/,
    'right-click a file in the Explorer; a folder has no single file to explain');
  assert.deepEqual(menus['singularityFlow.editorMenu'].map((entry) => entry.command), [
    'singularityFlow.explainCodeAtCursor', 'singularityFlow.explainChangeAtCursor', 'singularityFlow.explainFileChanges',
    'singularityFlow.openCodeExplainer', 'singularityFlow.openChangeExplorer', 'singularityFlow.openCodeExplanation',
    'singularityFlow.previewSelectedImpact'
  ]);
  assert.deepEqual(menus['singularityFlow.explorerMenu'].map((entry) => entry.command), [
    'singularityFlow.explainFileChanges', 'singularityFlow.previewSelectedImpact'
  ]);
  assert.equal(placed('editor/title', 'singularityFlow.explainFileChanges').group.split('@')[0], 'navigation',
    'the editor title shows it as a button, not in the overflow');
  assert.ok(placed('scm/title', 'singularityFlow.openChangeExplorer'));
  assert.ok(placed('scm/title', 'singularityFlow.openCodeExplainer'), 'the Code Explainer sits beside the Change Explorer in Source Control');
  assert.ok(placed('scm/resourceState/context', 'singularityFlow.explainFileChanges'), 'right-click a changed file');
  const navigator = (menus['view/title'] ?? []).filter((entry) => /view == singularityFlow\.navigation\b/.test(entry.when));
  assert.deepEqual(navigator.map((entry) => [entry.command, entry.group.split('@')[0]]), [
    ['singularityFlow.openChangeExplorer', 'navigation'],
    ['singularityFlow.openCodeExplainer', 'navigation'],
    ['singularityFlow.openCodeExplanation', '1_explain'],
    ['singularityFlow.openComprehensionCenter', '1_explain'],
    ['singularityFlow.refreshCapability', '2_maintain']
  ]);
  assert.equal((menus['editor/context'] ?? []).some((entry) => entry.command), false,
    'every Singularity Flow editor action lives in its one submenu');

  // Outside a governed repository none of this appears; inside one, every entry is gated the same way.
  // Refresh Capability is the exception on purpose: with no repository open it offers the
  // registered workspaces, which is when a person most needs it.
  const repositoryFree = new Set(['singularityFlow.refreshCapability']);
  for (const menu of ['editor/context', 'explorer/context', 'editor/title', 'scm/title', 'scm/resourceState/context', 'view/title']) {
    for (const entry of (menus[menu] ?? []).filter((item) => !repositoryFree.has(item.command))) {
      assert.match(entry.when ?? '', new RegExp(`\\b${REPOSITORY.replace('.', '\\.')}\\b`), `${menu}: ${entry.command ?? entry.submenu}`);
    }
  }
  // A submenu is already labelled "Singularity Flow", so its items do not repeat it; the palette
  // still reads "Singularity Flow: …" through the category.
  for (const command of new Set([...menus['singularityFlow.editorMenu'], ...menus['singularityFlow.explorerMenu']]
    .map((entry) => entry.command))) {
    const contributed = commandTitles.get(command);
    assert.equal(contributed.category, 'Singularity Flow', command);
    assert.doesNotMatch(contributed.title, /^(Singularity Flow|SFlow):/, command);
  }
  assert.equal(commandTitles.get('singularityFlow.explainChangeAtCursor').title, 'Explain This Change');
  assert.equal(commandTitles.get('singularityFlow.explainFileChanges').title, 'Explain Changes in This File');
  assert.equal(commandTitles.get('singularityFlow.explainCodeAtCursor').title, 'Explain This Code');
  assert.equal(commandTitles.get('singularityFlow.openCodeExplainer').title, 'Code Explainer');
  assert.equal((menus.commandPalette ?? []).find((entry) => entry.command === 'singularityFlow.explainCodeAtCursor')?.when,
    `${REPOSITORY} && resourceScheme == file`, 'the palette offers the cursor command only with a file open in a governed repository');

  // The sidebar keeps it with the work instead of at the bottom of Help. Work tools, a row on every
  // sidebar, offers Understand changes, which leads with Explain changes; Help & diagnostics offers
  // none of the explanations. Each group is read by its name, so a restructured sidebar fails here
  // naming the group rather than matching against an empty slice.
  const utilities = sidebarBody({ navigation: { workspace: null, next: null }, freshness: null, loading: false,
    pending: null, active: null, favorites: [] }).match(/<footer aria-label="Utilities">([\s\S]*?)<\/footer>/)?.[1] ?? '';
  assert.match(utilities, /data-action="work-tools"[^>]*>[\s\S]*?<span class="nav-label">Work tools<\/span>/);
  const sidebar = await readFile(path.join(root, 'apps/vscode/src/views/sidebar.ts'), 'utf8');
  const tools = (group) => {
    const declared = sidebar.match(new RegExp(`'${group}': \\{ title: '([^']+)', ids: \\[([^\\]]*)\\] \\}`));
    assert.ok(declared, `the sidebar declares its ${group} group`);
    return { title: declared[1], ids: [...declared[2].matchAll(/'([^']+)'/g)].map((match) => match[1]) };
  };
  assert.ok(tools('work-tools').ids.includes('understand-changes'), 'Work tools offer Understand changes');
  assert.deepEqual(tools('understand-changes'), {
    title: 'Understand changes', ids: ['change-explorer', 'code-explainer', 'repository-knowledge', 'code-explanation', 'comprehension-center']
  }, 'Explain changes comes first, then the Code Explainer and repository knowledge, and the deeper explanations follow');
  assert.match(sidebar, /if \(chosen\.id === 'understand-changes'\) return this\.openTools\(chosen\.id\)/,
    'choosing Understand changes opens its own list');
  assert.doesNotMatch(tools('help-tools').ids.join(' '), /understand-changes|change-explorer|code-explainer|code-explanation|comprehension-center/);
  assert.match(sidebar, /'code-explanation': 'singularityFlow\.openCodeExplanation'/);
  assert.match(sidebar, /'code-explainer': 'singularityFlow\.openCodeExplainer'/);
  assert.match(sidebar, /\{ id: 'code-explainer', label: 'Code Explainer', description: [^}]*command: ACTION_COMMANDS\['code-explainer'\]! \}/,
    'the Code Explainer can be pinned to Favorites');
  assert.match(sidebar, /\{ id: 'change-explorer', label: 'Explain changes', description: [^}]*command: ACTION_COMMANDS\['change-explorer'\]! \}/,
    'it can be pinned to Favorites');
});

test('Explain This Change selects exactly the unit explain --subject line names', async (t) => {
  const fixture = await createXpl2Fixture(t);
  const view = explainXpl2Subject(fixture.input, { subject: 'change' });
  const paths = [...new Set(view.inventory.units.map((unit) => unit.pathAfter)), 'src/untouched.ts'];
  let compared = 0;
  for (const file of paths) {
    const last = Math.max(1, ...view.inventory.units.filter((unit) => unit.pathAfter === file && unit.hunk)
      .map((unit) => unit.hunk.after.start + unit.hunk.after.lines));
    for (let line = 1; line <= last + 2; line += 1) {
      const engine = explainXpl2Subject(fixture.input, { subject: 'line', path: file, line, side: 'after' });
      const named = engine.derived.find((entry) => ['xpl2.line-in-unit@1', 'xpl2.line-opaque@1'].includes(entry.template));
      const focus = resolveExplorerFocus(view, { path: file, line, unsaved: false });
      const selected = focus.notice ? null : focus.unit;
      assert.equal(selected, named?.arguments.unitId ?? null, `${file}:${line}`);
      if (named) {
        const unit = view.inventory.units.find((entry) => entry.unitId === named.arguments.unitId);
        assert.equal(focus.node, unit.fileId, `${file}:${line} selects the unit's file on the map`);
      }
      compared += 1;
    }
  }
  assert.ok(compared > 60, `compared ${compared} lines`);
  assert.equal(resolveExplorerFocus(view, { path: 'assets/export-badge.png', line: 999, unsaved: false }).unit, 'O-001',
    'an opaque unit stands for every line of its file');
});

test('a file request selects its file, finds a deleted one by its old path, and says what it did not find', async (t) => {
  const fixture = await createXpl2Fixture(t);
  const view = explainXpl2Subject(fixture.input, { subject: 'change' });
  const service = view.inventory.units.filter((unit) => unit.pathAfter === 'src/export/service.ts');
  assert.deepEqual(resolveExplorerFocus(view, { path: 'src/export/service.ts', line: null, unsaved: false }),
    { node: service[0].fileId, unit: service[0].unitId, notice: null });

  const outside = resolveExplorerFocus(view, { path: 'src/export/service.ts', line: 30, unsaved: true });
  assert.equal(outside.node, service[0].fileId, 'a line between hunks still shows its file');
  assert.equal(outside.notice, 'Line 30 is not a changed line of src/export/service.ts in this snapshot. '
    + "Showing this file's changes. The editor has unsaved edits; this snapshot reflects the saved file.");
  assert.deepEqual(resolveExplorerFocus(view, { path: 'src/untouched.ts', line: null, unsaved: false }),
    { node: null, unit: null, notice: 'src/untouched.ts has no changes in this snapshot. Showing every change.' });
  assert.equal(resolveExplorerFocus(view, { path: 'src/index.ts', line: 3, unsaved: true }).notice,
    'The editor has unsaved edits; this snapshot reflects the saved file.');

  const deleted = structuredClone(view);
  const unit = deleted.inventory.units.find((entry) => entry.pathAfter === 'src/export/filters.ts');
  unit.pathAfter = null;
  assert.equal(resolveExplorerFocus(deleted, { path: 'src/export/filters.ts', line: null, unsaved: false }).unit, unit.unitId,
    'Source Control can name a deleted file');
  assert.equal(resolveExplorerFocus(deleted, { path: 'src/export/filters.ts', line: 10, unsaved: false }).unit, null,
    'a deleted file has no working lines to point at');
});

test('a focused render names its request, and the note is text', async (t) => {
  const fixture = await createXpl2Fixture(t);
  const view = explainXpl2Subject(fixture.input, { subject: 'change' });
  const plain = renderExplorer(view);
  assert.equal(attribute(plain, 'data-focus-id'), null);
  assert.doesNotMatch(plain, /class="xpl-notice"/);
  const focused = renderExplorer(view, {
    focus: { id: 'request-1', node: 'file:a<b', unit: 'H-002', notice: 'src/<img src=x>.ts has no changes.' }
  });
  assert.equal(attribute(focused, 'data-focus-id'), 'request-1');
  assert.equal(attribute(focused, 'data-focus-node'), 'file:a<b');
  assert.equal(attribute(focused, 'data-focus-unit'), 'H-002');
  assert.match(focused, /<div class="xpl-notice" id="xpl-focus-notice" role="status">src\/&lt;img src=x&gt;\.ts has no changes\.<\/div>/);
  assert.doesNotMatch(focused, /command:|href=/, 'a focused page still carries nothing to execute');
  const cleared = renderExplorer(view, { focus: { id: 'request-2', node: null, unit: null, notice: null } });
  assert.equal(attribute(cleared, 'data-focus-node'), '', 'an empty focus clears the remembered selection');
});

/** Run the explorer script over the smallest page it needs, and report what it saved and focused. */
function runExplorer(dataset, saved, { folded = false, withNote = true } = {}) {
  const states = [];
  const focused = [];
  const scrolled = [];
  const cluster = { open: !folded };
  const note = { hidden: false, scrollIntoView: () => scrolled.push('note') };
  const layout = { scrollIntoView: () => scrolled.push('layout') };
  const target = {
    dataset: {}, classList: { toggle() {}, add() {}, contains: () => false },
    closest: (selector) => (selector === 'details:not([open])' && !cluster.open ? cluster : null),
    focus: (options) => focused.push(options?.preventScroll ? 'quietly' : 'scrolling')
  };
  const page = { dataset, addEventListener() {} };
  runInNewContext(EXPLORER_SCRIPT, {
    window: {
      __sfVscode: {
        postMessage() {}, getState: () => saved,
        setState: (state) => states.push(JSON.parse(JSON.stringify(state)))
      }
    },
    document: {
      getElementById: (id) => (id === 'xpl-root' ? page : id === 'xpl-focus-notice' && withNote ? note : null),
      querySelectorAll: () => [],
      querySelector: (selector) => (selector.startsWith('.xpl-map [data-node=') ? target
        : selector === '.xpl-layout' ? layout : null)
    },
    CSS: { escape: (value) => value }
  });
  return { state: states.at(-1), focused, scrolled, cluster, note };
}

test('the page applies each request once over the remembered selection, unfolding its cluster', () => {
  const units = JSON.stringify([
    { unitId: 'H-001', nodeId: 'unit:H-001', fileId: 'file:a', digest: 'sha256:1' },
    { unitId: 'H-002', nodeId: 'unit:H-002', fileId: 'file:b', digest: 'sha256:2' },
    { unitId: 'H-003', nodeId: 'unit:H-003', fileId: 'file:b', digest: 'sha256:3' }
  ]);
  const page = { set: 'sha256:set', session: 'render', units, firstUnit: 'H-001' };
  const remembered = { set: 'sha256:set', selected: 'file:a', unit: 'H-001', view: 'relationships' };
  const request = { ...page, focusId: 'request-1', focusNode: 'file:b', focusUnit: 'H-003' };

  const kept = runExplorer({ ...page }, remembered);
  assert.deepEqual([kept.state.selected, kept.state.unit, kept.state.view], ['file:a', 'H-001', 'relationships'],
    'without a request the remembered selection stays');

  const asked = runExplorer(request, remembered, { folded: true });
  assert.deepEqual([asked.state.selected, asked.state.unit, asked.state.view, asked.state.focusId],
    ['file:b', 'H-003', 'map', 'request-1']);
  assert.deepEqual(asked.focused, ['quietly'], 'focus moves to the selected file without scrolling past the note');
  assert.deepEqual(asked.scrolled, ['note'], 'the note and the selection come into view together');
  assert.equal(asked.cluster.open, true, 'a file folded into a cluster is unfolded to be shown');
  assert.equal(asked.note.hidden, false, 'the page that applies the request shows its note');
  assert.deepEqual(runExplorer(request, remembered, { withNote: false }).scrolled, ['layout'],
    'without a note, the inventory and map come into view');

  // The reader then chose another file, and something re-rendered the page with the same request.
  const later = runExplorer(request, { ...asked.state, selected: 'file:a', unit: 'H-001' });
  assert.deepEqual([later.state.selected, later.state.unit], ['file:a', 'H-001'],
    'an applied request never takes the selection back');
  assert.equal(later.note.hidden, true, 'nor repeats its note');
  assert.deepEqual(later.scrolled, [], 'nor moves the page');
  assert.deepEqual(later.focused, ['scrolling'], 'a remembered selection is restored as before');

  const nothing = runExplorer({ ...page, focusId: 'request-2', focusNode: '', focusUnit: '' }, remembered);
  assert.equal(nothing.state.selected, '', 'a file with no change clears the old selection');
  assert.deepEqual(nothing.focused, []);
});

test('menu arguments resolve to repository files, through links, and never outside', async (t) => {
  assert.deepEqual(menuResource({ fsPath: '/r/a.ts', scheme: 'file', path: '/r/a.ts' }), { fsPath: '/r/a.ts', scheme: 'file' });
  assert.deepEqual(menuResource({ resourceUri: { fsPath: '/r/b.ts', scheme: 'file' } }), { fsPath: '/r/b.ts', scheme: 'file' },
    'a Source Control resource state carries its file');
  for (const junk of [undefined, null, 'file:///r/a.ts', {}, { fsPath: 1, scheme: 'file' }, { resourceUri: 'x' }]) {
    assert.equal(menuResource(junk), null, JSON.stringify(junk));
  }

  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-explain-target-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repository = path.join(base, 'repository');
  await mkdir(path.join(repository, 'src'), { recursive: true });
  await writeFile(path.join(repository, 'src', 'a.ts'), 'export {};\n');
  await symlink(repository, path.join(base, 'linked'));
  const { realpath } = await import('node:fs/promises');
  const canonical = await realpath(repository);

  assert.equal(await repositoryRelativePath(canonical, path.join(canonical, 'src', 'a.ts')), 'src/a.ts');
  assert.equal(await repositoryRelativePath(canonical, path.join(base, 'linked', 'src', 'a.ts')), 'src/a.ts',
    'an editor holding the file through a link is still inside');
  assert.equal(await repositoryRelativePath(canonical, path.join(base, 'linked', 'src', 'deleted.ts')), 'src/deleted.ts',
    'a deleted file resolves through its folder');
  assert.equal(await repositoryRelativePath(canonical, canonical), null, 'the root is not a file');
  assert.equal(await repositoryRelativePath(canonical, path.join(base, 'other.ts')), null);
  assert.equal(await repositoryRelativePath(canonical, path.join(canonical, '..', 'repository-sibling', 'x.ts')), null);
});
