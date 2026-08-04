import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeClarificationPolicy,
  renderClarificationProtocol
} from '../src/clarifications.mjs';

test('phase clarification policies are configurable and bounded', () => {
  assert.deepEqual(normalizeClarificationPolicy(), { mode: 'off', maxQuestions: 5, topics: [] });
  assert.deepEqual(normalizeClarificationPolicy('required'), { mode: 'required', maxQuestions: 5, topics: [] });
  assert.deepEqual(normalizeClarificationPolicy({
    mode: 'when-needed', maxQuestions: 3, topics: ['scope', 'risk']
  }), { mode: 'when-needed', maxQuestions: 3, topics: ['scope', 'risk'] });
  assert.throws(() => normalizeClarificationPolicy({ mode: 'always' }), /off, when-needed, or required/);
  assert.throws(() => normalizeClarificationPolicy({ maxQuestions: 11 }), /1 through 10/);
  assert.throws(() => normalizeClarificationPolicy({ topics: ['scope', 'scope'] }), /must not contain duplicates/);
  assert.throws(() => normalizeClarificationPolicy({ hidden: true }), /unknown field 'hidden'/);
});

test('required clarification produces an explicit interactive stop before authoring', () => {
  const rendered = renderClarificationProtocol({
    mode: 'required', maxQuestions: 4, topics: ['scope', 'acceptance criteria']
  }, 'requirements');
  assert.match(rendered, /Human clarification checkpoint/);
  assert.match(rendered, /requirements.*required/);
  assert.match(rendered, /Pause for at least one human response/);
  assert.match(rendered, /no more than 4 questions/);
  assert.match(rendered, /interactive `ask_user` tool/);
  assert.match(rendered, /Do not author or publish/);
  assert.match(rendered, /scope, acceptance criteria/);
});

test('off clarification adds no prompt instructions and when-needed may explicitly continue', () => {
  assert.equal(renderClarificationProtocol({ mode: 'off' }, 'implementation'), '');
  const rendered = renderClarificationProtocol({ mode: 'when-needed' }, 'design');
  assert.match(rendered, /Ask only when a material ambiguity remains/);
  assert.match(rendered, /found no material ambiguity and continue/);
});
