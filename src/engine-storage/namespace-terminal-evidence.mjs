/** A proposed human vote is evaluated as a proposal, never passed off as an accepted SDA receipt. */
import {canonicalJson} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {NODE_TEXT_DIGESTS,NODE_TEXT_VALUE_SYNTAX} from '../records.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from '../engine-compatibility/node-configuration-path.mjs';
import {evidenceEvaluationPolicies} from '../kernel/evidence-evaluation.mjs';
import {principalApprovalPlan} from '../kernel/approval-policy.mjs';
import {advanceCompletedPhase,recordPhaseApprovalState,resolvePhaseChangeRequests} from '../kernel/lifecycle-transitions.mjs';
import {routedApprovalSelection,planRoutedApproval} from '../kernel/routed-approval.mjs';
import {createNamespaceEvidenceReader} from './namespace-evidence-reader.mjs';
import {createNamespaceObligationRiskOwner} from './namespace-obligation-risk-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),rules=evidenceEvaluationPolicies(NODE_CONFIGURATION_PATH_SYNTAX,NODE_TEXT_VALUE_SYNTAX,NODE_TEXT_DIGESTS),
  fail=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>{throw new SingularityFlowError(message,{code,details});};
const intent=value=>Object.fromEntries(['projectId','workId','phase','generation','operationId','requestSha256','baseRevision','configuration','reviewPacket','artifactSet',
  'actor','agentId','recordedAt','authorityGroup','selfApproval','thresholdReached','currentPhase'].map(key=>[key,value[key]]));
export function createNamespaceTerminalEvidenceOwner({observer,scope,workId}){
  const evidence=createNamespaceEvidenceReader({observer,scope,workId}),risks=createNamespaceObligationRiskOwner({observer,scope,workId});
  async function candidate(snapshot,value,{signal,at=value.recordedAt,author}={}){
    const original=snapshot.workflow,phase=original.phases[value.phase];
    if(value.workId!==workId||value.projectId!==scope.projectId||value.baseRevision!==snapshot.revision||!same(value.configuration,snapshot.configuration)
      ||phase?.status!=='awaiting_approval'||original.currentPhase!==phase.id||phase.generation!==value.generation||value.currentPhase!==null||!value.thresholdReached)
      fail('Final evidence needs the exact submitted phase and actual proposed closing vote.');
    const policy=principalApprovalPlan(original,phase,{actor:value.actor,agentId:value.agentId},{author,active:phase.approvals});
    if(!policy.reached||policy.authorityGroup!==value.authorityGroup||policy.selfApproval!==value.selfApproval)fail('The final evaluation has another human authority or quorum.');
    const observed=await evidence.unexcepted(snapshot,{signal,at}),proofs=await risks.admitted(snapshot,{signal}),
      decision={decision:'approved',generation:value.generation,at:value.recordedAt,actor:value.actor.identity,principalId:value.actor.principalId,agent:value.agentId,
        approvedBy:value.actor.principalId,authorityGroup:value.authorityGroup,reviewPacketSha256:value.reviewPacket.sha256,artifactSetSha256:value.artifactSet.sha256,selfApproval:value.selfApproval};
    let proposed=structuredClone(original);
    if(value.routing){const route=routedApprovalSelection(original,phase,{reached:true,at:value.recordedAt});
      if(route.currentPhase!==null||route.outcome?.kind!=='end')fail('Only the pinned end route can carry terminal evidence.');
      proposed=planRoutedApproval(original,phase.id,{decision,reached:true,at:value.recordedAt,actorId:value.actor.principalId,agentId:value.agentId,
        authorityGroup:value.authorityGroup,outcome:route.outcome,pending:route.pending}).workflow;
    }else{
      const selected=proposed.phases[phase.id];resolvePhaseChangeRequests(proposed,selected,{at:value.recordedAt,actor:value.actor.principalId});
      advanceCompletedPhase(proposed,selected,value.recordedAt);recordPhaseApprovalState(selected,decision,{key:value.actor.principalId,reached:true});
      if(proposed.currentPhase!==null)fail('The sequential phase does not close this Story.');
    }
    const graph=rules.evidenceGraph({...observed.graph,workflow:proposed,terminal:null},{completenessReview:observed.graph.completenessReview}),
      unexcepted=rules.evaluateEvidence(graph,{at,boundary:'terminal',mode:'decision'}),
      report=rules.evaluateEvidence(graph,{at,boundary:'terminal',mode:'decision',admission:{riskDecisions:proofs.map(row=>row.value.outcome.record),
        riskBindings:risks.bindings(snapshot,unexcepted,proofs)}});
    if(report.decision.gate==='block')fail('Meet the remaining obligations, repair their evidence, or obtain an eligible original-owner risk decision before closing the Story.',
      'ENGINE_TERMINAL_EVIDENCE_REQUIRED',{rows:report.rows.filter(row=>!['satisfied','satisfied-with-exception','not-applicable'].includes(row.result)).slice(0,32),
        actions:[{operation:'story.evidence',inputs:{workId}}]});
    return {value:{schemaVersion:1,profile:'sflow-namespace-terminal-evidence/v1',approval:intent(value),proposal:'uncommitted-human-vote',
      sourceInputSha256:observed.graph.inputSha256,report,riskReceipts:proofs.map(row=>row.reference)},references:[...observed.references.filter(row=>row.namespace==='evidence'),...proofs.map(row=>row.reference)],
      readBindings:observed.readBindings,fresh:observed.fresh};
  }
  async function verify(snapshot,value,options={}){
    const data=await observer.bytes(value.terminalEvidence,value.terminalEvidence.bytes,options.signal);let retained;
    try{retained=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}catch{fail('The final evidence record is not UTF-8 JSON.');}
    const actual=await candidate(snapshot,value,options);if(!same(actual.value,retained))fail('The terminal evidence differs from its original observations and proposed human vote.');
    return {...actual,references:[value.terminalEvidence,...actual.references]};
  }
  return Object.freeze({candidate,verify});
}
