import path from 'node:path';

import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { SingularityFlowError } from '../util.mjs';
import { sealRecord, sha256 } from './canonicalize.mjs';
import { createScopeManifest } from './scope/manifest.mjs';
import {
  assertInstalledExtractorRegistry, BUILTIN_EXTRACTOR_REGISTRY, DEFAULT_EXTRACTOR_REFERENCES
} from './registry/extractors.mjs';
import {
  assertInstalledViewRegistry, BUILTIN_VIEW_REGISTRY, resolveViewContract
} from './registry/views.mjs';
import { createExactSourceSnapshot, verifyExactSourceSnapshot } from './source/snapshot.mjs';

const CONSUMERS = new Set([
  'developer', 'architect', 'tester', 'business', 'operations', 'security', 'release'
]);
const DEPTHS = new Set(['quick', 'standard', 'deep']);
const CACHE_POLICIES = new Set(['reuse-valid', 'rebuild']);

function schemaRecord(family, value) {
  return Object.freeze(readRecord(family, value).record);
}

function normalizedViews(viewRegistry, values, { required = true } = {}) {
  if (!Array.isArray(values) || !values.length) {
    throw new SingularityFlowError('A WMB v4 build requires at least one registered view.', {
      code: 'WMB_VIEW_UNKNOWN'
    });
  }
  const requested = values.map((entry) => typeof entry === 'string'
    ? { viewId: entry.replace(/@\d+$/, ''), reference: entry.includes('@') ? entry : `${entry}@4`, required }
    : {
        viewId: String(entry?.viewId ?? '').replace(/@\d+$/, ''),
        reference: entry?.version
          ? `${String(entry.viewId).replace(/@\d+$/, '')}@${entry.version}`
          : String(entry?.viewId ?? '').includes('@') ? String(entry.viewId) : `${entry?.viewId}@4`,
        required: entry?.required !== false
      });
  const unique = new Map();
  for (const entry of requested) {
    let contract;
    try { contract = resolveViewContract(viewRegistry, entry.reference); }
    catch (error) {
      throw new SingularityFlowError(error.message, {
        code: error.code === 'WMB_VIEW_NOT_ACTIVE' ? 'WMB_VIEW_REVOKED' : 'WMB_VIEW_UNKNOWN',
        details: error.details
      });
    }
    const prior = unique.get(contract.id);
    if (prior && prior.contract.version !== contract.version) {
      throw new SingularityFlowError(`View '${contract.id}' was requested with conflicting versions.`, {
        code: 'WMB_VIEW_VERSION_UNSUPPORTED'
      });
    }
    unique.set(contract.id, {
      viewId: contract.id,
      required: prior?.required === true || entry.required,
      contract
    });
  }
  return [...unique.values()].sort((left, right) => left.viewId.localeCompare(right.viewId));
}

export function createWorldModelConsumerProfile({
  consumer = 'developer', depth = 'standard', terminology = 'source-native',
  includeUnavailable = true, includeContradictions = true, maximumExamples = 5
} = {}) {
  if (!CONSUMERS.has(consumer)) {
    throw new SingularityFlowError(`Unknown WMB v4 consumer '${consumer}'.`, { code: 'WMB_CONSUMER_INVALID' });
  }
  if (!DEPTHS.has(depth)) {
    throw new SingularityFlowError(`Unknown WMB v4 depth '${depth}'.`, { code: 'WMB_DEPTH_INVALID' });
  }
  const base = {
    schemaVersion: currentSchemaVersion('world-model-consumer-profile'),
    kind: 'world-model-consumer-profile',
    consumer,
    depth,
    preferences: {
      terminology,
      includeUnavailable: Boolean(includeUnavailable),
      includeContradictions: Boolean(includeContradictions),
      maximumExamples
    }
  };
  return schemaRecord('world-model-consumer-profile', sealRecord(base, 'profileSha256'));
}

export function createWorldModelOutputBudget(contracts, { totalMaximumOutputTokens = null } = {}) {
  const sorted = [...contracts].sort((left, right) => left.id.localeCompare(right.id));
  const viewBudgets = Object.fromEntries(sorted.map((contract) => [contract.id, {
    maximumNarrativeWords: contract.narrative.totalMaximumWords,
    maximumSelectedFacts: contract.facts.maximumSelectedFacts,
    maximumOutputTokens: contract.budgets.maximumOutputTokens
  }]));
  const requiredTotal = sorted.reduce((sum, contract) => sum + contract.budgets.maximumOutputTokens, 0);
  const total = totalMaximumOutputTokens ?? requiredTotal;
  if (!Number.isSafeInteger(total) || total < 1) {
    throw new SingularityFlowError('WMB v4 total output budget must be a positive integer.', {
      code: 'WMB_OUTPUT_BUDGET_EXCEEDED'
    });
  }
  // Independent view cache identities cannot safely share a floating remainder. Until a reviewed
  // deterministic allocator exists, refuse an aggregate ceiling that cannot cover every admitted
  // per-view ceiling; this enforces the total before any provider fan-out and preserves reuse.
  if (total < requiredTotal) {
    throw new SingularityFlowError(
      `WMB v4 total output budget ${total} cannot cover the ${requiredTotal} tokens required by the selected independent views.`,
      {
        code: 'WMB_OUTPUT_BUDGET_EXCEEDED',
        details: { totalMaximumOutputTokens: total, minimumRequiredTokens: requiredTotal }
      }
    );
  }
  const base = {
    schemaVersion: currentSchemaVersion('world-model-output-budget'),
    kind: 'world-model-output-budget',
    viewBudgets,
    totalMaximumOutputTokens: total,
    overflowPolicy: [
      'omit-optional-facts', 'shorten-narrative', 'split-view',
      'route-larger-context', 'refuse'
    ]
  };
  return schemaRecord('world-model-output-budget', sealRecord(base, 'budgetSha256'));
}

/**
 * Project an operation-level budget into the exact budget supplied to one independent view.
 *
 * A view cache identity must not change merely because unrelated views were requested in the
 * same operation. The operation-wide total can still lower a single view's ceiling, but it must
 * never make that view depend on another view's budget entry.
 */
export function createWorldModelViewOutputBudget(outputBudget, contract) {
  const registered = outputBudget?.viewBudgets?.[contract.id];
  if (!registered) {
    throw new SingularityFlowError(`WMB v4 output budget does not contain view '${contract.id}'.`, {
      code: 'WMB_OUTPUT_BUDGET_EXCEEDED'
    });
  }
  const maximumOutputTokens = Math.min(
    registered.maximumOutputTokens,
    outputBudget.totalMaximumOutputTokens
  );
  const base = {
    schemaVersion: currentSchemaVersion('world-model-output-budget'),
    kind: 'world-model-output-budget',
    viewBudgets: {
      [contract.id]: {
        maximumNarrativeWords: registered.maximumNarrativeWords,
        maximumSelectedFacts: registered.maximumSelectedFacts,
        maximumOutputTokens
      }
    },
    totalMaximumOutputTokens: maximumOutputTokens,
    overflowPolicy: [...outputBudget.overflowPolicy]
  };
  return schemaRecord('world-model-output-budget', sealRecord(base, 'budgetSha256'));
}

export function createWorldModelBuildRequest({
  sourceSnapshot,
  scopeManifest,
  requestedViews,
  viewRegistry = BUILTIN_VIEW_REGISTRY,
  extractorRegistry = BUILTIN_EXTRACTOR_REGISTRY,
  consumerProfile,
  outputBudget,
  policySnapshotSha256,
  cachePolicy = 'reuse-valid'
}) {
  if (!CACHE_POLICIES.has(cachePolicy)) {
    throw new SingularityFlowError(`Unknown WMB v4 cache policy '${cachePolicy}'.`, { code: 'WMB_CACHE_POLICY_INVALID' });
  }
  const viewRequests = requestedViews.map(({ viewId, required }) => ({ viewId, required }));
  const identity = {
    sourceManifestSha256: sourceSnapshot.sourceManifestSha256,
    scopeManifestSha256: scopeManifest.scopeSha256,
    views: viewRequests,
    policySnapshotSha256,
    viewRegistrySha256: viewRegistry.registrySha256,
    extractorRegistrySha256: extractorRegistry.registrySha256,
    composerProfileSha256: consumerProfile.profileSha256,
    outputBudgetSha256: outputBudget.budgetSha256,
    cachePolicy
  };
  const base = {
    schemaVersion: currentSchemaVersion('world-model-build-request'),
    kind: 'world-model-build-request',
    requestId: `WMB-REQ-${sha256(identity).slice('sha256:'.length, 'sha256:'.length + 24)}`,
    source: {
      subjectKind: sourceSnapshot.subject.kind,
      subjectId: sourceSnapshot.subject.id,
      snapshotRef: `sfref:source-snapshot:${sourceSnapshot.sourceManifestSha256.slice('sha256:'.length)}`,
      snapshotSha256: sourceSnapshot.sourceManifestSha256,
      commit: sourceSnapshot.revision.commit
    },
    scopeManifestSha256: scopeManifest.scopeSha256,
    requestedViews: viewRequests,
    policySnapshotSha256,
    viewRegistrySha256: viewRegistry.registrySha256,
    extractorRegistrySha256: extractorRegistry.registrySha256,
    composerProfileSha256: consumerProfile.profileSha256,
    outputBudgetSha256: outputBudget.budgetSha256,
    consistency: 'exact',
    cachePolicy
  };
  return schemaRecord('world-model-build-request', sealRecord(base, 'requestSha256'));
}

export function createWorldModelBuildPlan({
  request,
  sourceSnapshot,
  scopeManifest,
  requestedViews,
  extractorReferences = DEFAULT_EXTRACTOR_REFERENCES,
  outputBudget
}) {
  const contracts = requestedViews.map((entry) => entry.contract);
  const factRequirements = [...new Set(contracts.flatMap((contract) => [
    ...contract.factPolicy.requiredFactTypes,
    ...contract.factPolicy.requiredUnavailableSubjects
  ]))].sort();
  const bodyAccess = contracts.filter((contract) => contract.bodyAccess.allowed).map((contract) => contract.id).sort();
  const base = {
    schemaVersion: currentSchemaVersion('world-model-build-plan'),
    kind: 'world-model-build-plan',
    requestSha256: request.requestSha256,
    sourceManifestSha256: sourceSnapshot.sourceManifestSha256,
    scopeManifestSha256: scopeManifest.scopeSha256,
    views: requestedViews.map(({ contract, required }) => ({
      viewId: contract.id,
      viewVersion: contract.version,
      viewSpecSha256: contract.contractSha256,
      required,
      // Full cache identity includes the selected Fact Ledger and is resolved after extraction.
      cacheStatus: request.cachePolicy === 'rebuild' ? 'stale' : 'miss'
    })),
    extractors: [...extractorReferences].sort(),
    factRequirements,
    bodyAccess,
    budgets: {
      totalMaximumOutputTokens: outputBudget.totalMaximumOutputTokens,
      maximumViewOutputTokens: Math.max(...contracts.map((contract) => contract.budgets.maximumOutputTokens))
    },
    estimatedWork: {
      sourceFiles: sourceSnapshot.files.length,
      views: contracts.length,
      deterministicExtractors: extractorReferences.length,
      maximumCompositionCalls: contracts.filter((contract) => contract.model.mode !== 'never').length
    }
  };
  return schemaRecord('world-model-build-plan', sealRecord(base, 'planSha256'));
}

/**
 * Resolve the policy-controlled portion of a WMB v4 build identity without reading source bytes.
 *
 * Store/status consumers use this to compare a published projection with the currently approved
 * configuration. Keeping this in the planner prevents status and build from interpreting scope,
 * view, consumer, and budget policy differently.
 */
export function resolveWorldModelV4ReusableIdentity({
  views,
  required = true,
  consumer = 'developer',
  depth = 'standard',
  capabilityId,
  allowedPaths = ['**'],
  sharedPaths = [],
  excludedPaths = [
    '.git/**', '.sflow/**', '.singularity-flow/**', 'singularity/**', '.github/agents/**'
  ],
  allowedSubjects,
  maximumTraversalDepth = 8,
  policySnapshotSha256 = sha256({ id: 'sflow-wmb-v4-policy', version: 1 }),
  totalMaximumOutputTokens = null,
  viewRegistry = BUILTIN_VIEW_REGISTRY,
  extractorRegistry = BUILTIN_EXTRACTOR_REGISTRY
} = {}) {
  viewRegistry = assertInstalledViewRegistry(viewRegistry);
  extractorRegistry = assertInstalledExtractorRegistry(extractorRegistry);
  const scopeManifest = createScopeManifest({
    capabilityId,
    allowedPaths,
    sharedPaths,
    excludedPaths,
    ...(allowedSubjects ? { allowedSubjects } : {}),
    maximumTraversalDepth,
    // The scope is not reusable after its approved policy source changes, even when its literal
    // path arrays happen to remain the same.
    policySourceSha256: policySnapshotSha256
  });
  const requestedViews = normalizedViews(viewRegistry, views, { required });
  const consumerProfile = createWorldModelConsumerProfile({ consumer, depth });
  const outputBudget = createWorldModelOutputBudget(
    requestedViews.map((entry) => entry.contract), { totalMaximumOutputTokens }
  );
  return Object.freeze({
    scopeManifest,
    requestedViews,
    consumerProfile,
    outputBudget,
    identity: Object.freeze({
      scopeManifestSha256: scopeManifest.scopeSha256,
      policySnapshotSha256,
      requestedViews: Object.freeze(requestedViews.map(({ contract, required: viewRequired }) =>
        Object.freeze({
          viewId: contract.id,
          viewVersion: contract.version,
          viewSpecSha256: contract.contractSha256,
          required: viewRequired
        }))),
      viewRegistrySha256: viewRegistry.registrySha256,
      extractorRegistrySha256: extractorRegistry.registrySha256,
      composerProfileSha256: consumerProfile.profileSha256,
      outputBudgetSha256: outputBudget.budgetSha256
    })
  });
}

/** Resolve a mutation-free WMB v4 plan from exact Git source and explicit policy. */
export function planWorldModelV4(root, {
  views,
  required = true,
  consumer = 'developer',
  depth = 'standard',
  capabilityId = path.basename(path.resolve(root)),
  allowedPaths = ['**'],
  sharedPaths = [],
  excludedPaths = [
    '.git/**', '.sflow/**', '.singularity-flow/**', 'singularity/**', '.github/agents/**'
  ],
  allowedSubjects,
  maximumTraversalDepth = 8,
  policySnapshotSha256 = sha256({ id: 'sflow-wmb-v4-policy', version: 1 }),
  cachePolicy = 'reuse-valid',
  totalMaximumOutputTokens = null,
  viewRegistry = BUILTIN_VIEW_REGISTRY,
  extractorRegistry = BUILTIN_EXTRACTOR_REGISTRY,
  extractorReferences = DEFAULT_EXTRACTOR_REFERENCES,
  candidateSnapshot = null
} = {}) {
  const reusable = resolveWorldModelV4ReusableIdentity({
    views,
    required,
    consumer,
    depth,
    capabilityId,
    allowedPaths,
    sharedPaths,
    excludedPaths,
    ...(allowedSubjects ? { allowedSubjects } : {}),
    maximumTraversalDepth,
    policySnapshotSha256,
    totalMaximumOutputTokens,
    viewRegistry,
    extractorRegistry
  });
  const {
    scopeManifest, requestedViews, consumerProfile, outputBudget
  } = reusable;
  // Dirty bytes are never selected implicitly. A caller must first capture a content-addressed
  // Candidate Snapshot and supply that exact record/ref through the public command boundary.
  const sourceSnapshot = candidateSnapshot
    ? verifyExactSourceSnapshot(root, candidateSnapshot, { scopeManifest })
    : createExactSourceSnapshot(root, { scopeManifest });
  const request = createWorldModelBuildRequest({
    sourceSnapshot,
    scopeManifest,
    requestedViews,
    viewRegistry,
    extractorRegistry,
    consumerProfile,
    outputBudget,
    policySnapshotSha256,
    cachePolicy
  });
  const plan = createWorldModelBuildPlan({
    request,
    sourceSnapshot,
    scopeManifest,
    requestedViews,
    extractorReferences,
    outputBudget
  });
  return Object.freeze({
    request,
    plan,
    sourceSnapshot,
    scopeManifest,
    requestedViews,
    consumerProfile,
    outputBudget,
    viewRegistry,
    extractorRegistry,
    extractorReferences: Object.freeze([...extractorReferences])
  });
}

export function resolveWorldModelV4Views(values, options = {}) {
  return normalizedViews(options.viewRegistry ?? BUILTIN_VIEW_REGISTRY, values, options);
}
