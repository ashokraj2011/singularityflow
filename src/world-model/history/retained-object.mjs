import { readRecord, schemaFamily } from '../../schema-migrations.mjs';
import { SingularityFlowError } from '../../util.mjs';
import { canonicalJson, sha256 } from '../canonicalize.mjs';
import { validateHistoricalDerivationCatalog } from '../extract/derivation-catalog.mjs';
import { validateEvidenceCatalog } from '../extract/evidence-catalog.mjs';
import { validateHistoricalFactLedger } from '../extract/fact-ledger.mjs';
import { validateViewFactLedger } from '../extract/selection.mjs';
import {
  validateHistoricalExtractorManifest, validateHistoricalExtractorRegistry
} from '../registry/extractors.mjs';
import { validateViewContract } from '../registry/views.mjs';
import {
  validateWorldModelConsumerProfile, validateWorldModelOutputBudget
} from '../plan.mjs';
import { validateScopeManifest } from '../scope/manifest.mjs';
import { validateSourceSnapshot } from '../source/snapshot.mjs';
import {
  validateWorldModelViewValidationReceipt
} from '../validate/candidate.mjs';
import {
  validateWorldModelCompletenessRecord, validateWorldModelExtractionPolicy,
  validateWorldModelRepositoryDomain
} from './model-owners.mjs';
import { WMP_RECORD_FAMILIES, parseCanonicalWmpRecordBytes } from './contracts.mjs';
import {
  WMP_MAXIMUM_OBJECT_BYTES, WMP_RENDERED_OBJECT_ROLES, validateWmpObjectRef
} from './identity.mjs';

const RENDERED_ROLES = new Set(WMP_RENDERED_OBJECT_ROLES);

// The draft names these authority dependencies, but the current codebase has no registered
// semantic owner for them. Refuse them instead of relabelling an unrelated registered record.
const MISSING_OWNER_ROLES = new Set([
  'admission-proof',
  'adoption-authorization',
  'origin-authority',
  'publication-receipt',
  'renderer-contract',
  'source-authority',
  'target-authority',
  'tokenizer',
  'validator-contract'
]);

// These roles have first-class existing record families. Bind the semantic role as well as the
// family so a valid record cannot be accepted after being relabelled as a different dependency.
const OWNED_ROLE_FAMILIES = Object.freeze({
  'completeness-record': 'world-model-completeness-record',
  'consumer-profile': 'world-model-consumer-profile',
  'extraction-policy': 'world-model-extraction-policy',
  'extractor-registry': 'world-model-extractor-registry',
  'output-budget': 'world-model-output-budget',
  'repository-domain': 'world-model-repository-domain',
  'validator-receipt': 'world-model-view-validation-receipt'
});
const OWNED_FAMILY_ROLES = Object.freeze(Object.fromEntries(
  Object.entries(OWNED_ROLE_FAMILIES).map(([role, family]) => [family, role])
));

const OWNER_VALIDATORS = Object.freeze({
  'world-model-completeness-record': validateWorldModelCompletenessRecord,
  'world-model-consumer-profile': validateWorldModelConsumerProfile,
  'world-model-derivation-catalog': validateHistoricalDerivationCatalog,
  'world-model-evidence-catalog': validateEvidenceCatalog,
  'world-model-extraction-policy': validateWorldModelExtractionPolicy,
  'world-model-extractor-manifest': validateHistoricalExtractorManifest,
  'world-model-extractor-registry': validateHistoricalExtractorRegistry,
  'world-model-fact-ledger': validateHistoricalFactLedger,
  'world-model-output-budget': validateWorldModelOutputBudget,
  'world-model-repository-domain': validateWorldModelRepositoryDomain,
  'world-model-scope-manifest': validateScopeManifest,
  'world-model-source-snapshot': validateSourceSnapshot,
  'world-model-view-contract': validateViewContract,
  'world-model-view-fact-ledger': validateViewFactLedger,
  'world-model-view-validation-receipt': validateWorldModelViewValidationReceipt
});

function fail(message, code, details = {}, cause = undefined) {
  throw new SingularityFlowError(message, { code, details, cause });
}

export function validateRetainedObjectReference(ref) {
  return validateWmpObjectRef(ref, {
    rendered: ref?.family === null && RENDERED_ROLES.has(ref?.role)
  });
}

/**
 * Validate exact retained bytes through their semantic owner. MIG establishes schema readability;
 * it is not a substitute for the owning record validator.
 */
export function parseExactRetainedObject(refValue, rawBytes) {
  const ref = validateRetainedObjectReference(refValue);
  if (!(Buffer.isBuffer(rawBytes) || rawBytes instanceof Uint8Array)) {
    fail(`Retained object '${ref.role}' must be supplied as exact bytes.`,
      'WMP_CANONICAL_BYTES_REQUIRED', { role: ref.role, family: ref.family });
  }
  const bytes = Buffer.from(rawBytes);
  if (!bytes.length || bytes.length > WMP_MAXIMUM_OBJECT_BYTES) {
    fail(`Retained object '${ref.role}' exceeds the per-object byte limit.`,
      'WMP_CONTRACT_LIMIT', {
        role: ref.role,
        bytes: bytes.length,
        maximumBytes: WMP_MAXIMUM_OBJECT_BYTES
      });
  }
  const observedSha256 = sha256(bytes);
  if (bytes.length !== ref.bytes || observedSha256 !== ref.sha256) {
    fail(`Retained object '${ref.role}' does not match its exact reference.`,
      'WMP_INTEGRITY_FAILED', {
        role: ref.role,
        expectedBytes: ref.bytes,
        observedBytes: bytes.length,
        expectedSha256: ref.sha256,
        observedSha256
      });
  }
  if (ref.family === null) return null;
  const ownedFamily = OWNED_ROLE_FAMILIES[ref.role];
  if (ownedFamily !== undefined && ref.family !== ownedFamily) {
    fail(`Retained role '${ref.role}' must use its semantic owner family '${ownedFamily}'.`,
      'WMP_OBJECT_FAMILY_MISMATCH', {
        role: ref.role, expectedFamily: ownedFamily, receivedFamily: ref.family
      });
  }
  const ownedRole = OWNED_FAMILY_ROLES[ref.family];
  if (ownedRole !== undefined && ref.role !== ownedRole) {
    fail(`Retained family '${ref.family}' is owned by semantic role '${ownedRole}', not '${ref.role}'.`,
      'WMP_OBJECT_ROLE_MISMATCH', {
        family: ref.family, expectedRole: ownedRole, receivedRole: ref.role
      });
  }
  if (MISSING_OWNER_ROLES.has(ref.role)) {
    fail(`Retained role '${ref.role}' has no installed semantic owner contract.`,
      'WMP_OBJECT_OWNER_UNAVAILABLE', { role: ref.role, family: ref.family });
  }
  if (WMP_RECORD_FAMILIES.includes(ref.family)) {
    return parseCanonicalWmpRecordBytes(ref.family, bytes, { maximumBytes: ref.bytes });
  }

  let parsed;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch (error) {
    fail(`Retained object '${ref.role}' is not valid UTF-8 canonical JSON.`,
      'WMP_CANONICAL_BYTES_REQUIRED', { role: ref.role, family: ref.family }, error);
  }
  // Preserve exact historical bytes: canonicality applies before MIG's in-memory projection.
  if (!Buffer.from(canonicalJson(parsed), 'utf8').equals(bytes)) {
    fail(`Retained object '${ref.role}' is not canonical JSON.`,
      'WMP_CANONICAL_BYTES_REQUIRED', { role: ref.role, family: ref.family });
  }
  try { schemaFamily(ref.family); }
  catch (error) {
    fail(`Retained object '${ref.role}' names an unsupported family.`,
      'WMP_READER_UNSUPPORTED', { role: ref.role, family: ref.family }, error);
  }
  const validator = OWNER_VALIDATORS[ref.family];
  if (!validator) {
    fail(`Retained family '${ref.family}' has no installed WMP owner adapter.`,
      'WMP_OBJECT_OWNER_UNAVAILABLE', { role: ref.role, family: ref.family });
  }
  let migrated;
  try { migrated = readRecord(ref.family, parsed).record; }
  catch (error) {
    fail(`Retained family '${ref.family}' is not readable by this build.`,
      'WMP_READER_UNSUPPORTED', { role: ref.role, family: ref.family }, error);
  }
  try { return validator(migrated); }
  catch (error) {
    fail(`Retained object '${ref.role}' failed its semantic owner validator.`,
      'WMP_INTEGRITY_FAILED', { role: ref.role, family: ref.family }, error);
  }
}
