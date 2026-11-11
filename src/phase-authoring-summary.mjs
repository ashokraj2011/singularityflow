import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { authoringRoute, phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { phaseHandoff, requestedSuccessorAction, requestedSuccessorEligible } from './guide.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';
import { pinnedResolutionVerification } from './pinned-policy-read.mjs';
import { sourceReviewRequired } from './source-review-policy.mjs';
import { reviewContinuation } from './review-continuation.mjs';
import { phaseAuthoringEntry } from './phase-authoring-entry.mjs';

/**
 * A pinned drafting route and its post-publication handoff. That handoff is not the next action
 * for an unpublished draft. Document inspection opts into the current read-only lifecycle
 * continuation; publication/approval displays do not pay for an extra readiness inspection.
 */
export async function phaseAuthoringSummary(root, config, workflow, phase, {
  documents = null, includeContinuation = false, includeEntry = false
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
  let reviewError = null;
  const sourceReviewEvidence = phase.status === 'in_progress' && phase.generation > 0 && sourceReviewRequired(workflow, phase.id)
    ? await (await import('./source-review-lifecycle.mjs')).readSourceReviewStatus(root, config, workflow, phase.id).catch(error => {
      reviewError = { code: error.code ?? null, message: error.message }; return null;
    }) : null;
  // What the person typed after /sf-code for the next generation leads a published, unsubmitted code step.
  // Read from the CLI source, so the editor bundles that read an entry do not carry the asked-for record.
  const requestedChange = requestedSuccessorEligible(workflow, phase)
    && (await (await import(pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'requested-successor.mjs')).href))
      .requestedChanges(root, workflow, phase).catch(() => [])).length > 0;
  // Files changed after the published code lead the same way: its next generation starts with them (N7).
  const changedPaths = requestedSuccessorEligible(workflow, phase) && phaseRequiresCodeDelivery(phase)
    ? (await (await import(pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'changes-after-publication.mjs')).href))
      .changesAfterPublication(root, config, workflow, phase).catch(() => null))?.paths ?? [] : [];
  const handoff = phase.status === 'in_progress'
    ? phaseHandoff(workflow, phase, { sourceReviewEvidence, requestedChange, changedPaths, ...(documents === null ? {} : { hasDocuments: phase.generation > 0 && documents.length > 0 }) })
      .map(({ skill, command, copilotCommand, modelFreeCommand, reason, optional }) => ({ skill, command, copilotCommand,
        modelFreeCommand: modelFreeCommand ?? null, reason, ...(optional ? { optional } : {}) }))
    : [];
  let entry = includeEntry ? phaseAuthoringEntry(workflow, phase, { review: sourceReviewEvidence, reviewError }) : null;
  const leads = requestedChange || changedPaths.length > 0;
  const offer = entry?.status === 'retained-generation' ? requestedSuccessorAction(workflow, phase, { requested: requestedChange, changedPaths }) : null;
  if (offer) entry = { ...entry, ...(changedPaths.length ? { reason: 'changed-after-publication', changedPaths } : requestedChange ? { reason: 'change-requested' } : {}),
    actions: entry.actions ? leads ? [offer, ...entry.actions] : [...entry.actions, offer] : handoff };
  return {
    authoringSkill: route.authoringSkill,
    effectiveAuthoringSkill: route.effectiveAuthoringSkill,
    authoringSkillSource: route.authoringSkillSource,
    ...(route.authoringSkillWarning ? { authoringSkillWarning: route.authoringSkillWarning } : {}),
    policyVerified: true,
    ...(includeEntry ? { entry } : {}),
    handoff,
    ...(includeContinuation ? {
      handoffScope: 'after-publication',
      continuation: await reviewContinuation(root, config, workflow, phase)
    } : {})
  };
}
