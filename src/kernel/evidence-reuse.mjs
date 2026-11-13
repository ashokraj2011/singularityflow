/** Reuse value rules. Source, original execution, presence and human authority are admitted by their owners. */
import {SingularityFlowError} from '../foundation/failures.mjs';
export const MAX_EVIDENCE_REUSE_DAYS=90;
const fail=(message,code='EVIDENCE_REUSE_INVALID',details=null)=>{throw new SingularityFlowError(message,{code,details});};
export function evidenceReuseReason(value,{revoking=false}={}){
  const text=String(value??'').trim();
  if(text.length<20||text.length>1000)fail('Say '+(revoking?'why the decision is revoked':'why the recorded run stands for this step')+' in 20 to 1000 characters with --reason.');
  return text;
}
export function evidenceReuseExpiry(expires,at){
  if(expires==null)return null;
  const expiry=/^\d{4}-\d{2}-\d{2}$/u.test(String(expires))?new Date(`${expires}T23:59:59.999Z`):null,now=new Date(at);
  if(!expiry||Number.isNaN(expiry.getTime())||expiry<=now||expiry-now>MAX_EVIDENCE_REUSE_DAYS*86400000)fail(
    `--expires must be a date after today and at most ${MAX_EVIDENCE_REUSE_DAYS} days ahead (YYYY-MM-DD).`);
  return expiry.toISOString();
}
export const NAMESPACE_EVIDENCE_REUSE_PROFILE='sflow-namespace-evidence-reuse/v1';
/** This first portable profile does not replace Code execution or a recovery agreement's no-reuse contract. */
export function namespaceEvidenceReusePhase(workflow,phaseId){
  const phase=workflow.phases?.[phaseId];
  if(!phase||phase.status==='skipped')fail('Name a phase on this Story\'s route.');
  if(phase.writeScope!=='artifact-only'||workflow.resolution?.testRecovery?.enabled)fail(
    'This reuse profile requires an artifact-only receiving phase without a no-reuse recovery agreement. Run its actual checks.',
    'ENGINE_PORT_UNAVAILABLE',{required:[phase.writeScope!=='artifact-only'?'code-execution-reuse':'test-recovery-cohort-reuse'],
      actions:[{operation:'phase.checks.run',inputs:{workId:workflow.workItem.id,phaseId},requiredInputs:['operationId']}]});
  return phase;
}
export function namespaceEvidenceReuseState(workflow,decision,{at}={}){
  if(typeof at!=='string'||!Number.isFinite(Date.parse(at)))fail('Reuse status requires an explicit valid observation time.','ENGINE_INPUT_INVALID');
  const rows=workflow.namespaceEvidenceReuses??[];
  if(rows.some(row=>row.revokes===decision.id))return 'revoked';
  if(decision.expiresAt&&new Date(decision.expiresAt)<=new Date(at))return 'expired';
  const phase=workflow.phases?.[decision.producer.phase];
  if(phase?.status!=='approved'||phase.generation!==decision.producer.generation)return 'superseded';
  return 'active';
}
export function namespaceEvidenceReusePlan(workflow,request,facts,source){
  const proposed=structuredClone(workflow),rows=proposed.namespaceEvidenceReuses??=[],reason=evidenceReuseReason(request.reason,{revoking:Boolean(request.revoke)});
  let record;
  if(request.revoke){
    const target=rows.find(row=>row.id===request.revoke);
    if(!target)fail('This Story has no such evidence-reuse decision.','EVIDENCE_REUSE_UNKNOWN');
    if(rows.some(row=>row.revokes===target.id))fail(target.id+' is already revoked.','EVIDENCE_REUSE_REVOKED');
    record={schemaVersion:1,profile:NAMESPACE_EVIDENCE_REUSE_PROFILE,revokes:target.id,phase:target.phase,
      reason,actor:facts.actorId,authorityGroup:facts.authorityGroup,at:facts.at};
  }else{
    namespaceEvidenceReusePhase(workflow,request.phaseId);
    const candidate=source.candidate;
    if(!candidate||candidate.taskId!==request.attemptId||candidate.producer.phase===request.phaseId
      ||workflow.phaseOrder.indexOf(candidate.producer.phase)>=workflow.phaseOrder.indexOf(request.phaseId))fail(
        'Select an actual submitted execution of an earlier approved phase.','EVIDENCE_REUSE_NOT_ELIGIBLE');
    const standing=rows.find(row=>row.id&&row.phase===request.phaseId&&row.producer.repositoryId===candidate.producer.repositoryId
      &&row.producer.command.id===candidate.producer.command.id&&namespaceEvidenceReuseState(workflow,row,{at:facts.at})==='active');
    if(standing)fail(standing.id+' already accounts for that receiving command and repository.','EVIDENCE_REUSE_ALREADY_RECORDED',{phase:request.phaseId});
    record={schemaVersion:1,profile:NAMESPACE_EVIDENCE_REUSE_PROFILE,id:'ERU-'+String(rows.filter(row=>row.id).length+1).padStart(3,'0'),
      phase:request.phaseId,producer:structuredClone(candidate.producer),observations:structuredClone(source.observations),
      reason,expiresAt:evidenceReuseExpiry(request.expires,facts.at),actor:facts.actorId,authorityGroup:facts.authorityGroup,at:facts.at};
  }
  proposed.namespaceEvidenceReuses=[...rows,record];
  proposed.history.push({at:facts.at,actor:facts.actorId,agent:facts.agentId,event:'evidence_reuse_decided',phase:request.phaseId,
    detail:(record.id??record.revokes)+(record.revokes?' revoked. ':' reused an earlier retained execution. ')+reason});
  return {workflow:proposed,outcome:{currentPhase:workflow.currentPhase,record}};
}
