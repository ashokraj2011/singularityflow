/** Reuse only the exact accepted execution capability; legacy anchoring keeps its original owner. */
import { storyExecutionVerified } from './story-execution-context.mjs';

export async function pinnedResolutionVerification(root, config, workflow) {
  if (workflow.workflowSnapshot && storyExecutionVerified(root, config, workflow)) {
    return { verified: true, reason: null };
  }
  return (await import('./state.mjs')).legacyPinnedResolutionVerification(root, config, workflow);
}
