/**
 * Compare two computed XPL2 views of the same repository [XPL2 M3, 5.1].
 *
 * Zero-import and pure, so the Change Explorer can tell a reader what moved between the snapshot
 * on screen and a newer one without rebuilding either. Units are compared by the content of the
 * change they hold (the file change's content identity, unit kind and ranges), never by display ID:
 * H-001 in one view and H-001 in another are the same change only when that content matches. A unit
 * digest stays bound to its own snapshot, so this comparison never lets a link from one view open a
 * unit of the other. Sources are compared by identity, digest and properties. Nothing here decides
 * which view is right; the older view stays the one on screen until the reader refreshes.
 */
export const XPL2_COMPARISON_LIMIT = 20;

const contentKey = (unit) => unit.changeContentSha256 ?? unit.explanationUnitSha256;

function units(view) {
  return new Map((view?.inventory?.units ?? []).map((unit) => [contentKey(unit), unit]));
}

function sources(view) {
  return new Map([
    ...(view?.sources ?? []).map((source) => [source.id, JSON.stringify([source.digest, source.properties])]),
    ...(view?.observations ?? []).map((observation) => [observation.id, JSON.stringify([observation.reason, observation.completeness])])
  ]);
}

const brief = (unit) => ({ unitId: unit.unitId, path: unit.path, digest: unit.explanationUnitSha256 });

/** What differs between two views; null when either is missing or they are of different repositories. */
export function compareXpl2Views(older, newer) {
  if (!older || !newer || older.kind !== 'xpl2-explanation' || newer.kind !== 'xpl2-explanation') return null;
  const before = units(older);
  const after = units(newer);
  const added = [...after.values()].filter((unit) => !before.has(contentKey(unit)));
  const removed = [...before.values()].filter((unit) => !after.has(contentKey(unit)));
  const kept = [...after.keys()].filter((digest) => before.has(digest)).length;
  const olderSources = sources(older);
  const newerSources = sources(newer);
  const changedSources = [...new Set([...olderSources.keys(), ...newerSources.keys()])]
    .filter((id) => olderSources.get(id) !== newerSources.get(id)).sort();
  return {
    sameSet: older.explanationSetSha256 === newer.explanationSetSha256,
    units: {
      kept,
      added: added.slice(0, XPL2_COMPARISON_LIMIT).map(brief),
      removed: removed.slice(0, XPL2_COMPARISON_LIMIT).map(brief),
      addedCount: added.length,
      removedCount: removed.length
    },
    sources: { changed: changedSources.slice(0, XPL2_COMPARISON_LIMIT), changedCount: changedSources.length },
    statements: { older: older.statements?.length ?? 0, newer: newer.statements?.length ?? 0 }
  };
}
