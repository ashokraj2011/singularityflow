import {NODE_TEXT_DIGESTS} from '../src/records.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {namespaceLifecycleFixture} from './helpers/namespace-lifecycle-fixture.mjs';
import {createNamespaceLifecycleReceiptReader} from '../src/engine-storage/namespace-lifecycle-receipt-reader.mjs';
import {createNamespaceLifecycleCodec} from '../src/engine-storage/namespace-lifecycle-codec.mjs';
import {NAMESPACE_STORE_METHODS} from '../src/sda/namespace/contract.mjs';
import {LIFECYCLE_AUTHORITY_KEY} from '../src/engine-storage/namespace-lifecycle-contract.mjs';
function reader(f,overrides={}){return createNamespaceLifecycleReceiptReader({records:f.records,content:f.content,scope:f.scope,workId:f.workId,authority:f.authority,...overrides});}
function wrapped(f,overrides){return {descriptor:f.records.descriptor,...Object.fromEntries(NAMESPACE_STORE_METHODS.map(name=>[name,f.records[name].bind(f.records)])),...overrides};}
async function committed(t,backend='sqlite'){
  const f=await namespaceLifecycleFixture(t,{backend}),snapshot=await f.committer.capture(),workflow=structuredClone(snapshot.workflow);
  workflow.phases['team-document'].generation=1;
  await f.committer.prepare(snapshot,f.proposal(workflow));const accepted=await f.committer.commit('publish-1');return {...f,accepted};
}
for(const backend of ['filesystem','sqlite','application'])test(backend+': evidence readers distinguish missing, genuinely prepared and accepted lifecycle operations',async t=>{
  const f=await namespaceLifecycleFixture(t,{backend}),r=reader(f),cache={};
  assert.deepEqual(await r.inspect('publish-1'),{status:'missing',operationId:'publish-1'});
  await assert.rejects(r.accepted('publish-1',{cache}),error=>error.code==='ENGINE_OPERATION_NOT_COMMITTED'&&error.details.status==='missing');
  const snapshot=await f.committer.capture(),workflow=structuredClone(snapshot.workflow);workflow.phases['team-document'].generation=1;
  await f.committer.prepare(snapshot,f.proposal(workflow));
  assert.equal((await r.inspect('publish-1')).status,'prepared');
  await assert.rejects(r.accepted('publish-1',{cache}),error=>error.code==='ENGINE_OPERATION_NOT_COMMITTED'&&error.details.status==='prepared');
  const accepted=await f.committer.commit('publish-1'),before=await f.records.read(f.scope,'state',f.headKey);
  const proof=await r.accepted('publish-1',{cache});assert.deepEqual(proof.receipt,accepted.receipt);
  assert.equal(proof.basisState.workflow.phases['team-document'].generation,0);assert.equal(proof.state.workflow.phases['team-document'].generation,1);
  assert.equal(Object.isFrozen(proof.state.workflow),true);
  assert.throws(()=>{proof.state.workflow.currentPhase='invented';},TypeError);
  assert.deepEqual(await f.records.read(f.scope,'state',f.headKey),before);
});
test('receipt inspection has no storage effects, reuses one traversal and starts fresh on the next',async t=>{
  const f=await committed(t);let reads=0;
  const records=wrapped(f,{async read(...args){reads++;return f.records.read(...args);},async transact(){throw Error('A reader must never transact.');}}),r=reader(f,{records}),cache={};
  const first=await r.accepted('publish-1',{cache}),count=reads;
  assert.equal(await r.accepted('publish-1',{cache}),first);assert.equal(reads,count);
  await r.accepted('publish-1',{cache:{}});assert.ok(reads>count);
});
for(const mutation of ['intent','manifest','manifest-version','configuration-version','prepare-receipt','commit-receipt','state'])test('receipt proof rejects changed '+mutation,async t=>{
  const f=await committed(t),codec=createNamespaceLifecycleCodec({...f,textDigests:NODE_TEXT_DIGESTS}),keys=codec.keys('publish-1');
  const records=wrapped(f,{
    async read(scope,namespace,key,options){const result=structuredClone(await f.records.read(scope,namespace,key,options));
      if(key===keys.prepared&&mutation==='intent')result.record.value.inputsSha256='b'.repeat(64);
      if(key===keys.manifest&&mutation==='manifest')result.record.value.inputsSha256='b'.repeat(64);
      if(key===keys.manifest&&mutation==='manifest-version')result.record.version='another-manifest-revision';
      if(namespace==='config'&&mutation==='configuration-version')result.record.version='another-config-revision';
      return result;},
    async inspectOperation(scope,id,options){const result=structuredClone(await f.records.inspectOperation(scope,id,options));
      if(mutation==='prepare-receipt'&&id===keys.prepareOperation||mutation==='commit-receipt'&&id===keys.operation)result.receipt.requestDigest='b'.repeat(64);
      return result;}
  });
  const content=mutation==='state'?{descriptor:f.content.descriptor,put:f.content.put.bind(f.content),
    async read(scope,ref,options){const result=await f.content.read(scope,ref,options);if(ref.namespace==='state'&&result.data?.length)result.data[0]^=1;return result;}}:f.content;
  await assert.rejects(reader(f,{records,content}).accepted('publish-1'),error=>['ENGINE_STORAGE_CORRUPT','ENGINE_PORT_RESULT_INVALID'].includes(error.code));
});
test('receipt proof preserves exact storage failures, retries failed traversals and honors cancellation',async t=>{
  const f=await committed(t),failure=Object.assign(Error('Original storage deadline with provider detail'),{code:'SDA_TIMEOUT',details:{deadlineMs:300000}});let fail=true;
  const records=wrapped(f,{async read(...args){if(fail)throw failure;return f.records.read(...args);}}),r=reader(f,{records}),cache={};
  await assert.rejects(r.accepted('publish-1',{cache}),error=>error===failure);fail=false;
  assert.equal((await r.accepted('publish-1',{cache})).status,'committed');
  await assert.rejects(r.accepted('publish-1',{cache,signal:AbortSignal.abort()}),error=>error.code==='ENGINE_OPERATION_CANCELLED');
});
test('historical accepted receipts remain readable after a later head and authority fencing',async t=>{
  const f=await committed(t),original=await reader(f).accepted('publish-1'),snapshot=await f.committer.capture();
  const changed=structuredClone(snapshot.workflow);changed.phases['team-document'].generation=2;
  await f.committer.prepare(snapshot,f.proposal(changed,'publish-2'));await f.committer.commit('publish-2');
  await f.update('state',LIFECYCLE_AUTHORITY_KEY,{...f.enrolled,status:'fenced'});
  assert.deepEqual(await reader(f).accepted('publish-1'),original);
});
test('missing manifests and unsupported intent or manifest schemas preserve their explicit errors',async t=>{
  const f=await committed(t),codec=createNamespaceLifecycleCodec({...f,textDigests:NODE_TEXT_DIGESTS}),keys=codec.keys('publish-1');
  for(const [key,version,code] of [[keys.manifest,null,'ENGINE_LIFECYCLE_RECORD_MISSING'],
    [keys.prepared,99,'ENGINE_STORAGE_UNSUPPORTED'],[keys.manifest,99,'ENGINE_STORAGE_UNSUPPORTED']]){
    const records=wrapped(f,{async read(scope,namespace,id,options){const result=await f.records.read(scope,namespace,id,options);
      if(id!==key)return result;if(version===null)return {status:'missing',record:null};
      return {...result,record:{...result.record,value:{...result.record.value,schemaVersion:version}}};}});
    await assert.rejects(reader(f,{records}).accepted('publish-1'),{code});
  }
});
