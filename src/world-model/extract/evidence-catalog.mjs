import { canonicalJson, collisionSafeIds, compareText, sealRecord, sha256 } from '../canonicalize.mjs';
import { currentSchemaVersion } from '../../schema-migrations.mjs';
import {
  EVIDENCE_ID_PATTERN, assertCanonicalOrder, assertExactKeys, assertInteger,
  assertNormalizedRepositoryPath, assertPlainRecord, assertSchemaKind, assertSelfHash,
  assertSha256, assertString, contractFailure
} from '../contracts.mjs';
import { classifyScopePath } from '../scope/matcher.mjs';
import { validateScopeManifest } from '../scope/manifest.mjs';
import { sourceFileMap, validateSourceSnapshot } from '../source/snapshot.mjs';
import { EVIDENCE_KINDS, assertVocabularyValue } from '../vocabularies.mjs';

const LOCATOR_KEYS = Object.freeze([
  'path', 'symbol', 'target', 'range'
]);

export function evidenceDescriptorFromItem(item) {
  return {
    kind: item.kind,
    locator: structuredClone(item.locator),
    subjectSha256: item.subjectSha256,
    sourceContentSha256: item.sourceContentSha256,
    scope: structuredClone(item.scope)
  };
}

export function validateEvidenceDescriptor(value, { sourceSnapshot = null, scopeManifest = null } = {}) {
  assertPlainRecord(value, 'Evidence descriptor');
  assertExactKeys(value, {
    required: ['kind', 'locator', 'subjectSha256', 'sourceContentSha256', 'scope'],
    label: 'Evidence descriptor'
  });
  assertVocabularyValue('Evidence kind', value.kind, EVIDENCE_KINDS);
  assertExactKeys(value.locator, { required: ['path'], optional: LOCATOR_KEYS.filter((key) => key !== 'path'), label: 'Evidence locator' });
  assertNormalizedRepositoryPath(value.locator.path, 'Evidence locator path');
  for (const field of ['symbol', 'target']) {
    if (Object.hasOwn(value.locator, field)) assertString(value.locator[field], `Evidence locator ${field}`);
  }
  if (Object.hasOwn(value.locator, 'range')) {
    assertExactKeys(value.locator.range, { required: ['startLine', 'endLine'], label: 'Evidence locator range' });
    assertInteger(value.locator.range.startLine, 'Evidence range startLine', { minimum: 1 });
    assertInteger(value.locator.range.endLine, 'Evidence range endLine', { minimum: value.locator.range.startLine });
  }
  assertSha256(value.subjectSha256, 'Evidence subjectSha256');
  assertSha256(value.sourceContentSha256, 'Evidence sourceContentSha256');
  assertExactKeys(value.scope, { required: ['status'], label: 'Evidence scope' });
  if (value.scope.status !== 'inside') contractFailure("Evidence scope status must be 'inside'.", 'WMB_EVIDENCE_OUT_OF_SCOPE');

  if (sourceSnapshot) {
    const sourceFile = sourceFileMap(sourceSnapshot).get(value.locator.path);
    if (!sourceFile) contractFailure(`Evidence path '${value.locator.path}' is not in the pinned Source Snapshot.`, 'WMB_EVIDENCE_SOURCE_MISMATCH');
    if (sourceFile.contentSha256 !== value.sourceContentSha256) {
      contractFailure(`Evidence for '${value.locator.path}' does not bind its pinned source content.`, 'WMB_EVIDENCE_SOURCE_MISMATCH');
    }
  }
  if (scopeManifest && classifyScopePath(value.locator.path, scopeManifest).status !== 'inside') {
    contractFailure(`Evidence path '${value.locator.path}' is outside the registered scope.`, 'WMB_EVIDENCE_OUT_OF_SCOPE');
  }
  return value;
}

export function evidenceSha256(value) {
  return sha256(validateEvidenceDescriptor(value));
}

export function createEvidenceCatalog({ sourceSnapshot, scopeManifest, descriptors = [] } = {}) {
  const source = validateSourceSnapshot(sourceSnapshot);
  const scope = validateScopeManifest(scopeManifest);
  if (!Array.isArray(descriptors)) contractFailure('Evidence descriptors must be an array.');
  const byDigest = new Map();
  for (const descriptorValue of descriptors) {
    const descriptor = structuredClone(validateEvidenceDescriptor(descriptorValue, { sourceSnapshot: source, scopeManifest: scope }));
    const digest = sha256(descriptor);
    const canonical = canonicalJson(descriptor);
    if (byDigest.has(digest) && byDigest.get(digest).canonical !== canonical) {
      contractFailure('Distinct Evidence descriptors produced the same full SHA-256 digest.', 'WMB_CONTENT_DIGEST_COLLISION');
    }
    byDigest.set(digest, { canonical, descriptor });
  }
  const ids = collisionSafeIds([...byDigest.keys()], { prefix: 'EV-' });
  const items = [...byDigest.entries()].map(([digest, { descriptor }]) => ({
    id: ids.get(digest.slice(7)),
    ...descriptor,
    evidenceSha256: digest
  })).sort((left, right) => compareText(left.id, right.id));
  return validateEvidenceCatalog(sealRecord({
    schemaVersion: currentSchemaVersion('world-model-evidence-catalog'),
    kind: 'world-model-evidence-catalog',
    sourceManifestSha256: source.sourceManifestSha256,
    scopeManifestSha256: scope.scopeSha256,
    items
  }, 'catalogSha256'), { sourceSnapshot: source, scopeManifest: scope });
}

export function validateEvidenceCatalog(value, { sourceSnapshot = null, scopeManifest = null } = {}) {
  assertPlainRecord(value, 'World-model Evidence Catalog');
  assertExactKeys(value, {
    required: ['schemaVersion', 'kind', 'sourceManifestSha256', 'scopeManifestSha256', 'items', 'catalogSha256'],
    label: 'World-model Evidence Catalog'
  });
  assertSchemaKind(value, 'world-model-evidence-catalog', 'World-model Evidence Catalog');
  assertSha256(value.sourceManifestSha256, 'Evidence Catalog sourceManifestSha256');
  assertSha256(value.scopeManifestSha256, 'Evidence Catalog scopeManifestSha256');
  if (sourceSnapshot && validateSourceSnapshot(sourceSnapshot).sourceManifestSha256 !== value.sourceManifestSha256) {
    contractFailure('Evidence Catalog source binding does not match the supplied Source Snapshot.', 'WMB_EVIDENCE_SOURCE_MISMATCH');
  }
  if (scopeManifest && validateScopeManifest(scopeManifest).scopeSha256 !== value.scopeManifestSha256) {
    contractFailure('Evidence Catalog scope binding does not match the supplied Scope Manifest.', 'WMB_EVIDENCE_OUT_OF_SCOPE');
  }
  if (!Array.isArray(value.items)) contractFailure('Evidence Catalog items must be an array.');
  const digests = [];
  const ids = new Set();
  for (const [index, item] of value.items.entries()) {
    assertExactKeys(item, {
      required: ['id', 'kind', 'locator', 'subjectSha256', 'sourceContentSha256', 'scope', 'evidenceSha256'],
      label: `Evidence Catalog item ${index}`
    });
    assertString(item.id, `Evidence Catalog item ${index} id`, { pattern: EVIDENCE_ID_PATTERN });
    if (ids.has(item.id)) contractFailure(`Evidence Catalog repeats id '${item.id}'.`);
    ids.add(item.id);
    const descriptor = evidenceDescriptorFromItem(item);
    validateEvidenceDescriptor(descriptor, { sourceSnapshot, scopeManifest });
    assertSha256(item.evidenceSha256, `Evidence Catalog item ${index} evidenceSha256`);
    const expected = sha256(descriptor);
    if (item.evidenceSha256 !== expected) contractFailure(`Evidence item '${item.id}' hash does not match its descriptor.`, 'WMB_RECORD_HASH_MISMATCH');
    digests.push(expected);
  }
  assertCanonicalOrder(value.items, (item) => item.id, 'Evidence Catalog items');
  if (new Set(digests).size !== digests.length) contractFailure('Evidence Catalog contains duplicate descriptors.');
  const allocated = collisionSafeIds(digests, { prefix: 'EV-' });
  for (const item of value.items) {
    const suffix = item.id.slice(3);
    const digest = item.evidenceSha256.slice(7);
    const minimumCollisionSafeLength = allocated.get(digest).length - 3;
    // A view-scoped catalog preserves IDs allocated by its parent catalog. Its subset may no
    // longer contain the sibling that forced extension, so longer valid digest prefixes remain
    // canonical while shorter ambiguous prefixes never do.
    if (!digest.startsWith(suffix) || suffix.length < minimumCollisionSafeLength) {
      contractFailure(`Evidence item '${item.id}' is not collision-safe for its descriptor.`, 'WMB_CONTENT_ID_INVALID');
    }
  }
  assertSha256(value.catalogSha256, 'Evidence Catalog catalogSha256');
  assertSelfHash(value, 'catalogSha256', 'World-model Evidence Catalog');
  return value;
}

export function evidenceIdForDescriptor(catalogValue, descriptorValue) {
  const catalog = validateEvidenceCatalog(catalogValue);
  const digest = sha256(validateEvidenceDescriptor(descriptorValue));
  const item = catalog.items.find((candidate) => candidate.evidenceSha256 === digest);
  if (!item || canonicalJson(evidenceDescriptorFromItem(item)) !== canonicalJson(descriptorValue)) {
    contractFailure('Evidence descriptor is not registered in the Evidence Catalog.', 'WMB_EVIDENCE_NOT_REGISTERED');
  }
  return item.id;
}

export function scopeEvidenceCatalog(catalogValue, evidenceIds) {
  const catalog = validateEvidenceCatalog(catalogValue);
  if (!Array.isArray(evidenceIds)) contractFailure('Evidence selection must be an array.');
  const selected = new Set(evidenceIds);
  for (const id of selected) {
    if (!catalog.items.some((item) => item.id === id)) contractFailure(`Evidence '${id}' is not registered.`, 'WMB_EVIDENCE_NOT_REGISTERED');
  }
  return validateEvidenceCatalog(sealRecord({
    schemaVersion: currentSchemaVersion('world-model-evidence-catalog'),
    kind: 'world-model-evidence-catalog',
    sourceManifestSha256: catalog.sourceManifestSha256,
    scopeManifestSha256: catalog.scopeManifestSha256,
    items: catalog.items.filter((item) => selected.has(item.id)).map((item) => structuredClone(item))
  }, 'catalogSha256'));
}
