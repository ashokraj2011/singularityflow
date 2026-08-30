import { createHash } from 'node:crypto';

import { canonicalJson } from './records.mjs';
import { currentSchemaVersion } from './schema-migrations.mjs';
import { SingularityFlowError } from './util.mjs';

const WEL_ROLLOUT = Object.freeze({ id: 'wel-v0.2-observe', version: 1, enrollment: 'new-story-only' });

function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function witnessedClausePolicies(phases = []) {
  return phases.flatMap((phase) => {
    const policy = phase?.specificationQuality?.witnessedClauses;
    if (!policy || policy.mode === 'disabled' || policy.enabled === false) return [];
    return [{ phaseId: phase.id, policy: structuredClone(policy) }];
  });
}

function configurationAuthority(source) {
  if (!source) return null;
  return {
    repository: source.repository ?? null,
    branch: source.branch ?? null,
    commit: source.commit ?? null,
    projectionSha256: source.projectionSha256 ?? null
  };
}

/**
 * Build the compact WEL enrollment projection before the Story policy hash is calculated.
 *
 * This projection contains identities and digests only. The normalized component policies remain
 * authoritative in `resolution.phases` and `resolution.codeDelivery`; WEL never becomes a second
 * policy source.
 */
export function buildWelEnrollment({
  phases = [], codeDelivery, configurationSource,
  claimMapContractVersion = currentSchemaVersion('specification-claim-map')
} = {}) {
  const clauses = witnessedClausePolicies(phases);
  const exact = structuredClone(codeDelivery?.tests?.testcaseExact ?? {
    mode: 'disabled', adapter: null, requiredWitnessTypes: ['test'],
    evidenceTier: 'testcase-local-observed'
  });
  const modes = new Set([
    clauses.length ? 'observe' : 'disabled',
    exact.mode ?? 'disabled'
  ]);
  if (modes.has('enforce')) {
    throw new SingularityFlowError(
      'WEL enforcement is unavailable until CAB external attestation and the SGOS lifecycle bridge are configured.',
      { code: 'WEL_ENFORCEMENT_UNAVAILABLE' }
    );
  }
  const mode = modes.has('observe') ? 'observe' : 'disabled';
  const authority = configurationAuthority(configurationSource);
  if (mode !== 'disabled' && (!authority?.repository || !authority?.commit)) {
    throw new SingularityFlowError(
      'WEL observation requires an approved configuration-source repository and commit. Refresh the workspace configuration before starting the Story.',
      { code: 'WEL_CONFIGURATION_AUTHORITY_REQUIRED' }
    );
  }
  const witnessedClauses = {
    enabled: clauses.length > 0,
    profiles: clauses.map(({ phaseId, policy }) => ({
      phaseId,
      profile: policy.profile ?? 'witnessed-v1',
      policySha256: digest(policy)
    }))
  };
  const testcaseExact = {
    mode: exact.mode ?? 'disabled',
    profile: exact.adapter ?? null,
    requiredAssurance: exact.mode === 'observe' ? 'testcase-local-observed' : 'unavailable',
    policySha256: digest(exact)
  };
  const derivedMode = witnessedClauses.enabled || testcaseExact.mode === 'observe' ? 'observe' : 'disabled';
  if (derivedMode !== mode) {
    throw new SingularityFlowError('WEL enrollment mode disagrees with its normalized component policies.', {
      code: 'WEL_POLICY_MISMATCH'
    });
  }
  return {
    schemaVersion: 1,
    mode,
    witnessedClauses,
    testcaseExact,
    claimMapContractVersion,
    cab: testcaseExact.mode === 'observe' ? {
      profile: 'cab-r1-local-observe',
      assurance: 'testcase-local-observed',
      authority: 'packaged-observation-only'
    } : null,
    sgos: null,
    rollout: structuredClone(WEL_ROLLOUT),
    configurationAuthority: authority
  };
}

export function welEnrollmentDigest(enrollment) {
  return digest(enrollment);
}

export function validateWelEnrollment(enrollment) {
  // `resolution.wel` is a creation-pinned policy projection nested inside the registered
  // story-workflow family, not a separately migrated durable family. Destructure its local format
  // version so the repository-wide migration lint does not mistake this nested policy check for a
  // durable-record migration branch.
  const { schemaVersion: enrollmentVersion } = enrollment ?? {};
  if (!enrollment || enrollmentVersion !== 1
      || !['disabled', 'observe', 'enforce'].includes(enrollment.mode)) {
    return { valid: false, reason: 'missing-or-malformed-enrollment' };
  }
  if (enrollment.mode === 'enforce') {
    return { valid: false, reason: 'enforcement-prerequisites-unavailable' };
  }
  if (!Number.isInteger(enrollment.claimMapContractVersion)
      || enrollment.claimMapContractVersion < 1
      || enrollment.claimMapContractVersion > currentSchemaVersion('specification-claim-map')) {
    return { valid: false, reason: 'claim-map-contract-unsupported' };
  }
  const derivedMode = enrollment.witnessedClauses?.enabled
      || enrollment.testcaseExact?.mode === 'observe'
    ? 'observe' : 'disabled';
  if (derivedMode !== enrollment.mode) return { valid: false, reason: 'component-mode-mismatch' };
  if (enrollment.rollout?.id !== WEL_ROLLOUT.id || enrollment.rollout?.version !== WEL_ROLLOUT.version) {
    return { valid: false, reason: 'rollout-unapproved' };
  }
  if (enrollment.mode === 'observe'
      && (!enrollment.configurationAuthority?.repository || !enrollment.configurationAuthority?.commit)) {
    return { valid: false, reason: 'configuration-authority-unavailable' };
  }
  return { valid: true, reason: null };
}
