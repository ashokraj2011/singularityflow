/** Exact approved plan and human amendment proof. Reads never acquire a writer or a checkout. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {sourceSnapshot} from '../foundation/source-snapshot.mjs';
import {standaloneDecisionAdmission} from '../kernel/decision-plan.mjs';
import {requireApprovalAuthority} from '../kernel/approval-policy.mjs';
import {mergePlannedClaimRecords} from '../kernel/specification-policy.mjs';
import {planDecisions} from '../engine-compatibility/node-plan-policy.mjs';
import {repositoryPlanTestLocation} from '../engine-compatibility/node-repository-plan.mjs';
import {createNamespaceSpecificationReader} from './namespace-specifications.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {createNamespaceSourceObservations} from './namespace-source-observations.mjs';
import {createNamespaceRecordedMutationReader} from './namespace-recorded-mutation-reader.mjs';
import {namespaceDecisionContract,namespaceDecisionReceipts} from './namespace-decision-contract.mjs';
const operation='decision.plan',same=(a,b)=>canonicalJson(a)===canonicalJson(b),hash=value=>createHash('sha256').update(value).digest('hex'),
  error=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>new SingularityFlowError(message,{code,details});
export function createNamespacePlanDecisionOwners({observer,scope,workId,sources=[]}){
  const checks=createNamespacePhaseCheckReader({...observer.evidenceReads,observer}),observations=createNamespaceSourceObservations({observer,scope,sources});
  let reader;
  async function admitted(snapshot,{signal,policyTraversal}={}){
    const rows=snapshot.workflow.planAmendments??[],links=namespaceDecisionReceipts(snapshot.workflow).filter(row=>row.operation===operation);
    if(!Array.isArray(rows)||links.length>64)throw error('The accepted plan amendment inventory exceeds its contract.','ENGINE_STORAGE_LIMIT');
    if(!links.length){if(rows.length)throw error('Plan amendments have no accepted human receipts.');return {rows:[],links:[],references:[]};}
    const last=await reader.accepted(links.at(-1),{signal,policyTraversal});
    if(!same(rows,last.accepted.state.workflow.planAmendments))throw error('The plan amendment list differs from its last human transition.');
    // Each prior record is authenticated while replaying that transition's original prefix.
    return {rows,links,references:links.map(row=>row.record)};
  }
  async function basePlans(snapshot,{signal}={}){
    const workflow=snapshot.workflow,owners=workflow.resolution?.plannedClaims?.owners??{},seen=new Set(),values=[],
      specifications=createNamespaceSpecificationReader({observer,scope,workId,checks});
    for(const codeId of workflow.phaseOrder){const owner=owners[codeId],phase=workflow.phases[owner];
      if(!owner||seen.has(owner)||phase?.status!=='approved'||phase.generation<1)continue;seen.add(owner);
      const value=await specifications.sourcePlan(snapshot,codeId,{signal,includeAmendments:false});values.push({codeId,...value});}
    if(!values.length)throw error('This Story has no approved planning input to amend.','SPEC_PLANNED_CLAIM_MAP_REQUIRED');
    const references=values.flatMap(row=>[row.proof.publication,row.proof.reviewPacket,row.proof.planned,
      ...row.proof.indices.map(item=>item.record),...(row.proof.repositoryPlan?[row.proof.repositoryPlan]:[])]);
    return {values,plan:mergePlannedClaimRecords(values.map(row=>row.planned)),references};
  }
  async function observedSource(snapshot,plans,changes,bound,signal){
    const selected=snapshot.workflow.sourceBindings?.current;
    if(!selected){if(bound?.observations?.length)throw error('The original plan had no bound source selection.');return {rows:[],references:[],pendingEvidence:[],contentHashes:{}};}
    const accepted=await observations.binding(selected.operationId,signal);
    if(!same(accepted.selected,selected))throw error('The plan source selection differs from its accepted transaction.');
    const rows=[],references=[],pendingEvidence=[],contentHashes={},captured=new Map();
    if(bound&&(!Array.isArray(bound.observations)||bound.observations.length!==selected.repositories.length))throw error('The plan decision lost a source observation.');
    for(const repository of selected.repositories){
      let snapshot,reference,revision;
      if(bound){const retained=bound.observations.find(row=>row.id===repository.id);
        if(!retained||!same(retained.descriptor,repository.descriptor))throw error('A plan source observation has another repository.');
        if(retained.content?.namespace!=='evidence')throw error('The original amendment source needs shared snapshot evidence.');
        const bytes=await observer.bytes(retained.content,retained.content.bytes,signal);
        try{snapshot=sourceSnapshot(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),repository.descriptor);}catch(cause){
          throw new SingularityFlowError('The retained plan source snapshot is invalid.',{code:'ENGINE_STORAGE_CORRUPT',cause});}
        reference=retained.content;revision='sha256:'+hash(canonicalJson(snapshot));if(retained.revision!==revision)throw error('The plan source revision has another digest.');
      }else{const actual=await observations.capture(repository,signal);snapshot=actual.snapshot;revision=actual.revision;
        const bytes=Buffer.from(canonicalJson(snapshot));reference={namespace:'evidence',sha256:hash(bytes),bytes:bytes.byteLength};pendingEvidence.push({reference,bytes});}
      rows.push({id:repository.id,descriptor:repository.descriptor,revision,content:reference});references.push(reference);captured.set(repository.id,snapshot);
    }
    for(const change of changes){
      const declared=plans.values.map(row=>row.repositoryPlan).find(Boolean),location=declared?repositoryPlanTestLocation(declared,change.path,{workflow:snapshot.workflow}):null;
      if(!declared&&selected.repositories.length!==1)throw error('A multi-repository amendment needs an approved repository-qualified plan.','ENGINE_PORT_UNAVAILABLE',{required:['repository-qualified-plan-amendment']});
      const id=location?.repositoryId??selected.repositories[0].id,path=location?.path??change.path,entry=captured.get(id)?.entries.find(row=>row.path===path);
      if(declared&&!location)throw error('The amended path is outside the approved repository roots.','PLAN_AMENDMENT_INVALID',{path:change.path});
      if(entry)contentHashes[change.path]=entry.sha256;
    }
    return {rows,references,pendingEvidence,contentHashes};
  }
  const owner={
    async read(snapshot,request,{signal,bound,policyTraversal}={}){
      const prior=await admitted(snapshot,{signal,policyTraversal}),plans=await basePlans(snapshot,{signal}),phase=snapshot.workflow.phases[request.phaseId];
      if(!phase)throw error('The amendment has another phase binding.','ENGINE_PHASE_UNAVAILABLE');
      // Validate and normalize exact paths before asking an execution port to observe them.
      const normalized=planDecisions.recordPlanAmendment(structuredClone(snapshot.workflow),{changes:request.changes,reason:request.reason,plan:plans.plan}).changes,
        observed=await observedSource(snapshot,plans,normalized,bound,signal),identity={profile:'sflow-namespace-plan-amendment-source/v1',
          plans:plans.values.map(row=>row.proof),observations:observed.rows,contentHashes:observed.contentHashes};
      if(bound&&!same(bound,identity))throw error('The amendment no longer replays its original planning and source inputs.');
      return {generation:phase.generation,identity,plan:plans.plan,references:[...prior.references,...plans.references,...observed.references],pendingEvidence:observed.pendingEvidence};
    },
    async fresh(snapshot,_request,source,{signal}={}){
      const selected=snapshot.workflow.sourceBindings?.current;
      for(const row of source.identity.observations){const repository=selected?.repositories.find(item=>item.id===row.id);
        if(!repository||!same(repository.descriptor,row.descriptor))throw error('The amendment source selection changed.','ENGINE_CONTEXT_CHANGED');
        const current=await observations.capture(repository,signal);if(current.revision!==row.revision)throw error(
          'The source changed after the human reviewed this plan amendment. Review the current files and use a new operation ID.','ENGINE_SOURCE_CHANGED',{
            repositoryId:row.id,expected:row.revision,observed:current.revision,requiredInputs:['operationId']});}
    },
    authority(workflow,_request,actor){const groups=planDecisions.planAuthorities(workflow);
      if(!groups.length)throw error('This Story has no authorized planning reviewer.','PLAN_AMENDMENT_AUTHORITY_UNAVAILABLE');
      return requireApprovalAuthority(workflow.resolution.approvalAuthorities,{mode:'required',authorities:groups,requiredAuthorities:[],minimum:1},actor.identity).authorityGroup;},
    plan(workflow,request,facts,source){standaloneDecisionAdmission(operation,workflow);
      if(request.phaseId!==workflow.currentPhase)throw error('The amendment has another current-phase binding.','ENGINE_CONTEXT_CHANGED');
      const proposed=structuredClone(workflow),record=planDecisions.recordPlanAmendment(proposed,{...request,plan:source.plan,contentHashes:source.identity.contentHashes,
        actor:facts.actorId,authorityGroup:facts.authorityGroup,identityAssurance:null,at:facts.at});
      proposed.history.push({at:facts.at,actor:facts.actorId,agent:facts.agentId,event:'plan_amended',phase:workflow.currentPhase,
        detail:record.id+': '+record.changes.map(change=>change.kind==='add-location'?change.path+' added to '+change.clauseId:change.path+' listed as '+change.class).join('; ')+'. '+record.reason});
      return {workflow:proposed,outcome:{currentPhase:workflow.currentPhase,record}};
    }
  };
  reader=createNamespaceRecordedMutationReader({observer,scope,workId,operation,owner,contract:namespaceDecisionContract});
  async function projection(snapshot,options){const value=await admitted(snapshot,options),record=planDecisions.planAmendmentRecord(snapshot.workflow,value.rows);
    return {record,rows:value.rows,receipts:value.links,references:value.references};}
  return Object.freeze({owner,reader,projection});
}
