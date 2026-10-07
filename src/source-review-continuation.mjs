/** Read-only author/reviewer handoff. A draft is never evidence of publication. */
import { phaseNeedsGeneration } from './sequence.mjs';
import { nextPhaseGeneration } from './phase-generation.mjs';
import { generationSkillForPhase, phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { copilotAction } from './copilot-guidance.mjs';
import { phaseGovernanceHold } from './phase-governance-routing.mjs';
import { decisionSubmitArguments } from './workflow-decisions.mjs';
import { sourceReviewRequired } from './source-review-policy.mjs';

export function sourceReviewContinuation(workflow, phase, review = null) {
  const hold = phaseGovernanceHold(workflow, phase);
  const action = (skill, command, reason) => copilotAction({ skill, command, reason });
  let classification, actions, generation = Number(phase.generation ?? 0);
  if (hold) { classification = hold.classification; actions = hold.actions; }
  else if (workflow.currentPhase !== phase.id || phase.status !== 'in_progress') {
    classification = 'lifecycle-review-required';
    actions = [action('/sf-nextsteps', `singularity-flow nextsteps ${workflow.workItem.id} --json`,
      'Inspect the current lifecycle. Submitted evidence requires an authorized return before authoring a successor.')];
  } else if (phaseNeedsGeneration(workflow, phase) || (review?.status === 'correction-required'
      && (review.findings ?? []).some(finding => finding.code !== 'human-disposition-required'))) {
    classification = 'successor-publication-required'; generation = nextPhaseGeneration(phase);
    actions = phaseRequiresCodeDelivery(phase) && phase.generationIntent?.status === 'consumed'
      ? [action('/sf-recover', `singularity-flow phase rollover ${phase.id} --json`,
        'Review the guarded code successor boundary; preserve the published generation and its tests.')]
      : [action(generationSkillForPhase(phase, workflow), `singularity-flow prepare ${phase.id}`,
        `Resume the phase author and prepare generation ${generation}. Preserve any private corrected draft, author it at the returned artifact path, then draft-check and prepublish. Publish only when the returned gates are ready; ${sourceReviewRequired(workflow, phase.id) ? 'review the published successor afterward' : 'follow its returned submission handoff'}.`)];
  } else if (review?.pendingDispositions?.length) {
    classification = 'human-disposition-required';
    actions = [action('/sf-review-source', `singularity-flow review-source decide ${phase.id} --finding ${review.pendingDispositions[0].id} --reason <TEXT>`,
      'An authorized human must decide this exact pending disposition; the reviewer cannot accept it.')];
  } else if (review?.status === 'ready') {
    classification = 'submission-required';
    actions = [action('/sf-submit', `singularity-flow submit ${phase.id} --work-id ${workflow.workItem.id}${decisionSubmitArguments(workflow, phase.id)}`,
      'Run configured checks and submit the reviewed publication; this review is not approval.')];
  } else {
    classification = 'source-review-required';
    actions = [action('/sf-review-source', `singularity-flow review-source context ${phase.id} --json`,
      'Review the exact published generation and its pinned answers; never review an unpublished draft as a successor.')];
  }
  return { classification, publishedGeneration: Number(phase.generation ?? 0), targetGeneration: generation,
    automaticAdvance: false, actions, nextCommand: actions[0]?.command ?? null,
    nextSkill: actions[0]?.skill ?? null, copilotCommand: actions[0]?.copilotCommand ?? null };
}
