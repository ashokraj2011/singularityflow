/** Ordinary status reads have no submission, ledger or human-renderer imports. */
import { workflowAuthoringRoutes } from '../code-delivery-policy.mjs';
import { executeGitQuery } from '../git-query.mjs';
import { buildRepositorySubjectIndex, resolveContext } from '../repository-subject-index.mjs';
import { SingularityFlowError } from '../util.mjs';
export async function galStatusBranchCandidate(root, options = {}) {
  return executeGitQuery(root, 'repository.branch', {}, options);
}

export async function galStatusBranch(root, options = {}) {
  const current = await galStatusBranchCandidate(root, options);
  if (!current) throw new SingularityFlowError('Detached HEAD is not supported.');
  return current;
}

/** Resolve the status repository through the same selector-safe registered boundary. */
export function galStatusRepositoryRoot(cwd = process.cwd(), options = {}) {
  const root = executeGitQuery(cwd, 'repository.root', {}, options);
  if (!root) {
    throw new SingularityFlowError('Run Singularity Flow from inside a Git repository.');
  }
  return root;
}

/** Complete repository/branch selection used by the status command. */
export async function galStatusSelection(cwd = process.cwd(), options = {}) {
  const root = galStatusRepositoryRoot(cwd, options);
  return Object.freeze({ root, branch: await galStatusBranch(root, options) });
}

/** Ordinary JSON status only; submission readiness and author/reviewer packets stay on the CLI. */
export async function readStatus(root, workId = null) {
  const reference = workId ?? await galStatusBranch(root);
  const selected = resolveContext(await buildRepositorySubjectIndex(root), {
    reference, kind: 'story', required: true
  });
  return { ...selected.state, authoringRoutes: workflowAuthoringRoutes(selected.state) };
}
