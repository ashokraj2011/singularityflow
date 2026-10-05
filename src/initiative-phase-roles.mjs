/** Epic capabilities follow their pinned output/check contracts, not a copied profile's name. */
export function isEpicPlanningPhase(phase) {
  return Boolean(phase?.outputs?.some((output) => output.id === 'story-specification-index')
    && phase?.checklist?.some((check) => check.id === 'story-specifications-complete'));
}

export function isEpicRequirementsPhase(phase) {
  return Boolean(phase?.outputs?.some((output) => output.id === 'requirements')
    && phase?.checklist?.some((check) => check.id === 'requirements-traceable'));
}

export function usesEpicPlanningLifecycle(resolution) {
  return Boolean(resolution?.phases?.some(isEpicPlanningPhase));
}

export const EPIC_TRACEABILITY_CHECKS = Object.freeze([
  'requirements-traceable', 'stories-traceable', 'repositories-resolved', 'dependencies-acyclic',
  'story-specifications-complete', 'acceptance-criteria-covered'
]);
