/**
 * Every full-page view offers a way out, or says why it does not.
 *
 * Nineteen of twenty-one views ended with their own content and nothing else — no way onward, no way
 * back, and an editor tab has no browser chrome to fall back on. The footer is rendered by `page()`
 * rather than by each view, because "remember to add navigation" is exactly the instruction that did
 * not scale the first time.
 *
 * Rendering it is only half of it. The buttons post a message, and a view that never listens shows
 * navigation that silently does nothing — which is worse than none. So this checks both halves, and
 * treats the opt-out as a deliberate, greppable decision rather than an absence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { codeOnly } from './source-text.mjs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const views = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'vscode', 'src', 'views');

// webview.ts defines `page`; it does not call it as a view.
const NOT_A_VIEW = new Set(['webview.ts']);

async function fullPageViews() {
  const entries = (await readdir(views)).filter((name) => name.endsWith('.ts') && !NOT_A_VIEW.has(name));
  const found = [];
  for (const name of entries) {
    const source = await readFile(path.join(views, name), 'utf8');
    if (/\bpage\(/.test(source)) found.push({ name, source });
  }
  return found;
}

test('every full-page view either dispatches the footer or opts out on purpose', async () => {
  const pages = await fullPageViews();
  assert.ok(pages.length >= 20, `expected the full set of views, found ${pages.length}`);

  const silent = pages
    .filter(({ source }) => !source.includes('navigationTarget(raw)') && !source.includes('nav: false'))
    .map(({ name }) => name);

  assert.deepEqual(silent, [],
    `these views render a page with navigation nothing listens to: ${silent.join(', ')}`);
});

test('the two opt-outs are the two pages that cannot run a script', async () => {
  // A footer needs a script to post its message. Opting out is correct exactly where one cannot run,
  // and nowhere else — otherwise it becomes a way to skip the rule.
  /**
   * Comments stripped before *detecting* an opt-out, not only before judging one.
   *
   * The loop below already did this, for exactly the right reason — a file that opts out explains
   * why, and the explanation names the thing being searched for. The detection one line up had the
   * same exposure and did not, so a page that mentioned `nav: false` while correctly *not* opting
   * out was reported as a third opt-out. Found when `result-panel.ts` documented having removed one.
   */
  const pages = (await fullPageViews()).map((entry) => ({ ...entry, code: codeOnly(entry.source) }));
  const optedOut = pages.filter(({ code }) => code.includes('nav: false'));
  assert.deepEqual(optedOut.map(({ name }) => name).sort(), ['specification-trace.ts', 'visual-fixture.ts']);

  for (const { name, code } of optedOut) {
    const scriptable = /enableScripts:\s*true/.test(code) || /script-src '?nonce/.test(code);
    assert.equal(scriptable, false, `${name} can run a script, so it should carry the footer`);
  }
});

test('a page that names itself does not link to itself', async () => {
  const { footerNav } = await import('../apps/vscode/src/views/webview.ts');
  const journey = footerNav('journey');
  assert.match(journey, /<span class="nav-current" aria-current="page">Journey<\/span>/);
  assert.doesNotMatch(journey, /data-nav="journey"/);
  // And a page that is none of the five destinations offers all of them.
  const anonymous = footerNav(null);
  for (const destination of ['journey', 'approvals', 'configuration', 'doctor', 'help']) {
    assert.match(anonymous, new RegExp(`data-nav="${destination}"`));
  }
});

test('the footer only reaches commands the extension actually contributes', async () => {
  // A destination naming a command nobody registered is a button that throws when pressed.
  const { NAV_COMMANDS } = await import('../apps/vscode/src/views/webview.ts');
  const manifest = JSON.parse(await readFile(
    path.resolve(views, '..', '..', 'package.json'), 'utf8'));
  const contributed = new Set(manifest.contributes.commands.map((entry) => entry.command));
  for (const command of Object.values(NAV_COMMANDS)) {
    assert.ok(contributed.has(command), `the footer points at ${command}, which is not contributed`);
  }
});

test('every inline stylesheet carries the CSP nonce', async () => {
  /**
   * The failure with no symptom.
   *
   * The policy is `style-src 'nonce-…'`, so a `<style>` without one is dropped by the webview
   * silently: the panel opens, the markup is byte-identical, and every rule in that sheet does not
   * exist. What the reader sees is whatever the shared kit happens to provide, which looks
   * plausible enough to ship — the result card did, and it took opening the editor and noticing
   * that six actions were filled when the envelope declared one.
   *
   * No fixture can catch it. A stylesheet rendered outside a webview has no CSP to enforce, so the
   * HTML tests pass either way. This is a source check because that is the only place the fact is
   * visible.
   */
  const offenders = [];
  for (const { name, source } of await fullPageViews()) {
    // `codeOnly`, because both files now carry a comment explaining this very rule. Fifth time this
    // trap has fired in one change, and the first time inside a test written to guard a different
    // one — which is the argument for the shared helper existing at all.
    for (const [, attributes] of codeOnly(source).matchAll(/<style([^>]*)>/g)) {
      if (!attributes.includes('nonce')) offenders.push(`${name}: <style${attributes}>`);
    }
  }
  assert.deepEqual(offenders, [],
    `these stylesheets are silently dropped by the content security policy:\n  ${offenders.join('\n  ')}`);
});
