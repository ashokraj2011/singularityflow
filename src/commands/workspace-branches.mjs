/** One advisory readiness snapshot; expensive services load only on a cache miss. */
import { repoRoot } from '../git-execution.mjs';
import { optionBoolean } from '../util.mjs';
import { automaticWorkspaceStoryCheckout } from '../workspace-story-checkout.mjs';
import { storyReadinessSnapshot } from '../story-readiness-snapshot.mjs';
import { measureCommandSpan } from '../dx-timing-context.mjs';

export async function readWorkspaceBranches(options = {}, { root: launchRoot = null } = {}) {
  const checkout = await automaticWorkspaceStoryCheckout('workspace', ['workspace', 'branches'], options,
    { cwd: launchRoot ?? process.cwd() });
  const root = checkout?.repositoryPath ?? repoRoot(launchRoot ?? process.cwd());
  const result = await storyReadinessSnapshot(root, options, checkout, () => measureCommandSpan('start.readiness', async () => {
    const { readWorkspaceBranchesAtRoot } = await import('./workspace-branches-service.mjs');
    return readWorkspaceBranchesAtRoot(options, root);
  }));
  return { ...result, repositoryPath: root, ...(checkout ? { branchCheckout: {
    repositoryPath: checkout.repositoryPath, branch: checkout.branch, reused: checkout.reused, originalPreserved: true
  } } : {}) };
}

export async function runWorkspaceBranches(options = {}) {
  const result = await readWorkspaceBranches(options);
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
  const { renderWorkspaceBranches } = await import('./workspace-branches-service.mjs');
  return renderWorkspaceBranches(result);
}
