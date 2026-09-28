import path from 'node:path';
import { portableFilesystemPathIdentity } from './configuration-assets.mjs';
import { isPortableRepositoryPathComponent, SingularityFlowError } from './util.mjs';

function repositoryPath(id, repository) {
  return repository?.path ?? `repos/${id}`;
}

function portablePath(value) {
  return typeof value === 'string'
    && value.startsWith('repos/')
    && value === path.posix.normalize(value)
    && value.split('/').every((component) => isPortableRepositoryPathComponent(component));
}

function pathIdentity(value) {
  // Older manifests may contain redundant separators or dot components. Normalize their spelling
  // for collision checks without changing what readWorkspace returns to existing callers.
  const canonical = path.posix.normalize(String(value).replaceAll('\\', '/'));
  return portableFilesystemPathIdentity(canonical.replace(/\/+$/u, ''));
}

function overlappingIdentity(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function pathError(id, value) {
  return new SingularityFlowError(
    `Workspace repository '${id}' path '${value}' must be a canonical portable path below repos/; Windows reserved names and filesystem aliases are not allowed.`,
    { code: 'WORKSPACE_REPOSITORY_PATH_NONPORTABLE', details: { repository: id, path: value } }
  );
}

function collisionError(id, value, otherId, otherValue) {
  return new SingularityFlowError(
    `Workspace repositories '${id}' and '${otherId}' have overlapping paths '${value}' and '${otherValue}' on Windows or a case-insensitive filesystem.`,
    {
      code: 'WORKSPACE_REPOSITORY_PATH_ALIAS',
      details: { repository: id, path: value, conflictingRepository: otherId, conflictingPath: otherValue }
    }
  );
}

/** Diagnose legacy owned checkout paths without making their saved manifest unreadable. */
export function workspaceRepositoryPathAliases(repositories) {
  const entries = Object.entries(repositories)
    .filter(([, repository]) => !repository.adoption)
    .map(([id, repository]) => ({
      id,
      value: repositoryPath(id, repository),
      identity: pathIdentity(repositoryPath(id, repository))
    }));
  const aliases = new Map();
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const first = entries[left];
      const second = entries[right];
      if (!overlappingIdentity(first.identity, second.identity)) continue;
      if (!aliases.has(first.id)) {
        aliases.set(first.id, collisionError(first.id, first.value, second.id, second.value));
      }
      if (!aliases.has(second.id)) {
        aliases.set(second.id, collisionError(second.id, second.value, first.id, first.value));
      }
    }
  }
  return aliases;
}

/**
 * New or changed checkout locations must be portable. Existing locations are grandfathered so
 * saved workspaces remain readable and can be renamed without rewriting their checkout layout.
 */
export function assertProposedWorkspaceRepositoryPaths(repositories, { previous = null } = {}) {
  const entries = Object.entries(repositories).map(([id, repository]) => ({
    id,
    value: repositoryPath(id, repository),
    previous: previous?.repositories?.[id]?.path
  }));
  for (const entry of entries) {
    if (entry.value === entry.previous) continue;
    if (!portablePath(entry.value)) throw pathError(entry.id, entry.value);
    const identity = pathIdentity(entry.value);
    for (const other of entries) {
      if (other.id === entry.id) continue;
      if (overlappingIdentity(identity, pathIdentity(other.value))) {
        throw collisionError(entry.id, entry.value, other.id, other.value);
      }
    }
  }
}

/** Refuse a clone into a legacy checkout path when another entry may resolve to the same tree. */
export function assertWorkspaceRepositoryMaterializationPaths(repositories, repositoryIds) {
  const entries = Object.entries(repositories)
    .filter(([, repository]) => !repository.adoption)
    .map(([id, repository]) => ({
      id,
      value: repositoryPath(id, repository),
      identity: pathIdentity(repositoryPath(id, repository))
    }));
  const selected = new Set(repositoryIds);
  for (const entry of entries) {
    if (!selected.has(entry.id)) continue;
    if (!portablePath(entry.value)) throw pathError(entry.id, entry.value);
    for (const other of entries) {
      if (other.id === entry.id) continue;
      if (overlappingIdentity(entry.identity, other.identity)) {
        throw collisionError(entry.id, entry.value, other.id, other.value);
      }
    }
  }
}
