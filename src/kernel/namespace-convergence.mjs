/** Portable convergence values over actual retained Code inputs; no Git fields or host discovery. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,textValueSyntax,phasePublicationBindingValue,admitRecordSchemaVersion} from '../foundation/record-schema.mjs';
import {NAMESPACE_CONVERGENCE_SCHEMAS} from '../foundation/record-schema.mjs';
import {convergenceValuePolicies,NAMESPACE_CONVERGENCE_VALUES_PROFILE} from './convergence-values.mjs';
import {repositoryCoverageProjection} from './repository-plan.mjs';
import {isConvergencePhase,phaseExplicitlyReopened,nextPhaseGeneration} from './phase-policy.mjs';
import {authoredArtifactText} from './artifact-content.mjs';
export const NAMESPACE_CONVERGENCE_PROFILE='sflow-namespace-convergence-projection/v1';
export const NAMESPACE_CONVERGENCE_SOURCE_PROFILE='sflow-namespace-convergence-source/v1';
const fail=(message,code,details=null)=>{throw new SingularityFlowError(message,{code,details});};
const text=value=>typeof value==='string'&&value.length>0&&value.length<=4096;
const positive=value=>Number.isSafeInteger(value)&&value>0;
const reference=value=>value&&value.namespace==='evidence'&&/^[a-f0-9]{64}$/u.test(value.sha256??'')&&Number.isSafeInteger(value.bytes)&&value.bytes>0;

export function namespaceConvergenceSelection(workflow,phaseId=null){
  const id=phaseId??workflow.currentPhase,phase=workflow.phases?.[id];
  if(!phase||!isConvergencePhase(phase))fail('Select the actual convergence phase.','CONVERGENCE_PHASE_REQUIRED');
  if(workflow.status!=='in_progress'||workflow.currentPhase!==id||phase.status==='approved'||phase.status==='skipped')fail(
    'Convergence belongs to the current in-progress Story phase.','PHASE_DRAFT_NOT_ACTIVE');
  if(phase.approvalPolicy?.mode!=='required')fail('Convergence requires its non-waivable human approval.','CONVERGENCE_HUMAN_APPROVAL_REQUIRED');
  return {phase:id,generation:phase.generation>0&&!phaseExplicitlyReopened(workflow,phase)?phase.generation:nextPhaseGeneration(phase)};
}

export function namespaceConvergencePolicies(pathPort,textPort){
  const values=convergenceValuePolicies(pathPort,textPort,{profile:NAMESPACE_CONVERGENCE_VALUES_PROFILE}),syntax=textValueSyntax(textPort),hash=value=>syntax.sha256Utf8(canonicalJson(value));
  function project({projectId,workId,phase,generation,configuration,inputs,indexes,repositories,adjudications=[],limits=undefined}){
    if(![projectId,workId,phase].every(text)||!positive(generation)||!Array.isArray(inputs)||!inputs.length||inputs.length>32
      ||!Array.isArray(indexes)||!indexes.length||!Array.isArray(repositories)||!repositories.length||repositories.length>32
      ||repositories.some(row=>!text(row?.id)||row.keptByPerson!==undefined&&row.keptByPerson!==null&&!Array.isArray(row.keptByPerson))
      ||new Set(repositories.map(row=>row.id)).size!==repositories.length||new Set(inputs.map(row=>row?.phase)).size!==inputs.length)fail(
      'Convergence requires exact retained Code, clause and repository inputs.','ENGINE_CONVERGENCE_INPUT_INVALID');
    for(const input of inputs){if(!text(input.phase)||!positive(input.generation)||!reference(input.report)||!reference(input.policy)
      ||!reference(input.reviewPacket)||!Array.isArray(input.approvals)||!input.approvals.length||input.approvals.some(ref=>!reference(ref)))fail(
      'Convergence needs the original publication, submitted packet and human approvals.','ENGINE_CONVERGENCE_INPUT_INVALID');
      if(phasePublicationBindingValue(input.publication).generation!==input.generation)fail(
        'A convergence producer has another published generation.','ENGINE_CONVERGENCE_INPUT_INVALID');}
    const views=repositoryCoverageProjection(indexes,repositories.map(row=>({id:row.id,clauseIds:[...(row.planned??[]),...(row.observed??[])]
      .flatMap(record=>Object.keys(record.claims??{}))}))),all=[],settled=[];
    for(const repository of [...repositories].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)){
      const local=views?.repositories.find(row=>row.id===repository.id),ids=local?new Set(local.clauseIds):null,
        active=ids?indexes.map(index=>({...index,clauses:index.clauses.filter(row=>ids.has(row.id))})):indexes,
        every=values.convergenceFacts({...repository,indexes:active,limits}),
        partition=values.settleChangedPaths(every,{reconciliation:repository.reconciliation,
          planAccount:values.planAccountsFromEntries(repository.planEntries??[],{keptByPerson:repository.keptByPerson===null?null:new Set(repository.keptByPerson??[])})});
      const qualify=item=>({...item,id:values.itemId('CF',{repositoryId:repository.id,itemId:item.id}),repositoryId:repository.id,originalId:item.id});
      all.push(...partition.facts.map(qualify));settled.push(...partition.settled.map(qualify));
    }
    const iteration=Math.max(generation,...inputs.map(row=>row.generation)),source={profile:NAMESPACE_CONVERGENCE_SOURCE_PROFILE,projectId,workId,phase,generation,iteration,configuration,inputs,
      inputValuesSha256:hash({indexes,repositories:repositories.map(({keptByPerson,...row})=>({...row,keptByPerson:keptByPerson===undefined?[]:keptByPerson}))})},
      sourceSha256=hash(source),reconciliation={profile:'sflow-namespace-convergence-reconciliation/v1',
        sha256:hash(repositories.map(row=>({id:row.id,reconciliation:row.reconciliation})))},
      bindings={profile:'sflow-namespace-convergence-bindings/v1',iteration,sourceSha256,configuration,reconciliation},
      projection=values.convergenceProjection({workId,bindings,facts:all,settledByPlan:settled,adjudications});
    return {schemaVersion:1,profile:NAMESPACE_CONVERGENCE_PROFILE,valueProfile:NAMESPACE_CONVERGENCE_VALUES_PROFILE,
      projectId,workId,phase,generation,iteration,source,sourceSha256,projection};
  }
  function assert(value){
    admitRecordSchemaVersion(NAMESPACE_CONVERGENCE_SCHEMAS.projection,value);
    if(value.profile!==NAMESPACE_CONVERGENCE_PROFILE||value.valueProfile!==NAMESPACE_CONVERGENCE_VALUES_PROFILE
      ||value.source?.profile!==NAMESPACE_CONVERGENCE_SOURCE_PROFILE||hash(value.source)!==value.sourceSha256
      ||value.sourceSha256!==value.projection?.bindings?.sourceSha256||value.projection?.bindings?.profile!=='sflow-namespace-convergence-bindings/v1'
      ||canonicalJson(value.source.configuration)!==canonicalJson(value.projection.bindings.configuration)
      ||value.workId!==value.projection?.workId||value.iteration!==value.projection?.iteration
      ||['projectId','workId','phase','generation','iteration'].some(key=>value[key]!==value.source[key]))fail(
      'The convergence value has another retained source binding.','ENGINE_CONVERGENCE_PROJECTION_INVALID');
    values.assertConvergenceIntegrity(value.projection);return value;
  }
  function render(value){assert(value);return values.renderConvergenceArtifact(value.projection)
    .replace('- Source target: `unavailable`','- Input snapshot: `sha256:'+value.sourceSha256+'`');}
  function publishable(value,body){assert(value);const projection=value.projection,
    disposed=new Set(projection.findings.map(row=>row.itemId)),undisposed=projection.facts.filter(row=>!disposed.has(row.id)).map(row=>row.id);
    if(!projection.allowedNext.includes('advance-to-verification')||projection.unresolvedBlockers.length)fail(
      'Record the exact human convergence decisions before publication.','CONVERGENCE_REVIEW_REQUIRED',{
        workId:value.workId,phase:value.phase,generation:value.generation,undisposedItemIds:undisposed,unresolvedBlockers:projection.unresolvedBlockers,
        actions:[{operation:'convergence.context',inputs:{workId:value.workId,phaseId:value.phase}}]});
    if(authoredArtifactText(body).replace(/\r\n/gu,'\n').trim()!==render(value).trim())fail(
      'Prepare the current deterministic convergence projection after its inputs or decisions change.','CONVERGENCE_ARTIFACT_MISMATCH',{
        actions:[{operation:'phase.prepare',inputs:{workId:value.workId,phaseId:value.phase}}]});
    return value;
  }
  function advancement(value,publication){assert(value);phasePublicationBindingValue(publication);
    if(publication.generation!==value.generation)fail('Convergence advancement needs its actual published generation.','ENGINE_CONVERGENCE_PROJECTION_INVALID');
    const projection=value.projection,confirmed={profile:'sflow-namespace-convergence-confirmation/v1',projectId:value.projectId,workId:value.workId,
      phase:value.phase,generation:value.generation,iteration:value.iteration,publication,sourceSha256:value.sourceSha256,convergenceSha256:projection.convergenceSha256};
    return {...confirmed,confirmationDigest:'sha256:'+hash(confirmed)};
  }
  return Object.freeze({project,assert,render,publishable,advancement,values,hash});
}
