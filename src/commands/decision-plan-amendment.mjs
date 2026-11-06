/**
 * The one write of a narrow plan amendment [E2G-012]: `decision plan` and a choice recorded from the
 * decision list both come here, so the authority check, the record and the commit are the same.
 */
import { requireApprovalAuthority } from '../approval-authority.mjs';
import { LIFECYCLE_EVENT } from '../lifecycle-event.mjs';
import { planAuthorities, recordPlanAmendment } from '../plan-amendments.mjs';
import { loadActiveSpecRecords, mergePlannedClaimRecords } from '../specifications.mjs';
import { actorKey, assertNoPendingPublication, transactStory } from '../state-stores.mjs';
import { workDir } from '../story-paths.mjs';
import { nowIso, SingularityFlowError } from '../util.mjs';

export async function commitPlanAmendment(root, config, workflow, { changes, reason }, { actor, agent = null }) {
  const id = workflow.workItem.id;
  const groups = planAuthorities(workflow);
  if (!groups.length) {
    throw new SingularityFlowError('No step of this Story holds the plan with an approval group, so nobody can amend it.', { code: 'PLAN_AMENDMENT_AUTHORITY_UNAVAILABLE' });
  }
  const records = await loadActiveSpecRecords(workDir(root, config, id), workflow);
  const plan = mergePlannedClaimRecords(records.planned ?? []);
  const authority = requireApprovalAuthority(
    workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    { mode: 'required', authorities: groups, requiredAuthorities: [], minimum: 1 },
    actor
  );
  const decide = (aggregate) => recordPlanAmendment(aggregate, {
    changes, reason, actor: actorKey(actor), authorityGroup: authority.authorityGroup,
    identityAssurance: authority.identityAssurance ?? null, at: nowIso(), plan
  });
  decide(structuredClone(workflow));
  const { value: amendment, publication } = await transactStory(
    root, config, workflow,
    {
      type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: workflow.currentPhase ?? null, generation: null,
      actor, agent, authorityGroup: authority.authorityGroup, payload: { decision: 'plan' }
    },
    `[${id}][plan:amend] ${changes.length} change(s)`,
    async (aggregate) => {
      await assertNoPendingPublication(root, config, aggregate, 'amend the plan');
      const recorded = decide(aggregate);
      aggregate.history.push({
        at: recorded.at, actor: recorded.actor, agent, event: 'plan_amended', phase: aggregate.currentPhase ?? null,
        detail: `${recorded.id}: ${recorded.changes.map((change) => change.kind === 'add-location' ? `${change.path} added to ${change.clauseId}` : `${change.path} listed as ${change.class}`).join('; ')}. ${recorded.reason}`
      });
      return recorded;
    },
    {
      eventFromResult: (recorded) => ({
        actor, agent, authorityGroup: recorded.authorityGroup, identityAssurance: recorded.identityAssurance,
        payload: { decision: 'plan', amendment: recorded.id, reviewPacketSha256: null }
      })
    }
  );
  return { amendment, publication };
}
