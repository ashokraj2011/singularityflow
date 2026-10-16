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
import { WorkflowAttachmentStore } from '../apps/vscode/src/views/workflow-attachment-store.ts';
import { withWorkflowIntentCatalog, queryWorkflowIntentCatalog } from '../src/workflow-intent-catalog.mjs';
import { compileWorkflowMarkup } from '../src/workflow-markup.mjs';
import { workflowMarkupCandidate } from './helpers/workflow-markup-candidate.mjs';

const result = { status: 'portable-ready', sourceSha256: 'source-hash', bundleSha256: 'bundle-hash',
  workflow: { id: 'demo', label: '<script>literal</script>', phases: [{ id: 'intake', label: 'Intake', agent: 'analyst' }], decisions: [] },
  sourceMap: [{ target: 'phase:intake', start: 0, end: 10, line: 1 }], meaning: 'Not approved.' };
const catalog = { resultType: 'workflow-intent-catalog', sourceSha256: 'sha256:' + 'a'.repeat(64), source: { kind: 'installed-package' },
  entries: [], counts: { skill: 3 }, patterns: [], families: [] };
class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.listeners = {}; this.attrs = {}; this.style = {}; this.value = ''; this.disabled = false; this.hidden = false; this.selectionStart = 0; this.selectionEnd = 0; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  appendChild(child) { this.children.push(child); }
  replaceChildren() { this.children = []; }
  setAttribute(key, value) { this.attrs[key] = value; }
  getAttribute(key) { return this.attrs[key]; }
  removeAttribute(key) { delete this.attrs[key]; }
  focus() {}
  setRangeText(text, start, end) { this.value = this.value.slice(0, start) + text + this.value.slice(end); }
}
function browser(initialState = null) {
  const elements = Object.fromEntries([...WORKFLOW_MARKUP_BODY.matchAll(/id="([^"]+)"/gu)].map(match => [match[1], new Element()]));
  elements['markup-catalog-source'].value = 'approved';
  const posted = []; let receive, retained = initialState;
  const window = { __sfVscode: { postMessage: message => posted.push(structuredClone(message)), getState: () => retained, setState: value => { retained = structuredClone(value); } }, addEventListener: (_name, callback) => { receive = callback; } };
  new Function('window', 'document', WORKFLOW_MARKUP_SCRIPT)(window, { getElementById: id => elements[id], createElement: tag => new Element(tag), createTextNode: text => ({ textContent: text }), querySelectorAll: () => [] });
  return { elements, posted, receive: message => receive({ data: message }), state: () => retained };
}

test('sequential results without decisions render safely, and a screened failed candidate survives reload without authorizing import', () => {
  const ui = browser(), sequential = structuredClone(result);
  delete sequential.workflow.decisions;
  assert.doesNotThrow(() => ui.receive({ type: 'markup.proposed', revision: 0, source: '<previous/>', result: sequential }));
  assert.equal(ui.elements['markup-import'].disabled, false);
  ui.receive({ type: 'markup.nativeBusy' });
  ui.receive({ type: 'markup.nativeIdle' });
  assert.equal(ui.elements['markup-import'].disabled, true, 'A new failed check cannot reuse the previous successful check.');
  ui.receive({ type: 'markup.draftFailed', revision: 0, source: '<workflow>retained &amp; inert</workflow>', message: 'Internal compiler failure' });
  assert.equal(ui.elements['markup-source'].value, '<workflow>retained &amp; inert</workflow>');
  assert.equal(ui.elements['markup-import'].disabled, true);
  assert.equal(ui.elements['markup-result'].hidden, true);
  assert.match(ui.elements['markup-status'].textContent, /unchecked candidate.*retained/iu);
  const resumed = browser(ui.state());
  assert.equal(resumed.elements['markup-source'].value, '<workflow>retained &amp; inert</workflow>');
  assert.equal(resumed.elements['markup-check'].disabled, false);
  assert.equal(resumed.elements['markup-import'].disabled, true);
  resumed.elements['markup-intent'].value = 'New intent'; resumed.elements['markup-intent'].listeners.input();
  resumed.receive({ type: 'markup.draftFailed', revision: 0, source: '<obsolete/>', message: 'Late failure' });
  assert.notEqual(resumed.elements['markup-source'].value, '<obsolete/>');
});

test('tag editor preserves source, rejects stale checks, and renders markup as inert text', () => {
  assert.match(WORKFLOW_MARKUP_BODY, /aria-live="polite"/);
  const ui = browser(); assert.equal(ui.posted[0].type, 'markup.ready');
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

test('description preview formats lists and checklists without executing imported markup', () => {
  const ui = browser();
  ui.elements['markup-intent'].value = '## Review\n\n- **Independent** tests\n- [x] Evidence retained\n\n1. Human approval\n\n<img src=x onerror=alert(1)>';
  ui.elements['markup-preview-toggle'].onclick();
  const nodes = ui.elements['markup-intent-preview'].children;
  assert.deepEqual(nodes.map(node => node.tag), ['h3', 'ul', 'ol', 'p']);
  assert.equal(nodes[1].children[0].children[1].tag, 'strong');
  assert.equal(nodes[1].children[1].children[0].textContent, '☑ Evidence retained');
  assert.equal(nodes[3].children[0].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(ui.elements['markup-intent'].hidden, true);
  ui.elements['markup-write'].onclick();
  assert.equal(ui.elements['markup-intent'].hidden, false);
});

async function host({ native = false } = {}) {
  const source = await readFile(new URL('../apps/vscode/src/views/workflow-markup-panel.ts', import.meta.url), 'utf8');
  const code = stripTypeScriptTypes(source.slice(source.indexOf('export class WorkflowMarkupPanel')).replace('export class', 'class'));
  const posted = [], imports = [], chats = [], calls = []; let receive, dispose, saving = async () => ({ scheme: 'file', fsPath: '/chosen/bundle.json' });
  let opening = async () => undefined;
  let choosingGroup = async choices => choices[0];
  let toolHandler;
  let compile = async (_args, _text) => structuredClone(result);
  const panel = { webview: { postMessage: message => posted.push(message), onDidReceiveMessage: callback => { receive = callback; return { dispose() {} }; } }, onDidDispose: callback => { dispose = callback; } };
  let modelMode = 'auto', aiDisabled = false, catalogRun = async () => structuredClone(catalog), captureRun;
  const vscode = { ViewColumn: { Active: 1 }, Uri: { file: fsPath => ({ fsPath }) },
    workspace: { getConfiguration: scope => ({ get: () => scope === 'singularityFlow' ? modelMode : aiDisabled }) },
    window: { createWebviewPanel: () => panel, showSaveDialog: () => saving(), showOpenDialog: () => opening(), showQuickPick: choices => choosingGroup(choices) },
    commands: { executeCommand: async (...args) => chats.push(args) } };
  let groups = [{ id: 'quality-reviewers', label: 'Quality reviewers' }];
  let capabilities = { protocol: 1, engine: { sha256: 'sha256:' + 'd'.repeat(64) }, grammarVersions: [2], cli: { compile: true, catalog: true, asset: true, attachments: true, documentation: true } };
  const client = { repository: '/selected/repository', location: { executable: '/installed/node', cli: '/installed/sflow.mjs' },
    run: async args => {
      if (args.includes('attachments')) return captureRun(args);
      if (args.includes('preflight')) {
        const selected = await catalogRun(args);
        return { resultType: 'workflow-intent-preflight', sourceSha256: selected.sourceSha256, catalog: selected, capabilities,
          approvalAuthorities: structuredClone(groups) };
      }
      return args.includes('intent') ? catalogRun(args) : { source: '<workflow />' };
    },
    runWithInput: async (args, text) => { calls.push({ args: [...args], text }); return compile(args, text); } };
  const intentRuntime = { workflowIntentPrompt, attachWorkflowIntentTool: handler => { toolHandler = handler; return { available: native, session: 'designer-session', dispose() {} }; } };
  const Panel = new Function('vscode', 'path', 'fs', 'constants', 'TextDecoder', 'require', '__dirname', 'nonce', 'page', 'contentSecurityPolicy', 'registerMessageRouter', 'integerField', 'stringField', 'navigationTarget', 'navigateTo', 'brandMark', code + '\nreturn WorkflowMarkupPanel;')(
    vscode, path, fs, constants, TextDecoder, file => file.endsWith('workflow-intent-runtime.cjs') ? intentRuntime : { WorkflowAttachmentStore, WORKFLOW_MARKUP_BODY, WORKFLOW_MARKUP_SCRIPT, WORKFLOW_MARKUP_STYLE: '' }, '/extension/dist', () => 'nonce', () => '', () => '', registerMessageRouter, integerField, stringField, navigationTarget, () => {}, () => '');
  Panel.show(client, async file => { imports.push(file); return { outcome: 'proposed', error: null }; });
  return { posted, imports, chats, calls, client, send: message => receive(message), close: () => dispose(),
    compile: fn => { compile = fn; }, saveDialog: fn => { saving = fn; }, openDialog: fn => { opening = fn; }, readDraft: file => Panel.readDraft(file),
    catalog: fn => { catalogRun = fn; }, capture: fn => { captureRun = fn; }, models: (mode, disabled = false) => { modelMode = mode; aiDisabled = disabled; }, tool: request => toolHandler(request),
    capabilities: value => { capabilities = value; }, group: fn => { choosingGroup = fn; }, groups: value => { groups = value; } };
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

test('incompatible designer capabilities and unresolved group choices stop before opening chat', async () => {
  const ui = await host();
  ui.capabilities({ protocol: 0 });
  await ui.send({ type: 'markup.copilot', intent: 'Keep human checkpoints', revision: 0 });
  assert.equal(ui.chats.length, 0); assert.match(ui.posted.at(-1).message, /align.*CLI.*extension.*plugin/u);
  const unresolved = await host(); unresolved.group(async choices => choices.at(-1));
  await unresolved.send({ type: 'markup.copilot', intent: 'Keep human checkpoints', revision: 0 });
  assert.equal(unresolved.chats.length, 0); assert.match(unresolved.posted.at(-1).message, /Draft retained.*unresolved/u);
});

test('native registration does not suppress attachment fallback or bind chat to another CLI from PATH', async () => {
  const ui = await host({ native: true }); ui.capture(async () => structuredClone(localCapture));
  ui.openDialog(async () => [{ scheme: 'file', fsPath: '/chosen/INSTRUCTIONS.md' }]);
  await ui.send({ type: 'markup.attach', mode: 'files', revision: 0 });
  await ui.send({ type: 'markup.copilot', intent: 'Use our instructions', catalogSource: 'installed', revision: 1 });
  assert.equal(ui.chats.length, 1);
  const prompt = ui.chats[0][1].query;
  assert.match(prompt, /\/installed\/sflow\.mjs/u);
  assert.match(prompt, /Attachment read groups[\s\S]*expected-source/u);
  assert.match(prompt, /quality-reviewers/u);
  assert.match(prompt, /availability here is unknown/u);
});

test('a repository without checkpoint groups opens chat without a dead-end picker', async () => {
  const ui = await host(); ui.groups([]);
  ui.group(async () => { throw new Error('no picker when there is nothing to choose'); });
  await ui.send({ type: 'markup.copilot', intent: 'A workflow with no human checkpoints', revision: 0 });
  assert.equal(ui.chats.length, 1, ui.posted.at(-1)?.message);
  assert.match(ui.chats[0][1].query, /Designer-selected checkpoint group: null/u);
});

test('the chat request names a launcher that runs the installation CLI outside the editor', async () => {
  const ui = await host();
  ui.client.location = { executable: "/Applications/Code Helper (Plugin)/it's", cli: '/installed/sflow.mjs' };
  await ui.send({ type: 'markup.copilot', intent: 'Keep human checkpoints', revision: 0 });
  const prompt = ui.chats[0][1].query;
  const launcher = process.platform === 'win32'
    ? "$env:ELECTRON_RUN_AS_NODE='1'; & '/Applications/Code Helper (Plugin)/it''s' '/installed/sflow.mjs'"
    : "ELECTRON_RUN_AS_NODE=1 '/Applications/Code Helper (Plugin)/it'\\''s' '/installed/sflow.mjs'";
  assert.ok(prompt.includes(JSON.stringify(launcher).slice(1, -1)), prompt);
});

test('missing, stale or withheld attachment retrieval blocks generation while retaining the selected files', async () => {
  for (const kind of ['missing', 'stale', 'withheld']) {
    const ui = await host({ native: true });
    const captured = structuredClone(localCapture);
    if (kind === 'missing') captured.readGuidance = null;
    if (kind === 'stale') captured.readGuidance.argv[captured.readGuidance.argv.indexOf('--expected-source') + 1] = 'sha256:' + '0'.repeat(64);
    if (kind === 'withheld') { captured.items[0].available = false; captured.items[0].sha256 = null; }
    ui.capture(async () => captured);
    ui.openDialog(async () => [{ scheme: 'file', fsPath: '/chosen/INSTRUCTIONS.md' }]);
    await ui.send({ type: 'markup.attach', revision: 0, mode: 'files' });
    await ui.send({ type: 'markup.copilot', intent: 'Use the selected guidance.', revision: 1 });
    assert.equal(ui.chats.length, 0, kind);
    assert.match(ui.posted.at(-1).message, /attach|withheld|unreadable/iu);
    assert.deepEqual(ui.imports, []);
  }
});

test('replacing and removing attachment captures releases their obsolete private read groups', async () => {
  const store = new WorkflowAttachmentStore();
  for (let index = 0; index < 20; index++) {
    const captured = structuredClone(localCapture);
    captured.sourceSha256 = 'sha256:' + index.toString(16).padStart(64, '0');
    await store.capture({ run: async () => captured }, ['/chosen/INSTRUCTIONS.md'], false);
    assert.equal(store.reads.size, 1);
  }
  store.remove(localCapture.items[0].id);
  assert.equal(store.reads.size, 0);
});

test('catalog cancellation and replacement reach the supervised CLI, not just late response suppression', async () => {
  const ui = await host(); const signals = []; let complete;
  ui.client.run = async (_args, signal) => { signals.push(signal); return new Promise(resolve => { complete = resolve; }); };
  const pending = ui.send({ type: 'markup.catalog', catalogSource: 'installed', request: 1 });
  await Promise.resolve();
  await ui.send({ type: 'markup.cancelCatalog' });
  assert.equal(signals[0].aborted, true);
  complete(structuredClone(catalog)); await pending;
  assert.equal(ui.posted.some(message => message.type === 'markup.catalogResult'), false);
});

test('description-first UI hides advanced syntax and sends intent, not the example, to Copilot', () => {
  assert.match(WORKFLOW_MARKUP_BODY, /<details id="markup-advanced"[^>]*><summary>Advanced/u);
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
  assert.deepEqual(ui.posted.slice(-2), [{ type: 'markup.changed', revision: 1 }, { type: 'markup.check', revision: 1, source, intent: '', catalogSource: 'approved', selectedAssets: [] }]);
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

test('catalog cards render inert names/tags, attach typed references without editing intent and ignore obsolete responses', () => {
  const ui = browser(); ui.elements['markup-kind'].value = 'skill'; ui.elements['markup-query'].value = 'angular';
  ui.elements['markup-search'].onclick(); const first = ui.posted.at(-1);
  ui.elements['markup-query'].value = 'spring'; ui.elements['markup-query'].listeners.input(); ui.elements['markup-search'].onclick();
  const second = ui.posted.at(-1);
  const data = { ...catalog, total: 1, nextCursor: null, entries: [{ kind: 'skill', id: 'spring-test', description: '<script>inert</script>', tags: ['framework:spring'], available: true }] };
  ui.receive({ type: 'markup.catalogResult', request: first.request, catalogSource: 'approved', result: data });
  assert.equal(ui.elements['markup-assets'].children.length, 0);
  ui.receive({ type: 'markup.catalogResult', request: second.request, catalogSource: 'approved', result: data });
  assert.equal(ui.elements['markup-assets'].children[0].children[2].textContent, '<script>inert</script>');
  ui.elements['markup-assets'].children[0].children[0].children[1].onclick();
  assert.equal(ui.elements['markup-intent'].value, '');
  assert.equal(ui.elements['markup-linked'].children.length, 1);
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
  ui.compile(async () => { throw Object.assign(new Error('Invalid candidate'), { result: { error: { code: 'WORKFLOW_MARKUP_INVALID' } } }); });
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

test('native compiler/transport failures stop model corrections immediately and retain only credential-screened candidates', async () => {
  for (const mode of ['compiler', 'transport', 'credentials']) {
    const ui = await host({ native: true });
    await ui.send({ type: 'markup.copilot', intent: 'Preserve my intent', catalogSource: 'installed', revision: 0 });
    const code = mode === 'compiler' ? 'WORKFLOW_MARKUP_COMPILER_FAILED' : mode === 'credentials' ? 'WORKFLOW_MARKUP_CONTENT_BLOCKED' : null;
    ui.compile(async () => { throw Object.assign(new Error(`${mode} failure`), code ? { result: { error: { code } } } : {}); });
    await assert.rejects(ui.tool({ action: 'draft', revision: 0, source: '<candidate/>' }));
    const retained = ui.posted.filter(message => message.type === 'markup.draftFailed');
    assert.equal(retained.length, mode === 'compiler' ? 1 : 0, mode);
    if (mode === 'compiler') assert.equal(retained[0].source, '<candidate/>');
    else assert.ok(ui.posted.filter(message => message.type === 'markup.error').every(message => !Object.hasOwn(message, 'source')));
    if (mode !== 'credentials') {
      for (const source of ['<candidate/>', '<different-candidate/>']) await assert.rejects(
        ui.tool({ action: 'draft', revision: 0, source }), /stopped after an internal compiler or transport failure/u);
      assert.equal(ui.calls.length, 1, mode);
    }
    assert.deepEqual(ui.imports, []);
    assert.equal(ui.posted.some(message => message.type === 'markup.proposed'), false);
  }
});

test('catalog drift, invalid installation and unsupported contracts stop before more model correction calls', async () => {
  for (const code of ['WORKFLOW_INTENT_CATALOG_STALE', 'DOCS_MANIFEST_MISMATCH', 'WORKFLOW_MARKUP_CAPABILITY_REQUIRED', 'WORKFLOW_MARKUP_CONTENT_BLOCKED']) {
    const ui = await host({ native: true });
    await ui.send({ type: 'markup.copilot', intent: 'Preserve my intent', catalogSource: 'installed', revision: 0 });
    ui.compile(async () => { throw Object.assign(new Error(code), { result: { error: { code } } }); });
    await assert.rejects(ui.tool({ action: 'draft', revision: 0, source: '<candidate/>' }));
    await assert.rejects(ui.tool({ action: 'draft', revision: 0, source: '<changed/>' }), /prerequisite or human decision/u);
    assert.equal(ui.calls.length, 1);
    assert.equal(ui.posted.some(message => message.type === 'markup.draftFailed' || message.type === 'markup.proposed'), false);
  }
});

test('native designer corrects a POC approval conflict through the real compiler and accepts the sequential design', async () => {
  const description = 'Preserve my intent';
  const captured = await withWorkflowIntentCatalog(null, { source: 'installed' }, value => ({
    catalog: queryWorkflowIntentCatalog(value),
    source: workflowMarkupCandidate(value, 'poc-workflow', { description,
      approvalGroup: phase => phase === 'poc-publication-review' ? 'quality-reviewers' : 'architecture-reviewers' })
  }));
  const ui = await host({ native: true });
  ui.catalog(async () => captured.catalog);
  ui.compile(async (_args, source) => compileWorkflowMarkup(source, { designReview: true }));
  await ui.send({ type: 'markup.copilot', intent: description, catalogSource: 'installed', revision: 0 });
  await assert.rejects(ui.tool({ action: 'draft', revision: 0, source: captured.source.replace('authority="quality-reviewers"', 'authority="architecture-reviewers"') }), /requiredAuthorities.*quality-reviewers/u);
  const accepted = await ui.tool({ action: 'draft', revision: 0, source: captured.source });
  assert.equal(accepted.status, 'portable-ready');
  const proposed = ui.posted.find(message => message.type === 'markup.proposed');
  assert.equal(proposed.result.designReview.phases.length, 6);
  assert.deepEqual(proposed.result.workflow.decisions, []);
  assert.deepEqual(proposed.result.designReview.phases.at(-1).approval.requiredAuthorities, ['quality-reviewers']);
  assert.equal(accepted.repositoryFilesChanged, false);
  assert.equal(accepted.approvalRecorded, false);
  assert.deepEqual(ui.imports, []);
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

const localCapture = { resultType: 'workflow-intent-attachments', sourceSha256: 'sha256:' + 'b'.repeat(64), notices: [],
  readGuidance: { argv: ['workflow', 'intent', 'attachments', '--file', '/chosen/INSTRUCTIONS.md', '--expected-source', 'sha256:' + 'b'.repeat(64), '--id', '<CAPTURE-ID>', '--json'] }, items: [
  { id: 'local-team-rule', name: 'INSTRUCTIONS.md', content: 'Keep every control keyboard accessible.', bytes: 39, available: true, sha256: 'sha256:' + 'c'.repeat(64),
    classification: { kind: 'instruction', confidence: 'recognized', reason: 'Named instructions', scope: null } }
] };
test('local attachment picker owns paths, exposes no file bodies to the webview list and binds generated objects', async () => {
  const ui=await host({native:true});ui.capture(async args=>{assert.deepEqual(args.slice(0,5),['workflow','intent','attachments','--file','/chosen/INSTRUCTIONS.md']);return structuredClone(localCapture);});
  ui.openDialog(async()=>[{scheme:'file',fsPath:'/chosen/INSTRUCTIONS.md'}]);await ui.send({type:'markup.attach',mode:'files',revision:0,path:'/untrusted/ignored.md'});
  const attached=ui.posted.find(item=>item.type==='markup.attachments');assert.equal(attached.revision,1);assert.equal(attached.items[0].content,undefined);assert.ok(!JSON.stringify(attached).includes('/chosen/'));
  await ui.send({type:'markup.copilot',intent:'Use our local guidance',catalogSource:'installed',revision:1});
  const body=await ui.tool({action:'asset',kind:'attachment',id:'local-team-rule',revision:1});assert.match(body.content,/keyboard/u);assert.ok(!JSON.stringify(body).includes('/chosen/'));
  ui.compile(async()=>({...result,intent:{text:'Use our local guidance',requirements:[]},catalog:{...catalog}}));
  await assert.rejects(ui.tool({action:'draft',revision:1,source:'<candidate/>'}),/Every available attachment/u);
  ui.compile(async()=>({...result,intent:{text:'Use our local guidance',requirements:[]},catalog:{...catalog},attachmentMappings:[{id:'local-team-rule',sha256:localCapture.items[0].sha256,kind:'instruction',targets:['instruction:flow-rule']}]}));
  await ui.tool({action:'draft',revision:1,source:'<corrected/>'});assert.ok(ui.posted.some(item=>item.type==='markup.proposed'));assert.deepEqual(ui.imports,[]);
  await ui.send({type:'markup.changed',revision:2});await ui.send({type:'markup.removeAttachment',id:'local-team-rule',revision:2});await apply(ui,1);assert.deepEqual(ui.imports,[]);
});
test('cancelled, nonlocal and late attachment captures never mutate the current draft', async () => {
  const ui=await host();await ui.send({type:'markup.attach',mode:'files',revision:0});assert.match(ui.posted.at(-1).message,/cancelled/u);
  ui.openDialog(async()=>[{scheme:'https',fsPath:'/outside'}]);await ui.send({type:'markup.attach',mode:'files',revision:0});assert.match(ui.posted.at(-1).message,/local files/u);
  ui.openDialog(async()=>[{scheme:'file',fsPath:'/chosen/INSTRUCTIONS.md'}]);let finish;ui.capture(()=>new Promise(resolve=>{finish=resolve;}));
  const capture=ui.send({type:'markup.attach',mode:'files',revision:0});await Promise.resolve();await Promise.resolve();await ui.send({type:'markup.changed',revision:1});finish(structuredClone(localCapture));await capture;
  assert.equal(ui.posted.some(item=>item.type==='markup.attachments'),false);
  await ui.send({type:'markup.check',revision:1,source:'<empty/>'});assert.equal(ui.posted.at(-1).type,'markup.checked','a discarded late capture did not leave invisible attachments');
});
test('selected library skills cannot disappear silently from a checked proposal',async()=>{
  const ui=await host({native:true});await ui.send({type:'markup.copilot',intent:'Use our skill',catalogSource:'installed',selectedAssets:[{kind:'skill',id:'team-test'}],revision:0});
  ui.compile(async()=>({...result,intent:{text:'Use our skill',requirements:[]},catalog:{...catalog}}));
  await assert.rejects(ui.tool({action:'draft',revision:0,source:'<missing/>'}),/does not account/u);
  ui.compile(async()=>({...result,intent:{text:'Use our skill',requirements:[]},catalog:{...catalog},reusedAssets:[{kind:'skill',id:'team-test',as:'team-test'}]}));
  await ui.tool({action:'draft',revision:0,source:'<selected/>'});assert.ok(ui.posted.some(item=>item.type==='markup.proposed'));
});

test('preparing a Copilot request prevents duplicate lookup and chat handoffs',async()=>{
  const ui=await host();let finish,calls=0;ui.catalog(()=>{calls++;return new Promise(resolve=>{finish=resolve;});});
  const first=ui.send({type:'markup.copilot',intent:'Create a review process',revision:0});
  await ui.send({type:'markup.copilot',intent:'Create a review process',revision:0});
  finish(catalog);await first;assert.equal(calls,1);assert.equal(ui.chats.length,1);
});

const inspection = { phase: 'intake', agent: { id: 'analyst', tools: ['read', 'edit'] }, skills: [{ id: 'local-checks', label: 'Local checks', loading: 'eager', scopes: ['agent analyst'], use: 'When UI files change', instructionRefs: ['keyboard-rule'] }],
  instructions: [{ id: 'keyboard-rule', label: 'Keyboard access' }], text: '<script>never execute</script>', bytes: 32, estimatedTokens: 8 };
const designResult = { ...result, designReview: { phases: [{ id: 'intake', label: 'Intake', agent: 'analyst', task: 'clarify', writeScope: 'artifact-only', artifact: { path: 'artifacts/intake.md' }, approval: { mode: 'required', authorities: ['reviewers'], rejectTo: ['intake'] }, inputs: [], qualityCommands: [] }], edges: [{ from: 'intake', to: 'end', label: 'Continue' }], inspection: null, notice: 'Static candidate only.' },
  routeSimulation: { status: 'passed', counts: { pass: 1 }, scenarios: [{ id: 'pass', kind: 'pass', outcome: 'end', path: ['intake','end'] }] } };

test('canvas phase selection is read-only, displays static guidance inertly and ignores stale inspector responses', () => {
  const ui = browser();ui.receive({ type: 'markup.checked', revision: 0, result: designResult });
  assert.equal(ui.elements['markup-phase-title'].textContent, 'Intake');
  assert.equal(ui.posted.some(item => item.type === 'markup.inspectPhase'), false, 'checking does not read every prompt');
  ui.elements['markup-inspect-prompt'].onclick(); const read = ui.posted.at(-1);
  assert.equal(read.type, 'markup.inspectPhase');assert.equal(read.phase, 'intake');
  ui.receive({ type: 'markup.phaseInspection', revision: 0, request: read.request, inspection });
  assert.equal(ui.elements['markup-prompt-text'].textContent, inspection.text);
  assert.equal(ui.elements['markup-inspection-content'].hidden, false);
  assert.match(ui.elements['markup-inspection-status'].textContent, /static guidance only/u);
  assert.equal(ui.elements['markup-scenario-path'].children.length, 2);
  ui.elements['markup-intent'].value = 'Changed';ui.elements['markup-intent'].listeners.input();
  ui.receive({ type: 'markup.phaseInspection', revision: 0, request: read.request, inspection: { ...inspection, text: 'stale' } });
  assert.equal(ui.elements['markup-prompt-text'].textContent, inspection.text);assert.equal(ui.elements['markup-result'].hidden, true);
});

test('phase inspection caches and coalesces exact reads without import, writes or model calls', async () => {
  const ui = await host();ui.compile(async () => designResult);await check(ui);
  let finish;ui.compile(async (args) => { assert.ok(args.includes('--inspect-phase'));assert.ok(!args.includes('--out'));return new Promise(resolve => { finish = resolve; }); });
  const first = ui.send({ type: 'markup.inspectPhase', phase: 'intake', revision: 0, request: 1 });
  const second = ui.send({ type: 'markup.inspectPhase', phase: 'intake', revision: 0, request: 2 });
  assert.equal(ui.calls.length, 2);
  finish({ ...designResult, designReview: { ...designResult.designReview, inspection } });await Promise.all([first, second]);
  await ui.send({ type: 'markup.inspectPhase', phase: 'intake', revision: 0, request: 3 });assert.equal(ui.calls.length, 2);
  assert.equal(ui.posted.at(-1).inspection.text, inspection.text);
  await ui.send({ type: 'markup.inspectPhase', phase: 'foreign', revision: 0, request: 4 });assert.equal(ui.calls.length, 2);assert.equal(ui.posted.at(-1).type, 'markup.inspectionError');
  assert.deepEqual(ui.imports, []);assert.deepEqual(ui.chats, []);
});

test('edits, repository changes and drifted compiler bindings cannot display a stale prompt', async () => {
  for (const changed of ['edit','repository','binding']) {
    const ui = await host();ui.compile(async () => designResult);await check(ui);let finish;
    ui.compile(() => new Promise(resolve => { finish = resolve; }));
    const pending = ui.send({ type: 'markup.inspectPhase', phase: 'intake', revision: 0, request: 1 });
    if (changed === 'edit') await ui.send({ type: 'markup.changed', revision: 1 });
    if (changed === 'repository') ui.client.repository = '/other/repository';
    finish({ ...designResult, ...(changed === 'binding' ? { bundleSha256: 'changed' } : {}), designReview: { ...designResult.designReview, inspection } });await pending;
    assert.equal(ui.posted.some(item => item.type === 'markup.phaseInspection'), false);
  }
});

test('attachment review reports duplicates and missing references without exposing source bodies or executing text', () => {
  const ui = browser();
  ui.receive({ type: 'markup.attachments', previousRevision: 0, items: [
    ...localCapture.items,
    { ...localCapture.items[0], id: 'local-copy', name: '<script>literal</script>.md', references: [{ status: 'not-in-capture', label: 'missing.md' }] }
  ] });
  assert.equal(ui.elements['markup-knowledge-summary'].textContent, '2 instructions');
  const warnings = ui.elements['markup-knowledge-review'].children;
  assert.match(warnings[0].textContent, /Same content/u);assert.ok(warnings[0].textContent.includes('<script>literal</script>'));
  assert.equal(warnings[1].children[0].textContent, '1 references need review · no additional files fetched');
});

test('review simulation previews are bounded without presenting a shortened path as complete', async () => {
  const ui = await host();ui.compile(async () => ({ ...designResult, routeSimulation: { ...designResult.routeSimulation, scenarios: [{ id: 'long', kind: 'repair', outcome: 'pause', path: Array(100).fill('intake'), pausedFor: ['reviewers'] }] } }));await check(ui);
  const scenario = ui.posted.at(-1).result.routeSimulation.scenarios[0];
  assert.equal(scenario.path.length, 80);assert.equal(scenario.pathLength, 100);assert.deepEqual(scenario.pausedFor, ['reviewers']);
});
test('phase refinement preserves the original description, invalidates old checks and only prepares a Copilot request', () => {
  const ui = browser();ui.elements['markup-intent'].value = 'My original process';
  ui.receive({ type: 'markup.proposed', source: '<existing-draft/>', revision: 0, result: designResult });
  ui.elements['markup-refine-text'].value = 'Keep the tester independent.';ui.elements['markup-refine-text'].listeners.input();
  assert.equal(ui.elements['markup-refine-phase'].disabled, false);
  ui.elements['markup-refine-phase'].onclick();
  const handoff = ui.posted.at(-1);
  assert.equal(handoff.type, 'markup.copilot');assert.match(handoff.intent, /^My original process/u);assert.match(handoff.intent, /Change to the "Intake" phase/u);assert.match(handoff.intent, /tester independent/u);
  assert.equal(handoff.source, '<existing-draft/>');
  assert.equal(ui.elements['markup-result'].hidden, true);assert.equal(ui.elements['markup-import'].disabled, true);
});
