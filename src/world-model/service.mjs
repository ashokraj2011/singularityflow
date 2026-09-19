import { types as utilTypes } from 'node:util';

import { SingularityFlowError } from '../util.mjs';
import { storeConservativeWorldModelStalenessReceipt } from './cache.mjs';
import {
  buildWorldModelManifest, deriveWorldModelManifestDependencies
} from './publish/manifest.mjs';
import {
  publishWorldModelTransaction, stageWorldModelPublication,
  validateStagedProjectionAuthorityAgainstSource
} from './publish/transaction.mjs';
import {
  clearWorldModelPublicationRecovery, prepareWorldModelPublicationRecovery
} from './recovery.mjs';
import {
  assertWorldModelHistoryPublicationEndpoint,
  assertWorldModelPublicationReview, captureWorldModelPublicationReview,
  materializeWorldModelPublicationReview, publicationRuntimeOptions
} from './publication-authority.mjs';
import { storeWorldModelQueryIndex } from './query-index.mjs';
import {
  buildWorldModelV4,
  retryFailedWorldModelV4View as retryFailedWorldModelV4ViewRuntime
} from './runtime.mjs';
import { runDeterministicRegistration } from './extract/runner.mjs';
import { planWorldModelV4 } from './plan.mjs';
import {
  buildPersistedWorldModelAfterLookupMiss,
  deriveFrozenV1WorldModelExtractionPolicy,
  lookupPersistedWorldModelBeforeExtraction,
  preparePersistedWorldModelBuild
} from './history/model-build.mjs';
import {
  resolvePublishedWorldModelV4, resolvePublishedWorldModelV4Authority
} from './store.mjs';
import {
  buildCalmProjection, createCalmProjectionRefusal, enforceProjectionBudgets,
  validateCalmProjectionCandidate
} from './projections/calm/projection.mjs';
import { compareText, isPlainRecord } from './canonicalize.mjs';
import { validateWorldModelHistoryRoots } from './history/paths.mjs';
import {
  materializePersistedWorldModelViews
} from './history/saved-view-publication.mjs';

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

function publicationRecords(runtime, projections = []) {
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
    refusals: runtime.refusals,
    projectionRegistry: runtime.planned.projectionRegistry,
    capabilitySnapshot: runtime.planned.capabilitySnapshot,
    configurationSnapshot: runtime.planned.configurationSnapshot,
    toolchainLock: runtime.planned.toolchainLock,
    architectureFactSet: projections.find((entry) => entry.factSet)?.factSet ?? null,
    projectionRefusals: projections.filter((entry) => entry.refusal).map((entry) => entry.refusal)
  };
}

function projectionPreserved(runtime) {
  return {
    sourceManifestSha256: runtime.planned.sourceSnapshot.sourceManifestSha256,
    scopeSha256: runtime.planned.scopeManifest.scopeSha256,
    factLedgerSha256: runtime.registration.factLedger.ledgerSha256,
    capabilitySnapshotSha256: runtime.planned.capabilitySnapshot?.snapshotSha256 ?? null,
    configurationSnapshotSha256: runtime.planned.configurationSnapshot?.snapshotSha256 ?? null,
    toolchainLockSha256: runtime.planned.toolchainLock?.lockSha256 ?? null
  };
}

function invalidPersistedHistoryOptions(message, details = {}) {
  throw new SingularityFlowError(message, {
    code: 'WMP_PERSISTED_HISTORY_OPTIONS_INVALID', details
  });
}

const MAXIMUM_HISTORY_OPTION_DEPTH = 32;
const MAXIMUM_HISTORY_OPTION_NODES = 10_000;
const MAXIMUM_HISTORY_OPTION_CONTAINER_ENTRIES = 4_096;
const MAXIMUM_HISTORY_OPTION_TEXT_BYTES = 1024 * 1024;

function retainedHistoryData(value) {
  let retained;
  let nodes = 0;
  let textBytes = 0;
  const containers = [];
  const pending = [{
    value,
    location: 'persistedHistory',
    depth: 0,
    ancestors: [],
    assign: (next) => { retained = next; }
  }];
  const accountText = (text, location) => {
    textBytes += Buffer.byteLength(text, 'utf8');
    if (textBytes > MAXIMUM_HISTORY_OPTION_TEXT_BYTES) {
      invalidPersistedHistoryOptions(
        `Persisted World-model history options exceed their ${MAXIMUM_HISTORY_OPTION_TEXT_BYTES}-byte text limit.`,
        { location, maximumTextBytes: MAXIMUM_HISTORY_OPTION_TEXT_BYTES }
      );
    }
  };
  while (pending.length) {
    const item = pending.pop();
    nodes += 1;
    if (nodes > MAXIMUM_HISTORY_OPTION_NODES) {
      invalidPersistedHistoryOptions(
        `Persisted World-model history options exceed their ${MAXIMUM_HISTORY_OPTION_NODES}-node limit.`,
        { maximumNodes: MAXIMUM_HISTORY_OPTION_NODES }
      );
    }
    const current = item.value;
    if (current === null || typeof current === 'boolean') {
      item.assign(current);
      continue;
    }
    if (typeof current === 'string') {
      accountText(current, item.location);
      item.assign(current);
      continue;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) {
        invalidPersistedHistoryOptions(
          `Persisted World-model history option '${item.location}' must be a finite number.`
        );
      }
      item.assign(Object.is(current, -0) ? 0 : current);
      continue;
    }
    if (!current || typeof current !== 'object' || utilTypes.isProxy(current)) {
      invalidPersistedHistoryOptions(
        `Persisted World-model history option '${item.location}' must contain retained JSON data only.`
      );
    }
    if (item.depth >= MAXIMUM_HISTORY_OPTION_DEPTH) {
      invalidPersistedHistoryOptions(
        `Persisted World-model history options exceed their ${MAXIMUM_HISTORY_OPTION_DEPTH}-level depth limit.`,
        { location: item.location, maximumDepth: MAXIMUM_HISTORY_OPTION_DEPTH }
      );
    }
    if (item.ancestors.includes(current)) {
      invalidPersistedHistoryOptions(
        `Persisted World-model history option '${item.location}' cannot contain a cycle.`
      );
    }
    const descriptors = Object.getOwnPropertyDescriptors(current);
    const keys = Reflect.ownKeys(current);
    const ancestors = [...item.ancestors, current];
    if (Array.isArray(current)) {
      if (current.length > MAXIMUM_HISTORY_OPTION_CONTAINER_ENTRIES) {
        invalidPersistedHistoryOptions(
          `Persisted World-model history option '${item.location}' exceeds its array-entry limit.`,
          { maximumEntries: MAXIMUM_HISTORY_OPTION_CONTAINER_ENTRIES }
        );
      }
      const unexpected = keys.filter((key) => {
        if (key === 'length') return false;
        if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(key)) return true;
        const index = Number(key);
        return !Number.isSafeInteger(index) || index >= current.length;
      });
      if (unexpected.length || keys.length !== current.length + 1) {
        invalidPersistedHistoryOptions(
          `Persisted World-model history option '${item.location}' contains unsupported array properties or sparse entries.`,
          { unexpected: unexpected.map(String).sort(compareText) }
        );
      }
      const output = new Array(current.length);
      item.assign(output);
      containers.push(output);
      for (let index = current.length - 1; index >= 0; index -= 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !Object.hasOwn(descriptor, 'value')
            || typeof descriptor.get === 'function' || typeof descriptor.set === 'function') {
          invalidPersistedHistoryOptions(
            `Persisted World-model history option '${item.location}[${index}]' cannot be an accessor.`
          );
        }
        pending.push({
          value: descriptor.value,
          location: `${item.location}[${index}]`,
          depth: item.depth + 1,
          ancestors,
          assign: (next) => { output[index] = next; }
        });
      }
      continue;
    }
    if (!isPlainRecord(current)) {
      invalidPersistedHistoryOptions(
        `Persisted World-model history option '${item.location}' must be a plain data object.`
      );
    }
    if (keys.length > MAXIMUM_HISTORY_OPTION_CONTAINER_ENTRIES) {
      invalidPersistedHistoryOptions(
        `Persisted World-model history option '${item.location}' exceeds its object-field limit.`,
        { maximumFields: MAXIMUM_HISTORY_OPTION_CONTAINER_ENTRIES }
      );
    }
    const symbolic = keys.filter((key) => typeof key !== 'string');
    if (symbolic.length) {
      invalidPersistedHistoryOptions(
        `Persisted World-model history option '${item.location}' cannot contain symbol properties.`
      );
    }
    const ordered = [...keys].sort(compareText);
    const output = Object.create(null);
    item.assign(output);
    containers.push(output);
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const key = ordered[index];
      accountText(key, `${item.location}.${key}`);
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, 'value')
          || typeof descriptor.get === 'function' || typeof descriptor.set === 'function') {
        invalidPersistedHistoryOptions(
          `Persisted World-model history option '${item.location}.${key}' cannot be an accessor.`
        );
      }
      pending.push({
        value: descriptor.value,
        location: `${item.location}.${key}`,
        depth: item.depth + 1,
        ancestors,
        assign: (next) => { output[key] = next; }
      });
    }
  }
  for (let index = containers.length - 1; index >= 0; index -= 1) {
    Object.freeze(containers[index]);
  }
  return retained;
}

function persistedHistoryConfiguration(value) {
  if (value === false || value == null) return null;
  if (value === true) return Object.freeze({});
  if (typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)
      || !isPlainRecord(value)) {
    throw new SingularityFlowError(
      'Persisted World-model history integration must be a boolean or a bounded options object.',
      { code: 'WMP_PERSISTED_HISTORY_OPTIONS_INVALID' }
    );
  }
  const allowed = new Set([
    'authorityCommit', 'authorityRef', 'historyDir',
    'pinnedCapabilityResolution', 'savedViews'
  ]);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  const unknown = keys.filter((key) => typeof key !== 'string' || !allowed.has(key))
    .map(String).sort(compareText);
  if (unknown.length) {
    throw new SingularityFlowError(
      `Persisted World-model history options contain unsupported field(s): ${unknown.join(', ')}.`,
      {
        code: 'WMP_PERSISTED_HISTORY_OPTIONS_INVALID',
        details: { unknown }
      }
    );
  }
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')
        || typeof descriptor.get === 'function' || typeof descriptor.set === 'function') {
      invalidPersistedHistoryOptions(
        `Persisted World-model history option '${String(key)}' cannot be an accessor.`
      );
    }
  }
  return retainedHistoryData(value);
}

function retainedPersistedFacts(resolved) {
  const closure = resolved?.closure;
  if (!Array.isArray(closure)) {
    throw new SingularityFlowError(
      'Persisted World-model reuse did not return its verified retained closure.',
      { code: 'WMP_INTEGRITY_FAILED' }
    );
  }
  const recordFor = (role) => {
    const matches = closure.filter((entry) => entry?.ref?.role === role);
    if (matches.length !== 1 || !matches[0].record) {
      throw new SingularityFlowError(
        `Persisted World-model reuse requires exactly one '${role}' record.`,
        { code: 'WMP_INPUT_ROLE_MISSING', details: { role, matches: matches.length } }
      );
    }
    return matches[0].record;
  };
  return Object.freeze({
    evidenceCatalog: recordFor('evidence-catalog'),
    derivationCatalog: recordFor('derivation-catalog'),
    factLedger: recordFor('fact-ledger')
  });
}

function retainedRegistrationFacts(registration) {
  if (!registration?.evidenceCatalog || !registration?.derivationCatalog
      || !registration?.factLedger) {
    throw new SingularityFlowError(
      'Completed persisted-model registration did not return its exact fact records.',
      { code: 'WMP_INTEGRITY_FAILED' }
    );
  }
  return Object.freeze({
    evidenceCatalog: registration.evidenceCatalog,
    derivationCatalog: registration.derivationCatalog,
    factLedger: registration.factLedger
  });
}

function historyLookupOptions(options) {
  const allowed = [
    'authorityCommit', 'authorityRef', 'historyDir',
    'pinnedCapabilityResolution'
  ];
  return Object.fromEntries(allowed.filter((key) => options[key] !== undefined)
    .map((key) => [key, options[key]]));
}

function assertHistoryPublicationAuthority(authority, publicationReview) {
  if (!authority || !publicationReview) {
    throw new SingularityFlowError(
      'Persisted World-model history has no exact reviewed publication authority.',
      { code: 'WMP_HISTORY_PUBLICATION_AUTHORITY_MISMATCH' }
    );
  }
  const expectedRef = publicationReview.endpoint?.configured
    ? `refs/remotes/${publicationReview.remote}/${publicationReview.branch}`
    : publicationReview.targetRef;
  const expectedCommit = publicationReview.publicationBase;
  const historyRepositoryIdentitySha256 = authority.repositoryIdentitySha256 ?? null;
  const publicationConfiguredRepositoryIdentitySha256 =
    publicationReview.endpoint?.configuredUrlSha256 ?? null;
  const publicationEffectiveRepositoryIdentitySha256 =
    publicationReview.endpoint?.effectiveUrlSha256 ?? null;
  const repositoryIdentityMismatch = publicationReview.endpoint?.configured
    ? historyRepositoryIdentitySha256 === null
      || historyRepositoryIdentitySha256 !== publicationConfiguredRepositoryIdentitySha256
      || historyRepositoryIdentitySha256 !== publicationEffectiveRepositoryIdentitySha256
    : historyRepositoryIdentitySha256 !== null
      || publicationConfiguredRepositoryIdentitySha256 !== null
      || publicationEffectiveRepositoryIdentitySha256 !== null;
  if (authority.ref !== expectedRef || authority.commit !== expectedCommit
      || repositoryIdentityMismatch) {
    throw new SingularityFlowError(
      'Persisted World-model history authority does not equal the reviewed state publication authority.',
      {
        code: 'WMP_HISTORY_PUBLICATION_AUTHORITY_MISMATCH',
        details: {
          expectedRef,
          receivedRef: authority.ref ?? null,
          expectedCommit,
          receivedCommit: authority.commit ?? null,
          historyRepositoryIdentitySha256,
          publicationConfiguredRepositoryIdentitySha256,
          publicationEffectiveRepositoryIdentitySha256
        }
      }
    );
  }
  return authority;
}

async function buildRequestedProjections(runtime) {
  const requested = runtime.planned.requestedProjections ?? [];
  if (!requested.length) return Object.freeze([]);
  const outputs = [];
  for (const selection of requested) {
    try {
      if (runtime.planned.projectionSetupError) {
        throw new SingularityFlowError(runtime.planned.projectionSetupError.message, {
          code: runtime.planned.projectionSetupError.code
        });
      }
      if (selection.projectionId !== 'arch.calm') {
        throw new SingularityFlowError(`Projection '${selection.projectionId}' has no installed mapper.`, {
          code: 'WMC_PROJECTION_NOT_CONFIGURED'
        });
      }
      const candidate = buildCalmProjection({
        subject: runtime.planned.sourceSnapshot.subject,
        subjectLabel: runtime.planned.sourceSnapshot.subject.id,
        sourceManifestSha256: runtime.planned.sourceSnapshot.sourceManifestSha256,
        scopeSha256: runtime.planned.scopeManifest.scopeSha256,
        factLedger: runtime.registration.factLedger,
        capabilitySnapshot: runtime.planned.capabilitySnapshot,
        configurationSnapshot: runtime.planned.configurationSnapshot,
        includeGovernanceActors: selection.profile?.includeGovernanceActors !== false,
        includeControls: selection.profile?.includeControls !== false,
        includeFlows: selection.profile?.includeFlows !== false,
        includeExternalDependencies: selection.profile?.includeExternalDependencies
          ?? 'direct-architecture-only',
        projectionContract: selection.contract
      });
      enforceProjectionBudgets(candidate.projection, {
        ...selection.contract.budgets, ...selection.budgets
      });
      const validated = await validateCalmProjectionCandidate(candidate, {
        strict: selection.validation?.strict !== false
      });
      if (validated.validationResult.toolchainLock.lockSha256 !== runtime.planned.toolchainLock.lockSha256) {
        throw new SingularityFlowError('CALM toolchain changed after the build plan was sealed.', {
          code: 'WMC_CALM_VALIDATOR_UNAVAILABLE'
        });
      }
      outputs.push(Object.freeze({
        projectionId: selection.projectionId,
        projectionVersion: selection.contract.version,
        required: selection.required,
        status: 'available',
        path: selection.contract.output.path,
        projection: validated.projection,
        projectionBytes: validated.projectionBytes,
        projectionSha256: validated.projectionSha256,
        sourceMap: validated.sourceMap,
        receipt: validated.receipt,
        factSet: validated.factSet,
        refusal: null
      }));
    } catch (error) {
      const refusal = createCalmProjectionRefusal({
        code: error?.code ?? 'WMC_PROJECTION_UNAVAILABLE', error,
        preserved: projectionPreserved(runtime)
      });
      outputs.push(Object.freeze({
        projectionId: selection.projectionId,
        projectionVersion: selection.contract.version,
        required: selection.required,
        status: 'unavailable',
        path: null, projection: null, projectionBytes: null, projectionSha256: null,
        sourceMap: null, receipt: null, factSet: null, refusal
      }));
    }
  }
  return Object.freeze(outputs);
}

function viewId(value) {
  return String(typeof value === 'string' ? value : value?.viewId ?? '').replace(/@\d+$/, '');
}

function cacheWarnings(runtime) {
  return Object.freeze((runtime.cacheDiagnostics ?? [])
    .filter((entry) => ['corrupt', 'unavailable'].includes(entry.status))
    .map((entry) => (
      `World-model ${entry.level ?? 'derived'} cache ${entry.operation ?? 'operation'} for `
      + `'${entry.viewId ?? 'unknown view'}' was ${entry.status}`
      + `${entry.code ? ` (${entry.code})` : ''}; authoritative evidence and valid local execution continue unchanged.`
    )));
}

async function retainQueryIndex(root, manifest, runtime) {
  try {
    const stored = await storeWorldModelQueryIndex(root, {
      manifest,
      evidenceCatalog: runtime.registration.evidenceCatalog,
      derivationCatalog: runtime.registration.derivationCatalog,
      factLedger: runtime.registration.factLedger
    });
    return Object.freeze({
      status: 'ready',
      indexSha256: stored.index.indexSha256,
      path: stored.path,
      written: stored.written,
      warning: null
    });
  } catch (error) {
    // Query indexes are derived memory. A failure is observable but cannot invalidate or block the
    // independently verified manifest/evidence graph from which the index can be rebuilt.
    return Object.freeze({
      status: 'unavailable',
      indexSha256: null,
      path: null,
      written: false,
      warning: `World-model query index could not be retained (${error?.code ?? 'WMB_QUERY_INDEX_UNAVAILABLE'}); the verified projection remains publishable and the index can be rebuilt.`
    });
  }
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

function preservationAuthority(review, existing) {
  if (!review) return null;
  return Object.freeze({
    commit: review.publicationBase ?? null,
    manifestSha256: existing?.manifest?.manifestSha256 ?? null
  });
}

function assertExpectedPreservationAuthority(expected, actual) {
  if (expected == null) return;
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)
      || !/^[a-f0-9]{40,64}$/.test(String(expected.commit ?? ''))
      || !/^sha256:[a-f0-9]{64}$/.test(String(expected.manifestSha256 ?? ''))) {
    throw new SingularityFlowError(
      'The automatic World-Model extension authority binding is malformed.',
      { code: 'WMB_AUTOMATIC_EXTENSION_AUTHORITY_INVALID' }
    );
  }
  if (actual?.commit !== expected.commit
      || actual?.manifestSha256 !== expected.manifestSha256) {
    throw new SingularityFlowError(
      'The registered World-Model authority changed after automatic extension was authorized. No view was generated or published.',
      {
        code: 'WMB_AUTOMATIC_EXTENSION_BASE_CHANGED',
        details: {
          expectedCommit: expected.commit,
          currentCommit: actual?.commit ?? null,
          expectedManifestSha256: expected.manifestSha256,
          currentManifestSha256: actual?.manifestSha256 ?? null
        }
      }
    );
  }
}

function exactPreservationStore(root, review, outputDir) {
  try {
    return resolvePublishedWorldModelV4Authority(root, {
      authorityCommit: review.publicationBase,
      outputDir,
      required: false
    });
  } catch (error) {
    // An explicit registered-v4 build may replace a legacy projection, but it still remains bound
    // to that legacy projection's immutable authority commit throughout execution.
    if (error?.code === 'WMB_MIGRATION_REQUIRED') return null;
    throw error;
  }
}

async function assertPreservationAuthority(root, review, expected, {
  outputDir, ledgerConfig, publicationOptions
}) {
  const currentReview = await assertWorldModelPublicationReview(root, review, {
    outputDir, ledgerConfig, publicationOptions
  });
  const current = exactPreservationStore(root, currentReview, outputDir);
  const actual = preservationAuthority(currentReview, current);
  if (actual.commit !== expected.commit
      || actual.manifestSha256 !== expected.manifestSha256) {
    throw new SingularityFlowError(
      'The registered world-model preservation authority changed during the build.',
      {
        code: 'WMB_GATEWAY_PLAN_DRIFTED',
        details: {
          expectedAuthorityCommit: expected.commit,
          currentAuthorityCommit: actual.commit,
          expectedManifestSha256: expected.manifestSha256,
          currentManifestSha256: actual.manifestSha256
        }
      }
    );
  }
  return currentReview;
}

/** Resolve the exact complete view set a preserving build will plan before any composition starts. */
export function resolveWorldModelV4BuildViews(root, {
  views,
  outputDir = 'singularity/world-model',
  ledgerConfig = {},
  preserveIndependentViews = true,
  authorityCommit = undefined
} = {}) {
  if (!preserveIndependentViews) return Object.freeze([...(views ?? [])]);
  let existing = null;
  try {
    existing = authorityCommit !== undefined
      ? resolvePublishedWorldModelV4Authority(root, {
          authorityCommit, outputDir, required: false
        })
      : resolvePublishedWorldModelV4(root, {
          outputDir,
          stateBranch: ledgerConfig.branch ?? 'state',
          remote: ledgerConfig.remote ?? 'origin',
          required: false
        });
  } catch (error) {
    if (error?.code !== 'WMB_MIGRATION_REQUIRED') throw error;
  }
  return Object.freeze(currentRequestViews(views, existing));
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
  expectedBuildIdentity = null,
  expectedPublication = null,
  expectedPreservationAuthority = null,
  persistedHistory = false,
  ...buildOptions
} = {}) {
  if (Object.hasOwn(buildOptions, 'persistedFacts')) {
    throw new SingularityFlowError(
      'Persisted World-model facts are an internal verified-history input and cannot be supplied to the publication service.',
      { code: 'WMP_PERSISTED_FACTS_CALLER_FORBIDDEN' }
    );
  }
  const historyOptions = persistedHistoryConfiguration(persistedHistory);
  const historyRoots = historyOptions ? validateWorldModelHistoryRoots({
    outputDir,
    ...(historyOptions.historyDir === undefined ? {} : { historyDir: historyOptions.historyDir })
  }) : null;
  if (historyOptions?.savedViews !== undefined) {
    if (!isPlainRecord(historyOptions.savedViews)) {
      throw new SingularityFlowError(
        'Persisted saved-view options must be a bounded plain object.',
        { code: 'WMP_PERSISTED_HISTORY_OPTIONS_INVALID' }
      );
    }
    const reserved = ['model', 'outputDir', 'historyDir'].filter(
      (field) => Object.hasOwn(historyOptions.savedViews, field)
    );
    if (reserved.length) {
      throw new SingularityFlowError(
        `Persisted saved-view options cannot replace verified authority field(s): ${reserved.join(', ')}.`,
        {
          code: 'WMP_PERSISTED_FACTS_CALLER_FORBIDDEN',
          details: { reserved }
        }
      );
    }
  }
  if (historyOptions?.savedViews !== undefined && !publish) {
    throw new SingularityFlowError(
      'Persisted saved views require the reviewed one-CAS state publication path.',
      { code: 'WMP_SAVED_VIEW_PUBLICATION_REQUIRED' }
    );
  }
  if (publish && buildOptions.candidateSnapshot?.authority?.kind === 'candidate-snapshot') {
    throw new SingularityFlowError(
      'Candidate Snapshot builds are checkout-local and cannot be published as reusable state authority. Validate with --local, then commit the reviewed source and publish a clean-source build.',
      {
        code: 'WMB_CANDIDATE_SNAPSHOT_LOCAL_ONLY',
        details: {
          sourceManifestSha256: buildOptions.candidateSnapshot.sourceManifestSha256 ?? null
        }
      }
    );
  }
  // Bind preservation to the exact current state authority before planning or composition. Direct
  // CLI builds capture it here; gateway builds recheck the already confirmed review. Materializing
  // that exact commit refreshes the tracking ref without allowing a newer or older base to slip in.
  let confirmedPublication = null;
  if (publish) {
    confirmedPublication = expectedPublication
      ? await assertWorldModelPublicationReview(root, expectedPublication, {
          outputDir, ledgerConfig, publicationOptions,
          requireHistoryPublicationEndpoint: Boolean(historyOptions)
        })
      : await captureWorldModelPublicationReview(root, {
          outputDir, ledgerConfig, publicationOptions,
          requireHistoryPublicationEndpoint: Boolean(historyOptions)
        });
    if (historyOptions) {
      assertWorldModelHistoryPublicationEndpoint(root, confirmedPublication);
    }
    confirmedPublication = await materializeWorldModelPublicationReview(
      root, confirmedPublication, {
        publicationOptions,
        requireHistoryPublicationEndpoint: Boolean(historyOptions)
      }
    );
  }
  let existing = null;
  let preservationWarning = null;
  let exactAuthority = null;
  if (publish) {
    try {
      exactAuthority = resolvePublishedWorldModelV4Authority(root, {
        authorityCommit: confirmedPublication.publicationBase,
        outputDir,
        required: false
      });
    } catch (error) {
      // An explicit v4 build is a legal replacement for legacy output. Corrupt/partial v4 state
      // still fails closed instead of being silently overwritten.
      if (error?.code !== 'WMB_MIGRATION_REQUIRED') throw error;
      preservationWarning = 'Legacy v3 output was not imported; this explicit WMB v4 rebuild replaces it without trusting legacy claims.';
    }
  }
  if (preserveIndependentViews) {
    existing = exactAuthority;
    if (!publish) {
      try {
        existing = resolvePublishedWorldModelV4(root, {
          outputDir,
          stateBranch: ledgerConfig.branch ?? 'state',
          remote: ledgerConfig.remote ?? 'origin',
          required: false
        });
      } catch (error) {
        if (error?.code !== 'WMB_MIGRATION_REQUIRED') throw error;
        preservationWarning = 'Legacy v3 output was not imported; this explicit WMB v4 rebuild replaces it without trusting legacy claims.';
      }
    }
  }
  const boundPreservationAuthority = preservationAuthority(
    confirmedPublication, publish ? exactAuthority : existing
  );
  // An unattended progressive build is authorized against one exact verified state projection.
  // Bind before registration/composition so a concurrent deletion, replacement, or state advance
  // cannot turn that narrow authorization into an implicit first build or replacement.
  assertExpectedPreservationAuthority(
    expectedPreservationAuthority, boundPreservationAuthority
  );
  const explicitlyRequested = Array.isArray(buildOptions.views) ? buildOptions.views : [];
  const explicitlyRequestedIds = [...new Set(explicitlyRequested.map(viewId))];
  const runtimeViews = preserveIndependentViews
    ? currentRequestViews(buildOptions.views, existing)
    : buildOptions.views;
  const retainedIds = preserveIndependentViews
    ? runtimeViews.map(viewId).filter((id) => !explicitlyRequestedIds.includes(id))
    : [];
  let persistedModel = null;
  let persistedAcceptedModel = null;
  let persistedRegistrationCalls = 0;
  let runtime = null;
  if (historyOptions && publish && !buildOptions.candidateSnapshot
      && !buildOptions.legacyMigration) {
    const planned = planWorldModelV4(root, { ...buildOptions, views: runtimeViews });
    const extractionPolicy = deriveFrozenV1WorldModelExtractionPolicy(
      planned.scopeManifest, planned.extractorRegistry, planned.extractorReferences
    );
    const lookupOptions = {
      ...historyLookupOptions(historyOptions),
      ...historyRoots
    };
    const preparation = await preparePersistedWorldModelBuild(root, {
      capabilityId: planned.scopeManifest.capabilityId,
      sourceSnapshot: planned.sourceSnapshot,
      scopeManifest: planned.scopeManifest,
      extractionPolicy,
      extractorRegistry: planned.extractorRegistry,
      extractorReferences: planned.extractorReferences,
      requestedRevision: planned.sourceSnapshot.revision.commit,
      ...(historyOptions.pinnedCapabilityResolution === undefined ? {} : {
        pinnedCapabilityResolution: historyOptions.pinnedCapabilityResolution
      }),
      ...(historyOptions.resolveRepositoryAuthority === undefined ? {} : {
        resolveRepositoryAuthority: historyOptions.resolveRepositoryAuthority
      })
    });
    const lookup = await lookupPersistedWorldModelBeforeExtraction(root, {
      preparation,
      ...lookupOptions
    });
    assertHistoryPublicationAuthority(lookup.authority, confirmedPublication);
    if (lookup.status === 'reused') {
      persistedAcceptedModel = Object.freeze({
        binding: lookup.resolved.binding,
        objects: Object.freeze(lookup.resolved.closure.map((entry) => Object.freeze({
          ref: entry.ref, bytes: entry.canonicalBytes, record: entry.record
        })))
      });
      persistedModel = Object.freeze({
        status: 'reused', modelKey: lookup.modelKey,
        authority: lookup.authority, stagedHistory: null,
        bindingPath: lookup.bindingPath,
        bindingSha256: lookup.resolved.binding.bindingSha256,
        execution: Object.freeze({
          ...lookup.execution, registrationCalls: persistedRegistrationCalls
        })
      });
      runtime = await buildWorldModelV4(root, {
        ...buildOptions,
        views: runtimeViews,
        rebuildViewIds: buildOptions.cachePolicy === 'rebuild' ? explicitlyRequestedIds : [],
        cacheOnlyViewIds: retainedIds,
        preservedViews: existing?.views ?? [],
        expectedBuildIdentity,
        persistedFacts: retainedPersistedFacts(lookup.resolved)
      });
    } else {
      let baseRegistration = null;
      const built = await buildPersistedWorldModelAfterLookupMiss(root, {
        preparation,
        lookup,
        requestedViews: [],
        viewRegistry: planned.viewRegistry,
        ...lookupOptions,
        runRegistration: async (registrationOptions) => {
          persistedRegistrationCalls += 1;
          baseRegistration = runDeterministicRegistration(registrationOptions);
          return baseRegistration;
        }
      });
      assertHistoryPublicationAuthority(built.authority ?? lookup.authority, confirmedPublication);
      persistedAcceptedModel = Object.freeze({
        binding: built.binding,
        objects: built.objects
      });
      runtime = await buildWorldModelV4(root, {
        ...buildOptions,
        views: runtimeViews,
        rebuildViewIds: buildOptions.cachePolicy === 'rebuild'
          ? explicitlyRequestedIds : [],
        cacheOnlyViewIds: retainedIds,
        preservedViews: existing?.views ?? [],
        expectedBuildIdentity,
        persistedFacts: retainedRegistrationFacts(baseRegistration)
      });
      persistedModel = Object.freeze({
        status: built.status,
        reasonCode: built.reasonCode ?? null,
        modelKey: built.modelKey,
        authority: built.authority ?? lookup.authority,
        stagedHistory: built.stagedHistory,
        bindingPath: built.bindingPath ?? null,
        bindingSha256: built.binding?.bindingSha256 ?? null,
        execution: Object.freeze({
          ...built.execution, registrationCalls: persistedRegistrationCalls
        })
      });
    }
    if (historyOptions.savedViews !== undefined) {
      if (!persistedAcceptedModel) {
        throw new SingularityFlowError(
          'Persisted saved-view materialization has no accepted Model Binding closure.',
          { code: 'WMP_GROUNDING_NOT_READY' }
        );
      }
      const savedViews = materializePersistedWorldModelViews({
        ...historyOptions.savedViews,
        model: persistedAcceptedModel,
        outputDir: historyRoots.outputDir,
        historyDir: historyRoots.historyDir
      });
      persistedModel = Object.freeze({
        ...persistedModel,
        stagedHistory: savedViews.stagedHistory,
        savedViews
      });
    }
  }
  if (!runtime) {
    runtime = await buildWorldModelV4(root, {
      ...buildOptions,
      views: runtimeViews,
      rebuildViewIds: buildOptions.cachePolicy === 'rebuild' ? explicitlyRequestedIds : [],
      cacheOnlyViewIds: retainedIds,
      preservedViews: existing?.views ?? [],
      expectedBuildIdentity
    });
  }
  // A model-backed build can be long-running. Recheck the exact endpoint and CAS authority before
  // retaining any post-build receipt, recovery marker, or publication state.
  if (publish) {
    confirmedPublication = await assertPreservationAuthority(
      root, confirmedPublication, boundPreservationAuthority,
      { outputDir, ledgerConfig, publicationOptions }
    );
  }
  const retainedStaleness = await retainExplicitRegenerationReceipts(
    root, existing, explicitlyRequestedIds, buildOptions.cachePolicy
  );
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
      warnings: Object.freeze([
        ...retainedStaleness.warnings,
        ...cacheWarnings(runtime)
      ]),
      next: Object.freeze(runtime.refusals.map((entry) => entry.nextAction)),
      stalenessReceipts: retainedStaleness.records,
      runtime,
      publication: null
    });
  }

  const projections = await buildRequestedProjections(runtime);
  const requiredProjectionFailures = projections.filter(
    (entry) => entry.required && entry.status !== 'available'
  );
  if (requiredProjectionFailures.length) {
    return Object.freeze({
      schemaVersion: 1, resultType: 'world-model-build-result',
      requestSha256: runtime.planned.request.requestSha256, status: 'refused', manifestSha256: null,
      views: Object.freeze(runtime.executions.map((entry) => ({
        viewId: entry.viewId, status: entry.markdown ? 'available' : 'unavailable',
        viewSha256: entry.viewSha256 ?? null, cache: entry.cache ?? 'miss'
      }))),
      projections: Object.freeze(projections.map((entry) => ({
        projectionId: entry.projectionId, status: entry.status,
        projectionSha256: entry.projectionSha256, refusalSha256: entry.refusal?.refusalSha256 ?? null
      }))),
      refusals: Object.freeze(requiredProjectionFailures.map((entry) => entry.refusal)),
      warnings: Object.freeze(cacheWarnings(runtime)),
      next: Object.freeze([{ command: 'singularity-flow architecture doctor --json' }]),
      runtime, publication: null
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
    .sort((left, right) => compareText(left.viewId, right.viewId));
  const built = buildWorldModelManifest({
    subject: runtime.planned.sourceSnapshot.subject,
    dependencies,
    views,
    allowUnavailableOptionalViews,
    projectionRegistry: projections.length ? runtime.planned.projectionRegistry : null,
    projections
  });
  const staged = stageWorldModelPublication({
    outputDir,
    manifest: built.manifest,
    dependencies,
    views,
    records: publicationRecords(runtime, projections),
    projections,
    allowUnavailableOptionalViews,
    ...(persistedModel?.stagedHistory ?? {})
  });
  if (publish) await validateStagedProjectionAuthorityAgainstSource(root, staged);
  const queryIndex = await retainQueryIndex(root, built.manifest, runtime);
  let publication = null;
  let publicationRecovery = null;
  let publicationRecoveryRetained = null;
  if (publish) {
    // Persist the exact, fully validated projection before the state-branch CAS. A provider result
    // must never be lost merely because Git transport failed after composition completed, and a
    // retry must not spend again or reconstruct a subtly different projection from mutable inputs.
    const publicationReview = await assertPreservationAuthority(
      root, confirmedPublication, boundPreservationAuthority,
      { outputDir, ledgerConfig, publicationOptions }
    );
    const exactPublicationOptions = publicationReview.options;
    publicationRecovery = await prepareWorldModelPublicationRecovery(
      root, publicationReview.ledger, staged, { publicationOptions: exactPublicationOptions }
    );
    try {
      const runtimePublicationOptions = publicationRuntimeOptions(
        root, publicationReview, publicationOptions
      );
      publication = await publishWorldModelTransaction(
        root, publicationRecovery.record.ledger, publicationRecovery.record.publication,
        runtimePublicationOptions
      );
      publicationRecoveryRetained = false;
      await clearWorldModelPublicationRecovery(root, publicationRecovery.id).catch(() => {
        // Publication is already atomic and authoritative. A cleanup failure leaves an idempotent
        // marker whose exact replay becomes a no-op; it must not turn a successful push into a lie.
        publicationRecoveryRetained = true;
      });
    } catch (error) {
      throw new SingularityFlowError(
        `WMB v4 generation and validation completed, but atomic state publication failed: ${error.message}`,
        {
          code: 'WMB_PUBLICATION_RECOVERY_REQUIRED',
          details: {
            recoveryId: publicationRecovery.id,
            requestSha256: runtime.planned.request.requestSha256,
            planSha256: runtime.planned.plan.planSha256,
            manifestSha256: built.manifest.manifestSha256,
            recoveryCommand: `singularity-flow wm recovery publish ${publicationRecovery.id} --confirm ${publicationRecovery.id}`,
            causeCode: error.code ?? null
          },
          cause: error
        }
      );
    }
  }
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
    projections: Object.freeze(built.projections.map((entry) => ({
      projectionId: entry.projectionId, status: entry.status,
      projectionSha256: entry.projectionSha256,
      refusalSha256: entry.refusal?.refusalSha256 ?? null
    }))),
    refusals: runtime.refusals,
    warnings: Object.freeze([
      ...(preservationWarning ? [preservationWarning] : []),
      ...retainedStaleness.warnings,
      ...cacheWarnings(runtime),
      ...(queryIndex.warning ? [queryIndex.warning] : [])
    ]),
    next: Object.freeze([]),
    stalenessReceipts: retainedStaleness.records,
    runtime,
    manifest: built.manifest,
    queryIndex,
    staged,
    publication,
    preservationAuthority: boundPreservationAuthority,
    persistedModel: persistedModel ? Object.freeze({
      status: persistedModel.status,
      reasonCode: persistedModel.reasonCode ?? null,
      modelKey: persistedModel.modelKey,
      authority: persistedModel.authority,
      bindingPath: persistedModel.bindingPath,
      bindingSha256: persistedModel.bindingSha256,
      execution: persistedModel.execution,
      savedViews: persistedModel.savedViews ? Object.freeze({
        status: persistedModel.savedViews.status,
        measurementPolicy: persistedModel.savedViews.measurementPolicy,
        views: persistedModel.savedViews.views.map((entry) => Object.freeze({
          reference: entry.reference,
          variant: entry.variant,
          format: entry.format,
          viewKey: entry.viewKey,
          bindingSha256: entry.bindingSha256,
          expansionHandle: entry.expansionHandle,
          bytes: entry.bytes
        }))
      }) : null
    }) : null,
    publicationRecovery: publicationRecovery
      ? Object.freeze({ id: publicationRecovery.id, retained: publicationRecoveryRetained }) : null
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

/**
 * Service facade for the immutable kernel retry. It deliberately returns a ready-to-publish
 * runtime instead of silently publishing a partial prior build; callers retain the ordinary
 * explicit publication boundary after inspecting the retry receipt.
 */
export async function retryFailedWorldModelV4View(root, previousBuildResult, options = {}) {
  return retryFailedWorldModelV4ViewRuntime(root, previousBuildResult, options);
}

export const retryFailedWorldModelView = retryFailedWorldModelV4View;
