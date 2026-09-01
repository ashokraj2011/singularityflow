import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  optionBoolean, optionNumber, optionString, secureRepositoryPath, SingularityFlowError
} from '../util.mjs';
import { inspectWorldModelViewCache } from './cache.mjs';
import { canonicalJson, sha256 } from './canonicalize.mjs';
import { createWorldModelMigrationReceipt } from './migration/v3-to-v4.mjs';
import { readLegacyWorldModelView } from './migration/v3-reader.mjs';
import { createWorldModelViewOutputBudget, planWorldModelV4 } from './plan.mjs';
import { BUILTIN_EXTRACTOR_REGISTRY } from './registry/extractors.mjs';
import {
  BUILTIN_VIEW_REGISTRY, resolveBuiltInViewContract
} from './registry/views.mjs';
import {
  WMB_V4_CANDIDATE_SCHEMA_SHA256, WMB_V4_DETERMINISTIC_EXECUTION_SHA256,
  WMB_V4_VALIDATOR_SHA256
} from './runtime.mjs';
import {
  assertWorldModelV4BuildCompleted, buildAndPublishWorldModelV4
} from './service.mjs';
import {
  resolvePublishedWorldModelV4, worldModelV4StoreSummary
} from './store.mjs';
import {
  publishWorldModelTransaction, stageWorldModelMigrationPublication
} from './publish/transaction.mjs';

const DEFAULT_EXCLUDED_ROOTS = Object.freeze([
  '.git/**', '.sflow/**', '.singularity-flow/**', 'singularity/**', '.github/agents/**'
]);

export function configuredWorldModelV4ViewIds(config, options = {}, phase = null) {
  const explicit = optionString(options, 'views') ?? optionString(options, 'view');
  const activeContracts = BUILTIN_VIEW_REGISTRY.contracts.filter(
    (contract) => contract.validity.status === 'active'
  );
  const all = activeContracts.map((contract) => contract.id);
  const normalize = (entries, label) => {
    const raw = entries.map((entry) => String(entry).trim()).filter(Boolean);
    if (raw.includes('all')) {
      if (raw.length !== 1) throw new SingularityFlowError(`WMB v4 ${label} cannot combine 'all' with named views.`, { code: 'WMB_VIEW_UNKNOWN' });
      return all;
    }
    const selected = [];
    const unknown = [];
    for (const entry of raw) {
      const parsed = /^(?<id>[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+)(?:@(?<version>[1-9][0-9]*))?$/.exec(entry)?.groups;
      const contract = parsed && activeContracts.find((candidate) =>
        candidate.id === parsed.id
        && (parsed.version == null || candidate.version === Number(parsed.version)));
      if (contract) selected.push(entry);
      else unknown.push(entry);
    }
    if (unknown.length) {
      throw new SingularityFlowError(`Unknown or inactive configured WMB v4 view(s): ${unknown.join(', ')}.`, {
        code: 'WMB_VIEW_UNKNOWN', details: { views: unknown, registeredViews: all }
      });
    }
    return selected;
  };
  if (explicit) return [...new Set(normalize(
    String(explicit).split(','), 'CLI selection'
  ))].sort();
  const phaseRaw = phase && config.phases?.[phase]?.declaredViews?.length
    ? config.phases[phase].declaredViews : [];
  const phaseViews = normalize(phaseRaw, `phase '${phase}'`);
  const configuredRaw = config.definition?.worldModel?.views ?? [];
  const configured = normalize(configuredRaw, 'configuration');
  let values = phaseViews.length ? phaseViews : configured;
  if (!values.length && (phaseRaw.length || configuredRaw.length)) {
    throw new SingularityFlowError(
      'The approved World-Model configuration contains no registered WMB v4 view.',
      { code: 'WMB_VIEW_UNKNOWN', details: { registeredViews: all } }
    );
  }
  if (!values.length) values = all;
  return [...new Set(values)].sort();
}

function composer(config, options) {
  const supplied = optionString(options, 'composer');
  if (supplied) return supplied === 'model-required' ? 'model' : supplied === 'model-optional' ? 'auto' : supplied;
  const configured = config.definition?.worldModel?.v4?.composer ?? 'deterministic';
  return configured === 'model-required' ? 'model' : configured === 'model-optional' ? 'auto' : 'deterministic';
}

function depth(config, options) {
  const value = optionString(options, 'depth', config.definition?.worldModel?.v4?.depth ?? 'standard');
  return value === 'light' ? 'quick' : value;
}

function ledgerConfig(config) {
  return {
    ...(config.definition?.ledger ?? {}),
    branch: config.definition?.ledger?.branch ?? config.stateBranch ?? 'state',
    remote: config.definition?.git?.remote ?? config.remote ?? 'origin'
  };
}

function scopeOptions(root, config) {
  const policy = config.definition?.worldModel ?? {};
  const activeCapability = config.workflow?.resolution?.capability?.id
    ?? config.workflow?.resolution?.capabilityId
    ?? path.basename(root);
  const excluded = [...new Set([
    ...DEFAULT_EXCLUDED_ROOTS,
    ...(policy.excludedRoots ?? [])
  ])].sort();
  return {
    capabilityId: activeCapability,
    allowedPaths: policy.sourceRoots?.length ? policy.sourceRoots : ['**'],
    sharedPaths: policy.sharedRoots ?? [],
    excludedPaths: excluded,
    ...(policy.allowedSubjects?.length ? { allowedSubjects: policy.allowedSubjects } : {}),
    maximumTraversalDepth: policy.maximumTraversalDepth ?? 8,
    policySnapshotSha256: sha256({
      format: 'registered-v4',
      worldModel: policy,
      capabilityId: activeCapability
    })
  };
}

/** Resolve the v4 worker bound while preserving an explicit CLI override. */
export function configuredWorldModelV4MaximumWorkers(config, options = {}) {
  const explicit = optionNumber(options, 'workers');
  if (explicit != null) return explicit;
  if (config.generation?.parallel === false
      || config.definition?.worldModel?.generation?.parallel === false) return 1;
  return config.generation?.maxWorkers
    ?? config.definition?.worldModel?.generation?.maxWorkers
    ?? 4;
}

function commonBuildOptions(root, config, options, { views = null, cachePolicy = null } = {}) {
  return {
    views: views ?? configuredWorldModelV4ViewIds(config, options, optionString(options, 'phase')),
    consumer: optionString(
      options, 'consumer', config.definition?.worldModel?.v4?.consumer ?? 'developer'
    ),
    depth: depth(config, options),
    cachePolicy: cachePolicy
      ?? (optionBoolean(options, 'rebuild') ? 'rebuild'
        : config.definition?.worldModel?.v4?.cachePolicy ?? 'reuse-valid'),
    totalMaximumOutputTokens: optionNumber(
      options,
      'total-max-output-tokens',
      config.definition?.worldModel?.v4?.totalMaximumOutputTokens
    ) ?? null,
    composer: composer(config, options),
    provider: config.provider,
    providerConfig: config.providerConfig,
    // No configured legacy model is forced here. With no explicit --model the governed provider
    // selects its own current model and the observed result is stamped in the view.
    model: optionString(options, 'model'),
    maximumWorkers: configuredWorldModelV4MaximumWorkers(config, options),
    ...scopeOptions(root, config)
  };
}

function storeOptions(config) {
  const ledger = ledgerConfig(config);
  return {
    outputDir: config.outputDir,
    stateBranch: ledger.branch,
    remote: ledger.remote
  };
}

export function isWorldModelV4(config, options = {}) {
  const requested = optionString(options, 'format');
  if (requested) return ['v4', 'wmb-v4', 'registered-v4'].includes(requested);
  return config.definition?.worldModel?.format === 'registered-v4';
}

export function planWorldModelV4Command(root, config, options) {
  const planned = planWorldModelV4(root, commonBuildOptions(root, config, options));
  const result = {
    request: planned.request,
    plan: planned.plan,
    sourceSnapshot: planned.sourceSnapshot,
    scopeManifest: planned.scopeManifest,
    consumerProfile: planned.consumerProfile,
    outputBudget: planned.outputBudget
  };
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`WMB v4 plan ${planned.plan.planSha256}`);
    console.log(`  Source: ${planned.sourceSnapshot.subject.id}@${planned.sourceSnapshot.revision.commit}`);
    console.log(`  Scope: ${planned.scopeManifest.capabilityId} · ${planned.sourceSnapshot.files.length} exact file(s)`);
    console.log(`  Views: ${planned.plan.views.map((entry) => `${entry.viewId}@${entry.viewVersion}`).join(', ')}`);
    console.log(`  Extractors: ${planned.plan.extractors.length} deterministic · model calls: at most ${planned.plan.estimatedWork.maximumCompositionCalls}`);
  }
  return result;
}

export async function buildWorldModelV4Command(root, config, options, { views = null, rebuild = false } = {}) {
  const result = await buildAndPublishWorldModelV4(root, {
    ...commonBuildOptions(root, config, options, {
      views,
      cachePolicy: rebuild ? 'rebuild' : null
    }),
    outputDir: config.outputDir,
    ledgerConfig: ledgerConfig(config),
    publish: !optionBoolean(options, 'local'),
    publicationOptions: {},
    allowUnavailableOptionalViews: true
  });
  if (optionBoolean(options, 'json')) console.log(JSON.stringify({
    schemaVersion: result.schemaVersion,
    resultType: result.resultType,
    requestSha256: result.requestSha256,
    status: result.status,
    manifestSha256: result.manifestSha256,
    views: result.views,
    refusals: result.refusals,
    warnings: result.warnings,
    next: result.next,
    publication: result.publication
  }, null, 2));
  else if (result.status === 'completed') {
    const hits = result.views.filter((entry) => entry.cache === 'hit').length;
    console.log(`WMB v4 complete: ${result.views.length} view(s), ${hits} exact cache hit(s).`);
    console.log(`  Manifest: ${result.manifestSha256}`);
    console.log(result.publication
      ? `  Published atomically to ${result.publication.branch}@${result.publication.commit ?? 'current'}.`
      : '  Validated locally; no state-branch publication was requested.');
    result.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
  }
  return assertWorldModelV4BuildCompleted(result);
}

function currentStore(root, config) {
  return resolvePublishedWorldModelV4(root, storeOptions(config));
}

function selectedStoreView(store, viewId) {
  const view = store.views.find((entry) => entry.viewId === viewId);
  if (!view) {
    const error = new Error(`WMB v4 view '${viewId}' is not present in the current manifest.`);
    error.code = 'WMB_VIEW_UNKNOWN';
    throw error;
  }
  return view;
}

function requiredValue(value, usage) {
  if (value != null && String(value).trim()) return String(value).trim();
  throw new SingularityFlowError(`Usage: ${usage}`, { code: 'WMB_COMMAND_ARGUMENT_REQUIRED' });
}

function rawSha256(value) {
  return value == null ? null : String(value).replace(/^sha256:/, '');
}

function contentSha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

/**
 * Resolve phase grounding from the immutable published v4 projection.
 *
 * This boundary is deliberately read-only. A phase can consume an exact state-backed view or
 * receive an actionable refusal; phase preparation and prompt composition never create, repair,
 * or replace a World Model as a side effect.
 */
export function resolveWorldModelV4Grounding(root, config, {
  phase = null,
  options = {},
  required = true,
  store: suppliedStore = null
} = {}) {
  const store = suppliedStore
    ?? resolvePublishedWorldModelV4(root, { ...storeOptions(config), required });
  if (!store) return null;
  const viewIds = configuredWorldModelV4ViewIds(config, options, phase);
  const views = viewIds.map((viewId) => selectedStoreView(store, viewId));
  const unavailable = views.filter((entry) => entry.status !== 'available');
  if (unavailable.length) {
    throw new SingularityFlowError(
      `Registered WMB v4 grounding is unavailable for: ${unavailable.map((entry) => entry.viewId).join(', ')}. `
      + 'Run an explicit singularity-flow wm build --format registered-v4 for those views.',
      {
        code: 'WMB_VIEW_UNAVAILABLE',
        details: { phase, views: unavailable.map((entry) => entry.viewId), implicitRebuild: false }
      }
    );
  }
  if (!store.freshness.fresh && config.staleness === 'fail') {
    throw new SingularityFlowError(
      `Registered WMB v4 grounding is stale (${store.freshness.reason}). `
      + 'Review the source change and run an explicit WMB v4 build; phase composition will not rebuild it.',
      {
        code: 'WMB_SOURCE_SNAPSHOT_STALE',
        details: { ...store.freshness, implicitRebuild: false }
      }
    );
  }
  const selected = views.map((view) => ({
    relative: view.path,
    absolute: null,
    body: view.markdown,
    level: 1,
    reason: `registered WMB v4 view ${view.viewId}@${view.viewVersion}`,
    sha256: contentSha256(view.markdown),
    size: Buffer.byteLength(view.markdown, 'utf8'),
    viewId: view.viewId,
    viewVersion: view.viewVersion
  }));
  const selections = views.map((view) => ({
    kind: 'view',
    view: view.viewId,
    version: view.viewVersion,
    tier: 'registered-v4',
    path: view.path,
    sha256: rawSha256(view.viewSha256)
  }));
  return Object.freeze({
    format: 'registered-v4',
    store,
    views,
    selected,
    selections,
    located: {
      source: store.ref.startsWith('refs/remotes/') || store.ref.startsWith('refs/heads/')
        ? 'state-branch' : 'repository',
      ref: store.ref,
      commit: store.commit
    },
    directory: null,
    manifest: store.manifest,
    // The manifest identity binds its canonical record without the self-hash field. Prompt
    // injection's historical receipt separately binds the exact committed blob bytes.
    manifestSha256: store.manifest.manifestSha256,
    manifestContentSha256: contentSha256(canonicalJson(store.manifest)),
    sourceManifestSha256: store.sourceSnapshot.sourceManifestSha256,
    freshness: structuredClone(store.freshness)
  });
}

export function statusWorldModelV4Command(root, config, options) {
  const store = currentStore(root, config);
  const result = worldModelV4StoreSummary(store);
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`WMB v4: ${result.fresh ? 'fresh' : 'stale'} · ${result.views.length} view(s) · ${result.facts} fact(s)`);
    console.log(`  Authority: ${result.authorityRef}@${result.authorityCommit}`);
    console.log(`  Manifest: ${result.manifestSha256}`);
    result.views.forEach((entry) => console.log(`  ${entry.status === 'available' ? 'ready' : 'unavailable'}  ${entry.viewId}@${entry.viewVersion} · cache ${entry.cache}`));
  }
  return result;
}

function manifestCommand(root, config, options) {
  const store = currentStore(root, config);
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(store.manifest, null, 2));
  else process.stdout.write(canonicalJson(store.manifest));
  return store.manifest;
}

function showCommand(root, config, options, viewId) {
  const store = currentStore(root, config);
  const view = selectedStoreView(store, viewId);
  if (view.status !== 'available') throw Object.assign(new Error(`WMB v4 view '${viewId}' is unavailable.`), { code: 'WMB_VIEW_UNAVAILABLE' });
  if (optionBoolean(options, 'json')) console.log(JSON.stringify({
    viewId, viewVersion: view.viewVersion, viewSha256: view.viewSha256,
    validationReceiptSha256: view.validationReceipt.receiptSha256,
    markdown: view.markdown
  }, null, 2));
  else process.stdout.write(view.markdown);
  return view;
}

function factsCommand(root, config, options, viewId = null) {
  const store = currentStore(root, config);
  let ledger = store.factLedger;
  if (viewId) {
    ledger = store.records.viewFactLedgers.find((entry) => entry.viewId === viewId);
    if (!ledger) throw Object.assign(new Error(`No published view Fact Ledger exists for '${viewId}'.`), { code: 'WMB_FACT_LEDGER_INVALID' });
  }
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(ledger, null, 2));
  else ledger.facts.forEach((fact) => console.log(`${fact.id}  ${fact.status}/${fact.assurance}  ${fact.claim ?? fact.reason?.detail}`));
  return ledger;
}

function evidenceCommand(root, config, options, evidenceId) {
  const store = currentStore(root, config);
  const evidence = store.evidenceCatalog.items.find((entry) => entry.id === evidenceId);
  if (!evidence) throw Object.assign(new Error(`Unknown WMB v4 evidence '${evidenceId}'.`), { code: 'WMB_EVIDENCE_REFERENCE_UNKNOWN' });
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(evidence, null, 2));
  else process.stdout.write(canonicalJson(evidence));
  return evidence;
}

function derivationCommand(root, config, options, derivationId) {
  const store = currentStore(root, config);
  const derivation = store.derivationCatalog.derivations.find((entry) => entry.id === derivationId);
  if (!derivation) throw Object.assign(new Error(`Unknown WMB v4 derivation '${derivationId}'.`), { code: 'WMB_DERIVATION_INVALID' });
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(derivation, null, 2));
  else process.stdout.write(canonicalJson(derivation));
  return derivation;
}

function registryViewsCommand(options) {
  const result = BUILTIN_VIEW_REGISTRY.contracts.map((contract) => ({
    id: contract.id,
    version: contract.version,
    status: contract.validity.status,
    title: contract.title,
    model: contract.model.mode,
    contractSha256: contract.contractSha256
  }));
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else result.forEach((entry) => console.log(`${entry.id}@${entry.version}  ${entry.status}  ${entry.model}  ${entry.title}`));
  return result;
}

function viewContractCommand(options, viewId) {
  const contract = resolveBuiltInViewContract(viewId.includes('@') ? viewId : `${viewId}@4`);
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(contract, null, 2));
  else process.stdout.write(canonicalJson(contract));
  return contract;
}

function extractorsCommand(options) {
  const result = BUILTIN_EXTRACTOR_REGISTRY.manifests.map((manifest) => ({
    id: manifest.id,
    version: manifest.version,
    languages: manifest.languages,
    factTypes: manifest.factTypes,
    manifestSha256: manifest.manifestSha256
  }));
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else result.forEach((entry) => console.log(`${entry.id}@${entry.version}  model never  network none  ${entry.factTypes.join(', ')}`));
  return result;
}

async function verifyCacheCommand(root, config, options) {
  const store = currentStore(root, config);
  const profile = store.records.consumerProfile;
  const budget = store.records.outputBudget;
  const inspected = await inspectWorldModelViewCache(root);
  const reports = [];
  for (const view of store.views.filter((entry) => entry.status === 'available')) {
    const contract = store.viewRegistry.contracts.find((entry) => entry.id === view.viewId && entry.version === view.viewVersion);
    const ledger = store.records.viewFactLedgers.find((entry) => entry.viewId === view.viewId);
    const context = store.records.contextManifests.find((entry) => entry.viewId === view.viewId);
    if (!profile || !budget || !contract || !ledger || !context) {
      reports.push({ viewId: view.viewId, status: 'unverifiable', reason: 'published-cache-key-input-missing' });
      continue;
    }
    const expected = {
      sourceManifestSha256: store.sourceSnapshot.sourceManifestSha256,
      scopeManifestSha256: store.scopeManifest.scopeSha256,
      viewId: view.viewId,
      viewVersion: view.viewVersion,
      viewSpecSha256: contract.contractSha256,
      viewFactLedgerSha256: ledger.ledgerSha256,
      consumerProfileSha256: profile.profileSha256,
      composerCoreSha256: context.regions.find((entry) => entry.id === 'stable-core')?.sha256,
      compositionCandidateSchemaSha256: WMB_V4_CANDIDATE_SCHEMA_SHA256,
      validatorSha256: WMB_V4_VALIDATOR_SHA256,
      outputBudgetSha256: createWorldModelViewOutputBudget(budget, contract).budgetSha256
    };
    const deterministic = view.execution.executionUnitManifestSha256
      === WMB_V4_DETERMINISTIC_EXECUTION_SHA256;
    const matching = inspected.entries.filter((entry) => {
      const { executionProfileSha256, ...semantic } = entry.components;
      return canonicalJson(semantic) === canonicalJson(expected)
        && (deterministic ? executionProfileSha256 === null : executionProfileSha256 !== null)
        && entry.record.viewSha256 === view.viewSha256
        && entry.record.validationReceiptSha256 === view.validationReceipt.receiptSha256;
    });
    const result = matching[0] ?? null;
    reports.push({
      viewId: view.viewId,
      status: result ? 'verified' : 'miss',
      cacheKeySha256: result?.cacheKeySha256 ?? null,
      executionProfileSha256: result?.components.executionProfileSha256 ?? null,
      reason: result ? null : 'no-exact-persisted-cache-identity-matches-the-published-view'
    });
  }
  reports.push(...inspected.problems.map((problem) => ({
    viewId: null,
    status: 'corrupt',
    cacheKeySha256: problem.cacheKeySha256 ?? null,
    executionProfileSha256: null,
    reason: problem.reason
  })));
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(reports, null, 2));
  else reports.forEach((entry) => console.log(`${entry.status}  ${entry.viewId}${entry.reason ? `  ${entry.reason}` : ''}`));
  return reports;
}

function contextCommand(root, config, options, phase = null) {
  const store = currentStore(root, config);
  let resolved;
  if (!optionString(options, 'views') && !optionString(options, 'view') && phase == null) {
    const viewIds = store.manifest.views
      .filter((entry) => entry.status === 'available').map((entry) => entry.viewId);
    resolved = resolveWorldModelV4Grounding(root, config, {
      options: { ...options, views: viewIds.join(',') }, store
    });
  } else resolved = resolveWorldModelV4Grounding(root, config, { phase, options, store });
  const { views } = resolved;
  if (optionBoolean(options, 'json')) console.log(JSON.stringify({
    manifestSha256: resolved.manifestSha256,
    freshness: resolved.freshness,
    views: views.map((entry) => ({ viewId: entry.viewId, viewSha256: entry.viewSha256, path: entry.path }))
  }, null, 2));
  else if (optionBoolean(options, 'concat')) {
    for (const view of views) process.stdout.write(`\n<!-- WMB v4 ${view.viewId}@${view.viewVersion} -->\n\n${view.markdown}`);
  } else {
    console.log(`# WMB v4 context${phase ? `: phase=${phase}` : ''} ${resolved.freshness.fresh ? 'fresh' : 'STALE'}`);
    views.forEach((entry) => console.log(`${entry.viewId}@${entry.viewVersion}  ${entry.viewSha256}  ${entry.path}`));
  }
  return resolved;
}

async function migrationCommand(root, config, options, legacyPath, viewId) {
  const secured = await secureRepositoryPath(root, legacyPath, {
    label: 'Legacy World-model view', mustExist: true, type: 'file'
  });
  const legacy = readLegacyWorldModelView(await readFile(secured.absolute, 'utf8'), {
    sourcePath: secured.relative
  });
  // Build and validate locally first. The target projection and its migration receipt are then
  // published by one state-branch CAS, so a push failure cannot expose a migrated view without the
  // receipt that explains which legacy claims were (and were not) registered.
  const built = await buildWorldModelV4Command(
    root, config, { ...options, local: true }, { views: [viewId], rebuild: true }
  );
  const target = built.runtime.availableViews.find((entry) => entry.viewId === viewId);
  const migration = createWorldModelMigrationReceipt({
    legacyView: legacy,
    targetViewSha256: target.viewSha256,
    sourceSnapshot: built.runtime.planned.sourceSnapshot,
    scopeManifest: built.runtime.planned.scopeManifest,
    evidenceCatalog: built.runtime.registration.evidenceCatalog,
    factLedger: built.runtime.registration.factLedger
  });
  let publication = null;
  if (!optionBoolean(options, 'local')) {
    const staged = stageWorldModelMigrationPublication(built.staged, migration.receipt);
    publication = await publishWorldModelTransaction(root, ledgerConfig(config), staged, {
      message: `[world-model][wmb-v4] migrate ${secured.relative}`
    });
  }
  const result = { ...migration, publication };
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`Migrated ${migration.receipt.claims.mappedToRegisteredFacts}/${migration.receipt.claims.total} legacy claim(s); ${migration.receipt.claims.unresolved} remain unavailable.`);
  return result;
}

export async function handleWorldModelV4Command(root, config, command, positionals, options) {
  if (command === 'plan') return planWorldModelV4Command(root, config, options);
  if (command === 'build') return buildWorldModelV4Command(root, config, options);
  if (command === 'status' || command === 'availability') return statusWorldModelV4Command(root, config, options);
  if (command === 'ensure') {
    const phase = positionals[2] ?? optionString(options, 'phase');
    const resolved = resolveWorldModelV4Grounding(root, config, { phase, options });
    const result = {
      status: 'ready',
      phase,
      format: resolved.format,
      manifestSha256: resolved.manifestSha256,
      fresh: resolved.freshness.fresh,
      views: resolved.views.map((entry) => ({
        viewId: entry.viewId, viewVersion: entry.viewVersion, viewSha256: entry.viewSha256
      })),
      modelInvoked: false,
      rebuilt: false
    };
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else console.log(`WMB v4 grounding ready${phase ? ` for ${phase}` : ''}: ${result.views.map((entry) => entry.viewId).join(', ')} (reused; no build).`);
    return result;
  }
  if (command === 'manifest') return manifestCommand(root, config, options);
  if (command === 'show') return showCommand(
    root, config, options,
    requiredValue(positionals[2], 'singularity-flow wm show <view-id> [--json]')
  );
  if (command === 'facts') return factsCommand(root, config, options, positionals[2] ?? null);
  if (command === 'evidence') return evidenceCommand(
    root, config, options,
    requiredValue(positionals[2], 'singularity-flow wm evidence <evidence-id> [--json]')
  );
  if (command === 'derivation') return derivationCommand(
    root, config, options,
    requiredValue(positionals[2], 'singularity-flow wm derivation <derivation-id> [--json]')
  );
  if (command === 'views') return registryViewsCommand(options);
  if (command === 'view-contract') return viewContractCommand(
    options,
    requiredValue(positionals[2], 'singularity-flow wm view-contract <view-id> [--json]')
  );
  if (command === 'extractors') return extractorsCommand(options);
  if (command === 'validate' || command === 'check') return statusWorldModelV4Command(root, config, options);
  if (command === 'validate-view') {
    const viewId = requiredValue(
      positionals[2], 'singularity-flow wm validate-view <view-id> [--json]'
    );
    const view = selectedStoreView(currentStore(root, config), viewId);
    if (view.status !== 'available') {
      throw new SingularityFlowError(`WMB v4 view '${viewId}' is unavailable.`, {
        code: 'WMB_VIEW_UNAVAILABLE'
      });
    }
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(view.validationReceipt, null, 2));
    else console.log(`passed  ${viewId}@${view.viewVersion}  ${view.validationReceipt.receiptSha256}`);
    return view.validationReceipt;
  }
  if (command === 'verify-cache') return verifyCacheCommand(root, config, options);
  if (command === 'regenerate') {
    let ids;
    if (optionBoolean(options, 'stale')) {
      const store = currentStore(root, config);
      if (store.freshness.fresh) {
        const result = { status: 'current', regenerated: [] };
        if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
        else console.log('WMB v4 is fresh; no stale view requires regeneration.');
        return result;
      }
      ids = store.manifest.views.map((entry) => entry.viewId);
    } else ids = [requiredValue(
      positionals[2], 'singularity-flow wm regenerate <view-id> [--json]'
    )];
    return buildWorldModelV4Command(root, config, options, { views: ids, rebuild: true });
  }
  if (command === 'context') return contextCommand(root, config, options, positionals[2] ?? optionString(options, 'phase'));
  if (command === 'doctor') {
    let store = null;
    let state = 'not-built';
    let detail = null;
    try { store = resolvePublishedWorldModelV4(root, { ...storeOptions(config), required: false }); state = store ? 'valid' : state; }
    catch (error) { state = 'invalid'; detail = { code: error.code ?? null, message: error.message }; }
    const result = {
      status: state === 'invalid' ? 'fail' : 'pass',
      registries: {
        views: BUILTIN_VIEW_REGISTRY.registrySha256,
        extractors: BUILTIN_EXTRACTOR_REGISTRY.registrySha256
      },
      state,
      detail,
      summary: store ? worldModelV4StoreSummary(store) : null
    };
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else console.log(`WMB v4 doctor: ${result.status} · state ${state} · 4 registered views · ${BUILTIN_EXTRACTOR_REGISTRY.manifests.length} registered extractors`);
    return result;
  }
  if (command === 'migrate') {
    const legacyPath = positionals[2] ?? optionString(options, 'from');
    const viewId = optionString(options, 'view');
    if (!legacyPath || !viewId) throw Object.assign(new Error('Usage: singularity-flow wm migrate <legacy-view.md> --view <registered-view>'), { code: 'WMB_MIGRATION_SOURCE_INVALID' });
    return migrationCommand(root, config, options, legacyPath, viewId);
  }
  return null;
}

export const WORLD_MODEL_V4_COMMANDS = Object.freeze(new Set([
  'plan', 'build', 'status', 'availability', 'ensure', 'manifest', 'show', 'facts', 'evidence',
  'derivation', 'validate', 'check', 'validate-view', 'verify-cache', 'regenerate',
  'views', 'view-contract', 'extractors', 'doctor', 'context', 'migrate'
]));
