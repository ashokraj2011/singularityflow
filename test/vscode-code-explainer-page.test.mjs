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
  assert.deepEqual(accepted, ['cx.ready', 'cx.reindex', 'cx.depth', 'cx.open', 'cx.openModule', 'cx.openTest', 'cx.openSite',
    'cx.diff', 'cx.ask', 'cx.copy', 'cx.export', 'cx.changeExplorer', 'cx.repository', 'cx.repoOpen', 'cx.story']);
  const fields = [...router.matchAll(/(?:string|integer|enum)Field\(message, '([a-z]+)'/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(fields)].sort(), ['depth', 'edge', 'index', 'line', 'module', 'symbol', 'to']);
  assert.match(source, /navigationTarget\(raw\)/, 'the footer navigation is handled');
  assert.match(source, /retainContextWhenHidden: true/);
  // Every action that opens something resolves it from the host's own harvest.
  assert.match(source, /private locate\(symbolId: string \| null\)/);
  assert.match(source, /containedWorkingPath\(root, relative\)/, 'a repository file is opened only when it stays inside the repository');
  const page = codeOnly(await readFile(path.join(root, 'apps/vscode/src/views/code-explainer-page.ts'), 'utf8'));
  const posted = [...page.matchAll(/post\('(cx\.[A-Za-z]+)'/g)].map((match) => match[1]);
  for (const type of new Set(posted)) assert.ok(accepted.includes(type), `the page only sends what the host accepts: ${type}`);
});
