import { sha256 } from '../../canonicalize.mjs';
import { contractFailure } from '../../contracts.mjs';
import { validateScopeManifest } from '../../scope/manifest.mjs';
import { validateViewContract } from '../../registry/views.mjs';
import { implementationSha256, result, unavailableDraft } from './common.mjs';

export const LEGACY_MIGRATION_RESOLUTION_ID = 'legacy-migration-resolution';
export const LEGACY_MIGRATION_RESOLUTION_VERSION = '1.0.0';
export const LEGACY_MIGRATION_RESOLUTION_IMPLEMENTATION_SHA256 = implementationSha256(
  LEGACY_MIGRATION_RESOLUTION_ID,
  LEGACY_MIGRATION_RESOLUTION_VERSION,
  'claim-digest-only-typed-unavailable-resolution-v1'
);

export function legacyMigrationUnavailableSubjectId({
  sourceViewSha256, sourceClaimIndex, sourceClaimSha256
} = {}) {
  return `legacy-migration:${sha256({
    sourceViewSha256, sourceClaimIndex, sourceClaimSha256
  }).slice(7)}`;
}

function migrationFactType(view) {
  // Prefer the contract's required-unavailable channel so migration gaps cannot be silently pruned
  // from the regenerated narrative. If the legacy input exceeds the hard Fact ceiling, selection
  // refuses explicitly instead of publishing a deceptively complete migration.
  const candidates = [
    ...view.factPolicy.requiredUnavailableSubjects,
    ...view.factPolicy.optionalFactTypes,
    ...view.factPolicy.requiredFactTypes
  ];
  const selected = candidates.find((factType) => view.factPolicy.allowedStatus.includes('unavailable'));
  if (!selected) {
    contractFailure(
      `View '${view.id}@${view.version}' has no Fact type that can represent an unavailable legacy claim.`,
      'WMB_MIGRATION_UNAVAILABLE_FACT_UNREPRESENTABLE'
    );
  }
  return selected;
}

function migrationSubjectKind(scope) {
  const preferred = ['analysis', 'repository'];
  return preferred.find((kind) => scope.allowedSubjects.includes(kind))
    ?? contractFailure(
      "The current Scope Manifest must admit 'analysis' or 'repository' subjects for deterministic legacy migration results.",
      'WMB_MIGRATION_UNAVAILABLE_FACT_UNREPRESENTABLE'
    );
}

/**
 * Convert unresolved legacy claim identities into registered *unavailable* Fact drafts.
 *
 * The producer deliberately receives no prose. Only the source-view digest, claim index, claim
 * digest, and non-authoritative evidence candidate strings cross this boundary. Consequently a
 * legacy/model-authored sentence can never become a v4 Fact claim or assurance assertion.
 */
export function extractLegacyMigrationUnavailableFacts({
  sourceViewSha256,
  unresolvedClaims = [],
  scopeManifest,
  viewContract
} = {}) {
  if (!/^sha256:[a-f0-9]{64}$/.test(String(sourceViewSha256 ?? ''))) {
    contractFailure('Legacy migration requires the exact source-view SHA-256.', 'WMB_MIGRATION_SOURCE_INVALID');
  }
  if (!Array.isArray(unresolvedClaims)) {
    contractFailure('Legacy migration unresolved claims must be an array.', 'WMB_MIGRATION_SOURCE_INVALID');
  }
  const scope = validateScopeManifest(scopeManifest);
  const view = validateViewContract(viewContract);
  const factType = migrationFactType(view);
  const subjectKind = migrationSubjectKind(scope);
  const seen = new Set();
  const facts = unresolvedClaims.map((entry, position) => {
    if (!Number.isSafeInteger(entry?.sourceClaimIndex) || entry.sourceClaimIndex < 0
        || !/^sha256:[a-f0-9]{64}$/.test(String(entry?.sourceClaimSha256 ?? ''))
        || entry?.status !== 'unavailable') {
      contractFailure(
        `Legacy migration unresolved claim ${position} is not a typed claim identity.`,
        'WMB_MIGRATION_SOURCE_INVALID'
      );
    }
    if (seen.has(entry.sourceClaimIndex)) {
      contractFailure(
        `Legacy migration repeats claim index ${entry.sourceClaimIndex}.`,
        'WMB_MIGRATION_SOURCE_INVALID'
      );
    }
    seen.add(entry.sourceClaimIndex);
    return unavailableDraft({
      factType,
      subject: {
        kind: subjectKind,
        id: legacyMigrationUnavailableSubjectId({
          sourceViewSha256,
          sourceClaimIndex: entry.sourceClaimIndex,
          sourceClaimSha256: entry.sourceClaimSha256
        })
      },
      attemptedProducer: LEGACY_MIGRATION_RESOLUTION_ID,
      code: 'NO_REGISTERED_PRODUCER',
      detail: `Legacy claim ${entry.sourceClaimIndex} (${entry.sourceClaimSha256}) did not resolve to exactly one current registered Fact.`
    });
  });
  return result(LEGACY_MIGRATION_RESOLUTION_ID, [], facts);
}
