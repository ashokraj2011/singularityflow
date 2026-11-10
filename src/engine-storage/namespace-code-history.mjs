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
import {createNamespaceSourceRetentionReader} from './namespace-source-retention-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),error=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>new SingularityFlowError(message,{code,details});
export function createNamespaceCodeHistoryReader({observer,scope,workId}){
  async function predecessor(scoped,snapshot,phaseId,generation,{signal,policyTraversal}={}){
    const workflow=snapshot.workflow,phase=workflow.phases[phaseId],
      previous=phase.publicationBindings?.filter(row=>row.generation===generation-1),requests=(workflow.changeRequests??[]).filter(row=>row.status==='open'&&row.targetPhase===phaseId);
    if(generation!==phase.generation+1||previous?.length!==1||requests.length!==1||phase.reworkRevalidation?.generation!==phase.generation)throw error(
      'A Code successor needs its exact prior publication and one authenticated return.','ENGINE_CODE_REWORK_REQUIRED');
    const request=requests[0],links=namespaceApprovalReceipts(workflow,{projectId:scope.projectId,workId}).filter(row=>row.phase===request.sourcePhase&&row.generation===request.sourceGeneration);
    const checks=createNamespacePhaseCheckReader({...scoped.evidenceReads,observer:scoped}),packets=createNamespaceSubmissionReader({observer:scoped,scope,workId,checks}),
      votes=createNamespaceApprovalReader({observer:scoped,scope,workId,checks}),publications=createNamespacePublicationReader({observer:scoped,scope,workId,checks}),
      retention=createNamespaceSourceRetentionReader({...scoped.evidenceReads,observer:scoped});let route=null;
    for(const link of [...links].reverse()){
      const binding={schemaVersion:1,format:'sflow-namespace-phase-approval-binding/v1',generation:link.generation,record:link.record},value=await votes.decode(binding,link.phase,{signal});
      if(value.routing?.outcome?.kind!=='loop'||value.routing.outcome.target!==phaseId||value.recordedAt!==request.requestedAt)continue;
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
      if(!same(value.routing.outcome,selected.outcome)||!same(proposed.workflow,accepted.state.workflow)||value.currentPhase!==phaseId)throw error('The Code return does not replay its original human-approved transition.');
      route={binding,value,accepted,before,selected,proof};break;
    }
    if(!route)throw error('A copied change request cannot authorize Code rework.','ENGINE_CODE_REWORK_REQUIRED');
    const {binding,value,accepted,selected,proof}=route,
      actualRequest=accepted.state.workflow.changeRequests?.find(row=>row.id===request.id);
    if(!actualRequest||!same(actualRequest,request)||request.decision?.id!==selected.outcome.decision||request.decision?.round!==selected.outcome.round
      ||request.reviewPacketSha256!==proof.binding.record.sha256||phase.reworkRevalidation.invalidatedAt!==value.recordedAt
      ||!same(accepted.state.workflow.phases[phaseId].reworkRevalidation,phase.reworkRevalidation))throw error('The Code return differs from its original accepted request.');
    const published=await publications.accepted(previous[0],phaseId,{signal,policyTraversal}),code=publications.policies.codeEvidence(published);
    if(!code||code.sources.length!==workflow.sourceBindings?.current?.repositories.length)throw error('The Code predecessor needs its original source-backed policy.','ENGINE_PORT_UNAVAILABLE',{required:['retained-code-policy']});
    const original=await retention.accepted({operationId:code.report.preflight.source.operationId,workId,phaseId},{signal});
    if(!original||original.plan.sourceBinding.operationId!==workflow.sourceBindings?.current?.operationId)throw error('Code rework must retain its original Story source selection.','ENGINE_PORT_UNAVAILABLE',{required:['namespace-code-rework-source-selection']});
    if(!same(original.workflow.sourceBindings.current,workflow.sourceBindings.current))throw error('The Code successor changed its original source selection.');
    return {request,binding,previous:previous[0],code};
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
      const {request,binding,previous,code}=await predecessor(scoped,snapshot,phaseId,verified.plan.generation,{signal,policyTraversal}),workflow=snapshot.workflow,
        definition=(await scoped.approved(snapshot,{signal})).compiled.definition,repositories=[];
      for(const source of current.plan.sources){const earlier=code.sources.find(row=>row.repository.id===source.repository.id);
        if(!earlier||!same(earlier.repository,source.repository))throw error('The Code successor changed its original repository binding.');
        const left=await retention.snapshot(earlier.observed.content,source.repository.descriptor,earlier.observed.revision,signal),
          right=await retention.snapshot(source.observed.content,source.repository.descriptor,source.observed.revision,signal),
          inventory=value=>new Map(sourceBaselineInventory(value,{workflow,definition}).entries.map(row=>[row.path,row])),a=inventory(left),b=inventory(right),changes=[];
        for(const path of [...new Set([...a.keys(),...b.keys()])].sort())if(!same(a.get(path)??null,b.get(path)??null))changes.push({path,before:a.get(path)??null,after:b.get(path)??null});
        repositories.push({id:source.repository.id,previous:earlier.observed,current:source.observed,changes});
      }
      if(!repositories.some(row=>row.changes.length))throw error('An unchanged Code successor needs its explicit revalidation owner.','ENGINE_PORT_UNAVAILABLE',{required:['namespace-code-revalidation']});
      return {profile:'sflow-namespace-code-history/v1',predecessor:{publication:previous,policy:code.binding,report:code.manifest.report},
        return:{approval:binding,request:structuredClone(request)},repositories};
    });
  }
  return Object.freeze({inspect,opening});
}
