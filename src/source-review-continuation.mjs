/** Read-only author/reviewer handoff. A draft is never evidence of publication. */
import { phaseExplicitlyReopened, phaseNeedsGeneration } from './sequence.mjs';
import { nextPhaseGeneration } from './phase-generation.mjs';
import { generationSkillForPhase, phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { copilotAction } from './copilot-guidance.mjs';
import { phaseGovernanceHold } from './phase-governance-routing.mjs';
import { decisionSubmitArguments } from './workflow-decisions.mjs';
import { sourceReviewRequired } from './source-review-policy.mjs';
import { raiseUpstreamIssueRoute } from './upstream-routes.mjs';

/**
 * When everything a review still holds is a reviewer finding about the approved specification, the
 * way on is to raise it there [PHR:REQ-003]: the plan's author cannot correct it, and a successor of
 * the plan would meet it again. Null otherwise, or when no raise is open from here.
 */
export function reviewUpstreamRoute(workflow, phase, review) {
  const holding = (review?.findings ?? []).filter((entry) => entry.code !== 'human-disposition-required');
  if (review?.status !== 'correction-required' || !holding.length || !holding.every((entry) => entry.code === 'reviewer-blocker' && entry.upstreamPhase)) return null;
  const [first] = holding;
  const raised = raiseUpstreamIssueRoute(workflow, first.upstreamPhase, phase.id);
  return raised ? { command: raised.command.replace('<clause-or-section>', first.about ?? first.reviewFindingId), skill: '/sf-decide',
    label: `${holding.length === 1 ? 'The reviewer finding is' : `${holding.length} reviewer findings are`} about ${first.upstreamPhase}'s approved output: raise ${holding.length === 1 ? 'it' : 'each'} to ${first.upstreamPhase}'s approvers; then ${phase.id} is not held by ${holding.length === 1 ? 'it' : 'them'}, only the Story's ending.` } : null;
}

export function sourceReviewContinuation(workflow, phase, review = null) {
  const hold = phaseGovernanceHold(workflow, phase);
  const action = (skill, command, reason) => copilotAction({ skill, command, reason });
  let classification, actions, generation = Number(phase.generation ?? 0);
  if (hold) { classification = hold.classification; actions = hold.actions; }
  else if (workflow.currentPhase !== phase.id || phase.status !== 'in_progress') {
    classification = 'lifecycle-review-required';
    actions = [action('/sf-nextsteps', `singularity-flow nextsteps ${workflow.workItem.id} --json`,
      'Inspect the current lifecycle. Submitted evidence requires an authorized return before authoring a successor.')];
  } else if (!phaseNeedsGeneration(workflow, phase) && reviewUpstreamRoute(workflow, phase, review)) {
    const route = reviewUpstreamRoute(workflow, phase, review);
    classification = 'upstream-issue-required';
    actions = [action(route.skill, route.command, route.label)];
  } else if (phaseNeedsGeneration(workflow, phase) || (review?.status === 'correction-required'
      && (review.findings ?? []).some(finding => finding.code !== 'human-disposition-required'))) {
    classification = 'successor-publication-required'; generation = nextPhaseGeneration(phase);
    actions = phaseRequiresCodeDelivery(phase) && phase.generationIntent?.status === 'consumed' && !phaseExplicitlyReopened(workflow, phase)
      ? [action('/sf-recover', `singularity-flow phase rollover ${phase.id} --json`,
        'Review the guarded code successor boundary; preserve the published generation and its tests.')]
      : [action(generationSkillForPhase(phase, workflow), `singularity-flow prepare ${phase.id}`,
        `Resume the phase author and prepare generation ${generation}. Preserve any private corrected draft, author it at the returned artifact path, then draft-check and prepublish. Publish only when the returned gates are ready; ${sourceReviewRequired(workflow, phase.id) ? 'review the published successor afterward' : 'follow its returned submission handoff'}.`)];
  } else if (review?.pendingDispositions?.length) {
    classification = 'human-disposition-required';
    actions = [action('/sf-review-decide', `singularity-flow review-source decision-context ${phase.id} --work-id ${workflow.workItem.id} --finding ${review.pendingDispositions[0].id} --reason <TEXT> --json`,
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
