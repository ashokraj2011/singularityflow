/**
 * One approval with a Yes, and the convergence confirmation folded into its approval (owner, 2026-11-19: "too many
 * jargons and too many confusing loops"). /sf-approve, the approval page and the Decide card show the step's documents
 * and ask one question, "Approve <Step> v<N>?"; the person's own Yes, bound to the receipt of the version shown, replaces
 * typing the step's ID. A chat approval stands only on that Yes in its own turn; VS Code's own chat sends the person to
 * the approval page.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { approvalQuestion } from '../src/choices.mjs';
import { approvalAnswerReason, noteQuestionAnswered, startAnswerLedger } from '../src/copilot-answer-binding.mjs';
import { ANSWER_BOUND_TURNS } from '../src/person-step-catalog.mjs';
import { agentAct } from '../src/agent-output.mjs';
import { withPlainWords } from '../src/decision-plain.mjs';

const QUESTION = 'Approve Requirements v1?';
const ask = (turnId, answer, question = QUESTION) => ({ toolName: 'ask_user', toolArgs: { question },
  toolResult: { resultType: 'success', textResultForLlm: `User responded: ${answer}` }, turnId });

test('the approval question names the step and its version, in a developer\'s words', () => {
  assert.equal(approvalQuestion({ id: 'requirements', label: 'Requirements', generation: 1 }), QUESTION);
  assert.equal(approvalQuestion({ id: 'fix-spec', generation: 3 }), 'Approve fix-spec v3?');
  assert.ok(ANSWER_BOUND_TURNS.includes('approve'), 'an /sf-approve turn keeps the person\'s answers for its approval');
});

test('an approval in chat stands only on the person\'s own Yes to that exact question', async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'sflow-approve-yes-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const turn = async (name, replies, { question = QUESTION, options = {}, prompt = '/sf-approve requirements' } = {}) => {
    const file = path.join(folder, `${name}.mutation.json`);
    const record = { turnId: `turn-${name}` };
    await startAnswerLedger(file, record, prompt);
    for (const [answer, asked] of replies) await noteQuestionAnswered(file, record, ask(record.turnId, answer, asked));
    return { file, record, reason: await approvalAnswerReason(file, record, question, { options }) };
  };
  assert.equal((await turn('yes', [['Yes', QUESTION]])).reason, null, 'their Yes to the question approves');
  assert.equal((await turn('label', [['Approve Requirements v1', QUESTION]])).reason, null, 'the outcome label is a Yes');
  // Typing the step's ID with the skill is no longer the confirmation: the question is asked.
  assert.match((await turn('typed', [])).reason, /ask them "Approve Requirements v1\?" exactly with your question tool \(ask_user\), its choices "Approve Requirements v1" and "Not now"/u);
  assert.match((await turn('not-now', [['Not now', QUESTION]])).reason, /did not say Yes to "Approve Requirements v1\?": approve nothing/u);
  // A Yes to another version's question never approves this one, either way round (v1 is not v10).
  assert.match((await turn('v10', [['Yes', 'Approve Requirements v10?']])).reason, /ask them "Approve Requirements v1\?"/u);
  assert.match((await turn('v1-for-v10', [['Yes', QUESTION]], { question: 'Approve Requirements v10?' })).reason, /ask them "Approve Requirements v10\?"/u);
  assert.match((await turn('label-v10', [['Approve Requirements v10', QUESTION]])).reason, /did not say Yes|ask them/u, 'another version\'s label is no Yes');
  // An article's reason is the person's words, never the agent's.
  const words = await turn('words', [['Yes', QUESTION]], { options: { 'article-reason': 'The agent decided this exception is fine.' } });
  assert.match(words.reason, /not what the person answered/u);
  // One Yes carries one approval: after it is used, the same Yes still holds that approval's second command.
  const used = await turn('used', [['Yes', QUESTION]]);
  assert.equal(used.reason, null);
  assert.equal(await approvalAnswerReason(used.file, used.record, QUESTION), null, 'choices answer, then approve, on the one Yes');
  // VS Code's own chat, whose answers have never been seen to reach SFlow, approves on the approval page instead.
  const file = path.join(folder, 'local.mutation.json');
  const record = { turnId: 'turn-local' };
  await startAnswerLedger(file, record, '');
  assert.match(await approvalAnswerReason(file, record, QUESTION, { localChat: true }), /do not ask again in this chat\. They can approve it on the approval page, which the Decide card opens/u);
  assert.match(await approvalAnswerReason(file, record, null), /names no review opened on this machine/u);
});

test('the review packet asks one question with its outcome-labelled choice, nothing preselected', () => {
  const packet = { approvalContext: { phase: 'requirements' }, ready: false, choiceSets: [{ id: 'phase-confirmation', question: QUESTION, options: [{ id: 'requirements', label: 'Approve Requirements v1' }] }],
    approvalPacket: { review: {} } };
  const act = agentAct(packet);
  assert.equal(act.state, 'ask-person');
  assert.equal(act.ask.question, QUESTION);
  assert.deepEqual(act.ask.choices.map((choice) => choice.label), ['Approve Requirements v1', 'Not now']);
  assert.match(act.ask.how, /approvalCovers/u);
  // VS Code: #sflowDecide opens the approval page, and the turn ends there with no approve route [owner's Story, 2026-11-20]. A
  // second turn calls it again, which brings the open page forward; the ending names only the page and the person's own
  // @sflow line, filled when the packet names the Story [owner, 2026-11-21].
  // Since 2026-11-28 the open page needs no command at all; the person's own @sflow line only when it could not open.
  assert.match(act.ask.how, /in VS Code's own chat do not ask: call #sflowDecide with workId only, in this turn even when an earlier one opened the approval page \(it brings that page forward\)\. When it answers approval-open, end that VS Code turn with only what the person does: approve or send it back on the approval page that is open, with no command at all; only when it says the page could not open, type the tool's next \(@sflow \/approve\) in the chat box\. No Copilot, Shell or other approve route/u);
  assert.match(agentAct({ ...packet, workId: 'AY-1' }).ask.how, /type `@sflow \/approve requirements --work-id AY-1` in the chat box/u);
  assert.match(act.ask.how, /Record it only after their Yes; never answer it yourself/u);
});

test('the Decide card asks "Approve <Step> v<N>?" and names what the approval also covers', () => {
  const workflow = { workItem: { id: 'AY-1' }, currentPhase: 'design', phaseOrder: ['requirements', 'design'], phases: { requirements: { id: 'requirements', label: 'Requirements' }, design: { id: 'design', label: 'Design' } } };
  const { items } = withPlainWords(workflow, { items: [{ kind: 'approval', title: 'Approve Design', options: [],
    details: { phase: 'design', generation: 2, ready: true, documents: ['singularity/work-items/AY-1/artifacts/design/design.md'],
      covers: [{ phase: 'requirements', label: 'Requirements', generation: 1, documents: [], words: 'approved automatically: the reviewer said ready' }] } }] });
  assert.equal(items[0].plain.question, 'Approve Design v2?');
  assert.match(items[0].plain.why, /with Requirements v1, which SFlow approved when ready/u);
});

test('the person\'s own skill, terminal and approval page ask the same one question; nobody types the step\'s ID', async () => {
  const skill = await readFile(new URL('../plugin/skills/sflow-approve/SKILL.md', import.meta.url), 'utf8');
  assert.doesNotMatch(skill, /TYPED-PHASE|exact phase ID/u);
  // The Yes is recorded by the filled command the packet returns: nobody types the step's ID or the receipt [owner, 2026-11-20].
  assert.match(skill, /After their Yes, run `act\.ask\.onYes` as returned/u);
  assert.doesNotMatch(skill, /<TOKEN>/u);
  const kernel = await readFile(new URL('../src/commands/kernel.mjs', import.meta.url), 'utf8');
  assert.match(kernel, /Approve \$\{phase\.label \?\? phase\.id\} v\$\{Number\(phase\.generation\) \|\| 0\}\? \[y\/N\]/u);
  const page = await readFile(new URL('../apps/vscode/src/views/approval-review.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /data-confirmation/u, 'no field to type the step\'s ID in');
  assert.match(page, /<button type="submit" disabled>\$\{escape\(approvalChoice\(request\)\)\}<\/button>/u);
  assert.match(page, /data-cancel>Not now<\/button>/u);
});
