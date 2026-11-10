/** Conditional standalone decision records. Domain owners reconstruct the actual input observations. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {admitRecordSchemaVersion,canonicalJson,NAMESPACE_DECISION_SCHEMA,namespacePlanCorrectionRecordProfile} from '../foundation/record-schema.mjs';
import {standaloneDecisionRequest,upstreamOperationRequest} from '../kernel/decision-plan.mjs';
import {storyDocumentRequest} from '../kernel/story-documents.mjs';
import {storyActorValue} from '../kernel/story-creation.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
import {namespaceIdentifier,namespaceRevision,namespaceKey,namespaceJson,exactObject} from '../sda/namespace/values.mjs';
import {contentReference} from '../sda/content/contract.mjs';
export {NAMESPACE_DECISION_SCHEMA} from '../foundation/record-schema.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const nonHuman=new Set(['upstream.raise','forward-amendment.propose','test-command.request','story.document.attach','story.document.detach']);
export function namespaceDecisionValue(value,{projectId,workId}) {
  try{
    admitRecordSchemaVersion(NAMESPACE_DECISION_SCHEMA,value);
    exactObject(value,['schemaVersion','format','projectId','workId','phase','generation','operation','operationId','requestSha256',
      'baseRevision','configuration','source','request','actor','agentId','authorityGroup','recordedAt','outcome']);
    if(value.format!=='sflow-namespace-recorded-decision/v1'||value.projectId!==projectId||value.workId!==workId
      ||!Number.isSafeInteger(value.generation)||value.generation<0||!digest(value.requestSha256)||namespaceRevision(value.baseRevision)===null)throw Error('Another decision binding.');
    for(const field of ['projectId','workId','phase','operation','operationId'])namespaceIdentifier(value[field]);
    exactObject(value.configuration,['key','content']);namespaceKey(value.configuration.key);
    if(contentReference(value.configuration.content).namespace!=='config'||!same(storyActorValue(value.actor),value.actor)
      ||!nonHuman.has(value.operation)&&value.actor.actorKind!=='human')throw Error('Another configuration or actor.');
    if(value.authorityGroup===null?!nonHuman.has(value.operation):typeof namespaceIdentifier(value.authorityGroup)!=='string')throw Error('A human decision needs its original authority.');
    if(value.agentId!==null)namespaceIdentifier(value.agentId);projectEnrollmentTimestamp(value.recordedAt);
    const normalize=value.operation.startsWith('story.document.')?storyDocumentRequest
      :value.operation.startsWith('upstream.')||value.operation.startsWith('forward-amendment.')?upstreamOperationRequest:standaloneDecisionRequest;
    if(value.request?.phaseId!==value.phase||!same(value.request,{...normalize(value.operation,value.request),phaseId:value.phase}))throw Error('Another normalized decision intent.');
    if(!value.source||typeof value.source!=='object'||Array.isArray(value.source))throw Error('Missing source identity.');
    exactObject(value.outcome,['currentPhase','record']);
    if(value.outcome.currentPhase!==null)namespaceIdentifier(value.outcome.currentPhase);
    if(!value.outcome.record||typeof value.outcome.record!=='object'||Array.isArray(value.outcome.record))throw Error('Missing domain record.');
    if(value.operation==='plan.correction.record'&&value.outcome.record.format!==namespacePlanCorrectionRecordProfile('record',value.outcome.record).format)throw Error('Another correction record format.');
    namespaceJson(value);return value;
  }catch(cause){throw new SingularityFlowError('The standalone decision record is invalid.',{cause,
    code:['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT'});}
}
export function namespaceDecisionRecord(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||['schemaVersion','format'].some(key=>Object.hasOwn(value,key)))throw new SingularityFlowError(
    'Decision wire metadata belongs to its registered owner.',{code:'ENGINE_INPUT_INVALID'});
  try{return namespaceDecisionValue({schemaVersion:1,format:'sflow-namespace-recorded-decision/v1',...value},{projectId:value.projectId,workId:value.workId});}
  catch(cause){throw new SingularityFlowError('The decision does not satisfy its record contract.',{code:'ENGINE_INPUT_INVALID',cause});}
}
export function namespaceDecisionReceipt(value,record){return {operation:value.operation,operationId:value.operationId,phase:value.phase,
  generation:value.generation,requestSha256:value.requestSha256,principalId:value.actor.principalId,record};}
export function namespaceDecisionReceipts(workflow){
  const values=workflow.namespaceDecisionReceipts??[],seen=new Set();
  try{if(!Array.isArray(values))throw Error('Invalid decision receipt inventory.');
    for(const value of values){exactObject(value,['operation','operationId','phase','generation','requestSha256','principalId','record']);
      for(const field of ['operation','operationId','phase','principalId'])namespaceIdentifier(value[field]);
      if(!digest(value.requestSha256)||!Number.isSafeInteger(value.generation)||value.generation<0||contentReference(value.record).namespace!=='evidence'
        ||seen.has(value.operationId))throw Error('Invalid or duplicate decision receipt.');seen.add(value.operationId);}
    return values;
  }catch(cause){throw new SingularityFlowError('The standalone decision receipt inventory is invalid.',{code:'ENGINE_STORAGE_CORRUPT',cause});}
}
export const namespaceDecisionContract=Object.freeze({receiptField:'namespaceDecisionReceipts',value:namespaceDecisionValue,
  make:namespaceDecisionRecord,receipt:namespaceDecisionReceipt,receipts:namespaceDecisionReceipts});
