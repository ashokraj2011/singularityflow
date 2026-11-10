import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {namespaceEngineFixture} from './helpers/namespace-engine-fixture.mjs';
import {configure} from './helpers/namespace-routing-fixture.mjs';
import {createNamespaceStoryObserver} from '../src/engine-storage/namespace-story-reader.mjs';
import {createNamespaceLifecycleCommitter} from '../src/engine-storage/namespace-lifecycle-commit.mjs';
import {namespaceLifecycleStoryKey} from '../src/engine-storage/namespace-lifecycle-reader.mjs';
import {lifecycleRecord,LIFECYCLE_AUTHORITY_KEY} from '../src/engine-storage/namespace-lifecycle-contract.mjs';
import {namespaceStoryGenesisKey} from '../src/engine-storage/namespace-story-codec.mjs';
import {canonicalJson} from '../src/foundation/record-schema.mjs';
import {createFilesystemSourceUnit} from '../src/sgos/filesystem-source-unit.mjs';

// Deliberately corrupt a policy through the low-level storage contract. It grants no business authority.
async function changedPolicy(f,change) {
  const committer=createNamespaceLifecycleCommitter(f.options),snapshot=await committer.capture();change(snapshot.workflow);
  const body=lifecycleRecord('state',{projectId:f.scope.projectId,workId:f.workId,authorityId:f.authority.id,epoch:f.authority.epoch,
    configuration:snapshot.configuration.content,workflow:snapshot.workflow});
  await committer.prepare(snapshot,{operationId:'fixture-policy-drift',operation:'phase.publish',inputsSha256:'0'.repeat(64),state:Buffer.from(canonicalJson(body)),evidence:[]});
  await committer.commit('fixture-policy-drift');return (await f.capture()).revision;
}
for(const backend of ['filesystem','sqlite','application'])test(`${backend}: actual creation policy is readable without another identity, clock or write`,async t=>{
  const f=await namespaceEngineFixture(t,{backend,working:false});await f.bootstrap();
  const expected=await f.capture(),before=f.control.engineCalls;
  const observer=createNamespaceStoryObserver(f.options),captured=await observer.capture();
  const approved=await observer.approved(captured.snapshot);
  assert.deepEqual(captured.snapshot,expected);assert.equal(approved.operationId,'approve-composed');assert.equal(f.control.engineCalls,before);
  const source=await f.engine.run('document.read',{reference:{kind:'story-document',id:'story-source',workId:f.workId}});
  assert.equal(source.document.integrity,'matched');
});

test('a bounded Story proof traversal shares original policy but checks each snapshot and never retains a failure or expired scope',async t=>{
  const f=await namespaceEngineFixture(t,{backend:'filesystem'});await f.bootstrap();await f.author();
  const snapshot=await f.capture(),genesis=namespaceStoryGenesisKey(f.workId),denied=Object.assign(Error('Original genesis permission failure.'),{code:'EACCES'}),
    operationId=(await f.records.read(f.scope,'state',namespaceLifecycleStoryKey(f.workId))).record.value.operationId;
  let originals=0,inspections=0,fail=false,escaped;
  const records={...f.records,async read(scope,namespace,key,options){if(key===genesis){originals++;if(fail)throw denied;}return f.records.read(scope,namespace,key,options);},
      inspectOperation(...args){inspections++;return f.records.inspectOperation(...args);}},
    observer=createNamespaceStoryObserver({...f.options,records});
  await observer.withReadScope(async scoped=>{
    escaped=scoped;await Promise.all([scoped.approved(structuredClone(snapshot)),scoped.approved(structuredClone(snapshot))]);
    assert.equal(originals,1);const proof=await scoped.accepted(operationId),before=inspections;
    assert.strictEqual(await scoped.accepted(operationId),proof);assert.equal(inspections,before,'the same accepted immutable receipt is verified once per traversal');
    const changed=structuredClone(snapshot);changed.workflow.resolution.approvalAuthorities.reviewers.members.push({email:'unapproved@example.test'});
    await assert.rejects(scoped.approved(changed),{code:'ENGINE_STORAGE_CORRUPT'});assert.equal(originals,1,'every different snapshot still checks its policy');
  });
  await assert.rejects(escaped.approved(structuredClone(snapshot)),{code:'ENGINE_INPUT_INVALID'});
  await observer.withReadScope(async scoped=>{fail=true;await assert.rejects(scoped.approved(structuredClone(snapshot)),error=>error===denied);
    fail=false;await scoped.approved(structuredClone(snapshot));});assert.equal(originals,3,'a failed proof does not poison the traversal');
  await observer.withReadScope(scoped=>scoped.approved(structuredClone(snapshot)));assert.equal(originals,4,'another traversal reads the original proof again');
  const controller=new AbortController();controller.abort();
  await assert.rejects(observer.withReadScope(scoped=>scoped.approved(structuredClone(snapshot),{signal:controller.signal})),{code:'ENGINE_OPERATION_CANCELLED'});
  assert.deepEqual(await f.capture(),snapshot);
});

test('genuine creator auto-enrollment is retained rather than replaced with the un-enrolled catalog',async t=>{
  const f=await namespaceEngineFixture(t,{backend:'sqlite',configure(source){source.definition.approvalAuthorities.reviewers.members=[];}});
  await f.bootstrap();const snapshot=await f.capture();
  assert.ok(snapshot.workflow.resolution.approvalAuthorities.reviewers.members.some(item=>item.email==='reviewer@example.test'));
  assert.equal((await f.engine.run('phase.prepare',{phaseId:'intake'})).status,'prepared');
});

test('ordinary Story title and display-label edits do not become a policy amendment',async t=>{
  const f=await namespaceEngineFixture(t,{backend:'sqlite'});await f.bootstrap();
  await changedPolicy(f,w=>{w.workItem.title='A clearer description';w.workItem.workTypeLabel='Translated display label';});
  const source=await f.engine.run('document.read',{reference:{kind:'story-document',id:'story-source',workId:f.workId}});
  assert.equal(source.document.integrity,'matched');assert.equal((await f.engine.run('phase.prepare',{phaseId:'intake'})).status,'prepared');
});

for(const stage of ['prepare','publish','submit','approve','choose','read'])test(stage+': copied policy changes cannot become phase authority',async t=>{
  const f=await namespaceEngineFixture(t,{backend:'sqlite',configure:stage==='choose'?configure('ask'):null});await f.bootstrap();
  let input={phaseId:'intake'},operation='phase.'+stage;
  if(stage==='publish'||stage==='submit') {
    await f.engine.run('phase.prepare',input);const draft=await f.engine.run('phase.draft.read',input);
    const content=(await f.local.content.put(f.scope,'local',Buffer.from('# Actual document\n\nAn authored observable result.\n'))).reference;
    await f.engine.run('phase.draft.write',{operationId:'author-policy-fixture',workId:f.workId,phaseId:'intake',expectedRevision:draft.manifest.draft.revision,
      content,reason:'Retain the authored document.'});
    if(stage==='submit')await f.engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});
    else input={...input,authored:'governed-agent',channel:'copilot-host'};
  }
  if(stage==='approve') {
    await f.author();f.asReviewer();const {manifest}=await f.engine.run('phase.review.resources',input);
    input.confirmation={workId:f.workId,phase:'intake',generation:1,reviewPacketSha256:manifest.reviewBinding.packetSha256};
  }
  if(stage==='choose') {
    await f.author();await f.review();const {manifest}=await f.engine.run('decision.context');operation='decision.choose';
    input={workId:f.workId,expected:manifest.question.key,option:'continue',reason:'The actual human chose the next phase.'};
  }
  if(stage==='read'){operation='document.read';input={reference:{kind:'story-document',id:'story-source',workId:f.workId}};}
  const before=await changedPolicy(f,w=>w.resolution.approvalAuthorities.reviewers.members.push({email:'unreviewed@example.test'}));
  await assert.rejects(f.engine.run(operation,input),error=>error.code==='ENGINE_STORAGE_CORRUPT'&&error.details.profile==='sflow-namespace-story-policy/v1');
  assert.equal((await f.capture()).revision,before);
});

test('missing, future and differently bound genesis records retain explicit failures',async t=>{
  const f=await namespaceEngineFixture(t,{backend:'sqlite',working:false});await f.bootstrap();const key=namespaceStoryGenesisKey(f.workId);
  for(const [expected,alter] of [
    ['ENGINE_LIFECYCLE_RECORD_MISSING',()=>({status:'missing',record:null})],
    ['ENGINE_STORAGE_UNSUPPORTED',r=>({...r,record:{...r.record,value:{...r.record.value,schemaVersion:99}}})],
    ['ENGINE_AUTHORITY_FENCED',r=>({...r,record:{...r.record,value:{...r.record.value,epoch:2}}})],
    ['ENGINE_STORAGE_CORRUPT',r=>({...r,record:{...r.record,version:r.record.version+'-another'}})]
  ]) {
    const records={...f.records,async read(scope,namespace,id,options){const r=await f.records.read(scope,namespace,id,options);return id===key?alter(r):r;}};
    await assert.rejects(f.make({records}).run('decision.context'),{code:expected});
  }
});

test('source binding refuses unapproved policy before reading the selected checkout or retaining observations',async t=>{
  const f=await namespaceEngineFixture(t,{backend:'sqlite'});await f.bootstrap();
  const root=path.join(f.directory,'source');await mkdir(root);await writeFile(path.join(root,'app.mjs'),'export const result = 42;\n');
  const unit=await createFilesystemSourceUnit({root,id:'policy-source',projectId:f.scope.projectId,repositoryId:'app'});let calls=0;
  const engine=f.make({sources:[{descriptor:unit.descriptor,capture(...args){calls++;return unit.capture(...args);}}]});
  const revision=await changedPolicy(f,w=>w.phases.intake.writeScope='source-and-artifact');
  await assert.rejects(engine.run('source.bind',{operationId:'bind-unapproved-source',workId:f.workId,expectedRevision:revision,
    repositories:['app'],reason:'Bind the selected checkout.'}),error=>error.code==='ENGINE_STORAGE_CORRUPT'&&error.details.profile==='sflow-namespace-story-policy/v1');
  assert.equal(calls,0);assert.equal((await f.capture()).revision,revision);
});

test('real receipt, source, state and metadata errors preserve the original timeout or permission object',async t=>{
  const f=await namespaceEngineFixture(t,{backend:'sqlite',working:false});const {creationInput}=await f.bootstrap();
  const failed=Object.assign(new Error('The application journal could not respond.'),{code:'ETIMEDOUT',timedOut:true,syscall:'read',path:'application-journal',details:{deadlineMs:1234}});
  for(const options of [
    {records:{...f.records,inspectOperation(){throw failed;}}},
    {records:{...f.records,read(scope,namespace,id,options){if(id===namespaceStoryGenesisKey(f.workId))throw failed;return f.records.read(scope,namespace,id,options);}}},
    {content:{...f.content,read(scope,reference,options){if(reference.sha256===creationInput.source.sha256)throw failed;return f.content.read(scope,reference,options);}}}
  ])await assert.rejects(f.make(options).run('decision.context'),error=>error===failed);
});

test('genesis proof requires the actual original intent, manifest and both accepted receipts',async t=>{
  const f=await namespaceEngineFixture(t,{backend:'sqlite',working:false});await f.bootstrap();
  const cases=[
    ['ENGINE_STORAGE_CORRUPT',(id,r)=>id.startsWith('stories/prepared/')?{...r,record:{...r.record,value:{...r.record.value,parametersSha256:'0'.repeat(64)}}}:r],
    ['ENGINE_STORAGE_CORRUPT',(id,r)=>id.startsWith('stories/creations/')?{...r,record:{...r.record,value:{...r.record.value,title:'Unreviewed intent'}}}:r]
  ];
  for(const [code,alter] of cases) {
    const records={...f.records,async read(scope,namespace,id,options){return alter(id,await f.records.read(scope,namespace,id,options));}};
    await assert.rejects(f.make({records}).run('decision.context'),{code});
  }
  for(const prefix of ['story-prepare-','story-create-']) {
    const records={...f.records,async inspectOperation(scope,id,options){const r=await f.records.inspectOperation(scope,id,options);
      return id.startsWith(prefix)?{...r,receipt:{...r.receipt,requestDigest:'0'.repeat(64)}}:r;}};
    await assert.rejects(f.make({records}).run('decision.context'),{code:'ENGINE_PORT_RESULT_INVALID'});
  }
});

test('historical states and reused snapshot objects are checked against the original policy on every admission',async t=>{
  const f=await namespaceEngineFixture(t,{backend:'sqlite',working:false});await f.bootstrap();
  const observer=createNamespaceStoryObserver(f.options),captured=await observer.capture();
  await observer.approved(captured.snapshot);
  captured.snapshot.workflow.phases.intake.approvalPolicy.minimum=0;
  await assert.rejects(observer.approved(captured.snapshot),{code:'ENGINE_STORAGE_CORRUPT'});
  const current=await createNamespaceLifecycleCommitter(f.options).capture(),head=(await f.records.read(f.scope,'state',namespaceLifecycleStoryKey(f.workId))).record.value;
  const body=lifecycleRecord('state',{projectId:f.scope.projectId,workId:f.workId,authorityId:f.authority.id,epoch:f.authority.epoch,
    configuration:current.configuration.content,workflow:current.workflow});
  body.workflow.resolution.approvalAuthorities.reviewers.members.push({email:'unreviewed@example.test'});
  await assert.rejects(observer.state(Buffer.from(canonicalJson(body)),head),{code:'ENGINE_STORAGE_CORRUPT'});
});

test('a head change during original-policy traversal preserves the new state and asks for a fresh basis',async t=>{
  const f=await namespaceEngineFixture(t,{backend:'sqlite',working:false});await f.bootstrap();let changed=false;
  const records={...f.records,async inspectOperation(...args){const result=await f.records.inspectOperation(...args);
    if(!changed&&args[1].startsWith('story-create-')) {changed=true;const committer=createNamespaceLifecycleCommitter(f.options),snapshot=await committer.capture();
      const body=lifecycleRecord('state',{projectId:f.scope.projectId,workId:f.workId,authorityId:f.authority.id,epoch:f.authority.epoch,
        configuration:snapshot.configuration.content,workflow:snapshot.workflow});
      await committer.prepare(snapshot,{operationId:'move-during-proof',operation:'phase.publish',inputsSha256:'0'.repeat(64),state:Buffer.from(canonicalJson(body)),evidence:[]});
      await committer.commit('move-during-proof');}
    return result;}};
  await assert.rejects(f.make({records}).run('decision.context'),{code:'ENGINE_CONTEXT_CHANGED'});assert.equal(changed,true);
  assert.equal((await f.engine.run('decision.context')).manifest.question,null);
});

test('same-epoch fencing still permits historical proof inspection and refuses new authoring',async t=>{
  const f=await namespaceEngineFixture(t,{backend:'sqlite'});await f.bootstrap();await f.author();const approved=await f.review();
  const a=await f.readAuthority();await f.records.transact(f.scope,{operationId:'fence-policy-fixture',preconditions:[{namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,version:a.record.version}],
    changes:[{op:'put',namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,immutable:false,value:{...a.record.value,status:'fenced'}}],events:[]});
  assert.deepEqual(await f.make({working:null,clock:{now(){throw Error('No new timestamp.');}}}).run('phase.approve',
    {phaseId:'intake',confirmation:approved.confirmation}),approved.result);
  await assert.rejects(f.engine.run('phase.prepare',{phaseId:'intake'}),{code:'ENGINE_AUTHORITY_FENCED'});
});

test('passive clients verify frozen v1 creation inputs with the same enrolled origin and preserve writer fencing',async t=>{
  const f=await namespaceEngineFixture(t,{backend:'sqlite'});await f.bootstrap();const snapshot=await f.capture();
  const records={...f.records,descriptor:{...f.records.descriptor,id:'read-only-record-client'}},
    content={...f.content,descriptor:{...f.content.descriptor,id:'read-only-content-client'}};
  const observer=createNamespaceStoryObserver({...f.options,records,content});
  assert.equal((await observer.approved(snapshot)).operationId,'approve-composed');
  await assert.rejects(observer.inspect(),{code:'ENGINE_AUTHORITY_FENCED'});
  const before=(await f.capture()).revision;
  await assert.rejects(f.make({records,content}).run('phase.prepare',{phaseId:'intake'}),{code:'ENGINE_AUTHORITY_FENCED'});
  assert.equal((await f.capture()).revision,before);
  const authority=await f.readAuthority();await f.records.transact(f.scope,{operationId:'fence-passive-origin',
    preconditions:[{namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,version:authority.record.version}],
    changes:[{op:'put',namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,immutable:false,value:{...authority.record.value,status:'fenced'}}],events:[]});
  assert.equal((await createNamespaceStoryObserver({...f.options,records,content}).approved(snapshot)).operationId,'approve-composed');
});

test('a passive client cannot substitute another origin, epoch or creation digest',async t=>{
  const f=await namespaceEngineFixture(t,{backend:'sqlite',working:false});await f.bootstrap();const snapshot=await f.capture();
  for(const change of [
    value=>({...value,recordsId:'unverified-store'}),
    value=>({...value,contentId:'unverified-content'}),
    value=>({...value,authorityId:'another-authority'}),
    value=>({...value,epoch:value.epoch+1})
  ]) {
    const records={...f.records,descriptor:{...f.records.descriptor,id:'passive-client'},async read(scope,namespace,key,options){
      const result=await f.records.read(scope,namespace,key,options);
      return key===LIFECYCLE_AUTHORITY_KEY?{...result,record:{...result.record,value:change(result.record.value)}}:result;
    }};
    await assert.rejects(createNamespaceStoryObserver({...f.options,records}).approved(snapshot),{code:'ENGINE_STORAGE_CORRUPT'});
  }
  const records={...f.records,descriptor:{...f.records.descriptor,id:'passive-client'},async read(scope,namespace,key,options){
    const result=await f.records.read(scope,namespace,key,options);
    return key.startsWith('stories/prepared/')?{...result,record:{...result.record,value:{...result.record.value,parametersSha256:'0'.repeat(64)}}}:result;
  }};
  await assert.rejects(createNamespaceStoryObserver({...f.options,records}).approved(snapshot),{code:'ENGINE_STORAGE_CORRUPT'});
});

test('origin lookup preserves an actual timeout and is unnecessary for the original v1 client',async t=>{
  const f=await namespaceEngineFixture(t,{backend:'sqlite',working:false});await f.bootstrap();const snapshot=await f.capture();
  const failure=Object.assign(new Error('Origin authority could not be read.'),{code:'ETIMEDOUT',timedOut:true,details:{deadlineMs:4321}});
  const unavailable={...f.records,read(scope,namespace,key,options){if(key===LIFECYCLE_AUTHORITY_KEY)throw failure;return f.records.read(scope,namespace,key,options);}};
  await assert.doesNotReject(createNamespaceStoryObserver({...f.options,records:unavailable}).approved(snapshot));
  const passive={...unavailable,descriptor:{...unavailable.descriptor,id:'passive-client'}};
  await assert.rejects(createNamespaceStoryObserver({...f.options,records:passive}).approved(snapshot),error=>error===failure);
});
