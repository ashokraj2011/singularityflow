import assert from 'node:assert/strict';
import test from 'node:test';
import { assertStoryStartChoices } from '../src/story-start-inputs.mjs';
import { storyBaseRequired } from '../src/story-base-choices.mjs';

test('missing base reports the complete new-Story input shape and the separate resume route', async () => {
  const error = storyBaseRequired('STORY-1');
  assert.equal(error.code, 'STORY_BASE_REQUIRED');
  assert.match(error.message, /--work-type.*--title.*--description/su);
  assert.match(error.message, /resume STORY-1 --fetch/u);
  // The bases this clone knows, the usual one first, each the same start as a whole command [audit 2026-11-19, entry 12].
  const known = storyBaseRequired('STORY-1', { branches: ['main', 'develop'] });
  assert.match(known.message, /starts from: main, develop\./u);
  assert.deepEqual(known.details.branches, ['main', 'develop']);
  const { refusalRemediationPlan } = await import('../src/refusal-remediation.mjs');
  const plan = refusalRemediationPlan(known, ['start', 'STORY-1', '--title', 'Pay in two parts', '--json']);
  assert.deepEqual(plan.steps.slice(0, 3).map((entry) => entry.command), [
    "singularity-flow start STORY-1 --title 'Pay in two parts' --from-branch main",
    'singularity-flow start STORY-1 --title \'Pay in two parts\' --from-branch develop',
    'singularity-flow resume STORY-1 --fetch']);
  assert.match(plan.steps[0].label, /main, the usual branch/u);
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
