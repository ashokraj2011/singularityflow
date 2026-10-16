/** Optional intake acceleration. A prepared checkout is not a Story, readiness or authority. */
import { optionString, optionStrings, SingularityFlowError } from './util.mjs';
import { normalizeQualityGateMode } from './phase-quality-risk.mjs';
import { parseReferenceRepositoryOptions } from './reference-repositories.mjs';
import { admitStoryIntakeReceipt } from './story-intake-verification.mjs';
import { prepareStoryWorktree, preparedStoryWorktreePath, discardPreparedStoryWorktree } from './story-worktree.mjs';

/** Only a passing, exact-request receipt may trigger speculative local checkout work. */
export async function prepareIntakeWorktree(root, workId, options) {
  if (process.env.SINGULARITY_FLOW_INTAKE_WORKTREE_PREPARATION === 'off') return { status: 'unavailable', reason: 'disabled' };
  const receipt = optionString(options, 'intake-receipt');
  const baseBranch = optionString(options, 'from-branch');
  const remote = optionString(options, 'remote', 'origin');
  if (!receipt || !baseBranch || optionStrings(options, 'from-branch').length !== 1
      || optionString(options, 'ref', workId) !== workId
      || optionString(options, 'readiness-baseline', 'reuse') === 'run') {
    return { status: 'unavailable', reason: 'inputs' };
  }
  const references = parseReferenceRepositoryOptions(optionStrings(options, 'reference-repository'),
    optionStrings(options, 'reference-branch'));
  const admission = await admitStoryIntakeReceipt(root, receipt, {
    workId, remote, baseBranch,
    inputs: { workId, workType: optionString(options, 'work-type'), baseBranch, remote,
      capabilityId: optionString(options, 'capability') ?? null,
      readinessBaseline: optionString(options, 'readiness-baseline', 'reuse'),
      testExecutionMode: optionString(options, 'test-execution-mode', 'changed-and-affected'),
      qualityGateMode: normalizeQualityGateMode(optionString(options, 'gate-mode', 'hard')),
      references: references.map(entry => ({ id: entry.id, url: entry.repository, branch: entry.requestedBranch })) }
  });
  if (admission.status !== 'admitted') return { status: 'unavailable', reason: admission.reason };
  try {
    const baseCommit = admission.repository.baseCommit;
    const existing = await preparedStoryWorktreePath(root, workId, { baseCommit });
    if (existing) return { status: 'prepared', workId, baseCommit, owned: false };
    const prepared = await prepareStoryWorktree(root, workId, { base: baseCommit });
    return { status: 'prepared', workId, baseCommit, owned: prepared.created };
  } finally { await admission.release(); }
}

export async function discardIntakeWorktree(root, workId, options) {
  const baseCommit = optionString(options, 'prepared-base');
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(baseCommit ?? '')) throw new SingularityFlowError(
    'Prepared cleanup requires the exact initial base commit.', { code: 'STORY_WORKTREE_INVALID' });
  return discardPreparedStoryWorktree(root, workId, { baseCommit });
}
