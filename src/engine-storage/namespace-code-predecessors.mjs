/** Earlier Code is carried only from its actual publication, independent approval and unchanged archived inputs. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {phaseRequiresCodeDelivery} from '../kernel/phase-policy.mjs';
import {changedApprovedSourceInputs} from '../kernel/source-changes.mjs';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
import {sourceBaselineInventory} from '../engine-compatibility/node-source-policy.mjs';
import {repositoryPlanProjection,repositoryPlanAmendmentProjection} from '../engine-compatibility/node-repository-plan.mjs';
import {createNamespaceSubmissionReader} from './namespace-submission-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {createNamespaceSourceRetentionReader} from './namespace-source-retention-reader.mjs';
import {createNamespaceSpecificationReader} from './namespace-specifications.mjs';
import {memoNamespaceObservedCodePredecessors} from './namespace-story-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),error=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>new SingularityFlowError(message,{code,details});
export function createNamespaceCodePredecessorReader({observer,scope,workId}){
  async function inspect(snapshot,phaseId,current,{signal,policyTraversal}={}){
    const workflow=snapshot.workflow,ids=workflow.phaseOrder.slice(0,workflow.phaseOrder.indexOf(phaseId))
      .filter(id=>phaseRequiresCodeDelivery(workflow.phases[id])&&workflow.phases[id].generation>0&&workflow.phases[id].status!=='skipped');
    if(!ids.length)return null;
    if(ids.length>32)throw error('Earlier Code exceeds its bounded proof inventory.','ENGINE_STORAGE_LIMIT');
    const identity={phase:phaseId,revision:snapshot.revision,configuration:snapshot.configuration,
      workflowSha256:NODE_TEXT_DIGESTS.sha256Utf8(canonicalJson(workflow)),sourceSha256:current?NODE_TEXT_DIGESTS.sha256Utf8(canonicalJson(current)):null};
    return memoNamespaceObservedCodePredecessors(observer,identity,()=>observer.withReadScope(async scoped=>{
      const options={...scoped.evidenceReads,observer:scoped},checks=createNamespacePhaseCheckReader(options),
        packets=createNamespaceSubmissionReader({observer:scoped,scope,workId,checks}),retention=createNamespaceSourceRetentionReader(options),
        plans=createNamespaceSpecificationReader({observer:scoped,scope,workId,checks}),definition=(await scoped.approved(snapshot,{signal})).compiled.definition,
        proofs=await packets.inspectApprovedMany(snapshot,ids,{signal,policyTraversal}),phases=[];
      if(current){const actual=await retention.accepted(current.plan.input,{signal});
        if(!actual||!same(actual,current))throw error('Earlier claims need the actual accepted current source proof.','ENGINE_INPUT_INVALID');}
      for(const [position,id]of ids.entries()){
        if(signal?.aborted)throw error('Earlier Code inspection was cancelled.','ENGINE_OPERATION_CANCELLED');
        const proof=proofs[position],code=proof&&packets.publicationCodeEvidence(proof.published);
        if(!code)throw error('Earlier Code needs its actual approved source and execution proof.','ENGINE_PORT_UNAVAILABLE',{
          required:['retained-code-policy'],phase:id,actions:[{operation:'phase.review',inputs:{workId,phaseId:id}}]});
        const plan=await plans.sourcePlan(snapshot,id,{signal}),repositories=[];
        for(const source of code.sources){
          const selected=current?.plan.sources.find(row=>row.repository.id===source.repository.id)
            ??{repository:workflow.sourceBindings?.current?.repositories?.find(row=>row.id===source.repository.id)};
          if(!selected?.repository||!same(selected.repository.descriptor,source.repository.descriptor))throw error('A later Code phase cannot carry another repository selection.',
            'ENGINE_PRIOR_CODE_SOURCE_REQUIRED',{phase:phaseId,sourcePhase:id,repositoryId:source.repository.id});
          const report=code.report.repositories.find(row=>row.id===source.repository.id),delivery=code.report.preflight.repositories.find(row=>row.id===source.repository.id)?.delivery;
          if(!report?.observed||!delivery)throw error('Earlier Code lost its actual observed claims or delivered paths.');
          const before=await retention.snapshot(source.observed.content,source.repository.descriptor,source.observed.revision,signal),
            after=current?await retention.snapshot(selected.observed.content,selected.repository.descriptor,selected.observed.revision,signal):before,
            inventory=value=>sourceBaselineInventory(value,{definition,workflow}).entries,
            changed=changedApprovedSourceInputs(inventory(before),inventory(after),{absentPaths:delivery.paths.filter(row=>row.exists===false).map(row=>row.path)});
          if(changed.length)throw error('Previously approved application inputs changed; obtain their actual owner revalidation before carrying those claims.',
            'ENGINE_PRIOR_CODE_REVALIDATION_REQUIRED',{phase:phaseId,sourcePhase:id,repositoryId:source.repository.id,paths:changed,
              actions:[{operation:'upstream.raise',inputs:{workId,phaseId:id,about:'changed approved inputs in '+source.repository.id,
                problem:'Previously approved input '+source.repository.id+'/'+changed[0]+' changed before a later Code phase. Revalidate its original source and execution.'
                  +(changed.length>1?' There are '+(changed.length-1)+' additional changed inputs.':''),proposed:'return'},
                requiredInputs:['operationId']}]});
          repositories.push({id:source.repository.id,descriptor:source.repository.descriptor,observed:structuredClone(report.observed),
            source:{revision:source.observed.revision,content:source.observed.content},paths:structuredClone(delivery.paths)});
        }
        const approvals=(workflow.phases[id].approvals??[]).filter(row=>row.decision==='approved'&&!row.invalidatedAt&&row.generation===proof.value.generation).map(row=>row.namespaceVote);
        if(!approvals.length||approvals.some(row=>!row))throw error('Earlier Code has no exact retained human approval.');
        const references=[proof.value.publication.record,proof.binding.record,...approvals.map(row=>row.record),
          ...packets.publicationPolicyEvidence(proof.published),...plan.proof.indices.map(row=>row.record),plan.proof.planned,
          ...(plan.proof.repositoryPlan?[plan.proof.repositoryPlan]:[]),...(plan.proof.amendments??[]).map(row=>row.record)];
        phases.push({phase:id,generation:proof.value.generation,publication:proof.value.publication,submission:proof.binding,approvals,
          policy:code.binding,report:code.manifest.report,plan:plan.proof,repositories,references,records:plan.records,indexes:plan.active.indexes,
          planned:plan.planned,repositoryPlan:plan.repositoryPlan??null});
      }
      return {profile:'sflow-namespace-code-predecessors/v1',phases};
    }),{signal});
  }
  function repository(value,id,options={}){const selected=(value?.phases??[]).filter(phase=>phase.repositories.some(row=>row.id===id)),
    rows=selected.flatMap(phase=>phase.repositories.filter(row=>row.id===id).map(row=>({phase:phase.phase,...row}))),
    paths=new Set(rows.flatMap(row=>row.paths.map(item=>item.path))),observed=rows.map(row=>row.observed),
    projected=selected.flatMap(phase=>{if(!phase.repositoryPlan)return phase.records;
      const projection=repositoryPlanProjection(phase.repositoryPlan,id),planned={...phase.planned,claims:projection.claims,
        supportingFiles:projection.supportingFiles,supportingFileDetails:projection.supportingFileDetails};
      return [planned,...phase.records.filter(row=>row.amendment).map(row=>repositoryPlanAmendmentProjection(phase.repositoryPlan,row,id,options)).filter(Boolean)];}),
    records=[...new Map(projected.map(row=>[canonicalJson(row),row])).values()];
    return {paths,observed,records};}
  async function opening(snapshot,phaseId,options={}){
    const proof=await inspect(snapshot,phaseId,null,options);if(!proof)return null;
    const sources=(snapshot.workflow.sourceBindings?.current?.repositories??[]).map(repository=>{
      const row=proof.phases.flatMap(phase=>phase.repositories).findLast(row=>row.id===repository.id);
      if(!row)throw error('Earlier Code has no approved opening for a selected repository.','ENGINE_PRIOR_CODE_SOURCE_REQUIRED',{repositoryId:repository.id});
      return {repository,observed:{content:row.source.content,revision:row.source.revision}};
    });return {proof,sources};
  }
  return Object.freeze({inspect,repository,opening});
}
