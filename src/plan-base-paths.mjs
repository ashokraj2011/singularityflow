/**
 * The plan's existing and removed rows against the Story's base [PHR:REQ-002], finding 14.
 *
 * A row planned as existing behaviour names paths that must already be there, and a removal names
 * paths that must be there to remove. The code step judged both, after the plan was approved, when
 * its author could only route the plan back. The planner checks them here, against the commit the
 * Story started from. A path another row of the same plan creates or changes is the Story's own work,
 * not the base's, so it is not judged; a base the checkout cannot read judges nothing.
 */
import { exactTreePathsAtObject } from './git.mjs';

const BASE_JUDGED = new Set(['existing', 'removed']);

/** One problem per planned existing path missing from the base, and per planned removal absent from it. */
export function plannedBasePathProblems(root, workflow, claims) {
  const base = String(workflow?.workItem?.baseCommit ?? '');
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(base)) return [];
  const rows = Object.entries(claims ?? {}).flatMap(([clauseId, claim]) => (claim?.obligations ?? [claim])
    .map((obligation) => ({ clauseId, fulfillment: obligation?.fulfillment ?? claim?.fulfillment, paths: obligation?.expectedPaths ?? [] })));
  const created = new Set(rows.filter((row) => !BASE_JUDGED.has(row.fulfillment)).flatMap((row) => row.paths));
  const judged = rows.filter((row) => BASE_JUDGED.has(row.fulfillment));
  const wanted = [...new Set(judged.flatMap((row) => row.paths))].filter((candidate) => !created.has(candidate));
  if (!wanted.length) return [];
  const listed = exactTreePathsAtObject(root, base, wanted);
  if (!listed) return [];
  const present = new Set(listed);
  const at = base.slice(0, 12);
  return judged.flatMap((row) => row.paths.filter((candidate) => wanted.includes(candidate) && !present.has(candidate)).map((candidate) => ({
    code: row.fulfillment === 'existing' ? 'specification.planned-existing-path-missing' : 'specification.planned-removed-path-absent',
    clauseId: row.clauseId, path: candidate, fulfillment: row.fulfillment, baseCommit: base,
    message: row.fulfillment === 'existing'
      ? `${row.clauseId} plans existing behaviour at ${candidate}, but the Story's base (${at}) has no ${candidate}. Plan the row as new or modified, or name the path where it already exists.`
      : `${row.clauseId} plans to remove ${candidate}, but the Story's base (${at}) has no ${candidate}, so there is nothing to remove there. Name the path to remove, or plan the row another way.`
  })));
}
