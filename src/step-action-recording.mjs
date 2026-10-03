/**
 * Committing after-step action receipts: the transaction behind `integrations record`, and the
 * recording a machine does by itself right after it delivers a required action, so the next step
 * is not held waiting for someone to run the command.
 */
import { identity } from './git.mjs';
import { LIFECYCLE_EVENT } from './lifecycle-event.mjs';
import { commitAndPublish, loadConfig, loadStoryAggregate } from './state-stores.mjs';
import {
  assertReceiptsMayBeRecorded, missingRequiredStepActionReceipts, planStepActionReceipts, stepAwaitingApproval,
  storyRequiresStepActions, writeStepActionReceipts
} from './step-action-receipts.mjs';
import { SingularityFlowError } from './util.mjs';

/**
 * Commit a receipt for each of the Story's delivered deliveries without one, in one
 * external-synchronized commit. Refused while a step awaits approval. Returns what was written and
 * the publication.
 */
export async function commitStepActionReceipts(root, config, workflow) {
  assertReceiptsMayBeRecorded(workflow);
  const who = identity(root, { offline: true });
  const recordedBy = { name: who?.name || null, email: who?.email || null };
  let written = [];
  const publication = await commitAndPublish(
    root,
    config,
    workflow,
    { type: LIFECYCLE_EVENT.EXTERNAL_SYNCHRONIZED, payload: { operation: 'step-action-receipts' } },
    `[${workflow.workItem.id}][integrations][record] after-step action receipts`,
    [],
    {
      beforeStateWrite: async () => {
        // Planned again under the Story's lock, so two recordings at once never write a receipt twice.
        const fresh = await planStepActionReceipts(root, config, workflow);
        written = await writeStepActionReceipts(root, config, workflow, fresh.pending, { recordedAt: new Date().toISOString(), recordedBy });
        if (!written.length) {
          throw new SingularityFlowError('Another command recorded these receipts first; nothing was changed.', { code: 'STEP_ACTION_RECEIPTS_ALREADY_RECORDED' });
        }
        return written;
      },
      eventFromResult: (created) => ({
        payload: { operation: 'step-action-receipts', deliveryKeys: (created ?? []).map((entry) => entry.receipt.deliveryKey) }
      })
    }
  );
  return { written, publication };
}

/**
 * After a command delivered after-step actions: when this machine delivered a required action of
 * the checked-out Story that has no receipt yet, record the Story's receipts now. Returns null when
 * there is nothing to do: no Story here, another Story, no required action, a step awaiting
 * approval (the receipts wait for the decision), or no such delivery on this machine.
 */
export async function recordRequiredReceiptsAfterDelivery(root, { workId = null } = {}) {
  let config;
  let workflow;
  try {
    config = await loadConfig(root);
    workflow = await loadStoryAggregate(root, config);
  } catch { return null; }
  if (!workflow?.workItem?.id || (workId && workflow.workItem.id !== workId)) return null;
  if (!storyRequiresStepActions(workflow) || stepAwaitingApproval(workflow)) return null;
  const missing = new Set((await missingRequiredStepActionReceipts(root, config, workflow)).map((entry) => entry.key));
  if (!missing.size) return null;
  const plan = await planStepActionReceipts(root, config, workflow);
  if (!plan.pending.some((record) => missing.has(record.key))) return null;
  return commitStepActionReceipts(root, config, workflow);
}

/** One line for a person after an automatic recording, or null. */
export function recordedReceiptsLine(recorded) {
  if (!recorded?.written?.length) return null;
  const count = recorded.written.length;
  return `Recorded ${count} after-step receipt${count === 1 ? '' : 's'} in commit ${recorded.publication.sha.slice(0, 8)}${recorded.publication.pushed ? ' (pushed)' : ''}, so the next step is not held.`;
}
