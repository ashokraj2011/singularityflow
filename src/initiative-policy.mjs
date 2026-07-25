/** Effective policy for the Epic planning journey.
 *
 * Intake is deliberately non-blocking. The Jira Epic snapshot (or the local
 * Epic details) is enough to enter Requirements; source documents and the
 * narrative intake outputs are enrichment. This also keeps Epics created with
 * an older pinned resolution from being stranded with three required files.
 */
export function epicIntakeAllowsEmptyArtifacts(initiative, phaseId) {
  return initiative?.resolution?.profile === 'epic-planning' && phaseId === 'epic-intake';
}

export function initiativeOutputRequired(initiative, phaseId, definition) {
  if (epicIntakeAllowsEmptyArtifacts(initiative, phaseId)) return false;
  return definition?.required !== false;
}

export function initiativeCheckRequirement(initiative, phaseId, check) {
  if (epicIntakeAllowsEmptyArtifacts(initiative, phaseId)) return 'optional';
  return check?.requirement ?? 'must';
}
