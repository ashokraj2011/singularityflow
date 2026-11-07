/** Native decision-evidence-reuse recording. Existing authority, record and transaction semantics are retained. */
import {requireApprovalAuthority} from '../kernel/approval-policy.mjs';
import {evidenceReuseAuthorities} from '../kernel/approval-fallback.mjs';
export {evidenceReuseAuthorities};
import {prepareEvidenceReuse,recordEvidenceReuse,recordEvidenceReuseRevocation,evidenceReuseLabel} from '../evidence-reuse.mjs';
import {LIFECYCLE_EVENT} from '../lifecycle-event.mjs';
import {actorKey,assertNoPendingPublication,transactStory} from '../state-stores.mjs';
import {nowIso,SingularityFlowError} from '../util.mjs';

/**
 * One evidence-reuse decision for `phaseId` (the attempt verified against the current source first),
 * or the revocation named by `revoke`, checked and ready to write into a transaction. Its own commit
 * and an approval's both write it [SPEC-OAP M4], so the source binding, authority and record are the same.
 */
export async function evidenceReuseDecisionPart(root, config, workflow, {
  phaseId, attemptId = null, revoke = null, reason = '', expires = null
}, { actor, agent = null }) {
  const id = workflow.workItem.id;
  // Verified before authority, so a refusal names what is wrong with the evidence first.
  const prepared = revoke ? null : await prepareEvidenceReuse(root, config, workflow, { phaseId, attemptId });
  const groups = evidenceReuseAuthorities(workflow, phaseId);
  if (!groups.length) {
    throw new SingularityFlowError(`Step ${phaseId} has no approval group, so nobody can approve reusing evidence for it.`, { code: 'EVIDENCE_REUSE_AUTHORITY_UNAVAILABLE' });
  }
  const authority = requireApprovalAuthority(
    workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    { mode: 'required', authorities: groups, requiredAuthorities: [], minimum: 1 },
    actor
  );
  const common = { reason: reason ?? '', actor: actorKey(actor), authorityGroup: authority.authorityGroup,
    identityAssurance: authority.identityAssurance ?? null, at: nowIso() };
  const decide = (aggregate) => revoke
    ? recordEvidenceReuseRevocation(aggregate, { reuseId: revoke, ...common })
    : recordEvidenceReuse(aggregate, { phaseId, candidate: prepared, expires: expires ?? null, ...common });
  decide(structuredClone(workflow));
  return {
    decision: 'evidence-reuse', phaseId, authority,
    message: `[${id}][evidence-reuse:${revoke ? 'revoke' : 'accept'}] ${revoke ?? `${phaseId} ${attemptId}`}`,
    write(aggregate) {
      const recorded = decide(aggregate);
      aggregate.history.push({
        at: recorded.at, actor: recorded.actor, agent, event: 'evidence_reuse_decided', phase: phaseId,
        detail: recorded.revokes
          ? `${recorded.revokes} (${recorded.attemptId} for ${recorded.phase}) revoked. ${recorded.reason}`
          : `${recorded.id} ${evidenceReuseLabel(recorded)}${recorded.expiresAt ? `, until ${recorded.expiresAt.slice(0, 10)}` : ''}. ${recorded.reason}`
      });
      return recorded;
    },
    record: (recorded) => recorded.revokes ?? recorded.id
  };
}

/**
 * Record one evidence-reuse decision for `phaseId` (the attempt verified against the current source
 * first), or the revocation named by `revoke`, and commit it. The command and the decision list
 * both record through this; an approval writes the same part into its own commit [SPEC-OAP M4].
 */
export async function recordEvidenceReuseDecision(root, config, workflow, request, { actor, agent = null }) {
  const part = await evidenceReuseDecisionPart(root, config, workflow, request, { actor, agent });
  const { value: record, publication } = await transactStory(
    root, config, workflow,
    {
      type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: part.phaseId, generation: null,
      actor, agent, authorityGroup: part.authority.authorityGroup, payload: { decision: 'evidence-reuse' }
    },
    part.message,
    async (aggregate) => {
      await assertNoPendingPublication(root, config, aggregate, 'record an evidence-reuse decision');
      return part.write(aggregate);
    },
    {
      eventFromResult: (recorded) => ({
        actor, agent, authorityGroup: recorded.authorityGroup, identityAssurance: recorded.identityAssurance,
        payload: { decision: 'evidence-reuse', record: recorded.revokes ?? recorded.id, revoked: Boolean(recorded.revokes), reviewPacketSha256: null }
      })
    }
  );
  return { record, publication };
}
