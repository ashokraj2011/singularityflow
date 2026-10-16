/**
 * A person's way out of a worktree review hold: set the held changes aside.
 *
 * Recovery holds a step when the checkout has changes it cannot attribute to the open step
 * (PHASE_CONTEXT_WORKTREE_REVIEW_REQUIRED, and the same check before approval). Its only routes were
 * a read-only inspection and, for code steps, a reviewed commit of application files; a document
 * step, or any file in the Story's own directory, had no command at all, so the agent stopped and
 * asked for "human review" nobody could perform. A person who has looked at the files either keeps
 * them (commits them, which is theirs to do) or sets them aside here: every changed file and the
 * Git index are saved first in a private recovery copy, then exactly the listed paths return to
 * their committed bytes (an untracked one is deleted). Plan-hash confirmed, refused for agents.
 */
import { createPhaseCheckpoint } from './phase-checkpoint.mjs';
import { restorePathsToHead } from './git.mjs';
import { withSubjectLock } from './subject-lock.mjs';
import { assertNoHiddenWorktreeChanges } from './worktree-fingerprint.mjs';
import { operationContext } from './operation-context.mjs';
import { optionString, SingularityFlowError } from './util.mjs';

/** The recovery action, offered beside a working-tree hold that only a person can resolve. */
export function setAsideWorktreeAction(worktreeAction, workflow, phase, publishedEdits = []) {
  const held = worktreeAction?.confirmation === 'human-authority' ? worktreeAction.unexpectedPaths ?? [] : [];
  const paths = [...new Set([...held, ...publishedEdits])].sort();
  if (!paths.length || !phase || phase.id !== workflow.currentPhase
      || !['in_progress', 'awaiting_approval'].includes(phase.status)) return null;
  return {
    id: 'set-aside-worktree', safe: false, automatic: false, mode: 'guided', confirmation: 'plan-hash',
    reviewRequired: true, humanOnly: true, paths, command: null, skill: '/sf-recover',
    ...(publishedEdits.length ? { publishedEdits } : {}),
    detail: 'For the person, after looking at each listed file: to keep it, commit it yourself (an edited published document is kept only through an authorized return or successor); to drop it, run this command in your own terminal. It first saves every changed file and the Git index in a private recovery copy (appeal checkpoint-show lists it), then returns exactly the listed paths to their committed bytes, deleting the untracked ones. An agent must show this command and stop.',
    preserved: ['a private recovery copy of every changed file and the Git index', 'unlisted working-tree bytes', 'published generations', 'approval history']
  };
}

export async function setAsideRecovery(root, config, workflow, options) {
  return withSubjectLock(root, { kind: 'story', id: workflow.workItem.id }, async () => {
    assertNoHiddenWorktreeChanges(root, 'Setting aside held changes');
    const { recoveryPlan, recoveryRevision } = await import('./collaboration.mjs');
    const settings = { phaseId: optionString(options, 'phase'), inspectActivePhase: true,
      modelEnabled: operationContext()?.modelMode.enabled !== false };
    const plan = await recoveryPlan(root, config, workflow, settings);
    const action = plan.actions.find(entry => entry.id === 'set-aside-worktree');
    if (!action || plan.branch !== plan.targetBranch) {
      throw new SingularityFlowError('Nothing is held for a person to set aside here. Follow the exact recovery actions.', {
        code: 'RECOVERY_SET_ASIDE_UNAVAILABLE', details: { recoveryCommand: `singularity-flow recover ${plan.workId} --json` }
      });
    }
    if (optionString(options, 'confirm') !== plan.planId) throw new SingularityFlowError(
      'Setting changes aside requires the exact current recovery plan hash. Look at the listed files and confirm a fresh plan.',
      { code: 'RECOVERY_PLAN_STALE', details: { planId: plan.planId, paths: action.paths,
        recoveryCommand: `singularity-flow recover ${plan.workId} --json` } }
    );
    const phase = workflow.phases[workflow.currentPhase];
    const checkpoint = await createPhaseCheckpoint(root, config, workflow, phase);
    if (JSON.stringify(recoveryRevision(root, config, workflow)) !== JSON.stringify(plan.revision)) {
      throw new SingularityFlowError(`The checkout changed while it was being saved. Nothing was set aside; the recovery copy ${checkpoint.id} is kept. Inspect recovery again.`, {
        code: 'RECOVERY_PLAN_STALE', details: { checkpoint: checkpoint.id, recoveryCommand: `singularity-flow recover ${plan.workId} --json` }
      });
    }
    const { restored, removed } = restorePathsToHead(root, action.paths);
    const after = await recoveryPlan(root, config, workflow, settings);
    return { ...after, setAside: { paths: action.paths, restored, removed, checkpoint: checkpoint.id,
      inspect: checkpoint.next, confirmedPlanId: plan.planId, lifecycleAdvanced: false, testsWaived: false } };
  });
}
