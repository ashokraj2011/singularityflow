import { SingularityFlowError } from './util.mjs';

/** A pinned, opt-in gate. Older Story resolutions without this field stay unchanged. */
/**
 * `reviewable(phaseId)`, when given, says whether a step defines the scope or plans the claims; the
 * policy is read from the step's structure, never its name [E2G-001].
 */
export function normalizeSourceReviewPolicy(value = null, { workTypeId = 'workflow', phases = [], reviewable = null } = {}) {
  if (value == null) return { mode: 'off', phases: [], reviewerAgent: null };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError(`Work type '${workTypeId}' sourceReview must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (!['mode', 'phases', 'reviewerAgent'].includes(key)) {
      throw new SingularityFlowError(`Work type '${workTypeId}' sourceReview has unknown field '${key}'.`);
    }
  }
  const mode = value.mode ?? 'off';
  if (!['off', 'enforce'].includes(mode)) {
    throw new SingularityFlowError(`Work type '${workTypeId}' sourceReview.mode must be off or enforce.`);
  }
  const selected = value.phases ?? [];
  if (!Array.isArray(selected) || new Set(selected).size !== selected.length
      || selected.some((phase) => !phases.includes(phase) || (reviewable && !reviewable(phase)))) {
    throw new SingularityFlowError(`Work type '${workTypeId}' sourceReview.phases must list distinct active steps that define the scope or plan the claims.`);
  }
  const reviewerAgent = value.reviewerAgent ?? null;
  if (reviewerAgent != null && (typeof reviewerAgent !== 'string'
      || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(reviewerAgent))) {
    throw new SingularityFlowError(`Work type '${workTypeId}' sourceReview.reviewerAgent must be a governed agent ID.`);
  }
  if (mode === 'enforce' && (!selected.length || !reviewerAgent)) {
    throw new SingularityFlowError(`Work type '${workTypeId}' enforced sourceReview needs phases and reviewerAgent.`);
  }
  return { mode, phases: selected, reviewerAgent };
}

export function sourceReviewRequired(workflow, phaseId) {
  const policy = workflow?.resolution?.sourceReview;
  return policy?.mode === 'enforce' && Array.isArray(policy.phases)
    && policy.phases.includes(phaseId);
}

/** A generation authored by its required reviewer needs an honestly attributed successor. */
export function sourceReviewAuthorConflict(workflow, phase) {
  return Boolean(phase?.generation > 0 && sourceReviewRequired(workflow, phase.id)
    && phase.generatedAgent === workflow.resolution.sourceReview.reviewerAgent);
}

export function pendingIntentAmendmentAcknowledgement(workflow) {
  return [...(workflow?.intentAmendments ?? [])].reverse()
    .find((entry) => entry.status === 'approved' && !entry.acknowledgedAt) ?? null;
}

export function assertIntentAmendmentAcknowledged(workflow) {
  const amendment = pendingIntentAmendmentAcknowledgement(workflow);
  if (!amendment) return;
  const command = `singularity-flow story intent-amendment acknowledge ${amendment.id} --work-id ${workflow.workItem.id}`;
  throw new SingularityFlowError(`Intent amendment '${amendment.id}' changed ${amendment.changedClauses?.join(', ') || 'the approved scope'}. Acknowledge it before downstream revalidation with ${command}.`, {
    code: 'INTENT_AMENDMENT_ACKNOWLEDGEMENT_REQUIRED',
    details: { workId: workflow.workItem.id, phase: workflow.currentPhase,
      actions: [{ command, skill: '/sf-reject', detail: 'Review the amendment and acknowledge only with an explicit human choice.' }] }
  });
}

export function assertSourceReviewerAvailable(policy, agents, { workTypeId = 'workflow' } = {}) {
  if (policy?.mode !== 'enforce') return;
  const reviewer = agents?.find((agent) => agent.id === policy.reviewerAgent);
  if (!reviewer || reviewer.metadata?.['sflow-mode'] !== 'read-only-review') {
    throw new SingularityFlowError(
      `Work type '${workTypeId}' requires governed reviewer '${policy.reviewerAgent}' with sflow-mode: read-only-review.`,
      { code: 'SOURCE_REVIEW_AGENT_UNAVAILABLE' }
    );
  }
  const collisions = (policy.phases ?? []).filter((id) => reviewer.defaultFor?.includes(id));
  if (collisions.length) throw new SingularityFlowError(
    `Work type '${workTypeId}' cannot use '${reviewer.id}' as both author and independent reviewer of ${collisions.join(', ')}. Choose a writable default author.`,
    { code: 'SOURCE_REVIEW_AUTHOR_COLLISION', details: { workTypeId, reviewerAgent: reviewer.id, phases: collisions } }
  );
}
