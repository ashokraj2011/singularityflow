/** Actual source-generation facts for shared Code policy. No checkout, Git, writer or caller verdict. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {sourceRelativePath} from '../foundation/source-snapshot.mjs';
import {codeSourceBasis,CODE_SOURCE_BASIS_PROFILE} from '../kernel/code-delivery-evidence.mjs';
import {createNamespaceSourcePatchReader} from './namespace-source-patches.mjs';
import {verifySourceFileChunks} from './namespace-source-content-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),maximumReadBytes=16*1024*1024,maximumCachedBytes=16*1024*1024,maximumInvocationBytes=64*1024*1024;
const error=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>new SingularityFlowError(message,{code,details});
export function createNamespaceCodeSourceReader({observer,retention,baseline,requireCurrentIndices=true}){
  const patches=createNamespaceSourcePatchReader({observer,retention,baseline,requireCurrentIndices}),contexts=new WeakMap();
  function selected(context,signal){if(signal?.aborted)throw error('Code source inspection was cancelled.','ENGINE_OPERATION_CANCELLED');
    const state=contexts.get(context);if(!state||!retention.isAccepted(state.found))throw error('Use the original authenticated code-source context.','ENGINE_INPUT_INVALID');return state;}
  async function capture(found,original,repositoryId,{signal}={}){
    if(!retention.isAccepted(found))throw error('Code policy needs original accepted generation bytes.','ENGINE_INPUT_INVALID');
    const patch=await patches.capture(found,original,{signal}),position=found.plan.sources.findIndex(row=>row.repository.id===repositoryId),source=found.plan.sources[position],
      first=original.plan.sources.findIndex(row=>row.repository.id===repositoryId),before=original.plan.sources[first];
    if(!source||!before||!same(source.repository,before.repository))throw error('Code source archives name another repository selection.','ENGINE_INPUT_INVALID');
    const current=await retention.verifyRepository(found,source,found.body.repositories[position].manifest,signal),
      archived=await baseline.verifyRepository(original,before,original.body.repositories[first].manifest,signal),
      snapshot=await retention.snapshot(source.observed.content,source.repository.descriptor,source.observed.revision,signal),
      basis=codeSourceBasis({profile:CODE_SOURCE_BASIS_PROFILE,workId:found.plan.input.workId,phase:found.plan.input.phaseId,generation:found.plan.generation,
        repositoryId,sourceBindingId:found.plan.sourceBinding.operationId,generationIntentId:found.plan.generationIntent.id,
        baselineRevision:source.repository.revision,currentRevision:source.observed.revision},found.workflow,found.workflow.phases[found.plan.input.phaseId]),context=Object.freeze({sourceBasis:basis});
    contexts.set(context,{found,source,before,patch,original,members:new Map(snapshot.entries.map(row=>[row.path,row])),
      originals:new Map(archived.body.entries.map(row=>[row.path,row])),changes:current.value.entries,cache:new Map(),cachedBytes:0,readBytes:0});
    await finish(context,{signal});return context;
  }
  function facts(context,path,{signal}={}){const state=selected(context,signal),member=state.members.get(sourceRelativePath(path));
    return {exists:Boolean(member),regular:Boolean(member),bytes:member?.bytes??0};}
  async function bytes(context,path,{signal,maximumBytes=maximumReadBytes}={}){
    const state=selected(context,signal);path=sourceRelativePath(path);
    if(!Number.isSafeInteger(maximumBytes)||maximumBytes<0||maximumBytes>maximumReadBytes)throw error('Use a bounded code-source byte request.','ENGINE_INPUT_INVALID');
    const member=state.members.get(path);if(!member)return null;
    if(member.bytes>maximumBytes)throw error('The code-source request exceeds its declared file bound.','ENGINE_CODE_SOURCE_LIMIT',{
      limit:'maximumFileBytes',maximum:maximumBytes,observed:member.bytes,path});
    if(state.cache.has(path))return Buffer.from(state.cache.get(path));
    const changed=state.changes.find(row=>row.newPath===path&&row.after),entry=changed?.after??state.originals.get(path),chunks=changed?.chunks??entry?.chunks,
      maximumChunkBytes=(changed?state.source:state.before).reader?.maximumChunkBytes;
    if(!entry||!same({sha256:entry.sha256,bytes:entry.bytes,executable:entry.executable},{sha256:member.sha256,bytes:member.bytes,executable:member.executable}))throw error(
      'A candidate source file has no exact retained original/current bytes.','ENGINE_STORAGE_CONTENT_MISSING',{path});
    if(state.readBytes+entry.bytes>maximumInvocationBytes)throw error('The code-source invocation exceeds its total byte bound.','ENGINE_CODE_SOURCE_LIMIT',{
      limit:'maximumInvocationBytes',maximum:maximumInvocationBytes,observed:state.readBytes+entry.bytes,path});
    const parts=[];await verifySourceFileChunks(entry,chunks,{maximumChunkBytes,signal,read:async(...args)=>{selected(context,signal);const data=await observer.bytes(...args);parts.push(data);return data;}});
    selected(context,signal);const data=Buffer.concat(parts);state.readBytes+=data.length;
    while(state.cachedBytes+data.length>maximumCachedBytes&&state.cache.size){const [key,old]=state.cache.entries().next().value;state.cache.delete(key);state.cachedBytes-=old.length;}
    if(data.length<=maximumCachedBytes){state.cache.set(path,data);state.cachedBytes+=data.length;}return Buffer.from(data);
  }
  function changes(context,{signal}={}){return structuredClone(selected(context,signal).changes);}
  async function regions(context,paths,{signal}={}){const state=selected(context,signal);return patches.repository(state.patch,context.sourceBasis.repositoryId,paths,{signal});}
  async function finish(context,{signal}={}){const state=selected(context,signal);await patches.finish(state.patch,{signal});}
  return Object.freeze({capture,facts,bytes,changes,regions,finish});
}
