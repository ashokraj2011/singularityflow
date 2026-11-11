/** Versioned human mutation receipts. Typed owners recompute source, authority and outcome. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,namespaceHumanDecisionProfile} from '../foundation/record-schema.mjs';
import {namespaceIdentifier,namespaceRevision,namespaceKey,namespaceJson,exactObject} from '../sda/namespace/values.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {storyActorValue} from '../kernel/story-creation.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
export function namespaceHumanDecisionValue(value,{projectId,workId}) {
  try{
    const profile=namespaceHumanDecisionProfile(value);
    exactObject(value,['schemaVersion','format','projectId','workId','phase','generation','operation','operationId','requestSha256',
      'baseRevision','configuration','source','request','actor','agentId','authorityGroup','recordedAt','outcome']);
    if(value.format!==profile.format||value.projectId!==projectId||value.workId!==workId
      ||!['conformance.decide','phase.reject'].includes(value.operation)||!digest(value.requestSha256)
      ||!Number.isSafeInteger(value.generation)||value.generation<1||namespaceRevision(value.baseRevision)===null)throw Error('Invalid decision identity.');
    for(const field of ['projectId','workId','phase','operationId','authorityGroup'])namespaceIdentifier(value[field]);
    exactObject(value.configuration,['key','content']);namespaceKey(value.configuration.key);
    if(contentReference(value.configuration.content).namespace!=='config')throw Error('Invalid configuration.');
    if(!same(storyActorValue(value.actor),value.actor)||value.actor.actorKind!=='human')throw Error('A decision needs an authenticated human.');
    if(value.agentId!==null)namespaceIdentifier(value.agentId);projectEnrollmentTimestamp(value.recordedAt);
    exactObject(value.request,value.operation==='conformance.decide'
      ?['phaseId','expected','clauseId','ownerPhase','outcome','expires','reason']:['phaseId','target','reason','confirm']);
    if(value.request.phaseId!==value.phase||typeof value.request.reason!=='string'||value.request.reason!==value.request.reason.trim()
      ||!value.request.reason.length||value.request.reason.length>2048||/[\u0000\u007f]/u.test(value.request.reason))throw Error('Invalid request.');
    if(value.operation==='conformance.decide'){
      namespaceIdentifier(value.request.ownerPhase);
      if(!digest(value.request.expected)||typeof value.request.clauseId!=='string'||!value.request.clauseId.length
        ||!['accept-risk','dismiss'].includes(value.request.outcome)||value.request.expires!==null&&typeof value.request.expires!=='string')throw Error('Invalid disposition.');
      exactObject(value.outcome,['currentPhase','clauseId','ownerPhase','verdict','outcome','reason','expiresAt']);
    }else{namespaceIdentifier(value.request.target);if(!digest(value.request.confirm))throw Error('Invalid submitted packet.');
      exactObject(value.outcome,['currentPhase','changeRequest',...(profile.repairBudget?['repairBudget']:[])]);}
    if(profile.repairBudget&&(value.operation!=='phase.reject'||value.source?.profile!=='sflow-namespace-reviewer-return/v2'))throw Error('Another bounded-return profile.');
    if(!value.source||typeof value.source!=='object'||Array.isArray(value.source))throw Error('Invalid source.');
    namespaceJson(value);return value;
  }catch(cause){throw new SingularityFlowError('The retained human decision is invalid.',{cause,
    code:['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT'});}
}
export function namespaceHumanDecisionRecord(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||['schemaVersion','format'].some(key=>Object.hasOwn(value,key)))throw new SingularityFlowError(
    'The human decision wire version belongs to its registered owner.',{code:'ENGINE_INPUT_INVALID'});
  const profile=namespaceHumanDecisionProfile({schemaVersion:value.source?.profile==='sflow-namespace-reviewer-return/v2'?2:1});
  try{return namespaceHumanDecisionValue({schemaVersion:profile.version,
    format:profile.format,...value},{projectId:value.projectId,workId:value.workId});}
  catch(cause){throw new SingularityFlowError('The human decision input does not satisfy its record contract.',{code:'ENGINE_INPUT_INVALID',cause});}
}
export function namespaceHumanDecisionReceipt(value,record){return {operation:value.operation,operationId:value.operationId,
  phase:value.phase,generation:value.generation,requestSha256:value.requestSha256,principalId:value.actor.principalId,record};}
export function namespaceHumanDecisionReceipts(workflow){
  const values=workflow.namespaceHumanDecisionReceipts??[],seen=new Set();
  try{
    if(!Array.isArray(values))throw Error('Invalid receipt inventory.');
    for(const value of values){exactObject(value,['operation','operationId','phase','generation','requestSha256','principalId','record']);
      namespaceIdentifier(value.operationId);namespaceIdentifier(value.phase);
      if(!['conformance.decide','phase.reject'].includes(value.operation)||!digest(value.requestSha256)
        ||!Number.isSafeInteger(value.generation)||value.generation<1||typeof value.principalId!=='string'||!value.principalId
        ||contentReference(value.record).namespace!=='evidence'||seen.has(value.operationId))throw Error('Invalid receipt.');seen.add(value.operationId);}
    return values;
  }catch(cause){throw new SingularityFlowError('The human decision receipt inventory is invalid.',{cause,code:'ENGINE_STORAGE_CORRUPT'});}
}

export const namespaceHumanDecisionContract=Object.freeze({receiptField:'namespaceHumanDecisionReceipts',value:namespaceHumanDecisionValue,
  make:namespaceHumanDecisionRecord,receipt:namespaceHumanDecisionReceipt,receipts:namespaceHumanDecisionReceipts});
