/**
 * SFlow's own record writers that are no person's decision, by event, with exactly what each commit may change besides
 * workflow.json, STATUS.md and its ledger intent [owner, 2026-11-28: SFlow's own records never undo an approval]:
 *   phaseKeys  the keys of one step's state it may change (its usage accounting)
 *   files      which other files of the Story's records it may write (`itemFile` spells a record's path in either layout)
 *   history    the history event it appends
 * Each is review-safe in REVIEW_EFFECTS (state.mjs); a commit that changes anything else is not one. Loaded only when a
 * commit after a submission is not a decision (state.mjs sflowRecordCommit).
 */
import { governedStateChange, stateChangesOnly } from './state.mjs';
import { recordSha256 } from './records.mjs';
import { LIFECYCLE_EVENT } from './lifecycle-event.mjs';

export const RECORD_WRITERS = Object.freeze({
  // Copilot usage reconciled after a version: the step's usage and its telemetry record, never what was reviewed.
  [LIFECYCLE_EVENT.TELEMETRY_RECORDED]: Object.freeze({ phaseKeys: Object.freeze(['usage', 'telemetry']), history: 'phase_telemetry_reconciled',
    files: (itemFile, event) => (file) => file === itemFile(`telemetry/${event.phaseId}-gen${event.generation}.json`) })
});

/** Whether a commit is one of these: its event, history and files are its kind's, and only its step's listed keys change. */
export function recordWriterCommit(root, config, workflow, commit) {
  const change = governedStateChange(root, config, workflow, commit);
  const event = change?.event;
  const writer = event ? RECORD_WRITERS[event.type] : null;
  if (!writer || event.subject?.id !== workflow.workItem.id || change.identity.eventSha256 !== `sha256:${recordSha256(event)}`) return false;
  const own = writer.files(change.itemFile, event);
  if (change.changed.some((file) => !change.ownPaths.includes(file) && !own(file))) return false;
  const { before, after } = change;
  if (after.history?.length - (before.history?.length ?? 0) !== 1 || after.history.at(-1)?.event !== writer.history) return false;
  if (!stateChangesOnly(change, ['history', 'publicationProjections', ...(writer.phaseKeys.length ? ['phases'] : [])])) return false;
  const phases = [...new Set([...Object.keys(before.phases ?? {}), ...Object.keys(after.phases ?? {})])];
  return phases.every((id) => {
    const was = before.phases?.[id] ?? null;
    const is = after.phases?.[id] ?? null;
    if (recordSha256(was) === recordSha256(is)) return true;
    if (id !== event.phaseId || !was || !is) return false;
    return [...new Set([...Object.keys(was), ...Object.keys(is)])].every((key) => writer.phaseKeys.includes(key)
      || recordSha256(was[key] ?? null) === recordSha256(is[key] ?? null));
  });
}
