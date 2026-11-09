/**
 * One decisions list [SCS:REQ-030..033]: at an open convergence step its items are on the list as
 * `convergence-item`, one row per problem, each disposition a choice, every choice written by the one
 * `story adjudicate --answers` write bound to the table's digest, and none of it a chat turn's to record.
 * The VS Code card, the Copilot CLI forms and the terminal ask the same things in the same words.
 */
import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';

import { decideHtml, decideRows, decideSummary, sharedAnswers } from '../apps/vscode/src/views/decide-card-page.ts';
import { decisionAnswersFromChoices } from '../apps/vscode/src/views/decision-list-model.ts';
import { cardRows, confirmForm, detailForm, rowForms, sharedAnswers as cardShared } from '../plugin/extensions/decisions/card.mjs';
import { promptDecisionAnswers } from '../src/commands/decisions.mjs';
import { DISPOSITIONS } from '../src/convergence.mjs';
import { DISPOSITION_WORDS } from '../src/convergence-adjudications.mjs';
import { argvAllowed, DECISION_LIST_CHAT_OPTIONS } from '../src/copilot-mutation-guard.mjs';
import { decisionChatSteps, decisionPacket, decisionRecordPlan, effectWords, ISSUE_ONLY_OPTIONS, parseDecisionAnswers, pendingSummary, PENDING_CONCEPTS, PENDING_ITEM_KINDS,
  runDecisionPlan } from '../src/decision-list.mjs';
import { upstreamIssueStates } from '../src/upstream-routes.mjs';

const AT = '2026-11-08T10:00:00.000Z';
const DIGEST = `sha256:${'c'.repeat(64)}`;
const actor = { name: 'Architect', email: 'architect@example.invalid', login: null };

function story({ anyone = true } = {}) {
  return {
    workItem: { id: 'SDS-1' }, status: 'in_progress', currentPhase: 'convergence',
    phaseOrder: ['specification', 'planning', 'implementation', 'convergence', 'verification', 'release'],
    phases: {
      specification: { id: 'specification', label: 'Specification', status: 'approved', generation: 1, approvalPolicy: { authorities: ['product-approvers'] } },
      planning: { id: 'planning', label: 'Planning', status: 'approved', generation: 1, approvalPolicy: { authorities: ['architecture-reviewers'] } },
      implementation: { id: 'implementation', label: 'Implementation', status: 'approved', generation: 1, approvalPolicy: { authorities: ['engineering-reviewers'] } },
      convergence: { id: 'convergence', label: 'Convergence', status: 'in_progress', generation: 0, approvalPolicy: { authorities: ['architecture-reviewers'] } }
    },
    resolution: { approvalAuthorities: {
      'product-approvers': { label: 'Product approvers', allowAnyGitIdentity: true, members: [] },
      'engineering-reviewers': { label: 'Engineering reviewers', allowAnyGitIdentity: true, members: [] },
      'architecture-reviewers': { label: 'Architecture reviewers', allowAnyGitIdentity: anyone, members: [{ name: 'Lead Architect', email: 'lead@example.invalid' }] }
    } },
    upstreamIssues: [{ id: 'UPI-001', phase: 'specification', about: 'SDS-1:REQ-002', problem: 'The retry rule reads two ways.', raisedIn: { phase: 'implementation', generation: 1 } }],
    upstreamIssueDecisions: []
  };
}

const DECIDED = { disposition: 'deferred', reason: 'Later.', clauseIds: [], actor: 'lead@example.invalid', at: '2026-11-07T09:00:00.000Z',
  replaced: [{ disposition: 'accepted-deviation', reason: 'Fine for now.', actor: 'architect@example.invalid', at: '2026-11-06T09:00:00.000Z' }] };
const item = (id, kind, fields = {}) => ({ id, kind, paths: [], clauseIds: [], detail: `${kind} detail for ${id}`, plan: null, acceptAll: false, decision: null, ...fields });
function table(items = null) {
  return { status: 'open', workId: 'SDS-1', phase: 'convergence', digest: DIGEST, clauses: ['SDS-1:REQ-001', 'SDS-1:REQ-002'],
    dispositions: DISPOSITIONS.map((id) => ({ id, label: DISPOSITION_WORDS[id] })),
    groupWords: { 'test-setup': 'These changed together for how tests run: one change, so one decision. Each file is still recorded by name.' },
    items: items ?? [
      item('CF-aaaaaaaaaaaa', 'absent-observed-claim', { clauseIds: ['SDS-1:REQ-002'], detail: 'no observed claim records evidence for SDS-1:REQ-002' }),
      // What the assisted pass proposed about the same fact: the same problem.
      item('CC-bbbbbbbbbbbb', 'item', { clauseIds: ['SDS-1:REQ-002'], detail: null, classification: 'missing', text: 'The append-only helper is not delivered.', factIds: ['CF-aaaaaaaaaaaa'] }),
      item('CF-cccccccccccc', 'unclaimed-changed-path', { paths: ['src/retry-log.ts'], acceptAll: true, detail: 'src/retry-log.ts changed and no observed claim cites it' }),
      item('CF-dddddddddddd', 'unclaimed-changed-path', { paths: ['src/metrics.ts'], acceptAll: true, detail: 'src/metrics.ts changed and no observed claim cites it' }),
      item('CF-eeeeeeeeeeee', 'unclaimed-changed-path', { paths: ['vitest.config.ts'], acceptAll: true, group: 'test-setup' }),
      item('CF-ffffffffffff', 'unclaimed-changed-path', { paths: ['test/setup.ts'], acceptAll: true, group: 'test-setup' }),
      item('CF-111111111111', 'failing-bound-test', { detail: "bound acceptance command 'unit' did not pass" }),
      // Already decided: not a question on the list, but offered beside it to change [SCS:REQ-034].
      item('CF-999999999999', 'missing-bound-test', { detail: "no bound test result for 'unit'", decision: DECIDED })
    ] };
}

function packetOf(workflow = story(), list = table(), overrides = {}) {
  return decisionPacket(workflow, { phaseId: 'convergence', at: AT, gaps: [], issues: upstreamIssueStates(workflow, AT), convergence: list,
    state: { convergence: list?.digest ?? null }, ...overrides }, { authorities: workflow.resolution.approvalAuthorities, actor, at: AT });
}

const rows = (packet) => packet.items.filter((entry) => entry.kind === 'convergence-item');

test('convergence items are on the one list with the five dispositions, decided by the convergence approvers', () => {
  const packet = packetOf();
  const listed = rows(packet);
  assert.equal(listed.length, 5, 'one row per problem: the fact and its proposal, two files, the test setup, the failing test');
  assert.ok(PENDING_ITEM_KINDS.includes('convergence-item'));
  assert.ok(PENDING_CONCEPTS['decision-list'].kinds.includes('convergence-item'));
  for (const row of listed) {
    assert.deepEqual(row.options.map((entry) => entry.id), [...DISPOSITIONS]);
    assert.deepEqual(row.options.map((entry) => entry.label), DISPOSITIONS.map((id) => DISPOSITION_WORDS[id]));
    assert.equal(row.options.some((entry) => entry.recommended), false, 'an answer was recommended for the person');
    assert.equal(row.options.some((entry) => entry.needs.reason.default), false, 'a reason was suggested');
    assert.equal(row.decidedBy.allowed, true);
    assert.deepEqual(row.decidedBy.groups, ['architecture-reviewers']);
    assert.equal(row.holdsApproval, false, 'a convergence item is decided before the step is submitted, never at its approval');
    for (const entry of row.options) {
      assert.deepEqual(entry.effects, [{ kind: 'convergence-adjudication', phase: 'convergence', items: row.details.convergence, disposition: entry.id, expect: DIGEST }]);
    }
  }
  assert.match(packet.headline, /^Convergence needs 5 decisions/u);
  assert.equal(packet.next.kind, 'convergence-item');
  assert.equal(new Set(listed.map((row) => row.title)).size, listed.length, 'two rows share a title, which keys what a page keeps of a draft');
  // What is decided already is never asked again.
  assert.equal(listed.some((row) => row.details.convergence.includes('CF-999999999999')), false);
});

test('one problem is one item: a fact and the proposal about it, a test setup, and an upstream issue on the same clause', () => {
  const [clause, retryLog, , setup, failing] = rows(packetOf());
  assert.deepEqual(clause.details.convergence, ['CF-aaaaaaaaaaaa', 'CC-bbbbbbbbbbbb']);
  assert.match(clause.title, /^REQ-002: no recorded trace that it is delivered and proposed as missing \(CF-aaaaaaaaaaaa and 1 more\)$/u);
  assert.match(clause.why, /Convergence found that no observed claim records evidence for SDS-1:REQ-002\. The assisted pass proposed: "The append-only helper is not delivered\."/u);
  assert.match(clause.why, /UPI-001, a problem reported against Specification, names it too/u);
  assert.match(clause.why, /One answer records each of CF-aaaaaaaaaaaa and CC-bbbbbbbbbbbb by name\./u);
  assert.deepEqual(clause.details.issues, ['UPI-001']);
  assert.equal(packetOf().items.some((entry) => entry.kind === 'upstream-issue'), false, 'the issue on the same clause was asked again');
  assert.equal(retryLog.details.path, 'src/retry-log.ts', 'a page cannot open the file');
  assert.deepEqual(setup.details.convergence, ['CF-eeeeeeeeeeee', 'CF-ffffffffffff']);
  assert.deepEqual(setup.details.paths, ['vitest.config.ts', 'test/setup.ts']);
  assert.match(setup.why, /one change, so one decision/u);
  assert.deepEqual(failing.details.convergence, ['CF-111111111111']);
  // A proposal naming the same clause and difference without citing the fact is the same problem too.
  const uncited = table([item('CF-aaaaaaaaaaaa', 'absent-observed-claim', { clauseIds: ['SDS-1:REQ-002'] }),
    item('CC-bbbbbbbbbbbb', 'item', { clauseIds: ['sds-1:req-002'], classification: 'missing', text: 'Missing.', factIds: [] }),
    item('CC-cccccccccccc', 'item', { clauseIds: ['SDS-1:REQ-002'], classification: 'partial', text: 'Partly there.', factIds: [] })]);
  assert.deepEqual(rows(packetOf(story(), uncited)).map((row) => row.details.convergence), [['CF-aaaaaaaaaaaa', 'CC-bbbbbbbbbbbb'], ['CC-cccccccccccc']],
    'a different difference on the same clause was folded into another problem');
});

test('a reason as convergence asks it: rework on what the kernel found may go unexplained, any other answer states one', () => {
  const [clause, retryLog, metrics, setup, failing] = rows(packetOf());
  const need = (row, id) => row.options.find((entry) => entry.id === id).needs;
  assert.equal(need(failing, 'rework').reason.minimum, 0);
  assert.equal(need(setup, 'rework').reason.minimum, 0);
  assert.equal(need(clause, 'rework').reason.minimum, 1, 'rework on an assisted proposal went unexplained');
  for (const id of ['accepted-deviation', 'dismissed', 'deferred', 'update-intent']) assert.equal(need(failing, id).reason.minimum, 1);
  assert.deepEqual(need(clause, 'update-intent').clause, { known: ['SDS-1:REQ-002', 'SDS-1:REQ-001'], words: 'The clauses the specification should change', label: 'Clauses to change' });
  assert.equal(need(clause, 'accepted-deviation').clause, undefined);
  // Only changed files no clause claims share one reason, as on the Adjudicate page.
  const shareable = (row) => row.options.filter((entry) => !entry.oneByOne).map((entry) => entry.id);
  assert.deepEqual([clause, retryLog, metrics, setup, failing].map(shareable), [[], ['accepted-deviation'], ['accepted-deviation'], ['accepted-deviation'], []]);

  const packet = packetOf();
  const plan = (choose, reason = {}, clause = {}) => decisionRecordPlan(packet, parseDecisionAnswers({ choose, reason, clause }), { at: AT });
  assert.equal(plan({ d5: 'rework' }).steps[0].values.reason, '');
  assert.throws(() => plan({ d1: 'rework' }), /The reason for d1 must be 1 to 1000 characters/u);
  assert.throws(() => plan({ d5: 'dismissed' }), /The reason for d5 must be 1 to 1000 characters/u);
  assert.throws(() => plan({ d1: 'update-intent' }, { d1: 'The spec is wrong.' }), /Name the clauses that carry d1/u);
  assert.throws(() => plan({ d1: 'update-intent' }, { d1: 'The spec is wrong.' }, { d1: 'REQ-404' }), /REQ-404, which is not a clause of this Story/u);
  assert.deepEqual(plan({ d1: 'update-intent' }, { d1: 'The spec is wrong.' }, { d1: 'req-002' }).steps[0].values.clause, ['SDS-1:REQ-002']);
});

test('every convergence answer chosen together is one write of the table it was read from, each with its own reason', async () => {
  const packet = packetOf();
  const plan = decisionRecordPlan(packet, parseDecisionAnswers({ choose: { d1: 'update-intent', d2: 'accepted-deviation', d4: 'rework', d5: 'deferred' },
    reason: { d1: 'The specification is wrong about retries.', d2: 'A log line only.', d5: 'Waits for the test environment.' }, clause: { d1: 'REQ-002' } }), { at: AT });
  const writes = [];
  const outcome = await runDecisionPlan(plan, async (effect) => { writes.push(effect); return { recorded: effect.answers.map((answer) => answer.itemId) }; });
  assert.equal(outcome.failed, null);
  assert.equal(writes.length, 1, 'a second write would meet a table the first one changed');
  assert.deepEqual(writes[0], { kind: 'convergence-adjudication', phase: 'convergence', expect: DIGEST, answers: [
    { itemId: 'CF-aaaaaaaaaaaa', disposition: 'update-intent', reason: 'The specification is wrong about retries.', clauseIds: ['SDS-1:REQ-002'] },
    { itemId: 'CC-bbbbbbbbbbbb', disposition: 'update-intent', reason: 'The specification is wrong about retries.', clauseIds: ['SDS-1:REQ-002'] },
    { itemId: 'CF-cccccccccccc', disposition: 'accepted-deviation', reason: 'A log line only.', clauseIds: [] },
    { itemId: 'CF-eeeeeeeeeeee', disposition: 'rework', reason: '', clauseIds: [] },
    { itemId: 'CF-ffffffffffff', disposition: 'rework', reason: '', clauseIds: [] },
    { itemId: 'CF-111111111111', disposition: 'deferred', reason: 'Waits for the test environment.', clauseIds: [] }] });
  assert.deepEqual(outcome.recorded.map((entry) => entry.item), ['d1', 'd2', 'd4', 'd5']);
  assert.match(effectWords(story(), plan.steps[0].effects[0], plan.steps[0].values), /^change the spec for REQ-002 \(CF-aaaaaaaaaaaa\), change the spec for REQ-002 \(CC-bbbbbbbbbbbb\) \(convergence adjudication/u);
  // A failed write names every answer as not recorded.
  const failed = await runDecisionPlan(plan, async () => { throw new Error('The list of items changed while it was open.'); });
  assert.deepEqual(failed.remaining.map((entry) => entry.item), ['d1', 'd2', 'd4', 'd5']);
});

test('the list digest binds the convergence table: an answer recorded meanwhile changes what a person confirms', () => {
  const first = packetOf();
  const moved = { ...table(), digest: `sha256:${'d'.repeat(64)}` };
  assert.notEqual(packetOf(story(), moved).packetSha256, first.packetSha256);
  assert.equal(packetOf(story(), table()).packetSha256, first.packetSha256);
});

test('no chat turn records an adjudication: no option is one a /sf-decide turn may write, and none has a chat command', () => {
  const packet = packetOf();
  for (const row of rows(packet)) {
    for (const entry of row.options) {
      assert.equal(DECISION_LIST_CHAT_OPTIONS.includes(entry.id), false, `${entry.id} reads as a choice a chat turn may record`);
      assert.equal(ISSUE_ONLY_OPTIONS.includes(entry.id), false);
      assert.equal(entry.chat, undefined);
    }
  }
  assert.deepEqual(decisionChatSteps(packet, [{ item: 'd2', option: 'accepted-deviation', values: { reason: 'A log line only.' } }]), []);
  // A host with no card cannot send the person to /sf-decide for these: that turn could only show them again.
  assert.equal(packetOf(story(), table(), {}).record.copilotCommand, '/sf-decide SDS-1');
  const noCard = decisionPacket(story(), { phaseId: 'convergence', at: AT, gaps: [], issues: [], convergence: table(), state: {} },
    { authorities: story().resolution.approvalAuthorities, actor, at: AT, card: false });
  assert.equal(noCard.record.copilotCommand, null);
});

test('someone outside the convergence approvers is told who decides, and nothing of theirs is recorded', () => {
  const workflow = story({ anyone: false });
  const packet = packetOf(workflow);
  const [row] = rows(packet);
  assert.equal(row.decidedBy.allowed, false);
  assert.equal(row.decidedBy.words, 'The Architecture reviewers decide this.');
  assert.equal(row.decidedBy.share, '/sf-decide SDS-1');
  const plan = decisionRecordPlan(packet, parseDecisionAnswers({ choose: { d5: 'rework' } }), { at: AT });
  assert.deepEqual(plan.steps, []);
  assert.equal(plan.refused[0].item, 'd5');
});

test('the VS Code card asks each item its dispositions, the clauses an update-intent changes, and keeps the tightest reason rule', () => {
  const packet = { ...packetOf(), repositoryPath: '/repo' };
  const html = decideHtml(packet);
  assert.match(html, /<option value="update-intent" data-needs="clause reason" data-one="1">The spec should change<\/option>/u);
  assert.match(html, /<option value="accepted-deviation" data-needs="reason">Accept as is<\/option>/u, 'a changed file no clause claims cannot share one reason');
  assert.match(html, /aria-label="The clauses the specification should change, for REQ-002/u);
  assert.match(html, /Reason \(1 to 1000 characters\)/u);
  assert.doesNotMatch(html, /Reason \(0 to 1000 characters\)/u, 'the label read as if no answer needs a reason');
  assert.match(html, /data-open="src\/retry-log\.ts"/u);
  assert.doesNotMatch(html, /<option[^>]* selected/u);
  assert.deepEqual(sharedAnswers(packet).map((entry) => [entry.id, entry.rows]), [['accepted-deviation', 3]]);
  const { answers, choices, errors } = decisionAnswersFromChoices(packet, [{ item: 'd1', option: 'update-intent', reason: 'The specification is wrong about retries.', clause: 'REQ-002' },
    { item: 'd5', option: 'rework', reason: '' }]);
  assert.deepEqual(errors, []);
  assert.deepEqual(answers.choose, { d1: 'update-intent', d5: 'rework' });
  assert.match(decideSummary(packet, choices), /The spec should change\. Clauses to change: REQ-002\. Reason: The specification is wrong about retries\./u);
  assert.match(decisionAnswersFromChoices(packet, [{ item: 'd1', option: 'update-intent', reason: 'The specification is wrong.' }]).errors[0],
    /name the clauses the specification should change/u);
});

test('the Copilot CLI forms ask the same: each disposition by its words, then what the chosen one needs', () => {
  const packet = packetOf();
  const [page] = rowForms(rows(packet));
  assert.deepEqual(page.form.requestedSchema.properties.decision0.enum, ['Leave undecided', ...DISPOSITIONS.map((id) => DISPOSITION_WORDS[id])]);
  const [clause] = rows(packet);
  const detail = detailForm(clause, clause.options.find((entry) => entry.id === 'update-intent'));
  assert.match(detail.requestedSchema.properties.clause.title, /^The clauses the specification should change, for REQ-002/u);
  assert.match(detail.requestedSchema.properties.reason.title, /1 to 1000 characters/u);
  assert.deepEqual(cardShared(packet).map((entry) => [entry.id, entry.items.length]), [['accepted-deviation', 3]]);
  const confirm = confirmForm(packet, [{ item: 'd1', title: clause.title, option: 'update-intent', clause: 'REQ-002', reason: 'The specification is wrong about retries.' }]);
  assert.match(confirm.message, /The spec should change\. Clauses to change: REQ-002\. Reason: The specification is wrong about retries\./u);
});

test('the terminal asks the same, with the same words, and confirms before anything is written', async () => {
  const packet = packetOf();
  // The answer offered beside the list is asked last, and passed over like any other.
  const input = Readable.from(['5\n', 'REQ-002\n', 'The specification is wrong about retries.\n', '6\n', '6\n', '6\n', '6\n', '6\n', 'y\n']);
  input.isTTY = true;
  const output = new PassThrough();
  output.isTTY = true;
  let shown = '';
  output.on('data', (chunk) => { shown += chunk; });
  const prompt = await promptDecisionAnswers(packet, { input, output });
  assert.deepEqual(Object.fromEntries(prompt.answers.choose), { d1: 'update-intent' });
  assert.match(shown, / {3}1\) Send back to fix\n {3}2\) Accept as is\n {3}3\) Not a real finding\n {3}4\) Decide later\n {3}5\) The spec should change\n {3}6\) Not now/u);
  assert.match(shown, /The clauses the specification should change, separated by commas \(SDS-1:REQ-002, SDS-1:REQ-001\): /u);
  const plan = decisionRecordPlan(packet, prompt.answers, { at: AT });
  assert.deepEqual(plan.steps[0].values, { reason: 'The specification is wrong about retries.', clause: ['SDS-1:REQ-002'] });
  assert.equal(await prompt.confirm(['d1. REQ-002: The spec should change.']), true);
  prompt.close();
});

test('away from an open convergence step there is nothing of convergence on the list', () => {
  assert.deepEqual(rows(packetOf(story(), null)), []);
});

// [SCS:REQ-034] A decided convergence answer is offered beside the list while the step is open, and its approvers may change it.
const answers = (packet) => (packet.offered ?? []).filter((entry) => entry.kind === 'convergence-answer');

test('a decided answer is offered beside the list: it holds nothing, is never counted, and says whose it is and what it replaced', () => {
  const packet = packetOf();
  const [answer, ...more] = answers(packet);
  assert.equal(more.length, 0);
  assert.equal(answer.id, 'd6', 'an offered row is numbered after everything the step waits on');
  assert.deepEqual(answer.details.convergence, ['CF-999999999999']);
  assert.equal(packet.items.some((entry) => entry.details?.convergence?.includes('CF-999999999999')), false, 'a decided answer was asked again as open');
  assert.equal(answer.holdsApproval, false);
  assert.equal(packet.open, 5);
  assert.match(packet.headline, /^Convergence needs 5 decisions/u);
  assert.equal(pendingSummary(packet).items.some((entry) => entry.kind === 'convergence-answer'), false, 'a counting surface sees the answer as pending');
  assert.equal(PENDING_ITEM_KINDS.includes('convergence-answer'), false);
  assert.equal(Object.values(PENDING_CONCEPTS).some((entry) => entry.kinds.includes('convergence-answer')), false);
  assert.equal(answer.title, "Convergence: no bound test result (CF-999999999999), answered Decide later");
  assert.match(answer.why, /^Decided: Decide later, by lead@example\.invalid on 2026-11-07 \("Later\."\)\. Earlier: Accept as is, by architect@example\.invalid on 2026-11-06 \("Fine for now\."\)\./u);
  assert.match(answer.why, /Convergence found that no bound test result for 'unit'\./u);
  assert.match(answer.why, /the record keeps this one and whose it was\. Nothing waits on it: Convergence's approvers may change it until the step is published\.$/u);
  // The five dispositions, under the convergence approvers, each changed on its own row and always with a reason.
  assert.deepEqual(answer.options.map((entry) => entry.id), [...DISPOSITIONS]);
  assert.deepEqual(answer.decidedBy.groups, ['architecture-reviewers']);
  for (const entry of answer.options) {
    assert.equal(entry.recommended, false);
    assert.equal(entry.oneByOne, true, `${entry.id} could change someone's answer through one answer for all`);
    assert.deepEqual(entry.needs.reason, { default: '', minimum: 1, maximum: 1000 }, `${entry.id} could change an answer without a reason`);
    assert.deepEqual(entry.effects, [{ kind: 'convergence-adjudication', phase: 'convergence', items: ['CF-999999999999'], disposition: entry.id, expect: DIGEST,
      replaces: { disposition: 'deferred', actor: 'lead@example.invalid' } }]);
  }
  assert.deepEqual(answer.options.find((entry) => entry.id === 'update-intent').needs.clause.known, ['SDS-1:REQ-001', 'SDS-1:REQ-002']);
  // What the person saw is what they confirm: whose answer it is is bound too, beside the table's own digest.
  const someoneElse = table(table().items.map((entry) => (entry.decision ? { ...entry, decision: { ...entry.decision, actor: 'other@example.invalid' } } : entry)));
  assert.notEqual(packetOf(story(), someoneElse).packetSha256, packet.packetSha256);
  // One answer for all never reaches an answer someone gave.
  assert.deepEqual(sharedAnswers({ ...packet, repositoryPath: '/repo' }).map((entry) => [entry.id, entry.rows]), [['accepted-deviation', 3]]);
  assert.deepEqual(cardShared(packet).map((entry) => [entry.id, entry.items.length]), [['accepted-deviation', 3]]);
});

test('decided items are one row only while they carry the same answer', () => {
  const decided = (fields) => ({ ...DECIDED, replaced: [], ...fields });
  const alike = table([item('CF-aaaaaaaaaaaa', 'absent-observed-claim', { clauseIds: ['SDS-1:REQ-002'], decision: decided({ clauseIds: ['SDS-1:REQ-002'] }) }),
    item('CC-bbbbbbbbbbbb', 'item', { clauseIds: ['SDS-1:REQ-002'], classification: 'missing', text: 'Missing.', factIds: ['CF-aaaaaaaaaaaa'], decision: decided({ clauseIds: ['SDS-1:REQ-002'] }) })]);
  const [both] = answers(packetOf(story(), alike));
  assert.deepEqual(both.details.convergence, ['CF-aaaaaaaaaaaa', 'CC-bbbbbbbbbbbb']);
  assert.match(both.title, /^REQ-002: no recorded trace that it is delivered and proposed as missing \(CF-aaaaaaaaaaaa and 1 more\), answered Decide later$/u);
  assert.match(both.why, /A change records each of CF-aaaaaaaaaaaa and CC-bbbbbbbbbbbb by name\./u);
  const apart = table([alike.items[0], { ...alike.items[1], decision: decided({ disposition: 'dismissed', reason: 'Not missing.', clauseIds: ['SDS-1:REQ-002'] }) }]);
  assert.deepEqual(answers(packetOf(story(), apart)).map((row) => [row.details.convergence, row.details.answer.disposition]),
    [[['CF-aaaaaaaaaaaa'], 'deferred'], [['CC-bbbbbbbbbbbb'], 'dismissed']], 'two answers were shown, and would be changed, as one');
  // An answer that changes the spec says which clauses.
  const intent = table([item('CF-aaaaaaaaaaaa', 'absent-observed-claim', { clauseIds: ['SDS-1:REQ-002'], decision: decided({ disposition: 'update-intent', reason: 'The spec is wrong.', clauseIds: ['SDS-1:REQ-001', 'SDS-1:REQ-002'] }) })]);
  assert.match(answers(packetOf(story(), intent))[0].why, /^Decided: The spec should change, by lead@example\.invalid on 2026-11-07 \("The spec is wrong\."\)\. Clauses to change: REQ-001 and REQ-002\./u);
});

test('changing an answer on the list is the one adjudication write, names the answer it replaces, and always states a reason', async () => {
  const packet = packetOf();
  const plan = (choose, reason = {}, clause = {}) => decisionRecordPlan(packet, parseDecisionAnswers({ choose, reason, clause }), { at: AT });
  assert.throws(() => plan({ d6: 'rework' }), /The reason for d6 must be 1 to 1000 characters/u, 'a change went unexplained');
  assert.throws(() => plan({ d6: 'update-intent' }, { d6: 'The spec is wrong.' }), /Name the clauses that carry d6/u);
  // Changed beside an open item: still one write of the table both were read from.
  const chosen = plan({ d5: 'deferred', d6: 'accepted-deviation' }, { d5: 'Waits for the test environment.', d6: 'The unit command is not bound on purpose.' });
  const writes = [];
  const outcome = await runDecisionPlan(chosen, async (effect) => { writes.push(effect); return { recorded: effect.answers.map((entry) => entry.itemId), unchanged: [] }; });
  assert.equal(outcome.failed, null);
  assert.deepEqual(writes, [{ kind: 'convergence-adjudication', phase: 'convergence', expect: DIGEST, answers: [
    { itemId: 'CF-111111111111', disposition: 'deferred', reason: 'Waits for the test environment.', clauseIds: [] },
    { itemId: 'CF-999999999999', disposition: 'accepted-deviation', reason: 'The unit command is not bound on purpose.', clauseIds: [] }] }]);
  const [, change] = chosen.steps;
  assert.equal(effectWords(story(), change.effects[0], change.values),
    'accept it as is (CF-999999999999), in place of decide it later from lead@example.invalid, which the record keeps (convergence adjudication, as story adjudicate --answers records it)');
  // Each host confirms it in the same words as any other choice.
  const card = { ...packet, repositoryPath: '/repo' };
  assert.match(decideSummary(card, [{ item: 'd6', option: 'accepted-deviation', reason: 'The unit command is not bound on purpose.' }]),
    /^Convergence: no bound test result \(CF-999999999999\), answered Decide later: Accept as is\. Reason: The unit command is not bound on purpose\./u);
  assert.match(confirmForm(packet, [{ item: 'd6', option: 'accepted-deviation', reason: 'The unit command is not bound on purpose.' }]).message,
    /answered Decide later: Accept as is\. Reason: The unit command is not bound on purpose\./u);
  assert.doesNotMatch(decideSummary(card, []), /CF-999999999999/u, 'an answer given was listed as still undecided');
});

test('nobody but the convergence approvers may change an answer', () => {
  const packet = packetOf(story({ anyone: false }));
  const [answer] = answers(packet);
  assert.equal(answer.decidedBy.allowed, false);
  assert.equal(answer.decidedBy.words, 'The Architecture reviewers decide this.');
  const plan = decisionRecordPlan(packet, parseDecisionAnswers({ choose: { d6: 'dismissed' }, reason: { d6: 'Not a real finding.' } }), { at: AT });
  assert.deepEqual(plan.steps, []);
  assert.deepEqual(plan.refused.map((entry) => entry.item), ['d6']);
  assert.doesNotMatch(decideHtml({ ...packet, repositoryPath: '/repo' }), /<tr data-item="d6"/u, 'the card offered someone else\'s choice as theirs');
});

test('once the convergence step is published, or away from it, no answer is offered', () => {
  const published = story();
  published.phases.convergence.status = 'awaiting_approval';
  assert.deepEqual(answers(packetOf(published)), []);
  assert.deepEqual(answers(packetOf(story(), null)), []);
  assert.deepEqual(answers(packetOf(story(), { ...table(), status: 'not-open' })), []);
});

test('no chat turn changes an answer: no chat command, no chat option, and the /sf-decide guard refuses each one', () => {
  const packet = packetOf();
  const [answer] = answers(packet);
  for (const entry of answer.options) {
    assert.equal(DECISION_LIST_CHAT_OPTIONS.includes(entry.id), false);
    assert.equal(entry.chat, undefined);
  }
  assert.deepEqual(decisionChatSteps(packet, [{ item: 'd6', option: 'dismissed', values: { reason: 'Not real.' } }]), []);
  const turn = { contract: { workId: 'SDS-1' } };
  const record = (choice) => ['decisions', 'record', 'SDS-1', '--choose', choice, '--reason', `${choice.split('=')[0]}=Not real.`, '--confirm', `sha256:${'e'.repeat(64)}`];
  for (const id of DISPOSITIONS) assert.equal(argvAllowed(record(`d6=${id}`), 'decision-only', turn), false, `a /sf-decide turn may record ${id}`);
  assert.equal(argvAllowed(record('d6=accept-risk'), 'decision-only', turn), true, 'the guard refuses even what a /sf-decide turn may record');
  assert.equal(argvAllowed(['story', 'adjudicate', '--work-id', 'SDS-1', '--answers', 'answers.json', '--expect', DIGEST], 'decision-only', turn), false);
});

test('every host shows the offered answer and asks what a change needs', async () => {
  const packet = { ...packetOf(), repositoryPath: '/repo' };
  assert.equal(decideRows(packet).at(-1).id, 'd6');
  const html = decideHtml(packet);
  const row = html.slice(html.indexOf('<tr data-item="d6"'));
  assert.match(row, /Decided: Decide later, by lead@example\.invalid on 2026-11-07/u);
  for (const id of DISPOSITIONS) assert.match(row, new RegExp(`<option value="${id}" data-needs="[a-z ]*reason" data-one="1">`, 'u'));
  assert.match(row, /Reason \(1 to 1000 characters\)/u);
  assert.equal(cardRows(packet).at(-1).id, 'd6');
  const [, second] = rowForms(cardRows(packet).filter((entry) => entry.decidedBy.allowed));
  assert.match(second.form.requestedSchema.properties.decision0.title, /^Convergence: no bound test result \(CF-999999999999\), answered Decide later: Decided: Decide later, by lead@example\.invalid/u);
  assert.match(detailForm(answers(packet)[0], answers(packet)[0].options[0]).requestedSchema.properties.reason.title, /1 to 1000 characters/u);
  // The terminal asks it last, and records it like any other choice.
  const input = Readable.from(['6\n', '6\n', '6\n', '6\n', '6\n', '2\n', 'The unit command is not bound on purpose.\n', 'y\n']);
  input.isTTY = true;
  const output = new PassThrough();
  output.isTTY = true;
  let shown = '';
  output.on('data', (chunk) => { shown += chunk; });
  const prompt = await promptDecisionAnswers(packet, { input, output });
  assert.deepEqual(Object.fromEntries(prompt.answers.choose), { d6: 'accepted-deviation' });
  assert.match(shown, /6\. Convergence: no bound test result \(CF-999999999999\), answered Decide later\n {3}Decided: Decide later, by lead@example\.invalid/u);
  prompt.close();
});

// [SCS:REQ-035] What the approved plan settled is offered beside the list too: nobody is asked unless they disagree.
const SETTLED = [
  { id: 'CF-21034d278357', paths: ['package.json'], clauseIds: [], decision: null,
    settledBy: { kind: 'supporting', phase: 'planning', generation: 1, class: 'build-configuration', text: 'names the retry test script so operators can run it.' } },
  { id: 'CF-d481d2555b77', paths: ['test/setup.ts'], clauseIds: [], decision: null,
    settledBy: { kind: 'amendment', id: 'PAM-001', clause: 'SDS-1:REQ-001', class: null, text: 'Test-only: a local storage stand-in.' } }
];
const settledOf = (packet) => (packet.offered ?? []).filter((entry) => entry.kind === 'convergence-settled');

test('what the plan settled is offered beside the list: it asks nobody, holds nothing, and an answer overrules the plan', async () => {
  const packet = packetOf(story(), { ...table(), settled: SETTLED });
  const [supporting, amendment, ...more] = settledOf(packet);
  assert.equal(more.length, 0);
  assert.deepEqual((packet.offered ?? []).map((entry) => [entry.id, entry.kind]), [['d6', 'convergence-answer'], ['d7', 'convergence-settled'], ['d8', 'convergence-settled']]);
  assert.equal(packet.open, 5, 'what the plan settled was counted as open');
  assert.match(packet.headline, /^Convergence needs 5 decisions/u);
  assert.equal(PENDING_ITEM_KINDS.includes('convergence-settled'), false);
  assert.equal(pendingSummary(packet).items.some((entry) => entry.kind === 'convergence-settled'), false);
  assert.equal(supporting.title, 'package.json: settled by the plan (CF-21034d278357)');
  assert.equal(supporting.why, 'The plan says: a supporting file, names the retry test script so operators can run it. The approved plan accounts for it, so nobody is asked about it unless they disagree.'
    + ' If you do, choose what it should be instead, with your reason. Nothing waits on it: Convergence\'s approvers may answer it until the step is published.');
  assert.match(amendment.why, /^The plan says: PAM-001 under SDS-1:REQ-001, Test-only: a local storage stand-in\./u);
  assert.equal(supporting.details.path, 'package.json', 'a page cannot open the file');
  assert.deepEqual(supporting.details.settledBy, SETTLED[0].settledBy);
  assert.deepEqual(supporting.decidedBy.groups, ['architecture-reviewers']);
  for (const entry of supporting.options) {
    assert.equal(entry.recommended, false);
    assert.equal(entry.oneByOne, true, `${entry.id} could overrule the plan through one answer for all`);
    assert.deepEqual(entry.needs.reason, { default: '', minimum: 1, maximum: 1000 }, `${entry.id} could overrule the plan without a reason`);
    assert.deepEqual(entry.effects, [{ kind: 'convergence-adjudication', phase: 'convergence', items: ['CF-21034d278357'], disposition: entry.id, expect: DIGEST }]);
  }
  // An overrule is the one write of the table, beside any other answer.
  const plan = (choose, reason = {}) => decisionRecordPlan(packet, parseDecisionAnswers({ choose, reason }), { at: AT });
  assert.throws(() => plan({ d7: 'rework' }), /The reason for d7 must be 1 to 1000 characters/u);
  const writes = [];
  await runDecisionPlan(plan({ d5: 'deferred', d7: 'rework' }, { d5: 'Waits for the test environment.', d7: 'The retry script must not run against production.' }),
    async (effect) => { writes.push(effect); return { recorded: effect.answers.map((entry) => entry.itemId), unchanged: [] }; });
  assert.deepEqual(writes.map((effect) => effect.answers.map((entry) => [entry.itemId, entry.disposition])), [[['CF-111111111111', 'deferred'], ['CF-21034d278357', 'rework']]]);
  // Overruled, it reads as any answer given, and a change keeps the one it replaces.
  const overruled = packetOf(story(), { ...table(), settled: [{ ...SETTLED[0], decision: { disposition: 'rework', reason: 'Not this script.', clauseIds: [], actor: 'lead@example.invalid', at: '2026-11-07T09:00:00.000Z', replaced: [] } }] });
  const answer = overruled.offered.find((entry) => entry.details.convergence.includes('CF-21034d278357'));
  assert.equal(answer.kind, 'convergence-answer');
  assert.equal(answer.title, 'package.json: settled by the plan (CF-21034d278357), answered Send back to fix');
  assert.match(answer.why, /^Decided: Send back to fix, by lead@example\.invalid on 2026-11-07 \("Not this script\."\)\. The plan says: a supporting file, .* This answer overrules what the plan settled\. Choosing again/u);
  assert.deepEqual(answer.options[1].effects[0].replaces, { disposition: 'rework', actor: 'lead@example.invalid' });
  // Each host shows it, and opens its file.
  const html = decideHtml({ ...packet, repositoryPath: '/repo' });
  assert.match(html.slice(html.indexOf('<tr data-item="d7"')), /^<tr data-item="d7"[^>]*>\s*<td><button type="button" class="dc-link" data-open="package\.json">/u);
  assert.deepEqual(cardRows(packet).slice(-2).map((entry) => entry.id), ['d7', 'd8']);
  // Nobody but the approvers, and never once the step is published.
  assert.equal(settledOf(packetOf(story({ anyone: false }), { ...table(), settled: SETTLED }))[0].decidedBy.allowed, false);
  const published = story();
  published.phases.convergence.status = 'awaiting_approval';
  assert.deepEqual(settledOf(packetOf(published, { ...table(), settled: SETTLED })), []);
  // No chat turn overrules the plan.
  assert.deepEqual(decisionChatSteps(packet, [{ item: 'd7', option: 'rework', values: { reason: 'Not this script.' } }]), []);
  assert.equal(supporting.options.some((entry) => entry.chat || DECISION_LIST_CHAT_OPTIONS.includes(entry.id)), false);
});

test('many settled files stay one row each, and a terminal passes over each with Enter', async () => {
  const many = Array.from({ length: 12 }, (_, at) => ({ ...SETTLED[0], id: `CF-${String(at).padStart(12, '0')}`, paths: [`config/part-${at}.json`] }));
  const packet = packetOf(story(), { ...table(), settled: many });
  assert.equal(settledOf(packet).length, 12);
  assert.equal(packet.open, 5);
  // Not now is the default for every offered row: nothing is chosen for the person.
  const input = Readable.from([...Array(5).fill('6\n'), ...Array(13).fill('\n')]);
  input.isTTY = true;
  const output = new PassThrough();
  output.isTTY = true;
  let shown = '';
  output.on('data', (chunk) => { shown += chunk; });
  const prompt = await promptDecisionAnswers(packet, { input, output, nothingChosen: 'Nothing chosen.' });
  assert.equal(prompt, null);
  assert.equal((shown.match(/Choose 1-6 \[6\]: /gu) ?? []).length, 18);
});
