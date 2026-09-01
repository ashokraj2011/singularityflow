import {
  assertCanonicalOrder, assertExactKeys, assertInteger, assertNormalizedRepositoryPath,
  assertPlainRecord, assertSchemaKind, assertSelfHash, assertSha256, assertString,
  assertStringArray, contractFailure, normalizeRepositoryPath
} from '../contracts.mjs';
import { currentSchemaVersion } from '../../schema-migrations.mjs';
import { sealRecord, sha256 } from '../canonicalize.mjs';
import { SCOPE_SUBJECT_KINDS, assertVocabularyValue } from '../vocabularies.mjs';

export const DEFAULT_SCOPE_POLICY_SHA256 = sha256({
  id: 'sflow-world-model-scope-policy',
  version: 1,
  excludedPrecedence: true,
  pathNormalization: 'posix-relative',
  symlinkEscape: 'refuse'
});

export function normalizeScopePattern(value, label = 'Scope path') {
  assertString(value, label);
  const normalized = String(value).trim().replaceAll('\\', '/').replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/').replace(/\/$/, '');
  if (!normalized || normalized === '.' || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)
      || normalized.split('/').includes('..') || /[\0\r\n\[\]{}!]/.test(normalized)) {
    contractFailure(`${label} must be a safe repository-relative prefix or *, **, ? glob.`, 'WMB_SCOPE_MANIFEST_INVALID', { value });
  }
  return normalized;
}

function normalizedPatterns(values, label) {
  if (values == null) return [];
  if (!Array.isArray(values)) contractFailure(`${label} must be an array.`, 'WMB_SCOPE_MANIFEST_INVALID');
  return [...new Set(values.map((value, index) => normalizeScopePattern(value, `${label}[${index}]`)))].sort();
}

export function createScopeManifest({
  capabilityId,
  allowedPaths = [],
  sharedPaths = [],
  excludedPaths = [],
  allowedSubjects = SCOPE_SUBJECT_KINDS,
  maximumTraversalDepth = 8,
  policySourceSha256 = DEFAULT_SCOPE_POLICY_SHA256
} = {}) {
  assertString(capabilityId, 'Scope capabilityId');
  const subjects = [...new Set(allowedSubjects)].sort();
  subjects.forEach((value) => assertVocabularyValue('Scope allowed subject', value, SCOPE_SUBJECT_KINDS, 'WMB_SCOPE_MANIFEST_INVALID'));
  assertInteger(maximumTraversalDepth, 'Scope maximumTraversalDepth', { minimum: 0, maximum: 128 });
  assertSha256(policySourceSha256, 'Scope policySourceSha256');
  return validateScopeManifest(sealRecord({
    schemaVersion: currentSchemaVersion('world-model-scope-manifest'),
    kind: 'world-model-scope-manifest',
    capabilityId,
    allowedPaths: normalizedPatterns(allowedPaths, 'Scope allowedPaths'),
    sharedPaths: normalizedPatterns(sharedPaths, 'Scope sharedPaths'),
    excludedPaths: normalizedPatterns(excludedPaths, 'Scope excludedPaths'),
    allowedSubjects: subjects,
    maximumTraversalDepth,
    policySourceSha256
  }, 'scopeSha256'));
}

export function validateScopeManifest(value) {
  assertPlainRecord(value, 'World-model Scope Manifest');
  assertExactKeys(value, {
    required: [
      'schemaVersion', 'kind', 'capabilityId', 'allowedPaths', 'sharedPaths', 'excludedPaths',
      'allowedSubjects', 'maximumTraversalDepth', 'policySourceSha256', 'scopeSha256'
    ],
    label: 'World-model Scope Manifest'
  });
  assertSchemaKind(value, 'world-model-scope-manifest', 'World-model Scope Manifest');
  assertString(value.capabilityId, 'Scope capabilityId');
  for (const [field, values] of [
    ['allowedPaths', value.allowedPaths], ['sharedPaths', value.sharedPaths], ['excludedPaths', value.excludedPaths]
  ]) {
    assertStringArray(values, `Scope ${field}`, { sorted: true });
    values.forEach((entry) => {
      if (normalizeScopePattern(entry, `Scope ${field}`) !== entry) contractFailure(`Scope ${field} contains a non-canonical pattern.`, 'WMB_SCOPE_MANIFEST_INVALID');
    });
  }
  assertStringArray(value.allowedSubjects, 'Scope allowedSubjects', { sorted: true });
  value.allowedSubjects.forEach((entry) => assertVocabularyValue(
    'Scope allowed subject', entry, SCOPE_SUBJECT_KINDS, 'WMB_SCOPE_MANIFEST_INVALID'
  ));
  assertInteger(value.maximumTraversalDepth, 'Scope maximumTraversalDepth', { minimum: 0, maximum: 128 });
  assertSha256(value.policySourceSha256, 'Scope policySourceSha256');
  assertSha256(value.scopeSha256, 'Scope scopeSha256');
  assertSelfHash(value, 'scopeSha256', 'World-model Scope Manifest');
  return value;
}

export function scopeManifestSummary(value) {
  const scope = validateScopeManifest(value);
  return Object.freeze({
    capabilityId: scope.capabilityId,
    allowedPaths: [...scope.allowedPaths],
    sharedPaths: [...scope.sharedPaths],
    excludedPaths: [...scope.excludedPaths],
    allowedSubjects: [...scope.allowedSubjects],
    maximumTraversalDepth: scope.maximumTraversalDepth,
    scopeSha256: scope.scopeSha256
  });
}
