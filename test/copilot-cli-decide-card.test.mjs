/**
 * Everything a step waits on as Copilot CLI forms. Only `ask` can answer, one answer reaches only rows
 * that offer it, each keeps its own reason, a changed list records nothing, and nothing is written until
 * the person confirms the exact list.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { answersFromRows, answersOnCurrentList, cardRows, confirmForm, decisionsTable, EACH, firstForm, LEAVE, NOT_NOW, RECORD, rowForms, runCard, sharedAnswers, SIGN, witnessAnswers, witnessForm } from '../plugin/extensions/decisions/card.mjs';

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

test('the table shows every open decision and who answers it; the approval is not a row', () => {
  const table = decisionsTable(packet());
  assert.match(table, /a\.js \| a\.js changed \\\| and no row names it\./u);
  assert.match(table, /Stays in your terminal: `singularity-flow recover PAY-1 --json`/u);
  assert.match(table, /The Leads decide this\. Share: \/sf-decide PAY-1/u);
  assert.doesNotMatch(table, /Approve Code/u);
  assert.equal(cardRows(packet()).length, 5);
});

test('nothing is preselected: no default on any field, and a person must choose', () => {
  const [{ form }] = rowForms(cardRows(packet()).slice(0, 3));
  for (const property of Object.values(form.requestedSchema.properties)) assert.equal(property.default, undefined);
  assert.equal(form.requestedSchema.properties.decision0.enum[0], LEAVE);
  assert.ok(form.requestedSchema.properties.until2.title.includes('2027-01-01'));
  assert.ok(form.requestedSchema.properties.cause2);
  assert.equal(firstForm(packet()).form.requestedSchema.properties.reason.default, undefined);
});

test('one answer is offered only where rows share it, and never one that needs a date', () => {
  assert.deepEqual(sharedAnswers(packet()).map((entry) => [entry.id, entry.items.length]), [['row-1', 2]]);
  assert.ok(firstForm(packet()).form.requestedSchema.properties.choice.enum.includes('Add to REQ-001 for all 2, with one reason'));
});

test('a form\'s answers: a reason without a decision, a short reason or a bad date is refused, each row keeps its own', () => {
  const rows = cardRows(packet()).slice(0, 3);
  assert.match(answersFromRows(rows, { decision0: LEAVE, reason0: 'A reason with no decision' }).problem, /Choose a decision for a\.js/u);
  assert.match(answersFromRows(rows, { decision0: 'Not one of them' }).problem, /not a decision/u);
  assert.match(answersFromRows(rows, { decision0: 'Add to REQ-001', reason0: 'short' }).problem, /a\.js must be 20 to 500/u);
  assert.match(answersFromRows(rows, { decision2: 'Accept until a date', reason2: 'The browser is not on this machine.', cause2: 'No browser here', until2: 'soon' }).problem, /YYYY-MM-DD/u);
  const { answers, problem } = answersFromRows(rows, { decision0: 'Add to REQ-002', reason0: 'The first row\'s own reason.', decision1: 'Add to REQ-001', reason1: 'The second row\'s own reason.',
    decision2: 'Accept until a date', reason2: 'The browser is not on this machine.', cause2: 'No browser here', until2: '2026-12-02' });
  assert.equal(problem, null);
  assert.deepEqual(answers.map((entry) => [entry.item, entry.option, entry.reason]), [['d1', 'row-2', 'The first row\'s own reason.'], ['d2', 'row-1', 'The second row\'s own reason.'], ['d3', 'accept-test-risk', 'The browser is not on this machine.']]);
  assert.equal(answers[2].expires, '2026-12-02');
});

test('one answer for all records each row with that reason, once the person confirmed the exact list', async () => {
  const { seen, ui } = person([accept({ choice: 'Add to REQ-001 for all 2, with one reason', reason: 'Test support for the same requirement.' }), accept({ decision0: LEAVE }), accept({ confirm: RECORD })]);
  const result = await runCard(ui);
  assert.equal(seen.recorded.length, 1);
  assert.equal(seen.recorded[0].digest, 'sha256:aaa');
  assert.deepEqual(seen.recorded[0].document.choose, { d1: 'row-1', d2: 'row-1' });
  assert.deepEqual(seen.recorded[0].document.reason, { d1: 'Test support for the same requirement.', d2: 'Test support for the same requirement.' });
  assert.match(seen.asked[2].message, /a\.js: Add to REQ-001\. Reason: Test support/u);
  assert.match(seen.asked[2].message, /Still undecided: The tests could not run/u);
  assert.equal(result.status, 'recorded');
  assert.deepEqual(result.recorded, ['R-d1', 'R-d2']);
});

test('Not now, a closed form or any other answer records nothing', async () => {
  for (const replies of [[accept({ choice: NOT_NOW })], [{ action: 'decline' }], [accept({ choice: EACH }), { action: 'cancel' }],
    [accept({ choice: EACH }), accept({ decision0: 'Add to REQ-002', reason0: 'The first row\'s own reason.' }), accept({ confirm: NOT_NOW })]]) {
    const { seen, ui } = person(replies);
    assert.equal((await runCard(ui)).status, 'cancelled');
    assert.equal(seen.recorded.length, 0, JSON.stringify(replies));
  }
});

test('a changed list records nothing, and only answers that still mean the same thing go back for confirmation', async () => {
  const fresh = packet({ packetSha256: 'sha256:bbb', items: [{ ...packet().items[0], id: 'd9' }, packet().items.at(-1)] });
  assert.deepEqual(answersOnCurrentList(fresh, mine), [{ ...mine[0], item: 'd9' }]);
  assert.deepEqual(answersOnCurrentList(packet({ items: [] }), mine), []);
  const { seen, ui } = person([accept({ choice: EACH }), accept({ decision0: 'Add to REQ-002', reason0: 'Its own reason, long enough.' }), accept({ confirm: RECORD }), accept({ confirm: RECORD })], [packet(), fresh, fresh]);
  seen.fail = Object.assign(new Error('changed'), { code: 'DECISIONS_PACKET_CHANGED' });
  const result = await runCard(ui);
  assert.ok(seen.shown.some((text) => /list changed while it was open, so nothing was recorded/u.test(text)));
  assert.deepEqual(seen.recorded.map((entry) => [entry.digest, entry.document.choose]), [['sha256:bbb', { d9: 'row-2' }]]);
  assert.equal(result.status, 'recorded');
});

test('a Story signed with SF Guard hands over one command with nothing to fill in, and writes nothing here', async () => {
  const { seen, ui } = person([accept({ choice: EACH }), accept({ decision0: 'Add to REQ-002', reason0: 'Its own reason, long enough.' }), accept({ confirm: RECORD })]);
  seen.fail = Object.assign(new Error('needs a card'), { code: 'PSS_CARD_NOT_SHOWN' });
  const result = await runCard(ui);
  assert.equal(result.status, 'needs-terminal');
  assert.equal(result.command, 'singularity-flow decisions record PAY-1');
  assert.match(result.message, /Touch ID is taken in your own terminal, so nothing was written here/u);
  assert.equal(seen.recorded.length, 0);
});

test('what comes back says what was decided, one to a decision, so no agent can report something else (bin-opr2)', async () => {
  const { ui } = person([accept({ choice: EACH }), accept({ decision0: 'Add to REQ-002', reason0: 'Its own reason, long enough.' }), accept({ confirm: RECORD })]);
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
  choice('scope-included', 'Included: named clauses carry it', { clause: { known: ['PAY-1:REQ-001'] }, reason: { default: '', minimum: 20, maximum: 1000 } }),
  choice('scope-excluded', 'Exclude it from this Story')] });
const checklist = { articles: [{ id: 'completeness', title: 'Completeness', question: 'Is every scenario covered?' }, { id: 'ambiguity', title: 'Ambiguity', question: 'Is it free of ambiguity?' }], decisions: ['satisfied', 'exception', 'not-applicable'] };
const reviewRow = { id: 'd9', kind: 'scope-completeness', title: 'Review the scope for completeness', why: 'Nothing waits on this review.', decidedBy: allowed, details: {}, options: [
  choice('reviewed', 'I reviewed it: record my answers', { article: checklist, reason: { default: '', minimum: 20, maximum: 1000 } })] };

test('a scope row asks for clauses, and an included statement with none goes back to the form', async () => {
  const list = packet({ items: [scopeRow('d1', 'It must export.'), scopeRow('d2', 'It must log.')] });
  assert.deepEqual(sharedAnswers(list).map((entry) => entry.id), ['scope-excluded'], 'naming clauses is each row\'s own');
  const [page] = rowForms(list.items);
  assert.ok(page.form.requestedSchema.properties.clause0, 'the clause field');
  assert.deepEqual(page.form.requestedSchema.required, ['decision0', 'decision1'], 'clauses are asked only of a choice that needs them');
  const fields = { decision0: 'Included: named clauses carry it', reason0: 'The first requirement carries it.', decision1: 'Exclude it from this Story', reason1: 'Logging is not part of this Story.' };
  assert.match(answersFromRows(page.items, fields).problem, /Name the clauses that carry/u);
  const { answers, problem } = answersFromRows(page.items, { ...fields, clause0: 'REQ-001', clause1: 'ignored' });
  assert.equal(problem, null);
  assert.deepEqual(answers.map((entry) => entry.clause), ['REQ-001', undefined], 'a disposition with no clauses never carries any');
  const { seen, ui } = person([accept({ choice: EACH }), accept({ ...fields, clause0: 'REQ-001' }), accept({ confirm: RECORD })], [list, { ...list, items: [] }]);
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
  const schema = page.form.requestedSchema;
  assert.deepEqual(schema.required, ['decision0'], 'nothing is answered for the person');
  assert.equal(schema.properties['article0-completeness'].title, 'Is every scenario covered?');
  const fields = { decision0: 'I reviewed it: record my answers', reason0: 'I looked at all of it, carefully.', 'article0-completeness': 'satisfied' };
  assert.match(answersFromRows(page.items, fields).problem, /Answer every article/u);
  assert.match(answersFromRows(page.items, { ...fields, 'article0-ambiguity': 'exception' }).problem, /needs its own reason/u);
  const person2 = person([accept({ ...fields, 'article0-ambiguity': 'exception', 'why0-ambiguity': 'Two words read two ways.' }), accept({ confirm: RECORD })], [list, { ...list, offered: [] }]);
  const result = await runCard(person2.ui);
  assert.deepEqual(person2.seen.recorded[0].document.article.d9, [{ article: 'completeness', decision: 'satisfied' }, { article: 'ambiguity', decision: 'exception', reason: 'Two words read two ways.' }]);
  assert.equal(result.status, 'recorded');
  assert.deepEqual(result.remaining, [], 'offered rows are not what remains');
});
