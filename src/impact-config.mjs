import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { secureRepositoryPath, SingularityFlowError } from './util.mjs';

export const IMPACT_CONFIG_PATH = 'singularity/impact.yml';
export const IMPACT_SCHEMA_VERSION = 1;
export const IMPACT_BANDS = Object.freeze(['small', 'medium', 'large', 'extra-large']);
export const IMPACT_METHODS = Object.freeze(['matched-observational', 'phased-rollout', 'before-after']);

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

function normalizeStudy(study, index) {
  const label = `impact studies[${index}]`;
  object(study, label);
  only(study, ['id', 'label', 'enabled', 'unit', 'method', 'eligibility', 'groups', 'matching', 'primaryMetric', 'guardrails', 'reporting', 'privacy'], label);
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
  only(matching, ['dimensions', 'timePeriod', 'seed'], `${label}.matching`);
  const dimensions = ids(matching.dimensions ?? ['capability', 'repository-class', 'work-type', 'complexity', 'risk', 'time-period'], `${label}.matching.dimensions`);
  for (const required of ['complexity', 'risk', 'time-period']) if (!dimensions.includes(required)) throw new SingularityFlowError(`${label}.matching.dimensions must include '${required}'.`);
  const timePeriod = matching.timePeriod ?? 'quarter';
  if (!['month', 'quarter', 'half-year', 'year'].includes(timePeriod)) throw new SingularityFlowError(`${label}.matching.timePeriod is invalid.`);

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
    matching: { dimensions, timePeriod, seed: String(matching.seed ?? study.id) },
    primaryMetric: normalizeMetric(study.primaryMetric, `${label}.primaryMetric`),
    guardrails: (study.guardrails ?? []).map((metric, metricIndex) => normalizeMetric(metric, `${label}.guardrails[${metricIndex}]`, { guardrail: true })),
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
  only(value, ['version', 'automaticEnrollment', 'studies'], 'impact.yml');
  if (value.version !== IMPACT_SCHEMA_VERSION) throw new SingularityFlowError(`impact.yml version must be ${IMPACT_SCHEMA_VERSION}.`);
  if (value.automaticEnrollment != null && typeof value.automaticEnrollment !== 'boolean') throw new SingularityFlowError('impact.yml automaticEnrollment must be boolean.');
  const studies = (value.studies ?? []).map(normalizeStudy);
  if (new Set(studies.map((study) => study.id)).size !== studies.length) throw new SingularityFlowError('impact.yml contains duplicate study ids.');
  return { version: IMPACT_SCHEMA_VERSION, automaticEnrollment: value.automaticEnrollment !== false, studies };
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
