import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveSidebarNavigation } from '../apps/vscode/src/views/sidebar-navigation-model.ts';
import { sidebarBody } from '../apps/vscode/src/views/sidebar-page.ts';
import { sidebarDestination } from '../apps/vscode/src/views/sidebar-destination.ts';
import { workspaceRows, workspaceRunTarget } from '../apps/vscode/src/views/workspaces-model.ts';
import { workspacesHtml, WORKSPACES_SCRIPT, EMPTY_DRAFT } from '../apps/vscode/src/views/workspaces-page.ts';

const entry = (path, overrides = {}) => ({ id: 'sample', path, name: 'Sample', anchorKey: 'sample', active: 'yes', ...overrides });
const page = navigation => ({ navigation, freshness: null, loading: true, pending: null, active: null, favorites: [], menuCollapsed: true });

test('Run & Test lives in workspace context and remains visible without lifecycle reads or an expanded menu', () => {
  for (const path of ['/work/sample', 'C:\\Workspaces\\Sample App']) {
    const navigation = deriveSidebarNavigation([entry(path)], null, { loading: true });
    assert.equal(navigation.workspaceRunPath, path);
    const html = sidebarBody(page(navigation)), context = html.split('<main>')[0];
    assert.match(context, /data-action="workspace-run-test"/);
    assert.match(context, /Run &amp; Test/);
    assert.match(html, /data-main-menu>/);
    assert.doesNotMatch(context, /data-action="work-start"/, 'opening Run & Test does not require starting a Story');
  }
  assert.equal(sidebarDestination('mainThreadWebview-singularityFlow.workspaceRuntime'), 'workspace-run-test');
});

test('missing, ambiguous and archived selections do not create a workspace Run & Test target', () => {
  for (const entries of [[], [entry('/work/a'), entry('/work/b')], [entry('/work/a', { archivedAt: '2026-01-01' })]]) {
    const navigation = deriveSidebarNavigation(entries, null);
    assert.equal(navigation.workspaceRunPath, undefined);
    assert.doesNotMatch(sidebarBody(page(navigation)), /data-action="workspace-run-test"/);
  }
});

test('workspace rows expose Run & Test before detail checks complete and reject forged/archived targets', () => {
  const rows = workspaceRows([entry('/work/a'), entry('/work/b', { id: 'b', active: '' }), entry('/work/archived', { id: 'archived', archivedAt: '2026-01-01' })]);
  const html = workspacesHtml(rows, '/work/a', EMPTY_DRAFT, null, null, true);
  assert.match(html, /Reading workspace configuration/);
  for (const path of ['/work/a', '/work/b']) {
    assert.ok(html.includes(`data-run-test="${path}"`));
    assert.deepEqual(workspaceRunTarget(rows, path), { workspace: path });
  }
  assert.doesNotMatch(html, /data-run-test="\/work\/archived"/);
  for (const path of ['/work/archived', '/work/spoofed', undefined, {}]) assert.equal(workspaceRunTarget(rows, path), null);
});

test('the shipping workspace click script targets the chosen row without a Switch or Reload action', () => {
  const listeners = [], posted = [];
  const document = { addEventListener(type, listener) { if (type === 'click') listeners.push(listener); }, querySelector() { return null; } };
  const window = { __sfVscode: { postMessage(message) { posted.push(message); } } };
  new Function('window', 'document', WORKSPACES_SCRIPT)(window, document);
  const button = { dataset: { runTest: 'C:\\Workspaces\\Another App' }, closest(selector) { return selector.includes('[data-run-test]') ? this : null; } };
  for (const listener of listeners) listener({ target: button, preventDefault() {} });
  assert.deepEqual(posted, [{ type: 'run-test', path: 'C:\\Workspaces\\Another App' }]);
});
