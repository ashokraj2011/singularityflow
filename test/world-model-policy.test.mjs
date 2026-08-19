import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertWorldModelStaleness,
  worldModelStalenessDecision
} from '../src/world-model-policy.mjs';

test('world-model staleness is an independent ignore, warn, or fail decision', () => {
  assert.deepEqual(
    ['ignore', 'warn', 'fail'].map((policy) => {
      const decision = worldModelStalenessDecision(policy, false, 'stale fixture');
      return [policy, decision.blocks, decision.warns, decision.ignored];
    }),
    [
      ['ignore', false, false, true],
      ['warn', false, true, false],
      ['fail', true, false, false]
    ]
  );
  assert.equal(worldModelStalenessDecision('fail', true).status, 'fresh');
});

test('the shared staleness assertion fails only for fail policy', () => {
  assert.doesNotThrow(() => assertWorldModelStaleness('ignore', false));
  assert.doesNotThrow(() => assertWorldModelStaleness('warn', false));
  assert.throws(
    () => assertWorldModelStaleness('fail', false, 'stale fixture'),
    (error) => error.code === 'WORLD_MODEL_STALE' && /stale fixture/.test(error.message)
  );
});
