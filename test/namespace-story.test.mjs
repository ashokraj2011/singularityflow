import test from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE_OPERATIONS } from '../src/engine-sdk/index.mjs';
import { namespaceStoryFixture } from './helpers/namespace-story-fixture.mjs';
import { createNamespaceLifecycleCommitter } from '../src/engine-storage/namespace-lifecycle-commit.mjs';
import { createNamespaceReadEngine } from '../src/engine-storage/namespace-reader.mjs';
import { namespaceStoryGenesisKey } from '../src/engine-storage/namespace-story.mjs';
import { LIFECYCLE_AUTHORITY_KEY } from '../src/engine-storage/namespace-lifecycle-contract.mjs';
import { SingularityFlowError } from '../src/foundation/failures.mjs';
import { seededNamespaceConfiguration } from './helpers/namespace-seeded-configuration.mjs';
import { assertWorkTypeStartable } from '../src/config.mjs';
import { assertApprovalPolicyAttainable,enrollPinnedApprovalIdentity,normalizeApprovalSecurity } from '../src/kernel/approval-policy.mjs';
import { namespaceLifecycleStoryKey } from '../src/engine-storage/namespace-lifecycle-reader.mjs';

const operation='story.create';
const capture=f=>createNamespaceLifecycleCommitter({records:f.records,content:f.content,scope:f.scope,authority:f.authority,workId:f.inputs.workId}).capture();

test('Story creation is a registered operation with no caller-supplied identity, branches or approval shortcut',async t=>{
  const f=await namespaceStoryFixture(t),d=ENGINE_OPERATIONS.find(item=>item.id===operation);
  assert.equal(d.subject,'story');assert.equal(d.humanDecision,false);assert.equal(d.authority,operation);
  for(const input of [{},{...f.inputs,principalId:'owner'},{...f.inputs,branch:'main'},{...f.inputs,ready:true},
    {...f.inputs,source:{path:'/tmp/story.md'}},{...f.inputs,source:{...f.inputs.source,namespace:'local'}},
    {...f.inputs,title:' '},{...f.inputs,workId:'../another'}])await assert.rejects(f.engine.run(operation,input),{code:'ENGINE_INPUT_INVALID'});
  await assert.rejects(f.configurationEngine.run(operation,f.inputs),{code:'ENGINE_PORT_UNAVAILABLE'});
  assert.equal((await f.head()).status,'missing');assert.equal(f.control.storyCalls,0);
});

for(const backend of ['filesystem','sqlite','application']) {
  test(`${backend}: create from actual approved configuration, reopen the canonical head and read the exact source`,async t=>{
    const f=await namespaceStoryFixture(t,{backend}),result=await f.engine.run(operation,f.inputs),snapshot=await capture(f);
    assert.equal(result.status,'created');assert.equal(result.currentPhase,'intake');assert.equal(result.generation,0);
    assert.equal(result.revision,snapshot.revision);assert.equal(result.replayed,false);
    assert.deepEqual(result.effects,{committed:true,pushed:false,storyCreated:true,configurationApproved:false,humanReviewRecorded:false,approvalRecorded:false});
    assert.equal(snapshot.workflow.workItem.branch,null);assert.equal(snapshot.workflow.workItem.baseBranch,null);
    assert.equal(snapshot.workflow.execution.status,'unbound');assert.equal(snapshot.workflow.phases.intake.generation,0);
    assert.deepEqual(snapshot.workflow.phases.intake.checks,[]);assert.deepEqual(snapshot.workflow.phases.intake.approvals,[]);
    assert.equal(snapshot.configuration.content.sha256,f.approval.configuration.sha256);
    const reader=createNamespaceReadEngine({records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId});
    const document=await reader.run('document.read',{reference:result.source});
    assert.equal(document.document.content.text,'# Story\n\nAdd a converter and retain boundary tests.\n');
    assert.equal(document.document.expected.sha256,f.inputs.source.sha256);
    assert.equal((await f.records.read(f.scope,'state',namespaceStoryGenesisKey(f.inputs.workId))).record.immutable,true);
    assert.equal((await f.list('evidence')).entries.filter(item=>item.key.startsWith('stories/creations/')).length,1);
  });
  test(`${backend}: accepted retry returns its original creation receipt without restamping or new authorization`,async t=>{
    const f=await namespaceStoryFixture(t,{backend}),first=await f.engine.run(operation,f.inputs),calls=f.control.storyCalls;
    f.control.permissions=[];f.control.now='2027-01-01T00:00:00.000Z';f.control.storyHook=()=>{throw Error('already committed');};
    assert.deepEqual(await f.make().run(operation,f.inputs),{...first,replayed:true});assert.equal(f.control.storyCalls,calls);
  });
  test(`${backend}: concurrent same-intent creation produces one Story and one shared receipt`,async t=>{
    const f=await namespaceStoryFixture(t,{backend});
    const results=await Promise.all([f.make().run(operation,f.inputs),f.make().run(operation,f.inputs)]);
    assert.equal(results[0].revision,results[1].revision);assert.equal(results.filter(item=>!item.replayed).length,1);
    assert.equal((await f.list('evidence')).entries.filter(item=>item.key.startsWith('stories/creations/')).length,1);
  });
  test(`${backend}: revoked permission leaves a resumable intent and no Story`,async t=>{
    const f=await namespaceStoryFixture(t,{backend});f.control.storyHook=n=>{if(n===2)f.control.permissions=[];};
    await assert.rejects(f.engine.run(operation,f.inputs),{code:'ENGINE_AUTHORITY_REQUIRED'});assert.equal((await f.head()).status,'missing');
    f.control.storyHook=()=>{};f.control.permissions=['story.create'];f.control.now='2027-01-01T00:00:00.000Z';
    const result=await f.make().run(operation,f.inputs);assert.equal(result.recordedAt,'2026-11-08T00:00:00.000Z');
  });
  test(`${backend}: lost commit acknowledgement is inspected using the same operation ID`,async t=>{
    const f=await namespaceStoryFixture(t,{backend});let once=false;
    const failure=new SingularityFlowError('Acknowledgement lost.',{code:'SDA_NAMESPACE_OUTCOME_UNKNOWN',outcomeClass:'OUTCOME_UNKNOWN'});
    const records={...f.records,async transact(scope,tx,options){const result=await f.records.transact(scope,tx,options);
      if(tx.operationId.startsWith('story-create-')&&!once){once=true;throw failure;}return result;}};
    await assert.rejects(f.make({records}).run(operation,f.inputs),error=>error===failure);
    const original=await f.head(),replayed=await f.make().run(operation,f.inputs);
    assert.equal(replayed.replayed,true);assert.equal(replayed.revision,original.record.version);
  });
  test(`${backend}: lost preparation acknowledgement resumes the original actor and time`,async t=>{
    const f=await namespaceStoryFixture(t,{backend});let once=false;
    const failure=new SingularityFlowError('Preparation acknowledgement lost.',{code:'SDA_NAMESPACE_OUTCOME_UNKNOWN',outcomeClass:'OUTCOME_UNKNOWN'});
    const records={...f.records,async transact(scope,tx,options){const result=await f.records.transact(scope,tx,options);
      if(tx.operationId.startsWith('story-prepare-')&&!once){once=true;throw failure;}return result;}};
    await assert.rejects(f.make({records}).run(operation,f.inputs),error=>error===failure);assert.equal((await f.head()).status,'missing');
    f.control.now='2027-01-01T00:00:00.000Z';const created=await f.make().run(operation,f.inputs);
    assert.equal(created.recordedAt,'2026-11-08T00:00:00.000Z');
  });
}

test('unapproved configuration is not substituted with the current configuration or an invented snapshot',async t=>{
  const f=await namespaceStoryFixture(t,{approve:false});await assert.rejects(f.engine.run(operation,f.inputs),{code:'ENGINE_CONFIGURATION_NOT_APPROVED'});
  assert.equal((await f.head()).status,'missing');
});
test('only an own declared workflow may be selected, including names inherited from Object',async t=>{
  const f=await namespaceStoryFixture(t);
  for(const workTypeId of ['unknown-workflow','constructor','toString'])await assert.rejects(f.engine.run(operation,{...f.inputs,workTypeId}),{code:'ENGINE_WORKFLOW_UNAVAILABLE'});
  assert.equal((await f.head()).status,'missing');
});
test('duplicate Story IDs and changed request parameters cannot overwrite retained work',async t=>{
  const f=await namespaceStoryFixture(t),first=await f.engine.run(operation,f.inputs);
  await assert.rejects(f.make().run(operation,{...f.inputs,operationId:'create-again'}),{code:'ENGINE_STORY_EXISTS'});
  await assert.rejects(f.make().run(operation,{...f.inputs,title:'Different'}),{code:'ENGINE_OPERATION_ID_REUSED'});
  assert.equal((await f.head()).record.version,first.revision);
});
test('genesis prevents ID reuse even if the mutable Story head is removed',async t=>{
  const f=await namespaceStoryFixture(t);await f.engine.run(operation,f.inputs);const head=await f.head();
  await f.records.transact(f.scope,{operationId:'simulate-lost-head',preconditions:[{namespace:'state',key:head.record.key,version:head.record.version}],
    changes:[{op:'delete',namespace:'state',key:head.record.key}],events:[]});
  await assert.rejects(f.make().run(operation,{...f.inputs,operationId:'recreate-deleted-head'}),{code:'ENGINE_STORY_EXISTS'});
});
test('actor identity cannot change across a prepared creation',async t=>{
  const f=await namespaceStoryFixture(t);f.control.storyHook=n=>{if(n===2)f.control.creator.email='someone-else@example.test';};
  await assert.rejects(f.engine.run(operation,f.inputs),{code:'ENGINE_ACTOR_CHANGED'});assert.equal((await f.head()).status,'missing');
});
test('a changed or fenced project authority cannot accept a prepared Story',async t=>{
  const f=await namespaceStoryFixture(t);f.control.storyHook=async n=>{if(n!==2)return;const a=await f.readAuthority();
    await f.records.transact(f.scope,{operationId:'fence-story-authority',preconditions:[{namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,version:a.record.version}],
      changes:[{op:'put',namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,immutable:false,value:{...a.record.value,status:'fenced'}}],events:[]});};
  await assert.rejects(f.engine.run(operation,f.inputs),{code:'ENGINE_AUTHORITY_FENCED'});assert.equal((await f.head()).status,'missing');
});

test('a later configuration approval cannot reinterpret an already prepared Story',async t=>{
  const f=await namespaceStoryFixture(t);let changed;
  f.control.storyHook=async n=>{if(n!==2)return;const source=structuredClone(f.configurationSource);
    source.definition.phases.intake.label='A later intake';const ref=await f.store(source);
    changed=await f.configurationEngine.run('configuration.approve',{...f.configurationInputs,operationId:'configuration-2',source:ref,
      confirm:ref.sha256,expectedRevision:f.approval.revision});};
  await f.engine.run(operation,f.inputs);const snapshot=await capture(f);
  assert.notEqual(changed.configuration.sha256,snapshot.configuration.content.sha256);
  assert.equal(snapshot.configuration.content.sha256,f.approval.configuration.sha256);
  assert.equal(snapshot.workflow.phases.intake.label,'Intake');
});

test('read hosts follow the canonical lifecycle head after a later accepted transition',async t=>{
  const f=await namespaceStoryFixture(t),created=await f.engine.run(operation,f.inputs);
  const committer=createNamespaceLifecycleCommitter({records:f.records,content:f.content,scope:f.scope,authority:f.authority,workId:f.inputs.workId});
  const snapshot=await committer.capture();snapshot.workflow.phases.intake.generation=1;
  const head=await f.head(),old=await f.content.read(f.scope,head.record.value.state),state=JSON.parse(Buffer.from(old.data));
  state.workflow=snapshot.workflow;
  const plan=await committer.prepare(snapshot,{operationId:'fixture-admitted-transition',operation:'phase.publish',inputsSha256:'0'.repeat(64),state:Buffer.from(JSON.stringify(state)+'\n'),evidence:[]});
  const accepted=await committer.commit(plan.operationId);
  const result=await f.make().run('phase.review',{phaseId:'intake'});
  assert.equal(result.manifest.generation,1);
  assert.equal(result.manifest.observedRevision,(await f.head()).record.version);
  assert.notEqual(result.manifest.observedRevision,created.revision);
  assert.equal((await f.make().run('document.read',{reference:created.source})).document.expected.sha256,f.inputs.source.sha256);
  assert.ok(accepted);
});

test('Story genesis cannot be smuggled into the existing-Story transition writer',async t=>{
  const f=await namespaceStoryFixture(t);await f.engine.run(operation,f.inputs);
  const committer=createNamespaceLifecycleCommitter({records:f.records,content:f.content,scope:f.scope,authority:f.authority,workId:f.inputs.workId});
  await assert.rejects(committer.prepare(await committer.capture(),{operationId:'bypass-genesis',operation,inputsSha256:'0'.repeat(64),state:Buffer.from('{}'),evidence:[]}),{code:'ENGINE_INPUT_INVALID'});
});

test('a missing source, invalid UTF-8 and source read permissions never become an accepted Story',async t=>{
  for(const bytes of [Buffer.from([0xff]),Buffer.from('   '),Buffer.from('text\0more')]) {
    const f=await namespaceStoryFixture(t),source=(await f.content.put(f.scope,'state',bytes)).reference;
    await assert.rejects(f.engine.run(operation,{...f.inputs,source}),{code:'ENGINE_SOURCE_INVALID'});assert.equal((await f.head()).status,'missing');
  }
  const f=await namespaceStoryFixture(t),source={...f.inputs.source,sha256:'f'.repeat(64)};
  await assert.rejects(f.engine.run(operation,{...f.inputs,source}),{code:'ENGINE_STORAGE_CONTENT_MISSING'});
  const denied=Object.assign(new Error('Source read denied.'),{code:'EACCES',path:'application-content'});
  const content={...f.content,async read(scope,ref,options){if(ref.sha256===f.inputs.source.sha256)throw denied;return f.content.read(scope,ref,options);}};
  await assert.rejects(f.make({content}).run(operation,f.inputs),error=>error===denied);
});

test('a service may create a Story, without impersonating human review or enrollment',async t=>{
  const f=await namespaceStoryFixture(t);f.control.actorKind='service';f.control.creator={name:'Build service',email:'build@example.test',login:null};
  const created=await f.engine.run(operation,f.inputs),snapshot=await capture(f);
  assert.equal(created.effects.approvalRecorded,false);assert.equal(snapshot.workflow.workItem.createdBy.actorKind,'service');
  assert.equal(Object.values(snapshot.workflow.resolution.approvalAuthorities).some(group=>group.members.some(member=>member.email==='build@example.test')),false);
});

test('cancellation after acceptance acknowledges the real receipt while cancellation before acceptance preserves the draft',async t=>{
  const f=await namespaceStoryFixture(t),controller=new AbortController();
  f.control.storyHook=n=>{if(n===2)controller.abort();};
  await assert.rejects(f.engine.run(operation,f.inputs,{signal:controller.signal}),{code:'ENGINE_OPERATION_CANCELLED'});assert.equal((await f.head()).status,'missing');
  f.control.storyHook=()=>{};const after=new AbortController();
  const records={...f.records,async transact(scope,tx,options){const result=await f.records.transact(scope,tx,options);if(tx.operationId.startsWith('story-create-'))after.abort();return result;}};
  assert.equal((await f.make({records}).run(operation,f.inputs,{signal:after.signal})).status,'created');
});

test('replacing host methods cannot redirect an already constructed creation and read engine',async t=>{
  const f=await namespaceStoryFixture(t),records={...f.records},content={...f.content},engine=f.make({records,content});
  const created=await engine.run(operation,f.inputs);
  records.read=()=>{throw Error('redirected metadata');};content.read=()=>{throw Error('redirected content');};
  assert.equal((await engine.run('document.read',{reference:created.source})).document.expected.sha256,f.inputs.source.sha256);
  assert.equal((await engine.run(operation,f.inputs)).replayed,true);
});

test('every shipped workflow retains native start admission and its actual pinned phase contract',async t=>{
  const f=await namespaceStoryFixture(t),seeded=await seededNamespaceConfiguration(f),reference=await f.store(seeded.source);
  const approval=await f.configurationEngine.run('configuration.approve',{...f.configurationInputs,operationId:'seeded-configuration',
    source:reference,confirm:reference.sha256,expectedRevision:f.approval.revision});
  const compiled=JSON.parse(Buffer.from((await f.content.read(f.scope,approval.configuration)).data));
  let checked=0,created=0;
  for(const [workTypeId,expected] of Object.entries(seeded.expected)) {
    const workId=`shipped-${++checked}`,inputs={...f.inputs,workId,workTypeId,configurationId:'seeded-configuration',operationId:`create-${workId}`};
    let blocked;
    try {
      assertWorkTypeStartable(expected);
      const groups=structuredClone(expected.approvalAuthorities);
      if(normalizeApprovalSecurity(seeded.source.definition.approvalSecurity??{}).autoEnrollNewIdentities)enrollPinnedApprovalIdentity(groups,f.control.creator);
      for(const phase of expected.phases)assertApprovalPolicyAttainable(groups,phase.approval,phase.id,{creator:f.control.creator});
    }catch(error){blocked=error;}
    if(blocked) {
      await assert.rejects(f.make({workId}).run(operation,inputs),error=>error.code===blocked.code
        ||blocked.code==='WORKFLOW_OBLIGATIONS_UNMET'&&error.details?.findings?.length>0);
      assert.equal((await f.records.read(f.scope,'state',namespaceLifecycleStoryKey(workId))).status,'missing');
    }else {
      const result=await f.make({workId}).run(operation,inputs);created++;
      const committer=createNamespaceLifecycleCommitter({records:f.records,content:f.content,scope:f.scope,authority:f.authority,workId});
      const snapshot=await committer.capture();
      assert.deepEqual(snapshot.workflow.resolution.phases,compiled.workflows[workTypeId].phases);
      assert.equal(result.currentPhase,expected.phases[0].id);
      assert.equal(snapshot.workflow.resolution.configurationApprovalId,'seeded-configuration');
      assert.equal(snapshot.configuration.content.sha256,approval.configuration.sha256);
      const source=await f.make({workId}).run('document.read',{reference:result.source});
      assert.equal(source.document.integrity,'matched');assert.equal(source.document.expected.sha256,inputs.source.sha256);
    }
  }
  assert.equal(checked,18);assert.ok(created>0);
});

test('unsupported prepared schemas retain their exact cause and never become a new creation',async t=>{
  const f=await namespaceStoryFixture(t);f.control.storyHook=n=>{if(n===2)f.control.permissions=[];};
  await assert.rejects(f.engine.run(operation,f.inputs),{code:'ENGINE_AUTHORITY_REQUIRED'});
  f.control.permissions=['story.create'];f.control.storyHook=()=>{};
  const records={...f.records,async read(...args){const result=await f.records.read(...args);
    return result.record?.value?.format==='sflow-namespace-story-intent/v1'?{...result,record:{...result.record,value:{...result.record.value,schemaVersion:99}}}:result;}};
  await assert.rejects(f.make({records}).run(operation,f.inputs),error=>error.code==='ENGINE_STORAGE_UNSUPPORTED'&&error.cause?.code==='SCHEMA_VERSION_FUTURE');
  assert.equal((await f.head()).status,'missing');assert.equal((await f.make().run(operation,f.inputs)).status,'created');
});

test('a malformed acceptance receipt does not erase the original creation or permit a duplicate',async t=>{
  const f=await namespaceStoryFixture(t);
  const records={...f.records,async transact(scope,tx,options){const result=await f.records.transact(scope,tx,options);
    return tx.operationId.startsWith('story-create-')?{...result,receipt:{...result.receipt,requestDigest:'0'.repeat(64)}}:result;}};
  await assert.rejects(f.make({records}).run(operation,f.inputs),{code:'ENGINE_PORT_RESULT_INVALID'});
  assert.equal((await f.head()).status,'present');assert.equal((await f.make().run(operation,f.inputs)).replayed,true);
  assert.equal((await f.list('evidence')).entries.filter(item=>item.key.startsWith('stories/creations/')).length,1);
});

test('the accepting transaction catches an authority change after the final fresh read',async t=>{
  const f=await namespaceStoryFixture(t);let changed=false;
  const records={...f.records,async transact(scope,tx,options){
    if(tx.operationId.startsWith('story-create-')&&!changed){changed=true;const a=await f.readAuthority();
      await f.records.transact(scope,{operationId:'fence-after-last-read',preconditions:[{namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,version:a.record.version}],
        changes:[{op:'put',namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,immutable:false,value:{...a.record.value,status:'fenced'}}],events:[]});}
    return f.records.transact(scope,tx,options);}};
  await assert.rejects(f.make({records}).run(operation,f.inputs),{code:'SDA_NAMESPACE_REVISION_CONFLICT'});
  assert.equal((await f.head()).status,'missing');
});

test('malformed creator facts are a port error while an actual authentication failure retains its cause',async t=>{
  const f=await namespaceStoryFixture(t);
  await assert.rejects(f.make({access:{current:()=>({projectId:f.scope.projectId,identity:{name:()=> 'not JSON'}})}}).run(operation,f.inputs),
    error=>error.code==='ENGINE_PORT_RESULT_INVALID'&&error.cause?.code==='SDA_NAMESPACE_INPUT_INVALID');
  const failure=Object.assign(new Error('Authentication provider unavailable.'),{code:'EACCES'});
  await assert.rejects(f.make({access:{current:()=>{throw failure;}}}).run(operation,f.inputs),error=>error===failure);
  assert.equal((await f.head()).status,'missing');
});
