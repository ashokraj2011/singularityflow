import test from 'node:test';
import assert from 'node:assert/strict';
import {namespaceLifecycleFixture} from './helpers/namespace-lifecycle-fixture.mjs';
import {commitNamespaceOperation} from '../src/engine-storage/namespace-commit-coordination.mjs';
for(const backend of ['filesystem','sqlite','application'])test(backend+': a validation race acknowledges only the actually committed original operation',async t=>{
  const f=await namespaceLifecycleFixture(t,{backend}),snapshot=await f.committer.capture();
  await f.committer.prepare(snapshot,f.proposal(snapshot.workflow));let validations=0;
  const moved=Object.assign(new Error('The head moved during policy proof.'),{code:'ENGINE_CONTEXT_CHANGED'});
  let original;
  const result=await commitNamespaceOperation(f.committer,'publish-1',async()=>{validations++;original=await f.make().commit('publish-1');throw moved;});
  assert.deepEqual(result.receipt,original.receipt);assert.equal(validations,1);assert.equal((await f.committer.capture()).revision,
    original.receipt.records.find(record=>record.namespace==='state').version);
  assert.deepEqual((await commitNamespaceOperation(f.committer,'publish-1',()=>{throw Error('Do not repeat admission.');})).receipt,original.receipt);
});
test('a changed context without acceptance preserves the original error and candidate',async t=>{
  const f=await namespaceLifecycleFixture(t,{backend:'sqlite'}),snapshot=await f.committer.capture();await f.committer.prepare(snapshot,f.proposal(snapshot.workflow));
  await f.committer.prepare(snapshot,f.proposal(snapshot.workflow,'another-operation'));
  const moved=Object.assign(new Error('Another operation changed the Story.'),{code:'ENGINE_CONTEXT_CHANGED',details:{workId:f.workId}});
  await assert.rejects(commitNamespaceOperation(f.committer,'publish-1',async()=>{await f.make().commit('another-operation');throw moved;}),error=>error===moved);
  assert.equal((await f.committer.inspect('publish-1')).status,'prepared');
});
for(const code of ['ETIMEDOUT','EACCES','ENGINE_AUTHORITY_REQUIRED','ENGINE_ACTOR_CHANGED','ENGINE_STORAGE_CORRUPT'])test(code+': receipt reconciliation cannot hide a real validation failure',async t=>{
  const f=await namespaceLifecycleFixture(t,{backend:'sqlite'}),snapshot=await f.committer.capture();await f.committer.prepare(snapshot,f.proposal(snapshot.workflow));
  const failure=Object.assign(new Error('Original validation failure.'),{code,details:{deadlineMs:1234}});
  await assert.rejects(commitNamespaceOperation(f.committer,'publish-1',async()=>{await f.make().commit('publish-1');throw failure;}),error=>error===failure);
  assert.equal((await f.committer.inspect('publish-1')).status,'committed');
});
test('a context change at the commit boundary recovers the actual accepted receipt',async t=>{
  const f=await namespaceLifecycleFixture(t,{backend:'sqlite'}),snapshot=await f.committer.capture();await f.committer.prepare(snapshot,f.proposal(snapshot.workflow));
  const moved=Object.assign(new Error('The acceptance was discovered at the commit boundary.'),{code:'ENGINE_CONTEXT_CHANGED'});let original;
  const committer={...f.committer,async commit(id,options){original=await f.make().commit(id,options);throw moved;}};
  assert.deepEqual((await commitNamespaceOperation(committer,'publish-1',()=>{})).receipt,original.receipt);
});
test('a real reconciliation read failure is preserved instead of claiming acceptance',async t=>{
  const f=await namespaceLifecycleFixture(t,{backend:'sqlite'}),snapshot=await f.committer.capture();await f.committer.prepare(snapshot,f.proposal(snapshot.workflow));
  const failure=Object.assign(new Error('Receipt inspection timed out.'),{code:'ETIMEDOUT',timedOut:true,details:{deadlineMs:1234}});let reads=0;
  const committer={...f.committer,inspect(...args){if(++reads===2)throw failure;return f.committer.inspect(...args);}};
  await assert.rejects(commitNamespaceOperation(committer,'publish-1',async()=>{
    await f.make().commit('publish-1');throw Object.assign(new Error('Changed context.'),{code:'ENGINE_CONTEXT_CHANGED'});
  }),error=>error===failure);
});
