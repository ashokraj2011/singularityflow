/**
 * Snapshot comparison [XPL2 M3, 5.1], shared by `explain --compare` and the Change Explorer.
 *
 * Import-free, so the extension renders the same comparison without bundling the engine. Units are
 * compared by the content of the change they hold (`unitContentSha256`: the hunk's own text with its
 * paths, or the file change and ranges when the patch was not projected), never by display ID: H-001
 * in one view and H-001 in another are the same change only when that content matches. A unit digest
 * stays bound to its own snapshot, so nothing here lets a link from one view open a unit of the
 * other. Sources are compared by identity, digest and properties, observations by reason and
 * completeness. Nothing here decides which view is right.
 */
export const XPL2_COMPARISON_LIMIT = 20;
export const XPL2_COMPARISON_PROJECTION = 'xpl2-comparison@1';

/**
 * What a comparison reads of a view, and the whole of what a retained snapshot keeps: no statement
 * text, no source content, no path beyond the units' own.
 */
export function xpl2ComparisonProjection(view) {
  if (!view || view.kind !== 'xpl2-explanation') return null;
  if (view.projection === XPL2_COMPARISON_PROJECTION) return view;
  return {
    kind: 'xpl2-explanation',
    projection: XPL2_COMPARISON_PROJECTION,
    explanationSetSha256: view.explanationSetSha256 ?? null,
    units: (view.inventory?.units ?? []).map((unit) => ({
      unitId: unit.unitId, path: unit.path, digest: unit.explanationUnitSha256, content: unit.unitContentSha256 ?? null
    })),
    sources: [
      ...(view.sources ?? []).map((source) => [source.id, JSON.stringify([source.digest, source.properties])]),
      ...(view.observations ?? []).map((observation) => [observation.id, JSON.stringify([observation.reason, observation.completeness])])
    ],
    statements: view.statements?.length ?? 0
  };
}

const brief = (unit) => ({ unitId: unit.unitId, path: unit.path, digest: unit.digest });

/** What differs between two views or retained snapshots; null when either is missing or not a view. */
export function compareXpl2Views(older, newer) {
  const [before, after] = [xpl2ComparisonProjection(older), xpl2ComparisonProjection(newer)];
  if (!before || !after) return null;
  const olderSources = new Map(before.sources);
  const newerSources = new Map(after.sources);
  const changedSources = [...new Set([...olderSources.keys(), ...newerSources.keys()])]
    .filter((id) => olderSources.get(id) !== newerSources.get(id)).sort();
  // A view built before units carried their own content cannot be compared unit by unit: its unit
  // digests are bound to its snapshot, so every unit would read as new and gone.
  const comparable = [before, after].every((view) => view.units.every((unit) => Boolean(unit.content)));
  const olderUnits = new Map(before.units.map((unit) => [unit.content ?? '', unit]));
  const newerUnits = new Map(after.units.map((unit) => [unit.content ?? '', unit]));
  const added = [...newerUnits.values()].filter((unit) => !olderUnits.has(unit.content ?? ''));
  const removed = [...olderUnits.values()].filter((unit) => !newerUnits.has(unit.content ?? ''));
  const kept = [...newerUnits.keys()].filter((digest) => olderUnits.has(digest)).length;
  return {
    sameSet: before.explanationSetSha256 === after.explanationSetSha256,
    units: !comparable ? null : {
      kept,
      added: added.slice(0, XPL2_COMPARISON_LIMIT).map(brief),
      removed: removed.slice(0, XPL2_COMPARISON_LIMIT).map(brief),
      addedCount: added.length,
      removedCount: removed.length
    },
    sources: { changed: changedSources.slice(0, XPL2_COMPARISON_LIMIT), changedCount: changedSources.length },
    statements: { older: before.statements, newer: after.statements }
  };
}
