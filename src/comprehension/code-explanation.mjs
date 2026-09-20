/**
 * Deterministic, observe-only code explanation over existing comprehension projections.
 *
 * This first XPL slice never discovers facts. It enumerates the exact hunks already present in the
 * bounded diff preview, retains non-text and untracked changes as opaque units, and uses current
 * cached symbols only when a declaration line overlaps a current-side hunk range. Cause, impact,
 * and proof remain explicitly unavailable until hunk-granular authoritative sources exist.
 */
import { createHash } from 'node:crypto';

import { recordSha256 } from '../records.mjs';
import { SingularityFlowError } from '../util.mjs';
import { validateChangeRegionManifest } from './contracts.mjs';

export const CODE_EXPLANATION_DRILLDOWNS = Object.freeze(['hunk', 'symbol', 'clause']);

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const SYMBOL_ASSURANCE = new Set(['text', 'syntax', 'semantic']);
const MAXIMUM_QUERY_BYTES = 512;

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function canonicalSha256(value) {
  return `sha256:${recordSha256(value)}`;
}

function compareText(left, right) {
  return Buffer.compare(Buffer.from(String(left ?? ''), 'utf8'), Buffer.from(String(right ?? ''), 'utf8'));
}

function regionPath(region) {
  return region.location?.pathAfter ?? region.location?.pathBefore ?? '';
}

function compareRegions(left, right) {
  return compareText(regionPath(left), regionPath(right))
    || compareText(left.location?.pathBefore, right.location?.pathBefore)
    || compareText(left.location?.pathAfter, right.location?.pathAfter)
    || compareText(left.operation, right.operation)
    || compareText(left.sourceChangeId, right.sourceChangeId)
    || compareText(left.regionSha256, right.regionSha256);
}

function compareHunks(left, right) {
  return left.afterStart - right.afterStart
    || left.beforeStart - right.beforeStart
    || left.afterLines - right.afterLines
    || left.beforeLines - right.beforeLines
    || compareText(left.header, right.header);
}

function range(start, lines) {
  return { start, lines, end: lines === 0 ? null : start + lines - 1 };
}

function validHunk(hunk) {
  if (!hunk || typeof hunk !== 'object' || Array.isArray(hunk)
      || typeof hunk.header !== 'string' || !hunk.header.startsWith('@@ ')) return false;
  for (const field of ['beforeStart', 'beforeLines', 'afterStart', 'afterLines']) {
    if (!Number.isSafeInteger(hunk[field]) || hunk[field] < 0) return false;
  }
  return (hunk.beforeLines === 0 || hunk.beforeStart > 0)
    && (hunk.afterLines === 0 || hunk.afterStart > 0);
}

function parseSectionHunks(section) {
  return [...section.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/gmu)]
    .map((match) => ({
      header: match[0],
      beforeStart: Number(match[1]),
      beforeLines: match[2] == null ? 1 : Number(match[2]),
      afterStart: Number(match[3]),
      afterLines: match[4] == null ? 1 : Number(match[4])
    }));
}

function sameHunks(left, right) {
  if (left.length !== right.length) return false;
  return left.every((hunk, index) => {
    const other = right[index];
    return hunk.header === other.header
      && hunk.beforeStart === other.beforeStart
      && hunk.beforeLines === other.beforeLines
      && hunk.afterStart === other.afterStart
      && hunk.afterLines === other.afterLines;
  });
}

function validDiffFile(file, region, patch) {
  if (!file || typeof file !== 'object' || Array.isArray(file)
      || file.sourceChangeId !== region.sourceChangeId
      || file.operation !== region.operation
      || file.pathBefore !== (region.location?.pathBefore ?? null)
      || file.pathAfter !== (region.location?.pathAfter ?? null)
      || !Number.isSafeInteger(file.patchStart) || file.patchStart < 0
      || !Number.isSafeInteger(file.patchEnd) || file.patchEnd <= file.patchStart
      || file.patchEnd > patch.length || !Number.isSafeInteger(file.bytes) || file.bytes < 0
      || !SHA256.test(String(file.patchSha256 ?? '')) || !Array.isArray(file.hunks)
      || file.hunks.some((hunk) => !validHunk(hunk))) return false;
  const section = patch.slice(file.patchStart, file.patchEnd);
  const before = region.location?.pathBefore ?? region.location?.pathAfter;
  const after = region.location?.pathAfter ?? region.location?.pathBefore;
  const firstLineEnd = section.indexOf('\n');
  const firstLine = section.slice(0, firstLineEnd < 0 ? section.length : firstLineEnd);
  if (firstLine !== `diff --git a/${before} b/${after}`
      || Buffer.byteLength(section, 'utf8') !== file.bytes
      || sha256(Buffer.from(section, 'utf8')) !== file.patchSha256) return false;
  return sameHunks(parseSectionHunks(section), file.hunks);
}

function likelyUntracked(region) {
  return region.operation === 'added'
    && region.location?.pathBefore === null
    && region.location?.gitObjectBefore === null
    && region.location?.gitObjectAfter === null;
}

function inspectDiff(manifest, regions, diff) {
  const unavailable = (reason, untrackedRegionIds = new Set(), classificationExact = false) => ({
    status: regions.length ? 'unavailable' : 'not-applicable',
    reason: regions.length ? reason : 'no-change-regions',
    files: new Map(),
    untrackedRegionIds,
    classificationExact,
    patchSha256: null
  });
  if (!regions.length) return unavailable('no-change-regions');
  if (!diff || typeof diff !== 'object' || Array.isArray(diff)
      || diff.kind !== 'comprehension-diff-preview'
      || diff.authoritative !== false || diff.lifecycleGate !== false
      || diff.changeSetSha256 !== manifest.changeSetSha256
      || !Number.isSafeInteger(diff.trackedRegions) || diff.trackedRegions < 0
      || !Number.isSafeInteger(diff.omittedUntrackedRegions) || diff.omittedUntrackedRegions < 0
      || diff.trackedRegions + diff.omittedUntrackedRegions !== regions.length) {
    return unavailable('diff-preview-binding-invalid');
  }
  const opaqueUntracked = regions.filter(likelyUntracked);
  const fallbackUntrackedIds = opaqueUntracked.length === diff.omittedUntrackedRegions
    ? new Set(opaqueUntracked.map((region) => region.regionId)) : new Set();
  const fallbackExact = fallbackUntrackedIds.size === diff.omittedUntrackedRegions;
  if (diff.status !== 'available' || diff.fileProjectionStatus !== 'available') {
    return unavailable(
      String(diff.fileProjectionReason ?? diff.reason ?? 'diff-preview-unavailable'),
      fallbackUntrackedIds,
      fallbackExact
    );
  }
  if (typeof diff.patch !== 'string' || !SHA256.test(String(diff.patchSha256 ?? ''))
      || sha256(Buffer.from(diff.patch, 'utf8')) !== diff.patchSha256
      || !Number.isSafeInteger(diff.bytes)
      || Buffer.byteLength(diff.patch, 'utf8') !== diff.bytes
      || !Array.isArray(diff.files) || diff.files.length !== diff.trackedRegions) {
    return unavailable('diff-preview-integrity-invalid', fallbackUntrackedIds, fallbackExact);
  }

  const regionsBySource = new Map(regions.map((region) => [region.sourceChangeId, region]));
  const files = new Map();
  for (const file of diff.files) {
    const region = regionsBySource.get(file?.sourceChangeId);
    if (!region || files.has(file.sourceChangeId) || !validDiffFile(file, region, diff.patch)) {
      return unavailable('diff-preview-integrity-invalid', fallbackUntrackedIds, fallbackExact);
    }
    files.set(file.sourceChangeId, file);
  }
  const sections = [...files.values()].sort((left, right) => left.patchStart - right.patchStart);
  let end = 0;
  for (const section of sections) {
    if (section.patchStart !== end) {
      return unavailable('diff-preview-integrity-invalid', fallbackUntrackedIds, fallbackExact);
    }
    end = section.patchEnd;
  }
  if (end !== diff.patch.length || files.size !== diff.trackedRegions) {
    return unavailable('diff-preview-integrity-invalid', fallbackUntrackedIds, fallbackExact);
  }
  const untrackedRegionIds = new Set(regions
    .filter((region) => !files.has(region.sourceChangeId)).map((region) => region.regionId));
  if (untrackedRegionIds.size !== diff.omittedUntrackedRegions) {
    return unavailable('diff-preview-integrity-invalid', fallbackUntrackedIds, fallbackExact);
  }
  return {
    status: 'available', reason: null, files, untrackedRegionIds,
    classificationExact: true, patchSha256: diff.patchSha256
  };
}

function normalizedSymbol(symbol) {
  if (!symbol || typeof symbol !== 'object' || Array.isArray(symbol)
      || typeof symbol.id !== 'string' || !symbol.id || symbol.id.includes('\0')
      || typeof symbol.name !== 'string' || !symbol.name || symbol.name.includes('\0')
      || typeof symbol.path !== 'string' || !symbol.path || symbol.path.includes('\0')
      || !Number.isSafeInteger(symbol.line) || symbol.line < 1
      || !SYMBOL_ASSURANCE.has(symbol.assurance)
      || typeof symbol.extractor !== 'string' || !symbol.extractor) return null;
  return {
    id: symbol.id,
    name: symbol.name,
    qualifiedName: typeof symbol.qualifiedName === 'string' && symbol.qualifiedName
      && !symbol.qualifiedName.includes('\0') ? symbol.qualifiedName : null,
    declarationKind: typeof symbol.declarationKind === 'string' && symbol.declarationKind
      && !symbol.declarationKind.includes('\0') ? symbol.declarationKind : 'symbol',
    signature: typeof symbol.signature === 'string' && !symbol.signature.includes('\0')
      ? symbol.signature.slice(0, 500) : null,
    path: symbol.path,
    line: symbol.line,
    assurance: symbol.assurance,
    extractor: symbol.extractor,
    match: 'declaration-line-overlap'
  };
}

function compareSymbols(left, right) {
  return compareText(left.path, right.path)
    || left.line - right.line
    || compareText(left.qualifiedName, right.qualifiedName)
    || compareText(left.name, right.name)
    || compareText(left.id, right.id)
    || compareText(left.extractor, right.extractor);
}

function inspectStructure(structure) {
  const invalid = (reason = 'cached-structure-source-invalid') => ({
    status: 'unavailable', reason, symbols: [], projectionSha256: null
  });
  if (!structure || typeof structure !== 'object' || Array.isArray(structure)
      || structure.kind !== 'ast-cached-symbol-projection'
      || structure.authoritative !== false || structure.lifecycleGate !== false
      || !SHA256.test(String(structure.projectionSha256 ?? ''))) return invalid();
  const { projectionSha256, ...core } = structure;
  if (canonicalSha256(core) !== projectionSha256) return invalid();
  if (structure.status !== 'available' || !Array.isArray(structure.symbols)) {
    return {
      status: String(structure.status ?? 'unavailable'),
      reason: String(structure.reason ?? 'cached-structure-unavailable'),
      symbols: [], projectionSha256
    };
  }
  const candidates = structure.symbols.map(normalizedSymbol).filter(Boolean).sort(compareSymbols);
  const symbols = [...new Map(candidates.map((symbol) => [
    `${symbol.path}\0${symbol.line}\0${symbol.id}\0${symbol.extractor}`, symbol
  ])).values()];
  return {
    status: symbols.length ? 'available' : 'unavailable',
    reason: symbols.length ? null : 'cached-structure-has-no-valid-symbols',
    symbols,
    projectionSha256
  };
}

function inspectGraph(manifest, graph) {
  const unavailable = (reason = 'cause-graph-unavailable') => ({
    status: 'unavailable', reason, referencesByRegion: new Map(), graphSha256: null
  });
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)
      || graph.kind !== 'comprehension-intent-graph'
      || graph.authoritative !== false || graph.lifecycleGate !== false
      || graph.candidateSha256 !== manifest.compatibilityCandidateSha256
      || graph.manifestSha256 !== manifest.manifestSha256
      || !SHA256.test(String(graph.graphSha256 ?? ''))
      || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return unavailable();
  const { graphSha256, ...core } = graph;
  if (canonicalSha256(core) !== graphSha256) return unavailable('cause-graph-integrity-invalid');
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const referencesByRegion = new Map();
  for (const edge of graph.edges) {
    const cause = nodes.get(edge?.from);
    const region = nodes.get(edge?.to);
    if (edge?.type !== 'cause-to-change-region' || cause?.type !== 'cause'
        || region?.type !== 'change-region' || !SHA256.test(String(region.regionSha256 ?? ''))
        || typeof cause.causeId !== 'string' || !cause.causeId
        || typeof cause.causeKind !== 'string' || !cause.causeKind) continue;
    const bucket = referencesByRegion.get(region.regionSha256) ?? [];
    bucket.push({
      causeKind: cause.causeKind,
      causeId: cause.causeId,
      authorityRecordSha256: SHA256.test(String(cause.authorityRecordSha256 ?? ''))
        ? cause.authorityRecordSha256 : null,
      relationship: typeof edge.relationship === 'string' ? edge.relationship : null,
      scope: 'change-region',
      hunkBound: false
    });
    referencesByRegion.set(region.regionSha256, bucket);
  }
  for (const [regionSha256, references] of referencesByRegion) {
    references.sort((left, right) => compareText(left.causeKind, right.causeKind)
      || compareText(left.causeId, right.causeId)
      || compareText(left.authorityRecordSha256, right.authorityRecordSha256));
    referencesByRegion.set(regionSha256, [...new Map(references.map((reference) => [
      `${reference.causeKind}\0${reference.causeId}\0${reference.authorityRecordSha256 ?? ''}`, reference
    ])).values()]);
  }
  return {
    status: 'unavailable',
    reason: referencesByRegion.size ? 'region-cause-not-hunk-bound' : 'hunk-cause-authority-unavailable',
    referencesByRegion,
    graphSha256
  };
}

function evidenceSha256(manifest, evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
      || evidence.kind !== 'comprehension-recorded-evidence'
      || evidence.authoritative !== false || evidence.lifecycleGate !== false
      || evidence.candidateSha256 !== manifest.compatibilityCandidateSha256
      || !SHA256.test(String(evidence.evidenceProjectionSha256 ?? ''))) return null;
  const { evidenceProjectionSha256, ...core } = evidence;
  return canonicalSha256(core) === evidenceProjectionSha256 ? evidenceProjectionSha256 : null;
}

function declarationsFor(hunk, region, structure) {
  if (hunk.afterLines === 0 || !region.location?.pathAfter || structure.status !== 'available') return [];
  const lastLine = hunk.afterStart + hunk.afterLines - 1;
  return structure.symbols.filter((symbol) => symbol.path === region.location.pathAfter
    && symbol.line >= hunk.afterStart && symbol.line <= lastLine);
}

function structureResult(kind, hunk, declarations, structure) {
  if (kind !== 'diff-hunk') return { status: 'unavailable', reason: 'opaque-change-unit' };
  if (hunk.afterLines === 0) return { status: 'unavailable', reason: 'no-current-side-lines' };
  if (structure.status !== 'available') {
    return { status: 'unavailable', reason: structure.reason ?? 'cached-structure-unavailable' };
  }
  if (!declarations.length) return { status: 'unavailable', reason: 'no-declaration-line-overlap' };
  return { status: 'available', reason: null };
}

function causeFor(region, graph) {
  const references = graph.referencesByRegion.get(region.regionSha256) ?? [];
  const clauseIds = [...new Set(references.filter((reference) => [
    'acceptance-clause', 'requirement'
  ].includes(reference.causeKind)).map((reference) => reference.causeId))].sort(compareText);
  return {
    status: 'unavailable',
    reason: references.length ? 'region-cause-not-hunk-bound' : graph.reason,
    clauseIds,
    references
  };
}

function hunkDraft(region, hunk) {
  return {
    region, kind: 'diff-hunk', hunk, opacityReason: null,
    order: [regionPath(region), region.location?.pathBefore, region.location?.pathAfter,
      0, hunk.afterStart, hunk.beforeStart, hunk.header]
  };
}

function opaqueDraft(region, kind, reason) {
  return {
    region, kind, hunk: null, opacityReason: reason,
    order: [regionPath(region), region.location?.pathBefore, region.location?.pathAfter, 1, 0, 0, reason]
  };
}

function compareDrafts(left, right) {
  for (let index = 0; index < left.order.length; index += 1) {
    if (typeof left.order[index] === 'number' && typeof right.order[index] === 'number') {
      const difference = left.order[index] - right.order[index];
      if (difference) return difference;
    } else {
      const difference = compareText(left.order[index], right.order[index]);
      if (difference) return difference;
    }
  }
  return compareText(left.region.regionSha256, right.region.regionSha256);
}

function unitFromDraft(draft, unitId, structure, graph) {
  const { region, kind, hunk, opacityReason } = draft;
  const declarations = hunk ? declarationsFor(hunk, region, structure) : [];
  const core = {
    unitId,
    unitKind: kind,
    explanationStatus: kind === 'diff-hunk' ? 'unexplained' : 'opaque',
    regionId: region.regionId,
    regionSha256: region.regionSha256,
    sourceChangeId: region.sourceChangeId,
    operation: region.operation,
    location: {
      pathBefore: region.location?.pathBefore ?? null,
      pathAfter: region.location?.pathAfter ?? null
    },
    hunk: hunk ? {
      hunkId: unitId,
      header: hunk.header,
      before: range(hunk.beforeStart, hunk.beforeLines),
      after: range(hunk.afterStart, hunk.afterLines)
    } : null,
    opacity: opacityReason ? { status: 'opaque', reason: opacityReason } : null,
    declarations,
    structure: structureResult(kind, hunk, declarations, structure),
    cause: causeFor(region, graph)
  };
  return freezeDeep({ ...core, explanationUnitSha256: canonicalSha256(core) });
}

function normalizeContext(context) {
  const bounded = (value) => typeof value === 'string' && value && !value.includes('\0')
    && Buffer.byteLength(value, 'utf8') <= MAXIMUM_QUERY_BYTES ? value : null;
  return {
    workId: bounded(context?.workId),
    phase: bounded(context?.phase),
    base: bounded(context?.base),
    source: bounded(context?.source)
  };
}

function normalizeQuery({ hunk = null, symbol = null, clause = null } = {}) {
  const candidates = [['hunk', hunk], ['symbol', symbol], ['clause', clause]]
    .filter(([, value]) => value != null);
  if (!candidates.length) return { type: 'all', value: null };
  if (candidates.length !== 1) {
    throw new SingularityFlowError('Code explanation accepts exactly one hunk, symbol, or clause drill-down.', {
      code: 'CMP_EXPLANATION_QUERY_INVALID'
    });
  }
  const [type, raw] = candidates[0];
  const value = String(raw).trim();
  if (!value || value.includes('\0') || Buffer.byteLength(value, 'utf8') > MAXIMUM_QUERY_BYTES
      || (type === 'hunk' && !/^H-[0-9]{3,}$/u.test(value))) {
    throw new SingularityFlowError(`Code explanation ${type} drill-down has an invalid value.`, {
      code: 'CMP_EXPLANATION_QUERY_INVALID'
    });
  }
  return { type, value };
}

function matchesQuery(unit, query) {
  if (query.type === 'all') return true;
  if (query.type === 'hunk') return unit.hunk?.hunkId === query.value;
  if (query.type === 'symbol') return unit.declarations.some((symbol) => [
    symbol.id, symbol.name, symbol.qualifiedName
  ].includes(query.value));
  return unit.cause.clauseIds.includes(query.value);
}

function structureAvailability(units, structure) {
  const hunks = units.filter((unit) => unit.unitKind === 'diff-hunk');
  if (!hunks.length) return { status: 'not-applicable', reason: 'no-text-hunks', sourceStatus: structure.status };
  const mapped = hunks.filter((unit) => unit.declarations.length).length;
  if (mapped === hunks.length) return { status: 'available', reason: null, sourceStatus: structure.status };
  if (mapped) {
    return {
      status: 'partial', reason: 'some-hunks-have-no-declaration-line-overlap',
      sourceStatus: structure.status
    };
  }
  return {
    status: 'unavailable',
    reason: structure.status === 'available'
      ? 'no-hunks-have-declaration-line-overlap'
      : structure.reason ?? 'cached-structure-unavailable',
    sourceStatus: structure.status
  };
}

function explanationCounts(regions, units, selected) {
  const hunks = units.filter((unit) => unit.unitKind === 'diff-hunk');
  const opaque = units.filter((unit) => unit.unitKind !== 'diff-hunk');
  const pathsByKind = (predicate) => new Set(units.filter(predicate)
    .map((unit) => unit.regionSha256)).size;
  return {
    regions: regions.length,
    trackedFiles: pathsByKind((unit) => ['diff-hunk', 'tracked-file-opaque'].includes(unit.unitKind)),
    untrackedRegions: pathsByKind((unit) => unit.unitKind === 'untracked-region-opaque'),
    unclassifiedRegions: pathsByKind((unit) => unit.unitKind === 'change-region-opaque'),
    diffHunks: hunks.length,
    opaqueUnits: opaque.length,
    explanationUnits: units.length,
    declarationLinks: units.reduce((total, unit) => total + unit.declarations.length, 0),
    causeBoundHunks: 0,
    unexplainedHunks: hunks.length,
    returnedUnits: selected.length,
    returnedHunks: selected.filter((unit) => unit.unitKind === 'diff-hunk').length,
    returnedOpaqueUnits: selected.filter((unit) => unit.unitKind !== 'diff-hunk').length
  };
}

/**
 * Build one complete or drill-down XPL projection from the already-loaded comprehension slice.
 * The function is pure: it performs no filesystem, Git, record-store, clock, or model access.
 */
export function buildCodeExplanation({
  context = null,
  manifest,
  diff = null,
  structure = null,
  evidence = null,
  graph = null
} = {}, {
  hunk = null,
  symbol = null,
  clause = null
} = {}) {
  const validation = validateChangeRegionManifest(manifest);
  if (!validation.valid) {
    throw new SingularityFlowError('Code explanation requires one integrity-valid change-region manifest.', {
      code: 'CMP_EXPLANATION_SOURCE_UNAVAILABLE', details: { failures: validation.failures }
    });
  }
  const regions = [...manifest.regions].sort(compareRegions);
  const diffSource = inspectDiff(manifest, regions, diff);
  const structureSource = inspectStructure(structure);
  const graphSource = inspectGraph(manifest, graph);
  const drafts = [];
  for (const region of regions) {
    const file = diffSource.files.get(region.sourceChangeId);
    if (file) {
      const hunks = [...file.hunks].sort(compareHunks);
      if (hunks.length) drafts.push(...hunks.map((entry) => hunkDraft(region, entry)));
      else drafts.push(opaqueDraft(region, 'tracked-file-opaque', 'tracked-file-has-no-text-hunks'));
      continue;
    }
    if (diffSource.untrackedRegionIds.has(region.regionId)) {
      drafts.push(opaqueDraft(region, 'untracked-region-opaque', 'untracked-content-not-projected'));
      continue;
    }
    drafts.push(opaqueDraft(
      region,
      diffSource.classificationExact ? 'tracked-file-opaque' : 'change-region-opaque',
      diffSource.reason ?? 'tracked-file-hunks-unavailable'
    ));
  }
  drafts.sort(compareDrafts);
  let hunkNumber = 0;
  let opaqueNumber = 0;
  const units = drafts.map((draft) => unitFromDraft(
    draft,
    draft.kind === 'diff-hunk'
      ? `H-${String(++hunkNumber).padStart(3, '0')}`
      : `O-${String(++opaqueNumber).padStart(3, '0')}`,
    structureSource,
    graphSource
  ));
  const normalizedQuery = normalizeQuery({ hunk, symbol, clause });
  const whyEachChange = units.filter((unit) => matchesQuery(unit, normalizedQuery));
  const queryAvailable = normalizedQuery.type === 'all' || whyEachChange.length > 0;
  const status = !units.length ? 'not-applicable' : queryAvailable ? 'available' : 'unavailable';
  const reason = !units.length ? 'no-change-units'
    : queryAvailable ? null : 'drilldown-subject-unavailable';
  const candidate = {
    binding: manifest.candidateBinding,
    sha256: manifest.compatibilityCandidateSha256,
    truth: manifest.sourceKind === 'repository-change-set' ? 'working-tree' : 'repository-tree',
    context: normalizeContext(context)
  };
  const impact = freezeDeep({
    status: 'unavailable', reason: 'repository-impact-not-projected', truth: null,
    callers: [], importers: [], tests: [], contracts: []
  });
  const proof = freezeDeep({
    status: 'unavailable', reason: 'candidate-bound-hunk-proof-not-projected',
    vocabulary: ['passed-current', 'ready', 'owed', 'stale'], clauses: [], records: []
  });
  const counts = explanationCounts(regions, units, whyEachChange);
  const availability = {
    diff: { status: diffSource.status, reason: diffSource.reason },
    structure: structureAvailability(units, structureSource),
    cause: { status: 'unavailable', reason: graphSource.reason },
    impact: { status: impact.status, reason: impact.reason, truth: impact.truth },
    proof: { status: proof.status, reason: proof.reason }
  };
  const sources = {
    manifestSha256: manifest.manifestSha256,
    diffPreviewSha256: diffSource.patchSha256,
    cachedStructureSha256: structureSource.projectionSha256,
    evidenceProjectionSha256: evidenceSha256(manifest, evidence),
    graphSha256: graphSource.graphSha256
  };
  const explanationSetSha256 = canonicalSha256({
    candidateSha256: candidate.sha256,
    sources,
    explanationUnits: units.map((unit) => unit.explanationUnitSha256)
  });
  const core = {
    schemaVersion: 1, // schema-transient: observe-only projection; never persisted or authorized
    kind: 'comprehension-code-explanation',
    mode: 'observe-only',
    authoritative: false,
    authority: 'none',
    lifecycleGate: false,
    status,
    reason,
    candidate,
    query: {
      ...normalizedQuery,
      status: queryAvailable ? 'available' : 'unavailable',
      reason: queryAvailable ? null : 'drilldown-subject-unavailable'
    },
    sources,
    whyEachChange,
    impact,
    proof,
    counts,
    availability,
    unexplained: {
      reason: 'durable-hunk-cause-authority-unavailable',
      hunkIds: whyEachChange.filter((unit) => unit.unitKind === 'diff-hunk')
        .map((unit) => unit.unitId),
      opaqueUnitIds: whyEachChange.filter((unit) => unit.unitKind !== 'diff-hunk')
        .map((unit) => unit.unitId)
    },
    explanationSetSha256
  };
  return freezeDeep({ ...core, explanationSha256: canonicalSha256(core) });
}
