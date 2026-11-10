import test from 'node:test';import assert from 'node:assert/strict';
import {createNamespaceReadSession,memoNamespaceStoryOrigin,memoNamespaceWitnessProof} from '../src/engine-storage/namespace-read-session.mjs';
const scope={projectId:'P'},reference={namespace:'evidence',sha256:'a'.repeat(64),bytes:4};
function fixture(){let records=0,contents=0,receipts=0,denied=null;const session=createNamespaceReadSession({
  records:{read:async(_scope,_namespace,key)=>{records++;if(denied)throw denied;return {status:'present',record:{immutable:key!=='head',value:{count:42}}};},
    inspectOperation:async()=>{receipts++;return {status:'committed',receipt:{id:receipts}};}},
  content:{read:async(_scope,ref,{maximumBytes=ref.bytes}={})=>{contents++;if(denied)throw denied;return {status:'present',reference:ref,
    data:Buffer.alloc(Math.min(maximumBytes,ref.bytes),contents),truncated:maximumBytes<ref.bytes};}}
});return {session,counts:()=>({records,contents,receipts}),deny:error=>{denied=error;}};}
test('one invocation coalesces immutable reads but returns private copies and always rereads mutable heads',async()=>{
  const f=fixture();await f.session.run(async()=>{
    const [a,b]=await Promise.all([f.session.records.read(scope,'state','original'),f.session.records.read(scope,'state','original')]);
    a.record.value.count=99;assert.equal(b.record.value.count,42);
    await f.session.records.read(scope,'state','original');
    const first=await f.session.content.read(scope,reference);first.data.fill(0);
    assert.deepEqual((await f.session.content.read(scope,reference)).data,Buffer.alloc(4,1));
    await f.session.records.read(scope,'state','head');await f.session.records.read(scope,'state','head');
    await f.session.records.inspectOperation(scope,'operation');await f.session.records.inspectOperation(scope,'operation');
    assert.deepEqual(f.counts(),{records:4,contents:1,receipts:1});
  });
  await f.session.run(()=>f.session.content.read(scope,reference));assert.equal(f.counts().contents,2);
});
test('permissions, missing results and partial reads are not reused across their required fresh reads',async()=>{
  const f=fixture(),denied=Object.assign(new Error('Actual provider permission failure.'),{code:'EACCES'});
  await f.session.run(async()=>{await f.session.content.read(scope,reference,{maximumBytes:1});await f.session.content.read(scope,reference);
    assert.equal(f.counts().contents,2);});f.deny(denied);
  await assert.rejects(f.session.run(()=>f.session.content.read(scope,reference)),error=>error===denied);
  await assert.rejects(f.session.run(()=>f.session.content.read(scope,reference)),error=>error===denied);
  let reads=0;const session=createNamespaceReadSession({records:{read:async()=>{reads++;return {status:'missing',record:null};}},content:{}});
  await session.run(async()=>{await session.records.read(scope,'state','absent');await session.records.read(scope,'state','absent');});assert.equal(reads,2);
});
test('concurrent invocations, distinct scopes and cancelled reads cannot borrow another invocation result',async()=>{
  const f=fixture();await Promise.all([f.session.run(()=>f.session.content.read(scope,reference)),f.session.run(()=>f.session.content.read(scope,reference))]);
  assert.equal(f.counts().contents,2);await f.session.run(async()=>{await f.session.content.read(scope,reference);
    await f.session.content.read({projectId:'OTHER'},reference);const controller=new AbortController();controller.abort();
    await assert.rejects(f.session.content.read(scope,reference,{signal:controller.signal}),{code:'ENGINE_OPERATION_CANCELLED'});});
  assert.equal(f.counts().contents,4);
});
test('oversized facts and reads beyond the entry quota remain uncached',async()=>{
  const f=fixture(),large={...reference,bytes:9*1024*1024};await f.session.run(async()=>{
    await f.session.content.read(scope,large);await f.session.content.read(scope,large);assert.equal(f.counts().contents,2);
    for(let i=0;i<256;i++)await f.session.records.read(scope,'evidence','item-'+i);
    await f.session.records.read(scope,'evidence','overflow');await f.session.records.read(scope,'evidence','overflow');
    assert.equal(f.counts().records,258);
  });
});
test('mutable heads are never coalesced, and unfinished reads expire with their invocation',async()=>{
  let headReads=0,release,pending;const session=createNamespaceReadSession({records:{read:async()=>({status:'present',record:{immutable:false,value:++headReads}})},
    content:{read:()=>new Promise(resolve=>{release=()=>resolve({status:'present',reference,data:Buffer.alloc(4),truncated:false});})}});
  await session.run(async()=>{const [first,second]=await Promise.all([session.records.read(scope,'state','head'),session.records.read(scope,'state','head')]);
    assert.notEqual(first.record.value,second.record.value);});assert.equal(headReads,2);
  await session.run(()=>{pending=session.content.read(scope,reference);});
  const rejected=assert.rejects(pending,{code:'ENGINE_CONTEXT_CHANGED'});release();await rejected;
});

test('immutable original proofs are reused only by exact captured ports in the same live invocation',async()=>{
  const f=fixture(),key='the-original-project-and-authority';let observations=0;
  const read=(records=f.session.records,content=f.session.content)=>memoNamespaceStoryOrigin(records,content,key,async()=>({configuration:{version:++observations}}));
  await f.session.run(async()=>{const [a,b]=await Promise.all([read(),read()]);assert.equal(observations,1);a.configuration.version=99;
    assert.equal(b.configuration.version,1);assert.equal((await read()).configuration.version,1);
    assert.equal((await read({...f.session.records})).configuration.version,2);
    assert.equal((await read(f.session.records,{...f.session.content})).configuration.version,3);
  });
  await f.session.run(async()=>assert.equal((await read()).configuration.version,4));
  let errors=0;const original=Object.assign(new Error('Exact origin read failed.'),{code:'EACCES'});
  await f.session.run(async()=>{for(let i=0;i<2;i++)await assert.rejects(memoNamespaceStoryOrigin(f.session.records,f.session.content,'bad-origin',()=>{errors++;throw original;}),error=>error===original);});
  assert.equal(errors,2);
});

test('every transaction boundary invalidates immutable reuse, including a lost or failed write response',async()=>{
  let reads=0,deny=false,replyFailure=false;const original=Object.assign(new Error('The actual write reply was lost.'),{code:'ETIMEDOUT'}),
    denied=Object.assign(new Error('The accepted intent is no longer readable.'),{code:'EACCES'}),session=createNamespaceReadSession({
      records:{read:async()=>{reads++;if(deny)throw denied;return {status:'present',record:{immutable:true,value:reads}};},
        transact:async()=>{if(replyFailure)throw original;return {status:'committed'};}},content:{}});
  await session.run(async()=>{await session.records.read(scope,'runtime','intent');await session.records.read(scope,'runtime','intent');assert.equal(reads,1);
    await session.records.transact(scope,{changes:[]});await session.records.read(scope,'runtime','intent');assert.equal(reads,2);
    replyFailure=true;await assert.rejects(session.records.transact(scope,{changes:[]}),error=>error===original);deny=true;
    await assert.rejects(session.records.read(scope,'runtime','intent'),error=>error===denied);
  });
});
test('a read in flight across a transaction cannot repopulate the following transaction scope',async()=>{
  let release,reads=0;const session=createNamespaceReadSession({records:{transact:async()=>({status:'committed'})},content:{
    read:async()=>{reads++;if(reads===1)await new Promise(resolve=>{release=resolve;});return {status:'present',reference,data:Buffer.alloc(4,reads),truncated:false};}}});
  await session.run(async()=>{const first=session.content.read(scope,reference);await Promise.resolve();await session.records.transact(scope,{changes:[]});
    release();await first;await session.content.read(scope,reference);assert.equal(reads,2);});
});
test('accepted witness proof reuse is bounded by exact ports, identity and transaction lifetime',async()=>{
  let reads=0,deny=false;const failure=Object.freeze(Object.assign(Error('Original witness receipt is unavailable.'),{code:'ETIMEDOUT'})),
    session=createNamespaceReadSession({records:{transact:async()=>({status:'committed'})},content:{}}),
    identity={scope,workId:'story',authority:{id:'authority',epoch:1},link:{record:reference}},
    observe=async()=>{reads++;if(deny)throw failure;return {value:{recordId:'WIT-001',references:[reference]}};},
    read=(selected=identity,records=session.records,content=session.content)=>memoNamespaceWitnessProof(records,content,selected,observe);
  await session.run(async()=>{const [a,b]=await Promise.all([read(),read()]);assert.equal(reads,1);a.value.recordId='altered';assert.equal(b.value.recordId,'WIT-001');
    await read({...identity,workId:'other'});assert.equal(reads,2);await read(identity,{...session.records});assert.equal(reads,3);
    await session.records.transact(scope,{});await read();assert.equal(reads,4);});
  deny=true;for(let i=0;i<2;i++)await assert.rejects(session.run(()=>read()),error=>error===failure);assert.equal(reads,6);
});
