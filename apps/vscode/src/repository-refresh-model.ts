import path from 'node:path';
import { realpath } from 'node:fs/promises';
import {
  gitRepositoryComparisonKey, sameGitRepository
} from '../../../src/git-repository-identity.mjs';
import type { WorkspaceEntry, WorkspaceStatus } from './views/workspaces-model.ts';

/** One repository which a registered workspace can safely hand to a maintenance command. */
export interface RepositoryRefreshTarget {
  workspaceId: string | null;
  workspaceName: string;
  workspacePath: string | null;
  repositoryId: string;
  repositoryPath: string;
  repositoryUrl: string;
  repositoryState: string;
}

export interface WorkspaceRefreshObservation {
  workspace: WorkspaceEntry;
  status: WorkspaceStatus | null;
  error?: string | null;
}

export type RepositoryRefreshAction = 'refresh' | 'authority' | 'reinitialize' | 'factory-reset';

/** The only command routes which a reviewed repository-maintenance choice may invoke. */
export function repositoryRefreshCommand(
  action: RepositoryRefreshAction,
  target: RepositoryRefreshTarget
): { command: string; args: unknown[] } | null {
  if (action === 'refresh' || action === 'reinitialize') {
    if (!target.workspacePath || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(target.repositoryId)) return null;
    return {
      command: 'singularityFlow.openWorkspaces',
      args: [{
        upgradeScope: 'selected',
        workspacePath: target.workspacePath,
        repositoryId: target.repositoryId
      }]
    };
  }
  if (action === 'authority') {
    return { command: 'singularityFlow.refreshAuthorityPin', args: [target.repositoryPath] };
  }
  return { command: 'singularityFlow.factoryReset', args: [target.repositoryPath] };
}

/**
 * A comparison key, not a transport URL.
 *
 * Git commonly presents one repository as HTTPS in a workspace manifest and SCP-style SSH in a
 * checkout. Scheme and the ordinary SSH user are therefore not repository identity. Host, port,
 * and path remain significant, while a trailing `.git`/slash does not. Local paths are kept in a
 * separate namespace and Windows drive spelling is normalized without resolving or accessing it.
 */
export { gitRepositoryComparisonKey, sameGitRepository };

/** Resolve a URL only against explicit, already-registered workspace observations. */
export function repositoryRefreshTargets(
  repositoryUrl: string,
  observations: readonly WorkspaceRefreshObservation[]
): RepositoryRefreshTarget[] {
  const targets = new Map<string, RepositoryRefreshTarget>();
  for (const observation of observations) {
    if (!observation.status) continue;
    for (const repository of observation.status.repositories ?? []) {
      const candidateUrl = repository.url?.trim();
      const repositoryPath = (repository.absolutePath ?? repository.path ?? '').trim();
      if (!candidateUrl || !repositoryPath || !sameGitRepository(repositoryUrl, candidateUrl)) continue;
      const target: RepositoryRefreshTarget = {
        workspaceId: observation.status.workspace.id || observation.workspace.id,
        workspaceName: observation.status.workspace.name || observation.workspace.name,
        workspacePath: observation.status.workspace.path || observation.workspace.path,
        repositoryId: repository.id,
        repositoryPath,
        repositoryUrl: candidateUrl,
        repositoryState: repository.state ?? 'unknown'
      };
      targets.set(`${path.resolve(target.workspacePath!)}\0${path.resolve(target.repositoryPath)}`, target);
    }
  }
  return [...targets.values()].sort((left, right) =>
    left.workspaceName.localeCompare(right.workspaceName)
      || left.repositoryId.localeCompare(right.repositoryId));
}

/** Resolve an already-selected local repository without trusting an arbitrary command argument. */
export async function canonicalFilesystemPath(
  value: string,
  {
    platform = process.platform,
    canonicalize = realpath
  }: {
    platform?: NodeJS.Platform;
    canonicalize?: (candidate: string) => Promise<string>;
  } = {}
): Promise<string> {
  const pathApi = platform === 'win32' ? path.win32 : path;
  const resolved = pathApi.resolve(value);
  const canonical = await canonicalize(resolved).catch(() => resolved);
  // A missing checkout is exactly when reinitialization is needed. On Windows, keep that recovery
  // selectable across drive-letter/path casing even though `realpath` cannot prove the absent path.
  return platform === 'win32'
    ? path.win32.normalize(canonical).toLocaleLowerCase('en-US')
    : canonical;
}

export async function repositoryRefreshTargetForPath(
  repositoryPath: string,
  workspacePath: string | null,
  observations: readonly WorkspaceRefreshObservation[]
): Promise<RepositoryRefreshTarget | null> {
  const requestedRepository = await canonicalFilesystemPath(repositoryPath);
  const requestedWorkspace = workspacePath ? await canonicalFilesystemPath(workspacePath) : null;
  for (const observation of observations) {
    if (!observation.status) continue;
    if (requestedWorkspace
      && await canonicalFilesystemPath(observation.status.workspace.path) !== requestedWorkspace) continue;
    for (const repository of observation.status.repositories ?? []) {
      const candidatePath = (repository.absolutePath ?? repository.path ?? '').trim();
      if (!candidatePath
        || await canonicalFilesystemPath(candidatePath) !== requestedRepository) continue;
      return {
        workspaceId: observation.status.workspace.id || observation.workspace.id,
        workspaceName: observation.status.workspace.name || observation.workspace.name,
        workspacePath: observation.status.workspace.path || observation.workspace.path,
        repositoryId: repository.id,
        repositoryPath: candidatePath,
        repositoryUrl: repository.url?.trim() ?? '',
        repositoryState: repository.state ?? 'unknown'
      };
    }
  }
  return null;
}
