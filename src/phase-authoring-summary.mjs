import { authoringRoute } from './code-delivery-policy.mjs';
import { phaseHandoff } from './guide.mjs';
import { pinnedResolutionVerification } from './state-stores.mjs';
import { sourceReviewRequired } from './source-review-policy.mjs';
import { readSourceReviewStatus } from './source-review-lifecycle.mjs';
import { reviewContinuation } from './review-continuation.mjs';

/**
 * A pinned drafting route and its post-publication handoff. That handoff is not the next action
 * for an unpublished draft. Document inspection opts into the current read-only lifecycle
 * continuation; publication/approval displays do not pay for an extra readiness inspection.
 */
export async function phaseAuthoringSummary(root, config, workflow, phase, {
  documents = null, includeContinuation = false
} = {}) {
  const route = authoringRoute(phase, workflow);
  const policy = await pinnedResolutionVerification(root, config, workflow);
  if (!policy.verified) {
    return {
      authoringSkill: null, effectiveAuthoringSkill: null, authoringSkillSource: 'unverified',
      policyVerified: false, policyReason: policy.reason, handoff: [],
      ...(includeContinuation ? { handoffScope: 'after-publication', continuation: null } : {})
    };
  }
  const sourceReviewEvidence = phase.status === 'in_progress' && phase.generation > 0 && sourceReviewRequired(workflow, phase.id)
    ? await readSourceReviewStatus(root, config, workflow, phase.id).catch(() => null) : null;
  return {
    authoringSkill: route.authoringSkill,
    effectiveAuthoringSkill: route.effectiveAuthoringSkill,
    authoringSkillSource: route.authoringSkillSource,
    ...(route.authoringSkillWarning ? { authoringSkillWarning: route.authoringSkillWarning } : {}),
    policyVerified: true,
    handoff: phase.status === 'in_progress'
      ? phaseHandoff(workflow, phase, { sourceReviewEvidence, ...(documents === null ? {} : { hasDocuments: phase.generation > 0 && documents.length > 0 }) })
        .map(({ skill, command, copilotCommand, reason, optional }) => ({ skill, command, copilotCommand, reason, ...(optional ? { optional } : {}) }))
      : [],
    ...(includeContinuation ? {
      handoffScope: 'after-publication',
      continuation: await reviewContinuation(root, config, workflow, phase)
    } : {})
  };
}
