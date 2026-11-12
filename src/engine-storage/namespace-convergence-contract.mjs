/** Separate portable convergence records. This module verifies shape, never authority. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,admitRecordSchemaVersion,phasePublicationBindingValue} from '../foundation/record-schema.mjs';
import {NAMESPACE_CONVERGENCE_SCHEMAS} from '../foundation/record-schema.mjs';
import {DISPOSITIONS} from '../kernel/convergence-values.mjs';
import {storyActorValue} from '../kernel/story-creation.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
import {namespaceIdentifier,namespaceRevision,namespaceJson,namespaceKey,exactObject} from '../sda/namespace/values.mjs';
import {contentReference} from '../sda/content/contract.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value),
  invalid=(message,code='ENGINE_INPUT_INVALID',cause=undefined)=>new SingularityFlowError(message,{code,cause});
export const CONVERGENCE_POLICY_EVIDENCE='convergence-projection/v1';
export function namespaceConvergenceRequest(input){
  if(input.reason!==undefined&&typeof input.reason!=='string')throw invalid('A convergence reason must be human-authored text.');
  const phaseId=namespaceIdentifier(input.phaseId,'Convergence phase'),itemId=input.itemId,disposition=input.disposition,reason=(input.reason??'').trim(),clauseIds=input.clauseIds??[];
  if(typeof itemId!=='string'||!/^CF-[a-f0-9]{12}$/u.test(itemId)||!DISPOSITIONS.includes(disposition)||!/^sha256:[a-f0-9]{64}$/u.test(input.expectedContext??'')
    ||typeof reason!=='string'||reason.length>2048||/[\u0000\u007f]/u.test(reason)||!reason&&disposition!=='rework'
    ||!Array.isArray(clauseIds)||clauseIds.length>128||new Set(clauseIds).size!==clauseIds.length||clauseIds.some(id=>typeof id!=='string'||!id||id!==id.trim()))throw invalid(
    'Select the exact convergence item, human disposition and current context; explain any accepted or deferred gap.');
  return {phaseId,itemId,disposition,reason,clauseIds:[...clauseIds],expectedContext:input.expectedContext};
}
export function namespaceConvergenceDecisionValue(value,{projectId,workId}){
  try{
    admitRecordSchemaVersion(NAMESPACE_CONVERGENCE_SCHEMAS.decision,value);
    exactObject(value,['schemaVersion','format','projectId','workId','phase','generation','operation','operationId','requestSha256',
      'baseRevision','configuration','source','request','actor','agentId','authorityGroup','recordedAt','outcome']);
    if(value.format!=='sflow-namespace-convergence-adjudication/v1'||value.projectId!==projectId||value.workId!==workId
      ||value.operation!=='convergence.adjudicate'||!digest(value.requestSha256)||!Number.isSafeInteger(value.generation)||value.generation<1
      ||namespaceRevision(value.baseRevision)===null)throw Error('Another convergence decision identity.');
    for(const field of ['projectId','workId','phase','operationId','authorityGroup'])namespaceIdentifier(value[field]);
    exactObject(value.configuration,['key','content']);namespaceKey(value.configuration.key);
    if(contentReference(value.configuration.content).namespace!=='config'||!same(storyActorValue(value.actor),value.actor)||value.actor.actorKind!=='human')throw Error('Missing actual configuration or human.');
    if(value.agentId!==null)namespaceIdentifier(value.agentId);projectEnrollmentTimestamp(value.recordedAt);
    if(value.request?.phaseId!==value.phase||!same(value.request,namespaceConvergenceRequest(value.request)))throw Error('Another normalized decision intent.');
    exactObject(value.source,['profile','projection','basisSha256','sourceSha256','projectionSha256','expectedContext']);
    if(value.source.profile!=='sflow-namespace-convergence-decision-source/v1'||contentReference(value.source.projection).namespace!=='evidence'
      ||!digest(value.source.basisSha256)||!digest(value.source.sourceSha256)||!digest(value.source.projectionSha256)||value.source.expectedContext!==value.request.expectedContext)throw Error('Another projection source.');
    exactObject(value.outcome,['currentPhase','record']);namespaceIdentifier(value.outcome.currentPhase);
    if(value.outcome.currentPhase!==value.phase||value.outcome.record?.format!=='sflow-namespace-convergence-finding/v1')throw Error('Another recorded finding.');
    namespaceJson(value);return value;
  }catch(cause){throw invalid('The retained convergence decision is invalid.',['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT',cause);}
}
function make(value){
  if(!value||typeof value!=='object'||['schemaVersion','format'].some(key=>Object.hasOwn(value,key)))throw invalid('Convergence wire metadata belongs to its owner.');
  try{return namespaceConvergenceDecisionValue({schemaVersion:1,format:'sflow-namespace-convergence-adjudication/v1',...value},{projectId:value.projectId,workId:value.workId});}
  catch(cause){throw invalid('The convergence decision does not satisfy its contract.','ENGINE_INPUT_INVALID',cause);}
}
const receipt=(value,record)=>({operation:value.operation,operationId:value.operationId,phase:value.phase,generation:value.generation,
  requestSha256:value.requestSha256,principalId:value.actor.principalId,record});
function receipts(workflow){
  const rows=workflow.namespaceConvergenceDecisionReceipts??[],seen=new Set();
  try{if(!Array.isArray(rows))throw Error('Invalid convergence receipt inventory.');
    for(const row of rows){exactObject(row,['operation','operationId','phase','generation','requestSha256','principalId','record']);
      if(row.operation!=='convergence.adjudicate'||!Number.isSafeInteger(row.generation)||row.generation<1||!digest(row.requestSha256)
        ||contentReference(row.record).namespace!=='evidence'||seen.has(row.operationId))throw Error('Another convergence receipt.');
      for(const field of ['operationId','phase','principalId'])namespaceIdentifier(row[field]);seen.add(row.operationId);}
    return rows;
  }catch(cause){throw invalid('The convergence receipt inventory is invalid.','ENGINE_STORAGE_CORRUPT',cause);}
}
export const namespaceConvergenceDecisionContract=Object.freeze({receiptField:'namespaceConvergenceDecisionReceipts',value:namespaceConvergenceDecisionValue,make,receipt,receipts});
export function namespaceSubmittedConvergence(value,{projectId,workId,phaseId,generation}){
  try{admitRecordSchemaVersion(NAMESPACE_CONVERGENCE_SCHEMAS.confirmation,value);
    exactObject(value,['schemaVersion','profile','projectId','workId','phase','generation','iteration','publication','sourceSha256','convergenceSha256','confirmationDigest','projection','contextBinding']);
    if(value.profile!=='sflow-namespace-convergence-confirmation/v1'||value.projectId!==projectId||value.workId!==workId||value.phase!==phaseId||value.generation!==generation
      ||!Number.isSafeInteger(value.iteration)||value.iteration<1||phasePublicationBindingValue(value.publication).generation!==generation
      ||!digest(value.sourceSha256)||!digest(value.convergenceSha256)||!/^sha256:[a-f0-9]{64}$/u.test(value.confirmationDigest??'')
      ||!/^sha256:[a-f0-9]{64}$/u.test(value.contextBinding??'')||contentReference(value.projection).namespace!=='evidence')throw Error('Another convergence confirmation binding.');
    return value;
  }catch(cause){throw invalid('The convergence submission confirmation is invalid.',['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT',cause);}
}
