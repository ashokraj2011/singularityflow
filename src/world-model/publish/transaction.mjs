import path from 'node:path';

import { publishToStateBranch } from '../../ledger.mjs';
import { readRecord } from '../../schema-migrations.mjs';
import { SingularityFlowError } from '../../util.mjs';
import { canonicalJson, isPlainRecord } from '../canonicalize.mjs';
import { assembleWmbV4PromptSync } from '../compose/pinned-core.mjs';
import { assertSelfHash } from '../contracts.mjs';
import { runDeterministicRegistration } from '../extract/index.mjs';
import { validateViewFactLedger } from '../extract/selection.mjs';
import { materializeWorldModelView } from '../materialize/view.mjs';
import { validateWorldModelMigrationReceipt } from '../migration/v3-to-v4.mjs';
import { parseWorldModelViewKernelStamp } from '../materialize/stamp.mjs';
import { createWorldModelViewOutputBudget } from '../plan.mjs';
import { resolveViewContract, validateViewRegistry } from '../registry/views.mjs';
import {
  validateWorldModelContextManifest, validateWorldModelUsageObservation
} from '../store.mjs';
import { validateCompositionCandidate } from '../validate/candidate.mjs';
import {
  deriveWorldModelManifestDependencies, readWorldModelV4Manifest, verifyWorldModelManifest
} from './manifest.mjs';

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
const MIGRATION_PATH_PATTERN = /^migrations\/[a-f0-9]{64}\.json$/;

function safeOutputDirectory(value) {
  const original = String(value ?? 'singularity/world-model').trim().replaceAll('\\', '/').replace(/\/$/, '');
  const normalized = path.posix.normalize(original);
  if (!original || original !== normalized || path.posix.isAbsolute(normalized)
      || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new SingularityFlowError('World-model publication output directory must stay inside the state branch.', {
      code: 'WMB_PUBLICATION_PATH_INVALID'
    });
  }
  return normalized;
}

function addFile(files, relative, contents) {
  if (Object.hasOwn(files, relative)) {
    throw new SingularityFlowError(`World-model publication repeats path '${relative}'.`, {
      code: 'WMB_PUBLICATION_PATH_COLLISION'
    });
  }
  files[relative] = contents;
}

function recordFile(files, outputDir, relative, record) {
  if (record != null) addFile(files, path.posix.join(outputDir, relative), canonicalJson(record));
}

function incomplete(message, details = null) {
  throw new SingularityFlowError(message, { code: 'WMB_PUBLICATION_PARTIAL', details });
}

function canonicalRecord(files, outputDir, relative) {
  const target = path.posix.join(outputDir, relative);
  if (!Object.hasOwn(files, target)) {
    incomplete(`World-model publication is missing required path '${target}'.`, { path: target });
  }
  const raw = files[target];
  if (typeof raw !== 'string') {
    incomplete(`World-model publication path '${target}' must contain canonical UTF-8 text.`, { path: target });
  }
  let record;
  try { record = JSON.parse(raw); }
  catch (error) {
    incomplete(`World-model publication path '${target}' is not valid JSON: ${error.message}`, { path: target });
  }
  if (!isPlainRecord(record) || canonicalJson(record) !== raw) {
    incomplete(`World-model publication path '${target}' is not a canonical JSON object.`, { path: target });
  }
  return record;
}

function sealedRecord(files, outputDir, relative, family, kind, hashField) {
  const record = readRecord(family, canonicalRecord(files, outputDir, relative)).record;
  if (record.kind !== kind) {
    incomplete(`World-model publication path '${path.posix.join(outputDir, relative)}' has unexpected kind '${record.kind ?? 'missing'}'.`, {
      path: path.posix.join(outputDir, relative), expectedKind: kind, receivedKind: record.kind ?? null
    });
  }
  assertSelfHash(record, hashField, `World-model publication ${kind}`);
  return record;
}

function exactProjectionPaths(manifest, viewRegistry, migrationPaths = []) {
  const expected = new Set([...REQUIRED_PROJECTION_FILES, ...migrationPaths]);
  for (const contract of viewRegistry.contracts.filter((entry) => entry.validity.status === 'active')) {
    expected.add(`catalogs/views/${contract.id}.facts.json`);
  }
  for (const view of manifest.views) {
    if (view.status === 'available') {
      expected.add(view.path);
      expected.add(`contexts/${view.viewId}.json`);
      expected.add(`candidates/${view.viewId}.json`);
      expected.add(`receipts/validation/${view.viewId}.json`);
      expected.add(`receipts/execution/${view.viewId}.json`);
      expected.add(`usage/${view.viewId}.json`);
    } else expected.add(`refusals/${view.viewId}.json`);
  }
  return expected;
}

function migrationProjectionPaths(files, outputDir) {
  const prefix = `${outputDir}/`;
  return Object.keys(files)
    .filter((target) => target.startsWith(prefix))
    .map((target) => target.slice(prefix.length))
    .filter((relative) => relative.startsWith('migrations/'))
    .map((relative) => {
      if (!MIGRATION_PATH_PATTERN.test(relative)) {
        incomplete(`World-model publication contains an invalid migration path '${relative}'.`, {
          path: path.posix.join(outputDir, relative)
        });
      }
      return relative;
    })
    .sort();
}

function assertExactProjectionPaths(files, outputDir, expected) {
  const prefix = `${outputDir}/`;
  const actual = new Set();
  for (const [target, contents] of Object.entries(files)) {
    if (path.posix.normalize(target) !== target || !target.startsWith(prefix)
        || typeof contents !== 'string') {
      incomplete(`World-model publication contains unsafe or non-text path '${target}'.`, { path: target });
    }
    actual.add(target.slice(prefix.length));
  }
  const missing = [...expected].filter((relative) => !actual.has(relative)).sort();
  const unexpected = [...actual].filter((relative) => !expected.has(relative)).sort();
  if (missing.length || unexpected.length) {
    incomplete('World-model publication file map is not the exact complete projection.', {
      missing, unexpected
    });
  }
}

function validateBuildRecords(files, outputDir, manifest, records) {
  const consumerProfile = sealedRecord(
    files, outputDir, 'profiles/consumer.json',
    'world-model-consumer-profile', 'world-model-consumer-profile', 'profileSha256'
  );
  const outputBudget = sealedRecord(
    files, outputDir, 'profiles/output-budget.json',
    'world-model-output-budget', 'world-model-output-budget', 'budgetSha256'
  );
  const request = sealedRecord(
    files, outputDir, 'requests/build-request.json',
    'world-model-build-request', 'world-model-build-request', 'requestSha256'
  );
  const plan = sealedRecord(
    files, outputDir, 'plans/build-plan.json',
    'world-model-build-plan', 'world-model-build-plan', 'planSha256'
  );
  const requested = manifest.views.map(({ viewId, required }) => ({ viewId, required }));
  if (request.source?.snapshotSha256 !== records.sourceSnapshot.sourceManifestSha256
      || request.scopeManifestSha256 !== records.scopeManifest.scopeSha256
      || request.policySnapshotSha256 !== manifest.policySnapshotSha256
      || request.viewRegistrySha256 !== records.viewRegistry.registrySha256
      || request.extractorRegistrySha256 !== records.extractorRegistry.registrySha256
      || request.composerProfileSha256 !== consumerProfile.profileSha256
      || request.outputBudgetSha256 !== outputBudget.budgetSha256
      || canonicalJson(request.requestedViews) !== canonicalJson(requested)
      || plan.requestSha256 !== request.requestSha256
      || plan.sourceManifestSha256 !== records.sourceSnapshot.sourceManifestSha256
      || plan.scopeManifestSha256 !== records.scopeManifest.scopeSha256) {
    incomplete('World-model publication build records do not bind the exact complete projection.');
  }
  return { consumerProfile, outputBudget, request, plan };
}

function materializationStamp(markdown, viewId) {
  const stamp = parseWorldModelViewKernelStamp(markdown);
  if (!stamp) {
    incomplete(`World-model publication view '${viewId}' has an invalid kernel stamp.`, {
      viewId
    });
  }
  return stamp;
}

/**
 * Re-run the semantic validator and kernel materializer from staged bytes.
 *
 * A self-hashed "passed" receipt is not proof that the current validator produced it. This check is
 * deliberately inside the state-writer boundary so a coherently rehashed candidate/receipt/view
 * envelope cannot publish prose that the registered facts and contract reject.
 */
function validateStagedAvailableView({
  files, outputDir, entry, markdown, candidate, validationReceipt, context,
  records, viewRegistry, build
}) {
  const contract = resolveViewContract(viewRegistry, `${entry.viewId}@${entry.viewVersion}`);
  const viewFactLedger = validateViewFactLedger(
    canonicalRecord(files, outputDir, `catalogs/views/${entry.viewId}.facts.json`),
    { factLedger: records.factLedger, viewContract: contract }
  );
  const viewBudget = createWorldModelViewOutputBudget(build.outputBudget, contract);
  const assembled = assembleWmbV4PromptSync({
    viewContract: contract,
    scopeManifest: records.scopeManifest,
    viewFactLedger,
    evidenceCatalog: records.evidenceCatalog,
    consumerProfile: build.consumerProfile,
    outputBudget: viewBudget
  });
  if (canonicalJson(assembled.contextManifest) !== canonicalJson(context)) {
    incomplete(`World-model publication Context Manifest '${entry.viewId}' does not reconstruct exactly.`, {
      viewId: entry.viewId
    });
  }
  const revalidated = validateCompositionCandidate(candidate, {
    contract,
    viewFactLedger,
    evidenceCatalog: records.evidenceCatalog,
    scopeManifest: records.scopeManifest,
    outputBudget: viewBudget
  });
  if (canonicalJson(revalidated.receipt) !== canonicalJson(validationReceipt)) {
    incomplete(`World-model publication candidate '${entry.viewId}' does not reproduce its validation receipt.`, {
      viewId: entry.viewId
    });
  }
  const stamp = materializationStamp(markdown, entry.viewId);
  const rebuilt = materializeWorldModelView({
    candidate: revalidated.candidate,
    contract,
    viewFactLedger,
    scopeManifest: records.scopeManifest,
    sourceSnapshot: records.sourceSnapshot,
    evidenceCatalog: records.evidenceCatalog,
    derivationCatalog: records.derivationCatalog,
    validationReceipt: revalidated.receipt,
    contextManifest: assembled.contextManifest,
    executionUnit: stamp.executionUnit,
    model: stamp.model === 'unavailable' ? null : stamp.model,
    generatedAt: stamp.generatedAt
  });
  if (rebuilt.markdown !== markdown) {
    incomplete(`World-model publication view '${entry.viewId}' does not materialize from its exact candidate and facts.`, {
      viewId: entry.viewId
    });
  }
}

/**
 * Reconstruct and validate the complete in-memory projection before any state-branch mutation.
 * The returned copy contains only verified immutable strings, closing the validation/publish TOCTOU.
 */
export function validateStagedWorldModelPublication(publication) {
  if (!isPlainRecord(publication) || !isPlainRecord(publication.files)) {
    incomplete('World-model publication must be a staged plain-object projection.');
  }
  const outputDir = safeOutputDirectory(publication.outputDir);
  const manifestPath = path.posix.join(outputDir, 'manifest.json');
  if (publication.manifestPath !== manifestPath
      || !Array.isArray(publication.replaceRoots)
      || canonicalJson(publication.replaceRoots) !== canonicalJson([outputDir])) {
    incomplete('World-model publication target, manifest path, or replacement root is not canonical.');
  }
  const files = Object.freeze(Object.fromEntries(Object.entries(publication.files)));
  const manifestRecord = canonicalRecord(files, outputDir, 'manifest.json');
  const manifest = readWorldModelV4Manifest(manifestRecord);
  if (canonicalJson(manifest) !== canonicalJson(publication.manifest)) {
    incomplete('World-model publication manifest object does not match its staged manifest bytes.');
  }

  const records = {
    sourceSnapshot: canonicalRecord(files, outputDir, 'source/source-snapshot.json'),
    scopeManifest: canonicalRecord(files, outputDir, 'scope/scope-manifest.json'),
    viewRegistry: canonicalRecord(files, outputDir, 'registries/views.json'),
    extractorRegistry: canonicalRecord(files, outputDir, 'registries/extractors.json'),
    evidenceCatalog: canonicalRecord(files, outputDir, 'catalogs/evidence.json'),
    derivationCatalog: canonicalRecord(files, outputDir, 'catalogs/derivations.json'),
    factLedger: canonicalRecord(files, outputDir, 'catalogs/facts.json')
  };
  const dependencies = deriveWorldModelManifestDependencies({
    ...records,
    policySnapshotSha256: manifest.policySnapshotSha256
  });
  const viewRegistry = validateViewRegistry(records.viewRegistry);
  const migrationPaths = migrationProjectionPaths(files, outputDir);
  const expectedPaths = exactProjectionPaths(manifest, viewRegistry, migrationPaths);
  assertExactProjectionPaths(files, outputDir, expectedPaths);
  const build = validateBuildRecords(files, outputDir, manifest, records);

  for (const contract of viewRegistry.contracts.filter((entry) => entry.validity.status === 'active')) {
    validateViewFactLedger(
      canonicalRecord(files, outputDir, `catalogs/views/${contract.id}.facts.json`),
      { factLedger: records.factLedger, viewContract: resolveViewContract(viewRegistry, `${contract.id}@${contract.version}`) }
    );
  }

  const views = manifest.views.map((entry) => {
    if (entry.status !== 'available') {
      const refusal = sealedRecord(
        files, outputDir, `refusals/${entry.viewId}.json`,
        'world-model-refusal', 'world-model-refusal', 'refusalSha256'
      );
      if (refusal.view !== entry.viewId
          || refusal.preserved?.evidenceCatalogSha256 !== records.evidenceCatalog.catalogSha256
          || refusal.preserved?.factLedgerSha256 !== records.factLedger.ledgerSha256) {
        incomplete(`World-model refusal for '${entry.viewId}' does not bind the exact preserved projection.`, {
          viewId: entry.viewId
        });
      }
      return structuredClone(entry);
    }
    const markdownPath = path.posix.join(outputDir, entry.path);
    const markdown = files[markdownPath];
    if (typeof markdown !== 'string' || !markdown.length) {
      incomplete(`World-model publication view '${entry.viewId}' is missing its Markdown bytes.`, {
        viewId: entry.viewId, path: markdownPath
      });
    }
    const candidate = canonicalRecord(files, outputDir, `candidates/${entry.viewId}.json`);
    const validationReceipt = canonicalRecord(
      files, outputDir, `receipts/validation/${entry.viewId}.json`
    );
    const execution = canonicalRecord(files, outputDir, `receipts/execution/${entry.viewId}.json`);
    const context = validateWorldModelContextManifest(canonicalRecord(
      files, outputDir, `contexts/${entry.viewId}.json`
    ));
    const usageObservation = validateWorldModelUsageObservation(canonicalRecord(
      files, outputDir, `usage/${entry.viewId}.json`
    ));
    if (context.viewId !== entry.viewId || context.manifestSha256 !== execution.contextManifestSha256
        || usageObservation.viewId !== entry.viewId
        || usageObservation.observationSha256 !== execution.usageObservationSha256
        || usageObservation.outputBytes !== Buffer.byteLength(markdown, 'utf8')) {
      incomplete(`World-model publication auxiliary records for '${entry.viewId}' do not bind its exact execution and bytes.`, {
        viewId: entry.viewId
      });
    }
    validateStagedAvailableView({
      files,
      outputDir,
      entry,
      markdown,
      candidate,
      validationReceipt,
      context,
      records,
      viewRegistry,
      build
    });
    return {
      ...structuredClone(entry), markdown, candidate, validationReceipt, execution, usageObservation
    };
  });
  for (const relative of migrationPaths) {
    const receipt = validateWorldModelMigrationReceipt(
      canonicalRecord(files, outputDir, relative),
      {
        sourceSnapshot: records.sourceSnapshot,
        scopeManifest: records.scopeManifest,
        evidenceCatalog: records.evidenceCatalog,
        factLedger: records.factLedger,
        availableViews: manifest.views
      }
    );
    const expectedPath = `migrations/${receipt.sourceViewSha256.replace(/^sha256:/, '')}.json`;
    if (relative !== expectedPath) {
      incomplete('World-model migration receipt does not bind the exact complete projection.', {
        path: relative, expectedPath, targetViewSha256: receipt.targetViewSha256
      });
    }
  }
  verifyWorldModelManifest(manifest, {
    dependencies,
    views,
    allowUnavailableOptionalViews: manifest.completeness.unavailableOptionalViews > 0
  });
  return Object.freeze({
    outputDir,
    manifestPath,
    manifest: Object.freeze(manifest),
    files,
    replaceRoots: Object.freeze([outputDir])
  });
}

/**
 * Reproduce the authoritative Fact graph from the target repository before its state branch can
 * accept staged bytes. Canonical/self hashes prove integrity, not that an approved extractor
 * actually observed those facts; the state-writer boundary therefore requires both.
 */
function validateStagedRegistrationAgainstSource(root, publication) {
  const { files, outputDir } = publication;
  const sourceSnapshot = canonicalRecord(files, outputDir, 'source/source-snapshot.json');
  const scopeManifest = canonicalRecord(files, outputDir, 'scope/scope-manifest.json');
  const viewRegistry = validateViewRegistry(canonicalRecord(
    files, outputDir, 'registries/views.json'
  ));
  const extractorRegistry = canonicalRecord(files, outputDir, 'registries/extractors.json');
  const buildPlan = canonicalRecord(files, outputDir, 'plans/build-plan.json');
  const activeContracts = viewRegistry.contracts.filter(
    (contract) => contract.validity.status === 'active'
  );
  const reproduced = runDeterministicRegistration({
    root,
    sourceSnapshot,
    scopeManifest,
    extractorRegistry,
    extractorReferences: buildPlan.extractors,
    requestedViews: activeContracts,
    viewRegistry
  });
  const comparisons = [
    ['Evidence Catalog', 'catalogs/evidence.json', reproduced.evidenceCatalog],
    ['Derivation Catalog', 'catalogs/derivations.json', reproduced.derivationCatalog],
    ['Fact Ledger', 'catalogs/facts.json', reproduced.factLedger],
    ...reproduced.viewFactLedgers.map((ledger) => [
      `View Fact Ledger '${ledger.viewId}'`,
      `catalogs/views/${ledger.viewId}.facts.json`,
      ledger
    ])
  ];
  for (const [label, relative, expected] of comparisons) {
    const received = canonicalRecord(files, outputDir, relative);
    if (canonicalJson(received) !== canonicalJson(expected)) {
      throw new SingularityFlowError(
        `World-model publication ${label} was not reproduced by its registered extractors from the pinned source.`,
        {
          code: 'WMB_PUBLICATION_FACTS_UNVERIFIED',
          details: { path: path.posix.join(outputDir, relative) }
        }
      );
    }
  }
}

/** Add one exact migration receipt to an already complete projection and revalidate the whole map. */
export function stageWorldModelMigrationPublication(publication, migrationReceipt) {
  const verified = validateStagedWorldModelPublication(publication);
  const receipt = readRecord('world-model-migration-receipt', migrationReceipt).record;
  assertSelfHash(receipt, 'receiptSha256', 'World-model migration receipt');
  const relative = `migrations/${receipt.sourceViewSha256.replace(/^sha256:/, '')}.json`;
  const files = { ...verified.files };
  addFile(files, path.posix.join(verified.outputDir, relative), canonicalJson(receipt));
  return validateStagedWorldModelPublication({
    ...verified,
    files: Object.freeze(files)
  });
}

/**
 * Produce one complete state-branch file map. The manifest is appended last for diagnostic clarity;
 * Git publishes the entire map in one commit, so readers can never observe a partial required set.
 */
export function stageWorldModelPublication({
  outputDir = 'singularity/world-model', manifest, dependencies, views,
  records = {}, allowUnavailableOptionalViews = false
} = {}) {
  const target = safeOutputDirectory(outputDir);
  const verified = verifyWorldModelManifest(manifest, {
    dependencies, views, allowUnavailableOptionalViews
  });
  const files = {};
  recordFile(files, target, 'source/source-snapshot.json', records.sourceSnapshot);
  recordFile(files, target, 'scope/scope-manifest.json', records.scopeManifest);
  recordFile(files, target, 'registries/views.json', records.viewRegistry);
  recordFile(files, target, 'registries/extractors.json', records.extractorRegistry);
  recordFile(files, target, 'catalogs/evidence.json', records.evidenceCatalog);
  recordFile(files, target, 'catalogs/derivations.json', records.derivationCatalog);
  recordFile(files, target, 'catalogs/facts.json', records.factLedger);
  recordFile(files, target, 'requests/build-request.json', records.buildRequest);
  recordFile(files, target, 'plans/build-plan.json', records.buildPlan);
  recordFile(files, target, 'profiles/consumer.json', records.consumerProfile);
  recordFile(files, target, 'profiles/output-budget.json', records.outputBudget);
  for (const ledger of records.viewFactLedgers ?? []) {
    recordFile(files, target, `catalogs/views/${ledger.viewId}.facts.json`, ledger);
  }
  for (const context of records.contextManifests ?? []) {
    recordFile(files, target, `contexts/${context.viewId}.json`, context);
  }
  for (const refusal of records.refusals ?? []) {
    recordFile(files, target, `refusals/${refusal.view ?? 'build'}.json`, refusal);
  }

  for (const view of verified.views) {
    if (view.status !== 'available') continue;
    addFile(files, path.posix.join(target, view.path), view.markdown);
    recordFile(files, target, `receipts/validation/${view.viewId}.json`, view.validationReceipt);
    recordFile(files, target, `candidates/${view.viewId}.json`, view.candidate);
    recordFile(files, target, `receipts/execution/${view.viewId}.json`, view.execution);
    recordFile(files, target, `usage/${view.viewId}.json`, view.usageObservation);
  }
  addFile(files, path.posix.join(target, 'manifest.json'), canonicalJson(verified.manifest));
  return validateStagedWorldModelPublication({
    outputDir: target,
    manifestPath: path.posix.join(target, 'manifest.json'),
    manifest: verified.manifest,
    files: Object.freeze(files),
    replaceRoots: Object.freeze([target])
  });
}

/** Publish the already verified transaction with the existing exact-CAS state-branch writer. */
export async function publishWorldModelTransaction(root, ledgerConfig, publication, {
  message = '[world-model][wmb-v4] publish registered views',
  publisher = publishToStateBranch,
  ...publicationOptions
} = {}) {
  const verified = validateStagedWorldModelPublication(publication);
  validateStagedRegistrationAgainstSource(root, verified);
  const result = await publisher(root, ledgerConfig, verified.files, message, {
    ...publicationOptions,
    replaceRoots: verified.replaceRoots
  });
  return Object.freeze({
    ...result,
    manifestSha256: verified.manifest.manifestSha256,
    manifestPath: verified.manifestPath
  });
}
