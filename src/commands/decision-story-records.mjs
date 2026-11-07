/**
 * The one write of each of these people's decisions: its own `decision` command and a choice recorded
 * from the decision list both come here, so the authority check, the record and the commit are the same.
 */
import { requireApprovalAuthority } from '../kernel/approval-policy.mjs';
import { omissionAuthorities, recordApplicabilityDecision } from '../evidence/applicability.mjs';
import { LIFECYCLE_EVENT } from '../lifecycle-event.mjs';
import { recordCompletenessReview, recordScopeDecision, scopeAuthorities } from '../scope/decisions.mjs';
import { activateWorkItemSession } from '../session.mjs';
import { actorKey, assertNoPendingPublication, decideStory, transactStory } from '../state-stores.mjs';
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { nowIso, SingularityFlowError } from '../util.mjs';
import { resolveDecisionChoice } from '../workflow-decisions.mjs';
import { postPublicationStep } from './shared/post-publication-step.mjs';
import { withRefusalMemory } from '../evidence/refusal-memory.mjs';

/** Why a responsibility the workflow leaves out does not apply to this Story. */
export async function commitApplicabilityDecision(root, config, workflow, { responsibility, reason }, { actor, agent = null }) {
  const id = workflow.workItem.id;
  // The same checks the transaction makes, before anything is locked or written.
  const groups = omissionAuthorities(workflow, responsibility);
  const authority = groups.length ? requireApprovalAuthority(
    workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    { mode: 'required', authorities: groups, requiredAuthorities: [], minimum: 1 },
    actor
  ) : null;
  const decide = (aggregate) => recordApplicabilityDecision(aggregate, {
    responsibility, reason, actor: actorKey(actor), authorityGroup: authority?.authorityGroup ?? null,
    identityAssurance: authority?.identityAssurance ?? null, at: nowIso()
  });
  decide(structuredClone(workflow));
  const { value: decision, publication } = await transactStory(
    root,
    config,
    workflow,
    {
      type: LIFECYCLE_EVENT.DECISION_MADE,
      phaseId: workflow.currentPhase ?? null,
      generation: null,
      actor,
      agent,
      authorityGroup: authority.authorityGroup,
      payload: { decision: 'applicability', responsibility }
    },
    `[${id}][applicability:${responsibility}] does not apply`,
    async (aggregate) => {
      await assertNoPendingPublication(root, config, aggregate, 'record an applicability decision');
      const recorded = decide(aggregate);
      aggregate.history.push({
        at: recorded.at, actor: recorded.actor, agent, event: 'applicability_decided', phase: aggregate.currentPhase ?? null,
        detail: `${responsibility} does not apply. Reason: ${recorded.reason}`
      });
      return recorded;
    },
    {
      // The publication otherwise names the current phase's approval as the decision.
      eventFromResult: (recorded) => ({
        actor, agent, authorityGroup: recorded.authorityGroup, identityAssurance: recorded.identityAssurance,
        payload: { decision: 'applicability', responsibility, reviewPacketSha256: null }
      })
    }
  );
  return { decision, publication };
}

/** One statement's disposition, read against the same inventory and clauses the person decided from. */
export async function commitScopeDecision(root, config, workflow, { item, disposition, clauseIds = [], reason }, { actor, agent = null }) {
  const id = workflow.workItem.id;
  const { evidenceGraphFromAggregate, scopeDecisionPreview } = await import('../evidence/graph.mjs');
  const graph = await evidenceGraphFromAggregate(root, config, workflow);
  const preview = await scopeDecisionPreview(root, config, workflow);
  const inventory = preview.inventory ?? graph.scope;
  if (!inventory) {
    throw new SingularityFlowError('The scope inventory of this Story cannot be built; see singularity-flow evidence scope.', { code: 'SCOPE_INVENTORY_UNAVAILABLE' });
  }
  const knownClauseIds = [...new Set([...(graph.records.indexes ?? []).flatMap((index) => (index.clauses ?? []).map((clause) => clause.id)), ...preview.clauseIds])];
  const groups = scopeAuthorities(workflow);
  if (!groups.length) {
    throw new SingularityFlowError('No step of this Story defines its scope with an approval group, so nobody can decide it.', { code: 'SCOPE_AUTHORITY_UNAVAILABLE' });
  }
  const authority = requireApprovalAuthority(
    workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    { mode: 'required', authorities: groups, requiredAuthorities: [], minimum: 1 },
    actor
  );
  const decide = (aggregate) => recordScopeDecision(aggregate, {
    item, disposition, clauseIds, reason, actor: actorKey(actor), authorityGroup: authority.authorityGroup,
    identityAssurance: authority.identityAssurance ?? null, at: nowIso(), inventory, knownClauseIds
  });
  decide(structuredClone(workflow));
  const { value: decision, publication } = await transactStory(
    root, config, workflow,
    {
      type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: workflow.currentPhase ?? null, generation: null,
      actor, agent, authorityGroup: authority.authorityGroup, payload: { decision: 'scope', item, disposition }
    },
    `[${id}][scope:${item}] ${disposition}`,
    async (aggregate) => {
      await assertNoPendingPublication(root, config, aggregate, 'record a scope decision');
      const recorded = decide(aggregate);
      aggregate.history.push({
        at: recorded.at, actor: recorded.actor, agent, event: 'scope_decided', phase: aggregate.currentPhase ?? null,
        detail: `${item} is ${disposition}${recorded.clauseIds.length ? ` (${recorded.clauseIds.join(', ')})` : ''}. Reason: ${recorded.reason}`
      });
      return recorded;
    },
    {
      eventFromResult: (recorded) => ({
        actor, agent, authorityGroup: recorded.authorityGroup, identityAssurance: recorded.identityAssurance,
        payload: { decision: 'scope', item, disposition, reviewPacketSha256: null }
      })
    }
  );
  return { decision, publication };
}

/** That someone in the group approving the scope step reviewed the inventory, bound to its exact digest [E2G-007]. */
export async function commitCompletenessReview(root, config, workflow, { confirm, checklist, reason }, { actor, agent = null }) {
  const id = workflow.workItem.id;
  const { evidenceGraphFromAggregate } = await import('../evidence/graph.mjs');
  const inventory = (await evidenceGraphFromAggregate(root, config, workflow)).scope;
  if (!inventory) {
    throw new SingularityFlowError('The scope inventory of this Story cannot be built; see singularity-flow evidence scope.', { code: 'SCOPE_INVENTORY_UNAVAILABLE' });
  }
  const groups = scopeAuthorities(workflow);
  if (!groups.length) {
    throw new SingularityFlowError('No step of this Story defines its scope with an approval group, so nobody can review it.', { code: 'SCOPE_AUTHORITY_UNAVAILABLE' });
  }
  const authority = requireApprovalAuthority(
    workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    { mode: 'required', authorities: groups, requiredAuthorities: [], minimum: 1 },
    actor
  );
  const decide = (aggregate) => recordCompletenessReview(aggregate, {
    inventory, confirm, checklist, reason,
    actor: actorKey(actor), authorityGroup: authority.authorityGroup, identityAssurance: authority.identityAssurance ?? null, at: nowIso()
  });
  decide(structuredClone(workflow));
  const { value: review, publication } = await transactStory(
    root, config, workflow,
    {
      type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: workflow.currentPhase ?? null, generation: null,
      actor, agent, authorityGroup: authority.authorityGroup, payload: { decision: 'completeness', inventorySha256: inventory.inventorySha256 }
    },
    `[${id}][scope:completeness] reviewed`,
    async (aggregate) => {
      await assertNoPendingPublication(root, config, aggregate, 'record a completeness review');
      const recorded = decide(aggregate);
      aggregate.history.push({
        at: recorded.at, actor: recorded.actor, agent, event: 'completeness_reviewed', phase: aggregate.currentPhase ?? null,
        detail: `Scope inventory ${recorded.inventorySha256} reviewed for completeness. ${recorded.reason}`
      });
      return recorded;
    },
    {
      eventFromResult: (recorded) => ({
        actor, agent, authorityGroup: recorded.authorityGroup, identityAssurance: recorded.identityAssurance,
        payload: { decision: 'completeness', inventorySha256: recorded.inventorySha256, reviewPacketSha256: null }
      })
    }
  );
  return { review, publication };
}

/** The workflow's routing choice: the Story moves on, or back, as the person chose. */
export async function commitRoutingChoice(root, config, workflow, { option, to, reason, expected }, { actor, agent = null }) {
  const pending = workflow.pendingDecision ?? null;
  resolveDecisionChoice(workflow, pending, { option, to });
  if (!reason.trim()) throw new SingularityFlowError('Say why with --reason; the decision log keeps it.', { code: 'DECISION_REASON_REQUIRED' });
  const authority = requireApprovalAuthority(
    workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    { mode: 'required', authorities: pending.by, requiredAuthorities: [], minimum: 1 },
    actor
  );
  const after = workflow.phases[pending.after];
  const { value: result, publication } = await withRefusalMemory(root, {
    operation: 'decision.choose', workId: workflow.workItem.id, phase: pending.after, actor: actorKey(actor), args: [option, to, pending.key]
  }, () => transactStory(
    root,
    config,
    workflow,
    {
      type: LIFECYCLE_EVENT.DECISION_MADE,
      phaseId: pending.after,
      generation: after?.generation ?? null,
      actor,
      agent,
      authorityGroup: authority.authorityGroup,
      payload: { decision: pending.decision, pendingKey: pending.key, option, to }
    },
    `[${workflow.workItem.id}][decision:${pending.decision}] ${option ?? `to ${to}`}`,
    (aggregate) => decideStory(root, config, aggregate, {
      option, to, reason, expectedKey: expected, channel: 'terminal', actor, agent
    }),
    {
      eventFromResult: (transition) => ({
        actor,
        agent,
        authorityGroup: transition.authority.authorityGroup,
        identityAssurance: transition.authority.identityAssurance,
        payload: {
          decision: transition.outcome.decision,
          route: transition.outcome.route,
          kind: transition.outcome.kind,
          target: transition.outcome.target ?? null,
          pendingKey: transition.pendingKey
        }
      })
    }
  ));
  await postPublicationStep('the next-phase session activation', workflow.workItem.id, async () => {
    const reloaded = await loadAcceptedStoryExecution(root, workflow.workItem.id);
    return activateWorkItemSession(root, reloaded.config, reloaded.workflow);
  });
  return { result, publication, authority };
}
