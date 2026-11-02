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

const media = (name) => readFileSync(new URL(`../apps/vscode/media/${name}`, import.meta.url), 'utf8');
const shapes = (svg) => [...svg.matchAll(/<(path|ellipse)\b[^>]*>/g)].map(([element]) => element
  .replace(/\s+/g, ' ').match(/(?:stroke-width|d|cx|cy|rx|ry)="[^"]*"/g).join(' '));

/**
 * The activity bar shows media/activity.svg, the chat participant its fixed-ink copies
 * media/chat-light.svg and media/chat-dark.svg, and the sidebar header and the page lockups draw the
 * mark inline. All of them are the same f∞₀, so one redraw cannot leave another surface on an older
 * mark.
 */
test('the activity-bar icon, the chat avatars and the inline marks draw one geometry', () => {
  const activity = media('activity.svg');
  assert.match(activity, /viewBox="0 0 24 24"/);
  assert.deepEqual([...new Set(activity.match(/(?:stroke|fill)="[^"]*"/g))].sort(), ['fill="none"', 'stroke="currentColor"']);
  assert.equal(shapes(activity).length, 3);
  assert.deepEqual(shapes(brandMark(20)), shapes(activity));
  assert.deepEqual(shapes(brandSymbol(25)), shapes(activity));
  assert.deepEqual(shapes(media('chat-light.svg')), shapes(activity));
  assert.deepEqual(shapes(media('chat-dark.svg')), shapes(activity));
  assert.match(brandMark(20), /stroke="currentColor"/);
});

/**
 * VS Code draws a participant's URI icon as a 24 px `<img>` cropped to a circle over the chat list's
 * background, choosing `dark` for dark and high-contrast dark themes and `light` otherwise. In an
 * `<img>` currentColor is black, so each copy needs a fixed ink that reads on every default
 * background of its themes, and room around the mark for the crop.
 */
test('the chat avatar pair carries fixed inks that read on their themes and fit the circular crop', () => {
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (high + 0.05) / (low + 0.05);
  };
  // Editor, sidebar and panel backgrounds of VS Code's built-in themes (2026, Modern, Plus, high contrast).
  const surfaces = {
    'chat-light.svg': ['#ffffff', '#fafafd', '#f8f8f8', '#f3f3f3'],
    'chat-dark.svg': ['#000000', '#121314', '#191a1b', '#181818', '#1f1f1f', '#1e1e1e', '#252526']
  };
  for (const [name, backgrounds] of Object.entries(surfaces)) {
    const svg = media(name);
    const inks = [...new Set(svg.match(/stroke="[^"]*"/g))];
    assert.equal(inks.length, 1, `${name} draws in one ink`);
    const ink = inks[0].slice('stroke="'.length, -1);
    assert.match(ink, /^#[0-9a-f]{6}$/, `${name} needs a fixed ink, not currentColor`);
    for (const background of backgrounds) {
      assert.ok(contrast(ink, background) >= 4.5, `${name} ${ink} on ${background}: ${contrast(ink, background).toFixed(2)}`);
    }
    // Measured along the stroked outlines, the mark reaches 14.25 units from (12, 12), the centre of
    // its 24-unit grid; a box that ends at the grid would crop the ∞ and the 0.
    const [x, y, width, height] = svg.match(/viewBox="([^"]+)"/)[1].split(' ').map(Number);
    assert.deepEqual([x + width / 2, y + height / 2, width], [12, 12, height]);
    assert.ok(width / 2 >= 14.25 + 1, `${name} leaves at least one unit between the mark and the crop`);
  }
});

test('a radio or checkbox choice card is a grid with a 1rem control, inside .choices or alone', () => {
  // webview.ts declares .choice as a flex row after its grid rule, and .editor-card inputs are width: 100%:
  // a lone checkbox card fell back to that row, the checkbox took the whole width and pushed the title
  // out of the card (map-capability "Where this capability is recorded").
  assert.match(THEME_STYLE, /\.choice:not\(\.workflow-choice\):has\(> input\[type="radio"\], > input\[type="checkbox"\]\) \{ display: grid;\s+grid-template-columns: 1rem minmax\(0, 1fr\)/);
  assert.doesNotMatch(THEME_STYLE, /\.choices > \.choice:not\(\.workflow-choice\):has/);
  assert.match(THEME_STYLE, /\.choice > input\[type="radio"\], \.choice > input\[type="checkbox"\] \{ grid-column: 1; grid-row: 1;[^}]*width: 1rem; min-width: 1rem; height: 1rem;/);
  // A one-repository card's title is a URL or path with no spaces; it must wrap inside the card.
  assert.match(THEME_STYLE, /\.choice > \.choice-label \{[^}]*overflow-wrap: anywhere;/);
  const form = readFileSync(new URL('../apps/vscode/src/views/map-capability-form.ts', import.meta.url), 'utf8');
  for (const control of ['<input type="checkbox" data-use-shipping-repository', '<input type="radio" name="capability-map-repository"']) {
    const at = form.indexOf(control);
    assert.ok(at > 0, control);
    assert.match(form.slice(form.lastIndexOf('<', at - 1), at + control.length), /^<label class="choice[^>]*>\s+<input/, `${control} is a direct child of its choice card`);
  }
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
