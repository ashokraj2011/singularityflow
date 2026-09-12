import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  optionBoolean, optionNumber, optionString, run, secureRepositoryPath, SingularityFlowError
} from '../util.mjs';
import { inspectWorldModelViewCache } from './cache.mjs';
import { canonicalJson, compareText, sha256 } from './canonicalize.mjs';
import { createWorldModelMigrationReceipt } from './migration/v3-to-v4.mjs';
import { readLegacyWorldModelView } from './migration/v3-reader.mjs';
import {
  createWorldModelViewOutputBudget, planWorldModelV4, resolveWorldModelV4ReusableIdentity
} from './plan.mjs';
import { BUILTIN_EXTRACTOR_REGISTRY } from './registry/extractors.mjs';
import {
  BUILTIN_VIEW_REGISTRY, normalizeBuiltInViewReference, resolveBuiltInViewContract
} from './registry/views.mjs';
import {
  BUILTIN_PROJECTION_REGISTRY, resolveProjectionContract
} from './registry/projections.mjs';
import {
  architectureProjectionInputIdentity, resolveCurrentArchitectureProjectionInputs
} from './projections/calm/authority.mjs';
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
import { createScopeManifest, normalizeScopePattern } from './scope/manifest.mjs';
import {
  captureCandidateSourceSnapshot, loadCandidateSourceSnapshot
} from './source/snapshot.mjs';
import {
  inspectWorldModelV4Authority, refreshWorldModelV4Authority
} from './authority-refresh.mjs';
import { worldModelStateAuthority } from './authority-config.mjs';
import {
  resolvePersistedWorldModel, resolvePersistedWorldModelView,
  resolveWorldModelHistoryAuthority
} from './history/store.mjs';
import {
  DEFAULT_WORLD_MODEL_HISTORY_DIR, validateWorldModelHistoryRoots
} from './history/paths.mjs';
import { configuredRemoteIdentity } from '../git-remote-diagnostics.mjs';

const DEFAULT_EXCLUDED_ROOTS = Object.freeze([
  '.git/**', '.sflow/**', '.singularity-flow/**', 'singularity/**', '.github/agents/**'
]);
const CAPABILITY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WMP_HISTORY_KEY = /^(?:sha256:)?([a-f0-9]{64})$/;
const WMP_HISTORY_KINDS = Object.freeze(['model', 'view']);
const WMP_HISTORY_LIST_DEFAULT_PAGE_SIZE = 100;
const WMP_HISTORY_LIST_MAXIMUM_PAGE_SIZE = 500;
const WMP_HISTORY_LIST_MAXIMUM_BINDINGS = 100_000;
const WMP_HISTORY_LIST_MAXIMUM_OUTPUT_BYTES = 32 * 1024 * 1024;
const WMP_HISTORY_CURSOR_PREFIX = 'wmp1.';

/** Capability identity that must survive a storyless multi-capability recovery round trip. */
export function configuredWorldModelV4CapabilityId(config) {
  const pinned = config.workflow?.resolution?.capability ?? null;
  const repositoryCapability = config.repositoryCapability ?? null;
  const candidate = pinned?.id
    ?? config.workflow?.resolution?.capabilityId
    ?? repositoryCapability?.id
    ?? null;
  return typeof candidate === 'string' && CAPABILITY_ID.test(candidate) ? candidate : null;
}

/** Capability options are replayed only for a real approved selection, never for the implicit root. */
export function explicitWorldModelV4CapabilityId(config) {
  const pinned = config.workflow?.resolution?.capability ?? null;
  const repositoryCapability = config.repositoryCapability ?? null;
  const candidate = configuredWorldModelV4CapabilityId(config);
  const effective = pinned?.effectiveResolution ?? repositoryCapability?.effectiveResolution ?? null;
  // Keep the implicit ID in the reusable scope identity: switching from an implicit repository
  // boundary to a reviewed capability is a material scope change. Omit it only from argv and
  // gateway selections, where replaying the synthetic ID would fail once a real map is available.
  return effective?.mode === 'implicit' ? null : candidate;
}

/** Append the selected capability to a copy/paste-safe registered-v4 CLI command. */
export function scopedWorldModelV4Command(config, command) {
  const capabilityId = explicitWorldModelV4CapabilityId(config);
  return `${command}${capabilityId ? ` --capability ${capabilityId}` : ''}`;
}

export function configuredWorldModelV4ViewSelections(config, options = {}, phase = null) {
  const explicit = optionString(options, 'views') ?? optionString(options, 'view');
  const activeContracts = BUILTIN_VIEW_REGISTRY.contracts.filter(
    (contract) => contract.validity.status === 'active'
  );
  const all = activeContracts.map((contract) => Object.freeze({
    viewId: contract.id,
    version: contract.version,
    reference: `${contract.id}@${contract.version}`
  }));
  const normalize = (entries, label, pinnedById = new Map()) => {
    const raw = entries.map((entry) => String(entry).trim()).filter(Boolean);
    if (raw.includes('all')) {
      if (raw.length !== 1) throw new SingularityFlowError(`WMB v4 ${label} cannot combine 'all' with named views.`, { code: 'WMB_VIEW_UNKNOWN' });
      return all.map((entry) => pinnedById.get(entry.viewId) ?? entry);
    }
    const selected = [];
    const failures = [];
    for (const entry of raw) {
      try {
        const normalized = normalizeBuiltInViewReference(entry);
        const exact = Object.freeze({
          viewId: normalized.viewId,
          version: normalized.version,
          reference: normalized.reference
        });
        const pinned = pinnedById.get(exact.viewId);
        if (pinned && entry.includes('@') && pinned.reference !== exact.reference) {
          const error = new SingularityFlowError(
            `WMB v4 ${label} selects '${exact.reference}', but repository configuration pins '${pinned.reference}'.`,
            { code: 'WMB_VIEW_VERSION_UNSUPPORTED' }
          );
          failures.push({ entry, error });
        } else {
          // A phase/agent uses the stable logical ID. Its exact execution contract comes from the
          // repository catalog so a future active version cannot silently bypass an approved pin.
          selected.push(pinned ?? exact);
        }
      } catch (error) {
        failures.push({ entry, error });
      }
    }
    if (failures.length) {
      const code = failures.length === 1 && failures[0].error?.code === 'WMB_VIEW_VERSION_UNSUPPORTED'
        ? 'WMB_VIEW_VERSION_UNSUPPORTED' : 'WMB_VIEW_UNKNOWN';
      throw new SingularityFlowError(
        `Unknown, inactive, or version-mismatched configured WMB v4 view(s): ${failures.map(({ entry }) => entry).join(', ')}.`,
        {
          code,
          details: {
            views: failures.map(({ entry }) => entry),
            registeredViews: all.map((entry) => `${entry.viewId}@${entry.version}`)
          }
        }
      );
    }
    return [...new Map(selected.map((entry) => [entry.viewId, entry])).values()];
  };
  const configuredRaw = config.definition?.worldModel?.views ?? [];
  const configured = normalize(configuredRaw, 'configuration');
  const configuredById = new Map(configured.map((entry) => [entry.viewId, entry]));
  if (explicit) return normalize(String(explicit).split(','), 'CLI selection', configuredById)
    .sort((left, right) => compareText(left.viewId, right.viewId));
  const phaseRaw = phase && config.phases?.[phase]?.declaredViews?.length
    ? config.phases[phase].declaredViews : [];
  const phaseViews = normalize(phaseRaw, `phase '${phase}'`, configuredById);
  let values = phaseViews.length ? phaseViews : configured;
  if (!values.length && (phaseRaw.length || configuredRaw.length)) {
    throw new SingularityFlowError(
      'The approved World-Model configuration contains no registered WMB v4 view.',
      { code: 'WMB_VIEW_UNKNOWN', details: {
        registeredViews: all.map((entry) => entry.viewId)
      } }
    );
  }
  if (!values.length) values = all;
  return [...new Map(values.map((entry) => [entry.viewId, entry])).values()]
    .sort((left, right) => compareText(left.viewId, right.viewId));
}

/** Resolve validated registered-view references to their canonical manifest IDs. */
export function configuredWorldModelV4ViewIds(config, options = {}, phase = null) {
  return configuredWorldModelV4ViewSelections(config, options, phase).map((entry) => entry.viewId);
}

/** Resolve explicit/configured deterministic products separately from narrative views. */
export function configuredWorldModelV4ProjectionSelections(config, options = {}) {
  const explicit = optionString(options, 'projections');
  const configured = config.definition?.worldModel?.projections ?? {};
  const names = explicit
    ? String(explicit).split(',').map((value) => value.trim()).filter(Boolean)
    : Object.entries(configured).filter(([, value]) => value.enabled).map(([id]) => id);
  if (names.length === 1 && names[0] === 'none') return [];
  const selected = names.includes('all') ? Object.keys(configured) : names;
  if (names.length === 1 && names[0] === 'all' && selected.length === 0) {
    throw new SingularityFlowError(
      "WMB v4 --projections all requires at least one projection in approved worldModel.projections configuration.",
      { code: 'WMC_PROJECTION_NOT_CONFIGURED', details: { configuredProjections: [] } }
    );
  }
  if (selected.includes('all') || (names.includes('all') && names.length !== 1)) {
    throw new SingularityFlowError("WMB v4 --projections all cannot be combined with named projections.", {
      code: 'WMC_PROJECTION_NOT_CONFIGURED'
    });
  }
  return [...new Set(selected)].map((id) => {
    const policy = configured[id];
    if (!policy) {
      throw new SingularityFlowError(
        `Projection '${id}' is not declared in approved worldModel.projections configuration.`,
        { code: 'WMC_PROJECTION_NOT_CONFIGURED', details: { projectionId: id } }
      );
    }
    const contract = resolveProjectionContract(
      BUILTIN_PROJECTION_REGISTRY, policy.contract ?? `${id}@1`
    );
    return Object.freeze({
      projectionId: contract.id, reference: `${contract.id}@${contract.version}`,
      required: policy.required === true, contract, profile: Object.freeze({ ...policy.profile }),
      budgets: Object.freeze({ ...contract.budgets, ...policy.budgets }),
      validation: Object.freeze({ strict: policy.calm?.strict !== false })
    });
  }).sort((left, right) => compareText(left.projectionId, right.projectionId));
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
  const authority = worldModelStateAuthority(config.definition ?? {}, {
    branch: config.stateBranch,
    remote: config.remote
  });
  return {
    ...(config.definition?.ledger ?? {}),
    branch: authority.branch,
    remote: authority.remote
  };
}

function scopeOptions(root, config) {
  const policy = config.definition?.worldModel ?? {};
  const activeCapability = configuredWorldModelV4CapabilityId(config)
    ?? path.basename(root);
  const pinnedCapability = config.workflow?.resolution?.capability ?? null;
  const repositoryCapability = config.repositoryCapability ?? null;
  const pinnedHasExactResolution = Boolean(
    pinnedCapability?.effectiveResolution || pinnedCapability?.resolutionSha256
  );
  const selectedCapability = pinnedHasExactResolution
    ? pinnedCapability
    : (!pinnedCapability || pinnedCapability.id === repositoryCapability?.id)
      ? repositoryCapability
      : pinnedCapability;
  const effective = selectedCapability?.effectiveResolution ?? null;
  // Bind every capability component that can alter World-Model scope or trust. The full PCD
  // resolution also binds the byte-exact approved workflow; excluding that outer digest here keeps
  // semantically equivalent path spellings and unrelated workflow controls reusable.
  const effectiveCapabilitySnapshotSha256 = effective
    ? sha256({
        repository: effective.repository,
        capabilityId: effective.capability?.id ?? selectedCapability?.id ?? null,
        policySha256: effective.policySha256,
        sourceScopeSha256: effective.sourceScopeSha256,
        approvalRequirementSha256: effective.approvalRequirementSha256,
        dependencyContractSha256: effective.dependencyContractSha256,
        resolver: effective.resolver
      })
    : selectedCapability?.resolutionSha256 ?? null;
  const canonicalPatterns = (values, label) => [...new Set(values.map(
    (value, index) => normalizeScopePattern(value, `${label}[${index}]`)
  ))].sort();
  const excluded = canonicalPatterns([
    ...DEFAULT_EXCLUDED_ROOTS,
    ...(policy.excludedRoots ?? [])
  ], 'World-model excluded roots');
  const allowedPaths = policy.sourceRoots?.length
    ? canonicalPatterns(policy.sourceRoots, 'World-model source roots') : ['**'];
  const sharedPaths = canonicalPatterns(policy.sharedRoots ?? [], 'World-model shared roots');
  const allowedSubjects = policy.allowedSubjects?.length
    ? [...new Set(policy.allowedSubjects)].sort() : null;
  const maximumTraversalDepth = policy.maximumTraversalDepth ?? 8;
  // Only approved source/scope policy participates in the reusable scope identity. Read behavior,
  // staleness handling, UI injection, worker parallelism, and materialization confirmation cannot
  // change which source bytes or subjects are admissible and must not make an unchanged model stale.
  const policySnapshotSha256 = sha256({
    id: 'sflow-wmb-v4-scope-policy',
    version: 1,
    format: 'registered-v4',
    capabilityId: activeCapability,
    effectiveCapabilitySnapshotSha256,
    allowedPaths,
    sharedPaths,
    excludedPaths: excluded,
    allowedSubjects,
    maximumTraversalDepth
  });
  return {
    capabilityId: activeCapability,
    allowedPaths,
    sharedPaths,
    excludedPaths: excluded,
    ...(allowedSubjects ? { allowedSubjects } : {}),
    maximumTraversalDepth,
    policySnapshotSha256,
    policySourceSha256: policySnapshotSha256
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
    views: views ?? configuredWorldModelV4ViewSelections(
      config, options, optionString(options, 'phase')
    ).map((entry) => entry.reference),
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

/**
 * Approved WMB v4 defaults for a transport-neutral exact gateway Plan.
 *
 * The CLI and native editor surface must not each reinterpret workflow.yml. This deliberately
 * returns only engine inputs: the gateway still validates the user's bounded arguments, resolves
 * an exact source/scope Plan, and requires a separate host confirmation before any provider or
 * publication work can begin.
 */
export function worldModelV4GatewayDefaults(root, config) {
  const projections = configuredWorldModelV4ProjectionSelections(config);
  const projectionInputs = config.architectureProjectionInputs ?? null;
  return Object.freeze({
    ...commonBuildOptions(root, config, {}, {
      views: configuredWorldModelV4ViewIds(config)
    }),
    outputDir: config.outputDir,
    ledgerConfig: ledgerConfig(config),
    // This is deliberately distinct from the scope-manifest capability fallback. Only an approved
    // selected capability can be replayed as a CLI option after a gateway refusal.
    selectedCapabilityId: explicitWorldModelV4CapabilityId(config),
    sharedCacheDirectory: process.env.SINGULARITY_FLOW_WMB_SHARED_CACHE ?? null,
    allowUnavailableOptionalViews: true,
    projections,
    projectionRegistry: BUILTIN_PROJECTION_REGISTRY,
    ...(projections.length && projectionInputs ? projectionInputs : {}),
    ...(projections.length && config.architectureProjectionSetupError ? {
      projectionSetupError: config.architectureProjectionSetupError
    } : {})
  });
}

function candidateSnapshotsAllowed(config) {
  return (config.definition?.worldModel?.v4?.candidateSnapshots ?? 'allow') === 'allow';
}

async function resolvedBuildOptions(root, config, options, overrides = {}) {
  const result = commonBuildOptions(root, config, options, overrides);
  const projectionSelections = configuredWorldModelV4ProjectionSelections(config, options);
  if (projectionSelections.length) {
    try {
      if (config.architectureProjectionSetupError) {
        throw new SingularityFlowError(config.architectureProjectionSetupError.message, {
          code: config.architectureProjectionSetupError.code
        });
      }
      const inputs = config.architectureProjectionInputs
        ?? await resolveCurrentArchitectureProjectionInputs(root, config.definition);
      result.projections = projectionSelections;
      result.projectionRegistry = BUILTIN_PROJECTION_REGISTRY;
      Object.assign(result, inputs);
    } catch (error) {
      const explicit = optionString(options, 'projections') != null;
      if (explicit || projectionSelections.some((entry) => entry.required)) throw error;
      result.projections = projectionSelections;
      result.projectionRegistry = BUILTIN_PROJECTION_REGISTRY;
      result.projectionSetupError = Object.freeze({
        code: error?.code ?? 'WMC_PROJECTION_UNAVAILABLE',
        message: error?.message ?? 'Architecture projection setup is unavailable.'
      });
    }
  }
  const reference = optionString(options, 'candidate-snapshot');
  if (!reference) return result;
  if (!candidateSnapshotsAllowed(config)) {
    throw new SingularityFlowError(
      'Approved WMB v4 policy denies Candidate Snapshot use; commit the source or change worldModel.v4.candidateSnapshots through configuration review.',
      { code: 'WMB_SOURCE_SNAPSHOT_REQUIRED' }
    );
  }
  const scopeManifest = createScopeManifest(scopeOptions(root, config));
  return {
    ...result,
    candidateSnapshot: await loadCandidateSourceSnapshot(root, reference, { scopeManifest })
  };
}

function storeOptions(root, config, { views = null, options = {} } = {}) {
  const ledger = ledgerConfig(config);
  const projections = configuredWorldModelV4ProjectionSelections(config, options);
  const expectedReusableIdentity = resolveWorldModelV4ReusableIdentity(
    {
      ...commonBuildOptions(root, config, options, {
        views: views ?? configuredWorldModelV4ViewIds(config)
      }),
      projections,
      ...(projections.length
        ? architectureProjectionInputIdentity(config.architectureProjectionInputs)
        : {})
    }
  ).identity;
  return {
    outputDir: config.outputDir,
    stateBranch: ledger.branch,
    remote: ledger.remote,
    expectedReusableIdentity
  };
}

export function isWorldModelV4(config, options = {}) {
  const requested = optionString(options, 'format');
  if (requested) return ['v4', 'wmb-v4', 'registered-v4'].includes(requested);
  return config.definition?.worldModel?.format === 'registered-v4';
}

export async function planWorldModelV4Command(root, config, options) {
  const planned = planWorldModelV4(root, await resolvedBuildOptions(root, config, options));
  const result = {
    request: planned.request,
    plan: planned.plan,
    sourceSnapshot: planned.sourceSnapshot,
    scopeManifest: planned.scopeManifest,
    consumerProfile: planned.consumerProfile,
    outputBudget: planned.outputBudget,
    requestedProjections: planned.requestedProjections,
    projectionRegistry: planned.requestedProjections.length ? planned.projectionRegistry : null,
    toolchainLock: planned.toolchainLock
  };
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`WMB v4 plan ${planned.plan.planSha256}`);
    console.log(`  Source: ${planned.sourceSnapshot.subject.id}@${planned.sourceSnapshot.revision.commit}`
      + (planned.sourceSnapshot.authority ? ' · immutable Candidate Snapshot' : ''));
    console.log(`  Scope: ${planned.scopeManifest.capabilityId} · ${planned.sourceSnapshot.files.length} exact file(s)`);
    console.log(`  Views: ${planned.plan.views.map((entry) => `${entry.viewId}@${entry.viewVersion}`).join(', ')}`);
    if (planned.plan.projections?.length) {
      console.log(`  Projections: ${planned.plan.projections.map((entry) => `${entry.projectionId}@${entry.projectionVersion}`).join(', ')} · deterministic`);
    }
    console.log(`  Extractors: ${planned.plan.extractors.length} deterministic · model calls: at most ${planned.plan.estimatedWork.maximumCompositionCalls}`);
  }
  return result;
}

export async function buildWorldModelV4Command(root, config, options, {
  views = null, rebuild = false, silent = false, preserveIndependentViews = true,
  legacyMigration = null
} = {}) {
  const expectedAuthorityCommit = optionString(options, 'expected-preservation-commit');
  const expectedAuthorityManifest = optionString(
    options, 'expected-preservation-manifest-sha256'
  );
  if (Boolean(expectedAuthorityCommit) !== Boolean(expectedAuthorityManifest)) {
    throw new SingularityFlowError(
      'Automatic registered-v4 extension requires both expected preservation authority fields.',
      { code: 'WMB_AUTOMATIC_EXTENSION_AUTHORITY_INVALID' }
    );
  }
  const result = await buildAndPublishWorldModelV4(root, {
    ...await resolvedBuildOptions(root, config, options, {
      views,
      cachePolicy: rebuild ? 'rebuild' : null
    }),
    sharedCacheDirectory: optionString(options, 'shared-cache')
      ?? process.env.SINGULARITY_FLOW_WMB_SHARED_CACHE
      ?? null,
    outputDir: config.outputDir,
    ledgerConfig: ledgerConfig(config),
    publish: !optionBoolean(options, 'local'),
    publicationOptions: {},
    allowUnavailableOptionalViews: true,
    preserveIndependentViews,
    expectedPreservationAuthority: expectedAuthorityCommit ? {
      commit: expectedAuthorityCommit,
      manifestSha256: expectedAuthorityManifest
    } : null,
    ...(legacyMigration ? { legacyMigration } : {})
  });
  if (!silent && optionBoolean(options, 'json')) console.log(JSON.stringify({
    schemaVersion: result.schemaVersion,
    resultType: result.resultType,
    requestSha256: result.requestSha256,
    status: result.status,
    manifestSha256: result.manifestSha256,
    views: result.views,
    projections: result.projections ?? [],
    refusals: result.refusals,
    warnings: result.warnings,
    next: result.next,
    publication: result.publication
  }, null, 2));
  else if (!silent && result.status === 'completed') {
    const hits = result.views.filter((entry) => entry.cache === 'hit').length;
    console.log(`WMB v4 complete: ${result.views.length} view(s), ${hits} exact cache hit(s).`);
    if (result.projections?.length) {
      console.log(`  Projections: ${result.projections.map((entry) => `${entry.projectionId}=${entry.status}`).join(', ')}`);
    }
    console.log(`  Manifest: ${result.manifestSha256}`);
    console.log(result.publication
      ? `  Published atomically to ${result.publication.branch}@${result.publication.commit ?? 'current'}.`
      : '  Validated locally; no state-branch publication was requested.');
    result.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
  }
  return assertWorldModelV4BuildCompleted(result);
}

async function captureCandidateSnapshotCommand(root, config, options) {
  if (!candidateSnapshotsAllowed(config)) {
    throw new SingularityFlowError(
      'Approved WMB v4 policy denies Candidate Snapshot capture.',
      { code: 'WMB_SOURCE_SNAPSHOT_REQUIRED' }
    );
  }
  const scopeManifest = createScopeManifest(scopeOptions(root, config));
  const sourceSnapshot = await captureCandidateSourceSnapshot(root, {
    subjectId: scopeManifest.capabilityId,
    scopeManifest
  });
  const result = Object.freeze({
    status: 'captured',
    reference: sourceSnapshot.sourceManifestSha256,
    sourceSnapshot,
    baseRevision: sourceSnapshot.authority.baseRevision,
    files: sourceSnapshot.files.length,
    next: scopedWorldModelV4Command(
      config,
      `singularity-flow wm build --candidate-snapshot ${sourceSnapshot.sourceManifestSha256} --local`
    )
  });
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`WMB v4 Candidate Snapshot captured: ${result.reference}`);
    console.log(`  Base: ${result.baseRevision.commit} · ${result.files} exact in-scope file(s)`);
    console.log(`  Build: ${result.next}`);
  }
  return result;
}

function currentStore(root, config) {
  return resolvePublishedWorldModelV4(root, storeOptions(root, config));
}

function selectedStoreView(store, viewId) {
  const selection = typeof viewId === 'string'
    ? { viewId: viewId.replace(/@\d+$/, ''), version: /@(\d+)$/.exec(viewId)?.[1] ?? null }
    : viewId;
  const view = store.views.find((entry) => entry.viewId === selection.viewId);
  if (!view) {
    const error = new Error(`WMB v4 view '${selection.viewId}' is not present in the current manifest.`);
    error.code = 'WMB_VIEW_UNAVAILABLE';
    throw error;
  }
  if (selection.version != null && Number(selection.version) !== Number(view.viewVersion)) {
    const error = new Error(
      `WMB v4 view '${selection.viewId}@${selection.version}' cannot use published version ${view.viewVersion}.`
    );
    error.code = 'WMB_VIEW_VERSION_UNSUPPORTED';
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
  const requestedSelections = configuredWorldModelV4ViewSelections(config, options, phase);
  const store = suppliedStore
    ?? resolvePublishedWorldModelV4(root, {
      ...storeOptions(root, config, {
        views: requestedSelections.map((selection) => selection.reference),
        options
      }),
      required
    });
  if (!store) return null;
  // The published build request and aggregate output budget describe the invocation that created
  // the projection. They do not invalidate an independently verified phase view merely because a
  // later consumer asks for a subset (or because this projection was built for a phase subset of a
  // larger repository catalog). Source, scope, policy, registry and composer changes still stale
  // the view. This keeps `wm build --phase X` from making its own output immediately unusable.
  const requestOnlyIdentityFields = new Set(['requestedViews', 'outputBudgetSha256']);
  const projectionIdentityFields = new Set([
    'requestedProjections', 'projectionRegistrySha256', 'capabilitySnapshotSha256',
    'configurationSnapshotSha256', 'toolchainLockSha256'
  ]);
  const projectionRequired = configuredWorldModelV4ProjectionSelections(config, options)
    .some((entry) => entry.required);
  const groundingChanges = (store.freshness?.changes ?? []).filter(
    (change) => !requestOnlyIdentityFields.has(change.field)
      && (projectionRequired || !projectionIdentityFields.has(change.field))
  );
  const primaryGroundingChange = groundingChanges[0] ?? null;
  const groundingFreshness = Object.freeze({
    ...structuredClone(store.freshness),
    fresh: groundingChanges.length === 0,
    built: primaryGroundingChange?.previousSha256
      ?? store.sourceSnapshot.sourceManifestSha256,
    current: primaryGroundingChange?.currentSha256
      ?? store.sourceSnapshot.sourceManifestSha256,
    reason: primaryGroundingChange?.reason ?? null,
    changes: Object.freeze(groundingChanges.map((change) => Object.freeze({ ...change })))
  });
  const views = requestedSelections.map((selection) => {
    try {
      return selectedStoreView(store, selection);
    } catch (error) {
      if (error?.code !== 'WMB_VIEW_UNAVAILABLE') throw error;
      return Object.freeze({
        viewId: selection.viewId,
        viewVersion: selection.version,
        status: 'missing',
        required: true
      });
    }
  });
  const unavailable = views.filter((entry) => entry.status !== 'available');
  if (unavailable.length) {
    const recoveryCommand = scopedWorldModelV4Command(
      config,
      `singularity-flow wm build --format registered-v4 --views ${unavailable.map((entry) => entry.viewId).join(',')}`
    );
    // A fully verified projection for the exact current source and reusable execution identity is a
    // safe progressive-build base. Expose only its immutable authority identity: the registered-v4
    // builder resolves and revalidates that authority itself before retaining the existing bytes.
    // Stale projections receive no extension identity; corrupt, version-mismatched, and removed
    // projections fail before one can be created.
    const extensionBase = groundingFreshness.fresh ? Object.freeze({
      format: 'registered-v4',
      source: 'state-branch',
      ref: store.ref,
      commit: store.commit,
      manifestSha256: store.manifest.manifestSha256,
      sourceManifestSha256: store.sourceSnapshot.sourceManifestSha256
    }) : null;
    throw new SingularityFlowError(
      `Registered WMB v4 grounding is unavailable for: ${unavailable.map((entry) => entry.viewId).join(', ')}. `
      + `Run: ${recoveryCommand}.`,
      {
        code: 'WMB_VIEW_UNAVAILABLE',
        details: {
          phase,
          views: unavailable.map((entry) => entry.viewId),
          implicitRebuild: false,
          command: recoveryCommand,
          extensionBase
        }
      }
    );
  }
  if (!groundingFreshness.fresh && config.staleness === 'fail') {
    throw new SingularityFlowError(
      `Registered WMB v4 grounding is stale (${groundingFreshness.reason}). `
      + 'Review the source change and run an explicit WMB v4 build; phase composition will not rebuild it.',
      {
        code: 'WMB_SOURCE_SNAPSHOT_STALE',
        details: { ...groundingFreshness, implicitRebuild: false }
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
    freshness: structuredClone(groundingFreshness)
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

function worldModelHistoryKind(options) {
  const kind = optionString(options, 'kind') ?? null;
  if (kind === null) return null;
  if (!WMP_HISTORY_KINDS.includes(kind)) {
    throw new SingularityFlowError(
      `World-Model history --kind must be ${WMP_HISTORY_KINDS.join(' or ')}.`,
      {
        code: 'WMP_COMMAND_ARGUMENT_INVALID',
        details: { option: 'kind', received: kind, allowed: WMP_HISTORY_KINDS }
      }
    );
  }
  return kind;
}

function worldModelHistoryKey(value) {
  const received = String(value ?? '').trim();
  const match = WMP_HISTORY_KEY.exec(received);
  if (!match) {
    throw new SingularityFlowError(
      'Persisted World-Model history keys must be a full sha256:<64-lowercase-hex> identity (the prefix may be omitted).',
      {
        code: 'WMP_COMMAND_ARGUMENT_INVALID',
        details: { argument: 'model-key-or-view-key', received: received || null }
      }
    );
  }
  return `sha256:${match[1]}`;
}

function worldModelHistoryConfig(config) {
  const roots = validateWorldModelHistoryRoots({
    outputDir: config.outputDir,
    historyDir: config.historyDir ?? DEFAULT_WORLD_MODEL_HISTORY_DIR
  });
  return Object.freeze({
    ...roots,
    stateAuthority: worldModelStateAuthority(config.definition ?? {}, {
      branch: config.stateBranch,
      remote: config.remote
    })
  });
}

function configuredWorldModelHistoryAuthorityRef(root, config, env = process.env) {
  const { branch, remote } = worldModelHistoryConfig(config).stateAuthority;
  const explicitRef = String(branch).startsWith('refs/');
  // A configured remote makes its remote-tracking state ref the admitted read authority. Falling
  // back to refs/heads/<branch> in that case would let an unpublished local branch masquerade as
  // shared governed state. Local fallback remains available only for genuinely remote-less
  // repositories, while an explicitly configured full ref keeps its exact authored meaning.
  const remoteConfigured = !explicitRef
    && configuredRemoteIdentity(root, remote, { direction: 'fetch' }).configured;
  const candidates = explicitRef
    ? [String(branch)]
    : remoteConfigured
      ? [`refs/remotes/${remote}/${branch}`]
      : [`refs/heads/${branch}`];
  for (const ref of [...new Set(candidates)]) {
    const format = run('git', ['check-ref-format', ref], {
      cwd: root, allowFailure: true, env
    });
    if (format.status !== 0) continue;
    const present = run('git', ['show-ref', '--verify', '--quiet', ref], {
      cwd: root, allowFailure: true, env: {
        ...env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never'
      }
    });
    if (present.status === 0) return ref;
  }
  throw new SingularityFlowError(
    'The configured World-Model state-authority ref is not available locally. Refresh approved state authority before inspecting persisted history.',
    {
      code: 'WMP_AUTHORITY_REFRESH_REQUIRED',
      details: {
        branch, remote, remoteConfigured,
        command: 'singularity-flow wm refresh-authority --format registered-v4'
      }
    }
  );
}

/**
 * Enumerate only immutable key bindings already present in one exact local authority commit.
 * `ls-tree` reads the selected Git tree; GIT_NO_LAZY_FETCH prevents a partial clone from turning
 * this audit operation into an undeclared network fetch.
 */
function historyCursorFailure(message) {
  throw new SingularityFlowError(message, { code: 'WMP_HISTORY_CURSOR_INVALID' });
}

function decodeWorldModelHistoryCursor(value) {
  if (typeof value !== 'string' || value.length > 4096
      || !value.startsWith(WMP_HISTORY_CURSOR_PREFIX)
      || !/^[A-Za-z0-9_-]+$/.test(value.slice(WMP_HISTORY_CURSOR_PREFIX.length))) {
    historyCursorFailure('Persisted World-Model history cursor is not a supported bounded cursor.');
  }
  let text;
  let cursor;
  try {
    text = Buffer.from(value.slice(WMP_HISTORY_CURSOR_PREFIX.length), 'base64url').toString('utf8');
    cursor = JSON.parse(text);
  } catch {
    historyCursorFailure('Persisted World-Model history cursor is malformed.');
  }
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)
      || canonicalJson(cursor) !== text
      || Object.keys(cursor).sort().join(',') !== [
        'afterKey', 'afterKind', 'authorityCommit', 'historyDir', 'kinds', 'limit', 'version'
      ].sort().join(',')) {
    historyCursorFailure('Persisted World-Model history cursor is not canonical.');
  }
  if (cursor.version !== 1 || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(cursor.authorityCommit)
      || !Array.isArray(cursor.kinds) || !cursor.kinds.length
      || cursor.kinds.some((kind) => !WMP_HISTORY_KINDS.includes(kind))
      || [...new Set(cursor.kinds)].length !== cursor.kinds.length
      || !cursor.kinds.includes(cursor.afterKind)
      || !WMP_HISTORY_KEY.test(cursor.afterKey)
      || typeof cursor.historyDir !== 'string'
      || !Number.isSafeInteger(cursor.limit) || cursor.limit < 1
      || cursor.limit > WMP_HISTORY_LIST_MAXIMUM_PAGE_SIZE) {
    historyCursorFailure('Persisted World-Model history cursor has invalid identity fields.');
  }
  return Object.freeze(cursor);
}

function encodeWorldModelHistoryCursor({ authorityCommit, historyDir, kinds, limit, entry }) {
  return `${WMP_HISTORY_CURSOR_PREFIX}${Buffer.from(canonicalJson({
    version: 1,
    authorityCommit,
    historyDir,
    kinds: [...kinds],
    limit,
    afterKind: entry.kind,
    afterKey: entry.key
  }), 'utf8').toString('base64url')}`;
}

function worldModelHistoryPage(entries, {
  authorityCommit, historyDir, kinds, options
}) {
  const suppliedLimit = optionNumber(options, 'limit');
  if (suppliedLimit !== undefined && (!Number.isSafeInteger(suppliedLimit)
      || suppliedLimit < 1 || suppliedLimit > WMP_HISTORY_LIST_MAXIMUM_PAGE_SIZE)) {
    throw new SingularityFlowError(
      `World-Model history --limit must be an integer from 1 to ${WMP_HISTORY_LIST_MAXIMUM_PAGE_SIZE}.`,
      { code: 'WMP_HISTORY_LIMIT', details: { received: suppliedLimit, maximum: WMP_HISTORY_LIST_MAXIMUM_PAGE_SIZE } }
    );
  }
  const encodedCursor = optionString(options, 'cursor');
  const cursor = encodedCursor ? decodeWorldModelHistoryCursor(encodedCursor) : null;
  const limit = suppliedLimit ?? cursor?.limit ?? WMP_HISTORY_LIST_DEFAULT_PAGE_SIZE;
  if (cursor && (cursor.authorityCommit !== authorityCommit
      || cursor.historyDir !== historyDir
      || canonicalJson(cursor.kinds) !== canonicalJson(kinds)
      || cursor.limit !== limit)) {
    historyCursorFailure('Persisted World-Model history cursor does not match the selected authority, kind, history root, or page size.');
  }
  let start = 0;
  if (cursor) {
    const prior = entries.findIndex((entry) => entry.kind === cursor.afterKind
      && entry.key === cursor.afterKey);
    if (prior < 0) historyCursorFailure('Persisted World-Model history cursor no longer identifies its exact prior binding.');
    start = prior + 1;
  }
  const page = entries.slice(start, start + limit);
  const hasMore = start + page.length < entries.length;
  return Object.freeze({
    entries: Object.freeze(page),
    limit,
    total: entries.length,
    hasMore,
    continuation: hasMore && page.length
      ? encodeWorldModelHistoryCursor({
          authorityCommit, historyDir, kinds, limit, entry: page.at(-1)
        })
      : null
  });
}

function listPersistedWorldModelBindings(root, config, {
  authorityCommit, authorityRef, kind = null, env = process.env
} = {}) {
  const commit = resolveWorldModelHistoryAuthority(root, authorityCommit, { authorityRef, env });
  const { historyDir } = worldModelHistoryConfig(config);
  const kinds = kind ? [kind] : WMP_HISTORY_KINDS;
  const directories = {
    model: `${historyDir}/models`,
    view: `${historyDir}/views`
  };
  const localEnv = {
    ...env,
    GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never'
  };
  const listed = run('git', [
    'ls-tree', '-r', '-z', '--full-tree', '--long', commit, '--',
    ...kinds.map((entry) => directories[entry])
  ], {
    cwd: root,
    allowFailure: true,
    env: localEnv,
    maxBuffer: WMP_HISTORY_LIST_MAXIMUM_OUTPUT_BYTES
  });
  if (listed.status !== 0) {
    throw new SingularityFlowError(
      'Persisted World-Model history could not inspect the selected local authority cut.',
      {
        code: 'WMP_AUTHORITY_UNAVAILABLE',
        details: { authorityCommit: commit, historyDir }
      }
    );
  }

  const entries = String(listed.stdout ?? '').split('\0').filter(Boolean).map((row) => {
    const match = /^([0-7]{6}) ([a-z]+) ([a-f0-9]{40,64}) +([0-9]+)\t(.+)$/.exec(row);
    if (!match) {
      throw new SingularityFlowError(
        'Persisted World-Model history contains an unsupported Git tree entry.',
        { code: 'WMP_INTEGRITY_FAILED', details: { authorityCommit: commit } }
      );
    }
    const [, mode, type, oid, byteText, relativePath] = match;
    const selectedKind = kinds.find((entry) => relativePath.startsWith(`${directories[entry]}/`));
    const expected = selectedKind
      ? new RegExp(`^${directories[selectedKind].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([a-f0-9]{64})\\.json$`).exec(relativePath)
      : null;
    const bytes = Number(byteText);
    if (!selectedKind || !expected || mode !== '100644' || type !== 'blob'
        || !Number.isSafeInteger(bytes) || bytes < 1) {
      throw new SingularityFlowError(
        `Persisted World-Model history binding has an invalid path or Git object: ${relativePath}.`,
        {
          code: 'WMP_INTEGRITY_FAILED',
          details: { authorityCommit: commit, path: relativePath, mode, type }
        }
      );
    }
    return Object.freeze({
      kind: selectedKind,
      key: `sha256:${expected[1]}`,
      path: relativePath,
      bytes,
      gitObject: oid
    });
  }).sort((left, right) => compareText(`${left.kind}\0${left.key}`, `${right.kind}\0${right.key}`));

  if (entries.length > WMP_HISTORY_LIST_MAXIMUM_BINDINGS) {
    throw new SingularityFlowError(
      `Persisted World-Model history contains more than ${WMP_HISTORY_LIST_MAXIMUM_BINDINGS} bindings.`,
      {
        code: 'WMP_HISTORY_LIMIT',
        details: {
          authorityCommit: commit,
          observed: entries.length,
          maximum: WMP_HISTORY_LIST_MAXIMUM_BINDINGS
        }
      }
    );
  }

  return Object.freeze({
    resultType: 'world-model-history-list',
    authorityCommit: commit,
    authorityRef,
    historyDir,
    kinds: Object.freeze([...kinds]),
    count: entries.length,
    entries: Object.freeze(entries)
  });
}

function renderWorldModelHistoryList(result, options) {
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else if (!result.entries.length) {
    console.log(`No persisted World-Model ${result.kinds.join(' or ')} bindings exist at ${result.authorityCommit}.`);
  } else {
    console.log(`Persisted World-Model history at ${result.authorityCommit}: ${result.count} of ${result.total} binding(s)`);
    result.entries.forEach((entry) => console.log(
      `  ${entry.kind.padEnd(5)}  ${entry.key}  ${entry.bytes} bytes`
    ));
    if (result.continuation) console.log(`  Continue with: --cursor ${result.continuation}`);
  }
  return result;
}

function persistedHistoryResult(resolved, kind, key) {
  return Object.freeze({
    resultType: 'world-model-history-binding',
    authorityCommit: resolved.authorityCommit,
    authorityRef: resolved.authorityRef,
    historyDir: resolved.historyDir,
    kind,
    key,
    bindingPath: resolved.bindingPath,
    bindingByteSha256: resolved.bindingByteSha256,
    bindingBytes: resolved.bindingBytes.length,
    binding: structuredClone(resolved.binding),
    closure: Object.freeze(resolved.closure.map((entry) => Object.freeze({
      ref: structuredClone(entry.ref),
      recordKind: entry.record?.kind ?? null,
      schemaVersion: entry.record?.schemaVersion ?? null,
      verified: true
    }))),
    closureObjects: resolved.closure.length,
    totalBytes: resolved.totalBytes
  });
}

function renderWorldModelHistoryBinding(result, options) {
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Persisted World-Model ${result.kind} verified: ${result.key}`);
    console.log(`  Authority: ${result.authorityRef} @ ${result.authorityCommit}`);
    console.log(`  Binding: ${result.bindingPath} · ${result.bindingByteSha256}`);
    console.log(`  Closure: ${result.closureObjects} exact object(s) · ${result.totalBytes} bytes`);
  }
  return result;
}

export function historyWorldModelV4Command(root, config, positionals, options) {
  if (optionString(options, 'branch')) {
    throw new SingularityFlowError(
      'Persisted World-Model history reads do not open or synchronize another branch. Select an exact locally available authority with --authority-commit.',
      { code: 'WMP_AUTHORITY_CUT_REQUIRED' }
    );
  }
  const action = positionals[2] ?? 'list';
  const authorityCommit = requiredValue(
    optionString(options, 'authority-commit'),
    `singularity-flow wm history ${action}${action === 'show' ? ' <model-key-or-view-key>' : ''} --authority-commit <full-commit> [--kind model|view] [--json]`
  );
  const kind = worldModelHistoryKind(options);
  const authorityRef = configuredWorldModelHistoryAuthorityRef(root, config);
  if (action === 'list') {
    const listed = listPersistedWorldModelBindings(root, config, {
      authorityCommit, authorityRef, kind
    });
    const page = worldModelHistoryPage(listed.entries, {
      authorityCommit: listed.authorityCommit,
      historyDir: listed.historyDir,
      kinds: listed.kinds,
      options
    });
    return renderWorldModelHistoryList(Object.freeze({
      ...listed,
      entries: page.entries,
      count: page.entries.length,
      limit: page.limit,
      total: page.total,
      hasMore: page.hasMore,
      continuation: page.continuation
    }), options);
  }
  if (action !== 'show') {
    throw new SingularityFlowError(
      `Unknown World-Model history action '${action}'. Available: list, show.`,
      {
        code: 'UNKNOWN_SUBCOMMAND',
        details: { command: 'wm history', action, available: ['list', 'show'] }
      }
    );
  }
  const key = worldModelHistoryKey(requiredValue(
    positionals[3],
    'singularity-flow wm history show <model-key-or-view-key> --authority-commit <full-commit> [--kind model|view] [--json]'
  ));
  let selectedKind = kind;
  if (selectedKind === null) {
    const candidates = listPersistedWorldModelBindings(root, config, {
      authorityCommit, authorityRef
    }).entries
      .filter((entry) => entry.key === key);
    if (candidates.length > 1) {
      throw new SingularityFlowError(
        `Persisted World-Model key '${key}' identifies both a model and a view; select --kind model or --kind view.`,
        {
          code: 'WMP_SELECTION_AMBIGUOUS',
          details: {
            authorityCommit,
            key,
            candidates: candidates.map((entry) => ({ kind: entry.kind, path: entry.path }))
          }
        }
      );
    }
    if (!candidates.length) {
      throw new SingularityFlowError(
        `No persisted World-Model model or view binding exists for '${key}' at the selected authority cut.`,
        {
          code: 'WMP_MODEL_MISSING',
          details: { authorityCommit, key, searchedKinds: WMP_HISTORY_KINDS }
        }
      );
    }
    selectedKind = candidates[0].kind;
  }
  const resolved = selectedKind === 'model'
    ? resolvePersistedWorldModel(root, {
        authorityCommit, authorityRef, modelKey: key,
        outputDir: worldModelHistoryConfig(config).outputDir,
        historyDir: worldModelHistoryConfig(config).historyDir
      })
    : resolvePersistedWorldModelView(root, {
        authorityCommit, authorityRef, viewKey: key,
        outputDir: worldModelHistoryConfig(config).outputDir,
        historyDir: worldModelHistoryConfig(config).historyDir
      });
  return renderWorldModelHistoryBinding(
    persistedHistoryResult(resolved, selectedKind, key), options
  );
}

function viewContractCommand(options, viewId) {
  const contract = normalizeBuiltInViewReference(viewId).contract;
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
    root, config, { ...options, local: true }, {
      views: [viewId], rebuild: true, silent: true,
      legacyMigration: { legacyView: legacy, targetViewId: viewId }
    }
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
  if (command === 'snapshot') return captureCandidateSnapshotCommand(root, config, options);
  if (command === 'history') return historyWorldModelV4Command(
    root, config, positionals, options
  );
  if (command === 'build') return buildWorldModelV4Command(root, config, options);
  if (command === 'status' || command === 'availability') return statusWorldModelV4Command(root, config, options);
  if (command === 'refresh-authority') {
    const refreshed = await refreshWorldModelV4Authority(root, config);
    if (['offline-cached', 'timeout-cached', 'unavailable'].includes(refreshed.status)) {
      throw new SingularityFlowError(
        'The registered World-Model state authority was not refreshed. Restore remote access and retry the same command.',
        {
          code: 'WMB_STATE_AUTHORITY_UNAVAILABLE',
          details: {
            status: refreshed.status,
            classification: refreshed.failure ?? null,
            command: scopedWorldModelV4Command(
              config, 'singularity-flow wm refresh-authority --format registered-v4'
            )
          }
        }
      );
    }
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(refreshed, null, 2));
    else if (refreshed.status === 'refreshed') {
      console.log(`World-Model state authority refreshed at ${refreshed.commit ?? 'an empty state branch'}.`);
    } else if (refreshed.status === 'remote-absent') {
      console.log('The remote state branch has no World Model; any stale tracking projection was cleared.');
    } else {
      console.log('No remote World-Model state authority is configured; local authority is unchanged.');
    }
    return refreshed;
  }
  if (command === 'ensure') {
    const phase = positionals[2] ?? optionString(options, 'phase');
    const authority = await inspectWorldModelV4Authority(root, config);
    if (authority.status === 'stale') {
      throw new SingularityFlowError(
        'The cached registered World-Model authority is behind the configured remote state branch.',
        {
          code: 'WMB_STATE_AUTHORITY_REFRESH_REQUIRED',
          details: {
            cachedCommit: authority.cachedCommit,
            remoteCommit: authority.remoteCommit,
            command: scopedWorldModelV4Command(
              config, 'singularity-flow wm refresh-authority --format registered-v4'
            )
          }
        }
      );
    }
    if (authority.status === 'remote-absent') {
      throw new SingularityFlowError(
        'The configured remote state branch has no registered World Model. Cached or local projections cannot override that authority.',
        {
          code: 'WMB_MANIFEST_MISSING',
          details: {
            command: scopedWorldModelV4Command(
              config, 'singularity-flow wm build --format registered-v4'
            ),
            remoteModelRemoved: true
          }
        }
      );
    }
    if (authority.status === 'unavailable') {
      throw new SingularityFlowError(
        'The registered World-Model authority is unavailable and no verified cached projection can be used.',
        {
          code: 'WMB_STATE_AUTHORITY_UNAVAILABLE',
          details: {
            command: scopedWorldModelV4Command(
              config, 'singularity-flow wm refresh-authority --format registered-v4'
            )
          }
        }
      );
    }
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
      ids = configuredWorldModelV4ViewIds(config);
    } else ids = [requiredValue(
      positionals[2], 'singularity-flow wm regenerate <view-id> [--json]'
    )];
    return buildWorldModelV4Command(root, config, options, {
      views: ids,
      rebuild: true,
      preserveIndependentViews: !optionBoolean(options, 'stale')
    });
  }
  if (command === 'context') return contextCommand(root, config, options, positionals[2] ?? optionString(options, 'phase'));
  if (command === 'doctor') {
    let store = null;
    let state = 'not-built';
    let detail = null;
    try { store = resolvePublishedWorldModelV4(root, { ...storeOptions(root, config), required: false }); state = store ? 'valid' : state; }
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
  'plan', 'snapshot', 'build', 'status', 'availability', 'ensure', 'refresh-authority', 'manifest', 'show', 'facts', 'evidence',
  'derivation', 'validate', 'check', 'validate-view', 'verify-cache', 'regenerate',
  'views', 'view-contract', 'extractors', 'doctor', 'context', 'migrate', 'history'
]));
