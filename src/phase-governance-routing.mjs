import { pendingIntentAmendmentAcknowledgement, sourceReviewAuthorConflict } from './source-review-policy.mjs';
import { decisionsCardAction, intentAmendmentPause, intentAmendmentPauseReason } from './intent-amendment-pause.mjs';
import { generationSkillForPhase, phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { copilotAction } from './copilot-guidance.mjs';
import { SingularityFlowError } from './util.mjs';

/** Shared read-only handoff for every workflow, including renamed/copied phases. */
export function phaseGovernanceHold(workflow, phase) {
  if (!phase) return null;
  const amendment = pendingIntentAmendmentAcknowledgement(workflow);
  if (amendment) return {
    code: 'INTENT_AMENDMENT_ACKNOWLEDGEMENT_REQUIRED', classification: 'amendment-acknowledgement-required',
    reason: `Approved amendment '${amendment.id}' requires an explicit human acknowledgement before downstream submission.`,
    // A person acknowledges it on the decisions card, which /sf-decide opens; no agent turn runs the
    // command itself, so its terminal line follows as theirs [owner, 2026-11-13].
    actions: [copilotAction({ ...decisionsCardAction(workflow), reason: `Acknowledge ${amendment.id} on the decisions card: a person reads the changed clauses and affected steps, then acknowledges it.` }),
      copilotAction({
        command: `singularity-flow story intent-amendment acknowledge ${amendment.id} --work-id ${workflow.workItem.id}`,
        reason: 'Or the person acknowledges it in their own terminal.', optional: true })]
  };
  // An undecided amendment proposed from this step pauses it, so the proposal cannot go stale; an
  // approval waiting on one has its own hold (approval-check.mjs) [owner, 2026-11-13].
  const paused = phase.status === 'in_progress' ? intentAmendmentPause(workflow, phase.id) : null;
  if (paused) return {
    code: 'INTENT_AMENDMENT_PENDING_PAUSE', classification: 'intent-amendment-pending',
    reason: `${intentAmendmentPauseReason(workflow, paused)}.`,
    actions: [copilotAction({ ...decisionsCardAction(workflow), reason: `A person who approves the scope decides ${paused.id} on the decisions card; ${phase.id} goes on once it is decided.` }),
      copilotAction({ command: `singularity-flow story intent-amendment status --work-id ${workflow.workItem.id} --json`,
        reason: `See what ${paused.id} changes.`, optional: true })].map((action) => ({ ...action, label: action.reason }))
  };
  if (!sourceReviewAuthorConflict(workflow, phase)) return null;
  return {
    code: 'SOURCE_REVIEW_AUTHOR_COLLISION', classification: 'source-review-author-conflict',
    reason: `Generation ${phase.generation} was authored by its required reviewer '${phase.generatedAgent}'. Preserve that history; the accepted author must re-author and publish a successor before independent review.`,
    actions: [
      ...(phase.defaultAgent ? [copilotAction({ skill: '/sf-agent',
        command: `singularity-flow agent --agent ${phase.defaultAgent}`,
        reason: 'Select the accepted phase author; do not relabel the published generation.' })] : []),
      ...(phase.status === 'awaiting_approval' ? [copilotAction({ skill: '/sf-reject',
        command: `singularity-flow reject ${phase.id} --work-id ${workflow.workItem.id} --fetch --to ${phase.id} --reason "Re-author under the accepted phase author for independent review"`,
        reason: 'An authorized human must return the submitted generation before authoring its successor.' })] : []),
      ...(phaseRequiresCodeDelivery(phase) && phase.generationIntent?.status === 'consumed'
        ? [copilotAction({ skill: '/sf-recover',
          command: `singularity-flow phase rollover ${phase.id} --json`,
          reason: 'Preview and review the exact successor-generation digest before reopening code authoring.' })] : []),
      copilotAction({ skill: generationSkillForPhase(phase, workflow),
        command: `singularity-flow prepare ${phase.id}`,
        reason: 'Re-author against the current approved inputs and publish a new generation, preserving all prior evidence.' })
    ]
  };
}

/** Direct lifecycle entry points share the same explicit hold as the read-only planners. */
export function assertPhaseGovernanceMayAdvance(workflow, phase) {
  const hold = phaseGovernanceHold(workflow, phase);
  if (hold) throw new SingularityFlowError(hold.reason, {
    code: hold.code, details: { workId: workflow.workItem.id, phase: phase?.id, actions: hold.actions }
  });
}

/**
 * Begin, prepare and publish of the step an undecided amendment was proposed from (submission reads the hold
 * above): refused, so the proposal stays bound to what it was proposed against; its decision, rejection and
 * refresh never are [owner, 2026-11-13].
 */
export function assertIntentAmendmentNotPausing(workflow, phaseId = workflow?.currentPhase) {
  const pending = intentAmendmentPause(workflow, phaseId);
  if (!pending) return;
  const workId = workflow.workItem.id;
  throw new SingularityFlowError(`${intentAmendmentPauseReason(workflow, pending)}.`, {
    code: 'INTENT_AMENDMENT_PENDING_PAUSE',
    details: { workId, phase: phaseId, amendment: pending.id, actions: [
      decisionsCardAction(workflow, `A person who approves the scope decides ${pending.id} on the decisions card.`),
      { command: `singularity-flow story intent-amendment decide ${pending.id} --decision reject --confirm ${pending.id} --work-id ${workId}`,
        detail: `Or they reject it in their own terminal; ${phaseId} then goes on as it was.` }] }
  });
}
