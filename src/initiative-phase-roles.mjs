import { SingularityFlowError } from './util.mjs';

export const EPIC_PHASES = Object.freeze({
  intake: 'epic-intake', requirements: 'epic-requirements',
  planning: 'epic-planning', publish: 'epic-publish'
});

function hasContract(phase, outputs, check) {
  return Boolean(outputs.every((id) => phase?.outputs?.some((output) => output.id === id))
    && phase?.checklist?.some((entry) => entry.id === check));
}

/** Epic capabilities follow their pinned output/check contracts, not a copied profile's name. */
export function isEpicPlanningPhase(phase) {
  return hasContract(phase, ['story-specification-index'], 'story-specifications-complete');
}

export function isEpicRequirementsPhase(phase) {
  return hasContract(phase, ['requirements-specification', 'requirements-traceability'], 'requirements-traceable');
}

export function usesEpicPlanningLifecycle(resolution) {
  return Boolean(resolution?.phases?.some(isEpicPlanningPhase));
}

/** The deterministic Epic services still use canonical storage/transition IDs. Refuse a
 * partial or renamed lifecycle before creating state, and diagnose older pins without mutating them. */
export function assertEpicPlanningTopology(resolution) {
  const phases = resolution?.phases ?? [];
  const roles = {
    intake: (phase) => hasContract(phase, ['source-catalog'], 'sources-pinned'),
    requirements: isEpicRequirementsPhase,
    planning: isEpicPlanningPhase,
    publish: (phase) => hasContract(phase, ['jira-write-plan', 'materialization-report'], 'stories-materialized')
  };
  if (!phases.some((phase) => Object.values(roles).some((matches) => matches(phase)))) return;
  for (const [role, matches] of Object.entries(roles)) {
    const renamed = phases.find((phase) => matches(phase) && phase.id !== EPIC_PHASES[role]);
    if (renamed) throw new SingularityFlowError(
      `Epic producer step '${renamed.id}' requires the canonical Epic step ID '${EPIC_PHASES[role]}'. Copy the profile with its shared steps instead of renaming the producer.`,
      { code: 'INITIATIVE_EPIC_PRODUCER_ID_UNSUPPORTED', details: { profile: resolution.id, phase: renamed.id } }
    );
  }
  const canonical = Object.values(EPIC_PHASES);
  if (phases.length !== canonical.length || phases.some((phase, index) =>
    phase.id !== canonical[index] || !roles[Object.keys(EPIC_PHASES)[index]](phase))) {
    throw new SingularityFlowError(
      `Epic planning requires the complete ordered lifecycle: ${canonical.join(' → ')}. Repair the profile before starting a new Epic; an existing pinned Epic must not be rewritten.`,
      { code: 'INITIATIVE_EPIC_TOPOLOGY_UNSUPPORTED', details: { profile: resolution.id, phases: phases.map((phase) => phase.id) } }
    );
  }
}

export const EPIC_TRACEABILITY_CHECKS = Object.freeze([
  'requirements-traceable', 'stories-traceable', 'repositories-resolved', 'dependencies-acyclic',
  'story-specifications-complete', 'acceptance-criteria-covered'
]);
