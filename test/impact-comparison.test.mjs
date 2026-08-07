import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeImpactDefinition } from '../src/impact-config.mjs';
import { compareImpactReceipts } from '../src/impact.mjs';

function study(method = 'matched-observational') {
  return normalizeImpactDefinition({
    version: 1,
    studies: [{
      id: 'delivery-study', label: 'Delivery study', enabled: true, method,
      groups: [
        { id: 'baseline', label: 'Baseline', assistanceMode: 'baseline' },
        { id: 'agent', label: 'Agent', assistanceMode: 'governed-agent' }
      ],
      matching: { dimensions: ['capability', 'repository-class', 'work-type', 'complexity', 'risk', 'time-period'], timePeriod: 'quarter', seed: 'comparison-seed' },
      primaryMetric: { id: 'flow-time-excluding-approval-wait-ms', direction: 'lower' },
      guardrails: [{ id: 'rework-cycles', maximumRegressionPercent: 10 }],
      reporting: { bootstrapSamples: 300, confidenceLevel: 0.95 },
      privacy: { individualReporting: false, minimumCohortSize: 3, allowedDimensions: ['capability', 'work-type'] }
    }]
  }).studies[0];
}

function receipt(groupId, index, duration, rework = 1) {
  return {
    schemaVersion: 1,
    status: 'finalized',
    subject: {
      workId: `${groupId}-${index}`, capability: 'checkout', repositoryClass: 'delivery',
      workType: 'feature', complexity: 'medium', risk: 'small', timePeriod: '2026-Q3'
    },
    study: { id: 'delivery-study', groupId },
    metrics: {
      'flow-time-excluding-approval-wait-ms': { value: duration, status: 'exact' },
      'rework-cycles': { value: rework, status: 'exact' }
    }
  };
}

function cohort() {
  return [
    receipt('baseline', 1, 100), receipt('baseline', 2, 110), receipt('baseline', 3, 90),
    receipt('agent', 1, 60), receipt('agent', 2, 70), receipt('agent', 3, 50)
  ];
}

test('matched comparisons are deterministic and labelled as observed association, never causation', () => {
  const first = compareImpactReceipts(cohort(), study());
  const second = compareImpactReceipts(cohort(), study());
  assert.deepEqual(first, second);
  assert.equal(first.inference, 'quality-gated-observed-association');
  assert.equal(first.label, 'validated observed delivery association');
  assert.equal(first.result.gainPercent, 40);
  assert.equal(first.qualityGatePassed, true);
});

test('only phased rollout may carry a causal label', () => {
  const result = compareImpactReceipts(cohort(), study('phased-rollout'));
  assert.equal(result.inference, 'causal-estimate');
  assert.equal(result.label, 'validated causal delivery gain');
});

test('guardrail regression prevents a validated delivery result', () => {
  const receipts = cohort().map((item) => item.study.groupId === 'agent'
    ? { ...item, metrics: { ...item.metrics, 'rework-cycles': { value: 2, status: 'exact' } } }
    : item);
  const result = compareImpactReceipts(receipts, study());
  assert.equal(result.qualityGatePassed, false);
  assert.equal(result.label, 'observed acceleration, not validated delivery gain');
  assert.equal(result.guardrails[0].passed, false);
});

test('privacy floors and allowed dimensions are enforced before comparison output', () => {
  assert.throws(() => compareImpactReceipts(cohort().slice(0, 5), study()), /privacy floor/);
  assert.throws(() => compareImpactReceipts(cohort(), study(), { filters: { risk: 'small' } }), /does not allow filtering/);
});
