/** Reviewer-requested rework through the registered rejection operation and shared lifecycle rule. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {requireApprovalAuthority} from '../kernel/approval-policy.mjs';
import {planNamespaceRejection} from '../kernel/conformance-decisions.mjs';
import {primaryDocumentPublicationRequirements} from '../kernel/publication-intent.mjs';
import {skillPhaseHostRequirement} from '../kernel/phase-admission.mjs';
import {createNamespaceSubmissionReader} from './namespace-submission-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {createNamespaceHumanDecisionReader} from './namespace-human-decision-reader.mjs';
import {createNamespaceRepairBudgetReader} from './namespace-repair-budget-reader.mjs';
import {memoNamespaceObservedDecision} from './namespace-story-reader.mjs';
const error=(message,code,details=null)=>new SingularityFlowError(message,{code,details});
export function createNamespaceRejectionOwner({observer,scope,workId}){
  const checks=createNamespacePhaseCheckReader({...observer.evidenceReads,observer}),packets=createNamespaceSubmissionReader({observer,scope,workId,checks});
  async function read(snapshot,request,{signal,policyTraversal}={}){
    const phase=snapshot.workflow.phases[request.phaseId],proof=await packets.inspect(snapshot,request.phaseId,{signal,policyTraversal});
    if(!phase||!proof)throw error('Submit the exact publication before a reviewer returns it.','PHASE_SUBMISSION_REQUIRED');
    const approved=await observer.approved(snapshot,{signal}),required=new Set(primaryDocumentPublicationRequirements(snapshot.workflow,phase,{definition:approved.compiled.definition}));
    for(const owner of packets.publicationOwners(proof.published))required.delete(owner);
    if(proof.published.checks)required.delete('check-execution');
    if(snapshot.workflow.resolution.presence)required.add('person-presence');
    if(snapshot.workflow.resolution.testRecovery?.enabled)required.add('test-recovery');
    if(skillPhaseHostRequirement(snapshot.workflow,phase))required.add('qualified-skill-host');
    if(required.size)throw error('This return needs its additional policy owners.','ENGINE_PORT_UNAVAILABLE',{required:[...required].sort()});
    const repairBudget=await createNamespaceRepairBudgetReader({observer,scope,workId}).inspect(snapshot,phase.id,request.target,{signal,policyTraversal});
    return {generation:phase.generation,reviewPacket:proof.binding.record,repairBudget,
      identity:{publication:proof.value.publication,reviewPacket:proof.binding.record,...(repairBudget.selection||repairBudget.prior?{
        profile:'sflow-namespace-reviewer-return/v2',repairBudget:repairBudget.selection,priorBudget:repairBudget.prior}:{})},
      references:[proof.binding.record,proof.value.publication.record,proof.published.artifact.content,...packets.publicationPolicyEvidence(proof.published),...repairBudget.references]};
  }
  return Object.freeze({read,plan:planNamespaceRejection,authority:(workflow,request,actor)=>requireApprovalAuthority(
    workflow.resolution.approvalAuthorities,workflow.phases[request.phaseId].approvalPolicy,actor.identity).authorityGroup});
}
export function createNamespaceRejectionReader({observer,scope,workId}){
  const reader=createNamespaceHumanDecisionReader({observer,scope,workId,operation:'phase.reject',owner:createNamespaceRejectionOwner({observer,scope,workId})});
  // Only immutable original return proofs. New decisions still authenticate current access/head.
  return Object.freeze({...reader,accepted:(link,options={})=>memoNamespaceObservedDecision(observer,
    {profile:'sflow-namespace-accepted-reviewer-return/v1',link},()=>reader.accepted(link,options),options)});
}
