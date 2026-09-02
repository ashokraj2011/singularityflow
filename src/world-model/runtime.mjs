import path from 'node:path';
import { types as utilTypes } from 'node:util';

import { gitCommonDir } from '../git.mjs';
import { invokeModel } from '../model-runner.mjs';
import { writeImmutablePrivateSidecar } from '../private-sidecar.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { withSubjectLock } from '../subject-lock.mjs';
import { SingularityFlowError } from '../util.mjs';
import { readWorldModelViewCache, writeWorldModelViewCache } from './cache.mjs';
import { canonicalJson, sealRecord, sha256 } from './canonicalize.mjs';
import { assembleWmbV4Prompt } from './compose/pinned-core.mjs';
import { renderDeterministicCandidate } from './compose/candidate.mjs';
import { assertSelfHash } from './contracts.mjs';
import { validateDerivationCatalog } from './extract/derivation-catalog.mjs';
import { validateEvidenceCatalog } from './extract/evidence-catalog.mjs';
import { validateFactLedger } from './extract/fact-ledger.mjs';
import { runDeterministicRegistration } from './extract/index.mjs';
import { validateViewFactLedger } from './extract/selection.mjs';
import { materializeWorldModelView, usageObservation } from './materialize/view.mjs';
import { augmentRegistrationForLegacyMigration } from './migration/v3-to-v4.mjs';
import { parseWorldModelViewKernelStamp } from './materialize/stamp.mjs';
import { createWorldModelViewOutputBudget, planWorldModelV4 } from './plan.mjs';
import { assertInstalledExtractorRegistry } from './registry/extractors.mjs';
import { assertInstalledViewRegistry, validateViewContract } from './registry/views.mjs';
import { worldModelRefusal } from './refusal.mjs';
import {
  WMB_V4_FAILED_VIEW_RETRY_POLICY, assertWorldModelViewRetryBinding,
  assertWorldModelViewRetryLineage,
  createWorldModelViewRetryBinding, createWorldModelViewRetryMetadata,
  createWorldModelViewRetryReceipt, isWorldModelViewRetryableCode,
  readWorldModelViewRetryReceiptForRefusal, storeWorldModelViewRetryReceipt,
  validateWorldModelViewRetryRefusal
} from './retry.mjs';
import {
  hydrateLocalWorldModelViewCacheFromShared,
  publishWorldModelViewToSharedCache
} from './shared-cache.mjs';
import { verifyExactSourceSnapshot } from './source/snapshot.mjs';
import {
  validateCompositionCandidate, WMB_V4_CANDIDATE_SCHEMA_SHA256,
  WMB_V4_VALIDATOR_SHA256
} from './validate/candidate.mjs';

export { WMB_V4_CANDIDATE_SCHEMA_SHA256, WMB_V4_VALIDATOR_SHA256 };
export const WMB_V4_DETERMINISTIC_EXECUTION_SHA256 = sha256({
  kind: 'world-model-composer-execution-profile',
  id: 'deterministic-renderer',
  version: 1,
  model: 'never'
});

const MAXIMUM_DERIVED_OBJECT_BYTES = 64 * 1024 * 1024;

function executionProfileSha256({ route, provider = null, model = null }) {
  return route === 'deterministic'
    ? null
    : sha256({
        kind: 'world-model-composer-execution-profile',
        id: 'governed-model-composer',
        version: 1,
        provider,
        model: model ?? 'provider-auto',
        tools: 'none'
      });
}

function executionUnitManifestSha256({ route, provider = null, model = null }) {
  return route === 'deterministic'
    ? WMB_V4_DETERMINISTIC_EXECUTION_SHA256
    : sha256({
        kind: 'world-model-execution-unit-manifest',
        id: 'wmb-v4-composer',
        version: '1.0.0',
        route,
        provider,
        requestedModel: model ?? 'provider-auto',
        toolPolicy: { mode: 'none' }
      });
}

function createViewExecution({
  requestSha256,
  contract,
  route,
  provider,
  model,
  contextManifest,
  viewFactLedger,
  status,
  candidateSha256,
  validationReceiptSha256,
  publishedViewSha256,
  usageObservationSha256
}) {
  const base = {
    schemaVersion: currentSchemaVersion('world-model-view-execution'),
    kind: 'world-model-view-execution',
    requestSha256,
    viewId: contract.id,
    viewVersion: contract.version,
    executionUnitManifestSha256: executionUnitManifestSha256({ route, provider, model }),
    contextManifestSha256: contextManifest.manifestSha256,
    viewFactLedgerSha256: viewFactLedger.ledgerSha256,
    status,
    candidateSha256,
    validationReceiptSha256,
    publishedViewSha256,
    usageObservationSha256
  };
  return Object.freeze(readRecord(
    'world-model-view-execution', sealRecord(base, 'executionSha256')
  ).record);
}

function derivedObjectPath(root, kind, digest) {
  const value = String(digest ?? '').replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new SingularityFlowError(`WMB v4 ${kind} has an invalid content identity.`, {
      code: 'WMB_DERIVED_OBJECT_INVALID'
    });
  }
  return path.join(
    gitCommonDir(root), 'singularity-flow', 'world-model-cache', 'v4', 'objects',
    kind, value.slice(0, 2), `${value}.json`
  );
}

/** Preserve deterministic registration even when every narrative composition fails. */
async function preserveRegisteredFacts(root, registration) {
  const objects = [
    ['evidence-catalogs', registration.evidenceCatalog.catalogSha256, registration.evidenceCatalog],
    ['derivation-catalogs', registration.derivationCatalog.catalogSha256, registration.derivationCatalog],
    ['fact-ledgers', registration.factLedger.ledgerSha256, registration.factLedger],
    ...registration.viewFactLedgers.map((ledger) => [
      'view-fact-ledgers', ledger.ledgerSha256, ledger
    ])
  ];
  return Promise.all(objects.map(async ([kind, digest, value]) => {
    const target = derivedObjectPath(root, kind, digest);
    const publication = await writeImmutablePrivateSidecar(
      root, target, Buffer.from(canonicalJson(value), 'utf8'),
      { maximumBytes: MAXIMUM_DERIVED_OBJECT_BYTES }
    );
    return Object.freeze({ kind, digest, path: target, written: publication.created });
  }));
}

function routeForContract(contract, composer) {
  if (contract.model.mode === 'never') return 'deterministic';
  if (contract.model.mode === 'required') return 'model';
  if (composer === 'model') return 'model';
  if (!['auto', 'deterministic'].includes(composer)) {
    throw new SingularityFlowError(`Unknown WMB v4 composer '${composer}'.`, {
      code: 'WMB_COMPOSER_INVALID'
    });
  }
  // The registered built-ins provide a deterministic renderer. Per §49 it takes precedence when
  // valid, keeping ordinary builds model-free and exactly reproducible.
  return 'deterministic';
}

async function composeWithModel(root, prompt, contract, viewOutputBudget, {
  provider,
  providerConfig,
  model = null,
  timeoutMs = 10 * 60 * 1000
}) {
  if (!provider) {
    throw new SingularityFlowError(
      `View '${contract.id}' requires model composition, but no governed provider is configured.`,
      { code: 'WMB_EXECUTION_UNIT_UNAVAILABLE' }
    );
  }
  const estimatedInputTokens = Math.ceil(Buffer.byteLength(prompt, 'utf8') / 4);
  if (estimatedInputTokens > contract.budgets.maximumInputTokens) {
    throw new SingularityFlowError(
      `View '${contract.id}' requires an estimated ${estimatedInputTokens} input tokens, above its registered ${contract.budgets.maximumInputTokens}-token ceiling.`,
      {
        code: 'WMB_OUTPUT_BUDGET_EXCEEDED',
        details: { estimatedInputTokens, maximumInputTokens: contract.budgets.maximumInputTokens }
      }
    );
  }
  const maximumOutputTokens = viewOutputBudget.viewBudgets[contract.id].maximumOutputTokens;
  return invokeModel({
    provider,
    providerConfig,
    ...(model ? { model } : {}),
    cwd: root,
    allowedRoots: [root],
    prompt: { text: prompt },
    channel: 'world-model-view-composition',
    subject: { kind: 'repository-world-model-view', id: contract.id },
    tools: { mode: 'none', names: [] },
    limits: {
      timeoutMs,
      outputBytes: maximumOutputTokens * 4,
      promptBytes: contract.budgets.maximumInputTokens * 4,
      maxTurns: 'auto',
      maxToolCalls: 'auto',
      maxTotalTokens: contract.budgets.maximumInputTokens + maximumOutputTokens,
      maxAiCredits: 'auto'
    },
    tokenAdmission: { mode: 'observe' }
  });
}

function failureRecord(error) {
  return {
    kind: 'view-execution-failure',
    code: String(error?.code ?? 'WMB_VIEW_VALIDATION_FAILED'),
    reason: String(error?.message ?? error),
    details: error?.details && typeof error.details === 'object'
      ? structuredClone(error.details) : null
  };
}

function typedViewFailureCode(error) {
  return error?.code?.startsWith('WMB_')
    ? error.code : 'WMB_VIEW_VALIDATION_FAILED';
}

function attachRetryBinding(error, retryBinding) {
  if (!retryBinding) return error;
  if (error && typeof error === 'object' && Object.isExtensible(error)) {
    Object.defineProperty(error, 'worldModelRetryBinding', {
      value: retryBinding, enumerable: false, configurable: false, writable: false
    });
    return error;
  }
  const wrapped = new SingularityFlowError(String(error?.message ?? error), {
    code: typedViewFailureCode(error),
    details: error?.details && typeof error.details === 'object'
      ? structuredClone(error.details) : null,
    cause: error
  });
  Object.defineProperty(wrapped, 'worldModelRetryBinding', {
    value: retryBinding, enumerable: false, configurable: false, writable: false
  });
  return wrapped;
}

function cachedViewStamp(markdown) {
  const stamp = parseWorldModelViewKernelStamp(markdown);
  if (!stamp) {
    throw new SingularityFlowError('Cached world-model view has no valid kernel stamp.', {
      code: 'WMB_CACHE_REVALIDATION_FAILED'
    });
  }
  return Object.freeze({
    generatedAt: stamp.generatedAt,
    executionUnit: stamp.executionUnit,
    model: stamp.model
  });
}

/**
 * A content-addressed cache entry is only a storage claim. Re-run the current validator and exact
 * materializer before treating it as publication authority, so a coherently rehashed local forgery
 * cannot introduce facts, evidence, scope, or prose that the current registered inputs reject.
 */
function revalidateCachedArtifact(cached, {
  contract, viewFactLedger, evidenceCatalog, derivationCatalog, scopeManifest, sourceSnapshot,
  outputBudget, contextManifest, route
}) {
  try {
    const markdown = Buffer.isBuffer(cached.viewBytes)
      ? cached.viewBytes.toString('utf8') : String(cached.markdown ?? '');
    const stamp = cachedViewStamp(markdown);
    if ((route === 'deterministic'
          && (stamp.executionUnit !== 'deterministic-renderer@1' || stamp.model !== 'unavailable'))
        || (route === 'model'
          && !stamp.executionUnit.startsWith('governed-model-composer@1:'))) {
      throw new SingularityFlowError(
        'Cached world-model view execution stamp does not match the current composition route.',
        { code: 'WMB_CACHE_REVALIDATION_FAILED' }
      );
    }
    const validated = validateCompositionCandidate(cached.candidate, {
      contract,
      viewFactLedger,
      evidenceCatalog,
      scopeManifest,
      outputBudget,
      candidateSchemaSha256: WMB_V4_CANDIDATE_SCHEMA_SHA256,
      validatorSha256: WMB_V4_VALIDATOR_SHA256
    });
    if (canonicalJson(validated.candidate) !== canonicalJson(cached.candidate)
        || canonicalJson(validated.receipt) !== canonicalJson(cached.validationReceipt)) {
      throw new SingularityFlowError(
        'Cached world-model candidate or validation receipt does not match current validation.',
        { code: 'WMB_CACHE_REVALIDATION_FAILED' }
      );
    }
    const materialized = materializeWorldModelView({
      candidate: validated.candidate,
      contract,
      viewFactLedger,
      scopeManifest,
      sourceSnapshot,
      evidenceCatalog,
      derivationCatalog,
      validationReceipt: validated.receipt,
      contextManifest,
      executionUnit: stamp.executionUnit,
      model: stamp.model === 'unavailable' ? null : stamp.model,
      generatedAt: stamp.generatedAt
    });
    const expectedViewSha256 = cached.record?.viewSha256 ?? cached.viewSha256;
    if (materialized.markdown !== markdown || materialized.viewSha256 !== expectedViewSha256) {
      throw new SingularityFlowError(
        'Cached world-model view bytes do not materialize from the current validated candidate.',
        { code: 'WMB_CACHE_REVALIDATION_FAILED' }
      );
    }
    return Object.freeze({
      markdown,
      candidate: validated.candidate,
      validationReceipt: validated.receipt,
      viewSha256: materialized.viewSha256,
      generatedAt: stamp.generatedAt
    });
  } catch (error) {
    if (error?.code === 'WMB_CACHE_REVALIDATION_FAILED') throw error;
    throw new SingularityFlowError(
      `Cached world-model view failed current authority validation: ${error.message}`,
      {
        code: 'WMB_CACHE_REVALIDATION_FAILED',
        details: { causeCode: error?.code ?? null }
      }
    );
  }
}

function cachedExecutionResult({
  cached, verified, context, requested, contract, viewFactLedger, route, options, assembled,
  cacheLevel = 'l1', cacheDiagnostics = []
}) {
  const observation = usageObservation({
    viewId: contract.id,
    prompt: '',
    output: verified.markdown,
    usage: null
  });
  const execution = createViewExecution({
    requestSha256: context.planned.request.requestSha256,
    contract,
    route,
    provider: route === 'model' ? options.provider : null,
    model: route === 'model' ? options.model : null,
    contextManifest: assembled.contextManifest,
    viewFactLedger,
    status: 'cached',
    candidateSha256: verified.validationReceipt.candidateSha256,
    validationReceiptSha256: verified.validationReceipt.receiptSha256,
    publishedViewSha256: verified.viewSha256,
    usageObservationSha256: observation.observationSha256
  });
  return Object.freeze({
    viewId: contract.id,
    required: requested.required,
    contract,
    viewFactLedger,
    route,
    cache: 'hit',
    cacheLevel,
    cacheDiagnostics: Object.freeze([...cacheDiagnostics]),
    markdown: verified.markdown,
    viewSha256: verified.viewSha256,
    validationReceipt: verified.validationReceipt,
    candidate: verified.candidate,
    contextManifest: assembled.contextManifest,
    usageObservation: observation,
    execution,
    cacheRecord: cached.record ?? null
  });
}

function sharedCacheDiagnostic(viewId, operation, status, details = {}) {
  return Object.freeze({
    viewId,
    level: 'l2',
    operation,
    status,
    ...details
  });
}

function localCacheDiagnostic(viewId, operation, status, details = {}) {
  return Object.freeze({
    viewId,
    level: 'l1',
    operation,
    status,
    ...details
  });
}

async function tryHydrateSharedCache(root, directory, cacheKey, viewId) {
  if (!directory) return Object.freeze({ cached: null, diagnostics: Object.freeze([]) });
  try {
    const cached = await hydrateLocalWorldModelViewCacheFromShared(root, directory, cacheKey);
    return Object.freeze({
      cached: cached.hit ? cached : null,
      diagnostics: Object.freeze([sharedCacheDiagnostic(
        viewId, 'hydrate', cached.hit ? 'hit' : cached.status,
        cached.hit ? { cacheKeySha256: cached.cacheKeySha256 }
          : { reason: cached.reason ?? null }
      )])
    });
  } catch (error) {
    return Object.freeze({
      cached: null,
      diagnostics: Object.freeze([sharedCacheDiagnostic(viewId, 'hydrate', 'unavailable', {
        code: error?.code ?? 'WMB_SHARED_CACHE_UNAVAILABLE',
        reason: error?.message ?? String(error)
      })])
    });
  }
}

async function tryWarmSharedCache(root, directory, cacheKey, viewId) {
  if (!directory) return Object.freeze([]);
  try {
    const published = await publishWorldModelViewToSharedCache(directory, root, cacheKey);
    return Object.freeze([sharedCacheDiagnostic(viewId, 'publish',
      published.written ? 'written' : 'reused', {
        bundleSha256: published.bundleSha256
      })]);
  } catch (error) {
    return Object.freeze([sharedCacheDiagnostic(viewId, 'publish', 'unavailable', {
      code: error?.code ?? 'WMB_SHARED_CACHE_UNAVAILABLE',
      reason: error?.message ?? String(error)
    })]);
  }
}

async function executeOneView(root, context, requested, options) {
  let retryBinding = null;
  try {
  const cacheDiagnostics = [];
  const contract = requested.contract;
  const viewFactLedger = context.registration.viewFactLedgers.find((ledger) => (
    ledger.viewId === contract.id && ledger.viewVersion === contract.version
  ));
  if (!viewFactLedger) {
    throw new SingularityFlowError(`No view-scoped Fact Ledger exists for '${contract.id}@${contract.version}'.`, {
      code: 'WMB_FACT_LEDGER_INVALID'
    });
  }
  const viewOutputBudget = createWorldModelViewOutputBudget(
    context.planned.outputBudget, contract
  );
  const assembled = await assembleWmbV4Prompt({
    viewContract: contract,
    scopeManifest: context.planned.scopeManifest,
    viewFactLedger,
    evidenceCatalog: context.registration.evidenceCatalog,
    consumerProfile: context.planned.consumerProfile,
    outputBudget: viewOutputBudget
  });
  const route = routeForContract(contract, options.composer);
  const profileSha256 = executionProfileSha256({
    route, provider: options.provider, model: options.model
  });
  const cacheKey = {
    sourceManifestSha256: context.planned.sourceSnapshot.sourceManifestSha256,
    scopeManifestSha256: context.planned.scopeManifest.scopeSha256,
    viewId: contract.id,
    viewVersion: contract.version,
    viewSpecSha256: contract.contractSha256,
    viewFactLedgerSha256: viewFactLedger.ledgerSha256,
    consumerProfileSha256: context.planned.consumerProfile.profileSha256,
    composerCoreSha256: assembled.coreSha256,
    compositionCandidateSchemaSha256: WMB_V4_CANDIDATE_SCHEMA_SHA256,
    validatorSha256: WMB_V4_VALIDATOR_SHA256,
    outputBudgetSha256: viewOutputBudget.budgetSha256,
    executionProfileSha256: profileSha256
  };
  retryBinding = createWorldModelViewRetryBinding({
    requestSha256: context.planned.request.requestSha256,
    sourceManifestSha256: context.planned.sourceSnapshot.sourceManifestSha256,
    scopeManifestSha256: context.planned.scopeManifest.scopeSha256,
    viewContract: contract,
    viewFactLedger,
    contextManifestSha256: assembled.contextManifest.manifestSha256,
    cacheKey,
    route,
    provider: options.provider,
    model: options.model,
    providerConfig: options.providerConfig,
    executionProfileSha256: profileSha256,
    executionUnitManifestSha256: executionUnitManifestSha256({
      route, provider: options.provider, model: options.model
    }),
    timeoutMs: options.timeoutMs ?? 10 * 60 * 1000
  });
  if (options.expectedRetryBinding) {
    assertWorldModelViewRetryBinding(options.expectedRetryBinding, retryBinding);
  }

  const forceRebuild = options.rebuildViewIds.has(contract.id);
  const cacheOnly = options.cacheOnlyViewIds.has(contract.id);
  let replacementExpectedRecordSha256;
  if (forceRebuild) {
    const previous = await readWorldModelViewCache(root, cacheKey);
    replacementExpectedRecordSha256 = previous.hit ? previous.record.recordSha256 : null;
  }
  if (!forceRebuild
      && (context.planned.request.cachePolicy === 'reuse-valid' || cacheOnly)) {
    let cached = await readWorldModelViewCache(root, cacheKey);
    let cacheLevel = 'l1';
    const preserved = options.preservedViews.get(contract.id);
    const canPreserve = cacheOnly && preserved?.status === 'available'
      && preserved.viewVersion === contract.version;
    let invalidCachedRecordSha256 = null;
    const revalidationOptions = {
      contract,
      viewFactLedger,
      evidenceCatalog: context.registration.evidenceCatalog,
      derivationCatalog: context.registration.derivationCatalog,
      scopeManifest: context.planned.scopeManifest,
      sourceSnapshot: context.planned.sourceSnapshot,
      outputBudget: viewOutputBudget,
      contextManifest: assembled.contextManifest,
      route
    };
    if (cached.status === 'corrupt') {
      cacheDiagnostics.push(localCacheDiagnostic(contract.id, 'read', 'corrupt', {
        code: cached.code ?? 'WMB_CACHE_ENTRY_CORRUPT',
        reason: cached.reason ?? null
      }));
    }
    if (!cached.hit) {
      const shared = await tryHydrateSharedCache(
        root, options.sharedCacheDirectory, cacheKey, contract.id
      );
      cacheDiagnostics.push(...shared.diagnostics);
      if (shared.cached) {
        cached = shared.cached;
        cacheLevel = 'l2';
      }
    }
    if (cached.hit) {
      try {
        const verified = revalidateCachedArtifact(cached, revalidationOptions);
        if (cacheLevel === 'l1') cacheDiagnostics.push(...await tryWarmSharedCache(
          root, options.sharedCacheDirectory, cacheKey, contract.id
        ));
        return cachedExecutionResult({
          cached, verified, context, requested, contract, viewFactLedger, route, options, assembled,
          cacheLevel, cacheDiagnostics
        });
      } catch (error) {
        // Cache objects are derived memory, not publication authority. A retained view must fall
        // back to its exact, independently verified state projection when a structurally coherent
        // cache entry fails current semantic validation. Views without preserved authority retain
        // the fail-closed behavior.
        if (!canPreserve) throw error;
        invalidCachedRecordSha256 = cached.record?.recordSha256 ?? null;
        const diagnostic = cacheLevel === 'l2' ? sharedCacheDiagnostic : localCacheDiagnostic;
        cacheDiagnostics.push(diagnostic(contract.id, 'revalidate', 'corrupt', {
          code: error?.code ?? 'WMB_CACHE_REVALIDATION_FAILED',
          reason: error?.message ?? String(error)
        }));
      }
    }
    if (canPreserve) {
      // Re-run the current validator/materializer over the published authority before using it. A
      // failure here aborts the complete extension because there is then no valid A to preserve.
      const verified = revalidateCachedArtifact(preserved, revalidationOptions);
      try {
        cached = await writeWorldModelViewCache(root, cacheKey, {
          view: verified.markdown,
          candidate: verified.candidate,
          validationReceipt: verified.validationReceipt,
          createdAt: verified.generatedAt,
          ...(invalidCachedRecordSha256 ? {
            replaceExisting: true,
            expectedRecordSha256: invalidCachedRecordSha256
          } : {})
        });
        const repaired = revalidateCachedArtifact(cached, revalidationOptions);
        if (repaired.viewSha256 !== verified.viewSha256
            || repaired.markdown !== verified.markdown) {
          throw new SingularityFlowError(
            `World-model cache repair for '${contract.id}' selected bytes other than the published authority.`,
            { code: 'WMB_CACHE_REPAIR_CONFLICT' }
          );
        }
        cacheDiagnostics.push(...await tryWarmSharedCache(
          root, options.sharedCacheDirectory, cacheKey, contract.id
        ));
        return cachedExecutionResult({
          cached, verified: repaired, context, requested, contract, viewFactLedger, route, options,
          assembled, cacheLevel: 'l1', cacheDiagnostics
        });
      } catch (error) {
        // Cache retention is best-effort. Returning the fully revalidated immutable state view keeps
        // optional A available while B is added, without laundering the cache failure as authority.
        cacheDiagnostics.push(localCacheDiagnostic(contract.id, 'publish', 'unavailable', {
          code: error?.code ?? 'WMB_CACHE_WRITE_UNAVAILABLE',
          reason: error?.message ?? String(error)
        }));
        return cachedExecutionResult({
          cached: preserved,
          verified,
          context,
          requested,
          contract,
          viewFactLedger,
          route,
          options,
          assembled,
          cacheLevel: 'published-authority',
          cacheDiagnostics
        });
      }
    }
    if (cacheOnly) {
      throw new SingularityFlowError(
        `Unrelated view '${contract.id}' has no exact, currently valid cache artifact to preserve.`,
        {
          code: 'WMB_CACHE_PRESERVATION_UNAVAILABLE',
          details: { viewId: contract.id, cacheStatus: cached.status }
        }
      );
    }
  }

  let rawCandidate;
  let providerResult = null;
  let observedModel = null;
  if (route === 'model') {
    providerResult = await composeWithModel(root, assembled.prompt, contract, viewOutputBudget, options);
    rawCandidate = providerResult.output;
    observedModel = providerResult.model ?? null;
  } else rawCandidate = renderDeterministicCandidate(contract, viewFactLedger);

  const { candidate, receipt } = validateCompositionCandidate(rawCandidate, {
    contract,
    viewFactLedger,
    evidenceCatalog: context.registration.evidenceCatalog,
    scopeManifest: context.planned.scopeManifest,
    outputBudget: viewOutputBudget,
    candidateSchemaSha256: WMB_V4_CANDIDATE_SCHEMA_SHA256,
    validatorSha256: WMB_V4_VALIDATOR_SHA256
  });
  const materialized = materializeWorldModelView({
    candidate,
    contract,
    viewFactLedger,
    scopeManifest: context.planned.scopeManifest,
    sourceSnapshot: context.planned.sourceSnapshot,
    evidenceCatalog: context.registration.evidenceCatalog,
    derivationCatalog: context.registration.derivationCatalog,
    validationReceipt: receipt,
    contextManifest: assembled.contextManifest,
    executionUnit: route === 'model'
      ? `governed-model-composer@1:${providerResult?.invocationId ?? 'unavailable'}`
      : 'deterministic-renderer@1',
    model: observedModel,
    generatedAt: options.generatedAt
  });
  const cached = await writeWorldModelViewCache(root, cacheKey, {
    view: materialized.markdown,
    candidate,
    validationReceipt: receipt,
    createdAt: options.generatedAt,
    replaceExisting: forceRebuild,
    ...(forceRebuild ? { expectedRecordSha256: replacementExpectedRecordSha256 } : {})
  });
  if (cached.raced) {
    // Another process completed this exact semantic key first. The selected bytes, candidate, and
    // receipt are the winner's artifact, so the losing invocation must not stamp its model or
    // provider usage onto them. Revalidate the winner and return it as a cache execution; the
    // losing model call remains visible only in the independent invocation audit that observed it.
    const verified = revalidateCachedArtifact(cached, {
      contract,
      viewFactLedger,
      evidenceCatalog: context.registration.evidenceCatalog,
      derivationCatalog: context.registration.derivationCatalog,
      scopeManifest: context.planned.scopeManifest,
      sourceSnapshot: context.planned.sourceSnapshot,
      outputBudget: viewOutputBudget,
      contextManifest: assembled.contextManifest,
      route
    });
    cacheDiagnostics.push(...await tryWarmSharedCache(
      root, options.sharedCacheDirectory, cacheKey, contract.id
    ));
    return cachedExecutionResult({
      cached, verified, context, requested, contract, viewFactLedger, route, options, assembled,
      cacheLevel: 'l1', cacheDiagnostics
    });
  }
  cacheDiagnostics.push(...await tryWarmSharedCache(
    root, options.sharedCacheDirectory, cacheKey, contract.id
  ));
  // Ordinary fills retain the first complete exact-key writer. Explicit regeneration uses a
  // lock/hash-CAS replacement above, so paid output is either installed or rejected as stale.
  const selectedMarkdown = cached.viewBytes.toString('utf8');
  const selectedReceipt = cached.validationReceipt;
  const observation = usageObservation({
    viewId: contract.id,
    prompt: route === 'model' ? assembled.prompt : '',
    output: selectedMarkdown,
    usage: providerResult?.usage ?? null
  });
  const execution = createViewExecution({
    requestSha256: context.planned.request.requestSha256,
    contract,
    route,
    provider: options.provider,
    model: observedModel ?? options.model,
    contextManifest: assembled.contextManifest,
    viewFactLedger,
    status: 'completed',
    candidateSha256: selectedReceipt.candidateSha256,
    validationReceiptSha256: selectedReceipt.receiptSha256,
    publishedViewSha256: cached.record.viewSha256,
    usageObservationSha256: observation.observationSha256
  });
  return Object.freeze({
    viewId: contract.id,
    required: requested.required,
    contract,
    viewFactLedger,
    route,
    cache: 'miss',
    cacheLevel: 'none',
    cacheDiagnostics: Object.freeze([...cacheDiagnostics]),
    markdown: selectedMarkdown,
    viewSha256: cached.record.viewSha256,
    validationReceipt: selectedReceipt,
    candidate: cached.candidate,
    contextManifest: assembled.contextManifest,
    usageObservation: observation,
    execution
  });
  } catch (error) {
    throw attachRetryBinding(error, retryBinding);
  }
}

async function boundedMap(values, maximumWorkers, worker) {
  const results = new Array(values.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(maximumWorkers, values.length) }, run));
  return results;
}

function refusalForFailedExecution(entry, registration, validViewIds, previousRefusal = null) {
  const code = typedViewFailureCode(entry.error);
  const binding = entry.retryBinding ?? entry.error?.worldModelRetryBinding ?? null;
  const retry = binding && isWorldModelViewRetryableCode(code)
    ? createWorldModelViewRetryMetadata({
        binding, previousRefusal, policy: WMB_V4_FAILED_VIEW_RETRY_POLICY
      })
    : null;
  return worldModelRefusal({
    code,
    view: entry.viewId,
    preserved: {
      evidenceCatalogSha256: registration.evidenceCatalog.catalogSha256,
      factLedgerSha256: registration.factLedger.ledgerSha256,
      validViewIds
    },
    failures: [failureRecord(entry.error)],
    nextAction: {
      operation: retry ? 'world-model.retry-failed-view' : 'world-model.regenerate-view',
      view: entry.viewId,
      reuseFacts: Boolean(retry)
    },
    ...(retry ? { retry } : {})
  });
}

/**
 * Execute the WMB v4 trust boundary through independent validated views.
 *
 * This function deliberately returns publication inputs rather than mutating Git. The caller can
 * inspect refusals first and may publish only when every required view is available.
 */
export async function buildWorldModelV4(root, {
  views,
  composer = 'auto',
  provider = null,
  providerConfig = null,
  model = null,
  maximumWorkers = 4,
  generatedAt = new Date().toISOString(),
  sharedCacheDirectory = null,
  rebuildViewIds = null,
  cacheOnlyViewIds = [],
  preservedViews = [],
  expectedBuildIdentity = null,
  legacyMigration = null,
  ...planOptions
} = {}) {
  if (!Number.isSafeInteger(maximumWorkers) || maximumWorkers < 1 || maximumWorkers > 32) {
    throw new SingularityFlowError('WMB v4 maximumWorkers must be an integer from 1 through 32.', {
      code: 'WMB_BUILD_REQUEST_INVALID'
    });
  }
  if (sharedCacheDirectory !== null
      && (typeof sharedCacheDirectory !== 'string' || !path.isAbsolute(sharedCacheDirectory))) {
    throw new SingularityFlowError(
      'WMB v4 sharedCacheDirectory must be an explicit absolute path when configured.',
      { code: 'WMB_SHARED_CACHE_CONFIGURATION_INVALID' }
    );
  }
  if ((rebuildViewIds !== null && !Array.isArray(rebuildViewIds))
      || !Array.isArray(cacheOnlyViewIds) || !Array.isArray(preservedViews)) {
    throw new SingularityFlowError(
      'WMB v4 rebuild, cache-only, and preserved-view selections must be arrays.',
      { code: 'WMB_BUILD_REQUEST_INVALID' }
    );
  }
  const planned = planWorldModelV4(root, { views, ...planOptions });
  if (expectedBuildIdentity
      && (planned.request.requestSha256 !== expectedBuildIdentity.requestSha256
        || planned.plan.planSha256 !== expectedBuildIdentity.planSha256)) {
    throw new SingularityFlowError(
      'The WMB v4 request or Plan changed after exact confirmation.',
      {
        code: 'WMB_GATEWAY_PLAN_DRIFTED',
        details: {
          expectedRequestSha256: expectedBuildIdentity.requestSha256 ?? null,
          currentRequestSha256: planned.request.requestSha256,
          expectedPlanSha256: expectedBuildIdentity.planSha256 ?? null,
          currentPlanSha256: planned.plan.planSha256
        }
      }
    );
  }
  const selectedRebuildIds = Array.isArray(rebuildViewIds)
    ? rebuildViewIds
    : (planned.request.cachePolicy === 'rebuild'
      ? planned.requestedViews.map((entry) => entry.contract.id) : []);
  const rebuildIds = new Set(selectedRebuildIds);
  const cacheOnlyIds = new Set(cacheOnlyViewIds);
  const plannedIds = new Set(planned.requestedViews.map((entry) => entry.contract.id));
  for (const id of [...rebuildIds, ...cacheOnlyIds]) {
    if (!plannedIds.has(id)) {
      throw new SingularityFlowError(
        `WMB v4 execution policy names unplanned view '${id}'.`,
        { code: 'WMB_BUILD_REQUEST_INVALID' }
      );
    }
  }
  for (const id of rebuildIds) {
    if (cacheOnlyIds.has(id)) {
      throw new SingularityFlowError(
        `WMB v4 view '${id}' cannot be both rebuilt and cache-only.`,
        { code: 'WMB_BUILD_REQUEST_INVALID' }
      );
    }
  }
  let registration = runDeterministicRegistration({
    root,
    sourceSnapshot: planned.sourceSnapshot,
    scopeManifest: planned.scopeManifest,
    extractorRegistry: planned.extractorRegistry,
    extractorReferences: planned.extractorReferences,
    // Register the closed active catalog, then compose only the requested views. This keeps the
    // global Evidence/Derivation/Fact identities stable when a later command regenerates one view
    // and is what makes independently generated views safely mergeable on the state branch.
    requestedViews: planned.viewRegistry.contracts.filter((contract) => contract.validity.status === 'active'),
    viewRegistry: planned.viewRegistry
  });
  let migrationResolution = null;
  if (legacyMigration !== null) {
    if (!legacyMigration || typeof legacyMigration !== 'object' || Array.isArray(legacyMigration)
        || typeof legacyMigration.targetViewId !== 'string' || !legacyMigration.legacyView) {
      throw new SingularityFlowError('WMB v4 legacy migration request is malformed.', {
        code: 'WMB_MIGRATION_SOURCE_INVALID'
      });
    }
    const requestedTarget = planned.requestedViews.find((entry) => (
      entry.contract.id === legacyMigration.targetViewId
    ));
    if (!requestedTarget) {
      throw new SingularityFlowError(
        `Migration target view '${legacyMigration.targetViewId}' is not part of the exact build Plan.`,
        { code: 'WMB_VIEW_UNKNOWN' }
      );
    }
    migrationResolution = augmentRegistrationForLegacyMigration({
      legacyView: legacyMigration.legacyView,
      registration,
      targetViewContract: requestedTarget.contract,
      viewRegistry: planned.viewRegistry,
      extractorRegistry: planned.extractorRegistry
    });
    registration = migrationResolution.registration;
  }
  const preservedObjects = await preserveRegisteredFacts(root, registration);
  const options = {
    composer,
    provider,
    providerConfig,
    model,
    maximumWorkers,
    generatedAt,
    sharedCacheDirectory,
    rebuildViewIds: rebuildIds,
    cacheOnlyViewIds: cacheOnlyIds,
    preservedViews: new Map(preservedViews.map((entry) => [entry.viewId, entry]))
  };
  const context = { planned, registration };
  const executions = await boundedMap(
    planned.requestedViews,
    maximumWorkers,
    async (requested) => {
      try { return await executeOneView(root, context, requested, options); }
      catch (error) {
        return Object.freeze({
          viewId: requested.contract.id,
          required: requested.required,
          contract: requested.contract,
          status: 'unavailable',
          error,
          retryBinding: error?.worldModelRetryBinding ?? null
        });
      }
    }
  );
  const available = executions.filter((entry) => entry.markdown);
  const validIds = available.map((entry) => entry.viewId).sort();
  const refusals = executions.filter((entry) => entry.error).map((entry) => (
    refusalForFailedExecution(entry, registration, validIds)
  ));
  const requiredFailures = executions.filter((entry) => (
    (entry.required || cacheOnlyIds.has(entry.viewId)) && !entry.markdown
  ));
  const cacheDiagnostics = executions.flatMap((entry) => entry.cacheDiagnostics ?? []);
  return Object.freeze({
    schemaVersion: 1, // schema-transient: API result envelope, never persisted
    resultType: 'world-model-v4-build-runtime-result',
    status: requiredFailures.length ? 'refused' : 'ready-to-publish',
    planned,
    registration,
    preservedObjects,
    executions: Object.freeze(executions),
    availableViews: Object.freeze(available),
    refusals: Object.freeze(refusals),
    requiredFailures: Object.freeze(requiredFailures.map((entry) => entry.viewId)),
    cacheDiagnostics: Object.freeze(cacheDiagnostics),
    retryReceipts: Object.freeze([]),
    migrationResolution
  });
}

function retryRuntime(value) {
  const runtime = value?.resultType === 'world-model-build-result' ? value.runtime
    : value?.resultType === 'world-model-v4-view-retry-result' ? value.runtime
      : value?.runtime?.resultType === 'world-model-v4-build-runtime-result' ? value.runtime
        : value;
  if (!runtime || runtime.resultType !== 'world-model-v4-build-runtime-result'
      || !runtime.planned || !runtime.registration
      || !Array.isArray(runtime.executions) || !Array.isArray(runtime.refusals)) {
    throw new SingularityFlowError(
      'World-model failed-view retry requires a prior WMB v4 runtime result.',
      { code: 'WMB_RETRY_RUNTIME_INVALID' }
    );
  }
  return runtime;
}

function normalizedRetryOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || utilTypes.isProxy(options)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) {
    throw new SingularityFlowError('World-model retry options must be a plain object.', {
      code: 'WMB_RETRY_REQUEST_INVALID'
    });
  }
  const allowed = new Set([
    'view', 'viewId', 'refusal', 'previousRefusal', 'previousRetryReceipt',
    'composer', 'provider', 'providerConfig', 'model', 'generatedAt', 'timeoutMs'
  ]);
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const unexpected = Reflect.ownKeys(options).filter((key) => (
    typeof key !== 'string' || !allowed.has(key)
  )).map(String).sort();
  if (unexpected.length) {
    throw new SingularityFlowError(
      `World-model failed-view retry received unsupported option(s): ${unexpected.join(', ')}.`,
      { code: 'WMB_RETRY_REQUEST_INVALID', details: { unexpected } }
    );
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!Object.hasOwn(descriptor, 'value')
        || typeof descriptor.get === 'function' || typeof descriptor.set === 'function') {
      throw new SingularityFlowError(
        `World-model retry option '${key}' cannot be an accessor.`,
        { code: 'WMB_RETRY_REQUEST_INVALID' }
      );
    }
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])
  ));
}

async function validateRetryRuntimeAuthority(root, runtime, requested, binding) {
  const { planned, registration } = runtime;
  assertSelfHash(planned.request, 'requestSha256', 'World-model retry Build Request');
  assertSelfHash(planned.plan, 'planSha256', 'World-model retry Build Plan');
  assertSelfHash(planned.consumerProfile, 'profileSha256', 'World-model retry Consumer Profile');
  assertSelfHash(planned.outputBudget, 'budgetSha256', 'World-model retry Output Budget');
  assertInstalledViewRegistry(planned.viewRegistry);
  assertInstalledExtractorRegistry(planned.extractorRegistry);
  validateViewContract(requested.contract);
  await Promise.resolve(verifyExactSourceSnapshot(root, planned.sourceSnapshot, {
    scopeManifest: planned.scopeManifest
  }));
  const evidence = validateEvidenceCatalog(registration.evidenceCatalog, {
    sourceSnapshot: planned.sourceSnapshot,
    scopeManifest: planned.scopeManifest
  });
  const derivationIds = new Set(
    registration.derivationCatalog.derivations.map((entry) => entry.id)
  );
  const facts = validateFactLedger(registration.factLedger, {
    sourceSnapshot: planned.sourceSnapshot,
    scopeManifest: planned.scopeManifest,
    extractorRegistry: planned.extractorRegistry,
    evidenceCatalog: evidence,
    derivationIds
  });
  validateDerivationCatalog(registration.derivationCatalog, {
    evidenceCatalog: evidence,
    factLedger: facts,
    extractorRegistry: planned.extractorRegistry
  });
  const viewFactLedger = registration.viewFactLedgers.find((entry) => (
    entry.viewId === requested.contract.id && entry.viewVersion === requested.contract.version
  ));
  if (!viewFactLedger) {
    throw new SingularityFlowError(
      `World-model retry has no preserved view Fact Ledger for '${requested.contract.id}@${requested.contract.version}'.`,
      { code: 'WMB_RETRY_BINDING_MISMATCH' }
    );
  }
  validateViewFactLedger(viewFactLedger, {
    factLedger: facts,
    viewContract: requested.contract
  });
  const registeredContract = planned.viewRegistry.contracts.find((entry) => (
    entry.id === requested.contract.id && entry.version === requested.contract.version
  ));
  if (!registeredContract
      || registeredContract.contractSha256 !== requested.contract.contractSha256
      || planned.request.requestSha256 !== binding.requestSha256
      || planned.sourceSnapshot.sourceManifestSha256 !== binding.sourceManifestSha256
      || planned.scopeManifest.scopeSha256 !== binding.scopeManifestSha256
      || requested.contract.id !== binding.viewId
      || requested.contract.version !== binding.viewVersion
      || requested.contract.contractSha256 !== binding.viewContractSha256
      || viewFactLedger.ledgerSha256 !== binding.viewFactLedgerSha256
      || registration.factLedger.ledgerSha256 !== facts.ledgerSha256) {
    throw new SingularityFlowError(
      'World-model retry runtime does not match the refusal source, scope, contract, and facts.',
      {
        code: 'WMB_RETRY_BINDING_MISMATCH',
        details: { viewId: binding.viewId, bindingSha256: binding.bindingSha256 }
      }
    );
  }
  return viewFactLedger;
}

function preservedFactAuthority(registration) {
  return canonicalJson({
    evidenceCatalog: registration.evidenceCatalog,
    derivationCatalog: registration.derivationCatalog,
    factLedger: registration.factLedger,
    viewFactLedgers: registration.viewFactLedgers
  });
}

/**
 * Re-run one and only one failed WMB v4 view over the prior immutable planning/registration
 * context. This API never plans, extracts, registers, or publishes. Its successful result is a
 * new ready-to-publish runtime plus a machine-local immutable lineage receipt.
 */
export async function retryFailedWorldModelV4View(root, previousResult, options = {}) {
  options = normalizedRetryOptions(options);
  const runtime = retryRuntime(previousResult);
  const selectedViewId = String(options.viewId ?? options.view ?? '').replace(/@\d+$/, '');
  if (!selectedViewId) {
    throw new SingularityFlowError('World-model failed-view retry requires a view ID.', {
      code: 'WMB_RETRY_REQUEST_INVALID'
    });
  }
  const target = runtime.executions.find((entry) => entry.viewId === selectedViewId);
  if (!target) {
    throw new SingularityFlowError(
      `World-model view '${selectedViewId}' was not part of the prior build.`,
      { code: 'WMB_RETRY_VIEW_UNKNOWN', details: { viewId: selectedViewId } }
    );
  }
  if (!target.error || target.markdown) {
    throw new SingularityFlowError(
      `World-model view '${selectedViewId}' is not a failed view.`,
      { code: 'WMB_RETRY_VIEW_NOT_FAILED', details: { viewId: selectedViewId } }
    );
  }
  const runtimeRefusal = runtime.refusals.find((entry) => entry.view === selectedViewId);
  const suppliedRefusal = options.previousRefusal ?? options.refusal ?? runtimeRefusal;
  const previousRefusal = validateWorldModelViewRetryRefusal(suppliedRefusal);
  if (!runtimeRefusal || runtimeRefusal.refusalSha256 !== previousRefusal.refusalSha256) {
    throw new SingularityFlowError(
      'World-model retry refusal is not the exact current failed-view refusal.',
      { code: 'WMB_RETRY_LINEAGE_INVALID', details: { viewId: selectedViewId } }
    );
  }
  const retrySubject = {
    kind: 'world-model-view-retry', id: previousRefusal.refusalSha256
  };
  try {
    return await withSubjectLock(root, retrySubject, async () => {
  const terminalReceipt = await readWorldModelViewRetryReceiptForRefusal(
    root, previousRefusal.refusalSha256
  );
  if (terminalReceipt) {
    throw new SingularityFlowError(
      `World-model refusal '${previousRefusal.refusalSha256}' already has a terminal retry receipt.`,
      {
        code: 'WMB_RETRY_ALREADY_TERMINAL',
        details: {
          viewId: selectedViewId,
          receiptSha256: terminalReceipt.receiptSha256,
          status: terminalReceipt.outcome.status
        }
      }
    );
  }
  const inferredPriorReceipt = (runtime.retryReceipts ?? []).find((receipt) => (
    receipt.outcome?.status === 'refused'
      && receipt.outcome.refusal?.refusalSha256 === previousRefusal.refusalSha256
  )) ?? null;
  const priorReceipt = options.previousRetryReceipt ?? inferredPriorReceipt;
  const lineage = assertWorldModelViewRetryLineage(previousRefusal, priorReceipt);
  const binding = previousRefusal.retry.binding;
  if (previousRefusal.view !== selectedViewId
      || target.retryBinding == null) {
    throw new SingularityFlowError(
      'World-model failed execution does not retain its exact retry binding.',
      { code: 'WMB_RETRY_BINDING_MISMATCH', details: { viewId: selectedViewId } }
    );
  }
  assertWorldModelViewRetryBinding(binding, target.retryBinding);
  const requested = runtime.planned.requestedViews.find((entry) => (
    entry.contract.id === selectedViewId
  ));
  if (!requested) {
    throw new SingularityFlowError(
      'World-model retry view is absent from the exact prior Build Plan.',
      { code: 'WMB_RETRY_BINDING_MISMATCH', details: { viewId: selectedViewId } }
    );
  }
  await validateRetryRuntimeAuthority(root, runtime, requested, binding);
  const factsBefore = preservedFactAuthority(runtime.registration);
  const executionOptions = {
    composer: options.composer ?? (binding.execution.route === 'model' ? 'model' : 'deterministic'),
    provider: Object.hasOwn(options, 'provider') ? options.provider : binding.execution.provider,
    providerConfig: options.providerConfig ?? null,
    model: Object.hasOwn(options, 'model') ? options.model : binding.execution.requestedModel,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    timeoutMs: options.timeoutMs ?? binding.execution.timeoutMs,
    rebuildViewIds: new Set([selectedViewId]),
    cacheOnlyViewIds: new Set(),
    preservedViews: new Map(),
    expectedRetryBinding: binding
  };
  let retried;
  try {
    retried = await executeOneView(
      root, { planned: runtime.planned, registration: runtime.registration },
      requested, executionOptions
    );
  } catch (error) {
    // Binding/policy failures happen before cache/provider effects and do not consume an attempt.
    if (String(error?.code ?? '').startsWith('WMB_RETRY_')
        || error?.worldModelRetryBinding == null) throw error;
    assertWorldModelViewRetryBinding(binding, error.worldModelRetryBinding);
    retried = Object.freeze({
      viewId: requested.contract.id,
      required: requested.required,
      contract: requested.contract,
      status: 'unavailable',
      error,
      retryBinding: error.worldModelRetryBinding
    });
  }
  if (preservedFactAuthority(runtime.registration) !== factsBefore) {
    throw new SingularityFlowError(
      'World-model selective retry mutated preserved registered facts.',
      { code: 'WMB_RETRY_FACT_MUTATION_DETECTED', details: { viewId: selectedViewId } }
    );
  }
  const executions = runtime.executions.map((entry) => (
    entry.viewId === selectedViewId ? retried : entry
  ));
  const availableViews = executions.filter((entry) => entry.markdown);
  const validViewIds = availableViews.map((entry) => entry.viewId).sort();
  const nextRefusal = retried.error
    ? refusalForFailedExecution(
        retried, runtime.registration, validViewIds, previousRefusal
      )
    : null;
  const refusals = executions.filter((entry) => entry.error).map((entry) => {
    if (entry.viewId === selectedViewId) return nextRefusal;
    const retained = runtime.refusals.find((value) => value.view === entry.viewId);
    if (!retained) {
      throw new SingularityFlowError(
        `World-model retry cannot retain missing sibling refusal '${entry.viewId}'.`,
        { code: 'WMB_RETRY_RUNTIME_INVALID' }
      );
    }
    return retained;
  });
  const requiredFailures = executions.filter((entry) => entry.required && !entry.markdown)
    .map((entry) => entry.viewId);
  const receipt = createWorldModelViewRetryReceipt({
    previousRefusal,
    previousRetryReceipt: lineage.previousRetryReceipt,
    ...(retried.error ? { refusal: nextRefusal } : { execution: retried.execution })
  });
  const persistence = await storeWorldModelViewRetryReceipt(root, receipt);
  const mergedRuntime = Object.freeze({
    schemaVersion: runtime.schemaVersion,
    resultType: runtime.resultType,
    status: requiredFailures.length ? 'refused' : 'ready-to-publish',
    planned: runtime.planned,
    registration: runtime.registration,
    preservedObjects: runtime.preservedObjects,
    executions: Object.freeze(executions),
    availableViews: Object.freeze(availableViews),
    refusals: Object.freeze(refusals),
    requiredFailures: Object.freeze(requiredFailures),
    cacheDiagnostics: Object.freeze(executions.flatMap((entry) => (
      entry.cacheDiagnostics ?? []
    ))),
    retryReceipts: Object.freeze([...(runtime.retryReceipts ?? []), receipt])
  });
  return Object.freeze({
    schemaVersion: 1,
    resultType: 'world-model-v4-view-retry-result',
    status: retried.error ? 'refused' : 'completed',
    viewId: selectedViewId,
    attempt: receipt.attempt,
    receipt,
    receiptPersistence: Object.freeze({
      path: persistence.path,
      lineagePath: persistence.lineagePath,
      written: persistence.written,
      lineageWritten: persistence.lineageWritten
    }),
    runtime: mergedRuntime
  });
    });
  } catch (error) {
    if (error?.code !== 'SUBJECT_LOCK_BUSY') throw error;
    throw new SingularityFlowError(
      `World-model view '${selectedViewId}' already has a retry in progress.`,
      {
        code: 'WMB_RETRY_IN_PROGRESS',
        details: { viewId: selectedViewId, refusalSha256: previousRefusal.refusalSha256 },
        cause: error
      }
    );
  }
}

export const retryFailedWorldModelView = retryFailedWorldModelV4View;
