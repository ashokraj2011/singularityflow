/**
 * What this change does, in VS Code [CSP:REQ-007, REQ-008]: the approval page shows its line first with "Open the full
 * page", the Decide card's approval row shows it with "Open the page", and the Work page's task view has "What this change
 * does". Each reads the engine's JSON; a path that leaves the checkout is never offered. Each page opens it in VS Code's
 * own Markdown preview, so no panel code joins any bundle.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

import * as messages from '../apps/vscode/src/views/messages.ts';
import * as webview from '../apps/vscode/src/views/webview.ts';
import { approvalDocuments, changeStoryOf as cardChangeStory } from '../apps/vscode/src/views/decide-card-page.ts';
import { workTaskFrom, workTaskHtml } from '../apps/vscode/src/views/work-page.ts';

const STORY = { summary: '1 file and 2 functions changed, 2 tests; SFlow\'s run: 2 passed.', path: 'singularity/work-items/CSP-1/CHANGE-STORY.md',
  command: 'singularity-flow explain --subject change --page --work-id CSP-1' };
const listed = (details) => ({ items: [{ id: 'd1', kind: 'approval', title: 'Approve Code', details: { phase: 'implementation', ...details } }] });

/** The VS Code approval page, with a stub `vscode`, as approval-focus.test.mjs loads it. */
async function approvalPage() {
  const source = await readFile(new URL('../apps/vscode/src/views/approval-review.ts', import.meta.url), 'utf8');
  const exports = {};
  const dependencies = { './messages.ts': messages, './webview.ts': webview, './navigate.ts': { navigateTo() {} },
    './approvals-model.ts': await import('../apps/vscode/src/views/approvals-model.ts'), './sf-guard-model.ts': await import('../apps/vscode/src/views/sf-guard-model.ts'),
    './try-it.ts': await import('../apps/vscode/src/views/try-it.ts') };
  const context = vm.createContext({ exports, Date, require(name) {
    if (name === 'vscode') return {};
    if (dependencies[name]) return dependencies[name];
    throw new Error(`Unexpected dependency: ${name}`);
  } });
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
  return exports;
}

test('the approval page starts with what the change does and opens the whole page beside the review [CSP:REQ-007]', async () => {
  const page = await approvalPage();
  const story = page.changeStoryOf(listed({ changeStory: STORY }));
  assert.deepEqual({ ...story }, { summary: STORY.summary, path: STORY.path });
  const html = page.approvalChangeStoryHtml(story);
  assert.match(html, /<h2>What this change does<\/h2>/u);
  assert.match(html, /<p>1 file and 2 functions changed, 2 tests; SFlow&#39;s run: 2 passed\.<\/p>|<p>1 file and 2 functions changed, 2 tests; SFlow's run: 2 passed\.<\/p>/u);
  assert.match(html, /<button type="button" class="secondary" data-change-story>Open the full page<\/button>/u);
  assert.equal(page.changeStoryOf(listed({})), null);
  assert.equal(page.changeStoryOf(listed({ changeStory: { ...STORY, path: '../outside/CHANGE-STORY.md' } })), null, 'a path out of the checkout is never offered');
  assert.equal(page.approvalChangeStoryHtml(null), '');
  const source = await readFile(new URL('../apps/vscode/src/views/approval-review.ts', import.meta.url), 'utf8');
  assert.match(source, /'approval\.changeStory': \(\) => \{[\s\S]*?markdown\.showPreviewToSide/u, 'the page opens in VS Code\'s own Markdown preview');
  assert.match(source, /\$\{approvalChangeStoryHtml\(request\.changeStory\)\}\$\{approvalFocusHtml\(request\.focus\)\}/u, 'first on the page');
});

test('the Decide card\'s approval row names the page, and only that page opens from it [CSP:REQ-007]', async () => {
  const packet = listed({ changeStory: STORY, documents: ['singularity/work-items/CSP-1/artifacts/implementation/implementation-summary.md'] });
  assert.deepEqual(cardChangeStory(packet.items[0]), { summary: STORY.summary, path: STORY.path });
  assert.deepEqual(approvalDocuments(packet), ['singularity/work-items/CSP-1/artifacts/implementation/implementation-summary.md', STORY.path]);
  const source = await readFile(new URL('../apps/vscode/src/views/decide-card-page.ts', import.meta.url), 'utf8');
  assert.match(source, /What this change does: \$\{escape\(story\.summary\)\} <button type="button" class="dc-link" data-open="\$\{escape\(story\.path\)\}">Open the page<\/button>/u);
  const card = await readFile(new URL('../apps/vscode/src/views/decide-card.ts', import.meta.url), 'utf8');
  assert.match(card, /file\.endsWith\('\/CHANGE-STORY\.md'\)[\s\S]{0,200}markdown\.showPreviewToSide/u);
});

test('the Work page\'s task view says what the change does and opens the page in a Markdown preview [CSP:REQ-008]', async () => {
  const status = { schemaVersion: 1, resultType: 'sflow-task-status', id: 'CSP-1', title: 'Double the value', status: 'in_progress', steps: [],
    changeStory: STORY, changed: { base: 'main', total: 1, files: [{ path: 'src/value.mjs', added: 3, removed: 1 }] } };
  const task = workTaskFrom(status);
  assert.deepEqual(task.changeStory, { summary: STORY.summary, path: STORY.path });
  const row = { id: 'CSP-1', title: 'Double the value', task: true, kind: 'change', repository: { id: 'r', name: 'r' }, status: 'in_progress', chips: [],
    statusLine: 'CSP-1 is at Code.', route: { checkout: '/work/r', clone: '/work/r', here: true, elsewhere: [] } };
  const html = workTaskHtml(row, task);
  assert.match(html, /<h2 id="change-story-title">What this change does<\/h2><p>1 file and 2 functions changed/u);
  assert.match(html, /<button type="button" class="secondary" data-act="change-story">What this change does<\/button>/u);
  assert.doesNotMatch(workTaskHtml({ ...row, route: { ...row.route, checkout: null } }, task), /data-act="change-story"/u, 'no checkout here, no button');
  assert.equal(workTaskFrom({ ...status, changeStory: { ...STORY, path: 'a/../../b.md' } }).changeStory, null);
  assert.doesNotMatch(workTaskHtml(row, workTaskFrom({ ...status, changeStory: undefined })), /change-story-title/u);
  const source = await readFile(new URL('../apps/vscode/src/views/work.ts', import.meta.url), 'utf8');
  assert.match(source, /act === 'change-story'[\s\S]{0,300}markdown\.showPreviewToSide/u);
});
