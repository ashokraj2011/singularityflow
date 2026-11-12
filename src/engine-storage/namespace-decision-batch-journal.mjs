/** Conditional runtime intent for a reviewed batch. Each domain decision keeps its own transaction. */
import {createHash} from 'node:crypto';
import {canonicalJson,namespaceDecisionBatchProfile} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {namespaceLimits} from '../sda/namespace/contract.mjs';
import {namespaceTransaction,namespaceTransactionIdentity} from '../sda/namespace/transaction.mjs';
import {namespaceJournalReceipt} from '../sda/namespace/journal-contract.mjs';
import {exactObject,namespaceRevision} from '../sda/namespace/values.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {LIFECYCLE_AUTHORITY_KEY,lifecycleHead} from './namespace-lifecycle-contract.mjs';
import {namespaceLifecycleStoryKey} from './namespace-lifecycle-reader.mjs';
import {createNamespaceLifecycleCodec} from './namespace-lifecycle-codec.mjs';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
import {phaseAccessIdentity} from '../kernel/phase-preparation.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex'),same=(a,b)=>canonicalJson(a)===canonicalJson(b),
  fail=(message,code='ENGINE_STORAGE_CORRUPT',cause=undefined)=>{throw new SingularityFlowError(message,{code,cause});};
export function createNamespaceDecisionBatchJournal({records,content,scope,workId,authority,observer}){
  const limits=namespaceLimits(records.descriptor.limits),binding={projectId:scope.projectId,workId,authorityId:authority.id,epoch:authority.epoch},
    key=identity=>'decision-batches/'+identity,operationId=identity=>'decision-batch-'+identity,
    lifecycle=createNamespaceLifecycleCodec({scope,workId,authority,limits,textDigests:NODE_TEXT_DIGESTS});
  function body(value,identity){
    const profile=namespaceDecisionBatchProfile('body',value);
    exactObject(value,['schemaVersion','format','binding','identity','input','principal','permissions','at','basis','policy','source','plan']);
    if(value.format!==profile.format||!same(value.binding,binding)||value.identity!==identity||!Array.isArray(value.permissions)
      ||!value.policy||value.policy.workId!==workId||value.input.confirmation!==value.policy.packetSha256
      ||!Array.isArray(value.plan?.steps)||!value.plan.steps.length)fail('The batch body has another original review binding.');
    exactObject(value.principal,['actor','agentId']);exactObject(value.principal.actor,['principalId','actorKind','identity']);
    const actor=value.principal.actor,principal=phaseAccessIdentity({projectId:scope.projectId,principalId:actor.principalId,actorKind:actor.actorKind,
      identity:actor.identity,agentId:value.principal.agentId,permissions:value.permissions},scope.projectId);
    if(actor.actorKind!=='human'||!same(principal,value.principal)||projectEnrollmentTimestamp(value.at)!==value.at
      ||!value.permissions.every(row=>typeof row==='string'&&row.length>0&&row.length<=128))
      fail('The batch lost its original authenticated human and timestamp.');
    exactObject(value.basis,['authorityVersion','headVersion','configurationVersion','head']);lifecycleHead(value.basis.head,scope,workId);
    for(const name of ['authorityVersion','headVersion','configurationVersion'])if(namespaceRevision(value.basis[name])===null)fail('The batch lost its original conditional basis.');
    return value;
  }
  function metadata(value,identity){const profile=namespaceDecisionBatchProfile('reference',value);
    exactObject(value,['schemaVersion','format','binding','identity','content','readBindings']);
    if(value.format!==profile.format||!same(value.binding,binding)||value.identity!==identity||contentReference(value.content).namespace!=='runtime'
      ||!Array.isArray(value.readBindings))fail('The retained batch reference is invalid.');return value;}
  function transaction(value,reference,readBindings){return namespaceTransaction({operationId:operationId(value.identity),preconditions:[
    {namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,version:value.basis.authorityVersion},
    {namespace:'state',key:namespaceLifecycleStoryKey(workId,NODE_TEXT_DIGESTS),version:value.basis.headVersion},
    {namespace:'config',key:value.basis.head.configuration.key,version:value.basis.configurationVersion},
    ...readBindings,{namespace:'runtime',key:key(value.identity),version:null}],changes:[{op:'put',namespace:'runtime',key:key(value.identity),immutable:true,
      value:{schemaVersion:1,format:namespaceDecisionBatchProfile('reference',{schemaVersion:1}).format,binding,identity:value.identity,content:reference,readBindings}}],events:[]},limits);}
  function receipt(result,tx){let found;try{found=namespaceJournalReceipt(result?.receipt,scope,tx.operationId);
      if(result.status!=='committed'||found.requestDigest!==hash(namespaceTransactionIdentity(scope,tx,limits))||found.records.length!==1
        ||found.records[0].namespace!=='runtime'||found.records[0].key!==tx.changes[0].key||found.eventIds.length)throw Error('Another transaction.');
    }catch(cause){fail('The runtime receipt does not prove this exact decision batch.','ENGINE_PORT_RESULT_INVALID',cause);}return found;}
  async function retained(identity,{signal}={}){
    const accepted=await records.inspectOperation(scope,operationId(identity),{signal}),record=await observer.record('runtime',key(identity),true,signal,true);
    if(accepted?.status==='missing'&&accepted.receipt===null){if(record)fail('An unaccepted batch cannot authorize recording.');return null;}
    if(!record)fail('The accepted batch lost its original review intent.');
    const value=metadata(record.value,identity);let original;
    const bytes=await observer.bytes(value.content,value.content.bytes,signal);
    try{original=body(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),identity);}
    catch(cause){if(cause.code==='SCHEMA_VERSION_FUTURE'||cause.code==='SCHEMA_VERSION_ARCHIVED')fail('The batch needs its original record reader.','ENGINE_STORAGE_UNSUPPORTED',cause);
      if(cause.code)throw cause;fail('The original batch is not valid JSON.','ENGINE_STORAGE_CORRUPT',cause);}
    const proof=receipt(accepted,transaction(original,value.content,value.readBindings));if(proof.records[0].version!==record.version)fail('The batch has another accepted record revision.');
    const retainedState=await observer.state(await observer.bytes(original.basis.head.state,original.basis.head.state.bytes,signal),original.basis.head,{signal});
    if(original.basis.head.sequence===0){const first=await observer.originalHead({signal});
      if(first.version!==original.basis.headVersion||!same(first.head,original.basis.head))fail('The batch lost its actual original Story creation.');
    }else{const actual=await observer.accepted(original.basis.head.operationId,{signal});
      if(actual.receipt.records.find(row=>row.namespace==='state'&&row.key===namespaceLifecycleStoryKey(workId,NODE_TEXT_DIGESTS))?.version!==original.basis.headVersion
        ||!same(lifecycle.head(actual.plan),original.basis.head)||actual.plan.basis.configurationVersion!==original.basis.configurationVersion
        ||!same(actual.state.workflow,retainedState.workflow))fail('The decision batch lost its actual original Story.');}
    return {value:original,snapshot:{workId,revision:original.basis.headVersion,configuration:original.basis.head.configuration,workflow:retainedState.workflow},
      record:record.value.content,reference:{key:key(identity),version:record.version,content:record.value.content}};
  }
  async function retain(value,observed,{signal}={}){
    body(value,value.identity);const previous=await retained(value.identity,{signal});if(previous){if(!same(previous.value,value))fail('The batch identity has another reviewed request.','ENGINE_OPERATION_ID_REUSED');return previous;}
    for(const pending of observed.pendingEvidence??[]){const saved=await content.put(scope,'evidence',pending.bytes,{signal});
      if(!same(saved.reference,pending.reference)||!observed.references.some(row=>same(row,pending.reference)))fail('The batch source bytes differ from its admitted observation.','ENGINE_PORT_RESULT_INVALID');}
    const bytes=Buffer.from(canonicalJson(value)),expected={namespace:'runtime',sha256:hash(bytes),bytes:bytes.byteLength},saved=await content.put(scope,'runtime',bytes,{signal});
    if(!same(contentReference(saved.reference),expected))fail('The content store acknowledged another reviewed batch.','ENGINE_PORT_RESULT_INVALID');
    await observer.bytes(expected,expected.bytes,signal);const tx=transaction(value,expected,observed.readBindings??[]);
    try{receipt(await records.transact(scope,tx,{signal}),tx);}catch(cause){
      if(!['SDA_NAMESPACE_REVISION_CONFLICT','SDA_NAMESPACE_OPERATION_ID_REUSED'].includes(cause.code))throw cause;
      const concurrent=await retained(value.identity,{signal});if(!concurrent||!same(concurrent.value,value))throw cause;return concurrent;}
    return retained(value.identity,{signal});
  }
  function outcomeTransaction(identity,reference,batch){return namespaceTransaction({operationId:'decision-batch-complete-'+identity,
    preconditions:[{namespace:'runtime',key:batch.key,version:batch.version},{namespace:'runtime',key:key(identity)+'/outcome',version:null}],
    changes:[{op:'put',namespace:'runtime',key:key(identity)+'/outcome',immutable:true,value:{schemaVersion:1,
      format:namespaceDecisionBatchProfile('reference',{schemaVersion:1}).format,binding,identity,content:reference,
      readBindings:[{namespace:'runtime',key:batch.key,version:batch.version}]}}],events:[]},limits);}
  async function outcome(identity,batch,{signal}={}){
    const accepted=await records.inspectOperation(scope,'decision-batch-complete-'+identity,{signal}),record=await observer.record('runtime',key(identity)+'/outcome',true,signal,true);
    if(accepted?.status==='missing'&&accepted.receipt===null){if(record)fail('An unaccepted batch result cannot acknowledge decisions.');return null;}
    if(!record)fail('The batch completion lost its immutable result.');const saved=metadata(record.value,identity);
    const bytes=await observer.bytes(saved.content,saved.content.bytes,signal);let value;
    try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
    catch(cause){fail('The batch completion is not valid JSON.','ENGINE_STORAGE_CORRUPT',cause);}
    const profile=namespaceDecisionBatchProfile('outcome',value);
    exactObject(value,['schemaVersion','format','binding','identity','batch','result']);
    if(value.format!==profile.format||value.identity!==identity||!same(value.binding,binding)||!same(value.batch,batch.reference)
      ||!same(saved.readBindings,[{namespace:'runtime',key:batch.reference.key,version:batch.reference.version}]))fail('The batch completion has another original intent.');
    const proof=receipt(accepted,outcomeTransaction(identity,saved.content,value.batch));if(proof.records[0].version!==record.version)fail('The batch completion changed its accepted record.');
    return value.result;
  }
  async function complete(identity,batch,result,{signal}={}){
    const previous=await outcome(identity,batch,{signal});if(previous)return previous;
    const value={schemaVersion:1,format:namespaceDecisionBatchProfile('outcome',{schemaVersion:1}).format,binding,identity,batch:batch.reference,result},
      bytes=Buffer.from(canonicalJson(value)),expected={namespace:'runtime',sha256:hash(bytes),bytes:bytes.byteLength},saved=await content.put(scope,'runtime',bytes,{signal});
    if(!same(contentReference(saved.reference),expected))fail('The completion store acknowledged another result.','ENGINE_PORT_RESULT_INVALID');
    await observer.bytes(expected,expected.bytes,signal);const tx=outcomeTransaction(identity,expected,batch.reference);
    try{receipt(await records.transact(scope,tx,{signal}),tx);}catch(cause){if(!['SDA_NAMESPACE_REVISION_CONFLICT','SDA_NAMESPACE_OPERATION_ID_REUSED'].includes(cause.code))throw cause;
      const concurrent=await outcome(identity,batch,{signal});if(!concurrent)throw cause;return concurrent;}
    return outcome(identity,batch,{signal});
  }
  return Object.freeze({retained,retain,outcome,complete});
}
