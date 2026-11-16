/** Pure inspection labels shared by authoring and read-only review. */
import { stepBeingWritten } from './phase-generation-need.mjs';
import { nextPhaseGeneration } from './phase-generation.mjs';

export function hasPublishedPhaseGeneration(phase) {
  const generation = Number(phase?.generation);
  if (!Number.isSafeInteger(generation) || generation < 1 || phase.generationIntent?.status === 'open') return false;
  return (phase.generationIntent?.status === 'consumed' && Number(phase.generationIntent.generation) === generation)
    || (phase.generationPublications ?? []).some(entry => Number(entry.generation) === generation && entry.record?.path);
}

/**
 * Whether the step's next version is the one to inspect: the step is being written (stepBeingWritten), the same test
 * as the edit permission's `editable`, so "may write" and "may edit" agree [OSA:REQ-010, C7]. It used to add "not
 * published", which differed only where nothing can be written: an open version at or below the published one, a
 * version with no publication record, and a sign-off step with no output.
 */
export function requiresProspectivePhaseInspection(workflow, phase) {
  return stepBeingWritten(workflow, phase);
}

export function phaseInspectionGeneration(workflow, phase) {
  return requiresProspectivePhaseInspection(workflow, phase)
    ? nextPhaseGeneration(phase) : Number(phase.generation ?? 0);
}
