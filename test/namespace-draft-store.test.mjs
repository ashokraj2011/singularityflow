import test from 'node:test';
import assert from 'node:assert/strict';
import { namespacePreparationFixture } from './helpers/namespace-preparation-fixture.mjs';
import { createNamespaceDraftStore } from '../src/engine-storage/namespace-draft-store.mjs';

const parameters='a'.repeat(64),otherParameters='b'.repeat(64);
function store(f,options={}) {return createNamespaceDraftStore({records:f.localRecords,content:f.localContent,scope:f.scope,
  workId:f.inputs.workId,phaseId:'intake',...options});}
const first={operationId:'private-origin',parametersSha256:parameters,expectedRevision:null,payload:{authored:'actual private bytes'}};

test('private receipt inspection validates the immutable operation revision as well as the head',async t=>{
  const f=await namespacePreparationFixture(t);await store(f).save(first);
  const records={...f.localRecords,async read(...args){const result=await f.localRecords.read(...args);
    return result.record?.immutable?{...result,record:{...result.record,version:'another-immutable-revision'}}:result;}};
  await assert.rejects(store(f,{records}).capture(),{code:'ENGINE_STORAGE_CORRUPT'});
  await assert.rejects(store(f,{records}).inspect(first.operationId,parameters),{code:'ENGINE_STORAGE_CORRUPT'});
});

test('a malformed acceptance acknowledgement cannot erase an accepted private write or duplicate it',async t=>{
  const f=await namespacePreparationFixture(t);let calls=0;
  const records={...f.localRecords,async transact(...args){calls++;const accepted=await f.localRecords.transact(...args);
    return {...accepted,receipt:{...accepted.receipt,requestDigest:'0'.repeat(64)}};}};
  await assert.rejects(store(f,{records}).save(first),{code:'ENGINE_PORT_RESULT_INVALID'});
  const accepted=await store(f).save(first);assert.equal(accepted.replayed,true);assert.equal(calls,1);
  assert.deepEqual(accepted.payload,first.payload);
  assert.equal((await f.localRecords.list(f.scope,'local',{limit:100})).entries.length,2);
});

test('private operation IDs cannot be reused for another request and old receipts survive later edits',async t=>{
  const f=await namespacePreparationFixture(t),draft=store(f),origin=await draft.save(first);
  const second=await draft.save({operationId:'second-edit',parametersSha256:otherParameters,expectedRevision:origin.revision,payload:{authored:'later bytes'}});
  assert.deepEqual(await draft.save(first),{...origin,replayed:true});
  await assert.rejects(draft.save({...first,parametersSha256:otherParameters}),{code:'ENGINE_OPERATION_ID_REUSED'});
  assert.equal((await draft.capture()).revision,second.revision);
});

test('future private metadata stays an explicit unsupported record without replacement',async t=>{
  const f=await namespacePreparationFixture(t);const accepted=await store(f).save(first);
  const records={...f.localRecords,async read(...args){const result=await f.localRecords.read(...args);
    return result.record?.key.endsWith('/head')?{...result,record:{...result.record,value:{...result.record.value,schemaVersion:2}}}:result;}};
  await assert.rejects(store(f,{records}).capture(),{code:'ENGINE_STORAGE_UNSUPPORTED'});
  assert.equal((await store(f).capture()).revision,accepted.revision);
});

test('a concurrent private head change is detected during capture while both authored bodies are retained',async t=>{
  const f=await namespacePreparationFixture(t),actual=store(f),origin=await actual.save(first);let once=false;
  const records={...f.localRecords,async read(...args){const result=await f.localRecords.read(...args);
    if(!once&&result.record?.key.endsWith('/head')) {once=true;
      await actual.save({operationId:'concurrent-edit',parametersSha256:otherParameters,expectedRevision:origin.revision,payload:{authored:'concurrent bytes'}});}
    return result;}};
  await assert.rejects(store(f,{records}).capture(),{code:'ENGINE_CONTEXT_CHANGED'});
  assert.equal((await actual.capture()).payload.authored,'concurrent bytes');
  assert.equal((await actual.inspect(first.operationId,parameters)).payload.authored,'actual private bytes');
});

test('private binding, cancellation and missing byte errors remain distinct before acceptance',async t=>{
  const f=await namespacePreparationFixture(t),draft=store(f);
  assert.throws(()=>store(f,{content:{...f.localContent,descriptor:{...f.localContent.descriptor,binding:{kind:'machine-local',deviceId:'another-device'}}}}),{code:'ENGINE_INPUT_INVALID'});
  const controller=new AbortController();controller.abort();
  await assert.rejects(draft.save(first,{signal:controller.signal}),{code:'ENGINE_OPERATION_CANCELLED'});
  assert.equal(await draft.capture(),null);
  await assert.rejects(draft.bytes({namespace:'local',sha256:'0'.repeat(64),bytes:1}),{code:'ENGINE_STORAGE_CONTENT_MISSING'});
});
