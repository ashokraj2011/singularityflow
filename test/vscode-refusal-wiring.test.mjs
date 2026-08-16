/**
 * Refusals reach the reader as cards. `[UXH:CON-007]` `[UXH:AC-003]`
 *
 * Two halves: the adapter that turns whatever the CLI returned into a card, and a ratchet on the
 * call sites. The ratchet is the part that lasts — the conversion is easy to do once and easy to
 * undo one `showErrorMessage` at a time, which is how a codebase drifts back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const view = (name) => path.join(root, 'apps', 'vscode', 'src', 'views', name);
const { fidelityNote, refusalFor } = await import(view('refusal.ts'));

const cliError = (message, stderr = '', exitCode = 1) =>
  Object.assign(new Error(message), { stderr, exitCode, name: 'CliError' });

const V1 = JSON.stringify({
  schemaVersion: 1,
  resultType: 'command-result',
  operation: { id: 'story.submit', classification: 'mutation' },
  subject: { kind: 'story', id: 'PAY-1187' },
  outcome: { status: 'refused', messageId: 'submit.refused', slots: {} },
  effects: { stateChanged: false, filesChanged: false, publicationCreated: false, externalSystemsChanged: false },
  why: [{ code: 'work.blocked.approvals-outstanding', source: 'lifecycle', slots: {} }],
  next: [{ label: 'Check readiness', command: 'sflow status --work-id PAY-1187', reasonCode: 'work.check-readiness' }],
  restState: null,
  data: {}
});

test('no refusal site shows a bare error toast', async () => {
  /**
   * The ratchet. Every one of the 37 sites was `showErrorMessage(error.message)`, which is a dead
   * end: no reason, no statement of what survived, nothing to do but dismiss it.
   *
   * `showErrorMessage` is not banned outright — `result-panel.ts` keeps one as the last resort for a
   * failure to render a failure, and that is the only place it belongs.
   */
  const offenders = [];
  for (const file of ['extension.ts', 'actions.ts']) {
    const source = await readFile(path.join(root, 'apps', 'vscode', 'src', file), 'utf8');
    if (source.includes('showErrorMessage')) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `these still toast refusals: ${offenders.join(', ')}`);

  /**
   * `navigate.ts` keeps its toast, and the exemption is the interesting part.
   *
   * It reports that a *view could not be opened*. Answering that by opening a webview panel is
   * asking the thing that just failed to do it again — and if it fails the same way, the reader is
   * told nothing at all. A toast is the correct surface for a failure of the surface.
   */
  const navigate = await readFile(path.join(root, 'apps', 'vscode', 'src', 'views', 'navigate.ts'), 'utf8');
  assert.equal(navigate.split('showErrorMessage').length - 1, 1);
  assert.match(navigate, /Could not open the Singularity Flow view/);

  // Calls, not mentions: the panel's own docblock names the thing it replaces.
  const panel = (await readFile(view('result-panel.ts'), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(panel.split('showErrorMessage(').length - 1, 1,
    'the panel keeps exactly one last-resort toast, for a failure to render a failure');
});

test('a v1 command-result becomes a card, with preservation derived from its effects', () => {
  const { view: card, fidelity } = refusalFor(cliError('Submit refused.', V1));
  assert.equal(fidelity, 'command-result-v1');
  assert.equal(card.tone, 'refusal');
  assert.equal(card.why[0].label, 'Approvals are outstanding');
  /**
   * v1 has no `preserved[]` — the field regressed out of v2 and was restored by this work — so the
   * statement is computed from the declared effects record rather than written next to a throw.
   */
  assert.equal(card.preserved.length, 1);
  assert.match(card.preserved[0].label, /Nothing was carried out/);
  assert.equal(card.actions[0].command, 'sflow status --work-id PAY-1187');
  assert.equal(card.actions[0].emphasis, 'primary');
});

test('a v1 result that did change something makes no preservation claim', () => {
  // The check that keeps the derivation honest: a half-applied command must not be described as
  // having left everything alone `[DHR:CON-060]`.
  const changed = JSON.parse(V1);
  changed.effects.filesChanged = true;
  const { view: card } = refusalFor(cliError('Failed midway.', JSON.stringify(changed)));
  assert.deepEqual(card.preserved, []);
  assert.equal(card.details.effects, 'filesChanged');
});

test('an error with no structured result claims nothing about preservation', () => {
  /**
   * The most tempting place to lie. "Your work is untouched" is almost always true and is exactly
   * what a refused reader wants to read — and nothing in a bare error message says so.
   */
  const { view: card, fidelity } = refusalFor(cliError('Something went wrong.', 'stack trace here'));
  assert.equal(fidelity, 'message-only');
  assert.deepEqual(card.preserved, []);
  assert.equal(card.why[0].label, 'Something went wrong.');
  assert.match(fidelityNote(fidelity), /no statement here about what was preserved/);
});

test('a caller headline is used only when the result named nothing itself', () => {
  const plain = refusalFor(cliError('boom'), { headline: 'Could not switch workspace' });
  assert.equal(plain.view.headline, 'Could not switch workspace');

  // A structured result names its own outcome from the catalog; a caller's summary of its own
  // intent must not replace that fact with a paraphrase.
  const structured = refusalFor(cliError('boom', V1), { headline: 'Could not switch workspace' });
  assert.notEqual(structured.view.headline, 'Could not switch workspace');
});

test('a structured result is found even when stderr also carries prose', () => {
  // The CLI prints human lines and JSON in either order depending on the failure.
  const noisy = `Singularity Flow error: submit refused\n${V1}\nSee the log for details.`;
  assert.equal(refusalFor(cliError('x', noisy)).fidelity, 'command-result-v1');
});

test('unparseable stderr degrades to message-only rather than throwing', () => {
  const { fidelity } = refusalFor(cliError('x', '{ not json at all }'));
  assert.equal(fidelity, 'message-only');
});

test('the fidelity of a card is stated, never implied', () => {
  // A reader who can see that a refusal carried no structured result knows why it is thinner than
  // the last one, instead of concluding the product is inconsistent.
  assert.equal(fidelityNote('sflow-result-v2'), null);
  assert.match(fidelityNote('command-result-v1'), /older result contract/);
  assert.match(fidelityNote('message-only'), /did not report a structured result/);
});
