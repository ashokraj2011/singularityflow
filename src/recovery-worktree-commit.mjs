import { branch, commitReviewedPaths, head } from './git.mjs';
import { regularWorktreeFile } from './lifecycle-worktree.mjs';
import { inspectPhaseWorktreeScope } from './recovery-plan.mjs';
import { phaseRequiresCodeDelivery } from './delivery-evidence.mjs';
import { withSubjectLock } from './subject-lock.mjs';
import { assertNoHiddenWorktreeChanges } from './worktree-fingerprint.mjs';
import { operationContext } from './operation-context.mjs';
import { optionBoolean, optionString, SingularityFlowError } from './util.mjs';

// Eligibility comes from the resolved delivery contract, not a built-in phase name. Governance
// files, transport reports, links, renames/deletions and out-of-scope edits never get swept in.
export async function reviewedWorktreeCommitAction(root, config, workflow, phase, inspection, knownScope = null) {
  if (!phaseRequiresCodeDelivery(phase) || phase.id !== workflow.currentPhase
      || !['in_progress', 'awaiting_approval'].includes(phase.status)
      || branch(root) !== workflow.workItem.branch) return null;
  const scope = knownScope ?? await inspectPhaseWorktreeScope(root, config, workflow, phase);
  if (scope?.status !== 'verified') return null;
  const paths = inspection.entries.filter(entry => entry.path.kind === 'utf8'
    && (entry.type === 'untracked' || (entry.type === 'ordinary' && !entry.submodule.isSubmodule
      && ['.M', 'M.', 'MM', 'A.', 'AM', '.A'].includes(entry.xy.raw)))
    && scope.paths.includes(entry.path.value) && regularWorktreeFile(root, entry.path.value))
    .map(entry => entry.path.value).sort();
  if (!paths.length) return null;
  return {
    id: 'commit-reviewed-worktree', safe: false, automatic: false, mode: 'guided',
    confirmation: 'plan-hash', reviewRequired: true, paths, command: null, skill: '/sf-recover',
    detail: 'Optional: review and confirm the exact listed source, test and documentation bytes, commit them, then continue recovery/draft checks. This is not publication, submission, approval or a test waiver. Other paths and every published generation are preserved.',
    preserved: ['unlisted working-tree bytes', 'unlisted Git index entries', 'test reports', 'published generations', 'approval history'],
    scope: { phaseId: phase.id, basis: scope.basis, baseCommit: scope.baseCommit, changeSetDigest: scope.changeSetDigest }
  };
}

export async function commitReviewedRecovery(root, config, workflow, options) {
  if (optionBoolean(options, 'apply')) throw new SingularityFlowError(
    '--commit-reviewed and --apply are separate reviewed actions; choose one.', { code: 'RECOVERY_COMMIT_OPTIONS_INVALID' }
  );
  return withSubjectLock(root, { kind: 'story', id: workflow.workItem.id }, async () => {
    assertNoHiddenWorktreeChanges(root, 'Reviewed recovery commit');
    const { recoveryPlan, recoveryRevision } = await import('./collaboration.mjs');
    const settings = { phaseId: optionString(options, 'phase'), inspectActivePhase: true,
      modelEnabled: operationContext()?.modelMode.enabled !== false };
    const plan = await recoveryPlan(root, config, workflow, settings);
    const action = plan.actions.find(entry => entry.id === 'commit-reviewed-worktree');
    if (!action || plan.pendingPublication || plan.branch !== plan.targetBranch) {
      throw new SingularityFlowError('No verified code-phase authoring commit is available. Preserve the work and follow the exact recovery actions.', {
        code: 'RECOVERY_COMMIT_UNAVAILABLE', details: { recoveryCommand: `singularity-flow recover ${plan.workId} --json` }
      });
    }
    if (optionString(options, 'confirm') !== plan.planId) throw new SingularityFlowError(
      'Committing requires the exact current reviewed recovery plan hash. Inspect the diff and confirm a fresh plan.',
      { code: 'RECOVERY_PLAN_STALE', details: { planId: plan.planId, paths: action.paths,
        recoveryCommand: `singularity-flow recover ${plan.workId} --json` } }
    );
    const warnings = [];
    const commit = await commitReviewedPaths(root,
      `[${plan.workId}][phase:${action.scope.phaseId}][recovery] commit reviewed authoring changes`, action.paths, {
        expectedHead: plan.revision.head,
        onCleanupWarning: warning => warnings.push(warning),
        stabilityGuard: async () => {
          return JSON.stringify(recoveryRevision(root, config, workflow)) === JSON.stringify(plan.revision)
            && head(root) === plan.revision.head;
        }
      });
    const reviewedCommit = { commit, paths: action.paths, confirmedPlanId: plan.planId,
      pushed: false, lifecycleAdvanced: false, testsWaived: false, warnings };
    let after;
    try { after = await recoveryPlan(root, config, workflow, settings); }
    catch (error) {
      throw new SingularityFlowError(
        `Reviewed commit ${commit} completed, but follow-up recovery inspection failed: ${error.message}. `
        + 'Do not repeat the commit. Preserve it and rerun recovery; no lifecycle action was run.',
        { code: 'RECOVERY_COMMITTED_RECHECK_REQUIRED', details: { reviewedCommit,
          recoveryCommand: `singularity-flow recover ${plan.workId} --json` } }
      );
    }
    return { ...after, reviewedCommit,
      continued: 'Continue with the returned current recovery or phase actions; revalidate changed source before publication or approval.' };
  });
}
