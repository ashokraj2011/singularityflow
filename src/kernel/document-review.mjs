/** A review document consumes approved intent; it cannot define clauses, plans or acceptance. */
import {stepResponsibilities,phaseRequiresCodeDelivery,isConvergencePhase} from './phase-policy.mjs';
import {phaseDefinesSpecificationClaims} from './specification-policy.mjs';
export const DOCUMENT_REVIEW_OWNERS=Object.freeze(['workflow-responsibility-policy','specification-claims','planned-claims']);
export function documentReviewPublicationPolicy(workflow,phase){
  if(!phase||!['phase-document','test-evidence'].includes(phase.requiredArtifact?.kind)||phaseRequiresCodeDelivery(phase)||isConvergencePhase(phase)
    ||phaseDefinesSpecificationClaims(workflow,phase)||phase.claimMaps?.planned||workflow.resolution?.phaseSemantics?.profile!=='sflow-phase-semantics/v1')return null;
  const roles=stepResponsibilities(workflow,phase.id);
  if(phase.requiredArtifact.kind==='test-evidence'&&workflow.resolution.spec?.mode==='enforce'&&workflow.resolution.plannedClaims?.mode==='disabled'
    &&roles.includes('verify')&&roles.every(role=>['verify','review'].includes(role))
    &&!workflow.phaseOrder.some(id=>phaseRequiresCodeDelivery(workflow.phases[id])))
    return {profile:'sflow-namespace-document-inspection/v1',version:2,owners:DOCUMENT_REVIEW_OWNERS};
  if(roles.length!==1||roles[0]!=='review'||workflow.resolution.spec?.mode==='off'&&workflow.resolution.plannedClaims?.mode==='disabled')return null;
  return {profile:'sflow-namespace-document-review/v1',owners:DOCUMENT_REVIEW_OWNERS};
}
export function documentReviewSources(workflow,phase){
  const order=workflow.phaseOrder??[],index=order.indexOf(phase.id);
  return order.slice(0,index).filter(id=>workflow.phases[id].status==='approved'&&(phaseDefinesSpecificationClaims(workflow,workflow.phases[id])||stepResponsibilities(workflow,id).includes('plan')));
}
