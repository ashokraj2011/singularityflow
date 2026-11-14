/** Immutable work-product mutations, with their own wire family and accepted lifecycle receipts. */
import {WORK_PRODUCT_SCHEMAS,admitRecordSchemaVersion,canonicalJson} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {namespaceJson,namespaceIdentifier,namespaceRevision,namespaceKey,exactObject} from '../sda/namespace/values.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {storyActorValue} from '../kernel/story-creation.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
import {workProductReference,workProductMutationRequest} from '../kernel/work-products.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
function value(input,{projectId,workId}){
  try{
    const v=namespaceJson(input);admitRecordSchemaVersion(WORK_PRODUCT_SCHEMAS.retained,v);
    exactObject(v,['schemaVersion','format','projectId','workId','phase','generation','operation','operationId','requestSha256',
      'baseRevision','configuration','source','request','actor','agentId','authorityGroup','recordedAt','outcome']);
    if(v.format!=='sflow-namespace-work-product/v1'||v.projectId!==projectId||v.workId!==workId||!['work-product.retain','work-product.amend','data.execute'].includes(v.operation)
      ||!Number.isSafeInteger(v.generation)||v.generation<1||!/^[a-f0-9]{64}$/u.test(v.requestSha256??'')||(v.operation==='work-product.amend'?typeof v.authorityGroup!=='string'||v.actor.actorKind!=='human':v.authorityGroup!==null)
      ||!same(storyActorValue(v.actor),v.actor)||namespaceRevision(v.baseRevision)===null
      ||!same(workProductMutationRequest(v.operation,v.request),v.request)||v.request.phaseId!==v.phase)throw Error('Another mutation binding.');
    for(const k of ['phase','operationId'])namespaceIdentifier(v[k]);if(v.agentId!==null)namespaceIdentifier(v.agentId);projectEnrollmentTimestamp(v.recordedAt);
    exactObject(v.configuration,['key','content']);namespaceKey(v.configuration.key);if(contentReference(v.configuration.content).namespace!=='config')throw Error('Another configuration.');
    exactObject(v.outcome,['currentPhase','record']);
    if(v.outcome.record.asset!==null)workProductReference(v.outcome.record.asset,{projectId});
    else if(v.operation!=='data.execute')throw Error('An authored product needs actual content.');
    if(v.outcome.currentPhase!==v.phase||v.outcome.record.phase!==v.phase||v.outcome.record.generation!==v.generation
      ||v.outcome.record.operationId!==v.operationId)throw Error('Another work-product outcome.');
    return v;
  }catch(cause){throw new SingularityFlowError('The retained work-product mutation is invalid.',{code:['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT',cause});}
}
function receipt(v,record){return {operation:v.operation,operationId:v.operationId,phase:v.phase,generation:v.generation,requestSha256:v.requestSha256,principalId:v.actor.principalId,record};}
function receipts(workflow){
  const rows=workflow.namespaceWorkProductReceipts??[],seen=new Set();
  if(!Array.isArray(rows)||rows.length>512)throw new SingularityFlowError('The work-product receipt history is invalid or full.',{code:'ENGINE_STORAGE_CORRUPT'});
  for(const r of rows){exactObject(r,['operation','operationId','phase','generation','requestSha256','principalId','record']);
    namespaceIdentifier(r.operationId);namespaceIdentifier(r.phase);namespaceIdentifier(r.principalId);
    if(!['work-product.retain','work-product.amend','data.execute'].includes(r.operation)||seen.has(r.operationId)||contentReference(r.record).namespace!=='evidence'
      ||!/^[a-f0-9]{64}$/u.test(r.requestSha256??'')||!Number.isSafeInteger(r.generation)||r.generation<1)throw new SingularityFlowError('The work-product receipt history has another binding.',{code:'ENGINE_STORAGE_CORRUPT'});seen.add(r.operationId);}
  return rows;
}
export const namespaceWorkProductContract=Object.freeze({receiptField:'namespaceWorkProductReceipts',value,
  make:v=>value({schemaVersion:1,format:'sflow-namespace-work-product/v1',...v},{projectId:v.projectId,workId:v.workId}),receipt,receipts});
