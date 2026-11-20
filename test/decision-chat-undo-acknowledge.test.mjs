/**
 * Two terminal-only steps become a bound yes in /sf-decide [owner, 2026-11-19, terminal-to-card]: undoing what was settled
 * ("Undo: ask me instead?") and acknowledging an approved intent amendment ("I read AMD-001"). Each runs only on the
 * person's own Yes to a question that names it, and never on a Story SF Guard signs, where the card or their own terminal
 * records it as before. Since 2026-11-20 what was settled is never asked in chat (owner: nothing waits on it); its undo stays
 * bound to the person's own Yes for a chat that is asked to run it, and is offered on the Decide card.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { noteQuestionAnswered, startAnswerLedger, unboundAnswerReason } from '../src/copilot-answer-binding.mjs';
import { decisionPacket } from '../src/decision-list.mjs';
import { ANSWER_BOUND_STEPS, OWN_TERMINAL_STEPS, PERSON_DECISIONS } from '../src/person-step-catalog.mjs';

const AT = '2026-11-19T09:00:00.000Z';
const WORK = 'UND-1';
const actor = { name: 'Decider', email: 'decider@example.invalid', login: null };

function story({ guard = false } = {}) {
  const group = (label) => ({ label, allowAnyGitIdentity: true, members: [] });
  return {
    workItem: { id: WORK }, status: 'in_progress', currentPhase: 'implementation', phaseOrder: ['specification', 'implementation'],
    phases: {
      specification: { id: 'specification', label: 'Specification', status: 'approved', generation: 2, approvalPolicy: { authorities: ['product'] } },
      implementation: { id: 'implementation', label: 'Implementation', status: 'in_progress', generation: 1, approvalPolicy: { authorities: ['engineering'] } }
    },
    resolution: { approvalAuthorities: { product: group('Product approvers'), engineering: group('Engineering reviewers') },
      ...(guard ? { presence: { status: 'required', chainId: 'chain-1' } } : {}) },
    settledDecisions: [{ id: 'STL-001', kind: 'plan-accounting', by: 'sflow', phase: 'implementation', subject: 'file:README.md',
      answer: 'Listed README.md in the plan as a supporting change (documentation).', evidence: [{ what: 'README.md is documentation', where: 'the repository root' }],
      effect: { file: 'README.md', class: 'documentation' }, at: AT }],
    upstreamIssues: [], upstreamIssueDecisions: []
  };
}

const packetOf = (workflow) => decisionPacket(workflow, { phaseId: 'implementation', at: AT, gaps: [], issues: [], candidates: [], reuseProblems: [], testRisks: [],
  unavailable: [], state: {}, pending: { intentAmendments: [{ id: 'AMD-001', status: 'approved', changedClauses: [`${WORK}:REQ-001`], affectedPhases: ['implementation'] }] } },
{ authorities: workflow.resolution.approvalAuthorities, actor, at: AT });

test('an approved amendment\'s acknowledgement is a yes in chat, never under SF Guard; a settled file\'s Undo is on the Decide card, never asked in chat', () => {
  const packet = packetOf(story());
  const [settled] = packet.settled;
  // Nothing waits on what was settled: never a chat question, its undo on the Decide card or in the person's terminal
  // [owner, 2026-11-20: a chat asked "Undo: ask me instead for all 6" with no way to keep them].
  assert.deepEqual([settled.chatYesNo, settled.yesNo, settled.options[0].chat, settled.answer.where], [false, undefined, undefined, 'card']);
  assert.equal(settled.options[0].terminal, `singularity-flow decisions undo ${WORK} --settled STL-001`);
  const amendment = packet.items.find((item) => item.kind === 'intent-amendment');
  assert.equal(amendment.chatYesNo, true);
  assert.match(amendment.yesNo.question, /AMD-001.*I read AMD-001: acknowledge it\? Recommended: yes\./u);
  assert.equal(amendment.options[0].chat.command, `singularity-flow story intent-amendment acknowledge AMD-001 --work-id ${WORK}`);
  // SF Guard signs a person's records: the card or their own terminal, as before.
  const guarded = packetOf(story({ guard: true }));
  assert.equal(guarded.settled[0].chatYesNo, false);
  assert.equal(guarded.settled[0].options[0].chat, undefined);
  assert.equal(guarded.items.find((item) => item.kind === 'intent-amendment').options[0].chat, undefined);
  // In the catalog: a /sf-decide turn's own steps, held to the person's answer; no longer only their terminal's.
  for (const id of ['settled-undo', 'intent-amendment-acknowledgement']) {
    assert.equal(OWN_TERMINAL_STEPS.some((step) => step.id === id), false, id);
    assert.deepEqual(PERSON_DECISIONS.find((step) => step.id === id)?.owners, ['decide'], id);
    assert.ok(ANSWER_BOUND_STEPS.includes(id), id);
  }
});

test('each runs only on the person\'s own Yes to the question that names it', async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'sflow-chat-undo-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const ask = (question, answer) => ({ toolName: 'ask_user', toolArgs: { question }, toolResult: { resultType: 'success', textResultForLlm: `User responded: ${answer}` } });
  const undo = { positionals: ['decisions', 'undo', WORK], options: { settled: 'STL-001' } };
  const acknowledge = { positionals: ['story', 'intent-amendment', 'acknowledge', 'AMD-001'], options: { 'work-id': WORK } };
  const cases = [
    [undo, 'Listed README.md in the plan as a supporting change (documentation). Undo: ask me instead (STL-001)?'],
    [acknowledge, 'Acknowledge intent amendment AMD-001. I read AMD-001: acknowledge it?']];
  for (const [index, [command, question]] of cases.entries()) {
    const yes = { turnId: `yes-${index}` };
    const yesFile = path.join(folder, `yes-${index}.json`);
    await startAnswerLedger(yesFile, yes, `/sf-decide ${WORK}`);
    await noteQuestionAnswered(yesFile, yes, ask(question, 'Yes'));
    assert.equal(await unboundAnswerReason(yesFile, yes, command.options, { positionals: command.positionals }), null, question);
    const none = { turnId: `none-${index}` };
    const noneFile = path.join(folder, `none-${index}.json`);
    await startAnswerLedger(noneFile, none, `/sf-decide ${WORK}`);
    await noteQuestionAnswered(noneFile, none, ask('Is the export right?', 'Yes'));
    assert.match(await unboundAnswerReason(noneFile, none, command.options, { positionals: command.positionals }) ?? '', /^PHASE_MUTATION_ANSWER_UNBOUND/u, 'a Yes to another question');
    const no = { turnId: `no-${index}` };
    const noFile = path.join(folder, `no-${index}.json`);
    await startAnswerLedger(noFile, no, `/sf-decide ${WORK}`);
    await noteQuestionAnswered(noFile, no, ask(question, 'No'));
    assert.match(await unboundAnswerReason(noFile, no, command.options, { positionals: command.positionals }) ?? '', /answered No for this row/u);
  }
});
