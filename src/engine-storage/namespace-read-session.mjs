/** Invocation-local reuse of observed immutable storage facts. No cache survives a public operation. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {NAMESPACE_STORE_METHODS,validateNamespaceStore} from '../sda/namespace/contract.mjs';
import {CONTENT_STORE_METHODS,validateContentStore} from '../sda/content/contract.mjs';
import {bindNamespaceReadBatch} from '../sda/namespace/read-batch.mjs';
const proofSessions=new WeakMap();
/** Capture genuine methods without losing their invocation domain. Copies cannot enroll themselves. */
export function captureNamespaceReadBindings(records,content){
  validateNamespaceStore(records);validateContentStore(content);
  const capturedRecords=bindNamespaceReadBatch(records,Object.freeze({descriptor:structuredClone(records.descriptor),...Object.fromEntries(NAMESPACE_STORE_METHODS.map(name=>[name,records[name].bind(records)]))})),
    capturedContent=Object.freeze({descriptor:structuredClone(content.descriptor),...Object.fromEntries(CONTENT_STORE_METHODS.map(name=>[name,content[name].bind(content)]))}),session=proofSessions.get(records);
  if(session?.content===content)proofSessions.set(capturedRecords,{content:capturedContent,read:session.read});
  return Object.freeze({records:capturedRecords,content:capturedContent});
}
/** Only the observer owning these exact captured ports can reuse an observed immutable origin. */
export function memoNamespaceStoryOrigin(records,content,key,observe,{signal}={}){
  const session=proofSessions.get(records);if(!session||session.content!==content)return observe();
  return session.read('story-origin:'+key,observe,()=>true,signal,true,2);
}
/** Accepted witness proof only. Current selection, identity and final writer gates stay outside. */
export function memoNamespaceWitnessProof(records,content,identity,observe,{signal}={}){
  const session=proofSessions.get(records);if(!session||session.content!==content)return observe();
  return session.read('accepted-witness/v1:'+canonicalJson(identity),observe,()=>true,signal,true,2);
}
/** Original human receipt projections only, never live authority, readiness or current selection. */
export function memoNamespaceDecisionProof(records,content,identity,observe,{signal}={}){
  const session=proofSessions.get(records);if(!session||session.content!==content)return observe();
  return session.read('accepted-decision/v1:'+canonicalJson(identity),observe,()=>true,signal,true,2);
}
/** Immutable conditional receipts only. Pending/missing operations and current heads are not cached. */
export function memoNamespaceLifecycleReceiptProof(records,content,identity,observe,{signal}={}){
  const session=proofSessions.get(records);if(!session||session.content!==content)return observe();
  return session.read('accepted-lifecycle-receipt/v1:'+canonicalJson(identity),observe,value=>value?.status==='committed',signal,true,true);
}
/** Verified receipt readers already return deep-frozen JSON. Preserve that read-only contract
 * without cloning entire predecessor/receiving state trees on each nested proof read. */
export function memoNamespaceFrozenLifecycleReceiptProof(records,content,identity,observe,{signal}={}){
  const session=proofSessions.get(records);if(!session||session.content!==content)return observe();
  const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
  return session.read('accepted-frozen-lifecycle-receipt/v1:'+canonicalJson(identity),async()=>freeze(await observe()),
    value=>value?.status==='committed',signal,true,true,value=>value);
}
/** Fully accepted source/check evidence only. A missing result can become accepted during a run. */
export function memoNamespaceSourceEvidenceProof(records,content,identity,observe,{signal}={}){
  const session=proofSessions.get(records);if(!session||session.content!==content)return observe();
  return session.read('accepted-source-evidence/v1:'+canonicalJson(identity),observe,value=>value!==null&&value!==undefined,signal,true,2);
}
/** Earlier Code proofs are immutable; live source admission and final authority are separate. */
export function memoNamespaceCodePredecessorProof(records,content,identity,observe,{signal}={}){
  const session=proofSessions.get(records);if(!session||session.content!==content)return observe();
  return session.read('accepted-code-predecessors/v1:'+canonicalJson(identity),observe,()=>true,signal,true,2);
}
/** Fully verified immutable Code records only. Never coalesce an unfinished recursive traversal. */
export function memoNamespaceCodePolicyProof(records,content,identity,observe,{signal}={}){
  const session=proofSessions.get(records);if(!session||session.content!==content)return observe();
  return session.read('accepted-code-policy/v1:'+canonicalJson(identity),observe,()=>true,signal,false,2);
}
const LIMITS=Object.freeze({entries:256,bytes:8*1024*1024});
const cancelled=signal=>{if(signal?.aborted)throw new SingularityFlowError('The namespace read was cancelled.',{code:'ENGINE_OPERATION_CANCELLED'});};
function copy(value){const result=structuredClone(value);if(value?.data instanceof Uint8Array)result.data=Buffer.from(value.data);return result;}
const size=value=>value?.data instanceof Uint8Array?value.data.byteLength:Buffer.byteLength(canonicalJson(value));
export function createNamespaceReadSession({records,content}) {
  const active=new AsyncLocalStorage();
  async function read(key,load,admitted,signal,coalesce=false,priority=false,copyValue=copy) {
    cancelled(signal);const context=active.getStore();
    if(!context)return load();
    if(context.closed)throw new SingularityFlowError('The namespace read outlived its operation.',{code:'ENGINE_CONTEXT_CHANGED'});
    const epoch=context.epoch,previous=context.entries.get(key);
    if(previous){const value=await previous.pending;cancelled(signal);if(context.closed)throw new SingularityFlowError(
      'The namespace read outlived its operation.',{code:'ENGINE_CONTEXT_CHANGED'});return copyValue(value);}
    const entry={pending:Promise.resolve().then(load)};
    if(coalesce&&key!==null&&context.entries.size<LIMITS.entries)context.entries.set(key,entry);
    try{const value=await entry.pending;cancelled(signal);if(context.closed)throw new SingularityFlowError(
      'The namespace read outlived its operation.',{code:'ENGINE_CONTEXT_CHANGED'});
      if(context.epoch!==epoch)return copyValue(value);
      const discard=()=>{if(context.entries.get(key)===entry){context.entries.delete(key);context.bytes-=entry.bytes??0;}};
      if(key===null||!admitted(value)){discard();return value;}
      if(context.entries.has(key)&&context.entries.get(key)!==entry)return copyValue(value);
      const bytes=size(value),full=()=>context.bytes+bytes>LIMITS.bytes||!context.entries.has(key)&&context.entries.size>=LIMITS.entries;
      // Prefer a completed, verified proof to rereadable raw bytes. Bounds and mutable reads stay unchanged.
      if(priority&&bytes<=LIMITS.bytes)for(const [candidate,retained]of context.entries){
        if(!full())break;
        if(retained===entry||retained.bytes===undefined||(retained.priority??0)>=Number(priority))continue;
        context.entries.delete(candidate);context.bytes-=retained.bytes;
      }
      if(full()){discard();return value;}
      entry.bytes=bytes;entry.priority=Number(priority);context.entries.set(key,entry);context.bytes+=bytes;return copyValue(value);
    }catch(error){if(context.entries.get(key)===entry)context.entries.delete(key);throw error;}
  }
  const cachedRecords=bindNamespaceReadBatch(records,Object.freeze({...records,
    async transact(...parameters){
      const context=active.getStore();
      try{return await records.transact(...parameters);}
      finally{if(context&&!context.closed){context.entries.clear();context.bytes=0;context.epoch++;}}
    },
    read(scope,namespace,key,options={}){return read('record:'+canonicalJson([scope,namespace,key]),()=>records.read(scope,namespace,key,options),
      value=>value?.status==='present'&&value.record?.immutable===true,options.signal);},
    inspectOperation(scope,id,options={}){return read('receipt:'+canonicalJson([scope,id]),()=>records.inspectOperation(scope,id,options),
      value=>value?.status==='committed',options.signal);}
  }));
  const cachedContent=Object.freeze({...content,
    read(scope,reference,options={}) {
      if(options.maximumBytes!==undefined&&options.maximumBytes<reference.bytes)return read(null,()=>content.read(scope,reference,options),()=>false,options.signal);
      return read('content:'+canonicalJson([scope,reference]),()=>content.read(scope,reference,options),
        value=>value?.status==='present'&&value.truncated===false&&value.data instanceof Uint8Array&&value.data.byteLength===reference.bytes,options.signal,true);
    }
  });
  proofSessions.set(cachedRecords,{content:cachedContent,read});
  return Object.freeze({records:cachedRecords,content:cachedContent,run:callback=>{
    if(typeof callback!=='function')throw new SingularityFlowError('Provide the registered invocation callback.',{code:'ENGINE_INPUT_INVALID'});
    const context={entries:new Map(),bytes:0,closed:false,epoch:0};
    return active.run(context,async()=>{try{return await callback();}finally{context.closed=true;context.entries.clear();context.bytes=0;}});
  }});
}
