import { phaseExplicitlyReopened } from './sequence.mjs';
import { requiresProspectivePhaseInspection } from './code-submission-evidence.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { phaseUsesDeterministicGeneration } from './manual-authorship.mjs';
import { phaseGovernanceHold } from './phase-governance-routing.mjs';
import { reviewAsksForCorrection, reviewCorrection, sourceReviewContinuation } from './source-review-continuation.mjs';
import { copilotAction } from './copilot-guidance.mjs';
import { versionFactsOf } from './phase-generation-need.mjs';
import { consumedOpeningMismatch, versionNumbers } from './kernel/step-versions.mjs';

/** Read-only entry classification. Only explicit prepare can reserve a document successor. */
export function phaseAuthoringEntry(workflow, phase, { review = null, reviewError = null } = {}) {
  // An impossible record, then positive damage, come before holds and authoring, as in the edit permission (section 5
  // precedence 1 and 3) [OSA:REQ-003, REQ-004].
  const facts = workflow.currentPhase === phase.id && phase.status === 'in_progress' ? versionFactsOf(workflow, phase) : null;
  const numbers = facts ? versionNumbers(facts) : null;
  if (numbers && (!numbers.ok || numbers.opening !== 'none' && numbers.opening !== 'applicable')) return {
    status: 'attention-required', reason: 'opening-not-applicable', actions: [copilotAction({ command: `singularity-flow phase show ${phase.id} --json`,
      reason: `Inspect ${phase.id}: its open version's number was used or skipped, so nothing is written until a person resolves it.` })] };
  if (facts && phaseRequiresCodeDelivery(phase) && consumedOpeningMismatch(facts)) return {
    status: 'attention-required', reason: 'successor-boundary-damaged', actions: [copilotAction({ skill: '/sf-recover',
      command: `singularity-flow recover ${workflow.workItem.id} --phase ${phase.id} --json`,
      reason: 'Keep the published version and the current edits, and let recovery check what went wrong before any code changes.' })] };
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
    // A code step returned for rework, or reopened by a skill amendment, is written now: its edit permission grants the
    // step's files and its authoring task opens the next version with `phase begin` before any application edit. The entry
    // said "next: prepare" while the permission and the task said `phase begin`, two commands for one step [OSA:REQ-010, C13].
    if (phaseRequiresCodeDelivery(phase) && phase.generationIntent?.status === 'consumed' && !phaseExplicitlyReopened(workflow, phase)) return {
      status: 'attention-required', reason: 'code-rollover-required',
      actions: [copilotAction({ skill: '/sf-code', command: `singularity-flow phase rollover ${phase.id} --json`,
        reason: `Preview starting version ${Number(phase.generation ?? 0) + 1} of ${phase.id} and ask the person to confirm it; version ${phase.generation} and its tests stay as published.` })] };
    return { status: 'authoring-entry' };
  }
  const continuation = review ? sourceReviewContinuation(workflow, phase, review) : null;
  // A retained review asked a published code step for corrections: its next version is the person's one yes, asked here
  // with the host's question tool, and the same turn goes straight on to the fix (owner, 2026-11-16). Never automatic.
  if (continuation?.classification === 'successor-publication-required' && phaseRequiresCodeDelivery(phase)
      && reviewAsksForCorrection(review) && continuation.nextCommand === `singularity-flow phase rollover ${phase.id} --json`) {
    const to = continuation.targetGeneration;
    return { status: 'successor-confirmation-required', reason: 'retained-review-correction', targetGeneration: to,
      successor: { question: `Start version ${to} to fix the review's findings? Version ${to - 1} and its tests stay.`, choices: ['Yes', 'No'],
        preview: continuation.actions[0], findings: reviewCorrection(review, phase.generation)?.findings ?? [] },
      actions: continuation.actions };
  }
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
