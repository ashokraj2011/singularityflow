import { SingularityFlowError } from '../util.mjs';
import { storeConservativeWorldModelStalenessReceipt } from './cache.mjs';
import {
  buildWorldModelManifest, deriveWorldModelManifestDependencies
} from './publish/manifest.mjs';
import {
  publishWorldModelTransaction, stageWorldModelPublication
} from './publish/transaction.mjs';
import { buildWorldModelV4 } from './runtime.mjs';
import { resolvePublishedWorldModelV4 } from './store.mjs';

function manifestView(runtime, entry) {
  if (!entry.markdown) {
    return {
      viewId: entry.viewId,
      viewVersion: entry.contract.version,
      required: entry.required,
      status: 'unavailable',
      cache: 'miss'
    };
  }
  return {
    viewId: entry.viewId,
    viewVersion: entry.contract.version,
    required: entry.required,
    status: 'available',
    path: `views/${entry.viewId}.md`,
    markdown: entry.markdown,
    viewSha256: entry.viewSha256,
    validationReceipt: entry.validationReceipt,
    candidate: entry.candidate,
    execution: entry.execution,
    usageObservation: entry.usageObservation,
    cache: entry.cache
  };
}

function publicationRecords(runtime) {
  return {
    sourceSnapshot: runtime.planned.sourceSnapshot,
    scopeManifest: runtime.planned.scopeManifest,
    viewRegistry: runtime.planned.viewRegistry,
    extractorRegistry: runtime.planned.extractorRegistry,
    evidenceCatalog: runtime.registration.evidenceCatalog,
    derivationCatalog: runtime.registration.derivationCatalog,
    factLedger: runtime.registration.factLedger,
    buildRequest: runtime.planned.request,
    buildPlan: runtime.planned.plan,
    consumerProfile: runtime.planned.consumerProfile,
    outputBudget: runtime.planned.outputBudget,
    viewFactLedgers: runtime.registration.viewFactLedgers,
    contextManifests: runtime.availableViews.map((entry) => entry.contextManifest),
    refusals: runtime.refusals
  };
}

function viewId(value) {
  return String(typeof value === 'string' ? value : value?.viewId ?? '').replace(/@\d+$/, '');
}

/**
 * Re-execute retained independent views under the current request rather than copying their old
 * receipts into a projection whose request/profile/budget records no longer describe them. Exact
 * per-view cache hits make this model-free and preserve the original validated view bytes.
 */
function currentRequestViews(requested, existing) {
  const values = Array.isArray(requested) ? [...requested] : [];
  const selected = new Set(values.map(viewId));
  for (const entry of existing?.manifest?.views ?? []) {
    if (entry.status !== 'available' || selected.has(entry.viewId)) continue;
    values.push({ viewId: `${entry.viewId}@${entry.viewVersion}`, required: entry.required });
    selected.add(entry.viewId);
  }
  return values;
}

async function retainExplicitRegenerationReceipts(root, existing, requestedViewIds, cachePolicy) {
  if (cachePolicy !== 'rebuild' || !existing || existing.freshness.fresh) {
    return Object.freeze({ records: Object.freeze([]), warnings: Object.freeze([]) });
  }
  const requested = new Set(requestedViewIds);
  const receipts = (existing.stalenessReceipts ?? [])
    .filter((receipt) => requested.has(receipt.nextAction.view));
  const records = [];
  const warnings = [];
  for (const receipt of receipts) {
    try {
      const stored = await storeConservativeWorldModelStalenessReceipt(root, receipt);
      records.push(Object.freeze({
        receipt,
        persistence: Object.freeze({ status: 'stored', written: stored.written })
      }));
    } catch (error) {
      // Staleness receipts are derived-memory diagnostics. Losing their local cache must remain
      // visible, but must not turn recoverable derived-memory loss into governance-data loss.
      records.push(Object.freeze({
        receipt,
        persistence: Object.freeze({
          status: 'unavailable', written: false, code: error?.code ?? 'WMB_STALENESS_RECEIPT_WRITE_FAILED'
        })
      }));
      warnings.push(
        `Staleness receipt '${receipt.receiptSha256}' could not be retained locally before regeneration (${error?.code ?? 'WMB_STALENESS_RECEIPT_WRITE_FAILED'}).`
      );
    }
  }
  return Object.freeze({
    records: Object.freeze(records),
    warnings: Object.freeze(warnings)
  });
}

/** Build, verify, and optionally publish one complete WMB v4 projection. */
export async function buildAndPublishWorldModelV4(root, {
  outputDir = 'singularity/world-model',
  ledgerConfig = {},
  publish = true,
  allowUnavailableOptionalViews = true,
  publicationOptions = {},
  preserveIndependentViews = true,
  ...buildOptions
} = {}) {
  let existing = null;
  let preservationWarning = null;
  if (preserveIndependentViews) {
    try {
      existing = resolvePublishedWorldModelV4(root, {
        outputDir,
        stateBranch: ledgerConfig.branch ?? 'state',
        remote: ledgerConfig.remote ?? 'origin',
        required: false
      });
    } catch (error) {
      // An explicit v4 build is a legal replacement for legacy output. Corrupt/partial v4 state
      // still fails closed instead of being silently overwritten.
      if (error?.code !== 'WMB_MIGRATION_REQUIRED') throw error;
      preservationWarning = 'Legacy v3 output was not imported; this explicit WMB v4 rebuild replaces it without trusting legacy claims.';
    }
  }
  const explicitlyRequested = Array.isArray(buildOptions.views) ? buildOptions.views : [];
  const explicitlyRequestedIds = [...new Set(explicitlyRequested.map(viewId))];
  const runtimeViews = preserveIndependentViews
    ? currentRequestViews(buildOptions.views, existing)
    : buildOptions.views;
  const retainedIds = preserveIndependentViews
    ? runtimeViews.map(viewId).filter((id) => !explicitlyRequestedIds.includes(id))
    : [];
  const retainedStaleness = await retainExplicitRegenerationReceipts(
    root, existing, explicitlyRequestedIds, buildOptions.cachePolicy
  );
  const runtime = await buildWorldModelV4(root, {
    ...buildOptions,
    views: runtimeViews,
    rebuildViewIds: buildOptions.cachePolicy === 'rebuild' ? explicitlyRequestedIds : [],
    cacheOnlyViewIds: retainedIds,
    preservedViews: existing?.views ?? []
  });
  if (runtime.requiredFailures.length) {
    return Object.freeze({
      schemaVersion: 1, // schema-transient: public API result envelope
      resultType: 'world-model-build-result',
      requestSha256: runtime.planned.request.requestSha256,
      status: 'refused',
      manifestSha256: null,
      views: Object.freeze(runtime.executions.map((entry) => ({
        viewId: entry.viewId,
        status: entry.markdown ? 'available' : 'unavailable',
        viewSha256: entry.viewSha256 ?? null,
        cache: entry.cache ?? 'miss'
      }))),
      refusals: runtime.refusals,
      warnings: retainedStaleness.warnings,
      next: Object.freeze(runtime.refusals.map((entry) => entry.nextAction)),
      stalenessReceipts: retainedStaleness.records,
      runtime,
      publication: null
    });
  }

  const dependencies = deriveWorldModelManifestDependencies({
    sourceSnapshot: runtime.planned.sourceSnapshot,
    scopeManifest: runtime.planned.scopeManifest,
    policySnapshotSha256: runtime.planned.request.policySnapshotSha256,
    viewRegistry: runtime.planned.viewRegistry,
    extractorRegistry: runtime.planned.extractorRegistry,
    evidenceCatalog: runtime.registration.evidenceCatalog,
    derivationCatalog: runtime.registration.derivationCatalog,
    factLedger: runtime.registration.factLedger
  });
  const views = runtime.executions.map((entry) => manifestView(runtime, entry))
    .sort((left, right) => left.viewId.localeCompare(right.viewId));
  const built = buildWorldModelManifest({
    subject: runtime.planned.sourceSnapshot.subject,
    dependencies,
    views,
    allowUnavailableOptionalViews
  });
  const staged = stageWorldModelPublication({
    outputDir,
    manifest: built.manifest,
    dependencies,
    views,
    records: publicationRecords(runtime),
    allowUnavailableOptionalViews
  });
  const publication = publish
    ? await publishWorldModelTransaction(root, ledgerConfig, staged, publicationOptions)
    : null;
  return Object.freeze({
    schemaVersion: 1, // schema-transient: public API result envelope
    resultType: 'world-model-build-result',
    requestSha256: runtime.planned.request.requestSha256,
    status: 'completed',
    manifestSha256: built.manifest.manifestSha256,
    views: Object.freeze(built.views.map((entry) => ({
      viewId: entry.viewId,
      status: entry.status,
      viewSha256: entry.viewSha256,
      cache: entry.cache
    }))),
    refusals: runtime.refusals,
    warnings: Object.freeze([
      ...(preservationWarning ? [preservationWarning] : []),
      ...retainedStaleness.warnings
    ]),
    next: Object.freeze([]),
    stalenessReceipts: retainedStaleness.records,
    runtime,
    manifest: built.manifest,
    staged,
    publication
  });
}

export function assertWorldModelV4BuildCompleted(result) {
  if (result?.status === 'completed') return result;
  const first = result?.refusals?.[0];
  throw new SingularityFlowError(
    first ? `World-model view '${first.view}' was refused: ${first.failures?.[0]?.reason ?? first.code}`
      : 'The WMB v4 build did not produce a complete manifest.',
    {
      code: first?.code ?? 'WMB_REQUIRED_VIEW_UNAVAILABLE',
      details: {
        requestSha256: result?.requestSha256 ?? null,
        requiredFailures: result?.runtime?.requiredFailures ?? [],
        refusals: result?.refusals ?? [],
        next: result?.next ?? []
      }
    }
  );
}
