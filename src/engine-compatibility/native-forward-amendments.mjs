/** Native forward amendments retain the installed transactions, records, authority and recovery. */
import {workDirRelative} from '../story-paths.mjs';
import {assertNoPendingPublication,decideForwardAmendment,proposeForwardAmendment,rejectPhase,revalidateAfterForwardAmendment,transactStory} from '../state-stores.mjs';
import {persistGenerationPublicationRecord} from '../generation-publication-store.mjs';
import {nextForwardAmendmentProposal} from '../forward-amendments.mjs';
import {upstreamIssueStates} from '../upstream-issues.mjs';
import {LIFECYCLE_EVENT} from '../lifecycle-event.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
const refused=(message,code='UPSTREAM_ISSUE_INVALID')=>{throw new SingularityFlowError(message,{code});};

export async function commitForwardAmendmentProposal(root,config,workflow,request,identity) {
  const {actor,agent}=identity;
  const phaseId = request.phaseId;
  if (!phaseId) refused('Name the earlier step with --phase.');
  const issue = request.upstreamIssue ?? null;
  if (issue && !upstreamIssueStates(workflow).some((entry) => entry.issue.id === issue && entry.issue.phase === phaseId)) {
    refused(`${issue} is not an upstream issue about ${phaseId}.`);
  }
  const target = workflow.phases?.[phaseId];
  if (!target?.requiredArtifact?.path) refused(`${phaseId} is not a step with one document to amend.`);
  const expected = nextForwardAmendmentProposal(workDirRelative(config, workflow.workItem.id), workflow,
    `${workDirRelative(config, workflow.workItem.id)}/${target.requiredArtifact.path}`);
  // The amended step's document is reset to its approved bytes in the same transaction; listing it in
  // exactWorkItemPaths lets a refused transaction restore the person's edit instead of leaving it reset.
  const result = await transactStory(root, config, workflow, {
    type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: workflow.currentPhase ?? null, generation: null,
    actor, agent, authorityGroup: null, payload: { decision: 'forward-amendment', stage: 'proposed' }
  }, `[${workflow.workItem.id}][forward-amendment] propose ${phaseId}`, async (aggregate) => {
    await assertNoPendingPublication(root, config, aggregate, 'propose a forward amendment');
    return proposeForwardAmendment(root, config, aggregate, { phaseId, reason: request.reason,
      file: request.file ?? null, actor, agent, upstreamIssue: issue });
  }, { exactWorkItemPaths: [expected.proposedPath, `${workDirRelative(config, workflow.workItem.id)}/${target.requiredArtifact.path}`],
    eventFromResult: (result) => ({ payload: { decision: 'forward-amendment', stage: 'proposed', amendment: result.id, reviewPacketSha256: null } }) });
  return result;
}

export async function commitForwardAmendmentDecision(root,config,workflow,amendmentId,request,identity) {
  if (request.confirmation !== amendmentId) refused(`Confirm the exact amendment: --confirm ${amendmentId}.`, 'FORWARD_AMENDMENT_CONFIRMATION_REQUIRED');
  const proposal = (workflow.forwardAmendments ?? []).find((entry) => entry.id === amendmentId);
  if (!proposal) refused(`${amendmentId || 'That amendment'} is not a forward amendment of this Story.`, 'FORWARD_AMENDMENT_NOT_FOUND');
  const {actor}=identity;
  const decision = request.decision;
  const result = await transactStory(root, config, workflow, {
    type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: proposal.phase, generation: null,
    actor, agent: null, authorityGroup: null, payload: { decision: 'forward-amendment', amendment: amendmentId }
  }, `[${workflow.workItem.id}][forward-amendment] ${decision} ${amendmentId}`, async (aggregate) => {
    await assertNoPendingPublication(root, config, aggregate, 'decide a forward amendment');
    return decideForwardAmendment(root, config, aggregate, { amendmentId, decision, reason: request.reason, actor, agent: null });
  }, {
    eventFromResult: (result) => result.applied ? {
      actor: result.approval.actor, agent: result.approval.agent, authorityGroup: result.approval.authorityGroup,
      identityAssurance: result.approval.identityAssurance, phaseId: proposal.phase, generation: result.approval.generation,
      payload: { decision: 'forward-amendment', amendment: amendmentId, decisionSha256: result.decisionSha256, reviewPacketSha256: null }
    } : { authorityGroup: result.decision.authorityGroup,
      payload: { decision: 'forward-amendment', amendment: amendmentId, outcome: 'rejected', reviewPacketSha256: null } },
    afterEventFinalize: async (publicationEvent, transactionContext, result) => {
      if (!result?.applied) return;
      await persistGenerationPublicationRecord(root, workflow, workflow.phases[proposal.phase], {
        publicationEvent, transactionId: transactionContext.transactionId, expectedHead: transactionContext.expectedHead,
        workDirectory: workDirRelative(config, workflow.workItem.id)
      });
    }
  });
  return result;
}

export async function commitForwardAmendmentRevalidation(root,config,workflow,phaseId,request,identity) {
  const amendmentId = request.amendmentId;
  const outcome = request.outcome;
  const reason = request.reason;
  const {actor,agent}=identity;
  let value,publication;
  if (outcome === 'return') {
    const current = workflow.phases?.[workflow.currentPhase];
    if (!current || !['in_progress', 'awaiting_approval'].includes(current.status)) {
      refused('A return needs a current step in progress or awaiting approval.', 'UPSTREAM_ISSUE_RETURN_UNAVAILABLE');
    }
    ({ value,publication } = await transactStory(root, config, workflow, {
      type: LIFECYCLE_EVENT.PHASE_REJECTED, phaseId: current.id, generation: current.generation, actor, agent,
      payload: { targetPhaseId: phaseId }
    }, `[${workflow.workItem.id}][forward-amendment] ${amendmentId} returns to ${phaseId}`, async (aggregate) => {
      const entry = await revalidateAfterForwardAmendment(root, config, aggregate, { amendmentId, phaseId, outcome, reason, actor, agent });
      const returned = await rejectPhase(root, config, aggregate, { phaseId: current.id, target: phaseId, reason, actor, agent,
        channel: 'terminal', upstreamIssue: { id: amendmentId } });
      entry.link = returned.changeRequest.id;
      return entry;
    }, { eventFromResult: (entry) => ({ payload: { targetPhaseId: phaseId, changeRequestId: entry.link } }) }));
  } else {
    ({ value,publication } = await transactStory(root, config, workflow, {
      type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: workflow.currentPhase ?? null, generation: null,
      actor, agent, authorityGroup: null, payload: { decision: 'forward-amendment' }
    }, `[${workflow.workItem.id}][forward-amendment] ${phaseId} revalidated after ${amendmentId}`, async (aggregate) => {
      await assertNoPendingPublication(root, config, aggregate, 'revalidate a step');
      return revalidateAfterForwardAmendment(root, config, aggregate, { amendmentId, phaseId, outcome, reason, actor, agent });
    }, { exactWorkItemPaths: [], eventFromResult: (entry) => ({ authorityGroup: entry.authorityGroup, identityAssurance: entry.identityAssurance,
      payload: { decision: 'forward-amendment', amendment: amendmentId, revalidated: phaseId, reviewPacketSha256: null } }) }));
  }
  return {value,publication};
}
