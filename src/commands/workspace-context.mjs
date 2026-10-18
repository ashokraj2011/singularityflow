import { captureExecutionContext, boundExecutionContextRoot, findWorkspaceMembership } from '../execution-context.mjs';
import { workspaceCheckoutInventory, planWorkspaceCheckoutCleanup, applyWorkspaceCheckoutCleanup } from '../workspace-checkout-inventory.mjs';
import { readActiveWorkspaceContext, activeWorkspaceFile, workspaceRegistryFile, buildWorkspaceContext } from '../workspace-context.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';
import { repoRoot } from '../git.mjs';
import path from 'node:path';
import { readWorkspace, workspaceRepositoryPath } from '../workspace-manifest.mjs';

export async function run(positionals, options) {
  const action = positionals[1];
  const reference = positionals[2] ?? optionString(options, 'workspace');
  if (action === 'context' && !reference) return console.log(JSON.stringify(await captureExecutionContext(
    boundExecutionContextRoot() ?? repoRoot(process.cwd()), { fresh: true }), null, 2));
  const manifest = reference && path.isAbsolute(reference) ? await readWorkspace(reference) : null;
  const repositoryId = optionString(options, 'repository') ?? manifest?.leadRepository;
  if (manifest && !manifest.repositories[repositoryId]) throw new SingularityFlowError(
    `Repository '${repositoryId}' is not part of workspace '${manifest.name}'.`, { code: 'ACTIVE_WORKSPACE_REPOSITORY_REMOVED' });
  const selected = manifest ? { workspacePath: manifest.path,
    repositoryPath: workspaceRepositoryPath(manifest, manifest.repositories[repositoryId]) }
    : reference ? await buildWorkspaceContext(workspaceRegistryFile(), reference, {
    repositoryId: optionString(options, 'repository'), detectStory: false
  }) : boundExecutionContextRoot() ? await findWorkspaceMembership(boundExecutionContextRoot())
    : await readActiveWorkspaceContext(activeWorkspaceFile(), workspaceRegistryFile(), { refresh: false });
  if (action === 'context') {
    const root = reference ? selected?.repositoryPath : boundExecutionContextRoot() ?? repoRoot(process.cwd());
    const member = await findWorkspaceMembership(root, { workspacePath: selected?.workspacePath });
    return console.log(JSON.stringify(await captureExecutionContext(root, { workspace: member, fresh: true }), null, 2));
  }
  if (!selected?.workspacePath) throw new SingularityFlowError('Select a workspace or pass its directory.', { code: 'WORKSPACE_SELECTION_REQUIRED' });
  const result = action === 'checkouts' ? await workspaceCheckoutInventory(selected.workspacePath)
    : optionBoolean(options, 'apply') ? await applyWorkspaceCheckoutCleanup(selected.workspacePath, optionString(options, 'confirm'), { purge: optionBoolean(options, 'purge') })
    : await planWorkspaceCheckoutCleanup(selected.workspacePath, { purge: optionBoolean(options, 'purge') });
  console.log(JSON.stringify(result, null, 2));
  return result;
}
