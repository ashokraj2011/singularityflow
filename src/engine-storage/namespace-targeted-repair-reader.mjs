/** Authenticate exact Code locations through real publications and human-approved plan records. Read only. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {targetedCodeRepairScope} from '../kernel/conformance-decisions.mjs';
import {rejectionTarget} from '../kernel/approval-policy.mjs';
import {codePublicationPolicy} from '../kernel/publication-intent.mjs';
import {mergePlannedClaimRecords} from '../kernel/specification-policy.mjs';
import {repositoryPlanProjection,repositoryPlanAmendmentProjection} from '../engine-compatibility/node-repository-plan.mjs';
import {createNamespaceSpecificationReader} from './namespace-specifications.mjs';
import {createNamespacePublicationReader} from './namespace-publication-reader.mjs';
import {createNamespaceSubmissionReader} from './namespace-submission-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),error=(message,code,details=null)=>new SingularityFlowError(message,{code,details});
export function createNamespaceTargetedRepairReader({observer,scope,workId}){
  const checks=createNamespacePhaseCheckReader({...observer.evidenceReads,observer}),plans=createNamespaceSpecificationReader({observer,scope,workId,checks}),
    publications=createNamespacePublicationReader({observer,scope,workId,checks}),packets=createNamespaceSubmissionReader({observer,scope,workId,checks});
  const references=proof=>[proof.publication,proof.reviewPacket,proof.planned,...proof.indices.map(row=>row.record),...(proof.repositoryPlan?[proof.repositoryPlan]:[]),
    ...(proof.amendments??[]).map(row=>row.record)];
  async function current(snapshot,phaseId,clauseIds,repositoryIds,{signal}={}){
    const plan=await plans.sourcePlan(snapshot,phaseId,{signal}),definition=(await observer.approved(snapshot,{signal})).compiled.definition,
      repositories=repositoryIds.map(id=>{const projection=plan.repositoryPlan?repositoryPlanProjection(plan.repositoryPlan,id):null,
        records=projection?[{...plan.planned,claims:projection.claims},...plan.records.filter(row=>row.amendment)
          .map(row=>repositoryPlanAmendmentProjection(plan.repositoryPlan,row,id,{workflow:snapshot.workflow,definition})).filter(Boolean)]:plan.records;
        return {id,claims:mergePlannedClaimRecords(records)};});
    try{return {scope:targetedCodeRepairScope({phaseId,clauseIds,indexes:plan.active.indexes,repositories}),plan:plan.proof,references:references(plan.proof)};}
    catch(cause){if(!cause.code?.startsWith('ENGINE_REPAIR_'))throw cause;
      throw error(cause.message,cause.code,{...cause.details,actions:[{operation:'phase.review',inputs:{workId,phaseId}},
        {operation:'plan.correction.context',inputs:{workId,ownerPhase:plan.proof.phase},requiredInputs:['operations','reason'],prerequisites:['authenticated-human-plan-approver']}]});}
  }
  async function read(snapshot,request,{signal,policyTraversal}={}){
    const workflow=snapshot.workflow,{targetId}=rejectionTarget(workflow,workflow.phases[request.phaseId],request.target),phase=workflow.phases[targetId];
    if(!codePublicationPolicy(workflow,phase))throw error('Clause-targeted returns require the actual Code phase owner.','ENGINE_PORT_UNAVAILABLE',{
      required:['namespace-targeted-document-repair'],phase:targetId});
    const publication=phase.publicationBindings?.find(row=>row.generation===phase.generation);
    if(!publication)throw error('A targeted return needs the exact delivered Code generation.','PHASE_GENERATION_REQUIRED',{phase:targetId});
    const published=await publications.accepted(publication,targetId,{signal,policyTraversal}),code=publications.policies.codeEvidence(published);
    if(!code)throw error('The target needs its original retained Code proof.','ENGINE_STORAGE_CORRUPT');
    const proof=phase.status==='approved'?(await packets.inspectApprovedMany(snapshot,[targetId],{signal,policyTraversal}))[0]
      :targetId===request.phaseId?await packets.inspect(snapshot,targetId,{signal,policyTraversal}):null;
    if(!proof||!same(proof.value.publication,publication))throw error('The target needs its actual reviewed Code publication.','ENGINE_STORAGE_CORRUPT');
    const selected=await current(snapshot,targetId,request.clauseIds,code.sources.map(row=>row.repository.id),{signal});
    return {identity:{profile:'sflow-namespace-targeted-code-return/v1',phase:targetId,generation:phase.generation,publication,
      policy:code.binding,report:code.manifest.report,reviewPacket:proof.binding.record,plan:selected.plan,scope:selected.scope},
      references:[publication.record,code.binding.record,code.manifest.report,proof.binding.record,...selected.references]};
  }
  return Object.freeze({read,current});
}
