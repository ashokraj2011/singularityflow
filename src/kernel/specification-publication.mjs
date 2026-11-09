/** Which specification records a pinned phase owes. No storage, clock or host decisions. */
import {normalizeSpecPolicy} from './configuration-policy.mjs';
import {phaseDefinesSpecificationClaims,plannedClaimsEnforced} from './specification-policy.mjs';
import {plannedDeliveryCodeSteps,stepResponsibilities,phaseRequiresCodeDelivery} from './phase-policy.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';

export const SPECIFICATION_PUBLICATION_OWNERS=Object.freeze(['workflow-responsibility-policy','specification-claims','planned-claims']);

export function specificationPublicationPolicy(workflow,phase) {
  const roles=stepResponsibilities(workflow,phase.id),policy=normalizeSpecPolicy(workflow.resolution?.spec);
  if(workflow.resolution?.phaseSemantics?.profile!=='sflow-phase-semantics/v1'||policy.mode==='off'
    ||!roles.some(role=>['scope','plan'].includes(role))||roles.some(role=>!['scope','plan','review'].includes(role)))return null;
  const codeSteps=policy.acceptance==='off'?[]:plannedDeliveryCodeSteps(workflow,phase)
    .filter(id=>phaseRequiresCodeDelivery(workflow.phases[id]));
  return {policy,index:phaseDefinesSpecificationClaims(workflow,phase),codeSteps,
    enforce:plannedClaimsEnforced(workflow,policy)};
}

/** Only preceding active definitions may contribute approved clause identities. */
export function specificationPublicationSources(workflow,phaseId) {
  const order=workflow.phaseOrder,position=order.indexOf(phaseId);
  if(position<0)throw new SingularityFlowError('The specification phase is not in the pinned workflow.',{code:'ENGINE_STORAGE_CORRUPT'});
  return order.slice(0,position).filter(id=>workflow.phases[id].status!=='skipped'
    &&phaseDefinesSpecificationClaims(workflow,workflow.phases[id]));
}
