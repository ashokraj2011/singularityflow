/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { storyRequiresStepActions } from '../../step-actions.mjs';
import { requiredStepActionHold, stepActionHoldSentence } from '../../step-action-receipts.mjs';

/** What holds the Story after a transition, for the next actions it prints; null when nothing does. */
export async function stepActionHoldAfterTransition(root, config, workflow) {
  if (!storyRequiresStepActions(workflow)) return null;
  try {
    const hold = await requiredStepActionHold(root, config, workflow);
    return hold ? { ...hold, reason: stepActionHoldSentence(hold) } : null;
  } catch { return null; }
}
