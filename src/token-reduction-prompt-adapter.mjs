import { createHash } from 'node:crypto';

import { composeTokenReductionContext } from './token-reduction-composer.mjs';
import {
  tkrLogicalComposerContract,
  validateTkrContractSet
} from './token-reduction/contracts.mjs';
import { defaultTokenReductionContractSet } from './token-reduction/default-contract.mjs';
import { SingularityFlowError } from './util.mjs';
import {
  canonicalJson,
  deepFreeze,
  recordSha256
} from './world-model/canonicalize.mjs';

const OWNER_BINDING_KIND = 'tkr/prompt-section-owner-binding';
const OWNER_BINDING_VERSION = 1;
const SECTION_KEYS = new Set(['id', 'text']);
const SUBJECT_REF_KEYS = new Set(['owner', 'domain', 'kind', 'id', 'revision', 'sourceRef']);
const COVERAGE_KEYS = new Set(['claimRef', 'subjectRef', 'evidenceRole', 'requirementRef']);
const BINDING_CORE_KEYS = new Set([
  'kind', 'version', 'sectionId', 'subjectRef', 'applicability',
  'applicabilityDecisionRef', 'evidenceRole', 'assuranceRef', 'requirementRef',
  'coverage', 'sourceRef', 'sourceBytes', 'sourceSha256', 'sourceByteLength',
  'expansionRefs', 'limitations', 'rendererRef', 'priority'
]);
const BINDING_KEYS = new Set([...BINDING_CORE_KEYS, 'bindingSha256']);
const ADAPTER_OPTION_KEYS = new Set(['contractSet', 'resolveOwnerBinding']);
const COMPOSE_OPTION_KEYS = new Set([
  'sections', 'maximumBytes', 'contractSet', 'resolveOwnerBinding'
]);
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const APPLICABILITIES = new Set(['required', 'optional', 'not-applicable']);

function fail(code, message, details = {}) {
  throw new SingularityFlowError(message, {
    code,
    details: {
      ...details,
      nextAction: details.nextAction
        ?? 'Resolve every prompt section through its synchronous owner and return a closed, self-hashed binding.'
    }
  });
}

function unsupported(message, details = {}) {
  fail('TKR_CONTRACT_UNSUPPORTED', message, details);
}

function limitExceeded(limit, maximum, required) {
  fail(
    'TKR_LIMIT_EXCEEDED',
    `TKR prompt adapter limit '${limit}' is ${maximum}, but ${required} are required.`,
    {
      limit,
      maximum,
      required,
      nextAction: 'Use an admitted narrower owner-resolved section set or a revised owner contract.'
    }
  );
}

function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function closed(value, keys, label) {
  if (!plain(value)) unsupported(`${label} must be a plain object.`, { subject: label });
  const unknown = Object.keys(value).filter((key) => !keys.has(key));
  if (unknown.length) unsupported(`${label} contains unsupported field '${unknown[0]}'.`, {
    subject: label,
    unknownFields: unknown.sort()
  });
  return value;
}

function exact(value, keys, label) {
  const result = closed(value, keys, label);
  const missing = [...keys].filter((key) => !Object.hasOwn(result, key));
  if (missing.length) unsupported(`${label} is missing required field '${missing[0]}'.`, {
    subject: label,
    missingFields: missing
  });
  return result;
}

function boundedText(value, label, maximumBytes = 4096) {
  if (typeof value !== 'string' || !value.trim().length) unsupported(
    `${label} must be a non-whitespace string.`, { subject: label }
  );
  const receivedBytes = Buffer.byteLength(value, 'utf8');
  if (receivedBytes > maximumBytes) limitExceeded(label, maximumBytes, receivedBytes);
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.toString('utf8') !== value) fail(
    'TKR_PROTECTED_CONTENT_CHANGED',
    `${label} is not a well-formed Unicode string.`,
    { subject: label }
  );
  return value;
}

function digestBytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function digest(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) unsupported(
    `${label} must be an exact lowercase SHA-256 digest.`,
    { subject: label, received: typeof value === 'string' ? value : null }
  );
  return value;
}

function safeInteger(value, label, { minimum = Number.MIN_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) unsupported(
    `${label} must be a safe integer${minimum === 0 ? ' at least zero' : ''}.`,
    { subject: label, received: value }
  );
  return value;
}

function normalizeSubjectRef(value, label) {
  const subject = exact(value, SUBJECT_REF_KEYS, label);
  return {
    owner: boundedText(subject.owner, `${label}.owner`, 128),
    domain: boundedText(subject.domain, `${label}.domain`, 4096),
    kind: boundedText(subject.kind, `${label}.kind`, 128),
    id: boundedText(subject.id, `${label}.id`, 4096),
    revision: boundedText(subject.revision, `${label}.revision`, 4096),
    sourceRef: boundedText(subject.sourceRef, `${label}.sourceRef`, 4096)
  };
}

function sameCanonical(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function normalizeStringList(value, label, maximum) {
  if (!Array.isArray(value)) unsupported(`${label} must be an array.`, { subject: label });
  if (value.length > maximum) limitExceeded(label, maximum, value.length);
  const seen = new Set();
  return value.map((entry, index) => {
    const normalized = boundedText(entry, `${label}[${index}]`, 4096);
    if (seen.has(normalized)) unsupported(`${label} contains duplicate '${normalized}'.`, {
      subject: label,
      duplicate: normalized
    });
    seen.add(normalized);
    return normalized;
  });
}

function normalizeCoverage(value, binding, label, maximum) {
  if (!Array.isArray(value)) unsupported(`${label} must be an array.`, { subject: label });
  if (value.length > maximum) limitExceeded('maximumCoverageClaims', maximum, value.length);
  const seen = new Set();
  return value.map((entry, index) => {
    const itemLabel = `${label}[${index}]`;
    const raw = exact(entry, COVERAGE_KEYS, itemLabel);
    const result = {
      claimRef: boundedText(raw.claimRef, `${itemLabel}.claimRef`, 4096),
      subjectRef: normalizeSubjectRef(raw.subjectRef, `${itemLabel}.subjectRef`),
      evidenceRole: boundedText(raw.evidenceRole, `${itemLabel}.evidenceRole`, 128),
      requirementRef: boundedText(raw.requirementRef, `${itemLabel}.requirementRef`, 4096)
    };
    if (!sameCanonical(result.subjectRef, binding.subjectRef)
        || result.evidenceRole !== binding.evidenceRole
        || result.requirementRef !== binding.requirementRef) fail(
      'TKR_COVERAGE_UNPROVEN',
      `${itemLabel} does not qualify the exact owner-bound subject, role, and requirement.`,
      {
        sectionId: binding.sectionId,
        claimRef: result.claimRef,
        expectedSubjectRef: binding.subjectRef,
        expectedEvidenceRole: binding.evidenceRole,
        expectedRequirementRef: binding.requirementRef
      }
    );
    const key = canonicalJson(result);
    if (seen.has(key)) unsupported(`${label} contains a duplicate qualified coverage claim.`, {
      sectionId: binding.sectionId,
      claimRef: result.claimRef
    });
    seen.add(key);
    return result;
  });
}

function validatedContractSet(value) {
  const selected = value ?? defaultTokenReductionContractSet();
  if (!plain(selected)) unsupported(
    'contractSet must be a complete TKR semantic and runtime renderer closure.',
    { subject: 'contractSet' }
  );
  // Establish the complete semantic and renderer closure before reading a section rule or
  // resolving owner-controlled content.
  const closure = validateTkrContractSet({
    composer: selected.composer,
    contracts: selected.contracts,
    rendererContracts: selected.rendererContracts
  });
  const logicalComposer = tkrLogicalComposerContract(closure.composer, {
    contracts: closure.contracts,
    rendererContracts: closure.rendererContracts
  });
  return deepFreeze({
    composer: closure.composer,
    contracts: closure.contracts,
    rendererContracts: closure.rendererContracts,
    logicalComposer
  });
}

function sourceRendererForRule(rule, contractSet) {
  const sourceRenderers = contractSet.rendererContracts.filter((entry) => (
    entry.mode === 'source-pass-through' && entry.format === 'literal-utf8'
  ));
  if (rule.rendererRef != null) {
    const matched = sourceRenderers.find((entry) => entry.rendererRef === rule.rendererRef);
    if (!matched) unsupported(
      `Prompt section '${rule.id}' is not bound to a source-pass-through renderer.`,
      { sectionId: rule.id, rendererRef: rule.rendererRef }
    );
    return matched.rendererRef;
  }
  if (sourceRenderers.length !== 1) unsupported(
    `Prompt section '${rule.id}' cannot resolve one exact source renderer.`,
    {
      sectionId: rule.id,
      sourceRendererRefs: sourceRenderers.map((entry) => entry.rendererRef)
    }
  );
  return sourceRenderers[0].rendererRef;
}

function preflightSections(sections, contractSet) {
  if (!Array.isArray(sections)) unsupported('Prompt sections must be an array.', {
    subject: 'sections'
  });
  const { limits } = contractSet.logicalComposer;
  if (sections.length > limits.maximumSections) limitExceeded(
    'maximumSections', limits.maximumSections, sections.length
  );
  if (sections.length === 0) fail(
    'TKR_COVERAGE_UNPROVEN',
    'Prompt sections cannot be empty; every applicability decision must come from an owner binding.',
    { subject: 'sections', reason: 'empty-context' }
  );
  const rulesById = new Map(contractSet.logicalComposer.sectionRules.map((rule) => [rule.id, rule]));
  const seen = new Set();
  let textBytes = 0;
  let metadataBytes = 0;
  const normalized = sections.map((value, index) => {
    const label = `sections[${index}]`;
    const section = exact(value, SECTION_KEYS, label);
    const id = boundedText(section.id, `${label}.id`, 128);
    if (seen.has(id)) unsupported(`Prompt section '${id}' is duplicated.`, { sectionId: id });
    seen.add(id);
    const rule = rulesById.get(id);
    if (!rule || rule.generator) unsupported(
      `Prompt section '${id}' is not declared as owner-supplied content by this TKR composer.`,
      { sectionId: id }
    );
    if (section.text !== null && typeof section.text !== 'string') unsupported(
      `${label}.text must be an exact string or null.`, { sectionId: id }
    );
    let bytes = null;
    if (typeof section.text === 'string') {
      const byteLength = Buffer.byteLength(section.text, 'utf8');
      textBytes += byteLength;
      if (textBytes > limits.maximumWorkingMetadataBytes) limitExceeded(
        'maximumWorkingMetadataBytes', limits.maximumWorkingMetadataBytes, textBytes
      );
      bytes = Buffer.from(section.text, 'utf8');
      if (bytes.toString('utf8') !== section.text) fail(
        'TKR_PROTECTED_CONTENT_CHANGED',
        `${label}.text is not well-formed Unicode.`,
        { sectionId: id }
      );
      if (!bytes.length || !section.text.trim().length) fail(
        'TKR_PROTECTED_CONTENT_CHANGED',
        `Prompt section '${id}' cannot represent empty owner source bytes.`,
        { sectionId: id }
      );
    }
    metadataBytes += Buffer.byteLength(canonicalJson({
      id,
      text: bytes == null ? null : { bytes: bytes.length, sha256: digestBytes(bytes) }
    }), 'utf8');
    if (textBytes + metadataBytes > limits.maximumWorkingMetadataBytes) limitExceeded(
      'maximumWorkingMetadataBytes', limits.maximumWorkingMetadataBytes,
      textBytes + metadataBytes
    );
    return {
      id,
      text: section.text,
      bytes,
      rule,
      rendererRef: sourceRendererForRule(rule, contractSet)
    };
  });
  return { sections: normalized, textBytes, metadataBytes };
}

function preflightRawBinding(value, section, index, counters, limits) {
  const label = `owner binding for sections[${index}]`;
  const binding = exact(value, BINDING_KEYS, label);
  for (const [field, multiplier, limitName] of [
    ['coverage', 2, 'maximumCoverageClaims'],
    ['expansionRefs', 1, 'maximumExpansionRefs'],
    ['limitations', 1, 'maximumLimitations']
  ]) {
    if (!Array.isArray(binding[field])) unsupported(`${label}.${field} must be an array.`, {
      sectionId: section.id,
      subject: `${label}.${field}`
    });
    const required = counters[field] + (binding[field].length * multiplier);
    if (required > limits.maximumCoverageClaims) limitExceeded(
      limitName, limits.maximumCoverageClaims, required
    );
    counters[field] = required;
  }
  if (binding.sourceBytes !== null && typeof binding.sourceBytes !== 'string') fail(
    'TKR_PROTECTED_CONTENT_CHANGED',
    `${label}.sourceBytes must be an exact UTF-8 string or null.`,
    { sectionId: section.id }
  );
  const sourceBytes = binding.sourceBytes == null
    ? 0
    : Buffer.byteLength(binding.sourceBytes, 'utf8');
  counters.sourceBytes += sourceBytes;
  if (counters.sourceBytes > limits.maximumWorkingMetadataBytes) limitExceeded(
    'maximumWorkingMetadataBytes', limits.maximumWorkingMetadataBytes, counters.sourceBytes
  );
  return binding;
}

function normalizeOwnerBinding(rawValue, section, index, contractSet, counters) {
  const label = `owner binding for sections[${index}]`;
  const binding = exact(rawValue, BINDING_KEYS, label);
  if (binding.kind !== OWNER_BINDING_KIND || binding.version !== OWNER_BINDING_VERSION) {
    unsupported(`${label} kind or version is unsupported.`, {
      sectionId: section.id,
      expectedKind: OWNER_BINDING_KIND,
      expectedVersion: OWNER_BINDING_VERSION,
      receivedKind: binding.kind ?? null,
      receivedVersion: binding.version ?? null
    });
  }
  const sectionId = boundedText(binding.sectionId, `${label}.sectionId`, 128);
  if (sectionId !== section.id) unsupported(`${label}.sectionId does not match its request.`, {
    sectionId,
    expectedSectionId: section.id
  });
  const subjectRef = normalizeSubjectRef(binding.subjectRef, `${label}.subjectRef`);
  if (!APPLICABILITIES.has(binding.applicability)) unsupported(
    `${label}.applicability must be required, optional, or not-applicable.`,
    { sectionId, applicability: binding.applicability ?? null }
  );
  const notApplicable = binding.applicability === 'not-applicable';
  const applicabilityDecisionRef = notApplicable
    ? boundedText(binding.applicabilityDecisionRef, `${label}.applicabilityDecisionRef`, 4096)
    : null;
  if (!notApplicable && binding.applicabilityDecisionRef !== null) unsupported(
    `${label}.applicabilityDecisionRef must be null unless the owner decided not-applicable.`,
    { sectionId }
  );
  const evidenceRole = boundedText(binding.evidenceRole, `${label}.evidenceRole`, 128);
  if (!section.rule.permittedRoles.includes(evidenceRole)) unsupported(
    `Owner binding placed '${sectionId}' in unpermitted role '${evidenceRole}'.`,
    { sectionId, evidenceRole, permittedRoles: section.rule.permittedRoles }
  );
  const assuranceRef = boundedText(binding.assuranceRef, `${label}.assuranceRef`, 4096);
  const requirementRef = boundedText(binding.requirementRef, `${label}.requirementRef`, 4096);
  const coverageContext = { sectionId, subjectRef, evidenceRole, requirementRef };
  const coverage = normalizeCoverage(
    binding.coverage,
    coverageContext,
    `${label}.coverage`,
    contractSet.logicalComposer.limits.maximumCoverageClaims
  );
  if (!notApplicable && coverage.length === 0) fail(
    'TKR_COVERAGE_UNPROVEN',
    `${label}.coverage must retain at least one owner-qualified claim.`,
    { sectionId, subjectRef, requirementRef }
  );
  if (notApplicable && coverage.length !== 0) fail(
    'TKR_COVERAGE_UNPROVEN',
    `${label}.coverage must be empty for an explicit not-applicable decision.`,
    { sectionId, applicabilityDecisionRef }
  );
  const sourceRef = boundedText(binding.sourceRef, `${label}.sourceRef`, 4096);
  if (sourceRef !== subjectRef.sourceRef) fail(
    'TKR_PROTECTED_CONTENT_CHANGED',
    `${label}.sourceRef does not match its owner-qualified subject source.`,
    { sectionId, sourceRef, subjectSourceRef: subjectRef.sourceRef }
  );
  let sourceBytes = null;
  let sourceSha256 = null;
  let sourceByteLength = 0;
  if (notApplicable) {
    if (binding.sourceBytes !== null || binding.sourceSha256 !== null
        || binding.sourceByteLength !== 0 || section.text !== null) fail(
      'TKR_PROTECTED_CONTENT_CHANGED',
      `${label} must bind null source bytes and a null prompt section for not-applicable.`,
      { sectionId }
    );
  } else {
    if (typeof binding.sourceBytes !== 'string' || section.bytes == null) fail(
      'TKR_PROTECTED_CONTENT_CHANGED',
      `${label} must bind exact source bytes for an applicable prompt section.`,
      { sectionId }
    );
    const byteLength = Buffer.byteLength(binding.sourceBytes, 'utf8');
    if (byteLength > contractSet.logicalComposer.limits.maximumWorkingMetadataBytes) {
      limitExceeded(
        'maximumWorkingMetadataBytes',
        contractSet.logicalComposer.limits.maximumWorkingMetadataBytes,
        byteLength
      );
    }
    sourceBytes = Buffer.from(binding.sourceBytes, 'utf8');
    if (sourceBytes.toString('utf8') !== binding.sourceBytes) fail(
      'TKR_PROTECTED_CONTENT_CHANGED',
      `${label}.sourceBytes is not well-formed Unicode.`,
      { sectionId }
    );
    if (!sourceBytes.length || !binding.sourceBytes.trim().length) fail(
      'TKR_PROTECTED_CONTENT_CHANGED',
      `${label}.sourceBytes cannot be empty.`,
      { sectionId }
    );
    sourceSha256 = digest(binding.sourceSha256, `${label}.sourceSha256`);
    sourceByteLength = safeInteger(
      binding.sourceByteLength, `${label}.sourceByteLength`, { minimum: 0 }
    );
    const actual = {
      sha256: digestBytes(sourceBytes),
      bytes: sourceBytes.length
    };
    if (sourceSha256 !== actual.sha256 || sourceByteLength !== actual.bytes) fail(
      'TKR_RENDER_CONFLICT',
      `${label} source digest or byte length does not identify its captured source bytes.`,
      { sectionId, expected: actual, received: { sha256: sourceSha256, bytes: sourceByteLength } }
    );
    if (!section.bytes.equals(sourceBytes)) fail(
      'TKR_PROTECTED_CONTENT_CHANGED',
      `Prompt section '${sectionId}' differs from its owner-captured full source bytes.`,
      {
        sectionId,
        ownerSourceSha256: actual.sha256,
        promptSectionSha256: digestBytes(section.bytes)
      }
    );
  }
  const expansionRefs = normalizeStringList(
    binding.expansionRefs,
    `${label}.expansionRefs`,
    contractSet.logicalComposer.limits.maximumCoverageClaims
  );
  const limitations = normalizeStringList(
    binding.limitations,
    `${label}.limitations`,
    contractSet.logicalComposer.limits.maximumCoverageClaims
  );
  if (notApplicable && expansionRefs.length) unsupported(
    `${label}.expansionRefs must be empty for a not-applicable decision.`,
    { sectionId }
  );
  const rendererRef = boundedText(binding.rendererRef, `${label}.rendererRef`, 512);
  if (rendererRef !== section.rendererRef) unsupported(
    `${label}.rendererRef does not match the section's exact registered source renderer.`,
    { sectionId, rendererRef, expectedRendererRef: section.rendererRef }
  );
  const priority = safeInteger(binding.priority, `${label}.priority`);
  const core = {
    kind: OWNER_BINDING_KIND,
    version: OWNER_BINDING_VERSION,
    sectionId,
    subjectRef,
    applicability: binding.applicability,
    applicabilityDecisionRef,
    evidenceRole,
    assuranceRef,
    requirementRef,
    coverage,
    sourceRef,
    sourceBytes: sourceBytes == null ? null : binding.sourceBytes,
    sourceSha256,
    sourceByteLength,
    expansionRefs,
    limitations,
    rendererRef,
    priority
  };
  const bindingSha256 = digest(binding.bindingSha256, `${label}.bindingSha256`);
  const expectedBindingSha256 = recordSha256(core);
  if (bindingSha256 !== expectedBindingSha256) fail(
    'TKR_RENDER_CONFLICT',
    `${label} failed its exact content-integrity check.`,
    { sectionId, expected: expectedBindingSha256, received: bindingSha256 }
  );
  const metadataProjection = {
    ...core,
    sourceBytes: sourceBytes == null
      ? null
      : { sha256: sourceSha256, bytes: sourceByteLength }
  };
  counters.metadataBytes += Buffer.byteLength(canonicalJson(metadataProjection), 'utf8');
  const requiredWorkingBytes = counters.textBytes + counters.metadataBytes;
  if (requiredWorkingBytes > contractSet.logicalComposer.limits.maximumWorkingMetadataBytes) {
    limitExceeded(
      'maximumWorkingMetadataBytes',
      contractSet.logicalComposer.limits.maximumWorkingMetadataBytes,
      requiredWorkingBytes
    );
  }
  return {
    ...core,
    bindingSha256
  };
}

function ownerResolver(value) {
  if (typeof value !== 'function') unsupported(
    'resolveOwnerBinding must be an explicit synchronous owner resolver callback.',
    { subject: 'resolveOwnerBinding', missingCapability: 'prompt-section-owner-resolution' }
  );
  return value;
}

function resolveBindings(preflight, contractSet, resolveOwnerBinding) {
  const resolver = ownerResolver(resolveOwnerBinding);
  const limits = contractSet.logicalComposer.limits;
  const counters = {
    coverage: 0,
    expansionRefs: 0,
    limitations: 0,
    sourceBytes: 0,
    textBytes: preflight.textBytes,
    metadataBytes: preflight.metadataBytes
  };
  const rawBindings = preflight.sections.map((section, index) => {
    const request = deepFreeze({
      kind: 'tkr/prompt-section-owner-resolution-request',
      version: 1,
      sectionId: section.id,
      index,
      composerSha256: contractSet.composer.contractSha256,
      rendererRef: section.rendererRef
    });
    let result;
    try {
      result = resolver(request);
    } catch (error) {
      if (error instanceof SingularityFlowError) throw error;
      unsupported(`Owner resolution failed for prompt section '${section.id}'.`, {
        sectionId: section.id,
        cause: error instanceof Error ? error.message : String(error)
      });
    }
    if (result && typeof result.then === 'function') unsupported(
      `Owner resolution for prompt section '${section.id}' was asynchronous.`,
      {
        sectionId: section.id,
        nextAction: 'Capture owner bindings before composition and return them synchronously.'
      }
    );
    return preflightRawBinding(result, section, index, counters, limits);
  });
  // All raw counts and source-byte ceilings are established before any binding becomes an offer.
  return rawBindings.map((binding, index) => normalizeOwnerBinding(
    binding, preflight.sections[index], index, contractSet, counters
  ));
}

function bindingToEntry(section, binding) {
  const notApplicable = binding.applicability === 'not-applicable';
  const renderedRef = notApplicable
    ? null
    : { sha256: binding.sourceSha256, bytes: binding.sourceByteLength };
  const representations = notApplicable ? [] : [{
    representation: 'full',
    rendererRef: binding.rendererRef,
    content: binding.sourceBytes,
    renderedRef,
    coverage: binding.coverage,
    expansionRefs: binding.expansionRefs,
    limitations: binding.limitations,
    protectedSpans: [{
      sourceRef: binding.sourceRef,
      sourceBytes: binding.sourceBytes,
      sourceStart: 0,
      sourceEnd: binding.sourceByteLength,
      renderedStart: 0,
      renderedEnd: binding.sourceByteLength,
      encoding: 'literal-utf8'
    }],
    aliasUses: []
  }];
  return {
    input: {
      id: section.id,
      mandatory: binding.applicability === 'required',
      applicability: binding.applicability,
      applicabilityDecisionRef: binding.applicabilityDecisionRef,
      priority: binding.priority,
      renderedRef,
      subjectRef: binding.subjectRef,
      ownerBindingRef: binding.bindingSha256,
      evidenceRole: binding.evidenceRole,
      assuranceRef: binding.assuranceRef,
      requirementRef: binding.requirementRef,
      coverage: binding.coverage,
      sourceRef: binding.sourceRef,
      sourceSha256: binding.sourceSha256,
      sourceByteLength: binding.sourceByteLength,
      expansionRefs: binding.expansionRefs,
      limitations: binding.limitations,
      rendererRef: binding.rendererRef
    },
    offer: {
      sectionId: section.id,
      subjectRef: binding.subjectRef,
      evidenceRole: binding.evidenceRole,
      assuranceRef: binding.assuranceRef,
      requirementRef: binding.requirementRef,
      applicability: binding.applicability,
      permittedRepresentations: notApplicable ? [] : ['full'],
      coverage: binding.coverage,
      representations,
      priority: binding.priority,
      limitations: binding.limitations
    }
  };
}

/**
 * Convert exact prompt bytes into full-only TKR offers using owner-resolved governance facts.
 * The adapter has no built-in I/O, dispatch, model, persistence, or lifecycle dependency. It
 * invokes the caller-supplied synchronous owner resolver; that caller owns and must prove the
 * resolver's side-effect boundary.
 */
export function promptSectionsToTokenReductionOffers(sections, options = {}) {
  const normalizedOptions = closed(options, ADAPTER_OPTION_KEYS, 'adapter options');
  const contractSet = validatedContractSet(normalizedOptions.contractSet);
  const preflight = preflightSections(sections, contractSet);
  const bindings = resolveBindings(
    preflight, contractSet, normalizedOptions.resolveOwnerBinding
  );
  const entries = preflight.sections.map((section, index) => (
    bindingToEntry(section, bindings[index])
  ));
  return deepFreeze({
    contractSet,
    offers: entries.map((entry) => entry.offer),
    inputs: entries.map((entry) => entry.input)
  });
}

function sectionReport(inputs, composition) {
  const selected = new Map(composition.segments.map((segment) => [segment.id, segment]));
  const omitted = new Map(composition.omissions.map((entry) => [entry.sectionId, entry]));
  const sections = inputs.map((input) => {
    const segment = selected.get(input.id);
    const omission = omitted.get(input.id);
    return {
      id: input.id,
      mandatory: input.mandatory,
      applicability: input.applicability,
      applicabilityDecisionRef: input.applicabilityDecisionRef,
      priority: input.priority,
      subjectRef: input.subjectRef,
      ownerBindingRef: input.ownerBindingRef,
      evidenceRole: input.evidenceRole,
      assuranceRef: input.assuranceRef,
      requirementRef: input.requirementRef,
      coverage: input.coverage,
      sourceRef: input.sourceRef,
      sourceSha256: input.sourceSha256,
      sourceByteLength: input.sourceByteLength,
      rendererRef: input.rendererRef,
      limitations: input.limitations,
      originalRenderedRef: input.renderedRef,
      outcome: segment ? 'included' : 'omitted',
      representation: segment?.representation ?? null,
      finalRenderedRef: segment ? { sha256: segment.sha256, bytes: segment.bytes } : null,
      omission: omission ? {
        reason: omission.reason,
        expansionRefs: omission.expansionRefs,
        carrierSectionId: omission.carrierSectionId ?? null,
        coverageProofSha256: omission.coverageProofSha256 ?? null
      } : null
    };
  });
  const retainedOriginalSectionBytes = sections.reduce((total, entry) => (
    total + (entry.outcome === 'included' ? (entry.originalRenderedRef?.bytes ?? 0) : 0)
  ), 0);
  const separatorBytes = composition.separators.reduce((total, entry) => total + entry.bytes, 0);
  const generatedSectionBytes = composition.segments
    .filter((segment) => segment.representation.startsWith('generated-'))
    .reduce((total, segment) => total + segment.bytes, 0);
  return {
    kind: 'tkr/prompt-section-report',
    version: 1,
    sources: inputs.map((input) => ({
      sectionId: input.id,
      subjectRef: input.subjectRef,
      ownerBindingRef: input.ownerBindingRef,
      evidenceRole: input.evidenceRole,
      assuranceRef: input.assuranceRef,
      requirementRef: input.requirementRef,
      applicability: input.applicability,
      applicabilityDecisionRef: input.applicabilityDecisionRef,
      sourceRef: input.sourceRef,
      sourceSha256: input.sourceSha256,
      sourceByteLength: input.sourceByteLength
    })),
    ownerAssuranceRefs: [...new Set(inputs.map((input) => input.assuranceRef))],
    composerSha256: composition.composerSha256,
    compositionRef: {
      sha256: composition.sha256,
      bytes: composition.bytes,
      composerSha256: composition.composerSha256
    },
    measurement: {
      candidateSectionBytes: inputs.reduce(
        (total, entry) => total + (entry.renderedRef?.bytes ?? 0), 0
      ),
      retainedOriginalSectionBytes,
      generatedSectionBytes,
      separatorBytes,
      finalCompositionBytes: composition.bytes,
      tokens: null,
      tokenizerRef: null,
      assurance: 'owner-declared-assurance-with-exact-byte-verification'
    },
    sections
  };
}

/** Compose owner-bound prompt sections through the packaged deterministic TKR preview. */
export function composePromptSectionsWithTokenReduction(options) {
  const normalizedOptions = closed(options, COMPOSE_OPTION_KEYS, 'compose options');
  const {
    sections,
    maximumBytes,
    contractSet: contractSetValue,
    resolveOwnerBinding
  } = normalizedOptions;
  const adapted = promptSectionsToTokenReductionOffers(sections, {
    contractSet: contractSetValue,
    resolveOwnerBinding
  });
  const composition = composeTokenReductionContext({
    contract: adapted.contractSet.composer,
    contracts: adapted.contractSet.contracts,
    rendererContracts: adapted.contractSet.rendererContracts,
    offers: adapted.offers,
    maximumBytes
  });
  return deepFreeze({
    composition,
    sectionReport: sectionReport(adapted.inputs, composition)
  });
}
