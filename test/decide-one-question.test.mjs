/**
 * "sf-decide are so confusing ..what are we deciding and why" [owner, 2026-11-18, Story new-ash-graph]. One sign-off
 * asked six questions in the engine's words (Did you look at it? three checks, What did you inspect? 10-1000
 * characters, I reviewed this exact change), never said what was decided or why, and ended with no next step.
 *
 * Now a sign-off is ONE question on every surface, "Does this screenshot show what AC-002 asks for?", Yes / No (say
 * what's wrong) / Not sure, the file open beside it; every item says what is decided and why in one line; what waits
 * on someone or something else is one "Waiting:" line; and the list always ends with "Next:".
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import { decisionPacket } from '../src/decision-list.mjs';
import { approvalHold } from '../src/approval-check.mjs';
import { SingularityFlowError } from '../src/util.mjs';
import { withPlainWords } from '../src/decision-plain.mjs';
import { packetText } from '../src/commands/decisions.mjs';
import { screenshotWalkthrough } from '../src/commands/decisions-screenshot.mjs';
import * as shared from '../src/sign-off-question.mjs';
import * as card from '../plugin/extensions/decisions/card.mjs';
import { runWitnessReview } from '../apps/vscode/src/views/decision-list-model.ts';
import { decideHtml } from '../apps/vscode/src/views/decide-card-page.ts';
import { buildDecisionListView } from '../apps/vscode/src/views/decision-list-model.ts';
import { decisionListHtml } from '../apps/vscode/src/views/decision-list-page.ts';

const W = 'NEW-ASH-GRAPH';
const AT = '2026-11-18T19:10:00.000Z';
const ME = { name: 'Person', email: 'person@example.invalid' };
const AUTHORITIES = { engineering: { label: 'Engineering reviewers', allowAnyGitIdentity: true, members: [] },
  product: { label: 'Product approvers', members: [] } };
const FILE = `singularity/work-items/${W}/evidence/visual-sign-offs/${W}-AC-002-layout-structure-0123456789abcdef.png`;
const CONTEXT = `sha256:${'c'.repeat(64)}`;

function story(status = 'awaiting_approval') {
  return { workItem: { id: W }, status: 'in_progress', currentPhase: 'implementation', phaseOrder: ['implementation'],
    phases: { implementation: { id: 'implementation', label: 'Implementation', status, generation: 1, approvals: [], approvalPolicy: { authorities: ['engineering'], minimum: 1 } } },
    resolution: { approvalAuthorities: AUTHORITIES }, history: [] };
}
const review = { kind: 'witness', clauseId: `${W}:AC-002`, clauseText: 'The graph shows its layout structure.', slot: 'layout-structure', method: 'visual', files: [FILE],
  owners: ['implementation'], contextBinding: CONTEXT };
const owed = { kind: 'witness', ...review, available: true, groups: ['engineering'],
  command: `singularity-flow decision witness --work-id ${W} --criterion ${W}:AC-002 --slot layout-structure --file ${FILE}`, capture: { status: 'taken', workId: W, file: FILE } };
// As on new-ash-graph: Implementation's approval is held by the sign-off it answers for.
const hold = (workflow) => approvalHold(new SingularityFlowError('Phase \'implementation\' cannot be approved while 1 sign-off(s) it answers for have no witness.',
  { code: 'EVIDENCE_INSPECTION_MISSING', details: { phase: 'implementation', criteria: [{ clauseId: `${W}:AC-002`, slot: 'layout-structure' }] } }), workflow, workflow.phases.implementation);
const packetOf = (entries, workflow = story()) => ({ ...withPlainWords(workflow, decisionPacket(workflow, { phaseId: 'implementation', pending: { owed: entries },
  approvalCheck: { holds: [hold(workflow)] } }, { authorities: AUTHORITIES, actor: ME, at: AT })), packetSha256: `sha256:${'a'.repeat(64)}`, repositoryPath: '/repo' });
const QUESTION = 'Does this screenshot show what AC-002 asks for?';
const WHAT = 'Sign off AC-002, the layout structure: tests can\'t check how it looks, so a person confirms it before Implementation is approved.';
const text = (html) => html.replace(/<script[\s\S]*?<\/script>/gu, '').replace(/<[^>]+>/gu, ' ').replace(/&#39;/gu, '\'').replace(/&quot;/gu, '"').replace(/&amp;/gu, '&').replace(/\s+/gu, ' ');

test('the shared answer rules: Yes confirms all three with an optional note, No needs one, Not sure records nothing; the card keeps the same copy', () => {
  assert.equal(shared.signOffQuestion(review), QUESTION);
  assert.equal(shared.signOffQuestion({ ...review, method: 'inspection', files: ['docs/runbook.md'] }), 'Does docs/runbook.md show what AC-002 asks for?');
  assert.deepEqual(shared.signOffAnswers('yes'), { reason: shared.CONFIRMED_ON_CARD,
    answers: [['states-the-outcome', true], ['matches-the-criterion', true], ['current-for-this-change', true]] });
  assert.deepEqual(shared.signOffAnswers('yes', 'The grid and the axis labels are both there.').reason, 'The grid and the axis labels are both there.');
  assert.match(shared.signOffAnswers('no', '').problem, /Say what is wrong/u);
  assert.deepEqual(shared.signOffAnswers('no', 'The axis labels are missing.').answers, [['states-the-outcome', false], ['matches-the-criterion', false], ['current-for-this-change', true]]);
  assert.deepEqual(shared.signOffAnswers('unsure'), { unsure: true });
  // The Copilot CLI card cannot import the engine: its copy says and records the same.
  for (const name of ['SIGN_OFF_ANSWERS', 'CONFIRMED_ON_CARD']) assert.deepEqual(card[name], shared[name], name);
  for (const [answer, note] of [['yes', ''], ['yes', 'The grid is there.'], ['no', ''], ['no', 'The labels are missing.'], ['unsure', '']]) {
    assert.deepEqual(card.signOffAnswers(answer, note), shared.signOffAnswers(answer, note), `${answer} ${note}`);
  }
  assert.equal(card.signOffQuestion(review), QUESTION);
  assert.equal(card.unsureWords(W), shared.unsureWords(W));
});

test('Copilot CLI: one sign-off is one question, what and why first, and a Yes is recorded with nothing more to confirm', async () => {
  const packet = packetOf([owed]);
  const item = packet.items.find((entry) => entry.details?.clause === `${W}:AC-002`);
  assert.equal(item.plain.why, WHAT);
  assert.equal(item.plain.question, 'Does the screenshot show what AC-002 asks for?');
  const { message, requestedSchema } = card.witnessForm(review, item);
  assert.equal(message.split('\n')[0], WHAT);
  assert.deepEqual(Object.keys(requestedSchema.properties), ['answer', 'note']);
  assert.deepEqual(requestedSchema.required, ['answer']);
  assert.equal(requestedSchema.properties.answer.title, QUESTION);
  // With the screenshot open, the person may also sign it off from their own check (owner, 2026-11-22).
  assert.deepEqual(requestedSchema.properties.answer.enum, ['Yes', 'No (say what\'s wrong)', 'Not sure', 'I checked it myself (no screenshot)']);
  assert.doesNotMatch(JSON.stringify(card.witnessForm(review, item)), /Did you look at it|I reviewed this exact change|observable outcome|current for this change|What did you inspect/u);
  const asked = [];
  const witnessed = [];
  const result = await card.runCard({ read: async () => packet, show: async () => {}, ask: async (form) => { asked.push(form); return { action: 'accept', content: { answer: 'Yes' } }; },
    record: async () => assert.fail('a sign-off records itself'), witness: async (read, current, answer) => { witnessed.push(answer); return { record: { id: 'WIT-002', outcome: 'met' } }; },
    inspect: async () => {} });
  assert.equal(asked.length, 1, 'one question, nothing to confirm after it');
  assert.deepEqual(witnessed, [{ problem: null, file: FILE, reason: shared.CONFIRMED_ON_CARD,
    answers: [['states-the-outcome', true], ['matches-the-criterion', true], ['current-for-this-change', true]] }]);
  assert.match(result.message, /^1 decision recorded\. AC-002 signed off\./u);
  // Not sure: nothing recorded, and what to do.
  const shown = [];
  const unsure = await card.runCard({ read: async () => packet, show: async (line) => { shown.push(line); }, ask: async () => ({ action: 'accept', content: { answer: 'Not sure' } }),
    record: async () => assert.fail('nothing'), witness: async () => assert.fail('nothing'), inspect: async () => {} });
  assert.equal(unsure.recorded.length, 0);
  assert.ok(shown.includes(shared.unsureWords(W)));
});

test('VS Code: the same one question and its note; Not sure records nothing', async () => {
  const packet = packetOf([owed]);
  const run = async (answer, note) => {
    const calls = { answered: [], recorded: [] };
    const result = await runWitnessReview({ workId: W, criterion: `${W}:AC-002`, slot: 'layout-structure' }, {
      read: async () => packet, choose: async (choices) => choices[0], file: async () => FILE, digest: async () => `sha256:${'d'.repeat(64)}`, inspect: async () => {},
      answer: async (question, answers) => { calls.answered.push([question, answers]); return answer; }, note: async (required) => { calls.required = required; return note; },
      record: async (repository, argv) => { calls.recorded.push(argv); return { data: { record: { id: 'WIT-002', outcome: answer === 'yes' ? 'met' : 'failed' } } }; } });
    return { result, calls };
  };
  const yes = await run('yes', '');
  assert.deepEqual(yes.calls.answered, [[QUESTION, shared.SIGN_OFF_ANSWERS]]);
  assert.equal(yes.calls.required, false);
  const argv = yes.calls.recorded[0];
  assert.equal(argv[argv.indexOf('--reason') + 1], shared.CONFIRMED_ON_CARD);
  assert.deepEqual(argv.filter((word) => word === '--confirm').length, 3);
  const no = await run('no', 'The axis labels are missing.');
  assert.equal(no.calls.required, true);
  assert.deepEqual(no.calls.recorded[0].filter((word) => word === '--deny').length, 2);
  const unsure = await run('unsure', undefined);
  assert.deepEqual([unsure.result.status, unsure.result.message, unsure.calls.recorded.length], ['unsure', shared.unsureWords(W), 0]);
});

test('terminal walkthrough: the same one question, y with no note records the yes, s records nothing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-one-question-'));
  try {
    await mkdir(path.dirname(path.join(root, FILE)), { recursive: true });
    await writeFile(path.join(root, FILE), 'png bytes');
    const packet = { ...packetOf([owed]), repositoryPath: root };
    const item = packet.items.find((entry) => entry.details?.clause === `${W}:AC-002`);
    const walk = async (lines) => {
      const output = new PassThrough();
      let said = '';
      output.on('data', (chunk) => { said += chunk; });
      const recorded = [];
      const outcome = await screenshotWalkthrough(root, { workId: W, packet, request: { item: item.id, subject: item.subject, take: false }, reread: async () => packet,
        io: { input: Readable.from(lines.map((entry) => `${entry}\n`)), output }, deps: { open: async () => {}, record: async (args) => { recorded.push(args); return { data: { record: { id: 'WIT-002', outcome: 'met' } } }; } } });
      return { outcome, said, recorded };
    };
    const yes = await walk(['y', '']);
    assert.match(yes.said, new RegExp(`${QUESTION.replace(/[?]/gu, '\\?')} y = yes, n = no \\(say what's wrong\\), s = not sure, r = take it again, c = I checked it myself \\(no screenshot\\) \\[s\\]: `, 'u'));
    assert.doesNotMatch(yes.said, /Record this review|What did you look at|observable outcome/u);
    assert.equal(yes.recorded[0][yes.recorded[0].indexOf('--reason') + 1], shared.CONFIRMED_ON_CARD);
    const unsure = await walk(['s']);
    assert.deepEqual([unsure.outcome.status, unsure.recorded.length], ['not-sure', 0]);
    assert.ok(unsure.said.includes(shared.unsureWords(W)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('every surface: what waits on someone else is one Waiting line naming who, and the list ends with Next', () => {
  // A scope statement that the product approvers decide, beside this person's sign-off.
  const scope = { kind: 'scope', id: 'SRI-001', text: 'The grid shows labeled axes.', source: 'brief.md:4', command: 'singularity-flow decision scope', groups: ['product'] };
  const packet = packetOf([owed, scope]);
  const theirs = packet.items.find((entry) => entry.details?.scopeItem === 'SRI-001');
  assert.equal(theirs.plain.later, 'Is "The grid shows labeled axes." part of this Story: waiting on Product approvers.');
  assert.equal(packet.plain.afterAnswer, 'After you answer, Implementation\'s approval is next.');
  const terminal = packetText(packet);
  assert.match(terminal, /\nWaiting: Is "The grid shows labeled axes\." part of this Story: waiting on Product approvers\.\n/u);
  assert.ok(terminal.trimEnd().endsWith('Next: After you answer, Implementation\'s approval is next.'), terminal);
  const table = card.decisionsTable(packet);
  assert.match(table, /\nWaiting: Is "The grid shows labeled axes\." part of this Story: waiting on Product approvers\./u);
  assert.ok(table.endsWith('**Next: After you answer, Implementation\'s approval is next.**'), table);
  for (const html of [decideHtml(packet), decisionListHtml(buildDecisionListView(packet))]) {
    assert.ok(text(html).includes('Waiting: Is "The grid shows labeled axes." part of this Story: waiting on Product approvers.'));
    assert.ok(text(html).includes('Next: After you answer, Implementation\'s approval is next.'));
  }
});
