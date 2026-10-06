import { pendingIntentAmendmentAcknowledgement, sourceReviewAuthorConflict } from './source-review-policy.mjs';
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
    actions: [copilotAction({ skill: '/sf-reject',
      command: `singularity-flow story intent-amendment acknowledge ${amendment.id} --work-id ${workflow.workItem.id}`,
      reason: 'Review the changed clauses and affected phases, then acknowledge only with the contributor\'s explicit choice.' })]
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
