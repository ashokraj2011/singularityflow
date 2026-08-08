import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deterministicStudyGroup, normalizeImpactDefinition
} from '../src/impact-config.mjs';
import { impactImplementationGate } from '../src/impact.mjs';
import { lifecycleEvent } from '../src/lifecycle-event.mjs';

function definition(overrides = {}) {
  return {
    version: 1,
    automaticEnrollment: true,
    studies: [{
      id: 'delivery-study',
      label: 'Delivery study',
      enabled: true,
      method: 'matched-observational',
      eligibility: { workTypes: ['feature'], capabilities: [] },
      groups: [
        { id: 'baseline', label: 'Baseline', assistanceMode: 'baseline', weight: 1 },
        { id: 'agent', label: 'Governed agent', assistanceMode: 'governed-agent', weight: 1 }
      ],
      matching: {
        dimensions: ['capability', 'repository-class', 'work-type', 'complexity', 'risk', 'time-period'],
        timePeriod: 'quarter', seed: 'stable-seed'
      },
      primaryMetric: { id: 'flow-time-excluding-approval-wait-ms', direction: 'lower' },
      guardrails: [{ id: 'rework-cycles', maximumRegressionPercent: 10 }],
      reporting: { bootstrapSamples: 500, confidenceLevel: 0.95 },
      privacy: { individualReporting: false, minimumCohortSize: 3, pseudonymizeContributors: true },
      ...overrides
    }]
  };
}

test('impact configuration normalizes a strict version-1 study and deterministic assignment', () => {
  const [study] = normalizeImpactDefinition(definition()).studies;
  assert.equal(study.primaryMetric.unit, 'milliseconds');
  assert.equal(study.privacy.minimumCohortSize, 3);
  assert.equal(study.matching.weighting, 'minimum-cohort-count');
  assert.equal(normalizeImpactDefinition(definition()).metricAuthorities['elapsed-ms'].authority, 'kernel-only');
  assert.deepEqual(deterministicStudyGroup(study, 'STORY-101'), deterministicStudyGroup(study, 'STORY-101'));
});

test('metric authorities and phased-rollout designs are explicit and predeclared', () => {
  assert.throws(() => normalizeImpactDefinition({
    ...definition(), metricAuthorities: { 'escaped-defects': { authority: 'external-provider' } }
  }), /allowlist at least one provider/);
  assert.throws(() => normalizeImpactDefinition(definition({ method: 'phased-rollout' })), /rollout/);
  const configured = normalizeImpactDefinition({
    ...definition({
      method: 'phased-rollout',
      rollout: {
        declaredAt: '2026-01-01T00:00:00.000Z', prePeriodDays: 14, postPeriodDays: 14,
        crossover: 'intention-to-treat', minimumAdherencePercent: 90,
        waves: [
          { id: 'wave-one', activatedAt: '2026-02-01T00:00:00.000Z' },
          { id: 'wave-two', activatedAt: '2026-03-01T00:00:00.000Z' }
        ]
      }
    }),
    metricAuthorities: { 'escaped-defects': { authority: 'external-provider', providers: ['quality-system'] } }
  });
  assert.equal(configured.metricAuthorities['escaped-defects'].providers[0], 'quality-system');
  assert.equal(configured.studies[0].rollout.requireConcurrentControl, true);
});

test('impact configuration rejects unknown metrics, unsafe cohorts, and incomplete matching', () => {
  assert.throws(() => normalizeImpactDefinition(definition({ primaryMetric: { id: 'invented-score' } })), /unknown metric/);
  assert.throws(() => normalizeImpactDefinition(definition({ privacy: { minimumCohortSize: 1 } })), /at least 2/);
  assert.throws(() => normalizeImpactDefinition(definition({ matching: { dimensions: ['complexity', 'risk'], timePeriod: 'quarter' } })), /time-period/);
  assert.throws(() => normalizeImpactDefinition({ ...definition(), surprise: true }), /unknown field/);
});

test('privacy filters cannot introduce dimensions outside the configured matching model', () => {
  const value = definition();
  value.studies[0].privacy.allowedDimensions = ['complexity', 'contributor'];
  assert.throws(() => normalizeImpactDefinition(value), /contributor.*not configured/);
});

test('schema 1 comparison studies require exactly two cohorts', () => {
  const value = definition();
  value.studies[0].groups.push({ id: 'manual', label: 'Manual', assistanceMode: 'custom' });
  assert.throws(() => normalizeImpactDefinition(value), /exactly two cohorts/);
});

test('all governed impact mutations are accepted by the publication event envelope', () => {
  const types = [
    'impact-classified', 'impact-opted-out', 'impact-exposure-recorded',
    'impact-evidence-collected', 'impact-evidence-imported', 'impact-finalized'
  ];
  for (const type of types) {
    assert.equal(lifecycleEvent({ type, subject: { kind: 'story', id: 'STORY-1' } }).type, type);
  }
});

test('implementation preparation is blocked until enrolled work is classified', () => {
  const workflow = {
    workItem: { id: 'STORY-101' },
    measurement: {
      status: 'classification-required',
      plan: { studyId: 'delivery-study' },
      classification: { confirmed: null }
    }
  };
  assert.match(impactImplementationGate(workflow, 'implementation'), /Confirm complexity and risk/);
  workflow.measurement.classification.confirmed = { complexity: 'small', risk: 'medium' };
  assert.equal(impactImplementationGate(workflow, 'implementation'), null);
  workflow.measurement.classification.confirmed = null;
  workflow.measurement.status = 'opted-out';
  assert.equal(impactImplementationGate(workflow, 'implementation'), null);
});
