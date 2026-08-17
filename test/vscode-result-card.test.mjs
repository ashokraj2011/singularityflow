/**
 * The result card, against the envelope a real planner produces.
 *
 * The fixture is not hand-written: it comes from `workReadinessResult`, so the card is tested
 * against the shape the product actually emits. A hand-built fixture drifts from its producer and
 * then the card passes while the screen is wrong.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { codeOnly } from './source-text.mjs';
import { REASON_CODES } from '../src/gateway/catalog.mjs';
import { KERNEL_MESSAGES } from '../src/gateway/kernel.mjs';
import { RESOLUTION_MESSAGES } from '../src/gateway/resolve.mjs';
import { workReadinessResult } from '../src/gateway/planners/work-readiness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const view = (name) => path.join(root, 'apps', 'vscode', 'src', 'views', name);
const { buildResultCard, gateSummary } = await import(view('result-card-model.ts'));
const { RESULT_CARD_STYLE, resultCardHtml } = await import(view('result-card-page.ts'));
const { RESULT_MESSAGES, fill, message } = await import(view('result-messages.ts'));

const blocked = (blockers) => workReadinessResult({
  id: 'PAY-1187', kind: 'story', phase: 'implement', generation: 3, group: 'active',
  blockers, nextAction: { operation: 'work.continue', reasonCode: 'work.resume-phase' }, lastMaterialEvent: null
});

test('every catalog code and narration ID has a sentence', () => {
  /**
   * The other half of the catalog. Enumerating codes is only worth doing if something turns each
   * one into words, and the failure mode without this test is a dotted identifier on screen.
   */
  const missing = [...REASON_CODES, ...KERNEL_MESSAGES, ...RESOLUTION_MESSAGES]
    .filter((code) => !RESULT_MESSAGES[code]);
  assert.deepEqual(missing, [], `codes with no message:\n  ${missing.join('\n  ')}`);
});

test('no message exists for a code nothing can emit', () => {
  const known = new Set([...REASON_CODES, ...KERNEL_MESSAGES, ...RESOLUTION_MESSAGES]);
  const orphans = Object.keys(RESULT_MESSAGES).filter((code) => !known.has(code));
  assert.deepEqual(orphans, [], `messages for codes that do not exist:\n  ${orphans.join('\n  ')}`);
});

test('an unfilled slot keeps its name rather than vanishing', () => {
  // "3 file(s) changed" silently becoming " file(s) changed" reads as zero, which is worse than
  // reading as a bug.
  assert.equal(fill('{files} file(s) changed', { files: 3 }), '3 file(s) changed');
  assert.equal(fill('{files} file(s) changed', {}), '{files} file(s) changed');
});

test('a code with no wording renders as itself, not as nothing', () => {
  const unknown = message('readiness.from-the-future');
  assert.equal(unknown.label, 'readiness.from-the-future');
  assert.match(unknown.detail, /no wording/);
});

test('the headline carries the gate count, and it matches the checklist', () => {
  /**
   * Screen A: "Not ready to submit — 2 of 5 gates unmet". Two unmet gates plus four unevaluated
   * ones is six outstanding of seven, so the number is whatever the checklist says — the point is
   * that it is derived from the rows and not counted a second time.
   */
  const card = buildResultCard(blocked(['approvals-outstanding', 'required-artifact-missing']));
  assert.equal(card.tone, 'read');
  assert.equal(card.gates.total, card.checklist.length);
  assert.equal(card.gates.outstanding, card.checklist.filter((row) => row.state !== 'met').length);

  /**
   * "Unmet" counts only the gates that were evaluated.
   *
   * The first version said "6 of 7 gates unmet" when two had failed and four had never been read,
   * which throws away the unmet/unknown distinction in the one line most readers stop at.
   */
  assert.equal(card.gates.unmet, 2);
  assert.equal(card.headline, 'Not ready to submit — 2 of 7 gates unmet, 4 not evaluated');

  // A readiness read that finds nothing wrong is not headlined as a problem.
  assert.equal(buildResultCard(blocked([])).headline, 'Here is what SFlow found — 4 of 7 gates not evaluated');

  // The status bar derives the same numbers from the same function `[UXH:AC-002]`.
  assert.deepEqual(gateSummary(blocked(['approvals-outstanding', 'required-artifact-missing'])), card.gates);
});

test('unmet and unknown are never rendered as the same thing', () => {
  /**
   * `[UXH:REQ-062]`. A gate nobody evaluated and a gate that failed look identical on a screen that
   * only lists problems, and the reader who acts on that screen submits against an untested change.
   */
  const card = buildResultCard(blocked(['approvals-outstanding']));
  const unmet = card.checklist.find((row) => row.id === 'approvals-outstanding');
  const unknown = card.checklist.find((row) => row.id === 'tests');
  const met = card.checklist.find((row) => row.id === 'publication-pending');

  assert.equal(unmet.state, 'unmet');
  assert.equal(unknown.state, 'unknown');
  assert.equal(met.state, 'met');
  assert.equal(new Set([unmet.icon, unknown.icon, met.icon]).size, 3, 'three states, three icons');
  assert.match(unknown.detail, /Not evaluated/);
  // An `unknown` row claims no evidence, because nothing was read.
  assert.equal(unknown.evidence, null);
  assert.equal(met.evidence, 'PAY-1187');
});

test('a gate with a remediation carries its own fix action', () => {
  const card = buildResultCard(blocked(['required-artifact-missing']));
  const row = card.checklist.find((entry) => entry.id === 'required-artifact-missing');
  assert.ok(row.action, 'the row has a fix action');
  assert.equal(row.action.id, 'fix:required-artifact-missing');

  // A gate only a person can clear offers no button — that would be an invitation to go and do it.
  const waiting = buildResultCard(blocked(['approvals-outstanding']))
    .checklist.find((entry) => entry.id === 'approvals-outstanding');
  assert.equal(waiting.action, null);
});

test('the card renders the preservation sentence, and renders it last', () => {
  /**
   * `[DHR:REQ-061]` and Screen A's closing line. A refusal envelope always carries it; this asserts
   * it survives all the way to the markup rather than being dropped by the renderer.
   */
  const refusal = {
    schemaVersion: 2, resultType: 'sflow-result', kind: 'refusal',
    operation: { id: 'work.continue', classification: 'read' }, subject: null,
    outcome: { status: 'refused', messageId: 'gateway.refused', slots: {} },
    effects: { contextChanged: false, stateChanged: false, filesChanged: false, gitRefsChanged: false, publicationCreated: false, externalSystemsChanged: false },
    why: [{ code: 'work.not-in-this-repository', source: 'lifecycle', reference: null, slots: {} }],
    warnings: [], checklist: [],
    preserved: [{ code: 'work.nothing-was-carried-out', source: 'deterministic', scope: 'all', reference: null, slots: {} }],
    next: [], restState: 'blocked', data: {}
  };
  const card = buildResultCard(refusal);
  assert.equal(card.tone, 'refusal');
  assert.equal(card.preserved.length, 1);

  const html = resultCardHtml(card);
  assert.match(html, /sf-card-refusal/);
  assert.match(html, /Nothing was carried out/);
  assert.ok(html.indexOf('sf-card-preserved') > html.indexOf('sf-card-why'),
    'the preservation statement comes after the reason');
  // Never a dead end: with no actions, the rest state is stated in words `[INT:REQ-041]`.
  assert.match(html, /no step you can take/);
});

test('the card never renders a raw handle or an operation name into the DOM', () => {
  /**
   * A click carries the stable action id; the host looks it up and dispatches through the executor,
   * which re-resolves. A handle in the DOM is reachable from anything that reaches the webview.
   */
  const card = buildResultCard(blocked(['required-artifact-missing']));
  const html = resultCardHtml(card);
  assert.match(html, /data-action-id="fix:required-artifact-missing"/);
  assert.ok(!html.includes('readiness:PAY-1187:'), 'the handle is not in the markup');
});

test('technical details are copyable and carry no path or prompt', () => {
  const card = buildResultCard(blocked(['approvals-outstanding']));
  assert.equal(card.details.operation, 'work.readiness');
  assert.equal(card.details.status, 'succeeded');
  assert.equal(card.details.effects, 'none');
  // `[UXH:REQ-065]`: built by naming fields, so a producer putting a path in `data` does not
  // silently start rendering it here.
  assert.ok(!Object.values(card.details).some((value) => value.startsWith('/')));
  // Copyable is a property of the stylesheet, not the fragment: the details block selects on drag.
  assert.match(RESULT_CARD_STYLE, /\.sf-card details pre \{[^}]*user-select: text/);
  assert.match(resultCardHtml(card), /<details><summary>Technical details<\/summary>/);
});

test('a fix action is not repeated below the rows it already appears on', () => {
  // The same action twice makes a reader wonder whether they are different `[UXH:REQ-064]`.
  const card = buildResultCard(blocked(['required-artifact-missing']));
  const html = resultCardHtml(card);
  const occurrences = html.split('data-action-id="fix:required-artifact-missing"').length - 1;
  assert.equal(occurrences, 1);
});

test('every gate row names its state for a screen reader', () => {
  // The icon is aria-hidden, so without this a reader hears seven gate names and no indication
  // which two are the reason nothing can be submitted.
  const html = resultCardHtml(buildResultCard(blocked(['approvals-outstanding'])));
  assert.match(html, /aria-label="Approvals: unmet"/);
  assert.match(html, /aria-label="Tests: unknown"/);
});

test('a gate label is neutral, so it does not contradict its own row', () => {
  /**
   * The labels were first written in the satisfied voice, which reads correctly beside a checkmark
   * and is a contradiction beside a warning icon: "⚠ Approvals recorded" on the row that is the
   * reason nothing can be submitted. Found by rendering the card and reading it, not by a test.
   */
  const card = buildResultCard(blocked(['approvals-outstanding']));
  const unmet = card.checklist.find((row) => row.id === 'approvals-outstanding');
  const met = card.checklist.find((row) => row.id === 'publication-pending');
  assert.equal(unmet.label, 'Approvals');
  assert.equal(met.label, 'Publication');
  for (const row of card.checklist) {
    assert.ok(!/\b(recorded|complete|present|current|answered|claimed)\b/.test(row.label),
      `'${row.label}' asserts a state the row's own icon may contradict`);
  }
});

test('a fix button names the step, not the blocker identifier', () => {
  // It read `required-artifact-missing` — the internal name, where a reader looks for a verb.
  const card = buildResultCard(blocked(['required-artifact-missing']));
  const row = card.checklist.find((entry) => entry.id === 'required-artifact-missing');
  assert.equal(row.action.label, 'Continue this work');
  assert.equal(row.action.detail, 'Produce the artifact');
});

test('a reason already shown as a gate row is not repeated above it', () => {
  // Correct in the envelope — a consumer with no checklist needs the reasons — and duplication on a
  // card that renders both, which makes a reader hunt for a difference that is not there.
  const card = buildResultCard(blocked(['approvals-outstanding', 'required-artifact-missing']));
  assert.equal(card.why.length, 1);
  assert.equal(card.why[0].label, '2 thing(s) are blocking this');
});

test('primary and secondary cannot look the same, whatever the theme sets', () => {
  /**
   * Found by eye in a real editor, not by a test: all six home actions rendered as identical filled
   * buttons because that theme resolves `button.secondaryBackground` and `button.background` to the
   * same green. The envelope carried exactly one `primary`. The rule survived in the data and died
   * in the CSS, which is the failure a contract check cannot see.
   *
   * Filled-versus-outlined is a contrast a theme cannot collapse: whatever the two variables hold,
   * a button with a background and a button without one are different.
   */
  const secondary = RESULT_CARD_STYLE.match(/\.sf-card-actions button \{[^}]*\}/)[0];
  const primary = RESULT_CARD_STYLE.match(/\.sf-card-actions button\.primary \{[^}]*\}/)[0];
  assert.match(secondary, /background: transparent/);
  assert.match(secondary, /border: 1px solid/);
  assert.match(primary, /background: var\(--vscode-button-background\)/);
  assert.ok(!secondary.includes('secondaryBackground'),
    'secondary must not depend on a variable a theme may set to the primary colour');

  const gate = RESULT_CARD_STYLE.match(/\.sf-gate button \{[^}]*\}/)[0];
  assert.match(gate, /background: transparent/, 'a fix button is never the card\'s filled action');
});

test('the phase rail renders as Screen B draws it', () => {
  /**
   * `intake ✓ design ✓ implement ● verify ○ release ○`, from the pinned definition.
   *
   * Text marks rather than icons: at a narrow sidebar width seven SVGs wrap into a grid, and the
   * rail has to stay one line of type.
   */
  const rail = [
    { id: 'intake', label: 'intake', state: 'done' },
    { id: 'design', label: 'design', state: 'done' },
    { id: 'implement', label: 'implement', state: 'current' },
    { id: 'verify', label: 'verify', state: 'pending' },
    { id: 'release', label: 'release', state: 'pending' }
  ];
  const card = buildResultCard({
    schemaVersion: 2, resultType: 'sflow-result', kind: 'read',
    operation: { id: 'home.overview', classification: 'read' }, subject: null,
    outcome: { status: 'succeeded', messageId: 'gateway.home', slots: {} },
    effects: { contextChanged: false, stateChanged: false, filesChanged: false, gitRefsChanged: false, publicationCreated: false, externalSystemsChanged: false },
    why: [], warnings: [], preserved: [], checklist: [], next: [], restState: 'informational',
    data: { rail, personalization: { source: 'git-identity', displayName: 'A<script>', replyName: 'A<script>' } }
  });
  assert.equal(card.rail.length, 5);
  assert.equal(card.replyName, 'A<script>');

  const html = resultCardHtml(card);
  assert.match(html, /Hello, A&lt;script&gt;\./);
  assert.doesNotMatch(html, /Hello, A<script>\./);
  const marks = [...html.matchAll(/class="sf-rail-mark" aria-hidden="true">(.)</g)].map(([, mark]) => mark);
  assert.deepEqual(marks, ['✓', '✓', '●', '○', '○']);
  // A screen reader hears the position, not five names in a row.
  assert.match(html, /aria-label="implement: current"/);
  assert.match(html, /aria-label="release: pending"/);
});

test('a result with no rail renders none', () => {
  // An empty rail is nothing; a rail of all-pending phases would draw a lifecycle for work nobody
  // has started.
  const card = buildResultCard(blocked(['approvals-outstanding']));
  assert.deepEqual(card.rail, []);
  assert.ok(!resultCardHtml(card).includes('sf-rail'));
});

test('the rail is read from a named field, never spread from data', () => {
  // A producer that starts putting something else in `data` does not start rendering it.
  const model = readFileSync(new URL('../apps/vscode/src/views/result-card-model.ts', import.meta.url), 'utf8');
  assert.match(model, /rail: Array\.isArray\(result\.data\?\.rail\)/);
});

test('an action carries how it is dispatched, so the host does not have to guess', async () => {
  /**
   * `executable` changes nothing on screen, which is why it was omitted — and the host then had to
   * invent one, forcing `false` on every press. That is right for a disambiguation choice and wrong
   * for a read handle: pressing the single primary on a "Ready to go" card resolved a read handle
   * as a selection and returned "that choice is no longer current", a stale-handle refusal with
   * nothing stale about it.
   *
   * Found by pressing the button in a real window. Every fixture rendered the card correctly.
   */
  const card = buildResultCard({
    schemaVersion: 2,
    kind: 'read',
    operation: { id: 'impact.quick', classification: 'read' },
    subject: { kind: 'repository', id: 'calc' },
    outcome: { status: 'succeeded', messageId: 'gateway.ready', slots: {} },
    effects: {},
    why: [],
    next: [
      { id: 'resolved:impact.quick', label: 'quick impact analysis', handle: 'h1', executable: true,
        reasonCode: 'gateway.ready', emphasis: 'primary', interaction: 'navigation' },
      { id: 'candidate:impact.quick', label: 'quick impact analysis', handle: 'h2', executable: false,
        reasonCode: 'gateway.ready', emphasis: 'secondary', interaction: 'navigation' }
    ],
    data: {}
  });
  assert.equal(card.actions[0].executable, true, 'a read handle is read');
  assert.equal(card.actions[1].executable, false, 'a candidate is selected and re-resolved');

  // And the host dispatches what the envelope said rather than overriding it.
  const source = codeOnly(await readFile(path.join(root, 'apps', 'vscode', 'src', 'extension.ts'), 'utf8'));
  assert.ok(!/executor\.execute\(\{[^}]*executable: false/.test(source),
    'the host is still forcing a dispatch mode onto every action');
  assert.match(source, /executor\.execute\(action\)/);
  assert.match(source, /outcome\.outcome === 'ceremony'[\s\S]{0,700}createTerminal/,
    'a ceremony returned by the executor must open its governed host surface rather than disappear');
});
