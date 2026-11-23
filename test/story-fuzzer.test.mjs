/**
 * The Story fuzzer (owner, 2026-11-23: "do 1 and 2"): seeded walks of what a person and an author do on a real Story, on
 * the real CLI, with what must hold checked after every action (test/helpers/story-fuzzer.mjs, src/story-invariants.mjs).
 *
 * Two walks replay what d-story met on 2026-11-23, which every other test passed:
 * - two issues about Verification returned with one answer for all: the second was refused;
 * - the release report edited by its author after Verification's next version: its evidence index was never written again.
 * The rest are seeded: SINGULARITY_FLOW_FUZZ_SEEDS (comma separated) and SINGULARITY_FLOW_FUZZ_STEPS widen a run. A
 * failure prints its seed and the actions that led there, so it replays exactly.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { fuzzTemplate, walkStory } from './helpers/story-fuzzer.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const SEEDS = String(process.env.SINGULARITY_FLOW_FUZZ_SEEDS ?? '11,23').split(',').map(Number).filter(Number.isInteger);
const STEPS = Number(process.env.SINGULARITY_FLOW_FUZZ_STEPS ?? 8);
const shown = (walk) => JSON.stringify({ seed: walk.seed, trail: walk.trail, problems: walk.problems }, null, 2);

const REPLAYS = {
  'two issues about Verification returned with one answer for all': [
    { do: 'advanceUntil', phase: 'release', status: 'awaiting_approval', edit: false },
    { do: 'raise', against: 'verification', count: 2 },
    { do: 'answerAll', option: 'return' }
  ],
  'the release report edited after Verification\'s next version was approved': [
    { do: 'advanceUntil', phase: 'release', status: 'awaiting_approval', edit: false },
    { do: 'raise', against: 'verification', count: 1 },
    { do: 'answerOne', option: 'return' },
    { do: 'advanceUntil', phase: 'release', status: 'awaiting_approval', edit: true }
  ]
};

test('the Story fuzzer: d-story\'s walks and seeded ones leave nothing refused that was shown, nothing stale and no dead end', slowLane({ timeout: 3_600_000 }), async (t) => {
  const template = await fuzzTemplate(t);
  for (const [name, script] of Object.entries(REPLAYS)) {
    await t.test(`replay: ${name}`, async (step) => {
      const walk = await walkStory(step, template, { seed: 1, script });
      step.diagnostic(walk.trail.join('\n'));
      assert.ok(walk.trail.every((line) => !/skipped|did not reach/u.test(line)), `the replay walked as written:\n${shown(walk)}`);
      assert.deepEqual(walk.problems, [], shown(walk));
    });
  }
  for (const seed of SEEDS) {
    await t.test(`seed ${seed}, ${STEPS} actions`, async (step) => {
      const walk = await walkStory(step, template, { seed, steps: STEPS });
      step.diagnostic(walk.trail.join('\n'));
      assert.deepEqual(walk.problems, [], shown(walk));
    });
  }
});
