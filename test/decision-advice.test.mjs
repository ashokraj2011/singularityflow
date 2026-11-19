/**
 * "Decisions are really confusing" [owner, 2026-11-13]: every item on the one decisions card shows its recommended
 * answer, with a one-line why, and every choice one line on what it does to the Story; when SFlow cannot tell, it says
 * what the person must weigh. A chat asks only a plain yes or no, bound to the person's own typed answer; every other
 * person decision, approvals included, is on the card on every host. Deterministic: read from the facts, never a model.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { noteQuestionAnswered, noteQuestionAsked, startAnswerLedger, unboundAnswerReason } from '../src/copilot-answer-binding.mjs';
import { advisedItem, itemRecommendation, optionDoes, yesNoOf } from '../src/decision-advice.mjs';
import { plainItem, withPlainWords } from '../src/decision-plain.mjs';
import { decisionPacket, PENDING_ITEM_KINDS } from '../src/decision-list.mjs';
import { packetText } from '../src/commands/decisions.mjs';
import { formatCommandRouteLines, modelFreeCommandForArgv, VSCODE_DECIDE_CARD } from '../src/model-free-commands.mjs';
import { safeCommandGuidance } from '../src/safe-command-guidance.mjs';
import { cardRows, choicesFromRows, decisionsTable, detailForm, rowForms } from '../plugin/extensions/decisions/card.mjs';
import { DECIDE_SCRIPT, decideHtml, decideRows } from '../apps/vscode/src/views/decide-card-page.ts';
import { buildDecisionListView } from '../apps/vscode/src/views/decision-list-model.ts';
import { decisionListHtml, DECISION_LIST_SCRIPT } from '../apps/vscode/src/views/decision-list-page.ts';

const AT = '2026-11-13T09:00:00.000Z';
const WORK = 'DEC-7';
const HASH = /sha256:|\b[a-f0-9]{40,64}\b/u;

function story({ status = 'in_progress' } = {}) {
  const group = (label) => ({ label, allowAnyGitIdentity: true, members: [] });
  return {
    workItem: { id: WORK }, status: 'in_progress', currentPhase: 'implementation',
    phaseOrder: ['specification', 'implementation', 'release'],
    phases: {
      specification: { id: 'specification', label: 'Specification', status: 'approved', generation: 1, approvalPolicy: { authorities: ['product'] } },
      implementation: { id: 'implementation', label: 'Implementation', status, generation: 2, writeScope: 'source-and-artifact',
        approvalPolicy: { authorities: ['engineering'] } },
      release: { id: 'release', label: 'Release', status: 'pending', generation: 0, approvalPolicy: { authorities: ['release'] } }
    },
    resolution: { approvalAuthorities: { product: group('Product approvers'), engineering: group('Engineering reviewers'), release: group('Release approvers') } },
    upstreamIssues: [], upstreamIssueDecisions: []
  };
}
const actor = { name: 'Decider', email: 'decider@example.invalid', login: null };
// As `decisions` reads it: with every item's plain words (decision-list-reads.mjs).
const packetOf = (workflow, facts) => withPlainWords(workflow, decisionPacket(workflow, { phaseId: 'implementation', at: AT, gaps: [], issues: [], candidates: [], reuseProblems: [],
  testRisks: [], unavailable: [], state: {}, ...facts }, { authorities: workflow.resolution.approvalAuthorities, actor, at: AT }));

/** A list with most kinds on it at once, built from the same facts `decisions` reads. */
function broadPacket(workflow = story()) {
  return packetOf(workflow, {
    testRisks: [{ phase: 'implementation', commandId: 'unit', status: 'failed', exitCode: 1, causeClass: null }],
    testNarrowings: [{ phase: 'implementation', commandId: 'unit', words: 'only test/a.test.mjs ran', reasons: [] }],
    nodePin: { phase: 'implementation', file: '.nvmrc', version: '22', node: '22.1.0', words: 'The tests ask for Node 22.', stage: 'early', tried: { passed: true, words: 'It passes on Node 22.' } },
    visual: [{ phase: 'implementation', profileId: 'mobile', label: 'Mobile', title: 'No screenshot at Mobile', why: 'Mobile is required.',
      options: [{ id: 'capture', label: 'Capture it', detail: 'Take the screenshot.', command: `singularity-flow evidence capture ${WORK}` },
        { id: 'not-applicable', label: 'It does not apply', detail: 'Mobile is not shipped.', available: true }] }],
    pending: {
      applicability: [{ responsibility: 'scope', authority: 'product', declaredReason: 'This workflow takes its scope from the Epic.' }],
      owed: [{ kind: 'scope', id: 'SRI-0001', text: 'Users can export the report.', groups: ['product'], clauses: [`${WORK}:REQ-001`] }]
    },
    excludedChanges: { unclaimedPaths: ['src/export.js'], planRows: [{ clauseId: `${WORK}:REQ-001`, result: 'new' }], waits: 'publishing this step would leave it out' },
    departures: { phase: 'implementation', planRows: [], codeStepOpen: true, findingTitles: {}, acceptance: {}, reopens: {}, tests: {},
      entries: [{ departure: { id: 'DEP-001', kind: 'supporting', phase: 'implementation', paths: ['package-lock.json'], class: 'lockfile', reason: 'The lockfile moved.', recordedBy: 'sflow' },
        status: 'open', groups: ['engineering'], words: 'package-lock.json changed', acceptAll: true }] },
    rollover: { phase: 'implementation', generation: 2, next: 3, paths: ['src/late.js'], uncommitted: ['src/late.js'], requests: [],
      command: 'singularity-flow phase rollover implementation', keepOut: `singularity-flow recover ${WORK} --phase implementation --json`, chatRoute: '/sf-code implementation', code: true }
  });
}

test('every item kind the list builds has a recommendation or says what to weigh, and every choice says what it does', () => {
  const workflow = story();
  // One synthetic item per kind, shaped as its builder shapes it: the advice reads only kind, details and options.
  const choice = (id, label, effects = [], extra = {}) => ({ id, label, recommended: false, words: `${label}.`, effects, needs: {}, decidedBy: { allowed: true, words: '' }, ...extra });
  const own = (id, label, command, extra = {}) => choice(id, label, [], { recordable: false, action: { command, alternativeCommands: [] }, ...extra });
  const decision = (outcome, phase = 'implementation') => ({ kind: 'upstream-issue-decision', issue: 'UPI-001', issuePhase: phase, outcome });
  const expires = { expires: { default: '2026-12-13', latest: '2027-02-11' } };
  const kinds = {
    'conformance-gap': { details: { clauses: [`${WORK}:REQ-001`], verdicts: ['partial'], owner: 'implementation', reuse: null },
      options: [choice('accept-risk', 'Accept the gap', [decision('accept-risk')], { needs: expires }), choice('dismiss', 'Dismiss it', [decision('dismiss')]), choice('return', 'Return the work', [decision('return')])] },
    'upstream-issue': { details: { phase: 'implementation', status: 'open', proposed: 'unknown' },
      options: [choice('accept-risk', 'Accept it', [decision('accept-risk')], { needs: expires }), choice('dismiss', 'Dismiss it', [decision('dismiss')])] },
    'visual-profile': { details: { label: 'Mobile' }, options: [own('capture', 'Capture it', 'singularity-flow evidence capture'), choice('not-applicable', 'It does not apply', [{ kind: 'visual-profile', phase: 'implementation', profileId: 'mobile' }])] },
    'node-pin': { details: { version: '22', tried: true }, options: [choice('pin-node', 'Pin Node 22', [{ kind: 'node-pin', phase: 'implementation', file: '.nvmrc', version: '22' }])] },
    'test-run-risk': { details: { commandId: 'unit' }, options: [choice('accept-test-risk', 'Accept it', [{ kind: 'test-run-risk', phase: 'implementation', commandId: 'unit' }], { needs: expires })] },
    'test-narrowing': { details: { commandId: 'unit' }, options: [choice('accept-test-narrowing', 'Accept it', [{ kind: 'test-narrowing', phase: 'implementation', commandId: 'unit' }])] },
    'test-command': { details: { command: { id: 'e2e' }, repin: { diff: [] } }, options: [choice('accept-test-command', 'Accept it', [{ kind: 'test-command', phase: 'implementation', request: 'TCD-001' }])] },
    'evidence-obligation': { details: {}, options: [own('witness-1', 'Sign off shot.png', 'singularity-flow decision witness', { action: { command: 'x', humanReview: { clauseId: `${WORK}:AC-001`, files: ['shot.png'] } } }),
      choice('accept-obligation-risk-known-failure', 'Accept it as a risk', [{ kind: 'obligation-risk', obligation: 'OBL-1', category: 'known-failure' }], { needs: expires })] },
    'owed-decision': { details: { responsibility: 'scope', declaredReason: 'The Epic holds the scope.' }, options: [choice('does-not-apply', 'It does not apply', [{ kind: 'applicability', responsibility: 'scope' }], { chat: { command: 'x --reason "<REASON>"' } })] },
    'plan-accounting': { details: { path: 'src/a.js' }, options: [choice('row-req-001', 'Add to REQ-001', [{ kind: 'plan-amendment', change: { kind: 'add-location', clauseId: `${WORK}:REQ-001`, path: 'src/a.js' } }])] },
    departure: { details: { departureKind: 'path', status: 'open', clauses: [] }, options: [choice('accept', 'Accept', [{ kind: 'departure', decision: 'accept', writes: 'plan-amendment', changes: [] }]), choice('reject', 'Reject', [{ kind: 'departure', decision: 'reject' }])] },
    'convergence-item': { details: { itemKinds: ['failing-bound-test'] }, options: ['rework', 'accepted-deviation', 'dismissed'].map((id) => choice(id, id, [{ kind: 'convergence-adjudication', disposition: id, items: ['CF-1'] }])) },
    'asked-for': { details: {}, options: [own('account', 'Its author accounts for it', 'singularity-flow departure account', { decidedBy: { allowed: false, author: true, words: '' } })] },
    'generation-rollover': { details: { paths: ['src/late.js'], requested: false, chatRoute: '/sf-code implementation' },
      options: [own('start-next-generation', 'Start generation 3', 'singularity-flow phase rollover implementation')] },
    'routing-decision': { details: { reason: 'ask' }, options: [choice('choose-a', 'Route A', [{ kind: 'routing', option: 'a' }]), choice('choose-b', 'Route B', [{ kind: 'routing', option: 'b' }])] },
    'intent-amendment': { details: { status: 'proposed' }, options: [choice('reject', 'Reject IAM-001', [{ kind: 'intent-amendment-decision', decision: 'reject' }]), choice('approve', 'Approve IAM-001', [{ kind: 'intent-amendment-decision', decision: 'approve' }])] },
    'forward-amendment': { details: { phase: 'specification' }, options: [own('decide', 'Approve or reject it', 'singularity-flow upstream-issue decide-amendment FAM-001')] },
    revalidation: { details: { phase: 'release' }, options: [choice('still-holds', 'Release still holds', [{ kind: 'amendment-revalidation', phase: 'release', outcome: 'unchanged' }]),
      choice('return-step', 'Return the Story to Release', [{ kind: 'amendment-revalidation', phase: 'release', outcome: 'return' }])] },
    appeal: { details: {}, options: [own('review', 'Review the appeal', 'singularity-flow appeal show APL-1')] },
    'approval-hold': { details: {}, options: [own('route', 'Clear the checkout', 'singularity-flow recover DEC-7 --json')] },
    'story-publication': { machine: true, details: {}, options: [own('sync', 'Publish it', `singularity-flow sync ${WORK}`)] },
    'transport-intent': { machine: true, details: {}, options: [own('sync', 'Publish it', 'singularity-flow sync TI-1')] },
    approval: { details: { ready: true, heldBy: [] }, options: [own('approve', 'Review and approve Implementation', `singularity-flow approve implementation --work-id ${WORK} --fetch`)] }
  };
  assert.deepEqual(PENDING_ITEM_KINDS.filter((kind) => !kinds[kind]), [], 'a kind the list builds has no row in this table');
  for (const [kind, shape] of Object.entries(kinds)) {
    const item = advisedItem(workflow, { id: 'd1', kind, title: kind, why: `Why ${kind} waits.`, decidedBy: { allowed: true, words: '' }, ...shape });
    const { recommended } = item;
    assert.ok(recommended?.words && recommended.why, `${kind}: no recommendation`);
    if (recommended.option) {
      assert.ok(item.options.some((entry) => entry.id === recommended.option && entry.available !== false), `${kind}: recommends a choice it does not offer`);
      assert.match(recommended.words, /^Recommended: /u, kind);
    // Every item recommends [owner, 2026-11-16]: a choice, what to do first, or which choice when.
    } else assert.match(recommended.words, /^Recommended(?: first)?: /u, kind);
    assert.doesNotMatch(recommended.words, /No recommendation/u, kind);
    // And in plain words: a question, why in one sentence, and the recommendation.
    const plain = plainItem(workflow, item);
    assert.ok(plain.later || (plain.question?.endsWith('?') && plain.why && /^Recommended: /u.test(plain.recommended)), `${kind}: ${JSON.stringify(plain)}`);
    for (const entry of item.options) {
      assert.ok(typeof entry.does === 'string' && entry.does.length > 10, `${kind}/${entry.id}: no effect said`);
      assert.doesNotMatch(entry.does, HASH, `${kind}/${entry.id}`);
    }
    assert.doesNotMatch(recommended.words, HASH, kind);
  }
});

test('each recommendation follows its facts: a run on unchanged code, a failed check, a stale amendment, a green approval', () => {
  const workflow = story();
  const rec = (item) => itemRecommendation(workflow, { id: 'd1', title: 't', why: 'w', decidedBy: { allowed: true }, ...item });
  const choice = (id, extra = {}) => ({ id, label: id, recommended: false, effects: [], needs: {}, ...extra });
  // A recorded run on unchanged code covers the gap: reuse it.
  assert.equal(rec({ kind: 'conformance-gap', details: { clauses: ['X'], verdicts: ['partial'], owner: 'implementation', reuse: { recordedBy: 'implementation' } },
    options: [choice('reuse', { recommended: true }), choice('accept-risk'), choice('return')] }).option, 'reuse');
  // Nothing covers it: return the work over accepting a risk.
  assert.equal(rec({ kind: 'conformance-gap', details: { clauses: ['X'], verdicts: ['missing'], owner: 'implementation' }, options: [choice('accept-risk'), choice('dismiss'), choice('return')] }).option, 'return');
  // Tests that cannot run here: fix the environment first; accepting is never what SFlow recommends.
  const risk = rec({ kind: 'test-run-risk', details: { commandId: 'unit' }, options: [choice('accept-test-risk')] });
  assert.deepEqual([risk.option, /^Recommended first: fix the environment/u.test(risk.words)], [null, true]);
  // A proposal the Story moved under is refreshed; an amendment nobody can judge for the person is left to weigh.
  assert.equal(rec({ kind: 'intent-amendment', details: { status: 'proposed' }, options: [choice('refresh', { recommended: true }), choice('reject'), choice('approve')] }).option, 'refresh');
  assert.match(rec({ kind: 'intent-amendment', details: { status: 'proposed' }, options: [choice('reject'), choice('approve')] }).words, /^Recommended: Approve it only if the approved clauses should change as shown/u);
  // An approval nothing holds: approve; one still held: decide what holds it first.
  assert.equal(rec({ kind: 'approval', details: { ready: true, heldBy: [] }, options: [choice('approve')] }).option, 'approve');
  assert.match(rec({ kind: 'approval', details: { ready: false, heldBy: ['d1', 'd2'] }, options: [choice('approve')] }).words, /^Recommended first: decide d1 and d2 above/u);
  // A scope statement no clause states: no one disposition is right whatever the facts, so it says which one when.
  assert.match(rec({ kind: 'owed-decision', details: { scopeItem: 'SRI-1' }, options: [choice('scope-included'), choice('scope-excluded')] }).words, /^Recommended: Included, naming its clause, if this Story delivers it/u);
  // A Node pin: from SFlow's own check of this code, or "Check first" until it has one [owner, 2026-11-16].
  const pin = (details) => rec({ kind: 'node-pin', details: { version: '22', ...details }, options: [choice('pin-node')] });
  assert.deepEqual([pin({ tried: true }).option, pin({ tried: true }).why], ['pin-node', 'Tests pass on Node 22 (checked).']);
  assert.match(pin({ tried: false }).words, /^Recommended: Leave it: tests fail on Node 22 too \(checked\), so the Node is not the cause\.$/u);
  assert.deepEqual([pin({}).check, pin({}).option], [true, null]);
  assert.equal(pin({ probe: { status: 'unknown', cutShort: true, seconds: 60 } }).why, 'The check did not finish within 60 seconds.');
});

test('what a choice does names the generation it opens and the one that stays, and the day a risk ends', () => {
  const workflow = story();
  const back = optionDoes(workflow, { kind: 'upstream-issue', details: {} }, { id: 'return', label: 'Return', effects: [{ kind: 'upstream-issue-decision', issuePhase: 'implementation', outcome: 'return' }] });
  assert.equal(back, 'Returns the work to Implementation: opens generation 3 of Implementation; generation 2 and its evidence stay, and the steps after it run again.');
  const risk = optionDoes(workflow, { kind: 'conformance-gap', details: {} }, { id: 'accept-risk', label: 'Accept', needs: { expires: { default: '2026-12-01', latest: '2027-02-01' } },
    effects: [{ kind: 'upstream-issue-decision', issuePhase: 'implementation', outcome: 'accept-risk' }] });
  assert.match(risk, /^Accepted as a risk until 2026-12-01 \(or the day you choose\): the verdict stays as written, tests still run/u);
});

test('the decisions list carries the advice on every item, the approval and the rollover included, outside the digest', () => {
  const packet = broadPacket();
  const kinds = packet.items.map((item) => item.kind);
  for (const kind of ['test-run-risk', 'test-narrowing', 'node-pin', 'visual-profile', 'owed-decision', 'plan-accounting', 'departure', 'generation-rollover']) {
    assert.ok(kinds.includes(kind), `${kind} is not on the list: ${kinds.join(', ')}`);
  }
  for (const item of [...packet.items, ...(packet.offered ?? [])]) {
    assert.ok(item.recommended?.words, `${item.id} ${item.kind}`);
    assert.ok(item.options.every((entry) => entry.does), `${item.id} ${item.kind}`);
    assert.ok(item.answer?.words, `${item.id} ${item.kind}: where it is answered`);
  }
  const rollover = packet.items.find((item) => item.kind === 'generation-rollover');
  assert.deepEqual(rollover.options.map((entry) => entry.id), ['start-next-generation', 'set-aside']);
  assert.equal(rollover.options[0].does, 'Opens version 3 of Implementation with the change; version 2 and its evidence and test results stay as published.');
  assert.match(rollover.recommended.words, /^Recommended: Keep src\/late\.js in a new version if it belongs in this step; otherwise set it aside\.$/u);
  assert.equal(rollover.options[0].action.command, 'singularity-flow phase rollover implementation', 'the person\'s own terminal previews it and asks them to confirm');
  // Its preview waits for the person's yes, or their yes is kept: that question asks it once, on every card and in the
  // terminal, and this row keeps only leaving the change out, in versions [D3, OSA:REQ-030, stage5b.md section 5].
  const asked = packetOf(story(), { rollover: { phase: 'implementation', generation: 2, next: 3, paths: ['src/late.js'], uncommitted: ['src/late.js'], requests: [],
    command: 'singularity-flow phase rollover implementation', keepOut: `singularity-flow recover ${WORK} --phase implementation --json`, asked: true,
    chatRoute: '/sf-code implementation', code: true } }).items.find((item) => item.kind === 'generation-rollover');
  assert.deepEqual(asked.options.map((entry) => entry.id), ['set-aside']);
  assert.equal(asked.title, 'Leave the change out of Implementation instead of starting version 3');
  assert.match(asked.why, /^src\/late\.js changed after version 2 of Implementation was published, .* Starting version 3 with the change is asked on its own; or leave the change out\.$/u);
  assert.equal(asked.options[0].does, 'Sets the changed files aside with a private copy; version 2 goes ahead as published, without them.');
  assert.match(asked.recommended.words, /^Recommended: Answer the question about version 3 first; leave the change out only if it does not belong in this step\.$/u);
  assert.equal(asked.yesNo ?? null, null, 'nothing asks it in chat a second time');
  assert.doesNotMatch(JSON.stringify(asked), /generation [0-9]|Generation [0-9]/u, 'a person reads versions');
  // The node pin's try passed: pin it.
  assert.equal(packet.items.find((item) => item.kind === 'node-pin').recommended.option, 'pin-node');
  // The workflow says why scope does not apply here.
  assert.equal(packet.items.find((item) => item.details?.responsibility).recommended.option, 'does-not-apply');
  // The advice is read from what the digest already binds: the same facts give the same digest whatever the words.
  assert.equal(broadPacket().packetSha256, packet.packetSha256);
  // The approval is an item of the list too, with its recommendation and where it is opened.
  const awaiting = packetOf(story({ status: 'awaiting_approval' }), {});
  const approval = awaiting.items.at(-1);
  assert.equal(approval.kind, 'approval');
  assert.equal(approval.recommended.option, 'approve');
  assert.match(approval.answer.words, /^Open it from the Decide card \(\/sf-decide DEC-7\), which opens its documents to review and approve/u);
});

test('only a binary item may be answered yes or no in chat, through the command bound to the person\'s typed answer', async (t) => {
  const packet = broadPacket();
  const yesNo = Object.fromEntries(packet.items.map((item) => [item.details?.responsibility ? 'applicability' : item.details?.scopeItem ? 'scope' : item.kind, item.chatYesNo]));
  // A responsibility (one choice), an accept-or-reject departure and the next generation are yes or no; a scope
  // statement (seven dispositions), a test risk (a date), a row choice and a person's own steps are not.
  assert.deepEqual(yesNo, { 'test-run-risk': false, 'test-narrowing': false, 'node-pin': false, 'visual-profile': false, applicability: true, scope: false,
    'plan-accounting': true, departure: true, 'generation-rollover': true });
  const departure = packet.items.find((item) => item.kind === 'departure');
  assert.deepEqual([departure.yesNo.yes, departure.yesNo.no, departure.yesNo.route], ['accept', 'reject', `/sf-decide ${WORK}`]);
  assert.equal(packet.items.find((item) => item.kind === 'generation-rollover').yesNo.route, '/sf-code implementation', 'its step\'s own skill asks it, as before');
  assert.match(departure.answer.words, /or answer yes or no in chat \(\/sf-decide DEC-7\)\.$/u);
  assert.equal(yesNoOf(story(), { kind: 'upstream-issue', options: [{ id: 'dismiss', chat: { command: 'x' } }, { id: 'return', chat: { command: 'y' } }] }), null,
    'two choices that are not accept and reject are a pick, not a yes or no');
  // The yes is that option's own chat command: the reason is the person's, and the binding refuses any other words.
  const applicability = packet.items.find((item) => item.details?.responsibility);
  const yes = applicability.options.find((entry) => entry.id === applicability.yesNo.yes);
  assert.match(yes.chat.command, /--reason "<REASON>"$/u);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-yes-no-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'turn.mutation.json');
  const record = { turnId: 'turn-1' };
  await startAnswerLedger(file, record, `/sf-decide ${WORK}`);
  await noteQuestionAsked(file, record);
  await noteQuestionAnswered(file, record, { toolName: 'ask_user', toolResult: { textResultForLlm: 'User responded: Yes. The Epic already holds this Story\'s scope.' } });
  assert.equal(await unboundAnswerReason(file, record, { reason: 'The Epic already holds this Story\'s scope.' }), null);
  assert.match(await unboundAnswerReason(file, record, { reason: 'A reason the model wrote for the person.' }), /^PHASE_MUTATION_ANSWER_UNBOUND/u);
  // VS Code's own chat may never hand the hook its answer: a yes or no is then sent to the card, never asked again in a loop.
  const local = { turnId: 'turn-2' };
  await startAnswerLedger(file, local, `/sf-decide ${WORK}`);
  await noteQuestionAsked(file, local);
  const revalidate = { 'work-id': WORK, amendment: 'AMD-001', outcome: 'unchanged', reason: 'The design names none of the changed clauses.' };
  const unseen = await unboundAnswerReason(file, local, revalidate, { localChat: true, positionals: ['upstream-issue', 'revalidate', 'fix-design'] });
  assert.match(unseen, /do not ask again in this chat\. The person answers it on the decisions card/u);
  assert.doesNotMatch(unseen, /Ask them that row's yes-or-no question/u);
  // Where the answers do arrive, a missing yes or no is asked for again.
  assert.match(await unboundAnswerReason(file, local, revalidate, { positionals: ['upstream-issue', 'revalidate', 'fix-design'] }), /Ask them that row's yes-or-no question/u);
});

test('under SF Guard no row offers chat, and every host says it is recorded in the person\'s own terminal [owner, 2026-11-14]', () => {
  const open = broadPacket();
  const guarded = story();
  guarded.resolution.presence = { status: 'required', chainId: 'chain-1' };
  const packet = { ...broadPacket(guarded), packetSha256: `sha256:${'a'.repeat(64)}` };
  const chatRows = open.items.filter((item) => item.answer?.where === 'chat');
  assert.deepEqual(chatRows.map((item) => item.kind).sort(), ['departure', 'owed-decision', 'owed-decision', 'plan-accounting'], 'an applicability, a scope statement, a departure, a plan row');
  const own = `SF Guard signs it, so it is recorded in your own terminal (singularity-flow decisions record ${WORK}), never in chat.`;
  for (const before of chatRows) {
    const item = packet.items.find((entry) => entry.id === before.id);
    assert.deepEqual([item.guardSigns, item.chatYesNo, item.options.some((entry) => entry.chat), item.answer.where], [true, false, false, 'terminal'], `${item.kind} ${item.title}`);
    assert.equal(item.answer.words, `Answer it on the Decide card: /sf-decide ${WORK} opens it. ${own}`);
    assert.equal(item.recommended.words, before.recommended.words, 'it still recommends');
  }
  assert.equal(broadPacket(guarded).packetSha256, open.packetSha256, 'what a person confirms is the same list');
  // Its step's own skill still asks a rollover, which SF Guard does not sign.
  assert.equal(packet.items.find((item) => item.kind === 'generation-rollover').chatYesNo, true);
  for (const [host, text] of [['terminal', packetText(packet)], ['VS Code', decideHtml(packet).replaceAll('&#39;', '\'')], ['Copilot CLI', decisionsTable(packet)]]) {
    assert.ok(text.includes(own), host);
    assert.ok(!text.includes(`yes or no in chat (/sf-decide ${WORK})`), host);
  }
  // Without SF Guard each yes or no names its row and the reason it takes, as the answer binding reads it.
  const departure = open.items.find((item) => item.kind === 'departure');
  // The recommended answer needs no reason; the question says so, and which side takes one [owner, 2026-11-19, C10].
  assert.equal(departure.yesNo.question, 'DEP-001: package-lock.json changed. Accept? Recommended: yes. It is a supporting file the change needs; accepting lists it in the plan, and no step is reset. A no says why in at least 20 characters.');
  // Saying a responsibility does not apply is an exception: recommended or not, it keeps the person's reason.
  assert.equal(open.items.find((item) => item.details?.responsibility).yesNo.question, 'Say why scope does not apply. It does not apply to this Story? Recommended: yes. The workflow says why: This workflow takes its scope from the Epic. Record it if that holds for this Story. Say why in at least 20 characters.');
});

test('every host shows the recommendation and what each choice does; the approval opens its page from the card', async () => {
  const packet = { ...broadPacket(), packetSha256: `sha256:${'a'.repeat(64)}` };
  const awaiting = packetOf(story({ status: 'awaiting_approval' }), { testRisks: [{ phase: 'implementation', commandId: 'unit', status: 'failed', exitCode: 1, causeClass: null }] });
  const risk = packet.items.find((item) => item.kind === 'test-run-risk');
  const accept = risk.options[0];
  // VS Code's Decide card.
  const html = decideHtml(packet);
  assert.ok(html.includes('Recommended: Fix the environment and run unit again.'), 'the recommendation, in plain words');
  assert.ok(html.includes(`<li><strong>${accept.label}</strong>: ${accept.does.replaceAll('(', '(')}`), 'what the choice does');
  assert.doesNotMatch(html, /<option[^>]* selected/u, 'shown, never preselected');
  const card = decideHtml({ ...awaiting, packetSha256: `sha256:${'b'.repeat(64)}` });
  assert.match(card, /data-approval="d\d+">Review and approve<\/button>/u);
  assert.match(DECIDE_SCRIPT, /closest\('\[data-approval\]'\)\) return vscode\.postMessage\(\{ type: 'decide\.approval' \}\)/u);
  assert.match(await readFile(new URL('../apps/vscode/src/views/decide-card.ts', import.meta.url), 'utf8'), /'decide\.approval': \(\) => \{ void vscode\.commands\.executeCommand\('singularityFlow\.openApprovals'\); \}/u);
  // VS Code's Decisions page.
  const page = decisionListHtml(buildDecisionListView({ ...awaiting, packetSha256: `sha256:${'b'.repeat(64)}` }));
  assert.match(page, /<p class="dl-rec">[\s\S]*Recommended: Fix the environment and run unit again\./u);
  assert.match(page, /data-approval-open="d\d+">Review and approve<\/button>/u);
  assert.match(DECISION_LIST_SCRIPT, /decisions\.approval/u);
  assert.match(await readFile(new URL('../apps/vscode/src/views/decision-list.ts', import.meta.url), 'utf8'), /'decisions\.approval': \(\) => \{ void vscode\.commands\.executeCommand\('singularityFlow\.openApprovals'\); \}/u);
  // Copilot CLI's card: each question, what each choice does, and the approval's own question.
  const table = decisionsTable(awaiting);
  assert.match(table, /\nRecommended: Fix the environment and run unit again\.\n/u);
  assert.ok(table.includes(`- ${accept.label}: ${accept.does}`), table);
  assert.ok(table.includes('**2. Approve Implementation?**'), table);
  assert.ok(table.includes('- Review and approve Implementation: /sf-approve implementation --work-id DEC-7 opens its documents; or in your terminal: `singularity-flow approve implementation --work-id DEC-7 --fetch`.'), table);
  assert.equal(cardRows(awaiting).some((item) => item.kind === 'approval'), false, 'the approval is never answered on a form');
  // A choice's own form says what it does before its own words on when to choose it.
  assert.ok(detailForm(risk, accept).message.startsWith(`${risk.title}: ${accept.label}. ${accept.does} ${accept.words}`), detailForm(risk, accept).message);
  // Its forms mark the recommended choice in the list itself, and still read the plain label back; nothing is preselected.
  const departure = packet.items.find((item) => item.kind === 'departure');
  const [{ form }] = rowForms([departure]);
  // The recommended choice first [owner, 2026-11-16], never preselected: no default, and Leave undecided still offered.
  assert.deepEqual(form.requestedSchema.properties.decision0.enum, ['Accept (recommended)', 'Reject', 'Leave undecided']);
  assert.equal(form.requestedSchema.properties.decision0.default, undefined);
  assert.equal(choicesFromRows([departure], { decision0: 'Accept (recommended)' }).picks[0].option.id, 'accept');
  // The terminal.
  const text = packetText(awaiting);
  assert.match(text, /\n {3}Recommended: Fix the environment and run unit again\./u);
  assert.match(text, /\n {3}accept-test-risk: Accept that these tests cannot run here, until a date\n {6}Accepted until 2026-12-13 \(or the day you choose\): the tests still run/u);
  assert.match(text, /\n {3}Recommended: Review and approve Implementation\. Nothing on this list holds it/u);
  for (const shown of [html, page, table, text]) assert.doesNotMatch(shown.replace(/data-digest="sha256:[a-f0-9]{64}"/gu, ''), /sha256:[a-f0-9]{8}/u);
});

test('what SFlow settled for the person shows under "Settled for you" on every host, with its evidence and its Undo', () => {
  const packet = { ...broadPacket(), packetSha256: `sha256:${'a'.repeat(64)}` };
  const settled = { id: 'd40', kind: 'owed-decision', settled: true, title: 'Scope does not apply', why: 'The workflow settles it: no step holds scope.',
    evidence: ['The workflow names no scope step.'], decidedBy: { allowed: true, words: 'You may decide this.' },
    options: [{ id: 'undo', label: 'Undo: decide it yourself', recommended: false, does: 'Opens it again for you to decide.', effects: [{ kind: 'undo' }], needs: {}, decidedBy: { allowed: true, words: '' } }] };
  const withSettled = { ...packet, settled: [settled] };
  // One line each, "Undo if wrong" [owner, 2026-11-16]; VS Code keeps its evidence behind a detail.
  assert.match(decideHtml(withSettled), /<h2>Settled for you<\/h2>[\s\S]*Scope does not apply\. Undo if wrong\.[\s\S]*<details class="dc-detail"><summary>What it rests on<\/summary>[\s\S]*The workflow names no scope step\.[\s\S]*value="undo"/u);
  assert.ok(decideRows(withSettled).some((item) => item.id === 'd40'), 'its Undo is chosen and recorded like any answer');
  // Then the list's last line, its next step [owner, 2026-11-18].
  assert.match(decisionsTable(withSettled), /\n\*\*Settled for you\.\*\* Scope does not apply\. Undo if wrong\.\n\n\*\*Next: [^\n]+\*\*$/u);
  assert.match(packetText(withSettled), /Settled for you:\n\nd40\. Scope does not apply\. Undo if wrong\.\n {3}undo: Undo: decide it yourself/u);
  assert.match(decisionListHtml(buildDecisionListView(withSettled)), /<h2>Settled for you<\/h2>[\s\S]*Undo: decide it yourself/u);
});

test('a decision\'s VS Code route is the Decide card, never "not available for this action"', () => {
  for (const argv of [['decisions', WORK], ['decisions', WORK, '--json'], ['decisions', 'record', WORK], ['decisions', '--work-id', WORK]]) {
    assert.equal(modelFreeCommandForArgv(argv), VSCODE_DECIDE_CARD, argv.join(' '));
  }
  // A preview with choices, or another Story's phase, is not the card's route.
  for (const argv of [['decisions', 'record', WORK, '--choose', 'd1=dismiss'], ['decisions', WORK, '--phase', 'release']]) assert.equal(modelFreeCommandForArgv(argv), null, argv.join(' '));
  const lines = formatCommandRouteLines(safeCommandGuidance({ command: `singularity-flow decisions ${WORK}` })).join('\n');
  assert.equal(lines, `- Copilot: /sf-decide ${WORK}\n- Shell: singularity-flow decisions ${WORK}\n- VS Code (model-free): ${VSCODE_DECIDE_CARD}`);
});
