/** SQL task values shared by execution and coordination; no process or filesystem access. */
import {createHash} from 'node:crypto';
import {cloneSgosRecordValue,canonicalJson,admitRecordSchemaVersion,WORK_PRODUCT_SCHEMAS} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {datasetSnapshot} from '../kernel/work-products.mjs';
import {freezeDeep} from './node-execution-values.mjs';
const bytesHash=v=>createHash('sha256').update(v).digest('hex');
const fail=(message,code)=>{throw new SingularityFlowError(message,{code});};
const taskFields=['profile','kind','query','datasets','batchId','requestSha256'];
export function sqliteDataRequest({kind='query',query,datasets,batchId=null}={}){
  ({kind,query,datasets,batchId}=cloneSgosRecordValue({kind,query,datasets,batchId}));
  if(Buffer.byteLength(canonicalJson({query,datasets,kind,batchId}))>4*1024*1024)fail('The complete SQL task exceeds its retained input bound.','SGOS_DATA_TASK_INVALID');
  return freezeDeep(requestValue({profile:'sflow-sql-data-task/v1',kind,query,datasets,batchId,
    requestSha256:bytesHash(canonicalJson({query,datasets,kind,batchId}))}));
}
export function requestValue(value){
  if(!value||typeof value!=='object'||Object.keys(value).length!==taskFields.length||taskFields.some(k=>!Object.hasOwn(value,k))
    ||value.profile!=='sflow-sql-data-task/v1'||!['query','batch'].includes(value.kind)||typeof value.query!=='string'||!value.query.trim()||value.query.length>65536
    ||value.kind==='query'&&value.batchId!==null||value.kind==='batch'&&!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.batchId)
    ||!Array.isArray(value.datasets)||!value.datasets.length||value.datasets.length>32)fail('Use an exact bounded SQL data task.','SGOS_DATA_TASK_INVALID');
  const tables=new Set();
  for(const input of value.datasets){
    if(!input||Object.keys(input).length!==2||!Object.hasOwn(input,'table')||!Object.hasOwn(input,'data')
      ||typeof input.table!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.table)||tables.has(input.table))fail('The query input tables differ from their declared bindings.','SGOS_DATA_TASK_INVALID');
    tables.add(input.table);datasetSnapshot(input.data);
  }
  const identity=bytesHash(canonicalJson({query:value.query,datasets:value.datasets,kind:value.kind,batchId:value.batchId}));
  if(value.requestSha256!==identity)fail('The data task changed after its input digest was established.','SGOS_DATA_TASK_INVALID');
  return structuredClone(value);
}
/** Actual execution facts only. Large diagnostic bytes stay in the retained observation. */
export function sqliteDataObservation({output,usage,recordedAt}){
  if(output?.profile!=='sflow-sql-data-result/v1'||output.modelInvocations!==0||output.process?.closed!==true
    ||usage?.modelInvocations!==0||typeof recordedAt!=='string'||!Number.isFinite(Date.parse(recordedAt)))fail('Use the actual completed SQL execution observation.','SGOS_DATA_RESULT_INVALID');
  return cloneSgosRecordValue({schemaVersion:1,profile:'sflow-data-execution-observation/v1',recordedAt,process:output.process,
    diagnostic:output.diagnostic,effect:output.effect,queryExecuted:output.result?.queryExecuted??null,
    originalContractSha256:output.result?.sink?.originalContractSha256??null,usage});
}
export function sqliteDataObservationPreview(value){
  admitRecordSchemaVersion(WORK_PRODUCT_SCHEMAS.observation,value);
  if(value.profile!=='sflow-data-execution-observation/v1')fail('Another SQL observation profile.','SGOS_DATA_RESULT_INVALID');
  const diagnostic=value.diagnostic;
  if(diagnostic===null)return {...cloneSgosRecordValue(value),diagnosticTruncated:false};
  const message=typeof diagnostic.message==='string'?diagnostic.message:canonicalJson(diagnostic),messageBytes=Buffer.from(message),
    details=diagnostic.details??null,detailsBytes=Buffer.from(canonicalJson(details)),truncated=messageBytes.length>4096||detailsBytes.length>4096;
  let prefix=message;
  if(messageBytes.length>4096){let length=0,end=0;for(const character of message){const n=Buffer.byteLength(character);if(length+n>4096)break;length+=n;end+=character.length;}prefix=message.slice(0,end);}
  return {...cloneSgosRecordValue(value),diagnostic:{name:typeof diagnostic.name==='string'?diagnostic.name:null,code:diagnostic.code??null,
    message:prefix,
    details:detailsBytes.length>4096?null:cloneSgosRecordValue(details)},diagnosticTruncated:truncated};
}
