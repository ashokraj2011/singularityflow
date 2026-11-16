import { requiresProspectivePhaseInspection } from './code-submission-evidence.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { phaseUsesDeterministicGeneration } from './manual-authorship.mjs';
import { phaseGovernanceHold } from './phase-governance-routing.mjs';
import { reviewAsksForCorrection, reviewCorrection, sourceReviewContinuation } from './source-review-continuation.mjs';
import { copilotAction } from './copilot-guidance.mjs';
import { versionFactsOf } from './phase-generation-need.mjs';
import { consumedOpeningMismatch, versionNeed, versionNumbers } from './kernel/step-versions.mjs';
import { versionProposal } from './story-version-proposal.mjs';

const NEED_REASONS = Object.freeze({ REWORK: 'rework', REJECTED: 'rejected', AMENDMENT: 'amendment', AUTHOR_CONFLICT: 'author-conflict' });

/**
 * A published step's next version, for any reason, is the person's one yes, asked here with the host's question tool and
 * the proposal's own words and numbers [D3, §7.1, OSA:REQ-030]; the same turn goes straight on to its work once it opens.
 */
function successorAsk(workflow, phase, { reason, findings = [], route }) {
  const { proposal, question } = versionProposal(workflow, phase, { reason });
  // The step's own preview route (its continuation's, with its work command), asked with the proposal's question.
  const preview = { ...route, reason: `Ask the person "${question}"; on their yes this preview, then its confirmation, opens version ${proposal.version} of ${phase.id}.` };
  return { status: 'successor-confirmation-required', reason: reason === 'review-corrections' ? 'retained-review-correction' : reason,
    targetGeneration: proposal.version, successor: { question, choices: ['Yes', 'No'], preview, findings }, actions: [preview] };
}

/** Read-only entry classification. Only explicit prepare can reserve a document successor. */
export function phaseAuthoringEntry(workflow, phase, { review = null, reviewError = null } = {}) {
  // An impossible record, then positive damage, come before holds and authoring, as in the edit permission (section 5
  // precedence 1 and 3) [OSA:REQ-003, REQ-004].
  const facts = workflow.currentPhase === phase.id && phase.status === 'in_progress' ? versionFactsOf(workflow, phase) : null;
  const numbers = facts ? versionNumbers(facts) : null;
  if (numbers && (!numbers.ok || numbers.opening === 'ahead' || numbers.opening === 'invalid')) return {
    status: 'attention-required', reason: 'opening-not-applicable', actions: [copilotAction({ command: `singularity-flow phase show ${phase.id} --json`,
      reason: `Inspect ${phase.id}: its open version's number is past the next one or unreadable, so nothing is written until a person resolves it.` })] };
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
  // A review that could not be read is an unknown fact, not damage: its own read again, with the original error kept
  // [§5 precedence 1, OSA:REQ-003, REQ-022, b1].
  if (reviewError) return { status: 'attention-required', reason: 'source-review-inspection-required',
    actions: [copilotAction({ skill: '/sf-review-source',
      command: `singularity-flow review-source status ${phase.id} --json`,
      reason: `Source review could not be read (${reviewError.code ?? 'inspection failed'}). Read its status again; the publication stays as it is, and nothing is written before it reads.` })],
    diagnostic: reviewError };
  const deterministic = phaseUsesDeterministicGeneration(phase);
  if (requiresProspectivePhaseInspection(workflow, phase)) {
    // A step a person returned, a rejection or an amendment reopened is written in its own entry, one command for the
    // entry, the permission and the task [OSA:REQ-010, C13]; its next version opens first, on the person's yes, asked here
    // [D3, OSA:REQ-030]. So does an older build's local opening of a successor, which the opening operation promotes.
    const opened = versionNumbers(versionFactsOf(workflow, phase));
    const legacy = opened.ok && opened.writing > 1 && versionFactsOf(workflow, phase).opening?.record === 'legacy';
    if (opened.ok && (!deterministic || phaseRequiresCodeDelivery(phase)) && (legacy || (opened.writing === null && opened.published >= 1))) {
      const route = legacy ? copilotAction({ command: `singularity-flow phase rollover ${phase.id} --json` }) : sourceReviewContinuation(workflow, phase).actions[0];
      return successorAsk(workflow, phase, { route, reason: legacy ? 'legacy-promotion' : NEED_REASONS[versionNeed(versionFactsOf(workflow, phase))] ?? 'requested-change' });
    }
    return { status: 'authoring-entry' };
  }
  const continuation = review ? sourceReviewContinuation(workflow, phase, review) : null;
  // A retained review asked a published code step for corrections: its next version is the person's one yes, asked here
  // with the host's question tool, and the same turn goes straight on to the fix (owner, 2026-11-16). Never automatic.
  if (continuation?.classification === 'successor-publication-required' && reviewAsksForCorrection(review)
      && continuation.nextCommand === `singularity-flow phase rollover ${phase.id} --json`) {
    return successorAsk(workflow, phase, { route: continuation.actions[0], reason: 'review-corrections', findings: reviewCorrection(review, phase.generation)?.findings ?? [] });
  }
  if (continuation?.classification === 'successor-publication-required'
      && !phaseRequiresCodeDelivery(phase) && !deterministic
      && phase.generationPolicy?.requirement !== 'none') return {
    status: 'successor-preparation-required', reason: 'retained-review-correction',
    targetGeneration: continuation.targetGeneration,
    preparation: continuation.actions[0], actions: continuation.actions
  };
  return { status: 'retained-generation', ...(continuation ? { reason: continuation.classification,
    actions: continuation.actions } : {}) };
}
