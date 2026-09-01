import { currentSchemaVersion, readRecord } from '../../schema-migrations.mjs';
import { SingularityFlowError } from '../../util.mjs';
import {
  canonicalJson, isPlainRecord, sealRecord, sha256
} from '../canonicalize.mjs';
import {
  VIEW_ID_PATTERN, assertCanonicalOrder, assertExactKeys, assertInteger,
  assertPlainRecord, assertSha256, assertString
} from '../contracts.mjs';
import { validateDerivationCatalog } from '../extract/derivation-catalog.mjs';
import { validateEvidenceCatalog } from '../extract/evidence-catalog.mjs';
import { validateFactLedger } from '../extract/fact-ledger.mjs';
import { validateExtractorRegistry } from '../registry/extractors.mjs';
import { validateViewRegistry } from '../registry/views.mjs';
import { validateScopeManifest } from '../scope/manifest.mjs';
import { validateSourceSnapshot } from '../source/snapshot.mjs';
import {
  WMB_V4_CANDIDATE_SCHEMA_SHA256, WMB_V4_VALIDATION_CHECK_IDS,
  WMB_V4_VALIDATOR_SHA256
} from '../validate/candidate.mjs';

export const WORLD_MODEL_MANIFEST_FAMILY = 'world-model-manifest';
export const WORLD_MODEL_MANIFEST_KIND = 'world-model-manifest';
export const WORLD_MODEL_MANIFEST_FORMAT = 'wmb-v4';

const VALIDATION_RECEIPT_FAMILY = 'world-model-view-validation-receipt';
const EXECUTION_FAMILY = 'world-model-view-execution';
const AVAILABLE_EXECUTION_STATUSES = new Set(['completed', 'cached']);
const CACHE_STATUSES = new Set(['hit', 'miss']);

function fail(message, code = 'WMB_MANIFEST_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function withoutField(value, field) {
  const copy = structuredClone(value);
  delete copy[field];
  return copy;
}

function safeViewPath(value, viewId) {
  assertString(value, `View '${viewId}' path`);
  const normalized = String(value).replaceAll('\\', '/');
  if (normalized !== value || normalized.startsWith('/') || normalized.split('/').includes('..')
      || !normalized.startsWith('views/') || !normalized.endsWith('.md')) {
    fail(`View '${viewId}' path must be a normalized relative Markdown path below views/.`, 'WMB_VIEW_PATH_INVALID');
  }
  return normalized;
}

export function worldModelViewSha256(markdown) {
  return sha256({ utf8: String(markdown) });
}

function readCurrent(family, value, label) {
  try { return readRecord(family, value).record; }
  catch (error) {
    fail(`${label} is not a readable current record: ${error.message}`, 'WMB_MANIFEST_DEPENDENCY_INVALID', {
      family,
      cause: error.code ?? null
    });
  }
}

function assertSelfHash(value, field, label) {
  assertSha256(value?.[field], `${label} ${field}`);
  const expected = sha256(withoutField(value, field));
  if (value[field] !== expected) {
    fail(`${label} ${field} does not match its canonical content.`, 'WMB_RECORD_HASH_MISMATCH', {
      field, expected, received: value[field]
    });
  }
  return value;
}

function validationReceipt(value, view) {
  const receipt = readCurrent(VALIDATION_RECEIPT_FAMILY, value, `View '${view.viewId}' validation receipt`);
  if (receipt.kind !== 'world-model-view-validation-receipt' || receipt.status !== 'passed') {
    fail(`View '${view.viewId}' must bind a passed validation receipt.`, 'WMB_VIEW_VALIDATION_INVALID');
  }
  if (receipt.viewId !== view.viewId || receipt.viewVersion !== view.viewVersion) {
    fail(`View '${view.viewId}' validation receipt binds a different view.`, 'WMB_VIEW_VALIDATION_MISMATCH');
  }
  if (!Array.isArray(receipt.checks) || receipt.checks.some((check) => check?.status !== 'pass')) {
    fail(`View '${view.viewId}' validation receipt contains a non-passing check.`, 'WMB_VIEW_VALIDATION_INVALID');
  }
  const checkIds = receipt.checks.map((check) => check.id);
  if (JSON.stringify(checkIds) !== JSON.stringify(WMB_V4_VALIDATION_CHECK_IDS)
      || receipt.candidateSchemaSha256 !== WMB_V4_CANDIDATE_SCHEMA_SHA256
      || receipt.validatorSha256 !== WMB_V4_VALIDATOR_SHA256) {
    fail(`View '${view.viewId}' validation receipt was not produced by the complete current validator.`,
      'WMB_VIEW_VALIDATION_INVALID', { expectedChecks: WMB_V4_VALIDATION_CHECK_IDS, receivedChecks: checkIds });
  }
  return assertSelfHash(receipt, 'receiptSha256', `View '${view.viewId}' validation receipt`);
}

function compositionCandidate(value, view, receipt) {
  const candidate = readCurrent(
    'world-model-composition-candidate', value, `View '${view.viewId}' composition candidate`
  );
  if (candidate.kind !== 'world-model-composition-candidate'
      || candidate.view !== view.viewId || candidate.viewVersion !== view.viewVersion
      || sha256(candidate) !== receipt.candidateSha256) {
    fail(`View '${view.viewId}' composition candidate does not match its validation receipt.`,
      'WMB_VIEW_VALIDATION_MISMATCH');
  }
  return candidate;
}

function executionReceipt(value, view, receipt, viewSha256) {
  const execution = readCurrent(EXECUTION_FAMILY, value, `View '${view.viewId}' execution receipt`);
  if (execution.kind !== 'world-model-view-execution'
      || execution.viewId !== view.viewId || execution.viewVersion !== view.viewVersion
      || !AVAILABLE_EXECUTION_STATUSES.has(execution.status)) {
    fail(`View '${view.viewId}' execution receipt is not a completed execution of that exact view.`, 'WMB_VIEW_EXECUTION_INVALID');
  }
  if (execution.validationReceiptSha256 !== receipt.receiptSha256
      || execution.candidateSha256 !== receipt.candidateSha256
      || execution.publishedViewSha256 !== viewSha256
      || execution.viewFactLedgerSha256 !== receipt.factLedgerSha256) {
    fail(`View '${view.viewId}' execution receipt does not bind its exact view and validation receipt.`, 'WMB_VIEW_EXECUTION_MISMATCH');
  }
  return assertSelfHash(execution, 'executionSha256', `View '${view.viewId}' execution receipt`);
}

function exactHeaderBinding(markdown, field, digest, viewId) {
  const line = `${field}: ${digest}`;
  if (!String(markdown).split(/\r?\n/).includes(line)) {
    fail(`View '${viewId}' does not stamp exact ${field} '${digest}'.`, 'WMB_VIEW_DEPENDENCY_MISMATCH', {
      viewId, field, digest
    });
  }
}

function normalizeAvailableView(value, dependencies) {
  assertPlainRecord(value, 'World-model available view');
  const viewId = assertString(value.viewId, 'View id', { pattern: VIEW_ID_PATTERN });
  const viewVersion = assertInteger(value.viewVersion, `View '${viewId}' version`, { minimum: 1 });
  if (typeof value.required !== 'boolean') fail(`View '${viewId}' required must be boolean.`);
  const path = safeViewPath(value.path ?? `views/${viewId}.md`, viewId);
  const markdown = String(value.markdown ?? '');
  if (!markdown.length) fail(`View '${viewId}' has no materialized Markdown.`, 'WMB_VIEW_ARTIFACT_MISSING');
  const digest = worldModelViewSha256(markdown);
  if (value.viewSha256 != null && value.viewSha256 !== digest) {
    fail(`View '${viewId}' content hash does not match its Markdown.`, 'WMB_VIEW_HASH_MISMATCH', {
      expected: digest, received: value.viewSha256
    });
  }
  exactHeaderBinding(markdown, 'source-manifest-sha256', dependencies.sourceManifestSha256, viewId);
  exactHeaderBinding(markdown, 'scope-sha256', dependencies.scopeManifestSha256, viewId);
  const receipt = validationReceipt(value.validationReceipt, { viewId, viewVersion });
  const candidate = compositionCandidate(value.candidate, { viewId, viewVersion }, receipt);
  if (receipt.scopeSha256 !== dependencies.scopeManifestSha256) {
    fail(`View '${viewId}' validation receipt binds a different scope.`, 'WMB_VIEW_DEPENDENCY_MISMATCH');
  }
  exactHeaderBinding(markdown, 'fact-ledger-sha256', receipt.factLedgerSha256, viewId);
  const execution = executionReceipt(value.execution, { viewId, viewVersion }, receipt, digest);
  const cache = value.cache ?? (execution.status === 'cached' ? 'hit' : 'miss');
  if (!CACHE_STATUSES.has(cache)) fail(`View '${viewId}' cache status must be hit or miss.`);
  return Object.freeze({
    viewId, viewVersion, required: value.required, status: 'available', path, markdown,
    viewSha256: digest, validationReceipt: receipt, execution, cache,
    candidate,
    usageObservation: value.usageObservation ?? null
  });
}

function normalizeUnavailableView(value) {
  assertPlainRecord(value, 'World-model unavailable view');
  const viewId = assertString(value.viewId, 'View id', { pattern: VIEW_ID_PATTERN });
  const viewVersion = assertInteger(value.viewVersion, `View '${viewId}' version`, { minimum: 1 });
  if (typeof value.required !== 'boolean') fail(`View '${viewId}' required must be boolean.`);
  const cache = value.cache ?? 'miss';
  if (!CACHE_STATUSES.has(cache)) fail(`View '${viewId}' cache status must be hit or miss.`);
  return Object.freeze({
    viewId, viewVersion, required: value.required, status: 'unavailable', path: null,
    markdown: null, viewSha256: null, validationReceipt: null, execution: null, cache,
    usageObservation: null
  });
}

function normalizeView(value, dependencies) {
  const status = value?.status ?? 'available';
  if (status === 'available') return normalizeAvailableView(value, dependencies);
  if (status === 'unavailable') return normalizeUnavailableView(value);
  fail(`World-model view status '${status}' is not supported.`);
}

function assertDependencyDigests(value) {
  assertPlainRecord(value, 'World-model manifest dependencies');
  const required = [
    'sourceManifestSha256', 'scopeManifestSha256', 'policySnapshotSha256',
    'viewRegistrySha256', 'extractorRegistrySha256', 'evidenceCatalogSha256',
    'derivationCatalogSha256', 'factLedgerSha256'
  ];
  assertExactKeys(value, { required, label: 'World-model manifest dependencies' });
  for (const field of required) assertSha256(value[field], `Manifest dependency ${field}`);
  return Object.freeze(structuredClone(value));
}

/**
 * Validate the complete deterministic provenance graph and project its exact manifest digests.
 */
export function deriveWorldModelManifestDependencies({
  sourceSnapshot, scopeManifest, policySnapshotSha256, viewRegistry, extractorRegistry,
  evidenceCatalog, derivationCatalog, factLedger
} = {}) {
  const source = validateSourceSnapshot(sourceSnapshot);
  const scope = validateScopeManifest(scopeManifest);
  const views = validateViewRegistry(viewRegistry);
  const extractors = validateExtractorRegistry(extractorRegistry);
  const evidence = validateEvidenceCatalog(evidenceCatalog, { sourceSnapshot: source, scopeManifest: scope });
  const facts = validateFactLedger(factLedger, {
    sourceSnapshot: source, scopeManifest: scope, extractorRegistry: extractors,
    evidenceCatalog: evidence,
    derivationIds: new Set((derivationCatalog?.derivations ?? []).map((item) => item.id))
  });
  const derivations = validateDerivationCatalog(derivationCatalog, {
    evidenceCatalog: evidence, factLedger: facts, extractorRegistry: extractors
  });
  assertSha256(policySnapshotSha256, 'Policy snapshot SHA-256');
  return assertDependencyDigests({
    sourceManifestSha256: source.sourceManifestSha256,
    scopeManifestSha256: scope.scopeSha256,
    policySnapshotSha256,
    viewRegistrySha256: views.registrySha256,
    extractorRegistrySha256: extractors.registrySha256,
    evidenceCatalogSha256: evidence.catalogSha256,
    derivationCatalogSha256: derivations.catalogSha256,
    factLedgerSha256: facts.ledgerSha256
  });
}

function manifestViewProjection(view) {
  return {
    viewId: view.viewId,
    viewVersion: view.viewVersion,
    required: view.required,
    status: view.status,
    path: view.path,
    viewSha256: view.viewSha256,
    validationReceiptSha256: view.validationReceipt?.receiptSha256 ?? null,
    executionSha256: view.execution?.executionSha256 ?? null,
    cache: view.cache
  };
}

/** Build only a complete aggregate manifest; valid independent views may still be cached on refusal. */
export function buildWorldModelManifest({
  subject, dependencies: dependencyValue, views: viewValues,
  allowUnavailableOptionalViews = false
} = {}) {
  assertPlainRecord(subject, 'World-model manifest subject');
  assertExactKeys(subject, { required: ['kind', 'id'], label: 'World-model manifest subject' });
  if (subject.kind !== 'repository') fail("World-model manifest subject kind must be 'repository'.");
  assertString(subject.id, 'World-model manifest subject id');
  const dependencies = assertDependencyDigests(dependencyValue);
  if (!Array.isArray(viewValues) || !viewValues.length) fail('World-model manifest requires at least one requested view.');
  const views = viewValues.map((value) => normalizeView(value, dependencies))
    .sort((left, right) => `${left.viewId}@${left.viewVersion}`.localeCompare(`${right.viewId}@${right.viewVersion}`));
  const identities = views.map((view) => `${view.viewId}@${view.viewVersion}`);
  if (new Set(identities).size !== identities.length) fail('World-model manifest repeats an exact view identity.');
  const unavailableRequired = views.filter((view) => view.required && view.status !== 'available');
  if (unavailableRequired.length) {
    fail('A complete World-Model Manifest cannot be published while a required view is unavailable.',
      'WMB_REQUIRED_VIEW_UNAVAILABLE', { views: unavailableRequired.map((view) => view.viewId) });
  }
  const unavailableOptional = views.filter((view) => !view.required && view.status !== 'available');
  if (unavailableOptional.length && !allowUnavailableOptionalViews) {
    fail('Optional World-Model Views are unavailable but the request did not permit partial optional publication.',
      'WMB_OPTIONAL_VIEW_UNAVAILABLE', { views: unavailableOptional.map((view) => view.viewId) });
  }
  const required = views.filter((view) => view.required);
  const optional = views.filter((view) => !view.required);
  const manifest = sealRecord({
    schemaVersion: currentSchemaVersion(WORLD_MODEL_MANIFEST_FAMILY),
    kind: WORLD_MODEL_MANIFEST_KIND,
    format: WORLD_MODEL_MANIFEST_FORMAT,
    subject: structuredClone(subject),
    ...dependencies,
    views: views.map(manifestViewProjection),
    completeness: {
      requiredViews: required.length,
      availableRequiredViews: required.filter((view) => view.status === 'available').length,
      optionalViews: optional.length,
      unavailableOptionalViews: unavailableOptional.length
    }
  }, 'manifestSha256');
  return Object.freeze({ manifest: Object.freeze(manifest), dependencies, views: Object.freeze(views) });
}

function parsedObject(raw) {
  if (isPlainRecord(raw)) return structuredClone(raw);
  try {
    const parsed = JSON.parse(Buffer.isBuffer(raw) || raw instanceof Uint8Array
      ? Buffer.from(raw).toString('utf8') : String(raw));
    if (!isPlainRecord(parsed)) throw new Error('top-level JSON is not an object');
    return parsed;
  } catch (error) {
    fail(`World-model manifest is not valid object JSON: ${error.message}`);
  }
}

function migrationRequired(manifest) {
  const sourceSchemaVersion = manifest?.schema_version ?? manifest?.source_schema_version ?? null;
  const error = new SingularityFlowError(
    'Legacy World-Model output is not a registered v4 manifest. Run an explicit v3-to-v4 migration or rebuild it under WMB v4.',
    {
      code: 'WMB_MIGRATION_REQUIRED',
      details: { classification: 'legacy-unregistered-view', sourceFormat: 'wmb-v3', sourceSchemaVersion }
    }
  );
  error.classification = 'legacy-unregistered-view';
  return error;
}

/** Read a v4 manifest without ever normalizing v1-v3 manifests into it. */
export function readWorldModelV4Manifest(raw) {
  const parsed = parsedObject(raw);
  if (Object.hasOwn(parsed, 'schema_version') || Object.hasOwn(parsed, 'source_schema_version')) {
    throw migrationRequired(parsed);
  }
  let manifest;
  try { manifest = readRecord(WORLD_MODEL_MANIFEST_FAMILY, parsed).record; }
  catch (error) {
    fail(`World-model v4 manifest schema is unreadable: ${error.message}`, 'WMB_MANIFEST_INVALID', {
      cause: error.code ?? null
    });
  }
  if (manifest.kind !== WORLD_MODEL_MANIFEST_KIND || manifest.format !== WORLD_MODEL_MANIFEST_FORMAT) {
    fail('World-model manifest is not registered WMB v4.', 'WMB_MANIFEST_FORMAT_INVALID');
  }
  assertExactKeys(manifest, {
    required: [
      'schemaVersion', 'kind', 'format', 'subject', 'sourceManifestSha256',
      'scopeManifestSha256', 'policySnapshotSha256', 'viewRegistrySha256',
      'extractorRegistrySha256', 'evidenceCatalogSha256', 'derivationCatalogSha256',
      'factLedgerSha256', 'views', 'completeness', 'manifestSha256'
    ],
    label: 'World-model manifest'
  });
  assertExactKeys(manifest.subject, { required: ['kind', 'id'], label: 'World-model manifest subject' });
  if (manifest.subject.kind !== 'repository') fail("World-model manifest subject kind must be 'repository'.");
  assertString(manifest.subject.id, 'World-model manifest subject id');
  assertDependencyDigests(Object.fromEntries([
    'sourceManifestSha256', 'scopeManifestSha256', 'policySnapshotSha256',
    'viewRegistrySha256', 'extractorRegistrySha256', 'evidenceCatalogSha256',
    'derivationCatalogSha256', 'factLedgerSha256'
  ].map((field) => [field, manifest[field]])));
  if (!Array.isArray(manifest.views) || !manifest.views.length) fail('World-model manifest requires at least one view.');
  for (const entry of manifest.views) {
    assertExactKeys(entry, {
      required: [
        'viewId', 'viewVersion', 'required', 'status', 'path', 'viewSha256',
        'validationReceiptSha256', 'executionSha256', 'cache'
      ],
      label: 'World-model manifest view entry'
    });
    assertString(entry.viewId, 'World-model manifest view id', { pattern: VIEW_ID_PATTERN });
    assertInteger(entry.viewVersion, `World-model manifest view '${entry.viewId}' version`, { minimum: 1 });
    if (typeof entry.required !== 'boolean' || !['available', 'unavailable'].includes(entry.status)
        || !CACHE_STATUSES.has(entry.cache)) fail(`World-model manifest view '${entry.viewId}' has invalid status fields.`);
    if (entry.status === 'available') {
      safeViewPath(entry.path, entry.viewId);
      for (const field of ['viewSha256', 'validationReceiptSha256', 'executionSha256']) {
        assertSha256(entry[field], `World-model manifest view '${entry.viewId}' ${field}`);
      }
    } else if (entry.path !== null || entry.viewSha256 !== null
        || entry.validationReceiptSha256 !== null || entry.executionSha256 !== null) {
      fail(`Unavailable World-model view '${entry.viewId}' must not reference materialized artifacts.`);
    }
    if (entry.required && entry.status !== 'available') {
      fail('A complete World-Model Manifest contains an unavailable required view.', 'WMB_REQUIRED_VIEW_UNAVAILABLE', {
        views: [entry.viewId]
      });
    }
  }
  assertCanonicalOrder(manifest.views, (entry) => `${entry.viewId}@${entry.viewVersion}`, 'World-model manifest views');
  const identities = manifest.views.map((entry) => `${entry.viewId}@${entry.viewVersion}`);
  if (new Set(identities).size !== identities.length) fail('World-model manifest repeats an exact view identity.');
  assertExactKeys(manifest.completeness, {
    required: ['requiredViews', 'availableRequiredViews', 'optionalViews', 'unavailableOptionalViews'],
    label: 'World-model manifest completeness'
  });
  const required = manifest.views.filter((entry) => entry.required);
  const optional = manifest.views.filter((entry) => !entry.required);
  const expectedCompleteness = {
    requiredViews: required.length,
    availableRequiredViews: required.filter((entry) => entry.status === 'available').length,
    optionalViews: optional.length,
    unavailableOptionalViews: optional.filter((entry) => entry.status === 'unavailable').length
  };
  for (const [field, expected] of Object.entries(expectedCompleteness)) {
    assertInteger(manifest.completeness[field], `World-model manifest completeness ${field}`);
    if (manifest.completeness[field] !== expected) {
      fail(`World-model manifest completeness ${field} does not match its view entries.`,
        'WMB_MANIFEST_COMPLETENESS_INVALID', { field, expected, received: manifest.completeness[field] });
    }
  }
  assertSelfHash(manifest, 'manifestSha256', 'World-model manifest');
  return manifest;
}

export function verifyWorldModelManifest(manifestValue, {
  dependencies, views, allowUnavailableOptionalViews = false
} = {}) {
  const manifest = readWorldModelV4Manifest(manifestValue);
  const rebuilt = buildWorldModelManifest({
    subject: manifest.subject, dependencies, views, allowUnavailableOptionalViews
  });
  if (canonicalJson(manifest) !== canonicalJson(rebuilt.manifest)) {
    fail('World-model manifest does not match the exact supplied view objects and dependency graph.',
      'WMB_MANIFEST_BINDING_MISMATCH', {
        expectedManifestSha256: rebuilt.manifest.manifestSha256,
        receivedManifestSha256: manifest.manifestSha256
      });
  }
  return rebuilt;
}
