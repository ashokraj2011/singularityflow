/**
 * Chat messages during a step are requests only when they ask for a change [owner, 2026-11-18, Story HELLO-1]:
 * "I have done npm login" and a pasted terminal output were held as "two earlier requests that still need accounting by
 * the implementation author in /sf-code, in a new version only with your yes". A status note, an acknowledgement or what a
 * terminal printed is kept as a note: it never holds a step and never asks for a version. Words SFlow cannot tell are a
 * request still wait, and the person calls them "not a request" with one click on the Decide card.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { askedForGeneration, needsAccount, noteAskedFor, typedKind } from '../src/asked-for.mjs';
import { accountWords, INSTRUCTION_ACCOUNTS, instructionAccounting } from '../src/asked-for-records.mjs';

const NPM_LOGIN = 'I have done npm login';
const PASTED = ['npm notice Log in on https://registry.npmjs.org/', 'Login at:', 'https://www.npmjs.com/login?next=/login/cli/0f1e2d', 'Press ENTER to open in the browser...',
  'Logged in on https://registry.npmjs.org/.'].join('\n');

test('a status note and a pasted terminal output are notes; a change asked for is a request; anything else is unsure', () => {
  assert.equal(typedKind(NPM_LOGIN), 'note');
  assert.equal(typedKind(PASTED), 'note');
  for (const words of ['done', 'ok thanks', 'it is working now', 'npm ERR! code E401\nnpm ERR! Unable to authenticate', '$ npm test\n> jest\nPASS test/a.test.js']) {
    assert.equal(typedKind(words), 'note', words);
  }
  for (const words of ['add a logout button', 'please make the title bold', 'the button should be blue', 'Use port 8080 instead of 3000', 'I added the key, now make the test pass',
    'fix this:\nnpm ERR! code E401', 'we need to support dark mode', "don't use lodash"]) {
    assert.equal(typedKind(words), 'request', words);
  }
  for (const words of ['why does the login test fail?', 'can you check why it fails', 'the second login form']) assert.equal(typedKind(words), 'unsure', words);
  // A note waits for no account, after /sf-code or in a plain chat that changed the work.
  assert.equal(needsAccount({ text: NPM_LOGIN }), false);
  assert.equal(needsAccount({ text: PASTED, plainChat: true, changed: true }), false);
  assert.equal(needsAccount({ text: 'add a logout button' }), true);
  assert.equal(needsAccount({ text: 'why does the login test fail?' }), true);
  assert.deepEqual(INSTRUCTION_ACCOUNTS, ['within-plan', 'departure', 'question', 'note']);
  assert.equal(accountWords({ as: 'note', clauses: [], departure: null }), 'a note, not a request for a change: kept, nothing to account for');
  assert.equal(accountWords({ as: 'note', clauses: [], departure: null, answeredBy: { surface: 'decisions-card' } }),
    'the person said it was not a request: kept as a note, nothing to change');
});

test('the incident: the two messages are kept as notes and hold nothing; only a request or an unsure one waits', () => {
  const workflow = { workItem: { id: 'HELLO-1' }, askedFor: [NPM_LOGIN, PASTED, 'why does the login test fail?', 'add a logout button']
    .map((text, at) => ({ phase: 'implementation', generation: 1, instruction: at + 1, text, turn: `turn-${at}` })) };
  assert.deepEqual(instructionAccounting(workflow, 'implementation').map((entry) => [entry.instruction, entry.account?.as ?? null]),
    [[1, 'note'], [2, 'note'], [3, null], [4, null]]);
});

/** A code step in progress whose author published nothing yet, as question-account.test.mjs builds it. */
async function codeStep(t) {
  const { repository, startQuickFix } = await import('./helpers/run-and-test-fixture.mjs');
  const repo = await repository(t, { implementCommands: false });
  const configPath = path.join(repo.root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.phases.implement.approval = { mode: 'required', authorities: ['engineering-reviewers'], minimum: 1, rejectTo: ['intake'] };
  config.phases.implement.generation = { requirement: 'required', task: 'code' };
  await writeFile(configPath, YAML.stringify(config));
  repo.must('git', ['add', 'singularity/workflow.yml']);
  repo.must('git', ['commit', '-m', 'An agent-authored code step with a human review in this fixture']);
  await startQuickFix(repo);
  repo.sflow('prepare', 'implement');
  await writeFile(path.join(repo.root, 'src/value.mjs'), '// @clause:QF-1:AC-001 return the approved value\nexport const value = 2;\n');
  repo.sflow('prepare', 'implement');
  const state = async () => JSON.parse(await readFile(path.join(repo.root, 'singularity/work-items/QF-1/workflow.json'), 'utf8'));
  const typed = async (text, turnId) => {
    const phase = (await state()).phases.implement;
    await noteAskedFor(path.join(repo.root, '.git'), { workId: 'QF-1', phase: 'implement', generation: askedForGeneration(phase), text, skill: 'sf-code', turnId,
      at: new Date().toISOString() });
  };
  return { repo, state, typed };
}

test('in a real Story: the notes are kept and hold nothing, and "That was not a request" on the list records the unsure one as a note', { timeout: 300_000 }, async (t) => {
  const { repo, state, typed } = await codeStep(t);
  await typed(NPM_LOGIN, 'turn-a');
  await typed(PASTED, 'turn-b');
  await typed('why does the login test fail?', 'turn-c');
  const checked = repo.sflowJson('phase', 'prepublish', 'implement', '--for-agent');
  assert.equal(checked.status, 0, JSON.stringify(checked.value).slice(0, 2000));
  assert.deepEqual(checked.value.askedFor.unaccounted, [3], 'only the question waits');
  assert.deepEqual(checked.value.askedFor.instructions.map((entry) => [entry.instruction, entry.account?.as ?? null]), [[1, 'note'], [2, 'note'], [3, null]]);
  assert.deepEqual((await state()).askedFor.map((entry) => entry.text), [NPM_LOGIN, PASTED, 'why does the login test fail?'], 'every word is kept');

  const packet = (({ value }) => value.data ?? value)(repo.sflowJson('decisions', 'QF-1'));
  const asked = packet.items.filter((entry) => entry.kind === 'asked-for');
  assert.equal(asked.length, 1, JSON.stringify(packet.items.map((entry) => entry.title)));
  const [item] = asked;
  assert.equal(item.title, 'Asked for (3) "why does the login test fail?": not handled yet');
  assert.equal(item.plain.question, 'Was "why does the login test fail?" a request for a change?');
  const note = item.options.find((entry) => entry.id === 'not-a-request');
  assert.deepEqual({ label: note.label, allowed: note.decidedBy.allowed, recordable: note.recordable !== false },
    { label: 'That was not a request', allowed: true, recordable: true }, 'one click, for anyone working on the Story');

  const recorded = repo.sflowJson('decisions', 'record', 'QF-1', '--choose', `${item.id}=not-a-request`, '--confirm', packet.packetSha256);
  assert.equal(recorded.status, 0, JSON.stringify(recorded.value).slice(0, 2000));
  const record = await state();
  assert.deepEqual(record.instructionAccounts.map((entry) => [entry.instruction, entry.as, entry.author.producer, entry.answeredBy.surface]), [[3, 'note', 'person', 'terminal']]);
  const after = (({ value }) => value.data ?? value)(repo.sflowJson('decisions', 'QF-1'));
  assert.deepEqual(after.items.filter((entry) => entry.kind === 'asked-for'), [], 'nothing typed holds the step');
});
