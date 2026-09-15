import {
  canonicalJson, compareText, deepFreeze, sha256
} from '../canonicalize.mjs';
import {
  assertExactKeys, assertPlainRecord, assertString, contractFailure
} from '../contracts.mjs';
import { createCompletenessRecordFromExtractionExecution } from '../extract/completeness.mjs';
import { runDeterministicRegistration } from '../extract/runner.mjs';
import {
  createWmpModelBinding, validateWmpModelInputDescriptors
} from './contracts.mjs';
import {
  deriveWmpParseSchemaSha256, WMP_SOURCE_NORMALIZATION_CONTRACT_SHA256
} from './extraction-profile-owners.mjs';
import {
  WMP_IDENTITY_VERSION, createWmpSourceBinding, deriveWmpModelKey,
  validateWmpModelInputs, validateWmpObjectRefs
} from './identity.mjs';
import {
  createWorldModelExtractionPolicy, validateWorldModelExtractionPolicy,
  validateWorldModelRepositoryDomain
} from './model-owners.mjs';
import { stageWorldModelHistoryPublication } from './publication.mjs';
import {
  resolveWorldModelRepositoryIdentityAuthority,
  validateWorldModelRepositoryIdentityAuthority
} from './repository-identity-authority.mjs';
import { parseExactRetainedObject } from './retained-object.mjs';
import {
  resolvePersistedWorldModel, validateRetainedWorldModelBindingGraph
} from './store.mjs';
import {
  resolveConfiguredWorldModelHistoryAuthorityCut
} from './authority-cut.mjs';
import {
  assertInstalledExtractorRegistry, BUILTIN_EXTRACTOR_REGISTRY, DEFAULT_EXTRACTOR_REFERENCES,
  resolveExtractorExecutionContract, resolveExtractorManifest
} from '../registry/extractors.mjs';
import { validateScopeManifest } from '../scope/manifest.mjs';
import {
  createDiscoveredCandidateRoster, validateSourceSnapshot, verifyDiscoveredCandidateRoster,
  verifyExactSourceSnapshot
} from '../source/snapshot.mjs';
import {
  WMP_CANDIDATE_EXCLUSION_REASONS, WMP_CANDIDATE_ROSTER_FAMILY,
  WMP_CANDIDATE_ROSTER_ROLE, validateWorldModelDiscoveredCandidateRoster
} from './candidate-roster-owner.mjs';
import { classifyScopePath } from '../scope/matcher.mjs';

const PREPARATION_KIND = 'wmp/model-build-preparation';
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const AUTHORITY_REF = /^refs\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const OBJECT_REF_KEYS = Object.freeze(['bytes', 'family', 'mediaType', 'role', 'sha256']);

function fail(message, code = 'WMP_MODEL_BUILD_INVALID', details = {}) {
  contractFailure(message, code, details);
}

function retainActionInput(value, label) {
  try { return structuredClone(value); }
  catch (error) {
    fail(`${label} cannot be retained exactly before the asynchronous action boundary.`,
      'WMP_MODEL_BUILD_INVALID', { cause: error?.name ?? null });
  }
}

function exactRef(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson(OBJECT_REF_KEYS);
}

function collectRefs(value, refs = []) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectRefs(entry, refs));
  } else if (value && typeof value === 'object') {
    if (exactRef(value)) refs.push(value);
    else Object.values(value).forEach((entry) => collectRefs(entry, refs));
  }
  return refs;
}

function refKey(value) {
  return `${value.role}\0${value.family ?? ''}\0${value.sha256}`;
}

function sortedRefs(values) {
  return [...values].sort((left, right) => compareText(refKey(left), refKey(right)));
}

function retainedRecord(record, role, family) {
  const bytes = canonicalJson(record);
  const raw = Buffer.from(bytes, 'utf8');
  return deepFreeze({
    ref: {
      role, family, mediaType: 'application/json', sha256: sha256(raw), bytes: raw.length
    },
    bytes
  });
}

function validateRetainedObjects(values, label) {
  if (!Array.isArray(values)) fail(`${label} must be an array.`);
  const refs = values.map((value, index) => {
    assertPlainRecord(value, `${label}[${index}]`);
    assertExactKeys(value, { required: ['ref', 'bytes'], label: `${label}[${index}]` });
    if (typeof value.bytes !== 'string') {
      fail(`${label}[${index}] bytes must be exact canonical UTF-8 text.`,
        'WMP_CANONICAL_BYTES_REQUIRED');
    }
    parseExactRetainedObject(value.ref, Buffer.from(value.bytes, 'utf8'));
    return value.ref;
  });
  validateWmpObjectRefs(sortedRefs(refs), label);
  const ordered = [...values].sort((left, right) => compareText(refKey(left.ref), refKey(right.ref)));
  if (canonicalJson(ordered.map((entry) => entry.ref)) !== canonicalJson(sortedRefs(refs))) {
    fail(`${label} must use canonical retained-object order.`);
  }
  return values;
}

function objectByRole(values, role, label) {
  const matches = values.filter((entry) => entry.ref.role === role);
  if (matches.length !== 1) {
    fail(`${label} requires exactly one '${role}' object.`, 'WMP_INPUT_ROLE_MISSING', {
      role, matches: matches.length
    });
  }
  return matches[0];
}

function parsedObject(value) {
  return parseExactRetainedObject(value.ref, Buffer.from(value.bytes, 'utf8'));
}

function validatePreparationCandidateRoster(retained, descriptors, source, scope) {
  const captures = descriptors.extractionInputs.captures.filter(
    (entry) => entry.role === WMP_CANDIDATE_ROSTER_ROLE
  );
  if (captures.length !== 1 || captures[0].status !== 'available') {
    fail('Model preparation requires one owned full discovered Candidate Roster.',
      'WMP_INPUT_ROLE_MISSING', {
        role: WMP_CANDIDATE_ROSTER_ROLE, matches: captures.length
      });
  }
  const object = objectByRole(retained, WMP_CANDIDATE_ROSTER_ROLE, 'Model preparation');
  if (object.ref.family !== WMP_CANDIDATE_ROSTER_FAMILY
      || canonicalJson(captures[0].objectRef) !== canonicalJson(object.ref)
      || captures[0].subject !== source.subject.id) {
    fail('Model preparation Candidate Roster capture is not its exact retained source input.',
      'WMP_CANDIDATE_ROSTER_BINDING_MISMATCH');
  }
  const roster = validateWorldModelDiscoveredCandidateRoster(parsedObject(object));
  if (roster.sourceManifestSha256 !== source.sourceManifestSha256
      || roster.scopeManifestSha256 !== scope.scopeSha256
      || roster.source.commit !== source.revision.commit
      || roster.source.gitObjectFormat !== descriptors.sourceBinding.gitObjectFormat) {
    fail('Model preparation Candidate Roster does not bind its exact source and scope.',
      'WMP_CANDIDATE_ROSTER_BINDING_MISMATCH');
  }
  const selected = new Map(source.files.map((entry) => [entry.path, entry]));
  for (const candidate of roster.candidates) {
    const classification = classifyScopePath(candidate.path, scope);
    const expectedStatus = classification.status === 'inside' ? 'selected' : 'excluded';
    const expectedReason = classification.status === 'inside'
      ? null : WMP_CANDIDATE_EXCLUSION_REASONS[classification.status];
    if (candidate.status !== expectedStatus || candidate.reasonCode !== expectedReason) {
      fail(`Model preparation Candidate Roster misclassifies '${candidate.path}'.`,
        'WMP_CANDIDATE_ROSTER_SCOPE_MISMATCH', { path: candidate.path });
    }
    if (candidate.status === 'selected') {
      const file = selected.get(candidate.path);
      if (!file || file.type !== candidate.type || file.mode !== candidate.mode
          || file.contentSha256 !== candidate.contentSha256
          || file.bytes !== candidate.bytes) {
        fail(`Model preparation Candidate Roster mismatches selected path '${candidate.path}'.`,
          'WMP_CANDIDATE_ROSTER_SOURCE_MISMATCH', { path: candidate.path });
      }
      selected.delete(candidate.path);
    } else if (selected.has(candidate.path)) {
      fail(`Model preparation Candidate Roster excludes selected path '${candidate.path}'.`,
        'WMP_CANDIDATE_ROSTER_SOURCE_MISMATCH', { path: candidate.path });
    }
  }
  if (selected.size) {
    fail('Model preparation Candidate Roster omits selected Source Snapshot paths.',
      'WMP_CANDIDATE_ROSTER_SOURCE_MISMATCH', {
        omittedPaths: [...selected.keys()].sort(compareText).slice(0, 100),
        omitted: Math.max(0, selected.size - 100)
      });
  }
  return roster;
}

function assertAuthorityMatchesDomain(authorityValue, domainValue, capabilityId) {
  const authority = validateWorldModelRepositoryIdentityAuthority(authorityValue);
  const domain = validateWorldModelRepositoryDomain(domainValue);
  for (const field of [
    'repositoryDomainSha256', 'repositoryId', 'repositoryIdentitySha256'
  ]) {
    if (authority[field] !== domain[field]) {
      fail(
        `Repository authority '${field}' does not match the retained Repository Domain.`,
        'WMP_REPOSITORY_AUTHORITY_MISMATCH', { field }
      );
    }
  }
  if (authority.capability.id !== capabilityId) {
    fail(
      'Repository authority capability does not match the selected World-model scope.',
      'WMP_REPOSITORY_AUTHORITY_MISMATCH', {
        expected: capabilityId, received: authority.capability.id
      }
    );
  }
  return { authority, domain };
}

function extractorMajor(version) {
  const major = Number(String(version).split('.')[0]);
  if (!Number.isSafeInteger(major) || major < 1) {
    fail(`Extractor version '${version}' has no supported major identity.`);
  }
  return major;
}

function validateExtractorReferences(values, registry, policy, profile) {
  if (!Array.isArray(values) || !values.length || values.length > 1024) {
    fail('Model preparation requires 1 through 1024 exact extractor references.',
      'WMP_CONTRACT_LIMIT');
  }
  const references = [...values];
  if (new Set(references).size !== references.length
      || canonicalJson(references) !== canonicalJson([...references].sort(compareText))) {
    fail('Model preparation extractor references must be unique and canonical.');
  }
  const profileByManifest = new Map(profile.extractors.map((entry) => [
    entry.manifestSha256, entry
  ]));
  const policyByManifest = new Map(policy.allowedExtractors.map((entry) => [
    entry.manifestSha256, entry
  ]));
  const selectedReferences = new Set(references);
  const missingCoverageExtractor = policy.factSemantics.coverageExtractorRefs.find(
    (reference) => !selectedReferences.has(reference)
  );
  if (missingCoverageExtractor) {
    fail(
      `Extraction Policy coverage extractor '${missingCoverageExtractor}' is absent from the exact build roster.`,
      'WMP_MODEL_INPUT_MISMATCH', { extractor: missingCoverageExtractor }
    );
  }
  for (const reference of references) {
    if (typeof reference !== 'string' || !SEMVER.test(reference.split('@').at(-1) ?? '')) {
      fail(`Extractor reference '${reference}' is invalid.`);
    }
    const manifest = resolveExtractorManifest(registry, reference);
    const execution = resolveExtractorExecutionContract(manifest);
    const selected = profileByManifest.get(manifest.manifestSha256);
    const allowed = policyByManifest.get(manifest.manifestSha256);
    if (!selected || selected.id !== manifest.id
        || selected.version !== extractorMajor(manifest.version)
        || selected.implementationSha256 !== manifest.producer.implementationSha256
        || selected.grammarSha256 !== manifest.producer.parser.grammarSha256
        || selected.parserSha256 !== null || selected.resolverSha256 !== null) {
      fail(`Extractor '${reference}' is not exactly represented by the Extraction Profile.`,
        'WMP_MODEL_INPUT_MISMATCH', { extractor: reference });
    }
    if (!allowed || allowed.id !== manifest.id || allowed.version !== manifest.version
        || allowed.implementationSha256 !== manifest.producer.implementationSha256
        || allowed.coverage !== execution.coverage) {
      fail(`Extractor '${reference}' is not exactly allowed by the Extraction Policy.`,
        'WMP_MODEL_INPUT_MISMATCH', { extractor: reference });
    }
  }
  if (profile.extractors.length !== references.length) {
    fail('Extraction Profile contains an extractor outside the exact build roster.',
      'WMP_MODEL_INPUT_MISMATCH');
  }
}

/**
 * Derive the only deterministic Extraction Policy admitted by the frozen v1 build boundary.
 *
 * `policySnapshotSha256` identifies the approved or Story-pinned policy source which selected the
 * Scope Manifest. The remaining semantics are not caller-authored: the exact product-owned
 * default execution roster determines both the allowed Facts and the coverage obligations. A caller therefore
 * cannot reuse that governed digest while substituting weaker Fact or coverage semantics.
 */
export function deriveFrozenV1WorldModelExtractionPolicy(scopeValue, registryValue,
  extractorReferencesValue = DEFAULT_EXTRACTOR_REFERENCES) {
  const scope = validateScopeManifest(scopeValue);
  const registry = assertInstalledExtractorRegistry(registryValue);
  if (!Array.isArray(extractorReferencesValue)) {
    fail('Frozen v1 Extraction Policy requires the product-owned default execution roster.',
      'WMP_EXTRACTION_POLICY_AUTHORITY_MISMATCH');
  }
  const extractorReferences = [...extractorReferencesValue].sort(compareText);
  const installedReferences = [...DEFAULT_EXTRACTOR_REFERENCES].sort(compareText);
  if (new Set(extractorReferences).size !== extractorReferences.length
      || canonicalJson(extractorReferences) !== canonicalJson(installedReferences)) {
    fail(
      'Frozen v1 Extraction Policy requires the exact product-owned default execution roster; a reduced or custom roster has no governed policy owner.',
      'WMP_EXTRACTION_POLICY_AUTHORITY_MISMATCH', {
        expectedExtractorReferences: installedReferences,
        receivedExtractorReferences: extractorReferences
      }
    );
  }
  const manifests = extractorReferences.map((reference) => {
    const manifest = resolveExtractorManifest(registry, reference);
    const execution = resolveExtractorExecutionContract(manifest);
    return { manifest, execution };
  });
  const allowedFactTypes = [...new Set(manifests.flatMap(
    ({ manifest }) => manifest.factTypes
  ))].sort(compareText);
  return createWorldModelExtractionPolicy({
    policySnapshotSha256: scope.policySourceSha256,
    allowedExtractors: manifests.map(({ manifest, execution }) => ({
      id: manifest.id,
      version: manifest.version,
      implementationSha256: manifest.producer.implementationSha256,
      manifestSha256: manifest.manifestSha256,
      coverage: execution.coverage
    })),
    factSemantics: {
      allowedFactTypes,
      requiredFactTypes: [],
      optionalFactTypes: allowedFactTypes,
      requiredUnavailableSubjects: [],
      coverageExtractorRefs: [...extractorReferences]
    }
  });
}

function assertGovernedExtractionPolicy(policy, scope, registry, extractorReferences) {
  const governed = deriveFrozenV1WorldModelExtractionPolicy(
    scope, registry, extractorReferences
  );
  if (canonicalJson(policy) !== canonicalJson(governed)) {
    fail(
      'Extraction Policy semantics differ from the deterministic policy derived from the exact approved scope and admitted extractor roster.',
      'WMP_EXTRACTION_POLICY_AUTHORITY_MISMATCH', {
        expected: governed.extractionPolicySha256,
        received: policy.extractionPolicySha256,
        policySourceSha256: scope.policySourceSha256
      }
    );
  }
  return governed;
}

function validatePreparationValue(value) {
  try { value = structuredClone(value); }
  catch (error) {
    fail('Persisted World-model build preparation cannot be retained exactly.',
      'WMP_MODEL_BUILD_INVALID', { cause: error?.name ?? null });
  }
  assertPlainRecord(value, 'Persisted World-model build preparation');
  assertExactKeys(value, {
    required: [
      'kind', 'version', 'capabilityId', 'repositoryDomain',
      'repositoryIdentityAuthority', 'modelKey', 'inputs', 'inputDescriptors',
      'inputObjects', 'retainedInputObjects', 'extractorReferences', 'preparationSha256'
    ],
    label: 'Persisted World-model build preparation'
  });
  if (value.kind !== PREPARATION_KIND || value.version !== 1) {
    fail('Persisted World-model build preparation kind or version is invalid.');
  }
  if (value.preparationSha256 !== sha256(Object.fromEntries(
    Object.entries(value).filter(([field]) => field !== 'preparationSha256')
  ))) {
    fail('Persisted World-model build preparation self-hash does not verify.',
      'WMP_INTEGRITY_FAILED');
  }
  const retained = validateRetainedObjects(
    value.retainedInputObjects, 'Persisted World-model retained input objects'
  );
  validateWmpObjectRefs(value.inputObjects, 'Persisted World-model input objects');
  if (canonicalJson(value.inputObjects)
      !== canonicalJson(retained.map((entry) => entry.ref))) {
    fail('Persisted World-model input refs do not match their exact retained bytes.',
      'WMP_INPUT_MISSING');
  }
  const descriptors = validateWmpModelInputDescriptors(value.inputDescriptors);
  const sourceBinding = descriptors.sourceBinding;
  const sourceObject = objectByRole(retained, 'source-snapshot', 'Model preparation');
  const scopeObject = objectByRole(retained, 'scope-manifest', 'Model preparation');
  const policyObject = objectByRole(retained, 'extraction-policy', 'Model preparation');
  const registryObject = objectByRole(retained, 'extractor-registry', 'Model preparation');
  const domainObject = objectByRole(retained, 'repository-domain', 'Model preparation');
  const source = validateSourceSnapshot(parsedObject(sourceObject));
  const scope = validateScopeManifest(parsedObject(scopeObject));
  const policy = validateWorldModelExtractionPolicy(parsedObject(policyObject));
  const registry = assertInstalledExtractorRegistry(parsedObject(registryObject));
  const domain = validateWorldModelRepositoryDomain(parsedObject(domainObject));
  if (canonicalJson(domain) !== canonicalJson(value.repositoryDomain)) {
    fail('Model preparation Repository Domain differs from its retained object.',
      'WMP_REPOSITORY_AUTHORITY_MISMATCH');
  }
  assertAuthorityMatchesDomain(value.repositoryIdentityAuthority, domain, value.capabilityId);
  if (scope.capabilityId !== value.capabilityId || source.subject.id !== value.capabilityId) {
    fail('Model preparation source, scope, and governed capability do not have one identity.',
      'WMP_REPOSITORY_AUTHORITY_MISMATCH', {
        capabilityId: value.capabilityId,
        sourceSubject: source.subject.id,
        scopeCapabilityId: scope.capabilityId
      });
  }
  if (policy.policySnapshotSha256 !== scope.policySourceSha256) {
    fail(
      'Extraction Policy does not originate from the exact policy sealed by the Scope Manifest.',
      'WMP_MODEL_INPUT_MISMATCH', {
        policySnapshotSha256: policy.policySnapshotSha256,
        policySourceSha256: scope.policySourceSha256
      }
    );
  }
  if (source.authority || sourceBinding.sourceKind !== 'committed'
      || sourceBinding.sourceAuthorityRef !== null) {
    fail(
      'Frozen v1 persisted-model preparation supports committed source only; Candidate adoption requires its deferred source-authority owner.',
      'WMP_SOURCE_AUTHORITY_OWNER_UNAVAILABLE'
    );
  }
  if (canonicalJson(sourceBinding.repositoryDomainRef) !== canonicalJson(domainObject.ref)
      || canonicalJson(sourceBinding.sourceSnapshotRef) !== canonicalJson(sourceObject.ref)
      || sourceBinding.repositoryDomainSha256 !== domain.repositoryDomainSha256
      || sourceBinding.sourceManifestSha256 !== source.sourceManifestSha256
      || sourceBinding.scopeManifestSha256 !== scope.scopeSha256
      || sourceBinding.effectiveRevision !== source.revision.commit) {
    fail('Model preparation Source Binding does not match its exact retained inputs.',
      'WMP_MODEL_INPUT_MISMATCH');
  }
  const candidateRoster = validatePreparationCandidateRoster(
    retained, descriptors, source, scope
  );
  if (descriptors.extractionProfile.configurationRefs.length) {
    fail(
      'Configured extraction has no installed frozen v1 configuration owner.',
      'WMP_EXTRACTION_CONFIGURATION_OWNER_UNAVAILABLE'
    );
  }
  validateExtractorReferences(
    value.extractorReferences, registry, policy, descriptors.extractionProfile
  );
  assertGovernedExtractionPolicy(policy, scope, registry, value.extractorReferences);
  for (const field of [
    'requiredFactTypes', 'optionalFactTypes', 'requiredUnavailableSubjects'
  ]) {
    if (canonicalJson(policy.factSemantics[field])
        !== canonicalJson(descriptors.factRequirements[field])) {
      fail(`Extraction Policy '${field}' differs from Fact Requirements.`,
        'WMP_MODEL_INPUT_MISMATCH', { field });
    }
  }
  const requiredRefs = new Map([
    domainObject.ref, sourceObject.ref, scopeObject.ref, policyObject.ref, registryObject.ref,
    ...collectRefs(descriptors)
  ].map((ref) => [refKey(ref), ref]));
  const expectedInputObjects = sortedRefs([...requiredRefs.values()]);
  if (canonicalJson(value.inputObjects) !== canonicalJson(expectedInputObjects)) {
    fail(
      'Model preparation input objects must equal the exact owner and descriptor closure; unkeyed extra objects are forbidden.',
      'WMP_INPUT_ROSTER_MISMATCH', {
        expected: expectedInputObjects.map(refKey),
        received: value.inputObjects.map(refKey)
      }
    );
  }
  const inputs = validateWmpModelInputs(value.inputs);
  const expectedInputs = {
    identityVersion: WMP_IDENTITY_VERSION,
    repositoryDomainSha256: domain.repositoryDomainSha256,
    sourceBindingSha256: sha256(sourceBinding),
    sourceManifestSha256: source.sourceManifestSha256,
    scopeManifestSha256: scope.scopeSha256,
    extractionPolicySha256: policy.extractionPolicySha256,
    extractorRegistrySha256: registry.registrySha256,
    extractionProfileSha256: sha256(descriptors.extractionProfile),
    factRequirementsSha256: sha256(descriptors.factRequirements),
    extractionInputsSha256: sha256(descriptors.extractionInputs)
  };
  if (canonicalJson(inputs) !== canonicalJson(expectedInputs)
      || deriveWmpModelKey(inputs) !== value.modelKey) {
    fail('Model preparation key does not match its complete pre-extraction inputs.',
      'WMP_MODEL_KEY_MISMATCH');
  }
  return {
    preparation: deepFreeze(value), source, scope, policy, registry, domain,
    candidateRoster, retainedInputObjects: retained, descriptors, inputs
  };
}

export function validatePersistedWorldModelBuildPreparation(value) {
  return validatePreparationValue(value).preparation;
}

function profileFor(registry, extractorReferences) {
  const extractors = extractorReferences.map((reference) => {
    const manifest = resolveExtractorManifest(registry, reference);
    // Exact current-runtime admission happens before any lookup can claim this key is reusable.
    resolveExtractorExecutionContract(manifest);
    return {
      id: manifest.id,
      version: extractorMajor(manifest.version),
      manifestSha256: manifest.manifestSha256,
      grammarSha256: manifest.producer.parser.grammarSha256,
      parserSha256: null,
      resolverSha256: null,
      implementationSha256: manifest.producer.implementationSha256
    };
  }).sort((left, right) => compareText(
    `${left.id}\0${String(left.version).padStart(12, '0')}`,
    `${right.id}\0${String(right.version).padStart(12, '0')}`
  ));
  return {
    kind: 'wmp/extraction-profile', version: 1, extractors,
    parseSchemaSha256: deriveWmpParseSchemaSha256(extractors),
    normalizationContractSha256: WMP_SOURCE_NORMALIZATION_CONTRACT_SHA256,
    configurationRefs: []
  };
}

/**
 * Capture the exact model-key preimage after source capture but before application extraction.
 * The repository domain is always resolved from governed configuration; callers cannot inject it.
 */
export async function preparePersistedWorldModelBuild(root, {
  capabilityId, sourceSnapshot, scopeManifest, extractionPolicy,
  extractorRegistry, extractorReferences = DEFAULT_EXTRACTOR_REFERENCES,
  requestedRevision = null,
  coverageRuleRefs = [], extractionInputs = { kind: 'wmp/extraction-inputs', version: 1, captures: [] },
  additionalInputObjects = [],
  pinnedCapabilityResolution = null,
  resolveRepositoryAuthority = resolveWorldModelRepositoryIdentityAuthority
} = {}) {
  if (typeof resolveRepositoryAuthority !== 'function') {
    fail('Persisted-model preparation requires the governed repository authority resolver.',
      'WMP_REPOSITORY_AUTHORITY_REQUIRED');
  }
  ({
    capabilityId,
    sourceSnapshot,
    scopeManifest,
    extractionPolicy,
    extractorRegistry,
    extractorReferences,
    requestedRevision,
    coverageRuleRefs,
    extractionInputs,
    additionalInputObjects,
    pinnedCapabilityResolution
  } = retainActionInput({
    capabilityId,
    sourceSnapshot,
    scopeManifest,
    extractionPolicy,
    extractorRegistry,
    extractorReferences,
    requestedRevision,
    coverageRuleRefs,
    extractionInputs,
    additionalInputObjects,
    pinnedCapabilityResolution
  }, 'Persisted-model preparation inputs'));
  const suppliedScope = validateScopeManifest(scopeManifest);
  const suppliedSource = validateSourceSnapshot(sourceSnapshot);
  if (suppliedSource.authority) {
    fail(
      'Candidate source cannot enter frozen v1 persisted-model preparation without its deferred source-authority owner.',
      'WMP_SOURCE_AUTHORITY_OWNER_UNAVAILABLE'
    );
  }
  const policy = validateWorldModelExtractionPolicy(extractionPolicy);
  if (policy.policySnapshotSha256 !== suppliedScope.policySourceSha256) {
    fail(
      'Extraction Policy must originate from the exact policy sealed by the Scope Manifest.',
      'WMP_MODEL_INPUT_MISMATCH', {
        policySnapshotSha256: policy.policySnapshotSha256,
        policySourceSha256: suppliedScope.policySourceSha256
      }
    );
  }
  const registry = assertInstalledExtractorRegistry(extractorRegistry);
  const selectedCapability = capabilityId ?? suppliedScope.capabilityId;
  const resolvedAuthority = await resolveRepositoryAuthority(root, {
    capabilityId: selectedCapability,
    pinnedCapabilityResolution
  });
  assertPlainRecord(resolvedAuthority, 'Resolved World-model repository authority');
  assertExactKeys(resolvedAuthority, {
    required: ['repositoryDomain', 'repositoryIdentityAuthority', 'scopeManifest'],
    label: 'Resolved World-model repository authority'
  });
  const scope = validateScopeManifest(resolvedAuthority.scopeManifest);
  if (canonicalJson(scope) !== canonicalJson(suppliedScope)) {
    fail(
      'Caller-supplied World-model scope differs from the exact approved or Story-pinned scope.',
      'WMP_SCOPE_AUTHORITY_MISMATCH', {
        expected: scope.scopeSha256,
        received: suppliedScope.scopeSha256
      }
    );
  }
  const { authority, domain } = assertAuthorityMatchesDomain(
    resolvedAuthority.repositoryIdentityAuthority,
    resolvedAuthority.repositoryDomain,
    selectedCapability
  );
  // Validation alone proves only a self-consistent record. Re-read the exact current Git source
  // against the independently derived governed scope so a caller cannot inject a historical,
  // foreign, or wider Source Snapshot and reuse it as present-day execution authority.
  const source = verifyExactSourceSnapshot(root, suppliedSource, { scopeManifest: scope });
  if (requestedRevision !== null && requestedRevision !== source.revision.commit) {
    fail(
      'Frozen v1 persisted-model preparation requires requestedRevision to equal the exact committed source revision.',
      'WMB_SOURCE_REVISION_INVALID', {
        expected: source.revision.commit, received: requestedRevision
      }
    );
  }
  if (!Array.isArray(extractionInputs?.captures)) {
    fail('Persisted-model extraction inputs require a bounded capture array.');
  }
  if (extractionInputs.captures.some(
    (entry) => entry?.role === WMP_CANDIDATE_ROSTER_ROLE
  )) {
    fail(
      'The full discovered Candidate Roster is captured by the governed source boundary and cannot be caller-supplied.',
      'WMP_CANDIDATE_ROSTER_CALLER_FORBIDDEN'
    );
  }
  const candidateRoster = createDiscoveredCandidateRoster(root, {
    sourceSnapshot: source, scopeManifest: scope
  });
  const candidateRosterObject = retainedRecord(
    candidateRoster, WMP_CANDIDATE_ROSTER_ROLE, WMP_CANDIDATE_ROSTER_FAMILY
  );
  const ownedExtractionInputs = {
    ...extractionInputs,
    captures: [
      ...extractionInputs.captures,
      {
        role: WMP_CANDIDATE_ROSTER_ROLE,
        subject: source.subject.id,
        status: 'available',
        objectRef: candidateRosterObject.ref,
        reason: null
      }
    ].sort((left, right) => compareText(
      `${left.role}\0${left.subject}`, `${right.role}\0${right.subject}`
    ))
  };
  const references = [...(extractorReferences ?? [])].sort(compareText);
  const extractionProfile = profileFor(registry, references);
  validateExtractorReferences(references, registry, policy, extractionProfile);
  assertGovernedExtractionPolicy(policy, scope, registry, references);
  const factRequirements = {
    kind: 'wmp/fact-requirements', version: 1,
    requiredFactTypes: [...policy.factSemantics.requiredFactTypes],
    optionalFactTypes: [...policy.factSemantics.optionalFactTypes],
    coverageRuleRefs: sortedRefs(coverageRuleRefs),
    requiredUnavailableSubjects: [...policy.factSemantics.requiredUnavailableSubjects]
  };
  const domainObject = retainedRecord(
    domain, 'repository-domain', 'world-model-repository-domain'
  );
  const sourceObject = retainedRecord(
    source, 'source-snapshot', 'world-model-source-snapshot'
  );
  const scopeObject = retainedRecord(
    scope, 'scope-manifest', 'world-model-scope-manifest'
  );
  const policyObject = retainedRecord(
    policy, 'extraction-policy', 'world-model-extraction-policy'
  );
  const registryObject = retainedRecord(
    registry, 'extractor-registry', 'world-model-extractor-registry'
  );
  const sourceBinding = createWmpSourceBinding({
    repositoryDomainRef: domainObject.ref,
    repositoryDomainSha256: domain.repositoryDomainSha256,
    sourceKind: 'committed',
    sourceSnapshotRef: sourceObject.ref,
    sourceManifestSha256: source.sourceManifestSha256,
    scopeManifestSha256: scope.scopeSha256,
    gitObjectFormat: source.revision.commit.length === 64 ? 'sha256' : 'sha1',
    requestedRevision: source.revision.commit,
    effectiveRevision: source.revision.commit,
    sourceAuthorityRef: null
  });
  const inputDescriptors = validateWmpModelInputDescriptors({
    sourceBinding, extractionProfile, factRequirements, extractionInputs: ownedExtractionInputs
  });
  const retainedInputObjects = validateRetainedObjects([
    candidateRosterObject, domainObject, sourceObject, scopeObject, policyObject, registryObject,
    ...additionalInputObjects
  ].sort((left, right) => compareText(refKey(left.ref), refKey(right.ref))),
  'Persisted World-model retained input objects');
  const inputObjects = retainedInputObjects.map((entry) => entry.ref);
  const inputs = validateWmpModelInputs({
    identityVersion: WMP_IDENTITY_VERSION,
    repositoryDomainSha256: domain.repositoryDomainSha256,
    sourceBindingSha256: sha256(sourceBinding),
    sourceManifestSha256: source.sourceManifestSha256,
    scopeManifestSha256: scope.scopeSha256,
    extractionPolicySha256: policy.extractionPolicySha256,
    extractorRegistrySha256: registry.registrySha256,
    extractionProfileSha256: sha256(extractionProfile),
    factRequirementsSha256: sha256(factRequirements),
    extractionInputsSha256: sha256(ownedExtractionInputs)
  });
  const preparationCore = {
    kind: PREPARATION_KIND,
    version: 1,
    capabilityId: selectedCapability,
    repositoryDomain: domain,
    repositoryIdentityAuthority: authority,
    modelKey: deriveWmpModelKey(inputs),
    inputs,
    inputDescriptors,
    inputObjects,
    retainedInputObjects,
    extractorReferences: references
  };
  const preparation = {
    ...preparationCore,
    preparationSha256: sha256(preparationCore)
  };
  validatePreparationValue(preparation);
  return deepFreeze(preparation);
}

function closureFromObjects(objects) {
  return new Map(objects.map((object) => [object.ref.sha256, {
    ref: object.ref,
    record: parsedObject(object)
  }]));
}

function immutableCanonicalText(bytes, label) {
  if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)) {
    fail(`${label} must contain exact retained bytes.`, 'WMP_INTEGRITY_FAILED');
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (error) {
    fail(`${label} is not valid canonical UTF-8.`, 'WMP_INTEGRITY_FAILED', {
      cause: error?.name ?? null
    });
  }
}

/**
 * Retain a resolver result synchronously and expose exact bytes as immutable text.
 *
 * Buffers cannot be frozen in JavaScript. Returning the store's shallow-frozen result would let a
 * consumer mutate binding or closure bytes after validation, while its digest fields continued to
 * describe the original content. Every successful model closure is canonical UTF-8 JSON, so this
 * action DTO keeps the exact representation as strings and recursively freezes cloned records.
 */
function retainImmutableResolvedModel(value) {
  assertPlainRecord(value, 'Resolved persisted World-model');
  assertExactKeys(value, {
    required: [
      'authorityCommit', 'authorityRef', 'historyDir', 'bindingPath', 'binding',
      'bindingBytes', 'bindingByteSha256', 'closure', 'totalBytes'
    ],
    label: 'Resolved persisted World-model'
  });
  if (!Array.isArray(value.closure)) {
    fail('Resolved persisted World-model closure must be an array.',
      'WMP_INTEGRITY_FAILED');
  }
  const bindingCanonicalBytes = immutableCanonicalText(
    value.bindingBytes, 'Resolved persisted World-model binding'
  );
  if (sha256(Buffer.from(bindingCanonicalBytes, 'utf8')) !== value.bindingByteSha256) {
    fail('Resolved persisted World-model binding bytes changed after verification.',
      'WMP_INTEGRITY_FAILED');
  }
  const closure = value.closure.map((entry, index) => {
    assertPlainRecord(entry, `Resolved persisted World-model closure[${index}]`);
    assertExactKeys(entry, {
      required: ['authorityCommit', 'ref', 'bytes', 'record', 'ownerError'],
      label: `Resolved persisted World-model closure[${index}]`
    });
    if (entry.ownerError !== null || entry.record === null) {
      fail(
        `Resolved persisted World-model closure[${index}] has no admitted semantic owner.`,
        'WMP_OBJECT_OWNER_UNAVAILABLE'
      );
    }
    const canonicalBytes = immutableCanonicalText(
      entry.bytes, `Resolved persisted World-model closure[${index}]`
    );
    if (Buffer.byteLength(canonicalBytes, 'utf8') !== entry.ref?.bytes
        || sha256(Buffer.from(canonicalBytes, 'utf8')) !== entry.ref?.sha256) {
      fail(
        `Resolved persisted World-model closure[${index}] bytes changed after verification.`,
        'WMP_INTEGRITY_FAILED'
      );
    }
    return {
      authorityCommit: entry.authorityCommit,
      ref: structuredClone(entry.ref),
      canonicalBytes,
      record: structuredClone(entry.record)
    };
  });
  return deepFreeze({
    authorityCommit: value.authorityCommit,
    authorityRef: value.authorityRef,
    historyDir: value.historyDir,
    bindingPath: value.bindingPath,
    binding: structuredClone(value.binding),
    bindingCanonicalBytes,
    bindingByteSha256: value.bindingByteSha256,
    closure,
    totalBytes: value.totalBytes
  });
}

/**
 * Resolve one exact accepted binding before extraction. Only a typed absence becomes a miss;
 * corruption, compatibility, authority, or graph errors remain hard refusals.
 */
export async function lookupPersistedWorldModelBeforeExtraction(root, {
  preparation, authorityCommit, authorityRef,
  historyDir, outputDir, env, runCommand,
  pinnedCapabilityResolution = null,
  resolveModel = resolvePersistedWorldModel,
  resolveRepositoryAuthority = resolveWorldModelRepositoryIdentityAuthority,
  resolveHistoryAuthority = resolveConfiguredWorldModelHistoryAuthorityCut
} = {}) {
  ({ preparation, pinnedCapabilityResolution } = retainActionInput({
    preparation, pinnedCapabilityResolution
  }, 'Persisted-model lookup inputs'));
  env = env === undefined ? undefined : Object.freeze({ ...env });
  const prepared = validatePreparationValue(preparation);
  if (typeof resolveModel !== 'function') fail('Persisted-model lookup resolver is invalid.');
  // Preparation is only a sealed plan, not a timeless assertion that the checkout still exposes
  // the same committed source. Re-prove it before even consulting history so a stale plan cannot
  // select a model after local source or scope changed.
  verifyExactSourceSnapshot(root, prepared.source, { scopeManifest: prepared.scope });
  verifyDiscoveredCandidateRoster(root, {
    candidateRoster: prepared.candidateRoster,
    sourceSnapshot: prepared.source,
    scopeManifest: prepared.scope,
    ...(env === undefined ? {} : { env })
  });
  await refreshAuthority(root, prepared, resolveRepositoryAuthority, {
    pinnedCapabilityResolution
  });
  const selectedAuthority = await admittedHistoryAuthority(root, resolveHistoryAuthority, {
    authorityCommit, authorityRef, env, runCommand,
    expectedRepositoryIdentitySha256: prepared.domain.repositoryIdentitySha256
  });
  let resolved;
  try {
    resolved = resolveModel(root, {
      authorityCommit: selectedAuthority.commit,
      authorityRef: selectedAuthority.ref,
      modelKey: prepared.preparation.modelKey,
      ...(historyDir === undefined ? {} : { historyDir }),
      ...(outputDir === undefined ? {} : { outputDir }),
      ...(env === undefined ? {} : { env }),
      ...(runCommand === undefined ? {} : { runCommand })
    });
  } catch (error) {
    if (error?.code !== 'WMP_MODEL_MISSING') throw error;
    // A missing binding can authorize extraction, so close the same read interval as a hit.
    // Neither source nor approved capability/configuration authority may change while history is
    // being inspected.
    verifyExactSourceSnapshot(root, prepared.source, { scopeManifest: prepared.scope });
    await refreshAuthority(root, prepared, resolveRepositoryAuthority, {
      pinnedCapabilityResolution
    });
    const finalAuthority = await admittedHistoryAuthority(root, resolveHistoryAuthority, {
      env, runCommand,
      expectedRepositoryIdentitySha256: prepared.domain.repositoryIdentitySha256
    });
    assertSameHistoryAuthority(selectedAuthority, finalAuthority);
    return deepFreeze({
      resultType: 'wmp-model-lookup',
      status: 'missing',
      reasonCode: 'WMP_MODEL_MISSING',
      modelKey: prepared.preparation.modelKey,
      repositoryDomainSha256: prepared.domain.repositoryDomainSha256,
      inputPlanSha256: prepared.preparation.preparationSha256,
      authority: selectedAuthority,
      execution: {
        extraction: false, modelCalls: 0, astCalls: 0, cacheWrites: 0
      },
      next: { action: 'build' }
    });
  }
  // Snapshot the resolver result before the next asynchronous authority check. This also removes
  // mutable Buffer views from the public reuse result while retaining their exact canonical text.
  resolved = retainImmutableResolvedModel(resolved);
  const closure = new Map(resolved.closure.map((entry) => [entry.ref.sha256, entry]));
  validateRetainedWorldModelBindingGraph('model', resolved.binding, closure, {
    currentExtractorAdmission: true
  });
  if (resolved.binding.modelKey !== prepared.preparation.modelKey
      || canonicalJson(resolved.binding.inputs) !== canonicalJson(prepared.inputs)) {
    fail('Persisted-model lookup returned a binding for different exact inputs.',
      'WMP_MODEL_KEY_MISMATCH');
  }
  // The closure read can be slow on a large history. Re-prove both mutable boundaries after the
  // full graph has been parsed and before returning a reusable result.
  verifyExactSourceSnapshot(root, prepared.source, { scopeManifest: prepared.scope });
  await refreshAuthority(root, prepared, resolveRepositoryAuthority, {
    pinnedCapabilityResolution
  });
  const finalAuthority = await admittedHistoryAuthority(root, resolveHistoryAuthority, {
    env, runCommand,
    expectedRepositoryIdentitySha256: prepared.domain.repositoryIdentitySha256
  });
  assertSameHistoryAuthority(selectedAuthority, finalAuthority);
  if ((resolved.authorityRef != null && resolved.authorityRef !== selectedAuthority.ref)
      || (resolved.authorityCommit != null
        && resolved.authorityCommit !== selectedAuthority.commit)) {
    fail(
      'Persisted-model resolver returned a different state-authority cut.',
      'WMP_REPOSITORY_AUTHORITY_CHANGED'
    );
  }
  return deepFreeze({
    resultType: 'wmp-model-lookup',
    status: 'reused',
    modelKey: prepared.preparation.modelKey,
    repositoryDomainSha256: prepared.domain.repositoryDomainSha256,
    inputPlanSha256: prepared.preparation.preparationSha256,
    authority: selectedAuthority,
    bindingPath: resolved.bindingPath,
    bindingByteSha256: resolved.bindingByteSha256,
    modelPayloadSha256: resolved.binding.modelPayloadSha256,
    source: {
      requestedRevision: prepared.descriptors.sourceBinding.requestedRevision,
      effectiveRevision: prepared.descriptors.sourceBinding.effectiveRevision,
      sourceManifestSha256: prepared.source.sourceManifestSha256
    },
    execution: {
      extraction: false, modelCalls: 0, astCalls: 0, cacheWrites: 0
    },
    resolved
  });
}

async function admittedHistoryAuthority(root, resolveHistoryAuthority, {
  authorityCommit = null, authorityRef = null, env, runCommand,
  expectedRepositoryIdentitySha256
} = {}) {
  if (typeof resolveHistoryAuthority !== 'function') {
    fail('Persisted-model lookup requires the configured state-authority resolver.',
      'WMP_AUTHORITY_CUT_REQUIRED');
  }
  const resolved = await resolveHistoryAuthority(root, {
    expectedRepositoryIdentitySha256,
    ...(env === undefined ? {} : { env }),
    ...(runCommand === undefined ? {} : { runCommand })
  });
  assertPlainRecord(resolved, 'Configured World-model history authority');
  assertExactKeys(resolved, {
    required: ['ref', 'commit', 'repositoryIdentitySha256'],
    label: 'Configured World-model history authority'
  });
  assertString(resolved.ref, 'Configured World-model history authority ref', {
    pattern: AUTHORITY_REF
  });
  assertString(resolved.commit, 'Configured World-model history authority commit', {
    pattern: COMMIT
  });
  if (resolved.ref.includes('..') || resolved.ref.includes('//')
      || resolved.ref.endsWith('/') || resolved.ref.endsWith('.lock')
      || resolved.ref.includes('@{')) {
    fail('Configured World-model history authority ref is unsafe.',
      'WMP_AUTHORITY_CUT_REQUIRED');
  }
  if (resolved.ref.startsWith('refs/remotes/')) {
    if (resolved.repositoryIdentitySha256 !== expectedRepositoryIdentitySha256) {
      fail(
        'Configured World-model history endpoint differs from the approved Repository Domain.',
        'WMP_STATE_AUTHORITY_IDENTITY_MISMATCH',
        {
          expectedRepositoryIdentitySha256,
          observedRepositoryIdentitySha256: resolved.repositoryIdentitySha256 ?? null
        }
      );
    }
  } else if (!resolved.ref.startsWith('refs/heads/')
      || resolved.repositoryIdentitySha256 !== null) {
    fail(
      'Configured World-model history authority is neither an identity-bound remote ref nor an approved local ref.',
      'WMP_AUTHORITY_CUT_REQUIRED'
    );
  }
  // Legacy arguments are retained as assertions only. They can never select a different ref or
  // commit than the cut derived from the current approved configuration.
  if ((authorityRef != null && authorityRef !== resolved.ref)
      || (authorityCommit != null && authorityCommit !== resolved.commit)) {
    fail(
      'Caller-supplied World-model authority does not equal the configured state-authority cut.',
      'WMP_AUTHORITY_CUT_NOT_ADMITTED',
      {
        configuredRef: resolved.ref,
        configuredCommit: resolved.commit,
        suppliedRef: authorityRef,
        suppliedCommit: authorityCommit
      }
    );
  }
  return deepFreeze({
    ref: resolved.ref,
    commit: resolved.commit,
    repositoryIdentitySha256: resolved.repositoryIdentitySha256
  });
}

function assertSameHistoryAuthority(before, after) {
  if (canonicalJson(before) !== canonicalJson(after)) {
    fail(
      'Configured World-model state authority changed while persisted history was being read.',
      'WMP_REPOSITORY_AUTHORITY_CHANGED',
      { before, after }
    );
  }
}

function coverageFor(completeness, extractor) {
  if (extractor.coverage === 'global') {
    const outcome = completeness.globalOutcomes.find(
      (entry) => entry.id === extractor.id && entry.version === extractor.version
    );
    if (!outcome) fail(`Completeness omits global extractor '${extractor.id}@${extractor.version}'.`);
    return {
      status: outcome.status === 'processed' ? 'complete'
        : outcome.status === 'failed' ? 'unavailable' : 'partial',
      processedPaths: 0
    };
  }
  const outcomes = completeness.pathOutcomes
    .filter((entry) => entry.status !== 'excluded')
    .map((entry) => entry.extractors.find(
      (candidate) => candidate.id === extractor.id && candidate.version === extractor.version
    ));
  if (outcomes.some((entry) => !entry)) {
    fail(`Completeness omits path extractor '${extractor.id}@${extractor.version}'.`);
  }
  const statuses = new Set(outcomes.map((entry) => entry.status));
  return {
    status: statuses.has('failed') ? 'unavailable'
      : statuses.has('partial') || statuses.has('unsupported') ? 'partial' : 'complete',
    processedPaths: outcomes.filter(
      (entry) => entry.status === 'processed' || entry.status === 'partial'
    ).length
  };
}

async function refreshAuthority(root, prepared, resolveRepositoryAuthority, {
  pinnedCapabilityResolution = null
} = {}) {
  if (typeof resolveRepositoryAuthority !== 'function') {
    fail('Persisted-model binding requires the governed repository authority resolver.',
      'WMP_REPOSITORY_AUTHORITY_REQUIRED');
  }
  const current = await resolveRepositoryAuthority(root, {
    capabilityId: prepared.preparation.capabilityId,
    pinnedCapabilityResolution
  });
  assertPlainRecord(current, 'Current World-model repository authority');
  assertExactKeys(current, {
    required: ['repositoryDomain', 'repositoryIdentityAuthority', 'scopeManifest'],
    label: 'Current World-model repository authority'
  });
  const currentScope = validateScopeManifest(current.scopeManifest);
  if (canonicalJson(currentScope) !== canonicalJson(prepared.scope)) {
    fail(
      'Governed World-model scope changed after model preparation.',
      'WMP_REPOSITORY_AUTHORITY_CHANGED', {
        expected: prepared.scope.scopeSha256,
        received: currentScope.scopeSha256
      }
    );
  }
  const { domain } = assertAuthorityMatchesDomain(
    current.repositoryIdentityAuthority,
    current.repositoryDomain,
    prepared.preparation.capabilityId
  );
  if (canonicalJson(domain) !== canonicalJson(prepared.domain)) {
    fail('Repository authority changed the stable Repository Domain after extraction began.',
      'WMP_REPOSITORY_AUTHORITY_CHANGED');
  }
  if (current.repositoryIdentityAuthority.authoritySha256
      !== prepared.preparation.repositoryIdentityAuthority.authoritySha256) {
    fail(
      'Governed capability or configuration authority changed after model preparation.',
      'WMP_REPOSITORY_AUTHORITY_CHANGED', {
        expected: prepared.preparation.repositoryIdentityAuthority.authoritySha256,
        received: current.repositoryIdentityAuthority.authoritySha256
      }
    );
  }
  return current;
}

/**
 * Convert one completed, receipt-bound deterministic registration into an exact immutable Model
 * Binding and staged history envelope. This function never writes Git or advances state authority.
 */
export async function createPersistedWorldModelBindingFromBuild(root, {
  preparation, registration,
  pinnedCapabilityResolution = null,
  resolveRepositoryAuthority = resolveWorldModelRepositoryIdentityAuthority,
  historyDir, outputDir, env
} = {}) {
  const prepared = validatePreparationValue(preparation);
  verifyDiscoveredCandidateRoster(root, {
    candidateRoster: prepared.candidateRoster,
    sourceSnapshot: prepared.source,
    scopeManifest: prepared.scope,
    ...(env === undefined ? {} : { env })
  });
  let retainedRegistration;
  try { retainedRegistration = structuredClone(registration); }
  catch (error) {
    fail('Completed deterministic registration cannot be retained exactly.',
      'WMP_MODEL_BUILD_INVALID', { cause: error?.name ?? null });
  }
  await refreshAuthority(root, prepared, resolveRepositoryAuthority, {
    pinnedCapabilityResolution
  });
  assertPlainRecord(retainedRegistration, 'Completed deterministic registration');
  if (retainedRegistration.sourceSnapshot?.sourceManifestSha256
      !== prepared.source.sourceManifestSha256
      || retainedRegistration.scopeManifest?.scopeSha256 !== prepared.scope.scopeSha256
      || retainedRegistration.extractorRegistrySha256 !== prepared.registry.registrySha256) {
    fail('Completed extraction does not match the exact pre-extraction preparation.',
      'WMP_MODEL_BUILD_INPUT_CHANGED');
  }
  const completenessRecord = createCompletenessRecordFromExtractionExecution({
    sourceSnapshot: prepared.source,
    scopeManifest: prepared.scope,
    extractorRegistry: prepared.registry,
    extractorExecutions: retainedRegistration.extractorExecutions,
    evidenceCatalog: retainedRegistration.evidenceCatalog,
    derivationCatalog: retainedRegistration.derivationCatalog,
    factLedger: retainedRegistration.factLedger,
    resolvedViewContracts: retainedRegistration.resolvedViewContracts,
    viewFactLedgers: retainedRegistration.viewFactLedgers,
    extractionExecutionReceipt: retainedRegistration.extractionExecutionReceipt,
    candidateRoster: prepared.candidateRoster,
    factRequirements: prepared.descriptors.factRequirements
  });
  const payloadObjects = [
    retainedRecord(
      completenessRecord, 'completeness-record', 'world-model-completeness-record'
    ),
    retainedRecord(
      retainedRegistration.derivationCatalog, 'derivation-catalog', 'world-model-derivation-catalog'
    ),
    retainedRecord(
      retainedRegistration.evidenceCatalog, 'evidence-catalog', 'world-model-evidence-catalog'
    ),
    retainedRecord(retainedRegistration.factLedger, 'fact-ledger', 'world-model-fact-ledger')
  ].sort((left, right) => compareText(refKey(left.ref), refKey(right.ref)));
  const extractorCoverage = completenessRecord.extractorReferences.map((extractor) => ({
    id: extractor.id,
    version: extractorMajor(extractor.version),
    ...coverageFor(completenessRecord, extractor)
  })).sort((left, right) => compareText(
    `${left.id}\0${String(left.version).padStart(12, '0')}`,
    `${right.id}\0${String(right.version).padStart(12, '0')}`
  ));
  const completenessObject = objectByRole(
    payloadObjects, 'completeness-record', 'Completed model payload'
  );
  const binding = createWmpModelBinding({
    modelKey: prepared.preparation.modelKey,
    inputs: prepared.inputs,
    inputDescriptors: prepared.descriptors,
    inputObjects: prepared.preparation.inputObjects,
    payloadObjects: payloadObjects.map((entry) => entry.ref),
    completeness: {
      ...completenessRecord.counts,
      requiredSubjects: completenessRecord.requiredSubjects,
      extractorCoverage,
      completenessRecord: completenessObject.ref
    }
  });
  const objects = [
    ...prepared.retainedInputObjects,
    ...payloadObjects
  ].sort((left, right) => compareText(refKey(left.ref), refKey(right.ref)));
  validateRetainedWorldModelBindingGraph(
    'model', binding, closureFromObjects(objects), { currentExtractorAdmission: true }
  );
  const stagedHistory = stageWorldModelHistoryPublication({
    ...(historyDir === undefined ? {} : { historyDir }),
    ...(outputDir === undefined ? {} : { outputDir }),
    modelBindings: [binding],
    objects
  });
  return Object.freeze({
    status: 'built',
    modelKey: binding.modelKey,
    binding,
    objects: Object.freeze(objects),
    stagedHistory
  });
}

function validateMissingLookup(value, prepared) {
  try { value = structuredClone(value); }
  catch (error) {
    fail('Persisted World-model lookup miss cannot be retained exactly.',
      'WMP_MODEL_BUILD_NOT_AUTHORIZED', { cause: error?.name ?? null });
  }
  assertPlainRecord(value, 'Persisted World-model lookup miss');
  if (value.resultType !== 'wmp-model-lookup' || value.status !== 'missing'
      || value.reasonCode !== 'WMP_MODEL_MISSING' || value.next?.action !== 'build') {
    fail(
      'Persisted-model extraction requires an exact typed WMP_MODEL_MISSING lookup result.',
      'WMP_MODEL_BUILD_NOT_AUTHORIZED'
    );
  }
  assertExactKeys(value, {
    required: [
      'resultType', 'status', 'reasonCode', 'modelKey', 'repositoryDomainSha256',
      'inputPlanSha256', 'authority', 'execution', 'next'
    ],
    label: 'Persisted World-model lookup miss'
  });
  assertPlainRecord(value.authority, 'Persisted World-model lookup miss authority');
  assertExactKeys(value.authority, {
    required: ['ref', 'commit', 'repositoryIdentitySha256'],
    label: 'Persisted World-model lookup miss authority'
  });
  assertString(value.authority.ref, 'Persisted World-model lookup miss authority ref', {
    pattern: AUTHORITY_REF
  });
  assertString(value.authority.commit, 'Persisted World-model lookup miss authority commit', {
    pattern: COMMIT
  });
  if (value.authority.repositoryIdentitySha256 !== null) {
    assertString(
      value.authority.repositoryIdentitySha256,
      'Persisted World-model lookup miss authority repositoryIdentitySha256',
      { pattern: /^sha256:[a-f0-9]{64}$/ }
    );
  }
  if (value.authority.ref.includes('..') || value.authority.ref.includes('//')
      || value.authority.ref.endsWith('/') || value.authority.ref.endsWith('.lock')
      || value.authority.ref.includes('@{')) {
    fail('Persisted-model lookup miss authority ref is unsafe.',
      'WMP_AUTHORITY_CUT_REQUIRED');
  }
  assertPlainRecord(value.execution, 'Persisted World-model lookup miss execution');
  assertExactKeys(value.execution, {
    required: ['extraction', 'modelCalls', 'astCalls', 'cacheWrites'],
    label: 'Persisted World-model lookup miss execution'
  });
  assertPlainRecord(value.next, 'Persisted World-model lookup miss next action');
  assertExactKeys(value.next, {
    required: ['action'], label: 'Persisted World-model lookup miss next action'
  });
  if (value.modelKey !== prepared.preparation.modelKey
      || value.repositoryDomainSha256 !== prepared.domain.repositoryDomainSha256
      || value.inputPlanSha256 !== prepared.preparation.preparationSha256) {
    fail(
      'Persisted-model lookup miss does not bind the exact pre-extraction preparation.',
      'WMP_MODEL_KEY_MISMATCH'
    );
  }
  if (canonicalJson(value.execution) !== canonicalJson({
    extraction: false, modelCalls: 0, astCalls: 0, cacheWrites: 0
  })) {
    fail(
      'Persisted-model lookup miss cannot authorize a build after hidden execution.',
      'WMP_MODEL_BUILD_NOT_AUTHORIZED'
    );
  }
  return deepFreeze(value);
}

/**
 * Execute the deterministic registration exactly once after an explicit exact-key miss.
 *
 * Lookup and build remain separate public actions so callers cannot turn absence into implicit
 * work. This adapter performs no model, network, cache, Git, or state mutation; it only returns a
 * fully validated immutable history envelope for the normal state-branch transaction owner.
 */
export async function buildPersistedWorldModelAfterLookupMiss(root, {
  preparation, lookup, requestedViews = [], viewRegistry,
  pinnedCapabilityResolution = null,
  runRegistration = runDeterministicRegistration,
  resolveModel = resolvePersistedWorldModel,
  resolveRepositoryAuthority = resolveWorldModelRepositoryIdentityAuthority,
  resolveHistoryAuthority = resolveConfiguredWorldModelHistoryAuthorityCut,
  historyDir, outputDir, env, runCommand
} = {}) {
  ({
    preparation,
    lookup,
    requestedViews,
    viewRegistry,
    pinnedCapabilityResolution
  } = retainActionInput({
    preparation,
    lookup,
    requestedViews,
    viewRegistry,
    pinnedCapabilityResolution
  }, 'Persisted-model build inputs'));
  env = env === undefined ? undefined : Object.freeze({ ...env });
  const prepared = validatePreparationValue(preparation);
  const retainedLookup = validateMissingLookup(lookup, prepared);
  if (!Array.isArray(requestedViews)) {
    fail('Persisted-model build requestedViews must be an array.');
  }
  if (requestedViews.length) {
    fail(
      'Persisted-model view requirements do not yet have a complete frozen input owner; build the model without views.',
      'WMP_VIEW_REQUIREMENTS_OWNER_UNAVAILABLE'
    );
  }
  if (typeof runRegistration !== 'function') {
    fail('Persisted-model build requires one deterministic registration function.');
  }
  verifyExactSourceSnapshot(root, prepared.source, { scopeManifest: prepared.scope });
  verifyDiscoveredCandidateRoster(root, {
    candidateRoster: prepared.candidateRoster,
    sourceSnapshot: prepared.source,
    scopeManifest: prepared.scope,
    ...(env === undefined ? {} : { env })
  });
  // Re-prove authority immediately before source access. The binding adapter repeats this check
  // after registration so a changed map, portfolio, capability pin, or configuration cut cannot
  // cross the extraction interval.
  await refreshAuthority(root, prepared, resolveRepositoryAuthority, {
    pinnedCapabilityResolution
  });
  // The miss is an observation, not a transferable build capability. Re-read the same admitted
  // authority cut immediately before extraction so a fabricated lookup object or an already
  // published exact binding cannot authorize redundant work.
  const confirmedMiss = await lookupPersistedWorldModelBeforeExtraction(root, {
    preparation: prepared.preparation,
    pinnedCapabilityResolution,
    resolveModel,
    resolveRepositoryAuthority,
    resolveHistoryAuthority,
    ...(historyDir === undefined ? {} : { historyDir }),
    ...(outputDir === undefined ? {} : { outputDir }),
    ...(env === undefined ? {} : { env }),
    ...(runCommand === undefined ? {} : { runCommand })
  });
  validateMissingLookup(confirmedMiss, prepared);
  if (canonicalJson(confirmedMiss.authority) !== canonicalJson(retainedLookup.authority)) {
    fail(
      'Persisted-model authority cut changed while confirming the exact miss.',
      'WMP_REPOSITORY_AUTHORITY_CHANGED'
    );
  }
  const registration = await runRegistration({
    root,
    sourceSnapshot: prepared.source,
    scopeManifest: prepared.scope,
    extractorRegistry: prepared.registry,
    extractorReferences: prepared.preparation.extractorReferences,
    requestedViews: [...requestedViews],
    ...(viewRegistry === undefined ? {} : { viewRegistry }),
    captureExtractorExecutions: true
  });
  const built = await createPersistedWorldModelBindingFromBuild(root, {
    preparation: prepared.preparation,
    registration,
    pinnedCapabilityResolution,
    resolveRepositoryAuthority,
    ...(historyDir === undefined ? {} : { historyDir }),
    ...(outputDir === undefined ? {} : { outputDir }),
    ...(env === undefined ? {} : { env })
  });
  // Extraction can be long enough for another process to win the exact-key publication race.
  // Re-read the current admitted state cut after the completed registration. A still-missing key
  // is useful only when the cut is unchanged; otherwise our staged bytes were built against an
  // obsolete authority. An exact byte-identical binding is safe to adopt and must not be staged
  // for a redundant publication. Every other winner is an integrity conflict.
  const afterRegistration = await lookupPersistedWorldModelBeforeExtraction(root, {
    preparation: prepared.preparation,
    pinnedCapabilityResolution,
    resolveModel,
    resolveRepositoryAuthority,
    resolveHistoryAuthority,
    ...(historyDir === undefined ? {} : { historyDir }),
    ...(outputDir === undefined ? {} : { outputDir }),
    ...(env === undefined ? {} : { env }),
    ...(runCommand === undefined ? {} : { runCommand })
  });
  const execution = deepFreeze({
    extraction: true, registrationCalls: 1, modelCalls: 0, astCalls: 0,
    cacheWrites: 0
  });
  if (afterRegistration.status === 'missing') {
    if (canonicalJson(afterRegistration.authority)
        !== canonicalJson(confirmedMiss.authority)) {
      fail(
        'World-model state authority advanced after extraction without publishing the exact model key.',
        'WMP_REPOSITORY_AUTHORITY_CHANGED',
        { before: confirmedMiss.authority, after: afterRegistration.authority }
      );
    }
    return deepFreeze({ ...built, execution });
  }
  if (afterRegistration.status !== 'reused'
      || canonicalJson(afterRegistration.resolved?.binding)
        !== canonicalJson(built.binding)) {
    fail(
      'A concurrent World-model publication claimed the exact model key with different binding bytes.',
      'WMP_MODEL_CONCURRENT_CONFLICT',
      {
        expectedBindingSha256: built.binding.bindingSha256,
        observedBindingSha256: afterRegistration.resolved?.binding?.bindingSha256 ?? null
      }
    );
  }
  return deepFreeze({
    status: 'reused',
    reasonCode: 'WMP_MODEL_CONCURRENT_WINNER',
    modelKey: built.modelKey,
    binding: afterRegistration.resolved.binding,
    authority: afterRegistration.authority,
    bindingPath: afterRegistration.bindingPath,
    bindingByteSha256: afterRegistration.bindingByteSha256,
    modelPayloadSha256: afterRegistration.modelPayloadSha256,
    stagedHistory: null,
    execution
  });
}
