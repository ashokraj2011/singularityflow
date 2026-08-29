/**
 * Projection-only bridge from the existing Story aggregate into SGOS terminology.
 *
 * It intentionally does not create a gvm-process or Task Receipt. Existing phase completion is
 * observed authority, not re-labelled as GVM success. This is the strangler boundary that lets the
 * new Command Center describe current Stories without becoming a second lifecycle kernel.
 */
import { recordSha256 } from '../records.mjs';
import { SingularityFlowError } from '../util.mjs';

function clone(value) {
  return structuredClone(value);
}

function compatibilityState(phase) {
  const status = String(phase?.status ?? 'unknown').toLowerCase();
  if (phase?.awaitingApproval === true || status === 'awaiting_approval' || status === 'awaiting-approval') return 'awaiting-human';
  if (['approved', 'completed', 'complete'].includes(status)) return 'authoritative-completion-observed';
  if (['in_progress', 'in-progress', 'active', 'generating'].includes(status)) return 'active';
  if (['rejected', 'failed'].includes(status)) return 'returned-by-authority';
  if (['blocked', 'recovery-required'].includes(status)) return 'blocked';
  if (['pending', 'not_started', 'not-started'].includes(status)) return 'pending';
  return 'unknown';
}

export function projectStoryForSgos(story) {
  if (!story?.workItem?.id || !Array.isArray(story.phaseOrder) || !story.phases || typeof story.phases !== 'object') {
    throw new SingularityFlowError('SGOS Story compatibility requires an exact Story aggregate.', {
      code: 'SGOS_STORY_SOURCE_INVALID'
    });
  }
  const phases = story.phaseOrder.map((phaseId, order) => {
    const phase = story.phases[phaseId] ?? {};
    return {
      phaseId,
      order,
      sourceStatus: phase.status ?? 'unknown',
      compatibilityState: compatibilityState(phase),
      generation: Number.isInteger(phase.generation) ? phase.generation : null,
      artifactSha256: phase.artifact?.sha256 ?? phase.requiredArtifact?.sha256 ?? null,
      approvals: Array.isArray(phase.approvals) ? phase.approvals.length : 0,
      // This operation is descriptive. It can never be dispatched by the sequential GVM.
      delegatedOperation: 'story.phase.observe'
    };
  });
  const core = {
    projectionVersion: 1,
    kind: 'sgos-story-compatibility-projection',
    authority: 'existing-story-lifecycle',
    workId: story.workItem.id,
    branch: story.workItem.branch ?? null,
    workflowType: story.workItem.workType ?? story.resolution?.workflowId ?? null,
    sourceStatus: story.status ?? null,
    currentPhase: story.currentPhase ?? null,
    phases,
    guarantees: {
      projectionOnly: true,
      storyWorkflowRemainsAuthority: true,
      phaseCompletionIsNotGvmTaskSuccess: true,
      noReceiptsInvented: true
    }
  };
  return Object.freeze({ ...clone(core), projectionSha256: `sha256:${recordSha256(core)}` });
}
