/**
 * The Story record's adapter into the kernel's version predicates (kernel/step-versions.mjs) [OSA:REQ-002], with the old
 * helpers as wrappers. Small, so the edit guard does not load the sequence graph; sequence.mjs re-exports it.
 */
import { sourceReviewAuthorConflict } from './source-review-policy.mjs';
import { nextPhaseGeneration } from './phase-generation.mjs';
import { beingWritten, hasOpenVersion, needsVersion, publishedVersionRecorded } from './kernel/step-versions.mjs';

/** A step's version facts from its record. Null for no step. */
export function versionFactsOf(workflow, phase) {
  if (!phase) return null;
  const intent = phase.generationIntent, amendment = phase.skillAmendmentRevalidation;
  return { status: phase.status, versionRequired: phase.generationPolicy?.requirement !== 'none', published: phase.generation,
    recordedHighWatermark: phase.generationHighWatermark, opening: intent ? { status: intent.status, version: intent.generation } : null,
    publicationRecorded: (phase.generationPublications ?? []).some(entry => Number(entry.generation) === Number(phase.generation) && entry.record?.path),
    rework: phase.reworkRevalidation ? { version: phase.reworkRevalidation.generation } : null,
    amendment: amendment?.state === 'affected' ? { baseline: amendment.generationAtAdoption } : null,
    rejection: phase.rejectedAt ? { rewritten: (workflow?.history ?? []).some(event => event.phase === phase.id && event.event === 'phase_generated' && event.at > phase.rejectedAt) } : null,
    authorConflict: sourceReviewAuthorConflict(workflow, phase),
    changeRequestOpen: (workflow?.changeRequests ?? []).some(request => request.status === 'open' && request.targetPhase === phase.id),
    intentAmendmentPending: Boolean(phase.intentAmendmentRevalidation && !phase.intentAmendmentRevalidation.revalidatedAt) };
}

const counters = (phase) => phase ? { published: phase.generation, recordedHighWatermark: phase.generationHighWatermark,
  opening: phase.generationIntent ? { status: phase.generationIntent.status, version: phase.generationIntent.generation } : null } : null;

/** Its next version is open, at its one applicable number (kernel `hasOpenVersion`). */
export const successorGenerationOpen = (phase) => hasOpenVersion(counters(phase));

export const phaseNeedsGeneration = (workflow, phase) => needsVersion(versionFactsOf(workflow, phase));

/** Being written now (kernel `beingWritten`): the one answer the permission, entry, task and planners give [OSA:REQ-010]. */
export const stepBeingWritten = (workflow, phase) => beingWritten(versionFactsOf(workflow, phase));

/** Kernel `publishedVersionRecorded` (P-4). */
export const hasPublishedPhaseGeneration = (phase) => publishedVersionRecorded(phase ? { ...counters(phase),
  publicationRecorded: (phase.generationPublications ?? []).some(entry => Number(entry.generation) === Number(phase.generation) && entry.record?.path) } : null);

/** The next version is inspected exactly when it is being written: "may write" and "may edit" agree. */
export const requiresProspectivePhaseInspection = stepBeingWritten;

export const phaseInspectionGeneration = (workflow, phase) => stepBeingWritten(workflow, phase)
  ? nextPhaseGeneration(phase) : Number(phase.generation ?? 0);
