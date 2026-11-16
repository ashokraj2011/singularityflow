/**
 * SPEC-OSA v1.1 Stage 3, the VS Code views (b27, b35, b36): the extension shows the engine's own next action for a step,
 * so its tree, cards and chat prefill agree with every other view [OSA:REQ-020, REQ-050].
 * - A review that asked corrections keeps the engine's route (the step's work command, which asks the person to start the
 *   next version): before Stage 3 every route but /sf-review-source was dropped, so S4b and S10 showed no action.
 * - A step whose task waits (SPEC-OSA §8) shows that wait and the engine's route for it.
 * - The prefill is a partial query: it fills the input, never sends.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { phaseGenerationChatPrefill, phaseSubmissionPresentation } from '../apps/vscode/src/views/submission-presentation.ts';

const phase = { id: 'implement', label: 'Implement', status: 'in_progress', generation: 1 };
const readiness = (extra) => ({ phaseId: 'implement', lifecycleReady: false, draftExists: true, draftModified: false, publicationRecorded: true,
  currentGeneration: 1, publishedGeneration: 1, ...extra });

test('a review that asked corrections keeps the engine\'s route to start the next version [b27, S4b, S10]', () => {
  const corrections = phaseSubmissionPresentation(phase, readiness({ classification: 'source-review-required',
    nextSkill: '/sf-code', nextCommand: 'singularity-flow phase rollover implement --json' }));
  assert.equal(corrections.kind, 'source-review-required');
  assert.equal(corrections.skill, '/sf-code');
  assert.match(corrections.statusLabel, /its review asked for corrections/u);
  assert.match(corrections.detail, /only on your yes/u);
  const review = phaseSubmissionPresentation(phase, readiness({ classification: 'source-review-required',
    nextSkill: '/sf-review-source', nextCommand: 'singularity-flow review-source context implement --json' }));
  assert.equal(review.skill, '/sf-review-source');
  assert.match(review.statusLabel, /source review required/u);
});

test('a step whose task waits shows the wait and the engine\'s route for it [§8]', () => {
  const waiting = phaseSubmissionPresentation({ ...phase, generation: 0 }, readiness({ publicationRecorded: false, publishedGeneration: null,
    classification: 'task-waiting', nextSkill: '/sf-decide', nextCommand: 'singularity-flow decisions W-1',
    reason: 'implement waits for a person\'s decision (CODE_TEST_FAILED) on the decisions card; nothing is retried until then.' }));
  assert.deepEqual([waiting.kind, waiting.skill], ['task-waiting', '/sf-decide']);
  assert.match(waiting.detail, /nothing is retried until then/u);
});

test('the prefill only fills the chat input with the route, never sends it [OSA:REQ-050]', () => {
  assert.deepEqual(phaseGenerationChatPrefill('/sf-code'), { query: '/sf-code ', isPartialQuery: true });
  assert.equal(phaseGenerationChatPrefill('rm -rf'), null);
});
