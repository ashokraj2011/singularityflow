import path from 'node:path';

import { gitCommonDir } from '../git.mjs';
import { invokeModel } from '../model-runner.mjs';
import { writeImmutablePrivateSidecar } from '../private-sidecar.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { SingularityFlowError } from '../util.mjs';
import { readWorldModelViewCache, writeWorldModelViewCache } from './cache.mjs';
import { canonicalJson, sealRecord, sha256 } from './canonicalize.mjs';
import { assembleWmbV4Prompt } from './compose/pinned-core.mjs';
import { renderDeterministicCandidate } from './compose/candidate.mjs';
import { runDeterministicRegistration } from './extract/index.mjs';
import { materializeWorldModelView, usageObservation } from './materialize/view.mjs';
import { parseWorldModelViewKernelStamp } from './materialize/stamp.mjs';
import { createWorldModelViewOutputBudget, planWorldModelV4 } from './plan.mjs';
import { worldModelRefusal } from './refusal.mjs';
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
  cached, verified, context, requested, contract, viewFactLedger, route, options, assembled
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

async function executeOneView(root, context, requested, options) {
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
    if (cached.hit) {
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
      return cachedExecutionResult({
        cached, verified, context, requested, contract, viewFactLedger, route, options, assembled
      });
    }
    const preserved = options.preservedViews.get(contract.id);
    if (cacheOnly && preserved?.status === 'available'
        && preserved.viewVersion === contract.version) {
      const verified = revalidateCachedArtifact(preserved, {
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
      cached = await writeWorldModelViewCache(root, cacheKey, {
        view: verified.markdown,
        candidate: verified.candidate,
        validationReceipt: verified.validationReceipt,
        createdAt: verified.generatedAt
      });
      return cachedExecutionResult({
        cached, verified, context, requested, contract, viewFactLedger, route, options, assembled
      });
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
    return cachedExecutionResult({
      cached, verified, context, requested, contract, viewFactLedger, route, options, assembled
    });
  }
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
    markdown: selectedMarkdown,
    viewSha256: cached.record.viewSha256,
    validationReceipt: selectedReceipt,
    candidate: cached.candidate,
    contextManifest: assembled.contextManifest,
    usageObservation: observation,
    execution
  });
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
  rebuildViewIds = null,
  cacheOnlyViewIds = [],
  preservedViews = [],
  ...planOptions
} = {}) {
  if (!Number.isSafeInteger(maximumWorkers) || maximumWorkers < 1 || maximumWorkers > 32) {
    throw new SingularityFlowError('WMB v4 maximumWorkers must be an integer from 1 through 32.', {
      code: 'WMB_BUILD_REQUEST_INVALID'
    });
  }
  if ((rebuildViewIds !== null && !Array.isArray(rebuildViewIds))
      || !Array.isArray(cacheOnlyViewIds) || !Array.isArray(preservedViews)) {
    throw new SingularityFlowError(
      'WMB v4 rebuild, cache-only, and preserved-view selections must be arrays.',
      { code: 'WMB_BUILD_REQUEST_INVALID' }
    );
  }
  const planned = planWorldModelV4(root, { views, ...planOptions });
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
  const registration = runDeterministicRegistration({
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
  const preservedObjects = await preserveRegisteredFacts(root, registration);
  const options = {
    composer,
    provider,
    providerConfig,
    model,
    maximumWorkers,
    generatedAt,
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
          error
        });
      }
    }
  );
  const available = executions.filter((entry) => entry.markdown);
  const validIds = available.map((entry) => entry.viewId).sort();
  const refusals = executions.filter((entry) => entry.error).map((entry) => worldModelRefusal({
    code: entry.error?.code?.startsWith('WMB_')
      ? entry.error.code : 'WMB_VIEW_VALIDATION_FAILED',
    view: entry.viewId,
    preserved: {
      evidenceCatalogSha256: registration.evidenceCatalog.catalogSha256,
      factLedgerSha256: registration.factLedger.ledgerSha256,
      validViewIds: validIds
    },
    failures: [failureRecord(entry.error)],
    nextAction: {
      operation: 'world-model.regenerate-view',
      view: entry.viewId,
      reuseFacts: true
    }
  }));
  const requiredFailures = executions.filter((entry) => (
    (entry.required || cacheOnlyIds.has(entry.viewId)) && !entry.markdown
  ));
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
    requiredFailures: Object.freeze(requiredFailures.map((entry) => entry.viewId))
  });
}
