import path from 'node:path';

import { posix, SingularityFlowError } from './util.mjs';

/**
 * A source scope is deliberately a set of directory prefixes, not glob expressions.
 *
 * Prefixes give Git, sparse checkout, the world-model scanner, and the deterministic facts builder
 * one meaning to share. Supporting a different pattern language at each layer would make a file
 * visible to one of them and invisible to another, which is exactly the kind of partial world model
 * that is dangerous in a monorepo.
 */
export function normalizeSourceRoots(value, label = 'Source roots') {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new SingularityFlowError(`${label} must be an array of repository-relative directories.`);
  const roots = [];
  for (const raw of value) {
    if (typeof raw !== 'string' || !raw.trim()) throw new SingularityFlowError(`${label} must contain non-empty paths.`);
    if (raw.includes('\\')) throw new SingularityFlowError(`${label} entry '${raw}' must use forward slashes.`);
    const normalized = posix(raw.trim()).replace(/^\.\//, '').replace(/\/$/, '');
    if (!normalized || normalized === '.' || path.posix.isAbsolute(normalized)
      || normalized.split('/').includes('..') || /[*?\[\]{}]/.test(normalized)) {
      throw new SingularityFlowError(`${label} entry '${raw}' must be a repository-relative directory without '..' or glob characters.`);
    }
    if (!roots.includes(normalized)) roots.push(normalized);
  }
  return roots.sort();
}

/** The normalized scope declared by either a workflow definition or a worldModel object. */
export function worldModelSourceScope(definition = {}) {
  const configured = definition.worldModel ?? definition;
  const sourceRoots = normalizeSourceRoots(configured?.sourceRoots, 'worldModel.sourceRoots');
  const sharedRoots = normalizeSourceRoots(configured?.sharedRoots, 'worldModel.sharedRoots');
  const paths = [...new Set([...sourceRoots, ...sharedRoots])].sort();
  return Object.freeze({
    sourceRoots: Object.freeze(sourceRoots),
    sharedRoots: Object.freeze(sharedRoots),
    paths: Object.freeze(paths),
    all: paths.length === 0
  });
}

/** True when a repository-relative path belongs to the configured world-model source scope. */
export function sourcePathIncluded(file, definition = {}) {
  const relative = posix(String(file ?? '')).replace(/^\.\//, '');
  const scope = worldModelSourceScope(definition);
  return scope.all || scope.paths.some((root) => relative === root || relative.startsWith(`${root}/`));
}

/**
 * Pin a capability's source scope into the effective definition used by a Story or Initiative.
 * A null scope leaves the repository-wide definition unchanged.
 */
export function withWorldModelSourceScope(definition, scope = null) {
  if (!scope) return definition;
  return {
    ...definition,
    worldModel: {
      ...(definition.worldModel ?? {}),
      sourceRoots: normalizeSourceRoots(scope.sourceRoots, 'Capability sourceRoots'),
      sharedRoots: normalizeSourceRoots(scope.sharedRoots, 'Capability sharedRoots')
    }
  };
}
