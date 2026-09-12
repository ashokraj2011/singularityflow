import { currentSchemaVersion, readRecord, schemaFamily } from '../../schema-migrations.mjs';
import {
  COMMIT_PATTERN, FACT_ID_PATTERN, assertCanonicalOrder, assertExactKeys, assertInteger,
  assertPlainRecord, assertSha256, assertString, contractFailure
} from '../contracts.mjs';
import {
  canonicalJson, deepFreeze, sealRecord, sha256
} from '../canonicalize.mjs';
import {
  WMP_MAXIMUM_OBJECT_BYTES, assertSortedTypeIds, deriveWmpModelKey, deriveWmpViewKey,
  validateWmpModelInputs, validateWmpObjectRef, validateWmpObjectRefs,
  validateWmpSourceBinding, validateWmpViewInputsKey
} from './identity.mjs';

export const WMP_RECORD_FAMILIES = Object.freeze([
  'world-model-model-binding',
  'world-model-view-inputs',
  'world-model-view-binding',
  'world-model-grounding-reference',
  'world-model-handoff',
  'world-model-source-adoption'
]);

const RECORD_KIND = Object.freeze(Object.fromEntries(WMP_RECORD_FAMILIES.map((family) => [
  family, family
])));
const TYPE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const REASON_CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const SAFE_REF = /^refs\/[A-Za-z0-9._/-]+$/;
const SUBJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAXIMUM_RECORD_BYTES = 32 * 1024 * 1024;
const MAXIMUM_PATHS = 50_000;
const MAXIMUM_FACT_IDS = 100_000;
const MAXIMUM_GAPS = 10_000;
const MAXIMUM_CAPTURES = 10_000;
const REQUIRED_MODEL_INPUT_ROLES = Object.freeze([
  'extraction-policy',
  'extractor-registry',
  'repository-domain',
  'scope-manifest',
  'source-snapshot'
]);
const REQUIRED_MODEL_PAYLOAD_ROLES = Object.freeze([
  'completeness-record',
  'derivation-catalog',
  'evidence-catalog',
  'fact-ledger'
]);

function fail(message, code = 'WMP_CONTRACT_INVALID', details = {}) {
  contractFailure(message, code, details);
}

function exact(value, required, label, optional = []) {
  return assertExactKeys(value, { required, optional, label });
}

function boundedText(value, label, { pattern = null, maximumBytes = 1024 } = {}) {
  assertString(value, label, { pattern });
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > maximumBytes) {
    fail(`${label} exceeds its ${maximumBytes}-byte limit.`, 'WMP_CONTRACT_LIMIT', {
      label, bytes, maximumBytes
    });
  }
  return value;
}

function nullableDigest(value, label) {
  if (value !== null) assertSha256(value, label);
}

function nullableCommit(value, label) {
  if (value !== null) assertString(value, label, { pattern: COMMIT_PATTERN });
}

function record(value, family) {
  let migrated;
  try { migrated = readRecord(family, value).record; }
  catch (error) {
    fail(`${family} schema is unsupported: ${error.message}`, 'WMP_READER_UNSUPPORTED', {
      family, cause: error.code ?? null
    });
  }
  if (migrated.kind !== RECORD_KIND[family]) {
    fail(`${family} kind is invalid.`, 'WMP_CONTRACT_INVALID');
  }
  return migrated;
}

function validateRef(value, label, options = {}) {
  try { return validateWmpObjectRef(value, options); }
  catch (error) {
    if (error?.details && typeof error.details === 'object') {
      error.details = { ...error.details, owner: label };
    }
    throw error;
  }
}

function sortedRefs(value, label, options = {}) {
  validateWmpObjectRefs(value, label, options);
  return value;
}

function exactRefIdentity(value) {
  return canonicalJson({
    bytes: value.bytes,
    family: value.family,
    mediaType: value.mediaType,
    role: value.role,
    sha256: value.sha256
  });
}

function refsIn(value, refs = []) {
  if (Array.isArray(value)) {
    value.forEach((entry) => refsIn(entry, refs));
  } else if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    if (canonicalJson(keys) === canonicalJson(['bytes', 'family', 'mediaType', 'role', 'sha256'])) {
      refs.push(value);
    } else {
      Object.values(value).forEach((entry) => refsIn(entry, refs));
    }
  }
  return refs;
}

function requireRoleRoster(values, requiredRoles, label) {
  const byRole = new Map(values.map((ref) => [ref.role, ref]));
  const missing = requiredRoles.filter((role) => !byRole.has(role));
  if (missing.length) {
    fail(`${label} is missing required retained role(s): ${missing.join(', ')}.`,
      'WMP_INPUT_ROLE_MISSING', { label, missing });
  }
  return byRole;
}

function requireExactRefs(values, required, label) {
  const available = new Set(values.map(exactRefIdentity));
  for (const ref of required) {
    if (!available.has(exactRefIdentity(ref))) {
      fail(`${label} does not retain embedded role '${ref.role}' exactly.`,
        'WMP_INPUT_MISSING', { label, role: ref.role, sha256: ref.sha256 });
    }
  }
}

function validateModelObjectRosters(result) {
  const inputByRole = requireRoleRoster(
    result.inputObjects, REQUIRED_MODEL_INPUT_ROLES, 'WMP Model Binding inputObjects'
  );
  const payloadByRole = requireRoleRoster(
    result.payloadObjects, REQUIRED_MODEL_PAYLOAD_ROLES, 'WMP Model Binding payloadObjects'
  );
  const repeated = [...inputByRole.keys()].filter((role) => payloadByRole.has(role));
  if (repeated.length) {
    fail(`WMP Model Binding repeats retained role(s) across input and payload objects: ${repeated.join(', ')}.`,
      'WMP_OBJECT_ROLE_DUPLICATE', { roles: repeated });
  }
  validateRef(inputByRole.get('scope-manifest'), 'WMP scope-manifest input', {
    expectedRole: 'scope-manifest', expectedFamily: 'world-model-scope-manifest'
  });
  validateRef(payloadByRole.get('evidence-catalog'), 'WMP evidence-catalog payload', {
    expectedRole: 'evidence-catalog', expectedFamily: 'world-model-evidence-catalog'
  });
  validateRef(payloadByRole.get('derivation-catalog'), 'WMP derivation-catalog payload', {
    expectedRole: 'derivation-catalog', expectedFamily: 'world-model-derivation-catalog'
  });
  validateRef(payloadByRole.get('fact-ledger'), 'WMP fact-ledger payload', {
    expectedRole: 'fact-ledger', expectedFamily: 'world-model-fact-ledger'
  });
  requireExactRefs(
    result.inputObjects, refsIn(result.inputDescriptors), 'WMP Model Binding inputObjects'
  );
  requireExactRefs(
    result.payloadObjects, [result.completeness.completenessRecord],
    'WMP Model Binding payloadObjects'
  );
}

function assertDistinctPrimaryViewRefs(result) {
  const refs = [
    result.viewInputsRef,
    result.selectedFactLedgerRef,
    result.rendererContractRef,
    result.validatorContractRef,
    result.rendered,
    result.validatorReceiptRef
  ];
  const roles = refs.map((ref) => ref.role);
  if (new Set(roles).size !== roles.length) {
    fail('WMP View Binding primary retained roles must be unique.',
      'WMP_OBJECT_ROLE_DUPLICATE', { roles });
  }
  const byDigest = new Map();
  for (const ref of refs) {
    const prior = byDigest.get(ref.sha256);
    if (prior && exactRefIdentity(prior) !== exactRefIdentity(ref)) {
      fail(`WMP View Binding reuses '${ref.sha256}' with contradictory retained metadata.`,
        'WMP_INTEGRITY_FAILED', { sha256: ref.sha256 });
    }
    byDigest.set(ref.sha256, ref);
  }
}

function validateExtractionProfile(value) {
  assertPlainRecord(value, 'WMP Extraction Profile');
  exact(value, [
    'kind', 'version', 'extractors', 'parseSchemaSha256', 'normalizationContractSha256',
    'configurationRefs'
  ], 'WMP Extraction Profile');
  if (value.kind !== 'wmp/extraction-profile' || value.version !== 1) {
    fail('WMP Extraction Profile kind or version is invalid.');
  }
  if (!Array.isArray(value.extractors) || value.extractors.length > 1024) {
    fail('WMP Extraction Profile extractors must be a bounded array.', 'WMP_CONTRACT_LIMIT');
  }
  for (const [index, entry] of value.extractors.entries()) {
    exact(entry, [
      'id', 'version', 'manifestSha256', 'grammarSha256', 'parserSha256',
      'resolverSha256', 'implementationSha256'
    ], `WMP Extraction Profile extractor ${index}`);
    boundedText(entry.id, `WMP Extraction Profile extractor ${index} id`, {
      pattern: TYPE_ID, maximumBytes: 128
    });
    assertInteger(entry.version, `WMP Extraction Profile extractor ${index} version`, {
      minimum: 1
    });
    assertSha256(entry.manifestSha256, `WMP Extraction Profile extractor ${index} manifestSha256`);
    for (const field of [
      'grammarSha256', 'parserSha256', 'resolverSha256', 'implementationSha256'
    ]) nullableDigest(entry[field], `WMP Extraction Profile extractor ${index} ${field}`);
  }
  assertCanonicalOrder(value.extractors, (entry) => `${entry.id}\0${String(entry.version).padStart(12, '0')}`,
    'WMP Extraction Profile extractors');
  const refs = value.extractors.map((entry) => `${entry.id}@${entry.version}`);
  if (new Set(refs).size !== refs.length) fail('WMP Extraction Profile repeats an extractor.');
  assertSha256(value.parseSchemaSha256, 'WMP Extraction Profile parseSchemaSha256');
  assertSha256(value.normalizationContractSha256,
    'WMP Extraction Profile normalizationContractSha256');
  sortedRefs(value.configurationRefs, 'WMP Extraction Profile configurationRefs');
  return value;
}

function validateFactRequirements(value) {
  assertPlainRecord(value, 'WMP Fact Requirements');
  exact(value, [
    'kind', 'version', 'requiredFactTypes', 'optionalFactTypes', 'coverageRuleRefs',
    'requiredUnavailableSubjects'
  ], 'WMP Fact Requirements');
  if (value.kind !== 'wmp/fact-requirements' || value.version !== 1) {
    fail('WMP Fact Requirements kind or version is invalid.');
  }
  assertSortedTypeIds(value.requiredFactTypes, 'WMP required fact types');
  assertSortedTypeIds(value.optionalFactTypes, 'WMP optional fact types');
  const overlap = value.requiredFactTypes.find((id) => value.optionalFactTypes.includes(id));
  if (overlap) fail(`WMP Fact Requirements repeats '${overlap}' as required and optional.`);
  sortedRefs(value.coverageRuleRefs, 'WMP coverage rule refs');
  assertSortedTypeIds(value.requiredUnavailableSubjects,
    'WMP required unavailable subjects');
  return value;
}

function validateCapture(value, label) {
  assertPlainRecord(value, label);
  exact(value, ['role', 'subject', 'status', 'objectRef', 'reason'], label);
  boundedText(value.role, `${label} role`, { pattern: TYPE_ID, maximumBytes: 128 });
  boundedText(value.subject, `${label} subject`, { maximumBytes: 512 });
  if (!['available', 'unavailable', 'not-applicable'].includes(value.status)) {
    fail(`${label} status is invalid.`);
  }
  if (value.status === 'available') {
    validateRef(value.objectRef, label);
    if (value.reason !== null) fail(`${label} cannot have a reason when it is available.`);
  } else {
    if (value.objectRef !== null) fail(`${label} cannot have an object when it is unavailable.`);
    assertPlainRecord(value.reason, `${label} reason`);
    exact(value.reason, [
      'code', 'observationBoundarySha256', 'applicabilitySha256'
    ], `${label} reason`);
    boundedText(value.reason.code, `${label} reason code`, {
      pattern: REASON_CODE, maximumBytes: 128
    });
    assertSha256(value.reason.observationBoundarySha256,
      `${label} reason observationBoundarySha256`);
    assertSha256(value.reason.applicabilitySha256, `${label} reason applicabilitySha256`);
  }
  return value;
}

function validateCaptures(values, label) {
  if (!Array.isArray(values) || values.length > MAXIMUM_CAPTURES) {
    fail(`${label} must contain at most ${MAXIMUM_CAPTURES} entries.`, 'WMP_CONTRACT_LIMIT');
  }
  values.forEach((entry, index) => validateCapture(entry, `${label}[${index}]`));
  const keys = values.map((entry) => `${entry.role}\0${entry.subject}`);
  if (new Set(keys).size !== keys.length) fail(`${label} repeats a role and subject.`);
  assertCanonicalOrder(values, (entry) => `${entry.role}\0${entry.subject}`, label);
  return values;
}

function requiredAvailableCapture(values, role, label, { expectedFamily } = {}) {
  const matches = values.filter((capture) => capture.role === role);
  if (matches.length !== 1 || matches[0].status !== 'available') {
    fail(`${label} requires exactly one available '${role}' capture.`,
      'WMP_INPUT_ROLE_MISSING', { label, role, matches: matches.length });
  }
  validateRef(matches[0].objectRef, `${label} ${role}`, {
    expectedRole: role, expectedFamily
  });
  return matches[0];
}

function validateExtractionInputs(value) {
  assertPlainRecord(value, 'WMP Extraction Inputs');
  exact(value, ['kind', 'version', 'captures'], 'WMP Extraction Inputs');
  if (value.kind !== 'wmp/extraction-inputs' || value.version !== 1) {
    fail('WMP Extraction Inputs kind or version is invalid.');
  }
  validateCaptures(value.captures, 'WMP Extraction Inputs captures');
  return value;
}

function validateInputDescriptors(value) {
  assertPlainRecord(value, 'WMP input descriptors');
  exact(value, [
    'sourceBinding', 'extractionProfile', 'factRequirements', 'extractionInputs'
  ], 'WMP input descriptors');
  validateWmpSourceBinding(value.sourceBinding);
  validateExtractionProfile(value.extractionProfile);
  validateFactRequirements(value.factRequirements);
  validateExtractionInputs(value.extractionInputs);
  return value;
}

function validateRequiredSubjectOutcomes(values) {
  if (!Array.isArray(values) || values.length > MAXIMUM_FACT_IDS) {
    fail('WMP required-subject outcomes are not bounded.', 'WMP_CONTRACT_LIMIT');
  }
  for (const [index, entry] of values.entries()) {
    exact(entry, ['id', 'status', 'reasonCode'], `WMP required-subject outcome ${index}`);
    boundedText(entry.id, `WMP required-subject outcome ${index} id`, {
      pattern: TYPE_ID, maximumBytes: 256
    });
    if (!['available', 'partial', 'unavailable', 'contradicted'].includes(entry.status)) {
      fail(`WMP required-subject outcome ${index} status is invalid.`);
    }
    if (entry.reasonCode !== null) boundedText(entry.reasonCode,
      `WMP required-subject outcome ${index} reasonCode`, {
        pattern: REASON_CODE, maximumBytes: 128
      });
    if (entry.status !== 'available' && entry.reasonCode === null) {
      fail(`WMP required-subject outcome ${index} requires a reasonCode.`);
    }
  }
  if (new Set(values.map((entry) => entry.id)).size !== values.length) {
    fail('WMP required-subject outcomes repeat an ID.');
  }
  assertCanonicalOrder(values, (entry) => entry.id, 'WMP required-subject outcomes');
  return values;
}

function validateExtractorCoverage(values) {
  if (!Array.isArray(values) || values.length > 1024) {
    fail('WMP extractor coverage must be a bounded array.', 'WMP_CONTRACT_LIMIT');
  }
  for (const [index, entry] of values.entries()) {
    exact(entry, ['id', 'version', 'status', 'processedPaths'],
      `WMP extractor coverage ${index}`);
    boundedText(entry.id, `WMP extractor coverage ${index} id`, {
      pattern: TYPE_ID, maximumBytes: 128
    });
    assertInteger(entry.version, `WMP extractor coverage ${index} version`, { minimum: 1 });
    if (!['complete', 'partial', 'unavailable'].includes(entry.status)) {
      fail(`WMP extractor coverage ${index} status is invalid.`);
    }
    assertInteger(entry.processedPaths, `WMP extractor coverage ${index} processedPaths`, {
      minimum: 0, maximum: MAXIMUM_PATHS
    });
  }
  assertCanonicalOrder(values, (entry) => `${entry.id}\0${String(entry.version).padStart(12, '0')}`,
    'WMP extractor coverage');
  return values;
}

function validateCompleteness(value) {
  assertPlainRecord(value, 'WMP model completeness');
  exact(value, [
    'totalPaths', 'processedPaths', 'unsupportedPaths', 'failedPaths', 'excludedPaths',
    'requiredSubjects', 'extractorCoverage', 'completenessRecord'
  ], 'WMP model completeness');
  for (const field of [
    'totalPaths', 'processedPaths', 'unsupportedPaths', 'failedPaths', 'excludedPaths'
  ]) assertInteger(value[field], `WMP model completeness ${field}`, {
    minimum: 0, maximum: MAXIMUM_PATHS
  });
  if (value.processedPaths + value.unsupportedPaths + value.failedPaths !== value.totalPaths) {
    fail('WMP model completeness processed, unsupported, and failed counts must sum to totalPaths.',
      'WMP_COMPLETENESS_INVALID');
  }
  validateRequiredSubjectOutcomes(value.requiredSubjects);
  validateExtractorCoverage(value.extractorCoverage);
  validateRef(value.completenessRecord, 'WMP completeness record', {
    expectedRole: 'completeness-record'
  });
  return value;
}

function modelPayloadCore(value) {
  return {
    kind: 'wmp/model-payload',
    version: 1,
    modelKey: value.modelKey,
    inputs: structuredClone(value.inputs),
    inputDescriptors: structuredClone(value.inputDescriptors),
    inputObjects: structuredClone(value.inputObjects),
    payloadObjects: structuredClone(value.payloadObjects),
    completeness: structuredClone(value.completeness)
  };
}

export function validateWmpModelBinding(value) {
  const result = record(value, 'world-model-model-binding');
  exact(result, [
    'schemaVersion', 'kind', 'modelKey', 'inputs', 'inputDescriptors', 'inputObjects',
    'payloadObjects', 'completeness', 'modelPayloadSha256', 'bindingSha256'
  ], 'WMP Model Binding');
  validateWmpModelInputs(result.inputs);
  if (deriveWmpModelKey(result.inputs) !== result.modelKey) {
    fail('WMP Model Binding modelKey does not match its complete inputs.',
      'WMP_MODEL_KEY_MISMATCH');
  }
  validateInputDescriptors(result.inputDescriptors);
  const descriptors = result.inputDescriptors;
  const expected = {
    repositoryDomainSha256: descriptors.sourceBinding.repositoryDomainSha256,
    sourceBindingSha256: sha256(descriptors.sourceBinding),
    sourceManifestSha256: descriptors.sourceBinding.sourceManifestSha256,
    scopeManifestSha256: descriptors.sourceBinding.scopeManifestSha256,
    extractionProfileSha256: sha256(descriptors.extractionProfile),
    factRequirementsSha256: sha256(descriptors.factRequirements),
    extractionInputsSha256: sha256(descriptors.extractionInputs)
  };
  for (const [field, digest] of Object.entries(expected)) {
    if (result.inputs[field] !== digest) {
      fail(`WMP Model Binding ${field} does not match its retained descriptor.`,
        'WMP_MODEL_INPUT_MISMATCH', { field, expected: digest, received: result.inputs[field] });
    }
  }
  sortedRefs(result.inputObjects, 'WMP Model Binding inputObjects');
  sortedRefs(result.payloadObjects, 'WMP Model Binding payloadObjects');
  validateCompleteness(result.completeness);
  validateModelObjectRosters(result);
  assertSha256(result.modelPayloadSha256, 'WMP Model Binding modelPayloadSha256');
  const payloadSha256 = sha256(modelPayloadCore(result));
  if (result.modelPayloadSha256 !== payloadSha256) {
    fail('WMP Model Binding payload digest does not match its complete retained payload.',
      'WMP_MODEL_PAYLOAD_MISMATCH', { expected: payloadSha256, received: result.modelPayloadSha256 });
  }
  assertSha256(result.bindingSha256, 'WMP Model Binding bindingSha256');
  const core = structuredClone(result);
  delete core.bindingSha256;
  if (result.bindingSha256 !== sha256(core)) {
    fail('WMP Model Binding self-hash does not verify.', 'WMP_INTEGRITY_FAILED');
  }
  return result;
}

export function createWmpModelBinding(value) {
  const base = {
    schemaVersion: currentSchemaVersion('world-model-model-binding'),
    kind: 'world-model-model-binding',
    ...structuredClone(value)
  };
  base.modelKey ??= deriveWmpModelKey(base.inputs);
  base.modelPayloadSha256 = sha256(modelPayloadCore(base));
  return deepFreeze(validateWmpModelBinding(sealRecord(base, 'bindingSha256')));
}

function validateSelection(value) {
  assertPlainRecord(value, 'WMP View Selection');
  exact(value, [
    'kind', 'version', 'storyScopeSha256', 'querySha256', 'factIds', 'traversal'
  ], 'WMP View Selection');
  if (value.kind !== 'wmp/view-selection' || value.version !== 1) {
    fail('WMP View Selection kind or version is invalid.');
  }
  nullableDigest(value.storyScopeSha256, 'WMP View Selection storyScopeSha256');
  nullableDigest(value.querySha256, 'WMP View Selection querySha256');
  assertSortedFactIds(value.factIds, 'WMP View Selection factIds');
  exact(value.traversal, ['maximumFacts', 'maximumEdges', 'maximumDepth'],
    'WMP View Selection traversal');
  assertInteger(value.traversal.maximumFacts, 'WMP View Selection maximumFacts', {
    minimum: 1, maximum: 100_000
  });
  assertInteger(value.traversal.maximumEdges, 'WMP View Selection maximumEdges', {
    minimum: 1, maximum: 100_000
  });
  assertInteger(value.traversal.maximumDepth, 'WMP View Selection maximumDepth', {
    minimum: 1, maximum: 32
  });
  return value;
}

function assertSortedFactIds(values, label) {
  if (!Array.isArray(values) || values.length > MAXIMUM_FACT_IDS) {
    fail(`${label} must contain at most ${MAXIMUM_FACT_IDS} IDs.`, 'WMP_CONTRACT_LIMIT');
  }
  values.forEach((entry, index) => boundedText(entry, `${label}[${index}]`, {
    pattern: FACT_ID_PATTERN, maximumBytes: 80
  }));
  if (new Set(values).size !== values.length) fail(`${label} contains duplicates.`);
  assertCanonicalOrder(values, (entry) => entry, label);
  return values;
}

export function validateWmpViewInputs(value) {
  const result = record(value, 'world-model-view-inputs');
  exact(result, [
    'schemaVersion', 'kind', 'modelPayloadSha256', 'captures', 'viewContractRef',
    'consumerProfileRef', 'selection', 'comparisonRef', 'evidenceCutRef',
    'inputManifestSha256'
  ], 'WMP View Inputs');
  assertSha256(result.modelPayloadSha256, 'WMP View Inputs modelPayloadSha256');
  validateCaptures(result.captures, 'WMP View Inputs captures');
  requiredAvailableCapture(result.captures, 'output-budget', 'WMP View Inputs', {
    expectedFamily: 'world-model-output-budget'
  });
  validateRef(result.viewContractRef, 'WMP View Inputs viewContractRef', {
    expectedRole: 'view-contract', expectedFamily: 'world-model-view-contract'
  });
  validateRef(result.consumerProfileRef, 'WMP View Inputs consumerProfileRef', {
    expectedRole: 'consumer-profile', expectedFamily: 'world-model-consumer-profile'
  });
  validateSelection(result.selection);
  if (result.comparisonRef !== null) validateRef(result.comparisonRef,
    'WMP View Inputs comparisonRef', { expectedRole: 'comparison-input' });
  if (result.evidenceCutRef !== null) validateRef(result.evidenceCutRef,
    'WMP View Inputs evidenceCutRef', { expectedRole: 'evidence-cut' });
  assertSha256(result.inputManifestSha256, 'WMP View Inputs inputManifestSha256');
  const core = structuredClone(result);
  delete core.inputManifestSha256;
  if (result.inputManifestSha256 !== sha256(core)) {
    fail('WMP View Inputs self-hash does not verify.', 'WMP_INTEGRITY_FAILED');
  }
  return result;
}

export function createWmpViewInputs(value) {
  return deepFreeze(validateWmpViewInputs(sealRecord({
    schemaVersion: currentSchemaVersion('world-model-view-inputs'),
    kind: 'world-model-view-inputs',
    ...structuredClone(value)
  }, 'inputManifestSha256')));
}

function validateGaps(values, label) {
  if (!Array.isArray(values) || values.length > MAXIMUM_GAPS) {
    fail(`${label} must contain at most ${MAXIMUM_GAPS} entries.`, 'WMP_CONTRACT_LIMIT');
  }
  for (const [index, gap] of values.entries()) {
    exact(gap, ['code', 'required', 'subject', 'reference'], `${label}[${index}]`);
    boundedText(gap.code, `${label}[${index}] code`, {
      pattern: REASON_CODE, maximumBytes: 128
    });
    if (typeof gap.required !== 'boolean') fail(`${label}[${index}] required must be boolean.`);
    boundedText(gap.subject, `${label}[${index}] subject`, { maximumBytes: 512 });
    if (gap.reference !== null) validateRef(gap.reference, `${label}[${index}] reference`);
  }
  const keys = values.map((gap) => `${gap.code}\0${gap.subject}`);
  if (new Set(keys).size !== values.length) fail(`${label} contains duplicates.`);
  assertCanonicalOrder(values, (gap) => `${gap.code}\0${gap.subject}`, label);
  return values;
}

function validateFactSelection(value) {
  exact(value, ['mode', 'selectedFactIds', 'omittedFactIds', 'manifestRef'],
    'WMP View Binding selection');
  if (!['inline', 'manifest'].includes(value.mode)) fail('WMP fact selection mode is invalid.');
  assertSortedFactIds(value.selectedFactIds, 'WMP selected fact IDs');
  assertSortedFactIds(value.omittedFactIds, 'WMP omitted fact IDs');
  const overlap = value.selectedFactIds.find((id) => value.omittedFactIds.includes(id));
  if (overlap) fail(`WMP fact selection both selects and omits '${overlap}'.`);
  if (value.mode === 'manifest') {
    validateRef(value.manifestRef, 'WMP fact selection manifestRef', {
      expectedRole: 'selection-manifest'
    });
    if (value.selectedFactIds.length || value.omittedFactIds.length) {
      fail('Manifest-mode WMP fact selection cannot also inline fact IDs.');
    }
  } else if (value.manifestRef !== null) {
    fail('Inline WMP fact selection cannot carry a selection manifest.');
  }
  return value;
}

function validateMeasurement(value, inputs, renderedBytes) {
  exact(value, ['bytes', 'tokens', 'tokenizerSha256'], 'WMP View Binding measurement');
  assertInteger(value.bytes, 'WMP View Binding measured bytes', {
    minimum: 1, maximum: WMP_MAXIMUM_OBJECT_BYTES
  });
  if (value.bytes !== renderedBytes) fail('WMP measured bytes do not match rendered ObjectRef.');
  nullableDigest(value.tokenizerSha256, 'WMP View Binding measurement tokenizerSha256');
  if (value.tokenizerSha256 !== inputs.tokenizerSha256) {
    fail('WMP measured tokenizer does not match the ViewInputsKey.', 'WMP_VIEW_KEY_MISMATCH');
  }
  if (value.tokenizerSha256 === null) {
    if (value.tokens !== null) fail('WMP token count cannot be asserted without a tokenizer.');
  } else {
    assertInteger(value.tokens, 'WMP View Binding measured tokens', { minimum: 0 });
  }
  return value;
}

export function validateWmpViewBinding(value) {
  const result = record(value, 'world-model-view-binding');
  exact(result, [
    'schemaVersion', 'kind', 'viewKey', 'inputs', 'viewInputsRef', 'selectedFactLedgerRef',
    'rendererContractRef', 'validatorContractRef', 'status', 'gaps', 'selection',
    'rendered', 'measurement', 'validatorReceiptRef', 'bindingSha256'
  ], 'WMP View Binding');
  validateWmpViewInputsKey(result.inputs);
  if (deriveWmpViewKey(result.inputs) !== result.viewKey) {
    fail('WMP View Binding viewKey does not match its complete inputs.', 'WMP_VIEW_KEY_MISMATCH');
  }
  validateRef(result.viewInputsRef, 'WMP View Binding viewInputsRef', {
    expectedRole: 'view-inputs', expectedFamily: 'world-model-view-inputs'
  });
  validateRef(result.selectedFactLedgerRef, 'WMP View Binding selectedFactLedgerRef', {
    expectedRole: 'selected-fact-ledger', expectedFamily: 'world-model-view-fact-ledger'
  });
  validateRef(result.rendererContractRef, 'WMP View Binding rendererContractRef', {
    expectedRole: 'renderer-contract'
  });
  validateRef(result.validatorContractRef, 'WMP View Binding validatorContractRef', {
    expectedRole: 'validator-contract'
  });
  if (!['complete', 'limited'].includes(result.status)) fail('WMP View Binding status is invalid.');
  validateGaps(result.gaps, 'WMP View Binding gaps');
  if (result.status === 'complete' && result.gaps.some((gap) => gap.required)) {
    fail('A complete WMP View Binding cannot retain a required gap.');
  }
  validateFactSelection(result.selection);
  validateRef(result.rendered, 'WMP View Binding rendered', {
    expectedRole: 'rendered-view', expectedFamily: null, rendered: true
  });
  const expectedMediaType = result.inputs.format === 'md' ? 'text/markdown' : 'application/json';
  if (result.rendered.mediaType !== expectedMediaType) {
    fail('WMP rendered media type does not match the ViewInputsKey format.');
  }
  validateMeasurement(result.measurement, result.inputs, result.rendered.bytes);
  validateRef(result.validatorReceiptRef, 'WMP View Binding validatorReceiptRef', {
    expectedRole: 'validator-receipt', expectedFamily: 'world-model-view-validation-receipt'
  });
  assertDistinctPrimaryViewRefs(result);
  assertSha256(result.bindingSha256, 'WMP View Binding bindingSha256');
  const core = structuredClone(result);
  delete core.bindingSha256;
  if (result.bindingSha256 !== sha256(core)) {
    fail('WMP View Binding self-hash does not verify.', 'WMP_INTEGRITY_FAILED');
  }
  return result;
}

export function createWmpViewBinding(value) {
  const base = {
    schemaVersion: currentSchemaVersion('world-model-view-binding'),
    kind: 'world-model-view-binding',
    ...structuredClone(value)
  };
  base.viewKey ??= deriveWmpViewKey(base.inputs);
  return deepFreeze(validateWmpViewBinding(sealRecord(base, 'bindingSha256')));
}

function validateGroundingSubject(value) {
  exact(value, [
    'repositoryDomainSha256', 'workId', 'workflowInstanceId', 'phase', 'generation', 'packetId'
  ], 'WMP Grounding subject');
  assertSha256(value.repositoryDomainSha256, 'WMP Grounding repositoryDomainSha256');
  for (const field of ['workId', 'workflowInstanceId', 'packetId']) {
    boundedText(value[field], `WMP Grounding ${field}`, { pattern: SUBJECT_ID, maximumBytes: 256 });
  }
  boundedText(value.phase, 'WMP Grounding phase', { pattern: TYPE_ID, maximumBytes: 128 });
  assertInteger(value.generation, 'WMP Grounding generation', { minimum: 1 });
}

function validateGroundingSource(value) {
  exact(value, [
    'kind', 'bindingSha256', 'snapshotSha256', 'requestedRevision', 'effectiveRevision',
    'comparisonBase'
  ], 'WMP Grounding source');
  if (!['committed', 'candidate'].includes(value.kind)) fail('WMP Grounding source kind is invalid.');
  assertSha256(value.bindingSha256, 'WMP Grounding source bindingSha256');
  assertSha256(value.snapshotSha256, 'WMP Grounding source snapshotSha256');
  assertString(value.requestedRevision, 'WMP Grounding source requestedRevision', {
    pattern: COMMIT_PATTERN
  });
  assertString(value.effectiveRevision, 'WMP Grounding source effectiveRevision', {
    pattern: COMMIT_PATTERN
  });
  nullableCommit(value.comparisonBase, 'WMP Grounding source comparisonBase');
}

function validateGroundingViews(values) {
  if (!Array.isArray(values) || !values.length || values.length > 256) {
    fail('WMP Grounding views must contain 1 through 256 entries.', 'WMP_CONTRACT_LIMIT');
  }
  for (const [index, entry] of values.entries()) {
    exact(entry, ['viewKey', 'bindingRef', 'variant', 'renderedRef'],
      `WMP Grounding view ${index}`);
    assertSha256(entry.viewKey, `WMP Grounding view ${index} viewKey`);
    validateRef(entry.bindingRef, `WMP Grounding view ${index} bindingRef`, {
      expectedRole: 'view-binding', expectedFamily: 'world-model-view-binding'
    });
    if (!['brief', 'full'].includes(entry.variant)) {
      fail(`WMP Grounding view ${index} variant is invalid.`);
    }
    validateRef(entry.renderedRef, `WMP Grounding view ${index} renderedRef`, {
      expectedRole: 'rendered-view', expectedFamily: null, rendered: true
    });
  }
  if (new Set(values.map((entry) => entry.viewKey)).size !== values.length) {
    fail('WMP Grounding repeats a view key.');
  }
}

function validateGroundingSelection(value) {
  exact(value, [
    'selectedFactIds', 'omittedFactIds', 'selectedContentSha256', 'omittedContentSha256'
  ], 'WMP Grounding selection');
  assertSortedFactIds(value.selectedFactIds, 'WMP Grounding selected fact IDs');
  assertSortedFactIds(value.omittedFactIds, 'WMP Grounding omitted fact IDs');
  assertSha256(value.selectedContentSha256, 'WMP Grounding selectedContentSha256');
  assertSha256(value.omittedContentSha256, 'WMP Grounding omittedContentSha256');
}

function validateGroundingBudget(value) {
  exact(value, ['mode', 'maximum', 'measured', 'tokenizerSha256'], 'WMP Grounding budget');
  if (!['tokens', 'bytes'].includes(value.mode)) fail('WMP Grounding budget mode is invalid.');
  assertInteger(value.maximum, 'WMP Grounding budget maximum', { minimum: 1 });
  assertInteger(value.measured, 'WMP Grounding budget measured', { minimum: 0 });
  if (value.measured > value.maximum) fail('WMP Grounding exceeded its retained budget.');
  nullableDigest(value.tokenizerSha256, 'WMP Grounding budget tokenizerSha256');
  if ((value.mode === 'tokens') !== (value.tokenizerSha256 !== null)) {
    fail('WMP Grounding token budget requires exactly one tokenizer identity.');
  }
}

function validateGroundingAuthority(value) {
  exact(value, [
    'repositoryDomainSha256', 'stateRef', 'authorityCommit', 'publicationRef', 'validationRefs'
  ], 'WMP Grounding authority');
  assertSha256(value.repositoryDomainSha256, 'WMP Grounding authority repositoryDomainSha256');
  boundedText(value.stateRef, 'WMP Grounding authority stateRef', {
    pattern: SAFE_REF, maximumBytes: 512
  });
  assertString(value.authorityCommit, 'WMP Grounding authority commit', {
    pattern: COMMIT_PATTERN
  });
  validateRef(value.publicationRef, 'WMP Grounding authority publicationRef', {
    expectedRole: 'publication-receipt'
  });
  sortedRefs(value.validationRefs, 'WMP Grounding authority validationRefs');
}

export function validateWmpGroundingReference(value) {
  const result = record(value, 'world-model-grounding-reference');
  exact(result, [
    'schemaVersion', 'kind', 'subject', 'source', 'model', 'views', 'inputRefs',
    'selection', 'renderedBlock', 'completeness', 'budget', 'authority', 'groundingSha256'
  ], 'WMP Grounding Reference');
  validateGroundingSubject(result.subject);
  validateGroundingSource(result.source);
  exact(result.model, ['modelKey', 'bindingRef', 'modelPayloadSha256'], 'WMP Grounding model');
  assertSha256(result.model.modelKey, 'WMP Grounding modelKey');
  validateRef(result.model.bindingRef, 'WMP Grounding model bindingRef', {
    expectedRole: 'model-binding', expectedFamily: 'world-model-model-binding'
  });
  assertSha256(result.model.modelPayloadSha256, 'WMP Grounding modelPayloadSha256');
  validateGroundingViews(result.views);
  sortedRefs(result.inputRefs, 'WMP Grounding inputRefs');
  validateGroundingSelection(result.selection);
  validateRef(result.renderedBlock, 'WMP Grounding renderedBlock', {
    expectedRole: 'rendered-grounding', expectedFamily: null, rendered: true
  });
  exact(result.completeness, ['status', 'gaps'], 'WMP Grounding completeness');
  if (!['complete', 'limited'].includes(result.completeness.status)) {
    fail('WMP Grounding completeness status is invalid.');
  }
  validateGaps(result.completeness.gaps, 'WMP Grounding gaps');
  if (result.completeness.status === 'complete'
      && result.completeness.gaps.some((gap) => gap.required)) {
    fail('Complete WMP Grounding cannot retain a required gap.');
  }
  validateGroundingBudget(result.budget);
  validateGroundingAuthority(result.authority);
  if (result.subject.repositoryDomainSha256 !== result.authority.repositoryDomainSha256) {
    fail('WMP Grounding subject and authority repository domains differ.');
  }
  assertSha256(result.groundingSha256, 'WMP Grounding groundingSha256');
  const core = structuredClone(result);
  delete core.groundingSha256;
  if (result.groundingSha256 !== sha256(core)) {
    fail('WMP Grounding self-hash does not verify.', 'WMP_INTEGRITY_FAILED');
  }
  return result;
}

export function createWmpGroundingReference(value) {
  return deepFreeze(validateWmpGroundingReference(sealRecord({
    schemaVersion: currentSchemaVersion('world-model-grounding-reference'),
    kind: 'world-model-grounding-reference',
    ...structuredClone(value)
  }, 'groundingSha256')));
}

function validateGitObjects(values, label) {
  if (!Array.isArray(values) || values.length > 100_000) {
    fail(`${label} exceeds its 100000-object limit.`, 'WMP_CONTRACT_LIMIT');
  }
  for (const [index, entry] of values.entries()) {
    exact(entry, ['oid', 'objectFormat', 'type', 'bytes', 'sha256'], `${label}[${index}]`);
    if (!['sha1', 'sha256'].includes(entry.objectFormat)) fail(`${label}[${index}] objectFormat is invalid.`);
    assertString(entry.oid, `${label}[${index}] oid`, { pattern: COMMIT_PATTERN });
    if (entry.oid.length !== (entry.objectFormat === 'sha1' ? 40 : 64)) {
      fail(`${label}[${index}] OID length disagrees with its object format.`);
    }
    if (!['commit', 'tree', 'blob', 'tag'].includes(entry.type)) fail(`${label}[${index}] type is invalid.`);
    assertInteger(entry.bytes, `${label}[${index}] bytes`, {
      minimum: 0, maximum: WMP_MAXIMUM_OBJECT_BYTES
    });
    assertSha256(entry.sha256, `${label}[${index}] sha256`);
  }
  if (new Set(values.map((entry) => entry.oid)).size !== values.length) fail(`${label} repeats an OID.`);
  assertCanonicalOrder(values, (entry) => entry.oid, label);
}

function validateReaderRequirements(values) {
  if (!Array.isArray(values) || values.length > 1024) {
    fail('WMP reader requirements must be a bounded array.', 'WMP_CONTRACT_LIMIT');
  }
  for (const [index, entry] of values.entries()) {
    exact(entry, ['family', 'minimumVersion', 'maximumVersion'],
      `WMP reader requirement ${index}`);
    boundedText(entry.family, `WMP reader requirement ${index} family`, {
      pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/, maximumBytes: 128
    });
    try { schemaFamily(entry.family); }
    catch { fail(`WMP reader requirement names unknown family '${entry.family}'.`); }
    assertInteger(entry.minimumVersion, `WMP reader requirement ${index} minimumVersion`, {
      minimum: 1
    });
    assertInteger(entry.maximumVersion, `WMP reader requirement ${index} maximumVersion`, {
      minimum: entry.minimumVersion
    });
  }
  if (new Set(values.map((entry) => entry.family)).size !== values.length) {
    fail('WMP reader requirements repeat a family.');
  }
  assertCanonicalOrder(values, (entry) => entry.family, 'WMP reader requirements');
}

function validateMissingItems(values) {
  if (!Array.isArray(values) || values.length > 10_000) {
    fail('WMP handoff missing items must be bounded.', 'WMP_CONTRACT_LIMIT');
  }
  for (const [index, entry] of values.entries()) {
    exact(entry, ['kind', 'id', 'required', 'reasonCode'], `WMP missing item ${index}`);
    boundedText(entry.kind, `WMP missing item ${index} kind`, {
      pattern: TYPE_ID, maximumBytes: 128
    });
    boundedText(entry.id, `WMP missing item ${index} id`, { maximumBytes: 512 });
    if (typeof entry.required !== 'boolean') fail(`WMP missing item ${index} required must be boolean.`);
    boundedText(entry.reasonCode, `WMP missing item ${index} reasonCode`, {
      pattern: REASON_CODE, maximumBytes: 128
    });
  }
  assertCanonicalOrder(values, (entry) => `${entry.kind}\0${entry.id}`, 'WMP missing items');
}

export function validateWmpHandoff(value) {
  const result = record(value, 'world-model-handoff');
  exact(result, [
    'schemaVersion', 'kind', 'repositoryDomainSha256', 'authorityCut',
    'sourceBindingSha256', 'modelBindings', 'viewBindings', 'inputObjects', 'sourceObjects',
    'missing', 'readerRequirements', 'confidentiality', 'adoption', 'handoffSha256'
  ], 'WMP Handoff');
  assertSha256(result.repositoryDomainSha256, 'WMP Handoff repositoryDomainSha256');
  exact(result.authorityCut, ['stateRef', 'commit', 'publicationRef'], 'WMP Handoff authorityCut');
  boundedText(result.authorityCut.stateRef, 'WMP Handoff stateRef', {
    pattern: SAFE_REF, maximumBytes: 512
  });
  assertString(result.authorityCut.commit, 'WMP Handoff authority commit', {
    pattern: COMMIT_PATTERN
  });
  validateRef(result.authorityCut.publicationRef, 'WMP Handoff publicationRef', {
    expectedRole: 'publication-receipt'
  });
  assertSha256(result.sourceBindingSha256, 'WMP Handoff sourceBindingSha256');
  sortedRefs(result.modelBindings, 'WMP Handoff modelBindings', { uniqueRoles: false });
  result.modelBindings.forEach((entry) => validateRef(entry, 'WMP Handoff model binding', {
    expectedRole: 'model-binding', expectedFamily: 'world-model-model-binding'
  }));
  sortedRefs(result.viewBindings, 'WMP Handoff viewBindings', { uniqueRoles: false });
  result.viewBindings.forEach((entry) => validateRef(entry, 'WMP Handoff view binding', {
    expectedRole: 'view-binding', expectedFamily: 'world-model-view-binding'
  }));
  sortedRefs(result.inputObjects, 'WMP Handoff inputObjects');
  validateGitObjects(result.sourceObjects, 'WMP Handoff sourceObjects');
  validateMissingItems(result.missing);
  validateReaderRequirements(result.readerRequirements);
  exact(result.confidentiality, ['classification', 'exportAllowed'], 'WMP Handoff confidentiality');
  if (!['repository-authorized', 'private-candidate'].includes(result.confidentiality.classification)) {
    fail('WMP Handoff confidentiality classification is invalid.');
  }
  if (typeof result.confidentiality.exportAllowed !== 'boolean') {
    fail('WMP Handoff confidentiality exportAllowed must be boolean.');
  }
  exact(result.adoption, [
    'required', 'targetRepositoryDomainSha256', 'authorizationRef'
  ], 'WMP Handoff adoption');
  if (typeof result.adoption.required !== 'boolean') fail('WMP Handoff adoption.required must be boolean.');
  if (result.adoption.required) {
    assertSha256(result.adoption.targetRepositoryDomainSha256,
      'WMP Handoff adoption targetRepositoryDomainSha256');
    validateRef(result.adoption.authorizationRef, 'WMP Handoff adoption authorizationRef', {
      expectedRole: 'adoption-authorization'
    });
  } else if (result.adoption.targetRepositoryDomainSha256 !== null
      || result.adoption.authorizationRef !== null) {
    fail('A WMP Handoff which needs no adoption cannot carry adoption authority.');
  }
  assertSha256(result.handoffSha256, 'WMP Handoff handoffSha256');
  const core = structuredClone(result);
  delete core.handoffSha256;
  if (result.handoffSha256 !== sha256(core)) {
    fail('WMP Handoff self-hash does not verify.', 'WMP_INTEGRITY_FAILED');
  }
  return result;
}

export function createWmpHandoff(value) {
  return deepFreeze(validateWmpHandoff(sealRecord({
    schemaVersion: currentSchemaVersion('world-model-handoff'),
    kind: 'world-model-handoff',
    ...structuredClone(value)
  }, 'handoffSha256')));
}

export function validateWmpSourceAdoption(value) {
  const result = record(value, 'world-model-source-adoption');
  exact(result, [
    'schemaVersion', 'kind', 'originRepositoryDomainSha256', 'targetRepositoryDomainSha256',
    'originAuthorityRef', 'targetAuthorityRef', 'sourceBindingSha256', 'sourceSnapshotRef',
    'sourceManifestSha256', 'scopeManifestSha256', 'objectClosureSha256', 'objects',
    'localBindingSha256', 'admissionProofRef', 'status', 'adoptionSha256'
  ], 'WMP Source Adoption');
  for (const field of [
    'originRepositoryDomainSha256', 'targetRepositoryDomainSha256', 'sourceBindingSha256',
    'sourceManifestSha256', 'scopeManifestSha256', 'objectClosureSha256', 'localBindingSha256'
  ]) assertSha256(result[field], `WMP Source Adoption ${field}`);
  validateRef(result.originAuthorityRef, 'WMP Source Adoption originAuthorityRef', {
    expectedRole: 'origin-authority'
  });
  validateRef(result.targetAuthorityRef, 'WMP Source Adoption targetAuthorityRef', {
    expectedRole: 'target-authority'
  });
  validateRef(result.sourceSnapshotRef, 'WMP Source Adoption sourceSnapshotRef', {
    expectedRole: 'source-snapshot', expectedFamily: 'world-model-source-snapshot'
  });
  validateGitObjects(result.objects, 'WMP Source Adoption objects');
  validateRef(result.admissionProofRef, 'WMP Source Adoption admissionProofRef', {
    expectedRole: 'admission-proof'
  });
  if (result.status !== 'verified') fail("WMP Source Adoption status must be 'verified'.");
  assertSha256(result.adoptionSha256, 'WMP Source Adoption adoptionSha256');
  const core = structuredClone(result);
  delete core.adoptionSha256;
  if (result.adoptionSha256 !== sha256(core)) {
    fail('WMP Source Adoption self-hash does not verify.', 'WMP_INTEGRITY_FAILED');
  }
  return result;
}

export function createWmpSourceAdoption(value) {
  return deepFreeze(validateWmpSourceAdoption(sealRecord({
    schemaVersion: currentSchemaVersion('world-model-source-adoption'),
    kind: 'world-model-source-adoption',
    ...structuredClone(value)
  }, 'adoptionSha256')));
}

const VALIDATORS = Object.freeze({
  'world-model-model-binding': validateWmpModelBinding,
  'world-model-view-inputs': validateWmpViewInputs,
  'world-model-view-binding': validateWmpViewBinding,
  'world-model-grounding-reference': validateWmpGroundingReference,
  'world-model-handoff': validateWmpHandoff,
  'world-model-source-adoption': validateWmpSourceAdoption
});

/**
 * Strict ingestion for WMP authority bytes.
 *
 * Parsing precedes equality only to obtain the JSON value; no value is returned or trusted until
 * the original bytes equal the one canonical encoding. Duplicate keys, alternate whitespace,
 * invalid UTF-8, a BOM, noncanonical ordering, and extra terminal data therefore all fail closed.
 */
export function parseCanonicalWmpRecordBytes(family, rawBytes, {
  maximumBytes = MAXIMUM_RECORD_BYTES
} = {}) {
  const validator = VALIDATORS[family];
  if (!validator) fail(`Unknown WMP record family '${family}'.`, 'WMP_READER_UNSUPPORTED');
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1
      || maximumBytes > MAXIMUM_RECORD_BYTES) {
    fail('WMP canonical reader maximumBytes is invalid.', 'WMP_CONTRACT_LIMIT');
  }
  if (!(Buffer.isBuffer(rawBytes) || rawBytes instanceof Uint8Array)) {
    fail('WMP authority input must be an exact byte buffer.', 'WMP_CANONICAL_BYTES_REQUIRED');
  }
  const bytes = Buffer.from(rawBytes);
  if (!bytes.length || bytes.length > maximumBytes) {
    fail(`WMP authority record must contain 1 through ${maximumBytes} bytes.`,
      'WMP_CONTRACT_LIMIT', { bytes: bytes.length, maximumBytes });
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (error) {
    fail('WMP authority record is not valid UTF-8.', 'WMP_CANONICAL_BYTES_REQUIRED', {
      cause: error.message
    });
  }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (error) {
    fail(`WMP authority record is not valid JSON: ${error.message}`,
      'WMP_CANONICAL_BYTES_REQUIRED');
  }
  const validated = validator(parsed);
  const canonical = Buffer.from(canonicalJson(validated), 'utf8');
  if (!canonical.equals(bytes)) {
    fail('WMP authority record is not the exact canonical JSON encoding.',
      'WMP_CANONICAL_BYTES_REQUIRED');
  }
  return deepFreeze(validated);
}

export const validateWorldModelModelBinding = validateWmpModelBinding;
export const createWorldModelModelBinding = createWmpModelBinding;
export const validateWorldModelViewInputs = validateWmpViewInputs;
export const createWorldModelViewInputs = createWmpViewInputs;
export const validateWorldModelViewBinding = validateWmpViewBinding;
export const createWorldModelViewBinding = createWmpViewBinding;
export const validateWorldModelGroundingReference = validateWmpGroundingReference;
export const createWorldModelGroundingReference = createWmpGroundingReference;
export const validateWorldModelHandoff = validateWmpHandoff;
export const createWorldModelHandoff = createWmpHandoff;
export const validateWorldModelSourceAdoption = validateWmpSourceAdoption;
export const createWorldModelSourceAdoption = createWmpSourceAdoption;
