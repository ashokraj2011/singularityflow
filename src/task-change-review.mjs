/**
 * Steps added to a task, as an approval reads the commits after a submission [ITW:REQ-009, REQ-014]: loaded only for a
 * task Story that gained a step (state.mjs reviewHistoryCommits).
 */
import { exactFileAtObject } from './git.mjs';
import { LIFECYCLE_EVENT } from './lifecycle-event.mjs';
import { recordSha256 } from './records.mjs';

const appendsOne = ({ before, after }, key) => Array.isArray(after[key]) && after[key].length === (before[key] ?? []).length + 1
  && recordSha256(after[key].slice(0, (before[key] ?? []).length)) === recordSha256(before[key] ?? []);

const TASK_CHANGE_KEYS = Object.freeze(['resolution', 'workflowSnapshot', 'taskChanges', 'phaseOrder', 'phases', 'history', 'publicationProjections']);

/**
 * Steps added to a task among the commits after a submission [ITW:REQ-009, REQ-014]. A step is only ever added after the
 * step that was current, so the step under review and every one before it are unchanged: each commit is accepted as
 * exactly one task change, its policy change replayed against its own decision record (assertTaskChangeScope), the
 * reviewed step's state unchanged, its files only the Story's state, the decision and its new snapshot revision. The
 * snapshot chain verifies the revision itself. Anything more stales the submission.
 */
export async function reviewSafeTaskChanges(root, config, workflow, phase, commits) {
  if (!commits.length || !(workflow.taskChanges ?? []).length) return [];
  const [{ governedStateChange, stateChangesOnly }, { assertTaskChangeScope, stableTaskStepState, taskChangeDigest }, { normalizeCurrentWorkflow }] = await Promise.all([
    import('./state.mjs'), import('./task-change-contracts.mjs'), import('./story-state-normalization.mjs')]);
  return commits.filter((commit) => {
    const raw = governedStateChange(root, config, workflow, commit);
    const event = raw?.event;
    if (event?.type !== LIFECYCLE_EVENT.CONFIGURATION_CHANGED || event.payload?.change !== 'task-step-added'
        || event.subject?.id !== workflow.workItem.id
        || raw.identity.eventSha256 !== `sha256:${recordSha256(event)}`) return false;
    // Both sides as every reader sees them: a record written at the start has none of the defaults the reader fills in
    // (repairBudgets, workIntervals), and the first commit after it writes them, which is no change.
    let change;
    try { change = { ...raw, before: normalizeCurrentWorkflow(structuredClone(raw.before)), after: normalizeCurrentWorkflow(structuredClone(raw.after)) }; }
    catch { return false; }
    if (!stateChangesOnly(change, TASK_CHANGE_KEYS)
        || !['taskChanges', 'history', 'publicationProjections'].every((key) => appendsOne(change, key))
        || change.after.history.at(-1)?.event !== 'task_step_added') return false;
    const summary = change.after.taskChanges.at(-1);
    const reference = change.after.workflowSnapshot;
    if (reference?.revision !== Number(change.before.workflowSnapshot?.revision) + 1
        || summary?.to?.revision !== reference.revision) return false;
    let decision;
    try {
      decision = JSON.parse(exactFileAtObject(root, commit, summary.decisionPath)?.toString('utf8') ?? 'null');
      assertTaskChangeScope(raw.before.resolution, raw.after.resolution, decision);
    } catch { return false; }
    if (decision?.id !== summary.id || taskChangeDigest(decision) !== summary.decisionSha256) return false;
    // The step under review, and every step before it, exactly as the review saw them.
    const reviewed = change.before.phaseOrder.indexOf(phase.id);
    if (reviewed < 0 || decision.position <= reviewed
        || change.before.phaseOrder.slice(0, reviewed + 1).some((id) => recordSha256(stableTaskStepState(change.before.phases[id]))
          !== recordSha256(stableTaskStepState(change.after.phases[id])))) return false;
    const snapshot = reference.manifestPath.slice(0, reference.manifestPath.lastIndexOf('/') + 1);
    const blobs = `${change.item}/config/wfa/blobs/`;
    return change.changed.every((file) => change.ownPaths.includes(file) || file === summary.decisionPath
      || file.startsWith(snapshot) || file.startsWith(blobs));
  });
}
