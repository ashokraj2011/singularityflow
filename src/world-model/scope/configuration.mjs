import path from 'node:path';

import { sha256 } from '../canonicalize.mjs';
import { normalizeScopePattern } from './manifest.mjs';

const DEFAULT_EXCLUDED_ROOTS = Object.freeze([
  '.git/**', '.sflow/**', '.singularity-flow/**', 'singularity/**', '.github/agents/**'
]);
const CAPABILITY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Resolve the portable capability identity used by registered-v4 scope planning.
 *
 * This lives beside the Scope Manifest rather than in the CLI command module so every producer
 * (CLI planning and persisted-model admission included) interprets an approved configuration cut
 * with one implementation.
 */
export function configuredWorldModelV4CapabilityId(config) {
  const pinned = config.workflow?.resolution?.capability ?? null;
  const repositoryCapability = config.repositoryCapability ?? null;
  const candidate = pinned?.id
    ?? config.workflow?.resolution?.capabilityId
    ?? repositoryCapability?.id
    ?? null;
  return typeof candidate === 'string' && CAPABILITY_ID.test(candidate) ? candidate : null;
}

/**
 * Derive the complete policy-controlled Scope Manifest input from approved/pinned configuration.
 * Caller-supplied path arrays are intentionally not accepted by this boundary.
 */
export function configuredWorldModelV4ScopeOptions(root, config) {
  const policy = config.definition?.worldModel ?? {};
  const activeCapability = configuredWorldModelV4CapabilityId(config)
    ?? path.basename(root);
  const pinnedCapability = config.workflow?.resolution?.capability ?? null;
  const repositoryCapability = config.repositoryCapability ?? null;
  const pinnedHasExactResolution = Boolean(
    pinnedCapability?.effectiveResolution || pinnedCapability?.resolutionSha256
  );
  const selectedCapability = pinnedHasExactResolution
    ? pinnedCapability
    : (!pinnedCapability || pinnedCapability.id === repositoryCapability?.id)
      ? repositoryCapability
      : pinnedCapability;
  const effective = selectedCapability?.effectiveResolution ?? null;
  // Bind every capability component that can alter World-Model scope or trust. The full PCD
  // resolution also binds the byte-exact approved workflow; excluding that outer digest here keeps
  // semantically equivalent path spellings and unrelated workflow controls reusable.
  const effectiveCapabilitySnapshotSha256 = effective
    ? sha256({
        repository: effective.repository,
        capabilityId: effective.capability?.id ?? selectedCapability?.id ?? null,
        policySha256: effective.policySha256,
        sourceScopeSha256: effective.sourceScopeSha256,
        approvalRequirementSha256: effective.approvalRequirementSha256,
        dependencyContractSha256: effective.dependencyContractSha256,
        resolver: effective.resolver
      })
    : selectedCapability?.resolutionSha256 ?? null;
  const canonicalPatterns = (values, label) => [...new Set(values.map(
    (value, index) => normalizeScopePattern(value, `${label}[${index}]`)
  ))].sort();
  const excluded = canonicalPatterns([
    ...DEFAULT_EXCLUDED_ROOTS,
    ...(policy.excludedRoots ?? [])
  ], 'World-model excluded roots');
  const allowedPaths = policy.sourceRoots?.length
    ? canonicalPatterns(policy.sourceRoots, 'World-model source roots') : ['**'];
  const sharedPaths = canonicalPatterns(policy.sharedRoots ?? [], 'World-model shared roots');
  const allowedSubjects = policy.allowedSubjects?.length
    ? [...new Set(policy.allowedSubjects)].sort() : null;
  const maximumTraversalDepth = policy.maximumTraversalDepth ?? 8;
  // Only approved source/scope policy participates in the reusable scope identity. Read behavior,
  // staleness handling, UI injection, worker parallelism, and materialization confirmation cannot
  // change which source bytes or subjects are admissible and must not make an unchanged model stale.
  const policySnapshotSha256 = sha256({
    id: 'sflow-wmb-v4-scope-policy',
    version: 1,
    format: 'registered-v4',
    capabilityId: activeCapability,
    effectiveCapabilitySnapshotSha256,
    allowedPaths,
    sharedPaths,
    excludedPaths: excluded,
    allowedSubjects,
    maximumTraversalDepth
  });
  return {
    capabilityId: activeCapability,
    allowedPaths,
    sharedPaths,
    excludedPaths: excluded,
    ...(allowedSubjects ? { allowedSubjects } : {}),
    maximumTraversalDepth,
    policySnapshotSha256,
    policySourceSha256: policySnapshotSha256
  };
}
