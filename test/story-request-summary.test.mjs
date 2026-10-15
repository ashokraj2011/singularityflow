/**
 * The Story request leads what an agent reads: one bounded summary of the pinned source.
 *
 * The pinned source stays complete and authoritative in the composed prompt; this projection only
 * puts the request where an agent that reads the start of a packet or prompt will see it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { requestedOutcomeLine, storyRequestSummary } from '../src/story-request-summary.mjs';

test('the summary takes the first field that says something and bounds every line', () => {
  // Manual sources keep unanswered fields as empty strings.
  const summary = storyRequestSummary({ title: 'Change the value', desiredOutcome: '', description: 'Change it\n from 1 to 2.', acceptanceCriteria: '' });
  assert.deepEqual([summary.title, summary.outcome, summary.acceptanceCriteria], ['Change the value', 'Change it from 1 to 2.', []]);
  assert.match(summary.authority, /pinned Story source/u);
  assert.equal(storyRequestSummary({ title: 'T', desiredOutcome: 'Outcome wins', description: 'ignored' }).outcome, 'Outcome wins');
  const long = storyRequestSummary({ title: 'T', description: 'x'.repeat(2000) });
  assert.equal(long.outcome.length, 600);
  assert.ok(long.outcome.endsWith('…'));
  assert.equal(storyRequestSummary({ title: '', description: '  ', acceptanceCriteria: [] }), null);
  assert.equal(storyRequestSummary(null), null);
});

test('criteria come from lists, numbered or bulleted text, or objects, and the rest are counted', () => {
  assert.deepEqual(storyRequestSummary({ title: 'T', acceptanceCriteria: '- one\n2. two\n\n* three' }).acceptanceCriteria, ['one', 'two', 'three']);
  const many = storyRequestSummary({ title: 'T', acceptanceCriteria: ['a', { text: 'b' }, { description: 'c' }, 'd', 'e', 'f', 'g', ''] });
  assert.deepEqual(many.acceptanceCriteria, ['a', 'b', 'c', 'd', 'e']);
  assert.equal(many.moreAcceptanceCriteria, 2, 'empty entries are not counted');
});

test('the prompt line names the outcome and where the full request is', () => {
  assert.equal(requestedOutcomeLine({ title: 'Change the value', description: 'Change it from 1 to 2.' }),
    '- Requested outcome: Change the value — Change it from 1 to 2. (full request: Pinned Story source below)');
  assert.equal(requestedOutcomeLine({ title: 'Same', description: 'Same' }),
    '- Requested outcome: Same (full request: Pinned Story source below)');
  assert.equal(requestedOutcomeLine({ acceptanceCriteria: ['Only a criterion'] }),
    '- Requested outcome: Only a criterion (full request: Pinned Story source below)');
  assert.equal(requestedOutcomeLine({}), null);
});

test('a step with approved inputs reads the request as refined by them, never as the whole requirement', () => {
  // A code step read "Implement hex operator" with criteria "test cases" and asked the person what
  // its approved plan already settled.
  const source = { title: 'Implement hex operator', acceptanceCriteria: ['test cases'] };
  const refined = storyRequestSummary(source, { refinedBy: ['specification', 'planning'] });
  assert.deepEqual(refined.refinedBy, ['specification', 'planning']);
  assert.match(refined.authority, /original request\. This step's approved inputs, the outputs of specification, planning right after the phase contract in the composed context, refine it and settle its detail: read them, never ask what they answer\./u);
  assert.equal(storyRequestSummary(source).refinedBy, undefined, 'the first step has no inputs to name');
  assert.equal(requestedOutcomeLine(source, { refinedBy: ['planning'] }),
    "- Requested outcome: Implement hex operator (full request: Pinned Story source below); refined by this step's approved inputs from planning (Approved upstream artifact evidence below), which settle its detail");
});
