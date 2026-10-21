/**
 * The brand sheet's treatments, and where each one appears.
 *
 * The request was specific: the icon treatment as the extension icon, the transparent banner on the
 * main page (My Work), and the navy card on About, with neither the T-shirt mockup nor the white
 * card anywhere. These hold the placements and the theme handling, which a fixture rendered outside
 * a webview would otherwise never notice: white SFLOW on a light editor is invisible, not broken.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { BRAND_ART_STYLE, brandBanner, brandCard } from '../apps/vscode/src/views/brand-art.ts';
import { ABOUT_STYLE, aboutHtml } from '../apps/vscode/src/views/about-page.ts';

const view = (name) => readFile(new URL(`../apps/vscode/src/views/${name}`, import.meta.url), 'utf8');
const text = (svg) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((match) => match[1]);

test('the main-page banner carries the mark, both names and the tagline as one labelled image', () => {
  const banner = brandBanner();
  assert.match(banner, /^<svg class="sf-brand-banner"[^>]*role="img"/);
  assert.match(banner, /aria-label="Singularity Flow\. SFLOW: from intent to verified delivery\."/);
  assert.deepEqual(text(banner), ['SINGULARITY FLOW', 'SFLOW', 'FROM INTENT TO VERIFIED DELIVERY']);
  // Every line is held to the sheet's width, whichever system font draws it.
  assert.equal((banner.match(/textLength="\d+" lengthAdjust="spacing"/g) ?? []).length, 3);
  assert.match(banner, /<linearGradient id="sf-banner-ink"/);
  assert.match(banner, /stroke="url\(#sf-banner-ink\)"/);
  assert.match(banner, /M178 107\.5C176\.8 103\.2/, 'the f is the sheet geometry');
  assert.doesNotMatch(banner, /stop-color="#/, 'banner colours must come from the theme variables');
});

test('the banner follows the editor theme and hands every colour back in high contrast', () => {
  assert.match(BRAND_ART_STYLE, /\.sf-brand-banner \{[^}]*--sf-logo-name: #f5f7f8/);
  assert.match(BRAND_ART_STYLE, /body\.vscode-light \.sf-brand-banner \{[^}]*--sf-logo-name: #1e2227/);
  assert.match(BRAND_ART_STYLE, /body\.vscode-light \.sf-brand-banner \{[^}]*--sf-logo-word: #1f6b45/);
  const contrast = 'body:is(.vscode-high-contrast, .vscode-high-contrast-light) :is(.sf-brand-banner, .sf-brand-card)';
  assert.ok(BRAND_ART_STYLE.includes(`${contrast} stop { stop-color: var(--vscode-foreground); }`));
  assert.ok(BRAND_ART_STYLE.includes(`${contrast} text { fill: var(--vscode-foreground); }`));
});

test('the About card is the navy documentation treatment, outlined instead in high contrast', () => {
  const card = brandCard();
  assert.match(card, /^<svg class="sf-brand-card"[^>]*role="img" aria-label="Singularity Flow\. SFLOW\."/);
  assert.match(card, /<rect class="sf-card-plate"[^>]*fill="#252c37"/);
  assert.deepEqual(text(card), ['SINGULARITY', 'SFLOW']);
  assert.match(card, /stroke="url\(#sf-card-ink\)"/);
  assert.notEqual(card.match(/id="([^"]+)"/)?.[1], brandBanner().match(/id="([^"]+)"/)?.[1]);
  assert.match(BRAND_ART_STYLE, /high-contrast-light\) \.sf-card-plate \{ fill: transparent; stroke: var\(--vscode-contrastBorder/);
});

test('About shows the navy card and My Work shows the banner; no other page uses either', async () => {
  const about = aboutHtml(null, { version: '0.9.0', build: 'abc', editorVersion: '1.90.0', reloadRequired: false });
  assert.ok(about.startsWith(`<header class="page-header">${brandCard()}<h1>About Singularity Flow</h1>`));
  assert.doesNotMatch(about, /sf-brand-banner|brand-lockup/);
  assert.ok(ABOUT_STYLE.startsWith(BRAND_ART_STYLE));

  const panel = await view('result-panel.ts');
  assert.match(panel, /<main class="sf-result-main">\$\{isHome \? brandBanner\(\) : ''\}\$\{contextNavigation\}/);
  assert.match(panel, /\$\{RESULT_CARD_STYLE\}\$\{isHome \? BRAND_ART_STYLE : ''\}/);

  const root = new URL('../apps/vscode/src/', import.meta.url);
  const users = [];
  for (const name of await readdir(root, { recursive: true })) {
    if (!name.endsWith('.ts') || name.endsWith('brand-art.ts')) continue;
    if (/brandBanner\(|brandCard\(/.test(await readFile(new URL(name, root), 'utf8'))) users.push(name.replaceAll('\\', '/'));
  }
  assert.deepEqual(users.sort(), ['views/about-page.ts', 'views/result-panel.ts']);
});
