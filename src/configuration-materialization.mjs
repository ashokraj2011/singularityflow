import { evaluateProtectedPaths } from './repository-change-set.mjs';

function configurationFiles(subject) {
  return subject?.resolution?.configurationSource?.files
    ?? subject?.configurationSource?.files
    ?? subject?.files
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
  const pinned = configurationFiles(workflowOrConfigurationSource);
  return new Set((changeSet?.entries ?? []).flatMap((entry) => {
    const expected = entry.newPath ? pinned[entry.newPath] : null;
    return expected
      && entry.newContent?.kind === 'regular-file'
      && entry.newContent.sha256 === `sha256:${expected}`
      ? [entry.newPath]
      : [];
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
