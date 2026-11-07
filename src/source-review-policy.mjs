import { SingularityFlowError } from './foundation/failures.mjs';

/** A pinned, opt-in gate. Older Story resolutions without this field stay unchanged. */
/**
 * `reviewable(phaseId)`, when given, says whether a step defines the scope or plans the claims; the
 * policy is read from the step's structure, never its name [E2G-001].
 */
export { normalizeSourceReviewPolicy, assertSourceReviewerAvailable } from './kernel/phase-admission.mjs';

export { sourceReviewRequired, sourceReviewAuthorConflict } from './kernel/phase-policy.mjs';

import { pendingIntentAmendmentAcknowledgement } from './kernel/phase-policy.mjs';
export { pendingIntentAmendmentAcknowledgement };

export function assertIntentAmendmentAcknowledged(workflow) {
  const amendment = pendingIntentAmendmentAcknowledgement(workflow);
  if (!amendment) return;
  const command = `singularity-flow story intent-amendment acknowledge ${amendment.id} --work-id ${workflow.workItem.id}`;
  throw new SingularityFlowError(`Intent amendment '${amendment.id}' changed ${amendment.changedClauses?.join(', ') || 'the approved scope'}. Acknowledge it before downstream revalidation with ${command}.`, {
    code: 'INTENT_AMENDMENT_ACKNOWLEDGEMENT_REQUIRED',
    details: { workId: workflow.workItem.id, phase: workflow.currentPhase,
      actions: [{ command, skill: '/sf-reject', detail: 'Review the amendment and acknowledge only with an explicit human choice.' }] }
  });
}
