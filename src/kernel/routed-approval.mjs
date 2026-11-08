/** Pure routing transitions after a separately verified human approval threshold. No authority or I/O. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {decisionAfter,decisionOutcomeFacts,pendingDecisionPayload} from './workflow-decisions.mjs';
import {nextPhaseAfterSkillAmendment,advanceCompletedPhase,recordPhaseApprovalState,reopenPhaseRange,
  resolvePhaseChangeRequests} from './lifecycle-transitions.mjs';
const same=(left,right)=>canonicalJson(left)===canonicalJson(right);
const invalid=cause=>{throw new SingularityFlowError('The routed approval does not match its pinned decision.',{code:'LIFECYCLE_TRANSITION_INVALID',cause});};

export function routedApprovalSelection(workflow,phase,{reached,at}) {
  const decision=decisionAfter(workflow,phase.id);if(!decision||typeof reached!=='boolean')invalid();
  const outcome=reached?decisionOutcomeFacts(workflow,phase):null;
  const pending=outcome?.kind==='pause'?pendingDecisionPayload(workflow,phase,outcome,{at}):null;
  const currentPhase=!reached||outcome.kind==='pause'?phase.id:outcome.kind==='end'?null
    :['forward','loop'].includes(outcome.kind)?outcome.target:nextPhaseAfterSkillAmendment(workflow,phase)?.id??null;
  return {decision:decision.id,outcome,pending,currentPhase};
}

/** The shared rework rule clears decisions/approvals; generation is opened by its own owner later. */
function loop(workflow,phase,outcome,{at,actorId,agentId,authorityGroup}) {
  const source=workflow.phaseOrder.indexOf(phase.id),target=workflow.phaseOrder.indexOf(outcome.target);
  if(target<0||target>source||!Number.isSafeInteger(outcome.round)||outcome.round<1)invalid();
  const used=workflow.decisionRounds?.[outcome.decision]?.count??0;
  if(!Number.isSafeInteger(used)||outcome.round!==used+1)invalid();
  workflow.decisionRounds??={};workflow.decisionRounds[outcome.decision]={...(workflow.decisionRounds[outcome.decision]??{}),count:outcome.round,lastAt:at};
  workflow.changeRequests??=[];
  const packet=workflow.lineage?.submissions?.findLast(item=>item.phase===phase.id&&item.generation===phase.generation);
  const request={schemaVersion:1,id:'CR-'+String(workflow.changeRequests.length+1).padStart(3,'0'),status:'open',sourcePhase:phase.id,
    sourceGeneration:phase.generation,targetPhase:outcome.target,clauseIds:[],decision:{id:outcome.decision,route:outcome.route??null,
      round:outcome.round,maxRounds:outcome.maxRounds??null,values:outcome.values??null,by:outcome.by??'rule'},
    comment:outcome.label,requestedAt:at,requestedBy:actorId,agent:agentId??null,channel:'engine-sdk',authorityGroup,
    identityAssurance:null,sourceArtifactSha256:(phase.artifacts??[]).map(item=>({path:item.path,sha256:item.sha256??null})),
    reviewPacketSha256:packet?.packetSha256??null,resolution:null};
  reopenPhaseRange(workflow,{targetId:outcome.target,at,actor:actorId,reason:request.comment,loopDecision:outcome.decision});
  workflow.changeRequests.push(request);
}

/** A vote supplied here is already authenticated and bound to immutable submission evidence by its host. */
function applyRoutedApproval(workflow,phase,{decision,reached,at,actorId,agentId,authorityGroup,outcome,pending}) {
  if(!phase||workflow.currentPhase!==phase.id||phase.status!=='awaiting_approval'||!Array.isArray(workflow.history))invalid();
  const selected=routedApprovalSelection(workflow,phase,{reached,at});
  if(!same(outcome,selected.outcome)||(pending===null)!==(selected.pending===null))invalid();
  if(pending!==null) {
    const {key,...payload}=pending;
    if(typeof key!=='string'||!/^[a-f0-9]{16}$/u.test(key)||!same(payload,selected.pending))invalid();
  }
  if(!decision||decision.decision!=='approved'||decision.generation!==phase.generation||decision.at!==at
    ||decision.principalId!==actorId||decision.authorityGroup!==authorityGroup)invalid();
  recordPhaseApprovalState(phase,decision,{key:actorId,reached});
  if(reached) {
    resolvePhaseChangeRequests(workflow,phase,{at,actor:actorId});
    if(outcome.kind==='loop')loop(workflow,phase,outcome,{at,actorId,agentId,authorityGroup});
    else advanceCompletedPhase(workflow,phase,at,pending?{...outcome,pending}:outcome.kind==='next'?null:outcome);
    workflow.decisionLog??=[];
    workflow.decisionLog.push({decision:outcome.decision,after:phase.id,kind:outcome.kind,reason:outcome.reason??null,
      route:outcome.route??null,target:outcome.target??null,skipped:[...(outcome.skipped??[])],round:outcome.round??null,
      values:outcome.values??null,by:outcome.by??'rule',at,actor:actorId,...(pending?{pendingKey:pending.key}:{})});
    workflow.history.push({at,actor:actorId,agent:agentId??null,event:pending?'decision_pending':'decision_routed',phase:phase.id,detail:outcome.decision});
  }
  workflow.history.push({at,actor:actorId,agent:agentId??null,event:'phase_approved',phase:phase.id,
    detail:reached?'required human approvals recorded':'human approval recorded; threshold not yet met'});
  if(workflow.currentPhase!==selected.currentPhase)invalid();
  return selected;
}

/** Return a detached proposal; malformed rework cannot partly mutate the caller's snapshot or vote. */
export function planRoutedApproval(workflow,phaseId,facts) {
  try {
    const proposed=structuredClone(workflow),selection=applyRoutedApproval(proposed,proposed.phases[phaseId],structuredClone(facts));
    return {...selection,workflow:proposed};
  }catch(cause){if(cause instanceof SingularityFlowError)throw cause;invalid(cause);}
}
