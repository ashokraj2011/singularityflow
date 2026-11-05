/** Explicit local browser qualification; no model, repository mutation, or hosted CI. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { specStudioHtml, SPEC_STUDIO_SCRIPT, SPEC_STUDIO_STYLE } from '../apps/vscode/src/views/spec-studio-page.ts';
import { statusFrom } from '../apps/vscode/src/views/spec-studio-model.ts';
import { page as webviewPage } from '../apps/vscode/src/views/webview.ts';

const output = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'sflow-spec-studio-visual'));
await mkdir(output, { recursive: true });
const specId = 'SPEC-DEMO-001';
const prose = '# Help customers place an order\n\n## Outcome\n\nCustomers can place an order and see a **clear confirmation**.\n\n## Requirements\n\nThe service returns one reference for each accepted order. [' + specId + ':REQ-001]\n\n## Acceptance\n\nA valid order returns a reference. [' + specId + ':AC-001]\n\n## Decisions and open questions\n\n- Who receives a confirmation?\n';
const status = statusFrom({ resultType: 'sflow-spec-author', action: 'status', specId, title: 'Help customers place an order', kind: 'business', sequence: 1, spec: prose,
  areas: [], gaps: [], researchItems: [], counts: { d: { passed: 0, total: 0 }, a: { status: 'not-run', pending: 0 }, h: { open: 0, deferred: 0 } },
  proposals: [], findings: [], sources: [{ id: 'SRC-aaaaaaaaaaaaaaaa', name: 'Customer notes.pdf' }], origins: [], rules: [], articles: [], clauseIds: [], blocking: [] });
const state = { target: { specId, revision: null, clauses: null, step: null }, step: 'draft', library: null, status, revision: null, coverage: null,
  split: null, splitDraft: null, selectedGap: null, impact: null, notice: null, error: null, busy: null, copilot: { available: true, tool: true } };
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.__sfMessages = []; window.__sfVscode = { postMessage: message => window.__sfMessages.push(message) }; });
  const base = webviewPage('Spec Studio', specStudioHtml(state), '', 'studio-test', SPEC_STUDIO_SCRIPT, { styles: SPEC_STUDIO_STYLE });
  const themes = {
    light: 'color-scheme:light;--vscode-foreground:#24352e;--vscode-editor-background:#fff;--vscode-sideBar-background:#f5f7f4;--vscode-input-background:#fff;--vscode-input-foreground:#24352e;--vscode-descriptionForeground:#68746d;--vscode-panel-border:#dde4de;--vscode-focusBorder:#26805e;--vscode-font-family:system-ui;--vscode-font-size:14px;--vscode-textLink-foreground:#267352;',
    dark: 'color-scheme:dark;--vscode-foreground:#d8e2dc;--vscode-editor-background:#1b2420;--vscode-sideBar-background:#202c25;--vscode-input-background:#18221c;--vscode-input-foreground:#d8e2dc;--vscode-descriptionForeground:#98aa9d;--vscode-panel-border:#3b4b40;--vscode-focusBorder:#75ba91;--vscode-font-family:system-ui;--vscode-font-size:14px;--vscode-textLink-foreground:#94c5a8;'
  };
  async function load(theme = 'light') {
    await page.goto('about:blank');
    await page.evaluate(() => { window.__sfMessages = []; window.__sfVscode = { postMessage: message => window.__sfMessages.push(message) }; });
    await page.setContent(base.replace('<head>', '<head><style>:root{' + themes[theme] + '}body{margin:0;font-family:system-ui}</style>'));
    await page.evaluate(() => { window.__sfMessages = []; });
  }
  await load();
  assert.equal(await page.locator('.ss-rich-editor').getAttribute('hidden'), null);
  await page.locator('.ss-writing-form button[type=submit]').click();
  assert.equal((await page.evaluate(() => window.__sfMessages)).at(-1).text, prose, 'unchanged rich text saves losslessly');
  await page.evaluate(() => window.postMessage({ type: 'spec.saved', sequence: 1, dirty: false }, '*'));
  await page.waitForFunction(() => !document.querySelector('.ss-writing-form button[type=submit]').disabled);
  // Raw edits survive a round trip to the visual editor, including literal HTML and fenced code.
  await page.locator('[data-source-toggle]').click();
  const changed = prose + '\nManual note <script>not executable</script>.\n```java\nreturn result;\n```\n';
  await page.locator('#ss-prose').fill(changed);
  await page.locator('[data-source-toggle]').click();
  await page.locator('.ss-writing-form button[type=submit]').click();
  assert.equal((await page.evaluate(() => window.__sfMessages)).at(-1).text, changed);
  assert.equal(await page.evaluate(() => document.querySelectorAll('.ss-rich-editor script').length), 0);
  // A rich edit posts precisely the visible text, title, kind and current local sequence.
  await page.locator('.ss-rich-editor').click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.type('One more sentence.');
  const events = await page.evaluate(() => window.__sfMessages.filter(m => m.type === 'spec.editing'));
  assert.ok(events.at(-1).text.includes('One more sentence.'));
  assert.equal(events.at(-1).kind, 'business');
  assert.equal(events.at(-1).sequence, 1);
  await page.evaluate(() => window.postMessage({ type: 'spec.saved', sequence: 2, dirty: false }, '*'));
  await page.waitForFunction(() => document.querySelector('[name=sequence]').value === '2');
  assert.match(await page.locator('[data-save-state]').innerText(), /Saved on this laptop/u);
  const sharingFailure = 'ETIMEDOUT: remote result unknown <script>no execution</script>';
  await page.evaluate(message => window.postMessage(message, '*'), { type: 'spec.syncState', text: 'Saved locally · sharing needs attention', message: sharingFailure, next: 'singularity-flow spec author sync ' + specId + ' --json' });
  await page.waitForFunction(() => !document.querySelector('[data-sync-problem]').hidden);
  assert.equal(await page.locator('[data-sync-error]').innerText(), sharingFailure);
  assert.equal(await page.locator('[data-sync-problem] script').count(), 0);
  await page.evaluate(() => window.postMessage({ type: 'spec.syncState', text: 'Synced' }, '*'));
  await page.waitForFunction(() => document.querySelector('[data-sync-problem]').hidden);
  results.push('rich/source round trip, escaping, editing metadata, save acknowledgement');

  // Editing a line keeps what the renderer drew from its Markdown: code spans, emphasis and clause anchors.
  const lines = '# T\n\nRun `npm test` and **read** it. [SPEC-DEMO-001:REQ-001]\n\nNext.\n';
  const inlineState = { ...state, status: { ...status, spec: lines } };
  const inlinePage = webviewPage('Spec Studio', specStudioHtml(inlineState), '', 'studio-test', SPEC_STUDIO_SCRIPT, { styles: SPEC_STUDIO_STYLE });
  const openInline = async () => {
    await page.goto('about:blank');
    await page.evaluate(() => { window.__sfMessages = []; window.__sfVscode = { postMessage: message => window.__sfMessages.push(message) }; });
    await page.setContent(inlinePage.replace('<head>', '<head><style>:root{' + themes.light + '}body{margin:0;font-family:system-ui}</style>'));
  };
  await openInline();
  assert.ok((await page.evaluate(() => window.__sfMessages)).some(message => message.type === 'spec.ready'), 'the page reports its script is running');
  await page.locator('.ss-rich-editor p', { hasText: 'Run' }).click();
  await page.keyboard.press('End'); await page.keyboard.type(' Done.');
  const edited = (await page.evaluate(() => window.__sfMessages.filter(m => m.type === 'spec.editing'))).at(-1).text;
  assert.ok(edited.includes('Run `npm test` and **read** it. [SPEC-DEMO-001:REQ-001] Done.'), 'an edited line keeps its Markdown: ' + edited);
  results.push('editing a line keeps inline code, emphasis and clause anchors');

  // A blank line sits small until someone types in it.
  const blank = page.locator('.ss-rich-editor p[data-original-line=""]').first();
  assert.ok((await blank.boundingBox()).height <= 8, 'an empty line is a small gap');
  await blank.click(); await page.keyboard.type('Typed into a blank line.');
  const typedLine = page.locator('.ss-rich-editor p', { hasText: 'Typed into a blank line.' });
  assert.ok((await typedLine.boundingBox()).height >= 16, 'text typed into a blank line is readable');
  assert.ok((await page.evaluate(() => window.__sfMessages.filter(m => m.type === 'spec.editing'))).at(-1).text.includes('Typed into a blank line.'));
  results.push('text typed into a blank line renders at full size');

  // What changes around the editor arrives as a message and leaves the editor alone.
  await page.locator('#ss-request').fill('An unsent Copilot request');
  await page.locator('.ss-rich-editor p', { hasText: 'Next.' }).click();
  await page.keyboard.press('End');
  await page.evaluate(() => { window.__sfEditor = document.querySelector('.ss-rich-editor'); window.__sfLine = window.__sfEditor.querySelector('p:last-of-type'); });
  await page.evaluate(() => window.postMessage({ type: 'spec.regions', sequence: 9, saveState: 'Saved on this laptop',
    regions: { notices: '<div class="notice ok" data-notice>A proposal arrived.</div><div class="notice warning" data-sync-problem hidden><span data-sync-error></span><code data-sync-next hidden></code></div>', cowriter: '<p data-new>One new proposal.</p>' } }, '*'));
  await page.waitForSelector('[data-new]');
  assert.equal(await page.evaluate(() => document.querySelector('.ss-rich-editor') === window.__sfEditor), true, 'the editor element is the same one');
  assert.equal(await page.locator('#ss-request').inputValue(), 'An unsent Copilot request');
  assert.equal(await page.locator('[name=sequence]').inputValue(), '9');
  await page.keyboard.type('!');
  assert.ok((await page.evaluate(() => window.__sfMessages.filter(m => m.type === 'spec.editing'))).at(-1).text.includes('Next.!'), 'the caret stayed where the person left it');
  // A typed reason in a replaced region survives the replacement, and Markdown mode survives too.
  await page.evaluate(() => { document.querySelector('[data-region="below"]').innerHTML = '<details open><summary>D</summary><textarea name="reason"></textarea></details>'; });
  await page.locator('[name=reason]').fill('A reason typed here');
  await page.locator('[data-source-toggle]').click();
  await page.evaluate(() => window.postMessage({ type: 'spec.regions', regions: { below: '<details><summary>D</summary><textarea name="reason"></textarea><p data-below-new>Later.</p></details>' } }, '*'));
  await page.waitForSelector('[data-below-new]', { state: 'attached' });
  assert.equal(await page.locator('[name=reason]').inputValue(), 'A reason typed here');
  assert.equal(await page.locator('[data-region="below"] details').evaluate(node => node.open), true);
  assert.equal(await page.locator('#ss-prose').isVisible(), true, 'Markdown mode is still on');
  // Saved wording the page lacks, with nothing unsaved, replaces the document in the mode it is in.
  await page.evaluate(() => window.postMessage({ type: 'spec.regions', regions: {}, sequence: 10, document: { text: '# New title\n\nFresh words.\n', html: '<h1 data-original-line="# New title">New title</h1><p data-original-line=""><br></p><p data-original-line="Fresh words.">Fresh words.</p><p data-original-line=""><br></p>', title: 'New title', kind: 'technical' } }, '*'));
  await page.waitForFunction(() => document.querySelector('#ss-prose').value.includes('Fresh words.'));
  assert.equal(await page.locator('#ss-title').inputValue(), 'New title');
  assert.equal(await page.locator('[name=kind]').inputValue(), 'technical');
  await page.locator('[data-source-toggle]').click();
  await page.locator('.ss-writing-form button[type=submit]').click();
  assert.equal((await page.evaluate(() => window.__sfMessages)).at(-1).text, '# New title\n\nFresh words.\n', 'the replaced document saves losslessly');
  results.push('regions and a replaced document leave the caret, unsent request, typed reasons and Markdown mode alone');
  results.push('sharing failures expose the original diagnostic and retry without replacing the editor');
  for (const theme of ['light', 'dark']) {
    await load(theme);
    await page.screenshot({ path: path.join(output, 'spec-studio-' + theme + '.png'), fullPage: true });
  }
  await page.setViewportSize({ width: 320, height: 844 }); await load();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'mobile layout has no horizontal page overflow');
  await page.screenshot({ path: path.join(output, 'spec-studio-mobile.png'), fullPage: true });
  results.push('light, dark and 320px mobile layout');
  await page.goto('about:blank');
  await page.evaluate(() => { window.__sfMessages = []; window.__sfVscode = { postMessage: message => window.__sfMessages.push(message) }; });
  await page.setContent(webviewPage('Spec Studio', specStudioHtml({ ...state, status: null, target: { specId: null, revision: null, clauses: null, step: null } }), '', 'studio-test', SPEC_STUDIO_SCRIPT, { styles: SPEC_STUDIO_STYLE }));
  await page.locator('textarea[name=intent]').fill('Make it easier to place an order.');
  await page.getByRole('button', { name: 'Help me write it' }).click();
  const creation = (await page.evaluate(() => window.__sfMessages)).find(message => message.type === 'spec.new');
  assert.equal(creation.mode, 'copilot');
  assert.equal(creation.intent, 'Make it easier to place an order.');
  results.push('idea creation routes Help me write it to Copilot');
  assert.deepEqual(errors, [], 'the webview script has no browser errors');
  await context.close();
} finally { await browser.close(); }
await writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'passed', platform: process.platform, results }, null, 2) + '\n');
console.log(JSON.stringify({ status: 'passed', output, results }));
