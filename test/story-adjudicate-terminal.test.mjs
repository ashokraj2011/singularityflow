/**
 * The decisions table for a host with no card: the same forms and words as the cards, asked one field at
 * a time in a person's own terminal. Nothing is chosen for them, input ending records nothing, and with no
 * terminal it asks nothing and names the command. test/spk-e2e.test.mjs walks a real Story through it.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { adjudicationTableCommand, runAdjudicationTable, terminalForms } from '../src/commands/story-adjudicate-terminal.mjs';
import { adjudicationTableStep } from '../src/command-skills.mjs';
import { confirmForm, firstForm, KEEP, LEAVE, OVERRULE, rowForms, settledRows } from '../plugin/extensions/decisions/decisions.mjs';
import { hasRealTerminal, openRealTerminal } from './helpers/real-terminal.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const item = (id, fields = {}) => ({ id, kind: 'unclaimed-changed-path', paths: [`src/${id}.js`], clauseIds: [], detail: null, plan: null, acceptAll: true, decision: null, ...fields });
const list = (fields = {}) => ({ status: 'open', workId: 'PAY-1', phase: 'convergence', open: 2, digest: 'sha256:abc', items: [item('CF-1'), item('CF-2')], settled: [],
  decidedBy: { groups: ['leads'], labels: ['Leads'], allowed: true, words: 'You may decide these (Leads).' },
  dispositions: [{ id: 'accepted-deviation', label: 'Accept as is' }, { id: 'rework', label: 'Send back to fix' }, { id: 'update-intent', label: 'The spec should change' }], ...fields });

function typing(lines) {
  const said = [];
  return { said, ask: terminalForms({ next: async () => (lines.length ? lines.shift() : null), write: (text) => said.push(text), clausesAnswer: () => 'The spec should change' }) };
}

test('a form is asked field by field in the cards\' own words, and only what the answers need', async () => {
  const each = typing(['2']);
  assert.deepEqual(await each.ask(firstForm(list()).form), { action: 'accept', content: { choice: 'Decide each one' } }, 'no reason is asked of a row-by-row answer');
  assert.match(each.said.join(''), /How do you want to decide\?\n {2}1\) Accept all 2 changed files with one reason\n {2}2\) Decide each one\n {2}3\) Not now\nChoose 1-3: /u);
  const all = typing(['1', 'All of it is test setup.']);
  assert.deepEqual((await all.ask(firstForm(list()).form)).content.reason, 'All of it is test setup.');
  const rows = rowForms(list(), list().items)[0].form;
  const answered = typing(['1', '4', 'The spec is wrong here.', 'SP-1:REQ-001']);
  const { content } = await answered.ask(rows);
  assert.deepEqual(content, { decision0: LEAVE, decision1: 'The spec should change', reason1: 'The spec is wrong here.', clauses1: 'SP-1:REQ-001' }, 'a row left undecided asks nothing more');
  const noClauses = typing(['2', 'Fine as it is, it is test setup.', '1']);
  assert.deepEqual((await noClauses.ask(rows)).content, { decision0: 'Accept as is', reason0: 'Fine as it is, it is test setup.', decision1: LEAVE }, 'clauses are only for a spec change');
  assert.equal(confirmForm(list(), [{ itemId: 'CF-1', disposition: 'rework', reason: '', clauseIds: [] }]).requestedSchema.properties.confirm.enum[0], 'Record these decisions');
});

test('overruling a settled row is asked the same way, and keeping the plan asks nothing more', async () => {
  const settled = list({ settled: [{ id: 'CF-9', paths: ['package.json'], clauseIds: [], settledBy: { kind: 'supporting', text: 'The test script.' }, decision: null }] });
  assert.deepEqual((await typing(['3']).ask(firstForm(settled).form)).content, { choice: OVERRULE }, 'no reason is asked of it');
  const form = rowForms(settled, settledRows(settled))[0].form;
  assert.deepEqual((await typing(['1']).ask(form)).content, { decision0: KEEP });
  assert.deepEqual((await typing(['3', 'It should not have changed.']).ask(form)).content, { decision0: 'Send back to fix', reason0: 'It should not have changed.' });
});

test('nothing is chosen for the person: Enter asks again, a wrong number asks again, and input ending is a cancel', async () => {
  const again = typing(['', '9', 'x', '2']);
  assert.equal((await again.ask(firstForm(list()).form)).content.choice, 'Decide each one');
  assert.equal(again.said.filter((text) => /Type a number from 1 to 3/u.test(text)).length, 3);
  assert.deepEqual(await typing([]).ask(firstForm(list()).form), { action: 'cancel' });
  assert.deepEqual(await typing(['1']).ask(firstForm(list()).form), { action: 'cancel' }, 'input ending at the reason');
});

test('with no terminal it asks nothing, reads nothing and names the exact command', async () => {
  const stopped = { read: async () => { throw new Error('it read the list'); }, record: async () => { throw new Error('it recorded'); } };
  for (const options of [{}, { json: true }]) {
    await assert.rejects(runAdjudicationTable({ workId: 'PAY-1', ...stopped, ...options, output: { isTTY: false, write() {} } }), (error) => {
      assert.equal(error.code, 'ADJUDICATION_TERMINAL_REQUIRED');
      assert.match(error.message, /Nothing was asked or recorded\. Run it there: singularity-flow story adjudicate --work-id PAY-1$/u);
      assert.equal(error.details.nextAction.command, adjudicationTableCommand('PAY-1'));
      return true;
    });
  }
});

test('only the whole-table form is the person\'s: naming an item stays as it was', () => {
  assert.equal(adjudicationTableStep(['story', 'adjudicate'], {}), true);
  assert.equal(adjudicationTableStep(['story', 'adjudicate'], { 'work-id': 'PAY-1' }), true);
  assert.equal(adjudicationTableStep(['story', 'adjudicate', 'CF-1'], { disposition: 'rework' }), false);
  assert.equal(adjudicationTableStep(['story', 'adjudicate'], { answers: '/tmp/a.json', expect: 'sha256:abc' }), false, 'that is its own refused step');
  assert.equal(adjudicationTableStep(['story', 'adjudicate'], { disposition: 'rework' }), false, 'that keeps its own usage refusal');
  assert.equal(adjudicationTableStep(['story', 'adjudications'], {}), false);
});

const FAKE_TABLE = `
import { runAdjudicationTable } from ${JSON.stringify(path.join(ROOT, 'src/commands/story-adjudicate-terminal.mjs'))};
const list = ${JSON.stringify(list())};
const result = await runAdjudicationTable({ workId: 'PAY-1', read: async () => list, record: async (read, answers) => {
  console.log('RECORD', read.digest, JSON.stringify(answers)); return { recorded: answers.map((answer) => answer.itemId), unchanged: [], remaining: [], next: 'All decided.' }; } });
console.log('RESULT', result.status);
`;
const fakeTable = (options = {}) => openRealTerminal(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', FAKE_TABLE], { cwd: ROOT, ...options });

test('in a real terminal: one reason for all, then the exact list, then the one write', { skip: !hasRealTerminal }, async () => {
  const term = fakeTable();
  await term.waitFor(/How do you want to decide\?[\s\S]*Choose 1-3: $/u);
  assert.match(term.screen, /\| src\/CF-1\.js \| Not in the plan \| Undecided \|/u);
  assert.doesNotMatch(term.screen, /\*\*/u, 'plain words in a terminal');
  term.type(term.number('Accept all'));
  await term.waitFor(/Reason for accepting all: $/u);
  term.type('All of it is test setup.');
  await term.waitFor(/Record 2 decisions on PAY-1, each under your name:\nsrc\/CF-1\.js: Accept as is\. Reason: All of it is test setup\.\nsrc\/CF-2\.js: Accept as is\. Reason: All of it is test setup\.[\s\S]*Choose 1-2: $/u);
  assert.doesNotMatch(term.screen, /RECORD/u, 'nothing is written before the person confirms');
  term.type(term.number('Record these decisions'));
  assert.equal(await term.finished, 0);
  assert.match(term.screen, /RECORD sha256:abc \[\{"itemId":"CF-1","disposition":"accepted-deviation","reason":"All of it is test setup\.","clauseIds":\[\]\},\{"itemId":"CF-2",/u);
  assert.match(term.screen, /2 recorded\. .*All decided\./su);
});

test('in a real terminal: Not now, a cancelled confirmation and input ending all record nothing', { skip: !hasRealTerminal }, async () => {
  const notNow = fakeTable();
  await notNow.waitFor(/Choose 1-3: $/u);
  notNow.type(notNow.number('Not now'));
  assert.equal(await notNow.finished, 0);
  assert.match(notNow.screen, /No decision was recorded\./u);
  const noConfirm = fakeTable();
  await noConfirm.waitFor(/Choose 1-3: $/u);
  noConfirm.type(noConfirm.number('Accept all'));
  await noConfirm.waitFor(/Reason for accepting all: $/u);
  noConfirm.type('All of it is test setup.');
  await noConfirm.waitFor(/Choose 1-2: $/u);
  noConfirm.type(noConfirm.number('Not now'));
  assert.equal(await noConfirm.finished, 0);
  assert.doesNotMatch(noConfirm.screen, /RECORD/u);
  const ended = fakeTable();
  await ended.waitFor(/Choose 1-3: $/u);
  ended.endInput();
  assert.equal(await ended.finished, 0);
  assert.match(ended.screen, /No decision was recorded\./u);
  assert.doesNotMatch(ended.screen, /RECORD/u);
});

test('in a real terminal an agent started: it asks nothing', { skip: !hasRealTerminal }, async () => {
  for (const marker of ['COPILOT_CLI', 'AI_AGENT']) {
    const term = fakeTable({ env: { ...process.env, [marker]: '1' }, keepAgentMarkers: true });
    await term.finished;
    assert.match(term.screen, /an agent started this command/u, marker);
    assert.doesNotMatch(term.screen, /How do you want to decide/u, marker);
  }
});
