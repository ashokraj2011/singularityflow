/** Authenticate a Code successor from the original human-approved loop, never a copied CR flag. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {principalApprovalPlan} from '../kernel/approval-policy.mjs';
import {planRoutedApproval,routedApprovalSelection} from '../kernel/routed-approval.mjs';
import {sourceBaselineInventory} from '../engine-compatibility/node-source-policy.mjs';
import {createNamespaceSubmissionReader} from './namespace-submission-reader.mjs';
import {createNamespacePublicationReader} from './namespace-publication-reader.mjs';
import {createNamespaceApprovalReader} from './namespace-approval-reader.mjs';
import {namespaceApprovalReceipt,namespaceApprovalReceipts,namespaceApprovalDecision} from './namespace-approval-contract.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {namespaceHumanDecisionReceipts} from './namespace-human-decision-contract.mjs';
import {createNamespaceRejectionReader} from './namespace-rejection-reader.mjs';
import {namespaceRoutingChoiceReceipts} from './namespace-routing-choice-contract.mjs';
import {createNamespaceRoutingReceiptReader} from './namespace-routing-receipt-reader.mjs';
import {createNamespaceUpstreamReturnReader,namespaceReturnGenesis} from './namespace-upstream-return-reader.mjs';
import {createNamespaceInitialCodeHistoryReader} from './namespace-code-initial-history.mjs';
import {createNamespaceSourceRetentionReader} from './namespace-source-retention-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),error=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>new SingularityFlowError(message,{code,details});
export function createNamespaceCodeHistoryReader({observer,scope,workId}){
  async function predecessor(scoped,snapshot,phaseId,generation,{signal,policyTraversal}={}){
    const workflow=snapshot.workflow,phase=workflow.phases[phaseId],
      previous=phase.publicationBindings?.filter(row=>row.generation===generation-1);
    let requests=(workflow.changeRequests??[]).filter(row=>row.status==='open'&&row.targetPhase===phaseId),inherited=null;
    if(!requests.length){requests=(workflow.changeRequests??[]).filter(row=>row.status==='resolved'&&workflow.phaseOrder.indexOf(row.targetPhase)<workflow.phaseOrder.indexOf(phaseId)
        &&row.requestedAt===phase.reworkRevalidation?.invalidatedAt);
      if(requests.length===1)inherited=await createNamespaceInitialCodeHistoryReader({observer:scoped,scope,workId}).inspectAffected(snapshot,phaseId,{signal,policyTraversal});}
    if(generation!==phase.generation+1||previous?.length!==1||requests.length!==1||phase.reworkRevalidation?.generation!==phase.generation)throw error(
      'A Code successor needs its exact prior publication and one authenticated return.','ENGINE_CODE_REWORK_REQUIRED');
    const request=requests[0],links=namespaceApprovalReceipts(workflow,{projectId:scope.projectId,workId}).filter(row=>row.phase===request.sourcePhase&&row.generation===request.sourceGeneration);
    const checks=createNamespacePhaseCheckReader({...scoped.evidenceReads,observer:scoped}),packets=createNamespaceSubmissionReader({observer:scoped,scope,workId,checks}),
      votes=createNamespaceApprovalReader({observer:scoped,scope,workId,checks}),publications=createNamespacePublicationReader({observer:scoped,scope,workId,checks}),
      retention=createNamespaceSourceRetentionReader({...scoped.evidenceReads,observer:scoped});let route=null;
    const upstream=await createNamespaceUpstreamReturnReader({observer:scoped,scope,workId}).accepted(snapshot,request,{signal,policyTraversal});
    if(upstream)route={...upstream,proof:null};
    if(!route)for(const link of [...links].reverse()){
      const binding={schemaVersion:1,format:'sflow-namespace-phase-approval-binding/v1',generation:link.generation,record:link.record},value=await votes.decode(binding,link.phase,{signal});
      if(value.routing?.outcome?.kind!=='loop'||value.routing.outcome.target!==request.targetPhase||value.recordedAt!==request.requestedAt)continue;
      const accepted=await scoped.accepted(value.operationId,{signal}),head=accepted.plan.basis.head,
        before=await scoped.state(await scoped.bytes(head.state,head.state.bytes,signal),head,{signal}),
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
      const choices=createNamespaceRoutingReceiptReader({observer:scoped,scope,workId});
      for(const link of namespaceRoutingChoiceReceipts(workflow,{projectId:scope.projectId,workId}).filter(row=>row.phase===request.sourcePhase&&row.generation===request.sourceGeneration).reverse()){
        const value=await choices.decode(link.record,{signal});
        if(value.outcome.kind!=='loop'||value.outcome.target!==request.targetPhase||value.recordedAt!==request.requestedAt)continue;
        const proof=await choices.accepted(link,{signal,policyTraversal});
        route={kind:'choice',binding:{operationId:link.operationId,record:link.record},value,accepted:proof.accepted,
          selected:{outcome:value.outcome},proof:proof.source.proof};break;
      }
    }
    if(!route){
      const returns=createNamespaceRejectionReader({observer:scoped,scope,workId});
      for(const link of namespaceHumanDecisionReceipts(workflow).filter(row=>row.operation==='phase.reject'&&row.phase===request.sourcePhase&&row.generation===request.sourceGeneration).reverse()){
        const value=await returns.decode(link.record,{signal});
        if(value.request.target!==request.targetPhase||value.recordedAt!==request.requestedAt)continue;
        const proof=await returns.accepted(link,{signal,policyTraversal});
        route={kind:'rejection',binding:{operationId:link.operationId,record:link.record},value,accepted:proof.accepted,proof};break;
      }
    }
    if(!route)throw error('A copied change request cannot authorize Code rework.','ENGINE_CODE_REWORK_REQUIRED');
    const {binding,value,accepted,selected,proof}=route,actualRequest=accepted.state.workflow.changeRequests?.find(row=>row.id===request.id),
      reviewPacket=route.kind==='upstream'?null:route.kind==='rejection'?value.source.reviewPacket.sha256:proof.binding.record.sha256;
    if(!actualRequest||!(inherited?same(namespaceReturnGenesis(actualRequest),namespaceReturnGenesis(request)):same(actualRequest,request))||request.reviewPacketSha256!==reviewPacket||phase.reworkRevalidation.invalidatedAt!==value.recordedAt
      ||!same(accepted.state.workflow.phases[phaseId].reworkRevalidation,phase.reworkRevalidation)
      ||!['rejection','upstream'].includes(route.kind)&&(request.decision?.id!==selected.outcome.decision||request.decision?.round!==selected.outcome.round))throw error('The Code return differs from its original accepted request.');
    const published=await publications.accepted(previous[0],phaseId,{signal,policyTraversal}),code=publications.policies.codeEvidence(published);
    if(!code||code.sources.length!==workflow.sourceBindings?.current?.repositories.length)throw error('The Code predecessor needs its original source-backed policy.','ENGINE_PORT_UNAVAILABLE',{required:['retained-code-policy']});
    const original=await retention.accepted({operationId:code.report.preflight.source.operationId,workId,phaseId},{signal});
    if(!original||original.plan.sourceBinding.operationId!==workflow.sourceBindings?.current?.operationId)throw error('Code rework must retain its original Story source selection.','ENGINE_PORT_UNAVAILABLE',{required:['namespace-code-rework-source-selection']});
    if(!same(original.workflow.sourceBindings.current,workflow.sourceBindings.current))throw error('The Code successor changed its original source selection.');
    return {request,binding,kind:route.kind??'loop',previous:previous[0],code,inherited,upstreamReferences:upstream?.references??[]};
  }
  async function opening(snapshot,phaseId,{signal,policyTraversal}={}){
    return observer.withReadScope(async scoped=>{
      const prior=await predecessor(scoped,snapshot,phaseId,snapshot.workflow.phases[phaseId].generation+1,{signal,policyTraversal});
      return prior.code.sources.map(source=>({repository:structuredClone(source.repository),observed:structuredClone(source.observed)}));
    });
  }
  async function inspect(snapshot,phaseId,current,{signal,policyTraversal}={}){
    return observer.withReadScope(async scoped=>{
      const retention=createNamespaceSourceRetentionReader({...scoped.evidenceReads,observer:scoped}),verified=current?.plan?.input?await retention.accepted(current.plan.input,{signal}):null;
      if(!verified||!same(verified,current))throw error('A Code successor needs its unchanged accepted source archive.');
      const {request,binding,kind,previous,code,inherited,upstreamReferences}=await predecessor(scoped,snapshot,phaseId,verified.plan.generation,{signal,policyTraversal}),workflow=snapshot.workflow,
        definition=(await scoped.approved(snapshot,{signal})).compiled.definition,repositories=[];
      for(const source of current.plan.sources){const earlier=code.sources.find(row=>row.repository.id===source.repository.id);
        if(!earlier||!same(earlier.repository,source.repository))throw error('The Code successor changed its original repository binding.');
        const left=await retention.snapshot(earlier.observed.content,source.repository.descriptor,earlier.observed.revision,signal),
          right=await retention.snapshot(source.observed.content,source.repository.descriptor,source.observed.revision,signal),
          inventory=value=>new Map(sourceBaselineInventory(value,{workflow,definition}).entries.map(row=>[row.path,row])),a=inventory(left),b=inventory(right),changes=[];
        for(const path of [...new Set([...a.keys(),...b.keys()])].sort())if(!same(a.get(path)??null,b.get(path)??null))changes.push({path,before:a.get(path)??null,after:b.get(path)??null});
        repositories.push({id:source.repository.id,previous:earlier.observed,current:source.observed,changes});
      }
      const changed=repositories.some(row=>row.changes.length),extended=kind==='choice'||!changed;
      return {profile:inherited?'sflow-namespace-code-history/v7':kind==='upstream'?'sflow-namespace-code-history/v5':extended?'sflow-namespace-code-history/v3':kind==='rejection'?'sflow-namespace-code-history/v2':'sflow-namespace-code-history/v1',
        ...(extended||inherited||kind==='upstream'?{mode:changed?'changed':'revalidated'}:{}),...(inherited?{returns:inherited.returns}:{}),predecessor:{publication:previous,policy:code.binding,report:code.manifest.report},
        return:{[kind==='upstream'?'upstream':kind==='choice'?'choice':kind==='rejection'?'rejection':'approval']:binding,request:structuredClone(request),...(upstreamReferences.length?{references:upstreamReferences}:{})},repositories};
    });
  }
  return Object.freeze({inspect,opening});
}
