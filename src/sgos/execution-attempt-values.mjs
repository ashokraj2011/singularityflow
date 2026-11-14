/** Retained execution wire values. No executor, persistence mutation, clock or ownership. */
import {createHash} from 'node:crypto';
import {canonicalJson,cloneSgosRecordValue,EXECUTION_UNIT_LIMITS,EXECUTION_UNIT_ABI_SCHEMA,admitRecordSchemaVersion} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {contentReference} from '../sda/content/contract.mjs';
export const DURABLE_EXECUTION_PROFILE='sgos-durable-execution/v1';
export const MAXIMUM_BYTES=32*1024*1024,MAXIMUM_EVENTS=EXECUTION_UNIT_LIMITS.maximumEvents;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const digest=value=>'sha256:'+hash(canonicalJson(value));
const fail=(message,code='SGOS_EXECUTION_RECORD_INVALID',details=null,cause=undefined)=>{throw new SingularityFlowError(message,{code,details,cause});};
const handleFields=['schemaVersion','kind','handleSha256','executionUnitManifestSha256','contractSha256','adapterHandle'];
export function fields(value,required) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==required.length
    ||required.some(key=>!Object.hasOwn(value,key)))fail('Execution record fields differ from their versioned protocol.');
}
export function hashed(value,kind,field) {
  let copy;
  try{copy=cloneSgosRecordValue(value);}catch(cause){fail('Execution record is not plain finite JSON.',undefined,null,cause);}
  if(copy?.kind!==kind||typeof copy[field]!=='string')fail('Execution record has another ABI identity.');
  admitRecordSchemaVersion(EXECUTION_UNIT_ABI_SCHEMA,copy);
  const core={...copy};delete core[field];
  if(digest(core)!==copy[field])fail('Execution record failed its exact digest.');
  return copy;
}
export function handleValue(value) {const handle=hashed(value,'execution-handle','handleSha256');fields(handle,handleFields);return handle;}
export function stopValue(value,handle,reason=null) {
  const stop=hashed(value,'stop-receipt','stopReceiptSha256');
  fields(stop,['schemaVersion','kind','handleSha256','reasonSha256','acknowledged','requestedAt','stopReceiptSha256']);
  if(stop.handleSha256!==handle.handleSha256||typeof stop.acknowledged!=='boolean'||!/^sha256:[a-f0-9]{64}$/u.test(stop.reasonSha256)
    ||!Number.isFinite(Date.parse(stop.requestedAt)))fail('The executor acknowledged another stop request.');
  if(reason!==null&&stop.reasonSha256!==('sha256:'+hash(reason)))fail('Execution already has a stop decision bound to another reason.','SGOS_GEU_STOP_CONFLICT');
  return stop;
}
export function errorValue(error) {
  let details=null;
  try{details=cloneSgosRecordValue(error?.details??null);}catch{}
  return {name:String(error?.name??'Error'),message:String(error?.message??error),code:error?.code??null,
    outcomeClass:error?.outcomeClass??null,details};
}
export function restoredError(value) {
  const error=new SingularityFlowError(value.message,{code:value.code,details:value.details,outcomeClass:value.outcomeClass});
  error.name=value.name;return error;
}
export function createExecutionAttemptValues(projectId,json){
  const project={projectId};
  const keyFor=contractSha256=>{
    if(typeof contractSha256!=='string'||!/^sha256:[a-f0-9]{64}$/u.test(contractSha256))fail('Execution requires an exact task-contract digest.');
    return 'execution/'+contractSha256.slice(7);
  };
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
  async function eventValue(raw,handle) {
    const event=hashed(raw,'execution-event','eventSha256');
    fields(event,['schemaVersion','kind','handleSha256','sequence','priorEventSha256','type','data','recordedAt','eventSha256']);
    if(event.handleSha256!==handle.handleSha256||!Number.isSafeInteger(event.sequence)||event.sequence<1||event.sequence>MAXIMUM_EVENTS
      ||!Number.isFinite(Date.parse(event.recordedAt))||typeof event.type!=='string')fail('Execution event has another handle, cursor or time.');
    return event;
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
  return Object.freeze({record,keyFor,eventValue,events,terminalEvents,candidateValue,quietValue,verifyTerminal});
}
