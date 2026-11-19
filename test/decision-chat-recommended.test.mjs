/**
 * The recommended answer in chat needs no reason [owner, 2026-11-19, C10]. The row's chat command for the recommended side
 * carries --recommended in place of the reason; the command itself checks it against the list (recommended-answer.mjs), and
 * the answer binding still holds it to the person's own Yes for that row. Only the reason checks are skipped.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { noteQuestionAnswered, recommendedAnswer, startAnswerLedger, unboundAnswerReason } from '../src/copilot-answer-binding.mjs';
import { decisionChatSteps, decisionPacket } from '../src/decision-list.mjs';
import { departureOptionOf } from '../src/recommended-answer.mjs';

const AT = '2026-11-19T09:00:00.000Z';
const WORK = 'CHT-1';
const actor = { name: 'Decider', email: 'decider@example.invalid', login: null };

function story() {
  const group = (label) => ({ label, allowAnyGitIdentity: true, members: [] });
  return {
    workItem: { id: WORK }, status: 'in_progress', currentPhase: 'implementation', phaseOrder: ['specification', 'implementation'],
    phases: {
      specification: { id: 'specification', label: 'Specification', status: 'approved', generation: 1, approvalPolicy: { authorities: ['product'] } },
      implementation: { id: 'implementation', label: 'Implementation', status: 'in_progress', generation: 1, approvalPolicy: { authorities: ['engineering'] } }
    },
    resolution: { approvalAuthorities: { product: group('Product approvers'), engineering: group('Engineering reviewers') } },
    upstreamIssues: [], upstreamIssueDecisions: []
  };
}

const packet = () => decisionPacket(story(), { phaseId: 'implementation', at: AT, gaps: [], issues: [], candidates: [], reuseProblems: [], testRisks: [], unavailable: [], state: {},
  departures: { phase: 'implementation', planRows: [{ clauseId: `${WORK}:AC-001`, result: 'export' }, { clauseId: `${WORK}:AC-002`, result: 'import' }], codeStepOpen: true,
    findingTitles: {}, acceptance: {}, reopens: {}, tests: {}, entries: [{ departure: { id: 'DEP-001', kind: 'path', phase: 'implementation', paths: ['src/extra.js'],
      clauses: [`${WORK}:AC-001`], reason: 'src/extra.js changed in this generation, and no row of the approved plan names it.', recordedBy: 'sflow' },
    status: 'open', groups: ['engineering'], words: 'src/extra.js changed', acceptAll: true }] } },
{ authorities: story().resolution.approvalAuthorities, actor, at: AT });

test('the recommended side\'s chat command says --recommended and carries no reason; the other side keeps the person\'s reason', () => {
  const list = packet();
  const [item] = list.items;
  const accept = item.options.find((entry) => entry.id === 'accept');
  const reject = item.options.find((entry) => entry.id === 'reject');
  assert.equal(accept.chat.command, `singularity-flow decision departure ${WORK} --fetch --departure DEP-001 --as accepted --recommended`);
  assert.equal(reject.chat.command, `singularity-flow decision departure ${WORK} --fetch --departure DEP-001 --as rejected --reason "<REASON>"`);
  // A /sf-decide turn runs it with nothing typed; the other side waits for the person's words.
  assert.deepEqual(decisionChatSteps(list, [{ item: item.id, option: 'accept', values: {} }]), [{ item: item.id, command: accept.chat.command }]);
  assert.deepEqual(decisionChatSteps(list, [{ item: item.id, option: 'reject', values: {} }]), []);
  assert.equal(departureOptionOf(item, { as: 'accepted' }), 'accept');
  assert.equal(departureOptionOf(item, { as: 'rejected' }), 'reject');
  assert.equal(departureOptionOf(item, { as: 'accepted', clause: `${WORK}:AC-002` }), null, 'a row the list does not offer');
});

test('the binding skips only the reason checks for --recommended: the person\'s own Yes for that row is still required', async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'sflow-chat-recommended-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  assert.equal(recommendedAnswer({ recommended: true }), true);
  assert.equal(recommendedAnswer({ recommended: 'false' }), false);
  const positionals = ['decision', 'departure', WORK];
  const options = { departure: 'DEP-001', as: 'accepted', recommended: true, 'work-id': WORK };
  const question = 'Say where src/extra.js belongs (DEP-001). Accept? Recommended: yes. The code step names AC-001 as what it serves. A no says why in at least 20 characters.';
  const ask = (answer) => ({ toolName: 'ask_user', toolArgs: { question }, toolResult: { resultType: 'success', textResultForLlm: `User responded: ${answer}` } });
  // Their Yes for that row: recorded with no reason typed.
  const yes = { turnId: 'turn-yes' };
  const yesFile = path.join(folder, 'yes.mutation.json');
  await startAnswerLedger(yesFile, yes, `/sf-decide ${WORK}`);
  await noteQuestionAnswered(yesFile, yes, ask('Yes'));
  assert.equal(await unboundAnswerReason(yesFile, yes, options, { positionals }), null);
  // Their No: the command records a yes, so it is refused.
  const no = { turnId: 'turn-no' };
  const noFile = path.join(folder, 'no.mutation.json');
  await startAnswerLedger(noFile, no, `/sf-decide ${WORK}`);
  await noteQuestionAnswered(noFile, no, ask('No'));
  assert.match(await unboundAnswerReason(noFile, no, options, { positionals }), /answered No for this row/u);
  // No question asked at all: nobody's Yes, refused, even though no reason is needed.
  const none = { turnId: 'turn-none' };
  const noneFile = path.join(folder, 'none.mutation.json');
  await startAnswerLedger(noneFile, none, `/sf-decide ${WORK}`);
  assert.match(await unboundAnswerReason(noneFile, none, options, { positionals }), /^PHASE_MUTATION_ANSWER_UNBOUND/u);
  // Without --recommended a missing reason is still refused by its length.
  assert.match(await unboundAnswerReason(yesFile, yes, { ...options, recommended: undefined }, { positionals }), /--reason has 0 characters/u);
  // A plan row kept with --recommended stands only on a Yes to a question naming it.
  const plan = { turnId: 'turn-plan' };
  const planFile = path.join(folder, 'plan.mutation.json');
  await startAnswerLedger(planFile, plan, `/sf-decide ${WORK}`);
  assert.match(await unboundAnswerReason(planFile, plan, { 'add-location': `${WORK}:AC-001=src/extra.js`, recommended: true }, { positionals: ['decision', 'plan', WORK] }),
    /^PHASE_MUTATION_ANSWER_UNBOUND/u);
});
