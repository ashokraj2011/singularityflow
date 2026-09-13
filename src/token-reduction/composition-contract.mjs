/**
 * Immutable TKR composition identity.
 *
 * This record binds a deterministic TKR candidate to the exact prompt selected by the existing
 * lifecycle owner. In shadow mode the two may differ; in active mode they must be byte-identical.
 * Prompt bodies remain in their existing prompt-snapshot owner and are never copied into this
 * receipt. The receipt is therefore safe to embed in the mutable prompt-injection envelope while
 * retaining its own frozen, self-hashed semantic identity.
 */
import { currentSchemaVersion, readRecord, schemaFamily } from '../schema-migrations.mjs';
import { SingularityFlowError } from '../util.mjs';
import { defaultTokenReductionContractSet } from './default-contract.mjs';
import { renderTkrGeneratedSection } from './generated-renderer.mjs';
import {
  canonicalJson, deepFreeze, sealRecord, sha256
} from '../world-model/canonicalize.mjs';

export const TOKEN_REDUCTION_COMPOSITION_FAMILY = 'token-reduction-composition';
export const TOKEN_REDUCTION_COMPOSITION_KIND = 'tkr/composition-receipt';

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const TYPE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const SUBJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SECTION_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const CONTRACT_REF = /^[a-z][a-z0-9.-]*\/tkr\/[a-z][a-z0-9-]*\/[a-z][a-z0-9.-]*@[1-9][0-9]*#sha256:[a-f0-9]{64}$/u;
const REPRESENTATIONS = new Set([
  'full', 'exact-excerpt', 'deterministic-brief', 'reference-only'
]);
const APPLICABILITIES = new Set(['required', 'optional', 'not-applicable']);
const OUTCOMES = new Set(['included', 'omitted']);
const OMISSION_REASONS = new Set([
  'irrelevant', 'duplicate', 'budget', 'not-applicable', 'unavailable'
]);
const ACTIVATIONS = new Set(['active', 'shadow']);
const MAXIMUM_SECTIONS = 256;
const MAXIMUM_COVERAGE = 4096;
const MAXIMUM_ALIASES = 1024;
const MAXIMUM_TEXT_BYTES = 4096;
const SEPARATOR = Buffer.from('\n\n', 'utf8');
const SEPARATOR_SHA256 = sha256(SEPARATOR);
const REGISTERED_CONTRACT_SET = defaultTokenReductionContractSet();
const REGISTERED_COMPOSER_REF = `${REGISTERED_CONTRACT_SET.composer.owner}`
  + `/${REGISTERED_CONTRACT_SET.composer.kind}/${REGISTERED_CONTRACT_SET.composer.contractId}`
  + `@${REGISTERED_CONTRACT_SET.composer.version}`
  + `#${REGISTERED_CONTRACT_SET.composer.contractSha256}`;
const REGISTERED_CONTRACT_SET_SHA256 = sha256({
  composer: REGISTERED_CONTRACT_SET.composer,
  contracts: REGISTERED_CONTRACT_SET.contracts,
  rendererContracts: REGISTERED_CONTRACT_SET.rendererContracts
});
const REGISTERED_RULES = new Map(
  REGISTERED_CONTRACT_SET.logicalComposer.sectionRules.map((rule) => [rule.id, rule])
);
const REGISTERED_RULE_INDEX = new Map(
  REGISTERED_CONTRACT_SET.logicalComposer.sectionRules.map((rule, index) => [rule.id, index])
);

function fail(message, code = 'TKR_CONTRACT_UNSUPPORTED', details = {}) {
  throw new SingularityFlowError(message, { code, details });
}

function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain object.`);
  }
  return value;
}

function exact(value, required, label) {
  plain(value, label);
  const allowed = new Set(required);
  const missing = required.filter((field) => !Object.hasOwn(value, field));
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (missing.length || unknown.length) {
    fail(`${label} has an invalid field set.`, 'TKR_CONTRACT_UNSUPPORTED', {
      label, missing, unknown
    });
  }
  return value;
}

function text(value, label, { pattern = null, maximumBytes = MAXIMUM_TEXT_BYTES } = {}) {
  if (typeof value !== 'string' || !value.length || (pattern && !pattern.test(value))) {
    fail(`${label} is invalid.`);
  }
  const size = Buffer.byteLength(value, 'utf8');
  if (size > maximumBytes) {
    fail(`${label} exceeds its ${maximumBytes}-byte limit.`, 'TKR_LIMIT_EXCEEDED', {
      limit: label, maximum: maximumBytes, required: size
    });
  }
  return value;
}

function nullableText(value, label, options = {}) {
  return value === null ? null : text(value, label, options);
}

function digest(value, label) {
  return text(value, label, { pattern: SHA256, maximumBytes: 71 });
}

function nullableDigest(value, label) {
  return value === null ? null : digest(value, label);
}

function integer(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be an integer from ${minimum} through ${maximum}.`,
      'TKR_LIMIT_EXCEEDED', { limit: label, minimum, maximum, required: value });
  }
  return value;
}

function oneOf(value, allowed, label) {
  if (!allowed.has(value)) fail(`${label} is unsupported.`, 'TKR_CONTRACT_UNSUPPORTED', {
    label, received: value, allowed: [...allowed]
  });
  return value;
}

function array(value, label, item, { maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  if (value.length > maximum) fail(`${label} exceeds its ${maximum}-entry limit.`,
    'TKR_LIMIT_EXCEEDED', { limit: label, maximum, required: value.length });
  value.forEach((entry, index) => item(entry, `${label}[${index}]`));
  return value;
}

function unique(value, keyOf, label, code = 'TKR_RENDER_CONFLICT') {
  const seen = new Set();
  for (const [index, entry] of value.entries()) {
    const key = keyOf(entry);
    if (seen.has(key)) fail(`${label} contains duplicate '${key}'.`, code, {
      label, duplicate: key, index
    });
    seen.add(key);
  }
  return value;
}

function exactStringArray(value, label, { maximum = MAXIMUM_COVERAGE } = {}) {
  array(value, label, (entry, itemLabel) => text(entry, itemLabel), { maximum });
  return unique(value, (entry) => entry, label);
}

function subjectRef(value, label) {
  exact(value, ['owner', 'domain', 'kind', 'id', 'revision', 'sourceRef'], label);
  for (const field of ['owner', 'domain', 'kind', 'id', 'revision', 'sourceRef']) {
    text(value[field], `${label}.${field}`);
  }
  return value;
}

function objectRef(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  exact(value, ['sha256', 'bytes'], label);
  digest(value.sha256, `${label}.sha256`);
  integer(value.bytes, `${label}.bytes`, { minimum: 1 });
  return value;
}

function coverageEntry(value, label) {
  exact(value, ['claimRef', 'subjectRef', 'evidenceRole', 'requirementRef'], label);
  text(value.claimRef, `${label}.claimRef`);
  subjectRef(value.subjectRef, `${label}.subjectRef`);
  text(value.evidenceRole, `${label}.evidenceRole`);
  text(value.requirementRef, `${label}.requirementRef`);
  return value;
}

function inputRecord(value, label) {
  exact(value, [
    'sectionId', 'subjectRef', 'ownerBindingSha256', 'evidenceRole', 'assuranceRef',
    'requirementRef', 'applicability', 'applicabilityDecisionRef', 'coverage',
    'sourceRef', 'sourceSha256', 'sourceByteLength', 'expansionRefs', 'limitations',
    'outcome', 'representation', 'originalRenderedRef', 'finalRenderedRef', 'omission'
  ], label);
  text(value.sectionId, `${label}.sectionId`, { pattern: SECTION_ID, maximumBytes: 128 });
  subjectRef(value.subjectRef, `${label}.subjectRef`);
  digest(value.ownerBindingSha256, `${label}.ownerBindingSha256`);
  text(value.evidenceRole, `${label}.evidenceRole`, { maximumBytes: 128 });
  text(value.assuranceRef, `${label}.assuranceRef`);
  text(value.requirementRef, `${label}.requirementRef`);
  oneOf(value.applicability, APPLICABILITIES, `${label}.applicability`);
  nullableText(value.applicabilityDecisionRef, `${label}.applicabilityDecisionRef`);
  array(value.coverage, `${label}.coverage`, coverageEntry, { maximum: MAXIMUM_COVERAGE });
  unique(value.coverage, (entry) => canonicalJson(entry), `${label}.coverage`);
  text(value.sourceRef, `${label}.sourceRef`);
  nullableDigest(value.sourceSha256, `${label}.sourceSha256`);
  integer(value.sourceByteLength, `${label}.sourceByteLength`);
  exactStringArray(value.expansionRefs, `${label}.expansionRefs`);
  exactStringArray(value.limitations, `${label}.limitations`);
  oneOf(value.outcome, OUTCOMES, `${label}.outcome`);
  if (value.representation !== null) {
    oneOf(value.representation, REPRESENTATIONS, `${label}.representation`);
  }
  objectRef(value.originalRenderedRef, `${label}.originalRenderedRef`, { nullable: true });
  objectRef(value.finalRenderedRef, `${label}.finalRenderedRef`, { nullable: true });
  if (value.omission !== null) omissionRecord(value.omission, `${label}.omission`, {
    includeSection: false
  });
  const notApplicable = value.applicability === 'not-applicable';
  if (notApplicable !== (value.applicabilityDecisionRef !== null)
      || notApplicable !== (value.sourceSha256 === null && value.sourceByteLength === 0)
      || (notApplicable && value.coverage.length)) {
    fail(`${label} has inconsistent not-applicable ownership.`, 'TKR_COVERAGE_UNPROVEN', {
      sectionId: value.sectionId
    });
  }
  if (notApplicable && (value.outcome !== 'omitted'
      || value.omission?.reason !== 'not-applicable')) {
    fail(`${label} marks a section not applicable but still carries live prompt content.`,
      'TKR_COVERAGE_UNPROVEN', { sectionId: value.sectionId });
  }
  if (!notApplicable && (!value.coverage.length || value.sourceSha256 === null
      || value.originalRenderedRef === null
      || value.originalRenderedRef.sha256 !== value.sourceSha256
      || value.originalRenderedRef.bytes !== value.sourceByteLength)) {
    fail(`${label} does not retain its exact applicable source and coverage.`,
      'TKR_COVERAGE_UNPROVEN', { sectionId: value.sectionId });
  }
  if (value.sourceRef !== value.subjectRef.sourceRef) {
    fail(`${label}.sourceRef does not match its owner-qualified subject.`,
      'TKR_PROTECTED_CONTENT_CHANGED', { sectionId: value.sectionId });
  }
  if (value.outcome === 'included') {
    if (value.representation === null || value.finalRenderedRef === null || value.omission !== null) {
      fail(`${label} has an incomplete included outcome.`, 'TKR_RENDER_CONFLICT', {
        sectionId: value.sectionId
      });
    }
  } else if (value.representation !== null || value.finalRenderedRef !== null
      || value.omission === null) {
    fail(`${label} has an incomplete omitted outcome.`, 'TKR_RENDER_CONFLICT', {
      sectionId: value.sectionId
    });
  }
  return value;
}

function segmentRecord(value, label) {
  exact(value, [
    'sectionId', 'slot', 'role', 'position', 'start', 'end', 'bytes', 'sha256',
    'rendererRef', 'representation', 'subjectRefsSha256', 'coverageSha256',
    'carriedSha256'
  ], label);
  text(value.sectionId, `${label}.sectionId`, { pattern: SECTION_ID, maximumBytes: 128 });
  text(value.slot, `${label}.slot`, { maximumBytes: 128 });
  text(value.role, `${label}.role`, { maximumBytes: 128 });
  integer(value.position, `${label}.position`);
  integer(value.start, `${label}.start`);
  integer(value.end, `${label}.end`, { minimum: 1 });
  integer(value.bytes, `${label}.bytes`, { minimum: 1 });
  digest(value.sha256, `${label}.sha256`);
  text(value.rendererRef, `${label}.rendererRef`);
  text(value.representation, `${label}.representation`, {
    pattern: /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u, maximumBytes: 64
  });
  digest(value.subjectRefsSha256, `${label}.subjectRefsSha256`);
  digest(value.coverageSha256, `${label}.coverageSha256`);
  digest(value.carriedSha256, `${label}.carriedSha256`);
  if (value.end - value.start !== value.bytes) {
    fail(`${label} byte range does not match its byte count.`, 'TKR_RENDER_CONFLICT', {
      sectionId: value.sectionId
    });
  }
  return value;
}

function separatorRecord(value, label) {
  exact(value, ['start', 'end', 'bytes', 'sha256'], label);
  integer(value.start, `${label}.start`);
  integer(value.end, `${label}.end`, { minimum: 1 });
  integer(value.bytes, `${label}.bytes`, { minimum: 1 });
  digest(value.sha256, `${label}.sha256`);
  if (value.end - value.start !== value.bytes
      || value.bytes !== SEPARATOR.length || value.sha256 !== SEPARATOR_SHA256) {
    fail(`${label} is not the frozen v1 LF-LF separator.`, 'TKR_RENDER_CONFLICT');
  }
  return value;
}

function range(value, label) {
  exact(value, ['start', 'end'], label);
  integer(value.start, `${label}.start`);
  integer(value.end, `${label}.end`);
  if (value.end < value.start) fail(`${label} is reversed.`, 'TKR_RENDER_CONFLICT');
  return value;
}

function protectedTextRecord(value, label) {
  exact(value, [
    'sectionId', 'sourceRef', 'sourceRange', 'renderedRange', 'blockRange', 'sha256',
    'bytes', 'encoding'
  ], label);
  text(value.sectionId, `${label}.sectionId`, { pattern: SECTION_ID, maximumBytes: 128 });
  text(value.sourceRef, `${label}.sourceRef`);
  range(value.sourceRange, `${label}.sourceRange`);
  range(value.renderedRange, `${label}.renderedRange`);
  range(value.blockRange, `${label}.blockRange`);
  digest(value.sha256, `${label}.sha256`);
  integer(value.bytes, `${label}.bytes`, { minimum: 1 });
  if (value.encoding !== 'literal-utf8') fail(`${label}.encoding is unsupported.`,
    'TKR_PROTECTED_CONTENT_CHANGED');
  if (value.sourceRange.end - value.sourceRange.start !== value.bytes
      || value.renderedRange.end - value.renderedRange.start !== value.bytes
      || value.blockRange.end - value.blockRange.start !== value.bytes) {
    fail(`${label} ranges do not retain the protected byte count.`,
      'TKR_PROTECTED_CONTENT_CHANGED');
  }
  return value;
}

function aliasRecord(value, label) {
  exact(value, ['id', 'namespace', 'scopeRef', 'targetRef'], label);
  text(value.id, `${label}.id`, { pattern: /^[A-Z][A-Z0-9]*[1-9][0-9]*$/u, maximumBytes: 64 });
  text(value.namespace, `${label}.namespace`, { pattern: /^[A-Z][A-Z0-9]*$/u, maximumBytes: 32 });
  text(value.scopeRef, `${label}.scopeRef`);
  subjectRef(value.targetRef, `${label}.targetRef`);
  if (!value.id.startsWith(value.namespace)) fail(`${label} does not match its namespace.`,
    'TKR_ALIAS_INVALID', { aliasId: value.id, namespace: value.namespace });
  return value;
}

function omissionRecord(value, label, { includeSection = true } = {}) {
  const required = [
    ...(includeSection ? ['sectionId'] : []), 'reason', 'originalRenderedRef',
    'expansionRefs', 'limitations', 'carrierSectionId', 'coverageProofSha256'
  ];
  exact(value, required, label);
  if (includeSection) text(value.sectionId, `${label}.sectionId`, {
    pattern: SECTION_ID, maximumBytes: 128
  });
  oneOf(value.reason, OMISSION_REASONS, `${label}.reason`);
  objectRef(value.originalRenderedRef, `${label}.originalRenderedRef`, { nullable: true });
  exactStringArray(value.expansionRefs, `${label}.expansionRefs`);
  exactStringArray(value.limitations, `${label}.limitations`);
  nullableText(value.carrierSectionId, `${label}.carrierSectionId`, {
    pattern: SECTION_ID, maximumBytes: 128
  });
  nullableDigest(value.coverageProofSha256, `${label}.coverageProofSha256`);
  const duplicate = value.reason === 'duplicate';
  if (duplicate !== (value.carrierSectionId !== null)
      || duplicate !== (value.coverageProofSha256 !== null)) {
    fail(`${label} has inconsistent duplicate-carrier evidence.`, 'TKR_COVERAGE_UNPROVEN');
  }
  if (value.reason === 'budget' && !value.expansionRefs.length) {
    fail(`${label} budget omission has no exact expansion reference.`,
      'TKR_COVERAGE_UNPROVEN');
  }
  return value;
}

function deduplicationRecord(value, label) {
  exact(value, [
    'removedSectionId', 'removedRepresentation', 'carrierSectionId',
    'carrierRepresentation', 'removedCandidateRef', 'carrierCandidateRef',
    'coverageProofSha256', 'ruleRef', 'coverageSha256'
  ], label);
  for (const field of ['removedSectionId', 'carrierSectionId']) text(value[field],
    `${label}.${field}`, { pattern: SECTION_ID, maximumBytes: 128 });
  for (const field of ['removedRepresentation', 'carrierRepresentation']) oneOf(
    value[field], REPRESENTATIONS, `${label}.${field}`
  );
  for (const field of [
    'removedCandidateRef', 'carrierCandidateRef', 'coverageProofSha256', 'coverageSha256'
  ]) digest(value[field], `${label}.${field}`);
  text(value.ruleRef, `${label}.ruleRef`);
  if (value.removedSectionId === value.carrierSectionId) fail(
    `${label} cannot remove its own carrier.`, 'TKR_COVERAGE_UNPROVEN'
  );
  return value;
}

function promptBytes(value, label) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value);
  fail(`${label} must be exact UTF-8 bytes.`, 'TKR_PROTECTED_CONTENT_CHANGED');
}

function promptRef(value) {
  const bytes = promptBytes(value, 'Prompt');
  const decoded = bytes.toString('utf8');
  if (!bytes.length || !Buffer.from(decoded, 'utf8').equals(bytes)) fail(
    'Prompt bytes must contain non-empty well-formed UTF-8.', 'TKR_PROTECTED_CONTENT_CHANGED'
  );
  return { sha256: sha256(bytes), bytes: bytes.length };
}

function receiptSubject(value) {
  exact(value, [
    'repositoryDomainSha256', 'workId', 'workflowInstanceId', 'phase', 'generation'
  ], 'TKR composition subject');
  digest(value.repositoryDomainSha256, 'TKR composition subject.repositoryDomainSha256');
  text(value.workId, 'TKR composition subject.workId', { pattern: SUBJECT_ID, maximumBytes: 256 });
  text(value.workflowInstanceId, 'TKR composition subject.workflowInstanceId', {
    pattern: SUBJECT_ID, maximumBytes: 256
  });
  text(value.phase, 'TKR composition subject.phase', { pattern: TYPE_ID, maximumBytes: 128 });
  integer(value.generation, 'TKR composition subject.generation', { minimum: 1 });
  return value;
}

function receiptAuthority(value, activation) {
  exact(value, [
    'tokenEconomyPolicySha256', 'phaseContextPolicySha256', 'workflowSnapshotSha256',
    'sourceSnapshotSha256', 'composerRef', 'composerSha256', 'contractSetSha256'
  ], 'TKR composition authority');
  digest(value.tokenEconomyPolicySha256,
    'TKR composition authority.tokenEconomyPolicySha256');
  for (const field of [
    'phaseContextPolicySha256', 'workflowSnapshotSha256', 'sourceSnapshotSha256'
  ]) nullableDigest(value[field], `TKR composition authority.${field}`);
  text(value.composerRef, 'TKR composition authority.composerRef', {
    pattern: CONTRACT_REF, maximumBytes: 512
  });
  digest(value.composerSha256, 'TKR composition authority.composerSha256');
  digest(value.contractSetSha256, 'TKR composition authority.contractSetSha256');
  if (!value.composerRef.endsWith(`#${value.composerSha256}`)) fail(
    'TKR composition authority composerRef does not bind composerSha256.',
    'TKR_CONTRACT_UNSUPPORTED'
  );
  if (value.composerRef !== REGISTERED_COMPOSER_REF
      || value.composerSha256 !== REGISTERED_CONTRACT_SET.composer.contractSha256
      || value.contractSetSha256 !== REGISTERED_CONTRACT_SET_SHA256) {
    fail('TKR composition authority does not resolve to the registered packaged contract closure.',
      'TKR_CONTRACT_UNSUPPORTED', {
        composerRef: value.composerRef,
        expectedComposerRef: REGISTERED_COMPOSER_REF,
        contractSetSha256: value.contractSetSha256,
        expectedContractSetSha256: REGISTERED_CONTRACT_SET_SHA256
      });
  }
  if (activation === 'active' && [
    value.phaseContextPolicySha256, value.workflowSnapshotSha256, value.sourceSnapshotSha256
  ].some((entry) => entry === null)) {
    fail('Active TKR composition requires exact phase policy, workflow, and source authority.',
      'TKR_CONTRACT_UNSUPPORTED', { activation });
  }
  return value;
}

function normalizeInput(section) {
  const omission = section.omission == null ? null : {
    reason: section.omission.reason,
    originalRenderedRef: structuredClone(section.originalRenderedRef ?? null),
    expansionRefs: [...(section.omission.expansionRefs ?? [])],
    limitations: [...(section.limitations ?? [])],
    carrierSectionId: section.omission.carrierSectionId ?? null,
    coverageProofSha256: section.omission.coverageProofSha256 ?? null
  };
  return {
    sectionId: section.id,
    subjectRef: structuredClone(section.subjectRef),
    ownerBindingSha256: section.ownerBindingRef,
    evidenceRole: section.evidenceRole,
    assuranceRef: section.assuranceRef,
    requirementRef: section.requirementRef,
    applicability: section.applicability,
    applicabilityDecisionRef: section.applicabilityDecisionRef,
    coverage: structuredClone(section.coverage),
    sourceRef: section.sourceRef,
    sourceSha256: section.sourceSha256,
    sourceByteLength: section.sourceByteLength,
    expansionRefs: [...(section.omission?.expansionRefs ?? [])],
    limitations: [...(section.limitations ?? [])],
    outcome: section.outcome,
    representation: section.representation,
    originalRenderedRef: structuredClone(section.originalRenderedRef),
    finalRenderedRef: structuredClone(section.finalRenderedRef),
    omission
  };
}

function normalizeComposition(composition) {
  return {
    composerSha256: composition.composerSha256,
    sha256: composition.sha256,
    bytes: composition.bytes,
    segments: composition.segments.map((entry) => ({
      sectionId: entry.id,
      slot: entry.slot,
      role: entry.role,
      position: entry.position,
      start: entry.start,
      end: entry.end,
      bytes: entry.bytes,
      sha256: entry.sha256,
      rendererRef: entry.rendererRef,
      representation: entry.representation,
      subjectRefsSha256: sha256(entry.subjectRefs),
      coverageSha256: sha256(entry.coverage),
      carriedSha256: sha256(entry.carried)
    })),
    separators: structuredClone(composition.separators),
    protectedText: structuredClone(composition.protectedText),
    aliases: structuredClone(composition.aliases),
    omissions: composition.omissions.map((entry) => ({
      sectionId: entry.sectionId,
      reason: entry.reason,
      originalRenderedRef: structuredClone(entry.originalRenderedRef),
      expansionRefs: [...entry.expansionRefs],
      limitations: [...entry.limitations],
      carrierSectionId: entry.carrierSectionId ?? null,
      coverageProofSha256: entry.coverageProofSha256 ?? null
    })),
    deduplication: composition.deduplication.map((entry) => ({
      removedSectionId: entry.removedSectionId,
      removedRepresentation: entry.removedRepresentation,
      carrierSectionId: entry.carrierSectionId,
      carrierRepresentation: entry.carrierRepresentation,
      removedCandidateRef: entry.removedCandidateRef,
      carrierCandidateRef: entry.carrierCandidateRef,
      coverageProofSha256: entry.coverageProofSha256,
      ruleRef: entry.ruleRef,
      coverageSha256: sha256(entry.coverage)
    }))
  };
}

function validateComposition(value, candidatePrompt, inputs) {
  exact(value, [
    'composerSha256', 'sha256', 'bytes', 'segments', 'separators', 'protectedText',
    'aliases', 'omissions', 'deduplication'
  ], 'TKR composition manifest');
  digest(value.composerSha256, 'TKR composition manifest.composerSha256');
  digest(value.sha256, 'TKR composition manifest.sha256');
  integer(value.bytes, 'TKR composition manifest.bytes', { minimum: 1 });
  if (value.sha256 !== candidatePrompt.sha256 || value.bytes !== candidatePrompt.bytes) {
    fail('TKR composition manifest does not identify the candidate prompt.',
      'TKR_RENDER_CONFLICT');
  }
  array(value.segments, 'TKR composition segments', segmentRecord, {
    maximum: MAXIMUM_SECTIONS
  });
  unique(value.segments, (entry) => entry.sectionId, 'TKR composition segments');
  array(value.separators, 'TKR composition separators', separatorRecord, {
    maximum: MAXIMUM_SECTIONS - 1
  });
  if (!value.segments.length) fail('TKR composition has no segments.',
    'TKR_COVERAGE_UNPROVEN');
  if (value.separators.length !== value.segments.length - 1) fail(
    'TKR composition separators do not close the segment sequence.',
    'TKR_RENDER_CONFLICT'
  );
  let cursor = 0;
  for (const [index, segment] of value.segments.entries()) {
    if (segment.position !== index || segment.start !== cursor) fail(
      `TKR segment '${segment.sectionId}' has an invalid position or start offset.`,
      'TKR_RENDER_CONFLICT', { sectionId: segment.sectionId, index, cursor }
    );
    cursor = segment.end;
    if (index < value.separators.length) {
      const separator = value.separators[index];
      if (separator.start !== cursor) fail('TKR separator does not follow its segment.',
        'TKR_RENDER_CONFLICT', { index, cursor });
      cursor = separator.end;
    }
  }
  if (cursor !== value.bytes) fail('TKR segments and separators do not cover the candidate bytes.',
    'TKR_RENDER_CONFLICT', { coveredBytes: cursor, candidateBytes: value.bytes });
  array(value.protectedText, 'TKR protected-text bindings', protectedTextRecord, {
    maximum: MAXIMUM_COVERAGE
  });
  array(value.aliases, 'TKR aliases', aliasRecord, { maximum: MAXIMUM_ALIASES });
  unique(value.aliases, (entry) => entry.id, 'TKR aliases', 'TKR_ALIAS_INVALID');
  unique(value.aliases, (entry) => canonicalJson(entry.targetRef), 'TKR aliases',
    'TKR_ALIAS_INVALID');
  array(value.omissions, 'TKR omissions', omissionRecord, { maximum: MAXIMUM_SECTIONS });
  unique(value.omissions, (entry) => entry.sectionId, 'TKR omissions');
  array(value.deduplication, 'TKR deduplication bindings', deduplicationRecord, {
    maximum: MAXIMUM_SECTIONS
  });
  unique(value.deduplication, (entry) => entry.removedSectionId,
    'TKR deduplication bindings', 'TKR_COVERAGE_UNPROVEN');
  if (value.deduplication.length) {
    // v1 stores only a hash of the carried presentation. It cannot independently reconstruct
    // alias uses and protected-span continuity from the content-free receipt, so accepting that
    // opaque hash would make a re-sealed forgery indistinguishable from a composer result. Keep
    // the feature fail-closed until a later frozen receipt version carries a verifiable proof
    // projection. The current production shadow adapter never proposes deduplication.
    fail('TKR composition receipt v1 cannot verify carried deduplication evidence.',
      'TKR_CONTRACT_UNSUPPORTED');
  }
  const segments = new Map(value.segments.map((entry) => [entry.sectionId, entry]));
  const omissions = new Map(value.omissions.map((entry) => [entry.sectionId, entry]));
  const inputById = new Map(inputs.map((entry) => [entry.sectionId, entry]));
  const inputIds = new Set(inputById.keys());
  const nonGeneratedSegmentIds = new Set();
  let priorRuleIndex = -1;
  for (const [sectionId, segment] of segments) {
    if (omissions.has(sectionId)) fail(
      `TKR section '${sectionId}' is both rendered and omitted.`,
      'TKR_RENDER_CONFLICT', { sectionId }
    );
    const rule = REGISTERED_RULES.get(sectionId);
    if (!rule) fail(`TKR composition renders unknown section '${sectionId}'.`,
      'TKR_CONTRACT_UNSUPPORTED', { sectionId });
    const ruleIndex = REGISTERED_RULE_INDEX.get(sectionId);
    if (ruleIndex <= priorRuleIndex) fail(
      `TKR segment '${sectionId}' violates the registered composer order.`,
      'TKR_RENDER_CONFLICT', { sectionId }
    );
    priorRuleIndex = ruleIndex;
    if (segment.slot !== rule.slot || !rule.permittedRoles.includes(segment.role)) fail(
      `TKR segment '${sectionId}' changes its registered slot or role.`,
      'TKR_CONTRACT_UNSUPPORTED', { sectionId }
    );
    if (rule.generator) {
      if (inputIds.has(sectionId)
          || segment.rendererRef !== rule.rendererRef
          || segment.representation !== `generated-${rule.generator}`) {
        fail(`TKR generated segment '${sectionId}' does not match its registered generator.`,
          'TKR_CONTRACT_UNSUPPORTED', { sectionId });
      }
      const visibleOmissions = value.omissions
        .filter((entry) => ['budget', 'unavailable'].includes(entry.reason))
        .map((entry) => {
          const input = inputById.get(entry.sectionId);
          return input ? {
            sectionId: entry.sectionId,
            subjectRef: input.subjectRef,
            reason: entry.reason,
            originalRenderedRef: entry.originalRenderedRef,
            expansionRefs: entry.expansionRefs,
            limitations: entry.limitations,
            evidenceRole: input.evidenceRole,
            requirementRef: input.requirementRef
          } : null;
        }).filter(Boolean);
      const subjectRefs = rule.generator === 'alias-table'
        ? value.aliases.map((entry) => entry.targetRef)
        : visibleOmissions.map((entry) => entry.subjectRef);
      const rendered = renderTkrGeneratedSection(rule.generator, {
        aliases: value.aliases,
        omissions: visibleOmissions
      }, { rendererRef: rule.rendererRef });
      if ((rule.generator === 'alias-table' && !value.aliases.length)
          || (rule.generator === 'omission-notices' && !subjectRefs.length)
          || segment.sha256 !== sha256(rendered)
          || segment.bytes !== rendered.length
          || segment.subjectRefsSha256 !== sha256(subjectRefs)
          || segment.coverageSha256 !== sha256([])
          || segment.carriedSha256 !== sha256([])) {
        fail(`TKR generated segment '${sectionId}' is not derived from its manifest inputs.`,
          'TKR_RENDER_CONFLICT', { sectionId });
      }
      continue;
    }
    if (!inputIds.has(sectionId)) fail(
      `TKR composition renders unknown owner input '${sectionId}'.`,
      'TKR_RENDER_CONFLICT', { sectionId }
    );
    nonGeneratedSegmentIds.add(sectionId);
    const input = inputById.get(sectionId);
    const carriedInputs = value.deduplication
      .filter((proof) => proof.carrierSectionId === sectionId)
      .map((proof) => inputById.get(proof.removedSectionId))
      .filter(Boolean);
    if (segment.role !== input.evidenceRole
        || segment.rendererRef !== (rule.rendererRef ?? REGISTERED_CONTRACT_SET.rendererRef)
        || segment.subjectRefsSha256 !== sha256([
          input.subjectRef, ...carriedInputs.map((entry) => entry.subjectRef)
        ])
        || segment.coverageSha256 !== sha256(input.coverage)
        || (!carriedInputs.length && segment.carriedSha256 !== sha256([]))) {
      fail(`TKR segment '${sectionId}' is not bound to its registered owner input.`,
        'TKR_COVERAGE_UNPROVEN', { sectionId });
    }
  }
  const expectedAliasTable = value.aliases.length > 0;
  const expectedOmissionNotices = value.omissions.some((entry) => (
    ['budget', 'unavailable'].includes(entry.reason)
  ));
  if (segments.has('alias-table') !== expectedAliasTable
      || segments.has('omission-notices') !== expectedOmissionNotices) {
    fail('TKR generated metadata segments do not match aliases and visible omissions.',
      'TKR_RENDER_CONFLICT');
  }
  for (const sectionId of omissions.keys()) {
    if (!inputIds.has(sectionId)) fail(
      `TKR composition omits unknown section '${sectionId}'.`,
      'TKR_RENDER_CONFLICT', { sectionId }
    );
  }
  if (nonGeneratedSegmentIds.size + omissions.size !== inputIds.size) fail(
    'TKR composition does not account for every input exactly once.',
    'TKR_RENDER_CONFLICT', {
      inputs: inputIds.size, segments: nonGeneratedSegmentIds.size, omissions: omissions.size
    }
  );
  for (const input of inputs) {
    const segment = segments.get(input.sectionId);
    const omission = omissions.get(input.sectionId);
    if (input.outcome === 'included') {
      if (!segment || omission || input.finalRenderedRef.sha256 !== segment.sha256
          || input.finalRenderedRef.bytes !== segment.bytes
          || input.representation !== segment.representation) {
        fail(`TKR input '${input.sectionId}' does not match its selected segment.`,
          'TKR_RENDER_CONFLICT', { sectionId: input.sectionId });
      }
    } else if (segment || !omission || input.omission.reason !== omission.reason
        || input.omission.carrierSectionId !== omission.carrierSectionId
        || input.omission.coverageProofSha256 !== omission.coverageProofSha256) {
      fail(`TKR input '${input.sectionId}' does not match its omission.`,
        'TKR_RENDER_CONFLICT', { sectionId: input.sectionId });
    }
  }
  for (const proof of value.deduplication) {
    const omission = omissions.get(proof.removedSectionId);
    const removedInput = inputById.get(proof.removedSectionId);
    const carrierInput = inputById.get(proof.carrierSectionId);
    if (!omission || omission.reason !== 'duplicate'
        || omission.carrierSectionId !== proof.carrierSectionId
        || omission.coverageProofSha256 !== proof.coverageProofSha256
        || !segments.has(proof.carrierSectionId)
        || !removedInput || !carrierInput
        || proof.removedRepresentation !== removedInput.representation
        || proof.carrierRepresentation !== carrierInput.representation
        || proof.coverageSha256 !== sha256(removedInput.coverage)
        || proof.ruleRef !== REGISTERED_CONTRACT_SET.composer.deduplicationRulesRef) {
      fail(`TKR deduplication for '${proof.removedSectionId}' has no exact live carrier.`,
        'TKR_COVERAGE_UNPROVEN', { removedSectionId: proof.removedSectionId });
    }
  }
  for (const span of value.protectedText) {
    const segment = segments.get(span.sectionId);
    const input = inputById.get(span.sectionId);
    if (!segment || !input || span.sourceRef !== input.sourceRef
        || span.sourceRange.end > input.sourceByteLength
        || span.renderedRange.end > segment.bytes
        || span.blockRange.start !== segment.start + span.renderedRange.start
        || span.blockRange.end !== segment.start + span.renderedRange.end) {
      fail(`TKR protected text for '${span.sectionId}' escapes its segment.`,
        'TKR_PROTECTED_CONTENT_CHANGED', { sectionId: span.sectionId });
    }
  }
  return value;
}

function verifyBytes(value, expected, label) {
  if (value == null) return;
  const actual = promptRef(value);
  if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) fail(
    `${label} do not match the retained TKR composition receipt.`,
    'TKR_PROTECTED_CONTENT_CHANGED', { expected, actual }
  );
}

/** Validate one current frozen composition receipt, optionally against exact retained bytes. */
export function validateTokenReductionCompositionReceipt(value, {
  selectedPrompt = null, candidatePrompt = null
} = {}) {
  let receipt;
  try { receipt = readRecord(TOKEN_REDUCTION_COMPOSITION_FAMILY, value).record; }
  catch (error) {
    fail(`TKR composition receipt schema is unsupported: ${error.message}`,
      'TKR_CONTRACT_UNSUPPORTED', { cause: error.code ?? null });
  }
  exact(receipt, [
    'schemaVersion', 'kind', 'version', 'activation', 'subject', 'authority', 'inputs',
    'selectedPrompt', 'candidatePrompt', 'relationship', 'composition',
    'compositionManifestSha256', 'receiptSha256'
  ], 'TKR composition receipt');
  // readRecord is the sole schema-version authority; this validator only checks the
  // frozen contract discriminator after migration/read admission has succeeded.
  if (receipt.kind !== TOKEN_REDUCTION_COMPOSITION_KIND || receipt.version !== 1) {
    fail('TKR composition receipt kind or version is unsupported.');
  }
  oneOf(receipt.activation, ACTIVATIONS, 'TKR composition receipt.activation');
  if (receipt.activation === 'active') {
    fail('Active TKR composition is not registered for production in receipt v1.',
      'TKR_CONTRACT_UNSUPPORTED', { activation: receipt.activation });
  }
  receiptSubject(receipt.subject);
  receiptAuthority(receipt.authority, receipt.activation);
  array(receipt.inputs, 'TKR composition inputs', inputRecord, { maximum: MAXIMUM_SECTIONS });
  unique(receipt.inputs, (entry) => entry.sectionId, 'TKR composition inputs');
  const coverageCount = receipt.inputs.reduce((total, entry) => total + entry.coverage.length, 0);
  if (coverageCount > MAXIMUM_COVERAGE) fail('TKR composition coverage exceeds its finite limit.',
    'TKR_LIMIT_EXCEEDED', {
      limit: 'maximumCoverageClaims', maximum: MAXIMUM_COVERAGE, required: coverageCount
    });
  objectRef(receipt.selectedPrompt, 'TKR composition selectedPrompt');
  objectRef(receipt.candidatePrompt, 'TKR composition candidatePrompt');
  if (!['identical', 'different'].includes(receipt.relationship)) fail(
    'TKR composition receipt.relationship is unsupported.'
  );
  const identical = receipt.selectedPrompt.sha256 === receipt.candidatePrompt.sha256
    && receipt.selectedPrompt.bytes === receipt.candidatePrompt.bytes;
  if ((receipt.relationship === 'identical') !== identical
      || (receipt.activation === 'active' && !identical)) {
    fail('TKR composition activation does not match the selected and candidate prompt bytes.',
      'TKR_RENDER_CONFLICT', { activation: receipt.activation, relationship: receipt.relationship });
  }
  validateComposition(receipt.composition, receipt.candidatePrompt, receipt.inputs);
  digest(receipt.compositionManifestSha256,
    'TKR composition receipt.compositionManifestSha256');
  const expectedManifest = sha256(receipt.composition);
  if (receipt.compositionManifestSha256 !== expectedManifest) fail(
    'TKR composition manifest failed its exact content-integrity check.',
    'TKR_RENDER_CONFLICT', {
      expected: expectedManifest, received: receipt.compositionManifestSha256
    }
  );
  if (receipt.authority.composerSha256 !== receipt.composition.composerSha256) fail(
    'TKR composition authority does not match the materialized composer.',
    'TKR_CONTRACT_UNSUPPORTED'
  );
  digest(receipt.receiptSha256, 'TKR composition receipt.receiptSha256');
  const expectedReceipt = sha256(Object.fromEntries(
    Object.entries(receipt).filter(([key]) => key !== 'receiptSha256')
  ));
  if (receipt.receiptSha256 !== expectedReceipt) fail(
    'TKR composition receipt failed its exact content-integrity check.',
    'TKR_RENDER_CONFLICT', { expected: expectedReceipt, received: receipt.receiptSha256 }
  );
  verifyBytes(selectedPrompt, receipt.selectedPrompt, 'Selected prompt bytes');
  // Active delivery says the candidate is the selected prompt. When a caller supplies only the
  // selected bytes (the normal prompt-snapshot read path), use those same trusted bytes to verify
  // every segment and protected span rather than trusting a re-sealed manifest digest.
  const verifiedCandidate = candidatePrompt ?? (
    receipt.activation === 'active' ? selectedPrompt : null
  );
  verifyBytes(verifiedCandidate, receipt.candidatePrompt, 'Candidate prompt bytes');
  if (verifiedCandidate != null) {
    const candidate = promptBytes(verifiedCandidate, 'Candidate prompt');
    for (const segment of receipt.composition.segments) {
      if (sha256(candidate.subarray(segment.start, segment.end)) !== segment.sha256) fail(
        `Candidate prompt changed segment '${segment.sectionId}'.`,
        'TKR_PROTECTED_CONTENT_CHANGED', { sectionId: segment.sectionId }
      );
    }
    for (const span of receipt.composition.protectedText) {
      if (sha256(candidate.subarray(span.blockRange.start, span.blockRange.end)) !== span.sha256) {
        fail(`Candidate prompt changed protected text in '${span.sectionId}'.`,
          'TKR_PROTECTED_CONTENT_CHANGED', { sectionId: span.sectionId });
      }
    }
  }
  const registration = schemaFamily(TOKEN_REDUCTION_COMPOSITION_FAMILY);
  if (!registration.immutable || registration.migrationPolicy !== 'frozen-identity') {
    fail('TKR composition receipt is not registered as a frozen immutable identity.');
  }
  return deepFreeze(receipt);
}

/**
 * Create one content-free composition receipt from the pure TKR composer and prompt adapter.
 * `selectedPrompt` is the exact prompt the established lifecycle chose. In active mode it must be
 * byte-identical to `composition.content`; shadow mode records either equality or difference while
 * leaving the selected prompt authoritative.
 */
export function createTokenReductionCompositionReceipt({
  activation = 'shadow', subject, authority, selectedPrompt, composition, sectionReport
} = {}) {
  oneOf(activation, ACTIVATIONS, 'TKR composition activation');
  receiptSubject(plain(structuredClone(subject), 'TKR composition subject'));
  receiptAuthority(plain(structuredClone(authority), 'TKR composition authority'), activation);
  plain(composition, 'TKR composer result');
  exact(composition, [
    'kind', 'version', 'composerSha256', 'content', 'bytes', 'sha256', 'separator',
    'segments', 'separators', 'protectedText', 'aliases', 'omissions', 'deduplication',
    'reduction', 'processing'
  ], 'TKR composer result');
  if (composition.kind !== 'tkr/composition-result' || composition.version !== 1) {
    fail('TKR composer result kind or version is unsupported.');
  }
  exact(composition.separator, ['utf8', 'bytes', 'sha256'], 'TKR composer separator');
  if (composition.separator.utf8 !== '\n\n'
      || composition.separator.bytes !== SEPARATOR.length
      || composition.separator.sha256 !== SEPARATOR_SHA256) {
    fail('TKR composer result does not use the frozen v1 LF-LF separator.',
      'TKR_RENDER_CONFLICT');
  }
  exact(composition.reduction, [
    'maximumBytes', 'initialBytes', 'finalBytes', 'attempts', 'accepted', 'visitedStates'
  ], 'TKR composer reduction report');
  exact(composition.processing, [
    'sectionRules', 'offers', 'presentationCandidates', 'coverageClaims', 'aliasEntries',
    'retainedAliasEntries', 'workingMetadataBytes'
  ], 'TKR composer processing report');
  plain(sectionReport, 'TKR prompt section report');
  exact(sectionReport, [
    'kind', 'version', 'sources', 'ownerAssuranceRefs', 'composerSha256',
    'compositionRef', 'measurement', 'sections'
  ], 'TKR prompt section report');
  if (sectionReport.kind !== 'tkr/prompt-section-report' || sectionReport.version !== 1) {
    fail('TKR prompt section report kind or version is unsupported.');
  }
  if (typeof composition.content !== 'string') fail(
    'TKR composer result.content must contain exact UTF-8 text.',
    'TKR_PROTECTED_CONTENT_CHANGED'
  );
  const candidatePrompt = promptRef(composition.content);
  if (composition.sha256 !== candidatePrompt.sha256 || composition.bytes !== candidatePrompt.bytes
      || sectionReport.composerSha256 !== composition.composerSha256
      || sectionReport.compositionRef?.sha256 !== composition.sha256
      || sectionReport.compositionRef?.bytes !== composition.bytes
      || sectionReport.compositionRef?.composerSha256 !== composition.composerSha256) {
    fail('TKR composer result and section report do not bind the same exact candidate.',
      'TKR_RENDER_CONFLICT');
  }
  const selectedRef = promptRef(selectedPrompt);
  const inputs = sectionReport.sections.map(normalizeInput);
  const manifest = normalizeComposition(composition);
  const core = {
    schemaVersion: currentSchemaVersion(TOKEN_REDUCTION_COMPOSITION_FAMILY),
    kind: TOKEN_REDUCTION_COMPOSITION_KIND,
    version: 1,
    activation,
    subject: structuredClone(subject),
    authority: structuredClone(authority),
    inputs,
    selectedPrompt: selectedRef,
    candidatePrompt,
    relationship: selectedRef.sha256 === candidatePrompt.sha256
      && selectedRef.bytes === candidatePrompt.bytes ? 'identical' : 'different',
    composition: manifest,
    compositionManifestSha256: sha256(manifest)
  };
  const receipt = sealRecord(core, 'receiptSha256');
  return validateTokenReductionCompositionReceipt(receipt, {
    selectedPrompt, candidatePrompt: composition.content
  });
}
