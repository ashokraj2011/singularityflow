/** Authenticate first Code execution after real earlier returns and human reapproval. Read only. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {principalApprovalPlan} from '../kernel/approval-policy.mjs';
import {routedApprovalSelection,planRoutedApproval} from '../kernel/routed-approval.mjs';
import {resolvePhaseChangeRequests} from '../kernel/lifecycle-transitions.mjs';
import {createNamespaceSubmissionReader} from './namespace-submission-reader.mjs';
import {createNamespaceApprovalReader} from './namespace-approval-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {createNamespaceRejectionReader} from './namespace-rejection-reader.mjs';
import {createNamespaceRoutingReceiptReader} from './namespace-routing-receipt-reader.mjs';
import {namespaceHumanDecisionReceipts} from './namespace-human-decision-contract.mjs';
import {namespaceRoutingChoiceReceipts} from './namespace-routing-choice-contract.mjs';
import {namespaceApprovalReceipts,namespaceApprovalReceipt,namespaceApprovalDecision} from './namespace-approval-contract.mjs';
import {createNamespaceUpstreamReturnReader} from './namespace-upstream-return-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),
  corrupt=()=>{throw new SingularityFlowError('Initial Code history must replay its real return and original human reapproval.',{code:'ENGINE_STORAGE_CORRUPT'});};
function genesis(request){const {status,resolution,resolvedAt,resolvedBy,...value}=request;return value;}
export function createNamespaceInitialCodeHistoryReader({observer,scope,workId}){
  async function inspect(snapshot,phaseId,{signal,policyTraversal}={}){
    if(snapshot.workflow.phases[phaseId]?.generation!==0)throw new SingularityFlowError('Initial history belongs to the first Code generation.',{code:'ENGINE_INPUT_INVALID'});
    return inspectReturns(snapshot,phaseId,{signal,policyTraversal});
  }
  async function inspectReturns(snapshot,phaseId,{signal,policyTraversal}={}){
    const requests=snapshot.workflow.changeRequests??[];if(!requests.length)return null;
    if(requests.length>64)throw new SingularityFlowError('Initial Code history exceeds its bounded replay inventory.',{code:'ENGINE_STORAGE_LIMIT'});
    if(new Set(requests.map(row=>row.id)).size!==requests.length)corrupt();
    return observer.withReadScope(async scoped=>{
      const checks=createNamespacePhaseCheckReader({...scoped.evidenceReads,observer:scoped}),
        packets=createNamespaceSubmissionReader({observer:scoped,scope,workId,checks}),votes=createNamespaceApprovalReader({observer:scoped,scope,workId,checks}),
        rejections=createNamespaceRejectionReader({observer:scoped,scope,workId}),choices=createNamespaceRoutingReceiptReader({observer:scoped,scope,workId}),
        workflow=snapshot.workflow,returns=[],upstream=createNamespaceUpstreamReturnReader({observer:scoped,scope,workId});
      async function originalVote(link){
        const binding=link.record?{schemaVersion:1,format:'sflow-namespace-phase-approval-binding/v1',generation:link.generation,record:link.record}:link.namespaceVote,
          phase=link.phase,value=await votes.decode(binding,phase,{signal}),accepted=await scoped.accepted(value.operationId,{signal}),head=accepted.plan.basis.head,
          state=await scoped.state(await scoped.bytes(head.state,head.state.bytes,signal),head,{signal}),
          basis={revision:accepted.plan.basis.headVersion,configuration:head.configuration,workflow:state.workflow},
          proof=await packets.inspect(basis,phase,{signal,policyTraversal});
        if(!proof)corrupt();const admitted=await votes.readAccepted(binding,phase,proof,{signal,policyTraversal});
        const active=await votes.activeAccepted(basis,phase,proof,{signal,policyTraversal}),policy=principalApprovalPlan(state.workflow,state.workflow.phases[phase],
          {actor:value.actor,agentId:value.agentId},{author:proof.published.actor,active:active.decisions});
        if(!policy.reached||!value.thresholdReached||policy.authorityGroup!==value.authorityGroup||policy.selfApproval!==value.selfApproval)corrupt();
        return {binding,value:admitted,accepted,basis,proof};
      }
      for(const request of requests){
        if(signal?.aborted)throw new SingularityFlowError('Initial Code history was cancelled.',{code:'ENGINE_OPERATION_CANCELLED'});
        let origin=await upstream.accepted(snapshot,request,{signal,policyTraversal});
        if(!origin)for(const link of namespaceHumanDecisionReceipts(workflow).filter(row=>row.operation==='phase.reject'&&row.phase===request.sourcePhase&&row.generation===request.sourceGeneration)){
          const value=await rejections.decode(link.record,{signal});if(value.recordedAt!==request.requestedAt||value.request.target!==request.targetPhase)continue;
          const proof=await rejections.accepted(link,{signal,policyTraversal});
          if(!same(genesis(proof.value.outcome.changeRequest),genesis(request)))continue;
          origin={kind:'rejection',binding:{operationId:link.operationId,record:link.record},accepted:proof.accepted,references:[link.record,...proof.source.references]};break;
        }
        if(!origin)for(const link of namespaceRoutingChoiceReceipts(workflow,{projectId:scope.projectId,workId}).filter(row=>row.phase===request.sourcePhase&&row.generation===request.sourceGeneration)){
          const value=await choices.decode(link.record,{signal});if(value.recordedAt!==request.requestedAt||value.outcome.kind!=='loop'||value.outcome.target!==request.targetPhase)continue;
          const proof=await choices.accepted(link,{signal,policyTraversal}),original=proof.accepted.state.workflow.changeRequests?.find(row=>row.id===request.id);
          if(!original||!same(genesis(original),genesis(request)))continue;
          origin={kind:'choice',binding:{operationId:link.operationId,record:link.record},accepted:proof.accepted,references:[link.record,...proof.source.references]};break;
        }
        if(!origin)for(const link of namespaceApprovalReceipts(workflow,{projectId:scope.projectId,workId}).filter(row=>row.phase===request.sourcePhase&&row.generation===request.sourceGeneration)){
          const value=await votes.decode({schemaVersion:1,format:'sflow-namespace-phase-approval-binding/v1',generation:link.generation,record:link.record},link.phase,{signal});
          if(value.recordedAt!==request.requestedAt||value.routing?.outcome?.kind!=='loop'||value.routing.outcome.target!==request.targetPhase)continue;
          const proof=await originalVote(link),selected=routedApprovalSelection(proof.basis.workflow,proof.basis.workflow.phases[link.phase],{reached:true,at:value.recordedAt}),
            proposed=planRoutedApproval(proof.basis.workflow,link.phase,{decision:namespaceApprovalDecision(value,proof.binding),reached:true,at:value.recordedAt,
              actorId:value.actor.principalId,agentId:value.agentId,authorityGroup:value.authorityGroup,outcome:selected.outcome,pending:null});
          proposed.workflow.namespaceApprovalReceipts=[...structuredClone(namespaceApprovalReceipts(proof.basis.workflow,{projectId:scope.projectId,workId})),namespaceApprovalReceipt(value,proof.binding)];
          const original=proof.accepted.state.workflow.changeRequests?.find(row=>row.id===request.id);
          if(!same(proposed.workflow,proof.accepted.state.workflow)||!original||!same(genesis(original),genesis(request)))corrupt();
          origin={kind:'approval',binding:{operationId:link.operationId,record:link.record},accepted:proof.accepted,references:[link.record,proof.proof.binding.record,...votes.evidence(proof.value)]};break;
        }
        if(!origin)corrupt();const original=origin.accepted.state.workflow.changeRequests?.find(row=>row.id===request.id);if(!original)corrupt();
        let resolution=null,references=[...origin.references];
        if(request.status==='open'){
          if(request.targetPhase!==phaseId||!same(request,original)||!same(workflow.phases[phaseId].reworkRevalidation,
            origin.accepted.state.workflow.phases[phaseId].reworkRevalidation))corrupt();
        }else{
          if(request.status!=='resolved'||request.resolution?.phase!==request.targetPhase||request.resolution.approvalDecisionAt!==request.resolvedAt)corrupt();
          const candidates=[...namespaceApprovalReceipts(workflow,{projectId:scope.projectId,workId}),
            ...(workflow.phases[request.targetPhase]?.approvals??[]).filter(row=>row.namespaceVote).map(row=>({...row,phase:request.targetPhase}))]
            .filter(row=>row.phase===request.targetPhase&&row.generation===request.resolution.generation);
          let matched=null;
          for(const link of candidates){const binding=link.record?{schemaVersion:1,format:'sflow-namespace-phase-approval-binding/v1',generation:link.generation,record:link.record}:link.namespaceVote,
            value=await votes.decode(binding,link.phase,{signal});
            if(value.recordedAt!==request.resolvedAt||value.actor.principalId!==request.resolvedBy||!value.thresholdReached)continue;
            const proof=await originalVote(link),proposed=structuredClone(proof.basis.workflow);
            resolvePhaseChangeRequests(proposed,proposed.phases[request.targetPhase],{at:value.recordedAt,actor:value.actor.principalId});
            if(!same(proposed.changeRequests?.find(row=>row.id===request.id),request)
              ||!same(proof.accepted.state.workflow.changeRequests?.find(row=>row.id===request.id),request))corrupt();
            matched=proof;break;
          }
          if(!matched)corrupt();resolution={phase:request.targetPhase,generation:request.resolution.generation,
            approval:matched.binding,reviewPacket:matched.proof.binding.record};
          references.push(matched.binding.record,matched.proof.binding.record,...votes.evidence(matched.value));
        }
        returns.push({request:structuredClone(request),kind:origin.kind,binding:origin.binding,resolution,
          references:[...new Map(references.map(row=>[canonicalJson(row),row])).values()]});
      }
      return {profile:returns.some(row=>row.kind==='upstream')?'sflow-namespace-code-history/v6':'sflow-namespace-code-history/v4',mode:'initial',returns};
    });
  }
  return Object.freeze({inspect,inspectAffected:inspectReturns});
}
