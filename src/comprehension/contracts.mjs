import { createHash } from 'node:crypto';

import { recordSha256 } from '../records.mjs';
import { verifyRepositoryChangeSetIntegrity } from '../repository-change-set.mjs';
import { readRecord } from '../schema-migrations.mjs';
import { SingularityFlowError } from '../util.mjs';

export const CMP_CAUSE_KINDS = Object.freeze([
  'requirement',
  'acceptance-clause',
  'clarification-answer',
  'architecture-decision',
  'design-decision',
  'risk-treatment',
  'defect',
  'incident',
  'refusal-repair',
  'verification-repair',
  'challenge-resolution',
  'amendment',
  'recovery',
  'performance-objective',
  'security-objective',
  'compliance-obligation',
  'approved-deviation',
  'deterministic-transformation',
  'reverse-converged-intent'
]);

export const CMP_RELATIONSHIPS = Object.freeze([
  'implements',
  'repairs',
  'implements-and-repairs',
  'satisfies',
  'mitigates',
  'explains-transformation'
]);

export const CMP_DISPOSITIONS = Object.freeze([
  'explained',
  'approved-deviation',
  'split',
  'revert',
  'excluded-from-publication',
  'deterministic-transformation',
  'legacy-untouched',
  'unresolved'
]);

export const CMP_PROPOSER_KINDS = Object.freeze([
  'human',
  'agent',
  'governed-agent',
  'model',
  'execution-unit',
  'copilot',
  'copilot-cli',
  'deterministic-tool'
]);

export const CMP_ASSURANCE_CLASSES = Object.freeze([
  'diff-derived',
  'structurally-derived',
  'diff-verified',
  'structurally-verified',
  'evidence-supported',
  'human-accepted',
  'model-advisory',
  'unavailable',
  'contradicted',
  'stale'
]);

export const CMP_AVAILABILITY_STATUSES = Object.freeze([
  'available',
  'unavailable',
  'unsupported',
  'degraded',
  'stale'
]);

export const CMP_REFUSAL_CODES = Object.freeze([
  'CMP_BINDING_CONFIRMATION_REQUIRED',
  'CMP_CANDIDATE_BINDING_INVALID',
  'CMP_CAUSE_AUTHORITY_INVALID',
  'CMP_CAUSE_COVERAGE_INCOMPLETE',
  'CMP_CAUSE_REFERENCE_MISSING',
  'CMP_CAUSE_REFERENCE_STALE',
  'CMP_CHANGE_SET_INVALID',
  'CMP_DEVIATION_DECISION_REQUIRED',
  'CMP_EVIDENCE_INVALID',
  'CMP_EVIDENCE_LIMIT',
  'CMP_PHASE_UNKNOWN',
  'CMP_REGION_IDENTITY_AMBIGUOUS',
  'CMP_SPLIT_TARGET_INVALID',
  'CMP_STORY_CONTEXT_REQUIRED',
  'CMP_TRANSFORMATION_RECEIPT_INVALID'
]);

export const CMP_DIAGNOSTIC_CODES = Object.freeze([
  ...new Set([
    ...CMP_REFUSAL_CODES,
    'CMP_BINDING_INTEGRITY_INVALID',
    'CMP_BINDING_INVALID',
    'CMP_BINDING_RELATIONSHIP_INVALID',
    'CMP_CAUSE_KIND_INVALID',
    'CMP_CAUSE_REFERENCE_AMBIGUOUS',
    'CMP_CAUSE_REFERENCE_INVALID',
    'CMP_DECISION_EVIDENCE_INVALID',
    'CMP_DISPOSITION_INVALID',
    'CMP_DISPOSITION_MISSING',
    'CMP_DISPOSITION_MULTIPLE',
    'CMP_EVIDENCE_AMBIGUOUS',
    'CMP_EVIDENCE_ORPHAN',
    'CMP_EXCLUSION_PENDING',
    'CMP_LEGACY_TOUCHED',
    'CMP_MANIFEST_COUNT_INVALID',
    'CMP_MANIFEST_INTEGRITY_INVALID',
    'CMP_MANIFEST_INVALID',
    'CMP_MANIFEST_ORDER_INVALID',
    'CMP_MANIFEST_SOURCE_MISMATCH',
    'CMP_REGION_FALLBACK_INVALID',
    'CMP_REGION_IDENTITY_INVALID',
    'CMP_REGION_REFERENCE_MISSING',
    'CMP_REVERT_PENDING',
    'CMP_SOURCE_CHANGE_SET_INVALID',
    'CMP_SPLIT_PENDING'
  ])
].sort());

export function assertComprehensionDiagnosticCode(code) {
  if (!CMP_DIAGNOSTIC_CODES.includes(code)) {
    throw new SingularityFlowError(`Unknown CMP diagnostic code '${code}'.`, {
      code: 'CMP_EVIDENCE_INVALID'
    });
  }
  return code;
}

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const TRANSPORT_SCHEMA = /^1$/;
const CHANGE_SET_KINDS = new Set(['repository-change-set', 'repository-tree-change-set']);
const AUTHORITATIVE_STATUSES = new Set(['approved', 'in-force', 'human-confirmed']);
const GENERIC_CAUSES = new Set([
  'cleanup', 'misc', 'ai change', 'refactor', 'fix issue', 'improve code', 'generated',
  'todo', 'tbd', 'unknown', 'none', 'n/a', 'na', 'placeholder', 'example', 'sample'
]);

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
}

function sha256Bytes(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function canonicalSha256(value) {
  return `sha256:${recordSha256(value)}`;
}

function without(value, ...keys) {
  const result = { ...value };
  for (const key of keys) delete result[key];
  return result;
}

function compareText(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareRegions(left, right) {
  return compareText(left.location?.pathBefore, right.location?.pathBefore)
    || compareText(left.location?.pathAfter, right.location?.pathAfter)
    || compareText(left.operation, right.operation)
    || compareText(left.sourceChangeId, right.sourceChangeId)
    || compareText(left.regionSha256, right.regionSha256);
}

function fileType(mode, contentKind = null) {
  if (contentKind === 'symlink' || mode === '120000') return 'symlink';
  if (mode === '160000') return 'gitlink';
  if (contentKind === 'non-regular') return 'non-regular';
  if (contentKind === 'missing' || mode === '000000' || mode == null) return 'missing';
  return 'regular-file';
}

function changeSetFailure(message, details = {}) {
  return new SingularityFlowError(message, {
    code: 'CMP_CHANGE_SET_INVALID',
    details
  });
}

function regionCore(region) {
  return without(region, 'regionId', 'regionSha256');
}

function regionDigest(region) {
  return canonicalSha256(regionCore(region));
}

function regionDisplayId(digest) {
  return `REG-${digest.slice('sha256:'.length, 'sha256:'.length + 20).toUpperCase()}`;
}

function manifestCore(manifest) {
  return without(manifest, 'manifestSha256');
}

function manifestDigest(manifest) {
  return canonicalSha256(manifestCore(manifest));
}

function transportSchemaOne(value) {
  return Number.isInteger(value?.schemaVersion)
    && TRANSPORT_SCHEMA.test(String(value.schemaVersion));
}

function assertChangeSet(changeSet) {
  if (!plainObject(changeSet) || !Array.isArray(changeSet.entries)) {
    throw changeSetFailure('A repository change set with an entries array is required.');
  }
  let current;
  try {
    current = readRecord('repository-change-set', changeSet).record;
  } catch (error) {
    throw changeSetFailure(`The repository change-set schema is not readable: ${error.message}`);
  }
  if (!CHANGE_SET_KINDS.has(current.kind)) {
    throw changeSetFailure(`Repository change-set kind '${current.kind ?? '(missing)'}' is not supported.`);
  }
  if (!Array.isArray(current.entries)) {
    throw changeSetFailure('The current repository change-set record has no entries array.');
  }
  let integrity;
  try {
    integrity = verifyRepositoryChangeSetIntegrity(current);
  } catch (error) {
    throw changeSetFailure(`The repository change set cannot be verified: ${error.message}`);
  }
  if (!integrity.valid || !SHA256.test(String(current.digest ?? ''))) {
    throw changeSetFailure('The repository change set failed its exact content-integrity check.', {
      claimed: current.digest ?? null,
      computed: integrity.digest ?? null,
      entryFailures: integrity.entryFailures ?? []
    });
  }
  return current;
}

function changeRegion(changeSet, entry) {
  const contentAfter = entry.newContent ?? null;
  const core = {
    schemaVersion: 1, // schema-transient: observe-only CMP region; never persisted or authorized
    kind: 'change-region',
    candidateBinding: 'repository-change-set-compatibility',
    compatibilityCandidateSha256: changeSet.digest,
    candidateSha256: changeSet.digest,
    changeSetSha256: changeSet.digest,
    sourceChangeId: entry.changeId,
    operation: entry.status,
    location: {
      pathBefore: entry.oldPath ?? null,
      pathAfter: entry.newPath ?? null,
      fileTypeBefore: fileType(entry.oldMode),
      fileTypeAfter: fileType(entry.newMode, contentAfter?.kind ?? null),
      modeBefore: entry.oldMode ?? null,
      modeAfter: entry.newMode ?? null,
      gitObjectBefore: entry.oldObject ?? null,
      gitObjectAfter: entry.newObject ?? null,
      contentBeforeSha256: null,
      contentAfterSha256: SHA256.test(String(contentAfter?.sha256 ?? '')) ? contentAfter.sha256 : null,
      fragmentBeforeSha256: null,
      fragmentAfterSha256: SHA256.test(String(contentAfter?.sha256 ?? '')) ? contentAfter.sha256 : null,
      contentBytesAfter: Number.isInteger(contentAfter?.bytes) && contentAfter.bytes >= 0
        ? contentAfter.bytes
        : null,
      symbolRefs: [],
      semanticAnchors: [],
      advisoryRangeBefore: null,
      advisoryRangeAfter: null
    },
    classification: {
      material: true,
      ownership: 'conservatively-in-scope',
      changeKind: 'resource-change',
      assurance: 'diff-derived',
      granularity: 'resource',
      structuralAssurance: 'unavailable'
    },
    dependencies: []
  };
  const regionSha256 = canonicalSha256(core);
  return freezeDeep({
    ...core,
    regionId: regionDisplayId(regionSha256),
    regionSha256
  });
}

/**
 * Project an already verified repository change set into the conservative CMP fallback view.
 *
 * This deliberately emits one conservatively in-scope material region per changed resource. It never claims
 * symbol-level or semantic segmentation when AST support is absent. The repository change-set
 * digest is used only as a compatibility subject until the SGOS Candidate adapter lands.
 */
export function buildChangeRegionManifest(changeSet) {
  const currentChangeSet = assertChangeSet(changeSet);
  const regions = currentChangeSet.entries
    .map((entry) => changeRegion(currentChangeSet, entry))
    .sort(compareRegions);
  const ids = new Set();
  const hashes = new Set();
  for (const region of regions) {
    if (ids.has(region.regionId) || hashes.has(region.regionSha256)) {
      throw changeSetFailure('The repository change set produced duplicate change-region identities.', {
        regionId: region.regionId,
        regionSha256: region.regionSha256
      });
    }
    ids.add(region.regionId);
    hashes.add(region.regionSha256);
  }
  const core = {
    schemaVersion: 1, // schema-transient: observe-only CMP manifest; never persisted or authorized
    kind: 'change-region-manifest',
    candidateBinding: 'repository-change-set-compatibility',
    compatibilityCandidateSha256: currentChangeSet.digest,
    candidateSha256: currentChangeSet.digest,
    changeSetSha256: currentChangeSet.digest,
    sourceKind: currentChangeSet.kind,
    sourceSchemaVersion: currentChangeSet.schemaVersion,
    granularity: 'resource',
    structuralAssurance: 'unavailable',
    regions,
    counts: {
      regions: regions.length,
      material: regions.length,
      inScope: regions.length
    }
  };
  return freezeDeep({ ...core, manifestSha256: canonicalSha256(core) });
}

function validateManifest(manifest) {
  const failures = [];
  const fail = (code, message) => failures.push({ code, message });
  if (!plainObject(manifest) || manifest.kind !== 'change-region-manifest') {
    fail('CMP_MANIFEST_INVALID', 'The change-region manifest is missing or has the wrong kind.');
    return { valid: false, failures };
  }
  if (!transportSchemaOne(manifest)) {
    fail('CMP_MANIFEST_INVALID', 'The change-region manifest transport schema is unsupported.');
  }
  if (!SHA256.test(String(manifest.compatibilityCandidateSha256 ?? ''))
      || manifest.candidateSha256 !== manifest.compatibilityCandidateSha256
      || manifest.changeSetSha256 !== manifest.compatibilityCandidateSha256) {
    fail('CMP_CANDIDATE_BINDING_INVALID', 'The manifest is not bound to one exact repository change-set compatibility subject.');
  }
  if (manifest.manifestSha256 !== manifestDigest(manifest)) {
    fail('CMP_MANIFEST_INTEGRITY_INVALID', 'The change-region manifest failed its content-integrity check.');
  }
  if (manifest.candidateBinding !== 'repository-change-set-compatibility'
      || manifest.granularity !== 'resource'
      || manifest.structuralAssurance !== 'unavailable') {
    fail('CMP_MANIFEST_INVALID', 'The change-region manifest is not a conservative resource fallback projection.');
  }
  if (!Array.isArray(manifest.regions)) {
    fail('CMP_MANIFEST_INVALID', 'The change-region manifest has no regions array.');
    return { valid: false, failures };
  }
  if (!plainObject(manifest.counts)
      || manifest.counts.regions !== manifest.regions.length
      || manifest.counts.material !== manifest.regions.length
      || manifest.counts.inScope !== manifest.regions.length) {
    fail('CMP_MANIFEST_COUNT_INVALID', 'The manifest counts do not match its exact resource regions.');
  }
  const ids = new Set();
  const hashes = new Set();
  let previous = null;
  for (const region of manifest.regions) {
    if (!plainObject(region) || region.kind !== 'change-region'
        || !transportSchemaOne(region)) {
      fail('CMP_REGION_IDENTITY_INVALID', 'A change region has an invalid kind or schema version.');
      continue;
    }
    const computed = regionDigest(region);
    if (region.regionSha256 !== computed || region.regionId !== regionDisplayId(computed)) {
      fail('CMP_REGION_IDENTITY_INVALID', `Region '${region.regionId ?? '(missing)'}' failed its identity check.`);
    }
    if (region.compatibilityCandidateSha256 !== manifest.compatibilityCandidateSha256
        || region.candidateSha256 !== manifest.compatibilityCandidateSha256
        || region.changeSetSha256 !== manifest.changeSetSha256) {
      fail('CMP_CANDIDATE_BINDING_INVALID', `Region '${region.regionId ?? '(missing)'}' is bound to another compatibility subject.`);
    }
    if (region.candidateBinding !== 'repository-change-set-compatibility'
        || region.classification?.material !== true
        || region.classification?.ownership !== 'conservatively-in-scope'
        || region.classification?.assurance !== 'diff-derived'
        || region.classification?.granularity !== 'resource'
        || region.classification?.structuralAssurance !== 'unavailable'
        || !Array.isArray(region.location?.symbolRefs)
        || region.location.symbolRefs.length !== 0
        || !Array.isArray(region.location?.semanticAnchors)
        || region.location.semanticAnchors.length !== 0) {
      fail('CMP_REGION_FALLBACK_INVALID', `Region '${region.regionId ?? '(missing)'}' is not a conservative material resource fallback.`);
    }
    if (ids.has(region.regionId) || hashes.has(region.regionSha256)) {
      fail('CMP_REGION_IDENTITY_AMBIGUOUS', `Region '${region.regionId ?? '(missing)'}' has a duplicate identity.`);
    }
    ids.add(region.regionId);
    hashes.add(region.regionSha256);
    if (previous && compareRegions(previous, region) > 0) {
      fail('CMP_MANIFEST_ORDER_INVALID', 'Change regions are not in canonical resource order.');
    }
    previous = region;
  }
  return { valid: failures.length === 0, failures };
}

function normalizedWords(value) {
  return String(value ?? '').trim().toLocaleLowerCase('en-US').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

function validCauseId(value) {
  const text = String(value ?? '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/.test(text)
    && !GENERIC_CAUSES.has(normalizedWords(text))
    && !/(?:todo|tbd|placeholder|example|sample|unknown)/i.test(text);
}

function validStatement(value) {
  const text = String(value ?? '').trim();
  return text.length >= 12
    && text.length <= 4096
    && !GENERIC_CAUSES.has(normalizedWords(text))
    && !/^<(?:[^>]+)>$/.test(text)
    && !/^(?:todo|tbd)\b/i.test(text);
}

function causeCore(cause) {
  return without(cause, 'refSha256');
}

function causeIdentity(cause) {
  return `${cause?.causeKind ?? ''}\0${cause?.causeId ?? ''}`;
}

function causeFailures(cause, candidateSha256) {
  const failures = [];
  const fail = (code, message) => failures.push({ code, message });
  if (!plainObject(cause) || cause.kind !== 'cause-ref') {
    fail('CMP_CAUSE_REFERENCE_MISSING', 'A binding cause does not resolve to a governed cause-ref record.');
    return failures;
  }
  if (!transportSchemaOne(cause)) {
    fail('CMP_CAUSE_REFERENCE_INVALID', 'The cause-ref transport schema is unsupported.');
  }
  if (!CMP_CAUSE_KINDS.includes(cause.causeKind)) {
    fail('CMP_CAUSE_KIND_INVALID', `Cause kind '${cause.causeKind ?? '(missing)'}' is not registered.`);
  }
  if (!validCauseId(cause.causeId)) {
    fail('CMP_CAUSE_REFERENCE_INVALID', 'The cause identifier is missing, generic, or a placeholder.');
  }
  if (!validStatement(cause.statement)) {
    fail('CMP_CAUSE_REFERENCE_INVALID', `Cause '${cause.causeId ?? '(missing)'}' has no specific governed statement.`);
  } else if (cause.statementSha256 !== sha256Bytes(Buffer.from(cause.statement, 'utf8'))) {
    fail('CMP_CAUSE_REFERENCE_INVALID', `Cause '${cause.causeId}' has a mismatched statement digest.`);
  }
  if (!plainObject(cause.authority)
      || !AUTHORITATIVE_STATUSES.has(cause.authority.status)
      || cause.authority.inForce === false
      || !SHA256.test(String(cause.authority.recordSha256 ?? ''))) {
    fail('CMP_CAUSE_AUTHORITY_INVALID', `Cause '${cause.causeId ?? '(missing)'}' lacks an approved, in-force authority digest.`);
  }
  if (!plainObject(cause.validity)
      || cause.validity.stale !== false
      || !SHA256.test(String(cause.validity.policySha256 ?? ''))
      || cause.validity.subjectSha256 !== candidateSha256) {
    fail('CMP_CAUSE_REFERENCE_STALE', `Cause '${cause.causeId ?? '(missing)'}' is stale or is not valid for this compatibility subject.`);
  }
  if (cause.refSha256 !== canonicalSha256(causeCore(cause))) {
    fail('CMP_CAUSE_REFERENCE_INVALID', `Cause '${cause.causeId ?? '(missing)'}' failed its content-integrity check.`);
  }
  return failures;
}

function trustedDigestSet(values) {
  const result = new Set();
  const candidates = values instanceof Set ? [...values] : Array.isArray(values) ? values : [];
  for (const value of candidates) {
    if (SHA256.test(String(value ?? ''))) result.add(String(value));
    else if (plainObject(value)) {
      for (const field of ['decisionSha256', 'recordSha256', 'receiptSha256']) {
        if (SHA256.test(String(value[field] ?? ''))) result.add(value[field]);
      }
    }
  }
  return result;
}

function bindingCore(binding) {
  return without(binding, 'bindingSha256');
}

function proposerNeedsConfirmation(proposedBy) {
  return proposedBy?.kind !== 'human';
}

/** Validate a proposed binding without treating its free-text fields as authority. */
export function validateChangeCauseBinding(binding, {
  manifest,
  causes = [],
  transformationReceipts: _transformationReceipts = [],
  decisions = []
} = {}) {
  const failures = [];
  const fail = (code, message) => failures.push({ code, message });
  const manifestValidation = validateManifest(manifest);
  failures.push(...manifestValidation.failures);
  if (!plainObject(binding) || binding.kind !== 'change-cause-binding') {
    fail('CMP_BINDING_INVALID', 'The change-cause binding is missing or has the wrong kind.');
    return freezeDeep({ valid: false, bindingSha256: null, regionSha256: null, failures });
  }
  if (!transportSchemaOne(binding)) {
    fail('CMP_BINDING_INVALID', 'The change-cause binding transport schema is unsupported.');
  }
  if (!validCauseId(binding.bindingId)) {
    fail('CMP_BINDING_INVALID', 'The binding identifier is missing or a placeholder.');
  }
  if (binding.bindingSha256 !== canonicalSha256(bindingCore(binding))) {
    fail('CMP_BINDING_INTEGRITY_INVALID', 'The change-cause binding failed its content-integrity check.');
  }
  const candidateSha256 = manifest?.compatibilityCandidateSha256 ?? null;
  if (binding.candidateSha256 !== candidateSha256) {
    fail('CMP_CANDIDATE_BINDING_INVALID', 'The change-cause binding is for another compatibility subject.');
  }
  const region = manifest?.regions?.find((entry) => entry.regionSha256 === binding.regionSha256);
  if (!region) fail('CMP_REGION_REFERENCE_MISSING', 'The binding does not identify an exact region in this manifest.');
  if (!CMP_RELATIONSHIPS.includes(binding.relationship)) {
    fail('CMP_BINDING_RELATIONSHIP_INVALID', `Binding relationship '${binding.relationship ?? '(missing)'}' is not registered.`);
  }
  if (!Array.isArray(binding.causeRefs) || binding.causeRefs.length === 0) {
    fail('CMP_CAUSE_REFERENCE_MISSING', 'The binding has no governed cause references.');
  } else {
    const fullCauses = [
      ...(Array.isArray(causes) ? causes : []),
      ...binding.causeRefs.filter((entry) => plainObject(entry) && entry.kind === 'cause-ref')
    ];
    const byIdentity = new Map(fullCauses.map((cause) => [causeIdentity(cause), cause]));
    const seen = new Set();
    for (const reference of binding.causeRefs) {
      const key = causeIdentity(reference);
      if (seen.has(key)) {
        fail('CMP_CAUSE_REFERENCE_INVALID', `Binding repeats cause '${reference?.causeId ?? '(missing)'}'.`);
        continue;
      }
      seen.add(key);
      const cause = byIdentity.get(key);
      if (!cause) {
        fail('CMP_CAUSE_REFERENCE_MISSING', `Cause '${reference?.causeId ?? '(missing)'}' does not resolve to a governed cause-ref record.`);
        continue;
      }
      failures.push(...causeFailures(cause, candidateSha256));
      if (reference.recordSha256 !== cause.authority?.recordSha256) {
        fail('CMP_CAUSE_AUTHORITY_INVALID', `Cause '${reference?.causeId ?? '(missing)'}' is not bound to its approved authority digest.`);
      }
    }
  }
  if (!plainObject(binding.proposedBy)
      || !CMP_PROPOSER_KINDS.includes(binding.proposedBy.kind)
      || !validCauseId(binding.proposedBy.id)) {
    fail('CMP_BINDING_INVALID', 'The binding proposer has no specific identity.');
  }
  const confirmationRequired = proposerNeedsConfirmation(binding.proposedBy)
    || binding.confirmation?.required === true;
  if (confirmationRequired) {
    const decisionSha256 = binding.confirmation?.decisionSha256;
    if (binding.confirmation?.required !== true
        || binding.confirmation?.status !== 'confirmed'
        || !SHA256.test(String(decisionSha256 ?? ''))
        || !trustedDigestSet(decisions).has(decisionSha256)) {
      fail('CMP_BINDING_CONFIRMATION_REQUIRED', 'A model- or agent-proposed binding requires an exact trusted confirmation decision.');
    }
  }
  return freezeDeep({
    valid: failures.length === 0,
    authoritative: false,
    authorityStatus: 'unverified-observation',
    bindingSha256: binding.bindingSha256 ?? null,
    regionSha256: binding.regionSha256 ?? null,
    failures
  });
}

function receiptCore(receipt) {
  return without(receipt, 'receiptSha256');
}

function validateTransformationReceipt(receipt, manifest) {
  const failures = [];
  const fail = (code, message) => failures.push({ code, message });
  if (!plainObject(receipt) || receipt.kind !== 'deterministic-transformation-receipt') {
    fail('CMP_TRANSFORMATION_RECEIPT_INVALID', 'A transformation receipt is missing or has the wrong kind.');
    return { valid: false, failures, covered: [] };
  }
  if (!transportSchemaOne(receipt)) {
    fail('CMP_TRANSFORMATION_RECEIPT_INVALID', 'The transformation receipt transport schema is unsupported.');
  }
  if (receipt.candidateSha256 !== manifest.compatibilityCandidateSha256) {
    fail('CMP_CANDIDATE_BINDING_INVALID', 'A transformation receipt is bound to another compatibility subject.');
  }
  if (!SHA256.test(String(receipt.receiptSha256 ?? ''))
      || receipt.receiptSha256 !== canonicalSha256(receiptCore(receipt))) {
    fail('CMP_TRANSFORMATION_RECEIPT_INVALID', 'A transformation receipt failed its content-integrity check.');
  }
  if (!plainObject(receipt.transformation)
      || !validCauseId(receipt.transformation.id)
      || !String(receipt.transformation.version ?? '').trim()
      || !SHA256.test(String(receipt.transformation.executableSha256 ?? ''))
      || !SHA256.test(String(receipt.transformation.configurationSha256 ?? ''))) {
    fail('CMP_TRANSFORMATION_RECEIPT_INVALID', 'A transformation receipt has no exact tool and configuration identity.');
  }
  if (!SHA256.test(String(receipt.inputManifestSha256 ?? ''))
      || receipt.outputManifestSha256 !== manifest.manifestSha256
      || receipt.semanticChange !== false
      || receipt.verification?.status !== 'passed'
      || !validCauseId(receipt.verification?.verifier)) {
    fail('CMP_TRANSFORMATION_RECEIPT_INVALID', 'A transformation receipt does not prove a verified nonsemantic transformation into this manifest.');
  }
  const covered = [];
  const seen = new Set();
  if (!Array.isArray(receipt.regions) || receipt.regions.length === 0) {
    fail('CMP_TRANSFORMATION_RECEIPT_INVALID', 'A transformation receipt has no exact covered regions.');
  } else {
    for (const identity of receipt.regions) {
      const region = manifest.regions.find((candidate) =>
        candidate.regionId === identity || candidate.regionSha256 === identity);
      if (!region) {
        fail('CMP_EVIDENCE_ORPHAN', `Transformation receipt region '${identity}' is not in this manifest.`);
      } else if (seen.has(region.regionSha256)) {
        fail('CMP_TRANSFORMATION_RECEIPT_INVALID', `Transformation receipt repeats region '${identity}'.`);
      } else {
        seen.add(region.regionSha256);
        covered.push(region.regionSha256);
      }
    }
  }
  return { valid: failures.length === 0, failures, covered };
}

function dispositionCore(disposition) {
  return without(disposition, 'dispositionSha256');
}

function validateDisposition(disposition, manifest) {
  const failures = [];
  const fail = (code, message) => failures.push({ code, message });
  if (!plainObject(disposition) || disposition.kind !== 'change-disposition') {
    fail('CMP_DISPOSITION_INVALID', 'A change disposition is missing or has the wrong kind.');
    return { valid: false, failures, region: null };
  }
  if (!transportSchemaOne(disposition)) {
    fail('CMP_DISPOSITION_INVALID', 'The change-disposition transport schema is unsupported.');
  }
  if (disposition.dispositionSha256 !== canonicalSha256(dispositionCore(disposition))) {
    fail('CMP_DISPOSITION_INVALID', 'A change disposition failed its content-integrity check.');
  }
  if (disposition.candidateSha256 !== manifest.compatibilityCandidateSha256) {
    fail('CMP_CANDIDATE_BINDING_INVALID', 'A change disposition is bound to another compatibility subject.');
  }
  const region = manifest.regions.find((candidate) => candidate.regionSha256 === disposition.regionSha256) ?? null;
  if (!region) fail('CMP_EVIDENCE_ORPHAN', 'A change disposition does not identify a region in this manifest.');
  if (!CMP_DISPOSITIONS.includes(disposition.disposition)) {
    fail('CMP_DISPOSITION_INVALID', `Disposition '${disposition.disposition ?? '(missing)'}' is not registered.`);
  }
  return { valid: failures.length === 0, failures, region };
}

function unresolved(region, reason, code) {
  return {
    regionId: region.regionId,
    regionSha256: region.regionSha256,
    path: region.location?.pathAfter ?? region.location?.pathBefore ?? null,
    code,
    reason
  };
}

function dispositionForRegion(validatedDispositions, region) {
  return validatedDispositions.filter((entry) =>
    entry.validation.valid && entry.record.regionSha256 === region.regionSha256);
}

/**
 * Compute an observe-only assessment. It is never a lifecycle gate or publication authorization.
 */
export function evaluateComprehensionCoverage({
  changeSet,
  manifest,
  bindings = [],
  dispositions = [],
  transformationReceipts = [],
  decisions = [],
  causes = []
} = {}) {
  const diagnostics = [];
  for (const [label, value] of [
    ['bindings', bindings],
    ['dispositions', dispositions],
    ['transformationReceipts', transformationReceipts],
    ['decisions', decisions],
    ['causes', causes]
  ]) {
    if (!Array.isArray(value)) diagnostics.push({
      code: 'CMP_EVIDENCE_INVALID',
      message: `Comprehension evidence '${label}' must be an array.`
    });
  }
  let expectedManifest = null;
  try {
    expectedManifest = buildChangeRegionManifest(changeSet);
    if (manifest?.manifestSha256 !== expectedManifest.manifestSha256
        || canonicalSha256(manifest) !== canonicalSha256(expectedManifest)) {
      diagnostics.push({
        code: 'CMP_MANIFEST_SOURCE_MISMATCH',
        message: 'The manifest is not the exact deterministic projection of the supplied repository change set.'
      });
    }
  } catch (error) {
    diagnostics.push({
      code: 'CMP_SOURCE_CHANGE_SET_INVALID',
      message: error.message
    });
  }
  const manifestValidation = validateManifest(manifest);
  diagnostics.push(...manifestValidation.failures);
  const candidateSha256 = manifest?.compatibilityCandidateSha256 ?? null;
  const observedDecisions = new Set();
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    if (SHA256.test(String(decision ?? ''))) {
      const digest = String(decision);
      if (observedDecisions.has(digest)) diagnostics.push({
        code: 'CMP_EVIDENCE_AMBIGUOUS',
        message: `Decision '${digest}' is duplicated in the evidence bundle.`
      });
      observedDecisions.add(digest);
    }
    else diagnostics.push({
      code: 'CMP_DECISION_EVIDENCE_INVALID',
      message: 'Decision evidence must be an exact sha256 digest in the observe-only pilot.'
    });
  }

  const referencedCauses = new Set();
  for (const binding of Array.isArray(bindings) ? bindings : []) {
    for (const reference of Array.isArray(binding?.causeRefs) ? binding.causeRefs : []) {
      referencedCauses.add(causeIdentity(reference));
    }
  }
  const seenCauses = new Set();
  for (const cause of Array.isArray(causes) ? causes : []) {
    const identity = causeIdentity(cause);
    if (seenCauses.has(identity)) diagnostics.push({
      code: 'CMP_CAUSE_REFERENCE_AMBIGUOUS',
      message: `Cause '${cause?.causeId ?? '(missing)'}' is duplicated in the evidence bundle.`
    });
    seenCauses.add(identity);
    diagnostics.push(...causeFailures(cause, candidateSha256));
    if (!referencedCauses.has(identity)) diagnostics.push({
      code: 'CMP_EVIDENCE_ORPHAN',
      message: `Cause '${cause?.causeId ?? '(missing)'}' is not referenced by a binding.`
    });
  }

  const validBindings = new Map();
  const seenBindings = new Set();
  const bindingResults = (Array.isArray(bindings) ? bindings : []).map((binding) => {
    if (seenBindings.has(binding?.bindingSha256 ?? null)) diagnostics.push({
      code: 'CMP_EVIDENCE_AMBIGUOUS',
      message: `Binding '${binding?.bindingSha256 ?? '(missing)'}' is duplicated in the evidence bundle.`
    });
    seenBindings.add(binding?.bindingSha256 ?? null);
    const validation = validateChangeCauseBinding(binding, {
      manifest, causes, transformationReceipts, decisions
    });
    diagnostics.push(...validation.failures);
    if (validation.valid) {
      const list = validBindings.get(binding.regionSha256) ?? [];
      list.push(binding);
      validBindings.set(binding.regionSha256, list);
    }
    return { bindingSha256: binding?.bindingSha256 ?? null, ...validation };
  });

  const validatedDispositions = (Array.isArray(dispositions) ? dispositions : []).map((record) => {
    const validation = manifestValidation.valid
      ? validateDisposition(record, manifest)
      : { valid: false, failures: [{ code: 'CMP_DISPOSITION_INVALID', message: 'The manifest is invalid.' }] };
    diagnostics.push(...validation.failures);
    return { record, validation };
  });
  const validatedReceipts = (Array.isArray(transformationReceipts) ? transformationReceipts : []).map((record) => {
    const validation = manifestValidation.valid
      ? validateTransformationReceipt(record, manifest)
      : { valid: false, failures: [{ code: 'CMP_TRANSFORMATION_RECEIPT_INVALID', message: 'The manifest is invalid.' }], covered: [] };
    diagnostics.push(...validation.failures);
    return { record, validation };
  });
  const seenReceipts = new Set();
  for (const { record } of validatedReceipts) {
    const identity = record?.receiptSha256 ?? null;
    if (seenReceipts.has(identity)) diagnostics.push({
      code: 'CMP_EVIDENCE_AMBIGUOUS',
      message: `Transformation receipt '${identity ?? '(missing)'}' is duplicated in the evidence bundle.`
    });
    seenReceipts.add(identity);
  }

  const unresolvedRegions = [];
  const counts = {
    regions: Array.isArray(manifest?.regions) ? manifest.regions.length : 0,
    materialRegions: 0,
    nonmaterialRegions: 0,
    explained: 0,
    approvedDeviations: 0,
    deterministicTransformations: 0,
    split: 0,
    unresolved: 0,
    diagnostics: 0
  };
  const finish = (assessment) => {
    const uniqueDiagnostics = [...new Map(diagnostics.map((entry) => [
      `${entry.code}\0${entry.message}`, entry
    ])).values()].sort((left, right) => compareText(left.code, right.code)
      || compareText(left.message, right.message));
    counts.unresolved = unresolvedRegions.length;
    counts.diagnostics = uniqueDiagnostics.length;
    const core = {
      schemaVersion: 1, // schema-transient: observe-only CMP assessment; never persisted or authorized
      kind: 'comprehension-coverage-result',
      assessment: 'CAUSE_COVERAGE',
      lifecycleGate: false,
      authoritative: false,
      authority: 'unverified-observation',
      verdict: assessment,
      candidateSha256,
      counts,
      unresolved: unresolvedRegions,
      diagnostics: uniqueDiagnostics,
      bindingResults
    };
    return freezeDeep({ ...core, resultSha256: canonicalSha256(core) });
  };

  if (!manifestValidation.valid || !expectedManifest
      || diagnostics.some((entry) => entry.code === 'CMP_MANIFEST_SOURCE_MISMATCH')) {
    return finish('incomplete');
  }

  const usedBindings = new Set();
  for (const region of manifest.regions) {
    const material = region.classification?.material === true;
    if (material) counts.materialRegions += 1;
    else counts.nonmaterialRegions += 1;
    const matching = dispositionForRegion(validatedDispositions, region);
    if (matching.length !== 1) {
      unresolvedRegions.push(unresolved(
        region,
        matching.length === 0 ? 'No primary disposition is registered.' : 'More than one primary disposition is registered.',
        matching.length === 0 ? 'CMP_DISPOSITION_MISSING' : 'CMP_DISPOSITION_MULTIPLE'
      ));
      continue;
    }
    const disposition = matching[0].record;
    const receiptEntry = validatedReceipts.find((entry) =>
      entry.record?.receiptSha256 === disposition.receiptSha256);
    const receiptValid = Boolean(receiptEntry?.validation.valid
      && receiptEntry.validation.covered.includes(region.regionSha256));
    if (!material && (disposition.disposition !== 'deterministic-transformation' || !receiptValid)) {
      unresolvedRegions.push(unresolved(
        region,
        'A nonmaterial classification requires a valid deterministic transformation receipt.',
        'CMP_TRANSFORMATION_RECEIPT_INVALID'
      ));
      continue;
    }
    if (disposition.disposition === 'explained') {
      const coveringBindings = validBindings.get(region.regionSha256) ?? [];
      if (coveringBindings.length > 0) {
        counts.explained += 1;
        for (const binding of coveringBindings) usedBindings.add(binding.bindingSha256);
      }
      else unresolvedRegions.push(unresolved(region, 'No valid governed cause binding exists.', 'CMP_CAUSE_COVERAGE_INCOMPLETE'));
      continue;
    }
    if (disposition.disposition === 'approved-deviation') {
      if (SHA256.test(String(disposition.decisionSha256 ?? ''))
          && observedDecisions.has(disposition.decisionSha256)) {
        counts.approvedDeviations += 1;
      } else unresolvedRegions.push(unresolved(
        region,
        'The observed deviation has no exact decision digest in the supplied evidence.',
        'CMP_DEVIATION_DECISION_REQUIRED'
      ));
      continue;
    }
    if (disposition.disposition === 'deterministic-transformation') {
      if (receiptValid) counts.deterministicTransformations += 1;
      else unresolvedRegions.push(unresolved(
        region,
        'The deterministic transformation receipt is missing or invalid.',
        'CMP_TRANSFORMATION_RECEIPT_INVALID'
      ));
      continue;
    }
    if (disposition.disposition === 'split') {
      // A target digest is not a transfer receipt. While the region is still in this subject it
      // remains material here; a later authority integration may accept a split only after exact
      // recomputation proves absence and the target work receipt resolves.
      unresolvedRegions.push(unresolved(
        region,
        'The region remains present; a target subject hash alone does not prove a governed split.',
        'CMP_SPLIT_PENDING'
      ));
      continue;
    }
    if (disposition.disposition === 'revert') {
      unresolvedRegions.push(unresolved(region, 'The region remains present and has not been reverted.', 'CMP_REVERT_PENDING'));
      continue;
    }
    if (disposition.disposition === 'excluded-from-publication') {
      unresolvedRegions.push(unresolved(region, 'The region remains present in the compatibility manifest.', 'CMP_EXCLUSION_PENDING'));
      continue;
    }
    if (disposition.disposition === 'legacy-untouched') {
      unresolvedRegions.push(unresolved(region, 'A changed compatibility region cannot be treated as legacy untouched.', 'CMP_LEGACY_TOUCHED'));
      continue;
    }
    unresolvedRegions.push(unresolved(region, 'The region is explicitly unresolved.', 'CMP_CAUSE_COVERAGE_INCOMPLETE'));
  }
  unresolvedRegions.sort((left, right) => compareText(left.path, right.path)
    || compareText(left.regionSha256, right.regionSha256));

  for (const binding of Array.isArray(bindings) ? bindings : []) {
    const wasValid = bindingResults.find((entry) => entry.bindingSha256 === binding?.bindingSha256)?.valid === true;
    if (wasValid && !usedBindings.has(binding.bindingSha256)) diagnostics.push({
      code: 'CMP_EVIDENCE_ORPHAN',
      message: `Binding '${binding.bindingSha256}' is not used by an explained region disposition.`
    });
  }
  const referencedReceiptDigests = new Set((Array.isArray(dispositions) ? dispositions : [])
    .filter((record) => record?.disposition === 'deterministic-transformation')
    .map((record) => record?.receiptSha256).filter((value) => SHA256.test(String(value ?? ''))));
  for (const entry of validatedReceipts) {
    if (entry.record?.receiptSha256 && !referencedReceiptDigests.has(entry.record.receiptSha256)) {
      diagnostics.push({
        code: 'CMP_EVIDENCE_ORPHAN',
        message: `Transformation receipt '${entry.record.receiptSha256}' is not referenced by a disposition.`
      });
    }
  }
  const referencedDecisionDigests = new Set([
    ...(Array.isArray(bindings) ? bindings : []).map((record) => record?.confirmation?.decisionSha256),
    ...(Array.isArray(dispositions) ? dispositions : [])
      .filter((record) => record?.disposition === 'approved-deviation')
      .map((record) => record?.decisionSha256)
  ].filter((value) => SHA256.test(String(value ?? ''))));
  for (const digest of observedDecisions) {
    if (!referencedDecisionDigests.has(digest)) diagnostics.push({
      code: 'CMP_EVIDENCE_ORPHAN',
      message: `Decision '${digest}' is not referenced by a binding or disposition.`
    });
  }
  if (manifest.regions.length === 0 && diagnostics.length === 0) return finish('not-applicable');
  return finish(unresolvedRegions.length === 0 && diagnostics.length === 0
    ? 'complete'
    : 'incomplete');
}
