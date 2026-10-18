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

/**
 * Resolve an already-selected local repository without trusting an arbitrary command argument.
 * On Windows the result is a lowercased comparison key, never a path to open.
 */
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

/**
 * Local checkouts to inspect, one per filesystem identity. The identity key only compares: on
 * Windows it is lowercased, which can name another folder (a case-sensitive directory) or none
 * (`İ` lowercases to two characters). So each entry keeps the spelling it was added with, for the
 * filesystem and Git to open.
 */
export function repositoryCandidates<Owner>(
  options: Parameters<typeof canonicalFilesystemPath>[1] = {}
): {
  readonly entries: ReadonlyMap<string, { path: string; owner: Owner }>;
  /** Adds or replaces a checkout and returns its identity key; `keep` leaves an existing entry. */
  add(candidatePath: string, owner: Owner, keep?: boolean): Promise<string>;
} {
  const entries = new Map<string, { path: string; owner: Owner }>();
  return {
    entries,
    async add(candidatePath, owner, keep = false) {
      const key = await canonicalFilesystemPath(candidatePath, options);
      if (!keep || !entries.has(key)) entries.set(key, { path: candidatePath, owner });
      return key;
    }
  };
}

/**
 * The entries that name `target`, an already canonical path, through any of their paths. Intake
 * and Copilot hand over canonical checkouts, while the registry or a window can name the same
 * directory through a symlink: the macOS /var → /private/var temporary root, or a linked folder.
 */
export async function entriesAtCanonicalPath<T>(
  entries: readonly T[],
  target: string,
  pathsOf: (entry: T) => readonly (string | null | undefined)[]
): Promise<T[]> {
  const matches = await Promise.all(entries.map(async (entry) => {
    for (const candidate of pathsOf(entry)) {
      if (candidate && await canonicalFilesystemPath(candidate) === target) return true;
    }
    return false;
  }));
  return entries.filter((_entry, index) => matches[index]);
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
