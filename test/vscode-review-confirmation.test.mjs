import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as presentation from '../apps/vscode/src/views/review-confirmation-page.ts';
import * as webview from '../apps/vscode/src/views/webview.ts';
import * as messages from '../apps/vscode/src/views/messages.ts';

const hostSource = await readFile(new URL('../apps/vscode/src/views/review-confirmation.ts', import.meta.url), 'utf8');
const request = (extra = {}) => ({ title: 'Review upgrade', summary: 'One exact reviewed change',
  detail: 'Preserve application code and Story history.', confirmLabel: 'Apply reviewed upgrade', ...extra });

function host() {
  const panels = [];
  const navigations = [];
  const vscode = {
    ViewColumn: { Active: 1 },
    window: { createWebviewPanel(_id, title, _column, options) {
      let disposed = false;
      const disposal = [];
      const panel = { title, options, webview: { html: '', cspSource: 'vscode-webview:',
        onDidReceiveMessage(callback) { panel.send = callback; return { dispose() {} }; } },
      onDidDispose(callback) { disposal.push(callback); return { dispose() {} }; },
      dispose() { if (disposed) return; disposed = true; disposal.forEach(callback => callback()); },
      isDisposed() { return disposed; } };
      panels.push(panel);
      return panel;
    } }
  };
  const exports = {};
  const context = vm.createContext({ exports, require(name) {
    if (name === 'vscode') return vscode;
    if (name === './webview.ts') return webview;
    if (name === './messages.ts') return messages;
    if (name === './review-confirmation-page.ts') return presentation;
    if (name === './navigate.ts') return { navigateTo: value => navigations.push(value) };
    throw new Error(`Unexpected dependency: ${name}`);
  } });
  vm.runInContext(ts.transpileModule(hostSource, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
  } }).outputText, context);
  return { collect: exports.collectReviewConfirmation, panels, navigations };
}

test('large confirmation details are complete, escaped and independently scrollable', () => {
  const detail = Array.from({ length: 2000 }, (_, i) => `preserved/custom/${i}.yml`).join('\n')
    + '\n<script>alert("unsafe")</script>\nLAST-REVIEWED-PATH';
  const html = presentation.reviewConfirmationBody(request({ detail }));
  assert.match(html, /LAST-REVIEWED-PATH/);
  assert.match(html, /preserved\/custom\/1999\.yml/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /class="confirmation-content" tabindex="0"/);
  assert.match(html, /type="submit" disabled/);
  assert.match(html, /type="checkbox" data-acknowledged>/);
  assert.doesNotMatch(html, /\bchecked\b/);
  assert.match(presentation.REVIEW_CONFIRMATION_STYLE, /height:100dvh/);
  assert.match(presentation.REVIEW_CONFIRMATION_STYLE, /grid-template-rows:auto minmax\(0,1fr\) auto/);
  assert.match(presentation.REVIEW_CONFIRMATION_STYLE, /\.confirmation-content[^}]*overflow:auto/);
  assert.match(presentation.REVIEW_CONFIRMATION_STYLE, /white-space:pre-wrap; overflow-wrap:anywhere/);
  assert.match(presentation.REVIEW_CONFIRMATION_STYLE, /\.confirmation-actions[^}]*position:sticky/);
});

test('long exact confirmations are visible in full but never prefilled or weakened', () => {
  const expected = `wrip-${'a'.repeat(24)}-${'b'.repeat(64)}`;
  const model = request({ expected });
  const html = presentation.reviewConfirmationBody(model);
  assert.match(html, new RegExp(`<code>${expected}</code>`));
  assert.match(html, /<input id="review-confirmation"[^>]*required>/);
  assert.doesNotMatch(html, /<input[^>]*\bvalue=/);
  assert.doesNotMatch(html, /data-acknowledged/);
  for (const confirmation of [undefined, '', expected.slice(0, 24), `${expected} `, expected.toUpperCase()]) {
    assert.equal(presentation.reviewConfirmationAccepted(model,
      { type: 'confirmation.accept', confirmation, acknowledged: true }), false);
  }
  assert.equal(presentation.reviewConfirmationAccepted(model,
    { type: 'confirmation.accept', confirmation: expected }), true);
  assert.equal(presentation.reviewConfirmationAccepted(request({ expected: '' }),
    { type: 'confirmation.accept', confirmation: '' }), false);
});

test('yes/no confirmation needs an explicit boolean acknowledgement', () => {
  for (const acknowledged of [undefined, false, 'true', 1]) {
    assert.equal(presentation.reviewConfirmationAccepted(request(),
      { type: 'confirmation.accept', acknowledged }), false);
  }
  assert.equal(presentation.reviewConfirmationAccepted(request(),
    { type: 'confirmation.accept', acknowledged: true }), true);
});

test('host refuses malformed, unknown and wrong exact decisions before accepting the reviewed bytes', async () => {
  const h = host();
  const original = request({ expected: 'phase:exact-current-hash' });
  const result = h.collect(original);
  original.expected = 'substituted-after-render';
  const panel = h.panels[0];
  for (const message of [null, [], {}, { type: 'unknown', acknowledged: true },
    { type: 'confirmation.accept', confirmation: original.expected },
    { type: 'confirmation.accept', acknowledged: true }]) panel.send(message);
  assert.equal(panel.isDisposed(), false);
  panel.send({ type: 'confirmation.accept', confirmation: 'phase:exact-current-hash' });
  assert.equal(await result, true);
  assert.equal(panel.isDisposed(), true);
  panel.send({ type: 'confirmation.accept', confirmation: original.expected });
});

test('close, Cancel and navigation each leave the action unconfirmed', async () => {
  for (const mode of ['close', 'cancel', 'navigate']) {
    const h = host();
    const result = h.collect(request());
    const panel = h.panels[0];
    if (mode === 'close') panel.dispose();
    else if (mode === 'cancel') panel.send({ type: 'confirmation.cancel' });
    else panel.send({ type: 'navigate', to: 'configuration' });
    assert.equal(await result, false, mode);
    assert.equal(panel.isDisposed(), true);
    assert.equal(h.navigations.length, mode === 'navigate' ? 1 : 0);
    panel.send({ type: 'confirmation.accept', acknowledged: true });
  }
});

test('opening a second confirmation cancels the first and cannot inherit its acknowledgement', async () => {
  const h = host();
  const first = h.collect(request());
  const second = h.collect(request({ title: 'Different decision' }));
  assert.equal(await first, false);
  h.panels[0].send({ type: 'confirmation.accept', acknowledged: true });
  assert.equal(h.panels[1].isDisposed(), false);
  h.panels[1].send({ type: 'confirmation.accept', acknowledged: true });
  assert.equal(await second, true);
});

test('migration and long approval callers use the scrollable review and retain stale-plan guards', async () => {
  const source = name => readFile(new URL(`../apps/vscode/src/${name}`, import.meta.url), 'utf8');
  const bootstrap = await source('views/bootstrap-panel.ts');
  assert.match(bootstrap, /collectReviewConfirmation\([\s\S]*Not carried forward/);
  assert.match(bootstrap, /if \(!confirmed\) return;[\s\S]*revision !== this\.inspectionRevision/);
  const workspace = await source('views/workspaces-panel.ts');
  assert.match(workspace, /collectReviewConfirmation\([\s\S]*expected: planId/);
  assert.match(workspace, /if \(!confirmation \|\| this\.disposed \|\| this\.configuration\.result !== reviewedResult/);
  const actions = await source('actions.ts');
  assert.match(actions, /collectReviewConfirmation\([\s\S]*expected: confirmation\.expected/);
  assert.match(actions, /client\.repository !== reviewedRepository/);
  assert.match(actions, /acknowledgeSelfApproval = review\.acknowledgeSelfApproval/);
  assert.match(actions, /request\.kind === 'story' && acknowledgeSelfApproval\) argv\.push\('--acknowledge-self-approval'\)/,
    'an acknowledgement explicitly collected in the approval form is not requested a second time');
  const approval = await source('views/approval-review.ts');
  assert.match(approval, /return `<form class="approval-form"[\s\S]*\$\{selfApproval\}/,
    'the self-approval checkbox must be inside the form inspected by its script');
  assert.match(approval, /\.approval-review-content[^}]*overflow:auto/);
  assert.match(approval, /grid-template-rows:minmax\(0,1fr\) auto/);
  const studio = await source('views/workflow-studio.ts');
  assert.match(studio, /const accepted = await collectReviewConfirmation/);
  assert.doesNotMatch(studio, /bounded\(detail, 2000\)/, 'review details are not silently cut');
});
