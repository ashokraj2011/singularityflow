import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { WORKFLOW_MARKUP_BODY, WORKFLOW_MARKUP_SCRIPT } from '../apps/vscode/src/views/workflow-markup-page.ts';
import { integerField, registerMessageRouter, stringField } from '../apps/vscode/src/views/messages.ts';
import { navigationTarget } from '../apps/vscode/src/views/webview.ts';
import { workflowIntentPrompt } from '../apps/vscode/src/views/workflow-intent-prompt.ts';

const result = { status: 'portable-ready', sourceSha256: 'source-hash', bundleSha256: 'bundle-hash',
  workflow: { id: 'demo', label: '<script>literal</script>', phases: [{ id: 'intake', label: 'Intake', agent: 'analyst' }], decisions: [] },
  sourceMap: [{ target: 'phase:intake', start: 0, end: 10, line: 1 }], meaning: 'Not approved.' };
const catalog = { resultType: 'workflow-intent-catalog', sourceSha256: 'sha256:' + 'a'.repeat(64), source: { kind: 'installed-package' },
  entries: [], counts: { skill: 3 }, patterns: [], families: [] };
class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.listeners = {}; this.value = ''; this.disabled = false; this.hidden = false; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  appendChild(child) { this.children.push(child); }
  replaceChildren() { this.children = []; }
}
function browser() {
  const elements = Object.fromEntries(['source', 'intent', 'open', 'check', 'import', 'copilot', 'result', 'status', 'title', 'phases', 'routes', 'map', 'meaning', 'catalog-source', 'kind', 'query', 'search', 'more', 'assets', 'catalog-status', 'coverage'].map(id => [`markup-${id}`, new Element()]));
  elements['markup-catalog-source'].value = 'approved';
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

async function host({ native = false } = {}) {
  const source = await readFile(new URL('../apps/vscode/src/views/workflow-markup-panel.ts', import.meta.url), 'utf8');
  const code = stripTypeScriptTypes(source.slice(source.indexOf('export class WorkflowMarkupPanel')).replace('export class', 'class'));
  const posted = [], imports = [], chats = [], calls = []; let receive, dispose, saving = async () => ({ scheme: 'file', fsPath: '/chosen/bundle.json' });
  let opening = async () => undefined;
  let toolHandler;
  let compile = async (_args, _text) => structuredClone(result);
  const panel = { webview: { postMessage: message => posted.push(message), onDidReceiveMessage: callback => { receive = callback; return { dispose() {} }; } }, onDidDispose: callback => { dispose = callback; } };
  let modelMode = 'auto', aiDisabled = false, catalogRun = async () => structuredClone(catalog);
  const vscode = { ViewColumn: { Active: 1 }, Uri: { file: fsPath => ({ fsPath }) },
    workspace: { getConfiguration: scope => ({ get: () => scope === 'singularityFlow' ? modelMode : aiDisabled }) },
    window: { createWebviewPanel: () => panel, showSaveDialog: () => saving(), showOpenDialog: () => opening() },
    commands: { executeCommand: async (...args) => chats.push(args) } };
  const client = { repository: '/selected/repository', run: async args => args.includes('intent') ? catalogRun(args) : ({ source: '<workflow />' }),
    runWithInput: async (args, text) => { calls.push({ args: [...args], text }); return compile(args, text); } };
  const intentRuntime = { workflowIntentPrompt, attachWorkflowIntentTool: handler => { toolHandler = handler; return { available: native, session: 'designer-session', dispose() {} }; } };
  const Panel = new Function('vscode', 'path', 'fs', 'constants', 'TextDecoder', 'require', '__dirname', 'nonce', 'page', 'contentSecurityPolicy', 'registerMessageRouter', 'integerField', 'stringField', 'navigationTarget', 'navigateTo', 'WORKFLOW_MARKUP_BODY', 'WORKFLOW_MARKUP_STYLE', 'WORKFLOW_MARKUP_SCRIPT', code + '\nreturn WorkflowMarkupPanel;')(
    vscode, path, fs, constants, TextDecoder, () => intentRuntime, '/extension/dist', () => 'nonce', () => '', () => '', registerMessageRouter, integerField, stringField, navigationTarget, () => {}, '', '', '');
  Panel.show(client, async file => { imports.push(file); return { outcome: 'proposed', error: null }; });
  return { posted, imports, chats, calls, client, send: message => receive(message), close: () => dispose(),
    compile: fn => { compile = fn; }, saveDialog: fn => { saving = fn; }, openDialog: fn => { opening = fn; }, readDraft: file => Panel.readDraft(file),
    catalog: fn => { catalogRun = fn; }, models: (mode, disabled = false) => { modelMode = mode; aiDisabled = disabled; }, tool: request => toolHandler(request) };
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
  const ui = await host(); await ui.send({ type: 'markup.copilot', intent: 'If tests fail, repair and retest.' });
  assert.equal(ui.chats[0][0], 'workbench.action.chat.open');
  assert.equal(ui.chats[0][1].isPartialQuery, true);
  assert.match(ui.chats[0][1].query, /Do not import, approve or activate/u);
  assert.match(ui.chats[0][1].query, /If tests fail, repair and retest/u);
  assert.match(ui.chats[0][1].query, /never ask me to supply tags/u);
  assert.match(ui.chats[0][1].query, /Load Copilot draft/u);
  assert.match(ui.chats[0][1].query, /without overwriting existing files/u);
  assert.match(ui.chats[0][1].query, /ask before substituting/u);
  assert.match(ui.chats[0][1].query, /not the full XML or source code/u);
  assert.deepEqual(ui.calls, []);
  ui.compile(async () => { throw new Error('Unknown condition at line 7'); }); await check(ui); await apply(ui);
  assert.deepEqual(ui.imports, []);
});

test('description-first UI hides advanced syntax and sends intent, not the example, to Copilot', () => {
  assert.match(WORKFLOW_MARKUP_BODY, /<details id="markup-advanced"><summary>Advanced/u);
  assert.doesNotMatch(WORKFLOW_MARKUP_BODY, /<details id="markup-advanced" open/u);
  const ui = browser();
  assert.equal(ui.elements['markup-copilot'].disabled, true);
  assert.equal(ui.elements['markup-check'].disabled, true);
  ui.receive({ type: 'markup.example', source: '<workflow>not my requested workflow</workflow>' });
  const intent = ui.elements['markup-intent']; intent.value = 'Intake, test, repair and retest three times, then human closure.'; intent.listeners.input();
  assert.equal(ui.elements['markup-copilot'].disabled, false);
  ui.elements['markup-copilot'].onclick();
  assert.equal(ui.posted.at(-1).intent, intent.value);
  assert.equal(ui.posted.at(-1).source, undefined);
});

test('loading a Copilot draft invalidates old bindings and automatically checks exact loaded bytes', () => {
  const ui = browser();
  ui.elements['markup-open'].onclick();
  assert.deepEqual(ui.posted.at(-1), { type: 'markup.open', revision: 0 });
  const source = '\uFEFF<workflow>generated\r\n</workflow>';
  ui.receive({ type: 'markup.loaded', revision: 0, source });
  assert.deepEqual(ui.posted.slice(-2), [{ type: 'markup.changed', revision: 1 }, { type: 'markup.check', revision: 1, source, intent: '', catalogSource: 'approved' }]);
  ui.receive({ type: 'markup.checked', revision: 1, result });
  assert.equal(ui.elements['markup-import'].disabled, false);
  ui.elements['markup-intent'].value = 'changed requirements'; ui.elements['markup-intent'].listeners.input();
  assert.equal(ui.elements['markup-import'].disabled, true);
  ui.receive({ type: 'markup.loaded', revision: 1, source: 'stale replacement' });
  assert.equal(ui.elements['markup-source'].value, source);
});

test('Copilot draft loading only reads the explicitly selected bounded regular UTF-8 file', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sflow-markup-load-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'copilot.workflow.xml'), source = '\uFEFF<workflow>\r\n</workflow>';
  await fs.writeFile(file, source);
  const ui = await host();
  ui.openDialog(async () => [{ scheme: 'file', fsPath: file }]);
  await ui.send({ type: 'markup.open', revision: 0, path: '/attacker/ignored.xml' });
  assert.deepEqual(ui.posted.at(-1), { type: 'markup.loaded', revision: 0, source });
  assert.deepEqual(ui.calls, []); assert.deepEqual(ui.imports, []);
  const invalid = path.join(directory, 'invalid.xml');
  await fs.writeFile(invalid, Buffer.from([0xff]));
  await assert.rejects(ui.readDraft(invalid));
  const big = path.join(directory, 'large.xml'); await fs.writeFile(big, 'x'.repeat(256 * 1024 + 1));
  await assert.rejects(ui.readDraft(big), /256 KiB/u);
  await assert.rejects(ui.readDraft(directory), /regular XML/u);
  const empty = path.join(directory, 'empty.xml'); await fs.writeFile(empty, '  ');
  await assert.rejects(ui.readDraft(empty), /empty/u);
  const link = path.join(directory, 'link.xml');
  try { await fs.symlink(file, link); }
  catch (error) { if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error; t.diagnostic('Host disallows creating symlinks; other file checks executed.'); return; }
  await assert.rejects(ui.readDraft(link), /regular XML/u);
});

test('cancelled, nonlocal, stale or closed load cannot replace the current draft', async () => {
  const ui = await host(); await check(ui);
  await ui.send({ type: 'markup.open', revision: 0 });
  assert.match(ui.posted.at(-1).message, /cancelled/u);
  ui.openDialog(async () => [{ scheme: 'https', fsPath: '/remote.xml' }]);
  await ui.send({ type: 'markup.open', revision: 0 });
  assert.match(ui.posted.at(-1).message, /local XML/u);
  let select;
  ui.openDialog(() => new Promise(resolve => { select = resolve; }));
  const pending = ui.send({ type: 'markup.open', revision: 0 });
  await ui.send({ type: 'markup.changed', revision: 1 });
  select([{ scheme: 'file', fsPath: '/must/not/be/read.xml' }]); await pending;
  assert.match(ui.posted.at(-1).message, /changed/u);
  assert.equal(ui.posted.some(message => message.type === 'markup.loaded'), false);
  const closing = await host(); closing.openDialog(() => new Promise(resolve => { select = resolve; }));
  const loading = closing.send({ type: 'markup.open', revision: 0 }); closing.close();
  select([{ scheme: 'file', fsPath: '/must/not/be/read.xml' }]); await loading;
  assert.equal(closing.posted.some(message => message.type === 'markup.loaded'), false);
});

test('empty or oversized description never opens a Copilot request', async () => {
  const ui = await host();
  await ui.send({ type: 'markup.copilot', intent: '  ' });
  await ui.send({ type: 'markup.copilot', intent: 'x'.repeat(32769) });
  assert.deepEqual(ui.chats, []);
});

test('Copilot uses exact catalog discovery and retrieval; model-off and stale intent never open chat', async () => {
  const ui = await host(); await ui.send({ type: 'markup.copilot', intent: 'Use our Angular test skill', catalogSource: 'installed' });
  assert.match(ui.chats[0][1].query, /workflow intent show/u);
  assert.match(ui.chats[0][1].query, new RegExp(catalog.sourceSha256));
  assert.match(ui.chats[0][1].query, /Never attach a command-skill/u);
  assert.match(ui.chats[0][1].query, /do not serialize or omit/iu);
  ui.models('disabled'); await ui.send({ type: 'markup.copilot', intent: 'Do not send this' }); assert.equal(ui.chats.length, 1);
  ui.models('auto', true); await ui.send({ type: 'markup.copilot', intent: 'Still disabled' }); assert.equal(ui.chats.length, 1);
  const stale = await host(); let finish;
  stale.catalog(() => new Promise(resolve => { finish = resolve; }));
  const opening = stale.send({ type: 'markup.copilot', intent: 'Old intent', revision: 0 });
  await stale.send({ type: 'markup.changed', revision: 1 }); finish(catalog); await opening;
  assert.deepEqual(stale.chats, []);
});

test('a described draft must preserve exact intent and catalog source before import is offered', async () => {
  const ui = await host();
  await ui.send({ type: 'markup.check', revision: 0, source: '<workflow/>', intent: 'Keep my checkpoints' });
  assert.match(ui.posted.at(-1).message, /exact current intent/u);
  ui.compile(async () => ({ ...result, intent: { text: 'Keep my checkpoints' }, catalog: { source: { kind: 'installed-package' }, sourceSha256: catalog.sourceSha256 } }));
  await ui.send({ type: 'markup.check', revision: 0, source: '<workflow/>', intent: 'Keep my checkpoints', catalogSource: 'approved' });
  assert.match(ui.posted.at(-1).message, /different catalog source/u);
  await ui.send({ type: 'markup.check', revision: 0, source: '<workflow/>', intent: 'Keep my checkpoints', catalogSource: 'installed' });
  assert.equal(ui.posted.at(-1).type, 'markup.checked');
});

test('catalog UI renders inert names/tags, inserts typed references and ignores obsolete search responses', () => {
  const ui = browser(); ui.elements['markup-kind'].value = 'skill'; ui.elements['markup-query'].value = 'angular';
  ui.elements['markup-search'].onclick(); const first = ui.posted.at(-1);
  ui.elements['markup-query'].value = 'spring'; ui.elements['markup-query'].listeners.input(); ui.elements['markup-search'].onclick();
  const second = ui.posted.at(-1);
  const data = { ...catalog, total: 1, nextCursor: null, entries: [{ kind: 'skill', id: 'spring-test', description: '<script>inert</script>', tags: ['framework:spring'], available: true }] };
  ui.receive({ type: 'markup.catalogResult', request: first.request, catalogSource: 'approved', result: data });
  assert.equal(ui.elements['markup-assets'].children.length, 0);
  ui.receive({ type: 'markup.catalogResult', request: second.request, catalogSource: 'approved', result: data });
  assert.match(ui.elements['markup-assets'].children[0].textContent, /<script>inert<\/script>/u);
  ui.elements['markup-assets'].children[0].children[0].onclick();
  assert.match(ui.elements['markup-intent'].value, /\[skill:spring-test\]/u);
});

test('native Copilot submits a checked draft directly to the designer without a file or lifecycle mutation', async () => {
  const ui = await host({ native: true });
  await ui.send({ type: 'markup.copilot', intent: 'Preserve my intent', catalogSource: 'installed', revision: 0 });
  assert.match(ui.chats[0][1].query, /#sflowWorkflowAuthoring/u);
  assert.match(ui.chats[0][1].query, /Do not write candidate files/u);
  ui.compile(async () => ({ ...result, intent: { text: 'Preserve my intent', requirements: [{}] }, catalog: { ...catalog } }));
  const ready = await ui.tool({ action: 'draft', revision: 0, source: '<workflow>checked</workflow>' });
  assert.equal(ready.status, 'portable-ready'); assert.equal(ready.repositoryFilesChanged, false);
  assert.equal(ui.posted.find(message => message.type === 'markup.proposed').source, '<workflow>checked</workflow>');
  assert.deepEqual(ui.imports, []); assert.ok(ui.calls.every(call => !call.args.includes('--out')));
  await assert.rejects(ui.tool({ action: 'draft', revision: 0, source: '<workflow>again</workflow>' }), /fresh handoff/u);
  await apply(ui); assert.deepEqual(ui.imports, ['/chosen/bundle.json']);
});

test('native draft checks bound corrections, stop unchanged failures and discard edits while checking', async () => {
  const ui = await host({ native: true });
  await ui.send({ type: 'markup.copilot', intent: 'Preserve my intent', catalogSource: 'installed', revision: 0 });
  ui.compile(async () => { throw new Error('Invalid candidate'); });
  await assert.rejects(ui.tool({ action: 'draft', revision: 0, source: '<one/>' }), /Invalid candidate/u);
  assert.ok(ui.posted.some(message => message.type === 'markup.error' && message.message === 'Invalid candidate' && message.revision === 0));
  const attempts = ui.calls.length;
  await assert.rejects(ui.tool({ action: 'draft', revision: 0, source: '<one/>' }), /unchanged failure/u); assert.equal(ui.calls.length, attempts);
  await assert.rejects(ui.tool({ action: 'draft', revision: 0, source: '<two/>' }));
  await assert.rejects(ui.tool({ action: 'draft', revision: 0, source: '<three/>' }));
  await assert.rejects(ui.tool({ action: 'draft', revision: 0, source: '<four/>' }), /bounded draft check/u);
  const stale = await host({ native: true }); let finish;
  await stale.send({ type: 'markup.copilot', intent: 'Original', catalogSource: 'installed', revision: 0 });
  stale.compile(() => new Promise(resolve => { finish = resolve; }));
  const pending = stale.tool({ action: 'draft', revision: 0, source: '<candidate/>' });
  await stale.send({ type: 'markup.changed', revision: 1 });
  finish({ ...result, intent: { text: 'Original', requirements: [] }, catalog: { ...catalog } });
  await assert.rejects(pending, /changed/u);
  assert.equal(stale.posted.some(message => message.type === 'markup.proposed'), false);
  assert.equal(stale.posted.some(message => message.type === 'markup.error'), false, 'a late failure must not replace the edited draft status');
});

test('direct proposals preview exact checked bytes without another compilation and never overwrite an edited draft', () => {
  const ui = browser();
  ui.receive({ type: 'markup.proposed', revision: 0, source: '<direct/>', result });
  assert.equal(ui.elements['markup-source'].value, '<direct/>'); assert.equal(ui.elements['markup-import'].disabled, false);
  assert.equal(ui.posted.some(message => message.type === 'markup.check'), false);
  ui.elements['markup-intent'].value = 'Changed while the model worked'; ui.elements['markup-intent'].listeners.input();
  ui.receive({ type: 'markup.proposed', revision: 0, source: '<late/>', result });
  assert.equal(ui.elements['markup-source'].value, '<direct/>'); assert.equal(ui.elements['markup-import'].disabled, true);
});
