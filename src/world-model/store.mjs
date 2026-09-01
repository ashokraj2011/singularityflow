import path from 'node:path';

import { readRecord } from '../schema-migrations.mjs';
import { SingularityFlowError, run } from '../util.mjs';
import { canonicalJson, sha256 } from './canonicalize.mjs';
import { createConservativeWorldModelStalenessReceipt } from './cache.mjs';
import { assembleWmbV4PromptSync } from './compose/pinned-core.mjs';
import {
  VIEW_ID_PATTERN, assertExactKeys, assertInteger, assertPlainRecord, assertSchemaKind,
  assertSelfHash, assertSha256, assertString
} from './contracts.mjs';
import {
  deriveWorldModelManifestDependencies, readWorldModelV4Manifest, verifyWorldModelManifest
} from './publish/manifest.mjs';
import { classifyWorldModelInput, worldModelMigrationRequired } from './migration/v3-reader.mjs';
import { validateWorldModelMigrationReceipt } from './migration/v3-to-v4.mjs';
import { validateDerivationCatalog } from './extract/derivation-catalog.mjs';
import { validateEvidenceCatalog } from './extract/evidence-catalog.mjs';
import { validateFactLedger, validateViewFactLedger } from './extract/index.mjs';
import { assertInstalledExtractorRegistry } from './registry/extractors.mjs';
import { assertInstalledViewRegistry, resolveViewContract } from './registry/views.mjs';
import { createWorldModelViewOutputBudget } from './plan.mjs';
import { validateScopeManifest } from './scope/manifest.mjs';
import {
  createExactSourceSnapshot, validateSourceSnapshot, verifyExactSourceSnapshot
} from './source/snapshot.mjs';
import { materializeWorldModelView } from './materialize/view.mjs';
import { parseWorldModelViewKernelStamp } from './materialize/stamp.mjs';
import { validateCompositionCandidate } from './validate/candidate.mjs';

function conservativeStalenessReceipts(manifest, records, freshness) {
  if (freshness.fresh || !freshness.current) return Object.freeze([]);
  const change = freshness.changes?.[0] ?? {
    kind: 'source-change', previousSha256: freshness.built, currentSha256: freshness.current
  };
  const ledgers = new Map(
    records.viewFactLedgers.map((ledger) => [ledger.viewId, ledger])
  );
  return Object.freeze(manifest.views
    .filter((entry) => entry.status === 'available' && entry.viewSha256)
    .map((entry) => createConservativeWorldModelStalenessReceipt({
      previousViewSha256: entry.viewSha256,
      cause: {
        kind: change.kind,
        previousSha256: change.previousSha256,
        currentSha256: change.currentSha256
      },
      affectedFactIds: (ledgers.get(entry.viewId)?.facts ?? []).map((fact) => fact.id),
      viewId: entry.viewId
    })));
}

function reusableIdentityFromPublished(records, scopeManifest) {
  const request = records.buildRequest;
  const plan = records.buildPlan;
  const planViews = new Map(plan.views.map((entry) => [entry.viewId, entry]));
  const requestedViews = request.requestedViews.map((entry) => {
    const planned = planViews.get(entry.viewId);
    return {
      viewId: entry.viewId,
      viewVersion: planned?.viewVersion ?? null,
      viewSpecSha256: planned?.viewSpecSha256 ?? null,
      required: entry.required
    };
  }).sort((left, right) => left.viewId.localeCompare(right.viewId));
  return Object.freeze({
    scopeManifestSha256: scopeManifest.scopeSha256,
    policySnapshotSha256: request.policySnapshotSha256,
    requestedViews: Object.freeze(requestedViews),
    viewRegistrySha256: request.viewRegistrySha256,
    extractorRegistrySha256: request.extractorRegistrySha256,
    composerProfileSha256: request.composerProfileSha256,
    outputBudgetSha256: request.outputBudgetSha256
  });
}

const REUSABLE_IDENTITY_FIELDS = Object.freeze([
  ['scopeManifestSha256', 'scope-manifest-changed', 'scope-change'],
  ['policySnapshotSha256', 'policy-snapshot-changed', 'scope-change'],
  ['requestedViews', 'view-selection-changed', 'view-contract-change'],
  ['viewRegistrySha256', 'view-registry-changed', 'view-contract-change'],
  ['extractorRegistrySha256', 'extractor-registry-changed', 'fact-ledger-change'],
  ['composerProfileSha256', 'consumer-profile-changed', 'consumer-profile-change'],
  ['outputBudgetSha256', 'output-budget-changed', 'budget-change']
]);

function reusableIdentityChanges(built, current) {
  if (!current) return [];
  const changes = [];
  for (const [field, reason, kind] of REUSABLE_IDENTITY_FIELDS) {
    if (canonicalJson(built[field]) === canonicalJson(current[field])) continue;
    changes.push(Object.freeze({
      field,
      reason,
      kind,
      previousSha256: field === 'requestedViews' ? sha256(built[field]) : built[field],
      currentSha256: field === 'requestedViews' ? sha256(current[field]) : current[field]
    }));
  }
  return changes;
}

function safeOutputDirectory(value) {
  const normalized = String(value ?? 'singularity/world-model').trim().replaceAll('\\', '/').replace(/\/$/, '');
  if (!normalized || path.posix.normalize(normalized) !== normalized || path.posix.isAbsolute(normalized)
      || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new SingularityFlowError('World-model store path must stay inside its Git revision.', {
      code: 'WMB_PUBLICATION_PATH_INVALID'
    });
  }
  return normalized;
}

function safeRelative(value) {
  const normalized = String(value ?? '').replaceAll('\\', '/');
  if (!normalized || path.posix.normalize(normalized) !== normalized || path.posix.isAbsolute(normalized)
      || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new SingularityFlowError(`Unsafe World-model store path '${value}'.`, {
      code: 'WMB_PUBLICATION_PATH_INVALID'
    });
  }
  return normalized;
}

function commitAt(root, ref) {
  const result = run('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: root, allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

function readAt(root, ref, relative, { optional = false } = {}) {
  const safe = safeRelative(relative);
  const tree = run('git', ['ls-tree', ref, '--', safe], { cwd: root, allowFailure: true });
  const row = tree.status === 0 ? tree.stdout.trim() : '';
  if (!row) {
    if (optional) return null;
    throw new SingularityFlowError(`Published WMB v4 record is missing: ${safe}.`, {
      code: 'WMB_PUBLICATION_PARTIAL', details: { ref, path: safe }
    });
  }
  const mode = row.split(/\s+/)[0];
  const type = row.split(/\s+/)[1];
  if (!['100644', '100755'].includes(mode) || type !== 'blob') {
    throw new SingularityFlowError(`Published WMB v4 path is not a regular Git blob: ${safe}.`, {
      code: 'WMB_PUBLICATION_PARTIAL', details: { ref, path: safe, mode, type }
    });
  }
  const shown = run('git', ['show', `${ref}:${safe}`], { cwd: root, allowFailure: true });
  if (shown.status !== 0) {
    throw new SingularityFlowError(`Published WMB v4 record cannot be read: ${safe}.`, {
      code: 'WMB_PUBLICATION_PARTIAL', details: { ref, path: safe }
    });
  }
  return shown.stdout;
}

function jsonAt(root, ref, relative, options) {
  const text = readAt(root, ref, relative, options);
  if (text == null) return null;
  try { return JSON.parse(text); }
  catch (error) {
    throw new SingularityFlowError(`Published WMB v4 record is invalid JSON: ${relative}.`, {
      code: 'WMB_PUBLICATION_PARTIAL', cause: error, details: { ref, path: relative }
    });
  }
}

const REQUIRED_PROJECTION_FILES = Object.freeze([
  'manifest.json',
  'source/source-snapshot.json',
  'scope/scope-manifest.json',
  'registries/views.json',
  'registries/extractors.json',
  'catalogs/evidence.json',
  'catalogs/derivations.json',
  'catalogs/facts.json',
  'requests/build-request.json',
  'plans/build-plan.json',
  'profiles/consumer.json',
  'profiles/output-budget.json'
]);

function publishedTreeEntries(root, ref, outputDir) {
  const result = run('git', ['ls-tree', '-r', '-z', ref, '--', outputDir], {
    cwd: root, allowFailure: true
  });
  if (result.status !== 0) {
    recordFailure('Published WMB v4 projection tree cannot be enumerated.',
      'WMB_PUBLICATION_PARTIAL', { ref, outputDir });
  }
  return Object.freeze(result.stdout.split('\0').filter(Boolean).map((row) => {
    const tab = row.indexOf('\t');
    const metadata = tab < 0 ? [] : row.slice(0, tab).split(' ');
    const fullPath = tab < 0 ? '' : row.slice(tab + 1);
    const relative = fullPath.startsWith(`${outputDir}/`)
      ? fullPath.slice(outputDir.length + 1) : null;
    if (!relative || metadata.length !== 3) {
      recordFailure('Published WMB v4 projection contains an unparseable Git tree entry.',
        'WMB_PUBLICATION_UNEXPECTED_PATH', { ref, outputDir, row });
    }
    return Object.freeze({ mode: metadata[0], type: metadata[1], object: metadata[2], relative });
  }));
}

function exactProjectionAllowlist(root, ref, outputDir, manifest, viewRegistry) {
  const entries = publishedTreeEntries(root, ref, outputDir);
  const migrationPattern = /^migrations\/[a-f0-9]{64}\.json$/;
  const migrationPaths = entries.map((entry) => entry.relative).filter((relative) => (
    migrationPattern.test(relative)
  ));
  const expected = new Set([
    ...REQUIRED_PROJECTION_FILES,
    ...viewRegistry.contracts
      .filter((contract) => contract.validity.status === 'active')
      .map((contract) => `catalogs/views/${contract.id}.facts.json`),
    ...migrationPaths
  ]);
  for (const entry of manifest.views) {
    if (entry.status === 'available') {
      expected.add(entry.path);
      expected.add(`contexts/${entry.viewId}.json`);
      expected.add(`candidates/${entry.viewId}.json`);
      expected.add(`receipts/validation/${entry.viewId}.json`);
      expected.add(`receipts/execution/${entry.viewId}.json`);
      expected.add(`usage/${entry.viewId}.json`);
    } else expected.add(`refusals/${entry.viewId}.json`);
  }
  const actual = new Set(entries.map((entry) => entry.relative));
  const missing = [...expected].filter((relative) => !actual.has(relative)).sort();
  const unexpected = [...actual].filter((relative) => !expected.has(relative)).sort();
  if (missing.length) {
    recordFailure('Published WMB v4 projection is missing allowlisted files.',
      'WMB_PUBLICATION_PARTIAL', {
        ref, outputDir, path: path.posix.join(outputDir, missing[0]), missing
      });
  }
  if (unexpected.length) {
    recordFailure('Published WMB v4 projection contains files outside its exact allowlist.',
      'WMB_PUBLICATION_UNEXPECTED_PATH', { ref, outputDir, unexpected });
  }
  return Object.freeze({ entries, migrationPaths: Object.freeze(migrationPaths.sort()) });
}

function candidateRefs(root, { stateBranch, remote }) {
  return [
    `refs/remotes/${remote}/${stateBranch}`,
    `refs/heads/${stateBranch}`,
    'HEAD'
  ].filter((value, index, values) => values.indexOf(value) === index && commitAt(root, value));
}

function recordFailure(message, code, details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function nullableInteger(value, label) {
  if (value === null) return value;
  return assertInteger(value, label);
}

/** Validate the complete semantic shape and content identity of one persisted context manifest. */
export function validateWorldModelContextManifest(value) {
  const record = readRecord('world-model-context-manifest', value).record;
  assertPlainRecord(record, 'World-model Context Manifest');
  assertExactKeys(record, {
    required: ['schemaVersion', 'kind', 'viewId', 'regions', 'promptSha256', 'manifestSha256'],
    label: 'World-model Context Manifest'
  });
  assertSchemaKind(record, 'world-model-context-manifest', 'World-model Context Manifest');
  assertString(record.viewId, 'Context Manifest viewId', { pattern: VIEW_ID_PATTERN });
  if (!Array.isArray(record.regions) || !record.regions.length) {
    recordFailure('World-model Context Manifest requires at least one region.', 'WMB_CONTEXT_MANIFEST_INVALID');
  }
  const regionIds = new Set();
  const cacheClasses = new Set(['stable-prefix', 'stable-view', 'task', 'dynamic']);
  for (const region of record.regions) {
    assertExactKeys(region, {
      required: ['id', 'sha256', 'bytes', 'estimatedTokens', 'cacheClass'],
      label: 'World-model Context Manifest region'
    });
    assertString(region.id, 'Context Manifest region id', {
      pattern: /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
    });
    if (regionIds.has(region.id)) {
      recordFailure(
        `World-model Context Manifest repeats region '${region.id}'.`,
        'WMB_CONTEXT_MANIFEST_INVALID',
        { viewId: record.viewId, regionId: region.id }
      );
    }
    regionIds.add(region.id);
    assertSha256(region.sha256, `Context Manifest region '${region.id}' sha256`);
    assertInteger(region.bytes, `Context Manifest region '${region.id}' bytes`);
    assertInteger(region.estimatedTokens, `Context Manifest region '${region.id}' estimatedTokens`);
    if (region.estimatedTokens !== Math.ceil(region.bytes / 4)) {
      recordFailure(
        `World-model Context Manifest region '${region.id}' has an invalid token estimate.`,
        'WMB_CONTEXT_MANIFEST_INVALID',
        {
          viewId: record.viewId,
          regionId: region.id,
          expected: Math.ceil(region.bytes / 4),
          received: region.estimatedTokens
        }
      );
    }
    if (!cacheClasses.has(region.cacheClass)) {
      recordFailure(
        `World-model Context Manifest region '${region.id}' has unknown cache class '${region.cacheClass}'.`,
        'WMB_CONTEXT_MANIFEST_INVALID',
        { viewId: record.viewId, regionId: region.id }
      );
    }
  }
  assertSha256(record.promptSha256, 'Context Manifest promptSha256');
  assertSha256(record.manifestSha256, 'Context Manifest manifestSha256');
  assertSelfHash(record, 'manifestSha256', 'World-model Context Manifest');
  return Object.freeze(record);
}

/** Validate exact, non-conflated token and cost measures for one persisted usage observation. */
export function validateWorldModelUsageObservation(value) {
  const record = readRecord('world-model-usage-observation', value).record;
  assertPlainRecord(record, 'World-model Usage Observation');
  assertExactKeys(record, {
    required: [
      'schemaVersion', 'kind', 'viewId', 'promptBytes', 'estimatedInputTokens',
      'providerInputTokens', 'providerCachedTokens', 'outputBytes', 'estimatedOutputTokens',
      'providerOutputTokens', 'cost', 'assurance', 'observationSha256'
    ],
    label: 'World-model Usage Observation'
  });
  assertSchemaKind(record, 'world-model-usage-observation', 'World-model Usage Observation');
  assertString(record.viewId, 'Usage Observation viewId', { pattern: VIEW_ID_PATTERN });
  assertInteger(record.promptBytes, 'Usage Observation promptBytes');
  assertInteger(record.estimatedInputTokens, 'Usage Observation estimatedInputTokens');
  nullableInteger(record.providerInputTokens, 'Usage Observation providerInputTokens');
  nullableInteger(record.providerCachedTokens, 'Usage Observation providerCachedTokens');
  assertInteger(record.outputBytes, 'Usage Observation outputBytes');
  assertInteger(record.estimatedOutputTokens, 'Usage Observation estimatedOutputTokens');
  nullableInteger(record.providerOutputTokens, 'Usage Observation providerOutputTokens');
  if (record.estimatedInputTokens !== Math.ceil(record.promptBytes / 4)
      || record.estimatedOutputTokens !== Math.ceil(record.outputBytes / 4)) {
    recordFailure(
      'World-model Usage Observation estimated tokens do not match its exact byte counts.',
      'WMB_USAGE_OBSERVATION_INVALID',
      { viewId: record.viewId }
    );
  }
  if (record.providerCachedTokens !== null && record.providerInputTokens !== null
      && record.providerCachedTokens > record.providerInputTokens) {
    recordFailure(
      'World-model Usage Observation cached input tokens exceed provider input tokens.',
      'WMB_USAGE_OBSERVATION_INVALID',
      { viewId: record.viewId }
    );
  }
  assertExactKeys(record.cost, {
    required: ['currency', 'amount', 'assurance'],
    label: 'World-model Usage Observation cost'
  });
  if (record.cost.currency !== 'USD'
      || !['provider-reported', 'unavailable'].includes(record.cost.assurance)
      || (record.cost.amount !== null
        && (!Number.isFinite(record.cost.amount) || record.cost.amount < 0))) {
    recordFailure('World-model Usage Observation cost is invalid.', 'WMB_USAGE_OBSERVATION_INVALID', {
      viewId: record.viewId
    });
  }
  if ((record.cost.assurance === 'unavailable') !== (record.cost.amount === null)) {
    recordFailure(
      'World-model Usage Observation cost value and assurance disagree.',
      'WMB_USAGE_OBSERVATION_INVALID',
      { viewId: record.viewId }
    );
  }
  assertExactKeys(record.assurance, {
    required: ['promptBytes', 'estimatedTokens', 'providerTokens'],
    label: 'World-model Usage Observation assurance'
  });
  const providerObserved = record.providerInputTokens !== null || record.providerOutputTokens !== null;
  if (record.assurance.promptBytes !== 'exact' || record.assurance.estimatedTokens !== 'estimated'
      || !['provider-reported', 'unavailable'].includes(record.assurance.providerTokens)
      || (record.assurance.providerTokens === 'provider-reported') !== providerObserved) {
    recordFailure(
      'World-model Usage Observation token assurance disagrees with its measures.',
      'WMB_USAGE_OBSERVATION_INVALID',
      { viewId: record.viewId }
    );
  }
  assertSha256(record.observationSha256, 'Usage Observation observationSha256');
  assertSelfHash(record, 'observationSha256', 'World-model Usage Observation');
  return Object.freeze(record);
}

function loadProjectionRecords(root, ref, outputDir, viewEntries, viewRegistry, migrationPaths) {
  const required = (relative) => jsonAt(root, ref, path.posix.join(outputDir, relative));
  const available = viewEntries.filter((entry) => entry.status === 'available');
  const unavailable = viewEntries.filter((entry) => entry.status === 'unavailable');
  return {
    buildRequest: required('requests/build-request.json'),
    buildPlan: required('plans/build-plan.json'),
    consumerProfile: required('profiles/consumer.json'),
    outputBudget: required('profiles/output-budget.json'),
    viewFactLedgers: viewRegistry.contracts
      .filter((contract) => contract.validity.status === 'active')
      .map((contract) => required(`catalogs/views/${contract.id}.facts.json`)),
    contextManifests: available.map((entry) => required(`contexts/${entry.viewId}.json`)),
    refusals: unavailable.map((entry) => required(`refusals/${entry.viewId}.json`)),
    migrations: migrationPaths.map((relative) => ({ relative, record: required(relative) }))
  };
}

function validateSealedRecord(value, {
  family, kind, hashField, fields, label
}) {
  const record = readRecord(family, value).record;
  assertPlainRecord(record, label);
  assertExactKeys(record, { required: fields, label });
  assertSchemaKind(record, kind, label);
  assertSha256(record[hashField], `${label} ${hashField}`);
  assertSelfHash(record, hashField, label);
  return Object.freeze(record);
}

function validateBuildRecords(records, {
  manifest, sourceSnapshot, scopeManifest, viewRegistry, extractorRegistry
}) {
  const profile = validateSealedRecord(records.consumerProfile, {
    family: 'world-model-consumer-profile', kind: 'world-model-consumer-profile',
    hashField: 'profileSha256', label: 'World-model Consumer Profile',
    fields: ['schemaVersion', 'kind', 'consumer', 'depth', 'preferences', 'profileSha256']
  });
  const budget = validateSealedRecord(records.outputBudget, {
    family: 'world-model-output-budget', kind: 'world-model-output-budget',
    hashField: 'budgetSha256', label: 'World-model Output Budget',
    fields: ['schemaVersion', 'kind', 'viewBudgets', 'totalMaximumOutputTokens', 'overflowPolicy', 'budgetSha256']
  });
  const request = validateSealedRecord(records.buildRequest, {
    family: 'world-model-build-request', kind: 'world-model-build-request',
    hashField: 'requestSha256', label: 'World-model Build Request',
    fields: [
      'schemaVersion', 'kind', 'requestId', 'source', 'scopeManifestSha256',
      'requestedViews', 'policySnapshotSha256', 'viewRegistrySha256',
      'extractorRegistrySha256', 'composerProfileSha256', 'outputBudgetSha256',
      'consistency', 'cachePolicy', 'requestSha256'
    ]
  });
  const plan = validateSealedRecord(records.buildPlan, {
    family: 'world-model-build-plan', kind: 'world-model-build-plan',
    hashField: 'planSha256', label: 'World-model Build Plan',
    fields: [
      'schemaVersion', 'kind', 'requestSha256', 'sourceManifestSha256',
      'scopeManifestSha256', 'views', 'extractors', 'factRequirements', 'bodyAccess',
      'budgets', 'estimatedWork', 'planSha256'
    ]
  });
  if (request.source.snapshotSha256 !== sourceSnapshot.sourceManifestSha256
      || request.scopeManifestSha256 !== scopeManifest.scopeSha256
      || request.policySnapshotSha256 !== manifest.policySnapshotSha256
      || request.viewRegistrySha256 !== viewRegistry.registrySha256
      || request.extractorRegistrySha256 !== extractorRegistry.registrySha256
      || request.composerProfileSha256 !== profile.profileSha256
      || request.outputBudgetSha256 !== budget.budgetSha256
      || plan.requestSha256 !== request.requestSha256
      || plan.sourceManifestSha256 !== sourceSnapshot.sourceManifestSha256
      || plan.scopeManifestSha256 !== scopeManifest.scopeSha256) {
    recordFailure('Published WMB v4 build records do not bind the exact dependency graph.',
      'WMB_MANIFEST_DEPENDENCY_MISMATCH');
  }
  const requested = [...request.requestedViews]
    .sort((left, right) => left.viewId.localeCompare(right.viewId));
  const published = manifest.views.map(({ viewId, required }) => ({ viewId, required }));
  if (canonicalJson(requested) !== canonicalJson(published)) {
    recordFailure('Published WMB v4 manifest views do not match the exact Build Request.',
      'WMB_MANIFEST_BINDING_MISMATCH');
  }
  return Object.freeze({ request, plan, profile, budget });
}

function exactRecordMap(values, label) {
  const result = new Map();
  for (const value of values) {
    if (result.has(value.viewId)) {
      recordFailure(`Published ${label} repeats view '${value.viewId}'.`, 'WMB_PUBLICATION_PARTIAL', {
        viewId: value.viewId
      });
    }
    result.set(value.viewId, value);
  }
  return result;
}

function assertOptionalRecords(records, manifest, {
  views, viewRegistry, extractorRegistry, factLedger, scopeManifest, sourceSnapshot,
  evidenceCatalog, derivationCatalog
}) {
  const build = validateBuildRecords(records, {
    manifest, sourceSnapshot, scopeManifest, viewRegistry, extractorRegistry
  });
  const available = manifest.views.filter((entry) => entry.status === 'available');
  const unavailable = manifest.views.filter((entry) => entry.status === 'unavailable');
  const ledgers = exactRecordMap(records.viewFactLedgers, 'view Fact Ledger');
  const contexts = exactRecordMap(
    records.contextManifests.map(validateWorldModelContextManifest), 'Context Manifest'
  );
  const activeContracts = viewRegistry.contracts.filter((contract) => (
    contract.validity.status === 'active'
  ));
  if (ledgers.size !== activeContracts.length || contexts.size !== available.length) {
    recordFailure(
      'Published WMB v4 projection does not contain exactly one Fact Ledger per active registered view and one Context Manifest per available view.',
      'WMB_PUBLICATION_PARTIAL'
    );
  }
  for (const contract of activeContracts) {
    const ledger = ledgers.get(contract.id);
    if (!ledger) {
      recordFailure(`Published WMB v4 projection is missing the registered view Fact Ledger '${contract.id}'.`,
        'WMB_PUBLICATION_PARTIAL', { viewId: contract.id });
    }
    validateViewFactLedger(ledger, { factLedger, viewContract: contract });
  }
  const refusalViews = new Set();
  for (const value of records.refusals) {
    const refusal = readRecord('world-model-refusal', value).record;
    assertSelfHash(refusal, 'refusalSha256', 'World-model refusal');
    if (!unavailable.some((entry) => entry.viewId === refusal.view)
        || refusal.preserved.evidenceCatalogSha256 !== evidenceCatalog.catalogSha256
        || refusal.preserved.factLedgerSha256 !== factLedger.ledgerSha256
        || refusalViews.has(refusal.view)) {
      recordFailure('Published WMB v4 refusal does not bind exactly one unavailable manifest view.',
        'WMB_PUBLICATION_PARTIAL', { viewId: refusal.view ?? null });
    }
    refusalViews.add(refusal.view);
  }
  if (refusalViews.size !== unavailable.length) {
    recordFailure('Published WMB v4 projection is missing an unavailable-view refusal.',
      'WMB_PUBLICATION_PARTIAL');
  }
  for (const entry of available) {
    const view = views.find((candidate) => candidate.viewId === entry.viewId);
    const ledger = ledgers.get(entry.viewId);
    const context = contexts.get(entry.viewId);
    if (!view || !ledger || !context) {
      recordFailure(
        `Published WMB v4 projection is missing exact records for view '${entry.viewId}'.`,
        'WMB_PUBLICATION_PARTIAL',
        { viewId: entry.viewId }
      );
    }
    const contract = resolveViewContract(viewRegistry, `${entry.viewId}@${entry.viewVersion}`);
    validateViewFactLedger(ledger, { factLedger, viewContract: contract });
    if (ledger.ledgerSha256 !== view.execution.viewFactLedgerSha256
        || ledger.ledgerSha256 !== view.validationReceipt.factLedgerSha256) {
      recordFailure(
        `Published view Fact Ledger '${entry.viewId}' does not match its exact execution and validation receipt.`,
        'WMB_VIEW_EXECUTION_MISMATCH',
        { viewId: entry.viewId }
      );
    }
    if (context.manifestSha256 !== view.execution.contextManifestSha256) {
      recordFailure(
        `Published Context Manifest '${entry.viewId}' does not match its exact execution.`,
        'WMB_VIEW_EXECUTION_MISMATCH',
        { viewId: entry.viewId }
      );
    }
    if (view.execution.requestSha256 !== build.request.requestSha256) {
      recordFailure(`Published execution '${entry.viewId}' binds a different Build Request.`,
        'WMB_VIEW_EXECUTION_MISMATCH', { viewId: entry.viewId });
    }
    const viewBudget = createWorldModelViewOutputBudget(build.budget, contract);
    const assembled = assembleWmbV4PromptSync({
      viewContract: contract,
      scopeManifest,
      viewFactLedger: ledger,
      evidenceCatalog,
      consumerProfile: build.profile,
      outputBudget: viewBudget
    });
    if (canonicalJson(assembled.contextManifest) !== canonicalJson(context)) {
      recordFailure(`Published Context Manifest '${entry.viewId}' does not reconstruct exactly.`,
        'WMB_CONTEXT_MANIFEST_MISMATCH', { viewId: entry.viewId });
    }
    const revalidated = validateCompositionCandidate(view.candidate, {
      contract,
      viewFactLedger: ledger,
      evidenceCatalog,
      scopeManifest,
      outputBudget: viewBudget
    });
    if (canonicalJson(revalidated.receipt) !== canonicalJson(view.validationReceipt)) {
      recordFailure(`Published candidate '${entry.viewId}' does not reproduce its validation receipt.`,
        'WMB_VIEW_VALIDATION_MISMATCH', { viewId: entry.viewId });
    }
    const stamp = publishedViewStamp(view.markdown, entry.viewId);
    const rebuilt = materializeWorldModelView({
      candidate: revalidated.candidate,
      contract,
      viewFactLedger: ledger,
      scopeManifest,
      sourceSnapshot,
      evidenceCatalog,
      derivationCatalog,
      validationReceipt: revalidated.receipt,
      contextManifest: assembled.contextManifest,
      executionUnit: stamp.executionUnit,
      model: stamp.model === 'unavailable' ? null : stamp.model,
      generatedAt: stamp.generatedAt
    });
    if (rebuilt.markdown !== view.markdown) {
      recordFailure(`Published view '${entry.viewId}' does not materialize from its exact candidate and facts.`,
        'WMB_VIEW_DEPENDENCY_MISMATCH', { viewId: entry.viewId });
    }
  }
  for (const migration of records.migrations) {
    const receipt = validateWorldModelMigrationReceipt(migration.record, {
      sourceSnapshot,
      scopeManifest,
      evidenceCatalog,
      factLedger,
      availableViews: available
    });
    const expectedPath = `migrations/${receipt.sourceViewSha256.replace(/^sha256:/, '')}.json`;
    if (migration.relative !== expectedPath) {
      recordFailure('Published WMB v4 migration receipt does not bind the exact current projection.',
        'WMB_MIGRATION_RECEIPT_INVALID', {
          receiptSha256: receipt.receiptSha256, path: migration.relative, expectedPath
        });
    }
  }
}

function publishedViewStamp(markdown, viewId) {
  const stamp = parseWorldModelViewKernelStamp(markdown);
  if (!stamp) {
    recordFailure(`Published view '${viewId}' has an invalid kernel stamp.`,
      'WMB_VIEW_DEPENDENCY_MISMATCH', { viewId });
  }
  return stamp;
}

/** Read and independently verify one complete state/application WMB v4 projection. */
export function readPublishedWorldModelV4(root, {
  ref,
  outputDir = 'singularity/world-model',
  expectedReusableIdentity = null
} = {}) {
  const target = safeOutputDirectory(outputDir);
  const manifestPath = path.posix.join(target, 'manifest.json');
  const manifest = readWorldModelV4Manifest(readAt(root, ref, manifestPath));
  const sourceSnapshot = validateSourceSnapshot(jsonAt(root, ref, path.posix.join(target, 'source/source-snapshot.json')));
  const scopeManifest = validateScopeManifest(jsonAt(root, ref, path.posix.join(target, 'scope/scope-manifest.json')));
  const viewRegistry = assertInstalledViewRegistry(
    jsonAt(root, ref, path.posix.join(target, 'registries/views.json'))
  );
  const extractorRegistry = assertInstalledExtractorRegistry(
    jsonAt(root, ref, path.posix.join(target, 'registries/extractors.json'))
  );
  const evidenceCatalog = validateEvidenceCatalog(
    jsonAt(root, ref, path.posix.join(target, 'catalogs/evidence.json')),
    { sourceSnapshot, scopeManifest }
  );
  const derivationRaw = jsonAt(root, ref, path.posix.join(target, 'catalogs/derivations.json'));
  const factLedger = validateFactLedger(
    jsonAt(root, ref, path.posix.join(target, 'catalogs/facts.json')),
    {
      sourceSnapshot, scopeManifest, extractorRegistry, evidenceCatalog,
      derivationIds: new Set((derivationRaw?.derivations ?? []).map((entry) => entry.id))
    }
  );
  const derivationCatalog = validateDerivationCatalog(derivationRaw, {
    evidenceCatalog, factLedger, extractorRegistry
  });
  const dependencies = deriveWorldModelManifestDependencies({
    sourceSnapshot,
    scopeManifest,
    policySnapshotSha256: manifest.policySnapshotSha256,
    viewRegistry,
    extractorRegistry,
    evidenceCatalog,
    derivationCatalog,
    factLedger
  });
  const views = manifest.views.map((entry) => {
    if (entry.status === 'unavailable') return structuredClone(entry);
    return {
      ...structuredClone(entry),
      markdown: readAt(root, ref, path.posix.join(target, entry.path)),
      candidate: jsonAt(root, ref, path.posix.join(target, `candidates/${entry.viewId}.json`)),
      validationReceipt: jsonAt(root, ref, path.posix.join(target, `receipts/validation/${entry.viewId}.json`)),
      execution: jsonAt(root, ref, path.posix.join(target, `receipts/execution/${entry.viewId}.json`)),
      usageObservation: jsonAt(root, ref, path.posix.join(target, `usage/${entry.viewId}.json`))
    };
  });
  const verified = verifyWorldModelManifest(manifest, {
    dependencies,
    views,
    allowUnavailableOptionalViews: manifest.completeness.unavailableOptionalViews > 0
  });
  const allowlist = exactProjectionAllowlist(root, ref, target, manifest, viewRegistry);
  const records = loadProjectionRecords(
    root, ref, target, manifest.views, viewRegistry, allowlist.migrationPaths
  );
  assertOptionalRecords(records, manifest, {
    views: verified.views, viewRegistry, extractorRegistry, factLedger, scopeManifest,
    sourceSnapshot, evidenceCatalog, derivationCatalog
  });
  for (const view of verified.views.filter((entry) => entry.status === 'available')) {
    const observation = validateWorldModelUsageObservation(view.usageObservation);
    const publishedBytes = Buffer.byteLength(view.markdown, 'utf8');
    if (observation.viewId !== view.viewId
        || observation.observationSha256 !== view.execution.usageObservationSha256
        || observation.outputBytes !== publishedBytes) {
      recordFailure(
        `Published Usage Observation '${view.viewId}' does not match its exact execution and view bytes.`,
        'WMB_VIEW_EXECUTION_MISMATCH',
        { viewId: view.viewId, expectedOutputBytes: publishedBytes }
      );
    }
  }
  let sourceFreshness;
  try {
    const current = sourceSnapshot.authority
      ? verifyExactSourceSnapshot(root, sourceSnapshot, { scopeManifest })
      : createExactSourceSnapshot(root, {
          subjectId: sourceSnapshot.subject.id,
          scopeManifest
        });
    sourceFreshness = {
      fresh: current.sourceManifestSha256 === sourceSnapshot.sourceManifestSha256,
      built: sourceSnapshot.sourceManifestSha256,
      current: current.sourceManifestSha256,
      reason: current.sourceManifestSha256 === sourceSnapshot.sourceManifestSha256
        ? null : 'source-snapshot-changed'
    };
  } catch (error) {
    sourceFreshness = {
      fresh: false,
      built: sourceSnapshot.sourceManifestSha256,
      current: null,
      reason: error.code ?? 'source-snapshot-unavailable',
      detail: error.message
    };
  }
  const builtReusableIdentity = reusableIdentityFromPublished(records, scopeManifest);
  const identityChanges = reusableIdentityChanges(
    builtReusableIdentity, expectedReusableIdentity
  );
  const sourceChanges = sourceFreshness.fresh ? [] : [Object.freeze({
    field: 'sourceManifestSha256',
    reason: sourceFreshness.reason,
    kind: 'source-change',
    previousSha256: sourceFreshness.built,
    currentSha256: sourceFreshness.current
  })];
  const changes = Object.freeze([...sourceChanges, ...identityChanges]);
  const primary = changes[0] ?? null;
  const freshness = Object.freeze({
    fresh: changes.length === 0,
    built: primary?.previousSha256 ?? sourceSnapshot.sourceManifestSha256,
    current: primary?.currentSha256 ?? sourceSnapshot.sourceManifestSha256,
    reason: primary?.reason ?? null,
    ...(sourceFreshness.detail ? { detail: sourceFreshness.detail } : {}),
    source: Object.freeze(sourceFreshness),
    reusableIdentity: Object.freeze({
      built: builtReusableIdentity,
      current: expectedReusableIdentity ? structuredClone(expectedReusableIdentity) : null
    }),
    changes
  });
  const stalenessReceipts = conservativeStalenessReceipts(manifest, records, freshness);
  return Object.freeze({
    ref,
    commit: commitAt(root, ref),
    outputDir: target,
    manifest: verified.manifest,
    dependencies,
    views: verified.views,
    sourceSnapshot,
    scopeManifest,
    viewRegistry,
    extractorRegistry,
    evidenceCatalog,
    derivationCatalog,
    factLedger,
    records,
    freshness,
    stalenessReceipts
  });
}

/** Locate the current authority without silently falling through a legacy manifest. */
export function resolvePublishedWorldModelV4(root, {
  outputDir = 'singularity/world-model',
  stateBranch = 'state',
  remote = 'origin',
  required = true,
  expectedReusableIdentity = null
} = {}) {
  const target = safeOutputDirectory(outputDir);
  const manifestPath = path.posix.join(target, 'manifest.json');
  for (const ref of candidateRefs(root, { stateBranch, remote })) {
    const raw = readAt(root, ref, manifestPath, { optional: true });
    if (raw == null) continue;
    const classification = classifyWorldModelInput(raw);
    if (classification.classification !== 'registered-v4-manifest') {
      throw worldModelMigrationRequired(raw);
    }
    return readPublishedWorldModelV4(root, {
      ref, outputDir: target, expectedReusableIdentity
    });
  }
  if (!required) return null;
  throw new SingularityFlowError(
    `No registered WMB v4 manifest was found at ${manifestPath} on ${remote}/${stateBranch}, ${stateBranch}, or HEAD.`,
    {
      code: 'WMB_MANIFEST_MISSING',
      details: { outputDir: target, stateBranch, remote, nextAction: 'world-model build' }
    }
  );
}

export function worldModelV4StoreSummary(store) {
  return Object.freeze({
    format: 'wmb-v4',
    authorityRef: store.ref,
    authorityCommit: store.commit,
    manifestSha256: store.manifest.manifestSha256,
    sourceManifestSha256: store.sourceSnapshot.sourceManifestSha256,
    scopeManifestSha256: store.scopeManifest.scopeSha256,
    fresh: store.freshness.fresh,
    freshness: structuredClone(store.freshness),
    stalenessReceipts: structuredClone(store.stalenessReceipts ?? []),
    views: store.manifest.views.map((entry) => ({
      viewId: entry.viewId,
      viewVersion: entry.viewVersion,
      status: entry.status,
      required: entry.required,
      cache: entry.cache,
      viewSha256: entry.viewSha256
    })),
    facts: store.factLedger.facts.length,
    evidence: store.evidenceCatalog.items.length,
    derivations: store.derivationCatalog.derivations.length
  });
}

export function canonicalPublishedWorldModelV4(store) {
  return canonicalJson(worldModelV4StoreSummary(store));
}
