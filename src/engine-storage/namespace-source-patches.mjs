/** Implementation regions reconstructed from original accepted source bytes. No working tree or Git. */
import {canonicalJson} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {sourceRelativePath} from '../foundation/source-snapshot.mjs';
import {sourceTextHunks,SOURCE_TEXT_DIFF_PROFILE} from '../kernel/source-text-diff.mjs';
import {verifySourceFileChunks} from './namespace-source-content-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),maximumFileBytes=2*1024*1024;
const error=(message,code='ENGINE_STORAGE_CORRUPT',details=null,cause)=>new SingularityFlowError(message,{code,details,cause});
export function createNamespaceSourcePatchReader({observer,retention,baseline}){
  const contexts=new WeakMap();
  async function capture(found,given,{signal}={}){
    if(!retention.isAccepted(found)||!given)throw error('Read source regions from the original accepted generation and baseline.','ENGINE_INPUT_INVALID');
    const original=await baseline.accepted(given.plan.input,{signal});
    if(!original||!same(original.record,given.record)||!same(original.reference,given.reference)||!same(original.plan,given.plan)||!same(original.body,given.body))throw error('Source regions need their actual accepted original archive.','ENGINE_INPUT_INVALID');
    if(original.plan.input.sourceBindingId!==found.plan.sourceBinding.operationId)throw error('Source regions need this generation’s exact selected baseline.','ENGINE_INPUT_INVALID');
    const token=Object.freeze({});contexts.set(token,{found,original});await finish(token,{signal});return token;
  }
  async function finish(token,{signal}={}){
    if(signal?.aborted)throw error('Source region replay was cancelled.','ENGINE_OPERATION_CANCELLED');
    const state=contexts.get(token);if(!state||!retention.isAccepted(state.found))throw error('Use the issued source-region context.','ENGINE_INPUT_INVALID');
    const {found,original}=state,bindings=[found.binding.index,{key:baseline.codec.indexKey(original.plan.input),version:original.indexVersion}];
    for(const binding of bindings){const value=await observer.record('evidence',binding.key,false,signal);
      if(!value||value.version!==binding.version)throw error('Source-region evidence changed during its replay.','ENGINE_CONTEXT_CHANGED');}
  }
  async function repository(token,repositoryId,paths,{signal}={}){
    const cancelled=()=>{if(signal?.aborted)throw error('Source region replay was cancelled.','ENGINE_OPERATION_CANCELLED');};cancelled();
    const state=contexts.get(token);if(!state||!retention.isAccepted(state.found))throw error('Use the issued source-region context.','ENGINE_INPUT_INVALID');
    const {found,original}=state;
    const position=found.plan.sources.findIndex(row=>row.repository.id===repositoryId),source=found.plan.sources[position],
      first=original.plan.sources.findIndex(row=>row.repository.id===repositoryId),before=original.plan.sources[first];
    if(!source||!before||!same(before.repository,source.repository))throw error('The source region archives name another repository selection.','ENGINE_INPUT_INVALID');
    if(!Array.isArray(paths)||paths.length>source.repository.descriptor.limits.maximumFiles*2)throw error('Select bounded exact changed paths.','ENGINE_INPUT_INVALID');
    const requested=[...new Set(paths.map(sourceRelativePath))],
      old=await baseline.verifyRepository(original,before,original.body.repositories[first].manifest,signal),
      current=await retention.verifyRepository(found,source,found.body.repositories[position].manifest,signal),
      originals=new Map(old.body.entries.map(entry=>[entry.path,entry])),changes=new Map(current.value.entries.flatMap(entry=>[entry.oldPath,entry.newPath].filter(Boolean).map(path=>[path,entry]))),
      files=[],seen=new Set();
    async function text(entry,chunks,reader){
      cancelled();if(entry.bytes>maximumFileBytes)throw error('Exact implementation regions need a source file within its existing two-MiB read bound.',
        'ENGINE_SOURCE_DIFF_LIMIT',{profile:SOURCE_TEXT_DIFF_PROFILE,limit:'maximumFileBytes',maximum:maximumFileBytes,observed:entry.bytes});
      const buffers=[];await verifySourceFileChunks(entry,chunks,{maximumChunkBytes:reader?.maximumChunkBytes,signal,read:async(...args)=>{
        cancelled();const bytes=await observer.bytes(...args);buffers.push(bytes);return bytes;}});
      let value;try{value=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(buffers));}
      catch(cause){throw error('Exact implementation regions require UTF-8 source bytes.','ENGINE_SOURCE_DIFF_TEXT_REQUIRED',null,cause);}
      if(value.includes('\0'))throw error('Binary source needs its explicit region-analysis owner.','ENGINE_SOURCE_DIFF_TEXT_REQUIRED');return value;
    }
    for(const path of requested){
      cancelled();const change=changes.get(path);if(!change)throw error('Implementation regions can name only an actually retained change.','ENGINE_INPUT_INVALID',{path});
      const key=canonicalJson([change.oldPath,change.newPath]);if(seen.has(key))continue;seen.add(key);
      const previous=change.oldPath===null?null:originals.get(change.oldPath);
      if(change.before?(!previous||!same(change.before,{sha256:previous.sha256,bytes:previous.bytes,executable:previous.executable})):previous)throw error('A source region lost its exact original file identity.');
      const left=previous?await text(previous,previous.chunks,before.reader):'',right=change.after?await text(change.after,change.chunks,source.reader):'',
        compared=sourceTextHunks(left,right);
      files.push({pathBefore:change.oldPath,pathAfter:change.newPath,hunks:compared.hunks});
    }
    cancelled();if(!retention.isAccepted(found))throw error('Source evidence changed during its region replay.','ENGINE_INPUT_INVALID');
    return {profile:SOURCE_TEXT_DIFF_PROFILE,repositoryId,baseline:{operationId:original.plan.input.operationId,result:original.record,
      index:{key:baseline.codec.indexKey(original.plan.input),version:original.indexVersion}},source:found.binding,files};
  }
  return Object.freeze({capture,repository,finish});
}
