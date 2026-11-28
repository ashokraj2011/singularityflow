/**
 * The Story record's adapter into the kernel's version predicates (kernel/step-versions.mjs) [OSA:REQ-002], with the old
 * helpers as wrappers. Small, so the edit guard does not load the sequence graph; sequence.mjs re-exports it.
 */
import { sourceReviewAuthorConflict } from './source-review-policy.mjs';
import { beingWritten, hasOpenVersion, needsVersion, publishedVersionRecorded, versionNumbers } from './kernel/step-versions.mjs';

/** A step's opening with its provenance (§7.2, §14): the opening operation's record (`operation`), or an older build's local intent. */
export function openingFactsOf(phase) {
  const intent = phase?.generationIntent, pointer = phase?.versionOpening, id = pointer?.operationId;
  const own = id ? { operationId: id, fence: pointer.writer?.fence ?? null } : {};
  if (intent) return { status: intent.status, version: intent.generation, record: id && +pointer.version === +intent.generation ? 'operation' : 'legacy', ...own };
  return id && +pointer.version > +(phase.generation ?? 0) ? { status: 'open', version: pointer.version, record: 'operation', ...own } : null;
}

/** A step's version facts from its record. Null for no step. */
export function versionFactsOf(workflow, phase) {
  if (!phase) return null;
  const amendment = phase.skillAmendmentRevalidation;
  return { status: phase.status, versionRequired: phase.generationPolicy?.requirement !== 'none', published: phase.generation,
    recordedHighWatermark: phase.generationHighWatermark, ...reservation(phase), opening: openingFactsOf(phase),
    publicationRecorded: (phase.generationPublications ?? []).some(entry => Number(entry.generation) === Number(phase.generation) && entry.record?.path),
    rework: phase.reworkRevalidation ? { version: phase.reworkRevalidation.generation } : null,
    amendment: amendment?.state === 'affected' ? { baseline: amendment.generationAtAdoption } : null,
    rejection: phase.rejectedAt ? { rewritten: (workflow?.history ?? []).some(event => event.phase === phase.id && event.event === 'phase_generated' && event.at > phase.rejectedAt) } : null,
    authorConflict: sourceReviewAuthorConflict(workflow, phase),
    changeRequestOpen: (workflow?.changeRequests ?? []).some(request => request.status === 'open' && request.targetPhase === phase.id),
    intentAmendmentPending: Boolean(phase.intentAmendmentRevalidation && !phase.intentAmendmentRevalidation.revalidatedAt) };
}

/** The number the opening operation reserved, if any. */
const reservation = (phase) => (phase?.versionOpening?.highWatermark ?? null) === null ? {} : { reservedHighWatermark: phase.versionOpening.highWatermark };

/** The counters the one version arithmetic reads. */
export const counters = (phase) => phase ? { published: phase.generation, recordedHighWatermark: phase.generationHighWatermark,
  ...reservation(phase), opening: openingFactsOf(phase) } : null;

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
  ? versionNumbers(counters(phase)).next : Number(phase.generation ?? 0);

/**
 * Ask once (owner, 2026-11-28): a person who sent this step back already said its next version should be written, and why.
 * The send-back that reopened it, as SFlow uses it instead of asking "Start version N?": the open change request a person
 * made for it, or the one whose return reopened it with the steps after its target (the same moment), its reason in their
 * words; SFlow's own returns are not one. Null when a person undid an earlier such start of this step, which makes that
 * question theirs again, and otherwise. For every step, whatever its workflow.
 */
export function sentBackAnswer(workflow, phase) {
  if (!phase || workflow?.currentPhase !== phase.id || phase.status !== 'in_progress') return null;
  const requests = workflow.changeRequests ?? [];
  const reopenedAt = phase.reworkRevalidation?.invalidatedAt ?? null;
  const request = requests.findLast((entry) => entry?.status === 'open' && entry.targetPhase === phase.id)
    ?? (reopenedAt ? requests.findLast((entry) => entry?.requestedAt === reopenedAt && entry.status !== 'abandoned') : null);
  if (!request?.id || request.automatic || request.identityAssurance === 'automatic' || request.requestedBy?.automatic === true) return null;
  const settled = workflow.settledDecisions ?? [];
  const undone = new Set(settled.map((entry) => entry?.undoes).filter(Boolean));
  if (settled.some((entry) => entry?.kind === 'sent-back' && entry.phase === phase.id && undone.has(entry.id))) return null;
  const words = String(request.comment ?? '').replace(/\s+/gu, ' ').trim();
  return { changeRequest: request.id, from: { phase: request.sourcePhase ?? phase.id, version: Number(request.sourceGeneration ?? 0) },
    reason: words && words !== 'Changes requested.' ? words.slice(0, 600) : null };
}
