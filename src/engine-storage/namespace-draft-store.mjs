/** Conditional machine-private working storage. Business admission is the caller's kernel rule. */
import { createHash } from 'node:crypto';
import { SingularityFlowError } from '../foundation/failures.mjs';
import { canonicalJson } from '../foundation/record-schema.mjs';
import { validateNamespaceStore,namespaceLimits } from '../sda/namespace/contract.mjs';
import { namespaceScope,namespaceIdentifier,namespaceRevision,namespaceJson,namespaceIdentityJson } from '../sda/namespace/values.mjs';
import { namespaceTransaction,namespaceTransactionIdentity } from '../sda/namespace/transaction.mjs';
import { namespaceJournalReceipt } from '../sda/namespace/journal-contract.mjs';
import { validateContentStore,contentReference } from '../sda/content/contract.mjs';
import { namespaceDraftRecord,namespaceDraftValue } from './namespace-draft-contract.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const error=(message,code,details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});
function cancelled(signal){if(signal?.aborted)throw error('The local draft operation was cancelled before its next effect.','ENGINE_OPERATION_CANCELLED');}

export function createNamespaceDraftStore({records,content,scope,workId,phaseId}={}) {
  validateNamespaceStore(records);validateContentStore(content);scope=namespaceScope(scope);
  for(const [key,value] of Object.entries({workId,phaseId}))namespaceIdentifier(value,key);
  const deviceId=records.descriptor.binding.deviceId;
  if(records.descriptor.binding.kind!=='machine-local'||content.descriptor.binding.kind!=='machine-local'
    ||content.descriptor.binding.deviceId!==deviceId)throw error('Draft records and bytes need the same explicit machine-local device binding.','ENGINE_INPUT_INVALID');
  const binding=Object.freeze({projectId:scope.projectId,deviceId,workId,phaseId}),limits=namespaceLimits(records.descriptor.limits);
  const key='drafts/'+hash(namespaceIdentityJson(binding)),headKey=key+'/head';
  const read=records.read.bind(records),transact=records.transact.bind(records),inspectOperation=records.inspectOperation.bind(records);
  const readBytes=content.read.bind(content),put=content.put.bind(content);
  const operationKey=id=>key+'/operations/'+hash(namespaceIdentityJson({operationId:id}));
  const txId=id=>'local-draft-'+hash(namespaceIdentityJson({binding,operationId:id}));
  function stored(kind,value) {
    try {return namespaceDraftValue(kind,namespaceJson(value,{maxBytes:limits.maxValueBytes}),binding);}
    catch(cause){if(cause.code==='ENGINE_STORAGE_UNSUPPORTED')throw cause;throw error('A persisted local draft record is invalid.','ENGINE_STORAGE_CORRUPT',binding,cause);}
  }
  async function record(selected,immutable,signal) {
    cancelled(signal);const result=await read(scope,'local',selected,{signal});cancelled(signal);
    if(result?.status==='missing'&&result.record===null)return null;
    if(result?.status!=='present'||result.record?.namespace!=='local'||result.record.key!==selected
      ||result.record.immutable!==immutable||namespaceRevision(result.record.version)===null)throw error('The private metadata port returned another record.','ENGINE_PORT_RESULT_INVALID');
    return result.record;
  }
  async function bytes(reference,{signal}={}) {
    cancelled(signal);reference=contentReference(reference);
    if(reference.namespace!=='local')throw error('Draft content must remain machine private.','ENGINE_INPUT_INVALID');
    const result=await readBytes(scope,reference,{maximumBytes:reference.bytes,signal});cancelled(signal);
    if(result?.status==='missing'&&result.data===null)throw error('Required private draft bytes are missing on this device.','ENGINE_STORAGE_CONTENT_MISSING',{...binding,reference});
    if(result?.status!=='present'||!same(contentReference(result.reference),reference)||!(result.data instanceof Uint8Array)
      ||result.truncated!==false||result.data.byteLength!==reference.bytes)throw error('The private content port returned another draft binding.','ENGINE_PORT_RESULT_INVALID');
    if(hash(result.data)!==reference.sha256)throw error('Private draft bytes have a different digest.','ENGINE_STORAGE_CORRUPT');
    return Buffer.from(result.data);
  }
  async function putBytes(data,{signal}={}) {
    cancelled(signal);if(!(data instanceof Uint8Array))throw error('Draft content needs actual bytes.','ENGINE_INPUT_INVALID');
    const expected={namespace:'local',sha256:hash(data),bytes:data.byteLength},saved=await put(scope,'local',data,{signal});
    if(!same(contentReference(saved?.reference),expected)||typeof saved.reused!=='boolean')throw error('The private content port did not acknowledge draft bytes.','ENGINE_PORT_RESULT_INVALID');
    await bytes(expected,{signal});return expected;
  }
  async function body(reference,signal) {
    let value;try {value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await bytes(reference,{signal})));}
    catch(cause){if(cause.code)throw cause;throw error('A local draft body is not UTF-8 JSON.','ENGINE_STORAGE_CORRUPT',binding,cause);}
    return stored('body',value);
  }
  function transaction(operation) {
    const head=namespaceDraftRecord('head',{...binding,body:operation.body,operationId:operation.operationId});
    return namespaceTransaction({operationId:txId(operation.operationId),preconditions:[
      {namespace:'local',key:headKey,version:operation.expectedRevision},
      {namespace:'local',key:operationKey(operation.operationId),version:null}
    ],changes:[{op:'put',namespace:'local',key:operationKey(operation.operationId),immutable:true,value:operation},
      {op:'put',namespace:'local',key:headKey,immutable:false,value:head}],events:[]},limits);
  }
  function receipt(result,operation) {
    const tx=transaction(operation);let r;
    try {r=namespaceJournalReceipt(result?.receipt,scope,tx.operationId);
      if(result.status!=='committed'||r.requestDigest!==hash(namespaceTransactionIdentity(scope,tx,limits))||r.eventIds.length
        ||result.replayed!==undefined&&typeof result.replayed!=='boolean'
        ||r.records.length!==2||!tx.changes.every(change=>r.records.some(row=>row.namespace===change.namespace&&row.key===change.key&&namespaceRevision(row.version)!==null)))throw Error('Another receipt.');}
    catch(cause){throw error('Inspect the original private draft operation; its acceptance receipt is invalid.','ENGINE_PORT_RESULT_INVALID',null,cause);}
    return r;
  }
  async function inspect(operationId,parametersSha256,{signal}={}) {
    namespaceIdentifier(operationId,'Draft operation ID');cancelled(signal);
    if(typeof parametersSha256!=='string'||!/^([a-f0-9]{64})$/u.test(parametersSha256))throw error('A local draft inspection needs its exact request digest.','ENGINE_INPUT_INVALID');
    const observed=await inspectOperation(scope,txId(operationId),{signal});
    if(observed?.status==='missing'&&observed.receipt===null)return null;
    const saved=await record(operationKey(operationId),true,signal);
    if(!saved)throw error('An accepted private draft lost its immutable operation.','ENGINE_STORAGE_CORRUPT');
    const operation=stored('operation',saved.value);
    if(operation.operationId!==operationId||operation.parametersSha256!==parametersSha256)throw error('This private operation ID belongs to another draft update.','ENGINE_OPERATION_ID_REUSED');
    const r=receipt(observed,operation);
    if(r.records.find(row=>row.key===saved.key).version!==saved.version)throw error('The immutable private operation differs from its acceptance receipt.','ENGINE_STORAGE_CORRUPT');
    const value=await body(operation.body,signal);
    return {revision:r.records.find(row=>row.key===headKey).version,body:operation.body,payload:value.payload,receipt:r,replayed:true};
  }
  async function capture({signal}={}) {
    const saved=await record(headKey,false,signal);if(!saved)return null;
    const head=stored('head',saved.value),operationRecord=await record(operationKey(head.operationId),true,signal);
    if(!operationRecord)throw error('The current private draft lost its immutable operation.','ENGINE_STORAGE_CORRUPT');
    const operation=stored('operation',operationRecord.value);
    const accepted=receipt(await inspectOperation(scope,txId(head.operationId),{signal}),operation);
    if(operation.operationId!==head.operationId||!same(operation.body,head.body)
      ||accepted.records.find(row=>row.key===operationRecord.key).version!==operationRecord.version
      ||accepted.records.find(row=>row.key===headKey).version!==saved.version)throw error('The current private draft differs from its accepted operation.','ENGINE_STORAGE_CORRUPT');
    const value=await body(head.body,signal),fresh=await record(headKey,false,signal);
    if(!fresh||fresh.version!==saved.version)throw error('The private draft changed while it was read.','ENGINE_CONTEXT_CHANGED',binding);
    return {revision:saved.version,body:head.body,payload:value.payload,operationId:head.operationId};
  }
  async function save({operationId,parametersSha256,expectedRevision,payload},{signal}={}) {
    namespaceIdentifier(operationId,'Draft operation ID');namespaceRevision(expectedRevision);
    if(typeof parametersSha256!=='string'||!/^([a-f0-9]{64})$/u.test(parametersSha256))throw error('A local draft operation needs its exact request digest.','ENGINE_INPUT_INVALID');
    const accepted=await inspect(operationId,parametersSha256,{signal});if(accepted)return accepted;
    const value=namespaceJson(namespaceDraftRecord('body',{...binding,payload}),{maxBytes:limits.maxValueBytes});
    namespaceDraftValue('body',value,binding);
    const data=Buffer.from(canonicalJson(value)),reference=await putBytes(data,{signal});
    const operation=namespaceDraftRecord('operation',{...binding,operationId,parametersSha256,expectedRevision,body:reference});
    stored('operation',operation);const tx=transaction(operation);cancelled(signal);
    let result;
    try {result=await transact(scope,tx,{signal});}
    catch(cause){if(!['SDA_NAMESPACE_REVISION_CONFLICT','SDA_NAMESPACE_OPERATION_ID_REUSED'].includes(cause.code))throw cause;
      const concurrent=await inspect(operationId,parametersSha256,{signal});if(!concurrent)throw cause;return concurrent;}
    const r=receipt(result,operation);
    return {revision:r.records.find(row=>row.key===headKey).version,body:reference,payload:structuredClone(payload),receipt:r,replayed:result.replayed===true};
  }
  return Object.freeze({binding,bytes,put:putBytes,capture,inspect,save});
}
