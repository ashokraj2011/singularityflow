import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { publishToStateBranch } from '../../ledger.mjs';
import { loadDefinition } from '../../config.mjs';
import { readRecord } from '../../schema-migrations.mjs';
import { secureRepositoryPath, SingularityFlowError } from '../../util.mjs';
import { canonicalJson, isPlainRecord, sha256 } from '../canonicalize.mjs';
import { assembleWmbV4PromptSync } from '../compose/pinned-core.mjs';
import { assertSelfHash } from '../contracts.mjs';
import { runDeterministicRegistration } from '../extract/index.mjs';
import { validateViewFactLedger } from '../extract/selection.mjs';
import { materializeWorldModelView } from '../materialize/view.mjs';
import {
  augmentRegistrationForMigrationReceipt, validateWorldModelMigrationReceipt
} from '../migration/v3-to-v4.mjs';
import { validateStagedWorldModelHistory } from '../history/publication.mjs';
import { parseWorldModelViewKernelStamp } from '../materialize/stamp.mjs';
import { createWorldModelViewOutputBudget } from '../plan.mjs';
import { assertInstalledExtractorRegistry } from '../registry/extractors.mjs';
import {
  assertInstalledViewRegistry, resolveViewContract
} from '../registry/views.mjs';
import { validateProjectionRegistry } from '../registry/projections.mjs';
import {
  buildCalmProjection, enforceProjectionBudgets, validateCalmProjectionCandidate
} from '../projections/calm/projection.mjs';
import { validateCalmWithOfficialToolchain } from '../projections/calm/validator.mjs';
import {
  assertArchitectureProjectionAuthoritySnapshots, resolveCurrentArchitectureProjectionInputs
} from '../projections/calm/authority.mjs';
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
// Publication recovery stores the complete canonical staged map in a 128 MiB immutable sidecar.
// Keep a deliberate 32 MiB envelope margin for the recovery identity, authority and JSON framing.
const MAXIMUM_RECOVERABLE_STAGED_PUBLICATION_BYTES = 96 * 1024 * 1024;
// Recovery v1 predated the staged-publication sub-limit. Its complete sealed sidecar was already
// bounded to 128 MiB, so a stored v1 marker inside that old envelope must remain readable even
// when its projection is larger than the limit applied to newly created markers.
const MAXIMUM_LEGACY_V1_STAGED_PUBLICATION_BYTES = 128 * 1024 * 1024;

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

function validateStagedHistory(publication, outputDir) {
  const fields = [
    'historyDir', 'historyAdditions', 'historyExpectations', 'exactBlobSha256'
  ];
  const supplied = fields.filter((field) => Object.hasOwn(publication, field));
  if (!supplied.length) return null;
  if (supplied.length !== fields.length) {
    incomplete('World-model history publication must supply its complete staged envelope.', {
      required: fields, supplied
    });
  }
  return validateStagedWorldModelHistory({
    outputDir,
    historyDir: publication.historyDir,
    historyAdditions: publication.historyAdditions,
    historyExpectations: publication.historyExpectations,
    exactBlobSha256: publication.exactBlobSha256
  });
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

function changedArchitectureElement(expected, received) {
  for (const [kind, expectedValues, receivedValues, id] of [
    ['node', expected.nodes ?? [], received.nodes ?? [], (value) => value?.['unique-id']],
    ['relationship', expected.relationships ?? [], received.relationships ?? [], (value) => value?.['unique-id']],
    ['control', Object.entries(expected.controls ?? {}), Object.entries(received.controls ?? {}), (value) => value?.[0]]
  ]) {
    const left = new Map(expectedValues.map((value) => [id(value), value]));
    const right = new Map(receivedValues.map((value) => [id(value), value]));
    for (const key of [...new Set([...left.keys(), ...right.keys()])].sort()) {
      if (canonicalJson(left.get(key) ?? null) !== canonicalJson(right.get(key) ?? null)) {
        return { elementKind: kind, elementId: key };
      }
    }
  }
  return { elementKind: 'projection', elementId: 'arch.calm' };
}

function generatedProjectionEdit(expected, received, sourceMap) {
  const changed = changedArchitectureElement(expected, received);
  const source = sourceMap.elements.find((entry) => entry.elementKind === changed.elementKind
    && entry.elementId === changed.elementId);
  throw new SingularityFlowError(
    `CALM projection refused — arch.calm.json is generated evidence. Element changed: ${changed.elementId}. `
      + 'Change the authoritative capability, policy, contract, or implementation source and rebuild; nothing was published.',
    {
      code: 'WMC_GENERATED_OUTPUT_EDIT',
      details: {
        ...changed,
        sources: source?.sources ?? [],
        nextAction: changed.elementId === 'arch.calm'
          ? 'singularity-flow wm build --projections arch.calm'
          : `singularity-flow architecture explain ${changed.elementId}`,
        published: false
      }
    }
  );
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
  if (manifest.projections?.length) {
    expected.add('registries/projections.json');
    if (manifest.projections.some((entry) => entry.status === 'available')) {
      expected.add('inputs/capability-snapshot.json');
      expected.add('inputs/configuration-snapshot.json');
      expected.add('toolchains/calm.json');
    }
    for (const projection of manifest.projections) {
      if (projection.status === 'available') {
        expected.add(projection.path);
        expected.add(`catalogs/projections/${projection.projectionId}.facts.json`);
        expected.add(`catalogs/projections/${projection.projectionId}.sources.json`);
        expected.add(`receipts/projections/${projection.projectionId}.json`);
      } else expected.add(`refusals/projections/${projection.projectionId}.json`);
    }
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
  if (manifest.projections?.length) {
    const requestedProjections = manifest.projections.map(
      ({ projectionId, projectionVersion, required }) => ({ projectionId, projectionVersion, required })
    );
    const requestProjectionSummary = (request.requestedProjections ?? []).map(
      ({ projectionId, projectionVersion, required }) => ({ projectionId, projectionVersion, required })
    );
    if (request.projectionRegistrySha256 !== manifest.projectionRegistrySha256
        || request.capabilitySnapshotSha256 !== (records.capabilitySnapshot?.snapshotSha256 ?? null)
        || request.configurationSnapshotSha256 !== (records.configurationSnapshot?.snapshotSha256 ?? null)
        || request.toolchainLockSha256 !== (records.toolchainLock?.lockSha256 ?? null)
        || canonicalJson(requestProjectionSummary) !== canonicalJson(requestedProjections)
        || canonicalJson(plan.projections?.map(({ projectionId, projectionVersion, required }) => ({
          projectionId, projectionVersion, required
        })) ?? []) !== canonicalJson(requestedProjections)) {
      incomplete('World-model projection build records do not bind the exact projection inputs.');
    }
  }
  return { consumerProfile, outputBudget, request, plan };
}

function validateStagedProjections(files, outputDir, manifest, records) {
  if (!manifest.projections?.length) return [];
  records.projectionRegistry = validateProjectionRegistry(canonicalRecord(
    files, outputDir, 'registries/projections.json'
  ));
  if (manifest.projections.some((entry) => entry.status === 'available')) {
    records.capabilitySnapshot = sealedRecord(
      files, outputDir, 'inputs/capability-snapshot.json',
      'architecture-fact-set', 'architecture-capability-snapshot', 'snapshotSha256'
    );
    records.configurationSnapshot = sealedRecord(
      files, outputDir, 'inputs/configuration-snapshot.json',
      'architecture-fact-set', 'architecture-configuration-snapshot', 'snapshotSha256'
    );
    records.toolchainLock = sealedRecord(
      files, outputDir, 'toolchains/calm.json',
      'calm-toolchain-lock', 'calm-toolchain-lock', 'lockSha256'
    );
  }
  if (records.projectionRegistry.registrySha256 !== manifest.projectionRegistrySha256) {
    incomplete('World-model projection registry does not match the manifest.');
  }
  const buildRequest = canonicalRecord(files, outputDir, 'requests/build-request.json');
  return manifest.projections.map((entry) => {
    if (entry.status === 'unavailable') {
      const refusal = sealedRecord(
        files, outputDir, `refusals/projections/${entry.projectionId}.json`,
        'world-model-projection-refusal', 'world-model-projection-refusal', 'refusalSha256'
      );
      if (refusal.refusalSha256 !== entry.refusalSha256 || refusal.projectionId !== entry.projectionId) {
        incomplete(`Projection refusal '${entry.projectionId}' does not match the manifest.`);
      }
      return { ...structuredClone(entry), refusal };
    }
    const raw = files[path.posix.join(outputDir, entry.path)];
    if (typeof raw !== 'string') incomplete(`Projection '${entry.projectionId}' bytes are missing.`);
    const projection = canonicalRecord(files, outputDir, entry.path);
    const factSet = sealedRecord(
      files, outputDir, `catalogs/projections/${entry.projectionId}.facts.json`,
      'architecture-fact-set', 'architecture-fact-set', 'factSetSha256'
    );
    const sourceMap = sealedRecord(
      files, outputDir, `catalogs/projections/${entry.projectionId}.sources.json`,
      'world-model-projection-source-map', 'world-model-projection-source-map', 'sourceMapSha256'
    );
    const receipt = sealedRecord(
      files, outputDir, `receipts/projections/${entry.projectionId}.json`,
      'world-model-projection-receipt', 'world-model-projection-receipt', 'receiptSha256'
    );
    if (sha256({ utf8: raw }) !== entry.projectionSha256
        || sourceMap.sourceMapSha256 !== entry.sourceMapSha256
        || receipt.receiptSha256 !== entry.receiptSha256
        || receipt.validation?.toolchainLockSha256 !== records.toolchainLock.lockSha256) {
      incomplete(`Projection '${entry.projectionId}' artifacts do not bind the manifest.`);
    }
    const rebuilt = buildCalmProjection({
      subject: manifest.subject,
      subjectLabel: manifest.subject.id,
      sourceManifestSha256: records.sourceSnapshot.sourceManifestSha256,
      scopeSha256: records.scopeManifest.scopeSha256,
      factLedger: records.factLedger,
      capabilitySnapshot: records.capabilitySnapshot,
      configurationSnapshot: records.configurationSnapshot,
      includeGovernanceActors: buildRequest.requestedProjections?.find(
        (value) => value.projectionId === entry.projectionId
      )?.profile?.includeGovernanceActors !== false,
      includeControls: buildRequest.requestedProjections?.find(
        (value) => value.projectionId === entry.projectionId
      )?.profile?.includeControls !== false,
      includeFlows: buildRequest.requestedProjections?.find(
        (value) => value.projectionId === entry.projectionId
      )?.profile?.includeFlows !== false,
      includeExternalDependencies: buildRequest.requestedProjections?.find(
        (value) => value.projectionId === entry.projectionId
      )?.profile?.includeExternalDependencies ?? 'direct-architecture-only'
    });
    const requested = buildRequest.requestedProjections?.find(
      (value) => value.projectionId === entry.projectionId
    );
    if (requested?.validation
        && receipt.validation?.strict !== requested.validation.strict) {
      incomplete(`Projection '${entry.projectionId}' validation receipt does not bind its strictness policy.`);
    }
    enforceProjectionBudgets(rebuilt.projection, requested?.budgets ?? {});
    if (canonicalJson(rebuilt.factSet) !== canonicalJson(factSet)
        || rebuilt.projectionBytes !== raw
        || canonicalJson(rebuilt.sourceMap) !== canonicalJson(sourceMap)) {
      generatedProjectionEdit(rebuilt.projection, projection, sourceMap);
    }
    return {
      ...structuredClone(entry), projection, projectionBytes: raw,
      projectionSha256: entry.projectionSha256, factSet, sourceMap, receipt
    };
  });
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
function validateStagedWorldModelPublicationWithLimit(publication, maximumRecoverableBytes) {
  if (!isPlainRecord(publication) || !isPlainRecord(publication.files)) {
    incomplete('World-model publication must be a staged plain-object projection.');
  }
  const outputDir = safeOutputDirectory(publication.outputDir);
  const history = validateStagedHistory(publication, outputDir);
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
  const projections = validateStagedProjections(files, outputDir, manifest, records);
  const dependencies = deriveWorldModelManifestDependencies({
    ...records,
    policySnapshotSha256: manifest.policySnapshotSha256
  });
  const viewRegistry = assertInstalledViewRegistry(records.viewRegistry);
  assertInstalledExtractorRegistry(records.extractorRegistry);
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
    projectionRegistry: records.projectionRegistry ?? null,
    projections,
    allowUnavailableOptionalViews: manifest.completeness.unavailableOptionalViews > 0
  });
  const result = Object.freeze({
    outputDir,
    manifestPath,
    manifest: Object.freeze(manifest),
    files,
    replaceRoots: Object.freeze([outputDir]),
    projections: Object.freeze(projections),
    ...(history ?? {})
  });
  const stagedBytes = Buffer.byteLength(canonicalJson(result), 'utf8');
  if (stagedBytes > maximumRecoverableBytes) {
    incomplete(
      'World-model publication exceeds the bounded recovery envelope; split retained history into smaller admitted publications.',
      {
        bytes: stagedBytes,
        maximumBytes: maximumRecoverableBytes
      }
    );
  }
  return result;
}

export function validateStagedWorldModelPublication(publication) {
  return validateStagedWorldModelPublicationWithLimit(
    publication, MAXIMUM_RECOVERABLE_STAGED_PUBLICATION_BYTES
  );
}

/** Read-only compatibility boundary for recovery sidecars stored by the v1 writer. */
export function validateMigratedV1StagedWorldModelPublication(publication) {
  return validateStagedWorldModelPublicationWithLimit(
    publication, MAXIMUM_LEGACY_V1_STAGED_PUBLICATION_BYTES
  );
}

async function validateStagedProjectionAuthorityAgainstSourceWith(
  root, publication, validatePublication
) {
  const verified = validatePublication(publication);
  if (!(verified.projections ?? []).some((projection) => projection.status === 'available')) {
    return verified;
  }
  for (const [relative, label] of [
    ['inputs/capability-snapshot.json', 'Capability'],
    ['inputs/configuration-snapshot.json', 'Configuration']
  ]) {
    const snapshot = canonicalRecord(verified.files, verified.outputDir, relative);
    const located = await secureRepositoryPath(root, snapshot.source?.path, {
      label: `${label} projection authority`, mustExist: true, type: 'file'
    });
    const currentSha256 = sha256({ utf8: await readFile(located.absolute, 'utf8') });
    if (currentSha256 !== snapshot.source?.sha256) {
      throw new SingularityFlowError(
        `${label} authority changed after the CALM projection build was planned. Nothing was published.`,
        {
          code: 'WMC_PROJECTION_INPUT_CHANGED',
          details: {
            path: snapshot.source?.path ?? null,
            plannedSha256: snapshot.source?.sha256 ?? null,
            currentSha256,
            nextAction: 'singularity-flow wm build --format registered-v4 --projections arch.calm'
          }
        }
      );
    }
  }
  for (const projection of verified.projections.filter((entry) => entry.status === 'available')) {
    const repeated = await validateCalmWithOfficialToolchain(projection.projection, {
      strict: projection.receipt.validation?.strict !== false
    });
    if (repeated.toolchainLock.lockSha256 !== projection.receipt.validation.toolchainLockSha256
        || repeated.normalizedResultSha256
          !== projection.receipt.validation.normalizedResultSha256) {
      incomplete(`Projection '${projection.projectionId}' validation cannot be reproduced at publication.`);
    }
  }
  const current = await resolveCurrentArchitectureProjectionInputs(root, await loadDefinition(root));
  assertArchitectureProjectionAuthoritySnapshots({
    capabilitySnapshot: canonicalRecord(
      verified.files, verified.outputDir, 'inputs/capability-snapshot.json'
    ),
    configurationSnapshot: canonicalRecord(
      verified.files, verified.outputDir, 'inputs/configuration-snapshot.json'
    )
  }, current);
  return verified;
}

/** Recheck mutable non-source authority immediately before retaining or publishing a projection. */
export async function validateStagedProjectionAuthorityAgainstSource(root, publication) {
  return validateStagedProjectionAuthorityAgainstSourceWith(
    root, publication, validateStagedWorldModelPublication
  );
}

async function validateMigratedV1ProjectionAuthorityAgainstSource(root, publication) {
  return validateStagedProjectionAuthorityAgainstSourceWith(
    root, publication, validateMigratedV1StagedWorldModelPublication
  );
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
  const viewRegistry = assertInstalledViewRegistry(canonicalRecord(
    files, outputDir, 'registries/views.json'
  ));
  const extractorRegistry = assertInstalledExtractorRegistry(canonicalRecord(
    files, outputDir, 'registries/extractors.json'
  ));
  const buildPlan = canonicalRecord(files, outputDir, 'plans/build-plan.json');
  const activeContracts = viewRegistry.contracts.filter(
    (contract) => contract.validity.status === 'active'
  );
  let reproduced = runDeterministicRegistration({
    root,
    sourceSnapshot,
    scopeManifest,
    extractorRegistry,
    extractorReferences: buildPlan.extractors,
    requestedViews: activeContracts,
    viewRegistry
  });
  const manifest = readWorldModelV4Manifest(canonicalRecord(
    files, outputDir, 'manifest.json'
  ));
  for (const relative of migrationProjectionPaths(files, outputDir)) {
    const receipt = validateWorldModelMigrationReceipt(
      canonicalRecord(files, outputDir, relative),
      {
        sourceSnapshot,
        scopeManifest,
        evidenceCatalog: reproduced.evidenceCatalog,
        availableViews: manifest.views
      }
    );
    const target = manifest.views.find((entry) => (
      entry.status === 'available' && entry.viewSha256 === receipt.targetViewSha256
    ));
    if (!target) {
      throw new SingularityFlowError(
        'World-model migration receipt target is absent from the exact staged manifest.',
        { code: 'WMB_PUBLICATION_FACTS_UNVERIFIED', details: { path: relative } }
      );
    }
    reproduced = augmentRegistrationForMigrationReceipt({
      receipt,
      registration: reproduced,
      targetViewContract: resolveViewContract(
        viewRegistry, `${target.viewId}@${target.viewVersion}`
      ),
      viewRegistry,
      extractorRegistry
    }).registration;
  }
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
  records = {}, allowUnavailableOptionalViews = false, projections = [],
  historyDir = undefined, historyAdditions = undefined, historyExpectations = undefined,
  exactBlobSha256 = undefined
} = {}) {
  const target = safeOutputDirectory(outputDir);
  const verified = verifyWorldModelManifest(manifest, {
    dependencies, views, allowUnavailableOptionalViews,
    projectionRegistry: projections.length ? records.projectionRegistry : null,
    projections
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
  if (verified.projections.length) {
    recordFile(files, target, 'registries/projections.json', records.projectionRegistry);
    if (verified.projections.some((entry) => entry.status === 'available')) {
      recordFile(files, target, 'inputs/capability-snapshot.json', records.capabilitySnapshot);
      recordFile(files, target, 'inputs/configuration-snapshot.json', records.configurationSnapshot);
      recordFile(files, target, 'toolchains/calm.json', records.toolchainLock);
    }
    for (const projection of verified.projections) {
      if (projection.status === 'unavailable') {
        recordFile(files, target, `refusals/projections/${projection.projectionId}.json`, projection.refusal);
        continue;
      }
      addFile(files, path.posix.join(target, projection.path), projection.projectionBytes);
      recordFile(files, target, `catalogs/projections/${projection.projectionId}.facts.json`, projection.factSet);
      recordFile(files, target, `catalogs/projections/${projection.projectionId}.sources.json`, projection.sourceMap);
      recordFile(files, target, `receipts/projections/${projection.projectionId}.json`, projection.receipt);
    }
  }
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
    replaceRoots: Object.freeze([target]),
    ...(historyDir !== undefined || historyAdditions !== undefined
      || historyExpectations !== undefined || exactBlobSha256 !== undefined ? {
        historyDir, historyAdditions, historyExpectations, exactBlobSha256
      } : {})
  });
}

async function publishWorldModelTransactionWith(
  root, ledgerConfig, publication, options, validatePublicationAuthority
) {
  const {
    message = '[world-model][wmb-v4] publish registered views',
    publisher = publishToStateBranch,
    ...publicationOptions
  } = options;
  const verified = await validatePublicationAuthority(root, publication);
  // WMB publications replace only the compatible current projection. Immutable history is
  // additive and can never be retired through the generic state-writer escape hatch. Keeping
  // removePaths entirely outside this transaction also protects custom history roots which a
  // projection-only caller did not include in its staged envelope.
  if (publicationOptions.removePaths !== undefined
      && (!Array.isArray(publicationOptions.removePaths)
        || publicationOptions.removePaths.length !== 0)) {
    throw new SingularityFlowError(
      'World-model publication cannot remove state-branch paths; immutable history is append-only.',
      { code: 'WMP_HISTORY_DELETE_REFUSED' }
    );
  }
  validateStagedRegistrationAgainstSource(root, verified);
  for (const projection of verified.projections ?? []) {
    if (projection.status !== 'available') continue;
    const validated = await validateCalmProjectionCandidate({
      factSet: projection.factSet,
      projection: projection.projection,
      projectionBytes: projection.projectionBytes,
      projectionSha256: projection.projectionSha256,
      sourceMap: projection.sourceMap
    });
    if (canonicalJson(validated.receipt) !== canonicalJson(projection.receipt)) {
      incomplete(`Projection '${projection.projectionId}' did not reproduce its official validator receipt at publication.`);
    }
  }
  const mergePublicationMap = (label, supplied, retained) => {
    if (supplied !== undefined && !isPlainRecord(supplied)) {
      incomplete(`World-model publication ${label} must be a plain-object path map.`);
    }
    const merged = { ...(supplied ?? {}) };
    for (const [target, value] of Object.entries(retained ?? {})) {
      if (Object.hasOwn(merged, target)
          && canonicalJson(merged[target]) !== canonicalJson(value)) {
        incomplete(`World-model history conflicts with an existing ${label} entry at '${target}'.`, {
          path: target
        });
      }
      merged[target] = value;
    }
    return Object.freeze(merged);
  };
  const writerOptions = verified.historyAdditions ? {
    ...publicationOptions,
    replaceRoots: verified.replaceRoots,
    pathPreconditions: mergePublicationMap(
      'pathPreconditions', publicationOptions.pathPreconditions, verified.historyExpectations
    ),
    exactBlobSha256: mergePublicationMap(
      'exactBlobSha256', publicationOptions.exactBlobSha256, verified.exactBlobSha256
    )
  } : {
    ...publicationOptions,
    replaceRoots: verified.replaceRoots
  };
  let result;
  try {
    result = await publisher(root, ledgerConfig, {
      ...verified.files,
      ...(verified.historyAdditions ?? {})
    }, message, writerOptions);
  } catch (error) {
    if (error?.code === 'state_branch.path_precondition_failed'
        && Object.hasOwn(verified.historyExpectations ?? {}, error.details?.path)) {
      throw new SingularityFlowError(
        `Immutable World-model history conflicts at '${error.details.path}'.`,
        {
          code: 'WMP_IDENTITY_CONFLICT',
          details: {
            path: error.details.path,
            expectedSha256: error.details.expectedSha256 ?? null,
            observed: error.details.observed ?? null
          },
          cause: error
        }
      );
    }
    throw error;
  }
  return Object.freeze({
    ...result,
    manifestSha256: verified.manifest.manifestSha256,
    manifestPath: verified.manifestPath
  });
}

/** Publish the already verified transaction with the existing exact-CAS state-branch writer. */
export async function publishWorldModelTransaction(
  root, ledgerConfig, publication, options = {}
) {
  return publishWorldModelTransactionWith(
    root, ledgerConfig, publication, options,
    validateStagedProjectionAuthorityAgainstSource
  );
}

/** Resume only an already authenticated recovery marker written by the v1 sidecar format. */
export async function publishMigratedV1WorldModelRecoveryTransaction(
  root, ledgerConfig, publication, options = {}
) {
  return publishWorldModelTransactionWith(
    root, ledgerConfig, publication, options,
    validateMigratedV1ProjectionAuthorityAgainstSource
  );
}
