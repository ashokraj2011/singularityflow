import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { WORKFLOW_TRANSFER_BODY, WORKFLOW_TRANSFER_SCRIPT } from '../apps/vscode/src/views/workflow-transfer-page.ts';

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.disabled = false; this.textContent = ''; }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  all(tag) { return this.children.flatMap((child) => [ ...(child.tag === tag ? [child] : []), ...child.all(tag) ]); }
}
function browser() {
  const elements = Object.fromEntries(['status', 'apply', 'inventory', 'identities', 'plan', 'preview', 'cancel'].map((id) => [`transfer-${id}`, new Element('div')]));
  const posted = [], listeners = {};
  const window = { Node: Element, __sfVscode: { postMessage: (message) => posted.push(structuredClone(message)) }, addEventListener: (type, callback) => { listeners[type] = callback; } };
  new Function('window', 'document', WORKFLOW_TRANSFER_SCRIPT)(window, { createElement: (tag) => new Element(tag), getElementById: (id) => elements[id] });
  const receive = (plan, revision = posted.at(-1).revision) => listeners.message({ data: { type: 'transfer.plan', revision, plan } });
  return { elements, posted, receive };
}
const ready = (identities, extra = {}) => ({ status: 'ready', planSha256: 'a'.repeat(64), identities, ...extra });
const identity = (kind, id, extra = {}) => ({ kind, subject: `${kind}:${id}`, sourceId: id, renameable: true, occupiedIds: [], ...extra });

test('transfer page lists every agent and skill safely and requires collision-free revalidation after edits', () => {
  assert.match(WORKFLOW_TRANSFER_BODY, /aria-live="polite"/);
  const ui = browser();
  const rows = [identity('workflow', 'flow'), identity('agent', 'reviewer', { label: '<img onerror=boom>', skills: [{ id: 'checklist' }], resources: [{ type: 'skill', id: 'remote-check', url: 'https://skills.example.test/check.md' }] }), identity('skill', 'checklist', { description: 'Check the specification.' }), identity('agent', 'developer', { occupiedIds: ['existing-agent'] })];
  ui.receive(ready(rows));
  assert.equal(ui.elements['transfer-apply'].disabled, false);
  assert.deepEqual(ui.elements['transfer-inventory'].all('h2').map((el) => el.textContent), ['Agents included', 'Skills included']);
  assert.ok(ui.elements['transfer-inventory'].all('td').some((el) => el.textContent === '<img onerror=boom>'));
  assert.equal(ui.elements['transfer-inventory'].all('img').length, 0, 'source labels are never HTML');
  const inputs = ui.elements['transfer-identities'].all('input');
  inputs[3].value = 'reviewer'; inputs[3].listeners.input();
  assert.equal(ui.elements['transfer-apply'].disabled, true);
  assert.match(ui.elements['transfer-status'].textContent, /Duplicate destination: agent:reviewer/);
  inputs[3].value = 'existing-agent'; inputs[3].listeners.input();
  assert.match(ui.elements['transfer-status'].textContent, /Already exists: agent:existing-agent/);
  inputs[3].value = 'my-developer'; inputs[3].listeners.input();
  ui.elements['transfer-preview'].onclick();
  const revision = ui.posted.at(-1).revision;
  ui.receive(ready(rows), revision - 1);
  assert.equal(ui.elements['transfer-apply'].disabled, true, 'stale responses cannot enable Apply');
  ui.receive(ready(rows), revision);
  assert.equal(ui.elements['transfer-apply'].disabled, false);
  ui.elements['transfer-apply'].onclick();
  assert.deepEqual(ui.posted.at(-1), { type: 'transfer.apply', revision, planSha256: 'a'.repeat(64) });
});

test('existing IDs get independent names automatically, and immutable contract identities stay read-only', () => {
  const ui = browser();
  const rows = [identity('agent', 'reviewer', { occupiedIds: ['reviewer'], suggestedId: 'reviewer-imported' }), identity('phase', 'compiled-step', { renameable: false, reason: 'Compiled contract' }),
    identity('remote-skill', 'reviewer/check', { renameable: false, targetId: 'reviewer-imported/check', reason: 'Agent-scoped skill' })];
  ui.receive(ready(rows));
  assert.equal(ui.posted.at(-1).choices['agent:reviewer'].to, 'reviewer-imported');
  assert.equal(ui.elements['transfer-apply'].disabled, true);
  ui.receive(ready(rows, { resolutions: ui.posted.at(-1).choices }));
  assert.equal(ui.elements['transfer-apply'].disabled, false);
  assert.equal(ui.elements['transfer-identities'].all('input')[1].disabled, true);
  assert.equal(ui.elements['transfer-identities'].all('input')[2].value, 'reviewer-imported/check');
});

test('skill inventory shows both scopes, their phases and live destination names without changing bindings', () => {
  const ui = browser();
  const rows = [identity('workflow', 'flow'), identity('agent', 'reviewer', { resources: [{ type: 'skill', id: 'remote-check', phases: ['draft'], url: 'https://skills.example.test/check.md' }] }),
    identity('phase', 'draft'), identity('skill', 'checklist', { description: 'Check the specification.', attachments: [
      { scope: 'workflow', ownerId: 'flow', targetOwnerId: 'flow', phases: ['draft'], targetPhases: ['draft'], use: 'Before drafting' },
      { scope: 'agent', ownerId: 'reviewer', targetOwnerId: 'reviewer', phases: [], targetPhases: [], use: 'Before review' }
    ] })];
  ui.receive(ready(rows));
  const inventoryRows = () => ui.elements['transfer-inventory'].all('tr').map((row) => row.children.map((cell) => cell.textContent).join(' | '));
  assert.ok(inventoryRows().some((row) => /checklist.*Workflow.*flow.*draft.*Before drafting/.test(row)));
  assert.ok(inventoryRows().some((row) => /checklist.*Agent.*reviewer.*All owner phases.*Before review/.test(row)));
  assert.ok(inventoryRows().some((row) => /remote-check.*Agent.*reviewer.*draft.*reviewer\/remote-check/.test(row)));
  const inputs = ui.elements['transfer-identities'].all('input');
  for (const [index, value] of [[0, 'my-flow'], [1, 'my-reviewer'], [2, 'my-draft'], [3, 'my-checklist']]) {
    inputs[index].value = value; inputs[index].listeners.input();
  }
  assert.ok(inventoryRows().some((row) => /Workflow.*flow → my-flow.*my-draft.*my-checklist/.test(row)));
  assert.ok(inventoryRows().some((row) => /Agent.*reviewer → my-reviewer.*All owner phases.*my-checklist/.test(row)));
  assert.ok(inventoryRows().some((row) => /remote-check.*my-reviewer.*my-draft.*my-reviewer\/remote-check/.test(row)));
  assert.deepEqual(rows[3].attachments.map((entry) => entry.scope), ['workflow', 'agent']);
  assert.equal(ui.elements['transfer-apply'].disabled, true, 'changed names still require engine revalidation');
});

async function host() {
  const source = await readFile(new URL('../apps/vscode/src/views/workflow-transfer-panel.ts', import.meta.url), 'utf8');
  const compiled = stripTypeScriptTypes(source.slice(source.indexOf('export class WorkflowTransferPanel')).replace('export class', 'class'));
  let receiver, disposed, confirmation = 'Create proposal'; const posted = [];
  const panel = { webview: { postMessage: async (message) => { posted.push(message); }, onDidReceiveMessage: (callback) => { receiver = callback; } }, onDidDispose: (callback) => { disposed = callback; }, dispose: () => disposed() };
  let resolveConfirmation;
  const vscode = { ViewColumn: { Active: 1 }, window: { createWebviewPanel: () => panel, showWarningMessage: async () => typeof confirmation === 'function' ? confirmation() : confirmation } };
  const module = { exports: {} };
  new Function('module', 'exports', 'vscode', 'nonce', 'page', 'contentSecurityPolicy', 'workflowMutationPlanDetail', 'workflowMutationPlanSummary', 'showCompactWarningMessage', 'WORKFLOW_TRANSFER_BODY', 'WORKFLOW_TRANSFER_SCRIPT', compiled + '\nmodule.exports.WorkflowTransferPanel = WorkflowTransferPanel;')(module, module.exports, vscode, () => 'nonce', () => '', () => '', JSON.stringify, () => 'Exact proposal summary', vscode.window.showWarningMessage, '', '');
  return { Panel: module.exports.WorkflowTransferPanel, send: (message) => receiver(message), posted, cancel: () => panel.dispose(), reject: () => { confirmation = undefined; },
    holdConfirmation: () => { confirmation = () => new Promise((resolve) => { resolveConfirmation = resolve; }); },
    confirm: () => resolveConfirmation('Create proposal') };
}

test('host ignores old previews and rejects mismatched plans; cancellation does not mutate', async () => {
  const ui = await host(), pending = []; let writes = 0;
  const result = ui.Panel.show('Import', (choices) => new Promise((resolve) => pending.push({ choices, resolve })), async () => { writes++; return { outcome: 'written', error: null }; });
  const first = ui.send({ type: 'transfer.preview', choices: {}, revision: 1 });
  const second = ui.send({ type: 'transfer.preview', choices: { 'agent:reviewer': { action: 'rename', to: 'my-reviewer' } }, revision: 2 });
  pending[1].resolve(ready([])); await second;
  pending[0].resolve(ready([], { planSha256: 'b'.repeat(64) })); await first;
  assert.equal(ui.posted.length, 1);
  await ui.send({ type: 'transfer.apply', revision: 1, planSha256: 'a'.repeat(64) });
  await ui.send({ type: 'transfer.apply', revision: 2, planSha256: 'b'.repeat(64) });
  assert.equal(writes, 0);
  ui.reject(); await ui.send({ type: 'transfer.apply', revision: 2, planSha256: 'a'.repeat(64) });
  assert.equal(writes, 0);
  ui.cancel(); assert.equal((await result).outcome, 'cancelled');
});

test('host applies only the confirmed latest plan and its exact identity choices', async () => {
  const ui = await host(); const choices = { 'agent:reviewer': { action: 'rename', to: 'my-reviewer' } }; let applied;
  const result = ui.Panel.show('Duplicate', async () => ready([]), async (plan, selected) => { applied = { plan, selected }; return { outcome: 'written', error: null }; });
  await ui.send({ type: 'transfer.preview', choices, revision: 1 });
  await ui.send({ type: 'transfer.apply', revision: 1, planSha256: 'a'.repeat(64) });
  assert.equal((await result).outcome, 'written'); assert.deepEqual(applied.selected, choices);
});

test('closing the panel while confirmation is open cannot apply a proposal afterwards', async () => {
  const ui = await host(); let writes = 0;
  ui.holdConfirmation();
  const result = ui.Panel.show('Import', async () => ready([]), async () => { writes++; return { outcome: 'written', error: null }; });
  await ui.send({ type: 'transfer.preview', choices: {}, revision: 1 });
  const pending = ui.send({ type: 'transfer.apply', revision: 1, planSha256: 'a'.repeat(64) });
  ui.cancel();
  assert.equal((await result).outcome, 'cancelled');
  ui.confirm(); await pending;
  assert.equal(writes, 0);
});
