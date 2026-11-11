/** Human dispositions keep the observed verdict. No storage, identity discovery or model text. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {requireApprovalAuthority,rejectionTarget,assertRejectionComment} from './approval-policy.mjs';
import {upstreamDispositionFacts} from './decision-plan.mjs';
import {reopenPhaseRange} from './lifecycle-transitions.mjs';
import {applyNamespaceRepairBudget} from './test-recovery.mjs';
const fail=(message,code,details=null)=>{throw new SingularityFlowError(message,{code,details});};

export function conformanceDecisionSelection(workflow,request,source,{at}) {
  const phase=workflow.phases?.[request.phaseId];
  if(workflow.status!=='in_progress'||workflow.currentPhase!==request.phaseId||!['in_progress','awaiting_approval'].includes(phase?.status)
    ||phase.generation!==source.generation)fail('Decide a gap in the current published conformance generation.','ENGINE_CONFORMANCE_NOT_CURRENT');
  if(request.expected!==source.expected)fail('Review the exact retained conformance before deciding.','ENGINE_DECISION_CONFIRMATION_STALE',{
    actions:[{operation:'conformance.context',inputs:{workId:workflow.workItem.id,phaseId:request.phaseId}}]});
  const gap=source.gaps.find(row=>row.clauseId===request.clauseId);
  if(!gap||!gap.owners.includes(request.ownerPhase))fail('Choose the exact gap and its original upstream owner.','ENGINE_CONFORMANCE_OWNER_INVALID');
  if(!['accept-risk','dismiss'].includes(request.outcome))fail('Choose accept-risk or dismiss; return for repair uses phase.reject.','ENGINE_INPUT_INVALID');
  const disposition=upstreamDispositionFacts({...request,expiresAt:request.expires,at});
  return {gap,disposition};
}
export function conformanceDecisionAuthority(workflow,request,actor) {
  const policy=workflow.phases?.[request.ownerPhase]?.approvalPolicy;
  return requireApprovalAuthority(workflow.resolution.approvalAuthorities,policy,actor.identity).authorityGroup;
}
export function planConformanceDecision(workflow,request,facts,source) {
  const selected=conformanceDecisionSelection(workflow,request,source,{at:facts.at}),proposed=structuredClone(workflow);
  proposed.history.push({at:facts.at,actor:facts.actorId,agent:facts.agentId,event:'conformance_gap_decided',phase:request.phaseId,
    detail:request.clauseId+' / '+request.ownerPhase+': '+request.outcome});
  return {workflow:proposed,outcome:{currentPhase:workflow.currentPhase,clauseId:request.clauseId,ownerPhase:request.ownerPhase,
    verdict:selected.gap.verdict,outcome:request.outcome,...selected.disposition}};
}
export function conformanceDecisionActive(value,at){return value.request.outcome==='dismiss'||Date.parse(value.outcome.expiresAt)>Date.parse(at);}

/** Shared lifecycle reset, with an exact submitted packet and explicit human reviewer. */
export function planNamespaceRejection(workflow,request,facts,source) {
  const phase=workflow.phases?.[request.phaseId];
  if(workflow.status!=='in_progress'||workflow.currentPhase!==phase?.id||phase.status!=='awaiting_approval')fail(
    'Return the current submitted phase for repair.','PHASE_DRAFT_NOT_ACTIVE');
  if(request.confirm!==source.reviewPacket.sha256)fail('Confirm the exact submitted review packet before returning it.','ENGINE_APPROVAL_CONFIRMATION_STALE');
  const {targetId}=rejectionTarget(workflow,phase,request.target);assertRejectionComment(phase,request.reason,false);
  const proposed=structuredClone(workflow),target=proposed.phases[targetId];
  if(!target)fail('Return to a phase in this pinned workflow.','LIFECYCLE_TRANSITION_INVALID');
  const changeRequestId='CR-'+String((proposed.changeRequests??[]).length+1).padStart(3,'0'),
    repairBudget=applyNamespaceRepairBudget(proposed,source,request,facts,changeRequestId,'rejection');
  const changeRequest={schemaVersion:1,id:changeRequestId,status:'open',
    sourcePhase:phase.id,sourceGeneration:phase.generation,targetPhase:targetId,clauseIds:[],comment:request.reason,
    requestedAt:facts.at,requestedBy:facts.actorId,agent:facts.agentId,channel:'engine-sdk',authorityGroup:facts.authorityGroup,
    identityAssurance:null,sourceArtifactSha256:(phase.artifacts??[]).map(row=>({path:row.path,sha256:row.sha256??null})),
    reviewPacketSha256:source.reviewPacket.sha256,resolution:null};
  reopenPhaseRange(proposed,{targetId,at:facts.at,actor:facts.actorId,reason:request.reason});
  proposed.changeRequests??=[];proposed.changeRequests.push(changeRequest);
  proposed.phases[phase.id].approvals.push({decision:'rejected',phase:phase.id,target:targetId,reason:request.reason,
    changeRequestId:changeRequest.id,clauseIds:[],at:facts.at,actor:facts.actorId,agent:facts.agentId,authorityGroup:facts.authorityGroup,
    identityAssurance:null,channel:'engine-sdk',generation:phase.generation,reviewPacketSha256:source.reviewPacket.sha256});
  proposed.history.push({at:facts.at,actor:facts.actorId,agent:facts.agentId,event:'phase_rejected',phase:phase.id,
    detail:changeRequest.id+' returned to '+targetId+': '+request.reason});
  return {workflow:proposed,outcome:{currentPhase:targetId,changeRequest,
    ...(source.identity?.profile==='sflow-namespace-reviewer-return/v2'?{repairBudget}:{})}};
}
