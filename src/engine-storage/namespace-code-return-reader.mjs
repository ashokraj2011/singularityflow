/** Authenticate reviewer, routing and upstream returns from original accepted records. Read only. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {principalApprovalPlan} from '../kernel/approval-policy.mjs';
import {planRoutedApproval,routedApprovalSelection} from '../kernel/routed-approval.mjs';
import {createNamespaceSubmissionReader} from './namespace-submission-reader.mjs';
import {createNamespaceApprovalReader} from './namespace-approval-reader.mjs';
import {namespaceApprovalReceipt,namespaceApprovalReceipts,namespaceApprovalDecision} from './namespace-approval-contract.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {namespaceHumanDecisionReceipts} from './namespace-human-decision-contract.mjs';
import {createNamespaceRejectionReader} from './namespace-rejection-reader.mjs';
import {namespaceRoutingChoiceReceipts} from './namespace-routing-choice-contract.mjs';
import {createNamespaceRoutingReceiptReader} from './namespace-routing-receipt-reader.mjs';
import {createNamespaceUpstreamReturnReader,namespaceReturnGenesis} from './namespace-upstream-return-reader.mjs';
import {createNamespaceForwardAmendmentOwners} from './namespace-forward-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),error=(message,code='ENGINE_STORAGE_CORRUPT')=>new SingularityFlowError(message,{code});
export function createNamespaceCodeReturnReader({observer,scope,workId}){
  async function accepted(snapshot,request,phaseId,{signal,policyTraversal,inherited=null,historical=false,includeEarlier=false}={}){
    const workflow=snapshot.workflow,phase=workflow.phases[phaseId],links=namespaceApprovalReceipts(workflow,{projectId:scope.projectId,workId}).filter(row=>row.phase===request.sourcePhase&&row.generation===request.sourceGeneration);
    const checks=createNamespacePhaseCheckReader({...observer.evidenceReads,observer}),packets=createNamespaceSubmissionReader({observer,scope,workId,checks}),
      votes=createNamespaceApprovalReader({observer,scope,workId,checks});let route=null;
    const upstream=await createNamespaceUpstreamReturnReader({observer,scope,workId}).accepted(snapshot,request,{signal,policyTraversal});
    if(upstream)route={...upstream,proof:null};
    if(!route){const amendment=await createNamespaceForwardAmendmentOwners({observer,scope,workId}).returned(snapshot,request,{signal,policyTraversal});
      if(amendment)route={...amendment,proof:null};}
    if(!route)for(const link of [...links].reverse()){
      const binding={schemaVersion:1,format:'sflow-namespace-phase-approval-binding/v1',generation:link.generation,record:link.record},value=await votes.decode(binding,link.phase,{signal});
      if(value.routing?.outcome?.kind!=='loop'||value.routing.outcome.target!==request.targetPhase||value.recordedAt!==request.requestedAt)continue;
      const accepted=await observer.accepted(value.operationId,{signal}),head=accepted.plan.basis.head,
        before=await observer.state(await observer.bytes(head.state,head.state.bytes,signal),head,{signal}),
        basis={revision:accepted.plan.basis.headVersion,configuration:head.configuration,workflow:before.workflow},proof=await packets.inspect(basis,link.phase,{signal,policyTraversal});
      if(!proof)throw error('The Code return lost its original submitted review.');
      await votes.readAccepted(binding,link.phase,proof,{signal,policyTraversal});
      const active=await votes.activeAccepted(basis,link.phase,proof,{signal,policyTraversal}),
        policy=principalApprovalPlan(before.workflow,before.workflow.phases[link.phase],{actor:value.actor,agentId:value.agentId},{author:proof.published.actor,active:active.decisions});
      if(!policy.reached||!value.thresholdReached||policy.authorityGroup!==value.authorityGroup||policy.selfApproval!==value.selfApproval)throw error('The Code return has no original human approval threshold.');
      const selected=routedApprovalSelection(before.workflow,before.workflow.phases[link.phase],{reached:true,at:value.recordedAt}),
        proposed=planRoutedApproval(before.workflow,link.phase,{decision:namespaceApprovalDecision(value,binding),
          reached:true,at:value.recordedAt,actorId:value.actor.principalId,agentId:value.agentId,authorityGroup:value.authorityGroup,outcome:selected.outcome,pending:null});
      proposed.workflow.namespaceApprovalReceipts=[...structuredClone(namespaceApprovalReceipts(before.workflow,{projectId:scope.projectId,workId})),namespaceApprovalReceipt(value,binding)];
      if(!same(value.routing.outcome,selected.outcome)||!same(proposed.workflow,accepted.state.workflow)||value.currentPhase!==request.targetPhase)throw error('The Code return does not replay its original human-approved transition.');
      route={binding,value,accepted,before,selected,proof};break;
    }
    if(!route){
      const choices=createNamespaceRoutingReceiptReader({observer,scope,workId});
      for(const link of namespaceRoutingChoiceReceipts(workflow,{projectId:scope.projectId,workId}).filter(row=>row.phase===request.sourcePhase&&row.generation===request.sourceGeneration).reverse()){
        const value=await choices.decode(link.record,{signal});
        if(value.outcome.kind!=='loop'||value.outcome.target!==request.targetPhase||value.recordedAt!==request.requestedAt)continue;
        const proof=await choices.accepted(link,{signal,policyTraversal});
        route={kind:'choice',binding:{operationId:link.operationId,record:link.record},value,accepted:proof.accepted,
          selected:{outcome:value.outcome},proof:proof.source.proof};break;
      }
    }
    if(!route){
      const returns=createNamespaceRejectionReader({observer,scope,workId});
      for(const link of namespaceHumanDecisionReceipts(workflow).filter(row=>row.operation==='phase.reject'&&row.phase===request.sourcePhase&&row.generation===request.sourceGeneration).reverse()){
        const value=await returns.decode(link.record,{signal});
        if(value.request.target!==request.targetPhase||value.recordedAt!==request.requestedAt)continue;
        const proof=await returns.accepted(link,{signal,policyTraversal});
        route={kind:'rejection',binding:{operationId:link.operationId,record:link.record},value,accepted:proof.accepted,proof};break;
      }
    }
    if(!route)throw error('A copied change request cannot authorize Code rework.','ENGINE_CODE_REWORK_REQUIRED');
    const {binding,value,accepted,selected,proof}=route,actualRequest=accepted.state.workflow.changeRequests?.find(row=>row.id===request.id),
      reviewPacket=['upstream','amendment'].includes(route.kind)?null:route.kind==='rejection'?value.source.reviewPacket.sha256:proof.binding.record.sha256;
    const restored=accepted.state.workflow.phases[phaseId],originalReset=restored?.reworkRevalidation,isEarlier=includeEarlier&&restored?.generation<phase.generation,
      resetMatches=historical||isEarlier?restored?.generation<phase.generation&&originalReset?.generation===restored.generation&&originalReset.invalidatedAt===value.recordedAt
        :phase.reworkRevalidation?.invalidatedAt===value.recordedAt&&same(originalReset,phase.reworkRevalidation);
    if(!actualRequest||!(inherited||historical||isEarlier?same(namespaceReturnGenesis(actualRequest),namespaceReturnGenesis(request)):same(actualRequest,request))
      ||request.reviewPacketSha256!==reviewPacket||!resetMatches
      ||!['rejection','upstream','amendment'].includes(route.kind)&&(request.decision?.id!==selected.outcome.decision||request.decision?.round!==selected.outcome.round))
      throw error('The Code return differs from its original accepted request.');
    return route;
  }
  return Object.freeze({accepted});
}
