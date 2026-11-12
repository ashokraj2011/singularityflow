/** Registered reviewer return. Proof reconstruction belongs to the read-only rejection owner. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespaceHumanDecisionPort} from './namespace-human-decision.mjs';
import {createNamespaceRejectionOwner} from './namespace-rejection-reader.mjs';
import {phaseRejectionMembers} from '../kernel/approval-policy.mjs';
const error=(message,code,details=null)=>new SingularityFlowError(message,{code,details});
export function createNamespaceRejectionPorts(options){
  const {workId,scope}=options,observer=createNamespaceStoryObserver(options),owner=createNamespaceRejectionOwner({observer,scope,workId});
  function request(input){
    const members=phaseRejectionMembers(input.members??[]),clauseIds=[...new Set(input.clauseIds??[])];
    if(input.members?.length&&!members.length)throw error('Name an exact declared output member.','REJECT_MEMBER_UNKNOWN');
    const required=['repair','selectionReceipt','fetch','agent'].filter(key=>input[key]!=null&&input[key]!==false);
    if(required.length)throw error('This return requires additional decision owners.','ENGINE_PORT_UNAVAILABLE',{required});
    if(!input.phaseId||!input.confirm||!input.reason?.trim())throw error('Confirm the exact submitted review packet and give a repair reason.','ENGINE_APPROVAL_CONFIRMATION_REQUIRED',{
      actions:[{operation:'phase.review',inputs:{workId,phaseId:input.phaseId??null}}]});
    return {phaseId:input.phaseId,target:input.target??input.phaseId,reason:input.reason.trim(),confirm:input.confirm,
      ...(clauseIds.length||members.length?{clauseIds}:{}),...(members.length?{members}:{})};
  }
  return {rejection:createNamespaceHumanDecisionPort(options,{operation:'phase.reject',request,owner,finish:(value,revision)=>{
    const change=value.outcome.changeRequest;
    return {workId,phase:value.phase,generation:value.generation,revision,pushed:false,currentPhase:value.outcome.currentPhase,
      changeRequest:{id:change.id,status:change.status,sourcePhase:change.sourcePhase,sourceGeneration:change.sourceGeneration,targetPhase:change.targetPhase,
        clauseIds:change.clauseIds,members:change.members??[],reason:change.comment,actorId:value.actor.principalId,authorityGroup:value.authorityGroup,reviewPacket:change.reviewPacketSha256},
      repairBudget:value.outcome.repairBudget?.attempts.length?{consumed:value.outcome.repairBudget.attempts.length,maximum:value.outcome.repairBudget.maximum}:null};
  }})};
}
