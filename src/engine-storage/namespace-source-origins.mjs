/** Original accepted source/archive facts for portable line replay. No Git or checkout access. */
import {canonicalJson} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {exactObject} from '../sda/namespace/values.mjs';
import {carriedTagIdsReplay,storyTagLinesReplay,sourceOriginLineDeltasReplay,applicationPathContext} from '../engine-compatibility/node-source-policy.mjs';
import {scanSourceClauseTags} from '../engine-compatibility/node-source-analysis.mjs';
import {createNamespaceSourceBaselineReader} from './namespace-source-baseline-reader.mjs';
import {verifySourceFileChunks} from './namespace-source-content-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),maximumBytes=16*1024*1024;
const error=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>new SingularityFlowError(message,{code,details});
export function createNamespaceSourceOriginReader(options,sourceReader){
  const baselines=createNamespaceSourceBaselineReader(options),observer=sourceReader.observer;
  // Reuse only proofs tied to this exact accepted source object. Each new traversal/operation
  // reconstructs a new source proof; index selection and final conditional reads remain fresh.
  const proofs=new WeakMap();
  const binding=value=>({sourceBindingId:value.plan.input.sourceBindingId,operationId:value.plan.input.operationId,result:value.record,
    index:{key:baselines.codec.indexKey(value.plan.input),version:value.indexVersion}});
  function selected(source,id){
    const baseline=source.plan.sources.find(row=>row.repository.id===id),origin=source.workflow.sourceBindings?.origins?.find(row=>row.id===id);
    if(!baseline||!origin)throw error('The repository has no accepted first Story source selection.');
    const {operationId,recordedAt,...repository}=origin;
    return {baseline:baseline.repository,origin:repository,sourceBindingId:operationId};
  }
  async function archived(source,id,proof,signal){
    if(signal?.aborted)throw error('Source origin inspection was cancelled.','ENGINE_OPERATION_CANCELLED');
    if(!sourceReader.isAccepted(source))throw error('Source origin inspection needs its original accepted source proof.','ENGINE_INPUT_INVALID');
    let cache=proofs.get(source);if(!cache){cache=new Map();proofs.set(source,cache);}
    const key=proof?canonicalJson(proof):null;if(key&&cache.has(key))return cache.get(key);
    const expected=selected(source,id),originBinding=await baselines.binding(expected.sourceBindingId,signal),
      original=originBinding.selected.repositories.find(row=>row.id===id);
    if(!same(original,expected.origin)||!same(original.descriptor,expected.baseline.descriptor))throw error('The first Story source has another accepted selection.');
    async function archive(sourceBindingId,saved){
      let found;
      if(saved){
        exactObject(saved,['sourceBindingId','operationId','result','index']);
        if(saved.sourceBindingId!==sourceBindingId)throw error('The origin archive names another source binding.');
        found=await baselines.accepted({workId:options.workId,operationId:saved.operationId,sourceBindingId},{signal});
        if(!found||!same(binding(found),saved))throw error('The source origin lost its original accepted byte archive.');
      }else found=await baselines.inspectBinding(sourceBindingId,{signal});
      if(!found)throw error('Retain the actual original source bytes before retaining line origins.','ENGINE_SOURCE_BASELINE_REQUIRED',{
        operation:'source.baseline.retain',inputs:{workId:options.workId,sourceBindingId},requires:['operationId']});
      const position=found.plan.sources.findIndex(row=>row.repository.id===id),row=found.plan.sources[position],
        wanted=sourceBindingId===expected.sourceBindingId?expected.origin:expected.baseline;
      if(!row||!same(row.repository,wanted))throw error('The archive has another original repository selection.');
      const {body}=await baselines.verifyRepository(found,row,found.body.repositories[position].manifest,signal);
      return {found,row,body};
    }
    if(proof){exactObject(proof,['id','origin','baseline']);if(proof.id!==id)throw error('The origin proof names another repository.');}
    const origin=await archive(expected.sourceBindingId,proof?.origin),baseline=expected.sourceBindingId===source.plan.sourceBinding.operationId
      ?origin:await archive(source.plan.sourceBinding.operationId,proof?.baseline);
    if(proof&&expected.sourceBindingId===source.plan.sourceBinding.operationId&&!same(proof.origin,proof.baseline))throw error('One source binding cannot have different original archive proofs.');
    const value={binding:{id,origin:binding(origin.found),baseline:binding(baseline.found)},origin,baseline};
    cache.set(canonicalJson(value.binding),value);return value;
  }
  async function select(source,id,signal){return (await archived(source,id,null,signal)).binding;}
  async function verify(proof,source,id,signal){return archived(source,id,proof,signal);}
  async function replayFacts(proof,source,observation,id,signal){
    const archives=await verify(proof,source,id,signal),position=source.plan.sources.findIndex(row=>row.repository.id===id),repository=source.plan.sources[position],
      {value}=await sourceReader.verifyRepository(source,repository,source.body.repositories[position].manifest,signal),
      current=new Map(observation.current.snapshot.entries.map(row=>[row.path,row])),changed=new Map(value.entries.filter(row=>row.after).map(row=>[row.newPath,row])),
      origin=new Map(archives.origin.body.entries.map(row=>[row.path,row])),baseline=new Map(archives.baseline.body.entries.map(row=>[row.path,row])),cache=new Map();
    let cached=0;const tracked=new Set(observation.origin.trackedPaths);
    async function bytes(side,path){
      if(signal?.aborted)throw error('Source origin replay was cancelled.','ENGINE_OPERATION_CANCELLED');
      const key=side+'\0'+path;if(cache.has(key))return cache.get(key);
      const archive=side==='origin'?archives.origin:archives.baseline,entry=side==='current'?(changed.get(path)?.after??baseline.get(path)):(side==='origin'?origin:baseline).get(path),
        chunks=side==='current'&&changed.has(path)?changed.get(path).chunks:entry?.chunks,
        reader=side==='current'&&changed.has(path)?repository.reader:archive.row.reader;
      if(!entry)throw error('A line-origin dependency has no retained application bytes.','ENGINE_SOURCE_ORIGIN_BYTES_REQUIRED',{path,side,operation:'source.baseline.retain'});
      if(entry.bytes>maximumBytes)throw error('A source-line dependency exceeds its declared read bound.','ENGINE_SOURCE_CONTROL_BINDING_INVALID',{reason:'origin-source-limit',path});
      if(side==='current'&&(!current.has(path)||['sha256','bytes'].some(field=>current.get(path)[field]!==entry[field])))throw error('The current line source differs from its retained archive.');
      const buffers=[];await verifySourceFileChunks(entry,chunks,{maximumChunkBytes:reader?.maximumChunkBytes,signal,
        read:async(...args)=>{const data=await observer.bytes(...args);buffers.push(data);return data;}});
      const body=Buffer.concat(buffers);
      while(cached+entry.bytes>maximumBytes&&cache.size){const [old,value]=cache.entries().next().value;cache.delete(old);cached-=value.length;}
      cache.set(key,body);cached+=entry.bytes;return body;
    }
    async function drive(run){let next=run.next();while(!next.done){const request=next.value;let reply;
      switch(request.kind){
        case 'origin-baseline-texts':{
          reply=new Map();let size=0;for(const path of request.paths){const entry=baseline.get(path);if(!entry)continue;
            if(entry.bytes>request.maximumObjectBytes||(size+=entry.bytes)>request.maximumBytes)throw error('Original source tags exceed their bounded read.','ENGINE_SOURCE_CONTROL_BINDING_INVALID');
            reply.set(path,(await bytes('baseline',path)).toString('utf8'));}break;
        }
        case 'origin-comment-tags':reply=scanSourceClauseTags(request.source,{sourcePath:request.path});break;
        case 'origin-source-bytes':reply=await bytes(request.side,request.path);break;
        case 'origin-line-deltas':reply=await drive(sourceOriginLineDeltasReplay({patch:observation.origin.patch,tag:request.tag,pathContext:context}));break;
        case 'origin-tracked-paths':reply=new Set(request.paths.filter(path=>tracked.has(path)));break;
        case 'origin-untracked-text':reply=(await bytes('current',request.path)).toString('utf8');break;
        default:throw error('Source origin replay needs its named fact owner.','ENGINE_PORT_UNAVAILABLE',{required:[request.kind]});
      }next=run.next(reply);}return next.value;
    }
    let context=applicationPathContext(source.definition,source.workflow.resolution);
    return {verify:async()=>{for(const tag of ['clause','ac'])await drive(sourceOriginLineDeltasReplay({patch:observation.origin.patch,tag,pathContext:context}));},
      carried:occurrences=>drive(carriedTagIdsReplay({baseline:observation.baseline.revision,
      changes:observation.control.entries.map(row=>({oldPath:row.oldPath,newPath:row.newPath,previousRegular:/^100/u.test(row.oldMode)})),occurrences,tag:'clause'})),
      added:(occurrences,pathContext)=>{context=pathContext;return drive(storyTagLinesReplay({baseline:observation.origin.revision,occurrences,tag:'clause',pathContext}));}};
  }
  return Object.freeze({select,verify,replayFacts});
}
