import path from 'node:path';
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

export type RepositoryRefreshAction = 'refresh' | 'authority' | 'reinitialize';

/** The only command routes which a reviewed repository-maintenance choice may invoke. */
export function repositoryRefreshCommand(
  action: RepositoryRefreshAction,
  target: RepositoryRefreshTarget
): { command: string; args: unknown[] } | null {
  if (action === 'refresh') {
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
  return { command: 'singularityFlow.reinitialize', args: [target.repositoryPath] };
}

/**
 * A comparison key, not a transport URL.
 *
 * Git commonly presents one repository as HTTPS in a workspace manifest and SCP-style SSH in a
 * checkout. Scheme and the ordinary SSH user are therefore not repository identity. Host, port,
 * and path remain significant, while a trailing `.git`/slash does not. Local paths are kept in a
 * separate namespace and Windows drive spelling is normalized without resolving or accessing it.
 */
export function gitRepositoryComparisonKey(value: string): string | null {
  let remote = value.trim();
  if (!remote) return null;
  const windowsPath = /^[A-Za-z]:[\\/]/u.test(remote);
  if (windowsPath) {
    let local = path.win32.normalize(remote).replace(/\\/g, '/');
    local = `${local[0]!.toLowerCase()}${local.slice(1)}`;
    return `local:${local.replace(/\/+$/u, '').replace(/\.git$/iu, '')}`;
  }
  const uncPath = /^(?:\\\\|\/\/)([^\\/]+)[\\/](.+)$/u.exec(remote);
  if (uncPath) {
    const repositoryPath = uncPath[2]!.replace(/\\/g, '/')
      .replace(/\/+$/u, '').replace(/\.git$/iu, '');
    return repositoryPath ? `local-unc:${uncPath[1]!.toLowerCase()}/${repositoryPath}` : null;
  }
  const scp = remote.match(/^[^/@:\s]+@([^:\s]+):(.+)$/u);
  if (scp) remote = `ssh://${scp[1]}/${scp[2]}`;
  try {
    const parsed = new URL(remote);
    const sshProtocol = ['ssh:', 'git+ssh:', 'ssh+git:'].includes(parsed.protocol);
    if (parsed.search || parsed.hash || parsed.password || (parsed.username && !sshProtocol)) return null;
    if (parsed.protocol === 'file:') {
      let local = decodeURIComponent(parsed.pathname).replace(/\\/g, '/');
      // WHATWG file URLs spell a Windows drive as `/C:/...`; Git and VS Code also surface the
      // same checkout as `C:\\...`. Normalize only that syntactic leading slash and drive letter.
      // The remainder deliberately stays case-sensitive unless filesystem identity was proved.
      if (/^\/[A-Za-z]:\//u.test(local)) {
        local = `${local[1]!.toLowerCase()}${local.slice(2)}`;
      }
      if (parsed.hostname && parsed.hostname.toLowerCase() !== 'localhost') {
        const repositoryPath = local.replace(/^\/+|\/+$/gu, '').replace(/\.git$/iu, '');
        return repositoryPath
          ? `local-unc:${parsed.hostname.toLowerCase()}/${repositoryPath}` : null;
      }
      return `local:${local.replace(/\/+$/u, '').replace(/\.git$/iu, '')}`;
    }
    if (!parsed.hostname) return null;
    const defaultPort = (parsed.protocol === 'https:' && parsed.port === '443')
      || (parsed.protocol === 'http:' && parsed.port === '80')
      || (['ssh:', 'git+ssh:', 'ssh+git:'].includes(parsed.protocol) && parsed.port === '22');
    const port = parsed.port && !defaultPort ? `:${parsed.port}` : '';
    const repositoryPath = parsed.pathname.replace(/^\/+|\/+$/gu, '').replace(/\.git$/iu, '');
    if (!repositoryPath) return null;
    return `remote:${parsed.hostname.toLowerCase()}${port}/${repositoryPath}`;
  } catch {
    // Git accepts absolute local paths in addition to URLs. Do not turn relative, option-shaped,
    // or arbitrary text into an identity which could accidentally match a registered checkout.
    if (!path.isAbsolute(remote)) return null;
    const local = path.normalize(remote).replace(/\\/g, '/');
    return `local:${local.replace(/\/+$/u, '').replace(/\.git$/iu, '')}`;
  }
}

export function sameGitRepository(left: string, right: string): boolean {
  const leftKey = gitRepositoryComparisonKey(left);
  return Boolean(leftKey && leftKey === gitRepositoryComparisonKey(right));
}

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
export function repositoryRefreshTargetForPath(
  repositoryPath: string,
  workspacePath: string | null,
  observations: readonly WorkspaceRefreshObservation[]
): RepositoryRefreshTarget | null {
  const requestedRepository = path.resolve(repositoryPath);
  const requestedWorkspace = workspacePath ? path.resolve(workspacePath) : null;
  for (const observation of observations) {
    if (!observation.status) continue;
    if (requestedWorkspace && path.resolve(observation.status.workspace.path) !== requestedWorkspace) continue;
    for (const repository of observation.status.repositories ?? []) {
      const candidatePath = (repository.absolutePath ?? repository.path ?? '').trim();
      if (!candidatePath || path.resolve(candidatePath) !== requestedRepository) continue;
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
