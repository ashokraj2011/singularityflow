/** Prove the pending question from submitted content and the actual human approval quorum. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {decisionContextSelection} from '../kernel/decision-plan.mjs';
import {routedApprovalSelection} from '../kernel/routed-approval.mjs';
import {createNamespaceSubmissionReader} from './namespace-submission-reader.mjs';
import {createNamespaceApprovalReader,namespaceRoutingQuestionKey} from './namespace-approval-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const corrupt=message=>new SingularityFlowError(message,{code:'ENGINE_STORAGE_CORRUPT'});
export function createNamespaceRoutingChoiceReader({observer,scope,workId,packets=null,checks=null}) {
  packets??=createNamespaceSubmissionReader({observer,scope,workId,checks});
  const votes=createNamespaceApprovalReader({observer,scope,workId,checks});
  async function read(snapshot,{signal,policyTraversal}={}) {
    let selected;
    try{selected=decisionContextSelection(snapshot.workflow);}catch(cause){throw new SingularityFlowError('The retained question is invalid.',{
      code:'ENGINE_STORAGE_CORRUPT',cause});}
    if(selected.question===null)return null;
    const phase=snapshot.workflow.phases[selected.phase],proof=await packets.inspect(snapshot,phase.id,{signal,policyTraversal});
    if(!proof)throw corrupt('The pending question lost its submitted source.');
    const active=await votes.activeAccepted(snapshot,phase.id,proof,{signal,policyTraversal});
    const completed=active.votes.filter(item=>item.value.thresholdReached);
    if(completed.length!==1||completed[0]!==active.votes.at(-1))throw corrupt('The pending question has no exact completed human quorum.');
    const approved=completed[0],value=approved.value;
    if(value.routing?.outcome?.kind!=='pause'||value.routing.pendingKey!==selected.question.key)throw corrupt('The vote did not retain this question.');
    const route=routedApprovalSelection(snapshot.workflow,phase,{reached:true,at:value.recordedAt});
    const key=namespaceRoutingQuestionKey(route.pending,phase.generation,value.routing.schemaVersion);
    if(!same(snapshot.workflow.pendingDecision,{...route.pending,key})||phase.approvedAt!==value.recordedAt
      ||snapshot.workflow.currentPhase!==value.currentPhase)throw corrupt('The question differs from its original approved outcome.');
    return {selected,proof,approved};
  }
  return Object.freeze({read});
}
