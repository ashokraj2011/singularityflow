import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SGOS_EVALUATION_CLASSIFICATIONS,
  SGOS_EVALUATION_METRICS,
  SGOS_PROHIBITED_EVALUATION_METRICS,
  createSgosEvaluationArm,
  createSgosEvaluationStudy,
  evaluateSgosAgenticStudy,
  projectSgosEvaluationOpenTelemetry,
  validateSgosEvaluationArm,
  validateSgosEvaluationResult,
  validateSgosEvaluationStudy
} from '../src/sgos/index.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';

const digest = (character) => `sha256:${character.repeat(64)}`;
const now = '2026-08-30T00:00:00.000Z';

function study(overrides = {}) {
  return createSgosEvaluationStudy({
    studyId: 'study-a',
    title: 'Compare governed execution outcomes',
    hypothesis: 'The candidate improves verified outcomes without reducing quality.',
    baselineArmId: 'control',
    candidateArmId: 'candidate',
    minimumSampleCount: 10,
    metricTolerances: {},
    measurementPolicySha256: digest('1'),
    createdAt: now,
    ...overrides
  });
}

function metricValues(overrides = {}) {
  return {
    'first-pass-verified-rate': 0.8,
    'accepted-change-rate': 0.8,
    'maintainer-readiness-rate': 0.8,
    'behavioral-equivalence-rate': 0.9,
    'review-minutes': 20,
    'rework-generations': 2,
    'policy-violations': 1,
    'recovery-success-rate': 0.9,
    'cost-per-verified-outcome': 10,
    'latency-to-verified-outcome': 1000,
    'production-change-failure-rate': 0.1,
    'parallel-efficiency': 0.7,
    'merge-conflict-rate': 0.1,
    ...overrides
  };
}

function observations(values = metricValues(), { reverse = false, omit = [] } = {}) {
  const entries = Object.entries(values);
  if (reverse) entries.reverse();
  return Object.fromEntries(entries.filter(([id]) => !omit.includes(id)).map(([id, value]) => [id, {
    status: 'measured',
    value,
    sampleCount: 20,
    evidenceSha256: digest((SGOS_EVALUATION_METRICS.indexOf(id) % 9 + 1).toString())
  }]));
}

function arm(plan, role, values = metricValues(), overrides = {}) {
  const baseline = role === 'baseline';
  return createSgosEvaluationArm({
    armId: baseline ? 'control' : 'candidate',
    studySha256: plan.studySha256,
    role,
    systemSnapshotSha256: baseline ? digest('2') : digest('3'),
    cohortSha256: digest('4'),
    measurementPolicySha256: digest('1'),
    outcomeCount: 20,
    metrics: observations(values),
    outcomeEvidenceSha256: baseline ? digest('5') : digest('6'),
    capturedAt: now,
    ...overrides
  });
}

function evaluate(candidateValues, options = {}) {
  const plan = options.plan ?? study();
  const baseline = options.baseline ?? arm(plan, 'baseline');
  const candidate = options.candidate ?? arm(plan, 'candidate', candidateValues);
  return evaluateSgosAgenticStudy({ study: plan, baseline, candidate, evaluatedAt: now });
}

test('evaluation records are current-schema, content-addressed, canonical, and publicly validated', () => {
  const plan = study();
  const first = arm(plan, 'baseline');
  const second = createSgosEvaluationArm({
    armId: 'control', studySha256: plan.studySha256, role: 'baseline',
    systemSnapshotSha256: digest('2'), cohortSha256: digest('4'),
    measurementPolicySha256: digest('1'), outcomeCount: 20,
    metrics: observations(metricValues(), { reverse: true }),
    outcomeEvidenceSha256: digest('5'), capturedAt: now
  });
  assert.equal(plan.schemaVersion, currentSchemaVersion('sgos-evaluation-study'));
  assert.equal(first.schemaVersion, currentSchemaVersion('sgos-evaluation-arm'));
  assert.equal(first.armSha256, second.armSha256);
  assert.deepEqual(validateSgosEvaluationStudy(plan), plan);
  assert.deepEqual(validateSgosEvaluationArm(first), first);
  assert(Object.isFrozen(plan));
  assert(Object.isFrozen(first.metrics));
});

test('all seven evaluation classifications are closed and deterministic', () => {
  assert.deepEqual(SGOS_EVALUATION_CLASSIFICATIONS, [
    'improved', 'cheaper-but-worse', 'faster-but-worse',
    'quality-improved-higher-cost', 'no-improvement', 'inconclusive', 'invalid-study'
  ]);
  assert.equal(evaluate(metricValues({ 'accepted-change-rate': 0.9 })).classification, 'improved');
  assert.equal(evaluate(metricValues({
    'first-pass-verified-rate': 0.7,
    'cost-per-verified-outcome': 8
  })).classification, 'cheaper-but-worse');
  assert.equal(evaluate(metricValues({
    'first-pass-verified-rate': 0.7,
    'latency-to-verified-outcome': 800
  })).classification, 'faster-but-worse');
  assert.equal(evaluate(metricValues({
    'accepted-change-rate': 0.9,
    'cost-per-verified-outcome': 12
  })).classification, 'quality-improved-higher-cost');
  assert.equal(evaluate(metricValues()).classification, 'no-improvement');
});

test('savings never classify as improvement when any quality guardrail regresses', () => {
  const result = evaluate(metricValues({
    'maintainer-readiness-rate': 0.7,
    'review-minutes': 10,
    'cost-per-verified-outcome': 5,
    'latency-to-verified-outcome': 500
  }));
  assert.equal(result.classification, 'cheaper-but-worse');
  assert.deepEqual(result.qualityGuardrailRegressions, ['maintainer-readiness-rate']);
  assert.notEqual(result.classification, 'improved');
});

test('missing and insufficient evidence remain inconclusive instead of being invented', () => {
  const plan = study();
  const candidate = arm(plan, 'candidate', metricValues(), {
    metrics: observations(metricValues(), { omit: ['behavioral-equivalence-rate'] })
  });
  const missing = evaluateSgosAgenticStudy({
    study: plan, baseline: arm(plan, 'baseline'), candidate, evaluatedAt: now
  });
  assert.equal(missing.status, 'inconclusive');
  assert.equal(missing.classification, 'inconclusive');
  assert(missing.reasons.includes('candidate-missing-metric:behavioral-equivalence-rate'));

  const insufficient = evaluateSgosAgenticStudy({
    study: plan,
    baseline: arm(plan, 'baseline', metricValues(), { outcomeCount: 5, metrics: {} }),
    candidate: arm(plan, 'candidate'),
    evaluatedAt: now
  });
  assert.equal(insufficient.classification, 'inconclusive');
  assert(insufficient.reasons.includes('baseline-insufficient-outcomes'));
});

test('incomparable arms produce a content-addressed invalid-study result', () => {
  const plan = study();
  const result = evaluateSgosAgenticStudy({
    study: plan,
    baseline: arm(plan, 'baseline'),
    candidate: arm(plan, 'candidate', metricValues(), { cohortSha256: digest('7') }),
    evaluatedAt: now
  });
  assert.equal(result.status, 'invalid');
  assert.equal(result.classification, 'invalid-study');
  assert.deepEqual(result.comparisons, []);
  assert.deepEqual(result.reasons, ['cohort-mismatch']);
  assert.deepEqual(validateSgosEvaluationResult(result), result);
});

test('individual-productivity metrics and unknown outcome metrics are refused explicitly', () => {
  const plan = study();
  for (const metricId of SGOS_PROHIBITED_EVALUATION_METRICS) {
    assert.throws(() => createSgosEvaluationArm({
      armId: 'control', studySha256: plan.studySha256, role: 'baseline',
      systemSnapshotSha256: digest('2'), cohortSha256: digest('4'),
      measurementPolicySha256: digest('1'), outcomeCount: 20,
      metrics: { [metricId]: { status: 'measured', value: 1, sampleCount: 20, evidenceSha256: digest('5') } },
      outcomeEvidenceSha256: digest('5'), capturedAt: now
    }), (error) => error.code === 'SGOS_EVALUATION_METRIC_PROHIBITED');
  }
  assert.throws(() => createSgosEvaluationStudy({
    studyId: 'study-a', title: 'Title', hypothesis: 'Hypothesis', baselineArmId: 'control',
    candidateArmId: 'candidate', minimumSampleCount: 10,
    metricTolerances: { 'tokens per person': 0 }, measurementPolicySha256: digest('1'), createdAt: now
  }), (error) => error.code === 'SGOS_EVALUATION_METRIC_PROHIBITED');
  assert.throws(() => createSgosEvaluationStudy({
    studyId: 'study-a', title: 'Title', hypothesis: 'Hypothesis', baselineArmId: 'control',
    candidateArmId: 'candidate', minimumSampleCount: 10,
    metricTolerances: { 'developer-productivity': 0 }, measurementPolicySha256: digest('1'), createdAt: now
  }), (error) => error.code === 'SGOS_EVALUATION_METRIC_UNSUPPORTED');
});

test('strict bounds reject NaN, Infinity, oversized content, unknown fields, and forged hashes', () => {
  const plan = study();
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => arm(plan, 'baseline', metricValues({ 'review-minutes': value })), /finite number/);
  }
  assert.throws(() => study({ hypothesis: 'x'.repeat(4097) }), (error) => error.code === 'SGOS_EVALUATION_LIMIT_EXCEEDED');
  assert.throws(() => createSgosEvaluationStudy({
    studyId: 'study-a', title: 'Title', hypothesis: 'Hypothesis', baselineArmId: 'control',
    candidateArmId: 'candidate', minimumSampleCount: 10, metricTolerances: {},
    measurementPolicySha256: digest('1'), createdAt: now, employeeId: 'person'
  }), (error) => error.code === 'SGOS_EVALUATION_FIELD_UNSUPPORTED');

  const forged = { ...plan, title: 'Changed after hashing' };
  assert.throws(() => validateSgosEvaluationStudy(forged), (error) => error.code === 'SGOS_EVALUATION_HASH_MISMATCH');
  assert.throws(() => validateSgosEvaluationStudy({ ...plan, schemaVersion: 99 }),
    (error) => error.code === 'SCHEMA_VERSION_FUTURE');
});

test('OpenTelemetry projection is deterministic, read-only, and content-free by default', () => {
  const result = evaluate(metricValues({ 'accepted-change-rate': 0.9 }));
  const before = JSON.stringify(result);
  const first = projectSgosEvaluationOpenTelemetry(result);
  const second = projectSgosEvaluationOpenTelemetry(result, { includePromptContent: false });
  assert.deepEqual(first, second);
  assert.equal(first.telemetryMode, 'content-free');
  assert.equal(first.readOnly, true);
  assert(Object.isFrozen(first));
  const serialized = JSON.stringify(first);
  for (const forbidden of ['prompt', 'input.messages', 'output.messages', 'employee', 'person']) {
    assert.equal(serialized.toLowerCase().includes(forbidden), false);
  }
  assert.equal(JSON.stringify(result), before);
  assert.throws(() => projectSgosEvaluationOpenTelemetry(result, { includePromptContent: true }),
    (error) => error.code === 'SGOS_EVALUATION_CONTENT_EXPORT_FORBIDDEN');
});

test('metric vocabulary is complete, unique, and contains no prohibited primary metric', () => {
  assert.equal(SGOS_EVALUATION_METRICS.length, 13);
  assert.equal(new Set(SGOS_EVALUATION_METRICS).size, 13);
  assert.equal(SGOS_EVALUATION_METRICS.some((id) => SGOS_PROHIBITED_EVALUATION_METRICS.includes(id)), false);
});
