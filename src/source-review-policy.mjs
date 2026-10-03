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

export function assertSourceReviewerAvailable(policy, agents, { workTypeId = 'workflow' } = {}) {
  if (policy?.mode !== 'enforce') return;
  const reviewer = agents?.find((agent) => agent.id === policy.reviewerAgent);
  if (!reviewer || reviewer.metadata?.['sflow-mode'] !== 'read-only-review') {
    throw new SingularityFlowError(
      `Work type '${workTypeId}' requires governed reviewer '${policy.reviewerAgent}' with sflow-mode: read-only-review.`,
      { code: 'SOURCE_REVIEW_AGENT_UNAVAILABLE' }
    );
  }
}
