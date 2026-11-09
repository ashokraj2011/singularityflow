/** Version-preserving conditional lifecycle identities. Pure encoding, never storage or policy admission. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {namespaceLifecycleRecordProfile,textDigestCapability} from '../foundation/record-schema.mjs';
import {namespaceLimits} from '../sda/namespace/contract.mjs';
import {namespaceJson,namespaceIdentityJson,namespaceIdentifier,namespaceScope,namespaceRevision,exactObject} from '../sda/namespace/values.mjs';
import {namespaceTransaction,namespaceTransactionIdentity} from '../sda/namespace/transaction.mjs';
import {LIFECYCLE_AUTHORITY_KEY,lifecycleReadBindings} from './namespace-lifecycle-contract.mjs';
const same=(a,b)=>namespaceIdentityJson(a)===namespaceIdentityJson(b);
const error=(message,code,details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});
const v1=(kind,value)=>({schemaVersion:1,format:namespaceLifecycleRecordProfile(kind,{schemaVersion:1}).format,...value});
export function validWorkId(value) {
  if(typeof value!=='string'||!value||value.length>2048||/[\u0000-\u001f\u007f]/u.test(value))throw error(
    'Lifecycle persistence needs an explicit bounded Story ID.','ENGINE_INPUT_INVALID');
  return value;
}
export function namespaceLifecycleStoryKey(workId,textDigests){return `stories/${textDigestCapability(textDigests).sha256Utf8(namespaceIdentityJson({workId:validWorkId(workId)}))}/head`;}
export function createNamespaceLifecycleCodec({scope,workId,authority,limits,textDigests}={}) {
  scope=namespaceScope(scope);workId=validWorkId(workId);limits=namespaceLimits(limits);
  exactObject(authority,['id','epoch']);authority=Object.freeze(structuredClone(authority));
  namespaceIdentifier(authority.id,'Authority ID');
  if(!Number.isSafeInteger(authority.epoch)||authority.epoch<1)throw error('Lifecycle persistence needs an authority epoch.','ENGINE_INPUT_INVALID');
  const hash=textDigestCapability(textDigests).sha256Utf8,identity=value=>hash(namespaceIdentityJson(value));
  const headKey=namespaceLifecycleStoryKey(workId,textDigests);
  const token=operationId=>identity({projectId:scope.projectId,workId,authorityId:authority.id,epoch:authority.epoch,operationId});
  const keys=operationId=>{const id=token(namespaceIdentifier(operationId,'Operation ID'));
    return {operation:`lifecycle-${id}`,prepareOperation:`prepare-${id}`,prepared:`lifecycle/prepared/${id}`,manifest:`lifecycle/operations/${id}`,event:`lifecycle-${id}`};};
  function head(plan){const previous=plan.basis.head;return v1('head',{projectId:scope.projectId,workId,authorityId:authority.id,epoch:authority.epoch,
    sequence:previous.sequence+1,configuration:previous.configuration,state:plan.state,previous:previous.state,operationId:plan.operationId});}
  function reads(plan){const profile=namespaceLifecycleRecordProfile('prepared',plan);
    if(!profile.readBindings&&Object.hasOwn(plan,'readBindings'))throw error('A v1 operation cannot add conditional read bindings.','ENGINE_STORAGE_CORRUPT');
    return profile.readBindings?lifecycleReadBindings(plan.readBindings):[];}
  function manifest(plan){const previous=plan.basis.head,readBindings=reads(plan),schemaVersion=plan.schemaVersion,
    profile=namespaceLifecycleRecordProfile('prepared',plan);
    return {schemaVersion,format:namespaceLifecycleRecordProfile('manifest',{schemaVersion}).format,projectId:scope.projectId,workId,authorityId:authority.id,epoch:authority.epoch,
    sequence:previous.sequence+1,operationId:plan.operationId,operation:plan.operation,inputsSha256:plan.inputsSha256,
    configuration:previous.configuration,previous:previous.state,state:plan.state,evidence:plan.evidence,
    ...(profile.readBindings?{readBindings}:{})};}
  function transaction(plan){const k=keys(plan.operationId),previous=plan.basis.head;
    return namespaceTransaction({operationId:k.operation,preconditions:[
      {namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,version:plan.basis.authorityVersion},
      {namespace:'state',key:headKey,version:plan.basis.headVersion},
      {namespace:'config',key:previous.configuration.key,version:plan.basis.configurationVersion},
      {namespace:'evidence',key:k.manifest,version:null},...reads(plan)],changes:[
      {op:'put',namespace:'state',key:headKey,immutable:false,value:head(plan)},
      {op:'put',namespace:'evidence',key:k.manifest,immutable:true,value:manifest(plan)}],
    events:[{eventId:k.event,eventType:'engine.operation-committed',namespace:'state',
      payload:{workId,operation:plan.operation,sequence:previous.sequence+1,state:plan.state}}]},limits);
  }
  function prepareTransaction(plan){const k=keys(plan.operationId),basis=plan.basis;
    return namespaceTransaction({operationId:k.prepareOperation,preconditions:[
      {namespace:'runtime',key:k.prepared,version:null},
      {namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,version:basis.authorityVersion},
      {namespace:'state',key:headKey,version:basis.headVersion},
      {namespace:'config',key:basis.head.configuration.key,version:basis.configurationVersion},...reads(plan)],
    changes:[{op:'put',namespace:'runtime',key:k.prepared,immutable:true,value:plan}],events:[]},limits);
  }
  const requestDigest=tx=>hash(namespaceTransactionIdentity(scope,tx,limits));
  function receipt(result,plan,tx=transaction(plan)) {
    const expected=tx.changes.map(change=>[change.namespace,change.key]);let r;
    try {
      r=namespaceJson(result?.receipt,{maxBytes:limits.maxValueBytes});
      exactObject(r,['operationId','scope','revision','requestDigest','records','eventIds']);
      namespaceScope(r.scope);namespaceRevision(r.revision);
      if(!Array.isArray(r.records))throw error('Receipt records must be an array.','ENGINE_PORT_RESULT_INVALID');
      for(const record of r.records){exactObject(record,['namespace','key','version']);
        if(namespaceRevision(record.version)===null)throw error('A put receipt needs an opaque record revision.','ENGINE_PORT_RESULT_INVALID');}
    }catch(cause){throw error('The namespace port returned an invalid receipt. Inspect the retained operation intent.',
      'ENGINE_PORT_RESULT_INVALID',{workId,operationId:plan.operationId},cause);}
    if(result?.status!=='committed'||!r||r.operationId!==tx.operationId||r.scope?.projectId!==scope.projectId
      ||r.requestDigest!==requestDigest(tx)||r.revision===null||result.replayed!==undefined&&typeof result.replayed!=='boolean'
      ||!Array.isArray(r.records)||!Array.isArray(r.eventIds)||r.records.length!==expected.length||!same(r.eventIds,tx.events.map(event=>event.eventId))
      ||new Set(r.records.map(record=>JSON.stringify([record.namespace,record.key]))).size!==expected.length
      ||!r.records.every(record=>expected.some(([namespace,key])=>record.namespace===namespace&&record.key===key)))throw error(
      'The namespace port returned a different operation receipt; inspect the same retained intent.','ENGINE_PORT_RESULT_INVALID',
      {workId,operationId:plan.operationId,requestDigest:plan.requestDigest});
    return namespaceJson(r,{maxBytes:limits.maxValueBytes});
  }
  return Object.freeze({keys,headKey,head,manifest,transaction,prepareTransaction,requestDigest,receipt});
}
