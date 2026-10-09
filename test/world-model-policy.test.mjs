import test from 'node:test';
import assert from 'node:assert/strict';

import {
  guidanceGroundingMode,
  retiredWorldModelBlockingSettings,
  worldModelStalenessDecision
} from '../src/world-model-policy.mjs';

test('a stale World Model is warned about or ignored, never a blocker', () => {
  assert.deepEqual(
    ['ignore', 'warn', 'fail'].map((policy) => {
      const decision = worldModelStalenessDecision(policy, false, 'stale fixture');
      return [policy, decision.policy, decision.warns, decision.ignored, Object.hasOwn(decision, 'blocks')];
    }),
    [
      ['ignore', 'ignore', false, true, false],
      ['warn', 'warn', true, false, false],
      // The former blocking setting is still accepted and acts as warn.
      ['fail', 'warn', true, false, false]
    ]
  );
  assert.equal(worldModelStalenessDecision('fail', true).status, 'fresh');
  assert.throws(() => worldModelStalenessDecision('Fail', false), /must be 'warn', 'fail', or 'ignore'/);
});

test('grounding enforce acts as warn, and doctor names the settings that no longer block', () => {
  assert.equal(guidanceGroundingMode('off'), 'off');
  assert.equal(guidanceGroundingMode('warn'), 'warn');
  assert.equal(guidanceGroundingMode('enforce'), 'warn');
  assert.throws(() => guidanceGroundingMode('sometimes'), /must be off, warn, or enforce/);
  assert.deepEqual(retiredWorldModelBlockingSettings({ worldModel: { grounding: 'warn', staleness: 'warn' } }), []);
  assert.deepEqual(retiredWorldModelBlockingSettings({ worldModel: { grounding: 'enforce', staleness: 'fail' } }),
    ['worldModel.grounding: enforce', 'worldModel.staleness: fail']);
});
