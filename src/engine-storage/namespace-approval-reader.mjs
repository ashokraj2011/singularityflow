/** Read exact vote bytes and recompute authority/quorum; never write or record a human decision. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {principalApprovalPlan} from '../kernel/approval-policy.mjs';
import {namespaceApprovalValue,namespaceApprovalBindingValue,namespaceApprovalArtifactSetValue,namespaceApprovalDecision} from './namespace-approval-contract.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const corrupt=(message,cause)=>new SingularityFlowError(message,{code:'ENGINE_STORAGE_CORRUPT',cause});
export function createNamespaceApprovalReader({observer,scope,workId}) {
  async function json(reference,signal) {
    const data=await observer.bytes(reference,reference.bytes,signal);
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}
    catch(cause){throw corrupt('The retained approval evidence is not UTF-8 JSON.',cause);}
  }
  async function read(binding,phaseId,proof,{signal}={}) {
    namespaceApprovalBindingValue(binding);
    const value=namespaceApprovalValue(await json(binding.record,signal),{projectId:scope.projectId,workId,phaseId});
    if(value.generation!==binding.generation||value.generation!==proof.value.generation||!same(value.reviewPacket,proof.binding.record)
      ||!same(value.configuration,proof.value.configuration))throw corrupt('The vote belongs to another submitted review.');
    const set=namespaceApprovalArtifactSetValue(await json(value.artifactSet,signal),{projectId:scope.projectId,workId,phaseId});
    if(set.generation!==value.generation||!same(set.reviewPacket,value.reviewPacket)||!same(set.artifact,
      {sourceKey:proof.published.artifact.sourceKey,kind:proof.published.artifact.kind,content:proof.published.artifact.content})) {
      throw corrupt('The vote artifact set differs from the retained publication.');
    }
    return value;
  }
  async function active(snapshot,phaseId,proof,{signal}={}) {
    const phase=snapshot.workflow.phases[phaseId];
    if(!Array.isArray(phase.approvals))throw corrupt('The phase approval inventory is invalid.');
    const votes=[],decisions=[];
    for(const decision of phase.approvals) {
      if(!decision||typeof decision!=='object')throw corrupt('A retained approval is invalid.');
      if(decision.invalidatedAt||decision.decision!=='approved')continue;
      if(!Number.isSafeInteger(decision.generation)||decision.generation<1||decision.generation>phase.generation)throw corrupt('An active approval has no valid generation.');
      if(decision.generation!==phase.generation)continue;
      if(decision.reviewPacketSha256!==proof.binding.record.sha256)throw corrupt('An active vote names another review packet.');
      if(!decision.namespaceVote)throw new SingularityFlowError('A retained vote needs its evidence owner.',{
        code:'ENGINE_PORT_UNAVAILABLE',details:{required:['retained-approval-vote']}});
      const value=await read(decision.namespaceVote,phaseId,proof,{signal});
      try {
        if(!same(decision,namespaceApprovalDecision(value,decision.namespaceVote)))throw Error('The canonical vote metadata changed.');
        const plan=principalApprovalPlan(snapshot.workflow,phase,{actor:value.actor,agentId:value.agentId},{author:proof.published.actor,active:decisions});
        if(plan.authorityGroup!==value.authorityGroup||plan.selfApproval!==value.selfApproval||plan.reached!==value.thresholdReached)throw Error('The recorded vote authority or quorum changed.');
      }catch(cause){throw corrupt('The retained approval does not match its human authority and quorum.',cause);}
      votes.push({value,binding:decision.namespaceVote});decisions.push(decision);
    }
    return {votes,decisions};
  }
  return Object.freeze({read,active});
}
