import { evaluateProtectedPaths } from './repository-change-set.mjs';

function configurationFiles(subject) {
  return subject?.resolution?.configurationSource?.files
    ?? subject?.configurationSource?.files
    ?? subject?.files
    ?? {};
}

function configurationAssets(subject) {
  const source = subject?.resolution?.configurationSource
    ?? subject?.configurationSource
    ?? subject
    ?? {};
  return source.assets ?? Object.fromEntries(Object.entries(configurationFiles(subject))
    .map(([relative, sha256]) => [relative, { sha256, object: null, mode: null }]));
}

function configurationRemovals(subject) {
  return subject?.resolution?.configurationSource?.removed
    ?? subject?.configurationSource?.removed
    ?? subject?.removed
    ?? {};
}

/**
 * Return configuration paths whose current change-set bytes exactly match the immutable
 * configuration snapshot selected when the Story started.
 *
 * These files are Story input projected from `sflow/config`, not application output. The match is
 * intentionally fail-closed: deletions, renames, symlinks, missing digests, and byte changes are
 * never accepted as approved materialization.
 */
export function approvedConfigurationMaterializations(changeSet, workflowOrConfigurationSource) {
  const pinned = configurationAssets(workflowOrConfigurationSource);
  const removals = configurationRemovals(workflowOrConfigurationSource);
  return new Set((changeSet?.entries ?? []).flatMap((entry) => {
    const accepted = [];
    const expected = entry.newPath ? pinned[entry.newPath] : null;
    const expectedSha256 = expected?.sha256 ?? expected;
    const modeMatches = !expected?.mode || entry.newMode === expected.mode;
    const objectMatches = Boolean(expected?.object && entry.newObject === expected.object);
    const bytesMatch = entry.newContent?.kind === 'regular-file'
      && entry.newContent.sha256 === `sha256:${expectedSha256}`;
    if (expected && modeMatches && (objectMatches || bytesMatch)) accepted.push(entry.newPath);
    const removed = entry.oldPath ? removals[entry.oldPath] : null;
    if (removed && entry.oldObject === removed.object && entry.oldMode === removed.mode) {
      accepted.push(entry.oldPath);
    }
    return accepted;
  }));
}

/** Apply protected-path policy while classifying exact Story configuration projection as input. */
export function evaluateStoryProtectedPaths(changeSet, guards, workflowOrConfigurationSource) {
  const evaluated = evaluateProtectedPaths(changeSet, guards);
  const approvedMaterializations = approvedConfigurationMaterializations(
    changeSet, workflowOrConfigurationSource
  );
  const acceptedProtectedPaths = new Set();
  const violations = evaluated.violations.filter((violation) => {
    if (!approvedMaterializations.has(violation.path)) return true;
    acceptedProtectedPaths.add(violation.path);
    return false;
  });
  return {
    valid: violations.length === 0,
    violations,
    approvedMaterializations,
    acceptedProtectedPaths
  };
}
