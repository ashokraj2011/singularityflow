/**
 * The convergence decisions as Copilot CLI forms. Only `ask` can answer, Accept all reaches only changed
 * files, each answer keeps its own reason, and nothing is written until the person confirms the exact list.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptable, answersFromRows, confirmForm, decisionsTable, firstForm, LEAVE, RECORD, rowForms, runDecisions
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
  const { seen, ui } = person([accept({ choice: yes, reason: 'Test support.' }),
    accept({ decision0: 'Decide later', reason0: 'After the next build.' }), accept({ confirm: RECORD })]);
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
    const { seen, ui } = person([accept({ choice: yes, reason: 'Test support.' }), accept({ decision0: LEAVE }), last]);
    assert.equal((await runDecisions(ui)).status, 'cancelled');
    assert.deepEqual(seen.recorded, []);
  }
  for (const first of [accept({ choice: 'Not now' }), { action: 'cancel' }]) {
    const { seen, ui } = person([first]);
    assert.equal((await runDecisions(ui)).status, 'cancelled');
    assert.deepEqual(seen.recorded, []);
  }
});

test('a form that is wrong is asked again and loses nothing already answered', async () => {
  const { yes } = firstForm(list());
  const { seen, ui } = person([accept({ choice: yes, reason: '  ' }), accept({ choice: yes, reason: 'Test support.' }),
    accept({ decision0: 'Accept as is' }), accept({ decision0: 'Accept as is', reason0: 'It is fine.' }), accept({ confirm: RECORD })]);
  assert.equal((await runDecisions(ui)).status, 'recorded');
  assert.ok(seen.shown.some((text) => /Give one reason for accepting them all/u.test(text)));
  assert.ok(seen.shown.some((text) => /Give a reason for PAY-1:REQ-001/u.test(text)));
  assert.equal(seen.recorded[0].answers.length, 3);
});

test('each row needs what it would record', () => {
  const rows = [item('CF-1')];
  const answer = (content) => answersFromRows(list(), rows, content);
  assert.deepEqual(answer({ decision0: LEAVE }), { answers: [], problem: null });
  assert.match(answer({ decision0: LEAVE, reason0: 'A reason.' }).problem, /Choose a decision for src\/CF-1\.js/u);
  assert.match(answer({ decision0: 'The spec should change', reason0: 'Wrong.' }).problem, /Name the clauses/u);
  assert.deepEqual(answer({ decision0: 'The spec should change', reason0: 'Wrong.', clauses0: 'PAY-1:REQ-1, PAY-1:REQ-2' }).answers[0].clauseIds, ['PAY-1:REQ-1', 'PAY-1:REQ-2']);
  assert.equal(answer({ decision0: 'Send back to fix' }).problem, null, 'rework needs no reason, as the CLI rule says');
  assert.match(answer({ decision0: 'Dismiss everything', reason0: 'x' }).problem, /not a decision/u);
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
