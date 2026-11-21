/**
 * Dispute this finding (owner, 2026-11-20: "yes add a dispute this finding choice"). A person who may decide for a step
 * disputes the reviewer's blocking finding with their own reason: on the Decide card and decision list (a finding row, and
 * the row of the version SFlow started for it), never asked in chat since nothing waits on it, in their own terminal, and the step's
 * approvers see each dispute on the approval screen. The dispute is the review's own human decision, `dispute:<ID>`: the
 * finding then blocks neither the next version nor the submission, and the same finding raised again shows as disputed.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

import { noteQuestionAnswered, startAnswerLedger, unboundAnswerReason } from '../src/copilot-answer-binding.mjs';
import { argvAllowed } from '../src/copilot-mutation-guard.mjs';
import { decisionPacket, optionOutcome } from '../src/decision-list.mjs';
import { withPlainWords } from '../src/decision-plain.mjs';
import { ANSWER_BOUND_STEPS, OWN_TERMINAL_STEPS, PERSON_DECISIONS } from '../src/person-step-catalog.mjs';
import { reviewCorrection } from '../src/source-review-continuation.mjs';
import { reraisedRoute } from '../src/settled-decisions.mjs';
import { agentAct, completeAgentResult } from '../src/agent-output.mjs';
import { packetText, waitsOnPerson, withStoryNext } from '../src/commands/decisions.mjs';
import * as card from '../plugin/extensions/decisions/card.mjs';
import { LEAVE as adjudicateLeave } from '../plugin/extensions/decisions/decisions.mjs';
import * as messages from '../apps/vscode/src/views/messages.ts';
import * as webview from '../apps/vscode/src/views/webview.ts';
import { decideHtml, KEEP_SETTLED as vscodeKeep, LEAVE_AS_IS as vscodeAsIs, STAYS_OPEN as vscodeStaysOpen } from '../apps/vscode/src/views/decide-card-page.ts';

import { publishedSpecificationStory, reviewReport } from './helpers/source-review-fixture.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';

const AT = '2026-11-20T09:00:00.000Z';
const WORK = 'DSP-1';
const actor = { name: 'Ana Approver', email: 'ana@example.invalid', login: null };
const REASON = 'The clause asks for a count of drafts, not a list of them.';

function story({ guard = false, status = 'in_progress', settled = [], opening = null } = {}) {
  const group = (label) => ({ label, allowAnyGitIdentity: true, members: [] });
  return {
    workItem: { id: WORK }, status: 'in_progress', currentPhase: 'specification', phaseOrder: ['specification', 'planning'],
    phases: {
      specification: { id: 'specification', label: 'Specification', status, generation: 1, approvalPolicy: { authorities: ['product'] },
        ...(opening ? { versionOpening: opening } : {}) },
      planning: { id: 'planning', label: 'Planning', status: 'pending', generation: 0, approvalPolicy: { authorities: ['product'] } }
    },
    resolution: { approvalAuthorities: { product: group('Product approvers') }, ...(guard ? { presence: { status: 'required', chainId: 'chain-1' } } : {}) },
    settledDecisions: settled, upstreamIssues: [], upstreamIssueDecisions: []
  };
}
const finding = (id, disputed = null) => ({ id, message: `The reviewer's words for ${id}.`, clauseId: `${WORK}:REQ-001`, disputed });
const facts = (reviewDisputes, workflow) => ({ phaseId: 'specification', at: AT, gaps: [], issues: [], candidates: [], reuseProblems: [], testRisks: [],
  unavailable: [], state: {}, pending: {}, reviewDisputes: { phase: 'specification', generation: 1, reportSha256: 'a'.repeat(64), status: workflow.phases.specification.status, ...reviewDisputes } });
const packetOf = (workflow, reviewDisputes) => withPlainWords(workflow, decisionPacket(workflow, facts(reviewDisputes, workflow),
  { authorities: workflow.resolution.approvalAuthorities, actor, at: AT }));

test('each blocking finding is a row a person may dispute with their own reason; a dispute is never recommended', () => {
  const workflow = story();
  const packet = packetOf(workflow, { findings: [finding('F-1'), finding('F-2', { by: 'Bo', reason: REASON })] });
  const rows = packet.offered.filter((item) => item.kind === 'review-finding');
  assert.deepEqual(rows.map((item) => item.details.finding), ['F-1'], 'a disputed finding blocks nothing, so it is no row');
  const [row] = rows;
  assert.equal(row.title, 'The reviewer\'s finding F-1 on Specification version 1');
  assert.equal(row.plain.question, 'Dispute the reviewer\'s finding F-1 on Specification version 1?');
  assert.equal(row.holds, 'nothing');
  const [dispute] = row.options;
  assert.equal(dispute.label, 'Dispute this finding');
  assert.equal(dispute.outcome, 'dispute');
  assert.deepEqual(dispute.needs.reason, { default: '', minimum: 20, maximum: 1000 }, 'their own words, required');
  assert.deepEqual(dispute.effects, [{ kind: 'review-dispute', phase: 'specification', finding: 'F-1', generation: 1, reportSha256: 'a'.repeat(64) }]);
  assert.equal(row.recommended.option, null, 'a dispute goes against the reviewer: never recommended');
  assert.equal(dispute.decidedBy.allowed, true);
  // Nothing waits on it, so a chat never asks it [owner, 2026-11-20: "what does this mean .. it is confusing"]: a row on the
  // card, whose skip names its default. Its command still takes the person's own reason.
  assert.equal(row.optional, true);
  assert.equal(row.chatYesNo, false);
  assert.equal(row.yesNo, undefined);
  assert.equal(row.plain.skip, 'Don\'t dispute (the author fixes it)');
  assert.equal(dispute.chat.command, `singularity-flow review-source dispute specification --work-id ${WORK} --finding F-1 --reason "<REASON>"`);
  assert.equal(row.answer.where, 'card');
  assert.equal(row.answer.words, `Nothing waits on it. Answer it on the Decide card (/sf-decide ${WORK} opens it) only if you disagree; a chat never asks it.`);
  // SF Guard signs it: the card or the person's own terminal, never chat.
  const guarded = packetOf(story({ guard: true }), { findings: [finding('F-1')] }).offered.find((item) => item.kind === 'review-finding');
  assert.equal(guarded.chatYesNo, false);
  assert.equal(guarded.options[0].chat, undefined);
  assert.equal(guarded.options[0].terminal, dispute.chat.command);
  // Once the step is submitted, nothing is offered: its approvers see the disputes instead.
  assert.equal(packetOf(story({ status: 'awaiting_approval' }), { findings: [finding('F-2', { by: 'Bo', reason: REASON })] }).offered?.some((item) => item.kind === 'review-finding') ?? false, false);
});

test('the version SFlow started for the findings offers each one\'s dispute beside its undo, and says when all are disputed', () => {
  const start = { id: 'STL-001', kind: 'review-corrections', by: 'sflow', phase: 'specification', subject: 'specification version 1: the review\'s findings',
    answer: 'Started version 2 of specification to fix the review\'s findings on version 1', evidence: [{ what: 'the review of version 1 asks for 2 corrections', where: 'specification review of version 1' }],
    effect: { generation: 1, toGeneration: 2, findings: ['F-1', 'F-2'] }, at: AT };
  const workflow = story({ settled: [start], opening: { version: 2, reason: 'review-corrections', consent: { settled: 'STL-001', surface: 'settled' } } });
  const open = { open: { version: 2, startedFor: ['F-1', 'F-2'], settled: 'STL-001' } };
  const [row] = packetOf(workflow, { ...open, findings: [finding('F-1'), finding('F-2', { by: 'Bo', reason: REASON })] }).settled;
  assert.deepEqual(row.options.map((entry) => [entry.id, entry.outcome]), [['undo', 'undo'], ['dispute-F-1', 'dispute']]);
  assert.equal(row.options[1].label, 'Dispute the reviewer\'s finding F-1');
  assert.equal(row.chatYesNo, false, 'what was settled is never a chat question: its undo is on the Decide card [owner, 2026-11-20]');
  assert.match(row.plain.settled, /To disagree with a finding, dispute it\. The reviewer's finding F-2 is disputed by Bo: The clause asks for a count of drafts, not a list of them\.$/u);
  const [all] = packetOf(workflow, { ...open, findings: [finding('F-1', { by: 'Bo', reason: REASON }), finding('F-2', { by: 'Bo', reason: REASON })] }).settled;
  assert.deepEqual(all.options.map((entry) => entry.id), ['undo']);
  assert.match(all.plain.settled, /Its author is told not to make those fixes; version 2 stays open, as an open version can't be withdrawn\.$/u);
  // The undo names the dispute as the person's say on a finding.
  assert.match(reraisedRoute(workflow, start).words, /To disagree with a finding, dispute it on the decisions card or in \/sf-decide, with your reason; or return the step when you approve it\.$/u);
});

test('the approval names each dispute and its reason, and the approver may still return the step', () => {
  const workflow = story({ status: 'awaiting_approval' });
  const packet = packetOf(workflow, { findings: [finding('F-2', { by: 'Bo', reason: REASON })] });
  const approval = packet.items.find((item) => item.kind === 'approval');
  assert.deepEqual(approval.details.disputes, [{ finding: 'F-2', message: 'The reviewer\'s words for F-2.', by: 'Bo', reason: REASON,
    words: `The reviewer's finding F-2 is disputed by Bo: ${REASON}` }]);
  assert.deepEqual(approval.details.lines, [`The reviewer's finding F-2 is disputed by Bo: ${REASON}`]);
  assert.match(approval.plain.why, /The reviewer's finding F-2 is disputed by Bo: .* Return the step if you agree with the reviewer\.$/u);
  assert.equal(optionOutcome({ kind: 'review-finding' }, { id: 'dispute' }), 'dispute');
});

/** The VS Code approval page, with a stub `vscode`, as oap-m0-approval-defects.test.mjs loads it. */
async function approvalPage() {
  const source = await readFile(new URL('../apps/vscode/src/views/approval-review.ts', import.meta.url), 'utf8');
  const exports = {};
  const approvalsModel = await import('../apps/vscode/src/views/approvals-model.ts');
  const sfGuardModel = await import('../apps/vscode/src/views/sf-guard-model.ts');
  const tryIt = await import('../apps/vscode/src/views/try-it.ts');
  const context = vm.createContext({ exports, Date, require(name) {
    if (name === 'vscode') return {};
    if (name === './messages.ts') return messages;
    if (name === './webview.ts') return webview;
    if (name === './navigate.ts') return { navigateTo() {} };
    if (name === './approvals-model.ts') return approvalsModel;
    if (name === './sf-guard-model.ts') return sfGuardModel;
    if (name === './try-it.ts') return tryIt;
    throw new Error(`Unexpected dependency: ${name}`);
  } });
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
  return exports;
}

test('the VS Code approval page lists each disputed finding, with who and why, from the list\'s approval item', async () => {
  const page = await approvalPage();
  const workflow = story({ status: 'awaiting_approval' });
  const listed = packetOf(workflow, { findings: [finding('F-2', { by: 'Bo', reason: REASON })] });
  const disputes = page.disputesOf(listed);
  assert.deepEqual(JSON.parse(JSON.stringify(disputes)), [{ finding: 'F-2', words: `The reviewer's finding F-2 is disputed by Bo: ${REASON}` }]);
  assert.equal(page.disputesOf({ items: [{ kind: 'approval', details: {} }] }), null);
  const html = page.approvalReviewBody({ title: 'Approve Specification', expected: 'specification', workId: WORK, phaseId: 'specification',
    phaseLabel: 'Specification', generation: 1, artifact: null, articles: [], findings: [], witnessedClauses: null, witnessMappings: [],
    priorExceptions: [], selfApproval: false, disputes });
  assert.match(html, /<h2>Disputed review findings<\/h2>/u);
  assert.match(html, /Send the step back if you agree with the reviewer\./u);
  assert.match(html, /The reviewer&#39;s finding F-2 is disputed by Bo: |The reviewer's finding F-2 is disputed by Bo: /u);
});

// ------------------------------------------------------------- ask a person only what waits on them [owner, 2026-11-20]

/**
 * The owner's /sf-decide (2026-11-20): four "Dispute the reviewer's finding … on Implementation version 2?" were asked as
 * required questions beside the one real decision, a test command's re-pin, while version 3 was already written to fix
 * them: "what does this mean .. it is confusing". The same list, built by the engine: one question waits, and the four
 * findings are rows on the card whose skip names their default.
 */
function ownersList() {
  const W = 'ARSHY';
  const ids = ['AC001-browser-test-gap', 'AC002-layout-test-gap', 'REQ001-trace-gap', 'REQ002-save-gap'];
  const start = { id: 'STL-001', kind: 'review-corrections', by: 'sflow', phase: 'implementation', subject: 'implementation version 2: the review\'s findings',
    answer: 'Started version 3 of implementation to fix the review\'s findings on version 2',
    evidence: [{ what: 'the review of version 2 asks for 4 corrections', where: 'implementation review of version 2' }], effect: { generation: 2, toGeneration: 3, findings: ids }, at: AT };
  const workflow = { workItem: { id: W }, status: 'in_progress', currentPhase: 'implementation', phaseOrder: ['implementation'],
    phases: { implementation: { id: 'implementation', label: 'Implementation', status: 'in_progress', generation: 2, approvalPolicy: { authorities: ['product'] },
      versionOpening: { version: 3, reason: 'review-corrections', consent: { settled: 'STL-001', surface: 'settled' } } } },
    resolution: { approvalAuthorities: { product: { label: 'Product approvers', allowAnyGitIdentity: true, members: [] } } },
    settledDecisions: [start], upstreamIssues: [], upstreamIssueDecisions: [] };
  const command = { id: '.-node-tests', argv: ['npm', 'test'], workingDirectory: '.', affectedRoots: ['.'], result: { adapter: 'vitest-json', path: '.sflow/results/node-tests.json' } };
  const listed = decisionPacket(workflow, { phaseId: 'implementation', at: AT, gaps: [], issues: [], candidates: [], reuseProblems: [], testRisks: [], unavailable: [], state: {}, pending: {},
    testCommands: [{ id: 'TCD-001', phase: 'implementation', requestedBy: 'developer', reason: 'Keeps the browser test in its own runner.', command, repin: { changes: ['package.json scripts.test changed'] } }],
    reviewDisputes: { phase: 'implementation', generation: 2, reportSha256: 'a'.repeat(64), status: 'in_progress', open: { version: 3, startedFor: ids, settled: 'STL-001' },
      findings: ids.map((id) => ({ id, message: `The reviewer's words for ${id}.`, disputed: null })) } }, { authorities: workflow.resolution.approvalAuthorities, actor, at: AT });
  // As `decisions` hands it to every host: in plain words, its next step the Decide card.
  return { W, ids, workflow, packet: { ...withStoryNext(withPlainWords(workflow, listed), null), repositoryPath: '/repo' } };
}

test('offered findings are never a question: beside one real decision, every chat-facing surface asks exactly one', async () => {
  const { W, ids, packet } = ownersList();
  const findings = packet.offered.filter((item) => item.kind === 'review-finding');
  assert.deepEqual(findings.map((item) => item.details.finding), ids);
  for (const row of findings) {
    assert.deepEqual([row.optional, row.chatYesNo, row.yesNo, row.plain.skip, row.answer.where], [true, false, undefined, 'Don\'t dispute (the author fixes it)', 'card'], row.title);
  }
  // One question, counted and asked: the re-pin. Nothing on the list is a yes or no a chat asks.
  const open = [...packet.items, ...packet.offered].filter((item) => !item.settled);
  assert.deepEqual(open.filter((item) => !item.optional && item.plain?.question).map((item) => item.kind), ['test-command']);
  assert.equal(open.filter((item) => item.chatYesNo).length, 0);
  assert.equal(packet.plain.headline, 'One question for you.');
  assert.equal(packet.plain.optional, 'Optional on the Decide card: dispute a reviewer\'s finding you disagree with.');
  assert.equal(waitsOnPerson(packet), true);
  assert.equal(waitsOnPerson({ ...packet, items: [] }), false, 'what is offered never waits on the person');
  // The /sf-decide turn: the re-pin is answered on the card, and the offered rows are one line it may say, never asked.
  const act = agentAct(packet);
  assert.equal(act.state, 'confirm-in-terminal', JSON.stringify(act));
  assert.match(act.said, /^One question for you\. What is left is answered on the Decide card, not in this chat: .* Say plain\.optional and plain\.settledLine once, as given; never ask them\.$/u);
  assert.equal(packet.plain.settledLine, 'Settled for you: starting version 3 of Implementation. Undo any on the Decide page.');
  assert.equal(act.ask, undefined);

  // Copilot CLI's card: one question named, the findings behind a choice of their own, and only the re-pin asked.
  const { form, offer } = card.firstForm(packet);
  assert.equal(offer, 'Dispute a reviewer\'s finding (4)');
  // Keeping everything first, since the form offers an undo; never an undo by default [owner, 2026-11-20].
  assert.deepEqual(form.requestedSchema.properties.choice.enum, [card.KEEP_ALL, card.EACH, `${card.UNDO_SETTLED} (1)`, offer]);
  assert.match(form.message, /^One question for you: 1\. Use the changed \.-node-tests command for Implementation\? /u);
  assert.ok(form.message.includes(` Optional, nothing waits on them: the reviewer's findings ${ids.slice(0, 3).join(', ')} and ${ids[3]}, which you may dispute if the reviewer is wrong; left alone, the author fixes them.`), form.message);
  const table = card.decisionsTable(packet);
  assert.match(table, /\*\*Optional; nothing waits on these\.\*\* Answer one only if you disagree: choose "Dispute a reviewer's finding" on the first form\.\n- The reviewer's finding AC001-browser-test-gap on Implementation version 2: The reviewer found: /u);
  assert.doesNotMatch(table, /\*\*(?:\d+\. )?Dispute the reviewer's finding/u, 'never a question on the card');
  const run = async (answer) => {
    const asked = [];
    const recorded = [];
    await card.runCard({ read: async () => packet, show: async () => {}, inspect: async () => {}, witness: async () => assert.fail('no sign-off'),
      record: async (listed, document) => { recorded.push(document); return { recorded: [] }; },
      ask: async (shown) => { asked.push(shown); return { action: 'accept', content: answer(shown.requestedSchema.properties) }; } });
    return { asked, recorded, rows: asked.filter((shown) => shown.requestedSchema.properties.decision0) };
  };
  const tcd = packet.items.find((item) => item.kind === 'test-command');
  const each = await run((fields) => (fields.choice ? { choice: card.EACH } : fields.decision0 ? { decision0: fields.decision0.enum[0] } : fields.confirm ? { confirm: card.RECORD } : {}));
  assert.equal(each.rows.length, 1);
  assert.deepEqual(Object.keys(each.rows[0].requestedSchema.properties), ['decision0'], 'only the re-pin is asked');
  assert.deepEqual(each.rows[0].requestedSchema.required, ['decision0']);
  assert.deepEqual(each.rows[0].requestedSchema.properties.decision0.enum, ['Accept the changed command as its pin', card.LEAVE]);
  assert.deepEqual(each.recorded.map((document) => document.choose), [{ [tcd.id]: 'accept-test-command' }]);
  // Choosing to dispute: the findings, none of them required, each skipping to its default; the re-pin still asked.
  const disputing = await run((fields) => (fields.choice ? { choice: offer } : fields.decision0
    ? { decision0: 'Dispute this finding', decision1: 'Don\'t dispute (the author fixes it)', decision4: card.LEAVE } : fields.reason ? { reason: REASON } : fields.confirm ? { confirm: card.RECORD } : {}));
  const [page] = disputing.rows;
  assert.deepEqual(page.requestedSchema.required, ['decision4'], 'only what waits is required');
  assert.deepEqual(page.requestedSchema.properties.decision0.enum, ['Don\'t dispute (the author fixes it)', 'Dispute this finding'], 'its default first, never the dispute');
  assert.deepEqual(disputing.recorded.map((document) => [document.choose, document.reason]), [[{ [findings[0].id]: 'dispute' }, { [findings[0].id]: REASON }]]);
  // No choice on any form says "undecided": each skip says what skipping does.
  const choices = [...each.asked, ...disputing.asked].flatMap((shown) => Object.values(shown.requestedSchema.properties).flatMap((field) => field.enum ?? []));
  assert.ok(choices.includes(card.LEAVE) && choices.includes('Don\'t dispute (the author fixes it)'));
  assert.doesNotMatch(JSON.stringify(choices), /undecided/iu);

  // The terminal and VS Code's Decide card: the same count, the findings under their own line, each skip in words.
  const terminal = packetText(packet);
  assert.match(terminal, new RegExp(`^Decide ${W} · Implementation\\. One question for you\\.\\n`, 'u'));
  assert.match(terminal, /\nOptional; nothing waits on these\. Answer one only if you disagree:\n\n\S+\. Dispute the reviewer's finding AC001-browser-test-gap on Implementation version 2\?\n/u);
  const html = decideHtml(packet);
  assert.match(html, /One question for you\./u);
  assert.equal(html.match(/<option value="">Don&#39;t dispute \(the author fixes it\)<\/option>|<option value="">Don't dispute \(the author fixes it\)<\/option>/gu)?.length, 4, html);
  assert.equal(html.match(/<option value="">Not now \(stays open\)<\/option>/gu)?.length, 1);
  assert.equal(html.match(/<span class="dc-tag">optional<\/span>/gu)?.length, 4);
  assert.doesNotMatch(html, /Leave undecided|<option value="">Choose…<\/option>/u);
  // One set of skip words: the Copilot CLI card, its convergence table and VS Code's card.
  assert.deepEqual([adjudicateLeave, vscodeStaysOpen, vscodeKeep, vscodeAsIs], [card.LEAVE, card.LEAVE, card.KEEP_SETTLED, card.LEAVE_AS_IS]);
});

test('with only offered rows left, nothing waits: no question is counted, and a chat that opened the card carries on', async () => {
  const { workflow, packet } = ownersList();
  const offeredOnly = withPlainWords(workflow, { ...packet, items: [] });
  assert.equal(offeredOnly.plain.headline, 'Nothing waits on you now.');
  assert.equal(offeredOnly.plain.afterAnswer, undefined);
  assert.equal(waitsOnPerson(offeredOnly), false);
  const asked = [];
  const result = await card.runCard({ askedInChat: true, read: async () => offeredOnly, show: async () => {}, inspect: async () => {}, witness: async () => assert.fail('nothing'),
    record: async () => assert.fail('nothing'), ask: async (shown) => { asked.push(shown); return { action: 'cancel' }; } });
  assert.equal(result.status, 'nothing-to-decide');
  assert.deepEqual(asked, [], 'a chat that asked is never stopped by what nothing waits on');
});

test('the author of the version opened for the findings is told not to make a disputed fix', () => {
  const report = { findings: [{ id: 'F-1', severity: 'blocking', message: 'Count the drafts.' }, { id: 'F-2', severity: 'blocking', message: 'List the drafts.' }] };
  const both = reviewCorrection({ report }, 1, [{ id: 'F-2', by: 'Bo', reason: REASON }]);
  assert.deepEqual(both.findings.map((entry) => entry.id), ['F-1']);
  assert.deepEqual(both.disputed, [{ id: 'F-2', words: `The reviewer's finding F-2 is disputed by Bo: ${REASON} Do not make that fix.` }]);
  const none = reviewCorrection({ report }, 1, [{ id: 'F-1', by: 'Bo', reason: REASON }, { id: 'F-2', by: 'Bo', reason: REASON }]);
  assert.deepEqual(none.findings, [], 'every finding disputed: nothing to fix, and each one said');
  assert.equal(none.disputed.length, 2);
});

test('only the person disputes: a /sf-decide turn runs it on their Yes to the question naming the finding, in their words', async (t) => {
  assert.deepEqual(PERSON_DECISIONS.find((step) => step.id === 'review-dispute')?.owners, ['decide']);
  assert.ok(ANSWER_BOUND_STEPS.includes('review-dispute'));
  assert.equal(OWN_TERMINAL_STEPS.some((step) => step.id === 'review-dispute'), false);
  const value = { contract: { workId: WORK, phaseId: 'specification' }, decisionEnded: false };
  const argv = (...extra) => ['review-source', 'dispute', 'specification', '--work-id', WORK, '--finding', 'F-1', '--reason', REASON, ...extra];
  assert.equal(argvAllowed(argv(), 'decision-only', value), true);
  assert.equal(argvAllowed(argv('--json'), 'decision-only', value), true);
  assert.equal(argvAllowed(['review-source', 'dispute', 'specification', '--work-id', 'OTHER-1', '--finding', 'F-1', '--reason', REASON], 'decision-only', value), false, 'another Story');
  assert.equal(argvAllowed(['review-source', 'decide', 'specification', '--work-id', WORK, '--finding', 'F-1', '--reason', REASON], 'decision-only', value), false);
  assert.equal(argvAllowed(argv(), 'decision-only', { ...value, decisionEnded: true }), false);

  const folder = await mkdtemp(path.join(os.tmpdir(), 'sflow-dispute-binding-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const ask = (question, answer) => ({ toolName: 'ask_user', toolArgs: { question }, toolResult: { resultType: 'success', textResultForLlm: `User responded: ${answer}` } });
  const command = { positionals: ['review-source', 'dispute', 'specification'], options: { 'work-id': WORK, finding: 'F-1', reason: REASON } };
  const question = 'The reviewer\'s finding F-1 on Specification version 1. Dispute this finding? Say why in at least 20 characters.';
  const run = async (name, answers, options = command.options) => {
    const record = { turnId: name };
    const file = path.join(folder, `${name}.json`);
    await startAnswerLedger(file, record, `/sf-decide ${WORK}`);
    for (const [asked, said] of answers) await noteQuestionAnswered(file, record, ask(asked, said));
    return unboundAnswerReason(file, record, options, { positionals: command.positionals });
  };
  assert.equal(await run('yes', [[question, 'Yes'], ['Why is the reviewer wrong?', REASON]]), null);
  assert.match(await run('other', [['Is the export right?', 'Yes'], ['Why?', REASON]]) ?? '', /^PHASE_MUTATION_ANSWER_UNBOUND/u, 'a Yes to another question');
  assert.match(await run('no', [[question, 'No'], ['Why?', REASON]]) ?? '', /answered No for this row/u);
  assert.match(await run('words', [[question, 'Yes'], ['Why?', 'Because I say so, really.']]) ?? '', /not what the person answered/u, 'the reason is the person\'s own');
  assert.match(await run('short', [[question, 'Yes'], ['Why?', 'Wrong.']], { ...command.options, reason: 'Wrong.' }) ?? '', /takes 20 to 1000/u);
});

// ------------------------------------------------------------------------------------------ a real Story, end to end

const executable = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'bin/singularity-flow.mjs');
const STORY = 'REVIEW-1';
const run = (root, ...args) => spawnSync(process.execPath, [executable, ...args], { cwd: root, encoding: 'utf8', timeout: childTimeout(60000),
  env: { ...process.env, SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.git/test-workspace-registry.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.git/test-active-workspace.json') } });
function cli(root, ...args) {
  const result = run(root, ...args);
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return result.stdout.trim();
}
const git = (root, ...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.trim();
async function retain(root, findings) {
  const packet = completeAgentResult(cli(root, 'review-source', 'context', 'specification', '--json'));
  const report = { ...reviewReport(packet), findings };
  await mkdir(path.dirname(packet.stagingPath), { recursive: true });
  await writeFile(packet.stagingPath, JSON.stringify(report));
  return { packet, retained: completeAgentResult(cli(root, 'review-source', 'submit', 'specification', '--report-file', packet.stagingPath, '--json')) };
}

test('a real Story: the person disputes F-001, it no longer blocks, and the same finding raised again shows as disputed', { timeout: 600_000 }, async (t) => {
  const { root, authorAgent } = await publishedSpecificationStory(t);
  const F1 = { id: 'F-001', severity: 'blocking', clauseId: `${STORY}:REQ-001`, message: 'The saved status needs a persisted-status requirement.' };
  const { retained } = await retain(root, [F1]);
  assert.ok(retained.findings.some((entry) => entry.code === 'reviewer-blocker' && entry.reviewFindingId === 'F-001'));
  // The exclusion is the review's own pending decision, decided as before.
  const decision = completeAgentResult(cli(root, 'review-source', 'decision-context', 'specification', '--work-id', STORY,
    '--finding', 'exclusion:export-exclusion', '--reason', 'Confirmed outside requested scope.', '--json'));
  cli(root, ...decision.commandGuidance.argv);

  // The decision list offers the finding's dispute, as a bound yes, with nothing recommended.
  const listed = completeAgentResult(cli(root, 'decisions', STORY, '--json'));
  const row = (listed.data ?? listed).offered?.find((item) => item.kind === 'review-finding');
  assert.equal(row?.details.finding, 'F-001', JSON.stringify((listed.data ?? listed).offered ?? null).slice(0, 2000));
  assert.equal(row.options[0].chat.command, `singularity-flow review-source dispute specification --work-id ${STORY} --finding F-001 --reason "<REASON>"`);

  // The reviewer never disputes its own review, and a dispute takes the person's reason.
  const head = git(root, 'rev-parse', 'HEAD');
  cli(root, 'agent', '--agent', 'sflow-source-reviewer');
  const reviewer = run(root, 'review-source', 'dispute', 'specification', '--work-id', STORY, '--finding', 'F-001', '--reason', REASON, '--json');
  assert.notEqual(reviewer.status, 0);
  assert.match(`${reviewer.stdout}${reviewer.stderr}`, /cannot dispute its own review/u);
  cli(root, 'agent', '--agent', authorAgent);
  const short = run(root, 'review-source', 'dispute', 'specification', '--work-id', STORY, '--finding', 'F-001', '--reason', 'Wrong.', '--json');
  assert.notEqual(short.status, 0);
  assert.match(`${short.stdout}${short.stderr}`, /REVIEW_DISPUTE_REASON_REQUIRED/u);
  const unknown = run(root, 'review-source', 'dispute', 'specification', '--work-id', STORY, '--finding', 'F-009', '--reason', REASON, '--json');
  assert.match(`${unknown.stdout}${unknown.stderr}`, /has no blocking finding F-009; its blocking findings are F-001/u);
  assert.equal(git(root, 'rev-parse', 'HEAD'), head, 'nothing was recorded');

  const disputed = completeAgentResult(cli(root, 'review-source', 'dispute', 'specification', '--work-id', STORY, '--finding', 'F-001', '--reason', REASON, '--json'));
  assert.match(disputed.words, new RegExp(`^The reviewer's finding F-001 is disputed by Review Driver: ${REASON.replace(/[.]/gu, '\\.')} Nothing the reviewer found blocks version 1 of Specification now\\. Specification's approvers see the dispute and its reason`, 'u'));
  assert.deepEqual(disputed.blocking, []);
  const status = completeAgentResult(cli(root, 'review-source', 'status', 'specification', '--json'));
  assert.equal(status.status, 'ready', JSON.stringify(status.findings));
  assert.deepEqual(status.disputedFindings.map((entry) => [entry.id, entry.by, entry.reason]), [['F-001', 'Review Driver', REASON]]);
  // The record is the review's own decision, with the exact finding and version.
  const decisions = path.join(root, 'singularity/work-items', STORY, 'context/reviews/specification/gen-1/decisions', status.reportSha256);
  const records = await Promise.all((await readdir(decisions)).map(async (name) => JSON.parse(await readFile(path.join(decisions, name), 'utf8'))));
  const record = records.find((entry) => entry.id === 'dispute:F-001');
  assert.equal(record.decision, 'accepted');
  assert.equal(record.generation, 1);
  assert.deepEqual([record.finding.id, record.finding.clauseId, record.reason], ['F-001', `${STORY}:REQ-001`, REASON]);
  const again = run(root, 'review-source', 'dispute', 'specification', '--work-id', STORY, '--finding', 'F-001', '--reason', REASON, '--json');
  assert.match(`${again.stdout}${again.stderr}`, /REVIEW_DISPUTE_ALREADY_RECORDED/u);

  // The reviewer is told what was disputed; raising the same finding again, it shows as disputed, and a new one blocks.
  const next = await retain(root, [{ ...F1, message: 'Persisted status is still not a requirement.' },
    { id: 'F-002', severity: 'blocking', clauseId: `${STORY}:AC-001`, message: 'Saved status needs a time limit.' }]);
  assert.deepEqual(next.packet.disputedEarlier.map((entry) => [entry.id, entry.version, entry.reason]), [['F-001', 1, REASON]]);
  const later = completeAgentResult(cli(root, 'review-source', 'status', 'specification', '--json'));
  assert.deepEqual(later.disputedFindings.map((entry) => [entry.id, entry.reason, entry.carriedFrom?.generation]), [['F-001', REASON, 1]]);
  assert.deepEqual(later.findings.filter((entry) => entry.code === 'reviewer-blocker').map((entry) => entry.reviewFindingId), ['F-002']);
});

test('a real Story: disputed after its next version opened, that version stays open and its author is told not to make the fix', { timeout: 600_000 }, async (t) => {
  const { root } = await publishedSpecificationStory(t);
  const F1 = { id: 'F-001', severity: 'blocking', clauseId: `${STORY}:REQ-001`, message: 'The saved status needs a persisted-status requirement.' };
  await retain(root, [F1]);
  // The person's yes to the review's question opens version 2 for its findings.
  const preview = completeAgentResult(cli(root, 'phase', 'rollover', 'specification', '--json'));
  assert.equal(preview.toGeneration, 2);
  cli(root, 'phase', 'rollover', 'specification', '--confirm', preview.confirmation, '--json');
  // While version 2 is being written, the finding is still a row to dispute, and the dispute says what stays.
  const listed = completeAgentResult(cli(root, 'decisions', STORY, '--json'));
  const row = (listed.data ?? listed).offered?.find((item) => item.kind === 'review-finding');
  assert.equal(row?.details.writing, 2, JSON.stringify((listed.data ?? listed).offered ?? null).slice(0, 2000));
  assert.match(row.why, /Version 2 is being written to fix it\./u);
  const disputed = completeAgentResult(cli(root, 'review-source', 'dispute', 'specification', '--work-id', STORY, '--finding', 'F-001', '--reason', REASON, '--json'));
  assert.deepEqual(disputed.openVersion, { version: 2, allDisputed: true });
  assert.match(disputed.words, /Version 2 of Specification stays open: an open version can't be withdrawn\. Every finding it was started for is disputed now, so its author is told not to make that fix;/u);
  // The author's entry for version 2: nothing to fix, and the disputed finding named so it is not fixed.
  const entry = completeAgentResult(cli(root, 'phase', 'enter', 'specification', '--for-agent', '--json'));
  assert.deepEqual(entry.reviewCorrection?.findings, [], JSON.stringify(entry.reviewCorrection ?? entry.status));
  assert.deepEqual(entry.reviewCorrection.disputed.map((item) => item.id), ['F-001']);
  assert.match(entry.reviewCorrection.disputed[0].words, /^The reviewer's finding F-001 is disputed by Review Driver: .* Do not make that fix\.$/u);
});

test('a real Story: a step with a disputed finding is approved by a person, who sees the dispute and its reason', { timeout: 600_000 }, async (t) => {
  const { root } = await publishedSpecificationStory(t);
  await retain(root, [{ id: 'F-001', severity: 'blocking', clauseId: `${STORY}:REQ-001`, message: 'The saved status needs a persisted-status requirement.' }]);
  const decision = completeAgentResult(cli(root, 'review-source', 'decision-context', 'specification', '--work-id', STORY,
    '--finding', 'exclusion:export-exclusion', '--reason', 'Confirmed outside requested scope.', '--json'));
  cli(root, ...decision.commandGuidance.argv);
  cli(root, 'review-source', 'dispute', 'specification', '--work-id', STORY, '--finding', 'F-001', '--reason', REASON);
  for (const item of JSON.parse(cli(root, 'evidence', 'scope', '--json')).data.scope.items.filter((entry) => entry.disposition === 'unresolved')) {
    cli(root, 'decision', 'scope', '--item', item.id, '--as', 'excluded', '--reason', 'Outside what this review fixture specifies; another Story owns it.');
  }
  // The reviewer did not say ready on its own, so SFlow never approves it: a person does, with the dispute in view.
  const submitted = cli(root, 'submit', 'specification', '--skip-checks');
  assert.doesNotMatch(submitted, /Approved Specification v1 automatically/u);
  assert.match(submitted, /needs your approval: a person disputed the reviewer's finding F-001/u);
  const listed = completeAgentResult(cli(root, 'decisions', STORY, '--json'));
  const approval = (listed.data ?? listed).items.find((item) => item.kind === 'approval');
  assert.deepEqual(approval.details.disputes.map((entry) => entry.words), [`The reviewer's finding F-001 is disputed by Review Driver: ${REASON}`]);
  const shown = completeAgentResult(cli(root, 'phase', 'show', 'specification', '--json'));
  assert.deepEqual(shown.reviewDisputes.map((entry) => [entry.finding, entry.by, entry.reason]), [['F-001', 'Review Driver', REASON]]);
  assert.match(cli(root, 'phase', 'show', 'specification'), /Disputed review findings \(return the step if you agree with the reviewer\):\n {2}The reviewer's finding F-001 is disputed by Review Driver: /u);
});
