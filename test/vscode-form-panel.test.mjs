/**
 * The host that runs a schema-driven form. `[UXH:REQ-070]`–`[UXH:REQ-076]`
 *
 * Asserted against the source, because the panel is the one third of the form layer that needs an
 * extension host and therefore the one third a fixture cannot exercise. The rules checked here are
 * the ones whose absence has no symptom: a missing nonce renders a plausible page, a success
 * message the panel has no evidence for reads exactly like one it does, and a draft written before
 * the filter looks identical to a draft written after it until someone opens the state file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { codeOnly } from './source-text.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const panel = codeOnly(await readFile(
  path.join(root, 'apps', 'vscode', 'src', 'views', 'form-panel.ts'), 'utf8'));

test('the panel never claims the operation succeeded', () => {
  /**
   * `[UXH:REQ-071]`: "Local success MUST never be presented as operation success." The panel can
   * say a field is missing. It cannot say "done" — the only honest evidence is the operation's own
   * envelope, which arrives as a result card from the same executor a CLI invocation goes through.
   */
  assert.ok(!/Submitted|Success|succeeded|showInformationMessage/i.test(panel),
    'the panel reports an outcome it has not seen');
  // It hands off and closes instead.
  assert.match(panel, /panel\.dispose\(\);\s*void submit\?\./);
});

test('a draft is filtered on the way to storage, not only on the way back', () => {
  // Once a confirmation reaches workspace state the rule is already broken: a later reader
  // declining to restore it does not unwrite it, and the state file is one someone can open.
  // One write, and its payload is what `draftRecord` allowed rather than what the form collected.
  const writes = [...panel.matchAll(/store\.update\((.*)\);/g)].map((match) => match[1]);
  assert.equal(writes.length, 1, `${writes.length} paths write to workspace state`);
  assert.match(writes[0], /draftRecord\(schemaId, values\)$/);
  assert.match(panel, /readDraft\(/, 'and the version check happens on the way back');
});

test('the stylesheet carries the render nonce', () => {
  /**
   * The failure with no symptom. `style-src 'nonce-…'` drops an un-nonced `<style>` silently: the
   * markup is byte-identical, the page renders, and every rule is simply gone. It shipped that way
   * once in `result-panel.ts` and was found by opening the editor.
   */
  assert.match(panel, /<style nonce="\$\{token\}">/);
});

test('the accepted messages are a closed, enumerable set', () => {
  // `[UXH:REQ-134]` `[UXH:AC-014]`. A webview is a separate document and its messages are input.
  assert.match(panel, /createMessageRouter\('singularityFlow\.form'/);
  assert.match(panel, /'sflow\.form\.draft':/);
  assert.match(panel, /'sflow\.form\.submit':/);
  // And a payload that is not JSON is a caught throw at the boundary, not a shape a handler assumes.
  assert.match(panel, /try \{\s*const parsed: unknown = JSON\.parse\(raw\)/);
});

test('a ceremony field is excluded from the draft message and included in the submit message', () => {
  /**
   * `[UXH:AC-004]` in the one place it is a *client-side* rule: a confirmation must be typed and
   * must be sent, and must never come back on its own. The script's two collections differ by
   * exactly that.
   */
  assert.match(panel, /collect\(false\)/, 'the draft message excludes ceremony fields');
  assert.match(panel, /collect\(true\)/, 'the submit message includes them');
  assert.match(panel, /if \(!includeCeremony && input\.hasAttribute\('data-no-draft'\)\) continue;/);
});

test('what is submitted has the types the operation declares', () => {
  // `[UXH:AC-011]`. `checkForm` coerces internally, so a panel that sent its raw collection would
  // pass its own check and be refused by the operation — the one place the conversion did not
  // happen, and invisible from either end.
  assert.match(panel, /values: coerceForm\(request\.schemaId, parsed\)/);
});

test('a schema this build does not have is refused rather than rendered empty', () => {
  // An empty form submits nothing and looks like a form for a schema with no fields, which several
  // schemas legitimately are.
  assert.match(panel, /if \(!view\) return false;/);
});
