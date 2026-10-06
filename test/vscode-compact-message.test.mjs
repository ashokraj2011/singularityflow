import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as presentation from '../apps/vscode/src/compact-message-presentation.ts';

const source = await readFile(new URL('../apps/vscode/src/compact-message.ts', import.meta.url), 'utf8');
const large = Array.from({ length: 2000 }, (_, i) => `file-${i} ${'a'.repeat(64)}`).join('\n');
function host(choices, { failPreview = false } = {}) {
  const calls = [], documents = [], shown = [], errors = [];
  const vscode = { window: {
    async showWarningMessage(message, options, ...items) {
      calls.push({ message, options, items });
      const choice = choices.shift();
      return choice === '@view' ? items.find(item => (typeof item === 'string' ? item : item.title) === 'View details')
        : typeof choice === 'string' ? items.find(item => (typeof item === 'string' ? item : item.title) === choice) : choice;
    },
    async showInformationMessage(message, options, ...items) {
      if (typeof options === 'string') return this.showWarningMessage(message, {}, options, ...items);
      return this.showWarningMessage(message, options, ...items);
    },
    async showTextDocument(document, options) { shown.push({ document, options }); },
    async showErrorMessage(message) { errors.push(message); }
  }, workspace: { async openTextDocument(options) {
    if (failPreview) throw new Error('Cannot open');
    documents.push(options); return options;
  } } };
  const exports = {};
  const context = vm.createContext({ exports, require(name) {
    if (name === 'vscode') return vscode;
    if (name === './compact-message-presentation.ts') return presentation;
    throw new Error(name);
  } });
  vm.runInContext(ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
  } }).outputText, context);
  return { ...exports, calls, documents, shown, errors };
}

test('native confirmation is bounded while the full title, paths and hashes remain verbatim', () => {
  const message = 'Create exact workflow proposal?';
  const result = presentation.compactMessagePresentation(message, large);
  assert.equal(result.message, message);
  assert.ok(result.detail.length <= presentation.COMPACT_MESSAGE_MAX_CHARS);
  assert.ok(result.detail.split('\n').length <= presentation.COMPACT_MESSAGE_MAX_LINES);
  assert.equal(result.fullText, `${message}\n\n${large}`);
  const longTitle = 'long'.repeat(1000) + '\nLAST-TITLE-LINE';
  const withTitle = presentation.compactMessagePresentation(longTitle, 'Do not modify approved state.');
  assert.ok(withTitle.message.length <= 220);
  assert.equal(withTitle.fullText, `${longTitle}\n\nDo not modify approved state.`);
  const summary = presentation.compactMessagePresentation(message, large, 'summary'.repeat(1000));
  assert.ok(summary.detail.length <= presentation.COMPACT_MESSAGE_MAX_CHARS);
});

test('small dialogs and non-modal messages retain their original text and action values', async () => {
  const h = host(['Proceed', 'Open']);
  const options = { modal: true, detail: 'One change; old state stays preserved.' };
  assert.equal(await h.showCompactWarningMessage('Continue?', options, 'Proceed'), 'Proceed');
  assert.equal(h.calls[0].options.detail, options.detail);
  assert.deepEqual([...h.calls[0].items], ['Proceed']);
  assert.equal(await h.showCompactInformationMessage('Notice', { detail: large }, 'Open'), 'Open');
  assert.equal(h.calls[1].options.detail, large);
  assert.equal(h.documents.length, 0);
  assert.equal(options.detail, 'One change; old state stays preserved.');
});

test('viewing details neither confirms nor changes action identity and preserves every byte', async () => {
  const h = host(['@view', 'Continue review', '@view', 'Continue review', 'Create proposal']);
  const options = { modal: true, detail: large, compactDetail: 'Add 52 · Reuse 3 · Replace 0\nExact configuration proposal' };
  const result = await h.showCompactWarningMessage('Create exact proposal?', options, 'Create proposal');
  assert.equal(result, 'Create proposal');
  assert.equal(h.calls.length, 5);
  assert.equal(h.documents.length, 2);
  assert.equal(h.documents[0].content, `Create exact proposal?\n\n${large}`);
  assert.equal(h.documents[0].language, 'plaintext');
  assert.match(h.calls[0].options.detail, /Add 52/);
  assert.ok(h.calls[0].options.detail.length <= 600);
  assert.equal(h.calls[0].options.compactDetail, undefined);
  assert.equal(options.detail, large, 'captured full plan is not truncated');
  assert.ok(h.calls[0].items.every(item => typeof item === 'string'), 'native overload never mixes item types');
  assert.equal(h.calls[1].options.modal, undefined, 'the complete review is readable without a blocking modal');
  assert.deepEqual([...h.calls[1].items], ['Continue review'], 'continue review is not a mutation action');
  assert.equal(h.calls[2].options.modal, true, 'consent still requires the original modal');
});

test('closing or failing full review never implies consent; similarly named caller actions stay distinct', async () => {
  const cancelled = host(['@view', undefined]);
  assert.equal(await cancelled.showCompactWarningMessage('Apply?', { modal: true, detail: large }, 'Apply'), undefined);
  const failed = host(['@view', 'Apply'], { failPreview: true });
  assert.equal(await failed.showCompactWarningMessage('Apply?', { modal: true, detail: large }, 'Apply'), undefined);
  assert.equal(failed.calls.length, 1);
  assert.equal(failed.errors.length, 1);
  const named = host(['View details']);
  assert.equal(await named.showCompactWarningMessage('Apply?', { modal: true, detail: large }, 'View details'), 'View details');
  assert.equal(named.documents.length, 0);
  assert.deepEqual([...named.calls[0].items], ['View details', 'View details…']);
  const item = { title: 'Approved action', isCloseAffordance: false };
  const objects = host([item]);
  assert.equal(await objects.showCompactInformationMessage('Apply?', { modal: true, detail: large }, item), item);
  assert.ok(objects.calls[0].items.every(value => typeof value === 'object'));
});

test('every native modal warning or information path goes through the shared compact presenter', async () => {
  const { readdir } = await import('node:fs/promises');
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      if (entry.isDirectory()) { await visit(file); continue; }
      if (!entry.name.endsWith('.ts') || entry.name === 'compact-message.ts') continue;
      const text = await readFile(file, 'utf8');
      if (!/modal:\s*true/.test(text)) continue;
      assert.doesNotMatch(text, /vscode\.window\.show(?:Warning|Information)Message/, file.pathname);
    }
  }
  await visit(new URL('../apps/vscode/src/', import.meta.url));
});
