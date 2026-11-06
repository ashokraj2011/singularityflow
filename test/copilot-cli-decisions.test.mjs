/**
 * The convergence decisions as Copilot CLI forms. Only `ask` can answer, Accept all reaches only changed
 * files, each answer keeps its own reason, and nothing is written until the person confirms the exact list.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptable, choicesFromRows, confirmForm, decisionRows, decisionsTable, detailForm, firstForm, KEEP, LEAVE, OVERRULE, RECORD, rowForms, runDecisions, settledRows, valuesFromForm
} from '../plugin/extensions/decisions/decisions.mjs';

const item = (id, fields = {}) => ({ id, kind: 'unclaimed-changed-path', paths: [`src/${id}.js`], clauseIds: [], detail: null, plan: null, acceptAll: true, decision: null, ...fields });
const list = (fields = {}) => ({
  status: 'open', workId: 'PAY-1', phase: 'convergence', open: 3, digest: 'sha256:abc',
  items: [item('CF-1'), item('CF-2', { plan: { kind: 'supporting', text: 'Test | setup.' } }),
    item('CF-3', { kind: 'absent-observed-claim', acceptAll: false, paths: [], detail: 'No test proves REQ-001.', clauseIds: ['PAY-1:REQ-001'] })],
  decidedBy: { groups: ['leads'], labels: ['Leads'], allowed: true, words: 'You may decide these (Leads).' },
  dispositions: [{ id: 'accepted-deviation', label: 'Accept as is' }, { id: 'rework', label: 'Send back to fix' }, { id: 'update-intent', label: 'The spec should change' }, { id: 'deferred', label: 'Decide later' }],
  ...fields
});

/** A person who answers from a list, and everything the run showed and wrote. */
function person(replies, listed = list()) {
  const seen = { asked: [], shown: [], recorded: [] };
  return { seen, ui: {
    read: async () => listed,
    show: async (text) => { seen.shown.push(text); },
    ask: async (form) => { seen.asked.push(form); return replies.shift() ?? { action: 'cancel' }; },
    record: async (read, answers) => { seen.recorded.push({ digest: read.digest, answers }); return { recorded: answers.map((a) => a.itemId), unchanged: [], remaining: ['CF-9'], next: 'Some items still need a decision.' }; }
  } };
}
const accept = (content) => ({ action: 'accept', content });

test('the table says what changed and what the plan says, and a pipe cannot break it', () => {
  const table = decisionsTable(list());
  assert.match(table, /\| src\/CF-1\.js \| Not in the plan \| Undecided \|/u);
  assert.match(table, /Supporting file: Test \\\| setup\./u);
  assert.match(table, /3 of 3 still need a decision/u);
});

test('Accept all counts only open changed files', () => {
  assert.deepEqual(acceptable(list()).map((entry) => entry.id), ['CF-1', 'CF-2']);
  assert.match(firstForm(list()).yes, /Accept all 2 changed files/u);
  const none = list({ items: [item('CF-3', { acceptAll: false })] });
  assert.deepEqual(firstForm(none).form.requestedSchema.properties.choice.enum, ['Decide each one', 'Not now']);
});

test('accept all, then the row it cannot reach gets its own answer and reason', async () => {
  const { yes } = firstForm(list());
  const { seen, ui } = person([accept({ choice: yes }), accept({ reason: 'Test support.' }),
    accept({ decision0: 'Decide later' }), accept({ reason: 'After the next build.' }), accept({ confirm: RECORD })]);
  const result = await runDecisions(ui);
  assert.equal(result.status, 'recorded');
  assert.deepEqual(seen.recorded, [{ digest: 'sha256:abc', answers: [
    { itemId: 'CF-1', disposition: 'accepted-deviation', reason: 'Test support.', clauseIds: [] },
    { itemId: 'CF-2', disposition: 'accepted-deviation', reason: 'Test support.', clauseIds: [] },
    { itemId: 'CF-3', disposition: 'deferred', reason: 'After the next build.', clauseIds: [] }] }]);
  assert.match(result.message, /3 recorded\. 1 still need/u);
  assert.match(seen.asked.at(-1).message, /src\/CF-1\.js: Accept as is\. Reason: Test support\./u);
});

test('nothing is written unless the person confirms the exact list', async () => {
  const { yes } = firstForm(list());
  for (const last of [accept({ confirm: 'Not now' }), { action: 'decline' }, { action: 'cancel' }]) {
    const { seen, ui } = person([accept({ choice: yes }), accept({ reason: 'Test support.' }), accept({ decision0: LEAVE }), last]);
    assert.equal((await runDecisions(ui)).status, 'cancelled');
    assert.deepEqual(seen.recorded, []);
  }
  for (const first of [accept({ choice: 'Not now' }), { action: 'cancel' }]) {
    const { seen, ui } = person([first]);
    assert.equal((await runDecisions(ui)).status, 'cancelled');
    assert.deepEqual(seen.recorded, []);
  }
});

test('a form that is wrong is asked again with the problem on top, keeps what was typed, and loses nothing already answered', async () => {
  const { yes } = firstForm(list());
  const { seen, ui } = person([accept({ choice: yes }), accept({ reason: '  ' }), accept({ reason: 'Test support.' }),
    accept({ decision0: 'Accept as is' }), accept({ reason: '' }), accept({ reason: 'It is fine.' }), accept({ confirm: RECORD })]);
  assert.equal((await runDecisions(ui)).status, 'recorded');
  assert.match(seen.asked[2].message, /^Give one reason for accepting them all/u);
  assert.match(seen.asked[5].message, /^Give a reason for PAY-1:REQ-001/u);
  assert.equal(seen.shown.filter((text) => /Give /u.test(text)).length, 0, 'never a notification beside the form');
  assert.equal(seen.recorded[0].answers.length, 3);
});

test('a real choice asks only what it needs, its rule in the title, and three refusals stop with nothing recorded', async () => {
  const rows = [item('CF-1')];
  const [{ form }] = rowForms(list(), rows);
  assert.deepEqual(Object.keys(form.requestedSchema.properties), ['decision0'], 'the choice comes first');
  assert.deepEqual(Object.keys(detailForm(list(), rows[0], 'accepted-deviation').requestedSchema.properties), ['reason']);
  assert.deepEqual(Object.keys(detailForm(list(), rows[0], 'update-intent').requestedSchema.properties), ['reason', 'clauses'], 'clauses only for a spec change');
  assert.equal(detailForm(list(), rows[0], 'rework'), null, 'rework needs no reason, as the CLI rule says');
  const reason = detailForm(list(), rows[0], 'accepted-deviation').requestedSchema.properties.reason;
  assert.equal(reason.title, 'Reason for src/CF-1.js (1 to 1000 characters)');
  assert.equal(reason.minLength, 1);
  const { seen, ui } = person([accept({ choice: 'Decide each one' }), accept({ decision0: 'Accept as is' }), accept({ reason: '' }), accept({ reason: ' ' }), accept({ reason: '' }), accept({ confirm: RECORD })]);
  const result = await runDecisions(ui);
  assert.equal(result.status, 'refused');
  assert.match(result.message, /^Nothing was recorded\. After 3 tries the form still could not take this: Give a reason for src\/CF-1\.js\./u);
  assert.deepEqual(seen.recorded, []);
});

test('each row needs what it would record', () => {
  const rows = [item('CF-1')];
  const picks = (content) => choicesFromRows(list(), rows, content);
  assert.deepEqual(picks({ decision0: LEAVE }), { picks: [], problem: null });
  assert.match(picks({ decision0: 'Dismiss everything' }).problem, /not a decision/u);
  assert.match(valuesFromForm(rows[0], 'update-intent', { reason: 'Wrong.' }).problem, /Name the clauses/u);
  assert.deepEqual(valuesFromForm(rows[0], 'update-intent', { reason: 'Wrong.', clauses: 'PAY-1:REQ-1, PAY-1:REQ-2' }).clauseIds, ['PAY-1:REQ-1', 'PAY-1:REQ-2']);
  assert.equal(valuesFromForm(rows[0], 'rework', {}).problem, null, 'rework needs no reason, as the CLI rule says');
  assert.match(valuesFromForm(rows[0], 'accepted-deviation', {}).problem, /Give a reason/u);
});

test('long lists come in forms a person can get through', () => {
  const many = Array.from({ length: 12 }, (_, at) => item(`CF-${at}`));
  const forms = rowForms(list({ items: many }), many);
  assert.deepEqual(forms.map((form) => form.items.length), [5, 5, 2]);
  assert.match(forms[2].form.message, /3 of 3/u);
  for (const form of forms) assert.deepEqual(form.form.requestedSchema.properties.decision0.enum[0], LEAVE, 'the first answer leaves the row open');
});

test('someone outside the group sees the table and is asked nothing', async () => {
  const { seen, ui } = person([], list({ decidedBy: { groups: ['leads'], labels: ['Leads'], allowed: false, words: 'The Leads decide these.' } }));
  const result = await runDecisions(ui);
  assert.equal(result.status, 'not-allowed');
  assert.deepEqual(seen.asked, []);
  assert.deepEqual(seen.recorded, []);
  assert.match(seen.shown[0], /The Leads decide these\./u);
});

test('a list that is not open says why and asks nothing', async () => {
  const { seen, ui } = person([], { status: 'not-open', message: 'There is nothing to adjudicate.', items: [] });
  assert.deepEqual(await runDecisions(ui), { status: 'not-open', message: 'There is nothing to adjudicate.' });
  assert.deepEqual(seen.asked, []);
});

test('the confirmation names what stays undecided', () => {
  const form = confirmForm(list(), [{ itemId: 'CF-1', disposition: 'rework', reason: '', clauseIds: [] }]);
  assert.match(form.message, /Record 1 decision on PAY-1/u);
  assert.match(form.message, /Still undecided: src\/CF-2\.js, PAY-1:REQ-001/u);
});

test('test setup files are one row in the table and one form field, whose answer covers each by name', async () => {
  const setup = (id, file) => item(id, { paths: [file], group: 'test-setup' });
  const grouped = list({ items: [setup('CF-1', 'package-lock.json'), setup('CF-2', 'playwright.config.js'), item('CF-3', { kind: 'absent-observed-claim', acceptAll: false, paths: [], detail: 'No test proves REQ-001.' })],
    groupWords: { 'test-setup': 'These changed together for how tests run: one change, so one decision.' } });
  assert.equal(decisionRows(grouped).length, 2);
  assert.match(decisionsTable(grouped), /Test setup: package-lock\.json, playwright\.config\.js \| These changed together/u);
  const rows = decisionRows(grouped);
  const [page] = rowForms(grouped, rows);
  assert.match(page.form.requestedSchema.properties.decision0.title, /^Test setup: package-lock\.json, playwright\.config\.js: one change, one decision/u);
  const accepted = grouped.dispositions.find((entry) => entry.id === 'accepted-deviation').label;
  const { seen, ui } = person([accept({ choice: 'Decide each one' }), accept({ decision0: accepted, decision1: LEAVE }), accept({ reason: 'The browser runner needs these.' }), accept({ confirm: RECORD })], grouped);
  assert.equal((await runDecisions(ui)).status, 'recorded');
  assert.deepEqual(seen.recorded[0].answers.map((answer) => [answer.itemId, answer.disposition]), [['CF-1', 'accepted-deviation'], ['CF-2', 'accepted-deviation']]);
});

const settledFile = { id: 'CF-9', paths: ['package.json'], clauseIds: [], settledBy: { kind: 'supporting', text: 'The test script.' }, decision: null };

test('a row the plan settled can be overruled, with the same answer as any row, and no chat is ever stopped for it', async () => {
  const none = list({ items: [], open: 0, settled: [settledFile] });
  const inChat = person([], none);
  assert.equal((await runDecisions({ ...inChat.ui, askedInChat: true })).status, 'nothing-open', 'a chat that asked carries on');
  assert.deepEqual(inChat.seen.asked, []);
  const { seen, ui } = person([{ action: 'accept', content: { choice: OVERRULE } },
    { action: 'accept', content: { decision0: 'Accept as is' } }, { action: 'accept', content: { reason: 'This test script should not have changed.' } }, { action: 'accept', content: { confirm: RECORD } }], none);
  const result = await runDecisions(ui);
  assert.deepEqual(seen.asked[0].requestedSchema.properties.choice.enum, [OVERRULE, 'Not now'], 'nothing open offers nothing to decide');
  assert.deepEqual(seen.asked[1].requestedSchema.properties.decision0.enum.slice(0, 2), [KEEP, 'Accept as is'], 'keeping the plan is the first answer, never a chosen one');
  assert.deepEqual(seen.recorded[0].answers, [{ itemId: 'CF-9', disposition: 'accepted-deviation', reason: 'This test script should not have changed.', clauseIds: [] }]);
  assert.match(seen.asked[3].message, /package\.json: Accept as is\. Reason: This test script/u);
  assert.equal(result.status, 'recorded');
});

test('overruling sits beside what is open: the rows left are still asked, and keeping the plan records nothing for it', async () => {
  const open = list({ settled: [settledFile] });
  assert.ok(firstForm(open).form.requestedSchema.properties.choice.enum.includes(OVERRULE));
  assert.equal(firstForm(list()).form.requestedSchema.properties.choice.enum.includes(OVERRULE), false, 'with nothing settled it is not offered');
  const pages = rowForms(open, [...settledRows(open), ...open.items]);
  assert.match(pages[0].form.requestedSchema.properties.decision0.title, /package\.json: Supporting file: The test script\./u);
  const { picks, problem } = choicesFromRows(open, pages[0].items, { decision0: KEEP, decision1: 'Accept as is', decision2: LEAVE, decision3: LEAVE });
  assert.equal(problem, null);
  assert.deepEqual(picks.map(({ item, disposition }) => [item.id, disposition]), [['CF-1', 'accepted-deviation']]);
  assert.equal(confirmForm(open, [{ itemId: 'CF-9', disposition: 'rework', reason: '', clauseIds: [] }]).message.includes('package.json: Send back to fix'), true);
});
