import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CALM_PALETTE_STYLE, THEME_STYLE } from '../apps/vscode/src/views/theme.ts';
import { brandLockup, brandMark, brandSymbol } from '../apps/vscode/src/views/webview.ts';
import { sidebarBody, SIDEBAR_STYLE } from '../apps/vscode/src/views/sidebar-page.ts';
import { configurationCenterView } from '../apps/vscode/src/views/configuration-center-model.ts';
import { configurationCenterHtml } from '../apps/vscode/src/views/configuration-center-page.ts';

test('editor pages and sidebar share calm surfaces, while high contrast uses host colours', () => {
  assert.ok(THEME_STYLE.startsWith(CALM_PALETTE_STYLE));
  assert.ok(SIDEBAR_STYLE.startsWith(CALM_PALETTE_STYLE));
  assert.match(CALM_PALETTE_STYLE, /body\.vscode-dark[^}]*--sf-bg: #1c2024/);
  assert.match(CALM_PALETTE_STYLE, /body\.vscode-light[^}]*--sf-bg: #f7f8f9/);
  assert.match(CALM_PALETTE_STYLE, /body\.vscode-high-contrast[^}]*--sf-bg: var\(--vscode-editor-background\)/);
  assert.match(THEME_STYLE, /h1 \{[^}]*font-family: var\(--sf-font-sans\)[^}]*font-weight: 500[^}]*text-transform: none/);
  assert.match(THEME_STYLE, /input:focus-visible, select:focus-visible, textarea:focus-visible[^}]*outline: 2px solid/);
});

test('brand geometry and gradient remain independent of the new muted accent', () => {
  const symbol = brandSymbol(25);
  // The brand sheet's greens (brand-art.ts), not the UI accent; light and high-contrast themes swap them in CSS.
  for (const stop of ['#1b6a43', '#3f9462', '#72b98a']) assert.ok(symbol.includes(stop));
  assert.match(symbol, /d="M13\.2 4\.7C13 3\.35 12\.5 2\.6/);
  assert.match(SIDEBAR_STYLE, /body\.vscode-light \.brand-symbol \.sf-mark-low \{ stop-color:#145a3a; \}/);
  assert.match(SIDEBAR_STYLE, /vscode-high-contrast-light\) \.brand-symbol stop\[class\] \{ stop-color:var\(--vscode-foreground\); \}/);
  assert.match(brandLockup(), /SINGULARITY <span>Flow<\/span>/);
  assert.match(THEME_STYLE, /\.brand-lockup[^}]*color: var\(--sf-brand\)/);
  assert.match(CALM_PALETTE_STYLE, /--sf-brand: #3d8e10/);
  const sidebar = sidebarBody({ navigation: { workspace: null, next: null }, freshness: null,
    loading: false, pending: null, active: null, favorites: [] });
  assert.ok(sidebar.includes(symbol));
});

/**
 * The activity bar and the chat participant show media/activity.svg; the sidebar header and the page
 * lockups draw the mark inline. All of them are the same f∞₀, so one redraw cannot leave another
 * surface on an older mark.
 */
test('the activity-bar icon and the inline marks draw one geometry in currentColor', () => {
  const shapes = (svg) => [...svg.matchAll(/<(path|ellipse)\b[^>]*>/g)].map(([element]) => element
    .replace(/\s+/g, ' ').match(/(?:stroke-width|d|cx|cy|rx|ry)="[^"]*"/g).join(' '));
  const activity = readFileSync(new URL('../apps/vscode/media/activity.svg', import.meta.url), 'utf8');
  assert.match(activity, /viewBox="0 0 24 24"/);
  assert.deepEqual([...new Set(activity.match(/(?:stroke|fill)="[^"]*"/g))].sort(), ['fill="none"', 'stroke="currentColor"']);
  assert.equal(shapes(activity).length, 3);
  assert.deepEqual(shapes(brandMark(20)), shapes(activity));
  assert.deepEqual(shapes(brandSymbol(25)), shapes(activity));
  assert.match(brandMark(20), /stroke="currentColor"/);
});

test('grouped action buttons wrap with one shared gap and no extra child margin', () => {
  assert.match(THEME_STYLE, /\.card-foot, \.form-actions, \.actions, \.button-row, \.confirmation-actions[^}]*flex-wrap: wrap[^}]*gap: \.6rem/);
  assert.match(THEME_STYLE, /\.confirmation-actions > button[^}]*margin: 0[^}]*min-height: 2\.25rem/);
  assert.match(THEME_STYLE, /@media \(max-width: 900px\)[^}]*grid-template-columns: minmax\(0, 1fr\)/);
});

test('configuration overview groups connection controls and keeps advanced actions available', () => {
  const view = configurationCenterView({ definition: { phases: {}, approvalAuthorities: {} }, agents: [], mcp: { servers: [] } });
  const html = configurationCenterHtml(view, 'overview', null, null, null, []);
  assert.match(html, /<h2>Connections<\/h2>/);
  assert.match(html, /class="configuration-action-row" data-action="jira"/);
  assert.match(html, /class="configuration-action-row" data-action="teams"/);
  const advanced = html.match(/<details class="configuration-advanced-tools">([\s\S]*?)<\/details>/)?.[1];
  assert.ok(advanced);
  for (const action of ['open-workflow', 'open-portfolio', 'reset-jira']) {
    assert.match(advanced, new RegExp(`data-action="${action}"`));
    assert.equal((html.match(new RegExp(`data-action="${action}"`, 'g')) ?? []).length, 1);
  }
});
