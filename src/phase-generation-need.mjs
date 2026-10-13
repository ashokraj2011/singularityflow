/**
 * Whether a phase needs a new generation before it can move on.
 *
 * Its own small module so the Copilot edit guard, which loads the phase mutation contract on every
 * tool call, does not load the sequence and narration graph (about 80 modules) for this one
 * predicate. sequence.mjs re-exports it unchanged.
 */
import { sourceReviewAuthorConflict } from './source-review-policy.mjs';

export function phaseNeedsGeneration(workflow, phase) {
  if (sourceReviewAuthorConflict(workflow, phase)) return true;
  // A reviewed skill-version amendment invalidates only its affected phases. Their earlier
  // publication remains in the audit trail but is not fresh evidence under the new WFA pin.
  const amendment = phase?.skillAmendmentRevalidation;
  if (amendment?.state === 'affected') {
    const baseline = amendment.generationAtAdoption;
    if (!Number.isSafeInteger(baseline) || baseline < 0
        || !Number.isSafeInteger(phase.generation) || phase.generation <= baseline) return true;
  }
  if (phase?.generationPolicy?.requirement === 'none') return false;
  if (!phase || phase.generation < 1) return true;
  if (phase.reworkRevalidation
      && phase.generation <= phase.reworkRevalidation.generation) return true;
  if (!phase.rejectedAt) return false;
  return !(workflow.history ?? []).some((event) =>
    event.phase === phase.id && event.event === 'phase_generated' && event.at > phase.rejectedAt);
}
