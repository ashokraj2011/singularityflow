import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { activeWorkspaceFile, readActiveWorkspaceContext, workspaceRegistryFile } from '../workspace-context.mjs';
import { readWorkspace, workspaceRepositoryPath } from '../workspace-manifest.mjs';
import { capabilityRepositories } from '../capability-branches.mjs';
import { prepareWorkspaceBranch } from '../workspace-branch-checkout.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

export async function run(positionals, options) {
  const active = await readActiveWorkspaceContext(activeWorkspaceFile(), workspaceRegistryFile(), { refresh: false });
  const workspacePath = positionals[2] ?? active?.workspacePath;
  if (!workspacePath) throw new SingularityFlowError('Select a workspace, or pass its directory to workspace prepare-branch.');
  const workspace = await readWorkspace(workspacePath);
  const selectedHere = active?.workspacePath && await realpath(active.workspacePath).catch(() => null) === await realpath(workspace.path);
  const repositoryId = optionString(options, 'repository') ?? (selectedHere ? active.repositoryId : null) ?? workspace.leadRepository;
  const repository = Object.hasOwn(workspace.repositories, repositoryId) ? workspace.repositories[repositoryId] : null;
  if (!repository) throw new SingularityFlowError('The selected repository is not in this workspace.');
  const expectedPath = optionString(options, 'repository-path');
  if (expectedPath) {
    const canonical = async (file) => realpath(file).catch(error => {
      if (error.code === 'ENOENT') return path.resolve(file);
      throw error;
    });
    const expected = await canonical(expectedPath);
    const original = await canonical(workspaceRepositoryPath(workspace, repository));
    // Intake may have opened in an old Story worktree, not the manifest's main checkout. Its
    // exact stored navigation cursor is a fence, never repository/remote authority. Do not open
    // the old Git objects just to prove where the UI launched this explicit recovery request.
    const selectedPaths = selectedHere && active.repositoryId === repositoryId
      ? await Promise.all([active.repositoryPath, active.checkoutPath].filter(Boolean).map(canonical)) : [];
    if (expected !== original && !selectedPaths.includes(expected)) {
      throw new SingularityFlowError('The intake repository changed. Reopen intake before downloading a branch.');
    }
  }
  const branch = optionString(options, 'from-branch');
  const ids = new Set([repositoryId]);
  for (const capability of repository.capabilities ?? []) {
    for (const required of capabilityRepositories(workspace, capability)) ids.add(required.id);
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
  try {
    const repositories = [];
    for (const id of ids) repositories.push(await prepareWorkspaceBranch(workspace, id, branch, { signal: controller.signal }));
    const selected = repositories.find(item => item.repositoryId === repositoryId);
    const result = { ...selected, repositories, workspacePath: workspace.path, originalPreserved: true };
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else console.log(`Fresh branch checkout: ${result.repositoryPath}\nOriginal repositories and unpublished work were preserved. Run Story readiness from the fresh checkout.`);
    return result;
  } finally { process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel); }
}
