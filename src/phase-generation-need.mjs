/**
 * Whether a phase needs a new generation before it can move on.
 *
 * Its own small module so the Copilot edit guard, which loads the phase mutation contract on every
 * tool call, does not load the sequence and narration graph (about 80 modules) for this one
 * predicate. sequence.mjs re-exports it unchanged.
 */
import { sourceReviewAuthorConflict } from './source-review-policy.mjs';

/**
 * Whether the step's next version is open: confirmed and being written, not yet published. Its published version's
 * review asked for it and is already carried into it, so that review is not inspected or offered again.
 */
export function successorGenerationOpen(phase) {
  const intent = phase?.generationIntent;
  return intent?.status === 'open' && Number.isSafeInteger(Number(intent.generation))
    && Number(intent.generation) > Number(phase.generation ?? 0);
}

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

/**
 * Whether the step is being written now: in progress, and it needs a version or its next version is open [OSA:REQ-002,
 * Stage 1]. The one answer the edit permission, the step's entry, its authoring task, the review continuation,
 * submission readiness, the sequence guidance and next steps give. Six tests disagreed about an open version 2: one
 * said "write it", another "review version 1" or "ready to submit", and the agent went round them [real Story, 2026-11-16].
 */
export function stepBeingWritten(workflow, phase) {
  return phase?.status === 'in_progress' && (phaseNeedsGeneration(workflow, phase) || successorGenerationOpen(phase));
}
