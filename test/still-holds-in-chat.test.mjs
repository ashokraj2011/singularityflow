/**
 * A "still holds" row answered yes or no in a /sf-decide chat [owner, 2026-11-14]: the older SCS revalidation rows and the
 * CIC D1 rows (`reason: prompt-held`) alike. Yes is "still holds" (`unchanged`), no is "redo" (`return`), each the row's own
 * `upstream-issue revalidate` command at the person's reason; the question says which answer is recommended and why, in
 * one line, and the row is never settled for them. Where SF Guard signs the row it stays a signed step in the approver's own
 * terminal: no chat command, no yes or no, and every host says so. Only the step's own approvers answer it, as before.
 * The guard and the answer binding are held in phase-mutation-contract.test.mjs; the hook on a real Story in no-dead-end.test.mjs.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { decisionChatSteps, decisionPacket } from '../src/decision-list.mjs';
import { packetText } from '../src/commands/decisions.mjs';
import { registerPersonCounts, presencePinKey } from '../src/presence/counted.mjs';
import { revalidateAfterForwardAmendment } from '../src/state.mjs';
import { decideHtml } from '../apps/vscode/src/views/decide-card-page.ts';
import { decisionsTable } from '../plugin/extensions/decisions/card.mjs';

const AT = '2026-11-14T12:00:00.000Z';
const APPROVER = { name: 'Design Approver', email: 'design-approver@example.invalid' };
const OTHER = { name: 'Someone Else', email: 'someone-else@example.invalid' };
const ROW = 'singularity-flow upstream-issue revalidate fix-design --work-id D-1 --amendment AMD-001 --outcome <unchanged|return> --reason "<why>"';

function story({ presence = null } = {}) {
  const step = (id, label, status, generation) => ({ id, label, status, generation, approvals: [], approvalPolicy: { mode: 'required', authorities: ['design'], minimum: 1 } });
  return { workItem: { id: 'D-1', title: 'Still holds', workType: 'demo', branch: 'D-1' }, currentPhase: 'implement', status: 'in_progress',
    phaseOrder: ['intake', 'fix-design', 'implement'],
    resolution: { approvalAuthorities: { design: { label: 'Design approvers', members: [{ email: APPROVER.email }] } }, ...(presence ? { presence } : {}) },
    phases: { intake: step('intake', 'Scope and plan', 'approved', 2), 'fix-design': step('fix-design', 'Fix design', 'approved', 1), implement: step('implement', 'Implement', 'in_progress', 2) },
    intentAmendments: [{ id: 'AMD-001', status: 'approved', producer: 'intake', revalidate: [{ phase: 'fix-design', generation: 1, reason: 'prompt-held', clauses: ['D-1:AC-001'], recommend: 'unchanged' }] }] };
}

/** The list with one row: a D1 question (`prompt-held`) or an SCS row, as decision-list-reads.mjs hands it over. */
function packetOf(workflow, { held = true, recommend = 'unchanged', namedPaths = [], actor = APPROVER } = {}) {
  const row = { code: 'AMENDMENT_REVALIDATION_REQUIRED', amendment: 'AMD-001', phase: 'fix-design', producer: 'intake',
    message: 'fix-design read intake before AMD-001 amended it.', command: ROW,
    ...(held ? { reason: 'prompt-held', clauses: ['D-1:AC-001'], recommend, namedPaths, consumers: [] } : {}) };
  return decisionPacket(workflow, { phaseId: 'implement', endsStory: false, gaps: [], issues: [], evidence: [], visual: [], testRisks: [], testCommands: [],
    scopePhase: 'intake', approvalCheck: null, pending: { forwardAmendments: [row] }, state: null },
  { authorities: workflow.resolution.approvalAuthorities, actor, at: AT });
}
const rowOf = (packet) => packet.items.find((item) => item.kind === 'revalidation');
const hosts = (packet) => [['terminal', packetText(packet)], ['VS Code', decideHtml({ ...packet, packetSha256: 'sha256:x', repositoryPath: '/repo' }).replaceAll('&#39;', '\'')],
  ['Copilot CLI', decisionsTable(packet)]];

test('a "still holds" row is a yes or no in chat: yes still holds, no redoes it, each its own revalidate command', () => {
  const packet = packetOf(story());
  const row = rowOf(packet);
  assert.equal(row.chatYesNo, true);
  assert.deepEqual({ yes: row.yesNo.yes, no: row.yesNo.no, route: row.yesNo.route }, { yes: 'still-holds', no: 'return-step', route: '/sf-decide D-1' });
  // The question names the recommended answer and why, in one line.
  assert.equal(row.yesNo.question, 'Does Fix design still hold after AMD-001? Recommended: yes. Fix design\'s document names neither AC-001 nor any path it expects.');
  assert.doesNotMatch(row.yesNo.question, /\n/u);
  const command = (id) => row.options.find((entry) => entry.id === id).chat.command;
  assert.equal(command('still-holds'), 'singularity-flow upstream-issue revalidate fix-design --work-id D-1 --amendment AMD-001 --outcome unchanged --reason "<REASON>"');
  assert.equal(command('return-step'), 'singularity-flow upstream-issue revalidate fix-design --work-id D-1 --amendment AMD-001 --outcome return --reason "<REASON>"');
  // What a /sf-decide turn runs for the person's answer: that command, with their words, quoted for the shell.
  assert.deepEqual(decisionChatSteps(packet, [{ item: row.id, option: 'return-step', values: { reason: 'It relies on the numeric wording, so it is redone.' } }]),
    [{ item: row.id, command: 'singularity-flow upstream-issue revalidate fix-design --work-id D-1 --amendment AMD-001 --outcome return --reason \'It relies on the numeric wording, so it is redone.\'' }]);
  assert.deepEqual(decisionChatSteps(packet, [{ item: row.id, option: 'still-holds', values: {} }]), [], 'no reason, nothing to run');
  // Its document names a path the changed clause expects: redo it, and the question says so.
  const redo = rowOf(packetOf(story(), { recommend: 'return', namedPaths: ['src/value.mjs'] }));
  assert.equal(redo.yesNo.question, 'Does Fix design still hold after AMD-001? Recommended: no, redo it. Fix design\'s document names src/value.mjs, which AC-001 expects.');
  // An SCS row: the same yes and no; SFlow has no recommendation, and the question says what to weigh.
  const scs = rowOf(packetOf(story(), { held: false }));
  assert.equal(scs.chatYesNo, true);
  assert.deepEqual([scs.yesNo.yes, scs.yesNo.no], ['still-holds', 'return-step']);
  assert.match(scs.yesNo.question, /^Does Fix design still hold after AMD-001\? No recommendation: whether Fix design still holds under the amended document/u);
  // Never settled for the person.
  assert.equal(row.settled ?? false, false);
  assert.equal((packet.settled ?? []).length, 0);
});

test('every host says the row may also be answered yes or no in chat', () => {
  const packet = packetOf(story());
  const row = rowOf(packet);
  assert.equal(row.answer.where, 'chat');
  assert.equal(row.answer.words, 'Answer it on the Decide card: /sf-decide D-1 opens it, or answer yes or no in chat (/sf-decide D-1).');
  assert.equal(row.answer.also, 'Or answer yes or no in chat (/sf-decide D-1).');
  for (const [host, text] of hosts(packet)) assert.ok(text.includes('yes or no in chat (/sf-decide D-1)'), `${host}: ${text}`);
  // The Copilot CLI card's row says it beside its forms.
  assert.ok(decisionsTable(packet).includes('Your decision, on the forms below. Or answer yes or no in chat (/sf-decide D-1).'), decisionsTable(packet));
});

test('under SF Guard the row stays a signed step in the approver\'s own terminal: no chat asks it, and every host says so', () => {
  const guarded = story({ presence: { status: 'required', chainId: 'chain-1' } });
  const packet = packetOf(guarded);
  const row = rowOf(packet);
  assert.equal(row.guardSigns, true);
  assert.equal(row.chatYesNo, false);
  assert.equal(row.yesNo, undefined);
  assert.ok(row.options.every((entry) => entry.chat === undefined), 'no chat command to run');
  assert.equal(row.answer.where, 'terminal');
  assert.equal(row.answer.words, 'Answer it on the Decide card: /sf-decide D-1 opens it. SF Guard signs it, so it is recorded in your own terminal (singularity-flow decisions record D-1), never in chat.');
  for (const [host, text] of hosts(packet)) {
    assert.ok(text.includes('SF Guard signs it, so it is recorded in your own terminal (singularity-flow decisions record D-1), never in chat.'), `${host}: ${text}`);
    assert.ok(!text.includes('yes or no in chat'), host);
  }
  // Still on the card, with its recommendation, and still never settled.
  assert.equal(row.recommended.option, 'still-holds');
  assert.equal(row.settled ?? false, false);
  // The rule SF Guard signs by, not one of its own: a pin turned off, or a chain this process read that does not
  // require the Story, signs nothing, so the chat asks it.
  assert.equal(rowOf(packetOf(story({ presence: { status: 'off', chainId: 'chain-1' } }))).chatYesNo, true);
  const unrequired = story({ presence: { status: 'required', chainId: 'chain-2' } });
  registerPersonCounts(presencePinKey(unrequired), null);
  assert.equal(rowOf(packetOf(unrequired)).chatYesNo, true);
});

test('only the step\'s own approvers answer it: the list says who, and revalidate refuses anyone else before writing', async () => {
  const packet = packetOf(story(), { actor: OTHER });
  const row = rowOf(packet);
  assert.equal(row.decidedBy.allowed, false);
  assert.match(row.decidedBy.words, /Design approvers/u);
  // A card offers no chat answer to someone who may not give it.
  assert.ok(!decideHtml({ ...packet, packetSha256: 'sha256:x', repositoryPath: '/repo' }).includes('Or answer yes or no in chat'));
  assert.ok(!decisionsTable(packet).includes('Or answer yes or no in chat'));
  assert.equal(rowOf(packetOf(story())).decidedBy.allowed, true, 'its approver may');
  // The command a chat would run, under that person's identity: refused, and nothing is recorded.
  const workflow = story();
  await assert.rejects(revalidateAfterForwardAmendment('/nonexistent', {}, workflow, { amendmentId: 'AMD-001', phaseId: 'fix-design', outcome: 'unchanged',
    reason: 'It does not rely on the numeric wording of the value.', actor: OTHER, at: AT }), { code: 'APPROVAL_IDENTITY_NOT_AUTHORIZED' });
  assert.equal((workflow.amendmentRevalidations ?? []).length, 0);
});
