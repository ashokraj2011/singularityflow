/** Authenticate data work products through their accepted mutations and upstream human votes. */
import {canonicalJson,WORK_PRODUCT_SCHEMAS,admitRecordSchemaVersion} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {createNamespaceWorkProductOwners} from './namespace-work-products-reader.mjs';
import {namespaceApprovedWorkProductInputs} from './namespace-work-product-inputs.mjs';
import {namespaceEvidencePolicyManifest} from './namespace-policy-contract.mjs';
import {namespaceSpecificationIdentity} from './namespace-specification-contract.mjs';
import {workProductContinuations} from '../kernel/work-products.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),fail=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>{throw new SingularityFlowError(message,{code,details});};
export const WORK_PRODUCT_EVIDENCE='work-products/v1';
export const hasWorkProductPolicy=(workflow,phaseId)=>workflow.resolution.workProducts?.phases?.some(p=>p.id===phaseId)===true;
export function namespaceWorkProductManifest(value,bindings){return namespaceEvidencePolicyManifest(value,{...bindings,family:WORK_PRODUCT_SCHEMAS.policyManifest,format:'sflow-namespace-work-product-policy/v1'});}
export function createNamespaceWorkProductPolicyReader({observer,scope,workId}){
  const owned=createNamespaceWorkProductOwners({observer,scope,workId});
  async function candidate(publication,snapshot,{signal,policyTraversal}={}){
    const current=await owned.context(snapshot,publication.phase,{signal,generation:publication.generation,policyTraversal}),{phase,state}=current;
    if(current.missing.length)fail('Retain the phase\'s required inputs.','ENGINE_DATA_INPUT_REQUIRED',{missing:current.missing,operation:'work-product.context'});
    const sources=await namespaceApprovedWorkProductInputs({observer,scope,workId},snapshot,current,{signal,policyTraversal});
    const outputs=phase.outputs.map(id=>state.products.find(row=>row.asset.id===id&&row.phase===publication.phase&&row.generation===publication.generation)??null),
      missing=phase.outputs.filter((_id,i)=>outputs[i]===null);
    if(missing.length)fail('Retain the current generation\'s real output work products.','ENGINE_WORK_PRODUCT_OUTPUT_REQUIRED',{
      missing,actions:workProductContinuations(snapshot.workflow,current)});
    let execution=null,checks=[];
    if(phase.execution){
      execution=state.executions.filter(row=>row.phase===publication.phase&&row.generation===publication.generation).at(-1);
      if(!execution?.asset||outputs.some(row=>row.operationId!==execution.operationId))fail('The output is not from this generation\'s latest real data execution.','ENGINE_DATA_EXECUTION_REQUIRED');
      const link=snapshot.workflow.namespaceWorkProductReceipts.find(r=>r.operationId===execution.operationId),proof=await owned.readers.get('data.execute').accepted(link,{signal,policyTraversal});
      if(proof.source.identity.contextSha256!==current.contextSha256)fail('The query or input snapshot changed after execution.','ENGINE_DATA_EVIDENCE_STALE');
      checks=proof.source.checks;
      if(proof.source.status!=='passed'||checks.length!==phase.criteria.length||!checks.length||checks.some(c=>c.status!=='passed'))fail('Repair the current query/input contract and rerun its real quality checks. Failed observations remain retained.','ENGINE_DATA_QUALITY_FAILED',{
        checks,actions:workProductContinuations(snapshot.workflow,current)});
    }
    const requirementsTrace=current.declaration.requirements.map(requirement=>{
      const observations=requirement.criteria.map(criterionId=>{
        const check=checks.find(row=>row.criterionId===criterionId),inherited=sources.flatMap(row=>row.requirementsTrace).flatMap(row=>row.observations).find(row=>row.criterionId===criterionId&&row.status!=='planned');
        if(check)return {criterionId,status:check.status,phase:publication.phase,generation:publication.generation,execution:execution.execution,
          workProduct:outputs.find(row=>row.asset.id===phase.execution.output).asset,observation:check};
        return inherited??{criterionId,status:'planned',phase:current.declaration.phases.find(row=>row.criteria.some(c=>c.id===criterionId)).id,generation:null,execution:null,workProduct:null,observation:null};
      });return {requirementId:requirement.id,statement:requirement.statement,status:observations.every(row=>row.status==='passed')?'matched':observations.every(row=>row.status==='planned')?'pending':'partial',observations};
    });
    return {policy:{profile:'sflow-work-product-policy/v1',owners:['work-product-evidence']},
      report:{schemaVersion:1,format:'sflow-namespace-work-product-report/v1',projectId:scope.projectId,workId,phase:publication.phase,generation:publication.generation,
        contextSha256:current.contextSha256,requirementsTrace,inputs:current.assets,outputs,execution,checks,sources,processSuccessImpliesAcceptance:false,modelInvocations:0},
      references:[...current.references,...current.assets.map(row=>row.asset.content),...outputs.map(row=>row.asset.content),...(execution?[execution.execution]:[]),
        ...sources.flatMap(row=>[row.publication.record,row.submission.record,row.evidence.record])]};
  }
  async function verify(publication,binding,{signal,policyTraversal}={}){
    const manifest=namespaceWorkProductManifest(await owned.json(binding.record,signal),{scope,workId,phaseId:publication.phase}),identity=namespaceSpecificationIdentity(publication);
    if(!same(identity,Object.fromEntries(Object.keys(identity).map(k=>[k,manifest[k]])))||manifest.recordedAt!==publication.publishedAt
      ||!same(manifest.configuration,manifest.basis.head.configuration)||!same(manifest.artifact,{key:publication.artifact.sourceKey,content:publication.artifact.content}))fail('The work products have another publication binding.');
    const state=await observer.state(await observer.bytes(manifest.basis.head.state,manifest.basis.head.state.bytes,signal),manifest.basis.head,{signal}),
      actual=await candidate(publication,{revision:manifest.basis.revision,configuration:manifest.configuration,workflow:state.workflow},{signal,policyTraversal}),report=await owned.json(manifest.report,signal);
    admitRecordSchemaVersion(WORK_PRODUCT_SCHEMAS.policyReport,report);if(!same(report,actual.report))fail('The work-product report differs from its original approved inputs and execution.');
    return {...actual,binding,manifest};
  }
  return Object.freeze({candidate,verify});
}
