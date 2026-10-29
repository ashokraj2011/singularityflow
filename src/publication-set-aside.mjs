/**
 * Setting a waiting Story commit aside (`sync <WORK-ID> --set-aside`, 2026-10-28).
 *
 * A lifecycle commit that lost a push race to another clone, that a person already undid with
 * `git reset`, or that reached the remote outside SFlow (a hand push, which SFlow never counts as its
 * own publication) could never be published: sync repeated the same refusal, and cancel and every
 * step waited on it. The person who looked at it sets it aside in their own terminal with the commit's
 * full ID: the commit is kept at `refs/sflow-set-aside/<WORK-ID>/<commit>`, the waiting publication
 * is cleared, and a branch that still ends in it moves to what the remote has (or to its parent), so
 * the step's action is done again there if it still applies. Nothing is pushed or forced. Without
 * `--confirm` it is a preview.
 */
import path from 'node:path';
import { assertClean, branch, fetchRemote, head, isAncestor, moveCheckedOutBranch, preserveCommitRef, refHead } from './git.mjs';
import { clearPendingPublication, readPendingPublication } from './publication-pending.mjs';
import { workDir } from './story-paths.mjs';
import { withSubjectLock } from './subject-lock.mjs';
import { SingularityFlowError } from './util.mjs';

const REASONS = Object.freeze({
  'no-pending-publication': 'nothing is waiting to be published',
  'commit-unavailable': 'the waiting commit is not in this checkout',
  interrupted: 'the publication was interrupted before its commit; run singularity-flow sync to roll it back',
  'commits-after-it': 'commits were made on the branch after it; move them off it first',
  'not-checked-out': 'its branch is not the one checked out here'
});

export function setAsideReason(plan) {
  return REASONS[plan?.reason] ?? plan?.reason ?? 'it cannot be set aside';
}

function pendingOptions(root, config, workId) {
  return { kind: 'story', id: workId, legacyPath: path.join(workDir(root, config, workId), 'publication-pending.json') };
}

/** What setting the waiting commit aside would do, or why it cannot. Fetches; changes nothing else. */
export async function planPublicationSetAside(root, config, workflow) {
  const workId = workflow.workItem.id;
  const pending = await readPendingPublication(root, pendingOptions(root, config, workId));
  const refuse = (reason, extra = {}) => ({ settable: false, reason, workId, ...extra });
  if (!pending) return refuse('no-pending-publication');
  const record = pending.record ?? {};
  const commit = String(record.commit ?? '');
  if (record.recoveryStage === 'interrupted-before-branch-ref-advanced') return refuse('interrupted');
  if (!/^[0-9a-f]{40,64}$/u.test(commit) || !refHead(root, `${commit}^{commit}`)) return refuse('commit-unavailable', { commit });
  const target = record.branch ?? workflow.workItem.branch ?? workId;
  const remote = record.remote ?? config.git?.remote ?? 'origin';
  await fetchRemote(root, remote);
  const remoteTip = refHead(root, `refs/remotes/${remote}/${target}`);
  const local = refHead(root, `refs/heads/${target}`);
  const shared = {
    workId, commit, branch: target, remote, remoteTip,
    event: record.event?.type ?? null, phase: record.event?.phaseId ?? null,
    preservedRef: `refs/sflow-set-aside/${workId}/${commit}`,
    command: `singularity-flow sync ${workId} --set-aside --confirm ${commit}`
  };
  if (remoteTip && (remoteTip === commit || isAncestor(root, commit, remoteTip))) {
    // Already there, sent outside SFlow: the branch stays as it is; only the waiting stops.
    return { settable: true, ...shared, publishedElsewhere: true, parent: null, moveTo: null, onBranch: Boolean(local), lostRace: false };
  }
  const onBranch = Boolean(local) && (local === commit || isAncestor(root, commit, local));
  if (onBranch && local !== commit) return refuse('commits-after-it', { commit, local });
  if (onBranch && branch(root) !== target) return refuse('not-checked-out', { commit, branch: target });
  const parent = refHead(root, `${commit}^`);
  // Back to what the remote has when it builds on this commit's parent (a lost race), else the parent.
  const moveTo = !onBranch ? null : remoteTip && parent && isAncestor(root, parent, remoteTip) ? remoteTip : parent;
  // A race is lost only when another clone moved the remote past this commit's parent. A remote still
  // at the parent refused the push for its own reason (a protected branch, a 403): sync called that a
  // lost race and offered set-aside, and redoing the step was refused the same way (2026-10-29).
  return { settable: true, ...shared, publishedElsewhere: false, parent, moveTo, onBranch,
    lostRace: Boolean(remoteTip) && remoteTip !== parent && moveTo === remoteTip };
}

/** Set the waiting commit aside after the person confirmed its exact ID. */
export async function setPublicationAside(root, config, workflow, { confirm }) {
  const workId = workflow.workItem.id;
  return withSubjectLock(root, { kind: 'story', id: workId }, async () => {
    const plan = await planPublicationSetAside(root, config, workflow);
    if (!plan.settable) {
      throw new SingularityFlowError(`The waiting commit cannot be set aside: ${setAsideReason(plan)}. Nothing was changed.`,
        { code: 'PUBLICATION_SET_ASIDE_REFUSED', details: { reason: plan.reason, commit: plan.commit ?? null } });
    }
    if (confirm !== plan.commit) {
      throw new SingularityFlowError(`Confirm with the full ID of the waiting commit: ${plan.command}. Nothing was changed.`,
        { code: 'PUBLICATION_SET_ASIDE_CONFIRMATION', details: { commit: plan.commit, nextAction: plan.command } });
    }
    if (plan.moveTo) assertClean(root);
    preserveCommitRef(root, plan.preservedRef, plan.commit);
    if (plan.moveTo) moveCheckedOutBranch(root, plan.moveTo);
    await clearPendingPublication(root, pendingOptions(root, config, workId));
    return { ...plan, setAside: true, head: head(root) };
  });
}
