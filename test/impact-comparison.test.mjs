import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeImpactDefinition } from '../src/impact-config.mjs';
import { compareImpactReceipts } from '../src/impact.mjs';

function study(method = 'matched-observational', overrides = {}) {
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
      , ...overrides
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
  assert.equal(first.label, 'quality-gated matched-cohort association');
  assert.equal(first.result.gainPercent, 40);
  assert.equal(first.qualityGatePassed, true);
});

test('only a verified, predeclared phased rollout may carry a causal label', () => {
  const rollout = {
    declaredAt: '2026-01-01T00:00:00.000Z', prePeriodDays: 14, postPeriodDays: 14,
    crossover: 'intention-to-treat', minimumAdherencePercent: 90,
    waves: [
      { id: 'wave-one', activatedAt: '2026-02-01T00:00:00.000Z' },
      { id: 'wave-two', activatedAt: '2026-03-01T00:00:00.000Z' }
    ]
  };
  const receipts = cohort().map((item, index) => ({
    ...item,
    rollout: {
      waveId: index % 2 ? 'wave-two' : 'wave-one', exposureObserved: true,
      concurrentControl: true, adherencePercent: 100, preTrendPassed: true, crossoverApplied: true
    }
  }));
  const result = compareImpactReceipts(receipts, study('phased-rollout', { rollout }));
  assert.equal(result.inference, 'causal-estimate');
  assert.equal(result.label, 'validated causal gain');
  assert.equal(result.rollout.valid, true);

  const incomplete = compareImpactReceipts(cohort().map((item, index) => ({
    ...item, rollout: { waveId: index % 2 ? 'wave-two' : 'wave-one' }
  })), study('phased-rollout', { rollout }));
  assert.equal(incomplete.inference, 'observed-phased-rollout-association');
  assert.equal(incomplete.evidenceGrade, 'B');
  assert.equal(incomplete.rollout.valid, false);
});

test('guardrail regression prevents a validated delivery result', () => {
  const receipts = cohort().map((item) => item.study.groupId === 'agent'
    ? { ...item, metrics: { ...item.metrics, 'rework-cycles': { value: 2, status: 'exact' } } }
    : item);
  const result = compareImpactReceipts(receipts, study());
  assert.equal(result.qualityGatePassed, false);
  assert.equal(result.label, 'observed acceleration; quality guardrails failed');
  assert.equal(result.guardrails[0].passed, false);
});

test('missing guardrails are reported as incomplete quality evidence', () => {
  const result = compareImpactReceipts(cohort(), study('matched-observational', { guardrails: [] }));
  assert.equal(result.qualityGatePassed, false);
  assert.equal(result.label, 'observed acceleration; quality validation incomplete');
});

test('matched estimates are computed within strata before deterministic weighting', () => {
  const rows = [];
  for (let index = 0; index < 10; index += 1) rows.push({ ...receipt('baseline', `a-${index}`, 100), subject: { ...receipt('baseline', `a-${index}`, 100).subject, capability: 'alpha' } });
  for (let index = 0; index < 3; index += 1) rows.push({ ...receipt('agent', `a-${index}`, 90), subject: { ...receipt('agent', `a-${index}`, 90).subject, capability: 'alpha' } });
  for (let index = 0; index < 3; index += 1) rows.push({ ...receipt('baseline', `b-${index}`, 10), subject: { ...receipt('baseline', `b-${index}`, 10).subject, capability: 'beta' } });
  for (let index = 0; index < 10; index += 1) rows.push({ ...receipt('agent', `b-${index}`, 9), subject: { ...receipt('agent', `b-${index}`, 9).subject, capability: 'beta' } });
  const result = compareImpactReceipts(rows, study());
  assert.equal(result.result.gainPercent, 10);
  assert.equal(result.result.effectsByStratum.length, 2);
  assert.equal(result.cohorts.strata, 2);
  assert.equal(result.cohorts.excludedBaseline, 0);
  assert.equal(result.cohorts.excludedTreatment, 0);
});

test('privacy floors and allowed dimensions are enforced before comparison output', () => {
  assert.throws(() => compareImpactReceipts(cohort().slice(0, 5), study()), /privacy floor/);
  assert.throws(() => compareImpactReceipts(cohort(), study(), { filters: { risk: 'small' } }), /does not allow filtering/);
});
