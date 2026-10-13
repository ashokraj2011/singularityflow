/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { loadAcceptedStoryExecution } from '../../accepted-story-execution.mjs';

export async function acceptedStoryExecutionIfPresent(root, reference = null) {
  try { return await loadAcceptedStoryExecution(root, reference); }
  catch (error) {
    if (error?.code === 'STORY_NOT_FOUND') return null;
    throw error;
  }
}
