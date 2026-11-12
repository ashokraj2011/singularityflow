/** Authenticate a Code successor from the original human-approved loop, never a copied CR flag. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {sourceBaselineInventory} from '../engine-compatibility/node-source-policy.mjs';
import {createNamespacePublicationReader} from './namespace-publication-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {namespaceHumanDecisionReceipts} from './namespace-human-decision-contract.mjs';
import {createNamespaceRejectionReader} from './namespace-rejection-reader.mjs';
import {createNamespaceInitialCodeHistoryReader} from './namespace-code-initial-history.mjs';
import {createNamespaceSourceRetentionReader} from './namespace-source-retention-reader.mjs';
import {createNamespaceTargetedRepairReader} from './namespace-targeted-repair-reader.mjs';
import {assertTargetedCodeRepairDelta,assertArtifactOnlyCodeRepairDelta} from '../kernel/conformance-decisions.mjs';
import {createNamespaceCodeReturnReader} from './namespace-code-return-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),error=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>new SingularityFlowError(message,{code,details});
export function createNamespaceCodeHistoryReader({observer,scope,workId}){
  async function predecessor(scoped,snapshot,phaseId,generation,{signal,policyTraversal}={}){
    const workflow=snapshot.workflow,phase=workflow.phases[phaseId],
      previous=phase.publicationBindings?.filter(row=>row.generation===generation-1);
    let requests=(workflow.changeRequests??[]).filter(row=>row.status==='open'&&row.targetPhase===phaseId),inherited=null;
    if(!requests.length){requests=(workflow.changeRequests??[]).filter(row=>row.status==='resolved'&&workflow.phaseOrder.indexOf(row.targetPhase)<workflow.phaseOrder.indexOf(phaseId)
        &&row.requestedAt===phase.reworkRevalidation?.invalidatedAt);
      if(requests.length===1)inherited=await createNamespaceInitialCodeHistoryReader({observer:scoped,scope,workId}).inspectAffected(snapshot,phaseId,{signal,policyTraversal});}
    const returns=createNamespaceCodeReturnReader({observer:scoped,scope,workId});
    if(requests.length>1&&phase.surgicalReopen?.profile==='sflow-namespace-artifact-reopen/v1'){
      const current=requests.find(row=>row.id===phase.surgicalReopen.changeRequestId);
      if(!current)throw error('The current output return has no matching Code change request.');
      for(const earlier of requests.filter(row=>row!==current))await returns.accepted(snapshot,earlier,phaseId,{signal,policyTraversal,historical:true});
      requests=[current];
    }
    if(generation!==phase.generation+1||previous?.length!==1||requests.length!==1||phase.reworkRevalidation?.generation!==phase.generation)throw error(
      'A Code successor needs its exact prior publication and one authenticated return.','ENGINE_CODE_REWORK_REQUIRED');
    const request=requests[0],route=await returns.accepted(snapshot,request,phaseId,{signal,policyTraversal,inherited}),{binding,value}=route,
      checks=createNamespacePhaseCheckReader({...scoped.evidenceReads,observer:scoped}),publications=createNamespacePublicationReader({observer:scoped,scope,workId,checks}),
      retention=createNamespaceSourceRetentionReader({...scoped.evidenceReads,observer:scoped});
    if(phase.surgicalReopen?.profile==='sflow-namespace-artifact-reopen/v1'&&(!value.source?.artifactRepair
      ||!same(route.accepted.state.workflow.phases[phaseId].surgicalReopen,phase.surgicalReopen)))throw error('The current Code member scope differs from its original human return.');
    const published=await publications.accepted(previous[0],phaseId,{signal,policyTraversal}),code=publications.policies.codeEvidence(published);
    if(!code||code.sources.length!==workflow.sourceBindings?.current?.repositories.length)throw error('The Code predecessor needs its original source-backed policy.','ENGINE_PORT_UNAVAILABLE',{required:['retained-code-policy']});
    const original=await retention.accepted({operationId:code.report.preflight.source.operationId,workId,phaseId},{signal});
    if(!original||original.plan.sourceBinding.operationId!==workflow.sourceBindings?.current?.operationId)throw error('Code rework must retain its original Story source selection.','ENGINE_PORT_UNAVAILABLE',{required:['namespace-code-rework-source-selection']});
    if(!same(original.workflow.sourceBindings.current,workflow.sourceBindings.current))throw error('The Code successor changed its original source selection.');
    return {request,binding,kind:route.kind??'loop',previous:previous[0],code,inherited,upstreamReferences:route.kind==='upstream'?route.references??[]:[],
      targeted:route.kind==='rejection'?value.source.targeted??null:null,artifactRepair:route.kind==='rejection'&&value.source.artifactRepair?.phase===phaseId?value.source.artifactRepair:null};
  }
  async function opening(snapshot,phaseId,{signal,policyTraversal}={}){
    return observer.withReadScope(async scoped=>{
      const prior=await predecessor(scoped,snapshot,phaseId,snapshot.workflow.phases[phaseId].generation+1,{signal,policyTraversal});
      return prior.code.sources.map(source=>({repository:structuredClone(source.repository),observed:structuredClone(source.observed)}));
    });
  }
  /** Read the authenticated scope before authoring; decoding a candidate alone grants no write permission. */
  async function repairScope(snapshot,phaseId,{signal,policyTraversal}={}){
    const workflow=snapshot.workflow,phase=workflow.phases[phaseId];
    if(!phase||phase.generation<1||phase.reworkRevalidation?.generation!==phase.generation)return null;
    const requests=(workflow.changeRequests??[]).filter(row=>row.status==='open'&&row.targetPhase===phaseId),
      returns=createNamespaceRejectionReader({observer,scope,workId});let selected=null;
    for(const request of requests)for(const link of namespaceHumanDecisionReceipts(workflow).filter(row=>row.operation==='phase.reject'
      &&row.phase===request.sourcePhase&&row.generation===request.sourceGeneration).reverse()){
      const value=await returns.decode(link.record,{signal});
      if(value.outcome.changeRequest.id===request.id&&value.source.targeted){selected=request;break;}
    }
    if(!selected)return null;
    return observer.withReadScope(async scoped=>{
      const prior=await predecessor(scoped,snapshot,phaseId,phase.generation+1,{signal,policyTraversal});
      if(!prior.targeted||prior.request.id!==selected.id)throw error('The targeted authoring entry lost its original accepted return.');
      const current=await createNamespaceTargetedRepairReader({observer:scoped,scope,workId}).current(snapshot,phaseId,prior.targeted.scope.clauseIds,
        prior.code.sources.map(row=>row.repository.id),{signal});
      return {profile:'sflow-namespace-targeted-code-entry/v1',phase:phaseId,generation:phase.generation+1,changeRequestId:prior.request.id,
        sourceRecord:prior.binding.record,predecessor:prior.previous,original:prior.targeted.scope,current:current.scope,plan:current.plan,
        references:[...new Map([prior.binding.record,prior.previous.record,prior.targeted.policy.record,prior.targeted.report,...current.references].map(ref=>[canonicalJson(ref),ref])).values()]};
    });
  }
  async function inspect(snapshot,phaseId,current,{signal,policyTraversal}={}){
    return observer.withReadScope(async scoped=>{
      const retention=createNamespaceSourceRetentionReader({...scoped.evidenceReads,observer:scoped}),verified=current?.plan?.input?await retention.accepted(current.plan.input,{signal}):null;
      if(!verified||!same(verified,current))throw error('A Code successor needs its unchanged accepted source archive.');
      const {request,binding,kind,previous,code,inherited,upstreamReferences,targeted,artifactRepair}=await predecessor(scoped,snapshot,phaseId,verified.plan.generation,{signal,policyTraversal}),workflow=snapshot.workflow,
        definition=(await scoped.approved(snapshot,{signal})).compiled.definition,repositories=[];
      for(const source of current.plan.sources){const earlier=code.sources.find(row=>row.repository.id===source.repository.id);
        if(!earlier||!same(earlier.repository,source.repository))throw error('The Code successor changed its original repository binding.');
        const left=await retention.snapshot(earlier.observed.content,source.repository.descriptor,earlier.observed.revision,signal),
          right=await retention.snapshot(source.observed.content,source.repository.descriptor,source.observed.revision,signal),
          inventory=value=>new Map(sourceBaselineInventory(value,{workflow,definition}).entries.map(row=>[row.path,row])),a=inventory(left),b=inventory(right),changes=[];
        for(const path of [...new Set([...a.keys(),...b.keys()])].sort())if(!same(a.get(path)??null,b.get(path)??null))changes.push({path,before:a.get(path)??null,after:b.get(path)??null});
        repositories.push({id:source.repository.id,previous:earlier.observed,current:source.observed,changes});
      }
      let repair=null;
      if(targeted){
        if(targeted.phase!==phaseId||!same(targeted.publication,previous)||!same(targeted.scope.clauseIds,[...request.clauseIds].sort()))throw error('The targeted Code return lost its exact predecessor or clause scope.');
        const selected=await createNamespaceTargetedRepairReader({observer:scoped,scope,workId}).current(snapshot,phaseId,targeted.scope.clauseIds,repositories.map(row=>row.id),{signal});
        assertTargetedCodeRepairDelta(selected.scope,repositories,{workId,phaseId,ownerPhase:selected.plan.phase});repair={source:targeted,scope:selected.scope,plan:selected.plan};
      }
      const changed=repositories.some(row=>row.changes.length),extended=kind==='choice'||!changed;
      const documentRepair=artifactRepair&&!targeted;
      if(documentRepair)assertArtifactOnlyCodeRepairDelta(repositories,{workId,phaseId});
      return {profile:documentRepair?'sflow-namespace-code-history/v9':repair?'sflow-namespace-code-history/v8':inherited?'sflow-namespace-code-history/v7':kind==='upstream'?'sflow-namespace-code-history/v5':extended?'sflow-namespace-code-history/v3':kind==='rejection'?'sflow-namespace-code-history/v2':'sflow-namespace-code-history/v1',
        ...(repair?{targeted:repair}:{}),
        ...(documentRepair?{artifactRepair}:{}),...(repair||extended||inherited||kind==='upstream'?{mode:changed?'changed':'revalidated'}:{}),...(inherited?{returns:inherited.returns}:{}),predecessor:{publication:previous,policy:code.binding,report:code.manifest.report},
        return:{[kind==='upstream'?'upstream':kind==='choice'?'choice':kind==='rejection'?'rejection':'approval']:binding,request:structuredClone(request),...(upstreamReferences.length?{references:upstreamReferences}:{})},repositories};
    });
  }
  return Object.freeze({inspect,opening,repairScope});
}
