/** Native approval composition. Interactive wording and input collection belong to the host. */
import {loadNativeDecisionContext} from './decision-context.mjs';
import {submittedApprovalBinding,requireApprovalAuthority,remainingRequiredAuthorities} from '../kernel/approval-policy.mjs';
import {isConvergencePhase} from '../kernel/phase-policy.mjs';
import {assertConvergencePublicationReady} from '../convergence-context.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {withRefusalMemory} from '../evidence/refusal-memory.mjs';
import {actorKey,transactStory,approvePhase} from '../state-stores.mjs';
import {LIFECYCLE_EVENT} from '../lifecycle-event.mjs';
import {consumeSelectionReceipt,removeApprovalReceipts} from '../choices.mjs';
import {forgetTerminalReview} from '../terminal-review.mjs';
import {loadAcceptedStoryExecution} from '../accepted-story-execution.mjs';
import {activateWorkItemSession} from '../session.mjs';
import {postPublicationStep,collectRequiredReceiptsAfterTransition,collectSpecUsageAfterTransition} from './post-transition.mjs';

async function withApprovalDecisions(aggregate,decisions,approve) {
  if(!decisions)return approve();
  const {writeApprovalDecisions}=await import('../approval-decisions.mjs');
  const recorded=writeApprovalDecisions(aggregate,decisions);
  return Object.assign(await approve(),{decisions:recorded});
}

async function defaultPreparation(context,input) {
  const {root,config,workflow,phase,session,receipt}=context;
  const confirmation=input.confirmation ?? (receipt ? context.reviewBinding : null);
  const {assertApprovalReviewConfirmation}=await import('../kernel/approval-policy.mjs');
  assertApprovalReviewConfirmation(context.reviewBinding,confirmation);
  const presenceModule=workflow.resolution?.presence ? await import('../presence/person-records.mjs') : null;
  const presence=presenceModule ? await presenceModule.preparePersonPresence(root,{workflow,phase,actor:session.actor,action:'phase.approve'}) : null;
  const counts=presenceModule ? presenceModule.presenceCounts(workflow) : null;
  const approvalAuthority=requireApprovalAuthority(workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    phase.approvalPolicy,session.actor,{preferredAuthorities:remainingRequiredAuthorities(phase.approvalPolicy,phase.approvals,{counts})});
  const decisions=input.decisions ? await (await import('../approval-decisions.mjs')).prepareApprovalDecisions(
    root,config,workflow,phase,{digest:input.decisions.digest,
      answers:(await import('../decision-list.mjs')).parseDecisionAnswers(input.decisions.answers ?? {})},
    {actor:session.actor,agent:session.agent}) : null;
  const witnessRecords=input.confirmEvidence ? await import('../verification/witness-records.mjs') : null;
  const evidence=witnessRecords ? await witnessRecords.evidenceConfirmations(root,config,workflow,session.actor) : null;
  return {confirmation,reviewed:context.reviewBinding,presenceModule,presence,approvalAuthority,decisions,
    witnessRecords,evidence,evidenceReason:input.evidenceReason ?? null,
    checklist:input.checklist ?? [],witnessMappings:input.witnessMappings ?? [],bindingDecisions:input.bindingDecisions ?? [],
    channel:process.env.SINGULARITY_FLOW_GITHUB_ACTOR ? 'github-pr-comment' : receipt ? 'copilot-selection-receipt' : 'engine-sdk',
    actionContext:receipt?.approvalContext ?? null};
}

export function createGitApprovalPort({root,interaction=null,onContext=()=>{},notice=()=>{}}) {
  // Only trusted composition supplies these callbacks; operation inputs can never provide them.
  const load=typeof interaction?.load==='function' ? interaction.load.bind(interaction) : null;
  const prepare=typeof interaction?.prepare==='function' ? interaction.prepare.bind(interaction) : defaultPreparation;
  return {
    async load(input) {
      const native=load ? await load(input) : await loadNativeDecisionContext(root,
        ['approve',...(input.phaseId ? [input.phaseId] : [])],
        {'work-id':input.workId,'selection-receipt':input.selectionReceipt,fetch:input.fetch,agent:input.agent},'approve');
      if(native.root!==root || input.workId!=null && native.workflow.workItem.id!==input.workId
          || input.phaseId!=null && native.phase.id!==input.phaseId) {
        throw new SingularityFlowError('The approval interaction returned a different bound Story or phase.',{code:'ENGINE_PORT_RESULT_INVALID'});
      }
      const context={...native,subject:Object.freeze({kind:'story',id:native.workflow.workItem.id}),
        reviewBinding:submittedApprovalBinding(native.workflow,native.phase)};
      onContext(context);
      return context;
    },
    async prepare(context,input) {
      const prepared=await prepare(context,input);
      const {root,config,workflow,phase}=context;
      // The transition mutates the aggregate in place, so the convergence guard uses an immutable
      // pre-decision projection while rereading external files/refs at the isolated-commit boundary.
      const approvalStabilityWorkflow = structuredClone(workflow);
      const approvalStabilityPhase = approvalStabilityWorkflow.phases[phase.id];
      const expectedConvergenceApprovalSnapshot = isConvergencePhase(phase)
        ? (await assertConvergencePublicationReady(
            root, config, approvalStabilityWorkflow, approvalStabilityPhase
          )).snapshotSha256
        : null;
      const approvalStabilityGuard = async () => {
        let convergenceIdentity = 'not-convergence';
        if (expectedConvergenceApprovalSnapshot) {
          const current = await assertConvergencePublicationReady(
            root, config, approvalStabilityWorkflow, approvalStabilityPhase
          );
          if (current.snapshotSha256 !== expectedConvergenceApprovalSnapshot) {
            throw new SingularityFlowError(
              'Convergence evidence changed while approval was being recorded. Nothing was committed; review and submit the current projection again.',
              { code: 'PUBLICATION_SNAPSHOT_CHANGED' }
            );
          }
          convergenceIdentity = current.snapshotSha256;
        }
        return convergenceIdentity;
      };

      return {...prepared,approvedGeneration:phase.generation,approvalStabilityGuard};
    },
    async commit(context,prepared) {
      const {root,config,workflow,phase,session,receipt}=context;
      const {approvalAuthority,decisions,evidence,witnessRecords,checklist,witnessMappings,bindingDecisions,presence,approvalStabilityGuard}=prepared;
      const { value: result, publication } = await withRefusalMemory(root, {
        operation: 'approve', workId: workflow.workItem.id, phase: phase.id, actor: actorKey(session.actor),
        args: [checklist ?? null, witnessMappings ?? null, bindingDecisions, evidence ? evidence.confirm.map((entry) => `${entry.clauseId}:${entry.slot.slot}`) : null,
          ...(decisions ? [decisions.steps.map((step) => `${step.item}=${step.option}`)] : [])]
      }, () => transactStory(
        root,
        config,
        workflow,
        {
          type: LIFECYCLE_EVENT.PHASE_APPROVED,
          phaseId: phase.id,
          generation: phase.generation,
          actor: session.actor,
          agent: session.agent,
          authorityGroup: approvalAuthority.authorityGroup
        },
        `[${workflow.workItem.id}][phase:${phase.id}][approve] ${approvalAuthority.authorityGroup}${decisions ? ` with ${decisions.parts.length} decision record${decisions.parts.length === 1 ? '' : 's'}` : ''}`,
        async (aggregate) => withApprovalDecisions(aggregate, decisions, () => {
          // Confirmed evidence is recorded first, so the approval (and a Story's ending) is judged with it.
          if (evidence?.confirm.length) witnessRecords.recordEvidenceConfirmations(aggregate, evidence.confirm, {
            actor: actorKey(session.actor), agent: session.agent, phaseId: phase.id,
            reason: prepared.evidenceReason ?? null, at: new Date().toISOString() });
          return approvePhase(root, config, aggregate, {
          phaseId: phase.id,
          channel: prepared.channel,
          actionContext: prepared.actionContext,
          checklist,
          witnessMappings,
          bindingDecisions,
          actor: session.actor,
          agent: session.agent,
          presence,
          persist: false
        });
        }),
        {
          paths: phase.artifacts.map((item) => item.path),
          eventFromResult: (transition) => ({
            actor: transition.approval.actor,
            agent: transition.approval.agent,
            authorityGroup: transition.approval.authorityGroup,
            identityAssurance: transition.approval.identityAssurance,
            payload: {
              decision: transition.approval.decision,
              reviewPacketSha256: transition.approval.reviewPacketSha256,
              evidenceCommit: transition.approval.evidenceCommit,
              artifactSetSha256: transition.approval.artifactSetSha256,
              witnessMappingsSha256: transition.approval.witnessMappingsSha256 ?? null,
              ...(transition.decisions ? { decisions: transition.decisions } : {})
            }
          }),
          worktreeGuard: approvalStabilityGuard
        }
      ));

      Object.assign(context,{result,publication,prepared});
      return publication;
    },
    async finish(context,prepared,publication) {
      const {root,config,workflow,phase,session,receiptToken,result}=context;
      const {reviewed,approvedGeneration,presenceModule}=prepared;
      // Spent once the approval has actually landed. Consuming it up front — before the confirmation
      // prompt, let alone the publication — meant declining at the prompt or hitting any refusal burned
      // the reviewer's one-shot receipt, and a new one had to be issued before they could try again.
      if (receiptToken) {
        try { await consumeSelectionReceipt(root, receiptToken); }
        catch (error) {
          // The governed decision is already committed and may already be on the remote. Treat receipt
          // cleanup as a local recovery warning so retry cannot strand the reviewer behind an
          // "already approved" refusal after a successful gate transition.
          console.warn(`Warning: approval succeeded, but selection receipt cleanup is pending: ${error.message}`);
        }
      }
      await forgetTerminalReview(root, reviewed, session.actor);
      // Other receipts for this review (another window, an earlier /sf-approve) can never approve it again.
      await removeApprovalReceipts(root, workflow.workItem.id, (receipt) => receipt.approvalContext?.phase === phase.id
        && receipt.approvalContext?.generation === approvedGeneration);
      // Approval may cross a phase boundary. Rebind from the committed aggregate rather than the
      // caller's pre-transaction object so a same-agent transition (for example verification →
      // release) still changes the phase binding, and deterministic convergence clears agent
      // authority instead of inheriting the previous phase's session.
      await postPublicationStep('the next-phase session activation', workflow.workItem.id, async () => {
        const accepted = await loadAcceptedStoryExecution(root, workflow.workItem.id);
        return activateWorkItemSession(root, accepted.config, accepted.workflow);
      }, {notice});
      const receiptsReport = await collectRequiredReceiptsAfterTransition(root, workflow, {notice});
      const usageReport = await collectSpecUsageAfterTransition(root, config, workflow, { phase: result.phase.id, ended: !result.next, notice });

      Object.assign(context,{receiptsReport,usageReport,presenceModule});
      return {workId:workflow.workItem.id,phase:phase.id,generation:approvedGeneration,revision:publication.sha,
        pushed:publication.pushed===true,reviewPacket:result.approval.reviewPacketSha256,
        artifactSet:result.approval.artifactSetSha256,actorId:result.approval.approvedBy,
        authorityGroup:result.approval.authorityGroup,selfApproval:result.approval.selfApproval===true,
        thresholdReached:result.reached!==false,currentPhase:workflow.currentPhase ?? null};
    }
  };
}
