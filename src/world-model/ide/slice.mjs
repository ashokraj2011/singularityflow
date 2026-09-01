import { canonicalJson, sha256 } from '../canonicalize.mjs';
import { classifyScopePath } from '../scope/matcher.mjs';
import { readExactSourceFile } from '../source/snapshot.mjs';
import { resolvePublishedWorldModelV4 } from '../store.mjs';
import { resolveViewContract } from '../registry/views.mjs';

export const WORLD_MODEL_IDE_SLICE_VERSION = 1;
export const DEFAULT_WORLD_MODEL_PREVIEW_BYTES = 2_048;
export const MAX_WORLD_MODEL_PREVIEW_BYTES = 8_192;
export const MAX_WORLD_MODEL_IDE_VIEWS = 128;
export const DEFAULT_WORLD_MODEL_EXPANSION_BYTES = 32_768;
export const MAX_WORLD_MODEL_EXPANSION_BYTES = 65_536;

const EXPANSION_KINDS = new Set([
  'manifest', 'view', 'facts', 'evidence', 'derivations', 'unavailable',
  'contradictions', 'staleness', 'economics', 'source'
]);

function failExpansion(message, code, details = {}) {
  const error = new TypeError(message);
  error.code = code;
  error.details = details;
  throw error;
}

function boundedInteger(value, fallback, { minimum, maximum }) {
  const candidate = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new TypeError(`World-model IDE bound must be an integer from ${minimum} through ${maximum}.`);
  }
  return candidate;
}

function utf8Preview(value, maximumBytes) {
  const text = String(value ?? '');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maximumBytes) return { text, bytes: bytes.length, truncated: false };
  let end = maximumBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return {
    text: `${bytes.subarray(0, end).toString('utf8').trimEnd()}\n…`,
    bytes: end,
    truncated: true
  };
}

function expansion(kind, id, sha256Value, path = null) {
  return Object.freeze({
    kind,
    id,
    sha256: sha256Value,
    path,
    ref: `sfref:world-model:${kind}:${encodeURIComponent(id)}:${sha256Value.slice('sha256:'.length)}`
  });
}

function sourceExpansionId(relative) {
  return sha256({ kind: 'world-model-source-path', path: relative }).slice('sha256:'.length);
}

function expansionViewPolicy(store, viewId) {
  const entry = store?.manifest?.views?.find((view) => view.viewId === viewId && view.status === 'available');
  if (!entry || !store?.viewRegistry) return null;
  const contract = resolveViewContract(store.viewRegistry, {
    id: entry.viewId, version: entry.viewVersion
  });
  return contract.bodyAccess.allowed && contract.bodyAccess.maximumBytes > 0 ? contract : null;
}

function sourceExpansionIdentity(viewId, relative) {
  return `${viewId}@${sourceExpansionId(relative)}`;
}

function parseSourceExpansionIdentity(value) {
  const match = /^(?<viewId>[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+)@(?<sourceId>[a-f0-9]{64})$/.exec(value);
  return match?.groups ?? null;
}

/**
 * Turn a verified Evidence locator into an opaque, content-addressed exact-source reference.
 *
 * The reference is deliberately absent when the path is not both in the pinned Source Snapshot
 * and inside the registered scope. Consumers cannot manufacture a repository path and use this
 * helper as a general-purpose file reader.
 */
export function worldModelSourceExpansionReference(store, relative, { viewId = null } = {}) {
  const path = String(relative ?? '').replaceAll('\\', '/');
  const source = store?.sourceSnapshot?.files?.find((entry) => entry.path === path);
  const contract = viewId ? expansionViewPolicy(store, viewId) : null;
  if (!source || !contract || classifyScopePath(path, store.scopeManifest).status !== 'inside') return null;
  return expansion('source', sourceExpansionIdentity(viewId, path), source.contentSha256, path);
}

function parseExpansionReference(reference) {
  const match = /^sfref:world-model:([a-z-]+):([^:]+):([0-9a-f]{64})$/.exec(String(reference ?? ''));
  if (!match || !EXPANSION_KINDS.has(match[1])) {
    failExpansion('World-model expansion reference is malformed or names an unsupported kind.',
      'WMB_IDE_EXPANSION_REFERENCE_INVALID');
  }
  let id;
  try { id = decodeURIComponent(match[2]); }
  catch {
    failExpansion('World-model expansion reference contains an invalid encoded identifier.',
      'WMB_IDE_EXPANSION_REFERENCE_INVALID');
  }
  const digest = `sha256:${match[3]}`;
  if (expansion(match[1], id, digest).ref !== reference) {
    failExpansion('World-model expansion reference is not in canonical form.',
      'WMB_IDE_EXPANSION_REFERENCE_INVALID');
  }
  return { kind: match[1], id, digest };
}

function trustedExpansionRecord(store, parsed) {
  if (parsed.kind === 'manifest' && parsed.id === 'manifest') {
    return { digest: store.manifest.manifestSha256, value: store.manifest, contentType: 'application/json' };
  }
  if (parsed.kind === 'view') {
    const manifest = store.manifest.views.find((entry) => entry.viewId === parsed.id);
    const loaded = store.views.find((entry) => entry.viewId === parsed.id);
    if (!manifest?.viewSha256 || !loaded?.markdown) return null;
    return { digest: manifest.viewSha256, value: loaded.markdown, contentType: 'text/markdown' };
  }
  if (parsed.kind === 'facts') {
    const ledger = parsed.id === 'all'
      ? store.factLedger
      : store.records?.viewFactLedgers?.find((entry) => entry.viewId === parsed.id);
    return ledger
      ? { digest: ledger.ledgerSha256, value: ledger, contentType: 'application/json' }
      : null;
  }
  if (parsed.kind === 'evidence' && parsed.id === 'all') {
    return {
      digest: store.evidenceCatalog.catalogSha256,
      value: store.evidenceCatalog,
      contentType: 'application/json'
    };
  }
  if (parsed.kind === 'derivations' && parsed.id === 'all') {
    return {
      digest: store.derivationCatalog.catalogSha256,
      value: store.derivationCatalog,
      contentType: 'application/json'
    };
  }
  if (['unavailable', 'contradictions', 'staleness', 'economics'].includes(parsed.kind)
      && parsed.id === 'all') {
    return worldModelIdeDrilldown(store, parsed.kind);
  }
  return null;
}

function sumKnown(values) {
  const known = values.filter((value) => Number.isFinite(value));
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
}

/** Create a bounded, derived exact-record drill-down without copying it into the base IDE slice. */
function worldModelIdeDrilldown(store, kind) {
  let value;
  if (kind === 'unavailable' || kind === 'contradictions') {
    const status = kind === 'unavailable' ? 'unavailable' : 'contradicted';
    value = {
      schemaVersion: WORLD_MODEL_IDE_SLICE_VERSION, // schema-transient: derived IDE read envelope
      kind: `world-model-${kind}-analysis`,
      manifestSha256: store.manifest.manifestSha256,
      facts: store.factLedger.facts.filter((fact) => fact.status === status)
    };
  } else if (kind === 'staleness') {
    value = {
      schemaVersion: WORLD_MODEL_IDE_SLICE_VERSION, // schema-transient: derived IDE read envelope
      kind: 'world-model-staleness-analysis',
      manifestSha256: store.manifest.manifestSha256,
      freshness: structuredClone(store.freshness),
      receipts: structuredClone(store.stalenessReceipts ?? [])
    };
  } else {
    const views = store.manifest.views.map((entry) => {
      const loaded = store.views.find((view) => view.viewId === entry.viewId);
      const usage = loaded?.usageObservation ?? null;
      return {
        viewId: entry.viewId,
        status: entry.status,
        cache: entry.cache,
        promptBytes: usage?.promptBytes ?? null,
        outputBytes: usage?.outputBytes ?? null,
        providerInputTokens: usage?.providerInputTokens ?? null,
        providerCachedTokens: usage?.providerCachedTokens ?? null,
        providerOutputTokens: usage?.providerOutputTokens ?? null,
        providerCostUsd: usage?.cost?.amount ?? null,
        tokenAssurance: usage?.assurance?.providerTokens ?? 'unavailable',
        costAssurance: usage?.cost?.assurance ?? 'unavailable'
      };
    });
    value = {
      schemaVersion: WORLD_MODEL_IDE_SLICE_VERSION, // schema-transient: derived IDE read envelope
      kind: 'world-model-cache-economics-analysis',
      manifestSha256: store.manifest.manifestSha256,
      totals: {
        views: views.length,
        cacheHits: views.filter((view) => view.cache === 'hit').length,
        promptBytes: sumKnown(views.map((view) => view.promptBytes)),
        outputBytes: sumKnown(views.map((view) => view.outputBytes)),
        providerInputTokens: sumKnown(views.map((view) => view.providerInputTokens)),
        providerCachedTokens: sumKnown(views.map((view) => view.providerCachedTokens)),
        providerOutputTokens: sumKnown(views.map((view) => view.providerOutputTokens)),
        providerCostUsd: sumKnown(views.map((view) => view.providerCostUsd))
      },
      views
    };
  }
  return { digest: sha256(value), value, contentType: 'application/json' };
}

/**
 * Expand one opaque IDE/Gateway reference in bounded chunks.
 *
 * Source expansions are stronger than ordinary record reads: the path must be in the registered
 * scope, its reference digest must equal the pinned file digest, and `readExactSourceFile` reads
 * the blob from the pinned commit and re-hashes its bytes. Returning base64 keeps every chunk exact
 * across binary files and UTF-8 boundary splits. Repeating with `nextOffset` recovers any size file
 * without ever returning an unbounded payload.
 */
export function readWorldModelIdeExpansion(root, store, reference, {
  offset = 0,
  maximumBytes = DEFAULT_WORLD_MODEL_EXPANSION_BYTES
} = {}) {
  const start = boundedInteger(offset, 0, { minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
  const limit = boundedInteger(maximumBytes, DEFAULT_WORLD_MODEL_EXPANSION_BYTES, {
    minimum: 256, maximum: MAX_WORLD_MODEL_EXPANSION_BYTES
  });
  const parsed = parseExpansionReference(reference);
  let bytes;
  let contentType;
  let source = null;
  let sourcePolicy = null;
  if (parsed.kind === 'source') {
    const identity = parseSourceExpansionIdentity(parsed.id);
    const contract = identity ? expansionViewPolicy(store, identity.viewId) : null;
    if (!identity || !contract) {
      failExpansion('Exact source expansion is denied by the registered View Contract.',
        'WMB_SOURCE_BODY_FORBIDDEN', { viewId: identity?.viewId ?? null });
    }
    const file = store.sourceSnapshot.files.find((entry) => sourceExpansionId(entry.path) === identity.sourceId);
    const sourcePath = file?.path ?? null;
    const scope = sourcePath
      ? classifyScopePath(sourcePath, store.scopeManifest)
      : { status: 'outside' };
    if (!file || scope.status !== 'inside') {
      failExpansion('Exact source expansion is outside the registered source and scope.',
        'WMB_IDE_EXPANSION_SOURCE_OUT_OF_SCOPE', { sourceId: parsed.id, scope: scope.status });
    }
    if (file.contentSha256 !== parsed.digest) {
      failExpansion(`Exact source reference for '${sourcePath}' does not match the pinned source digest.`,
        'WMB_IDE_EXPANSION_DIGEST_MISMATCH', {
          path: sourcePath, expected: file.contentSha256, received: parsed.digest
        });
    }
    bytes = readExactSourceFile(root, store.sourceSnapshot, sourcePath);
    contentType = 'application/octet-stream';
    sourcePolicy = Object.freeze({
      viewId: contract.id,
      viewVersion: contract.version,
      viewSpecSha256: contract.contractSha256,
      maximumBytes: contract.bodyAccess.maximumBytes
    });
    source = Object.freeze({
      path: sourcePath,
      commit: store.sourceSnapshot.revision.commit,
      sourceManifestSha256: store.sourceSnapshot.sourceManifestSha256,
      scopeManifestSha256: store.scopeManifest.scopeSha256,
      scope: 'inside',
      viewId: contract.id,
      viewSpecSha256: contract.contractSha256
    });
  } else {
    const record = trustedExpansionRecord(store, parsed);
    if (!record) {
      failExpansion(`World-model expansion '${parsed.kind}:${parsed.id}' is not registered.`,
        'WMB_IDE_EXPANSION_UNAVAILABLE');
    }
    if (record.digest !== parsed.digest) {
      failExpansion(`World-model expansion '${parsed.kind}:${parsed.id}' does not match the registered digest.`,
        'WMB_IDE_EXPANSION_DIGEST_MISMATCH', {
          expected: record.digest, received: parsed.digest
        });
    }
    bytes = Buffer.from(typeof record.value === 'string'
      ? record.value
      : canonicalJson(record.value), 'utf8');
    contentType = record.contentType;
  }
  if (sourcePolicy && start >= sourcePolicy.maximumBytes) {
    failExpansion(`Exact source expansion exhausted the ${sourcePolicy.maximumBytes}-byte View Contract budget.`,
      'WMB_SOURCE_BODY_BUDGET_EXCEEDED', sourcePolicy);
  }
  const policyEnd = sourcePolicy ? Math.min(bytes.length, sourcePolicy.maximumBytes) : bytes.length;
  const end = Math.min(policyEnd, start + limit);
  const chunk = start >= bytes.length ? Buffer.alloc(0) : bytes.subarray(start, end);
  const policyTruncated = Boolean(sourcePolicy && policyEnd < bytes.length);
  const page = {
    kind: parsed.kind === 'source' ? 'world-model-source-page' : 'world-model-expansion-page',
    sourceRef: reference,
    range: { startByte: start, endByte: end },
    contentSha256: parsed.digest,
    bytes: chunk.length,
    content: chunk.toString('base64'),
    ...(sourcePolicy ? { viewSpecSha256: sourcePolicy.viewSpecSha256 } : {})
  };
  const pageSha256 = sha256(page);
  return Object.freeze({
    schemaVersion: WORLD_MODEL_IDE_SLICE_VERSION,
    kind: 'world-model-exact-expansion',
    reference,
    entity: parsed.kind,
    id: parsed.id,
    sha256: parsed.digest,
    contentType,
    encoding: 'base64',
    offset: start,
    bytes: chunk.length,
    totalBytes: bytes.length,
    complete: end >= bytes.length,
    nextOffset: end < policyEnd ? end : null,
    policyTruncated,
    policyMaximumBytes: sourcePolicy?.maximumBytes ?? null,
    content: page.content,
    pageSha256,
    source,
    event: Object.freeze({
      kind: 'world-model-expansion-event',
      viewId: sourcePolicy?.viewId ?? null,
      reference,
      offset: start,
      bytes: chunk.length,
      pageSha256,
      eventSha256: sha256({ reference, offset: start, bytes: chunk.length, pageSha256 })
    })
  });
}

function counts(facts) {
  return Object.freeze({
    total: facts.length,
    available: facts.filter((fact) => fact.status === 'available').length,
    partial: facts.filter((fact) => fact.status === 'partial').length,
    unavailable: facts.filter((fact) => fact.status === 'unavailable').length,
    contradicted: facts.filter((fact) => fact.status === 'contradicted').length,
    stale: facts.filter((fact) => fact.status === 'stale').length
  });
}

/**
 * Project one verified WMB v4 authority into the bounded data an IDE panel may retain.
 *
 * The complete Fact Ledger and Evidence Catalog deliberately do not cross this boundary. A panel
 * receives counts, small previews, and content-addressed expansion references; opening an item is
 * a separate exact read against the verified authority.
 */
export function projectWorldModelIdeSlice(store, {
  maximumPreviewBytes = DEFAULT_WORLD_MODEL_PREVIEW_BYTES,
  maximumViews = MAX_WORLD_MODEL_IDE_VIEWS
} = {}) {
  const previewLimit = boundedInteger(maximumPreviewBytes, DEFAULT_WORLD_MODEL_PREVIEW_BYTES, {
    minimum: 256, maximum: MAX_WORLD_MODEL_PREVIEW_BYTES
  });
  const viewLimit = boundedInteger(maximumViews, MAX_WORLD_MODEL_IDE_VIEWS, {
    minimum: 1, maximum: MAX_WORLD_MODEL_IDE_VIEWS
  });
  if (!store?.manifest || store.manifest.format !== 'wmb-v4') {
    throw new TypeError('World-model IDE projection requires a verified WMB v4 store.');
  }
  if (store.manifest.views.length > viewLimit) {
    const error = new TypeError(
      `World-model manifest has ${store.manifest.views.length} views; the IDE slice limit is ${viewLimit}.`
    );
    error.code = 'WMB_IDE_VIEW_LIMIT_EXCEEDED';
    throw error;
  }

  const viewLedgers = new Map((store.records?.viewFactLedgers ?? [])
    .map((ledger) => [ledger.viewId, ledger]));
  const loadedViews = new Map((store.views ?? []).map((view) => [view.viewId, view]));
  const views = store.manifest.views.map((manifestView) => {
    const ledger = viewLedgers.get(manifestView.viewId);
    const facts = ledger?.facts ?? [];
    const loaded = loadedViews.get(manifestView.viewId);
    const preview = manifestView.status === 'available'
      ? utf8Preview(loaded?.markdown ?? '', previewLimit)
      : { text: '', bytes: 0, truncated: false };
    return Object.freeze({
      id: manifestView.viewId,
      viewId: manifestView.viewId,
      viewVersion: manifestView.viewVersion,
      status: manifestView.status,
      required: manifestView.required,
      path: manifestView.path,
      viewSha256: manifestView.viewSha256,
      cache: manifestView.cache,
      counts: counts(facts),
      preview,
      expansion: Object.freeze([
        ...(manifestView.viewSha256
          ? [expansion('view', manifestView.viewId, manifestView.viewSha256, manifestView.path)] : []),
        ...(ledger
          ? [expansion('facts', manifestView.viewId, ledger.ledgerSha256,
              `catalogs/views/${manifestView.viewId}.facts.json`)] : [])
      ]),
      references: Object.freeze([])
    });
  });
  const payload = {
    schemaVersion: WORLD_MODEL_IDE_SLICE_VERSION,
    kind: 'world-model-ide-slice',
    format: 'wmb-v4',
    status: 'ready',
    authority: {
      ref: store.ref,
      commit: store.commit,
      manifestSha256: store.manifest.manifestSha256
    },
    source: {
      sourceManifestSha256: store.sourceSnapshot.sourceManifestSha256,
      scopeManifestSha256: store.scopeManifest.scopeSha256,
      fresh: store.freshness.fresh,
      reason: store.freshness.reason
    },
    generatedAt: null,
    root: store.outputDir,
    rebuildReason: store.freshness.fresh ? null : 'The registered source snapshot changed after this world model was built.',
    readiness: {
      status: store.freshness.fresh ? 'fresh' : 'stale',
      ready: store.freshness.fresh,
      source: 'state-branch',
      command: store.freshness.fresh ? null : 'singularity-flow world-model regenerate --stale'
    },
    summary: {
      views: views.length,
      facts: store.factLedger.facts.length,
      evidence: store.evidenceCatalog.items.length,
      derivations: store.derivationCatalog.derivations.length,
      unavailable: store.factLedger.facts.filter((fact) => fact.status === 'unavailable').length,
      contradictions: store.factLedger.facts.filter((fact) => fact.status === 'contradicted').length,
      cacheHits: store.manifest.views.filter((view) => view.cache === 'hit').length
    },
    views,
    expansion: Object.freeze([
      expansion('manifest', 'manifest', store.manifest.manifestSha256, 'manifest.json'),
      expansion('facts', 'all', store.factLedger.ledgerSha256, 'catalogs/facts.json'),
      expansion('evidence', 'all', store.evidenceCatalog.catalogSha256, 'catalogs/evidence.json'),
      expansion('derivations', 'all', store.derivationCatalog.catalogSha256, 'catalogs/derivations.json'),
      expansion('unavailable', 'all', worldModelIdeDrilldown(store, 'unavailable').digest),
      expansion('contradictions', 'all', worldModelIdeDrilldown(store, 'contradictions').digest),
      expansion('staleness', 'all', worldModelIdeDrilldown(store, 'staleness').digest),
      expansion('economics', 'all', worldModelIdeDrilldown(store, 'economics').digest)
    ])
  };
  return Object.freeze({ ...payload, revision: sha256(payload) });
}

/** Load no authority bytes when v4 is not selected, and never convert a legacy model implicitly. */
export function loadWorldModelIdeSlice(root, {
  outputDir = 'singularity/world-model', stateBranch = 'state', remote = 'origin', required = false,
  maximumPreviewBytes = DEFAULT_WORLD_MODEL_PREVIEW_BYTES,
  maximumViews = MAX_WORLD_MODEL_IDE_VIEWS
} = {}) {
  try {
    const store = resolvePublishedWorldModelV4(root, {
      outputDir, stateBranch, remote, required
    });
    if (!store) return Object.freeze({
      schemaVersion: WORLD_MODEL_IDE_SLICE_VERSION,
      kind: 'world-model-ide-slice',
      format: 'wmb-v4',
      status: 'unavailable',
      reason: 'WMB_MANIFEST_MISSING',
      root: outputDir,
      generatedAt: null,
      rebuildReason: 'No registered WMB v4 world model is published yet.',
      readiness: { status: 'missing', ready: false, source: null, command: 'singularity-flow world-model build' },
      summary: { views: 0, facts: 0, evidence: 0, derivations: 0, unavailable: 0, contradictions: 0, cacheHits: 0 },
      views: [],
      expansion: [],
      revision: sha256({ format: 'wmb-v4', status: 'unavailable', reason: 'WMB_MANIFEST_MISSING', outputDir })
    });
    return projectWorldModelIdeSlice(store, { maximumPreviewBytes, maximumViews });
  } catch (error) {
    if (required) throw error;
    return Object.freeze({
      schemaVersion: WORLD_MODEL_IDE_SLICE_VERSION,
      kind: 'world-model-ide-slice',
      format: 'wmb-v4',
      status: 'unavailable',
      reason: error?.code ?? 'WMB_IDE_SLICE_UNAVAILABLE',
      detail: error?.message ?? String(error),
      root: outputDir,
      generatedAt: null,
      rebuildReason: error?.message ?? String(error),
      readiness: { status: 'invalid', ready: false, source: null, command: 'singularity-flow world-model doctor' },
      summary: { views: 0, facts: 0, evidence: 0, derivations: 0, unavailable: 0, contradictions: 0, cacheHits: 0 },
      views: [],
      expansion: [],
      revision: sha256({ format: 'wmb-v4', status: 'unavailable', reason: error?.code ?? 'WMB_IDE_SLICE_UNAVAILABLE', outputDir })
    });
  }
}

export function serializedWorldModelIdeBytes(slice) {
  return Buffer.byteLength(canonicalJson(slice), 'utf8');
}
