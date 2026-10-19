/** Canonical story publication pending; legacy state exports delegate here. */
import { assertStoryNotArchived } from "./governance-archive.mjs";
import { enforceSequenceGate } from "./sequence.mjs";
import { legacyPendingPublicationPath } from "./story-state-write.mjs";
import { readPendingPublication } from "./publication-pending.mjs";
import { storyPublicationPending } from "./story-publication-read.mjs";

export async function repairRetainedPublication(root, config, workflow, action) {
  if (['off', '0', 'false', 'no'].includes(String(process.env[TRANSITION_REPAIR_SWITCH] ?? '').trim().toLowerCase())) return false;
  const pending = await readPendingPublication(root, {
    kind: 'story', id: workflow.workItem.id,
    legacyPath: legacyPendingPublicationPath(root, config, workflow.workItem.id)
  }).catch(() => null);
  if (!pending || pending.record?.recoveryStage === 'interrupted-before-branch-ref-advanced') return false;
  try {
    const result = await (await import('./state.mjs')).syncPublication(root, config, workflow);
    if (result.recoveredPrepared) return false;
  } catch {
    return false;
  }
  if (await storyPublicationPending(root, config, workflow.workItem.id)) return false;
  console.warn(`Published the retained local commit before this transition (${action}).`);
  return true;
}

export async function assertNoPendingPublication(root, config, workflow, action = 'continue') {
  // Retirement must precede prompt/artifact writes or retained-publication repair, not merely
  // the final workflow save. All existing mutation entry points share this preflight boundary.
  assertStoryNotArchived(root, workflow);
  if (await storyPublicationPending(root, config, workflow.workItem.id)
      && !(await repairRetainedPublication(root, config, workflow, action))) {
    await enforceSequenceGate(root, workflow, 'publicationPending', action, {
      reason: 'Publication is pending because a retained local lifecycle commit has not reached its configured remote.'
    });
  }
}

export const TRANSITION_REPAIR_SWITCH = 'SINGULARITY_FLOW_TRANSITION_REPAIR';
