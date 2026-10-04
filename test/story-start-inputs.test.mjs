import assert from 'node:assert/strict';
import test from 'node:test';
import { assertStoryStartChoices, storyBaseRequired } from '../src/story-start-inputs.mjs';

test('missing base reports the complete new-Story input shape and the separate resume route', () => {
  const error = storyBaseRequired('STORY-1');
  assert.equal(error.code, 'STORY_BASE_REQUIRED');
  assert.match(error.message, /--from-branch.*--work-type.*--title.*--description/su);
  assert.match(error.message, /resume STORY-1 --fetch/u);
});

test('noninteractive intake groups missing choices without guessing a workflow or source', () => {
  assert.throws(() => assertStoryStartChoices({ nonInteractive: true }), error =>
    error.code === 'STORY_INPUTS_REQUIRED' && error.details.missingInputs.length === 2);
  assert.throws(() => assertStoryStartChoices({ nonInteractive: true, workType: 'feature', source: 'manual' }),
    error => error.details.missingInputs.length === 1);
  assert.doesNotThrow(() => assertStoryStartChoices({ nonInteractive: true,
    workType: 'feature', source: 'manual', manualInput: true }));
  assert.doesNotThrow(() => assertStoryStartChoices({ nonInteractive: true, workType: 'feature', source: 'jira' }));
  assert.doesNotThrow(() => assertStoryStartChoices({ nonInteractive: false }));
});
