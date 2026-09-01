import { loadDefinition } from '../../config.mjs';
import {
  projectWorldModelIdeSlice, readWorldModelIdeExpansion, worldModelSourceExpansionReference
} from '../../world-model/ide/slice.mjs';
import { resolvePublishedWorldModelV4 } from '../../world-model/store.mjs';
import { noEffects, preservedAll, sflowResult } from '../result.mjs';

const MAX_CLAIM_BYTES = 4_096;

/**
 * Closed names for the recommendations returned by `world-model.next`.
 *
 * These are recommendation categories, not reason codes. Exporting the vocabulary keeps the
 * gateway catalog sweep from having to infer that distinction from the same dotted-string shape.
 */
export const WORLD_MODEL_RECOMMENDATION_OPERATIONS = Object.freeze([
  'world-model.plan',
  'world-model.doctor',
  'world-model.views',
  'world-model.regenerate',
  'world-model.validate-view',
  'world-model.validate'
]);

function boundedText(value, maximumBytes = MAX_CLAIM_BYTES) {
  if (value == null) return { text: null, truncated: false };
  const bytes = Buffer.from(String(value), 'utf8');
  if (bytes.length <= maximumBytes) return { text: String(value), truncated: false };
  let end = maximumBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return { text: `${bytes.subarray(0, end).toString('utf8')}…`, truncated: true };
}

async function authority(root) {
  const definition = await loadDefinition(root);
  return resolvePublishedWorldModelV4(root, {
    outputDir: definition.worldModel?.outputDir ?? 'singularity/world-model',
    stateBranch: definition.ledger?.branch ?? 'state',
    remote: definition.git?.remote ?? 'origin'
  });
}

function selectEntity(store, entity, id, {
  root = null, offset = 0, maximumBytes = undefined, viewId = null
} = {}) {
  if (entity === 'manifest') return projectWorldModelIdeSlice(store);
  if (entity === 'view') {
    const view = projectWorldModelIdeSlice(store).views.find((entry) => entry.viewId === id);
    return view ?? null;
  }
  if (entity === 'fact') {
    const fact = store.factLedger.facts.find((entry) => entry.id === id);
    if (!fact) return null;
    const claim = boundedText(fact.claim);
    return { ...structuredClone(fact), claim: claim.text, claimTruncated: claim.truncated };
  }
  if (entity === 'evidence') {
    const evidence = store.evidenceCatalog.items.find((entry) => entry.id === id);
    if (!evidence) return null;
    const selectedLedger = viewId
      ? store.records?.viewFactLedgers?.find((entry) => entry.viewId === viewId)
      : null;
    const selectedEvidence = selectedLedger?.facts?.some((fact) => fact.evidenceIds.includes(evidence.id));
    return {
      ...structuredClone(evidence),
      exactSource: selectedEvidence
        ? worldModelSourceExpansionReference(store, evidence.locator.path, { viewId })
        : null
    };
  }
  if (entity === 'derivation') {
    return structuredClone(store.derivationCatalog.derivations.find((entry) => entry.id === id) ?? null);
  }
  if (entity === 'refusal') {
    return structuredClone((store.records?.refusals ?? []).find((entry) =>
      entry.refusalSha256 === id || entry.view === id || entry.code === id) ?? null);
  }
  if (entity === 'expansion') {
    if (!root) return null;
    return readWorldModelIdeExpansion(root, store, id, {
      offset,
      ...(maximumBytes == null ? {} : { maximumBytes })
    });
  }
  return null;
}

function refusal(operation, subject, code, reference = null) {
  return sflowResult({
    kind: 'refusal',
    operation: { id: operation.id, classification: 'read' },
    subject,
    outcome: { status: 'refused', messageId: 'gateway.refused', slots: {} },
    effects: noEffects(),
    why: [{ code, source: 'unavailable', reference }],
    preserved: preservedAll('gateway.nothing-was-carried-out'),
    restState: 'unavailable'
  });
}

function nextRecommendation(store, error, requestedView = null) {
  const code = error?.code ?? null;
  if (!store) {
    if (code === 'WMB_MANIFEST_MISSING' || code === 'WMB_MIGRATION_REQUIRED') {
      return Object.freeze({
        status: 'build-required', classification: 'read', operation: 'world-model.plan',
        command: 'singularity-flow world-model plan --json',
        reason: code, requiresReview: false
      });
    }
    return Object.freeze({
      status: 'diagnosis-required', classification: 'read', operation: 'world-model.doctor',
      command: 'singularity-flow world-model doctor --json',
      reason: code ?? 'WMB_AUTHORITY_UNAVAILABLE', requiresReview: false
    });
  }
  const selected = requestedView
    ? store.manifest.views.find((entry) => entry.viewId === requestedView)
    : null;
  if (requestedView && !selected) {
    return Object.freeze({
      status: 'selection-required', classification: 'read', operation: 'world-model.views',
      command: 'singularity-flow world-model views --json',
      reason: 'WMB_VIEW_UNKNOWN', requiresReview: false
    });
  }
  const unavailable = selected?.status === 'unavailable'
    ? [selected]
    : store.manifest.views.filter((entry) => entry.required && entry.status === 'unavailable');
  if (unavailable.length) {
    const view = unavailable[0].viewId;
    return Object.freeze({
      status: 'regeneration-required', classification: 'mutation',
      operation: 'world-model.regenerate',
      command: `singularity-flow world-model regenerate ${view}`,
      reason: 'WMB_REQUIRED_VIEW_UNAVAILABLE', viewId: view, requiresReview: true
    });
  }
  if (!store.freshness.fresh) {
    const stalenessReceipts = Object.freeze((store.stalenessReceipts ?? [])
      .filter((receipt) => !requestedView || receipt.nextAction.view === requestedView)
      .map((receipt) => structuredClone(receipt)));
    return Object.freeze({
      status: 'regeneration-required', classification: 'mutation',
      operation: 'world-model.regenerate',
      command: requestedView
        ? `singularity-flow world-model regenerate ${requestedView}`
        : 'singularity-flow world-model regenerate --stale',
      reason: store.freshness.reason ?? 'WMB_SOURCE_SNAPSHOT_STALE',
      ...(requestedView ? { viewId: requestedView } : {}),
      stalenessReceipts,
      requiresReview: true
    });
  }
  return Object.freeze({
    status: 'verification-ready', classification: 'read',
    operation: requestedView ? 'world-model.validate-view' : 'world-model.validate',
    command: requestedView
      ? `singularity-flow world-model validate-view ${requestedView} --json`
      : 'singularity-flow world-model validate --json',
    reason: 'WMB_CURRENT', ...(requestedView ? { viewId: requestedView } : {}),
    requiresReview: false
  });
}

export function worldModelNextResult({
  operation, arguments: args = {}, subject = null, store = null, error = null
} = {}) {
  const recommendation = nextRecommendation(store, error, args.viewId ?? null);
  return sflowResult({
    kind: 'read',
    operation: { id: operation.id, classification: 'read' },
    subject,
    outcome: {
      status: 'succeeded', messageId: 'gateway.next',
      slots: { status: recommendation.status, operation: recommendation.operation }
    },
    effects: noEffects(),
    why: [{
      code: store ? 'world-model.registered-authority' : 'world-model.authority-unavailable',
      source: store ? 'evidence' : 'unavailable',
      reference: store?.manifest?.manifestSha256 ?? error?.code ?? null
    }],
    preserved: preservedAll('gateway.nothing-was-carried-out'),
    restState: 'informational',
    data: { worldModel: { recommendation } }
  });
}

function explanationValue(store, entity, id) {
  if (entity === 'manifest') {
    return {
      entity, id: store.manifest.manifestSha256,
      authority: { ref: store.ref, commit: store.commit },
      freshness: structuredClone(store.freshness),
      dependencies: {
        sourceManifestSha256: store.manifest.sourceManifestSha256,
        scopeManifestSha256: store.manifest.scopeManifestSha256,
        evidenceCatalogSha256: store.manifest.evidenceCatalogSha256,
        derivationCatalogSha256: store.manifest.derivationCatalogSha256,
        factLedgerSha256: store.manifest.factLedgerSha256
      }
    };
  }
  if (entity === 'view') {
    const entry = store.manifest.views.find((view) => view.viewId === id);
    const loaded = store.views.find((view) => view.viewId === id);
    if (!entry) return null;
    return {
      entity, id, status: entry.status, required: entry.required,
      viewVersion: entry.viewVersion, viewSha256: entry.viewSha256 ?? null,
      validationReceiptSha256: entry.validationReceiptSha256 ?? null,
      executionSha256: entry.executionSha256 ?? null,
      cache: entry.cache,
      validation: loaded?.validationReceipt?.checks ?? null
    };
  }
  if (entity === 'fact') {
    const fact = store.factLedger.facts.find((entry) => entry.id === id);
    if (!fact) return null;
    const claim = boundedText(fact.claim);
    return {
      entity, id, factType: fact.factType, subject: structuredClone(fact.subject),
      status: fact.status, assurance: fact.assurance,
      claim: claim.text, claimTruncated: claim.truncated,
      reason: structuredClone(fact.reason ?? null),
      evidenceIds: [...fact.evidenceIds], derivationId: fact.derivationId,
      conflictsWith: [...fact.conflictsWith], scopeStatus: fact.scopeStatus
    };
  }
  if (entity === 'evidence') {
    const evidence = store.evidenceCatalog.items.find((entry) => entry.id === id);
    return evidence ? {
      entity, id, kind: evidence.kind, locator: structuredClone(evidence.locator),
      subjectSha256: evidence.subjectSha256,
      sourceContentSha256: evidence.sourceContentSha256,
      scope: structuredClone(evidence.scope), evidenceSha256: evidence.evidenceSha256
    } : null;
  }
  if (entity === 'derivation') {
    const derivation = store.derivationCatalog.derivations.find((entry) => entry.id === id);
    return derivation ? {
      entity, id, extractor: structuredClone(derivation.extractor),
      sourceManifestSha256: derivation.sourceManifestSha256,
      scopeManifestSha256: derivation.scopeManifestSha256,
      inputEvidenceIds: [...derivation.inputEvidenceIds],
      outputFactIds: [...derivation.outputFactIds], status: derivation.status,
      derivationSha256: derivation.derivationSha256
    } : null;
  }
  if (entity === 'refusal') {
    const entry = (store.records?.refusals ?? []).find((candidate) =>
      candidate.refusalSha256 === id || candidate.view === id || candidate.code === id);
    return entry ? {
      entity, id, code: entry.code, view: entry.view,
      failures: structuredClone(entry.failures), preserved: structuredClone(entry.preserved),
      nextAction: structuredClone(entry.nextAction), refusalSha256: entry.refusalSha256
    } : null;
  }
  return null;
}

export function worldModelExplainResult({
  operation, arguments: args = {}, subject = null, store
} = {}) {
  const entity = args.entity ?? 'manifest';
  const id = args.id ?? null;
  if (entity !== 'manifest' && !id) {
    return refusal(operation, subject, 'world-model.entity-identifier-required', entity);
  }
  const explanation = explanationValue(store, entity, id);
  if (!explanation) return refusal(operation, subject, 'world-model.entity-unavailable', `${entity}:${id}`);
  return sflowResult({
    kind: 'read', operation: { id: operation.id, classification: 'read' }, subject,
    outcome: {
      status: 'succeeded', messageId: 'gateway.explained',
      slots: { entity, id: explanation.id }
    },
    effects: noEffects(),
    why: [{
      code: 'world-model.registered-authority', source: 'evidence',
      reference: store.manifest.manifestSha256,
      slots: { authority: store.ref, fresh: String(store.freshness.fresh) }
    }],
    preserved: preservedAll('gateway.nothing-was-carried-out'),
    restState: 'informational',
    data: { worldModel: { explanation } }
  });
}

export function worldModelInspectResult({
  operation, arguments: args = {}, subject = null, store, root = null
} = {}) {
  const entity = args.entity ?? 'manifest';
  const id = args.id ?? null;
  if (entity !== 'manifest' && !id) {
    return refusal(operation, subject, 'world-model.entity-identifier-required', entity);
  }
  let selected;
  try {
    selected = selectEntity(store, entity, id, {
      root,
      offset: args.offset ?? 0,
      maximumBytes: args.maximumBytes,
      viewId: args.viewId ?? null
    });
  } catch (error) {
    return refusal(operation, subject, 'world-model.expansion-refused', error?.code ?? null);
  }
  if (!selected) return refusal(operation, subject, 'world-model.entity-unavailable', `${entity}:${id}`);
  return sflowResult({
    kind: 'read',
    operation: { id: operation.id, classification: 'read' },
    subject,
    outcome: {
      status: 'succeeded', messageId: 'gateway.read',
      slots: { entity, id: id ?? store.manifest.manifestSha256 }
    },
    effects: noEffects(),
    why: [{
      code: 'world-model.registered-authority', source: 'evidence',
      reference: store.manifest.manifestSha256,
      slots: { authority: store.ref, fresh: String(store.freshness.fresh) }
    }],
    restState: 'informational',
    data: { worldModel: { entity, id, value: selected } }
  });
}

/** Bounded WMB v4 resolution behind the existing sflow_resolve → sflow_read tools. */
export async function worldModelInspect({ operation, arguments: args = {}, subject = null, root = null } = {}) {
  if (!root) return refusal(operation, subject, 'world-model.authority-unavailable');
  let store;
  try { store = await authority(root); }
  catch (error) {
    return refusal(operation, subject, 'world-model.authority-unavailable', error?.code ?? null);
  }
  return worldModelInspectResult({ operation, arguments: args, subject, store, root });
}

/** Compute one smallest legal WMB action without executing, authorizing, or invoking a model. */
export async function worldModelNext({ operation, arguments: args = {}, subject = null, root = null } = {}) {
  if (!root) return worldModelNextResult({
    operation, arguments: args, subject,
    error: Object.assign(new Error('No repository authority is selected.'), { code: 'WMB_AUTHORITY_UNAVAILABLE' })
  });
  try {
    const store = await authority(root);
    return worldModelNextResult({ operation, arguments: args, subject, store });
  } catch (error) {
    return worldModelNextResult({ operation, arguments: args, subject, error });
  }
}

/** Explain exact registered provenance; no narrative model or source-body read participates. */
export async function worldModelExplain({ operation, arguments: args = {}, subject = null, root = null } = {}) {
  if (!root) return refusal(operation, subject, 'world-model.authority-unavailable');
  let store;
  try { store = await authority(root); }
  catch (error) {
    return refusal(operation, subject, 'world-model.authority-unavailable', error?.code ?? null);
  }
  return worldModelExplainResult({ operation, arguments: args, subject, store });
}
