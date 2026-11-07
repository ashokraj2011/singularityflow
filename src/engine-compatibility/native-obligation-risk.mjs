/**
 * Native obligation-risk writes [E2G-025, D4]. CLI and registered decision effects share these
 * exact evaluations, authority checks, records and transactions.
 */
import { requireApprovalAuthority } from '../kernel/approval-policy.mjs';
import { recordRiskDecision, recordRiskRevocation, riskAuthorities } from '../evidence/risk-decisions.mjs';
import { LIFECYCLE_EVENT } from '../lifecycle-event.mjs';
import { actorKey, assertNoPendingPublication, transactStory } from '../state-stores.mjs';
import { nowIso, SingularityFlowError } from '../util.mjs';

export async function commitRiskDecision(root, config, workflow, { obligationId = null, revoke = null, category = null, transitions = ['terminal'], expires = null, reason = '' }, { actor, agent = null }) {
  const id = workflow.workItem.id;
  const { evidenceGraphFromAggregate } = await import('../evidence/graph.mjs');
  const { evaluateEvidence } = await import('../evidence/evaluate.mjs');
  const graph = await evidenceGraphFromAggregate(root, config, workflow);
  const obligations = evaluateEvidence(graph).rows.flatMap((row) => row.obligations);
  const targetId = revoke
    ? (workflow.riskDecisions ?? []).find((entry) => !entry.revokes && entry.id === revoke)?.obligationId ?? null
    : obligationId;
  const obligation = obligations.find((entry) => entry.id === targetId) ?? null;
  if (!obligation && !revoke) {
    throw new SingularityFlowError(`The evidence matrix of ${id} has no obligation ${obligationId}; see singularity-flow evidence matrix.`, { code: 'RISK_OBLIGATION_UNKNOWN' });
  }
  const groups = riskAuthorities(workflow, obligation ?? { owningSteps: workflow.phaseOrder ?? [] });
  if (!groups.length) {
    throw new SingularityFlowError(`No step owning ${targetId ?? 'this obligation'} has an approval group, so nobody can accept its risk.`, { code: 'RISK_AUTHORITY_UNAVAILABLE' });
  }
  const authority = requireApprovalAuthority(
    workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    { mode: 'required', authorities: groups, requiredAuthorities: [], minimum: 1 },
    actor
  );
  const common = { reason, actor: actorKey(actor), authorityGroup: authority.authorityGroup, identityAssurance: authority.identityAssurance ?? null, at: nowIso() };
  const decide = (aggregate) => revoke
    ? recordRiskRevocation(aggregate, { riskId: revoke, ...common })
    : recordRiskDecision(aggregate, { obligation, untrusted: graph.untrusted, category, transitions, expires, ...common });
  decide(structuredClone(workflow));
  const { value: record, publication } = await transactStory(
    root, config, workflow,
    {
      type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: workflow.currentPhase ?? null, generation: null,
      actor, agent, authorityGroup: authority.authorityGroup, payload: { decision: 'risk' }
    },
    `[${id}][risk:${revoke ? 'revoke' : 'accept'}] ${revoke ?? obligationId}`,
    async (aggregate) => {
      await assertNoPendingPublication(root, config, aggregate, 'record a risk decision');
      const recorded = decide(aggregate);
      aggregate.history.push({
        at: recorded.at, actor: recorded.actor, agent, event: 'risk_decided', phase: aggregate.currentPhase ?? null,
        detail: recorded.revokes
          ? `${recorded.revokes} on ${recorded.obligationId} revoked. ${recorded.reason}`
          : `${recorded.id} accepts the ${recorded.category} risk of ${recorded.obligationId} until ${recorded.expiresAt.slice(0, 10)} for ${recorded.transitions.join(', ')}. ${recorded.reason}`
      });
      return recorded;
    },
    {
      eventFromResult: (recorded) => ({
        actor, agent, authorityGroup: recorded.authorityGroup, identityAssurance: recorded.identityAssurance,
        payload: { decision: 'risk', record: recorded.revokes ?? recorded.id, revoked: Boolean(recorded.revokes), reviewPacketSha256: null }
      })
    }
  );
  return { record, publication };
}
