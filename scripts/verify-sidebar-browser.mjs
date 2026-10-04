/** Browser-level checks of the exact production sidebar renderer. No repository or model calls.
 * Run through scripts/run-typescript-module.mjs on supported Node versions without native TS.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { sidebarBody, SIDEBAR_STYLE, SIDEBAR_SCRIPT } from '../apps/vscode/src/views/sidebar-page.ts';
import { workspaceStoriesHtml, STORY_FILTER_SCRIPT } from '../apps/vscode/src/views/workspace-stories-page.ts';
import { buildInbox } from '../apps/vscode/src/views/inbox-model.ts';
import { STYLE } from '../apps/vscode/src/views/webview.ts';

const executablePath = process.env.SFLOW_UI_BROWSER;
if (!executablePath) throw new Error('Set SFLOW_UI_BROWSER to an installed Chromium/Chrome executable. This check never installs a browser.');
const output = process.env.SFLOW_UI_OUTPUT || await mkdtemp(path.join(os.tmpdir(), 'sflow-sidebar-visual-'));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
const results = [];
const failures = [];
const model = { navigation: { workspace: { name: 'Rule Compiler', repository: 'rulecompiler' },
  subject: { id: 'US-104 · Migration', kind: 'Story', phase: 'Implementation' }, next: null },
  active: 'my-work', pending: 3, loading: false, freshness: null,
  favorites: [{ id: 'journal', label: 'Local Journal', icon: 'book' }] };
const bridge = `<script>window.messages=[];window.saved={};window.acquireVsCodeApi=()=>({postMessage:m=>window.messages.push(m),getState:()=>window.saved,setState:s=>window.saved=s});</script>`;
function documentHtml(theme, body, style, script) {
  const dark = theme !== 'light';
  const background = dark ? '#181818' : '#f3f3f3';
  return `<!doctype html><html><head><meta charset="utf-8"><style>:root {
    --vscode-font-family:system-ui;--vscode-font-size:13px;--vscode-sideBar-background:${background};
    --vscode-sideBar-foreground:${dark ? '#ccc' : '#333'};--vscode-foreground:${dark ? '#ccc' : '#333'};
    --vscode-descriptionForeground:${dark ? '#aaa' : '#555'};--vscode-panel-border:${dark ? '#444' : '#ccc'};
    --vscode-dropdown-border:${dark ? '#666' : '#aaa'};--vscode-dropdown-background:${background};--vscode-dropdown-foreground:var(--vscode-foreground);
    --vscode-list-hoverBackground:${dark ? '#303030' : '#e5e5e5'};--vscode-list-activeSelectionBackground:${dark ? '#094771' : '#cce5ff'};
    --vscode-list-activeSelectionForeground:${dark ? '#fff' : '#111'};--vscode-focusBorder:#007acc;--vscode-textLink-foreground:${dark ? '#70baff' : '#006ab1'};
    --vscode-badge-background:#444;--vscode-badge-foreground:#fff;
  }${style}</style></head><body>${body}${bridge}<script>${script}</script></body></html>`;
}
try {
  for (const theme of ['light', 'dark', 'high-contrast']) {
    for (const width of [240, 320]) {
      const page = await browser.newPage({ viewport: { width, height: 780 }, forcedColors: theme === 'high-contrast' ? 'active' : 'none' });
      page.on('pageerror', error => failures.push(error.message));
      const html = documentHtml(theme, sidebarBody(model), SIDEBAR_STYLE, SIDEBAR_SCRIPT);
      await page.setContent(html);
      const nav = page.locator('nav[aria-label="Singularity Flow"] button');
      assert.equal(await nav.count(), 5);
      const target = page.locator('nav [data-action="stories"]');
      await target.hover();
      await page.waitForTimeout(550);
      assert.equal(await page.locator('[role="tooltip"],[title]').count(), 0);
      assert.equal(await page.evaluate(() => messages.length), 0, 'hover performs no action');
      assert.ok(await target.evaluate(el => getComputedStyle(el).transform !== 'none'));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: path.join(output, `sidebar-${theme}-${width}.png`) });
      await target.click();
      assert.deepEqual(await page.evaluate(() => messages), [{ type: 'action', action: 'stories' }]);
      assert.equal(await page.locator('nav [aria-current="page"]').getAttribute('data-action'), 'my-work', 'click does not optimistically select');
      await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'active-destination', id: 'stories' } })));
      assert.equal(await page.locator('nav [aria-current="page"]').getAttribute('data-action'), 'stories');
      await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'active-destination', id: null } })));
      assert.equal(await page.locator('nav [aria-current="page"]').count(), 0);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await target.hover();
      assert.equal(await target.evaluate(el => getComputedStyle(el).transform), 'none');
      await target.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      assert.notEqual(await target.evaluate(el => getComputedStyle(el).outlineStyle), 'none');
      await page.getByText('Pinned shortcuts', { exact: false }).click();
      assert.equal(await page.locator('[data-action="favorite:journal"]').isVisible(), true);
      await page.waitForFunction(() => window.saved['pinned-shortcuts'] === true);
      const saved = await page.evaluate(() => window.saved);
      await page.goto('about:blank');
      await page.setContent(html.replace('window.saved={}', `window.saved=${JSON.stringify(saved)}`));
      assert.equal(await page.locator('[data-action="favorite:journal"]').isVisible(), true, 'pin expansion survives redraw');
      results.push({ theme, width, status: 'passed' });
      await page.close();
    }
  }
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
  page.on('pageerror', error => failures.push(error.message));
  const inbox = buildInbox(null, ['in_progress', 'closed', 'cancelled'].map((status, index) => ({
    repositoryId: 'delivery', repositoryPath: '/fixture/repo', id: `US-${index + 1}`, title: `Story ${index + 1}`,
    status, branch: `US-${index + 1}`, currentPhase: 'custom-step'
  })));
  await page.setContent(documentHtml('light', workspaceStoriesHtml(inbox, '<button>Refresh</button>'),
    STYLE,
    `const vscode=acquireVsCodeApi();${STORY_FILTER_SCRIPT}`));
  await page.locator('#story-status').selectOption('active');
  assert.equal(await page.locator('[data-story-row]:visible').count(), 1);
  await page.locator('summary').first().click();
  assert.equal(await page.evaluate(() => messages.length), 0, 'details never attach');
  await page.locator('#story-status').selectOption('all');
  await page.locator('#story-search').fill('US-2');
  assert.equal(await page.locator('[data-story-row]:visible').count(), 1);
  await page.screenshot({ path: path.join(output, 'workspace-stories.png') });
  results.push({ scenario: 'Story filtering and read-only details', status: 'passed' });
  assert.deepEqual(failures, [], 'no browser runtime errors');
  await writeFile(path.join(output, 'verification.json'), JSON.stringify({ results, failures }, null, 2));
  console.log(JSON.stringify({ output, cases: results.length, failures }));
} finally {
  await browser.close();
}
