/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { storyRequiresStepActions } from '../../step-actions.mjs';
import { redactDiagnosticText } from '../../git-remote-diagnostics.mjs';

/**
 * Right after this machine delivered a required after-step action, record the Story's receipts so
 * the next step is not held. Returns a line to print, or null. Never fails the command it follows.
 */
export async function recordRequiredReceiptsAfterTransition(root, workflow) {
  if (!storyRequiresStepActions(workflow)) return null;
  try {
    const { recordRequiredReceiptsAfterDelivery, recordedReceiptsLine } = await import('../../step-action-recording.mjs');
    return recordedReceiptsLine(await recordRequiredReceiptsAfterDelivery(root, { workId: workflow.workItem.id }));
  } catch (error) {
    console.warn(`Warning: a required after-step action was delivered, but its receipt could not be recorded: ${redactDiagnosticText(error?.message ?? String(error))} Run singularity-flow integrations record.`);
    return null;
  }
}
