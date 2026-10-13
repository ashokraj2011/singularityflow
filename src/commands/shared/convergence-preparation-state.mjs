/** Extracted command implementation; governance remains in the existing kernel APIs. */

export function convergencePreparationState(projection) {
  if (!projection) return null;
  const disposed = new Set((projection.findings ?? []).map((finding) => finding.itemId));
  const undisposedItemIds = [...(projection.facts ?? []), ...(projection.candidateSnapshot ?? [])]
    .map((item) => item.id)
    .filter((id) => !disposed.has(id));
  return {
    iteration: projection.iteration,
    sha256: projection.convergenceSha256,
    factCount: projection.facts?.length ?? 0,
    findingCount: projection.findings?.length ?? 0,
    undisposedItemIds,
    unresolvedBlockers: projection.unresolvedBlockers ?? [],
    allowedNext: projection.allowedNext ?? []
  };
}
