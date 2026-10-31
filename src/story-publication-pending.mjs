/** Canonical story publication pending; legacy state exports delegate here. */
import { assertStoryNotArchived } from "./governance-archive.mjs";
import { enforceSequenceGate } from "./sequence.mjs";
import { legacyPendingPublicationPath } from "./story-state-write.mjs";
import { readPendingPublication } from "./publication-pending.mjs";
import { storyPublicationPending } from "./story-publication-read.mjs";
import { SingularityFlowError } from "./util.mjs";

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

/**
 * Another live command holding this Story's lock while its commit waits: it is publishing now. Said
 * as such, a publish in flight read as a stuck one (2026-10-28). Never this command's own lock.
 */
async function publishingNow(root, workId) {
  const { activeSubjectLocks, currentSubjectLockOwner, subjectLockPath } = await import('./subject-lock.mjs');
  const subject = { kind: 'story', id: workId };
  if (currentSubjectLockOwner(root, subject)) return null;
  const name = subjectLockPath(root, subject).split(/[\\/]/u).pop();
  const held = (await activeSubjectLocks(root).catch(() => [])).find((lock) => lock.directory.split(/[\\/]/u).pop() === name);
  return held && held.owner?.pid !== process.pid ? held : null;
}

export async function assertNoPendingPublication(root, config, workflow, action = 'continue') {
  // Retirement must precede prompt/artifact writes or retained-publication repair, not merely
  // the final workflow save. All existing mutation entry points share this preflight boundary.
  assertStoryNotArchived(root, workflow);
  const pending = await storyPublicationPending(root, config, workflow.workItem.id);
  const busy = pending ? await publishingNow(root, workflow.workItem.id) : null;
  if (busy) {
    // Waiting ends only a live owner here that still renews the lock. Another machine's owner, or
    // one here that stopped renewing, is ended by a person's reviewed release: since SDA nothing
    // takes it over by age, so "wait" became a loop (D3/E3).
    const { heldLeaseDetails, reviewedReleaseGuidance } = await import('./subject-lock.mjs');
    const subject = { kind: 'story', id: workflow.workItem.id };
    const details = { pid: busy.owner?.pid ?? null, ...heldLeaseDetails(subject, busy.directory, busy.owner, busy.liveness) };
    const again = action === 'continue' ? 'retry' : `${action} again`;
    throw new SingularityFlowError(details.releaseCommand
      ? `Story '${workflow.workItem.id}' is held by another command that is publishing it (PID ${busy.owner?.pid ?? 'unknown'}`
        + ` on ${busy.owner?.host ?? 'an unknown host'}). Nothing was changed, and waiting does not end it.`
        + `${reviewedReleaseGuidance(subject, busy.owner, busy.liveness)}. Then ${again}.`
      : `Another command${busy.owner?.pid ? ` (PID ${busy.owner.pid})` : ''} is publishing Story '${workflow.workItem.id}' right now. `
        + `Nothing was changed; wait for it to finish, then ${again}.`,
    { code: 'STORY_PUBLICATION_IN_PROGRESS', details });
  }
  if (pending && !(await repairRetainedPublication(root, config, workflow, action))) {
    await enforceSequenceGate(root, workflow, 'publicationPending', action, {
      reason: 'Publication is pending because a retained local lifecycle commit has not reached its configured remote.'
    });
  }
}

export const TRANSITION_REPAIR_SWITCH = 'SINGULARITY_FLOW_TRANSITION_REPAIR';
