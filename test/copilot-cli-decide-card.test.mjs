/**
 * Everything a step waits on as Copilot CLI forms. Only `ask` can answer, one answer reaches only rows
 * that offer it, each keeps its own reason, a changed list records nothing, and nothing is written until
 * the person confirms the exact list.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { choicesFromRows, detailForm, valuesFromForm, sharedReasonForm, answersOnCurrentList, cardRows, CHANGE, confirmForm, decisionsTable, EACH, firstForm, LEAVE, NOT_NOW, RECORD, rowForms, runCard, sharedAnswers, SIGN, witnessAnswers, witnessForm } from '../plugin/extensions/decisions/card.mjs';

const allowed = { allowed: true, words: 'You may decide this.', groups: ['planners'] };
const choice = (id, label, needs = { reason: { default: '', minimum: 20, maximum: 500 } }) => ({ id, label, recommended: false, effects: [{ kind: 'plan-amendment' }], needs, decidedBy: allowed });
const file = (id, path, options) => ({ id, kind: 'plan-accounting', title: `Say where ${path} belongs`, why: `${path} changed | and no row names it.`, decidedBy: allowed, details: { path }, options });
const review = { kind: 'witness', clauseId: 'PAY-1:AC-001', slot: 'visual', method: 'visual', files: ['shot.png'], owners: [], contextBinding: 'sha256:b' };
const packet = (fields = {}) => ({
  workId: 'PAY-1', phaseLabel: 'Code', headline: 'Code can\'t be approved yet.', packetSha256: 'sha256:aaa', repositoryPath: '/repo',
  items: [file('d1', 'a.js', [choice('row-1', 'Add to REQ-001'), choice('row-2', 'Add to REQ-002')]), file('d2', 'b.js', [choice('row-1', 'Add to REQ-001')]),
    { id: 'd3', kind: 'test-run-risk', title: 'The tests could not run', why: 'No browser.', decidedBy: allowed, options: [choice('accept-test-risk', 'Accept until a date', {
      reason: { default: 'Suggested.', minimum: 20, maximum: 1000 }, cause: { default: 'Suggested.', minimum: 10, maximum: 300 }, expires: { default: '2026-12-01', latest: '2027-01-01' } })] },
    { id: 'd4', kind: 'approval-hold', title: 'A dirty checkout', why: 'Files changed.', decidedBy: allowed, options: [{ id: 'route', label: 'Clear it', recordable: false, effects: [], needs: {}, decidedBy: allowed, action: { command: 'singularity-flow recover PAY-1 --json' } }] },
    { id: 'd5', kind: 'test-command', title: 'Theirs', why: 'Another group.', decidedBy: { allowed: false, words: 'The Leads decide this.', share: '/sf-decide PAY-1' }, options: [{ ...choice('x', 'Accept it'), decidedBy: { allowed: false } }] },
    { id: 'd6', kind: 'approval', title: 'Approve Code', why: 'Waits.', decidedBy: allowed, options: [{ id: 'approve', label: 'Approve', recordable: false, effects: [], needs: {}, decidedBy: allowed, action: { command: 'singularity-flow approve implementation' } }] }],
  ...fields
});

function person(replies, lists = [packet()]) {
  const seen = { asked: [], shown: [], recorded: [], witnessed: [], looked: [] };
  let reads = 0;
  return { seen, ui: {
    read: async () => lists[Math.min(reads++, lists.length - 1)],
    show: async (text) => { seen.shown.push(text); },
    ask: async (form) => { seen.asked.push(form); return replies.shift() ?? { action: 'cancel' }; },
    record: async (read, document) => { if (seen.fail) { const error = seen.fail; seen.fail = null; throw error; } seen.recorded.push({ digest: read.packetSha256, document }); return { recorded: Object.keys(document.choose).map((item) => ({ item, record: `R-${item}` })) }; },
    witness: async (read, current, answer) => { seen.witnessed.push({ current, answer }); return { record: { id: 'WIT-001' } }; },
    inspect: async (read, name) => { seen.looked.push(name); }
  } };
}
const accept = (content) => ({ action: 'accept', content });
const mine = [{ item: 'd1', title: 'Say where a.js belongs', option: 'row-2', reason: 'Its own reason, long enough.' }];

test('the table shows every open decision and who answers it, and the approval as its own row that /sf-approve opens', () => {
  const table = decisionsTable(packet());
  assert.match(table, /a\.js \| a\.js changed \\\| and no row names it\./u);
  assert.match(table, /Stays in your terminal: `singularity-flow recover PAY-1 --json`/u);
  assert.match(table, /The Leads decide this\. Share: \/sf-decide PAY-1/u);
  // One place [owner, 2026-11-13]: the approval is a row of the card, reviewed with its documents, never on a form.
  assert.match(table, /\| Approve Code \| Waits\. \| Review its documents and approve with \/sf-approve --work-id PAY-1; or in your terminal: `singularity-flow approve implementation` \|/u);
  assert.equal(cardRows(packet()).length, 5);
});

test('a row with a form still names each step that stays in the terminal, and a row of terminal steps names every one (2026-11-09)', () => {
  const own = (id, label, command) => ({ id, label, recordable: false, effects: [], needs: {}, decidedBy: allowed, action: { command } });
  const gap = { id: 'd1', kind: 'conformance-gap', title: 'AC-001 deviated', why: 'The report marks it deviated.', decidedBy: allowed,
    options: [own('fix-code', 'Fix the code: return to Code', 'singularity-flow reject conformance --work-id PAY-1 --to implementation --reason <reason>'), choice('accept-risk', 'Accept for now')] };
  const amendment = { id: 'd2', kind: 'forward-amendment', title: 'Decide forward amendment FAM-001', why: 'It proposes a corrected plan.', decidedBy: allowed,
    options: [own('approve', 'Approve it.', 'singularity-flow upstream-issue decide-amendment FAM-001 --decision approve'), own('reject', 'Reject it', 'singularity-flow upstream-issue decide-amendment FAM-001 --decision reject')] };
  const table = decisionsTable(packet({ items: [gap, amendment] }));
  // VS Code shows these beside the choices; a /decide that showed only the forms hid "Fix the code".
  assert.ok(table.includes('Your decision, on the forms below; or in your terminal: `singularity-flow reject conformance --work-id PAY-1 --to implementation --reason <reason>`'), table);
  assert.ok(table.includes('Stays in your terminal: Approve it: `singularity-flow upstream-issue decide-amendment FAM-001 --decision approve`; Reject it: `singularity-flow upstream-issue decide-amendment FAM-001 --decision reject`'), table);
  // An intent amendment is decided on the forms now, each choice with its own terminal command beside it [owner, 2026-11-13].
  const decide = (decision) => `singularity-flow story intent-amendment decide AMD-001 --decision ${decision} --confirm AMD-001 --work-id PAY-1`;
  const intent = { id: 'd3', kind: 'intent-amendment', title: 'Decide intent amendment AMD-001', why: 'It proposes a change.', decidedBy: allowed,
    options: [{ ...choice('reject', 'Reject AMD-001'), terminal: decide('reject') }, { ...choice('approve', 'Approve AMD-001'), terminal: decide('approve') }],
    details: { lines: ['AC-001 is revised from "1" to "2"'], proposedBy: 'Story Author proposed it.', reach: 'If it is approved: Plan is reopened: it cites AC-001.' } };
  const decided = decisionsTable(packet({ items: [intent] }));
  assert.ok(decided.includes(`Your decision, on the forms below; or in your terminal: Reject AMD-001: \`${decide('reject')}\`; Approve AMD-001: \`${decide('approve')}\``), decided);
  assert.ok(decided.includes('**Decide intent amendment AMD-001.** Story Author proposed it.\n- AC-001 is revised from "1" to "2"\n- If it is approved: Plan is reopened: it cites AC-001.'), decided);
});

test('nothing is preselected: no default on any field, and a person must choose', () => {
  const [{ form, items }] = rowForms(cardRows(packet()).slice(0, 3));
  for (const property of Object.values(form.requestedSchema.properties)) assert.equal(property.default, undefined);
  assert.equal(form.requestedSchema.properties.decision0.enum[0], LEAVE);
  const risk = items[2].options[0];
  const details = detailForm(items[2], risk).requestedSchema.properties;
  for (const property of Object.values(details)) assert.equal(property.default, undefined);
  assert.ok(details.until.title.includes('2027-01-01'));
  assert.ok(details.cause);
});

test('one answer is offered only where rows share it, and never one that needs a date', () => {
  assert.deepEqual(sharedAnswers(packet()).map((entry) => [entry.id, entry.items.length]), [['row-1', 2]]);
  assert.ok(firstForm(packet()).form.requestedSchema.properties.choice.enum.includes('Add to REQ-001 for all 2, with one reason'));
});

test('the choice comes first, and only what that choice needs comes after: a date is asked only of a risk', () => {
  const rows = cardRows(packet()).slice(0, 3);
  const [{ form }] = rowForms(rows);
  assert.deepEqual(Object.keys(form.requestedSchema.properties), ['decision0', 'decision1', 'decision2'], 'no reason, cause or date on the first form');
  const plain = detailForm(rows[0], rows[0].options[0]).requestedSchema;
  assert.deepEqual(Object.keys(plain.properties), ['reason']);
  const risk = detailForm(rows[2], rows[2].options[0]).requestedSchema;
  assert.deepEqual(Object.keys(risk.properties), ['reason', 'cause', 'until']);
  assert.deepEqual(risk.required, ['reason', 'cause', 'until']);
});

test('each field carries its own rule: in its title, and in the schema for a host that checks', () => {
  const rows = cardRows(packet()).slice(0, 3);
  const { reason, cause, until } = detailForm(rows[2], rows[2].options[0]).requestedSchema.properties;
  const need = rows[2].options[0].needs;
  assert.equal(reason.title, `Reason (${need.reason.minimum} to ${need.reason.maximum} characters)`);
  assert.equal(reason.minLength, need.reason.minimum);
  assert.equal(reason.maxLength, need.reason.maximum);
  assert.equal(cause.title, `What stops the tests (${need.cause.minimum} to ${need.cause.maximum} characters)`);
  assert.equal(cause.minLength, need.cause.minimum);
  assert.match(until.title, /^Until when \(YYYY-MM-DD, no later than 2027-01-01\)$/u);
  assert.ok(new RegExp(until.pattern, 'u').test('2026-12-02'));
  assert.ok(!new RegExp(until.pattern, 'u').test('soon'));
});

test('a form\'s answers: a short reason or a bad date is refused, saying what was wrong, and each row keeps its own', () => {
  const rows = cardRows(packet()).slice(0, 3);
  assert.match(choicesFromRows(rows, { decision0: 'Not one of them' }).problem, /not a decision/u);
  assert.deepEqual(choicesFromRows(rows, { decision0: LEAVE, decision1: LEAVE, decision2: LEAVE }).picks, []);
  assert.match(valuesFromForm(rows[0], rows[0].options[1], { reason: 'short' }).problem, /a\.js must be 20 to 500 characters; that was 5\./u);
  const risk = rows[2].options[0];
  const good = { reason: 'The browser is not on this machine.', cause: 'No browser here', until: '2026-12-02' };
  for (const until of ['soon', '2026-13-45', '2099-01-01']) {
    assert.match(valuesFromForm(rows[2], risk, { ...good, until }).problem, new RegExp(`must be YYYY-MM-DD, after today and no later than 2027-01-01\\. You gave "${until}"`, 'u'));
  }
  assert.match(valuesFromForm(rows[2], risk, { ...good, until: '2020-01-01' }).problem, /after today/u, 'a date already past is refused here, not by the record afterwards');
  const picks = choicesFromRows(rows, { decision0: 'Add to REQ-002', decision1: 'Add to REQ-001', decision2: 'Accept until a date' }).picks;
  assert.deepEqual(picks.map(({ item, option }) => [item.id, option.id]), [['d1', 'row-2'], ['d2', 'row-1'], ['d3', 'accept-test-risk']]);
  assert.deepEqual(valuesFromForm(rows[2], risk, good), { values: { reason: good.reason, cause: good.cause, expires: '2026-12-02' }, problem: null });
});

test('a refused form is asked again with the problem on top and every answer kept, and three refusals stop with nothing recorded', async () => {
  const short = accept({ reason: 'sdsaad' });
  // The real run: choose accept-risk, get the date wrong, then the reason too short, again and again.
  const rows = (reason, until) => accept({ reason, cause: 'No browser here to run these', until });
  const replies = [accept({ choice: EACH }), accept({ decision0: LEAVE, decision1: LEAVE, decision2: 'Accept until a date' }),
    rows('The browser is not on this machine.', 'soon'), rows('sdsaad', '2026-12-02'), rows('The browser is not on this machine.', '2026-12-02'), accept({ confirm: RECORD })];
  const fixed = person([...replies]);
  assert.equal((await runCard(fixed.ui)).status, 'recorded');
  const details = fixed.seen.asked.filter((form) => form.requestedSchema.properties.until);
  assert.equal(details.length, 3);
  assert.doesNotMatch(details[0].message, /must be/u, 'nothing to say the first time');
  assert.match(details[1].message, /^The date for The tests could not run must be YYYY-MM-DD/u, 'the last problem is the first thing on the form');
  assert.match(details[2].message, /^The reason for The tests could not run must be \d+ to \d+ characters; that was 6\./u);
  assert.equal(details[1].requestedSchema.properties.reason.default, 'The browser is not on this machine.', 'nothing to retype');
  assert.equal(details[1].requestedSchema.properties.cause.default, 'No browser here to run these');
  assert.equal(details[1].requestedSchema.properties.until.default, 'soon', 'what they typed, to correct');
  assert.equal(details[2].requestedSchema.properties.until.default, '2026-12-02');
  assert.equal(fixed.seen.shown.filter((text) => /must be/u.test(text)).length, 0, 'never a notification beside the form');
  assert.equal(fixed.seen.recorded[0].document.reason.d3, 'The browser is not on this machine.');

  const stuck = person([accept({ choice: EACH }), accept({ decision0: 'Add to REQ-002' }), short, short, short, accept({ confirm: RECORD })]);
  const result = await runCard(stuck.ui);
  assert.equal(result.status, 'refused');
  assert.deepEqual(stuck.seen.recorded, [], 'nothing recorded');
  assert.equal(stuck.seen.asked.filter((form) => form.requestedSchema.properties.reason).length, 3, 'three rounds, no fourth');
  assert.match(result.message, /^Nothing was recorded\. After 3 tries the form still could not take this: The reason for a\.js must be 20 to 500 characters; that was 6\./u);
});

test('a sign-off that is refused comes back the same way, and stops the same way', async () => {
  const signed = packet({ items: [{ id: 'd1', kind: 'evidence-obligation', title: 'Check the screenshot', why: 'A person looks.', decidedBy: allowed, options: [{ id: 'witness-1', label: 'I checked', recordable: false, effects: [], needs: {}, decidedBy: allowed,
    action: { command: 'singularity-flow decision witness', humanReview: { kind: 'witness', clauseId: 'PAY-1:AC-001', slot: 'screen', method: 'visual', files: ['shot.png'], owners: [], contextBinding: 'sha256:abc' } } }] }] });
  const answer = (reason) => accept({ choice: 'I looked at it', 'states-the-outcome': 'Yes', 'matches-the-criterion': 'Yes', 'current-for-this-change': 'Yes', reason });
  const { seen, ui } = person([answer('short'), answer('short'), answer('short')], [signed]);
  const result = await runCard(ui);
  assert.equal(result.status, 'refused');
  assert.match(result.message, /Describe what you inspected in 10 to 1000 characters/u);
  assert.equal(seen.witnessed.length, 0);
  assert.match(seen.asked[1].message, /^Describe what you inspected in 10 to 1000 characters\./u);
  assert.equal(seen.asked[1].requestedSchema.properties.reason.default, 'short');
  assert.equal(seen.asked[1].requestedSchema.properties['states-the-outcome'].default, 'Yes');
  assert.equal(witnessForm(signed.items[0].options[0].action.humanReview).requestedSchema.properties.reason.title, 'What did you inspect? In your own words (10 to 1000 characters)');
});

test('one answer for all records each row with that reason, once the person confirmed the exact list', async () => {
  const { seen, ui } = person([accept({ choice: 'Add to REQ-001 for all 2, with one reason' }), accept({ reason: 'Test support for the same requirement.' }), accept({ decision0: LEAVE }), accept({ confirm: RECORD })]);
  const result = await runCard(ui);
  assert.equal(seen.recorded.length, 1);
  assert.equal(seen.recorded[0].digest, 'sha256:aaa');
  assert.deepEqual(seen.recorded[0].document.choose, { d1: 'row-1', d2: 'row-1' });
  assert.deepEqual(seen.recorded[0].document.reason, { d1: 'Test support for the same requirement.', d2: 'Test support for the same requirement.' });
  assert.equal(seen.asked[1].requestedSchema.properties.reason.title, 'One reason for all of them (20 to 500 characters)');
  assert.match(seen.asked[3].message, /a\.js: Add to REQ-001\. Reason: Test support/u);
  assert.match(seen.asked[3].message, /Still undecided: The tests could not run/u);
  assert.equal(result.status, 'recorded');
  assert.deepEqual(result.recorded, ['R-d1', 'R-d2']);
});

test('Not now, a closed form or any other answer records nothing', async () => {
  for (const replies of [[accept({ choice: NOT_NOW })], [{ action: 'decline' }], [accept({ choice: EACH }), { action: 'cancel' }],
    [accept({ choice: EACH }), accept({ decision0: 'Add to REQ-002' }), accept({ reason: 'The first row\'s own reason.' }), accept({ confirm: NOT_NOW })]]) {
    const { seen, ui } = person(replies);
    assert.equal((await runCard(ui)).status, 'cancelled');
    assert.equal(seen.recorded.length, 0, JSON.stringify(replies));
  }
});

test('a changed list records nothing, and only answers that still mean the same thing go back for confirmation', async () => {
  const fresh = packet({ packetSha256: 'sha256:bbb', items: [{ ...packet().items[0], id: 'd9' }, packet().items.at(-1)] });
  assert.deepEqual(answersOnCurrentList(fresh, mine), [{ ...mine[0], item: 'd9' }]);
  assert.deepEqual(answersOnCurrentList(packet({ items: [] }), mine), []);
  const { seen, ui } = person([accept({ choice: EACH }), accept({ decision0: 'Add to REQ-002' }), accept({ reason: 'Its own reason, long enough.' }), accept({ confirm: RECORD }), accept({ confirm: RECORD })], [packet(), fresh, fresh]);
  seen.fail = Object.assign(new Error('changed'), { code: 'DECISIONS_PACKET_CHANGED' });
  const result = await runCard(ui);
  assert.ok(seen.shown.some((text) => /list changed while it was open, so nothing was recorded/u.test(text)));
  assert.deepEqual(seen.recorded.map((entry) => [entry.digest, entry.document.choose]), [['sha256:bbb', { d9: 'row-2' }]]);
  assert.equal(result.status, 'recorded');
});

test('a Story signed with SF Guard hands over one command with nothing to fill in, and writes nothing here', async () => {
  const { seen, ui } = person([accept({ choice: EACH }), accept({ decision0: 'Add to REQ-002' }), accept({ reason: 'Its own reason, long enough.' }), accept({ confirm: RECORD })]);
  seen.fail = Object.assign(new Error('needs a card'), { code: 'PSS_CARD_NOT_SHOWN' });
  const result = await runCard(ui);
  assert.equal(result.status, 'needs-terminal');
  assert.equal(result.command, 'singularity-flow decisions record PAY-1');
  assert.match(result.message, /Touch ID is taken in your own terminal, so nothing was written here/u);
  assert.equal(seen.recorded.length, 0);
});

test('what comes back says what was decided, one to a decision, so no agent can report something else (bin-opr2)', async () => {
  const { ui } = person([accept({ choice: EACH }), accept({ decision0: 'Add to REQ-002' }), accept({ reason: 'Its own reason, long enough.' }), accept({ confirm: RECORD })]);
  const words = 'Accept it as a risk until a date: accept it as a risk until 2027-02-04 (decision on UPI-001)';
  ui.record = async () => ({ recorded: [{ item: 'd1', record: 'UPI-001' }, { item: 'd1', record: 'UPI-001 accept-risk' }], decided: [{ item: 'd1', words }] });
  const result = await runCard(ui);
  assert.deepEqual(result.recorded, ['UPI-001', 'UPI-001 accept-risk'], 'two records');
  assert.deepEqual(result.decided, [words], 'one decision');
  assert.ok(result.message.startsWith(`1 decision recorded. ${words}.`), result.message);
});

test('a sign-off is one form, the same three questions, recorded only on its own confirmation', async () => {
  const signed = packet({ items: [{ id: 'd1', kind: 'evidence-obligation', title: 'Check the screenshot', why: 'A person looks.', decidedBy: allowed, options: [{ id: 'witness-1', label: 'I checked', recordable: false, effects: [], needs: {}, decidedBy: allowed, action: { command: 'singularity-flow decision witness', humanReview: review } }] }] });
  const form = witnessForm(review);
  assert.deepEqual(Object.keys(form.requestedSchema.properties), ['choice', 'states-the-outcome', 'matches-the-criterion', 'current-for-this-change', 'reason']);
  assert.match(witnessAnswers(review, { 'states-the-outcome': 'Yes', 'matches-the-criterion': 'Yes', 'current-for-this-change': 'Yes', reason: 'short' }).problem, /10 to 1000/u);
  const yes = { choice: 'I looked at it', 'states-the-outcome': 'Yes', 'matches-the-criterion': 'No', 'current-for-this-change': 'Yes', reason: 'The total shows on the screenshot.' };
  const { seen, ui } = person([accept(yes), accept({ confirm: SIGN })], [signed, signed, packet({ items: [packet().items.at(-1)] })]);
  const result = await runCard(ui);
  assert.deepEqual(seen.looked, ['shot.png'], 'the file is put in front of the person first');
  assert.deepEqual(seen.witnessed[0].answer.answers, [['states-the-outcome', true], ['matches-the-criterion', false], ['current-for-this-change', true]]);
  assert.deepEqual(result.recorded, ['WIT-001']);
  assert.equal(result.message, '1 decision recorded. Signed off PAY-1:AC-001 · visual. All decided.');
  const declined = person([accept({ ...yes, choice: NOT_NOW })], [signed]);
  assert.equal((await runCard(declined.ui)).status, 'cancelled');
  assert.equal(declined.seen.witnessed.length, 0);
});

test('a list with nothing to decide opens no form', async () => {
  const { seen, ui } = person([], [packet({ items: [packet().items.at(-1)] })]);
  assert.equal((await runCard(ui)).status, 'nothing-to-decide');
  assert.equal(seen.asked.length, 0);
});

test('the confirmation names every answer with its reason', () => {
  const form = confirmForm(packet(), mine);
  assert.match(form.message, /a\.js: Add to REQ-002\. Reason: Its own reason/u);
  assert.deepEqual(form.requestedSchema.properties.confirm.enum, [RECORD, NOT_NOW]);
});

const scopeRow = (id, statement) => ({ id, kind: 'owed-decision', title: `Decide scope item ${id}`, why: `"${statement}" needs a link.`, decidedBy: allowed, details: { scopeItem: id }, options: [
  choice('scope-included', 'Included: a clause of this Story states it', { clause: { known: ['PAY-1:REQ-001'] }, reason: { default: '', minimum: 20, maximum: 1000 } }),
  choice('scope-excluded', 'Exclude it from this Story')] });
const checklist = { articles: [{ id: 'completeness', title: 'Completeness', question: 'Is every scenario covered?' }, { id: 'ambiguity', title: 'Ambiguity', question: 'Is it free of ambiguity?' }], decisions: ['satisfied', 'exception', 'not-applicable'] };
const reviewRow = { id: 'd9', kind: 'scope-completeness', title: 'Review the scope for completeness', why: 'Nothing waits on this review.', decidedBy: allowed, details: {}, options: [
  choice('reviewed', 'I reviewed it: record my answers', { article: checklist, reason: { default: '', minimum: 20, maximum: 1000 } })] };

test('a scope row asks for clauses, and an included statement with none goes back to the form', async () => {
  const list = packet({ items: [scopeRow('d1', 'It must export.'), scopeRow('d2', 'It must log.')] });
  assert.deepEqual(sharedAnswers(list).map((entry) => entry.id), ['scope-excluded'], 'naming clauses is each row\'s own');
  const [page] = rowForms(list.items);
  assert.deepEqual(Object.keys(page.form.requestedSchema.properties), ['decision0', 'decision1'], 'the choices alone');
  const { picks } = choicesFromRows(page.items, { decision0: 'Included: a clause of this Story states it', decision1: 'Exclude it from this Story' });
  assert.ok(detailForm(picks[0].item, picks[0].option).requestedSchema.properties.clause, 'clauses are asked of a choice that needs them');
  assert.equal(detailForm(picks[1].item, picks[1].option).requestedSchema.properties.clause, undefined, 'and of no other');
  assert.match(valuesFromForm(picks[0].item, picks[0].option, { reason: 'The first requirement carries it.' }).problem, /Name the clauses that carry/u);
  assert.deepEqual(valuesFromForm(picks[0].item, picks[0].option, { reason: 'The first requirement carries it.', clause: 'REQ-001' }).values.clause, 'REQ-001');
  const { seen, ui } = person([accept({ choice: EACH }), accept({ decision0: 'Included: a clause of this Story states it', decision1: 'Exclude it from this Story' }),
    accept({ reason: 'The first requirement carries it.', clause: 'REQ-001' }), accept({ reason: 'Logging is not part of this Story.' }), accept({ confirm: RECORD })], [list, { ...list, items: [] }]);
  await runCard(ui);
  assert.deepEqual(seen.recorded[0].document.clause, { d1: 'REQ-001' });
  assert.match(seen.asked.at(-1).message, /Carried by REQ-001\./u);
});

test('a review nothing waits on has its own form, and only a person who typed /decide meets it alone', async () => {
  const list = packet({ items: [], offered: [reviewRow] });
  assert.deepEqual(cardRows(list).map((item) => item.id), ['d9']);
  const chat = person([], [list]);
  assert.equal((await runCard({ ...chat.ui, askedInChat: true })).status, 'nothing-to-decide', 'a chat that asked carries on');
  assert.equal(chat.seen.asked.length, 0, 'it never stops a chat turn');
  const [page] = rowForms(list.offered);
  assert.deepEqual(page.form.requestedSchema.required, ['decision0'], 'nothing is answered for the person');
  const [row] = page.items;
  const [option] = row.options;
  const schema = detailForm(row, option).requestedSchema;
  assert.equal(schema.properties['article-completeness'].title, 'Is every scenario covered?');
  assert.ok(schema.required.includes('article-ambiguity'), 'every article is answered');
  assert.ok(!schema.required.includes('why-ambiguity'), 'its reason only if it is not satisfied');
  const fields = { reason: 'I looked at all of it, carefully.', 'article-completeness': 'satisfied' };
  assert.match(valuesFromForm(row, option, fields).problem, /Answer every article/u);
  assert.match(valuesFromForm(row, option, { ...fields, 'article-ambiguity': 'exception' }).problem, /needs its own reason/u);
  const person2 = person([accept({ decision0: 'I reviewed it: record my answers' }), accept({ ...fields, 'article-ambiguity': 'exception', 'why-ambiguity': 'Two words read two ways.' }), accept({ confirm: RECORD })], [list, { ...list, offered: [] }]);
  const result = await runCard(person2.ui);
  assert.deepEqual(person2.seen.recorded[0].document.article.d9, [{ article: 'completeness', decision: 'satisfied' }, { article: 'ambiguity', decision: 'exception', reason: 'Two words read two ways.' }]);
  assert.equal(result.status, 'recorded');
  assert.deepEqual(result.remaining, [], 'offered rows are not what remains');
});

// A code step's departures [CQF:REQ-024]: files share one "Accept all"; a plan row or test is each row's own.
const departure = (id, title, { one = false } = {}) => ({ id, kind: 'departure', title, why: 'The model recorded it.', decidedBy: allowed, details: { departure: id, acceptAll: !one },
  options: [{ ...choice('accept', 'Accept'), ...(one ? { oneByOne: true } : {}) }, choice('reject', 'Reject')] });

test('"Accept all" covers file departures and leaves a plan row or a test to be decided one by one', async () => {
  const list = packet({ items: [departure('d1', 'DEP-001: index.html changed'), departure('d2', 'DEP-002: about.html changed'),
    departure('d3', 'DEP-003: a planned test changes', { one: true }), departure('d4', 'DEP-004: a plan row changes', { one: true })] });
  const shared = sharedAnswers(list);
  assert.deepEqual(shared.map((entry) => [entry.id, entry.items.map((item) => item.id)]), [['accept', ['d1', 'd2']], ['reject', ['d1', 'd2', 'd3', 'd4']]]);
  const reason = 'Both pages ship with the code they show.';
  const testReason = 'The renamed test still proves the clause.';
  const { seen, ui } = person([accept({ choice: 'Accept for all 2, with one reason' }), accept({ reason }),
    accept({ decision0: 'Accept', decision1: LEAVE }), accept({ reason: testReason }), accept({ confirm: RECORD })], [list]);
  await runCard({ ...ui, askedInChat: false });
  const [recorded] = seen.recorded;
  assert.deepEqual(recorded.document.choose, { d1: 'accept', d2: 'accept', d3: 'accept' });
  assert.deepEqual(recorded.document.reason, { d1: reason, d2: reason, d3: testReason }, 'the one-by-one row carries its own reason');
});

// The step's evidence beside its decisions, as the VS Code card shows it [CQF:REQ-031, REQ-033, REQ-034, REQ-052, REQ-055].
test('the table shows the same evidence as the VS Code card, in the engine\'s words, and asks nothing new', async () => {
  const { approvalEvidence, evidenceWords, HOLD_COMMAND } = await import('./helpers/approval-evidence-packet.mjs');
  const { evidenceLines } = await import('../plugin/extensions/decisions/card.mjs');
  const evidence = approvalEvidence();
  const list = packet({ approvalEvidence: evidence });
  const table = decisionsTable(list);
  for (const words of evidenceWords(evidence)) assert.ok(table.includes(words), `missing: ${words}`);
  assert.ok(table.indexOf('| A dirty checkout |') < table.indexOf('**Evidence for this approval.**'), 'after the decisions');
  assert.ok(table.includes(`Stays in your terminal: \`${HOLD_COMMAND}\``));
  assert.match(evidenceLines(packet({ approvalEvidence: approvalEvidence({ allowed: false }) })).join('\n'), /Share this with them: \/sf-decide PAY-1/u);
  assert.ok(!evidenceLines(packet({ approvalEvidence: approvalEvidence({ allowed: false }) })).join('\n').includes(HOLD_COMMAND), 'no command for someone who may not accept it');
  assert.deepEqual(evidenceLines(packet()), [], 'a list without evidence shows none');
  // The hold's own row already offers its command: the evidence points there instead of offering it twice.
  const holdRow = { id: 'd7', kind: 'approval-hold', title: 'Code waits for a person', why: 'A vulnerable package.', decidedBy: allowed,
    options: [{ id: 'route', label: 'Accept it', recordable: false, effects: [], needs: {}, decidedBy: allowed, action: { command: HOLD_COMMAND } }] };
  const once = decisionsTable(packet({ items: [holdRow], approvalEvidence: evidence }));
  assert.equal(once.split('singularity-flow decision finding-risk').length - 1, 1);
  assert.match(once, /Its command is on the hold's row above\./u);
  // The forms are the list's alone: the evidence adds no question and no answer.
  assert.deepEqual(firstForm(list), firstForm(packet()));
  assert.deepEqual(rowForms(cardRows(list)), rowForms(cardRows(packet())));
});

test('both hosts show the same facts from the one list', async () => {
  const { approvalEvidence, evidenceWords } = await import('./helpers/approval-evidence-packet.mjs');
  const { decideHtml } = await import('../apps/vscode/src/views/decide-card-page.ts');
  const evidence = approvalEvidence({ accepted: { id: 'FRK-001', by: 'Pat Reviewer', until: '2026-12-01' } });
  const list = packet({ resultType: 'sflow-decisions', phase: 'implementation', status: 'decisions-needed', approvalEvidence: evidence });
  const card = decideHtml(list).replace(/<[^>]+>/gu, '').replace(/\s+/gu, ' ').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&');
  const table = decisionsTable(list);
  for (const words of evidenceWords(evidence)) {
    assert.ok(card.includes(words), `the card lacks: ${words}`);
    assert.ok(table.includes(words), `the table lacks: ${words}`);
  }
});

test('Update the spec on the forms writes a draft: the confirmation and the result say it is not a record, and where it is [SCS:REQ-020]', async () => {
  const draft = { id: 'update-spec', label: 'Update the spec: draft Intake\'s amendment', recommended: false, words: 'Writes a draft.',
    effects: [{ kind: 'intent-amendment-draft', phase: 'intake', clauses: ['PAY-1:AC-001'] }], needs: { reason: { default: '', minimum: 20, maximum: 1000 } }, decidedBy: allowed };
  const list = packet({ items: [{ id: 'd1', kind: 'conformance-gap', title: 'AC-001 is deviated in the Conformance report', why: 'The code differs.', decidedBy: allowed, options: [draft] }] });
  const answers = [{ item: 'd1', title: list.items[0].title, option: 'update-spec', reason: 'Legacy callers rely on the longer wait.' }];
  assert.match(confirmForm(list, answers).message, /^Draft this amendment on PAY-1; nothing is recorded or decided:/u);
  const where = '/repo/.git/singularity-flow/intent-amendment-drafts/PAY-1.md';
  const { ui } = person([accept({ decision0: draft.label }), accept({ reason: answers[0].reason }), accept({ confirm: RECORD })], [list, { ...list, items: [] }]);
  ui.record = async () => ({ recorded: [], decided: [], drafted: [{ item: 'd1', path: where, next: { words: 'Write the wording, then propose it.' } }] });
  const result = await runCard(ui);
  assert.equal(result.status, 'drafted');
  assert.match(result.message, new RegExp(`^No decision was recorded\\. Drafted at ${where.replace(/[./]/gu, '\\$&')}\\. Write the wording, then propose it\\.`, 'u'));
});

// [SCS:REQ-034, REQ-035] Answers given and files the plan settled wait behind their own first choice, as /adjudicate keeps
// "Overrule a row the plan settled": the forms cover what waits unless the person chooses to change those (owner, 2026-11-09).
const DISPOSITIONS = [['rework', 'Send back to fix'], ['accepted-deviation', 'Accept as is'], ['dismissed', 'Not a real finding'], ['deferred', 'Decide later']];
const convergence = (id, kind, title) => ({ id, kind, title, why: `${title}.`, decidedBy: allowed, details: kind === 'convergence-item' ? {} : { path: `${id}.json` },
  options: DISPOSITIONS.map(([option, label]) => ({ ...choice(option, label, { reason: { default: '', minimum: option === 'rework' ? 0 : 1, maximum: 1000 } }),
    effects: [{ kind: 'convergence-adjudication' }], oneByOne: true })) });
const converging = (offered) => packet({ items: [convergence('d1', 'convergence-item', 'REQ-002: no recorded trace')], offered });
const settledFiles = [convergence('d2', 'convergence-answer', 'REQ-001: answered Decide later'),
  ...['d3', 'd4', 'd5', 'd6', 'd7', 'd8'].map((id) => convergence(id, 'convergence-settled', `config ${id}: settled by the plan`))];

test('answers given and settled files wait behind "Change an answer or overrule the plan"; the forms ask only what waits', async () => {
  const list = converging(settledFiles);
  const { form, change } = firstForm(list);
  assert.equal(change, `${CHANGE} (7)`);
  assert.deepEqual(form.requestedSchema.properties.choice.enum, [EACH, `${CHANGE} (7)`, NOT_NOW]);
  assert.match(form.message, /^1 still need a decision from you\. 7 are offered beside the list: an answer already given, or a file the plan settled, which you may change if you disagree\.$/u);
  assert.match(decisionsTable(list), /\| d3\.json \| config d3: settled by the plan\. \| Yours to change if you disagree: "Change an answer or overrule the plan" on the first form below \|/u);
  // Deciding each one asks only the open row.
  const each = person([accept({ choice: EACH }), accept({ decision0: 'Decide later' }), accept({ reason: 'Waits for the next Story.' }), accept({ confirm: RECORD })], [list, { ...list, items: [] }]);
  await runCard(each.ui);
  assert.deepEqual(Object.keys(each.seen.asked[1].requestedSchema.properties), ['decision0'], 'an offered row was asked with what waits');
  assert.deepEqual(each.seen.recorded[0].document.choose, { d1: 'deferred' });
  // Choosing to change asks the offered rows first, five to a form, then what waits; sending back to fix needs no reason.
  const changing = person([accept({ choice: `${CHANGE} (7)` }), accept({ decision0: LEAVE, decision1: 'Send back to fix', decision2: LEAVE, decision3: LEAVE, decision4: LEAVE }),
    accept({}), accept({ decision0: LEAVE, decision1: LEAVE, decision2: LEAVE }), accept({ confirm: RECORD })], [list, list]);
  await runCard(changing.ui);
  const pages = changing.seen.asked.filter((asked) => asked.requestedSchema.properties.decision0);
  assert.deepEqual(pages.map((page) => Object.values(page.requestedSchema.properties).map((field) => field.title.split(':')[0])),
    [['d2.json', 'd3.json', 'd4.json', 'd5.json', 'd6.json'], ['d7.json', 'd8.json', 'REQ-002']]);
  const rework = changing.seen.asked[2];
  assert.deepEqual(rework.requestedSchema.required, [], 'the form demanded a reason the record does not need');
  assert.deepEqual(changing.seen.recorded[0].document, { choose: { d3: 'rework' }, reason: { d3: '' }, cause: {}, expires: {}, clause: {}, article: {}, confirm: 'sha256:aaa' });
});

test('with nothing open, the first form offers only the change or Not now, and Not now or Esc keeps what was answered', async () => {
  const list = { ...converging(settledFiles), items: [] };
  assert.deepEqual(firstForm(list).form.requestedSchema.properties.choice.enum, [`${CHANGE} (7)`, NOT_NOW]);
  assert.match(firstForm(list).form.message, /^Nothing here waits on a decision from you\. 7 are offered/u);
  const notNow = person([accept({ choice: NOT_NOW })], [list]);
  assert.equal((await runCard(notNow.ui)).status, 'cancelled');
  assert.deepEqual(notNow.seen.recorded, []);
  // Esc on a later form keeps the answers already given, and asks to confirm them.
  const esc = person([accept({ choice: `${CHANGE} (7)` }), accept({ decision0: 'Accept as is', decision1: LEAVE, decision2: LEAVE, decision3: LEAVE, decision4: LEAVE }),
    accept({ reason: 'It is fine as it is.' }), { action: 'cancel' }, accept({ confirm: RECORD })], [list, list]);
  await runCard(esc.ui);
  assert.deepEqual(esc.seen.recorded[0].document.choose, { d2: 'accepted-deviation' });
  // A chat that asked carries on when nothing waits, as before.
  assert.equal((await runCard({ ...person([], [list]).ui, askedInChat: true })).status, 'nothing-to-decide');
});

test('the Copilot CLI table names evidence carried by a step\'s "still holds", as the card does [SCS:REQ-022]', async () => {
  const { evidenceLines } = await import('../plugin/extensions/decisions/card.mjs');
  const lines = evidenceLines(packet({ approvalEvidence: { phase: 'conformance', phaseLabel: 'Code checking', words: 'Evidence beside these decisions.', carried: { words: 'Counted on a person\'s word, not a new run: tests and reviews that predate the amended wording, kept because the step\'s own approvers said it still holds.',
    entries: [{ amendment: 'AMD-001', phase: 'implementation', generation: 1, clauses: ['PAY-1:AC-001'], by: 'Code Approver', authorityGroup: 'engineering-reviewers',
      words: "PAY-1:AC-001: Code's evidence predates AMD-001's wording; Code Approver, for the Code approvers (engineering-reviewers), said it still holds." }] } } }));
  assert.ok(lines.includes('- **Carried by "still holds".** Counted on a person\'s word, not a new run: tests and reviews that predate the amended wording, kept because the step\'s own approvers said it still holds.'));
  assert.ok(lines.includes("  - PAY-1:AC-001: Code's evidence predates AMD-001's wording; Code Approver, for the Code approvers (engineering-reviewers), said it still holds."));
});

test('nobody types a path: several files are a choice, none is never asked, and a failed sign-off keeps the rest (2026-11-11)', async () => {
  // The owner was asked "The file you looked at" for a screenshot no step had captured, typed "i h", and the whole card
  // ended in ENOENT with nothing more recorded.
  const several = { ...review, files: ['src/a.jsx', 'src/b.css'] };
  const form = witnessForm(several);
  assert.deepEqual(form.requestedSchema.properties.file.enum, ['src/a.jsx', 'src/b.css'], 'the person picks one of the files');
  const answered = { 'states-the-outcome': 'Yes', 'matches-the-criterion': 'Yes', 'current-for-this-change': 'Yes', reason: 'The layout reflows at the narrow viewport.' };
  assert.match(witnessAnswers(several, { ...answered, file: 'i h' }).problem, /Pick the file you looked at: src\/a\.jsx, src\/b\.css/u);
  assert.equal(witnessAnswers(several, { ...answered, file: 'src/b.css' }).file, 'src/b.css');

  const option = (id, files) => ({ id, label: 'I checked', recordable: false, effects: [], needs: {}, decidedBy: allowed,
    action: { command: 'singularity-flow decision witness', humanReview: { ...review, slot: id, files } } });
  const item = (id, files) => ({ id, kind: 'evidence-obligation', title: `Check ${id}`, why: 'A person looks.', decidedBy: allowed, options: [option(id, files)] });
  // No evidence file: nothing to look at, so it is not asked.
  const empty = packet({ items: [item('visual', [])] });
  const none = person([], [empty]);
  const nothing = await runCard(none.ui);
  assert.equal(none.seen.asked.length, 0, 'a sign-off with no file is never a form');
  assert.deepEqual([nothing.recorded, none.seen.witnessed], [[], []]);

  // The first sign-off fails to record; the second is still asked and recorded, and the failure is said.
  const two = packet({ items: [item('inspection', ['src/a.jsx']), item('inspection-2', ['src/b.css'])] });
  const yes = { choice: 'I looked at it', ...answered };
  const { seen, ui } = person([accept(yes), accept({ confirm: SIGN }), accept(yes), accept({ confirm: SIGN })], [two, two, two, two]);
  let calls = 0;
  ui.witness = async (read, current, answer) => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    seen.witnessed.push({ current, answer });
    return { record: { id: 'WIT-002' } };
  };
  const result = await runCard(ui);
  assert.deepEqual(result.recorded, ['WIT-002']);
  assert.ok(seen.shown.some((text) => /was not recorded: ENOENT/u.test(text)), 'the failed sign-off is said');
});
