/**
 * Daily run 2026-11-17: asked "Start version 2 of Implement?" with a form whose one field was a true/false box, the person
 * ticked it and Copilot CLI handed over "User responded: true". The guard read no yes in that, refused the confirmation with
 * PHASE_MUTATION_ANSWER_UNBOUND, and the person was asked the same question again. Its refusal also ended
 * "which asks them.. No current verified mutation contract.". A form's true or false is a yes or a no, and a whole refusal
 * reads as one.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { noteQuestionAnswered, repliesOfQuestion, sideOf, startAnswerLedger, unboundAnswerReason } from '../src/copilot-answer-binding.mjs';
import { mutationDenial } from '../src/phase-mutation-contract.mjs';

const QUESTION = 'Start version 2 of Implement? Published version 1 and its recorded tests will stay unchanged.';
const ROLLOVER = { positionals: ['phase', 'rollover', 'implement'], options: { confirm: `sha256:${'a'.repeat(64)}` } };
const rows = { yes: [], no: [] };

test('a form\'s true or false is a yes or a no, as a boolean or as the word the host hands over', () => {
  for (const value of [true, 'true', 'true.', 'yes']) assert.equal(sideOf({ texts: [value] }, rows), 'yes', String(value));
  for (const value of [false, 'false', 'false,', 'no']) assert.equal(sideOf({ texts: [value] }, rows), 'no', String(value));
  // Words that only start like them are no answer.
  for (const value of ['trueish', 'falsetto', 'it is true that I am unsure']) assert.equal(sideOf({ texts: [value] }, rows), null, value);
  assert.equal(sideOf({ texts: ['not now'] }, rows), 'not-now');
});

test('a true/false form field asked with the version question reaches the guard as the person\'s answer, on every result shape', () => {
  const schema = { message: QUESTION, requestedSchema: { properties: { confirm: { type: 'boolean', title: 'Start version 2?', default: true } } } };
  for (const [shape, textResultForLlm] of [['Copilot CLI line', 'User responded: true'], ['a form line', 'User responded: confirm=true'],
    ['a JSON object', JSON.stringify({ confirm: true })]]) {
    const [reply] = repliesOfQuestion({ toolName: 'ask_user', toolArgs: schema, toolResult: { resultType: 'success', textResultForLlm } });
    assert.match(reply.asked, /^start version 2 of implement\?/u, shape);
    assert.equal(sideOf(reply, rows), 'yes', `${shape}: ${JSON.stringify(reply.texts)}`);
  }
  const [declined] = repliesOfQuestion({ toolName: 'ask_user', toolArgs: schema, toolResult: { resultType: 'success', textResultForLlm: 'User responded: false' } });
  assert.equal(sideOf(declined, rows), 'no');
});

test('the version\'s confirmation is bound to a ticked box and refused on an unticked one, with no question asked twice', async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'sflow-answer-booleans-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const ask = (turnId, answer) => ({ toolName: 'ask_user', toolArgs: { message: QUESTION, requestedSchema: { properties: { confirm: { type: 'boolean' } } } },
    toolResult: { resultType: 'success', textResultForLlm: `User responded: ${answer}` }, turnId });
  for (const [answer, bound] of [['true', true], ['false', false]]) {
    const file = path.join(folder, `${answer}.mutation.json`);
    const record = { turnId: `turn-${answer}` };
    await startAnswerLedger(file, record, '');
    await noteQuestionAnswered(file, record, ask(record.turnId, answer));
    const reason = await unboundAnswerReason(file, record, ROLLOVER.options, { positionals: ROLLOVER.positionals, version: 2 });
    if (bound) assert.equal(reason, null, 'a ticked box is the person\'s yes to version 2');
    else assert.match(reason, /The person did not say yes to starting the next version: start nothing/u);
  }
});

test('a refusal that ends its own sentence gets no second period, and a whole one no contract line', () => {
  const whole = mutationDenial(null, 'PHASE_MUTATION_ANSWER_UNBOUND: nothing was recorded. In their own terminal singularity-flow phase rollover implement, which asks them.', [],
    { routes: [], alone: true });
  assert.equal(whole.permissionDecisionReason, 'PHASE_MUTATION_ANSWER_UNBOUND: nothing was recorded. In their own terminal singularity-flow phase rollover implement, which asks them.');
  const summed = mutationDenial({ summary: 'No direct edits.', next: [] }, 'PHASE_MUTATION_TOOL_PROTOCOL: use the file tools.', [], { routes: [] });
  assert.equal(summed.permissionDecisionReason, 'PHASE_MUTATION_TOOL_PROTOCOL: use the file tools. No direct edits.');
  assert.doesNotMatch(summed.permissionDecisionReason + whole.permissionDecisionReason, /\.\.|No current verified mutation contract/u);
  // A refusal with no contract at all still says so, once.
  assert.equal(mutationDenial(null, 'PHASE_MUTATION_CONTRACT_REQUIRED: refresh the exact binding', [], { routes: [] }).permissionDecisionReason,
    'PHASE_MUTATION_CONTRACT_REQUIRED: refresh the exact binding. No current verified mutation contract.');
});
