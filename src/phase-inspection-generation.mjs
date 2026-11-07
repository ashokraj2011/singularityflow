/** Pure inspection labels shared by authoring and read-only review. */
import { phaseNeedsGeneration } from './phase-generation-need.mjs';
import { nextPhaseGeneration } from './kernel/phase-policy.mjs';

export function hasPublishedPhaseGeneration(phase) {
  const generation = Number(phase?.generation);
  if (!Number.isSafeInteger(generation) || generation < 1 || phase.generationIntent?.status === 'open') return false;
  return (phase.generationIntent?.status === 'consumed' && Number(phase.generationIntent.generation) === generation)
    || (phase.generationPublications ?? []).some(entry => Number(entry.generation) === generation && entry.record?.path);
}

export function requiresProspectivePhaseInspection(workflow, phase) {
  return phase.status === 'in_progress'
    && (!hasPublishedPhaseGeneration(phase) || phaseNeedsGeneration(workflow, phase));
}

export function phaseInspectionGeneration(workflow, phase) {
  return requiresProspectivePhaseInspection(workflow, phase)
    ? nextPhaseGeneration(phase) : Number(phase.generation ?? 0);
}
