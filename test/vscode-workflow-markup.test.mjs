import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { WORKFLOW_MARKUP_BODY, WORKFLOW_MARKUP_SCRIPT } from '../apps/vscode/src/views/workflow-markup-page.ts';
import { integerField, registerMessageRouter, stringField } from '../apps/vscode/src/views/messages.ts';
import { navigationTarget } from '../apps/vscode/src/views/webview.ts';

const result = { status: 'portable-ready', sourceSha256: 'source-hash', bundleSha256: 'bundle-hash',
  workflow: { id: 'demo', label: '<script>literal</script>', phases: [{ id: 'intake', label: 'Intake', agent: 'analyst' }], decisions: [] },
  sourceMap: [{ target: 'phase:intake', start: 0, end: 10, line: 1 }], meaning: 'Not approved.' };
class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.listeners = {}; this.value = ''; this.disabled = false; this.hidden = false; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  appendChild(child) { this.children.push(child); }
  replaceChildren() { this.children = []; }
}
function browser() {
  const elements = Object.fromEntries(['source', 'check', 'import', 'copilot', 'result', 'status', 'title', 'phases', 'routes', 'map', 'meaning'].map(id => [`markup-${id}`, new Element()]));
  const posted = []; let receive;
  const window = { __sfVscode: { postMessage: message => posted.push(structuredClone(message)), getState: () => null, setState() {} }, addEventListener: (_name, callback) => { receive = callback; } };
  new Function('window', 'document', WORKFLOW_MARKUP_SCRIPT)(window, { getElementById: id => elements[id], createElement: tag => new Element(tag) });
  return { elements, posted, receive: message => receive({ data: message }) };
}

test('tag editor preserves source, rejects stale checks, and renders markup as inert text', () => {
  assert.match(WORKFLOW_MARKUP_BODY, /aria-live="polite"/);
  const ui = browser(); assert.deepEqual(ui.posted, [{ type: 'markup.ready' }]);
  ui.receive({ type: 'markup.example', source: '<workflow>example</workflow>' });
  const source = ui.elements['markup-source']; source.value = '<script>literal input</script>'; source.listeners.input();
  ui.elements['markup-check'].onclick();
  assert.equal(ui.posted.at(-1).source, source.value);
  const checkedRevision = ui.posted.at(-1).revision;
  source.value += ' changed'; source.listeners.input();
  ui.receive({ type: 'markup.checked', revision: checkedRevision, result });
  assert.equal(ui.elements['markup-import'].disabled, true);
  ui.elements['markup-check'].onclick();
  ui.receive({ type: 'markup.checked', revision: ui.posted.at(-1).revision, result });
  assert.equal(ui.elements['markup-import'].disabled, false);
  assert.equal(ui.elements['markup-title'].textContent, result.workflow.label);
  assert.equal(source.value, '<script>literal input</script> changed');
  ui.receive({ type: 'markup.example', source: 'must not replace edited text' });
  assert.equal(source.value, '<script>literal input</script> changed');
  ui.elements['markup-import'].onclick();
  assert.equal(ui.posted.at(-1).bundleSha256, result.bundleSha256);
  assert.equal(Object.hasOwn(ui.posted.at(-1), 'path'), false, 'webview never selects a host output path');
});

async function host() {
  const source = await readFile(new URL('../apps/vscode/src/views/workflow-markup-panel.ts', import.meta.url), 'utf8');
  const code = stripTypeScriptTypes(source.slice(source.indexOf('export class WorkflowMarkupPanel')).replace('export class', 'class'));
  const posted = [], imports = [], chats = [], calls = []; let receive, dispose, saving = async () => ({ scheme: 'file', fsPath: '/chosen/bundle.json' });
  let compile = async (_args, _text) => structuredClone(result);
  const panel = { webview: { postMessage: message => posted.push(message), onDidReceiveMessage: callback => { receive = callback; return { dispose() {} }; } }, onDidDispose: callback => { dispose = callback; } };
  const vscode = { ViewColumn: { Active: 1 }, Uri: { file: fsPath => ({ fsPath }) },
    window: { createWebviewPanel: () => panel, showSaveDialog: () => saving() },
    commands: { executeCommand: async (...args) => chats.push(args) } };
  const client = { repository: '/selected/repository', run: async () => ({ source: '<workflow />' }),
    runWithInput: async (args, text) => { calls.push({ args: [...args], text }); return compile(args, text); } };
  const Panel = new Function('vscode', 'path', 'nonce', 'page', 'contentSecurityPolicy', 'registerMessageRouter', 'integerField', 'stringField', 'navigationTarget', 'navigateTo', 'WORKFLOW_MARKUP_BODY', 'WORKFLOW_MARKUP_STYLE', 'WORKFLOW_MARKUP_SCRIPT', code + '\nreturn WorkflowMarkupPanel;')(
    vscode, path, () => 'nonce', () => '', () => '', registerMessageRouter, integerField, stringField, navigationTarget, () => {}, '', '', '');
  Panel.show(client, async file => { imports.push(file); return { outcome: 'proposed', error: null }; });
  return { posted, imports, chats, calls, client, send: message => receive(message), close: () => dispose(),
    compile: fn => { compile = fn; }, saveDialog: fn => { saving = fn; } };
}
const check = (ui, source = '<workflow />', revision = 0) => ui.send({ type: 'markup.check', source, revision });
const apply = (ui, revision = 0, overrides = {}) => ui.send({ type: 'markup.import', revision, sourceSha256: result.sourceSha256, bundleSha256: result.bundleSha256, ...overrides });

test('host only writes the checked source to the human-selected path, then uses existing import', async () => {
  const ui = await host(); await check(ui, '<workflow>exact</workflow>');
  await apply(ui, 0, { path: '/attacker/ignored.json' });
  assert.deepEqual(ui.calls.map(call => call.text), ['<workflow>exact</workflow>', '<workflow>exact</workflow>']);
  assert.deepEqual(ui.calls[1].args, ['workflow', 'markup', 'compile', '-', '--out', '/chosen/bundle.json', '--json']);
  assert.deepEqual(ui.imports, ['/chosen/bundle.json']);
  assert.equal(ui.posted.find(message => message.type === 'markup.checked').result.bundle, undefined);
  assert.equal(ui.calls.some(call => call.args.includes('activate') || call.args.includes('approve')), false);
});

test('stale/mismatched confirmation, changed source and changed repository cannot import', async () => {
  const ui = await host(); await check(ui);
  await apply(ui, 0, { bundleSha256: 'wrong' }); assert.equal(ui.calls.length, 1);
  await ui.send({ type: 'markup.changed', revision: 1 }); await apply(ui, 0); assert.equal(ui.calls.length, 1);
  await check(ui, '<workflow>new</workflow>', 1);
  ui.client.repository = '/different/repository'; await apply(ui, 1); assert.equal(ui.calls.length, 2);
  assert.deepEqual(ui.imports, []);
});

test('typing while compilation or a save dialog is pending cannot accept or import stale results', async () => {
  const ui = await host(); let finish;
  ui.compile(() => new Promise(resolve => { finish = resolve; }));
  const pending = check(ui); await ui.send({ type: 'markup.changed', revision: 1 }); finish(result); await pending;
  assert.equal(ui.posted.some(message => message.type === 'markup.checked'), false);
  ui.compile(async () => result); await check(ui, '<workflow>new</workflow>', 1);
  let save;
  ui.saveDialog(() => new Promise(resolve => { save = resolve; }));
  const importing = apply(ui, 1); await ui.send({ type: 'markup.changed', revision: 2 }); save({ scheme: 'file', fsPath: '/chosen/bundle.json' }); await importing;
  assert.equal(ui.calls.length, 2); assert.deepEqual(ui.imports, []);
});

test('closing during save or package drift preserves the bundle boundary and refuses import', async () => {
  const ui = await host(); await check(ui);
  ui.compile(async () => ({ ...result, bundleSha256: 'changed-build' })); await apply(ui);
  assert.deepEqual(ui.imports, []);
  assert.match(ui.posted.at(-1).message, /package changed/u);
  const closing = await host(); await check(closing); let save;
  closing.saveDialog(() => new Promise(resolve => { save = resolve; }));
  const pending = apply(closing); closing.close(); save({ scheme: 'file', fsPath: '/chosen/file.json' }); await pending;
  assert.equal(closing.calls.length, 1); assert.deepEqual(closing.imports, []);
});

test('Copilot action only prefills a reviewable description request and compilation failures do not import', async () => {
  const ui = await host(); await ui.send({ type: 'markup.copilot', source: 'If tests fail, repair and retest.' });
  assert.equal(ui.chats[0][0], 'workbench.action.chat.open');
  assert.equal(ui.chats[0][1].isPartialQuery, true);
  assert.match(ui.chats[0][1].query, /Do not import, approve or activate/u);
  assert.deepEqual(ui.calls, []);
  ui.compile(async () => { throw new Error('Unknown condition at line 7'); }); await check(ui); await apply(ui);
  assert.deepEqual(ui.imports, []);
});
