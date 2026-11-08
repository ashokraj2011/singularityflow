/**
 * One decisions list [SCS:REQ-030..033]: at an open convergence step its items are on the list as
 * `convergence-item`, one row per problem, each disposition a choice, every choice written by the one
 * `story adjudicate --answers` write bound to the table's digest, and none of it a chat turn's to record.
 * The VS Code card, the Copilot CLI forms and the terminal ask the same things in the same words.
 */
import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';

import { decideHtml, decideSummary, sharedAnswers } from '../apps/vscode/src/views/decide-card-page.ts';
import { decisionAnswersFromChoices } from '../apps/vscode/src/views/decision-list-model.ts';
import { confirmForm, detailForm, rowForms, sharedAnswers as cardShared } from '../plugin/extensions/decisions/card.mjs';
import { promptDecisionAnswers } from '../src/commands/decisions.mjs';
import { DISPOSITIONS } from '../src/convergence.mjs';
import { DISPOSITION_WORDS } from '../src/convergence-adjudications.mjs';
import { DECISION_LIST_CHAT_OPTIONS } from '../src/copilot-mutation-guard.mjs';
import { decisionChatSteps, decisionPacket, decisionRecordPlan, effectWords, ISSUE_ONLY_OPTIONS, parseDecisionAnswers, PENDING_CONCEPTS, PENDING_ITEM_KINDS, runDecisionPlan } from '../src/decision-list.mjs';
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
      // Already decided: not a question on the list.
      item('CF-999999999999', 'missing-bound-test', { decision: { disposition: 'deferred', reason: 'Later.', clauseIds: [] } })
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
  const input = Readable.from(['5\n', 'REQ-002\n', 'The specification is wrong about retries.\n', '6\n', '6\n', '6\n', '6\n', 'y\n']);
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
