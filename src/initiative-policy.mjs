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

/**
 * Whether this Epic must produce an output before its phase can advance.
 *
 * Profiles describe a delivery model, not one Epic. A phase that pins a business case, an
 * opportunity brief and a product roadmap is right for some work and ceremony for the rest, and
 * with no way to say so every Epic carried all of it. An Epic may therefore record which of its
 * phase's optional outputs it will actually produce; that selection, once made, is authoritative
 * for the phase. Outputs the profile marks required are always in it — the selection cannot drop
 * them — so an Epic can narrow ceremony but never governance.
 *
 * Every gate, report, next-action and context builder asks this one question, so a selection made
 * here is honoured everywhere without any of them knowing it exists.
 */
export function initiativeOutputRequired(initiative, phaseId, definition) {
  if (epicIntakeAllowsEmptyArtifacts(initiative, phaseId)) return false;
  const included = initiative?.phases?.[phaseId]?.outputSelection?.included;
  if (Array.isArray(included)) return included.includes(definition?.id);
  return definition?.required !== false;
}

export function initiativeCheckRequirement(initiative, phaseId, check) {
  if (epicIntakeAllowsEmptyArtifacts(initiative, phaseId)) return 'optional';
  return check?.requirement ?? 'must';
}
