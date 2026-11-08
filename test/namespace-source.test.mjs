import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile,readFile,mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ENGINE_OPERATIONS } from '../src/engine-sdk/index.mjs';
import { namespaceSourceFixture } from './helpers/namespace-source-fixture.mjs';
import { createFilesystemSourceUnit } from '../src/sgos/filesystem-source-unit.mjs';
import { createNamespaceLifecycleCommitter } from '../src/engine-storage/namespace-lifecycle-commit.mjs';
import { SingularityFlowError } from '../src/foundation/failures.mjs';
import { LIFECYCLE_AUTHORITY_KEY } from '../src/engine-storage/namespace-lifecycle-contract.mjs';

const operation='source.bind';
const capture=f=>createNamespaceLifecycleCommitter({records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId,authority:f.authority}).capture();

test('source binding uses the registry and rejects physical roots and claimed observations in input',async t=>{
  const f=await namespaceSourceFixture(t),descriptor=ENGINE_OPERATIONS.find(value=>value.id===operation);
  assert.equal(descriptor.humanDecision,false);assert.equal(descriptor.authority,operation);
  for(const input of [{},{...f.inputs,root:f.root},{...f.inputs,ready:true},{...f.inputs,repositories:[]},
    {...f.inputs,repositories:['app','app']},{...f.inputs,expectedRevision:null},{...f.inputs,reason:' '}]) {
    await assert.rejects(f.engine.run(operation,input),{code:'ENGINE_INPUT_INVALID'});
  }
  assert.equal(f.control.sourceCalls,0);
});
for(const backend of ['filesystem','sqlite','application']) {
  test(`${backend}: actual source binding retains file metadata without opening or approving a generation`,async t=>{
    const f=await namespaceSourceFixture(t,{backend}),before=await capture(f),source=await readFile(path.join(f.root,'src/main.js'));
    const result=await f.engine.run(operation,f.inputs),snapshot=await capture(f),bound=snapshot.workflow.sourceBindings.current;
    assert.equal(result.status,'bound');assert.equal(result.revision,snapshot.revision);assert.notEqual(result.revision,before.revision);
    assert.deepEqual(snapshot.workflow.phases,before.workflow.phases);assert.deepEqual(snapshot.workflow.resolution,before.workflow.resolution);
    assert.equal(snapshot.workflow.execution.status,'unbound');assert.equal(snapshot.workflow.currentPhase,before.workflow.currentPhase);
    assert.equal(result.effects.approvalRecorded,false);assert.equal(result.effects.generationOpened,false);assert.equal(result.effects.sourceFilesChanged,false);
    assert.deepEqual(await readFile(path.join(f.root,'src/main.js')),source);assert.equal(JSON.stringify(snapshot.workflow).includes(f.root),false);
    const manifest=JSON.parse(Buffer.from((await f.content.read(f.scope,result.repositories[0].snapshot)).data));
    assert.equal(manifest.entries[0].path,'src/main.js');assert.equal(bound.repositories[0].revision,result.repositories[0].revision);
    assert.equal(result.repositories[0].provider,'filesystem');
  });
  test(`${backend}: replay acknowledges the original source observation without reading current files or identity`,async t=>{
    const f=await namespaceSourceFixture(t,{backend}),first=await f.engine.run(operation,f.inputs);
    f.control.permissions=[];f.control.sourceHook=()=>{throw Error('cannot authorize a retained observation');};
    await writeFile(path.join(f.root,'src/main.js'),'a later edit');
    assert.deepEqual(await f.make({sources:[]}).run(operation,f.inputs),{...first,replayed:true});
  });
  test(`${backend}: permission revocation preserves the exact pending source intent and timestamp`,async t=>{
    const f=await namespaceSourceFixture(t,{backend});f.control.sourceHook=count=>{if(count===2)f.control.permissions=[];};
    await assert.rejects(f.engine.run(operation,f.inputs),{code:'ENGINE_AUTHORITY_REQUIRED'});assert.equal((await f.head()).record.version,f.story.revision);
    f.control.permissions=['source.bind'];f.control.sourceHook=()=>{};f.control.now='2027-01-01T00:00:00.000Z';
    assert.equal((await f.make().run(operation,f.inputs)).recordedAt,'2026-11-08T00:00:00.000Z');
  });
  test(`${backend}: identical concurrent captures retain one accepted state transition`,async t=>{
    const f=await namespaceSourceFixture(t,{backend});const results=await Promise.all([f.make().run(operation,f.inputs),f.make().run(operation,f.inputs)]);
    assert.equal(results[0].revision,results[1].revision);assert.equal(results.filter(result=>!result.replayed).length,1);
    assert.equal((await capture(f)).workflow.history.filter(event=>event.event==='sources_bound').length,1);
  });
  test(`${backend}: lost source-binding acknowledgement is inspected without rebinding newer source`,async t=>{
    const f=await namespaceSourceFixture(t,{backend});let once=false;
    const failure=new SingularityFlowError('Acknowledgement lost.',{code:'SDA_NAMESPACE_OUTCOME_UNKNOWN',outcomeClass:'OUTCOME_UNKNOWN'});
    const records={...f.records,async transact(scope,transaction,options){const result=await f.records.transact(scope,transaction,options);
      if(transaction.operationId.startsWith('lifecycle-')&&!once){once=true;throw failure;}return result;}};
    await assert.rejects(f.make({records}).run(operation,f.inputs),error=>error===failure);
    await writeFile(path.join(f.root,'src/main.js'),'newer source');assert.equal((await f.make({sources:[]}).run(operation,f.inputs)).replayed,true);
  });
}
test('the final observation detects source changes instead of granting a stale baseline',async t=>{
  const f=await namespaceSourceFixture(t);let changed=false;
  const unit={descriptor:f.unit.descriptor,async capture(options){const snapshot=await f.unit.capture(options);
    if(!changed){changed=true;await writeFile(path.join(f.root,'src/main.js'),'changed after capture');}return snapshot;}};
  await assert.rejects(f.make({sources:[unit]}).run(operation,f.inputs),{code:'ENGINE_SOURCE_CHANGED'});
  assert.equal((await f.head()).record.version,f.story.revision);
  await assert.rejects(f.make().run(operation,f.inputs),{code:'ENGINE_SOURCE_CHANGED'});
  assert.equal((await f.make().run(operation,{...f.inputs,operationId:'bind-updated-source'})).status,'bound');
});
test('later bindings require the current revision, preserve older receipts and support several repositories',async t=>{
  const f=await namespaceSourceFixture(t),first=await f.engine.run(operation,f.inputs),shared=path.join(f.directory,'shared');await mkdir(shared);
  await writeFile(path.join(shared,'api.txt'),'shared contract');
  const unit=await createFilesystemSourceUnit({root:shared,id:'shared-checkout',projectId:f.scope.projectId,repositoryId:'shared'});
  const engine=f.make({sources:[f.unit,unit]});
  await assert.rejects(engine.run(operation,{...f.inputs,operationId:'bind-again',repositories:['app','shared']}),{code:'ENGINE_CONTEXT_CHANGED'});
  const second=await engine.run(operation,{...f.inputs,operationId:'bind-again',repositories:['shared','app'],expectedRevision:first.revision});
  assert.deepEqual(second.repositories.map(repository=>repository.id),['app','shared']);
  assert.deepEqual(await engine.run(operation,f.inputs),{...first,replayed:true});
});
test('takeover can select another checkout without rewriting the Story or older source receipt',async t=>{
  const f=await namespaceSourceFixture(t),first=await f.engine.run(operation,f.inputs),other=path.join(f.directory,'takeover');
  await mkdir(path.join(other,'src'),{recursive:true});await writeFile(path.join(other,'src/main.js'),'a change in the takeover checkout');
  const unit=await createFilesystemSourceUnit({root:other,id:'another-device-checkout',projectId:f.scope.projectId,repositoryId:'app'});
  const result=await f.make({sources:[unit]}).run(operation,{...f.inputs,operationId:'bind-takeover',expectedRevision:first.revision});
  assert.notEqual(result.repositories[0].revision,first.repositories[0].revision);
  const current=await capture(f);assert.equal(current.workflow.workItem.id,f.inputs.workId);
  assert.equal(current.workflow.sourceBindings.origins[0].snapshot.sha256,first.repositories[0].snapshot.sha256);
  assert.equal(current.workflow.sourceBindings.origins[0].operationId,f.inputs.operationId);
  assert.deepEqual(await f.make({sources:[]}).run(operation,f.inputs),{...first,replayed:true});
  assert.equal(JSON.stringify(await capture(f)).includes(other),false);
});
test('a revoked or changed actor and a fenced authority cannot accept pending source metadata',async t=>{
  const f=await namespaceSourceFixture(t);f.control.sourceHook=count=>{if(count===2)f.control.creator.email='other@example.test';};
  await assert.rejects(f.engine.run(operation,f.inputs),{code:'ENGINE_ACTOR_CHANGED'});assert.equal((await f.head()).record.version,f.story.revision);
  let fenced=false;f.control.creator.email='reviewer@example.test';f.control.sourceHook=async()=>{if(fenced)return;fenced=true;
    const a=await f.readAuthority();await f.records.transact(f.scope,{operationId:'fence-source-writer',preconditions:[{namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,version:a.record.version}],
      changes:[{op:'put',namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,immutable:false,value:{...a.record.value,status:'fenced'}}],events:[]});};
  await assert.rejects(f.make().run(operation,f.inputs),{code:'ENGINE_AUTHORITY_FENCED'});
});
test('source calls keep actual failures and unavailable selections instead of inferring another checkout',async t=>{
  const f=await namespaceSourceFixture(t);
  await assert.rejects(f.engine.run(operation,{...f.inputs,repositories:['unknown']}),{code:'ENGINE_SOURCE_UNIT_UNAVAILABLE'});
  const denied=Object.assign(new Error('Source read denied.'),{code:'EACCES',path:'source-checkout'});
  const unit={descriptor:f.unit.descriptor,async capture(){throw denied;}};
  await assert.rejects(f.make({sources:[unit]}).run(operation,f.inputs),error=>error===denied);
  assert.equal((await f.head()).record.version,f.story.revision);
});
test('changed operation inputs and missing retained manifests cannot be hidden by replay',async t=>{
  const f=await namespaceSourceFixture(t),result=await f.engine.run(operation,f.inputs);
  await assert.rejects(f.make().run(operation,{...f.inputs,reason:'Changed request'}),{code:'ENGINE_OPERATION_ID_REUSED'});
  const content={...f.content,async read(scope,ref,options){return ref.sha256===result.repositories[0].snapshot.sha256
    ?{status:'missing',reference:ref,data:null}:f.content.read(scope,ref,options);}};
  await assert.rejects(f.make({content,sources:[]}).run(operation,f.inputs),{code:'ENGINE_STORAGE_CONTENT_MISSING'});
});
test('a head change cannot refresh a prepared baseline into another lifecycle revision',async t=>{
  const f=await namespaceSourceFixture(t);let intervening;
  f.control.sourceHook=async count=>{if(count!==2)return;intervening=await f.make().run(operation,{...f.inputs,operationId:'intervening-binding'});};
  await assert.rejects(f.engine.run(operation,f.inputs),{code:'SDA_NAMESPACE_REVISION_CONFLICT'});
  assert.equal((await f.head()).record.version,intervening.revision);
});
test('late identical acceptance is acknowledged instead of trying to bind an already moved head',async t=>{
  const f=await namespaceSourceFixture(t);let first,injected=false;
  f.control.sourceHook=async()=>{if(injected)return;injected=true;first=await f.make().run(operation,f.inputs);};
  assert.deepEqual(await f.engine.run(operation,f.inputs),{...first,replayed:true});
});
