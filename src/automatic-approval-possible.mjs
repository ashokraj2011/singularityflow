/**
 * Its own small module, so the session projection and the lifecycle handlers that read source-review-policy.mjs load
 * none of the approval rules it needs.
 */
import { approvesAutomatically } from './approval-authority.mjs';
import { isConvergencePhase } from './phase-roles.mjs';
import { sourceReviewRequired } from './source-review-policy.mjs';

/**
 * Whether SFlow can approve `phase` without a person once it is ready: its approval rules say so, and it is a step its
 * independent reviewer reviews, or the convergence step, whose own check stands in for one (automatic-approval.mjs).
 * A step with no reviewer is always approved by a person, whatever its rules say, so nothing promises otherwise: its
 * receipt said "approved automatically when its reviewer says ready" beside "no reviewer reviews this step" (owner's
 * note, 2026-11-21).
 */
export function automaticApprovalPossible(workflow, phase) {
  return approvesAutomatically(phase?.approvalPolicy)
    && (isConvergencePhase(phase) || (Boolean(phase?.id) && sourceReviewRequired(workflow, phase.id)));
}
