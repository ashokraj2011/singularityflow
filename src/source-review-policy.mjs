import { SingularityFlowError } from './util.mjs';
import { sourceReviewKind } from './phase-roles.mjs';

/**
 * The review a Story pins at its start. From level 2 (owner, 2026-11-11: "let there be a reviewer in every step
 * .. even for coding") every authored step is reviewed, code included, unless the work type says
 * `sourceReview.mode: off` or lists the step under `skip:`; a work type that says nothing is reviewed too, by
 * the packaged `sflow-source-reviewer`. A Story pinned before that keeps the review it started with.
 *
 * `authored(phaseId)` says whether a step is authored and how: 'code', 'document', or null for a step the
 * kernel builds or that writes nothing. `reviewable(phaseId)` says whether it defines the scope or plans the
 * claims: those keep their own review kinds when a legacy `phases` list names them, read from the step's
 * structure, never its name [E2G-001]. A legacy `phases` list no longer limits the review: it is kept as
 * `supersededPhases` and reported, never silently ignored.
 */
export const SOURCE_REVIEW_LEVEL = 2;
export const DEFAULT_SOURCE_REVIEWER = 'sflow-source-reviewer';

export function normalizeSourceReviewPolicy(value = null, { workTypeId = 'workflow', phases = [], reviewable = null, authored = null } = {}) {
  // A policy normalized once (the definition's) normalizes again from what was configured, never its derived fields.
  if (value?.level === SOURCE_REVIEW_LEVEL || value?.defaulted === true) {
    if (value.mode === 'off') return value.defaulted ? { ...value } : { mode: 'off', phases: [], reviewerAgent: null };
    value = { ...(value.defaulted ? {} : { reviewerAgent: value.reviewerAgent }), ...(value.skip ? { skip: value.skip } : {}),
      ...(value.supersededPhases ? { phases: value.supersededPhases } : {}) };
    if (!Object.keys(value).length) value = null;
  }
  if (value != null && (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw new SingularityFlowError(`Work type '${workTypeId}' sourceReview must be an object.`);
  }
  for (const key of Object.keys(value ?? {})) {
    if (!['mode', 'phases', 'reviewerAgent', 'skip'].includes(key)) {
      throw new SingularityFlowError(`Work type '${workTypeId}' sourceReview has unknown field '${key}'.`);
    }
  }
  const mode = value?.mode ?? 'enforce';
  if (!['off', 'enforce'].includes(mode)) {
    throw new SingularityFlowError(`Work type '${workTypeId}' sourceReview.mode must be off or enforce.`);
  }
  if (mode === 'off') return { mode: 'off', phases: [], reviewerAgent: null };
  const legacy = value?.phases ?? null;
  if (legacy != null && (!Array.isArray(legacy) || new Set(legacy).size !== legacy.length
      || legacy.some((phase) => !phases.includes(phase)))) {
    throw new SingularityFlowError(`Work type '${workTypeId}' sourceReview.phases must list distinct active steps.`);
  }
  const skip = value?.skip ?? [];
  if (!Array.isArray(skip) || new Set(skip).size !== skip.length || skip.some((phase) => !phases.includes(phase))) {
    throw new SingularityFlowError(`Work type '${workTypeId}' sourceReview.skip must list distinct active steps.`);
  }
  const reviewerAgent = value?.reviewerAgent ?? DEFAULT_SOURCE_REVIEWER;
  if (reviewerAgent != null && (typeof reviewerAgent !== 'string'
      || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(reviewerAgent))) {
    throw new SingularityFlowError(`Work type '${workTypeId}' sourceReview.reviewerAgent must be an agent ID.`);
  }
  // Each authored step not skipped, with its kind: a legacy listed scope or plan step keeps its own review.
  const kinds = {};
  for (const phase of phases) {
    if (skip.includes(phase)) continue;
    const kind = authored ? authored(phase) : 'document';
    if (!kind) continue;
    kinds[phase] = kind === 'code' ? 'code'
      : legacy?.includes(phase) && reviewable ? reviewable(phase) ?? 'document' : 'document';
  }
  return { mode: 'enforce', level: SOURCE_REVIEW_LEVEL, phases: Object.keys(kinds), kinds, reviewerAgent,
    ...(value == null ? { defaulted: true } : {}),
    ...(skip.length ? { skip: [...skip] } : {}), ...(legacy ? { supersededPhases: [...legacy] } : {}) };
}

/**
 * The default review needs the packaged reviewer. Where this configuration has none, or it authors one of the
 * steps, the default leaves those steps out and says why; a work type that configured its review is refused, as
 * before, by assertSourceReviewerAvailable.
 */
export function availableDefaultSourceReview(policy, agents) {
  if (!policy?.defaulted || policy.mode !== 'enforce' || !Array.isArray(agents) || !agents.length) return policy;
  const reviewer = agents.find((agent) => agent.id === policy.reviewerAgent);
  if (!reviewer || reviewer.metadata?.['sflow-mode'] !== 'read-only-review') {
    return { mode: 'off', phases: [], reviewerAgent: null, defaulted: true, unavailableReviewer: policy.reviewerAgent };
  }
  const authors = new Set(reviewer.defaultFor ?? []);
  if (!policy.phases.some((id) => authors.has(id))) return policy;
  const kinds = Object.fromEntries(Object.entries(policy.kinds).filter(([id]) => !authors.has(id)));
  return { ...policy, phases: Object.keys(kinds), kinds };
}

/** What a person reads about a work type's review policy that its legacy `phases` list no longer limits. */
export function sourceReviewPolicyNotice(policy, workTypeId = 'workflow') {
  if (!policy?.supersededPhases) return null;
  return `Work type '${workTypeId}' sourceReview.phases (${policy.supersededPhases.join(', ')}) is superseded: from review level ${SOURCE_REVIEW_LEVEL} every authored step is reviewed, and the listed scope and plan steps keep their own reviews; list a step under sourceReview.skip to leave it out.`;
}

/**
 * One predicate for guidance, the submit gate and `review-source`: the step is listed by the
 * pinned policy and still defines the scope or plans the claims. An older pin listing a step that
 * no longer does would otherwise get review routes that refuse and a submit gate that never clears.
 */
export function sourceReviewRequired(workflow, phaseId) {
  const policy = workflow?.resolution?.sourceReview;
  return policy?.mode === 'enforce' && Array.isArray(policy.phases)
    && policy.phases.includes(phaseId) && sourceReviewKind(workflow, phaseId) != null;
}

/** A generation authored by its required reviewer needs an honestly attributed successor. */
export function sourceReviewAuthorConflict(workflow, phase) {
  return Boolean(phase?.generation > 0 && sourceReviewRequired(workflow, phase.id)
    && phase.generatedAgent === workflow.resolution.sourceReview.reviewerAgent);
}

// An amendment that reset no step asks for none: its revalidation rows are each step's answer [SCS:REQ-022].
export function pendingIntentAmendmentAcknowledgement(workflow) {
  return [...(workflow?.intentAmendments ?? [])].reverse()
    .find((entry) => entry.status === 'approved' && entry.acknowledgementRequired !== false && !entry.acknowledgedAt) ?? null;
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
      `Work type '${workTypeId}' requires reviewer '${policy.reviewerAgent}' with sflow-mode: read-only-review.`,
      { code: 'SOURCE_REVIEW_AGENT_UNAVAILABLE' }
    );
  }
  const collisions = (policy.phases ?? []).filter((id) => reviewer.defaultFor?.includes(id));
  if (collisions.length) throw new SingularityFlowError(
    `Work type '${workTypeId}' cannot use '${reviewer.id}' as both author and independent reviewer of ${collisions.join(', ')}. Choose a writable default author.`,
    { code: 'SOURCE_REVIEW_AUTHOR_COLLISION', details: { workTypeId, reviewerAgent: reviewer.id, phases: collisions } }
  );
}
