/** Exact human exceptions for judged articles. They never change machine policy or approve a phase. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,textDigestCapability,admitRecordSchemaVersion,NAMESPACE_CONSTITUTION_EXCEPTION_SCHEMA} from '../foundation/record-schema.mjs';
const error=(message,code='ENGINE_INPUT_INVALID',details=null)=>new SingularityFlowError(message,{code,details});
export function namespaceConstitutionExceptionInput(input){
  const articleId=String(input.articleId??'').toUpperCase(),scope=String(input.scope??'').trim(),reason=String(input.reason??'').trim();
  if(!/^[A-Z][A-Z0-9]*-\d{3,}$/u.test(articleId)||[scope,reason].some(value=>value.length<20||value.length>1000||/[\u0000\u007f]/u.test(value))
    ||!/^sha256:[a-f0-9]{64}$/u.test(input.expectedContext??''))throw error('Review one exact article, its affected scope and a concrete exception reason.');
  let expiresAt=input.expires??null;
  if(expiresAt!==null&&(!Number.isFinite(Date.parse(expiresAt))||new Date(expiresAt).toISOString()!==expiresAt))throw error('An exception expiry is an exact UTC ISO timestamp.');
  return {phaseId:input.phaseId,articleId,scope,reason,expires:expiresAt,expectedContext:input.expectedContext};
}
export function namespaceConstitutionExceptionActive(value,at){
  if(!Number.isFinite(Date.parse(at)))throw error('Article exception evaluation needs an explicit observation time.');
  return value.expiresAt===null||Date.parse(value.expiresAt)>Date.parse(at);
}
export function namespaceConstitutionExceptionPolicies(digestPort){
  const digests=textDigestCapability(digestPort),hash=value=>digests.sha256Utf8(canonicalJson(value));
  function value(record){
    try{admitRecordSchemaVersion(NAMESPACE_CONSTITUTION_EXCEPTION_SCHEMA,record);
      const fields=['schemaVersion','format','id','phase','generation','articleId','articleSha256','scope','reason','at','expiresAt','actor','authorityGroup','binding','exceptionSha256'];
      if(!record||Object.keys(record).length!==fields.length||fields.some(key=>!Object.hasOwn(record,key))
        ||record.format!=='sflow-namespace-constitution-exception/v1'||!/^CEX-\d{3,}$/u.test(record.id)
        ||!Number.isFinite(Date.parse(record.at))||!record.binding||typeof record.binding!=='object'||record.phase!==record.binding.phase
        ||!Number.isSafeInteger(record.generation)||record.generation<1||record.generation!==record.binding.generation
        ||!/^sha256:[a-f0-9]{64}$/u.test('sha256:'+record.articleSha256)||typeof record.actor!=='string'||!record.actor||typeof record.authorityGroup!=='string'||!record.authorityGroup)throw Error('Another exception record.');
      namespaceConstitutionExceptionInput({phaseId:record.binding.phase,articleId:record.articleId,scope:record.scope,reason:record.reason,
        expires:record.expiresAt,expectedContext:'sha256:'+'a'.repeat(64)});
      const {exceptionSha256,...body}=record;if(exceptionSha256!==hash(body))throw Error('Another exception digest.');return record;
    }catch(cause){throw new SingularityFlowError('The namespace constitution exception is invalid.',{cause,
      code:['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT'});}
  }
  function plan(workflow,input,facts,source){
    const request=namespaceConstitutionExceptionInput(input),phase=workflow.phases?.[request.phaseId];
    if(workflow.status!=='in_progress'||workflow.currentPhase!==request.phaseId||phase?.status!=='awaiting_approval'||phase.generation!==source.generation)
      throw error('Record an exception against the current submitted generation.','PHASE_SUBMISSION_REQUIRED');
    if(request.expectedContext!==source.contextBinding)throw error('The reviewed article or publication changed. Read its exact exception context again.',
      'ENGINE_CONSTITUTION_EXCEPTION_STALE',{operation:'constitution.exception.context',inputs:{workId:workflow.workItem.id,phaseId:request.phaseId,articleId:request.articleId}});
    if(source.article?.id!==request.articleId||source.article.type!=='judged'||source.article.status!=='active')throw error(
      'This operation records a human exception to an active judged article; it cannot waive an enforced machine policy.','CONSTITUTION_EXCEPTION_NOT_JUDGED');
    if(request.expires!==null&&Date.parse(request.expires)<=Date.parse(facts.at))throw error('An exception expiry must be after the authenticated decision time.');
    const prior=(source.prior??[]).findLast(row=>row.articleId===request.articleId&&row.binding.phase===request.phaseId
      &&row.binding.generation===source.generation&&canonicalJson(row.binding.publication)===canonicalJson(source.identity.publication));
    if(prior&&namespaceConstitutionExceptionActive(prior,facts.at))throw error('This exact article and publication already have an active recorded exception.',
      'CONSTITUTION_EXCEPTION_ALREADY_RECORDED',{id:prior.id});
    const binding={workId:workflow.workItem.id,phase:request.phaseId,generation:source.generation,configuration:source.identity.configuration,
      storySource:source.identity.storySource,publication:source.identity.publication,reviewPacket:source.identity.reviewPacket,constitution:source.identity.constitution},
      body={schemaVersion:1,format:'sflow-namespace-constitution-exception/v1',id:'CEX-'+String((source.prior??[]).length+1).padStart(3,'0'),phase:request.phaseId,generation:source.generation,
        articleId:request.articleId,articleSha256:source.article.articleSha256,scope:request.scope,reason:request.reason,at:facts.at,expiresAt:request.expires,
        actor:facts.actorId,authorityGroup:facts.authorityGroup,binding},record=value({...body,exceptionSha256:hash(body)}),proposed=structuredClone(workflow);
    proposed.namespaceConstitutionExceptions=[...(source.prior??[]).map(row=>structuredClone(row)),record];
    proposed.history.push({at:facts.at,actor:facts.actorId,agent:facts.agentId,event:'constitution_exception_recorded',phase:request.phaseId,
      detail:record.id+' / '+request.articleId+': '+request.reason});
    return {workflow:proposed,outcome:{currentPhase:request.phaseId,record}};
  }
  return Object.freeze({value,plan});
}
