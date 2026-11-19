/**
 * SFlow never merges (owner, 2026-11-19). After the delivered code is approved by a person, finalizing the Story and
 * opening its pull request follow by themselves once the remaining steps pass; merging stays the person's click on the
 * Git host. This runs right after the approval that ends the Story (a person's, or SFlow's own when the last steps were
 * ready): it finalizes the Story for review (the packet binding its exact commit), then opens the pull request with the
 * GitHub CLI where the repository uses pull requests. Each part that cannot run here says why and names the one route
 * that does; nothing here undoes the approval, and nothing ever merges or promotes.
 *
 * It runs only when a person approved a step that delivers code in this Story: their Yes there is what lets the
 * pull request open later. A Story with no such step keeps its own routes (finalize, then `pr`), as before.
 */
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';

const MERGE_WORDS = 'Merge it on your Git host when its checks pass; SFlow never merges.';

/** Whether a person approved a step that delivers code in this Story (their Yes that lets the pull request open). */
export function deliveredCodeApprovedByPerson(workflow) {
  return (workflow?.phaseOrder ?? []).some((id) => {
    const phase = workflow.phases?.[id];
    return phaseRequiresCodeDelivery(phase) && phase?.status === 'approved'
      && (phase.approvals ?? []).some((entry) => !entry.invalidatedAt && entry.decision === 'approved');
  });
}

/**
 * After the approval that closed `workId`: finalize it, then open its pull request. Returns null when it does not apply
 * (the Story is open, or no person approved its delivered code), else `{ finalized, pullRequest, lines, next }`: what
 * happened in words, and the one route left for the person when something could not run here.
 */
export async function landAfterLastApproval(root, workId) {
  const { loadAcceptedStoryExecution } = await import('./accepted-story-execution.mjs');
  let accepted = await loadAcceptedStoryExecution(root, workId);
  const workflow = accepted.workflow;
  if (workflow.status !== 'closed' || workflow.currentPhase || !deliveredCodeApprovedByPerson(workflow)) return null;
  const config = () => accepted.config ?? accepted.definition;
  const lines = [];
  let finalized = (workflow.lineage?.finalizations ?? []).length > 0;
  let next = null;
  if (!finalized) {
    try {
      const [{ changes }, { recordedCompletion }, { assertRequiredStepActionsRecorded }, { StoryStateStore }, { finalizeStoryDelivery }] = await Promise.all([
        import('./git.mjs'), import('./completion-verdict.mjs'), import('./step-action-receipts.mjs'), import('./state-stores.mjs'), import('./story-lineage.mjs')]);
      if (!recordedCompletion(workflow)?.verified) throw new Error('its final check has not passed yet');
      if (changes(root).trim()) throw new Error('the working tree has uncommitted changes');
      await assertRequiredStepActionsRecorded(root, config(), workflow, 'The Story cannot be finalized');
      const impact = Boolean(workflow.measurement?.plan && workflow.measurement?.status !== 'opted-out');
      await new StoryStateStore(root, config()).transact(workflow,
        { type: impact ? 'impact-finalized' : 'work-completed', phaseId: workflow.currentPhase, payload: { workCompleted: true } },
        `[${workId}][finalize] ready for Product Owner review`,
        async () => finalizeStoryDelivery(root, config(), workflow, { persist: false }));
      finalized = true;
      lines.push(`Finalized ${workId} for review: the packet binds its exact commit.`);
      accepted = await loadAcceptedStoryExecution(root, workId);
    } catch (error) {
      next = { command: `singularity-flow finalize --parent ${workId}`, skill: '/sf-finalize', label: 'Finalize the Story for review.' };
      lines.push(`Not finalized yet: ${firstLine(error)}. Finalize it when that is fixed.`);
    }
  }
  let pullRequest = null;
  if (finalized) {
    const policy = accepted.workflow.lineage?.branchCompletionPolicy ?? accepted.workflow.source?.branchCompletionPolicy ?? 'pr';
    if (policy === 'direct') {
      lines.push(`${workId} completes without a pull request (repository policy: direct); promoting its branch stays yours.`);
    } else {
      try {
        const { createStoryPullRequest, storyPullRequestPlan } = await import('./pull-request.mjs');
        const plan = await storyPullRequestPlan(root, config(), accepted.workflow);
        pullRequest = createStoryPullRequest(root, plan, { remote: config().git?.remote ?? 'origin' });
        lines.push(`${pullRequest.status === 'existing' ? 'Its pull request is already open' : 'Opened its pull request'}: ${pullRequest.url}. ${MERGE_WORDS}`);
      } catch (error) {
        next = { command: `singularity-flow pr ${workId}`, skill: '/sf-pr', label: 'Open the pull request from its preview.' };
        lines.push(`The pull request was not opened here: ${firstLine(error)}. Open it from its preview. ${MERGE_WORDS}`);
      }
    }
  }
  return { finalized, pullRequest, lines, next };
}

function firstLine(error) {
  return String(error?.message ?? error).split('\n')[0].replace(/[.\s]+$/u, '');
}
