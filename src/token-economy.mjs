import { normalizeTokenEconomy } from './kernel/configuration-policy.mjs';
export { TOKEN_ECONOMY_MODES, TOKEN_ECONOMY_COMPOSERS, normalizeTokenEconomy } from './kernel/configuration-policy.mjs';
/** Closed-loop token-economy policy and quality-safe comparison classification. */
import { recordSha256 } from './records.mjs';
import { SingularityFlowError } from './util.mjs';

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
  const normalized = normalizeTokenEconomy(policy);
  if (normalized.composer === 'legacy-v1') {
    // This digest predates the composer selector. Preserve its historical preimage for the
    // byte-compatible legacy path so old Evidence Packets and telemetry remain verifiable.
    // A non-legacy composer is a new semantic input and therefore receives a distinct digest.
    const legacyPreimage = { ...normalized };
    delete legacyPreimage.composer;
    return recordSha256(legacyPreimage);
  }
  return recordSha256(normalized);
}

/**
 * Classify an IMP comparison without weakening its cohort, assurance, privacy, or quality gates.
 * This is a projection only; IMP remains the source of comparison truth.
 */
export function classifyTokenOptimization(comparison) {
  if (!comparison) return Object.freeze({ state: 'unavailable', releaseClaimAllowed: false, reason: 'comparison unavailable' });
  if (comparison.primaryMetric?.unit !== 'tokens') {
    return Object.freeze({ state: 'unavailable', releaseClaimAllowed: false, reason: 'the primary metric is not a provider-token metric' });
  }
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
  if (comparison.measurementAssurance?.primary?.providerTokenEvidence !== true) {
    return Object.freeze({ state: 'inconclusive', releaseClaimAllowed: false, reason: 'matched exact provider-token evidence is incomplete' });
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
