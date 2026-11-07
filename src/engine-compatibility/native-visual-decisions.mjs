/** Native decision-visual-profile recording. Existing authority, record and transaction semantics are retained. */
import {requireApprovalAuthority} from '../kernel/approval-policy.mjs';
import {visualProfileAuthorities} from '../kernel/approval-fallback.mjs';
export {visualProfileAuthorities};
import {assertVisualProfileDecidable,recordVisualProfileDecision,recordVisualProfileRevocation} from '../visual-profile-decisions.mjs';
import {LIFECYCLE_EVENT} from '../lifecycle-event.mjs';
import {actorKey,assertNoPendingPublication,transactStory} from '../state-stores.mjs';
import {nowIso,SingularityFlowError} from '../util.mjs';

/**
 * That one verification profile of a visual step does not apply to this Story, or the revocation
 * named by `revoke`, checked and ready to write into a transaction. Its own commit and an approval's
 * both write it [SPEC-OAP M4], so the checks, authority and record are the same.
 */
export async function visualProfileDecisionPart(root, config, workflow, { phaseId, profileId = null, revoke = null, reason = '' }, { actor, agent = null }) {
  const id = workflow.workItem.id;
  // Checked before authority, so a refusal names what is wrong with the decision first.
  if (!revoke) assertVisualProfileDecidable(workflow, { phaseId, profileId });
  const groups = visualProfileAuthorities(workflow, phaseId);
  if (!groups.length) {
    throw new SingularityFlowError(`Step ${phaseId} has no approval group, so nobody can decide which screen sizes apply to it.`, { code: 'VISUAL_PROFILE_AUTHORITY_UNAVAILABLE' });
  }
  const authority = requireApprovalAuthority(
    workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    { mode: 'required', authorities: groups, requiredAuthorities: [], minimum: 1 },
    actor
  );
  const common = { reason: reason ?? '', actor: actorKey(actor), authorityGroup: authority.authorityGroup,
    identityAssurance: authority.identityAssurance ?? null, at: nowIso() };
  const decide = (aggregate) => revoke
    ? recordVisualProfileRevocation(aggregate, { decisionId: revoke, ...common })
    : recordVisualProfileDecision(aggregate, { phaseId, profileId, ...common });
  decide(structuredClone(workflow));
  return {
    decision: 'visual-profile', phaseId, authority,
    message: `[${id}][visual-profile:${revoke ? 'revoke' : 'not-applicable'}] ${revoke ?? `${phaseId} ${profileId}`}`,
    write(aggregate) {
      const recorded = decide(aggregate);
      aggregate.history.push({
        at: recorded.at, actor: recorded.actor, agent, event: 'visual_profile_decided', phase: phaseId,
        detail: recorded.revokes
          ? `${recorded.revokes} (${recorded.profileId} for ${recorded.phase}) revoked; the profile needs a screenshot again. ${recorded.reason}`
          : `${recorded.id}: verification profile ${recorded.profileId} (${recorded.profileLabel}) does not apply to this Story for ${recorded.phase}. ${recorded.reason}`
      });
      return recorded;
    },
    record: (recorded) => recorded.revokes ?? recorded.id
  };
}

/**
 * Record that one verification profile of a visual step does not apply to this Story, or the
 * revocation named by `revoke`, and commit it. The command and the decision list both record through
 * this; an approval writes the same part into its own commit [SPEC-OAP M4].
 */
export async function recordVisualProfileDecisionFor(root, config, workflow, request, { actor, agent = null }) {
  const part = await visualProfileDecisionPart(root, config, workflow, request, { actor, agent });
  const { value: record, publication } = await transactStory(
    root, config, workflow,
    {
      type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: part.phaseId, generation: null,
      actor, agent, authorityGroup: part.authority.authorityGroup, payload: { decision: 'visual-profile' }
    },
    part.message,
    async (aggregate) => {
      await assertNoPendingPublication(root, config, aggregate, 'record a visual-profile decision');
      return part.write(aggregate);
    },
    {
      // A decision made while the step's draft and captures are still open commits only itself: the
      // publication that follows commits those [narrow decision transaction].
      exactWorkItemPaths: [],
      eventFromResult: (recorded) => ({
        actor, agent, authorityGroup: recorded.authorityGroup, identityAssurance: recorded.identityAssurance,
        payload: { decision: 'visual-profile', record: recorded.revokes ?? recorded.id, revoked: Boolean(recorded.revokes), reviewPacketSha256: null }
      })
    }
  );
  return { record, publication };
}
