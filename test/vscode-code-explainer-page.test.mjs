/**
 * The Code Explainer page and its host boundary.
 *
 * The page script's pure parts (layout, paths, framing, folding) run here in a bare context; the
 * script must not need a document to expose them. The rest of this file holds the page to inert
 * rendering and the host to a closed vocabulary that never accepts a path, command or URL.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { CODE_EXPLAINER_SCRIPT, CX_STYLE, codeExplainerBody } from '../apps/vscode/src/views/code-explainer-page.ts';
import { codeOnly } from './source-text.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function helpers() {
  const window = {};
  runInNewContext(CODE_EXPLAINER_SCRIPT, { window });
  return window.__codeExplainer;
}

test('the script exposes its layout without a document, and parses as a raw string', () => {
  const api = helpers();
  for (const name of ['layout', 'edgePath', 'loopPath', 'fitTransform', 'moduleRows', 'cardHeight', 'isCollapsed']) {
    assert.equal(typeof api[name], 'function', name);
  }
  assert.doesNotMatch(CODE_EXPLAINER_SCRIPT, /\$\{/, 'a raw template must not interpolate');
  assert.doesNotMatch(CODE_EXPLAINER_SCRIPT, /`/, 'no backtick can end the raw string early');
  assert.doesNotMatch(CODE_EXPLAINER_SCRIPT, /<\/script/i);
});

test('callers sit left of what they call, a column never overlaps, and unconnected cards go below', () => {
  const { layout } = helpers();
  const nodes = [
    { id: 'test', height: 120, rank0: 2 }, { id: 'checkout', height: 90, rank0: 1 }, { id: 'policy', height: 260, rank0: 0 },
    { id: 'client', height: 90, rank0: 3 }, { id: 'sink', height: 70, rank0: 3 }, { id: 'docs', height: 60, rank0: 6 }, { id: 'records', height: 60, rank0: 6 }
  ];
  const edges = [
    { from: 'test', to: 'policy' }, { from: 'checkout', to: 'policy' }, { from: 'policy', to: 'client' },
    { from: 'policy', to: 'sink' }, { from: 'checkout', to: 'client' }, { from: 'policy', to: 'policy' }
  ];
  const { positions } = layout(nodes, edges);
  for (const edge of edges.filter((entry) => entry.from !== entry.to)) {
    assert.ok(positions[edge.from].x < positions[edge.to].x, `${edge.from} is left of ${edge.to}`);
  }
  const columns = new Map();
  for (const node of nodes) columns.set(positions[node.id].x, [...(columns.get(positions[node.id].x) ?? []), node]);
  for (const column of columns.values()) {
    const sorted = column.map((node) => ({ top: positions[node.id].y, bottom: positions[node.id].y + node.height })).sort((a, b) => a.top - b.top);
    for (let index = 1; index < sorted.length; index += 1) assert.ok(sorted[index].top >= sorted[index - 1].bottom, 'cards in a column do not overlap');
  }
  const lowestConnected = Math.max(...['test', 'checkout', 'policy', 'client', 'sink'].map((id) => positions[id].y + nodes.find((node) => node.id === id).height));
  for (const id of ['docs', 'records']) assert.ok(positions[id].y > lowestConnected, `${id} is placed below the graph`);
  assert.deepEqual(layout(nodes, edges).positions, positions, 'the layout is deterministic');
  const cyclic = layout([{ id: 'a', height: 50 }, { id: 'b', height: 50 }, { id: 'c', height: 50 }], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }]);
  assert.equal(Object.keys(cyclic.positions).length, 3, 'a cycle is broken, not looped on');
  assert.equal(Object.keys(cyclic.reversed).length, 1);
});

test('paths, framing and folding', () => {
  const { edgePath, loopPath, fitTransform, moduleRows, cardHeight, isCollapsed } = helpers();
  assert.equal(edgePath(0, 10, 200, 50), 'M0 10 C100 10 100 50 200 50');
  assert.match(edgePath(300, 10, 0, 50), /^M300 10 C/, 'a backward edge still starts at its source');
  assert.match(loopPath(300, 20, 80), /^M300 20 C3\d\d 20 3\d\d 80 302 80$/, 'a call inside one card loops out and back to the same edge');
  const tiny = fitTransform({ x: 0, y: 0, w: 10000, h: 10000 }, 800, 600, 36);
  assert.equal(tiny.zoom, 0.2, 'zoom never drops below a fifth');
  assert.equal(fitTransform({ x: 0, y: 0, w: 100, h: 100 }, 800, 600, 36).zoom, 1, 'a small graph is never magnified');
  const model = { byId: {} };
  const ids = Array.from({ length: 15 }, (_, index) => `s${index}`);
  ids.forEach((id, index) => { model.byId[id] = { id, primary: index < 13 }; });
  const view = { expanded: {}, collapsed: {}, selected: 's14' };
  const module = { id: 'm', symbolIds: ids, collapsed: false };
  const rows = moduleRows(model, module, view);
  assert.equal(rows.rows.length, 12, 'twelve rows are drawn first');
  assert.equal(rows.hidden, 3, 'the rest are counted, the selected one among the shown');
  assert.equal(moduleRows(model, module, { ...view, expanded: { m: true } }).rows.length, 15, 'expanded, every symbol is a row');
  assert.equal(isCollapsed({ id: 'r', collapsed: true }, { collapsed: {} }), true, 'a card can start folded');
  assert.equal(isCollapsed({ id: 'r', collapsed: true }, { collapsed: { r: false } }), false, 'and a person can open it');
  // Objects made inside the script's context have its prototypes; compare their plain values.
  assert.deepEqual(JSON.parse(JSON.stringify(moduleRows(model, { ...module, collapsed: true }, view))), { rows: [], hidden: 15 });
  assert.equal(cardHeight(2, 0) < cardHeight(2, 3), true);
});

test('everything the page shows is built as text; nothing is parsed as markup', () => {
  for (const unsafe of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function/]) {
    assert.doesNotMatch(CODE_EXPLAINER_SCRIPT, unsafe, String(unsafe));
  }
  const body = codeExplainerBody('nonce-123');
  assert.match(body, /^<style nonce="nonce-123">/, 'the stylesheet carries the CSP nonce');
  assert.doesNotMatch(body, /\son[a-z]+=/i, 'no inline event handlers');
  assert.doesNotMatch(body, /style="/, 'no inline style attributes under a nonce-only policy');
  for (const id of ['cx-tab-graph', 'cx-tab-trace', 'cx-tab-walk', 'cx-canvas', 'cx-inspector', 'cx-search', 'cx-status']) {
    assert.match(body, new RegExp(`id="${id}"`), id);
  }
  assert.match(body, /role="tablist"/);
  assert.match(body, /aria-label="Dependency graph\. Arrow keys move between functions, Enter opens, Escape clears\."/);
  assert.match(CX_STYLE, /prefers-reduced-motion/, 'animated call flow stops for reduced motion');
});

test('the host accepts a closed set of messages, each naming ids, never a path, command or URL', async () => {
  const source = codeOnly(await readFile(path.join(root, 'apps/vscode/src/views/code-explainer.ts'), 'utf8'));
  const router = source.slice(source.indexOf("registerMessageRouter('singularityFlow.codeExplainer'"), source.indexOf('private accept('));
  const accepted = [...router.matchAll(/'(cx\.[A-Za-z]+)':/g)].map((match) => match[1]);
  assert.deepEqual(accepted, ['cx.ready', 'cx.reindex', 'cx.depth', 'cx.view', 'cx.scope', 'cx.open', 'cx.openModule', 'cx.openTest', 'cx.openSite',
    'cx.openLine', 'cx.diff', 'cx.ask', 'cx.copy', 'cx.export', 'cx.changeExplorer', 'cx.repository', 'cx.repoOpen', 'cx.story']);
  const fields = [...router.matchAll(/(?:string|integer|enum)Field\(message, '([a-z]+)'/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(fields)].sort(), ['depth', 'edge', 'index', 'line', 'module', 'symbol', 'to', 'view']);
  assert.match(source, /navigationTarget\(raw\)/, 'the footer navigation is handled');
  assert.match(source, /retainContextWhenHidden: true/);
  // Every action that opens something resolves it from the host's own harvest.
  assert.match(source, /private locate\(symbolId: string \| null\)/);
  assert.match(source, /containedWorkingPath\(root, relative\)/, 'a repository file is opened only when it stays inside the repository');
  const page = codeOnly(await readFile(path.join(root, 'apps/vscode/src/views/code-explainer-page.ts'), 'utf8'));
  const posted = [...page.matchAll(/post\('(cx\.[A-Za-z]+)'/g)].map((match) => match[1]);
  for (const type of new Set(posted)) assert.ok(accepted.includes(type), `the page only sends what the host accepts: ${type}`);
});

test('the graph offers a delta and a full view, and the page asks the host for the other one', async () => {
  const body = codeExplainerBody('nonce');
  assert.match(body, /<div class="cx-depth cx-view-mode" role="group" aria-label="Graph view"><span>View<\/span>/);
  assert.match(body, /data-view="delta" aria-pressed="true"[^>]*>Delta<\/button>/);
  assert.match(body, /data-view="full" aria-pressed="false"[^>]*>Full<\/button>/);
  // Only a different view is asked for, and the pressed state follows the model the host built.
  assert.match(CODE_EXPLAINER_SCRIPT, /if \(viewButton\.dataset\.view !== model\.view\) post\('cx\.view', \{ view: viewButton\.dataset\.view \}\);/);
  assert.match(CODE_EXPLAINER_SCRIPT, /node\.setAttribute\('aria-pressed', String\(node\.dataset\.view === model\.view\)\)/);
  assert.match(CODE_EXPLAINER_SCRIPT, /Choose Full to map every function in the current worktree/, 'an empty delta says where the map is');
  assert.match(CODE_EXPLAINER_SCRIPT, /if \(fresh && !viewChosen && view\.lens === 'code' && model\.view !== 'full' && model\.change\.status === 'empty'/, 'the full view stays on its map instead of jumping to Repository, and another lens stays where it is');
  assert.match(CODE_EXPLAINER_SCRIPT, /if \(view\.tab !== 'graph'\) setTab\('graph'\);/, 'choosing a view shows the graph');
  assert.match(CODE_EXPLAINER_SCRIPT, /view\.filters = Object\.assign\(\{\}, DEFAULT_FILTERS, view\.filters \|\| \{\}\);/, 'a role added after state was saved is not hidden');
  assert.match(CODE_EXPLAINER_SCRIPT, /repository: 'Repository'/);
  assert.match(CX_STYLE, /\.cx-dot\.repository \{ background: var\(--cx-repository\); \}/);
  const host = codeOnly(await readFile(path.join(root, 'apps/vscode/src/views/code-explainer.ts'), 'utf8'));
  assert.match(host, /const graphView: CxView = this\.view \?\? \(targets\.length \? 'delta' : 'full'\);/,
    'a Story that has not changed code opens on the full view');
  assert.match(host, /\['explain', 'code', '--repository', '--json'\]/, 'the full view reads the worktree at every build, so Re-index sees it as it is');
  assert.match(host, /hasScriptProject\(root\)/, 'a project-less JavaScript service is given the rest of the code before callers are asked for');
});

test('the lens bar offers Code and four more lenses, each with its own view', () => {
  const body = codeExplainerBody('nonce');
  assert.match(body, /<nav class="cx-lenses" role="tablist" aria-label="Lenses">/);
  const lenses = [...body.matchAll(/data-lens="([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(lenses, ['code', 'concepts', 'entities', 'flow', 'logic']);
  for (const id of ['cx-view-concepts', 'cx-view-entities', 'cx-view-flow', 'cx-view-logic', 'cx-flow-entry', 'cx-logic-fn', 'cx-tabs-row']) {
    assert.match(body, new RegExp(`id="${id}"`), id);
  }
  // The Code lens keeps its own tabs; another lens hides them and keeps its own selection.
  assert.match(CODE_EXPLAINER_SCRIPT, /\$\('cx-tabs-row'\)\.hidden = !code;/);
  assert.match(CODE_EXPLAINER_SCRIPT, /if \(next !== view\.lens\) view\.lensItem = null;/);
  assert.match(CODE_EXPLAINER_SCRIPT, /if \(view\.lens !== 'code'\) \{ view\.lens = 'code'; paintLensBar\(\); \}/, 'a Code tab asked for from anywhere shows the Code lens');
});

test('lens layouts: stacked top-down and wrapped to the panel; flowcharts never overlap and long switches grow downwards', () => {
  const { stackLayout, logicLayout } = helpers();
  const nodes = ['entry', 'a', 'b', 'c', 'd', 'sink', 'alone'].map((id) => ({ id, w: 200, h: 50 }));
  const edges = [{ from: 'entry', to: 'a' }, { from: 'entry', to: 'b' }, { from: 'entry', to: 'c' }, { from: 'entry', to: 'd' }, { from: 'a', to: 'sink' }, { from: 'd', to: 'sink' }];
  const stacked = stackLayout(nodes, edges, 450);
  const at = stacked.positions;
  for (const edge of edges) assert.ok(at[edge.from].y < at[edge.to].y, `${edge.from} above ${edge.to}`);
  assert.equal(new Set(['a', 'b', 'c', 'd'].map((id) => at[id].y)).size, 2, 'four in a layer wrap to two rows of two in 450px');
  for (const node of nodes) assert.ok(at[node.id].x + node.w <= 450 + 1, `${node.id} stays inside the width`);
  assert.ok(at.alone.y > at.sink.y, 'a node with no edges goes after the last layer');
  const step = (text) => ({ k: 'step', lines: [{ text, line: 1 }], calls: [] });
  const cases = Array.from({ length: 8 }, (_, index) => ({ label: `case ${index}`, line: index + 2, body: [step(`work ${index}`), { k: 'return', text: String(index), line: 3, calls: [] }] }));
  const flow = [
    step('start work'),
    { k: 'if', cond: 'a > 1', line: 2, then: [step('yes branch')], else: [{ k: 'if', cond: 'a > 2', line: 3, then: [step('second')], else: [{ k: 'if', cond: 'a > 3', line: 4, then: [step('third')], else: [step('otherwise')] }] }] },
    { k: 'loop', head: 'for item of items', line: 5, body: [step('handle item'), { k: 'if', cond: 'item.bad', line: 6, then: [{ k: 'throw', text: 'new Error()', line: 6, calls: [] }], else: null }] },
    { k: 'switch', subject: 'kind', line: 7, cases },
    { k: 'try', line: 9, body: [step('save')], catches: [{ label: 'IOError', line: 10, body: [step('log')] }], final: null }
  ];
  const chart = logicLayout(flow);
  for (let i = 0; i < chart.nodes.length; i += 1) {
    for (let j = i + 1; j < chart.nodes.length; j += 1) {
      const a = chart.nodes[i], b = chart.nodes[j];
      assert.ok(!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h), `${a.lines[0]} overlaps ${b.lines[0]}`);
    }
  }
  assert.ok(chart.width < 900, `eight cases and an else-if chain stay narrow (${chart.width}px)`);
  assert.ok(chart.nodes.some((node) => node.lines[0] === 'first that holds'), 'an else-if chain is one decision with several outcomes');
  assert.equal(chart.nodes[0].kind, 'start');
  assert.ok(chart.edges.some((edge) => edge.back), 'a loop draws its way back');
  assert.ok(chart.edges.some((edge) => edge.label === 'on error: IOError' && edge.dashed), 'a catch is a dashed branch');
});

test('the full view offers the folders it can map, and the page asks for one by its index', async () => {
  const body = codeExplainerBody('nonce');
  assert.match(body, /<label class="cx-scope-pick" id="cx-scope-pick" hidden><span>Folder<\/span><select id="cx-scope"/);
  assert.match(CODE_EXPLAINER_SCRIPT, /pick\.hidden = model\.view !== 'full' \|\| areas\.length < 2;/, 'only the full view of more than one folder shows it');
  assert.match(CODE_EXPLAINER_SCRIPT, /post\('cx\.scope', \{ index: index \}\);/, 'the page names an index, never a path');
  assert.match(CODE_EXPLAINER_SCRIPT, /whole\.value = '-1';/, 'the whole worktree stays one choice');
  const host = codeOnly(await readFile(path.join(root, 'apps/vscode/src/views/code-explainer.ts'), 'utf8'));
  assert.match(host, /const area = index >= 0 \? this\.areas\[index\] \?\? null : null;/, 'the host resolves the index against its own list');
  assert.match(host, /fairSample\(inScope, \(relative\) => relative, codeAreas\(inScope\), limit\)/, 'a bound keeps every folder represented');
  assert.match(host, /repository\?\.budget\?\.status === 'over-budget'\) return await this\.listedCodeFiles\(notes\)/,
    'a repository over the AST budget is listed from the worktree, not mapped as empty');
  assert.match(host, /vscode\.workspace\.findFiles\(new vscode\.RelativePattern\(root, CODE_FILE_GLOB\), LISTING_EXCLUDE, CX_LIMITS\.listedFiles\)/);
  const raw = await readFile(path.join(root, 'apps/vscode/src/views/code-explainer.ts'), 'utf8');
  assert.match(raw, /LISTING_EXCLUDE = `\*\*\/\{\.git,singularity,\.singularity-flow,node_modules/, 'the listing never walks Git metadata or Singularity Flow records');
  assert.match(host, /explainableView\(commandData/, 'the Repository tab drops anything this panel may not show before indexes are given out');
});

test('each file and folder carries an icon for its language', () => {
  const families = runInNewContext(`(${CODE_EXPLAINER_SCRIPT.match(/const LANGUAGE_FAMILY = (\{[\s\S]*?\});/)[1]})`);
  for (const [language, family] of [['java', 'java'], ['python', 'python'], ['typescriptreact', 'typescript'], ['typescript', 'typescript'],
    ['javascript', 'javascript'], ['csharp', 'csharp'], ['cs', 'csharp'], ['fsharp', 'fsharp'], ['shellscript', 'shell'], ['sh', 'shell'],
    ['bash', 'shell'], ['powershell', 'powershell']]) {
    assert.equal(families[language], family, language);
  }
  assert.match(CODE_EXPLAINER_SCRIPT, /csharp: \['C#', '#68217a', '#fff'\]/);
  assert.match(CODE_EXPLAINER_SCRIPT, /if \(!module\.group && !module\.external\) fileName\.insertBefore\(langIcon\(module\.language\), fileName\.firstChild\);/, 'graph cards');
  assert.match(CODE_EXPLAINER_SCRIPT, /if \(!module\.group && !module\.external\) head\.appendChild\(langIcon\(module\.language\)\);/, 'the outline');
  assert.match(CODE_EXPLAINER_SCRIPT, /filePath\.insertBefore\(langIcon\(file\.language\), filePath\.firstChild\);/, 'repository files');
  assert.match(CODE_EXPLAINER_SCRIPT, /icons\.appendChild\(langIcon\(item\.language\)\)/, 'repository folders show each language they hold');
  assert.match(CX_STYLE, /\.cx-lang \{ display: inline-grid;/);
});
