/** Actual shared-store conflicts, historical receipts and independent v1 byte compatibility. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {namespaceLifecycleFixture} from './helpers/namespace-lifecycle-fixture.mjs';
import {createNamespaceLifecycleReceiptReader} from '../src/engine-storage/namespace-lifecycle-receipt-reader.mjs';
import {createNamespaceLifecycleCodec} from '../src/engine-storage/namespace-lifecycle-codec.mjs';
import {lifecyclePrepared,lifecycleManifest,lifecycleReadBindings,lifecycleRecord} from '../src/engine-storage/namespace-lifecycle-contract.mjs';
import {NAMESPACE_LIFECYCLE_SCHEMAS,namespaceLifecycleRecordProfile} from '../src/foundation/record-schema.mjs';
import {NODE_TEXT_DIGESTS} from '../src/records.mjs';

const indexKey='phase-checks/drafts/fixture';
const readBinding=async f=>({namespace:'evidence',key:indexKey,version:(await f.records.read(f.scope,'evidence',indexKey)).record.version});
const reader=f=>createNamespaceLifecycleReceiptReader(f);
const codec=f=>createNamespaceLifecycleCodec({...f,limits:f.records.descriptor.limits,textDigests:NODE_TEXT_DIGESTS});
async function fixture(t,backend){
  const f=await namespaceLifecycleFixture(t,{backend});await f.update('evidence',indexKey,{observation:'first accepted result'});
  return f;
}

test('conditional operation profiles extend only prepared/manifest and select v2 explicitly',()=>{
  for(const kind of ['prepared','manifest']){
    const family=NAMESPACE_LIFECYCLE_SCHEMAS[kind];
    assert.deepEqual([family.currentVersion,family.minimumReadableVersion,family.maximumReadableVersion],[3,1,3]);
    assert.equal(family.migrationPolicy,'preserve-versions');
    assert.equal(lifecycleRecord(kind,{projectId:'fixture'}).schemaVersion,1);
    assert.equal(lifecycleRecord(kind,{projectId:'fixture'},{schemaVersion:2}).schemaVersion,2);
    assert.deepEqual(namespaceLifecycleRecordProfile(kind,{schemaVersion:1}),{format:`sflow-namespace-lifecycle-${kind}/v1`,state:null});
    assert.equal(namespaceLifecycleRecordProfile(kind,{schemaVersion:2}).readBindings,true);
    assert.equal(namespaceLifecycleRecordProfile(kind,{schemaVersion:2}).absentReadBindings,undefined);
    assert.equal(namespaceLifecycleRecordProfile(kind,{schemaVersion:3}).absentReadBindings,true);
  }
});

for(const backend of ['filesystem','sqlite','application']){
  test(backend+': v3 retains actual absence and replays after an optional checkpoint is later recorded',async t=>{
    const f=await namespaceLifecycleFixture(t,{backend}),snapshot=await f.committer.capture();
    const binding={namespace:'evidence',key:'clarifications/optional-checkpoint',version:null};
    const absent=await f.records.read(f.scope,binding.namespace,binding.key);assert.equal(absent.status,'missing');
    await f.committer.prepare(snapshot,f.proposal(snapshot.workflow,'optional-checkpoint',{readBindings:[binding]}));
    const plan=await f.committer.intent('optional-checkpoint');assert.equal(plan.schemaVersion,3);
    assert.deepEqual(codec(f).transaction(plan).preconditions.find(item=>item.key===binding.key),binding);
    const result=await f.make().commit('optional-checkpoint'),proof=await reader(f).accepted('optional-checkpoint');
    assert.equal(proof.manifest.schemaVersion,3);assert.deepEqual(proof.manifest.readBindings,[binding]);
    assert.equal((await f.records.read(f.scope,binding.namespace,binding.key)).status,'missing');
    await f.update(binding.namespace,binding.key,{answer:'later generation'});
    assert.deepEqual(await reader(f).accepted('optional-checkpoint'),proof);
    assert.deepEqual((await f.make().commit('optional-checkpoint')).receipt,result.receipt);
  });

  test(backend+': an optional checkpoint created before preparation or final acceptance cannot be missed',async t=>{
    const f=await namespaceLifecycleFixture(t,{backend}),snapshot=await f.committer.capture();
    const binding={namespace:'evidence',key:'clarifications/raced-checkpoint',version:null};
    await f.committer.prepare(snapshot,f.proposal(snapshot.workflow,'absence-at-commit',{readBindings:[binding]}));
    const plan=await f.committer.intent('absence-at-commit');
    await f.update(binding.namespace,binding.key,{responses:[{status:'deferred',blocking:true}]});
    await assert.rejects(f.make().commit('absence-at-commit'),{code:'SDA_NAMESPACE_REVISION_CONFLICT'});
    assert.deepEqual(await f.make().intent('absence-at-commit'),plan);
    const fresh=f.make();
    await assert.rejects(fresh.prepare(await fresh.capture(),f.proposal(snapshot.workflow,'absence-at-prepare',{readBindings:[binding]})),
      {code:'SDA_NAMESPACE_REVISION_CONFLICT'});
    assert.equal((await f.make().inspect('absence-at-prepare')).status,'missing');
    assert.equal((await f.committer.capture()).workflow.phases['team-document'].generation,0);
  });

  test(backend+': absent-record meaning cannot be downgraded to a v2 immutable plan or manifest',async t=>{
    const f=await namespaceLifecycleFixture(t,{backend}),snapshot=await f.committer.capture();
    await f.committer.prepare(snapshot,f.proposal(snapshot.workflow,'wire-absence',{readBindings:[{namespace:'evidence',key:'clarifications/wire',version:null}]}));
    const plan=await f.committer.intent('wire-absence');
    for(const [value,validate]of [[plan,lifecyclePrepared],[codec(f).manifest(plan),lifecycleManifest]]){
      assert.equal(validate(value,f.scope,f.workId,'wire-absence'),value);
      const older={...value,schemaVersion:2,format:value.format.replace('/v3','/v2')};
      assert.throws(()=>validate(older,f.scope,f.workId,'wire-absence'),{code:'ENGINE_STORAGE_CORRUPT'});
    }
  });

  test(backend+': a v2 publication atomically binds additional evidence revisions without changing them',async t=>{
    const f=await fixture(t,backend),writer=f.make(),snapshot=await writer.capture(),binding=await readBinding(f);
    const original=await f.records.read(f.scope,'evidence',indexKey);
    snapshot.workflow.phases['team-document'].generation=1;
    await writer.prepare(snapshot,f.proposal(snapshot.workflow,'checked-publication',{readBindings:[binding]}));
    const plan=await writer.intent('checked-publication');assert.equal(plan.schemaVersion,2);assert.deepEqual(plan.readBindings,[binding]);
    const tx=codec(f).transaction(plan),preparation=codec(f).prepareTransaction(plan);
    assert.ok(tx.preconditions.some(item=>item.key===indexKey&&item.version===binding.version));
    assert.ok(preparation.preconditions.some(item=>item.key===indexKey&&item.version===binding.version));
    const committed=await f.make().commit('checked-publication');assert.equal(committed.receipt.records.length,2);
    assert.deepEqual(await f.records.read(f.scope,'evidence',indexKey),original);
    const proof=await reader(f).accepted('checked-publication');
    assert.equal(proof.manifest.schemaVersion,2);assert.deepEqual(proof.manifest.readBindings,[binding]);
    assert.equal(proof.state.workflow.phases['team-document'].generation,1);
    assert.equal(proof.plan.requestDigest,committed.requestDigest);
    await f.update('evidence',indexKey,{observation:'later accepted result'});
    assert.deepEqual(await reader(f).accepted('checked-publication'),proof,'historical acceptance does not become a new freshness claim');
    assert.deepEqual((await f.make().commit('checked-publication')).receipt,committed.receipt);
  });

  test(backend+': a changed result rejects preparation without producing an intent or advancing the Story',async t=>{
    const f=await fixture(t,backend),snapshot=await f.committer.capture(),binding=await readBinding(f);
    await f.update('evidence',indexKey,{observation:'a later failed result'});
    await assert.rejects(f.committer.prepare(snapshot,f.proposal(snapshot.workflow,'stale-before-prepare',{readBindings:[binding]})),
      {code:'SDA_NAMESPACE_REVISION_CONFLICT'});
    assert.equal((await f.committer.inspect('stale-before-prepare')).status,'missing');
    assert.equal((await f.committer.capture()).workflow.phases['team-document'].generation,0);
  });

  test(backend+': a result changed between preparation and commit rejects the final write and preserves its candidate',async t=>{
    const f=await fixture(t,backend),snapshot=await f.committer.capture(),binding=await readBinding(f);
    snapshot.workflow.phases['team-document'].generation=1;
    await f.committer.prepare(snapshot,f.proposal(snapshot.workflow,'stale-at-commit',{readBindings:[binding]}));
    const plan=await f.committer.intent('stale-at-commit');
    await f.update('evidence',indexKey,{observation:'a later failed result'});
    await assert.rejects(f.make().commit('stale-at-commit'),{code:'SDA_NAMESPACE_REVISION_CONFLICT'});
    assert.deepEqual(await f.make().intent('stale-at-commit'),plan);
    assert.equal((await f.make().inspect('stale-at-commit')).status,'prepared');
    assert.equal((await f.committer.capture()).workflow.phases['team-document'].generation,0);
  });

  test(backend+': lost v2 preparation and final acknowledgements reconcile to the same accepted receipt',async t=>{
    const f=await fixture(t,backend);let failAt='prepare-';
    const failure=Object.assign(Error('Conditional write acknowledgement unavailable.'),{code:'ETIMEDOUT',details:{timeoutMs:300000}});
    const records={...f.records,async transact(scope,tx,options){const accepted=await f.records.transact(scope,tx,options);
      if(failAt&&tx.operationId.startsWith(failAt)){failAt=null;throw failure;}return accepted;}};
    const {createNamespaceLifecycleCommitter}=await import('../src/engine-storage/namespace-lifecycle-commit.mjs');
    const writer=createNamespaceLifecycleCommitter({...f,records}),snapshot=await writer.capture();
    const proposal=f.proposal(snapshot.workflow,'lost-checked-publication',{readBindings:[await readBinding(f)]});
    await assert.rejects(writer.prepare(snapshot,proposal),cause=>cause===failure);
    assert.equal((await reader(f).inspect(proposal.operationId)).status,'prepared');
    failAt='lifecycle-';await assert.rejects(writer.commit(proposal.operationId),cause=>cause===failure);
    const proof=await reader(f).accepted(proposal.operationId);
    assert.deepEqual((await f.make().commit(proposal.operationId)).receipt,proof.receipt);
    assert.equal((await f.records.read(f.scope,'state',f.headKey)).record.value.sequence,1);
  });
}

test('a read set rejects private, absent, duplicate and unbounded addresses',()=>{
  const item={namespace:'evidence',key:indexKey,version:'observed-version'};
  for(const value of [[],null,[{...item,namespace:'local'}],[{...item,version:null}],[item,item],
    [{...item,key:'../escape'}],[{...item,ready:true}],Array.from({length:129},(_,i)=>({...item,key:'item/'+i}))])assert.throws(()=>lifecycleReadBindings(value));
});

test('wire readers reject missing, mismatched, downgraded and future conditional operation records',async t=>{
  const f=await fixture(t,'sqlite'),snapshot=await f.committer.capture();
  await f.committer.prepare(snapshot,f.proposal(snapshot.workflow,'wire-check',{readBindings:[await readBinding(f)]}));
  const plan=await f.committer.intent('wire-check'),manifest=codec(f).manifest(plan);
  for(const [value,validate]of [[plan,lifecyclePrepared],[manifest,lifecycleManifest]]){
    const valid=()=>validate(value,f.scope,f.workId,'wire-check');assert.equal(valid(),value);
    const missing=structuredClone(value);delete missing.readBindings;assert.throws(()=>validate(missing,f.scope,f.workId,'wire-check'));
    const downgraded={...value,schemaVersion:1,format:value.format.replace('/v2','/v1')};
    assert.throws(()=>validate(downgraded,f.scope,f.workId,'wire-check'));
    assert.throws(()=>validate({...value,schemaVersion:99},f.scope,f.workId,'wire-check'),{code:'ENGINE_STORAGE_UNSUPPORTED'});
    assert.throws(()=>validate({...value,format:value.format.replace('/v2','/v1')},f.scope,f.workId,'wire-check'),{code:'ENGINE_STORAGE_CORRUPT'});
  }
  await f.committer.commit('wire-check');
  const keys=codec(f).keys('wire-check');
  const records={...f.records,async read(scope,namespace,key,options){const result=await f.records.read(scope,namespace,key,options);
    return key===keys.manifest?{...result,record:{...result.record,value:{...result.record.value,readBindings:[{namespace:'evidence',key:indexKey,version:'forged-revision'}]}}}:result;}};
  await assert.rejects(createNamespaceLifecycleReceiptReader({...f,records}).accepted('wire-check'),{code:'ENGINE_STORAGE_CORRUPT'});
});
