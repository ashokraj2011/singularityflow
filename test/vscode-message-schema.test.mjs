/**
 * The webview message boundary. `[UXH:REQ-134]` `[UXH:AC-014]`
 *
 * A webview is a separate document running with the extension's privileges on the other side of
 * `postMessage`. The boundary already coerces field by field; what it lacked was a *closed* set of
 * accepted types, so an unrecognised message was silently ignored — indistinguishable from one that
 * was handled — and no panel could say what it speaks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { codeOnly } from './source-text.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const views = path.join(root, 'apps', 'vscode', 'src');
const messages = await import(path.join(views, 'views', 'messages.ts'));

/**
 * How many message handlers have not moved to the router yet.
 *
 * The ratchet idiom this repository already uses for unimplemented planners: a number that only
 * goes down, asserted for equality so it tracks reality instead of drifting above it. Migrating 26
 * panels in one change would be a large rewrite of working, individually-defensive code; stating
 * the count is how the remainder stays visible instead of becoming the permanent status quo.
 */
const UNMIGRATED_MESSAGE_HANDLERS = 25;

async function sources(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await sources(full));
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

test('a payload that is not a message is refused before any handler sees it', () => {
  for (const bad of [null, undefined, 42, 'sflow.action', [], [{ type: 'sflow.action' }], {}, { type: 7 }, { type: '' }]) {
    assert.equal(messages.inboundMessage(bad), null, `${JSON.stringify(bad)} was accepted`);
  }
  // An array is an object, and would otherwise reach a handler as one.
  assert.equal(messages.inboundMessage([{ type: 'sflow.action' }]), null);
  assert.deepEqual(messages.inboundMessage({ type: 'sflow.action', actionId: 'x' }),
    { type: 'sflow.action', actionId: 'x' });
});

test('an unrecognised type is reported, never dropped', () => {
  /**
   * The property that was missing. A silently ignored message looks exactly like a handled one, so
   * the bug it hides is a button that does nothing and a maintainer who cannot tell whether the
   * message even arrived.
   */
  const seen = [];
  const router = messages.createMessageRouter('panel', { known: () => 'handled' }, (type, panel) => seen.push([panel, type]));

  assert.equal(router.route({ type: 'known' }), 'handled');
  assert.equal(router.route({ type: 'unknown' }), undefined);
  assert.equal(router.route('nonsense'), undefined);
  assert.deepEqual(seen, [['panel', 'unknown'], ['panel', '(malformed)']]);
});

test('the accepted set is enumerable, which is the whole point', () => {
  // A reviewer, a fuzzer and the next maintainer all need to ask a panel what it speaks. An
  // if-chain cannot answer; the router's keys are the contract.
  const router = messages.createMessageRouter('panel', { a: () => {}, b: () => {} });
  assert.deepEqual(router.accepts, ['a', 'b']);
});

test('field readers do not turn absent values into usable ones', () => {
  /**
   * `String(value ?? '')` — the coercion several handlers use — turns `undefined`, `null`, `0` and
   * `false` into strings a handler then acts on. Absent and empty are different facts.
   */
  const message = { type: 't', name: 'real', blank: '', zero: 0, no: false, yes: true, tab: 'agents' };
  assert.equal(messages.stringField(message, 'name'), 'real');
  assert.equal(messages.stringField(message, 'blank'), null);
  assert.equal(messages.stringField(message, 'zero'), null);
  assert.equal(messages.stringField(message, 'missing'), null);

  assert.equal(messages.booleanField(message, 'yes'), true);
  assert.equal(messages.booleanField(message, 'no'), false);
  // Only `true` is true, so a truthy string does not flip a flag.
  assert.equal(messages.booleanField({ type: 't', flag: 'true' }, 'flag'), false);

  assert.equal(messages.enumField(message, 'tab', ['agents', 'prompts']), 'agents');
  assert.equal(messages.enumField(message, 'tab', ['prompts']), null,
    'a value outside the enumeration cannot put a panel into a state it does not have');
});

test('the result panel routes through the closed set', async () => {
  const source = codeOnly(await readFile(path.join(views, 'views', 'result-panel.ts'), 'utf8'));
  assert.match(source, /createMessageRouter\('singularityFlow\.result'/);
  assert.match(source, /'sflow\.action':/);
  // The raw cast it replaced is gone.
  assert.ok(!/raw as \{ type\?: unknown/.test(source));
});

test('the unmigrated handler count only goes down', async () => {
  /**
   * Asserted for equality, not as a ceiling. A ratchet that permits fewer is a ratchet nobody
   * lowers — the repository already learned this with `MAX_UNIMPLEMENTED_GATEWAY_PLANNERS`.
   */
  const unmigrated = [];
  for (const file of await sources(views)) {
    const source = codeOnly(await readFile(file, 'utf8'));
    if (!source.includes('onDidReceiveMessage')) continue;
    if (!source.includes('createMessageRouter')) unmigrated.push(path.basename(file));
  }
  assert.equal(unmigrated.length, UNMIGRATED_MESSAGE_HANDLERS,
    `${unmigrated.length} handlers are not on the closed router (${unmigrated.join(', ')});`
    + ' lower the count when you migrate one');
});
