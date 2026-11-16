/**
 * "Active elsewhere" (the workspaces analysis's WS-10): a second laptop opened a Story another one was working on, with
 * no word about it.
 *
 * Nothing records which computer holds a Story, and nothing should be fetched only to find out. What opening a Story
 * already fetched tells it: the Story's branch on the remote had commits this computer did not have. When the Story's own
 * record says its last event was recent, the Story was being worked on elsewhere a moment ago (another computer, or
 * another person), and the person is told so before they work on it here too. It reads the record already loaded: no Git
 * process and no network. Opening the Story is never refused for it.
 */

/** How recent the Story's last recorded event must be to count as work in progress elsewhere. */
export const ACTIVE_ELSEWHERE_HOURS = 12;

function ago(milliseconds) {
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}

/**
 * The warning for a Story whose checkout here just moved from `before` (null: this computer had no copy) to `after`, the
 * remote's head, given the Story's record as it is now, or null when nothing came from elsewhere lately.
 */
export function storyActiveElsewhere({ workId, before = null, after = null, workflow = null, now = Date.now(), hours = ACTIVE_ELSEWHERE_HOURS }) {
  if (!after || before === after) return null;
  const history = Array.isArray(workflow?.history) ? workflow.history : [];
  const changedAt = Date.parse(history.at(-1)?.at ?? '');
  if (!Number.isFinite(changedAt) || now - changedAt > hours * 3_600_000 || changedAt - now > 3_600_000) return null;
  return {
    workId, commit: after, changedAt: new Date(changedAt).toISOString(), hadCopy: before !== null,
    words: `${workId} was changed elsewhere ${ago(Math.max(0, now - changedAt))}: its branch on the remote had commits this `
      + `computer did not${before === null ? ' (it had no copy of the Story)' : ''}. If another computer is still working on it, `
      + `publish its work there first (singularity-flow sync ${workId}) so the two copies do not part ways.`
  };
}
