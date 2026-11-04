import assert from 'node:assert/strict';
import { register } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildOutcomeReview } from '../src/outcome-review.mjs';

let panel;
const commands = [];
globalThis.__sfOutcomeRefreshVscode = {
  ViewColumn: { Active: 1 }, workspace: { isTrusted: true },
  commands: { async executeCommand(...args) { commands.push(args); } },
  window: {
    createWebviewPanel() {
      let receive = () => {};
      let rendered;
      let html = '';
      const loaded = new Promise(resolve => { rendered = resolve; });
      panel = { loaded, webview: { get html() { return html; }, set html(value) {
        html = value; if (value.includes('REFRESH-1')) rendered();
      }, cspSource: 'vscode-resource:',
        onDidReceiveMessage(listener) { receive = listener; return { dispose() {} }; } },
      post: message => receive(message), onDidDispose() { return { dispose() {} }; }, reveal() {}, dispose() {} };
      return panel;
    }
  }
};
const shim = 'data:text/javascript,' + encodeURIComponent(`
  export const { ViewColumn, workspace, commands, window } = globalThis.__sfOutcomeRefreshVscode;
`);
register(new URL('../scripts/typescript-test-loader.mjs', import.meta.url));
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'vscode') return { url: ${JSON.stringify(shim)}, shortCircuit: true };
    return nextResolve(specifier, context);
  }
`));
const { OutcomeReviewPanel } = await import('../apps/vscode/src/views/outcome-review.ts');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, refresh) {
  commands.length = 0;
  const repository = await mkdtemp(path.join(os.tmpdir(), 'sflow-outcome-refresh-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const workflow = { workItem: { id: 'REFRESH-1' }, status: 'in_progress', currentPhase: 'implementation',
    phases: { implementation: { status: 'in_progress', generation: 1 } } };
  const store = { current: { snapshot: { workflow }, stale: true, error: null }, refreshes: 0,
    async refresh() { this.refreshes++; await refresh(this); } };
  const reads = [];
  const client = { repository, async run(argv) {
    reads.push(argv);
    return { data: { outcome: buildOutcomeReview({ workflow: store.current.snapshot.workflow,
      graph: { records: { indexes: [] } }, evaluation: { rows: [], findings: [] },
      owed: { witnesses: [], scopeItems: [] }, contracts: new Map(), application: { status: 'not-declared' } }) } };
  } };
  const view = OutcomeReviewPanel.show({}, store, client);
  t.after(() => view.dispose());
  let timer;
  try {
    await Promise.race([panel.loaded, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Initial outcome read did not render: ${panel.webview.html.slice(0, 500)}`)), 5000);
    })]);
  } finally { clearTimeout(timer); }
  assert.ok(panel.webview.html.includes('REFRESH-1'), 'the initial CLI outcome was loaded');
  return { store, reads, panel };
}

test('outcome Refresh renews the shared snapshot before its next read and releases the stale-action loop', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { store, reads, panel } = await fixture(t, async store => { await gate; store.current.stale = false; });
  await panel.post({ type: 'action', action: 'start' });
  assert.equal(commands.length, 0, 'a stale shared snapshot cannot run the app');
  const refreshing = panel.post({ type: 'action', action: 'refresh' });
  await tick();
  assert.equal(store.refreshes, 1);
  assert.equal(reads.length, 1, 'outcome is not reloaded ahead of the shared snapshot');
  await panel.post({ type: 'action', action: 'start' });
  assert.equal(commands.length, 0, 'actions remain unavailable while refresh is in flight');
  release(); await refreshing;
  assert.equal(reads.length, 2);
  await panel.post({ type: 'action', action: 'start' });
  assert.deepEqual(commands, [['singularityFlow.startApplication']]);
});

test('outcome Refresh preserves the actual snapshot error and keeps actions disabled', async t => {
  const { store, reads, panel } = await fixture(t, async () => { throw new Error('EACCES: cannot read the active Story snapshot'); });
  await panel.post({ type: 'action', action: 'refresh' });
  assert.equal(store.refreshes, 1);
  assert.equal(reads.length, 1, 'a failed snapshot refresh cannot be hidden by a successful outcome read');
  assert.match(panel.webview.html, /EACCES: cannot read the active Story snapshot/);
  await panel.post({ type: 'action', action: 'start' });
  assert.equal(commands.length, 0);
  assert.match(panel.webview.html, /EACCES: cannot read the active Story snapshot/);
});

test('outcome Refresh shows a store-reported error without polling or accepting stale outcome data', async t => {
  const { store, reads, panel } = await fixture(t, async store => { store.current.error = new Error('Git deadline exceeded while checking the Story'); });
  await panel.post({ type: 'action', action: 'refresh' });
  assert.equal(store.refreshes, 1);
  assert.equal(reads.length, 1);
  assert.match(panel.webview.html, /Git deadline exceeded while checking the Story/);
});
