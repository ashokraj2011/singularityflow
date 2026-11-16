/**
 * "Why is it giving something that is not clearly understood" [owner, 2026-11-16]. The decisions card in a real Copilot
 * CLI session showed one open Node choice, a sign-off nobody could give yet and one thing SFlow had settled as a table of
 * internal words, repeated below itself, recommending nothing and telling the person to run a check SFlow can run
 * itself; its first form then counted ("1 still need a decision from you") and asked "How do you want to decide?".
 *
 * The same shape here, from the engine's own builder (a generic Story, no person's name): each surface prints the same
 * plain words, every item recommends, the check is SFlow's and comes first until it has a result, the sign-off is one
 * "Later:" line, the settled choice one line with its Undo, and one open item is asked directly.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { packetText } from '../src/commands/decisions.mjs';
import { decisionPacket } from '../src/decision-list.mjs';
import { DEFAULT_SECONDS, itemsToCheck, LONGEST_SECONDS, PROBE_KINDS, probeSeconds, runDecisionProbes } from '../src/decision-probes.mjs';
import { withPlainWords } from '../src/decision-plain.mjs';
import { recordSettledDecision } from '../src/settled-decisions.mjs';
import { CHECK_FIRST_SECONDS, CHECK_SECONDS, decisionsTable, directForm, directItem, firstForm, KEEP_SETTLED, LEAVE, RECORD, runCard } from '../plugin/extensions/decisions/card.mjs';
import { decideHtml } from '../apps/vscode/src/views/decide-card-page.ts';

const AT = '2026-11-16T09:20:00.000Z';
const W = 'WORK-7';
const group = (label) => ({ label, allowAnyGitIdentity: true, members: [] });

function story() {
  const workflow = { workItem: { id: W }, status: 'in_progress', currentPhase: 'implementation', phaseOrder: ['specification', 'implementation'],
    phases: { specification: { id: 'specification', label: 'Specification', status: 'approved', generation: 1, approvalPolicy: { authorities: ['product'] } },
      implementation: { id: 'implementation', label: 'Implementation', status: 'in_progress', generation: 1, writeScope: 'source-and-artifact', approvalPolicy: { authorities: ['engineering'] } } },
    resolution: { approvalAuthorities: { product: group('Product approvers'), engineering: group('Engineering reviewers') }, plannedClaims: { owners: { [`${W}:AC-001`]: 'specification' } } },
    history: [] };
  // What SFlow settled for the person: the Story this session opened, from the branch checked out.
  recordSettledDecision(workflow, { kind: 'story-selection', subject: `${W} on work-7`, answer: `Opened ${W}: the only Story whose branch, work-7, is checked out where this session runs.`,
    evidence: [{ what: `work-7 is ${W}'s own branch, recorded in its Story record`, where: `singularity/work-items/${W}/workflow.json on work-7` },
      { what: 'no other Story records a branch checked out where this session runs', where: 'the session\'s checkout' }], by: 'sflow', at: AT });
  return workflow;
}

// The engine's own words for this Node, as the incident's card showed them: what the plain words must not repeat.
const ENGINE_WORDS = 'Tests here would run on Node 26.12.0, whose own localStorage stands in front of the DOM environment\'s under Vitest. Tests that use localStorage then fail with errors such as "Cannot read properties of undefined (reading \'clear\')", and the change is not the cause. Also installed here: Node 22.14.0.';
const pin = (probe) => ({ phase: 'implementation', file: '.nvmrc', version: '22', node: '22.14.0', running: '26.12.0', words: ENGINE_WORDS, stage: 'failed', commandId: 'unit',
  cause: 'Node 26.12.0 here breaks tests that use localStorage; Node 22.14.0 is installed', probe,
  ...(probe.status === 'checked' ? { tried: { passed: probe.passed, known: true, current: true, words: `It ${probe.passed ? 'passes' : 'does not pass'} on Node 22.14.0 (12 of 12 passed).` } } : {}) });
// A sign-off of a screenshot no step has published yet.
const owed = [{ kind: 'witness', clauseId: `${W}:AC-001`, slot: 'visual', method: 'visual', files: [`singularity/work-items/${W}/evidence/screen-2.png`], owners: ['implementation'],
  available: false, contextBinding: `sha256:${'c'.repeat(64)}` }];
// As `decisions` reads it for every host: the engine's list, with each item's plain words (decision-list-reads.mjs).
const packetOf = (probe) => ({ ...withPlainWords(story(), decisionPacket(story(), { phaseId: 'implementation', gaps: [], issues: [], nodePin: pin(probe), pending: { owed }, state: {} },
  { authorities: story().resolution.approvalAuthorities, actor: { name: 'Person', email: 'person@example.invalid' }, at: AT })), packetSha256: `sha256:${'a'.repeat(64)}`, repositoryPath: '/repo' });

const BEFORE = packetOf({ status: 'unknown', cutShort: true, seconds: 60 });
const AFTER = packetOf({ status: 'checked', passed: true });
const FAILED = packetOf({ status: 'checked', passed: false });
const text = (html) => html.replace(/<script[\s\S]*?<\/script>/gu, '').replace(/<[^>]+>/gu, ' ').replace(/&#39;/gu, '\'').replace(/&quot;/gu, '"').replace(/&amp;/gu, '&').replace(/\s+/gu, ' ');
const words = (value) => value.split(/\s+/u).filter(Boolean).length;
// What the incident's card said, and none of the hosts may say again.
const JARGON = [/stands in front of/u, /Holds this step/u, /holds its approval once it is submitted/iu, /No recommendation/u, /singularity-flow tests node/u, /\| What it is \|/u,
  /still need a decision/u, /nobody was asked/u, /SFlow settled this from the evidence below/u];

test('after SFlow checked: the Copilot CLI card says it in plain words, once, and recommends from the check', () => {
  assert.equal(decisionsTable(AFTER), [
    `**Decide ${W} · Implementation.** One question for you. Nothing is recorded until you confirm.`,
    '',
    '**Run Implementation\'s tests on Node 22?**',
    'Node 26.12.0 here breaks tests that use localStorage; Node 22.14.0 is installed.',
    'Recommended: Pin Node 22. Tests pass on Node 22 (checked).',
    '- Pin Node 22 (recommended): Creates .nvmrc with Node 22 and adds it to the plan; the code stays the same.',
    '',
    'Later: Sign off AC-001 after Implementation publishes its screenshot.',
    '',
    `**Settled for you.** SFlow opened ${W} because its branch is the one checked out here. Undo if wrong.`
  ].join('\n'));
  // The question, why, recommendation and options: about 40 to 60 words.
  const item = decisionsTable(AFTER).split('\n').slice(2, 6).join(' ');
  assert.ok(words(item) >= 30 && words(item) <= 60, `${words(item)} words: ${item}`);
});

test('before SFlow could check: "Check first" is recommended and offered first, and the person is never told to run it', () => {
  const card = decisionsTable(BEFORE);
  assert.match(card, /\nRecommended: Check first\. The check did not finish within 60 seconds\.\n- Check first: run the tests on Node 22 \(recommended\): SFlow runs them once on a copy of this checkout; nothing is recorded\.\n- Pin Node 22: Creates \.nvmrc/u);
  const item = BEFORE.items.find((entry) => entry.kind === 'node-pin');
  assert.deepEqual([item.recommended.check, item.recommended.option, item.check.status], [true, null, 'unknown']);
  // Its engine words no longer tell a person to run a command, either.
  assert.doesNotMatch(item.why, /singularity-flow tests node/u);
  // The same item once checked carries no check, and a failed check recommends leaving it, saying why.
  assert.equal(AFTER.items.find((entry) => entry.kind === 'node-pin').check, undefined);
  assert.equal(FAILED.items.find((entry) => entry.kind === 'node-pin').plain.recommended,
    'Recommended: Leave it: tests fail on Node 22 too (checked), so the Node is not the cause.');
});

test('every host says the same plain words, and none of the incident\'s', () => {
  for (const packet of [BEFORE, AFTER]) {
    const node = packet.items.find((entry) => entry.kind === 'node-pin');
    const hosts = [['Copilot CLI', decisionsTable(packet)], ['terminal', packetText(packet)], ['VS Code', text(decideHtml(packet))]];
    for (const [host, shown] of hosts) {
      for (const line of [node.plain.question, node.plain.why, node.plain.recommended, 'Later: Sign off AC-001 after Implementation publishes its screenshot.',
        `SFlow opened ${W} because its branch is the one checked out here. Undo if wrong.`]) assert.ok(shown.includes(line), `${host} lacks: ${line}\n${shown}`);
      for (const word of JARGON) assert.doesNotMatch(shown, word, host);
      // The item's text is shown once: never a table and then the same words again below it.
      assert.equal(shown.split(node.plain.why).length - 1, 1, `${host} repeats it`);
      // The sign-off nobody can give yet is the "Later:" line, never a row or a question of its own.
      assert.doesNotMatch(shown, /Sign off AC-001 \(visual\)/u, host);
    }
    assert.ok(packetText(packet).startsWith(`Decide ${W} · Implementation. One question for you.\n`), packetText(packet));
  }
  assert.deepEqual(AFTER.plain, { headline: 'One question for you.', later: ['Sign off AC-001 after Implementation publishes its screenshot.'] });
});

test('one open item is asked directly: its question, its recommended option first, and the settled line kept unless undone', () => {
  assert.equal(directItem(AFTER).kind, 'node-pin');
  const { form } = directForm(AFTER);
  assert.deepEqual(Object.keys(form.requestedSchema.properties), ['decision0', 'settled0'], 'no "How do you want to decide?", no sign-off');
  assert.deepEqual(form.requestedSchema.required, ['decision0']);
  assert.equal(form.requestedSchema.properties.decision0.title, 'Run Implementation\'s tests on Node 22?');
  assert.deepEqual(form.requestedSchema.properties.decision0.enum, ['Pin Node 22 (recommended)', LEAVE]);
  assert.deepEqual(form.requestedSchema.properties.settled0.enum, [KEEP_SETTLED, 'Undo: ask me instead']);
  for (const property of Object.values(form.requestedSchema.properties)) assert.equal(property.default, undefined, 'never preselected');
  assert.equal(form.message, 'Node 26.12.0 here breaks tests that use localStorage; Node 22.14.0 is installed.\nRecommended: Pin Node 22. Tests pass on Node 22 (checked).\n'
    + `Settled for you: SFlow opened ${W} because its branch is the one checked out here. Undo if wrong.`);
  // Before the check: the check first.
  assert.deepEqual(directForm(BEFORE).form.requestedSchema.properties.decision0.enum, ['Check first: run the tests on Node 22 (recommended)', 'Pin Node 22', LEAVE]);
});

function person(replies, lists) {
  const seen = { asked: [], shown: [], reads: [], recorded: [] };
  return { seen, ui: {
    read: async (options) => { seen.reads.push(options ?? null); return lists[Math.min(seen.reads.length - 1, lists.length - 1)]; },
    show: async (shown) => { seen.shown.push(shown); },
    ask: async (form) => { seen.asked.push(form); return replies.shift() ?? { action: 'cancel' }; },
    record: async (read, document) => { seen.recorded.push({ digest: read.packetSha256, document }); return { recorded: Object.keys(document.choose).map((item) => ({ item, record: `R-${item}` })) }; },
    witness: async () => ({}), inspect: async () => {}
  } };
}
const accept = (content) => ({ action: 'accept', content });

test('the card checks before it asks, bounded; "Check first" runs it longer and asks again with what it found; nothing is recorded until confirmed', async () => {
  const unchecked = packetOf({ status: 'unknown' });
  const reason = 'The Vitest suite needs Node 22; the code does not change.';
  const { seen, ui } = person([accept({ decision0: 'Check first: run the tests on Node 22 (recommended)' }), accept({ decision0: 'Pin Node 22 (recommended)' }),
    accept({ reason }), accept({ confirm: RECORD })], [unchecked, BEFORE, AFTER, AFTER]);
  const result = await runCard(ui);
  // The first read, then the read after SFlow's bounded check, then the one after "Check first".
  assert.deepEqual(seen.reads.slice(0, 3), [null, { probe: CHECK_SECONDS }, { probe: CHECK_FIRST_SECONDS }]);
  assert.match(seen.shown[0], /^Checking first: run the tests on Node 22 \(up to 60 seconds; nothing is recorded\)\.$/u);
  assert.ok(seen.shown.some((shown) => /^Checking: run the tests on Node 22 \(up to 15 minutes; nothing is recorded\)\.$/u.test(shown)), seen.shown.join('\n'));
  // Asked again, with the check's result as the recommendation.
  assert.equal(seen.asked[1].requestedSchema.properties.decision0.enum[0], 'Pin Node 22 (recommended)');
  assert.equal(seen.recorded.length, 1);
  assert.deepEqual(seen.recorded[0].document.choose, { d1: 'pin-node' });
  assert.equal(seen.recorded[0].document.reason.d1, reason);
  assert.equal(result.status, 'recorded');
  // Closing the form after the check records nothing.
  const closed = person([accept({ decision0: 'Check first: run the tests on Node 22 (recommended)' }), { action: 'cancel' }], [BEFORE, BEFORE, AFTER]);
  assert.equal((await runCard(closed.ui)).status, 'cancelled');
  assert.deepEqual(closed.seen.recorded, []);
});

test('undoing what was settled is a choice beside the one question, and recorded like any answer', async () => {
  const { seen, ui } = person([accept({ decision0: LEAVE, settled0: 'Undo: ask me instead' }), accept({ reason: '' }), accept({ confirm: RECORD })], [AFTER]);
  await runCard(ui);
  const settled = AFTER.settled[0];
  assert.deepEqual(seen.recorded[0].document.choose, { [settled.id]: 'undo' });
});

test('several items are named on the first form, in grammar', () => {
  const two = { ...AFTER, items: [...AFTER.items, { ...AFTER.items[0], id: 'd9', title: 'Another', plain: { question: 'Approve the other change?', why: 'It waits.', recommended: 'Recommended: Approve it.' } }] };
  assert.equal(directItem(two), null);
  const { form } = firstForm(two);
  assert.match(form.message, /^2 questions for you: 1\. Run Implementation's tests on Node 22\? 2\. Approve the other change\? Settled for you: SFlow opened WORK-7 because/u);
  assert.doesNotMatch(form.message, /still need/u);
});

test('SFlow runs each check within its time, skips what it already knows, and a check that fails leaves "Check first"', async () => {
  assert.deepEqual(PROBE_KINDS, ['node-pin'], 'the kinds whose answer SFlow checks itself');
  assert.deepEqual([probeSeconds(undefined), probeSeconds('5'), probeSeconds('100000'), probeSeconds('soon')], [DEFAULT_SECONDS, 5, LONGEST_SECONDS, DEFAULT_SECONDS]);
  assert.deepEqual(itemsToCheck(AFTER), [], 'a checked answer is never checked again');
  assert.deepEqual(itemsToCheck(BEFORE).map((item) => item.id), ['d1']);
  let clock = 0;
  const calls = [];
  const said = [];
  const probes = { 'node-pin': async (root, packet, item, seconds) => { calls.push([item.id, seconds]); clock += 30_000; } };
  assert.deepEqual(await runDecisionProbes('/repo', BEFORE, { seconds: 45, now: () => clock, probes, say: (line) => said.push(line) }), { ran: ['d1'] });
  assert.deepEqual(calls, [['d1', 45]], 'given what is left of its time');
  assert.deepEqual(said, ['Checking: run the tests on Node 22 (up to 45 seconds; nothing is recorded).']);
  // No time left: nothing runs.
  assert.deepEqual(await runDecisionProbes('/repo', BEFORE, { seconds: 0, now: () => clock, probes }), { ran: [] });
  // A check that throws is not checked: the item keeps "Check first".
  assert.deepEqual(await runDecisionProbes('/repo', BEFORE, { seconds: 45, now: () => clock, probes: { 'node-pin': async () => { throw new Error('no Node 22 here'); } } }), { ran: [] });
});
