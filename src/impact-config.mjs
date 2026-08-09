import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { secureRepositoryPath, SingularityFlowError } from './util.mjs';

export const IMPACT_CONFIG_PATH = 'singularity/impact.yml';
export const IMPACT_SCHEMA_VERSION = 1;
export const IMPACT_BANDS = Object.freeze(['small', 'medium', 'large', 'extra-large']);
export const IMPACT_METHODS = Object.freeze(['matched-observational', 'phased-rollout', 'before-after']);
export const IMPACT_AUTHORITY_MODES = Object.freeze(['kernel-only', 'external-provider', 'attested', 'composite']);

export const IMPACT_METRICS = Object.freeze({
  'flow-time-excluding-approval-wait-ms': { unit: 'milliseconds', direction: 'lower' },
  'elapsed-ms': { unit: 'milliseconds', direction: 'lower' },
  'approval-wait-ms': { unit: 'milliseconds', direction: 'lower' },
  'rework-cycles': { unit: 'count', direction: 'lower' },
  rejections: { unit: 'count', direction: 'lower' },
  'self-approvals': { unit: 'count', direction: 'lower' },
  'sequence-overrides': { unit: 'count', direction: 'lower' },
  'input-tokens': { unit: 'tokens', direction: 'lower' },
  'output-tokens': { unit: 'tokens', direction: 'lower' },
  'cached-input-tokens': { unit: 'tokens', direction: 'higher' },
  'total-tokens': { unit: 'tokens', direction: 'lower' },
  'cost-usd': { unit: 'usd', direction: 'lower' },
  'first-pass-approval-rate': { unit: 'ratio', direction: 'higher' },
  'required-check-pass-rate': { unit: 'ratio', direction: 'higher' },
  'conformance-gap-count': { unit: 'count', direction: 'lower' },
  'escaped-defects': { unit: 'count', direction: 'lower' }
});

/**
 * Built through `normalizeMetricAuthority` rather than written as literals, so a default can never
 * again be a shape the validator rejects. The previous `escaped-defects` default was exactly that:
 * `external-provider` with an empty allowlist, which `normalizeMetricAuthority` refuses and which
 * only survived because the defaults bypassed it. With no allowlisted provider and no kernel
 * producer for the metric, every attempt to record it threw, and any study naming it as a guardrail
 * failed permanently regardless of the data. `attested` is what a repository can satisfy on day one;
 * `templates/impact.yml` shows how to raise it to a named provider.
 */
export const DEFAULT_IMPACT_METRIC_AUTHORITIES = Object.freeze(Object.fromEntries(
  Object.keys(IMPACT_METRICS).map((metric) => [metric, Object.freeze(normalizeMetricAuthority(
    metric === 'escaped-defects' ? { authority: 'attested' } : { authority: 'kernel-only' },
    metric
  ))])
));

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError(`${label} must be an object.`);
  return value;
}

function only(value, fields, label) {
  for (const key of Object.keys(value)) if (!fields.includes(key)) throw new SingularityFlowError(`${label} contains unknown field '${key}'.`);
}

function ids(values, label) {
  if (!Array.isArray(values)) throw new SingularityFlowError(`${label} must be an array.`);
  const normalized = values.map((item) => String(item).trim()).filter(Boolean);
  if (new Set(normalized).size !== normalized.length) throw new SingularityFlowError(`${label} must not contain duplicates.`);
  return normalized;
}

function normalizeMetric(value, label, { guardrail = false } = {}) {
  object(value, label);
  only(value, guardrail ? ['id', 'maximumRegressionPercent'] : ['id', 'direction'], label);
  if (!IMPACT_METRICS[value.id]) throw new SingularityFlowError(`${label} references unknown metric '${value.id}'.`);
  const direction = value.direction ?? IMPACT_METRICS[value.id].direction;
  if (!['higher', 'lower'].includes(direction)) throw new SingularityFlowError(`${label}.direction must be higher or lower.`);
  if (guardrail && (!Number.isFinite(value.maximumRegressionPercent) || value.maximumRegressionPercent < 0)) {
    throw new SingularityFlowError(`${label}.maximumRegressionPercent must be a non-negative number.`);
  }
  return guardrail
    ? { id: value.id, maximumRegressionPercent: value.maximumRegressionPercent, direction, unit: IMPACT_METRICS[value.id].unit }
    : { id: value.id, direction, unit: IMPACT_METRICS[value.id].unit };
}

function normalizeMetricAuthority(value, metric) {
  const label = `impact.yml metricAuthorities.${metric}`;
  object(value, label);
  only(value, ['authority', 'providers', 'reducer'], label);
  if (!IMPACT_AUTHORITY_MODES.includes(value.authority)) throw new SingularityFlowError(`${label}.authority must be ${IMPACT_AUTHORITY_MODES.join(', ')}.`);
  const providers = ids(value.providers ?? [], `${label}.providers`);
  if (value.authority === 'external-provider' && !providers.length) {
    throw new SingularityFlowError(`${label}.providers must allowlist at least one provider.`);
  }
  if (value.authority === 'composite' && value.reducer !== 'prefer-kernel') {
    throw new SingularityFlowError(`${label}.reducer must be 'prefer-kernel'.`);
  }
  if (value.authority !== 'composite' && value.reducer != null) throw new SingularityFlowError(`${label}.reducer is only valid for composite authority.`);
  return {
    authority: value.authority,
    ...(providers.length ? { providers } : {}),
    ...(value.reducer ? { reducer: value.reducer } : {})
  };
}

function normalizeRollout(value, label) {
  if (value == null) return null;
  object(value, label);
  only(value, ['declaredAt', 'waves', 'prePeriodDays', 'postPeriodDays', 'crossover', 'minimumAdherencePercent', 'requireConcurrentControl', 'requirePreTrendCheck'], label);
  const waves = (value.waves ?? []).map((wave, index) => {
    const waveLabel = `${label}.waves[${index}]`;
    object(wave, waveLabel);
    only(wave, ['id', 'activatedAt', 'capabilities'], waveLabel);
    if (!wave.id?.trim()) throw new SingularityFlowError(`${waveLabel}.id is required.`);
    if (!wave.activatedAt || Number.isNaN(Date.parse(wave.activatedAt))) throw new SingularityFlowError(`${waveLabel}.activatedAt must be an ISO timestamp.`);
    return { id: wave.id.trim(), activatedAt: wave.activatedAt, capabilities: ids(wave.capabilities ?? [], `${waveLabel}.capabilities`) };
  });
  if (waves.length < 2) throw new SingularityFlowError(`${label}.waves must contain at least two declared waves.`);
  if (!value.declaredAt || Number.isNaN(Date.parse(value.declaredAt))) throw new SingularityFlowError(`${label}.declaredAt must be an ISO timestamp.`);
  if (waves.some((wave) => Date.parse(value.declaredAt) >= Date.parse(wave.activatedAt))) throw new SingularityFlowError(`${label}.declaredAt must precede every activation.`);
  const prePeriodDays = Number(value.prePeriodDays);
  const postPeriodDays = Number(value.postPeriodDays);
  const minimumAdherencePercent = Number(value.minimumAdherencePercent);
  if (!Number.isInteger(prePeriodDays) || prePeriodDays < 1 || !Number.isInteger(postPeriodDays) || postPeriodDays < 1) throw new SingularityFlowError(`${label} pre/post periods must be positive whole days.`);
  if (!Number.isFinite(minimumAdherencePercent) || minimumAdherencePercent < 0 || minimumAdherencePercent > 100) throw new SingularityFlowError(`${label}.minimumAdherencePercent must be 0..100.`);
  if (!['exclude', 'as-treated', 'intention-to-treat'].includes(value.crossover)) throw new SingularityFlowError(`${label}.crossover is invalid.`);
  return {
    declaredAt: value.declaredAt, waves, prePeriodDays, postPeriodDays,
    crossover: value.crossover, minimumAdherencePercent,
    requireConcurrentControl: value.requireConcurrentControl !== false,
    requirePreTrendCheck: value.requirePreTrendCheck !== false
  };
}

function normalizeStudy(study, index) {
  const label = `impact studies[${index}]`;
  object(study, label);
  only(study, ['id', 'label', 'enabled', 'unit', 'method', 'eligibility', 'groups', 'matching', 'primaryMetric', 'guardrails', 'reporting', 'privacy', 'rollout'], label);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(study.id ?? '')) throw new SingularityFlowError(`${label}.id must be lower-case kebab-case.`);
  if (!study.label?.trim()) throw new SingularityFlowError(`${label}.label is required.`);
  if (study.enabled != null && typeof study.enabled !== 'boolean') throw new SingularityFlowError(`${label}.enabled must be boolean.`);
  if ((study.unit ?? 'story') !== 'story') throw new SingularityFlowError(`${label}.unit must be story in impact schema 1.`);
  if (!IMPACT_METHODS.includes(study.method)) throw new SingularityFlowError(`${label}.method must be ${IMPACT_METHODS.join(', ')}.`);

  const eligibility = object(study.eligibility ?? {}, `${label}.eligibility`);
  only(eligibility, ['workTypes', 'capabilities'], `${label}.eligibility`);
  const groups = (study.groups ?? []).map((group, groupIndex) => {
    object(group, `${label}.groups[${groupIndex}]`);
    only(group, ['id', 'label', 'assistanceMode', 'weight'], `${label}.groups[${groupIndex}]`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(group.id ?? '')) throw new SingularityFlowError(`${label}.groups[${groupIndex}].id must be lower-case kebab-case.`);
    if (!group.label?.trim()) throw new SingularityFlowError(`${label}.groups[${groupIndex}].label is required.`);
    if (!['baseline', 'assisted', 'governed-agent', 'custom'].includes(group.assistanceMode)) throw new SingularityFlowError(`${label}.groups[${groupIndex}].assistanceMode is invalid.`);
    const weight = group.weight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0) throw new SingularityFlowError(`${label}.groups[${groupIndex}].weight must be positive.`);
    return { id: group.id, label: group.label, assistanceMode: group.assistanceMode, weight };
  });
  if (groups.length !== 2) throw new SingularityFlowError(`${label}.groups must define exactly two cohorts in impact schema 1.`);
  if (new Set(groups.map((group) => group.id)).size !== groups.length) throw new SingularityFlowError(`${label}.groups contains duplicate ids.`);

  const matching = object(study.matching ?? {}, `${label}.matching`);
  only(matching, ['dimensions', 'timePeriod', 'seed', 'weighting'], `${label}.matching`);
  const dimensions = ids(matching.dimensions ?? ['capability', 'repository-class', 'work-type', 'complexity', 'risk', 'time-period'], `${label}.matching.dimensions`);
  for (const required of ['complexity', 'risk', 'time-period']) if (!dimensions.includes(required)) throw new SingularityFlowError(`${label}.matching.dimensions must include '${required}'.`);
  const timePeriod = matching.timePeriod ?? 'quarter';
  if (!['month', 'quarter', 'half-year', 'year'].includes(timePeriod)) throw new SingularityFlowError(`${label}.matching.timePeriod is invalid.`);
  const weighting = matching.weighting ?? 'minimum-cohort-count';
  if (!['equal-stratum', 'minimum-cohort-count'].includes(weighting)) throw new SingularityFlowError(`${label}.matching.weighting is invalid.`);

  const reporting = object(study.reporting ?? {}, `${label}.reporting`);
  only(reporting, ['bootstrapSamples', 'confidenceLevel'], `${label}.reporting`);
  const bootstrapSamples = reporting.bootstrapSamples ?? 1000;
  if (!Number.isInteger(bootstrapSamples) || bootstrapSamples < 100 || bootstrapSamples > 100000) throw new SingularityFlowError(`${label}.reporting.bootstrapSamples must be 100..100000.`);
  const confidenceLevel = reporting.confidenceLevel ?? 0.95;
  if (!Number.isFinite(confidenceLevel) || confidenceLevel <= 0.5 || confidenceLevel >= 1) throw new SingularityFlowError(`${label}.reporting.confidenceLevel must be between 0.5 and 1.`);

  const privacy = object(study.privacy ?? {}, `${label}.privacy`);
  only(privacy, ['individualReporting', 'minimumCohortSize', 'pseudonymizeContributors', 'allowedDimensions'], `${label}.privacy`);
  if (privacy.individualReporting === true) throw new SingularityFlowError(`${label}.privacy.individualReporting must remain false.`);
  const minimumCohortSize = privacy.minimumCohortSize ?? 5;
  if (!Number.isInteger(minimumCohortSize) || minimumCohortSize < 2) throw new SingularityFlowError(`${label}.privacy.minimumCohortSize must be at least 2.`);
  const allowedDimensions = ids(privacy.allowedDimensions ?? dimensions, `${label}.privacy.allowedDimensions`);
  for (const dimension of allowedDimensions) {
    if (!dimensions.includes(dimension)) throw new SingularityFlowError(`${label}.privacy.allowedDimensions may only contain configured matching dimensions; '${dimension}' is not configured.`);
  }

  const rollout = normalizeRollout(study.rollout, `${label}.rollout`);
  if (study.method === 'phased-rollout' && !rollout) throw new SingularityFlowError(`${label}.rollout is required for phased-rollout studies.`);
  if (study.method !== 'phased-rollout' && rollout) throw new SingularityFlowError(`${label}.rollout is only valid for phased-rollout studies.`);

  return {
    id: study.id,
    label: study.label,
    enabled: study.enabled !== false,
    unit: 'story',
    method: study.method,
    eligibility: {
      workTypes: ids(eligibility.workTypes ?? [], `${label}.eligibility.workTypes`),
      capabilities: ids(eligibility.capabilities ?? [], `${label}.eligibility.capabilities`)
    },
    groups,
    matching: { dimensions, timePeriod, seed: String(matching.seed ?? study.id), weighting },
    primaryMetric: normalizeMetric(study.primaryMetric, `${label}.primaryMetric`),
    guardrails: (study.guardrails ?? []).map((metric, metricIndex) => normalizeMetric(metric, `${label}.guardrails[${metricIndex}]`, { guardrail: true })),
    rollout,
    reporting: { bootstrapSamples, confidenceLevel },
    privacy: {
      individualReporting: false,
      minimumCohortSize,
      pseudonymizeContributors: privacy.pseudonymizeContributors !== false,
      allowedDimensions
    }
  };
}

export function normalizeImpactDefinition(value) {
  object(value, 'impact.yml');
  only(value, ['version', 'automaticEnrollment', 'metricAuthorities', 'studies'], 'impact.yml');
  if (value.version !== IMPACT_SCHEMA_VERSION) throw new SingularityFlowError(`impact.yml version must be ${IMPACT_SCHEMA_VERSION}.`);
  if (value.automaticEnrollment != null && typeof value.automaticEnrollment !== 'boolean') throw new SingularityFlowError('impact.yml automaticEnrollment must be boolean.');
  const studies = (value.studies ?? []).map(normalizeStudy);
  if (new Set(studies.map((study) => study.id)).size !== studies.length) throw new SingularityFlowError('impact.yml contains duplicate study ids.');
  const configuredAuthorities = object(value.metricAuthorities ?? {}, 'impact.yml metricAuthorities');
  for (const metric of Object.keys(configuredAuthorities)) if (!IMPACT_METRICS[metric]) throw new SingularityFlowError(`impact.yml metricAuthorities references unknown metric '${metric}'.`);
  const metricAuthorities = Object.fromEntries(Object.keys(IMPACT_METRICS).map((metric) => [
    metric,
    configuredAuthorities[metric]
      ? normalizeMetricAuthority(configuredAuthorities[metric], metric)
      : structuredClone(DEFAULT_IMPACT_METRIC_AUTHORITIES[metric])
  ]));
  return { version: IMPACT_SCHEMA_VERSION, automaticEnrollment: value.automaticEnrollment !== false, metricAuthorities, studies };
}

export async function loadImpactDefinition(root, { required = false } = {}) {
  const target = await secureRepositoryPath(root, IMPACT_CONFIG_PATH, { label: 'Impact configuration', type: 'file' });
  if (!target.exists) {
    if (required) throw new SingularityFlowError(`Missing ${IMPACT_CONFIG_PATH}.`);
    return null;
  }
  const text = await readFile(target.absolute, 'utf8');
  let parsed;
  try { parsed = YAML.parse(text); } catch (error) { throw new SingularityFlowError(`Invalid YAML in ${IMPACT_CONFIG_PATH}: ${error.message}`); }
  const definition = normalizeImpactDefinition(parsed);
  return { ...definition, path: IMPACT_CONFIG_PATH, sha256: sha256(text) };
}

export function eligibleImpactStudies(impact, { workType, capabilityId = null } = {}) {
  if (!impact?.automaticEnrollment) return [];
  return impact.studies.filter((study) => study.enabled
    && (!study.eligibility.workTypes.length || study.eligibility.workTypes.includes(workType))
    && (!study.eligibility.capabilities.length || (capabilityId && study.eligibility.capabilities.includes(capabilityId))));
}

export function deterministicStudyGroup(study, workId) {
  const point = Number.parseInt(sha256(`${study.matching.seed}:${workId}`).slice(0, 12), 16);
  const total = study.groups.reduce((sum, group) => sum + group.weight, 0);
  let cursor = point % total;
  for (const group of study.groups) {
    cursor -= group.weight;
    if (cursor < 0) return group;
  }
  return study.groups.at(-1);
}
