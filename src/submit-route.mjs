/**
 * The command that takes a published step toward approval, for every producer of guidance.
 *
 * Routes used to offer a bare `submit <phase>` from wherever they were, so a step that owes an
 * independent source review first, or that feeds a workflow decision, got a command the submit
 * gate then refused. A reviewable step goes through submission readiness (which reports the review
 * and its exact route); any other step gets `submit` with the decision values it must record.
 */
import { sourceReviewRequired } from './source-review-policy.mjs';
import { decisionSubmitArguments } from './workflow-decisions.mjs';

export function submitRoute(workflow, phase) {
  const workId = workflow.workItem.id;
  if (sourceReviewRequired(workflow, phase.id)) {
    return { skill: '/sf-submit', command: `singularity-flow status ${workId} --submission-readiness --json`,
      reason: `Check ${phase.id}'s submission readiness: its independent source review comes before submission.` };
  }
  return { skill: '/sf-submit', command: `singularity-flow submit ${phase.id} --work-id ${workId}${decisionSubmitArguments(workflow, phase.id)}`,
    reason: `Submit published ${phase.id}.` };
}
