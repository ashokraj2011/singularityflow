/** Private optional read capability. V1 stores and records keep their original public contract. */
import {namespaceAddress,namespaceIdentifier,namespaceScope,exactObject,namespaceError} from './values.mjs';
import {jsonValueContract} from '../../foundation/record-schema.mjs';
const capabilities=new WeakMap();
const batchJson=jsonValueContract({maximumBytes:8*1024*1024,maximumDepth:32,maximumNodes:200000,
  inputCode:'SDA_NAMESPACE_UNSUPPORTED',limitCode:'SDA_NAMESPACE_LIMIT_INVALID'}).namespaceJson;
export const NAMESPACE_READ_BATCH_PROFILE='sflow-namespace-read-batch/v1';
export function namespaceReadBatchRequest(input){
  if(!Array.isArray(input)||input.length<1||input.length>8)throw namespaceError('Use one through eight explicit namespace observations.');
  return input.map(row=>{if(row?.kind==='record'){
    exactObject(row,['kind','namespace','key']);return {kind:'record',...namespaceAddress({namespace:row.namespace,key:row.key})};
  }if(row?.kind==='operation'){exactObject(row,['kind','operationId']);return {kind:'operation',operationId:namespaceIdentifier(row.operationId,'Operation ID')};}
    throw namespaceError('A namespace batch may read only explicit records or operation receipts.');});
}
/** Only the journal adapter registers a real, single-observation reader. Copies grant no capability. */
export function attachNamespaceReadBatch(port,read){
  if(typeof read!=='function'||typeof port?.read!=='function'||typeof port.inspectOperation!=='function')throw namespaceError('A read batch needs its actual store methods.');
  capabilities.set(port,{read,methods:[port.read,port.inspectOperation],descriptor:port.descriptor});return port;
}
function capability(port){const value=capabilities.get(port);return value&&value.methods[0]===port.read&&value.methods[1]===port.inspectOperation&&value.descriptor===port.descriptor?value:null;}
/** Owned captures may retain the same reader. A decorated/copied source cannot borrow it. */
export function bindNamespaceReadBatch(source,target){const value=capability(source);if(value)attachNamespaceReadBatch(target,value.read);return target;}
export async function readNamespaceBatch(port,scope,input,options={}){
  const value=capability(port);if(!value)return null;
  scope=namespaceScope(scope);const requests=namespaceReadBatchRequest(input),result=await value.read(scope,requests,options);
  try{exactObject(result,['profile','scope','snapshot','facts']);
    if(result.profile!==NAMESPACE_READ_BATCH_PROFILE||JSON.stringify(result.scope)!==JSON.stringify(scope)||!Array.isArray(result.facts)||result.facts.length!==requests.length)throw Error('Another read batch.');
    exactObject(result.snapshot,['sequence','sha256']);if(!Number.isSafeInteger(result.snapshot.sequence)||result.snapshot.sequence<0
      ||(result.snapshot.sequence===0?result.snapshot.sha256!==null:! /^[a-f0-9]{64}$/u.test(result.snapshot.sha256)))throw Error('Another observation revision.');
    for(const [index,fact]of result.facts.entries()){exactObject(fact,['request','result']);if(JSON.stringify(fact.request)!==JSON.stringify(requests[index]))throw Error('Another observation key.');}
    batchJson(result);return result;
  }catch(cause){throw namespaceError('The namespace batch returned a differently bound observation.','SDA_NAMESPACE_UNSUPPORTED',{stage:'read-batch'},cause);}
}
