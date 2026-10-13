/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { runDraftTransaction } from '../../draft-unit-of-work.mjs';
import { workflowPublicationBranch, workDir } from '../../state-stores.mjs';
import { posix } from '../../util.mjs';
import path from 'node:path';
import { captureAggregateRecovery, restoreAggregateRecovery } from '../../aggregate-recovery.mjs';
import { captureTelemetryCursorsForWorkItem, restoreTelemetryCursorsForWorkItem } from '../../telemetry.mjs';

export async function storyDraftTransaction(root, config, workflow, operation, write, validate = null) {
  let aggregateRecovery = null;
  let telemetryRecovery = null;
  try {
    return await runDraftTransaction(root, {
      subject: {
        kind: 'story',
        id: workflow.workItem.id,
        branch: workflowPublicationBranch(root, workflow)
      },
      expectedRevision: workflow[Symbol.for('singularity-flow.state-revision')] ?? null,
      allowedPaths: [posix(path.relative(root, workDir(root, config, workflow.workItem.id)))],
      operation,
      // Capture caller-visible and optional machine-local state only after the Story lock and durable
      // draft journal exist. Capturing earlier lets a competing same-Story command complete between
      // snapshot and acquisition, after which this rollback could erase its valid cursor state.
      write: async (...args) => {
        aggregateRecovery = captureAggregateRecovery(workflow);
        telemetryRecovery = await captureTelemetryCursorsForWorkItem(
          root, workflow.workItem.id
        );
        return write(...args);
      },
      validate,
      afterRollback: async () => {
        if (aggregateRecovery) restoreAggregateRecovery(workflow, aggregateRecovery);
        await restoreTelemetryCursorsForWorkItem(
          root, workflow.workItem.id, telemetryRecovery
        );
      }
    });
  } catch (error) {
    // Preserve safe phase identity at the transaction boundary even when the user omitted the
    // optional phase argument (for example `phase begin`). The shared refusal presenter can then
    // keep recovery inside this Story and phase instead of falling back to repository-wide doctor.
    const phaseId = String(operation).split(':').at(-1);
    if (error && typeof error === 'object' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(phaseId)) {
      try {
        error.details = {
          ...(error.details && typeof error.details === 'object' ? error.details : {}),
          workId: workflow.workItem.id,
          phase: phaseId,
          operation
        };
      } catch { /* A frozen provider error keeps its original safe refusal. */ }
    }
    throw error;
  }
}
