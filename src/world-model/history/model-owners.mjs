import { currentSchemaVersion, readRecord } from '../../schema-migrations.mjs';
import {
  assertCanonicalOrder, assertExactKeys, assertInteger, assertNormalizedRepositoryPath,
  assertPlainRecord, assertSchemaKind, assertSelfHash, assertSha256, assertString,
  assertStringArray, contractFailure
} from '../contracts.mjs';
import { compareText, deepFreeze, sealRecord } from '../canonicalize.mjs';

const REPOSITORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const TYPE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const EXTRACTOR_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/;
const EXTRACTOR_REFERENCE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*@[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/;
const REASON_CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const MAXIMUM_EXTRACTORS = 1024;
const MAXIMUM_FACT_TYPES = 10_000;
const MAXIMUM_PATHS = 50_000;

const PATH_STATUSES = new Set([
  'processed', 'partial', 'unsupported', 'failed', 'excluded'
]);
const EXTRACTOR_STATUSES = new Set([
  'processed', 'partial', 'unsupported', 'failed'
]);
const EXTRACTOR_COVERAGE = new Set(['path', 'global']);

function fail(message, code = 'WMP_OWNER_CONTRACT_INVALID', details = {}) {
  contractFailure(message, code, details);
}

function record(value, family, kind, label) {
  let migrated;
  try { migrated = readRecord(family, value).record; }
  catch (error) {
    fail(`${label} schema is unsupported: ${error.message}`, 'WMP_READER_UNSUPPORTED', {
      family, cause: error.code ?? null
    });
  }
  assertSchemaKind(migrated, kind, label);
  return migrated;
}

function boundedString(value, label, { pattern = null, maximumBytes = 256 } = {}) {
  assertString(value, label, { pattern });
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > maximumBytes) {
    fail(`${label} exceeds its ${maximumBytes}-byte limit.`, 'WMP_OWNER_CONTRACT_LIMIT', {
      label, bytes, maximumBytes
    });
  }
  return value;
}

function sortedUniqueStrings(values, label, {
  pattern = TYPE_ID, maximum = MAXIMUM_FACT_TYPES
} = {}) {
  if (!Array.isArray(values) || values.length > maximum) {
    fail(`${label} must contain at most ${maximum} entries.`, 'WMP_OWNER_CONTRACT_LIMIT');
  }
  assertStringArray(values, label, { sorted: true, pattern });
  return values;
}

function extractorKey(value) {
  return `${value.id}@${value.version}`;
}

function validateExtractorIdentity(value, label, {
  includeManifest = true, includeCoverage = false, extraKeys = []
} = {}) {
  assertPlainRecord(value, label);
  assertExactKeys(value, {
    required: [
      'id', 'version', 'implementationSha256', ...(includeManifest ? ['manifestSha256'] : []),
      ...(includeCoverage ? ['coverage'] : []), ...extraKeys
    ],
    label
  });
  boundedString(value.id, `${label} id`, { pattern: EXTRACTOR_ID, maximumBytes: 128 });
  boundedString(value.version, `${label} version`, { pattern: SEMVER, maximumBytes: 128 });
  assertSha256(value.implementationSha256, `${label} implementationSha256`);
  if (includeManifest) assertSha256(value.manifestSha256, `${label} manifestSha256`);
  if (includeCoverage && !EXTRACTOR_COVERAGE.has(value.coverage)) {
    fail(`${label} coverage must be 'path' or 'global'.`,
      'WMP_EXTRACTION_POLICY_COVERAGE_INVALID');
  }
  return value;
}

function validateExtractorRoster(values, label) {
  if (!Array.isArray(values) || !values.length || values.length > MAXIMUM_EXTRACTORS) {
    fail(`${label} must contain 1 through ${MAXIMUM_EXTRACTORS} entries.`,
      'WMP_OWNER_CONTRACT_LIMIT');
  }
  values.forEach((entry, index) => validateExtractorIdentity(entry, `${label}[${index}]`, {
    includeCoverage: true
  }));
  assertCanonicalOrder(values, extractorKey, label);
  const keys = values.map(extractorKey);
  if (new Set(keys).size !== keys.length) fail(`${label} repeats an extractor identity.`);
  return values;
}

function sortedCopy(values, keyOf) {
  return [...(values ?? [])].map((entry) => structuredClone(entry))
    .sort((left, right) => compareText(keyOf(left), keyOf(right)));
}

/**
 * Validate the portable repository identity retained by WMP.
 *
 * This record is a portable semantic identity, not authorization. Production callers must resolve
 * and compare it with approved or pinned repository authority at the action boundary. A checkout
 * basename, local path, remote URL, or opaque authority digest is deliberately not admitted here.
 */
export function validateWorldModelRepositoryDomain(value) {
  const result = record(
    value, 'world-model-repository-domain', 'world-model-repository-domain',
    'World-model Repository Domain'
  );
  assertExactKeys(result, {
    required: [
      'schemaVersion', 'kind', 'repositoryId', 'repositoryIdentitySha256',
      'repositoryDomainSha256'
    ],
    label: 'World-model Repository Domain'
  });
  boundedString(result.repositoryId, 'Repository Domain repositoryId', {
    pattern: REPOSITORY_ID, maximumBytes: 256
  });
  if (/^(?:[a-z][a-z0-9+.-]*:\/\/|git@)/i.test(result.repositoryId)
      || result.repositoryId.includes('/') || result.repositoryId.includes('\\')) {
    fail('Repository Domain repositoryId cannot be a path or remote URL.',
      'WMP_REPOSITORY_DOMAIN_NOT_PORTABLE');
  }
  assertSha256(result.repositoryIdentitySha256,
    'Repository Domain repositoryIdentitySha256');
  assertSha256(result.repositoryDomainSha256, 'Repository Domain repositoryDomainSha256');
  assertSelfHash(result, 'repositoryDomainSha256', 'World-model Repository Domain');
  return result;
}

export function createWorldModelRepositoryDomain({
  repositoryId, repositoryIdentitySha256
} = {}) {
  const base = {
    schemaVersion: currentSchemaVersion('world-model-repository-domain'),
    kind: 'world-model-repository-domain',
    repositoryId,
    repositoryIdentitySha256
  };
  return deepFreeze(validateWorldModelRepositoryDomain(
    sealRecord(base, 'repositoryDomainSha256')
  ));
}

function validateFactSemantics(value) {
  assertPlainRecord(value, 'Extraction Policy factSemantics');
  assertExactKeys(value, {
    required: [
      'allowedFactTypes', 'requiredFactTypes', 'optionalFactTypes',
      'requiredUnavailableSubjects', 'coverageExtractorRefs'
    ],
    label: 'Extraction Policy factSemantics'
  });
  for (const field of [
    'allowedFactTypes', 'requiredFactTypes', 'optionalFactTypes',
    'requiredUnavailableSubjects'
  ]) sortedUniqueStrings(value[field], `Extraction Policy factSemantics ${field}`);
  sortedUniqueStrings(
    value.coverageExtractorRefs,
    'Extraction Policy factSemantics coverageExtractorRefs',
    { pattern: EXTRACTOR_REFERENCE, maximum: MAXIMUM_EXTRACTORS }
  );
  const required = new Set(value.requiredFactTypes);
  const optional = new Set(value.optionalFactTypes);
  const allowed = new Set(value.allowedFactTypes);
  const overlap = value.requiredFactTypes.find((entry) => optional.has(entry));
  if (overlap) fail(`Extraction Policy repeats '${overlap}' as required and optional.`);
  const unallowed = [...required, ...optional].find((entry) => !allowed.has(entry));
  if (unallowed) {
    fail(`Extraction Policy requires fact type '${unallowed}' without allowing it.`,
      'WMP_EXTRACTION_POLICY_FACT_NOT_ALLOWED', { factType: unallowed });
  }
  return value;
}

/** An exact, model-free extraction authority record. */
export function validateWorldModelExtractionPolicy(value) {
  const result = record(
    value, 'world-model-extraction-policy', 'world-model-extraction-policy',
    'World-model Extraction Policy'
  );
  assertExactKeys(result, {
    required: [
      'schemaVersion', 'kind', 'policySnapshotSha256', 'allowedExtractors',
      'factSemantics', 'permissions', 'extractionPolicySha256'
    ],
    label: 'World-model Extraction Policy'
  });
  assertSha256(result.policySnapshotSha256, 'Extraction Policy policySnapshotSha256');
  validateExtractorRoster(result.allowedExtractors, 'Extraction Policy allowedExtractors');
  validateFactSemantics(result.factSemantics);
  const allowedReferences = new Set(result.allowedExtractors.map(extractorKey));
  const unknownCoverage = result.factSemantics.coverageExtractorRefs.find(
    (reference) => !allowedReferences.has(reference)
  );
  if (unknownCoverage) {
    fail(`Extraction Policy coverage extractor '${unknownCoverage}' is not allowed.`,
      'WMP_EXTRACTION_POLICY_EXTRACTOR_NOT_ALLOWED', { reference: unknownCoverage });
  }
  assertPlainRecord(result.permissions, 'Extraction Policy permissions');
  assertExactKeys(result.permissions, {
    required: ['source', 'externalInputs', 'network', 'model'],
    label: 'Extraction Policy permissions'
  });
  if (result.permissions.source !== 'exact-captured'
      || result.permissions.externalInputs !== 'captured-only'
      || result.permissions.network !== 'none'
      || result.permissions.model !== 'never') {
    fail('Extraction Policy permissions exceed the deterministic WMP extraction boundary.',
      'WMP_EXTRACTION_POLICY_EFFECT_FORBIDDEN');
  }
  assertSha256(result.extractionPolicySha256,
    'Extraction Policy extractionPolicySha256');
  assertSelfHash(result, 'extractionPolicySha256', 'World-model Extraction Policy');
  return result;
}

export function createWorldModelExtractionPolicy({
  policySnapshotSha256, allowedExtractors, factSemantics,
  permissions = {
    source: 'exact-captured', externalInputs: 'captured-only', network: 'none', model: 'never'
  }
} = {}) {
  const normalizedFacts = Object.fromEntries(Object.entries(factSemantics ?? {}).map(
    ([field, values]) => [field, [...(values ?? [])].sort(compareText)]
  ));
  const base = {
    schemaVersion: currentSchemaVersion('world-model-extraction-policy'),
    kind: 'world-model-extraction-policy',
    policySnapshotSha256,
    allowedExtractors: sortedCopy(allowedExtractors, extractorKey),
    factSemantics: normalizedFacts,
    permissions: structuredClone(permissions)
  };
  return deepFreeze(validateWorldModelExtractionPolicy(
    sealRecord(base, 'extractionPolicySha256')
  ));
}

function validateReason(value, label, { required }) {
  if (value === null) {
    if (required) fail(`${label} requires a reason code.`);
    return null;
  }
  if (!required) fail(`${label} cannot carry a reason code when fully processed.`);
  return boundedString(value, `${label} reasonCode`, {
    pattern: REASON_CODE, maximumBytes: 128
  });
}

function validatePathExtractor(value, label, roster) {
  validateExtractorIdentity(value, label, {
    includeManifest: false, extraKeys: ['status', 'reasonCode']
  });
  if (!EXTRACTOR_STATUSES.has(value.status)) fail(`${label} status is invalid.`);
  validateReason(value.reasonCode, label, { required: value.status !== 'processed' });
  const expected = roster.get(extractorKey(value));
  if (!expected || expected.implementationSha256 !== value.implementationSha256) {
    fail(`${label} does not match the retained extractor roster.`,
      'WMP_COMPLETENESS_EXTRACTOR_MISMATCH', { extractor: extractorKey(value) });
  }
  return value;
}

function validateGlobalOutcome(value, index, roster) {
  const label = `Completeness globalOutcomes[${index}]`;
  validateExtractorIdentity(value, label, {
    includeManifest: false, extraKeys: ['status', 'reasonCode']
  });
  if (!EXTRACTOR_STATUSES.has(value.status)) fail(`${label} status is invalid.`);
  validateReason(value.reasonCode, label, { required: value.status !== 'processed' });
  const expected = roster.get(extractorKey(value));
  if (!expected || expected.implementationSha256 !== value.implementationSha256) {
    fail(`${label} does not match the retained global extractor roster.`,
      'WMP_COMPLETENESS_EXTRACTOR_MISMATCH', { extractor: extractorKey(value) });
  }
  return value;
}

function validateRequiredSubjectOutcomes(values) {
  if (!Array.isArray(values) || values.length > MAXIMUM_FACT_TYPES) {
    fail(`Completeness Record requiredSubjects must contain at most ${MAXIMUM_FACT_TYPES} entries.`,
      'WMP_OWNER_CONTRACT_LIMIT');
  }
  for (const [index, value] of values.entries()) {
    const label = `Completeness requiredSubjects[${index}]`;
    assertPlainRecord(value, label);
    assertExactKeys(value, { required: ['id', 'status', 'reasonCode'], label });
    boundedString(value.id, `${label} id`, { pattern: TYPE_ID, maximumBytes: 256 });
    if (!['available', 'partial', 'unavailable', 'contradicted'].includes(value.status)) {
      fail(`${label} status is invalid.`);
    }
    validateReason(value.reasonCode, label, { required: value.status !== 'available' });
  }
  assertCanonicalOrder(values, (entry) => entry.id,
    'Completeness Record requiredSubjects');
  if (new Set(values.map((entry) => entry.id)).size !== values.length) {
    fail('Completeness Record repeats a required subject.');
  }
  return values;
}

function expectedPathStatus(extractors) {
  const statuses = new Set(extractors.map((entry) => entry.status));
  if (statuses.has('failed')) return 'failed';
  if (statuses.has('partial') || (statuses.has('processed') && statuses.has('unsupported'))) {
    return 'partial';
  }
  if (statuses.has('processed')) return 'processed';
  return 'unsupported';
}

function validatePathOutcome(value, index, roster) {
  const label = `Completeness pathOutcomes[${index}]`;
  assertPlainRecord(value, label);
  assertExactKeys(value, {
    required: [
      'path', 'sourceContentSha256', 'status', 'reasonCode', 'extractors'
    ],
    label
  });
  assertNormalizedRepositoryPath(value.path, `${label} path`);
  if (!PATH_STATUSES.has(value.status)) fail(`${label} status is invalid.`);
  const excluded = value.status === 'excluded';
  if (excluded) {
    if (value.sourceContentSha256 !== null || !Array.isArray(value.extractors)
        || value.extractors.length !== 0) {
      fail(`${label} excluded path cannot retain source bytes or extractor outcomes.`,
        'WMP_COMPLETENESS_PATH_INVALID');
    }
  } else {
    assertSha256(value.sourceContentSha256, `${label} sourceContentSha256`);
    if (!Array.isArray(value.extractors) || value.extractors.length !== roster.size) {
      fail(`${label} must account for every retained extractor exactly once.`,
        'WMP_COMPLETENESS_EXTRACTOR_MISMATCH', {
          expected: roster.size,
          received: Array.isArray(value.extractors) ? value.extractors.length : null
        });
    }
    value.extractors.forEach((entry, extractorIndex) => validatePathExtractor(
      entry, `${label} extractors[${extractorIndex}]`, roster
    ));
    assertCanonicalOrder(value.extractors, extractorKey, `${label} extractors`);
    const keys = value.extractors.map(extractorKey);
    if (new Set(keys).size !== keys.length || keys.some((key) => !roster.has(key))) {
      fail(`${label} repeats or introduces an extractor.`,
        'WMP_COMPLETENESS_EXTRACTOR_MISMATCH');
    }
    const expected = expectedPathStatus(value.extractors);
    if (value.status !== expected) {
      fail(`${label} aggregate status does not match its extractor outcomes.`,
        'WMP_COMPLETENESS_STATUS_MISMATCH', {
          path: value.path, expected, received: value.status
        });
    }
  }
  validateReason(value.reasonCode, label, { required: value.status !== 'processed' });
  return value;
}

function expectedCounts(paths) {
  const count = (statuses) => paths.filter((entry) => statuses.has(entry.status)).length;
  return {
    totalPaths: count(new Set(['processed', 'partial', 'unsupported', 'failed'])),
    // A partial parse is still a processed path. Its detailed path/extractor outcome preserves
    // the limitation while the aggregate stays compatible with the frozen v1 Model Binding.
    processedPaths: count(new Set(['processed', 'partial'])),
    unsupportedPaths: count(new Set(['unsupported'])),
    failedPaths: count(new Set(['failed'])),
    excludedPaths: count(new Set(['excluded']))
  };
}

/** Verify complete, canonical per-path extractor accounting for one exact source and scope. */
export function validateWorldModelCompletenessRecord(value) {
  const result = record(
    value, 'world-model-completeness-record', 'world-model-completeness-record',
    'World-model Completeness Record'
  );
  assertExactKeys(result, {
    required: [
      'schemaVersion', 'kind', 'sourceManifestSha256', 'scopeManifestSha256',
      'extractorRegistrySha256', 'extractorReferences', 'pathOutcomes',
      'globalOutcomes', 'requiredSubjects', 'counts', 'completenessSha256'
    ],
    label: 'World-model Completeness Record'
  });
  assertSha256(result.sourceManifestSha256,
    'Completeness Record sourceManifestSha256');
  assertSha256(result.scopeManifestSha256,
    'Completeness Record scopeManifestSha256');
  assertSha256(result.extractorRegistrySha256,
    'Completeness Record extractorRegistrySha256');
  validateExtractorRoster(result.extractorReferences,
    'Completeness Record extractorReferences');
  const pathReferences = result.extractorReferences.filter((entry) => entry.coverage === 'path');
  const globalReferences = result.extractorReferences.filter((entry) => entry.coverage === 'global');
  if (!pathReferences.length) {
    fail('Completeness Record requires at least one path-scoped extractor.',
      'WMP_COMPLETENESS_PATH_EXTRACTOR_REQUIRED');
  }
  if (!Array.isArray(result.pathOutcomes) || result.pathOutcomes.length > MAXIMUM_PATHS) {
    fail(`Completeness Record pathOutcomes must contain at most ${MAXIMUM_PATHS} entries.`,
      'WMP_OWNER_CONTRACT_LIMIT');
  }
  const pathRoster = new Map(pathReferences.map((entry) => [extractorKey(entry), entry]));
  const globalRoster = new Map(globalReferences.map((entry) => [extractorKey(entry), entry]));
  result.pathOutcomes.forEach((entry, index) => validatePathOutcome(entry, index, pathRoster));
  assertCanonicalOrder(result.pathOutcomes, (entry) => entry.path,
    'Completeness Record pathOutcomes');
  const paths = result.pathOutcomes.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) fail('Completeness Record repeats a path.');
  if (!Array.isArray(result.globalOutcomes)
      || result.globalOutcomes.length !== globalRoster.size) {
    fail('Completeness Record must account for every global extractor exactly once.',
      'WMP_COMPLETENESS_EXTRACTOR_MISMATCH', {
        expected: globalRoster.size,
        received: Array.isArray(result.globalOutcomes) ? result.globalOutcomes.length : null
      });
  }
  result.globalOutcomes.forEach((entry, index) => validateGlobalOutcome(
    entry, index, globalRoster
  ));
  assertCanonicalOrder(result.globalOutcomes, extractorKey,
    'Completeness Record globalOutcomes');
  const globalKeys = result.globalOutcomes.map(extractorKey);
  if (new Set(globalKeys).size !== globalKeys.length
      || globalKeys.some((key) => !globalRoster.has(key))) {
    fail('Completeness Record repeats or introduces a global extractor.',
      'WMP_COMPLETENESS_EXTRACTOR_MISMATCH');
  }
  validateRequiredSubjectOutcomes(result.requiredSubjects);
  assertPlainRecord(result.counts, 'Completeness Record counts');
  assertExactKeys(result.counts, {
    required: [
      'totalPaths', 'processedPaths', 'unsupportedPaths', 'failedPaths', 'excludedPaths'
    ],
    label: 'Completeness Record counts'
  });
  for (const field of Object.keys(result.counts)) {
    assertInteger(result.counts[field], `Completeness Record counts ${field}`, {
      minimum: 0, maximum: MAXIMUM_PATHS
    });
  }
  const expected = expectedCounts(result.pathOutcomes);
  for (const [field, count] of Object.entries(expected)) {
    if (result.counts[field] !== count) {
      fail(`Completeness Record count '${field}' does not match its path outcomes.`,
        'WMP_COMPLETENESS_COUNT_MISMATCH', {
          field, expected: count, received: result.counts[field]
        });
    }
  }
  assertSha256(result.completenessSha256,
    'Completeness Record completenessSha256');
  assertSelfHash(result, 'completenessSha256', 'World-model Completeness Record');
  return result;
}

export function createWorldModelCompletenessRecord({
  sourceManifestSha256, scopeManifestSha256, extractorRegistrySha256,
  extractorReferences, pathOutcomes, globalOutcomes = [], requiredSubjects = []
} = {}) {
  const normalizedPaths = sortedCopy(pathOutcomes, (entry) => entry.path).map((entry) => ({
    ...entry,
    extractors: sortedCopy(entry.extractors, extractorKey)
  }));
  const base = {
    schemaVersion: currentSchemaVersion('world-model-completeness-record'),
    kind: 'world-model-completeness-record',
    sourceManifestSha256,
    scopeManifestSha256,
    extractorRegistrySha256,
    extractorReferences: sortedCopy(extractorReferences, extractorKey),
    pathOutcomes: normalizedPaths,
    globalOutcomes: sortedCopy(globalOutcomes, extractorKey),
    requiredSubjects: sortedCopy(requiredSubjects, (entry) => entry.id),
    counts: expectedCounts(normalizedPaths)
  };
  return deepFreeze(validateWorldModelCompletenessRecord(
    sealRecord(base, 'completenessSha256')
  ));
}
