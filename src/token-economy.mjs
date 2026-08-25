/** Closed-loop token-economy policy and quality-safe comparison classification. */
import { recordSha256 } from './records.mjs';
import { SingularityFlowError } from './util.mjs';

export const TOKEN_ECONOMY_MODES = Object.freeze(['off', 'observe', 'assist', 'enforce']);
const PROVIDER_TELEMETRY_MODES = Object.freeze(['off', 'optional', 'required']);
const CAPABILITY_MODES = Object.freeze(['off', 'optional', 'required']);
const BREACH_POLICIES = Object.freeze(['refuse', 'partial']);

const DEFAULT_PROFILE = Object.freeze({
  maximumEstimatedPromptTokens: 18_000,
  reservedOutputTokens: 6_000,
  maxExpansionTokens: 8_000,
  observationCapsuleTokens: 3_000,
  policyOnBudgetBreach: 'refuse'
});

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError(`${label} must be an object.`);
  }
  return value;
}

function integer(value, fallback, label, { minimum = 0, maximum = 1_000_000 } = {}) {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < minimum || selected > maximum) {
    throw new SingularityFlowError(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return selected;
}

function enumeration(value, fallback, allowed, label) {
  const selected = value ?? fallback;
  if (!allowed.includes(selected)) {
    throw new SingularityFlowError(`${label} must be ${allowed.join(', ')}; got '${selected}'.`);
  }
  return selected;
}

function enabled(value, fallback, label) {
  const selected = value ?? fallback;
  if (typeof selected !== 'boolean') throw new SingularityFlowError(`${label} must be true or false.`);
  return selected;
}

function normalizeProfile(value, label) {
  const source = object(value ?? {}, label);
  for (const key of Object.keys(source)) if (![
    'maximumEstimatedPromptTokens', 'maxInputTokens', 'reservedOutputTokens', 'maxExpansionTokens',
    'observationCapsuleTokens', 'policyOnBudgetBreach'
  ].includes(key)) throw new SingularityFlowError(`${label} contains unknown field '${key}'.`);
  if (source.maximumEstimatedPromptTokens != null && source.maxInputTokens != null
      && source.maximumEstimatedPromptTokens !== source.maxInputTokens) {
    throw new SingularityFlowError(`${label} cannot give maximumEstimatedPromptTokens and legacy maxInputTokens different values.`);
  }
  return Object.freeze({
    maximumEstimatedPromptTokens: integer(
      source.maximumEstimatedPromptTokens ?? source.maxInputTokens,
      DEFAULT_PROFILE.maximumEstimatedPromptTokens,
      `${label}.maximumEstimatedPromptTokens`, { minimum: 1024 }
    ),
    reservedOutputTokens: integer(source.reservedOutputTokens, DEFAULT_PROFILE.reservedOutputTokens, `${label}.reservedOutputTokens`),
    maxExpansionTokens: integer(source.maxExpansionTokens, DEFAULT_PROFILE.maxExpansionTokens, `${label}.maxExpansionTokens`),
    observationCapsuleTokens: integer(source.observationCapsuleTokens, DEFAULT_PROFILE.observationCapsuleTokens, `${label}.observationCapsuleTokens`),
    policyOnBudgetBreach: enumeration(
      source.policyOnBudgetBreach, DEFAULT_PROFILE.policyOnBudgetBreach,
      BREACH_POLICIES, `${label}.policyOnBudgetBreach`
    )
  });
}

/**
 * Normalize the repository policy. Observe is intentionally the compatibility default: it records
 * honest measurements but does not replace the context a host already sends to an agent.
 */
export function normalizeTokenEconomy(value = {}) {
  const source = object(value ?? {}, 'tokenEconomy');
  for (const key of Object.keys(source)) if (![
    'enabled', 'mode', 'profile', 'profiles', 'observationFirewall', 'progressiveRetrieval',
    'historicalMemory', 'cacheStableComposition', 'providerTelemetry', 'ast'
  ].includes(key)) throw new SingularityFlowError(`tokenEconomy contains unknown field '${key}'.`);
  const isEnabled = enabled(source.enabled, true, 'tokenEconomy.enabled');
  const declaredMode = enumeration(source.mode, 'observe', TOKEN_ECONOMY_MODES, 'tokenEconomy.mode');
  const mode = isEnabled ? declaredMode : 'off';
  const profile = String(source.profile ?? 'standard').trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profile)) {
    throw new SingularityFlowError('tokenEconomy.profile must be lower-case kebab-case.');
  }
  const declaredProfiles = object(source.profiles ?? { standard: DEFAULT_PROFILE }, 'tokenEconomy.profiles');
  const profiles = Object.fromEntries(Object.entries(declaredProfiles).map(([id, definition]) => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      throw new SingularityFlowError(`tokenEconomy profile '${id}' must be lower-case kebab-case.`);
    }
    return [id, normalizeProfile(definition, `tokenEconomy.profiles.${id}`)];
  }));
  if (!profiles[profile]) throw new SingularityFlowError(`tokenEconomy.profile references unknown profile '${profile}'.`);
  const normalized = {
    enabled: isEnabled,
    mode,
    profile,
    profiles,
    observationFirewall: enabled(source.observationFirewall, true, 'tokenEconomy.observationFirewall'),
    progressiveRetrieval: enabled(source.progressiveRetrieval, true, 'tokenEconomy.progressiveRetrieval'),
    historicalMemory: enabled(source.historicalMemory, false, 'tokenEconomy.historicalMemory'),
    cacheStableComposition: enabled(source.cacheStableComposition, true, 'tokenEconomy.cacheStableComposition'),
    providerTelemetry: enumeration(source.providerTelemetry, 'optional', PROVIDER_TELEMETRY_MODES, 'tokenEconomy.providerTelemetry'),
    ast: enumeration(source.ast, 'optional', CAPABILITY_MODES, 'tokenEconomy.ast')
  };
  return Object.freeze(normalized);
}

export function selectedTokenEconomyProfile(policy, requestedProfile = null) {
  const normalized = normalizeTokenEconomy(policy);
  const id = requestedProfile ?? normalized.profile;
  if (!normalized.profiles[id]) {
    throw new SingularityFlowError(`Unknown approved token-economy profile '${id}'.`, {
      code: 'TKN_PROFILE_NOT_APPROVED',
      details: { approvedProfiles: Object.keys(normalized.profiles).sort() }
    });
  }
  return Object.freeze({ id, ...normalized.profiles[id] });
}

export function tokenEconomyDigest(policy) {
  return recordSha256(normalizeTokenEconomy(policy));
}

/**
 * Classify an IMP comparison without weakening its cohort, assurance, privacy, or quality gates.
 * This is a projection only; IMP remains the source of comparison truth.
 */
export function classifyTokenOptimization(comparison) {
  if (!comparison) return Object.freeze({ state: 'unavailable', releaseClaimAllowed: false, reason: 'comparison unavailable' });
  const baseline = Number(comparison.cohorts?.matchedBaseline ?? 0);
  const treatment = Number(comparison.cohorts?.matchedTreatment ?? 0);
  const privacyFloor = Number(comparison.cohorts?.privacyFloor ?? 0);
  const gain = comparison.result?.gainPercent;
  const assurance = comparison.evidenceGrade ?? 'unavailable';
  if (!baseline || !treatment) {
    return Object.freeze({ state: 'unavailable', releaseClaimAllowed: false, reason: 'no compatible baseline and treatment cohort' });
  }
  if (baseline < privacyFloor || treatment < privacyFloor || !Number.isFinite(gain)
      || ['unavailable', 'low', 'C'].includes(assurance)) {
    return Object.freeze({ state: 'inconclusive', releaseClaimAllowed: false, reason: 'sample or assurance floor is not met' });
  }
  const qualityHeld = comparison.qualityGatePassed !== false
    && (comparison.guardrails ?? []).every((guardrail) => guardrail.passed !== false);
  if (gain > 0 && !qualityHeld) {
    return Object.freeze({ state: 'cheaper-but-worse', releaseClaimAllowed: false, reason: 'token metric improved but the quality floor regressed' });
  }
  if (gain > 0 && qualityHeld) {
    return Object.freeze({ state: 'improved', releaseClaimAllowed: true, reason: 'token metric improved and the quality floor held' });
  }
  return Object.freeze({ state: 'no-improvement', releaseClaimAllowed: false, reason: 'the primary token metric did not improve' });
}
