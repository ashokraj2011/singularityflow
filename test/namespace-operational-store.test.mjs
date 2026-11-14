import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {canonicalJson} from '../src/foundation/record-schema.mjs';
import {createNamespaceSgosOperationalStore,SGOS_NAMESPACE_OPERATIONAL_STORE_PROFILE} from '../src/sgos/namespace-operational-store.mjs';
import {assertSgosLiveOperationalStoreSelection} from '../src/sgos/operational-store.mjs';
import {exerciseOperationalStore} from './helpers/sgos-operational-conformance.mjs';
import {namespaceProjectFixture} from './helpers/namespace-project-fixture.mjs';
const storeId='execution-history',key=`sgos/operational/${storeId}/head`;
const make=(f,extra={})=>createNamespaceSgosOperationalStore({records:f.records,content:f.content,scope:f.scope,storeId,...extra});
const changes=value=>[{op:'put',key:'attempt/one',value}];
const input=(state,value)=>({expectedRevision:state.revision,expectedStateSha256:state.stateSha256,changes:changes(value)});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

test('direct append and validated restore preserve the independent native v1 packet hashes',async t=>{
  const f=await namespaceProjectFixture(t,{backend:'sqlite'}),packet=JSON.parse(await readFile(new URL('./fixtures/sgos-operational-store-packets/native-v1.json',import.meta.url),'utf8')),
    store=make(f,{storeId:'compatibility-store'});
  assert.deepEqual(await store.read(),packet.initial);
  for(const event of packet.backup.events)await store.transact({expectedRevision:event.revision-1,expectedStateSha256:event.beforeStateSha256,changes:event.changes});
  assert.deepEqual(await store.read(),packet.second);
  const rollback=await store.planRollback(1);await store.rollback({revision:1,confirmationSha256:rollback.confirmationSha256});
  assert.deepEqual(await store.read(),packet.afterRollback);
  const backup=await store.exportBackup(),other=make(f,{storeId:'compatibility-store',scope:{projectId:'restored-history'}}),plan=await other.planRestore(backup);
  await other.restore({backup,confirmationSha256:plan.confirmationSha256});assert.deepEqual(await other.read(),packet.afterRollback);
  assert.equal((await other.verify()).eventCount,packet.afterBackup.events.length);
});

for(const backend of ['filesystem','sqlite','application']) {
  test(`${backend}: namespace operational history passes the unchanged SGOS v1 conformance journey`,async t=>{
    const f=await namespaceProjectFixture(t,{backend});let sequence=0;
    await exerciseOperationalStore(id=>make(f,{storeId:id,scope:{projectId:'history-'+(++sequence)}}),{expectedPurposes:['runtime']});
    for(const namespace of ['state','config','evidence'])assert.deepEqual((await f.records.list(f.scope,namespace,{limit:100})).entries,[]);
    assert.equal(f.control.calls,0);assert.equal(f.control.clockCalls,0);
  });
  test(`${backend}: separate adapters serialize one head and retain values larger than namespace metadata`,async t=>{
    const f=await namespaceProjectFixture(t,{backend}),one=make(f),two=make(f),initial=await one.read();
    const text='x'.repeat(100_000),race=await Promise.allSettled([one,two].map((store,index)=>store.transact(input(initial,{index,text}))));
    assert.equal(race.filter(result=>result.status==='fulfilled').length,1);
    assert.equal(race.find(result=>result.status==='rejected').reason.code,'SGOS_OPERATIONAL_CAS_MISMATCH');
    assert.deepEqual(await one.read(),await two.read());assert.equal((await one.read()).entries['attempt/one'].text,text);
    const head=await f.records.read(f.scope,'runtime',key);assert.ok(Buffer.byteLength(JSON.stringify(head.record.value))<2048);
    assert.equal((await two.verify()).eventCount,1);assert.equal((await make(f).doctor()).status,'ready');
  });
  test(`${backend}: identical concurrent SPI calls still have exactly one CAS winner`,async t=>{
    const f=await namespaceProjectFixture(t,{backend}),operationIds=new Set();let arrivals=0,release;
    const both=new Promise(resolve=>{release=resolve;});
    const records={...f.records,async transact(scope,transaction){operationIds.add(transaction.operationId);
      if(++arrivals===2)release();await both;return f.records.transact(scope,transaction);}};
    const one=make(f,{records}),two=make(f,{records}),initial=await one.read(),sameInput=input(initial,{state:'running'});
    const results=await Promise.allSettled([one.transact(sameInput),two.transact(sameInput)]);
    assert.equal(operationIds.size,2,'an SPI invocation cannot acknowledge another invocation\'s receipt');
    assert.equal(results.filter(value=>value.status==='fulfilled').length,1);
    assert.equal(results.find(value=>value.status==='rejected').reason.code,'SGOS_OPERATIONAL_CAS_MISMATCH');
    assert.equal((await one.verify()).eventCount,1);
  });
}

test('construction captures explicit ports without I/O and cannot select native live authority',async t=>{
  const f=await namespaceProjectFixture(t),blocked=()=>{throw Error('Construction performed I/O.');};
  const records={...f.records,read:blocked,transact:blocked,list:blocked,inspectOperation:blocked,verify:blocked};
  const content={...f.content,put:blocked,read:blocked};
  const store=make(f,{records,content});assert.equal(store.profile,SGOS_NAMESPACE_OPERATIONAL_STORE_PROFILE);
  assert.equal(store.descriptor().authorityEligible,false);assert.throws(()=>assertSgosLiveOperationalStoreSelection(store),{code:'SGOS_OPERATIONAL_STORE_SELECTION_REFUSED'});
  const supplied={...f.records},provided={...f.content},scope={...f.scope},captured=make(f,{records:supplied,content:provided,scope});
  supplied.read=blocked;supplied.transact=blocked;provided.put=blocked;scope.projectId='foreign';
  assert.equal((await captured.transact(input(await captured.read(),true))).revision,1);
  assert.throws(()=>make(f,{root:'/implicit/workspace'}),{code:'SGOS_OPERATIONAL_STORE_INVALID'});
  assert.throws(()=>make(f,{content:{...f.content,descriptor:{...f.content.descriptor,binding:{kind:'machine-local',deviceId:'device'}}}}),{code:'SGOS_OPERATIONAL_ADAPTER_INVALID'});
});

test('a committed namespace response lost in transit is reconciled by exact operation receipt',async t=>{
  const f=await namespaceProjectFixture(t);let writes=0,inspections=0;
  const original=Object.assign(new Error('Response lost.'),{code:'SDA_NAMESPACE_OUTCOME_UNKNOWN',outcomeClass:'OUTCOME_UNKNOWN'});
  const store=make(f,{records:{...f.records,async transact(...args){writes++;await f.records.transact(...args);throw original;},
    inspectOperation(...args){inspections++;return f.records.inspectOperation(...args);}}});
  const first=await store.transact(input(await store.read(),{state:'running'}));
  assert.equal(first.revision,1);assert.equal(writes,1);assert.equal(inspections,1);assert.deepEqual(await make(f).read(),first);
});

test('unresolved commit uncertainty preserves its cause and exact recovery identity without repeating a write',async t=>{
  const f=await namespaceProjectFixture(t);let writes=0,operationId;
  const original=Object.freeze(Object.assign(new Error('Unknown write, inspect unavailable.'),{code:'SDA_NAMESPACE_OUTCOME_UNKNOWN'}));
  const store=make(f,{records:{...f.records,async transact(scope,transaction){writes++;operationId=transaction.operationId;
    await f.records.transact(scope,transaction);throw original;},inspectOperation(){throw Error('Offline.');}}});
  await assert.rejects(store.transact(input(await store.read(),true)),error=>error.cause===original&&error.code===original.code
    &&error.message===original.message&&error.outcomeClass==='OUTCOME_UNKNOWN'&&error.details.operationId===operationId
    &&/^[a-f0-9]{64}$/u.test(error.details.requestDigest)&&error.details.namespace==='runtime'&&error.details.revision===1);
  assert.equal(writes,1);assert.equal((await f.records.inspectOperation(f.scope,operationId)).status,'committed');
  assert.equal((await make(f).read()).revision,1);
});

test('a malformed inspection receipt preserves uncertainty and the original failed-write cause',async t=>{
  const f=await namespaceProjectFixture(t),original=Object.assign(new Error('Response lost.'),{code:'SDA_NAMESPACE_OUTCOME_UNKNOWN'});
  let operationId;
  const store=make(f,{records:{...f.records,async transact(scope,transaction){operationId=transaction.operationId;
    await f.records.transact(scope,transaction);throw original;},async inspectOperation(...args){const result=await f.records.inspectOperation(...args);
      return {...result,receipt:{...result.receipt,scope:{projectId:'foreign'}}};}}});
  await assert.rejects(store.transact(input(await store.read(),true)),error=>error.code===original.code
    &&error.outcomeClass==='OUTCOME_UNKNOWN'&&error.cause===original&&error.details.operationId===operationId);
  assert.equal((await make(f).read()).revision,1);
});

test('real permission, timeout and content-read failures preserve identity and details',async t=>{
  const f=await namespaceProjectFixture(t),normal=make(f);await normal.transact(input(await normal.read(),true));
  for(const code of ['EACCES','ETIMEDOUT']) {
    const original=Object.freeze(Object.assign(new Error('Original port failure.'),{code,details:{timedOut:code==='ETIMEDOUT',stage:'read'}}));
    const store=make(f,{content:{...f.content,read(){throw original;}}});
    await assert.rejects(store.read(),error=>error===original);await assert.rejects(store.verify(),error=>error===original);
  }
  const original=Object.assign(new Error('Metadata unavailable.'),{code:'SDA_NAMESPACE_UNAVAILABLE'});
  await assert.rejects(make(f,{records:{...f.records,read(){throw original;}}}).read(),error=>error===original);
});

test('uncommitted content is not an accepted event and the same intended write can safely resume',async t=>{
  const f=await namespaceProjectFixture(t);let interrupt=true;
  const original=Object.assign(new Error('Interrupted before head commit.'),{code:'EACCES'});
  const store=make(f,{content:{...f.content,put(scope,namespace,bytes){
    if(interrupt&&JSON.parse(new TextDecoder().decode(bytes)).format==='sflow.sgos.namespace-operational-lineage')throw original;
    return f.content.put(scope,namespace,bytes);}}});
  const initial=await store.read(),transaction=input(initial,{state:'running'});
  await assert.rejects(store.transact(transaction),error=>error===original);assert.deepEqual(await make(f).read(),initial);
  assert.equal((await f.records.read(f.scope,'runtime',key)).status,'missing');
  interrupt=false;assert.equal((await store.transact(transaction)).revision,1);assert.equal((await store.verify()).eventCount,1);
});

test('a namespace receipt must match the scope, transaction, changed record and event',async t=>{
  const f=await namespaceProjectFixture(t);
  const store=make(f,{records:{...f.records,async transact(...args){const result=await f.records.transact(...args);
    return {...result,receipt:{...result.receipt,requestDigest:'0'.repeat(64)}};}}});
  await assert.rejects(store.transact(input(await store.read(),true)),{code:'SGOS_OPERATIONAL_PORT_RESULT_INVALID'});
  assert.equal((await make(f).read()).revision,1,'a bad acknowledgement cannot claim that a real commit was rolled back');
});

test('missing, truncated and altered history content is corruption rather than an empty runtime',async t=>{
  const f=await namespaceProjectFixture(t),normal=make(f);await normal.transact(input(await normal.read(),true));
  for(const transform of [()=>({status:'missing',data:null}),result=>({...result,truncated:true}),
    result=>({...result,data:Buffer.from('altered')})]) {
    const store=make(f,{content:{...f.content,async read(...args){return transform(await f.content.read(...args));}}});
    await assert.rejects(store.read(),{code:'SGOS_OPERATIONAL_STORE_CORRUPT'});
  }
});

test('a BOM-prefixed but otherwise valid lineage is refused by its exact canonical bytes',async t=>{
  const f=await namespaceProjectFixture(t,{backend:'sqlite'}),store=make(f);await store.transact(input(await store.read(),true));
  const head=(await f.records.read(f.scope,'runtime',key)).record;
  const current=await f.content.read(f.scope,head.value.lineage);
  const bytes=Buffer.concat([Buffer.from([239,187,191]),Buffer.from(current.data)]);
  const lineage=(await f.content.put(f.scope,'runtime',bytes)).reference;
  await f.records.transact(f.scope,{operationId:'bom-lineage-fixture',preconditions:[{namespace:'runtime',key,version:head.version}],
    changes:[{op:'put',namespace:'runtime',key,immutable:false,value:{...head.value,lineage}}],events:[]});
  await assert.rejects(store.read(),{code:'SGOS_OPERATIONAL_STORE_CORRUPT'});
  await assert.rejects(store.verify(),{code:'SGOS_OPERATIONAL_STORE_CORRUPT'});
});

test('a self-hashed content object cannot substitute a different event or another project head',async t=>{
  const f=await namespaceProjectFixture(t),normal=make(f);await normal.transact(input(await normal.read(),true));
  const head=(await f.records.read(f.scope,'runtime',key)).record;
  const response=await f.content.read(f.scope,head.value.lineage),lineage=JSON.parse(new TextDecoder().decode(response.data));
  const eventResponse=await f.content.read(f.scope,lineage.events[0]),event=JSON.parse(new TextDecoder().decode(eventResponse.data));
  event.revision=9;
  const altered=(await f.content.put(f.scope,'runtime',Buffer.from(canonicalJson(event)))).reference;
  const index=(await f.content.put(f.scope,'runtime',Buffer.from(canonicalJson({...lineage,events:[altered]})))).reference;
  await f.records.transact(f.scope,{operationId:'corrupt-history-fixture',preconditions:[{namespace:'runtime',key,version:head.version}],
    changes:[{op:'put',namespace:'runtime',key,immutable:false,value:{...head.value,lineage:index}}],events:[]});
  await assert.rejects(normal.read(),{code:'SGOS_OPERATIONAL_STORE_CORRUPT'});
  const foreign=make(f,{scope:{projectId:'foreign'}});assert.equal((await foreign.read()).revision,0);
  const records={...f.records,async read(){return {status:'present',record:{...head,value:{...head.value,projectId:'foreign'}}};}};
  await assert.rejects(make(f,{records}).read(),{code:'SGOS_OPERATIONAL_STORE_CORRUPT'});
});

test('restore keeps its prior accepted head if imported content fails and refuses stale plans',async t=>{
  const f=await namespaceProjectFixture(t),source=make(f,{scope:{projectId:'source'}});
  for(const value of [1,2,3])await source.transact(input(await source.read(),value));
  const backup=await source.exportBackup(),target=make(f),before=await target.read(),plan=await target.planRestore(backup);
  let writes=0;const original=Object.assign(new Error('Interrupted import.'),{code:'ETIMEDOUT',timedOut:true});
  const failing=make(f,{content:{...f.content,put(...args){if(++writes===2)throw original;return f.content.put(...args);}}});
  await assert.rejects(failing.restore({backup,confirmationSha256:plan.confirmationSha256}),error=>error===original);
  assert.deepEqual(await target.read(),before);
  assert.equal((await target.restore({backup,confirmationSha256:plan.confirmationSha256})).revision,3);
  await assert.rejects(target.restore({backup,confirmationSha256:plan.confirmationSha256}),{code:'SGOS_OPERATIONAL_RESTORE_STALE'});
  const repeated=await target.planRestore(backup);assert.equal(repeated.mode,'noop');
  assert.equal((await target.restore({backup,confirmationSha256:repeated.confirmationSha256})).restored,false);
});

test('restore verifies the full retained prefix and cross-profile backups are not silently relabelled',async t=>{
  const f=await namespaceProjectFixture(t),source=make(f,{scope:{projectId:'source'}}),target=make(f);
  await source.transact(input(await source.read(),1));await target.transact(input(await target.read(),2));
  const backup=await source.exportBackup();await assert.rejects(target.planRestore(backup),{code:'SGOS_OPERATIONAL_RESTORE_DIVERGED'});
  const other={...backup,profile:'filesystem-live-v1'};delete other.backupSha256;
  other.backupSha256='sha256:'+digest(Buffer.from(canonicalJson(other)));
  await assert.rejects(target.planRestore(other),{code:'SGOS_OPERATIONAL_BACKUP_INVALID'});
});

test('longer history restores atomically without widening the namespace transaction bound',async t=>{
  const f=await namespaceProjectFixture(t,{backend:'sqlite'}),source=make(f,{scope:{projectId:'history-source'}});
  for(let number=1;number<=130;number++)await source.transact(input(await source.read(),number));
  const backup=await source.exportBackup();assert.equal(backup.events.length,130);
  let writes=0;
  const target=make(f,{records:{...f.records,transact(scope,transaction){writes++;assert.equal(transaction.changes.length,1);
    assert.ok(transaction.changes.length<=f.records.descriptor.limits.maxChanges);return f.records.transact(scope,transaction);}}});
  const plan=await target.planRestore(backup);await target.restore({backup,confirmationSha256:plan.confirmationSha256});
  assert.equal(writes,1);assert.deepEqual(await target.read(),await source.read());assert.equal((await target.verify()).eventCount,130);
});
