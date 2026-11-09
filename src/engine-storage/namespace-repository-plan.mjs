/** Discover new repository scope from a real publication, then require its original human approval. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {phaseRequiresCodeDelivery} from '../kernel/phase-policy.mjs';
import {assertRepositoryPlanSources} from '../engine-compatibility/node-repository-plan.mjs';
import {createNamespaceSpecificationReader} from './namespace-specifications.mjs';
import {namespacePublicationValue} from './namespace-publication-contract.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {namespaceSpecificationManifest} from './namespace-specification-contract.mjs';
export function createNamespaceRepositoryPlanReader(options){
  const {observer,scope,workId}=options,checks=options.checks??createNamespacePhaseCheckReader(options),
    specifications=createNamespaceSpecificationReader({observer,scope,workId,checks});
  // An immutable v1 publication cannot acquire a new roots declaration. This caches no approval,
  // source selection or mutable head; v2 always reopens its actual human and content proofs.
  const legacy=new Set();
  async function json(reference,signal){
    const data=await observer.bytes(reference,reference.bytes,signal);
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}catch(cause){throw new SingularityFlowError(
      'The repository plan publication is not valid retained JSON.',{code:'ENGINE_STORAGE_CORRUPT',cause});}
  }
  async function approved(snapshot,phaseId,{signal}={}){
    const w=snapshot.workflow,phase=w.phases[phaseId],ownerId=w.resolution?.plannedClaims?.owners?.[phaseId],owner=w.phases[ownerId];
    if(!phaseRequiresCodeDelivery(phase)||w.resolution?.plannedClaims?.mode!=='required'||!owner)return null;
    const binding=owner.publicationBindings?.find(row=>row.generation===owner.generation);if(!binding)return null;
    const key=JSON.stringify([ownerId,binding.generation,binding.record]);if(legacy.has(key))return null;
    // Discovery reads only the exact immutable metadata. It grants no publication or approval
    // authority. Normal resources still prove legacy plans; new roots below always require
    // the original conditional publication and human proof through sourcePlan.
    const publication=namespacePublicationValue(await json(binding.record,signal),{projectId:scope.projectId,workId,phaseId:ownerId});
    if(publication.generation!==binding.generation)throw new SingularityFlowError('The repository-plan publication has another generation.',{code:'ENGINE_STORAGE_CORRUPT'});
    if(!publication.specifications)return null;
    const manifest=namespaceSpecificationManifest(await json(publication.specifications.record,signal),{scope,workId,phaseId:ownerId});
    // Metadata-only v1 plans retain their existing preparation and source-binding behavior.
    if(!manifest.repositoryPlan){legacy.add(key);return null;}
    if(owner.status!=='approved')throw new SingularityFlowError('Review and approve the published repository plan before opening code generation.',{
      code:'ENGINE_REPOSITORY_PLAN_APPROVAL_REQUIRED',details:{operation:'phase.review',inputs:{workId,phaseId:ownerId},prerequisites:['human-plan-approval']}});
    const plan=await specifications.sourcePlan(snapshot,phaseId,{signal});
    if(!plan.repositoryPlan)throw new SingularityFlowError('The approved repository plan lost its original evidence.',{code:'ENGINE_STORAGE_CORRUPT'});
    return plan.repositoryPlan;
  }
  async function guard(snapshot,phaseId,repositories,{signal}={}){
    const plan=await approved(snapshot,phaseId,{signal});assertRepositoryPlanSources(plan,phaseId,repositories);return plan;
  }
  return Object.freeze({approved,guard});
}
