/** Read-only native presentation; a draft is never evidence of publication. */
import { sourceReviewContinuationPlan } from './kernel/phase-policy.mjs';
import { continuationActionPresentation } from './phase-transition-routes.mjs';
import { copilotAction } from './copilot-guidance.mjs';

export function sourceReviewContinuation(workflow, phase, review = null) {
  const plan = sourceReviewContinuationPlan(workflow, phase, review);
  const actions = plan.actions.map(action => copilotAction(continuationActionPresentation(action, { workflow, phase })));
  return { classification: plan.classification, publishedGeneration: plan.publishedGeneration,
    targetGeneration: plan.targetGeneration, automaticAdvance: false, actions,
    nextCommand: actions[0]?.command ?? null, nextSkill: actions[0]?.skill ?? null,
    copilotCommand: actions[0]?.copilotCommand ?? null };
}
