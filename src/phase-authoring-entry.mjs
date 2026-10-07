import { requiresProspectivePhaseInspection } from './code-submission-evidence.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { phaseUsesDeterministicGeneration } from './manual-authorship.mjs';
import { phaseGovernanceHold } from './phase-governance-routing.mjs';
import { sourceReviewContinuation } from './source-review-continuation.mjs';
import { copilotAction } from './copilot-guidance.mjs';

/** Read-only entry classification. Only explicit prepare can reserve a document successor. */
export function phaseAuthoringEntry(workflow, phase, { review = null, reviewError = null } = {}) {
  const hold = phaseGovernanceHold(workflow, phase);
  if (hold) return { status: 'attention-required', reason: hold.classification, actions: hold.actions };
  if (workflow.currentPhase !== phase.id || phase.status !== 'in_progress') return {
    status: 'retained-generation', reason: 'lifecycle-review-required',
    actions: sourceReviewContinuation(workflow, phase).actions
  };
  if (reviewError) return { status: 'attention-required', reason: 'source-review-inspection-required',
    actions: [copilotAction({ skill: '/sf-recover',
      command: `singularity-flow recover ${workflow.workItem.id} --phase ${phase.id} --json`,
      reason: `Source review could not be verified (${reviewError.code ?? 'inspection failed'}). Preserve the publication and inspect recovery before authoring.` })],
    diagnostic: reviewError };
  if (requiresProspectivePhaseInspection(workflow, phase)) {
    if (phaseRequiresCodeDelivery(phase) && phase.generationIntent?.status === 'consumed') return {
      status: 'attention-required', reason: 'code-rollover-required',
      actions: [copilotAction({ skill: '/sf-recover', command: `singularity-flow phase rollover ${phase.id} --json`,
        reason: 'Review the guarded code successor boundary; preserve the published generation and its tests.' })]
    };
    return { status: 'authoring-entry' };
  }
  const continuation = review ? sourceReviewContinuation(workflow, phase, review) : null;
  if (continuation?.classification === 'successor-publication-required'
      && !phaseRequiresCodeDelivery(phase) && !phaseUsesDeterministicGeneration(phase)
      && phase.generationPolicy?.requirement !== 'none') return {
    status: 'successor-preparation-required', reason: 'retained-review-correction',
    targetGeneration: continuation.targetGeneration,
    preparation: continuation.actions[0], actions: continuation.actions
  };
  return { status: 'retained-generation', ...(continuation ? { reason: continuation.classification,
    actions: continuation.actions } : {}) };
}
