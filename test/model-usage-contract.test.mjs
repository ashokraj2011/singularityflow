import assert from 'node:assert/strict';
import test from 'node:test';

import {
  combineUsageMetrics, estimateUtf8Tokens, observationCompression,
  providerTokenArithmetic, usageMetric
} from '../src/model-usage-contract.mjs';

test('unavailable usage is never represented by a numeric zero', () => {
  assert.deepEqual(usageMetric(null), {
    value: null, status: 'unavailable', assurance: 'unavailable'
  });
  assert.throws(() => usageMetric(0, { status: 'unavailable' }), /cannot carry a numeric value/);
});

test('provider arithmetic excludes cached input from double counting', () => {
  const arithmetic = providerTokenArithmetic({
    inputTokens: usageMetric(1000),
    outputTokens: usageMetric(250),
    cachedInputTokens: usageMetric(400)
  });
  assert.deepEqual(arithmetic.uncachedInputTokens, {
    value: 600, status: 'exact', assurance: 'provider-reported'
  });
  assert.deepEqual(arithmetic.totalProviderTokens, {
    value: 1250, status: 'exact', assurance: 'provider-reported'
  });
});

test('missing provider fields stay unavailable and make derived totals partial', () => {
  const arithmetic = providerTokenArithmetic({
    inputTokens: usageMetric(1000), outputTokens: usageMetric(null),
    cachedInputTokens: usageMetric(null)
  });
  assert.equal(arithmetic.uncachedInputTokens.status, 'unavailable');
  assert.deepEqual(arithmetic.totalProviderTokens, {
    value: 1000, status: 'partial', assurance: 'provider-reported'
  });
  assert.equal(combineUsageMetrics([usageMetric(3), usageMetric(null)]).status, 'partial');
});

test('derived arithmetic preserves a non-provider assurance', () => {
  const arithmetic = providerTokenArithmetic({
    inputTokens: usageMetric(100, { assurance: 'self-reported' }),
    outputTokens: usageMetric(20, { assurance: 'self-reported' }),
    cachedInputTokens: usageMetric(10, { assurance: 'self-reported' })
  });
  assert.equal(arithmetic.uncachedInputTokens.assurance, 'self-reported');
  assert.equal(arithmetic.totalProviderTokens.assurance, 'self-reported');
});

test('SFlow token estimates and compression keep their measurement assurance explicit', () => {
  assert.deepEqual(estimateUtf8Tokens(9), {
    value: 3, status: 'estimated', assurance: 'sflow-estimated'
  });
  assert.deepEqual(observationCompression(100, 25), {
    ratio: { value: 4, status: 'exact', assurance: 'sflow-measured' },
    reductionPercent: { value: 0.75, status: 'exact', assurance: 'sflow-measured' }
  });
  assert.equal(observationCompression(25, 100).ratio.status, 'unavailable');
});
