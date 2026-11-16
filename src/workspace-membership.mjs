/** Physical clone/worktree membership; independent of a profile's last selected workspace. */
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { repositoryGitDirectory } from './git-directory.mjs';
import { readWorkspace, readWorkspaceRegistry, workspaceRepositoryPath } from './workspace-manifest.mjs';
import { workspaceBranchMember } from './workspace-branch-locations.mjs';
import { configuredRemoteIdentity } from './git-remote-diagnostics.mjs';
import { sameRepositoryResolved } from './git-repository-identity.mjs';
import { SingularityFlowError } from './util.mjs';

const canonical = file => realpath(file).catch(error => error.code === 'ENOENT' ? path.resolve(file) : Promise.reject(error));
const same = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
export async function findWorkspaceMembership(root, { identity = null, workspacePath = null,
  registryFile = process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY ?? path.join(os.homedir(), '.singularity-flow', 'workspaces.json') } = {}) {
  const actual = await canonical(root);
  const common = await canonical(identity?.commonDir ?? repositoryGitDirectory(actual) ?? actual);
  const entries = workspacePath ? [{ path: workspacePath }]
    : (await readWorkspaceRegistry(registryFile)).filter(entry => !entry.archivedAt);
  const found = [];
  for (const entry of entries) {
    let workspace;
    try { workspace = await readWorkspace(entry.path); }
    catch (error) {
      const relative = path.relative(path.resolve(entry.path), actual);
      if (workspacePath || relative === '' || !relative.startsWith('..') && !path.isAbsolute(relative)) throw error;
      continue;
    }
    const branchMember = await workspaceBranchMember(common, workspace);
    for (const [id, repository] of Object.entries(workspace.repositories)) {
      const original = await canonical(workspaceRepositoryPath(workspace, repository));
      const originalCommon = repositoryGitDirectory(original);
      if (!(same(original, actual) || originalCommon && same(await canonical(originalCommon), common)
          || branchMember?.repositoryId === id)) continue;
      // One repository key (SCF:REQ-019): https or ssh, with or without `.git`, is the same repository.
      const origin = configuredRemoteIdentity(actual, 'origin', { direction: 'fetch' }).url;
      if (!origin || !await sameRepositoryResolved(origin, repository.url)) throw await originMismatch(actual, id, repository.url, origin);
      const context = { workspaceId: workspace.id, workspaceName: workspace.name, workspacePath: workspace.path,
        anchorKey: workspace.anchor.key, capabilities: [...(workspace.capabilities ?? [])],
        repositoryId: id, repositoryPath: actual, checkoutPath: actual,
        canonicalRepositoryPath: branchMember?.repositoryPath ?? original,
        repositoryState: 'ready', repositoryCapabilities: repository.capabilities ?? [],
        workspaceManifestSha256: `sha256:${createHash('sha256').update(JSON.stringify(workspace)).digest('hex')}`,
        ...(branchMember ? { branchCheckout: { branch: branchMember.record.branch, repositoryPath: branchMember.repositoryPath } } : {}) };
      Object.defineProperty(context, 'workspace', { value: freeze(structuredClone(workspace)), enumerable: false });
      found.push(context);
    }
  }
  if (found.length > 1) throw new SingularityFlowError('This clone belongs to multiple workspace registrations. Select an exact workspace.', {
    code: 'EXECUTION_CONTEXT_WORKSPACE_AMBIGUOUS', details: { workspaces: found.map(entry => entry.workspacePath) }
  });
  return found[0] ?? null;
}

/**
 * The refusal for a clone whose `origin` names another repository than its workspace records: both remotes, and the
 * command that points `origin` back (WS-6). Shared with workspace-context.mjs.
 */
export async function originMismatch(checkout, repositoryId, expected, actual) {
  const { sanitizeRemote } = await import('./git-remote-diagnostics.mjs');
  const [recorded, found] = [sanitizeRemote(expected), actual ? sanitizeRemote(actual) : null];
  const command = `git -C ${JSON.stringify(checkout)} remote set-url origin ${JSON.stringify(recorded)}`;
  return new SingularityFlowError(`The clone of '${repositoryId}' at ${checkout} pulls from ${found ?? 'no origin'}, but its workspace records `
    + `${recorded}. If that is another spelling of the same repository, set origin back to the recorded one.`, {
    code: 'WORKSPACE_REPOSITORY_IDENTITY_MISMATCH',
    details: { repositoryId, checkoutPath: checkout, expectedRemote: recorded, actualRemote: found,
      nextAction: { command, label: 'Point origin back at the repository its workspace records' } }
  });
}
