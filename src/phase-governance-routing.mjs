import { phaseGovernancePlan } from './kernel/phase-policy.mjs';
import { continuationActionPresentation } from './phase-transition-routes.mjs';
import { copilotAction } from './copilot-guidance.mjs';
import { SingularityFlowError } from './util.mjs';

/** Preserve the native error and route presentation over one shared kernel hold. */
export function phaseGovernanceHold(workflow, phase) {
  const plan = phaseGovernancePlan(workflow, phase);
  if (!plan) return null;
  return { code: plan.code, classification: plan.classification,
    reason: plan.classification === 'amendment-acknowledgement-required'
      ? `Approved amendment '${plan.amendmentId}' requires an explicit human acknowledgement before downstream submission.`
      : `Generation ${plan.generation} was authored by its required reviewer '${plan.generatedAgent}'. Preserve that history; the accepted author must re-author and publish a successor before independent review.`,
    actions: plan.actions.map(action => copilotAction(continuationActionPresentation(action, { workflow, phase }))) };
}

/** Direct lifecycle entry points share the same explicit hold as the read-only planners. */
export function assertPhaseGovernanceMayAdvance(workflow, phase) {
  const hold = phaseGovernanceHold(workflow, phase);
  if (hold) throw new SingularityFlowError(hold.reason, {
    code: hold.code, details: { workId: workflow.workItem.id, phase: phase?.id, actions: hold.actions }
  });
}
