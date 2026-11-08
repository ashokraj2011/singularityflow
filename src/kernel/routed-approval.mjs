/** Pure routing transitions after a separately verified human approval threshold. No authority or I/O. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {decisionAfter,decisionOutcomeFacts,pendingDecisionPayload,resolveDecisionChoicePlan,assertChoiceKeepsDependencies} from './workflow-decisions.mjs';
import {decisionContextSelection} from './decision-plan.mjs';
import {primaryDocumentPublicationRequirements} from './publication-intent.mjs';
import {skillPhaseHostRequirement} from './phase-admission.mjs';
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
function loop(workflow,phase,outcome,{at,actorId,agentId,authorityGroup,comment=null}) {
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
    comment:comment??outcome.label,requestedAt:at,requestedBy:actorId,agent:agentId??null,channel:'engine-sdk',authorityGroup,
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

/** A separately authenticated human may answer only the exact current question, with a reason. */
export function routingChoiceSelection(workflow,{option=null,to=null,expected=null,reason=''}) {
  const selected=decisionContextSelection(workflow),pending=workflow.pendingDecision;
  if(!pending)throw new SingularityFlowError('This Story is not waiting for a decision.',{code:'DECISION_NOT_PENDING'});
  if(expected!==pending.key)throw new SingularityFlowError('Review the current question before choosing its route.',{
    code:expected===null?'ENGINE_DECISION_CONFIRMATION_REQUIRED':'DECISION_STALE',details:{expected,current:pending.key}});
  if(typeof reason!=='string'||!reason.trim())throw new SingularityFlowError('A human route choice requires a reason.',{code:'DECISION_REASON_REQUIRED'});
  const {route,reach}=resolveDecisionChoicePlan(workflow,pending,{option,to});
  if(route.id==='step')assertChoiceKeepsDependencies(workflow,pending,reach);
  const outcome={decision:pending.decision,label:pending.label,after:pending.after,kind:reach.kind==='backward'?'loop':reach.kind,
    route:route.id,routeLabel:route.label,target:reach.target,skipped:reach.skipped,values:pending.values??null,
    maxRounds:pending.maxRounds??null,by:'person'};
  if(outcome.kind==='loop')outcome.round=(workflow.decisionRounds?.[pending.decision]?.count??0)+1;
  return {phase:selected.phase,pendingKey:pending.key,outcome,reason:reason.trim()};
}

/** Detached routing proposal. This neither grants authority nor records application/visual acceptance. */
export function planRoutingChoice(workflow,request,{at,actorId,agentId=null,authorityGroup}) {
  try {
    const proposed=structuredClone(workflow),selected=routingChoiceSelection(proposed,request),phase=proposed.phases[selected.phase];
    if(typeof at!=='string'||!at||typeof actorId!=='string'||!actorId||typeof authorityGroup!=='string'||!authorityGroup
      ||!Array.isArray(proposed.history))invalid();
    const outcome=selected.outcome;
    if(outcome.kind==='loop')loop(proposed,phase,outcome,{at,actorId,agentId,authorityGroup,comment:selected.reason});
    else advanceCompletedPhase(proposed,phase,at,outcome.kind==='next'?null:outcome);
    proposed.decisionLog??=[];
    proposed.decisionLog.push({decision:outcome.decision,after:phase.id,kind:outcome.kind,reason:null,route:outcome.route,
      target:outcome.target,skipped:[...outcome.skipped],round:outcome.round??null,values:outcome.values,by:'person',
      at,actor:actorId,authorityGroup,identityAssurance:null,comment:selected.reason,pendingKey:selected.pendingKey});
    proposed.history.push({at,actor:actorId,agent:agentId,event:'decision_made',phase:phase.id,detail:outcome.decision});
    return {...selected,workflow:proposed};
  }catch(cause){if(cause instanceof SingularityFlowError)throw cause;invalid(cause);}
}

/** Initial document-only hosts must not route around unimplemented delivery or final Story policies. */
export function routingChoiceRequirements(workflow,phase,{definition={}}={}) {
  const required=new Set(primaryDocumentPublicationRequirements(workflow,phase,{definition}));
  if(skillPhaseHostRequirement(workflow,phase))required.add('qualified-skill-host');
  if(workflow.resolution.presence)required.add('person-presence');
  if(workflow.phaseOrder.some(id=>{
    const roles=workflow.resolution.obligationGraph?.nodes?.find(node=>node.id===id)?.responsibilities;
    return !Array.isArray(roles)||roles.length!==1||roles[0]!=='review';
  }))required.add('routing-delivery-obligations');
  return Object.freeze([...required].sort());
}
