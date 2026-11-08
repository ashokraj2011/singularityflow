/** Persistence of already-admitted transitions; these fixtures do not authorize approval. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { advanceCompletedPhase, sequenceAdmission, applyConfirmedSequenceState } from '../src/kernel/lifecycle-transitions.mjs';
import { NAMESPACE_LIFECYCLE_SCHEMAS, admitRecordSchemaVersion, namespaceLifecycleRecordProfile } from '../src/foundation/record-schema.mjs';
import { lifecycleRecord, lifecycleState } from '../src/engine-storage/namespace-lifecycle-contract.mjs';
import { namespaceLifecycleFixture } from './helpers/namespace-lifecycle-fixture.mjs';

const scope={projectId:'profile-fixture'},configuration={namespace:'config',sha256:'a'.repeat(64),bytes:1};
const head={authorityId:'fixture-authority',epoch:1,workId:'fixture-story',configuration:{key:'approved/current',content:configuration}};
function body(version=2,status='in_progress',currentPhase='draft'){
  return {schemaVersion:version,format:`sflow-namespace-lifecycle-state/v${version}`,projectId:scope.projectId,
    authorityId:head.authorityId,epoch:head.epoch,workId:head.workId,configuration,
    workflow:{workItem:{id:head.workId},status,currentPhase,phases:{draft:{id:'draft',generation:1,status:'approved'}}}};
}
const oldBytes=(f,workflow)=>Buffer.from(JSON.stringify({...JSON.parse(f.encode(workflow)),schemaVersion:1,format:'sflow-namespace-lifecycle-state/v1'})+'\n');
function close(workflow){const phase=workflow.phases['team-document'];workflow.status='in_progress';workflow.phaseOrder=[phase.id];phase.status='approved';phase.generation=1;advanceCompletedPhase(workflow,phase,'fixture-time');}

test('v2 state is a version-preserving profile while the other lifecycle formats stay v1',()=>{
  const entry=NAMESPACE_LIFECYCLE_SCHEMAS.state;
  assert.deepEqual([entry.currentVersion,entry.minimumReadableVersion,entry.maximumReadableVersion],[2,1,2]);
  assert.equal(entry.migrationPolicy,'preserve-versions');assert.equal(Object.isFrozen(entry),true);
  for(const [kind,profile]of Object.entries(NAMESPACE_LIFECYCLE_SCHEMAS))if(kind!=='state'){
    assert.deepEqual([profile.currentVersion,profile.minimumReadableVersion,profile.maximumReadableVersion],[1,1,1]);
    assert.equal(profile.migrationPolicy,'frozen-identity');
  }
  const legacy={...entry,currentVersion:1,maximumReadableVersion:1,migrationPolicy:'frozen-identity'};
  assert.throws(()=>admitRecordSchemaVersion(legacy,body()),{code:'SCHEMA_VERSION_FUTURE'});
  const v1=namespaceLifecycleRecordProfile('state',body(1)),v2=namespaceLifecycleRecordProfile('state',body(2));
  assert.deepEqual(v1.state.terminalStatuses,[]);assert.deepEqual(v2.state.terminalStatuses,['closed','cancelled']);
  assert.equal(Object.isFrozen(v2),true);assert.equal(Object.isFrozen(v2.state.terminalStatuses),true);
  assert.throws(()=>namespaceLifecycleRecordProfile('constructor',body()),{code:'SCHEMA_FAMILY_UNKNOWN'});
});

test('v1 preserves its original active-phase meaning and v2 admits explicit terminal pointers',()=>{
  const legacy=body(1);assert.equal(lifecycleState(legacy,scope,head),legacy);
  for(const status of ['closed','cancelled']){
    assert.throws(()=>lifecycleState(body(1,status,null),scope,head),{code:'ENGINE_STORAGE_CORRUPT'});
    const terminal=body(2,status,null);assert.equal(lifecycleState(terminal,scope,head),terminal);
  }
  assert.equal(lifecycleRecord('state',{projectId:scope.projectId}).format,'sflow-namespace-lifecycle-state/v2');
  assert.equal(legacy.schemaVersion,1);assert.equal(legacy.format,'sflow-namespace-lifecycle-state/v1');
});

test('v2 refuses absent, inherited and ambiguous terminal markers and unknown wire versions',()=>{
  for(const status of [undefined,null,'in_progress','awaiting_approval','approved','completed','archived']){
    assert.throws(()=>lifecycleState(body(2,status,null),scope,head),{code:'ENGINE_STORAGE_CORRUPT'});
  }
  for(const current of [undefined,'',0,'missing','constructor',[],{}]){
    const invalid=body(2,'closed');invalid.workflow.currentPhase=current;
    assert.throws(()=>lifecycleState(invalid,scope,head),{code:'ENGINE_STORAGE_CORRUPT'});
  }
  const inherited=body(2,'closed',null);delete inherited.workflow.currentPhase;
  Object.setPrototypeOf(inherited.workflow,{currentPhase:null});
  assert.throws(()=>lifecycleState(inherited,scope,head),{code:'ENGINE_STORAGE_CORRUPT'});
  const mismatched=body();mismatched.format='sflow-namespace-lifecycle-state/v1';
  assert.throws(()=>lifecycleState(mismatched,scope,head),{code:'ENGINE_STORAGE_CORRUPT'});
  assert.throws(()=>lifecycleState(body(3),scope,head),error=>error.code==='ENGINE_STORAGE_UNSUPPORTED'
    &&error.cause.code==='SCHEMA_VERSION_FUTURE'&&error.details.readable.maximum===2);
  assert.throws(()=>lifecycleState(body(0),scope,head),{code:'ENGINE_STORAGE_CORRUPT'});
});

for(const backend of ['filesystem','sqlite','application']){
  test(`${backend}: retains a final kernel transition with no current phase`,async t=>{
    const f=await namespaceLifecycleFixture(t,{backend}),snapshot=await f.committer.capture();
    close(snapshot.workflow);
    assert.equal(snapshot.workflow.status,'closed');assert.equal(snapshot.workflow.currentPhase,null);
    const proposal=f.proposal(snapshot.workflow,'finish',{operation:'phase.approve'});
    await f.committer.prepare(snapshot,proposal);
    assert.equal((await f.records.read(f.scope,'state',f.headKey)).record.value.sequence,0);
    const committed=await f.make().commit('finish');
    assert.equal(committed.status,'committed');
    const reopened=await f.make().capture();
    assert.equal(reopened.workflow.status,'closed');assert.equal(reopened.workflow.currentPhase,null);
    const head=(await f.records.read(f.scope,'state',f.headKey)).record.value;
    const retained=await f.content.read(f.scope,head.state);
    assert.deepEqual(Buffer.from(retained.data),proposal.state);
    assert.equal(JSON.parse(Buffer.from(retained.data)).schemaVersion,2);
    assert.deepEqual((await f.make().commit('finish')).receipt,committed.receipt);
    assert.equal((await f.records.list(f.scope,'evidence',{limit:100})).entries.length,1);
    // Confirmation belongs to the admission owner; reading a closed aggregate does not authorize reopening.
    const decision=sequenceAdmission(reopened.workflow,{requestedPhase:'team-document'});
    assert.equal(decision.allowed,false);assert.equal(decision.gate,'completion');
    applyConfirmedSequenceState(reopened.workflow,reopened.workflow.phases['team-document'],decision,'confirmed-fixture-time');
    await f.make().capture(); // a detached mutation cannot alter accepted storage
    assert.equal((await f.committer.capture()).workflow.status,'closed');
    const writer=f.make(),basis=await writer.capture();
    // A local draft operation cannot be relabelled as a shared lifecycle commit or grant reopening.
    await assert.rejects(writer.prepare(basis,f.proposal(reopened.workflow,'continued',{operation:'phase.begin'})),{code:'ENGINE_INPUT_INVALID'});
    assert.equal((await writer.inspect('continued')).status,'missing');
    assert.deepEqual((await f.make().commit('finish')).receipt,committed.receipt);
    assert.equal((await f.make().capture()).workflow.status,'closed');
    assert.equal((await f.make().capture()).workflow.currentPhase,null);
  });

  test(`${backend}: another process completes and replays the terminal checkpoint without Git`,async t=>{
    const f=await namespaceLifecycleFixture(t,{backend}),snapshot=await f.committer.capture();close(snapshot.workflow);
    await f.committer.prepare(snapshot,f.proposal(snapshot.workflow,'finish',{operation:'phase.approve'}));
    const input={backend,directory:f.directory,scope:f.scope,workId:f.workId,authority:f.authority,headKey:f.headKey,recordsId:f.records.descriptor.id,operationId:'finish'};
    const child=spawnSync(process.execPath,[fileURLToPath(new URL('./helpers/namespace-lifecycle-reopen.mjs',import.meta.url)),JSON.stringify(input)],
      {env:{...process.env,PATH:''},encoding:'utf8',timeout:30_000,maxBuffer:1_048_576});
    assert.equal(child.status,0,child.stderr||child.error?.message);
    const result=JSON.parse(child.stdout);assert.equal(result.version,2);
    assert.equal(result.workflow.status,'closed');assert.equal(result.workflow.currentPhase,null);
    assert.deepEqual((await f.committer.commit('finish')).receipt,result.receipt);
    assert.equal((await f.make().capture()).workflow.status,'closed');
  });

  test(`${backend}: v1 heads and prepared bytes remain intact through explicit v2 completion`,async t=>{
    const f=await namespaceLifecycleFixture(t,{backend});
    const original=oldBytes(f,f.workflow),reference=(await f.content.put(f.scope,'state',original)).reference;
    const before=(await f.records.read(f.scope,'state',f.headKey)).record;
    await f.update('state',f.headKey,{...before.value,state:reference});
    const legacyHead=(await f.records.read(f.scope,'state',f.headKey)).record;
    const snapshot=await f.committer.capture();
    assert.deepEqual((await f.records.read(f.scope,'state',f.headKey)).record,legacyHead);
    snapshot.workflow.phases['team-document'].generation=1;
    const pendingBytes=oldBytes(f,snapshot.workflow);
    await f.committer.prepare(snapshot,f.proposal(snapshot.workflow,'legacy-pending',{state:pendingBytes}));
    const accepted=await f.make().commit('legacy-pending');
    const active=(await f.records.read(f.scope,'state',f.headKey)).record.value;
    assert.deepEqual(Buffer.from((await f.content.read(f.scope,active.state)).data),pendingBytes);
    const current=await f.make().capture();close(current.workflow);
    const writer=f.make(),basis=await writer.capture();
    await writer.prepare(basis,f.proposal(current.workflow,'finish',{operation:'phase.approve'}));await writer.commit('finish');
    const final=(await f.records.read(f.scope,'state',f.headKey)).record.value;
    assert.deepEqual(final.previous,active.state);
    assert.equal(JSON.parse(Buffer.from((await f.content.read(f.scope,final.state)).data)).schemaVersion,2);
    assert.deepEqual(Buffer.from((await f.content.read(f.scope,reference)).data),original);
    assert.deepEqual(Buffer.from((await f.content.read(f.scope,active.state)).data),pendingBytes);
    assert.deepEqual((await f.make().commit('legacy-pending')).receipt,accepted.receipt);
    assert.equal((await f.make().capture()).workflow.currentPhase,null);
  });

  test(`${backend}: invalid or future terminal proposals preserve the head and create no checkpoint`,async t=>{
    const f=await namespaceLifecycleFixture(t,{backend}),snapshot=await f.committer.capture();
    const before=(await f.records.read(f.scope,'state',f.headKey)).record;
    for(const [name,update,code]of [
      ['not-terminal',value=>{value.workflow.currentPhase=null;value.workflow.status='in_progress';},'ENGINE_STORAGE_CORRUPT'],
      ['no-status',value=>{value.workflow.currentPhase=null;delete value.workflow.status;},'ENGINE_STORAGE_CORRUPT'],
      ['future',value=>{value.schemaVersion=3;value.format='sflow-namespace-lifecycle-state/v3';},'ENGINE_STORAGE_UNSUPPORTED'],
      ['v1-terminal',value=>{value.schemaVersion=1;value.format='sflow-namespace-lifecycle-state/v1';value.workflow.status='closed';value.workflow.currentPhase=null;},'ENGINE_STORAGE_CORRUPT']
    ]){
      const value=JSON.parse(f.encode(snapshot.workflow));update(value);
      await assert.rejects(f.committer.prepare(snapshot,f.proposal(snapshot.workflow,name,{state:Buffer.from(JSON.stringify(value))})),{code});
      assert.equal((await f.committer.inspect(name)).status,'missing');
      assert.deepEqual((await f.records.read(f.scope,'state',f.headKey)).record,before);
    }
  });
}
