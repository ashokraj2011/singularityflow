/** Invocation-local reuse of observed immutable storage facts. No cache survives a public operation. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
const proofSessions=new WeakMap();
/** Only the observer owning these exact captured ports can reuse an observed immutable origin. */
export function memoNamespaceStoryOrigin(records,content,key,observe,{signal}={}){
  const session=proofSessions.get(records);if(!session||session.content!==content)return observe();
  return session.read('story-origin:'+key,observe,()=>true,signal,true);
}
const LIMITS=Object.freeze({entries:256,bytes:8*1024*1024});
const cancelled=signal=>{if(signal?.aborted)throw new SingularityFlowError('The namespace read was cancelled.',{code:'ENGINE_OPERATION_CANCELLED'});};
function copy(value){const result=structuredClone(value);if(value?.data instanceof Uint8Array)result.data=Buffer.from(value.data);return result;}
const size=value=>value?.data instanceof Uint8Array?value.data.byteLength:Buffer.byteLength(canonicalJson(value));
export function createNamespaceReadSession({records,content}) {
  const active=new AsyncLocalStorage();
  async function read(key,load,admitted,signal,coalesce=false) {
    cancelled(signal);const context=active.getStore();
    if(!context)return load();
    if(context.closed)throw new SingularityFlowError('The namespace read outlived its operation.',{code:'ENGINE_CONTEXT_CHANGED'});
    const epoch=context.epoch,previous=context.entries.get(key);
    if(previous){const value=await previous.pending;cancelled(signal);if(context.closed)throw new SingularityFlowError(
      'The namespace read outlived its operation.',{code:'ENGINE_CONTEXT_CHANGED'});return copy(value);}
    const entry={pending:Promise.resolve().then(load)};
    if(coalesce&&key!==null&&context.entries.size<LIMITS.entries)context.entries.set(key,entry);
    try{const value=await entry.pending;cancelled(signal);if(context.closed)throw new SingularityFlowError(
      'The namespace read outlived its operation.',{code:'ENGINE_CONTEXT_CHANGED'});
      if(context.epoch!==epoch)return copy(value);
      const discard=()=>{if(context.entries.get(key)===entry)context.entries.delete(key);};
      if(key===null||!admitted(value)){discard();return value;}
      if(context.entries.has(key)&&context.entries.get(key)!==entry)return copy(value);
      const bytes=size(value);if(context.bytes+bytes>LIMITS.bytes||!context.entries.has(key)&&context.entries.size>=LIMITS.entries){discard();return value;}
      context.entries.set(key,entry);context.bytes+=bytes;return copy(value);
    }catch(error){if(context.entries.get(key)===entry)context.entries.delete(key);throw error;}
  }
  const cachedRecords=Object.freeze({...records,
    async transact(...parameters){
      const context=active.getStore();
      try{return await records.transact(...parameters);}
      finally{if(context&&!context.closed){context.entries.clear();context.bytes=0;context.epoch++;}}
    },
    read(scope,namespace,key,options={}){return read('record:'+canonicalJson([scope,namespace,key]),()=>records.read(scope,namespace,key,options),
      value=>value?.status==='present'&&value.record?.immutable===true,options.signal);},
    inspectOperation(scope,id,options={}){return read('receipt:'+canonicalJson([scope,id]),()=>records.inspectOperation(scope,id,options),
      value=>value?.status==='committed',options.signal);}
  });
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
