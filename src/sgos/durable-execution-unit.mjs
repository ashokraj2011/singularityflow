/** SGOS execution-unit decorator. Runtime history never certifies an application or approves a phase. */
import {createHash} from 'node:crypto';
import {canonicalJson,cloneSgosRecordValue,EXECUTION_UNIT_LIMITS,EXECUTION_UNIT_ABI_SCHEMA,admitRecordSchemaVersion} from '../foundation/record-schema.mjs';
import {captureExecutionUnit} from '../foundation/execution-unit-port.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {assertSgosOperationalStoreAdapter,createSgosOperationalCodec} from './operational-contract.mjs';
import {validateContentStore,contentReference} from '../sda/content/contract.mjs';
import {namespaceScope} from '../sda/namespace/values.mjs';

export const DURABLE_EXECUTION_PROFILE='sgos-durable-execution/v1';
const MAXIMUM_BYTES=32*1024*1024,MAXIMUM_EVENTS=EXECUTION_UNIT_LIMITS.maximumEvents,MAXIMUM_SESSIONS=EXECUTION_UNIT_LIMITS.maximumSessions;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const digest=value=>'sha256:'+hash(canonicalJson(value));
const {validateBackup}=createSgosOperationalCodec({digest});
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const fail=(message,code='SGOS_EXECUTION_RECORD_INVALID',details=null,cause=undefined)=>{
  throw new SingularityFlowError(message,{code,details,cause});
};
function fields(value,required) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==required.length
    ||required.some(key=>!Object.hasOwn(value,key)))fail('Execution record fields differ from their versioned protocol.');
}
function hashed(value,kind,field) {
  let copy;
  try{copy=cloneSgosRecordValue(value);}catch(cause){fail('Execution record is not plain finite JSON.',undefined,null,cause);}
  if(copy?.kind!==kind||typeof copy[field]!=='string')fail('Execution record has another ABI identity.');
  admitRecordSchemaVersion(EXECUTION_UNIT_ABI_SCHEMA,copy);
  const core={...copy};delete core[field];
  if(digest(core)!==copy[field])fail('Execution record failed its exact digest.');
  return copy;
}
const handleFields=['schemaVersion','kind','handleSha256','executionUnitManifestSha256','contractSha256','adapterHandle'];
function handleValue(value) {const handle=hashed(value,'execution-handle','handleSha256');fields(handle,handleFields);return handle;}
function stopValue(value,handle,reason=null) {
  const stop=hashed(value,'stop-receipt','stopReceiptSha256');
  fields(stop,['schemaVersion','kind','handleSha256','reasonSha256','acknowledged','requestedAt','stopReceiptSha256']);
  if(stop.handleSha256!==handle.handleSha256||typeof stop.acknowledged!=='boolean'||!/^sha256:[a-f0-9]{64}$/u.test(stop.reasonSha256)
    ||!Number.isFinite(Date.parse(stop.requestedAt)))fail('The executor acknowledged another stop request.');
  if(reason!==null&&stop.reasonSha256!==('sha256:'+hash(reason)))fail('Execution already has a stop decision bound to another reason.','SGOS_GEU_STOP_CONFLICT');
  return stop;
}
function errorValue(error) {
  let details=null;
  try{details=cloneSgosRecordValue(error?.details??null);}catch{}
  return {name:String(error?.name??'Error'),message:String(error?.message??error),code:error?.code??null,
    outcomeClass:error?.outcomeClass??null,details};
}
function restoredError(value) {
  const error=new SingularityFlowError(value.message,{code:value.code,details:value.details,outcomeClass:value.outcomeClass});
  error.name=value.name;return error;
}
function methods(port,names,label) {
  if(!port||typeof port!=='object')fail('Supply an explicit '+label+' port.','SGOS_EXECUTION_BINDING_INVALID');
  return Object.fromEntries(names.map(name=>{
    let owner=port,field,depth=0;
    while(owner&&!field&&depth++<64){field=Object.getOwnPropertyDescriptor(owner,name);if(!field)owner=Object.getPrototypeOf(owner);}
    if(!field||!Object.hasOwn(field,'value')||typeof field.value!=='function')fail('Supply plain '+label+' methods.','SGOS_EXECUTION_BINDING_INVALID',{method:name});
    return [name,field.value.bind(port)];
  }));
}

/** Capture explicit capabilities. No executor, storage read, clock or ownership method is invoked. */
export function createDurableExecutionUnit({unit,store,content,scope,owner,clock}={}) {
  const execution=captureExecutionUnit(unit);assertSgosOperationalStoreAdapter(store);validateContentStore(content);
  const project=namespaceScope(scope),description=store.descriptor();
  if(description.authorityEligible!==false||description.durability!=='durable-reconstructable'
    ||!description.purposes.includes('runtime')||content.descriptor.binding.kind!=='shared'
    ||content.descriptor.maximumBytes<MAXIMUM_BYTES)fail('Durable execution requires runtime-only history and bounded shared content.','SGOS_EXECUTION_BINDING_INVALID');
  const history=methods(store,['read','transact','exportBackup'],'operational storage'),blobs=methods(content,['put','read'],'immutable content');
  const storeId=description.storeId,storageProfile=description.profile;
  const ownership=methods(owner,['acquire','assert','release'],'execution owner'),time=methods(clock,['now'],'clock');
  const sessions=new Map();let writes=Promise.resolve();
  const keyFor=contractSha256=>{
    if(typeof contractSha256!=='string'||!/^sha256:[a-f0-9]{64}$/u.test(contractSha256))fail('Execution requires an exact task-contract digest.');
    return 'execution/'+contractSha256.slice(7);
  };
  const timestamp=async()=>{const value=await time.now();if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))fail('The execution clock returned an invalid timestamp.','SGOS_EXECUTION_PORT_RESULT_INVALID');return value;};
  function record(value,key) {
    fields(value,['format','profile','projectId','attemptId','contractSha256','manifestSha256','status','owner','handle','events','stop','quiescence','result','failure','diagnostic','startedAt','updatedAt','recordSha256']);
    const core={...value};delete core.recordSha256;
    if(value.format!=='sflow.sgos.execution-attempt/v1'||value.profile!==DURABLE_EXECUTION_PROFILE||value.projectId!==project.projectId
      ||value.attemptId!==key||keyFor(value.contractSha256)!==key||digest(core)!==value.recordSha256
      ||!['starting','running','complete','uncertain'].includes(value.status)||!Array.isArray(value.events)||value.events.length>MAXIMUM_EVENTS
      ||!Number.isFinite(Date.parse(value.startedAt))||!Number.isFinite(Date.parse(value.updatedAt)))fail('The retained execution attempt has another binding or digest.');
    fields(value.owner,['hostId','instanceId','id']);
    if(Object.values(value.owner).some(item=>typeof item!=='string'||!item))fail('The retained execution lease is invalid.');
    if(value.handle!==null&&(handleValue(value.handle).contractSha256!==value.contractSha256
      ||value.handle.executionUnitManifestSha256!==value.manifestSha256))fail('The retained execution handle belongs to another attempt.');
    if(value.status==='complete'&&(value.handle===null||value.quiescence===null||Boolean(value.result)===Boolean(value.failure)))fail('A complete execution needs quiescence and exactly one retained outcome.');
    if(value.status!=='complete'&&(value.result!==null||value.failure!==null||value.quiescence!==null))fail('An unfinished execution cannot claim a retained result.');
    if(value.stop!==null){if(value.handle===null)fail('A retained stop must bind an actual execution handle.');stopValue(value.stop,value.handle);}
    if(value.diagnostic!==null&&contentReference(value.diagnostic,MAXIMUM_BYTES).namespace!=='runtime')fail('Execution diagnostics must remain in runtime storage.');
    for(const slot of value.events){fields(slot,['reference','eventSha256']);contentReference(slot.reference,MAXIMUM_BYTES);
      if(slot.reference.namespace!=='runtime'||!/^sha256:[a-f0-9]{64}$/u.test(slot.eventSha256))fail('Retained execution event references are invalid.');}
    return structuredClone(value);
  }
  async function read(key) {const snapshot=await history.read(),value=snapshot.entries[key];return {snapshot,value:value===undefined?null:record(value,key)};}
  function mutate(key,change) {
    const work=async()=>{
      for(let retry=0;retry<32;retry++) {
        const {snapshot,value}=await read(key);let proposed;
        try{proposed=await change(value,snapshot);}catch(cause){if(cause.code==='SGOS_OPERATIONAL_CAS_MISMATCH')continue;throw cause;}
        if(proposed===null)return value;
        const core={...proposed};delete core.recordSha256;
        const next=record({...core,recordSha256:digest(core)},key);
        try{await history.transact({expectedRevision:snapshot.revision,expectedStateSha256:snapshot.stateSha256,
          changes:[{op:'put',key,value:next}]});return next;}
        catch(cause){if(cause.code!=='SGOS_OPERATIONAL_CAS_MISMATCH')throw cause;}
      }
      fail('Execution history changed beyond the bounded CAS retry limit.','SGOS_OPERATIONAL_CAS_MISMATCH',{attemptId:key});
    };
    const pending=writes.then(work,work);writes=pending.then(()=>{},()=>{});return pending;
  }
  async function unclaimed(key,snapshot) {
    const {backup}=validateBackup(await history.exportBackup(),storeId,storageProfile);
    if(backup.head.revision!==snapshot.revision||backup.head.stateSha256!==snapshot.stateSha256)fail(
      'Operational history changed before the execution claim.','SGOS_OPERATIONAL_CAS_MISMATCH');
    let previous=null;
    for(const event of backup.events)for(const change of event.changes)if(change.op==='put'&&change.key===key)previous=change.value;
    if(previous){const value=record(previous,key);throw new SingularityFlowError(
      'Retained history contains an earlier execution removed from the current snapshot. Reconcile that exact attempt before creating a new task contract.',{
        code:'SGOS_EXECUTION_RECOVERY_REQUIRED',outcomeClass:'OUTCOME_UNKNOWN',details:{attemptId:key,contractSha256:value.contractSha256,
          priorStatus:value.status,owner:value.owner,handle:value.handle,diagnostic:value.diagnostic,historyRestored:true,automaticRetry:false}});}
  }
  async function put(value) {
    const data=Buffer.from(canonicalJson(value));
    if(data.byteLength>MAXIMUM_BYTES)fail('Execution content exceeds its byte ceiling.','SGOS_EXECUTION_CONTENT_LIMIT');
    const expected={namespace:'runtime',sha256:hash(data),bytes:data.byteLength},result=await blobs.put(project,'runtime',data);
    if(!same(result?.reference,expected)||typeof result.reused!=='boolean')fail('The content port acknowledged another execution result.','SGOS_EXECUTION_PORT_RESULT_INVALID');
    await json(expected);return expected;
  }
  async function json(reference) {
    reference=contentReference(reference,MAXIMUM_BYTES);
    if(reference.namespace!=='runtime')fail('Execution bytes must remain in runtime storage.');
    const result=await blobs.read(project,reference,{maximumBytes:reference.bytes});
    if(result?.status!=='present'||result.truncated!==false||!same(result.reference,reference)||!(result.data instanceof Uint8Array)
      ||result.data.byteLength!==reference.bytes||hash(result.data)!==reference.sha256)fail('Retained execution bytes are missing, truncated or changed.','SGOS_EXECUTION_CONTENT_CORRUPT');
    try{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(result.data));
      if(!Buffer.from(canonicalJson(value)).equals(result.data))throw Error('Noncanonical execution bytes.');return value;
    }catch(cause){fail('Retained execution content is not canonical JSON.','SGOS_EXECUTION_CONTENT_CORRUPT',null,cause);}
  }
  function recovery(value,cause=undefined) {
    return new SingularityFlowError('Execution has an unresolved live or uncertain attempt. Reconcile its original owner; do not launch it again.',{
      code:'SGOS_EXECUTION_RECOVERY_REQUIRED',cause,outcomeClass:'OUTCOME_UNKNOWN',details:{attemptId:value.attemptId,contractSha256:value.contractSha256,
        status:value.status,owner:value.owner,handle:value.handle,diagnostic:value.diagnostic??null,automaticRetry:false}});
  }
  async function owned(session) {
    if(await ownership.assert(session.owner)!==true)fail('The owner port did not authenticate the live execution lease.','SGOS_EXECUTION_LEASE_LOST');
  }
  async function diagnose(key,session,cause,{uncertain=false}={}) {
    try {
      await owned(session);const diagnostic=await put(errorValue(cause)),updatedAt=await timestamp();
      return await mutate(key,value=>{
        if(!value||value.status==='complete'||!same(value.owner,session.owner))return null;
        return {...value,status:uncertain?'uncertain':value.status,diagnostic,handle:session.handle??value.handle,updatedAt};
      });
    }catch{return null;} // Diagnostic failure must never replace the original execution/storage error.
  }
  async function selected(handle) {
    handle=handleValue(handle);const key=keyFor(handle.contractSha256);let {value}=await read(key);
    const session=sessions.get(key);
    if(['starting','uncertain'].includes(value?.status)&&session&&same(session.handle,handle)&&same(value.owner,session.owner)
      &&(value.handle===null||same(value.handle,handle))) {
      // A lost post-launch persistence acknowledgement can resume only from this live capability.
      // Another host cannot reconstruct a handle or infer that the command never ran.
      await owned(session);const updatedAt=await timestamp();
      value=await mutate(key,current=>{
        if(!['starting','uncertain'].includes(current?.status)||(current.handle!==null&&!same(current.handle,handle))
          ||!same(current.owner,session.owner))fail('The launch owner changed before reconciliation.','SGOS_EXECUTION_LEASE_LOST');
        return {...current,status:'running',handle,updatedAt};
      });
    }
    if(!value||!same(value.handle,handle))fail('The execution handle is not retained by this runtime.','SGOS_GEU_HANDLE_STALE');
    if(value.status==='complete')return {key,value,session:null};
    if(!session||!same(session.handle,handle))throw recovery(value);
    await owned(session);return {key,value,session};
  }
  async function eventValue(raw,handle) {
    const event=hashed(raw,'execution-event','eventSha256');
    fields(event,['schemaVersion','kind','handleSha256','sequence','priorEventSha256','type','data','recordedAt','eventSha256']);
    if(event.handleSha256!==handle.handleSha256||!Number.isSafeInteger(event.sequence)||event.sequence<1||event.sequence>MAXIMUM_EVENTS
      ||!Number.isFinite(Date.parse(event.recordedAt))||typeof event.type!=='string')fail('Execution event has another handle, cursor or time.');
    return event;
  }
  async function retainEvent(key,handle,raw) {
    const event=await eventValue(raw,handle),reference=await put(event),slot={reference,eventSha256:event.eventSha256},at=await timestamp();
    await mutate(key,value=>{
      if(!value||!same(value.handle,handle))fail('Execution changed before retaining its event.','SGOS_EXECUTION_LEASE_LOST');
      if(event.sequence<=value.events.length) {
        if(!same(value.events[event.sequence-1],slot))fail('Execution event changed at an already retained sequence.');return null;
      }
      if(value.status!=='running'||event.sequence!==value.events.length+1
        ||event.priorEventSha256!==(value.events.at(-1)?.eventSha256??null))fail('Execution event lineage is incomplete.');
      return {...value,events:[...value.events,slot],updatedAt:at};
    });return event;
  }
  async function events(value,handle) {
    const result=[];let prior=null;
    for(const slot of value.events) {
      const event=await eventValue(await json(slot.reference),handle);
      if(event.sequence!==result.length+1||event.priorEventSha256!==prior||event.eventSha256!==slot.eventSha256)fail('Retained execution event lineage is incomplete.');
      result.push(event);prior=event.eventSha256;
    }
    return result;
  }
  function terminalEvents(retained,handle,failed) {
    if(retained.length<2||retained[0].type!=='started'||retained[0].data?.contractSha256!==handle.contractSha256
      ||retained.at(-1).type!==(failed?'failed':'completed'))fail('Execution has no matching started and terminal event sequence.');
  }
  function candidateValue(raw,handle,eventHead) {
    const candidate=cloneSgosRecordValue(raw);
    fields(candidate,['kind','executionUnitManifestSha256','contractSha256','output','outputSha256','candidate','usage','eventHeadSha256']);
    if(candidate.kind!=='candidate-result'||candidate.contractSha256!==handle.contractSha256
      ||candidate.executionUnitManifestSha256!==handle.executionUnitManifestSha256||candidate.outputSha256!==digest(candidate.output)
      ||candidate.eventHeadSha256!==eventHead)fail('The executor returned another task result.');
    return candidate;
  }
  function quietValue(raw,handle,eventHead) {
    const quiet=hashed(raw,'quiescence-receipt','quiescenceReceiptSha256');
    fields(quiet,['schemaVersion','kind','handleSha256','quiescent','eventHeadSha256','observedAt','quiescenceReceiptSha256']);
    if(quiet.handleSha256!==handle.handleSha256||quiet.quiescent!==true||quiet.eventHeadSha256!==eventHead
      ||!Number.isFinite(Date.parse(quiet.observedAt)))fail('The executor did not prove this exact retained event stream quiescent.');
    return quiet;
  }
  async function verifyTerminal(value,handle) {
    const retained=await events(value,handle),head=retained.at(-1)?.eventSha256??null;
    terminalEvents(retained,handle,Boolean(value.failure));
    quietValue(value.quiescence,handle,head);
    if(value.result)candidateValue(await json(value.result),handle,head);
    else{const failure=await json(value.failure);fields(failure,['name','message','code','outcomeClass','details']);
      if(typeof failure.message!=='string'||typeof failure.name!=='string')fail('The retained execution failure is invalid.');}
    return value;
  }
  async function terminal(handle) {
    const chosen=await selected(handle);
    if(chosen.value.status==='complete'){
      const value=await verifyTerminal(chosen.value,handle),session=sessions.get(chosen.key);
      if(session&&!session.complete&&same(session.owner,value.owner)){await ownership.release(session.owner);session.complete=true;}
      return value;
    }
    const {key,session}=chosen;
    session.completion??=(async()=>{
      for await(const event of execution.observe(handle,0)){await owned(session);await retainEvent(key,handle,event);}
      await owned(session);
      const quiescence=await execution.quiesce(handle);
      // An observer can finish its current batch before a concurrent stop has settled. Positive
      // quiescence is the boundary after which the final event suffix must also be retained.
      // A negative receipt remains a real protocol failure, never a reason to certify termination.
      if(quiescence?.quiescent===true){
        for(let batch=0;batch<MAXIMUM_EVENTS;batch++){
          const current=(await read(key)).value,cursor=current.events.length;
          if((current.events.at(-1)?.eventSha256??null)===quiescence.eventHeadSha256)break;
          for await(const event of execution.observe(handle,cursor)){await owned(session);await retainEvent(key,handle,event);}
          if((await read(key)).value.events.length===cursor)break;
        }
      }
      const observed=(await read(key)).value,retained=await events(observed,handle),eventHead=retained.at(-1)?.eventSha256??null;
      const quiet=quietValue(quiescence,handle,eventHead);
      let candidate=null,executionFailure=null,result=null,failure=null;
      try{candidate=await execution.collect(handle);}catch(cause){executionFailure=cause;}
      if(executionFailure&&retained.at(-1)?.type!=='failed')throw recovery(await diagnose(key,session,executionFailure)??observed,executionFailure);
      terminalEvents(retained,handle,executionFailure!==null);
      // Storage and protocol failures cannot be disguised as a terminal executor failure.
      if(executionFailure){session.failure=executionFailure;failure=await put(errorValue(executionFailure));}
      else result=await put(candidateValue(candidate,handle,eventHead));
      await owned(session);const at=await timestamp();
      const finished=await mutate(key,value=>{
        if(!value||value.status!=='running'||!same(value.owner,session.owner)||!same(value.events,observed.events))fail('Execution ownership changed before completion.','SGOS_EXECUTION_LEASE_LOST');
        return {...value,status:'complete',quiescence:quiet,result,failure,updatedAt:at};
      });
      session.complete=true;await ownership.release(session.owner);return finished;
    })();
    const pending=session.completion;
    try{return await pending;}catch(cause){if(session.completion===pending)session.completion=null;throw cause;}
  }
  return Object.freeze({
    descriptor:execution.descriptor,doctor:execution.doctor,planCapability:execution.planCapability,
    async start(contract,{signal=null}={}) {
      signal?.throwIfAborted();
      contract=hashed(contract,'agent-task-contract','contractSha256');
      const manifest=hashed(execution.descriptor(),'execution-unit-manifest','manifestSha256'),key=keyFor(contract.contractSha256);
      if(contract.executionUnitManifestSha256!==manifest.manifestSha256)fail('The task belongs to another execution unit.','SGOS_GEU_MANIFEST_MISMATCH');
      const previous=(await read(key)).value;
      if(previous) {
        if(previous.status==='complete'){await verifyTerminal(previous,previous.handle);return structuredClone(previous.handle);}
        const session=sessions.get(key);if(session&&previous.handle&&same(previous.owner,session.owner)){await owned(session);return structuredClone(session.handle);}
        throw recovery(previous,previous.diagnostic?restoredError(await json(previous.diagnostic)):undefined);
      }
      if(sessions.size>=MAXIMUM_SESSIONS) {
        for(const [id,session] of sessions){if(session.complete)sessions.delete(id);if(sessions.size<MAXIMUM_SESSIONS)break;}
        if(sessions.size>=MAXIMUM_SESSIONS)fail('Durable execution concurrent session ceiling exceeded.','SGOS_GEU_SESSION_LIMIT');
      }
      const at=await timestamp();
      const token=cloneSgosRecordValue(await ownership.acquire());fields(token,['hostId','instanceId','id']);
      try {signal?.throwIfAborted();await mutate(key,async(value,snapshot)=>{
        if(value)throw recovery(value);
        await unclaimed(key,snapshot);
        return {format:'sflow.sgos.execution-attempt/v1',profile:DURABLE_EXECUTION_PROFILE,projectId:project.projectId,attemptId:key,
          contractSha256:contract.contractSha256,manifestSha256:manifest.manifestSha256,status:'starting',owner:token,handle:null,
          events:[],stop:null,quiescence:null,result:null,failure:null,diagnostic:null,startedAt:at,updatedAt:at};
      });}catch(cause){await ownership.release(token);throw cause;}
      const session={owner:token,handle:null,completion:null,failure:null};sessions.set(key,session);
      try {
        await owned(session);signal?.throwIfAborted();const handle=handleValue(await execution.start(contract,{signal}));session.handle=handle;
        if(handle.contractSha256!==contract.contractSha256||handle.executionUnitManifestSha256!==manifest.manifestSha256)fail('The executor started another task.');
        const updatedAt=await timestamp();
        await mutate(key,value=>{
          if(value?.status!=='starting'||!same(value.owner,token))fail('Execution ownership changed during launch.','SGOS_EXECUTION_LEASE_LOST');
          return {...value,status:'running',handle,updatedAt};
        });return structuredClone(handle);
      }catch(cause){let value=await diagnose(key,session,cause,{uncertain:true});
        if(!value)try{value=(await read(key)).value;}catch{}
        throw recovery({...value,attemptId:key,contractSha256:contract.contractSha256,status:value?.status??'starting',owner:token,
          handle:session.handle??value?.handle??null},cause);}
    },
    async *observe(handle,cursor=0) {
      if(!Number.isSafeInteger(cursor)||cursor<0)fail('Execution event cursor is invalid.','SGOS_GEU_CURSOR_INVALID');
      const {key,value,session}=await selected(handle);
      if(value.status==='complete'){for(const event of (await events(value,handle)).slice(cursor))yield event;return;}
      for await(const event of execution.observe(handle,0)){await owned(session);const retained=await retainEvent(key,handle,event);if(retained.sequence>cursor)yield retained;}
    },
    async requestStop(handle,request={}) {
      request=cloneSgosRecordValue(request);
      if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).some(name=>name!=='reason')
        ||request.reason!=null&&(typeof request.reason!=='string'||!request.reason.trim()))fail('Execution stop reason must be a non-empty string.','SGOS_GEU_CONTRACT_INVALID');
      handle=handleValue(handle);const key=keyFor(handle.contractSha256),session=sessions.get(key);
      if(!session||session.complete||!same(session.handle,handle)) {
        const {value}=await selected(handle);
        if(value.stop)return stopValue(value.stop,handle,request.reason?.trim()??'Execution stop requested.');
        if(value.status==='complete')fail('Execution is already quiescent; collect its retained outcome.','SGOS_EXECUTION_ALREADY_SETTLED',{
          attemptId:key,handle,nextMethod:'collect',automaticRetry:false});
        fail('This execution can only be stopped by its original live owner.','SGOS_EXECUTION_RECOVERY_REQUIRED',{attemptId:key,automaticRetry:false});
      }
      // A retained-store outage must not prevent stopping a process that this host actually owns.
      await owned(session);const stop=stopValue(await execution.requestStop(handle,request),handle,request.reason?.trim()??'Execution stop requested.');
      const updatedAt=await timestamp();
      await mutate(key,value=>{if(!value||!same(value.owner,session.owner))fail('Execution owner changed before retaining the stop.','SGOS_EXECUTION_LEASE_LOST');
        if(value.stop&&!same(value.stop,stop))fail('Execution has another retained stop reason.','SGOS_GEU_STOP_CONFLICT');
        return {...value,status:value.status==='complete'?'complete':'running',handle,stop,updatedAt};});
      return structuredClone(stop);
    },
    async quiesce(handle){return structuredClone((await terminal(handle)).quiescence);},
    async collect(handle){const value=await terminal(handle);
      if(value.failure){const failure=await json(value.failure),session=sessions.get(keyFor(handle.contractSha256));throw session?.failure??restoredError(failure);}
      return json(value.result);}
  });
}
