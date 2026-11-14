/** Explicit bounded SQL execution. No Git, model, CLI discovery or global runtime selection. */
import {readFile,lstat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,EXECUTION_UNIT_LIMITS} from '../foundation/record-schema.mjs';
import {datasetSnapshot} from '../kernel/work-products.mjs';
import {validateContentStore,contentReference} from '../sda/content/contract.mjs';
import {namespaceScope} from '../sda/namespace/values.mjs';
import {validateExecutionUnitManifest,validateAgentTaskContract,seal,sha256,freezeDeep} from './node-execution-values.mjs';
import {requestValue} from './sql-data-values.mjs';
export {sqliteDataRequest} from './sql-data-values.mjs';
import {executePinnedProcess} from './node-execution-unit.mjs';
import {sqliteDataWorker} from './sqlite-data-worker.mjs';
const fail=(message,code='SGOS_DATA_BINDING_INVALID',details=null)=>{throw new SingularityFlowError(message,{code,details});};
const bytesHash=v=>createHash('sha256').update(v).digest('hex');
const driver='('+sqliteDataWorker.toString()+')()';
export const SQLITE_DATA_DRIVER_SHA256='sha256:'+bytesHash(driver);
const processEnvironment=()=>Object.fromEntries(['SystemRoot','SYSTEMROOT','WINDIR','LANG','LC_ALL','TZ','TMPDIR','TEMP','TMP']
  .filter(key=>Object.hasOwn(process.env,key)).map(key=>[key,process.env[key]]));
export function createSqliteDataExecutionUnit({manifest,executable,executableSha256,authorize,content,scope,timeoutMs=30000,sink=null}={}){
  manifest=validateExecutionUnitManifest(manifest);
  validateContentStore(content);scope=namespaceScope(scope);const readContent=content.read.bind(content);
  if(manifest.provider!=='deterministic-sqlite'||manifest.models.length||manifest.network?.mode!=='deny'||manifest.sandbox?.kind!=='fixed-sql-driver'||manifest.capabilities.query!==true||manifest.toolPolicy?.profile!=='sflow-sql-data-execution/v1'
    ||manifest.toolPolicy.runtimeSha256!=='sha256:'+executableSha256||manifest.toolPolicy.driverSha256!==SQLITE_DATA_DRIVER_SHA256
    ||typeof executable!=='string'||!path.isAbsolute(executable)||!/^[a-f0-9]{64}$/.test(executableSha256??'')
    ||typeof authorize!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<50||timeoutMs>300000)fail('Supply a pinned deterministic SQLite data executor.');
  if(sink!==null&&(!sink||typeof sink!=='object'||Object.keys(sink).length!==3||!path.isAbsolute(sink.filename??'')
    ||!['id','projectId'].every(k=>typeof sink[k]==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sink[k]))))fail('A batch sink needs its exact filename, project and logical identity.');
  if(sink?manifest.capabilities.batch!==true||manifest.toolPolicy.sinkId!==sink.id||manifest.toolPolicy.projectId!==scope.projectId:manifest.capabilities.batch!==false||Object.hasOwn(manifest.toolPolicy,'sinkId'))fail('The manifest must declare its exact optional sink capability.');
  if(sink&&sink.projectId!==scope.projectId)fail('The sink belongs to another execution project.');
  sink=sink===null?null:structuredClone(sink);const states=new Map();
  const selected=handle=>{const state=states.get(handle?.handleSha256);if(!state||canonicalJson(handle)!==canonicalJson(state.handle))fail('Use this executor\'s exact live handle.','SGOS_GEU_HANDLE_STALE');return state;};
  async function pinned(){
    const stat=await lstat(executable);
    if(!stat.isFile()||stat.isSymbolicLink()||bytesHash(await readFile(executable))!==executableSha256)fail('The reviewed SQL runtime executable changed.','SGOS_DATA_EXECUTABLE_CHANGED');
    if(sink){const parent=path.dirname(sink.filename);if(await realpath(parent)!==parent)fail('The data sink parent must be its physical path.');try{const st=await lstat(sink.filename);if(!st.isFile()||st.isSymbolicLink())fail('The data sink must be a regular owned file.');}catch(cause){if(cause.code!=='ENOENT')throw cause;}}
  }
  async function retainedTask(contract,signal){
    const encoded=contract.inputs.length===1?/^evidence:([a-f0-9]{64}):([1-9][0-9]{0,8})$/u.exec(contract.inputs[0]):null;
    if(!encoded||contract.budgets.modelInvocations!==0||contract.workingSet!=null)fail('A deterministic data task needs one exact retained input reference and zero model calls.','SGOS_DATA_TASK_INVALID');
    const reference=contentReference({namespace:'evidence',sha256:encoded[1],bytes:Number(encoded[2])},4*1024*1024),
      read=await readContent(scope,reference,{signal,maximumBytes:reference.bytes});
    if(read?.status!=='present'||read.truncated!==false||!(read.data instanceof Uint8Array)||read.data.byteLength!==reference.bytes
      ||bytesHash(read.data)!==reference.sha256||canonicalJson(read.reference)!==canonicalJson(reference))fail('The retained data request is missing or changed.','SGOS_DATA_INPUT_UNAVAILABLE');
    let task;try{task=requestValue(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(read.data)));}catch(cause){if(cause.code)throw cause;throw new SingularityFlowError('The retained data request is not valid JSON.',{code:'SGOS_DATA_TASK_INVALID',cause});}
    if(task.kind==='batch'&&!sink)fail('A batch needs an explicitly bound sink.');
    if(task.kind==='batch'?canonicalJson(contract.writeScope)!==canonicalJson(['sink:'+sink.id]):contract.writeScope.length!==0)fail('The task write scope differs from its actual sink capability.','SGOS_DATA_TASK_INVALID');
    return task;
  }
  function stop(state,reason){if(state.closed)return true;state.stopped=true;state.reason=reason;state.controller.abort(reason);return true;}
  return Object.freeze({
    descriptor:()=>manifest,
    async doctor(){await pinned();return seal('execution-unit-attestation','attestationSha256',{executionUnitManifestSha256:manifest.manifestSha256,status:'ready',capabilities:manifest.capabilities,observedAt:new Date().toISOString(),diagnosticCode:null});},
    async planCapability({requiredCapabilities=[]}={}){const unavailable=requiredCapabilities.filter(k=>manifest.capabilities[k]!==true);return {capable:!unavailable.length,unavailable};},
    async start(contract,{signal=null}={}){
      contract=validateAgentTaskContract(contract,manifest);
      if(states.size>=EXECUTION_UNIT_LIMITS.maximumSessions)fail('The bounded SQL execution handle inventory is full.','SGOS_EXECUTION_LIMIT');
      const task=await retainedTask(contract,signal);
      if(signal?.aborted)fail('The data task was cancelled before launch.','ENGINE_OPERATION_CANCELLED');
      if(await authorize({contract,task,stage:'start'})!==true)fail('The actual data task is not authorized.','ENGINE_AUTHORITY_REQUIRED');
      await pinned();
      if(signal?.aborted)fail('The data task was cancelled before launch.','ENGINE_OPERATION_CANCELLED');
      if(await authorize({contract,task,stage:'dispatch'})!==true)fail('Data execution permission changed before launch.','ENGINE_AUTHORITY_REQUIRED');
      if(signal?.aborted)fail('The data task was cancelled before dispatch.','ENGINE_OPERATION_CANCELLED');
      const handle=seal('execution-handle','handleSha256',{executionUnitManifestSha256:manifest.manifestSha256,contractSha256:contract.contractSha256,
        adapterHandle:{id:sha256({contract:contract.contractSha256,sequence:states.size}),profile:'sflow-sql-data-handle/v1'}});
      const env=processEnvironment();
      const controller=new AbortController(),state={handle,controller,closed:false,stopped:false,timedOut:false,events:[]};
      states.set(handle.handleSha256,state);
      const event=(type,data)=>{const prior=state.events.at(-1);state.events.push(seal('execution-event','eventSha256',{handleSha256:handle.handleSha256,
        sequence:state.events.length+1,priorEventSha256:prior?.eventSha256??null,type,data,recordedAt:new Date().toISOString()}));};
      event('started',{contractSha256:contract.contractSha256,harness:null,modelInvocations:0,kind:task.kind});
      const abort=()=>stop(state,'cancelled');signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
      state.done=executePinnedProcess({command:{executable,arguments:['--input-type=module','-e',driver]},root:path.dirname(executable),environment:env,
        input:JSON.stringify({task,sinkBinding:sink,contractSha256:contract.contractSha256}),signal:controller.signal,
        timeoutMs:Math.min(timeoutMs,contract.budgets.activeMinutes*60000),maximumOutputBytes:8*1024*1024}).then(observed=>{
        state.closed=true;state.timedOut=observed.timedOut;state.quiescenceUnknown=observed.error?.quiescenceUnknown===true;
        signal?.removeEventListener('abort',abort);
        const stderr=observed.stderr.toString('utf8'),stdout=observed.stdout.toString('utf8');
        let result=null,diagnostic=observed.error?{name:observed.error.name,message:observed.error.message,code:observed.error.code??null,details:observed.error.details??null}:null;
        if(observed.status===0&&!state.stopped&&!observed.overflow&&!diagnostic){try{const candidate=JSON.parse(stdout);datasetSnapshot(candidate.data);
          if(Object.keys(candidate).sort().join(',')!=='data,queryExecuted,sink'||typeof candidate.queryExecuted!=='boolean')throw Error('Another data result shape.');result=candidate;
        }catch(cause){diagnostic={message:cause.message,code:'SGOS_DATA_RESULT_INVALID'};}}
        if(stderr&&!diagnostic){try{diagnostic=JSON.parse(stderr);}catch{diagnostic={message:stderr,code:null};}}
        state.output={profile:'sflow-sql-data-result/v1',result,process:{status:observed.status,signal:observed.signal,closed:true,timedOut:observed.timedOut,stopped:state.stopped,outputLimit:observed.overflow},
          diagnostic,effect:task.kind==='batch'?(result?.sink?'confirmed':'unknown'):'none',modelInvocations:0};
        event('completed',{status:observed.status,timedOut:observed.timedOut,resultAvailable:result!==null});
      });return handle;
    },
    async inspectBatch({contract,signal=null}){
      if(!sink)fail('A batch inspection needs its original bound sink.');contract=validateAgentTaskContract(contract,manifest);
      if(signal?.aborted)fail('The sink inspection was cancelled before reading its inputs.','ENGINE_OPERATION_CANCELLED');
      const task=await retainedTask(contract,signal);if(task.kind!=='batch')fail('Inspect an actual batch, not a query.');
      if(await authorize({contract,task,stage:'reconcile'})!==true)fail('The original sink inspection is not authorized.','ENGINE_AUTHORITY_REQUIRED');
      if(signal?.aborted)fail('The sink inspection was cancelled before observation.','ENGINE_OPERATION_CANCELLED');
      await pinned();let observation;
      try{await lstat(sink.filename);}catch(cause){if(cause.code!=='ENOENT')throw cause;observation={status:'absent',batchId:task.batchId,requestSha256:task.requestSha256,sinkId:sink.id};}
      if(!observation){const observed=await executePinnedProcess({command:{executable,arguments:['--input-type=module','-e',driver]},root:path.dirname(executable),environment:processEnvironment(),
        input:JSON.stringify({task,sinkBinding:sink,contractSha256:contract.contractSha256,inspectOnly:true}),signal,timeoutMs:Math.max(timeoutMs,30000),maximumOutputBytes:1024*1024});
        if(observed.error)throw observed.error;if(observed.status!==0||observed.timedOut||observed.overflow)fail('The sink observation did not complete.','SGOS_DATA_RECONCILIATION_REQUIRED',{
          process:{status:observed.status,signal:observed.signal,timedOut:observed.timedOut,overflow:observed.overflow},stderr:observed.stderr.toString('utf8')});
        observation=JSON.parse(observed.stdout.toString('utf8'));}
      return freezeDeep({schemaVersion:1,profile:'sflow-sql-data-sink-observation/v1',executionUnitManifestSha256:manifest.manifestSha256,contractSha256:contract.contractSha256,
        projectId:scope.projectId,observedAt:new Date().toISOString(),...observation});
    },
    async *observe(handle,cursor=0){const state=selected(handle);if(!Number.isSafeInteger(cursor)||cursor<0)fail('Use a valid execution cursor.');for(const e of state.events)if(e.sequence>cursor){yield e;cursor=e.sequence;}await state.done;for(const e of state.events)if(e.sequence>cursor)yield e;},
    async requestStop(handle,{reason='requested'}={}){const state=selected(handle),acknowledged=stop(state,reason);return seal('stop-receipt','stopReceiptSha256',{handleSha256:handle.handleSha256,reasonSha256:sha256(reason),acknowledged,requestedAt:new Date().toISOString()});},
    async quiesce(handle){const state=selected(handle);await state.done;if(state.quiescenceUnknown)fail('The data process group did not prove quiescence.','SGOS_GEU_QUIESCENCE_UNCONFIRMED');return seal('quiescence-receipt','quiescenceReceiptSha256',{handleSha256:handle.handleSha256,quiescent:true,eventHeadSha256:state.events.at(-1)?.eventSha256??null,observedAt:new Date().toISOString()});},
    async collect(handle){const state=selected(handle);if(!state.closed)fail('Collect only after the data process has closed.','SGOS_GEU_NOT_QUIESCENT');
      return freezeDeep({kind:'candidate-result',executionUnitManifestSha256:manifest.manifestSha256,contractSha256:handle.contractSha256,output:state.output,
        outputSha256:sha256(state.output),candidate:state.output.result?.data??null,usage:{modelInvocations:0,tokens:null,cost:null},eventHeadSha256:state.events.at(-1)?.eventSha256??null});}
  });
}
