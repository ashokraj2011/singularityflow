/**
 * Generated workflows, walked (step intents spec §9.3, Stage 6): workflows built from intents with random step IDs and
 * random mixes of document, code and no-code steps, review on or off, approval by a person, by SFlow when clean or none,
 * questions asked or not, and test commands configured or detected (test/helpers/generated-workflows.mjs). Each draw
 * the engine starts is walked by the walk every change runs (src/workflow-walk/quick.mjs) on Copilot CLI and VS Code;
 * a draw it stops is one nobody could make, and each of its stops says why in plain words with a filled fix. The
 * draws it lets through are the workflows a person could make: test/step-intents-hosts.test.mjs walks those as real
 * Stories, as each host drives them, and fails on any loop, dead end or stop that is not a person's.
 *
 * Fast lane: a small fixed seed set, chosen so that together it covers every mix and the walk stops at least one draw.
 * Slow lane: many seeds (SINGULARITY_FLOW_GENERATED_WORKFLOWS, default 200; SINGULARITY_FLOW_GENERATED_SEED moves the first).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { QUICK_WALK_CLASSES } from '../src/workflow-walk/quick.mjs';
import { generatedWorkflow, walkGenerated } from './helpers/generated-workflows.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

// Seeds whose workflows, between them, have every mix (checked below, so a generator change that loses one fails).
export const FIXED_SEEDS = Object.freeze([11, 12, 13, 14, 15, 16, 17, 18]);
const MANY = Number(process.env.SINGULARITY_FLOW_GENERATED_WORKFLOWS ?? 200);
const FIRST = Number(process.env.SINGULARITY_FLOW_GENERATED_SEED ?? 20261121);

/** Every stop the walk gave a draw it refused: a class it knows, plain words and a filled fix. */
function assertExplained(refused) {
  for (const draw of refused) {
    for (const stop of draw.stops) {
      assert.ok(QUICK_WALK_CLASSES.includes(stop.class), `${draw.where}: ${stop.class}`);
      for (const field of [stop.title, stop.detail, stop.fix?.text]) assert.ok(typeof field === 'string' && field.length >= 20 && !/\bundefined\b|\bnull\b/u.test(field), `${draw.where}: ${JSON.stringify(stop)}`);
    }
  }
}

test(`a fixed set of generated workflows: each draw the walk stops is explained with its fix, the rest walk on both hosts with no stop, and every mix is there (seeds ${FIXED_SEEDS.join(', ')})`, () => {
  const seen = { code: 0, codeFree: 0, reviewOff: 0, questionsOff: 0, testsConfigured: 0, testsDetected: 0, person: 0, automatic: 0, none: 0, refusedByWalk: 0 };
  for (const seed of FIXED_SEEDS) {
    const generated = generatedWorkflow(seed);
    assertExplained(generated.refused);
    seen.refusedByWalk += generated.refused.length;
    const walk = walkGenerated(generated.resolved, generated.value);
    assert.deepEqual(walk.stops.map((stop) => `${stop.class}: ${stop.title}`), [], generated.where);
    assert.equal(walk.outcome, 'completed', generated.where);
    assert.ok(walk.paths >= 1 && walk.routes >= generated.ids.length * 3, `${generated.where}: ${walk.paths} paths, ${walk.routes} routes`);
    seen[generated.intents.includes('code') ? 'code' : 'codeFree'] += 1;
    if (generated.review !== 'on') seen.reviewOff += 1;
    if (generated.questions === 'off') seen.questionsOff += 1;
    seen[generated.tests ? 'testsConfigured' : 'testsDetected'] += 1;
    for (const change of generated.changes) for (const kind of ['person', 'automatic', 'none']) if (change.endsWith(`approval ${kind}`)) seen[kind] += 1;
  }
  for (const [mix, count] of Object.entries(seen)) assert.ok(count >= 1, `no fixed seed gives a workflow with ${mix}: ${JSON.stringify(seen)}`);
});

test('many seeds: every draw the walk stops is explained with its fix, and every workflow a person could make walks with no stop', slowLane({ timeout: 900_000 }), () => {
  for (let index = 0; index < MANY; index += 1) {
    const generated = generatedWorkflow(FIRST + index);
    assertExplained(generated.refused);
    assert.deepEqual(walkGenerated(generated.resolved, generated.value).stops, [], generated.where);
  }
});
