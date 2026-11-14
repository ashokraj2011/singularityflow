/** Read actual captured source through explicit content ports, then call the host's AST adapter. */
import {createHash} from 'node:crypto';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {sourceSnapshot,validateSourceUnit} from '../foundation/source-snapshot.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
const fail=(message,code='SGOS_IMPACT_INPUT_INVALID')=>{throw new SingularityFlowError(message,{code});},
  hash=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
/** The analyzer is a trusted SGOS port. No repository path, graph or success flag is a lifecycle input. */
export function createSourceTestImpactUnit({sources,analyzer,maximumDurationMs=300000}={}){
  if(!Array.isArray(sources)||!sources.length||sources.length>32||typeof analyzer?.analyze!=='function'
    ||typeof analyzer.descriptor?.id!=='string'||!analyzer.descriptor.id||typeof analyzer.descriptor?.version!=='string'||!analyzer.descriptor.version
    ||!/^sha256:[a-f0-9]{64}$/u.test(analyzer.descriptor?.implementationSha256??'')||Object.keys(analyzer.descriptor).sort().join(',')!=='id,implementationSha256,version'
    ||!Number.isSafeInteger(maximumDurationMs)||maximumDurationMs<1||maximumDurationMs>86400000)fail('Bind explicit source/content readers, a versioned AST analyzer and a bounded deadline.');
  const descriptor=Object.freeze(structuredClone(analyzer.descriptor)),analyze=analyzer.analyze.bind(analyzer),units=new Map();
  for(const row of sources){const source=validateSourceUnit(row.unit);
    if(units.has(source.repositoryId)||typeof row.content?.read!=='function'||canonicalJson(row.content.descriptor?.source)!==canonicalJson(source))fail('Bind one matching content reader per source.');
    units.set(source.repositoryId,{source,capture:row.unit.capture.bind(row.unit),read:row.content.read.bind(row.content),maximumBytes:row.content.descriptor.maximumChunkBytes});}
  async function observe(input,signal){
    if(!Array.isArray(input?.sources)||input.sources.length!==units.size)fail('Observe the exact selected repository set.');
    const files=[],bound=[],seen=new Set();let total=0;
    for(const selected of input.sources){signal?.throwIfAborted();const unit=units.get(selected.repositoryId);
      if(!unit||seen.has(selected.repositoryId))fail('The impact analyzer requires each bound repository exactly once.');seen.add(selected.repositoryId);
      const captured=await unit.capture({signal}),snapshot=sourceSnapshot(captured.snapshot,unit.source);
      if(captured.revision!==selected.revision||hash(canonicalJson(snapshot))!==selected.revision)fail('Source changed before impact analysis.','TEST_IMPACT_SOURCE_CHANGED');
      bound.push({repositoryId:selected.repositoryId,revision:captured.revision});
      for(const entry of snapshot.entries){const chunks=[];let offset=0;
        if((total+=entry.bytes)>64*1024*1024)fail('The impact content exceeds its explicit byte bound.','SGOS_IMPACT_LIMIT');
        do{signal?.throwIfAborted();const result=await unit.read({entry,offset,maximumBytes:unit.maximumBytes},{signal});
          if(!(result.data instanceof Uint8Array)||result.offset!==offset||!result.data.byteLength&&entry.bytes>offset)fail('The impact content reader made no progress.','ENGINE_PORT_RESULT_INVALID');
          chunks.push(result.data);offset+=result.data.byteLength;
        }while(offset<entry.bytes);
        const bytes=Buffer.concat(chunks);if(bytes.byteLength!==entry.bytes||hash(bytes)!=='sha256:'+entry.sha256)fail('Impact input bytes differ from the captured source.','TEST_IMPACT_SOURCE_CHANGED');
        files.push({repositoryId:selected.repositoryId,path:entry.path,sha256:entry.sha256,bytes});
      }
    }
    const value=await analyze({sources:structuredClone(bound),files},{signal});signal.throwIfAborted();
    for(const selected of input.sources)if((await units.get(selected.repositoryId).capture({signal})).revision!==selected.revision)fail('Source changed during impact analysis.','TEST_IMPACT_SOURCE_CHANGED');
    return {schemaVersion:1,profile:'sflow-test-impact-observation/v1',analyzer:structuredClone(descriptor),sources:bound,nodes:value.nodes,unknown:value.unknown};
  }
  return Object.freeze({descriptor:Object.freeze({profile:'sflow-test-impact-unit/v1',analyzer:descriptor,maximumDurationMs}),async observe(input,{signal}={}){
    const controller=new AbortController();let reject;
    const stopped=new Promise((_,refuse)=>{reject=refuse;}),stop=reason=>{if(!controller.signal.aborted){controller.abort(reason);reject(reason);}},
      abort=()=>stop(signal.reason??new SingularityFlowError('Impact analysis was cancelled.',{code:'ENGINE_OPERATION_CANCELLED'}));
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const timer=setTimeout(()=>stop(new SingularityFlowError('The bound impact analyzer exceeded its deadline.',{code:'SGOS_IMPACT_TIMEOUT',details:{analyzerId:descriptor.id,timeoutMs:maximumDurationMs}})),maximumDurationMs);
    try{return await Promise.race([Promise.resolve().then(()=>{controller.signal.throwIfAborted();return observe(input,controller.signal);}),stopped]);}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }});
}
