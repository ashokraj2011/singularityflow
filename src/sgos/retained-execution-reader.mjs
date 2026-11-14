/** Read-only SGOS result replay. It cannot execute, authorize, acquire a lease or write. */
import {createHash} from 'node:crypto';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {assertSgosOperationalStoreAdapter} from './operational-contract.mjs';
import {validateContentStore,contentReference} from '../sda/content/contract.mjs';
import {namespaceScope} from '../sda/namespace/values.mjs';
import {MAXIMUM_BYTES,handleValue,restoredError,createExecutionAttemptValues} from './execution-attempt-values.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),hash=v=>createHash('sha256').update(v).digest('hex');
const fail=(message,code='SGOS_EXECUTION_RECORD_INVALID',details=null)=>{throw new SingularityFlowError(message,{code,details});};
export function createRetainedExecutionReader({store,content,scope}){
  assertSgosOperationalStoreAdapter(store);validateContentStore(content);scope=namespaceScope(scope);
  const read=store.read.bind(store),bytes=content.read.bind(content),codec=createExecutionAttemptValues(scope.projectId,json);
  async function json(reference){
    reference=contentReference(reference,MAXIMUM_BYTES);if(reference.namespace!=='runtime')fail('Execution bytes must remain in runtime storage.');
    const result=await bytes(scope,reference,{maximumBytes:reference.bytes});
    if(result?.status!=='present'||result.truncated!==false||!same(result.reference,reference)||!(result.data instanceof Uint8Array)
      ||result.data.byteLength!==reference.bytes||hash(result.data)!==reference.sha256)fail('Retained execution bytes are missing, truncated or changed.','SGOS_EXECUTION_CONTENT_CORRUPT');
    try{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(result.data));if(!Buffer.from(canonicalJson(value)).equals(result.data))throw Error('Noncanonical bytes.');return value;}
    catch(cause){throw new SingularityFlowError('Retained execution content is not canonical UTF-8 JSON.',{code:'SGOS_EXECUTION_CONTENT_CORRUPT',cause});}
  }
  async function completed(handle){handle=handleValue(handle);const key=codec.keyFor(handle.contractSha256),snapshot=await read(),raw=snapshot.entries[key];
    if(raw===undefined)fail('The execution handle is not retained by this runtime.','SGOS_GEU_HANDLE_STALE');
    const value=codec.record(raw,key);if(!same(value.handle,handle))fail('The execution handle differs from its retained attempt.','SGOS_GEU_HANDLE_STALE');
    if(value.status!=='complete')fail('Reconcile the original execution owner before collecting its unfinished attempt.','SGOS_EXECUTION_RECOVERY_REQUIRED',{
      attemptId:key,contractSha256:value.contractSha256,status:value.status,owner:value.owner,handle:value.handle,diagnostic:value.diagnostic,automaticRetry:false});
    return codec.verifyTerminal(value,handle);
  }
  return Object.freeze({
    async collect(handle){const value=await completed(handle);if(value.failure)throw restoredError(await json(value.failure));return json(value.result);},
    async events(handle){return codec.events(await completed(handle),handle);},
    async quiesce(handle){return structuredClone((await completed(handle)).quiescence);}
  });
}
