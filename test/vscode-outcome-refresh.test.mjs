import assert from 'node:assert/strict';
import { register } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildOutcomeReview } from '../src/outcome-review.mjs';

let panel;
const commands = [];
let pick = async () => undefined;
globalThis.__sfOutcomeRefreshVscode = {
  ViewColumn: { Active: 1 }, workspace: { isTrusted: true },
  commands: { async executeCommand(...args) { commands.push(args); } },
  window: {
    showQuickPick(items, options) { return pick(items, options); },
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

async function fixture(t, refresh, application = { status: 'not-declared' }, capability = null) {
  commands.length = 0;
  pick = async () => undefined;
  const repository = await mkdtemp(path.join(os.tmpdir(), 'sflow-outcome-refresh-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const workflow = { workItem: { id: 'REFRESH-1' }, status: 'in_progress', currentPhase: 'implementation',
    phases: { implementation: { status: 'in_progress', generation: 1, generationPolicy: { task: 'code' } } } };
  const store = { current: { snapshot: { workflow }, stale: true, error: null }, refreshes: 0,
    async refresh() { this.refreshes++; await refresh(this); } };
  const reads = [];
  const client = { repository, async run(argv) {
    reads.push(argv);
    return { data: { outcome: buildOutcomeReview({ workflow: store.current.snapshot.workflow,
      graph: { records: { indexes: [] } }, evaluation: { rows: [], findings: [] },
      owed: { witnesses: [], scopeItems: [] }, contracts: new Map(), application }) } };
  } };
  const view = OutcomeReviewPanel.show({}, store, client, null, capability);
  t.after(() => view.dispose());
  let timer;
  try {
    await Promise.race([panel.loaded, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Initial outcome read did not render: ${panel.webview.html.slice(0, 500)}`)), 5000);
    })]);
  } finally { clearTimeout(timer); }
  assert.ok(panel.webview.html.includes('REFRESH-1'), 'the initial CLI outcome was loaded');
  return { store, reads, panel, view, client };
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
  assert.deepEqual(commands, [['singularityFlow.startApplication', { workId: 'REFRESH-1', phase: 'implementation', generation: 1, capability: undefined }]]);
});

test('native validation asks a real question, cancellation runs nothing, and an explicit choice keeps the exact Story target', async t => {
  const application = { status: 'declared', capability: 'web', entries: [{ id: 'dev', name: 'Web', url: 'http://localhost:5173', started: false, ready: false,
    start: { command: 'singularity-flow app start dev --capability web' } }] };
  const { store, reads, view } = await fixture(t, async store => { store.current.stale = false; }, application);
  const cancelled = await view.guideDelivery('REFRESH-1');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(store.refreshes, 1, 'the stale snapshot is refreshed once before asking');
  assert.deepEqual(commands, [], 'cancelling cannot start, run tests, witness or approve');
  assert.equal(reads.length, 2, 'no polling or repeated publication');
  pick = async (items, options) => {
    assert.match(options.placeHolder, /What would you like to validate for REFRESH-1/);
    return items.find(item => item.label === 'Start Web');
  };
  const started = await view.guideDelivery('REFRESH-1');
  assert.equal(started.status, 'selected');
  assert.equal(started.choice, 'start:dev');
  assert.equal(started.recorded, null, 'selection establishes no test result or acceptance');
  assert.deepEqual(commands, [['singularityFlow.startApplication', {
    workId: 'REFRESH-1', phase: 'implementation', generation: 1, capability: 'web', configuration: 'dev'
  }]]);
  assert.equal(reads.length, 2, 'asking reuses the one outcome packet');
});

test('local setup and test choices target this checkout without shared policy edits or implicit witnesses', async t => {
  const { store, view, panel } = await fixture(t, async store => { store.current.stale = false; }, { status: 'none-declared', capability: 'web' });
  store.current.stale = false;
  pick = async items => items.find(item => item.label === 'Set up or change local run configuration');
  assert.equal((await view.guideDelivery('REFRESH-1')).choice, 'configure');
  assert.deepEqual(commands, [['singularityFlow.editRunConfigurations', {
    workId: 'REFRESH-1', phase: 'implementation', generation: 1, capability: 'web', local: true
  }]]);
  pick = async items => items.find(item => item.label === 'Run tests');
  assert.equal((await view.guideDelivery('REFRESH-1')).choice, 'tests');
  assert.deepEqual(commands[1], ['singularityFlow.runTests', { workId: 'REFRESH-1', phase: 'implementation', generation: 1, capability: 'web', testPhase: 'implementation' }]);
  const beforeReview = commands.length;
  pick = async items => items.find(item => item.label === 'Check acceptance criteria');
  assert.equal((await view.guideDelivery('REFRESH-1')).choice, 'review');
  assert.equal(commands.length, beforeReview, 'review opens criteria without inventing a sign-off');
  assert.match(panel.webview.html, /What would you like to validate/);
});

test('native choices refuse a different Story and a generation change while the question is open', async t => {
  const { store, view } = await fixture(t, async store => { store.current.stale = false; });
  store.current.stale = false;
  assert.equal((await view.guideDelivery('OTHER')).status, 'blocked');
  pick = async items => { store.current.snapshot.workflow.phases.implementation.generation = 2; return items[0]; };
  assert.equal((await view.guideDelivery('REFRESH-1')).status, 'blocked');
  assert.deepEqual(commands, [], 'a stale human selection never acts on a replacement delivery');
});

test('only one native question can be open at a time, including duplicate tool entries', async t => {
  const { store, view, client, reads } = await fixture(t, async store => { store.current.stale = false; });
  store.current.stale = false;
  let release, shown;
  const waiting = new Promise(resolve => { release = resolve; });
  const opened = new Promise(resolve => { shown = resolve; });
  pick = async () => { shown(); await waiting; return undefined; };
  const first = view.guideDelivery('REFRESH-1');
  await opened;
  assert.equal(OutcomeReviewPanel.show({}, store, client), view);
  assert.equal((await view.guideDelivery('REFRESH-1')).status, 'already-open');
  assert.equal(reads.length, 1, 'a duplicate invocation must not invalidate the original open question');
  release(); assert.equal((await first).status, 'cancelled');
  assert.deepEqual(commands, []);
});

test('a capability chosen in Copilot is preserved by the native read and runtime action', async t => {
  const application = { status: 'none-declared', capability: 'api' };
  const { store, view, reads } = await fixture(t, async store => { store.current.stale = false; }, application, 'api');
  store.current.stale = false;
  assert.deepEqual(reads[0], ['outcome', 'REFRESH-1', '--capability', 'api', '--json']);
  pick = async items => items.find(item => item.label === 'Set up or change local run configuration');
  const selected = await view.guideDelivery('REFRESH-1');
  assert.equal(selected.capability, 'api');
  assert.equal(commands[0][1].capability, 'api');
});

test('a test choice in a later document phase retains its active binding and uses the test-owning code phase', async t => {
  const { store, view, panel } = await fixture(t, async store => { store.current.stale = false; }, { status: 'none-declared', capability: 'web' });
  const workflow = store.current.snapshot.workflow;
  workflow.phases.implementation.status = 'approved';
  workflow.phases.verification = { status: 'in_progress', generation: 1 };
  workflow.currentPhase = 'verification';
  await panel.post({ type: 'action', action: 'refresh' });
  pick = async items => items.find(item => item.label === 'Run tests');
  assert.equal((await view.guideDelivery('REFRESH-1')).status, 'selected');
  assert.deepEqual(commands[0], ['singularityFlow.runTests', {
    workId: 'REFRESH-1', phase: 'verification', generation: 1, capability: 'web', testPhase: 'implementation'
  }]);
});

test('an older CLI retains its readable outcome and gets an explicit upgrade route without repeated questions', async t => {
  const { client, view, panel } = await fixture(t, async store => { store.current.stale = false; });
  const original = client.run.bind(client);
  client.run = async argv => { const result = await original(argv); delete result.data.outcome.validation; return result; };
  await panel.post({ type: 'action', action: 'refresh' });
  assert.match(panel.webview.html, /REFRESH-1/);
  const result = await view.guideDelivery('REFRESH-1');
  assert.equal(result.status, 'blocked');
  assert.match(result.message, /Update the CLI and VS Code integration together/);
  assert.deepEqual(commands, []);
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
