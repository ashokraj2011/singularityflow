/** Native presence-aware reads; recording rules are shared with the namespace Engine. */
import {scopeDecisions} from '../engine-compatibility/node-scope-policy.mjs';
import {countedRecords,inDecisionOrder,isWithdrawn} from '../presence/counted.mjs';
export {scopeAuthorities} from '../kernel/scope-decisions.mjs';
export const recordScopeDecision=scopeDecisions.recordScopeDecision;
export const recordCompletenessReview=scopeDecisions.recordCompletenessReview;

/** The completeness review that still speaks for this inventory, or null. */
export function currentCompletenessReview(workflow, inventory) {
  const latest = [...inDecisionOrder(workflow, countedRecords(workflow, workflow?.completenessReviews))].reverse().find((entry) => !isWithdrawn(workflow, entry)) ?? null;
  return latest && inventory && latest.inventorySha256 === inventory.inventorySha256 ? latest : null;
}
