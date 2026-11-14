import test from 'node:test';import assert from 'node:assert/strict';
import {createNamespaceReadSession,captureNamespaceReadBindings,memoNamespaceStoryOrigin,memoNamespaceWitnessProof,memoNamespaceCodePredecessorProof,memoNamespaceCodePolicyProof,memoNamespaceDecisionProof,memoNamespaceLifecycleReceiptProof,memoNamespaceFrozenLifecycleReceiptProof} from '../src/engine-storage/namespace-read-session.mjs';
import {namespaceStoreDescriptor,NAMESPACE_STORE_METHODS} from '../src/sda/namespace/contract.mjs';
import {contentStoreDescriptor,CONTENT_STORE_METHODS} from '../src/sda/content/contract.mjs';
const scope={projectId:'P'},reference={namespace:'evidence',sha256:'a'.repeat(64),bytes:4};
test('read-only receipt reuse freezes every nested state and expires at exact port, write and invocation boundaries',async()=>{
  const session=createNamespaceReadSession({records:{transact:async()=>({status:'committed'})},content:{}});let reads=0,denied=false;
  const failure=Object.freeze(Object.assign(Error('Actual retained receipt read failed.'),{code:'EACCES'})),identity={scope,operationId:'accepted'},
    observe=()=>{reads++;if(denied)throw failure;return {status:'committed',state:{workflow:{phases:[{id:'code',generation:reads}]}},basisState:{rows:[1]}};},
    read=(records=session.records)=>memoNamespaceFrozenLifecycleReceiptProof(records,session.content,identity,observe);
  await session.run(async()=>{const first=await read();assert.equal(Object.isFrozen(first.state.workflow.phases[0]),true);
    assert.throws(()=>{first.state.workflow.phases[0].generation=99;},TypeError);assert.strictEqual(await read(),first);assert.equal(reads,1);
    await read({...session.records});assert.equal(reads,2);await session.records.transact(scope,{});assert.notStrictEqual(await read(),first);assert.equal(reads,3);});
  await session.run(()=>read());assert.equal(reads,4);denied=true;
  for(let n=0;n<2;n++)await assert.rejects(session.run(()=>read()),error=>error===failure);assert.equal(reads,6);
  const signal=AbortSignal.abort();await assert.rejects(session.run(()=>memoNamespaceFrozenLifecycleReceiptProof(session.records,session.content,identity,observe,{signal})),{code:'ENGINE_OPERATION_CANCELLED'});
});
test('a completed accepted receipt displaces raw cache entries without increasing the entry or byte bounds',async()=>{
  const f=fixture();let observed=0;
  await f.session.run(async()=>{for(let n=0;n<256;n++)await f.session.records.read(scope,'evidence','raw-'+n);
    const read=()=>memoNamespaceLifecycleReceiptProof(f.session.records,f.session.content,{scope,operationId:'accepted'},()=>({status:'committed',plan:{version:++observed}}));
    const first=await read();first.plan.version=99;assert.equal((await read()).plan.version,1);assert.equal(observed,1);
    await f.session.records.read(scope,'evidence','raw-0');await f.session.records.read(scope,'evidence','raw-0');assert.equal(f.counts().records,258);
  });
  const bytes=fixture();let proofs=0;
  await bytes.session.run(async()=>{const large={...reference,bytes:7*1024*1024};await bytes.session.content.read(scope,large);
    const read=()=>memoNamespaceCodePolicyProof(bytes.session.records,bytes.session.content,{scope,publication:reference},()=>({report:'p'.repeat(2*1024*1024),proof:++proofs}));
    await read();await read();assert.equal(proofs,1);await bytes.session.content.read(scope,large);await bytes.session.content.read(scope,large);
    assert.equal(bytes.counts().contents,3);await read();assert.equal(proofs,1);
  });
});
test('pending receipts, failed reads, copied ports and later invocations cannot borrow a completed receipt proof',async()=>{
  const session=createNamespaceReadSession({records:{transact:async()=>({status:'committed'})},content:{}});let reads=0,denied=false;
  const failure=Object.assign(Error('The original conditional receipt is unreadable.'),{code:'EACCES',details:{path:'runtime/original'}}),
    read=(records=session.records)=>memoNamespaceLifecycleReceiptProof(records,session.content,{scope,operationId:'immutable-receipt'},()=>{
      reads++;if(denied)throw failure;return {status:reads===1?'prepared':'committed',record:{number:reads}};});
  await session.run(async()=>{assert.equal((await read()).status,'prepared');const committed=await read();assert.equal(committed.status,'committed');
    assert.deepEqual(await read(),committed);assert.equal(reads,2);await read({...session.records});assert.equal(reads,3);
    await session.records.transact(scope,{});await read();assert.equal(reads,4);});
  denied=true;for(let n=0;n<2;n++)await assert.rejects(session.run(()=>read()),error=>error===failure);assert.equal(reads,6);
});
test('genuine captured read bindings preserve their live invocation, while copied or substituted ports cannot enroll themselves',async()=>{
  const binding={kind:'shared'},forbidden=()=>{throw Error('Capturing read bindings cannot perform I/O.');},
    records={descriptor:namespaceStoreDescriptor({id:'capture-records',qualification:'test-only',binding}),...Object.fromEntries(NAMESPACE_STORE_METHODS.map(name=>[name,forbidden])),transact:async()=>({status:'committed'})},
    content={descriptor:contentStoreDescriptor({id:'capture-content',binding,maximumBytes:134217728}),...Object.fromEntries(CONTENT_STORE_METHODS.map(name=>[name,forbidden]))},
    session=createNamespaceReadSession({records,content}),captured=captureNamespaceReadBindings(session.records,session.content),
    copied=captureNamespaceReadBindings({...session.records},session.content);let calls=0;
  const observe=()=>({proof:++calls}),read=(ports=captured)=>memoNamespaceCodePolicyProof(ports.records,ports.content,{scope,publication:reference},observe);
  assert.ok(Object.isFrozen(captured.records));assert.throws(()=>{captured.records.read=forbidden;},TypeError);
  await session.run(async()=>{await read();await read({records:session.records,content:session.content});assert.equal(calls,1);
    await read(copied);await read(copied);assert.equal(calls,3);await captured.records.transact(scope,{});await read();assert.equal(calls,4);});
  await session.run(()=>read());assert.equal(calls,5);
});
test('completed Code proof reuse preserves exact binding, errors, mutation boundaries and independent result ownership',async()=>{
  let reads=0,deny=false;const failure=Object.freeze(Object.assign(Error('Actual immutable Code proof is unreadable.'),{code:'EACCES'})),
    session=createNamespaceReadSession({records:{transact:async()=>({status:'committed'})},content:{}}),identity={scope,workId:'story',authority:{id:'a',epoch:1},publication:reference},
    observe=()=>{reads++;if(deny)throw failure;return {report:{preflight:{outputs:{files:[{content:reference}]}}}};},
    read=(selected=identity,records=session.records,content=session.content)=>memoNamespaceCodePolicyProof(records,content,selected,observe);
  await session.run(async()=>{const first=await read();first.report.preflight.outputs.files.length=0;assert.equal((await read()).report.preflight.outputs.files.length,1);assert.equal(reads,1);
    await read({...identity,workId:'other'});await read(identity,{...session.records});await read(identity,session.records,{...session.content});assert.equal(reads,4);
    await session.records.transact(scope,{});await read();assert.equal(reads,5);});
  deny=true;for(let i=0;i<2;i++)await assert.rejects(session.run(()=>read()),error=>error===failure);assert.equal(reads,7);
});
test('unfinished recursive Code traversals are never coalesced into a self-waiting proof',async()=>{
  const session=createNamespaceReadSession({records:{},content:{}});let calls=0;
  await session.run(async()=>{const read=()=>memoNamespaceCodePolicyProof(session.records,session.content,{scope,publication:reference},async()=>{
      calls++;if(calls===1)return read();return {validated:'inner-traversal'};});
    assert.deepEqual(await read(),{validated:'inner-traversal'});assert.equal(calls,2);await read();assert.equal(calls,2);});
});
test('accepted decision projections are private, exact-port bounded and invalidated at every write or invocation',async()=>{
  const failure=Object.freeze(Object.assign(Error('Actual accepted decision read failed.'),{code:'EACCES'}));let reads=0,denied=false;
  const session=createNamespaceReadSession({records:{transact:async()=>({status:'committed'})},content:{}}),
    identity={scope,workId:'story',authority:{id:'authority',epoch:1},owner:'plan-amendments',link:{record:reference}},
    observe=()=>{reads++;if(denied)throw failure;return {rows:[{id:'PRC-001',actualContent:reference}]};},
    read=(input=identity,records=session.records,content=session.content)=>memoNamespaceDecisionProof(records,content,input,observe);
  await session.run(async()=>{const [a,b]=await Promise.all([read(),read()]);assert.equal(reads,1);a.rows[0].id='counterfeit';assert.equal(b.rows[0].id,'PRC-001');
    await read({...identity,owner:'another-owner'});assert.equal(reads,2);await read(identity,{...session.records});assert.equal(reads,3);
    await read(identity,session.records,{...session.content});assert.equal(reads,4);await session.records.transact(scope,{});await read();assert.equal(reads,5);});
  denied=true;for(let i=0;i<2;i++)await assert.rejects(session.run(()=>read()),error=>error===failure);assert.equal(reads,7);
  const abort=new AbortController();abort.abort();await assert.rejects(session.run(()=>memoNamespaceDecisionProof(session.records,session.content,identity,observe,{signal:abort.signal})),{code:'ENGINE_OPERATION_CANCELLED'});
});
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
test('Code predecessor proof reuse keeps exact inputs, private results, fresh errors and write boundaries',async()=>{
  let reads=0,deny=false;const failure=Object.assign(Error('Actual predecessor proof cannot be read.'),{code:'EACCES'}),
    session=createNamespaceReadSession({records:{transact:async()=>({status:'committed'})},content:{}}),
    identity={scope,workId:'story',authority:{id:'authority',epoch:1},phase:'code',workflowSha256:'a'.repeat(64),sourceSha256:'b'.repeat(64)},
    observe=()=>{reads++;if(deny)throw failure;return {phases:[{phase:'previous-code',references:[reference]}]};},
    read=(value=identity,records=session.records,content=session.content)=>memoNamespaceCodePredecessorProof(records,content,value,observe);
  await session.run(async()=>{const [first,second]=await Promise.all([read(),read()]);assert.equal(reads,1);first.phases[0].phase='changed';
    assert.equal(second.phases[0].phase,'previous-code');await read({...identity,sourceSha256:'c'.repeat(64)});assert.equal(reads,2);
    await read(identity,{...session.records});assert.equal(reads,3);await read(identity,session.records,{...session.content});assert.equal(reads,4);
    await session.records.transact(scope,{});await read();assert.equal(reads,5);});
  deny=true;for(let i=0;i<2;i++)await assert.rejects(session.run(()=>read()),error=>error===failure);assert.equal(reads,7);
  const controller=new AbortController();controller.abort();await assert.rejects(session.run(()=>memoNamespaceCodePredecessorProof(
    session.records,session.content,identity,observe,{signal:controller.signal})),{code:'ENGINE_OPERATION_CANCELLED'});
});
