/**
 * Deterministic structural-first fact selection, shared by live pagination and evidence replay.
 *
 * One module because the two consumers must never disagree: the live path orders facts before the
 * page is cut, and the replay runner must re-apply the identical order before re-cutting the same
 * page — a recorded `page.factsSha256` is only replayable if both sides sort with one function.
 */
export function factSelectionRank(fact) {
  const stage = fact?.extractor?.stage ?? null;
  const structural = fact?.kind !== 'file';
  if (structural && stage === 'semantic') return 0;
  if (structural && stage === 'syntax') return 1;
  if (structural) return 2;
  return 3;
}

export function orderFactsStructuralFirst(facts) {
  return facts
    .map((fact, index) => ({ fact, index, rank: factSelectionRank(fact) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.fact);
}

export const FACT_PRIORITIES = Object.freeze(['structural-first']);

export function applySelectionPriority(facts, priority) {
  return priority === 'structural-first' ? orderFactsStructuralFirst(facts) : facts;
}
