/** Native reviewer return port. The record writer remains a separately owned transition. */
import { SingularityFlowError } from '../foundation/failures.mjs';
import { loadNativeDecisionContext } from './decision-context.mjs';
import { postPublicationStep } from './post-transition.mjs';

async function prepareRejection(context) {
  const { root, workflow, phase, session, inputs, testingRepairPlan } = context;
  const presence = workflow.resolution?.presence
    ? await (await import('../presence/person-records.mjs')).preparePersonPresence(root, {
      workflow, phase, actor: session.actor, action: 'phase.reject'
    }) : null;
  return { presence, channel: process.env.SINGULARITY_FLOW_GITHUB_ACTOR ? 'github-pr-comment' : 'engine-sdk',
    actionContext: null, testingRepairConfirm: testingRepairPlan ? inputs.confirm ?? null : null, testingRepairPlan };
}

/** Human interaction is a trusted host collaborator. Request data cannot replace identity or ports. */
export function createGitRejectionPort({ root, interaction = null, notice = () => {}, onContext = () => {} }) {
  const load = typeof interaction?.load === 'function' ? interaction.load.bind(interaction) : null;
  const prepare = typeof interaction?.prepare === 'function' ? interaction.prepare.bind(interaction) : prepareRejection;
  return {
    async load(inputs) {
      const native = load ? await load(inputs) : await loadNativeDecisionContext(root,
        ['reject', ...(inputs.phaseId ? [inputs.phaseId] : [])], {
          'work-id': inputs.workId, 'selection-receipt': inputs.selectionReceipt, fetch: inputs.fetch,
          agent: inputs.agent, to: inputs.target, repair: inputs.repair, confirm: inputs.confirm
        }, 'reject');
      if (native.root !== root || inputs.workId != null && native.workflow.workItem.id !== inputs.workId
        || inputs.phaseId != null && native.phase.id !== inputs.phaseId) {
        throw new SingularityFlowError('The rejection interaction returned another bound Story or phase.', { code: 'ENGINE_PORT_RESULT_INVALID' });
      }
      const context = { ...native, inputs, subject: { kind: 'story', id: native.workflow.workItem.id },
        target: inputs.target ?? native.phase.id, sourceGeneration: Number(native.phase.generation ?? 0) };
      onContext(context); return context;
    },
    async prepare(context) { return prepare(context, context.inputs); },
    async commit(context, prepared) {
      const { transactStory, rejectPhase } = await import('../state-stores.mjs');
      const { LIFECYCLE_EVENT } = await import('../lifecycle-event.mjs');
      const { root, config, workflow, phase: current, session, target, inputs } = context;
      const { value: phase, publication } = await transactStory(
        root, config, workflow,
        { type: LIFECYCLE_EVENT.PHASE_REJECTED, phaseId: current.id, generation: current.generation,
          actor: session.actor, agent: session.agent, payload: { targetPhaseId: target } },
        `[${workflow.workItem.id}][phase:${current.id}][reject] return to ${target}`,
        aggregate => rejectPhase(root, config, aggregate, {
          phaseId: current.id, target, reason: inputs.reason ?? undefined, clauseIds: inputs.clauseIds ?? [], members: inputs.members ?? [],
          channel: prepared.channel, actionContext: prepared.actionContext, actor: session.actor, agent: session.agent,
          presence: prepared.presence, testingRepairConfirm: prepared.testingRepairConfirm, testingRepairPlan: prepared.testingRepairPlan
        }),
        { eventFromResult: transition => ({ payload: { targetPhaseId: target, changeRequestId: transition.changeRequest.id } }) }
      );
      Object.assign(context, { result: phase, publication }); return publication;
    },
    async finish(context, _prepared, publication) {
      const { root, workflow, phase, sourceGeneration, result } = context;
      await postPublicationStep('the returned-phase session activation', workflow.workItem.id, async () => {
        const { loadAcceptedStoryExecution } = await import('../accepted-story-execution.mjs');
        const { activateWorkItemSession } = await import('../session.mjs');
        const accepted = await loadAcceptedStoryExecution(root, workflow.workItem.id);
        return activateWorkItemSession(root, accepted.config, accepted.workflow);
      }, { notice });
      const change = result.changeRequest;
      return { workId: workflow.workItem.id, phase: phase.id, generation: sourceGeneration, revision: publication.sha,
        pushed: publication.pushed === true, currentPhase: workflow.currentPhase ?? null,
        changeRequest: { id: change.id, status: change.status, sourcePhase: change.sourcePhase,
          sourceGeneration: Number(change.sourceGeneration ?? 0), targetPhase: change.targetPhase, clauseIds: change.clauseIds,
          members: change.members ?? [], reason: change.comment,
          actorId: change.requestedBy.login ?? change.requestedBy.email ?? change.requestedBy.name,
          authorityGroup: change.authorityGroup, reviewPacket: change.reviewPacketSha256 },
        repairBudget: result.repairBudget ? { consumed: result.repairBudget.attempts.length, maximum: result.repairBudget.maximum } : null };
    }
  };
}
