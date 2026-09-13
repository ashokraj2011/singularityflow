import { createHash } from 'node:crypto';

import { canonicalJson, recordSha256 } from './records.mjs';
import {
  TKR_COMPOSER_LIMITS,
  TKR_ERROR_CODES,
  TKR_REPRESENTATIONS,
  tkrLogicalComposerContract,
  validateTkrContractSet,
  validateTkrComposerContract as validateRegisteredTkrComposerContract
} from './token-reduction/contracts.mjs';
import {
  renderTkrGeneratedSection,
  TKR_GENERATED_RENDERER_REF
} from './token-reduction/generated-renderer.mjs';
import { SingularityFlowError } from './util.mjs';
import { deepFreeze } from './world-model/canonicalize.mjs';

export const TKR_COMPOSER_KIND = 'tkr/composer-contract';
export const TKR_COMPOSER_VERSION = 1;
export { TKR_ERROR_CODES, TKR_REPRESENTATIONS };
export const TKR_APPLICABILITIES = Object.freeze(['required', 'optional', 'not-applicable']);
export const TKR_GENERATORS = Object.freeze(['alias-table', 'omission-notices']);
export const TKR_INITIAL_LIMITS = TKR_COMPOSER_LIMITS;

const IDENTIFIER = /^[a-z][a-z0-9.-]{0,127}$/u;
const EXACT_CONTRACT_REF = /^[a-z][a-z0-9./-]*@[1-9][0-9]*#sha256:[a-f0-9]{64}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const ALIAS_ID = /^([A-Za-z]+)([1-9][0-9]*)$/u;
const SEPARATOR = Buffer.from('\n\n', 'utf8');
const OFFER_KEYS = new Set([
  'sectionId', 'subjectRef', 'evidenceRole', 'assuranceRef', 'requirementRef',
  'applicability', 'permittedRepresentations', 'coverage', 'representations', 'priority',
  'limitations'
]);
const CANDIDATE_KEYS = new Set([
  'representation', 'rendererRef', 'content', 'renderedRef', 'coverage', 'expansionRefs',
  'limitations', 'protectedSpans', 'aliasUses'
]);
const SUBJECT_REF_KEYS = new Set(['owner', 'domain', 'kind', 'id', 'revision', 'sourceRef']);
const COVERAGE_KEYS = new Set(['claimRef', 'subjectRef', 'evidenceRole', 'requirementRef']);
const PROOF_KEYS = new Set([
  'removedSectionId', 'removedRepresentation', 'carrierSectionId', 'carrierRepresentation',
  'coverage', 'ruleRef'
]);
const PROTECTED_SPAN_KEYS = new Set([
  'sourceRef', 'sourceBytes', 'sourceStart', 'sourceEnd', 'renderedStart', 'renderedEnd',
  'encoding'
]);
const ALIAS_KEYS = new Set(['id', 'namespace', 'scopeRef', 'targetRef']);
const ALIAS_USE_KEYS = new Set(['id', 'scopeRef', 'targetRef']);
const COMPOSITION_KEYS = new Set([
  'contract', 'contracts', 'rendererContracts', 'offers', 'deduplicationProofs', 'aliases',
  'compositionScopeRef', 'maximumBytes'
]);

function fail(code, message, details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function unsupported(message, details = null) {
  fail('TKR_CONTRACT_UNSUPPORTED', message, {
    ...details,
    nextAction: details?.nextAction
      ?? 'Install or select the exact registered TKR composer and renderer contracts.'
  });
}

function coverageUnproven(message, details = null) {
  fail('TKR_COVERAGE_UNPROVEN', message, {
    ...details,
    nextAction: details?.nextAction
      ?? 'Retain a permitted complete representation or correct the qualified coverage proof.'
  });
}

function plainObject(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)
      || value instanceof Uint8Array) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertObject(value, label, code = 'TKR_CONTRACT_UNSUPPORTED') {
  if (!plainObject(value)) fail(code, `${label} must be an object.`, { subject: label });
}

function assertClosedObject(value, allowed, label, code = 'TKR_CONTRACT_UNSUPPORTED') {
  assertObject(value, label, code);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) fail(code, `${label} contains unsupported field '${unknown[0]}'.`, {
    subject: label, unknownFields: unknown.sort()
  });
}

function nonemptyString(value, label, code = 'TKR_CONTRACT_UNSUPPORTED') {
  if (typeof value !== 'string' || !value.trim().length) fail(code, `${label} must be a non-whitespace string.`, {
    subject: label
  });
  return value;
}

function identifier(value, label, code = 'TKR_CONTRACT_UNSUPPORTED') {
  const result = nonemptyString(value, label, code);
  if (!IDENTIFIER.test(result)) fail(code, `${label} '${result}' is not a supported identifier.`, {
    subject: label, value: result
  });
  return result;
}

function exactContractRef(value, label) {
  const result = nonemptyString(value, label);
  if (!EXACT_CONTRACT_REF.test(result)) unsupported(`${label} is not an exact owner/version/digest reference.`, {
    subject: label, received: result
  });
  return result;
}

function uniqueStrings(value, label, {
  allowEmpty = true,
  identifiers = false,
  maximum = null,
  limit = 'maximumCoverageClaims'
} = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    unsupported(`${label} must be ${allowEmpty ? 'an' : 'a nonempty'} array.`, { subject: label });
  }
  if (maximum != null && value.length > maximum) {
    limitExceeded(limit, maximum, value.length);
  }
  const seen = new Set();
  return value.map((entry, index) => {
    const normalized = identifiers
      ? identifier(entry, `${label}[${index}]`)
      : nonemptyString(entry, `${label}[${index}]`);
    if (seen.has(normalized)) unsupported(`${label} contains duplicate '${normalized}'.`, {
      subject: label, duplicate: normalized
    });
    seen.add(normalized);
    return normalized;
  });
}

function boundedArray(value, label, maximum, limit = 'maximumCoverageClaims') {
  if (!Array.isArray(value)) unsupported(`${label} must be an array.`, { subject: label });
  if (value.length > maximum) limitExceeded(limit, maximum, value.length);
  return value;
}

function byteDigest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function stableValue(value) {
  if (value instanceof Uint8Array) {
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return { bytes: bytes.length, sha256: byteDigest(bytes) };
  }
  if (Array.isArray(value)) return value.map(stableValue);
  if (plainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().flatMap((key) => (
      value[key] === undefined ? [] : [[key, stableValue(value[key])]]
    )));
  }
  if (['string', 'number', 'boolean'].includes(typeof value) || value === null) return value;
  unsupported('TKR metadata contains a value that has no canonical JSON representation.', {
    valueType: typeof value
  });
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function compareCanonical(left, right) {
  return Buffer.compare(Buffer.from(stableJson(left), 'utf8'), Buffer.from(stableJson(right), 'utf8'));
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function metadataProjection(value, parentKey = '') {
  if (value instanceof Uint8Array) {
    const raw = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return { bytes: raw.length, sha256: byteDigest(raw) };
  }
  if (Array.isArray(value)) return value.map((entry) => metadataProjection(entry, parentKey));
  if (plainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      if (key === 'content' || key === 'sourceBytes') {
        const raw = utf8Bytes(entry, key, 'TKR_PROTECTED_CONTENT_CHANGED');
        return [key, { bytes: raw.length, sha256: byteDigest(raw) }];
      }
      return [key, metadataProjection(entry, key)];
    }));
  }
  if (value === undefined) return null;
  return value;
}

function metadataBytes(...values) {
  return values.reduce((total, value) => (
    total + Buffer.byteLength(stableJson(metadataProjection(value)), 'utf8')
  ), 0);
}

function limitExceeded(limit, maximum, required) {
  fail('TKR_LIMIT_EXCEEDED', `TKR composer limit '${limit}' is ${maximum}, but ${required} are required.`, {
    limit, maximum, required,
    nextAction: 'Use an admitted narrower scope or install a revised supported composer contract.'
  });
}

function positiveInteger(value, label, maximum = null) {
  if (!Number.isSafeInteger(value) || value <= 0) unsupported(`${label} must be a positive safe integer.`, {
    subject: label, received: value
  });
  if (maximum != null && value > maximum) unsupported(`${label} exceeds the supported version-1 ceiling.`, {
    subject: label, received: value, supportedMaximum: maximum
  });
  return value;
}

function utf8Bytes(value, label, code = 'TKR_CONTRACT_UNSUPPORTED') {
  let result;
  if (typeof value === 'string') {
    result = Buffer.from(value, 'utf8');
    if (result.toString('utf8') !== value) fail(code, `${label} is not a well-formed Unicode string.`, {
      subject: label
    });
  }
  else if (value instanceof Uint8Array) {
    result = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  } else fail(code, `${label} must contain exact UTF-8 bytes or a string.`, { subject: label });
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(result);
  } catch {
    fail(code, `${label} is not valid UTF-8.`, { subject: label, bytes: result.length });
  }
  return Buffer.from(result);
}

function utf8Boundary(bytes, offset) {
  return offset === 0 || offset === bytes.length || (bytes[offset] & 0xc0) !== 0x80;
}

function byteRange(start, end, length, label, code = 'TKR_PROTECTED_CONTENT_CHANGED') {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || end < start || end > length) {
    fail(code, `${label} is not an in-bounds half-open byte range.`, {
      subject: label, start, end, availableBytes: length
    });
  }
  return { start, end };
}

function exactSubjectRef(value, label, code = 'TKR_CONTRACT_UNSUPPORTED') {
  assertClosedObject(value, SUBJECT_REF_KEYS, label, code);
  const result = {};
  for (const key of SUBJECT_REF_KEYS) result[key] = nonemptyString(value[key], `${label}.${key}`, code);
  return result;
}

function normalizeCoverageEntry(entry, offer, label) {
  const normalized = typeof entry === 'string'
    ? {
      claimRef: nonemptyString(entry, label),
      subjectRef: offer.subjectRef,
      evidenceRole: offer.evidenceRole,
      requirementRef: offer.requirementRef
    }
    : (() => {
      assertClosedObject(entry, COVERAGE_KEYS, label);
      return {
        claimRef: nonemptyString(entry.claimRef, `${label}.claimRef`),
        subjectRef: exactSubjectRef(entry.subjectRef, `${label}.subjectRef`),
        evidenceRole: identifier(entry.evidenceRole, `${label}.evidenceRole`),
        requirementRef: nonemptyString(entry.requirementRef, `${label}.requirementRef`)
      };
    })();
  const mismatched = [];
  if (stableJson(normalized.subjectRef) !== stableJson(offer.subjectRef)) {
    mismatched.push('subjectRef');
  }
  if (normalized.evidenceRole !== offer.evidenceRole) mismatched.push('evidenceRole');
  if (normalized.requirementRef !== offer.requirementRef) mismatched.push('requirementRef');
  if (mismatched.length) coverageUnproven(
    `${label} is not qualified by its enclosing subject, evidence role, and requirement.`,
    {
      sectionId: offer.sectionId,
      claimRef: normalized.claimRef,
      mismatched,
      expectedSubjectRef: offer.subjectRef,
      expectedEvidenceRole: offer.evidenceRole,
      expectedRequirementRef: offer.requirementRef
    }
  );
  return normalized;
}

function coverageKey(entry) {
  return stableJson(entry);
}

function normalizeCoverage(value, offer, label, { allowEmpty = false, counter = null } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    unsupported(`${label} must be ${allowEmpty ? 'an' : 'a nonempty'} array.`, { subject: label });
  }
  if (counter) {
    counter.count += value.length;
    if (counter.count > counter.maximum) {
      limitExceeded('maximumCoverageClaims', counter.maximum, counter.count);
    }
  }
  const seen = new Set();
  return value.map((entry, index) => {
    const normalized = normalizeCoverageEntry(entry, offer, `${label}[${index}]`);
    const key = coverageKey(normalized);
    if (seen.has(key)) unsupported(`${label} contains a duplicate qualified coverage claim.`, {
      subject: label, claim: normalized
    });
    seen.add(key);
    return normalized;
  });
}

function includesAllCoverage(candidateCoverage, requiredCoverage) {
  const available = new Set(candidateCoverage.map(coverageKey));
  return requiredCoverage.every((entry) => available.has(coverageKey(entry)));
}

function sameCoverage(left, right) {
  if (left.length !== right.length) return false;
  const rightKeys = new Set(right.map(coverageKey));
  return left.every((entry) => rightKeys.has(coverageKey(entry)));
}

function normalizeProtectedSpan(span, contentBytes, offer, label) {
  assertClosedObject(span, PROTECTED_SPAN_KEYS, label, 'TKR_PROTECTED_CONTENT_CHANGED');
  if (span.encoding !== 'literal-utf8') fail(
    'TKR_CONTRACT_UNSUPPORTED',
    `${label}.encoding '${span.encoding}' is unsupported; version 1 accepts literal-utf8 only.`,
    { subject: label, encoding: span.encoding }
  );
  const sourceRef = nonemptyString(span.sourceRef, `${label}.sourceRef`, 'TKR_PROTECTED_CONTENT_CHANGED');
  const sourceBytes = utf8Bytes(span.sourceBytes, `${label}.sourceBytes`, 'TKR_PROTECTED_CONTENT_CHANGED');
  const sourceRange = byteRange(
    span.sourceStart, span.sourceEnd, sourceBytes.length, `${label}.sourceRange`
  );
  const renderedRange = byteRange(
    span.renderedStart, span.renderedEnd, contentBytes.length, `${label}.renderedRange`
  );
  const ownerSourceRef = offer.subjectRef.sourceRef;
  const qualifiedRangeRef = `${ownerSourceRef}#bytes=${sourceRange.start}-${sourceRange.end}`;
  if (sourceRef !== ownerSourceRef && sourceRef !== qualifiedRangeRef) {
    fail(
      'TKR_PROTECTED_CONTENT_CHANGED',
      `${label}.sourceRef is not bound to its enclosing owner subject.`,
      {
        subject: label,
        sectionId: offer.sectionId,
        sourceRef,
        expectedSourceRef: ownerSourceRef,
        expectedRangeSourceRef: qualifiedRangeRef
      }
    );
  }
  if (!utf8Boundary(sourceBytes, sourceRange.start) || !utf8Boundary(sourceBytes, sourceRange.end)
      || !utf8Boundary(contentBytes, renderedRange.start) || !utf8Boundary(contentBytes, renderedRange.end)) {
    fail('TKR_PROTECTED_CONTENT_CHANGED', `${label} does not align to UTF-8 byte boundaries.`, {
      subject: label, sourceRef, sourceRange, renderedRange
    });
  }
  const expected = sourceBytes.subarray(sourceRange.start, sourceRange.end);
  const actual = contentBytes.subarray(renderedRange.start, renderedRange.end);
  if (!expected.equals(actual)) fail('TKR_PROTECTED_CONTENT_CHANGED', `${label} changed protected source bytes.`, {
    subject: label,
    sourceRef,
    sourceRange,
    renderedRange,
    expectedSha256: byteDigest(expected),
    actualSha256: byteDigest(actual)
  });
  return {
    sourceRef,
    sourceRange,
    renderedRange,
    sha256: byteDigest(expected),
    bytes: expected.length,
    encoding: 'literal-utf8'
  };
}

function normalizeRenderedRef(value, contentBytes, label) {
  assertClosedObject(value, new Set(['sha256', 'bytes']), label);
  if (!SHA256.test(value.sha256 ?? '') || !Number.isSafeInteger(value.bytes) || value.bytes < 0) {
    unsupported(`${label} must contain an exact sha256 digest and byte length.`, { subject: label });
  }
  const actual = { sha256: byteDigest(contentBytes), bytes: contentBytes.length };
  if (value.sha256 !== actual.sha256 || value.bytes !== actual.bytes) {
    fail('TKR_RENDER_CONFLICT', `${label} does not identify the supplied rendered bytes.`, {
      subject: label, expected: value, actual,
      nextAction: 'Re-render through the pinned renderer and retain one exact identity.'
    });
  }
  return actual;
}

function normalizeAliasUse(value, label) {
  assertClosedObject(value, ALIAS_USE_KEYS, label, 'TKR_ALIAS_INVALID');
  return {
    id: nonemptyString(value.id, `${label}.id`, 'TKR_ALIAS_INVALID'),
    scopeRef: nonemptyString(value.scopeRef, `${label}.scopeRef`, 'TKR_ALIAS_INVALID'),
    targetRef: exactSubjectRef(value.targetRef, `${label}.targetRef`, 'TKR_ALIAS_INVALID')
  };
}

function normalizeCandidate(value, offer, contract, representationRules, coverageCounter, label) {
  assertClosedObject(value, CANDIDATE_KEYS, label);
  if (!TKR_REPRESENTATIONS.includes(value.representation)) unsupported(
    `${label}.representation '${value.representation}' is unsupported.`,
    { subject: offer.subjectRef, representation: value.representation }
  );
  if (!offer.permittedRepresentations.includes(value.representation)) unsupported(
    `${label}.representation '${value.representation}' is not permitted for '${offer.sectionId}'.`,
    { subject: offer.subjectRef, representation: value.representation }
  );
  const rendererRef = exactContractRef(value.rendererRef, `${label}.rendererRef`);
  if (!contract.renderers.includes(rendererRef)) unsupported(
    `${label}.rendererRef is not in the pinned composer renderer list.`,
    { subject: offer.subjectRef, rendererRef }
  );
  if (rendererRef === TKR_GENERATED_RENDERER_REF) unsupported(
    `${label}.rendererRef is reserved for composer-generated framing sections.`,
    { subject: offer.subjectRef, rendererRef, representation: value.representation }
  );
  const rendererRegistration = contract.rendererContracts.find((entry) => (
    entry.rendererRef === rendererRef
  ));
  if (!rendererRegistration || rendererRegistration.mode !== 'source-pass-through') unsupported(
    `${label}.rendererRef is not registered for exact source pass-through.`,
    { subject: offer.subjectRef, rendererRef,
      mode: rendererRegistration?.mode ?? null }
  );
  const contentBytes = utf8Bytes(value.content, `${label}.content`);
  if (contentBytes.length === 0 || contentBytes.toString('utf8').trim().length === 0) unsupported(`${label}.content cannot be empty.`, {
    subject: offer.subjectRef, representation: value.representation
  });
  const coverage = normalizeCoverage(value.coverage, offer, `${label}.coverage`, {
    counter: coverageCounter
  });
  const expansionRefs = uniqueStrings(value.expansionRefs ?? [], `${label}.expansionRefs`, {
    maximum: contract.limits.maximumCoverageClaims
  });
  const representationRule = representationRules.representations.find((entry) => (
    entry.id === value.representation
  ));
  if (!representationRule) unsupported(
    `${label} has no exact registered representation rule.`,
    { subject: offer.subjectRef, representation: value.representation }
  );
  if (representationRule.expansion === 'required' && expansionRefs.length === 0) coverageUnproven(
    `${label} uses ${value.representation} without an exact expansion reference.`,
    { subject: offer.subjectRef, representation: value.representation,
      reason: 'expansion-reference-unavailable' }
  );
  const limitations = uniqueStrings(value.limitations ?? [], `${label}.limitations`, {
    maximum: contract.limits.maximumCoverageClaims
  });
  const rawProtectedSpans = boundedArray(
    value.protectedSpans ?? [], `${label}.protectedSpans`,
    contract.limits.maximumCoverageClaims
  );
  const rawAliasUses = boundedArray(
    value.aliasUses ?? [], `${label}.aliasUses`, contract.limits.maximumAliases,
    'maximumAliases'
  );
  const protectedSpans = rawProtectedSpans.map((span, index) => (
    normalizeProtectedSpan(
      span,
      contentBytes,
      offer,
      `${label}.protectedSpans[${index}]`
    )
  ));
  const aliasUses = rawAliasUses.map((entry, index) => (
    normalizeAliasUse(entry, `${label}.aliasUses[${index}]`)
  ));
  return {
    representation: value.representation,
    rendererRef,
    contentBytes,
    renderedRef: normalizeRenderedRef(value.renderedRef, contentBytes, `${label}.renderedRef`),
    coverage,
    expansionRefs,
    limitations,
    protectedSpans,
    aliasUses
  };
}

function generatorRules(sectionRules) {
  const byGenerator = new Map();
  for (const rule of sectionRules) {
    if (!rule.generator) continue;
    byGenerator.set(rule.generator, rule);
  }
  return byGenerator;
}

/**
 * Validate a registered immutable TKR v1 composer and project its runtime logical contract.
 *
 * The five referenced contracts are mandatory and revalidate the complete owner closure.
 * The returned `composerSha256` is the durable record's self-hash, never a second runtime identity.
 */
function validateComposerClosure(value, contracts, rendererContracts) {
  if (!Array.isArray(contracts) || !Array.isArray(rendererContracts)) unsupported(
    'TKR composition requires the exact semantic owner and runtime renderer closures.',
    {
      missingCapability: !Array.isArray(contracts)
        ? 'tkr-semantic-contract-closure'
        : 'tkr-renderer-contract-closure'
    }
  );
  const closure = validateTkrContractSet({ composer: value, contracts, rendererContracts });
  const logical = tkrLogicalComposerContract(closure.composer, {
    contracts: closure.contracts,
    rendererContracts: closure.rendererContracts
  });
  return {
    contract: Object.freeze({
      ...logical,
      sectionRules: Object.freeze(logical.sectionRules.map((entry, index) => Object.freeze({
        ...entry, index
      }))),
      rendererContracts: closure.rendererContracts,
      composerSha256: closure.composer.contractSha256
    }),
    contracts: closure.contracts,
    rendererContracts: closure.rendererContracts
  };
}

export function validateTkrComposerContract(value, { contracts, rendererContracts } = {}) {
  return validateComposerClosure(value, contracts, rendererContracts).contract;
}

function normalizeOffer(value, contract, representationRules, coverageCounter, rule, label) {
  assertClosedObject(value, OFFER_KEYS, label);
  const sectionId = identifier(value.sectionId, `${label}.sectionId`);
  if (sectionId !== rule.id) unsupported(`${label}.sectionId does not match its composer rule.`, {
    sectionId, expectedSectionId: rule.id
  });
  const subjectRef = exactSubjectRef(value.subjectRef, `${label}.subjectRef`);
  const evidenceRole = identifier(value.evidenceRole, `${label}.evidenceRole`);
  if (!rule.permittedRoles.includes(evidenceRole)) unsupported(
    `Section '${sectionId}' cannot be placed in role '${evidenceRole}'.`,
    { sectionId, role: evidenceRole, permittedRoles: rule.permittedRoles }
  );
  const assuranceRef = nonemptyString(value.assuranceRef, `${label}.assuranceRef`);
  const requirementRef = nonemptyString(value.requirementRef, `${label}.requirementRef`);
  if (!TKR_APPLICABILITIES.includes(value.applicability)) {
    if (value.applicability === 'unknown') coverageUnproven(
      `Required applicability is unknown for section '${sectionId}'.`,
      { sectionId, subjectRef, requirementRef, reason: 'applicability-unknown' }
    );
    unsupported(`${label}.applicability '${value.applicability}' is unsupported.`, {
      sectionId, applicability: value.applicability
    });
  }
  const permittedRepresentations = uniqueStrings(
    value.permittedRepresentations ?? [], `${label}.permittedRepresentations`,
    {
      allowEmpty: value.applicability === 'not-applicable',
      maximum: contract.limits.maximumCandidatesPerSubject,
      limit: 'maximumCandidatesPerSubject'
    }
  );
  for (const representation of permittedRepresentations) {
    if (!TKR_REPRESENTATIONS.includes(representation)) unsupported(
      `Section '${sectionId}' permits unknown representation '${representation}'.`,
      { sectionId, representation }
    );
  }
  const offer = {
    sectionId,
    subjectRef,
    evidenceRole,
    assuranceRef,
    requirementRef,
    applicability: value.applicability,
    permittedRepresentations,
    priority: value.priority == null ? 0 : value.priority,
    limitations: uniqueStrings(value.limitations ?? [], `${label}.limitations`, {
      maximum: contract.limits.maximumCoverageClaims
    }),
    rule
  };
  if (!Number.isSafeInteger(offer.priority)) unsupported(`${label}.priority must be a safe integer.`, {
    sectionId, received: value.priority
  });
  offer.coverage = normalizeCoverage(value.coverage ?? [], offer, `${label}.coverage`, {
    allowEmpty: value.applicability === 'not-applicable', counter: coverageCounter
  });
  const rawCandidates = value.representations ?? [];
  if (!Array.isArray(rawCandidates)) unsupported(`${label}.representations must be an array.`, {
    sectionId
  });
  if (rawCandidates.length > contract.limits.maximumCandidatesPerSubject) {
    limitExceeded(
      'maximumCandidatesPerSubject', contract.limits.maximumCandidatesPerSubject,
      rawCandidates.length
    );
  }
  const byRepresentation = new Map();
  for (let index = 0; index < rawCandidates.length; index += 1) {
    const candidate = normalizeCandidate(
      rawCandidates[index], offer, contract, representationRules, coverageCounter,
      `${label}.representations[${index}]`
    );
    const prior = byRepresentation.get(candidate.representation);
    if (prior) {
      if (prior.renderedRef.sha256 !== candidate.renderedRef.sha256) fail(
        'TKR_RENDER_CONFLICT',
        `Section '${sectionId}' has different bytes for representation '${candidate.representation}'.`,
        { sectionId, representation: candidate.representation,
          digests: [prior.renderedRef.sha256, candidate.renderedRef.sha256] }
      );
      unsupported(`Section '${sectionId}' repeats representation '${candidate.representation}'.`, {
        sectionId, representation: candidate.representation
      });
    }
    byRepresentation.set(candidate.representation, candidate);
  }
  offer.candidates = permittedRepresentations.flatMap((representation) => {
    const candidate = byRepresentation.get(representation);
    return candidate && includesAllCoverage(candidate.coverage, offer.coverage) ? [candidate] : [];
  });
  offer.presentationCandidateCount = byRepresentation.size;
  return offer;
}

function protectedContinuity(span) {
  return {
    sourceRef: span.sourceRef,
    sourceRange: span.sourceRange,
    sha256: span.sha256,
    bytes: span.bytes,
    encoding: span.encoding
  };
}

function candidateProofBinding(offer, candidate, representationRules) {
  const representationRule = representationRules.representations.find((entry) => (
    entry.id === candidate.representation
  ));
  return {
    sectionId: offer.sectionId,
    subjectRef: offer.subjectRef,
    evidenceRole: offer.evidenceRole,
    assuranceRef: offer.assuranceRef,
    requirementRef: offer.requirementRef,
    applicability: offer.applicability,
    slot: offer.rule.slot,
    orderGroup: offer.rule.orderGroup,
    stability: offer.rule.stability,
    representation: candidate.representation,
    completeness: representationRule.completeness,
    rendererRef: candidate.rendererRef,
    renderedRef: candidate.renderedRef,
    coverage: candidate.coverage,
    expansionRefs: candidate.expansionRefs,
    offerLimitations: offer.limitations,
    candidateLimitations: candidate.limitations,
    aliasUses: candidate.aliasUses,
    protectedContinuity: candidate.protectedSpans.map((span) => ({
      ...protectedContinuity(span),
      renderedRange: span.renderedRange
    }))
  };
}

function normalizeProof(
  value, offersBySection, contract, representationRules, coverageCounter, label
) {
  assertClosedObject(value, PROOF_KEYS, label);
  const removedSectionId = identifier(value.removedSectionId, `${label}.removedSectionId`);
  const carrierSectionId = identifier(value.carrierSectionId, `${label}.carrierSectionId`);
  if (removedSectionId === carrierSectionId) fail(
    'TKR_RENDER_CONFLICT', `${label} cannot make a section its own deduplication carrier.`,
    { sectionId: removedSectionId }
  );
  const removed = offersBySection.get(removedSectionId);
  const carrier = offersBySection.get(carrierSectionId);
  if (!removed || !carrier) coverageUnproven(`${label} names an unavailable presentation.`, {
    removedSectionId, carrierSectionId
  });
  if (value.ruleRef !== contract.deduplicationRulesRef) coverageUnproven(
    `${label} does not use the pinned deduplication rule.`,
    { removedSectionId, carrierSectionId, ruleRef: value.ruleRef,
      expectedRuleRef: contract.deduplicationRulesRef }
  );
  if (!TKR_REPRESENTATIONS.includes(value.removedRepresentation)
      || !TKR_REPRESENTATIONS.includes(value.carrierRepresentation)) coverageUnproven(
    `${label} names an unsupported representation.`, { removedSectionId, carrierSectionId }
  );
  const removedCandidate = removed.candidates.find((entry) => (
    entry.representation === value.removedRepresentation
  ));
  const carrierCandidate = carrier.candidates.find((entry) => (
    entry.representation === value.carrierRepresentation
  ));
  if (!removedCandidate || !carrierCandidate) coverageUnproven(
    `${label} does not bind available permitted representation candidates.`,
    { removedSectionId, removedRepresentation: value.removedRepresentation,
      carrierSectionId, carrierRepresentation: value.carrierRepresentation }
  );
  const coverage = normalizeCoverage(value.coverage, removed, `${label}.coverage`, {
    counter: coverageCounter
  });
  if (!sameCoverage(coverage, removed.coverage)
      || !includesAllCoverage(removedCandidate.coverage, coverage)
      || !includesAllCoverage(carrierCandidate.coverage, coverage)) coverageUnproven(
    `${label} does not prove every qualified requirement and evidence role of '${removedSectionId}'.`,
    { removedSectionId, carrierSectionId, unsatisfiedCoverage: removed.coverage.filter((entry) => (
      !carrierCandidate.coverage.some((candidate) => coverageKey(candidate) === coverageKey(entry))
    )) }
  );
  const removedBinding = candidateProofBinding(removed, removedCandidate, representationRules);
  const carrierBinding = candidateProofBinding(carrier, carrierCandidate, representationRules);
  const incompatibleBoundary = [];
  if (stableJson(removed.subjectRef) !== stableJson(carrier.subjectRef)) {
    incompatibleBoundary.push('subject');
  }
  if (removed.evidenceRole !== carrier.evidenceRole) incompatibleBoundary.push('evidence-role');
  if (removed.assuranceRef !== carrier.assuranceRef) incompatibleBoundary.push('assurance');
  if (removed.rule.slot !== carrier.rule.slot) incompatibleBoundary.push('slot');
  if (removed.rule.orderGroup !== carrier.rule.orderGroup) incompatibleBoundary.push('order-group');
  if (removed.rule.stability !== carrier.rule.stability) incompatibleBoundary.push('stability');
  if (carrier.rule.index >= removed.rule.index) incompatibleBoundary.push('carrier-order');
  if (removedBinding.completeness !== carrierBinding.completeness) {
    incompatibleBoundary.push('completeness');
  }
  if (incompatibleBoundary.length) coverageUnproven(
    `${label} crosses a subject, role, assurance, ordering, or completeness boundary.`,
    { removedSectionId, carrierSectionId, incompatibleBoundary }
  );
  const requiredLimitations = [...new Set([
    ...removed.limitations, ...removedCandidate.limitations
  ])];
  const carrierLimitations = new Set([
    ...carrier.limitations, ...carrierCandidate.limitations
  ]);
  const missingLimitations = requiredLimitations.filter((entry) => !carrierLimitations.has(entry));
  if (missingLimitations.length) coverageUnproven(
    `${label} does not retain every limitation of '${removedSectionId}'.`,
      { removedSectionId, carrierSectionId, missingLimitations }
  );
  const carrierExpansionRefs = new Set(carrierCandidate.expansionRefs);
  const missingExpansionRefs = removedCandidate.expansionRefs.filter((entry) => (
    !carrierExpansionRefs.has(entry)
  ));
  if (missingExpansionRefs.length) coverageUnproven(
    `${label} does not retain every expansion reference of '${removedSectionId}'.`,
    { removedSectionId, carrierSectionId, missingExpansionRefs }
  );
  const carrierAliasUses = new Set(carrierCandidate.aliasUses.map(stableJson));
  const missingAliasUses = removedCandidate.aliasUses.filter((entry) => (
    !carrierAliasUses.has(stableJson(entry))
  ));
  if (missingAliasUses.length) fail(
    'TKR_ALIAS_INVALID',
    `${label} does not retain every alias binding of '${removedSectionId}'.`,
    { removedSectionId, carrierSectionId, missingAliasUses }
  );
  const exactBytesRequired = removed.applicability === 'required'
    || removed.rule.stability === 'invariant';
  if (exactBytesRequired
      && (removedCandidate.renderedRef.sha256 !== carrierCandidate.renderedRef.sha256
        || removedCandidate.renderedRef.bytes !== carrierCandidate.renderedRef.bytes)) {
    fail(
      'TKR_PROTECTED_CONTENT_CHANGED',
      `${label} cannot replace required full or invariant bytes with different carrier bytes.`,
      { removedSectionId, carrierSectionId,
        removedRenderedRef: removedCandidate.renderedRef,
        carrierRenderedRef: carrierCandidate.renderedRef }
    );
  }
  const carrierContinuity = new Set(
    carrierCandidate.protectedSpans.map((span) => stableJson(protectedContinuity(span)))
  );
  const missingProtectedContinuity = removedCandidate.protectedSpans
    .map(protectedContinuity)
    .filter((span) => !carrierContinuity.has(stableJson(span)));
  if (missingProtectedContinuity.length) fail(
    'TKR_PROTECTED_CONTENT_CHANGED',
    `${label} does not retain protected source continuity in '${carrierSectionId}'.`,
    { removedSectionId, carrierSectionId, missingProtectedContinuity }
  );
  const removedCandidateRef = `sha256:${recordSha256(removedBinding)}`;
  const carrierCandidateRef = `sha256:${recordSha256(carrierBinding)}`;
  const proofCore = {
    composerSha256: contract.composerSha256,
    removedCandidateRef,
    carrierCandidateRef,
    coverage,
    ruleRef: value.ruleRef
  };
  return {
    removedSectionId,
    removedRepresentation: value.removedRepresentation,
    carrierSectionId,
    carrierRepresentation: value.carrierRepresentation,
    coverage,
    ruleRef: value.ruleRef,
    removedCandidateRef,
    carrierCandidateRef,
    removedBinding,
    carrierBinding,
    proofSha256: `sha256:${recordSha256(proofCore)}`
  };
}

/** Validate deterministic packet-scoped aliases and return target-sorted entries. */
export function validateTkrAliases(value, {
  maximumAliases = TKR_INITIAL_LIMITS.maximumAliases,
  compositionScopeRef = null
} = {}) {
  if (!Array.isArray(value)) fail('TKR_ALIAS_INVALID', 'TKR aliases must be an array.', {
    subject: 'aliases'
  });
  if (value.length > maximumAliases) limitExceeded('maximumAliases', maximumAliases, value.length);
  const expectedScopeRef = value.length
    ? nonemptyString(compositionScopeRef, 'compositionScopeRef', 'TKR_ALIAS_INVALID')
    : null;
  const ids = new Set();
  const targets = new Set();
  const namespaceKinds = new Map();
  const kindNamespaces = new Map();
  const normalized = value.map((entry, index) => {
    const label = `aliases[${index}]`;
    assertClosedObject(entry, ALIAS_KEYS, label, 'TKR_ALIAS_INVALID');
    const id = nonemptyString(entry.id, `${label}.id`, 'TKR_ALIAS_INVALID');
    const match = ALIAS_ID.exec(id);
    if (!match || match[2].startsWith('0')) fail('TKR_ALIAS_INVALID', `Alias '${id}' is not a typed ASCII positive sequence ID.`, {
      aliasId: id
    });
    const namespace = nonemptyString(entry.namespace, `${label}.namespace`, 'TKR_ALIAS_INVALID');
    if (namespace !== match[1]) fail('TKR_ALIAS_INVALID', `Alias '${id}' does not match namespace '${namespace}'.`, {
      aliasId: id, namespace
    });
    const sequence = Number(match[2]);
    if (!Number.isSafeInteger(sequence)) fail('TKR_ALIAS_INVALID', `Alias '${id}' sequence is not a safe integer.`, {
      aliasId: id
    });
    const scopeRef = nonemptyString(entry.scopeRef, `${label}.scopeRef`, 'TKR_ALIAS_INVALID');
    const targetRef = exactSubjectRef(entry.targetRef, `${label}.targetRef`, 'TKR_ALIAS_INVALID');
    if (ids.has(id)) fail('TKR_ALIAS_INVALID', `Alias ID '${id}' is duplicated.`, { aliasId: id });
    const targetKey = stableJson(targetRef);
    if (targets.has(targetKey)) fail('TKR_ALIAS_INVALID', `Alias target '${targetRef.id}' is duplicated.`, {
      targetRef
    });
    ids.add(id);
    targets.add(targetKey);
    const priorKind = namespaceKinds.get(namespace);
    if (priorKind && priorKind !== targetRef.kind) fail('TKR_ALIAS_INVALID', `Alias namespace '${namespace}' crosses target types.`, {
      namespace, targetKinds: [priorKind, targetRef.kind]
    });
    const priorNamespace = kindNamespaces.get(targetRef.kind);
    if (priorNamespace && priorNamespace !== namespace) fail('TKR_ALIAS_INVALID', `Alias target type '${targetRef.kind}' uses ambiguous namespaces.`, {
      targetKind: targetRef.kind, namespaces: [priorNamespace, namespace]
    });
    namespaceKinds.set(namespace, targetRef.kind);
    kindNamespaces.set(targetRef.kind, namespace);
    return { id, namespace, sequence, scopeRef, targetRef };
  });
  const scopes = new Set(normalized.map((entry) => entry.scopeRef));
  if (scopes.size > 1) fail('TKR_ALIAS_INVALID', 'Alias mapping crosses retained block scopes.', {
    scopeRefs: [...scopes].sort()
  });
  if (normalized.length && normalized[0].scopeRef !== expectedScopeRef) fail(
    'TKR_ALIAS_INVALID',
    'Alias mapping does not belong to the expected composition scope.',
    { expectedScopeRef, receivedScopeRef: normalized[0].scopeRef }
  );
  for (const entry of normalized) {
    if (ids.has(entry.targetRef.id)) fail(
      'TKR_ALIAS_INVALID',
      `Alias '${entry.id}' targets alias ID '${entry.targetRef.id}'; alias chains and cycles are forbidden.`,
      { aliasId: entry.id, targetAliasId: entry.targetRef.id }
    );
  }
  const groups = new Map();
  for (const entry of normalized) {
    const group = groups.get(entry.namespace) ?? [];
    group.push(entry);
    groups.set(entry.namespace, group);
  }
  for (const [namespace, entries] of groups) {
    const ordered = [...entries].sort((left, right) => compareCanonical(left.targetRef, right.targetRef));
    for (let index = 0; index < ordered.length; index += 1) {
      if (ordered[index].sequence !== index + 1) fail('TKR_ALIAS_INVALID', `Alias namespace '${namespace}' is not numbered by canonical target order.`, {
        namespace, aliasId: ordered[index].id, expectedId: `${namespace}${index + 1}`
      });
    }
  }
  return deepFreeze([...normalized]
    .sort((left, right) => compareUtf8(left.namespace, right.namespace)
      || left.sequence - right.sequence)
    .map(({ sequence, ...entry }) => entry));
}

function validateAliasUses(offers, aliases) {
  const byId = new Map(aliases.map((entry) => [entry.id, entry]));
  for (const offer of offers) {
    for (const candidate of offer.candidates) {
      for (const use of candidate.aliasUses) {
        const mapping = byId.get(use.id);
        if (!mapping || mapping.scopeRef !== use.scopeRef
            || stableJson(mapping.targetRef) !== stableJson(use.targetRef)) fail(
          'TKR_ALIAS_INVALID',
          `Section '${offer.sectionId}' uses undefined, cross-scope, or mismatched alias '${use.id}'.`,
          { sectionId: offer.sectionId, aliasId: use.id, scopeRef: use.scopeRef }
        );
      }
    }
  }
}

function generatorContent(generator, payload, rendererRef) {
  if (rendererRef !== TKR_GENERATED_RENDERER_REF) unsupported(
    `Generated section '${generator}' is not bound to the packaged generated renderer.`,
    { generator, rendererRef, expectedRendererRef: TKR_GENERATED_RENDERER_REF }
  );
  return renderTkrGeneratedSection(generator, payload, { rendererRef });
}

function omissionRecord(offer, reason, candidate = null, extra = {}) {
  return {
    sectionId: offer.sectionId,
    subjectRef: offer.subjectRef,
    evidenceRole: offer.evidenceRole,
    requirementRef: offer.requirementRef,
    reason,
    originalRenderedRef: candidate?.renderedRef ?? null,
    expansionRefs: candidate?.expansionRefs ?? [],
    limitations: candidate?.limitations ?? offer.limitations,
    ...extra
  };
}

function activeDependenciesSatisfied(offers, selections, explicitOmissions, carriedBy) {
  const active = new Set(offers.filter((offer) => (
    offer.applicability !== 'not-applicable'
      && selections.has(offer.sectionId)
      && !explicitOmissions.has(offer.sectionId)
  )).map((offer) => offer.sectionId));
  for (const offer of offers) {
    if (!active.has(offer.sectionId)) continue;
    for (const dependency of offer.rule.dependencies) {
      if (!active.has(dependency) && !carriedBy.has(dependency)) coverageUnproven(
        `Section '${offer.sectionId}' has no retained carrier for dependency '${dependency}'.`,
        { sectionId: offer.sectionId, dependency }
      );
    }
  }
}

function validateMaterializedDependencies(segmentEntries, carriedBy) {
  const positions = new Map(segmentEntries.map((entry, index) => [entry.rule.id, index]));
  const retainedId = (sectionId) => carriedBy.get(sectionId) ?? sectionId;
  const verify = (sectionId, dependencies, position, { carrierId = null } = {}) => {
    for (const dependency of dependencies) {
      const retainedDependency = retainedId(dependency);
      const dependencyPosition = positions.get(retainedDependency);
      const carriedIntoCurrent = carrierId != null && retainedDependency === carrierId;
      if (dependencyPosition == null || dependencyPosition > position
          || (dependencyPosition === position && !carriedIntoCurrent)) coverageUnproven(
        `Section '${sectionId}' cannot retain dependency '${dependency}' in final order.`,
        {
          sectionId,
          dependency,
          retainedDependency,
          dependencyPosition: dependencyPosition ?? null,
          sectionPosition: position,
          reason: dependencyPosition == null ? 'dependency-unavailable' : 'dependency-order'
        }
      );
    }
  };
  for (let index = 0; index < segmentEntries.length; index += 1) {
    const entry = segmentEntries[index];
    verify(entry.rule.id, entry.rule.dependencies, index);
    for (const carried of entry.carried) {
      verify(carried.sectionId, carried.dependencies, index, { carrierId: entry.rule.id });
    }
  }
}

function materialize({ contract, offers, proofs, aliases, selections, explicitOmissions }) {
  const selected = new Map();
  const omissions = [];
  for (const offer of offers) {
    if (offer.applicability === 'not-applicable') {
      omissions.push(omissionRecord(offer, 'not-applicable'));
      continue;
    }
    const candidate = selections.get(offer.sectionId);
    if (!candidate) {
      if (offer.applicability === 'required') coverageUnproven(
        `Required section '${offer.sectionId}' has no representation proving its coverage.`,
        { sectionId: offer.sectionId, subjectRef: offer.subjectRef,
          requiredCoverage: offer.coverage }
      );
      omissions.push(omissionRecord(offer, 'unavailable'));
      continue;
    }
    if (explicitOmissions.has(offer.sectionId)) {
      omissions.push(omissionRecord(offer, 'budget', candidate));
      continue;
    }
    selected.set(offer.sectionId, { offer, candidate, carried: [] });
  }

  const activeProofs = [];
  const removed = new Set();
  for (const proof of proofs) {
    const removedEntry = selected.get(proof.removedSectionId);
    const carrierEntry = selected.get(proof.carrierSectionId);
    if (!removedEntry || !carrierEntry
        || removedEntry.candidate.representation !== proof.removedRepresentation
        || carrierEntry.candidate.representation !== proof.carrierRepresentation) continue;
    if (removed.has(proof.removedSectionId)) fail(
      'TKR_RENDER_CONFLICT', `Section '${proof.removedSectionId}' has multiple active deduplication carriers.`,
      { sectionId: proof.removedSectionId }
    );
    removed.add(proof.removedSectionId);
    activeProofs.push(proof);
  }
  for (const proof of activeProofs) {
    if (removed.has(proof.carrierSectionId)) fail(
      'TKR_RENDER_CONFLICT',
      `Deduplication carrier '${proof.carrierSectionId}' is itself removed by an active proof.`,
      { removedSectionId: proof.removedSectionId, carrierSectionId: proof.carrierSectionId }
    );
  }
  const carriedBy = new Map();
  for (const proof of activeProofs) {
    const removedEntry = selected.get(proof.removedSectionId);
    const carrierEntry = selected.get(proof.carrierSectionId);
    selected.delete(proof.removedSectionId);
    carriedBy.set(proof.removedSectionId, proof.carrierSectionId);
    carrierEntry.carried.push({
      sectionId: proof.removedSectionId,
      subjectRef: removedEntry.offer.subjectRef,
      evidenceRole: removedEntry.offer.evidenceRole,
      assuranceRef: removedEntry.offer.assuranceRef,
      requirementRef: removedEntry.offer.requirementRef,
      representation: removedEntry.candidate.representation,
      rendererRef: removedEntry.candidate.rendererRef,
      renderedRef: removedEntry.candidate.renderedRef,
      coverage: proof.coverage,
      expansionRefs: removedEntry.candidate.expansionRefs,
      limitations: [...new Set([
        ...removedEntry.offer.limitations, ...removedEntry.candidate.limitations
      ])],
      protectedContinuity: removedEntry.candidate.protectedSpans.map((span) => ({
        ...protectedContinuity(span),
        renderedRange: span.renderedRange
      })),
      aliasUses: removedEntry.candidate.aliasUses,
      dependencies: removedEntry.offer.rule.dependencies,
      removedCandidateRef: proof.removedCandidateRef,
      carrierCandidateRef: proof.carrierCandidateRef,
      proofSha256: proof.proofSha256
    });
    omissions.push(omissionRecord(removedEntry.offer, 'duplicate', removedEntry.candidate, {
      carrierSectionId: proof.carrierSectionId,
      coverageProofSha256: proof.proofSha256
    }));
  }
  activeDependenciesSatisfied(offers, selections, explicitOmissions, carriedBy);

  const visibleOmissions = omissions.filter((entry) => ['budget', 'unavailable'].includes(entry.reason));
  const usedAliasIds = new Set([...selected.values()].flatMap((entry) => (
    entry.candidate.aliasUses.map((use) => use.id)
  )));
  const retainedAliasCeilings = new Map();
  for (const entry of aliases) {
    if (!usedAliasIds.has(entry.id)) continue;
    const match = ALIAS_ID.exec(entry.id);
    retainedAliasCeilings.set(entry.namespace, Math.max(
      retainedAliasCeilings.get(entry.namespace) ?? 0, Number(match[2])
    ));
  }
  // Preserve the deterministic prefix needed by the highest retained ID. Renumbering here would
  // change already-rendered candidate bytes; retaining a prefix keeps every surviving use exact.
  const retainedAliases = aliases.filter((entry) => {
    const maximum = retainedAliasCeilings.get(entry.namespace);
    return maximum != null && Number(ALIAS_ID.exec(entry.id)[2]) <= maximum;
  });
  const registeredGenerators = generatorRules(contract.sectionRules);
  if (visibleOmissions.length && !registeredGenerators.has('omission-notices')) unsupported(
    'The composer needs an omission-notices section, but its pinned contract declares none.',
    { omittedSections: visibleOmissions.map((entry) => entry.sectionId) }
  );
  if (retainedAliases.length && !registeredGenerators.has('alias-table')) unsupported(
    'The composer needs an alias-table section, but its pinned contract declares none.',
    { aliasCount: retainedAliases.length }
  );

  const segmentEntries = [];
  for (const rule of contract.sectionRules) {
    if (rule.generator === 'alias-table' && retainedAliases.length) {
      segmentEntries.push({
        rule,
        contentBytes: generatorContent(
          'alias-table', { aliases: retainedAliases, omissions: visibleOmissions }, rule.rendererRef
        ),
        rendererRef: rule.rendererRef,
        role: rule.permittedRoles[0],
        representation: 'generated-alias-table',
        subjectRefs: retainedAliases.map((entry) => entry.targetRef),
        coverage: [],
        protectedSpans: [],
        carried: []
      });
      continue;
    }
    if (rule.generator === 'omission-notices' && visibleOmissions.length) {
      segmentEntries.push({
        rule,
        contentBytes: generatorContent(
          'omission-notices', { aliases: retainedAliases, omissions: visibleOmissions }, rule.rendererRef
        ),
        rendererRef: rule.rendererRef,
        role: rule.permittedRoles[0],
        representation: 'generated-omission-notices',
        subjectRefs: visibleOmissions.map((entry) => entry.subjectRef),
        coverage: [],
        protectedSpans: [],
        carried: []
      });
      continue;
    }
    const entry = selected.get(rule.id);
    if (!entry) continue;
    segmentEntries.push({
      rule,
      contentBytes: entry.candidate.contentBytes,
      rendererRef: entry.candidate.rendererRef,
      role: entry.offer.evidenceRole,
      representation: entry.candidate.representation,
      subjectRefs: [entry.offer.subjectRef, ...entry.carried.map((item) => item.subjectRef)],
      coverage: [...entry.candidate.coverage],
      protectedSpans: entry.candidate.protectedSpans,
      carried: entry.carried
    });
  }
  if (segmentEntries.length > contract.limits.maximumSections) {
    limitExceeded('maximumSections', contract.limits.maximumSections, segmentEntries.length);
  }
  validateMaterializedDependencies(segmentEntries, carriedBy);

  const chunks = [];
  const segments = [];
  const separators = [];
  const protectedText = [];
  let offset = 0;
  for (let index = 0; index < segmentEntries.length; index += 1) {
    if (index > 0) {
      const start = offset;
      chunks.push(SEPARATOR);
      offset += SEPARATOR.length;
      separators.push({
        start, end: offset, bytes: SEPARATOR.length, sha256: byteDigest(SEPARATOR)
      });
    }
    const entry = segmentEntries[index];
    const start = offset;
    chunks.push(entry.contentBytes);
    offset += entry.contentBytes.length;
    const end = offset;
    segments.push({
      id: entry.rule.id,
      slot: entry.rule.slot,
      role: entry.role,
      permittedRoles: entry.rule.permittedRoles,
      orderGroup: entry.rule.orderGroup,
      stability: entry.rule.stability,
      position: index,
      start,
      end,
      bytes: entry.contentBytes.length,
      sha256: byteDigest(entry.contentBytes),
      rendererRef: entry.rendererRef,
      representation: entry.representation,
      subjectRefs: entry.subjectRefs,
      coverage: entry.coverage,
      carried: entry.carried
    });
    for (const span of entry.protectedSpans) protectedText.push({
      sectionId: entry.rule.id,
      sourceRef: span.sourceRef,
      sourceRange: span.sourceRange,
      renderedRange: span.renderedRange,
      blockRange: { start: start + span.renderedRange.start, end: start + span.renderedRange.end },
      sha256: span.sha256,
      bytes: span.bytes,
      encoding: span.encoding
    });
  }
  const bytes = Buffer.concat(chunks);
  for (const span of protectedText) {
    if (!utf8Boundary(bytes, span.blockRange.start) || !utf8Boundary(bytes, span.blockRange.end)
        || byteDigest(bytes.subarray(span.blockRange.start, span.blockRange.end)) !== span.sha256) {
      fail('TKR_PROTECTED_CONTENT_CHANGED', `Final composition changed protected bytes in '${span.sectionId}'.`, {
        sectionId: span.sectionId, sourceRef: span.sourceRef, blockRange: span.blockRange
      });
    }
  }
  return {
    content: bytes.toString('utf8'),
    bytes: bytes.length,
    sha256: byteDigest(bytes),
    segments,
    separators,
    protectedText,
    aliases: retainedAliases,
    omissions: omissions.sort((left, right) => (
      contract.sectionRules.findIndex((rule) => rule.id === left.sectionId)
        - contract.sectionRules.findIndex((rule) => rule.id === right.sectionId)
    )),
    deduplication: activeProofs.map((proof) => ({
      removedSectionId: proof.removedSectionId,
      removedRepresentation: proof.removedRepresentation,
      carrierSectionId: proof.carrierSectionId,
      carrierRepresentation: proof.carrierRepresentation,
      removedCandidateRef: proof.removedCandidateRef,
      carrierCandidateRef: proof.carrierCandidateRef,
      coverageProofSha256: proof.proofSha256,
      ruleRef: proof.ruleRef,
      coverage: proof.coverage,
      removedBinding: proof.removedBinding,
      carrierBinding: proof.carrierBinding
    }))
  };
}

function stateKey(selections, explicitOmissions) {
  return stableJson({
    selections: [...selections].map(([sectionId, candidate]) => ({
      sectionId, representation: candidate.representation, renderedRef: candidate.renderedRef
    })).sort((left, right) => compareUtf8(left.sectionId, right.sectionId)),
    omissions: [...explicitOmissions].sort()
  });
}

function initialSelections(offers) {
  const selected = new Map();
  for (const offer of offers) {
    if (offer.applicability === 'not-applicable') continue;
    if (offer.candidates.length) selected.set(offer.sectionId, offer.candidates[0]);
    else if (offer.applicability === 'required') coverageUnproven(
      `Required section '${offer.sectionId}' has no permitted representation proving all coverage.`,
      { sectionId: offer.sectionId, subjectRef: offer.subjectRef,
        requiredCoverage: offer.coverage, permittedRepresentations: offer.permittedRepresentations }
    );
  }
  return selected;
}

function budgetError(maximumBytes, result, attempts, offers, selections, explicitOmissions) {
  const remaining = offers.filter((offer) => (
    offer.applicability === 'required' && selections.has(offer.sectionId)
      && !explicitOmissions.has(offer.sectionId)
  )).map((offer) => ({
    sectionId: offer.sectionId,
    subjectRef: offer.subjectRef,
    representation: selections.get(offer.sectionId).representation,
    renderedRef: selections.get(offer.sectionId).renderedRef
  }));
  fail('WMP_BUDGET_TOO_SMALL', `Required TKR context is ${result.bytes} bytes; the hard limit is ${maximumBytes}.`, {
    maximumBytes,
    neededBytes: result.bytes,
    measuredResidualBytes: result.bytes,
    remainingRequiredRepresentations: remaining,
    attemptedPermittedAlternatives: attempts,
    nextAction: 'Use an admitted larger phase budget, narrower scope, or split the work.'
  });
}

/**
 * Compose one exact, byte-bounded TKR block from already-resolved logical inputs.
 *
 * This function performs no I/O and invokes no model. It never trims or normalizes candidate
 * bodies. All reductions are limited to owner-permitted representations, proof-backed duplicate
 * removal, and optional entries with an exact expansion handle and visible omission notice.
 */
export function composeTokenReductionContext(options) {
  assertClosedObject(options, COMPOSITION_KEYS, 'TKR composition input');
  const {
    contract: contractValue,
    contracts,
    rendererContracts,
    offers: offerValues,
    deduplicationProofs: proofValues = [],
    aliases: aliasValues = [],
    compositionScopeRef = null,
    maximumBytes
  } = options;
  const closure = validateComposerClosure(contractValue, contracts, rendererContracts);
  const contract = closure.contract;
  const representationRules = closure.contracts.find((entry) => (
    entry.kind === 'tkr/representation-rules'
  ));
  positiveInteger(maximumBytes, 'maximumBytes');
  if (!Array.isArray(offerValues)) unsupported('TKR input offers must be an array.', {
    subject: 'offers'
  });
  if (offerValues.length === 0) coverageUnproven(
    'TKR input offers cannot be empty; applicability must be resolved explicitly.',
    { subject: 'offers', reason: 'empty-context' }
  );
  if (offerValues.length > contract.limits.maximumSections) {
    limitExceeded('maximumSections', contract.limits.maximumSections, offerValues.length);
  }
  const rulesById = new Map(contract.sectionRules.map((rule) => [rule.id, rule]));
  const seenSections = new Set();
  const coverageCounter = {
    count: 0,
    maximum: contract.limits.maximumCoverageClaims
  };
  const offers = offerValues.map((value, index) => {
    const sectionId = value?.sectionId;
    const rule = rulesById.get(sectionId);
    if (!rule || rule.generator) unsupported(`Input offer '${sectionId ?? 'unknown'}' has no content section rule.`, {
      sectionId: sectionId ?? null
    });
    if (seenSections.has(sectionId)) unsupported(`Input offer section '${sectionId}' is duplicated.`, {
      sectionId
    });
    seenSections.add(sectionId);
    return normalizeOffer(
      value, contract, representationRules, coverageCounter, rule, `offers[${index}]`
    );
  }).sort((left, right) => left.rule.index - right.rule.index);
  const offersBySection = new Map(offers.map((offer) => [offer.sectionId, offer]));
  if (!Array.isArray(proofValues)) unsupported('TKR deduplication proofs must be an array.', {
    subject: 'deduplicationProofs'
  });
  if (proofValues.length > contract.limits.maximumCoverageClaims) {
    limitExceeded(
      'maximumCoverageClaims', contract.limits.maximumCoverageClaims, proofValues.length
    );
  }
  const proofs = proofValues.map((value, index) => (
    normalizeProof(
      value, offersBySection, contract, representationRules, coverageCounter,
      `deduplicationProofs[${index}]`
    )
  ));
  const aliases = validateTkrAliases(aliasValues, {
    maximumAliases: contract.limits.maximumAliases,
    compositionScopeRef
  });
  validateAliasUses(offers, aliases);

  const coverageClaims = coverageCounter.count;
  const workingMetadataBytes = metadataBytes(contractValue, offerValues, proofValues, aliasValues);
  if (workingMetadataBytes > contract.limits.maximumWorkingMetadataBytes) limitExceeded(
    'maximumWorkingMetadataBytes', contract.limits.maximumWorkingMetadataBytes, workingMetadataBytes
  );

  const selections = initialSelections(offers);
  const explicitOmissions = new Set();
  const visited = new Set([stateKey(selections, explicitOmissions)]);
  const attempts = [];
  const accepted = [];
  let result = materialize({ contract, offers, proofs, aliases, selections, explicitOmissions });

  if (result.bytes > maximumBytes) {
    for (const offer of offers) {
      const current = selections.get(offer.sectionId);
      if (!current) continue;
      let cursor = offer.candidates.findIndex((candidate) => candidate === current) + 1;
      while (cursor < offer.candidates.length && result.bytes > maximumBytes) {
        const candidate = offer.candidates[cursor];
        cursor += 1;
        const trialSelections = new Map(selections);
        trialSelections.set(offer.sectionId, candidate);
        const key = stateKey(trialSelections, explicitOmissions);
        if (visited.has(key)) fail('TKR_RENDER_CONFLICT', 'TKR representation reduction revisited a candidate state.', {
          sectionId: offer.sectionId, representation: candidate.representation
        });
        visited.add(key);
        const trial = materialize({
          contract, offers, proofs, aliases, selections: trialSelections, explicitOmissions
        });
        const observation = {
          action: 'representation', sectionId: offer.sectionId,
          from: selections.get(offer.sectionId).representation,
          to: candidate.representation,
          beforeBytes: result.bytes,
          afterBytes: trial.bytes,
          accepted: trial.bytes < result.bytes
        };
        attempts.push(observation);
        if (observation.accepted) {
          selections.set(offer.sectionId, candidate);
          result = trial;
          accepted.push(observation);
        }
      }
      if (result.bytes <= maximumBytes) break;
    }
  }

  if (result.bytes > maximumBytes) {
    const optional = offers.filter((offer) => offer.applicability === 'optional' && selections.has(offer.sectionId))
      .sort((left, right) => right.priority - left.priority || right.rule.index - left.rule.index);
    for (const offer of optional) {
      if (result.bytes <= maximumBytes) break;
      const candidate = selections.get(offer.sectionId);
      if (candidate.expansionRefs.length === 0) {
        attempts.push({
          action: 'omit-optional', sectionId: offer.sectionId,
          representation: candidate.representation, beforeBytes: result.bytes,
          afterBytes: null, accepted: false, reason: 'expansion-reference-unavailable'
        });
        continue;
      }
      const activeDependent = offers.find((entry) => (
        entry.rule.dependencies.includes(offer.sectionId)
          && selections.has(entry.sectionId)
          && !explicitOmissions.has(entry.sectionId)
      ));
      if (activeDependent) {
        attempts.push({
          action: 'omit-optional', sectionId: offer.sectionId,
          representation: candidate.representation, beforeBytes: result.bytes,
          afterBytes: null, accepted: false,
          reason: 'active-dependency', dependentSectionId: activeDependent.sectionId
        });
        continue;
      }
      const trialOmissions = new Set(explicitOmissions);
      trialOmissions.add(offer.sectionId);
      const key = stateKey(selections, trialOmissions);
      if (visited.has(key)) fail('TKR_RENDER_CONFLICT', 'TKR optional reduction revisited a candidate state.', {
        sectionId: offer.sectionId
      });
      visited.add(key);
      const trial = materialize({
        contract, offers, proofs, aliases, selections, explicitOmissions: trialOmissions
      });
      const observation = {
        action: 'omit-optional', sectionId: offer.sectionId,
        representation: candidate.representation,
        beforeBytes: result.bytes,
        afterBytes: trial.bytes,
        accepted: trial.bytes < result.bytes
      };
      attempts.push(observation);
      if (observation.accepted) {
        explicitOmissions.add(offer.sectionId);
        result = trial;
        accepted.push(observation);
      }
    }
  }

  if (result.bytes > maximumBytes) budgetError(
    maximumBytes, result, attempts, offers, selections, explicitOmissions
  );

  return deepFreeze({
    kind: 'tkr/composition-result',
    version: 1,
    composerSha256: contract.composerSha256,
    content: result.content,
    bytes: result.bytes,
    sha256: result.sha256,
    separator: { utf8: '\n\n', bytes: SEPARATOR.length, sha256: byteDigest(SEPARATOR) },
    segments: result.segments,
    separators: result.separators,
    protectedText: result.protectedText,
    omissions: result.omissions,
    deduplication: result.deduplication,
    aliases: result.aliases,
    reduction: {
      maximumBytes,
      initialBytes: attempts[0]?.beforeBytes ?? result.bytes,
      finalBytes: result.bytes,
      attempts,
      accepted,
      visitedStates: visited.size
    },
    processing: {
      sectionRules: contract.sectionRules.length,
      offers: offers.length,
      presentationCandidates: offers.reduce((total, offer) => (
        total + offer.presentationCandidateCount
      ), 0),
      coverageClaims,
      aliasEntries: aliases.length,
      retainedAliasEntries: result.aliases.length,
      workingMetadataBytes
    }
  });
}

/** Exact digest helper for callers that already hold the returned UTF-8 composition bytes. */
export function tokenReductionByteRef(value) {
  const bytes = utf8Bytes(value, 'TKR composition bytes');
  return Object.freeze({ sha256: byteDigest(bytes), bytes: bytes.length });
}

/** Canonical debug representation; never substitutes for the complete byte digest. */
export function tokenReductionContractJson(contract) {
  return canonicalJson(validateRegisteredTkrComposerContract(contract));
}
