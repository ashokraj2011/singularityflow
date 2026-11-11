import assert from 'node:assert/strict';
import test from 'node:test';

import { signOffReady } from '../src/owed-decisions.mjs';

test('a sign-off waits for the step that produces its evidence, and for a file to look at (2026-11-11)', () => {
  // The owner signed an inspection against the component before the code step had written anything (generation 0),
  // and was asked to type a path for a screenshot no step had captured yet.
  const workflow = (generation) => ({ phases: { implementation: { id: 'implementation', generation } } });
  const inspection = { files: ['src/components/FunctionGrapher.jsx'], owners: ['implementation'] };
  assert.equal(signOffReady(workflow(0), inspection), false, 'nothing of this change exists before the step publishes');
  assert.equal(signOffReady(workflow(1), inspection), true, 'after a published generation it is this change\'s evidence');
  assert.equal(signOffReady(workflow(1), { files: [], owners: ['implementation'] }), false, 'no file, nothing to look at');
  assert.equal(signOffReady(workflow(1), { files: ['shot.png'], owners: ['visual-verification'] }), false, 'its own step has not published');
});
