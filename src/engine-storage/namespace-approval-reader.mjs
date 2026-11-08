/** Read exact vote bytes and recompute authority/quorum; never write or record a human decision. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {createHash} from 'node:crypto';
import {canonicalJson,namespaceApprovalRoutingProfile} from '../foundation/record-schema.mjs';
import {principalApprovalPlan} from '../kernel/approval-policy.mjs';
import {decisionAfter} from '../kernel/workflow-decisions.mjs';
import {routedApprovalSelection} from '../kernel/routed-approval.mjs';
import {namespaceApprovalValue,namespaceApprovalBindingValue,namespaceApprovalArtifactSetValue,namespaceApprovalDecision,
  namespaceApprovalReceipts,namespaceApprovalReceipt} from './namespace-approval-contract.mjs';
import {namespaceAcceptedEvidence} from './namespace-lifecycle-receipt-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const corrupt=(message,cause)=>new SingularityFlowError(message,{code:'ENGINE_STORAGE_CORRUPT',cause});
/** V1 hashes its native payload. V2 also binds generation, so coarse clocks cannot reuse a question. */
export function namespaceRoutingQuestionKey(pending,generation,version) {
  const profile=namespaceApprovalRoutingProfile({schemaVersion:version});
  if(pending===null)return null;
  if(!Number.isSafeInteger(generation)||generation<1)throw corrupt('A question needs its actual approved generation.');
  const identity=profile.generationBound?{generation,question:pending}:pending;
  return createHash('sha256').update(canonicalJson(identity)).digest('hex').slice(0,16);
}
export function createNamespaceApprovalReader({observer,scope,workId}) {
  async function json(reference,signal) {
    const data=await observer.bytes(reference,reference.bytes,signal);
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}
    catch(cause){throw corrupt('The retained approval evidence is not UTF-8 JSON.',cause);}
  }
  async function decode(binding,phaseId,{signal}={}) {
    namespaceApprovalBindingValue(binding);
    const value=namespaceApprovalValue(await json(binding.record,signal),{projectId:scope.projectId,workId,phaseId});
    if(value.generation!==binding.generation)throw corrupt('The vote belongs to another submitted review.');
    return value;
  }
  async function read(binding,phaseId,proof,{signal}={}) {
    const value=await decode(binding,phaseId,{signal});
    if(value.generation!==proof.value.generation||!same(value.reviewPacket,proof.binding.record)
      ||!same(value.configuration,proof.value.configuration))throw corrupt('The vote belongs to another submitted review.');
    const set=namespaceApprovalArtifactSetValue(await json(value.artifactSet,signal),{projectId:scope.projectId,workId,phaseId});
    if(set.generation!==value.generation||!same(set.reviewPacket,value.reviewPacket)||!same(set.artifact,
      {sourceKey:proof.published.artifact.sourceKey,kind:proof.published.artifact.kind,content:proof.published.artifact.content})) {
      throw corrupt('The vote artifact set differs from the retained publication.');
    }
    return value;
  }
  async function readAccepted(binding,phaseId,proof,options={}) {
    const value=await read(binding,phaseId,proof,options),accepted=await namespaceAcceptedEvidence(observer,binding,value,'phase.approve',options);
    const workflow=accepted.state.workflow,phase=workflow.phases[phaseId];
    const retained=value.routing?namespaceApprovalReceipts(workflow,{projectId:scope.projectId,workId}).some(item=>same(item,namespaceApprovalReceipt(value,binding)))
      :phase?.generation===value.generation&&phase.approvals?.some(item=>same(item,namespaceApprovalDecision(value,binding)));
    if(!retained||workflow.currentPhase!==value.currentPhase||![value.artifactSet,value.reviewPacket].every(ref=>accepted.plan.evidence.some(item=>same(item,ref))))throw corrupt(
      'The accepted approval lost its exact human vote or outcome.');
    return value;
  }
  async function collect(snapshot,phaseId,proof,options,readVote) {
    const {signal}=options;
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
      const value=await readVote(decision.namespaceVote,phaseId,proof,{...options,signal,snapshot});
      if(!value.routing&&decisionAfter(snapshot.workflow,phaseId))throw new SingularityFlowError('A routed approval needs its versioned outcome proof.',{
        code:'ENGINE_PORT_UNAVAILABLE',details:{required:['routed-approval-proof']}});
      try {
        if(!same(decision,namespaceApprovalDecision(value,decision.namespaceVote)))throw Error('The canonical vote metadata changed.');
        const plan=principalApprovalPlan(snapshot.workflow,phase,{actor:value.actor,agentId:value.agentId},{author:proof.published.actor,active:decisions});
        if(plan.authorityGroup!==value.authorityGroup||plan.selfApproval!==value.selfApproval||plan.reached!==value.thresholdReached)throw Error('The recorded vote authority or quorum changed.');
        if(value.routing) {
          const selected=routedApprovalSelection(snapshot.workflow,phase,{reached:plan.reached,at:value.recordedAt});
          const profile=namespaceApprovalRoutingProfile(value.routing),pendingKey=namespaceRoutingQuestionKey(selected.pending,phase.generation,profile.version);
          if(value.currentPhase!==selected.currentPhase||!same(value.routing,{schemaVersion:profile.version,format:profile.format,
            decision:selected.decision,outcome:selected.outcome,pendingKey,...(profile.generationBound?{generation:phase.generation}:{})}))throw Error('The routed vote changed its pinned outcome.');
        }
      }catch(cause){throw corrupt('The retained approval does not match its human authority and quorum.',cause);}
      votes.push({value,binding:decision.namespaceVote});decisions.push(decision);
    }
    return {votes,decisions};
  }
  const active=(snapshot,phaseId,proof,options={})=>collect(snapshot,phaseId,proof,options,read);
  const activeAccepted=(snapshot,phaseId,proof,options={})=>collect(snapshot,phaseId,proof,options,readAccepted);
  return Object.freeze({decode,read,readAccepted,active,activeAccepted});
}
