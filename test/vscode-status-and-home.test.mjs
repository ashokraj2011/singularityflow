/**
 * The status bar and the home: one derivation, one menu, one way back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { codeOnly } from './source-text.mjs';
import { RESULT_MESSAGES, message } from '../src/gateway/messages.mjs';
import { REASON_CODES } from '../src/gateway/catalog.mjs';
import { KERNEL_MESSAGES } from '../src/gateway/kernel.mjs';
import { RESOLUTION_MESSAGES } from '../src/gateway/resolve.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFile(path.join(root, ...parts), 'utf8');

test('the status bar returns to your work rather than refreshing it', async () => {
  /**
   * `[UXH:REQ-040]`. It was wired to `singularityFlow.refresh`, so the one always-visible piece of
   * SFlow chrome answered a click by re-reading the repository and leaving the reader where they
   * were. Refresh is what you ask for when you think the screen is stale; it is not "take me back".
   */
  const source = codeOnly(await read('apps', 'vscode', 'src', 'extension.ts'));
  assert.match(source, /status\.command = 'singularityFlow\.myWork'/);
  assert.ok(!/status\.command = 'singularityFlow\.refresh'/.test(source));
});

test('the status bar and the card count gates with the same function', async () => {
  /**
   * `[UXH:AC-002]`, and the reason it is an acceptance criterion: two surfaces that each count for
   * themselves will eventually disagree, and the disagreement is invisible until someone puts both
   * in one screenshot. The status bar calls `gateSummary`, which is what the card's own model uses.
   */
  const source = codeOnly(await read('apps', 'vscode', 'src', 'extension.ts'));
  assert.match(source, /gateSummary\(await kernel\.read\(/);
  assert.match(source, /gates \$\{gates\.met\}\/\$\{gates\.total\}/);

  const model = codeOnly(await read('apps', 'vscode', 'src', 'views', 'result-card-model.ts'));
  assert.match(model, /export function gateSummary/);
  assert.match(model, /return buildResultCard\(result\)\.gates/);
});

test('a gate count that cannot be read is absent, not zero', async () => {
  // "No gates" and "we could not ask" are different facts, and `gates 0/0` asserts the first.
  const source = codeOnly(await read('apps', 'vscode', 'src', 'extension.ts'));
  assert.match(source, /const gateCountFor = async[\s\S]{0,700}?return null;\s*\}\s*\};/);
});

test('a late gate count for the previous Story is discarded', async () => {
  const source = codeOnly(await read('apps', 'vscode', 'src', 'extension.ts'));
  assert.match(source, /if \(!gates \|\| statusWorkId !== renderedFor\) return;/);
});

test('the home renders one menu, from the envelope', async () => {
  /**
   * It printed the projection's four choices directly below the kernel's six — two independent
   * answers to "what can I do", stacked, in the command whose purpose is to show a surface reading
   * the kernel instead of deriving in parallel.
   */
  const source = codeOnly(await read('src', 'commands', 'home.mjs'));
  assert.match(source, /const menu = envelope\.next\.filter/);
  assert.ok(!/choices\.forEach/.test(source), 'the projection is no longer a second menu');
  // The primary is hoisted out of the list, so the computed step and the goals are not peers.
  assert.match(source, /action\.id !== leads\?\.id/);
});

test('the message catalog is in core, where both surfaces can reach it', async () => {
  /**
   * It lived in `apps/vscode/` and the CLI immediately printed `home.stable-choice` where a
   * sentence belonged — a second vocabulary opening in the place a catalog exists to prevent one.
   */
  assert.ok(RESULT_MESSAGES['home.stable-choice'], 'core owns the table');
  const shim = codeOnly(await read('apps', 'vscode', 'src', 'views', 'result-messages.ts'));
  assert.match(shim, /from '\.\.\/\.\.\/\.\.\/\.\.\/src\/gateway\/messages\.mjs'/);
  assert.ok(!shim.includes("M('"), 'the editor no longer holds a copy of the words');
});

test('every code a result can carry still has a sentence, after the move', () => {
  const missing = [...REASON_CODES, ...KERNEL_MESSAGES, ...RESOLUTION_MESSAGES]
    .filter((code) => !RESULT_MESSAGES[code]);
  assert.deepEqual(missing, []);
  assert.equal(message('home.stable-choice').label, 'Always available');
});

test('the home falls back to the catalog, not to a raw code', async () => {
  // The envelope is the only projection now, and its reason always renders through the catalog.
  const source = codeOnly(await read('src', 'commands', 'home.mjs'));
  assert.match(source, /message\(action\.reasonCode\)\.label/);
  assert.doesNotMatch(source, /detail\.get\(goal\)/);
});
