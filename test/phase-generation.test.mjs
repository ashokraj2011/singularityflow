import assert from 'node:assert/strict';
import test from 'node:test';
import { nextPhaseGeneration } from '../src/phase-generation.mjs';

test('next generation preserves active evidence and reserves abandoned publication identities', () => {
  assert.equal(nextPhaseGeneration(undefined), 1);
  assert.equal(nextPhaseGeneration({ generation: 2 }), 3);
  assert.equal(nextPhaseGeneration({ generation: 1, generationHighWatermark: 3 }), 4);
  assert.equal(nextPhaseGeneration({ generation: 4, generationHighWatermark: 3 }), 5);
  assert.equal(nextPhaseGeneration({ generation: '1', generationHighWatermark: '3' }), 4);
});

test('invalid and overflowing counters refuse instead of emitting reusable or nonnumeric identities', () => {
  for (const value of [null, NaN, Infinity, -1, 1.5, true, {}, '', ' 2 ', '01', 'not-a-number', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
    for (const field of ['generation', 'generationHighWatermark']) {
      assert.throws(() => nextPhaseGeneration({ generation: 1, [field]: value }), { code: 'GENERATION_COUNTER_INVALID' });
    }
  }
  assert.equal(nextPhaseGeneration({ generation: Number.MAX_SAFE_INTEGER - 1 }), Number.MAX_SAFE_INTEGER);
});
