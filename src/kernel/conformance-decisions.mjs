/** Human dispositions keep the observed verdict. No storage, identity discovery or model text. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {requireApprovalAuthority,rejectionTarget,assertRejectionComment} from './approval-policy.mjs';
import {upstreamDispositionFacts} from './decision-plan.mjs';
import {reopenPhaseRange} from './lifecycle-transitions.mjs';
import {applyNamespaceRepairBudget} from './test-recovery.mjs';
import {sourceRelativePath} from '../foundation/source-snapshot.mjs';
import {plannedClaimAllocatedTo} from './specification-policy.mjs';
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

/** File scope selected from actual reviewed plan rows. Shared files retain their other clause owners. */
export function targetedCodeRepairScope({phaseId,clauseIds,indexes,repositories}){
  if(typeof phaseId!=='string'||!phaseId||!Array.isArray(indexes)||!Array.isArray(repositories)||!repositories.length||repositories.length>32
    ||repositories.some(row=>typeof row?.id!=='string'||!row.id)||new Set(repositories.map(row=>row.id)).size!==repositories.length)fail('Use the exact distinct repositories and approved clause indexes.','ENGINE_REPAIR_SCOPE_INVALID');
  if(!Array.isArray(clauseIds)||!clauseIds.length||clauseIds.length>128||new Set(clauseIds).size!==clauseIds.length
    ||clauseIds.some(id=>typeof id!=='string'||!id||id!==id.trim()))fail('Select one through 128 exact, distinct approved clauses.','ENGINE_REPAIR_CLAUSE_INVALID');
  const known=new Set(indexes.flatMap(index=>(index.clauses??[]).map(row=>row.id))),unknown=clauseIds.filter(id=>!known.has(id));
  if(unknown.length)fail('A targeted return names an unknown approved clause.','ENGINE_REPAIR_CLAUSE_UNKNOWN',{clauseIds:unknown});
  const selected=new Set(clauseIds),allocated=new Set(),rows=[];
  for(const repository of repositories){const paths=new Set(),owners=new Map();
    for(const [id,claim]of Object.entries(repository.claims??{})){
      if(!plannedClaimAllocatedTo(claim,phaseId))continue;
      const locations=[...(claim.expectedPaths??[]),...(claim.tests??[])];
      if(selected.has(id)&&locations.length)allocated.add(id);
      for(const location of locations){const path=sourceRelativePath(location);
        if(selected.has(id)&&/[*?\[\]{}]/u.test(path))fail('Targeted Code repair needs exact plan locations.','ENGINE_REPAIR_LOCATION_REQUIRED',{clauseId:id,path});
        const ids=owners.get(path)??new Set();ids.add(id);owners.set(path,ids);if(selected.has(id))paths.add(path);}
    }
    const sorted=[...paths].sort();rows.push({id:repository.id,paths:sorted,shared:sorted.flatMap(path=>{
      const other=[...owners.get(path)].filter(id=>!selected.has(id)).sort();return other.length?[{path,clauseIds:other}]:[];})});
  }
  const missing=clauseIds.filter(id=>!allocated.has(id));if(missing.length)fail('The selected clauses need exact locations allocated to this Code phase.',
    'ENGINE_REPAIR_LOCATION_REQUIRED',{phaseId,clauseIds:missing});
  return {profile:'sflow-namespace-targeted-code-scope/v1',phase:phaseId,clauseIds:[...clauseIds].sort(),repositories:rows.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)};
}
/** Compare actual predecessor/current deltas; a plan claim is never evidence that an unrelated file was unchanged. */
export function assertTargetedCodeRepairDelta(scope,repositories,{workId,phaseId,ownerPhase}={}){
  const outside=[];for(const repository of repositories){const allowed=new Set(scope.repositories.find(row=>row.id===repository.id)?.paths??[]);
    for(const change of repository.changes)if(!allowed.has(change.path))outside.push({repositoryId:repository.id,path:change.path});}
  if(outside.length)fail('Preserve the draft and correct files outside the reviewed targeted scope, or obtain an exact human plan correction.',
    'ENGINE_TARGETED_REPAIR_SCOPE_EXCEEDED',{profile:'sflow-namespace-targeted-repair-refusal/v1',workId,phase:phaseId,clauses:scope.clauseIds,outside,
      actions:[{operation:'phase.source.inspect',inputs:{workId,phaseId}},{operation:'plan.correction.context',inputs:{workId,...(ownerPhase?{ownerPhase}:{})},
        requiredInputs:[...(!ownerPhase?['ownerPhase']:[]),'operations','reason'],prerequisites:['authenticated-human-plan-approver']}]});
  return repositories.reduce((count,row)=>count+row.changes.length,0);
}

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
  const clauseIds=source.identity?.targeted?[...request.clauseIds]:[];
  const changeRequest={schemaVersion:1,id:changeRequestId,status:'open',
    sourcePhase:phase.id,sourceGeneration:phase.generation,targetPhase:targetId,clauseIds,comment:request.reason,
    requestedAt:facts.at,requestedBy:facts.actorId,agent:facts.agentId,channel:'engine-sdk',authorityGroup:facts.authorityGroup,
    identityAssurance:null,sourceArtifactSha256:(phase.artifacts??[]).map(row=>({path:row.path,sha256:row.sha256??null})),
    reviewPacketSha256:source.reviewPacket.sha256,resolution:null};
  reopenPhaseRange(proposed,{targetId,at:facts.at,actor:facts.actorId,reason:request.reason});
  proposed.changeRequests??=[];proposed.changeRequests.push(changeRequest);
  proposed.phases[phase.id].approvals.push({decision:'rejected',phase:phase.id,target:targetId,reason:request.reason,
    changeRequestId:changeRequest.id,clauseIds,at:facts.at,actor:facts.actorId,agent:facts.agentId,authorityGroup:facts.authorityGroup,
    identityAssurance:null,channel:'engine-sdk',generation:phase.generation,reviewPacketSha256:source.reviewPacket.sha256});
  proposed.history.push({at:facts.at,actor:facts.actorId,agent:facts.agentId,event:'phase_rejected',phase:phase.id,
    detail:changeRequest.id+' returned to '+targetId+': '+request.reason});
  return {workflow:proposed,outcome:{currentPhase:targetId,changeRequest,
    ...(['sflow-namespace-reviewer-return/v2','sflow-namespace-reviewer-return/v3'].includes(source.identity?.profile)?{repairBudget}:{})}};
}
