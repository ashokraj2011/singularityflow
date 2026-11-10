/** Exact implementation bindings over accepted archives and original approved source-clause observations. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {implementationBindingsReplay} from '../engine-compatibility/node-source-analysis.mjs';
import {verifySourceFileChunks} from './namespace-source-content-reader.mjs';
import {createNamespaceSourcePatchReader} from './namespace-source-patches.mjs';
export const NAMESPACE_IMPLEMENTATION_REGIONS='sflow-implementation-region-observations/v1';
const empty=()=>({bindings:0,regions:0,hunks:0,symbols:0,problems:0});
const totals=value=>({bindings:value.bindings.length,regions:value.bindings.reduce((n,row)=>n+row.regions.length,0),
  hunks:value.bindings.reduce((n,row)=>n+row.regions.reduce((n,region)=>n+region.hunks.length,0),0),
  symbols:value.bindings.reduce((n,row)=>n+row.regions.reduce((n,region)=>n+region.symbols.length,0),0),problems:value.problems.length});
export function createNamespaceImplementationRegionReader({observer,retention,baseline}){
  const patches=createNamespaceSourcePatchReader({observer,retention,baseline});
  async function inspect(found,original,clauses,{signal}={}){
    const result={profile:NAMESPACE_IMPLEMENTATION_REGIONS,status:'off',baselineRecord:null,retentionRecord:null,totals:null,repositories:[],requiredPolicyOwners:[]};
    if(clauses.status==='off')return result;
    if(clauses.status==='pending-owner')return {...result,status:'pending-owner',requiredPolicyOwners:[...clauses.requiredPolicyOwners]};
    if(!found)return {...result,status:'missing-source-evidence'};
    const required=clauses.repositories.some(row=>row.value?.mode==='enforce'&&row.value.required.length);if(!required)return result;
    if(!original)return {...result,status:'missing-baseline'};
    const context=await patches.capture(found,original,{signal});result.status='observed';result.baselineRecord=original.record.content;result.retentionRecord=found.record.content;result.totals=empty();
    for(const row of clauses.repositories){
      if(!row.value?.required.length)continue;
      const position=found.plan.sources.findIndex(source=>source.repository.id===row.id),source=found.plan.sources[position],
        {value}=await retention.verifyRepository(found,source,found.body.repositories[position].manifest,signal),changed=new Map(value.entries.flatMap(entry=>[entry.oldPath,entry.newPath].filter(Boolean).map(path=>[path,entry]))),
        changeSet={entries:value.entries.map(entry=>({status:entry.status==='D'?'deleted':entry.status==='A'?'added':'modified',oldPath:entry.oldPath,newPath:entry.newPath,untracked:false}))},
        run=implementationBindingsReplay({changeSet,required:row.value.required,tags:row.value.bindings});
      let step=run.next(),pending=null;
      try{while(!step.done){if(signal?.aborted)throw new SingularityFlowError('Implementation region replay was cancelled.',{code:'ENGINE_OPERATION_CANCELLED'});
        const request=step.value;let reply;
        if(request.kind==='implementation-diff-preview')reply=await patches.repository(context,row.id,request.paths,{signal});
        else if(request.kind==='implementation-source'){
          const entry=changed.get(request.path);if(!entry?.after)throw new SingularityFlowError('An implementation binding lost its actual retained source.',{code:'ENGINE_STORAGE_CORRUPT'});
          if(entry.after.bytes>request.maximumBytes)throw new SingularityFlowError('The implementation source exceeds its existing read bound.',{code:'ENGINE_SOURCE_DIFF_LIMIT',details:{limit:'maximumFileBytes',maximum:request.maximumBytes,observed:entry.after.bytes}});
          const buffers=[];await verifySourceFileChunks(entry.after,entry.chunks,{maximumChunkBytes:source.reader?.maximumChunkBytes,signal,read:async(...args)=>{const data=await observer.bytes(...args);buffers.push(data);return data;}});
          try{reply=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(buffers));}catch(cause){throw new SingularityFlowError('Implementation bindings need actual UTF-8 source.',{code:'ENGINE_SOURCE_DIFF_TEXT_REQUIRED',cause});}
          if(reply.includes('\0'))throw new SingularityFlowError('Binary source needs its region-analysis owner.',{code:'ENGINE_SOURCE_DIFF_TEXT_REQUIRED'});
        }else throw new SingularityFlowError('Implementation binding needs its declared observation owner.',{code:'ENGINE_PORT_UNAVAILABLE',details:{required:[request.kind]}});
        step=run.next(reply);
      }}catch(error){if(!['ENGINE_SOURCE_DIFF_LIMIT','ENGINE_SOURCE_DIFF_TEXT_REQUIRED'].includes(error.code))throw error;pending={code:error.code,
        limit:error.details?.limit??null,maximum:error.details?.maximum??null,observed:error.details?.observed??null};}
      if(pending){result.status='pending-owner';result.requiredPolicyOwners=['implementation-region-analysis'];result.repositories.push({id:row.id,status:'pending-owner',value:null,limitation:pending});}
      else{const value=step.value;result.repositories.push({id:row.id,status:'observed',value,limitation:null});const count=totals(value);for(const key of Object.keys(result.totals))result.totals[key]+=count[key];}
    }
    if(result.status==='pending-owner')result.totals=null;await patches.finish(context,{signal});return result;
  }
  function preview(value,{maximumEntries=200,maximumBytes=65536}={}){
    let shown=0,bytes=0;
    return {...value,repositories:value.repositories.map(row=>{
      const bindings=[];for(const binding of row.value?.bindings??[]){const item={clauseId:binding.clauseId,explanation:binding.explanation,
        regionCount:binding.regions.length,regions:binding.regions.slice(0,64).map(region=>({path:region.path,change:region.change,hunks:region.hunks.length,symbols:region.symbols.length,symbolAssurance:region.symbolAssurance})),truncated:binding.regions.length>64},size=Buffer.byteLength(canonicalJson(item));
        if(shown<maximumEntries&&bytes+size<=maximumBytes){bindings.push(item);shown++;bytes+=size;}}
      return {id:row.id,status:row.status,bindingsSha256:row.value?.bindingsSha256??null,totals:row.value?totals(row.value):null,bindings,
        truncated:bindings.length<(row.value?.bindings.length??0)||bindings.some(binding=>binding.truncated),limitation:row.limitation};
    })};
  }
  return Object.freeze({inspect,preview});
}
