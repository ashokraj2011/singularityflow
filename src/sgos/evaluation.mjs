/**
 * Pure, bounded SGOS Agentic Evaluation records and content-free telemetry projection.
 *
 * This module does not read or write Git/files, invoke a model, execute a Process, rank people, or
 * infer missing evidence. It compares only caller-supplied, content-addressed outcome evidence.
 */
import { canonicalJson } from '../records.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { SingularityFlowError } from '../util.mjs';
import {
  cloneSgosValue, recordSelfSha256
} from './contracts.mjs';
import { compareSgosCodePoints } from './order.mjs';

export const SGOS_EVALUATION_METRICS = Object.freeze([
  'first-pass-verified-rate',
  'accepted-change-rate',
  'maintainer-readiness-rate',
  'behavioral-equivalence-rate',
  'review-minutes',
  'rework-generations',
  'policy-violations',
  'recovery-success-rate',
  'cost-per-verified-outcome',
  'latency-to-verified-outcome',
  'production-change-failure-rate',
  'parallel-efficiency',
  'merge-conflict-rate'
]);

export const SGOS_PROHIBITED_EVALUATION_METRICS = Object.freeze([
  'tokens-per-person',
  'prompts-per-person',
  'lines-generated-per-person',
  'agent-hours-per-person',
  'individual-ranking'
]);

export const SGOS_EVALUATION_CLASSIFICATIONS = Object.freeze([
  'improved',
  'cheaper-but-worse',
  'faster-but-worse',
  'quality-improved-higher-cost',
  'no-improvement',
  'inconclusive',
  'invalid-study'
]);

export const SGOS_EVALUATION_LIMITS = Object.freeze({
  maximumRecordBytes: 256 * 1024,
  maximumTitleBytes: 256,
  maximumHypothesisBytes: 4 * 1024,
  maximumOutcomesPerArm: 1_000_000,
  maximumMetricValue: 1_000_000_000_000,
  maximumReasons: 64
});

const HASH = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const RATE_METRICS = new Set([
  'first-pass-verified-rate', 'accepted-change-rate', 'maintainer-readiness-rate',
  'behavioral-equivalence-rate', 'recovery-success-rate',
  'production-change-failure-rate', 'parallel-efficiency', 'merge-conflict-rate'
]);
const LOWER_IS_BETTER = new Set([
  'review-minutes', 'rework-generations', 'policy-violations',
  'cost-per-verified-outcome', 'latency-to-verified-outcome',
  'production-change-failure-rate', 'merge-conflict-rate'
]);
const QUALITY_GUARDRAILS = Object.freeze([
  'first-pass-verified-rate', 'accepted-change-rate', 'maintainer-readiness-rate',
  'behavioral-equivalence-rate', 'rework-generations', 'policy-violations',
  'recovery-success-rate', 'production-change-failure-rate', 'merge-conflict-rate'
]);
const QUALITY_SET = new Set(QUALITY_GUARDRAILS);
const ECONOMIC_SET = new Set(['review-minutes', 'cost-per-verified-outcome']);
const SPEED_SET = new Set(['latency-to-verified-outcome', 'parallel-efficiency']);
const METRIC_SET = new Set(SGOS_EVALUATION_METRICS);
const PROHIBITED_SET = new Set(SGOS_PROHIBITED_EVALUATION_METRICS);
const METRIC_UNITS = Object.freeze(Object.fromEntries(SGOS_EVALUATION_METRICS.map((id) => [id,
  RATE_METRICS.has(id) ? 'ratio'
    : id === 'review-minutes' ? 'minutes'
      : id === 'latency-to-verified-outcome' ? 'milliseconds'
        : id === 'cost-per-verified-outcome' ? 'currency-units'
          : 'count'
])));

export class SgosEvaluationError extends SingularityFlowError {
  constructor(message, code = 'SGOS_EVALUATION_INVALID', details = null) {
    super(message, { code, details: details ?? undefined });
    this.name = 'SgosEvaluationError';
  }
}

function fail(message, code = 'SGOS_EVALUATION_INVALID', details = null) {
  throw new SgosEvaluationError(message, code, details);
}

function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowed, label) {
  if (!plain(value)) fail(`${label} must be a plain object.`);
  const accepted = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !accepted.has(key));
  if (unexpected.length) fail(`${label} contains unsupported field(s): ${unexpected.join(', ')}.`,
    'SGOS_EVALUATION_FIELD_UNSUPPORTED', { unexpected: unexpected.sort(compareSgosCodePoints) });
}

function requireKeys(value, required, label) {
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length) fail(`${label} is missing required field(s): ${missing.join(', ')}.`,
    'SGOS_EVALUATION_FIELD_REQUIRED', { missing });
}

function text(value, label, maximumBytes) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a non-empty string.`);
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > maximumBytes) fail(`${label} exceeds its ${maximumBytes}-byte ceiling.`,
    'SGOS_EVALUATION_LIMIT_EXCEEDED', { field: label, bytes, maximumBytes });
}

function identifier(value, label) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) fail(`${label} is not a valid identifier.`);
}

function digest(value, label, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !HASH.test(value)) fail(`${label} must be a lowercase SHA-256 digest.`);
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !RFC3339.test(value) || !Number.isFinite(Date.parse(value))) {
    fail(`${label} must be an RFC 3339 timestamp supplied by the caller.`);
  }
}

function finite(value, label, { minimum = 0, maximum = SGOS_EVALUATION_LIMITS.maximumMetricValue } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail(`${label} must be a finite number between ${minimum} and ${maximum}.`);
  }
}

function integer(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be a safe integer between ${minimum} and ${maximum}.`);
  }
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function bounded(record, label) {
  const bytes = Buffer.byteLength(canonicalJson(record), 'utf8');
  if (bytes > SGOS_EVALUATION_LIMITS.maximumRecordBytes) {
    fail(`${label} exceeds the ${SGOS_EVALUATION_LIMITS.maximumRecordBytes}-byte record ceiling.`,
      'SGOS_EVALUATION_LIMIT_EXCEEDED', { bytes, maximumBytes: SGOS_EVALUATION_LIMITS.maximumRecordBytes });
  }
}

function assertMetricId(value, label) {
  const normalized = typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[\s_/]+/g, '-').replace(/-+/g, '-')
    : value;
  if (PROHIBITED_SET.has(normalized)) {
    fail(`${label} '${value}' is prohibited: SGOS evaluation cannot measure or rank individual productivity.`,
      'SGOS_EVALUATION_METRIC_PROHIBITED', { metricId: value, canonicalProhibitedMetricId: normalized });
  }
  if (!METRIC_SET.has(value)) fail(`${label} '${value}' is unsupported.`,
    'SGOS_EVALUATION_METRIC_UNSUPPORTED', { metricId: value, allowed: SGOS_EVALUATION_METRICS });
}

function checkBase(record, { family, kind, hashField, allowed, required, requireHash = true }) {
  exactKeys(record, ['schemaVersion', 'kind', ...allowed, hashField], kind);
  requireKeys(record, ['schemaVersion', 'kind', ...required, ...(requireHash ? [hashField] : [])], kind);
  // Schema range checks and any future migrations belong to the central durable-record registry.
  // These v1 immutable families currently return an equivalent clone.
  readRecord(family, record);
  if (record.kind !== kind) fail(`${kind}.kind must be '${kind}'.`);
  if (requireHash) {
    digest(record[hashField], `${kind}.${hashField}`);
    const expected = recordSelfSha256(record, hashField);
    if (record[hashField] !== expected) fail(`${kind}.${hashField} does not match its canonical content.`,
      'SGOS_EVALUATION_HASH_MISMATCH', { expected, received: record[hashField] });
  }
  bounded(record, kind);
}

function seal(family, kind, hashField, input, validate) {
  if (!plain(input)) fail(`${kind} input must be a plain object.`);
  // Creation may accept an explicitly stamped current record, but never silently replaces a
  // caller-supplied future/archived version or a different kind.
  if (Object.hasOwn(input, 'schemaVersion')) readRecord(family, input);
  if (Object.hasOwn(input, 'kind') && input.kind !== kind) fail(`${kind}.kind must be '${kind}'.`);
  const suppliedHash = input[hashField];
  const core = { ...input };
  delete core[hashField];
  const record = {
    ...core,
    schemaVersion: currentSchemaVersion(family),
    kind
  };
  validate(record, false);
  const sealed = { ...record, [hashField]: recordSelfSha256(record, hashField) };
  if (suppliedHash != null && suppliedHash !== sealed[hashField]) {
    fail(`${kind}.${hashField} supplied by the caller is not canonical.`,
      'SGOS_EVALUATION_HASH_MISMATCH', { expected: sealed[hashField], received: suppliedHash });
  }
  validate(sealed, true);
  return freezeDeep(cloneSgosValue(sealed));
}

function metricTolerances(value, label) {
  if (!plain(value)) fail(`${label} must be an object.`);
  const normalized = {};
  for (const metricId of Object.keys(value)) assertMetricId(metricId, `${label} metric`);
  for (const metricId of SGOS_EVALUATION_METRICS) {
    const tolerance = Object.hasOwn(value, metricId) ? value[metricId] : 0;
    finite(tolerance, `${label}.${metricId}`, {
      maximum: RATE_METRICS.has(metricId) ? 1 : SGOS_EVALUATION_LIMITS.maximumMetricValue
    });
    normalized[metricId] = tolerance;
  }
  return normalized;
}

function validateStudy(record, requireHash = true) {
  checkBase(record, {
    family: 'sgos-evaluation-study', kind: 'sgos-evaluation-study', hashField: 'studySha256',
    allowed: [
      'studyId', 'title', 'hypothesis', 'baselineArmId', 'candidateArmId',
      'metricIds', 'qualityGuardrailMetricIds', 'minimumSampleCount', 'metricTolerances',
      'measurementPolicySha256', 'createdAt'
    ],
    required: [
      'studyId', 'title', 'hypothesis', 'baselineArmId', 'candidateArmId',
      'metricIds', 'qualityGuardrailMetricIds', 'minimumSampleCount', 'metricTolerances',
      'measurementPolicySha256', 'createdAt'
    ], requireHash
  });
  identifier(record.studyId, 'sgos-evaluation-study.studyId');
  identifier(record.baselineArmId, 'sgos-evaluation-study.baselineArmId');
  identifier(record.candidateArmId, 'sgos-evaluation-study.candidateArmId');
  if (record.baselineArmId === record.candidateArmId) fail('Evaluation arms must have distinct IDs.');
  text(record.title, 'sgos-evaluation-study.title', SGOS_EVALUATION_LIMITS.maximumTitleBytes);
  text(record.hypothesis, 'sgos-evaluation-study.hypothesis', SGOS_EVALUATION_LIMITS.maximumHypothesisBytes);
  if (canonicalJson(record.metricIds) !== canonicalJson(SGOS_EVALUATION_METRICS)) {
    fail('Evaluation study metricIds must be the complete canonical SGOS outcome metric vocabulary.',
      'SGOS_EVALUATION_METRICS_INCOMPLETE');
  }
  if (canonicalJson(record.qualityGuardrailMetricIds) !== canonicalJson(QUALITY_GUARDRAILS)) {
    fail('Evaluation study qualityGuardrailMetricIds must be the complete canonical quality guardrail set.',
      'SGOS_EVALUATION_GUARDRAILS_INCOMPLETE');
  }
  integer(record.minimumSampleCount, 'sgos-evaluation-study.minimumSampleCount', {
    minimum: 1, maximum: SGOS_EVALUATION_LIMITS.maximumOutcomesPerArm
  });
  const tolerances = metricTolerances(record.metricTolerances, 'sgos-evaluation-study.metricTolerances');
  if (canonicalJson(record.metricTolerances) !== canonicalJson(tolerances)) {
    fail('Evaluation study metricTolerances must contain every metric in canonical form.');
  }
  digest(record.measurementPolicySha256, 'sgos-evaluation-study.measurementPolicySha256');
  timestamp(record.createdAt, 'sgos-evaluation-study.createdAt');
}

export function createSgosEvaluationStudy(input) {
  exactKeys(input, [
    'schemaVersion', 'kind', 'studyId', 'title', 'hypothesis', 'baselineArmId',
    'candidateArmId', 'minimumSampleCount', 'metricTolerances', 'measurementPolicySha256',
    'createdAt', 'studySha256'
  ], 'evaluation study input');
  const normalized = {
    ...input,
    metricIds: [...SGOS_EVALUATION_METRICS],
    qualityGuardrailMetricIds: [...QUALITY_GUARDRAILS],
    metricTolerances: metricTolerances(input.metricTolerances ?? {}, 'evaluation study input.metricTolerances')
  };
  return seal('sgos-evaluation-study', 'sgos-evaluation-study', 'studySha256', normalized, validateStudy);
}

export function validateSgosEvaluationStudy(record) {
  validateStudy(record, true);
  return freezeDeep(cloneSgosValue(record));
}

function validateObservation(metricId, value, label) {
  exactKeys(value, ['status', 'value', 'sampleCount', 'evidenceSha256'], label);
  requireKeys(value, ['status', 'value', 'sampleCount', 'evidenceSha256'], label);
  if (!['measured', 'unavailable'].includes(value.status)) fail(`${label}.status is invalid.`);
  if (value.status === 'unavailable') {
    if (value.value !== null || value.sampleCount !== 0 || value.evidenceSha256 !== null) {
      fail(`${label} unavailable observations must carry null value/evidence and zero samples.`);
    }
    return;
  }
  finite(value.value, `${label}.value`, { maximum: RATE_METRICS.has(metricId) ? 1 : SGOS_EVALUATION_LIMITS.maximumMetricValue });
  integer(value.sampleCount, `${label}.sampleCount`, {
    minimum: 1, maximum: SGOS_EVALUATION_LIMITS.maximumOutcomesPerArm
  });
  digest(value.evidenceSha256, `${label}.evidenceSha256`);
}

function normalizeMetrics(value, label) {
  if (!plain(value)) fail(`${label} must be an object.`);
  for (const metricId of Object.keys(value)) assertMetricId(metricId, `${label} metric`);
  const normalized = {};
  for (const metricId of SGOS_EVALUATION_METRICS) {
    if (!Object.hasOwn(value, metricId)) continue;
    validateObservation(metricId, value[metricId], `${label}.${metricId}`);
    normalized[metricId] = cloneSgosValue(value[metricId]);
  }
  return normalized;
}

function validateArm(record, requireHash = true) {
  checkBase(record, {
    family: 'sgos-evaluation-arm', kind: 'sgos-evaluation-arm', hashField: 'armSha256',
    allowed: [
      'armId', 'studySha256', 'role', 'systemSnapshotSha256', 'cohortSha256',
      'measurementPolicySha256', 'outcomeCount', 'metrics', 'outcomeEvidenceSha256', 'capturedAt'
    ],
    required: [
      'armId', 'studySha256', 'role', 'systemSnapshotSha256', 'cohortSha256',
      'measurementPolicySha256', 'outcomeCount', 'metrics', 'outcomeEvidenceSha256', 'capturedAt'
    ], requireHash
  });
  identifier(record.armId, 'sgos-evaluation-arm.armId');
  if (!['baseline', 'candidate'].includes(record.role)) fail('sgos-evaluation-arm.role must be baseline or candidate.');
  for (const field of [
    'studySha256', 'systemSnapshotSha256', 'cohortSha256',
    'measurementPolicySha256', 'outcomeEvidenceSha256'
  ]) digest(record[field], `sgos-evaluation-arm.${field}`);
  integer(record.outcomeCount, 'sgos-evaluation-arm.outcomeCount', {
    maximum: SGOS_EVALUATION_LIMITS.maximumOutcomesPerArm
  });
  const normalized = normalizeMetrics(record.metrics, 'sgos-evaluation-arm.metrics');
  if (canonicalJson(record.metrics) !== canonicalJson(normalized)) fail('sgos-evaluation-arm.metrics is not canonical.');
  for (const [metricId, observation] of Object.entries(record.metrics)) {
    if (observation.status === 'measured' && observation.sampleCount > record.outcomeCount) {
      fail(`sgos-evaluation-arm.metrics.${metricId}.sampleCount exceeds outcomeCount.`);
    }
  }
  timestamp(record.capturedAt, 'sgos-evaluation-arm.capturedAt');
}

export function createSgosEvaluationArm(input) {
  exactKeys(input, [
    'schemaVersion', 'kind', 'armId', 'studySha256', 'role', 'systemSnapshotSha256',
    'cohortSha256', 'measurementPolicySha256', 'outcomeCount', 'metrics',
    'outcomeEvidenceSha256', 'capturedAt', 'armSha256'
  ], 'evaluation arm input');
  return seal('sgos-evaluation-arm', 'sgos-evaluation-arm', 'armSha256', {
    ...input,
    metrics: normalizeMetrics(input.metrics ?? {}, 'evaluation arm input.metrics')
  }, validateArm);
}

export function validateSgosEvaluationArm(record) {
  validateArm(record, true);
  return freezeDeep(cloneSgosValue(record));
}

function deterministicEvaluationId(studySha256, baselineArmSha256, candidateArmSha256) {
  const digestHex = recordSelfSha256({ studySha256, baselineArmSha256, candidateArmSha256 }, 'unused')
    .slice(7, 39).toUpperCase();
  return `EVAL-${digestHex}`;
}

function contextProblems(study, baseline, candidate) {
  const problems = [];
  if (baseline.studySha256 !== study.studySha256 || candidate.studySha256 !== study.studySha256) problems.push('arm-study-mismatch');
  if (baseline.role !== 'baseline' || candidate.role !== 'candidate') problems.push('arm-role-mismatch');
  if (baseline.armId !== study.baselineArmId || candidate.armId !== study.candidateArmId) problems.push('arm-identity-mismatch');
  if (baseline.armSha256 === candidate.armSha256) problems.push('duplicate-arm');
  if (baseline.measurementPolicySha256 !== study.measurementPolicySha256
      || candidate.measurementPolicySha256 !== study.measurementPolicySha256) problems.push('measurement-policy-mismatch');
  if (baseline.cohortSha256 !== candidate.cohortSha256) problems.push('cohort-mismatch');
  return [...new Set(problems)].sort(compareSgosCodePoints);
}

function compareMetric(study, baseline, candidate, metricId) {
  const left = baseline.metrics[metricId];
  const right = candidate.metrics[metricId];
  if (!left || !right || left.status !== 'measured' || right.status !== 'measured') return null;
  const delta = right.value - left.value;
  const tolerance = study.metricTolerances[metricId];
  const directed = LOWER_IS_BETTER.has(metricId) ? -delta : delta;
  const assessment = directed > tolerance ? 'improved' : directed < -tolerance ? 'regressed' : 'unchanged';
  return {
    metricId,
    unit: METRIC_UNITS[metricId],
    direction: LOWER_IS_BETTER.has(metricId) ? 'lower-is-better' : 'higher-is-better',
    qualityGuardrail: QUALITY_SET.has(metricId),
    baselineValue: left.value,
    candidateValue: right.value,
    delta: Object.is(delta, -0) ? 0 : delta,
    tolerance,
    assessment,
    minimumSampleCount: study.minimumSampleCount,
    baselineSampleCount: left.sampleCount,
    candidateSampleCount: right.sampleCount,
    baselineEvidenceSha256: left.evidenceSha256,
    candidateEvidenceSha256: right.evidenceSha256
  };
}

function classifyComparisons(comparisons) {
  const improved = new Set(comparisons.filter((entry) => entry.assessment === 'improved').map((entry) => entry.metricId));
  const regressed = new Set(comparisons.filter((entry) => entry.assessment === 'regressed').map((entry) => entry.metricId));
  const qualityImproved = [...improved].some((id) => QUALITY_SET.has(id));
  const qualityRegressed = [...regressed].some((id) => QUALITY_SET.has(id));
  const cheaper = [...improved].some((id) => ECONOMIC_SET.has(id));
  const costlier = [...regressed].some((id) => ECONOMIC_SET.has(id));
  const faster = [...improved].some((id) => SPEED_SET.has(id));

  // Cost/speed wins can never mask a quality guardrail regression.
  if (qualityRegressed && cheaper) return 'cheaper-but-worse';
  if (qualityRegressed && faster) return 'faster-but-worse';
  if (qualityRegressed) return 'no-improvement';
  if (qualityImproved && costlier) return 'quality-improved-higher-cost';
  if (qualityImproved || cheaper || faster) return 'improved';
  return 'no-improvement';
}

function inconclusiveReasons(study, arm, prefix) {
  const reasons = [];
  if (arm.outcomeCount < study.minimumSampleCount) reasons.push(`${prefix}-insufficient-outcomes`);
  for (const metricId of SGOS_EVALUATION_METRICS) {
    const observation = arm.metrics[metricId];
    if (!observation) reasons.push(`${prefix}-missing-metric:${metricId}`);
    else if (observation.status === 'unavailable') reasons.push(`${prefix}-unavailable-metric:${metricId}`);
    else if (observation.sampleCount < study.minimumSampleCount) reasons.push(`${prefix}-insufficient-samples:${metricId}`);
  }
  return reasons;
}

function validateComparison(value, label) {
  exactKeys(value, [
    'metricId', 'unit', 'direction', 'qualityGuardrail', 'baselineValue', 'candidateValue',
    'delta', 'tolerance', 'assessment', 'minimumSampleCount', 'baselineSampleCount',
    'candidateSampleCount', 'baselineEvidenceSha256', 'candidateEvidenceSha256'
  ], label);
  requireKeys(value, [
    'metricId', 'unit', 'direction', 'qualityGuardrail', 'baselineValue', 'candidateValue',
    'delta', 'tolerance', 'assessment', 'minimumSampleCount', 'baselineSampleCount',
    'candidateSampleCount', 'baselineEvidenceSha256', 'candidateEvidenceSha256'
  ], label);
  assertMetricId(value.metricId, `${label}.metricId`);
  if (value.unit !== METRIC_UNITS[value.metricId]) fail(`${label}.unit is not canonical.`);
  const expectedDirection = LOWER_IS_BETTER.has(value.metricId) ? 'lower-is-better' : 'higher-is-better';
  if (value.direction !== expectedDirection) fail(`${label}.direction is not canonical.`);
  if (value.qualityGuardrail !== QUALITY_SET.has(value.metricId)) fail(`${label}.qualityGuardrail is not canonical.`);
  finite(value.baselineValue, `${label}.baselineValue`, { maximum: RATE_METRICS.has(value.metricId) ? 1 : SGOS_EVALUATION_LIMITS.maximumMetricValue });
  finite(value.candidateValue, `${label}.candidateValue`, { maximum: RATE_METRICS.has(value.metricId) ? 1 : SGOS_EVALUATION_LIMITS.maximumMetricValue });
  if (typeof value.delta !== 'number' || !Number.isFinite(value.delta)
      || Math.abs(value.delta) > SGOS_EVALUATION_LIMITS.maximumMetricValue) fail(`${label}.delta must be finite and bounded.`);
  finite(value.tolerance, `${label}.tolerance`);
  if (!['improved', 'regressed', 'unchanged'].includes(value.assessment)) fail(`${label}.assessment is invalid.`);
  for (const field of ['minimumSampleCount', 'baselineSampleCount', 'candidateSampleCount']) integer(value[field], `${label}.${field}`, {
    minimum: 1, maximum: SGOS_EVALUATION_LIMITS.maximumOutcomesPerArm
  });
  digest(value.baselineEvidenceSha256, `${label}.baselineEvidenceSha256`);
  digest(value.candidateEvidenceSha256, `${label}.candidateEvidenceSha256`);
  const directed = LOWER_IS_BETTER.has(value.metricId) ? -value.delta : value.delta;
  const expected = directed > value.tolerance ? 'improved' : directed < -value.tolerance ? 'regressed' : 'unchanged';
  if (value.assessment !== expected) fail(`${label}.assessment does not match its values and tolerance.`);
}

function validateResult(record, requireHash = true) {
  checkBase(record, {
    family: 'sgos-evaluation-result', kind: 'sgos-evaluation-result', hashField: 'resultSha256',
    allowed: [
      'evaluationId', 'studySha256', 'baselineArmSha256', 'candidateArmSha256',
      'status', 'classification', 'comparisons', 'qualityGuardrailRegressions', 'reasons',
      'evaluatedAt', 'readOnly'
    ],
    required: [
      'evaluationId', 'studySha256', 'baselineArmSha256', 'candidateArmSha256',
      'status', 'classification', 'comparisons', 'qualityGuardrailRegressions', 'reasons',
      'evaluatedAt', 'readOnly'
    ], requireHash
  });
  identifier(record.evaluationId, 'sgos-evaluation-result.evaluationId');
  for (const field of ['studySha256', 'baselineArmSha256', 'candidateArmSha256']) digest(record[field], `sgos-evaluation-result.${field}`);
  if (!['valid', 'inconclusive', 'invalid'].includes(record.status)) fail('sgos-evaluation-result.status is invalid.');
  if (!SGOS_EVALUATION_CLASSIFICATIONS.includes(record.classification)) fail('sgos-evaluation-result.classification is invalid.');
  if (!Array.isArray(record.comparisons) || record.comparisons.length > SGOS_EVALUATION_METRICS.length) fail('sgos-evaluation-result.comparisons is invalid.');
  record.comparisons.forEach((entry, index) => validateComparison(entry, `sgos-evaluation-result.comparisons[${index}]`));
  const expectedOrder = SGOS_EVALUATION_METRICS.filter((id) => record.comparisons.some((entry) => entry.metricId === id));
  if (canonicalJson(record.comparisons.map((entry) => entry.metricId)) !== canonicalJson(expectedOrder)) {
    fail('sgos-evaluation-result.comparisons must be unique and in canonical metric order.');
  }
  if (!Array.isArray(record.qualityGuardrailRegressions)
      || record.qualityGuardrailRegressions.some((id) => !QUALITY_SET.has(id))
      || new Set(record.qualityGuardrailRegressions).size !== record.qualityGuardrailRegressions.length) {
    fail('sgos-evaluation-result.qualityGuardrailRegressions is invalid.');
  }
  const expectedRegressions = record.comparisons.filter((entry) => entry.qualityGuardrail && entry.assessment === 'regressed')
    .map((entry) => entry.metricId);
  if (canonicalJson(record.qualityGuardrailRegressions) !== canonicalJson(expectedRegressions)) {
    fail('sgos-evaluation-result.qualityGuardrailRegressions does not match comparisons.');
  }
  if (!Array.isArray(record.reasons) || record.reasons.length > SGOS_EVALUATION_LIMITS.maximumReasons
      || record.reasons.some((reason) => typeof reason !== 'string' || !reason || Buffer.byteLength(reason, 'utf8') > 256)
      || new Set(record.reasons).size !== record.reasons.length
      || canonicalJson(record.reasons) !== canonicalJson([...record.reasons].sort(compareSgosCodePoints))) {
    fail('sgos-evaluation-result.reasons must be unique, bounded, and sorted.');
  }
  if (record.status === 'invalid' && record.classification !== 'invalid-study') fail('Invalid evaluation results must classify as invalid-study.');
  if (record.status === 'inconclusive' && record.classification !== 'inconclusive') fail('Inconclusive evaluation results must classify as inconclusive.');
  if (record.status === 'valid' && record.classification !== classifyComparisons(record.comparisons)) {
    fail('Valid evaluation result classification does not match its metric comparisons.');
  }
  timestamp(record.evaluatedAt, 'sgos-evaluation-result.evaluatedAt');
  if (record.readOnly !== true) fail('sgos-evaluation-result.readOnly must be true.');
}

/** Compare two immutable arms. Missing evidence stays inconclusive and incomparable context invalid. */
export function evaluateSgosAgenticStudy(input) {
  exactKeys(input, ['study', 'baseline', 'candidate', 'evaluatedAt'], 'agentic evaluation input');
  requireKeys(input, ['study', 'baseline', 'candidate', 'evaluatedAt'], 'agentic evaluation input');
  const study = validateSgosEvaluationStudy(input.study);
  const baseline = validateSgosEvaluationArm(input.baseline);
  const candidate = validateSgosEvaluationArm(input.candidate);
  timestamp(input.evaluatedAt, 'agentic evaluation input.evaluatedAt');

  const invalid = contextProblems(study, baseline, candidate);
  const incomplete = invalid.length ? [] : [
    ...inconclusiveReasons(study, baseline, 'baseline'),
    ...inconclusiveReasons(study, candidate, 'candidate')
  ].sort(compareSgosCodePoints);
  const comparisons = invalid.length ? [] : SGOS_EVALUATION_METRICS
    .map((metricId) => compareMetric(study, baseline, candidate, metricId)).filter(Boolean);
  const status = invalid.length ? 'invalid' : incomplete.length ? 'inconclusive' : 'valid';
  const classification = status === 'invalid' ? 'invalid-study'
    : status === 'inconclusive' ? 'inconclusive' : classifyComparisons(comparisons);
  const reasons = status === 'invalid' ? invalid : status === 'inconclusive' ? incomplete : [];
  const core = {
    evaluationId: deterministicEvaluationId(study.studySha256, baseline.armSha256, candidate.armSha256),
    studySha256: study.studySha256,
    baselineArmSha256: baseline.armSha256,
    candidateArmSha256: candidate.armSha256,
    status,
    classification,
    comparisons,
    qualityGuardrailRegressions: comparisons
      .filter((entry) => entry.qualityGuardrail && entry.assessment === 'regressed')
      .map((entry) => entry.metricId),
    reasons,
    evaluatedAt: input.evaluatedAt,
    readOnly: true
  };
  return seal('sgos-evaluation-result', 'sgos-evaluation-result', 'resultSha256', core, validateResult);
}

export function validateSgosEvaluationResult(record) {
  validateResult(record, true);
  return freezeDeep(cloneSgosValue(record));
}

function otlpAttribute(key, value) {
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  if (typeof value === 'number' && Number.isSafeInteger(value)) return { key, value: { intValue: String(value) } };
  if (typeof value === 'number') return { key, value: { doubleValue: value } };
  return { key, value: { stringValue: String(value) } };
}

/**
 * Produce an OpenTelemetry OTLP/JSON-compatible, content-free read model. Prompt export is
 * deliberately unsupported by v1; the projection has no side effects and performs no transport.
 */
export function projectSgosEvaluationOpenTelemetry(result, options = {}) {
  exactKeys(options, ['includePromptContent'], 'evaluation telemetry options');
  if (options.includePromptContent === true) {
    fail('Agentic evaluation telemetry cannot export prompt content.',
      'SGOS_EVALUATION_CONTENT_EXPORT_FORBIDDEN');
  }
  if (options.includePromptContent != null && options.includePromptContent !== false) {
    fail('evaluation telemetry options.includePromptContent must be boolean.');
  }
  const validated = validateSgosEvaluationResult(result);
  const hex = validated.resultSha256.slice(7);
  const unixNanos = (BigInt(Date.parse(validated.evaluatedAt)) * 1_000_000n).toString();
  const attributes = [
    ['gen_ai.operation.name', 'invoke_agent'],
    ['gen_ai.provider.name', 'singularity-flow'],
    ['sflow.sgos.evaluation.classification', validated.classification],
    ['sflow.sgos.evaluation.result_sha256', validated.resultSha256],
    ['sflow.sgos.evaluation.status', validated.status],
    ['sflow.sgos.evaluation.study_sha256', validated.studySha256],
    ['sflow.sgos.evaluation.quality_guardrail_regressions', validated.qualityGuardrailRegressions.length],
    ['sflow.sgos.telemetry.mode', 'content-free']
  ];
  for (const comparison of validated.comparisons) {
    attributes.push([`sflow.sgos.evaluation.metric.${comparison.metricId}.delta`, comparison.delta]);
  }
  attributes.sort(([left], [right]) => compareSgosCodePoints(left, right));
  return freezeDeep({
    schemaUrl: 'https://opentelemetry.io/schemas/1.27.0',
    telemetryMode: 'content-free',
    readOnly: true,
    resourceSpans: [{
      resource: { attributes: [otlpAttribute('service.name', 'singularity-flow')] },
      scopeSpans: [{
        scope: { name: 'singularity-flow.sgos.evaluation', version: '1' },
        spans: [{
          traceId: hex.slice(0, 32),
          spanId: hex.slice(32, 48),
          name: 'sflow.sgos.agentic_evaluation',
          kind: 1,
          startTimeUnixNano: unixNanos,
          endTimeUnixNano: unixNanos,
          attributes: attributes.map(([key, value]) => otlpAttribute(key, value)),
          status: { code: validated.status === 'invalid' ? 2 : 1 }
        }]
      }]
    }]
  });
}
