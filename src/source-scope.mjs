import { worldModelSourceScope, normalizeSourceRoots } from "./engine-compatibility/node-configuration-path.mjs";
export { normalizeSourceRoots, worldModelSourceScope } from "./engine-compatibility/node-configuration-path.mjs";
import path from 'node:path';

import { posix } from './util.mjs';
import { sourcePathPolicy, isSeparatelyHashedTestInput } from "./kernel/configuration-path-policies.mjs";

/** True when a repository-relative path belongs to the configured world-model source scope. */
export function sourcePathIncluded(file, definition = {}) {
  const relative = posix(String(file ?? '')).replace(/^\.\//, '');
  const scope = worldModelSourceScope(definition);
  return (scope.all || scope.paths.some((root) => relative === root || relative.startsWith(`${root}/`)))
    && (!isSeparatelyHashedTestInput(relative, scope) || scope.testConfigurationPaths.includes(relative));
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
      sharedRoots: normalizeSourceRoots(scope.sharedRoots, 'Capability sharedRoots'),
      ...(scope.sourceHashExcludedRoots != null || scope.testConfigurationPaths != null
        ? sourcePathPolicy(scope) : {})
    }
  };
}
