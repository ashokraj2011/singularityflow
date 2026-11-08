import test from 'node:test';
import assert from 'node:assert/strict';
import {namespacePreparationFixture} from './helpers/namespace-preparation-fixture.mjs';
import {createNamespacePublicationEngine} from '../src/engine-storage/namespace-publication.mjs';
import {createNamespaceSubmissionEngine} from '../src/engine-storage/namespace-submission.mjs';
import {createNamespaceReadEngine} from '../src/engine-storage/namespace-reader.mjs';
import {createNamespaceLifecycleObserver} from '../src/engine-storage/namespace-lifecycle-reader.mjs';
import {LIFECYCLE_AUTHORITY_KEY} from '../src/engine-storage/namespace-lifecycle-contract.mjs';
import {namespaceSubmissionValue,namespaceSubmissionBindingValue} from '../src/engine-storage/namespace-submission-contract.mjs';
import {SingularityFlowError} from '../src/foundation/failures.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createNamespaceSourceEngine} from '../src/engine-storage/namespace-source.mjs';
import {createFilesystemSourceUnit} from '../src/sgos/filesystem-source-unit.mjs';
import {createNamespaceLifecycleCommitter} from '../src/engine-storage/namespace-lifecycle-commit.mjs';
import {createNamespaceSubmissionReader} from '../src/engine-storage/namespace-submission-reader.mjs';
import {canonicalJson,NAMESPACE_SUBMISSION_SCHEMAS} from '../src/foundation/record-schema.mjs';
const input={phaseId:'intake'};
const make=(f,extra={})=>createNamespaceSubmissionEngine({records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId,
  authority:f.authority,access:f.access,clock:f.clock,...extra});
async function capture(f){return (await createNamespaceLifecycleObserver({records:f.records,content:f.content,scope:f.scope,
  workId:f.inputs.workId,authority:f.authority}).capture()).snapshot;}
async function published(f){
  await f.engine.run('phase.prepare');const draft=await f.read(f.engine);
  await f.engine.run('phase.draft.write',{operationId:'author-for-submission',workId:f.inputs.workId,phaseId:'intake',expectedRevision:draft.manifest.draft.revision,
    content:await f.upload('# An actual authored requirement\n\nThe result and its observable acceptance.'),reason:'Complete the retained document.'});
  f.control.permissions.push('phase.publish','phase.submit');
  await createNamespacePublicationEngine({records:f.records,content:f.content,localRecords:f.localRecords,localContent:f.localContent,
    scope:f.scope,workId:f.inputs.workId,authority:f.authority,access:f.access,clock:f.clock}).run('phase.publish',{...input,authored:'governed-agent',channel:'copilot-host'});
}

for(const backend of ['filesystem','sqlite','application'])test(`${backend}: submit an actual shared publication without private stores, source checkout or tests`,async t=>{
  const f=await namespacePreparationFixture(t,{backend});await published(f);const before=await capture(f),privateHead=await f.localRecords.list(f.scope,'local',{limit:100}),engine=make(f);
  const result=await engine.run('phase.submit',input),after=await capture(f),phase=after.workflow.phases.intake;
  assert.equal(result.status,'awaiting-approval');assert.equal(result.generation,1);assert.equal(result.revision,after.revision);
  assert.deepEqual(result.effects,{committed:true,pushed:false});assert.equal(phase.status,'awaiting_approval');assert.equal(after.workflow.currentPhase,'intake');
  assert.deepEqual(phase.artifacts,before.workflow.phases.intake.artifacts);assert.deepEqual(phase.checks,[]);assert.deepEqual(phase.approvals,[]);
  assert.equal(phase.namespaceSubmission.record.sha256,result.submission.reviewPacket);
  assert.equal(after.workflow.lineage.submissions[0].packetSha256,result.submission.reviewPacket);
  const packet=JSON.parse(Buffer.from((await f.content.read(f.scope,phase.namespaceSubmission.record)).data));
  assert.deepEqual(packet.publication,phase.publicationBindings[0]);assert.equal(packet.baseRevision,before.revision);
  assert.equal(packet.actor.principalId,f.control.principalId);assert.equal(packet.agentId,'analyst');
  assert.equal(Object.hasOwn(packet,'sourceCommit'),false);assert.equal(Object.hasOwn(packet,'testsPassed'),false);
  assert.deepEqual(await f.localRecords.list(f.scope,'local',{limit:100}),privateHead);
  const documents=await engine.run('phase.review',input);
  assert.equal(documents.manifest.reviewBinding.packetSha256,result.submission.reviewPacket);
  assert.equal(documents.manifest.reviewBinding.sourceRevision,before.revision);assert.equal(documents.manifest.reviewBinding.observedRevision,result.revision);
  const readOnly=createNamespaceReadEngine({records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId});
  assert.deepEqual(await readOnly.run('phase.review',input),documents,'read and mutation hosts use the same authoritative review proof');
  const read=await engine.run('document.read',{reference:{kind:'story-document',id:'REVIEW-intake-GEN-1',workId:f.inputs.workId}});
  assert.deepEqual(JSON.parse(read.document.content.text),packet);
  const replay=await make(f,{access:{current(){throw Error('Accepted submission cannot authorize another write.');}},clock:{now(){throw Error('Do not restamp the receipt.');}}}).run('phase.submit',input);
  assert.equal(replay.status,'retained');assert.equal(replay.revision,result.revision);assert.deepEqual(replay.effects,{committed:false,pushed:false});
  assert.equal((await capture(f)).workflow.history.filter(item=>item.event==='phase_submitted').length,1);
});

test('an unprepared, private-only or unauthorized phase never becomes submitted',async t=>{
  const f=await namespacePreparationFixture(t);await assert.rejects(make(f).run('phase.submit',input),{code:'PHASE_GENERATION_REQUIRED'});
  await f.engine.run('phase.prepare');await assert.rejects(make(f).run('phase.submit',input),{code:'PHASE_GENERATION_REQUIRED'});
  await published(f);f.control.permissions=f.control.permissions.filter(value=>value!=='phase.submit');const before=await f.head();
  await assert.rejects(make(f).run('phase.submit',input),{code:'ENGINE_AUTHORITY_REQUIRED'});assert.deepEqual(await f.head(),before);
});

test('a workflow cannot drop its required review and undeclared decision inputs retain the actual policy refusal',async t=>{
  await assert.rejects(namespacePreparationFixture(t,{configure:source=>{source.definition.phases.intake.approval={mode:'none'};}}),
    {code:'OBLIGATION_ROUTE_DROPS_RESPONSIBILITY'});
  const normal=await namespacePreparationFixture(t);await published(normal);
  await assert.rejects(make(normal).run('phase.submit',{...input,decisionValues:{channel:'web'}}),{code:'DECISION_INPUT_UNKNOWN'});
  assert.equal((await capture(normal)).workflow.phases.intake.status,'in_progress');
});

test('a changed authenticated author cannot accept another authors prepared submission',async t=>{
  const f=await namespacePreparationFixture(t);await published(f);const original={principalId:f.control.principalId,creator:structuredClone(f.control.creator)};let changed=false;
  const records={...f.records,async transact(scope,tx,options){const result=await f.records.transact(scope,tx,options);
    if(!changed&&tx.changes.some(change=>change.namespace==='runtime'&&change.key.startsWith('lifecycle/prepared/'))) {
      changed=true;f.control.principalId='another-author';f.control.creator={name:'Another author',email:'another@example.test'};
    }return result;}};
  await assert.rejects(make(f,{records}).run('phase.submit',input),{code:'ENGINE_ACTOR_CHANGED'});
  assert.equal((await capture(f)).workflow.phases.intake.status,'in_progress');
  Object.assign(f.control,original);
  const result=await make(f,{clock:{now(){throw Error('Resume the first authors original candidate.');}}}).run('phase.submit',input);
  assert.equal(result.status,'awaiting-approval');
});

test('a legitimate Story change after preparation preserves the old candidate and permits freshly checked submission',async t=>{
  const f=await namespacePreparationFixture(t);await published(f);const root=path.join(f.directory,'actual-application');await mkdir(root);
  await writeFile(path.join(root,'app.js'),'export const answer = 42;\n');
  const unit=await createFilesystemSourceUnit({root,id:'application-files',projectId:f.scope.projectId,repositoryId:'app'});
  const source=createNamespaceSourceEngine({records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId,authority:f.authority,
    access:f.access,clock:f.clock,sources:[unit]});let original=null;
  const records={...f.records,async transact(scope,tx,options){const result=await f.records.transact(scope,tx,options);
    const candidate=tx.changes.find(change=>change.namespace==='runtime'&&change.value?.operation==='phase.submit');
    if(!original&&candidate) {
      original={key:candidate.key,value:structuredClone(candidate.value)};
      const head=await f.head();await source.run('source.bind',{operationId:'bind-source-during-submission',workId:f.inputs.workId,
        expectedRevision:head.record.version,repositories:['app'],reason:'Bind the actual application source for later work.'});
    }return result;}};
  await assert.rejects(make(f,{records}).run('phase.submit',input),{code:'ENGINE_CONTEXT_CHANGED'});
  const changed=await capture(f);assert.equal(changed.workflow.phases.intake.status,'in_progress');assert.ok(changed.workflow.sourceBindings.current);
  const next=await make(f).run('phase.submit',input);assert.equal(next.status,'awaiting-approval');
  const phase=(await capture(f)).workflow.phases.intake,value=JSON.parse(Buffer.from((await f.content.read(f.scope,phase.namespaceSubmission.record)).data));
  assert.notEqual(value.operationId,original.value.operationId);assert.equal(value.baseRevision,changed.revision);
  assert.deepEqual((await f.records.read(f.scope,'runtime',original.key)).record.value,original.value);
  const committer=createNamespaceLifecycleCommitter({records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId,authority:f.authority});
  await assert.rejects(committer.commit(original.value.operationId),{code:'SDA_NAMESPACE_REVISION_CONFLICT'});
  assert.equal((await capture(f)).workflow.lineage.submissions.length,1);
});

test('another authorized person creates their own submission without borrowing the first authors pending candidate',async t=>{
  const f=await namespacePreparationFixture(t);await published(f);const before=await capture(f);let original=null,calls=0;
  const records={...f.records,async transact(scope,tx,options){const result=await f.records.transact(scope,tx,options);
    const candidate=tx.changes.find(change=>change.namespace==='runtime'&&change.value?.operation==='phase.submit');
    if(candidate&&!original)original={key:candidate.key,value:structuredClone(candidate.value)};return result;}};
  f.control.draftHook=(_count,request)=>{if(request.operation==='phase.submit'&&++calls===3)f.control.permissions=f.control.permissions.filter(value=>value!=='phase.submit');};
  await assert.rejects(make(f,{records}).run('phase.submit',input),{code:'ENGINE_AUTHORITY_REQUIRED'});
  assert.ok(original);f.control.draftHook=()=>{};f.control.permissions.push('phase.submit');f.control.principalId='new-submitter';
  f.control.creator={name:'New submitter',email:'new-submitter@example.test'};
  const accepted=await make(f).run('phase.submit',input),after=await capture(f),phase=after.workflow.phases.intake;
  const packet=JSON.parse(Buffer.from((await f.content.read(f.scope,phase.namespaceSubmission.record)).data));
  assert.equal(accepted.status,'awaiting-approval');assert.equal(packet.actor.principalId,'new-submitter');
  assert.notEqual(packet.operationId,original.value.operationId);assert.deepEqual(phase.generatedBy,before.workflow.phases.intake.generatedBy);
  assert.deepEqual((await f.records.read(f.scope,'runtime',original.key)).record.value,original.value);
  assert.equal(after.workflow.lineage.submissions.length,1);assert.deepEqual(phase.approvals,[]);
});

test('malformed submitted inventories report storage corruption rather than a raw property exception',async t=>{
  const f=await namespacePreparationFixture(t);await published(f);await make(f).run('phase.submit',input);
  const snapshot=await capture(f),observer=createNamespaceLifecycleObserver({records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId,authority:f.authority});
  const reader=createNamespaceSubmissionReader({observer,scope:f.scope,workId:f.inputs.workId});
  for(const mutate of [value=>{value.workflow.phases.intake.artifacts=null;},value=>{value.workflow.lineage.submissions={};},
    value=>{value.workflow.phases.intake.publicationBindings={};}]) {
    const corrupt=structuredClone(snapshot);mutate(corrupt);await assert.rejects(reader.review(corrupt,'intake'),{code:'ENGINE_STORAGE_CORRUPT'});
  }
});

test('the shared read host classifies malformed canonical metadata without swallowing storage failures',async t=>{
  const f=await namespacePreparationFixture(t);await published(f);await make(f).run('phase.submit',input);const head=await f.head();
  // Corruption injection follows real enrollment, approval, creation, publication and submission.
  const body=JSON.parse(Buffer.from((await f.content.read(f.scope,head.record.value.state)).data));body.workflow.phases.intake.artifacts=[null];
  const bad=(await f.content.put(f.scope,'state',Buffer.from(canonicalJson(body)))).reference;
  await f.records.transact(f.scope,{operationId:'inject-malformed-canonical-metadata',preconditions:[{namespace:'state',key:head.record.key,version:head.record.version}],
    changes:[{op:'put',namespace:'state',key:head.record.key,immutable:false,value:{...head.record.value,state:bad}}],events:[]});
  const reader=createNamespaceReadEngine({records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId});
  await assert.rejects(reader.run('phase.review',input),error=>error.code==='ENGINE_STORAGE_CORRUPT'&&error.cause instanceof TypeError);
});

test('phase review checks the current authority after reading the real immutable review proof',async t=>{
  const f=await namespacePreparationFixture(t);await published(f);await make(f).run('phase.submit',input);
  const state=await capture(f),reference=state.workflow.phases.intake.namespaceSubmission.record;let fenced=false;
  const content={...f.content,async read(scope,ref,options){const result=await f.content.read(scope,ref,options);
    if(!fenced&&ref.sha256===reference.sha256) {
      fenced=true;const active=await f.readAuthority();await f.records.transact(f.scope,{operationId:'fence-during-review-proof',
        preconditions:[{namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,version:active.record.version}],
        changes:[{op:'put',namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,immutable:false,value:{...active.record.value,status:'fenced'}}],events:[]});
    }return result;}};
  await assert.rejects(make(f,{content}).run('phase.review',input),{code:'ENGINE_CONTEXT_CHANGED'});
});

test('retrying a submitted phase ignores new decision values and preserves the original receipt',async t=>{
  const f=await namespacePreparationFixture(t);await published(f);const first=await make(f).run('phase.submit',input),notices=[];
  const engine=make(f,{access:{current(){throw Error('Acknowledgement must not open another submission.');}},clock:{now(){throw Error('The packet time is immutable.');}},notice:event=>notices.push(event)});
  const retained=await engine.run('phase.submit',{...input,runChecks:false,decisionValues:{channel:'mobile'}});
  assert.equal(retained.status,'retained');assert.equal(retained.revision,first.revision);assert.deepEqual(retained.submission,first.submission);
  assert.deepEqual(notices,[{code:'submission.decision-values-ignored',phase:'intake'}]);
  assert.equal((await capture(f)).workflow.lineage.submissions.length,1);
});

test('a lost final submission acknowledgement returns the original receipt on a new host',async t=>{
  const f=await namespacePreparationFixture(t);await published(f);let failed=false;
  const failure=new SingularityFlowError('The final submission acknowledgement was lost.',{code:'SDA_NAMESPACE_OUTCOME_UNKNOWN',outcomeClass:'OUTCOME_UNKNOWN'});
  const records={...f.records,async transact(scope,tx,options){const result=await f.records.transact(scope,tx,options);
    if(!failed&&tx.events.some(event=>event.eventType==='engine.operation-committed')){failed=true;throw failure;}return result;}};
  await assert.rejects(make(f,{records}).run('phase.submit',input),e=>e===failure);
  const result=await make(f).run('phase.submit',input);assert.equal(result.status,'retained');assert.equal(result.generation,1);
  assert.equal((await capture(f)).workflow.history.filter(item=>item.event==='phase_submitted').length,1);
});

test('concurrent submissions retain one real packet and the first candidate timestamp',async t=>{
  const f=await namespacePreparationFixture(t);await published(f);let tick=0;const clock={now:()=>new Date(Date.UTC(2026,10,8,2,0,++tick)).toISOString()};
  const [a,b]=await Promise.all([make(f,{clock}).run('phase.submit',input),make(f,{clock}).run('phase.submit',input)]);
  assert.equal(a.revision,b.revision);assert.equal(a.submission.reviewPacket,b.submission.reviewPacket);
  const state=(await capture(f)).workflow;assert.equal(state.lineage.submissions.length,1);assert.equal(state.history.filter(item=>item.event==='phase_submitted').length,1);
});

test('a revoked permission preserves the prepared submission and resumes without restamping it',async t=>{
  const f=await namespacePreparationFixture(t);await published(f);let calls=0;
  f.control.draftHook=(_count,request)=>{if(request.operation==='phase.submit'&&++calls===3)f.control.permissions=f.control.permissions.filter(value=>value!=='phase.submit');};
  await assert.rejects(make(f).run('phase.submit',input),{code:'ENGINE_AUTHORITY_REQUIRED'});
  assert.equal((await capture(f)).workflow.phases.intake.status,'in_progress');
  f.control.permissions.push('phase.submit');f.control.draftHook=()=>{};
  const result=await make(f,{clock:{now(){throw Error('Use the original prepared timestamp.');}}}).run('phase.submit',input);
  assert.equal(result.status,'awaiting-approval');
});

test('accepted submission acknowledgements survive fencing and cancellation after acceptance',async t=>{
  const f=await namespacePreparationFixture(t);await published(f);const controller=new AbortController();
  const records={...f.records,async transact(scope,tx,options){const result=await f.records.transact(scope,tx,options);
    if(tx.events.some(event=>event.eventType==='engine.operation-committed'))controller.abort();return result;}};
  const first=await make(f,{records}).run('phase.submit',input,{signal:controller.signal});assert.equal(first.status,'awaiting-approval');
  const active=await f.readAuthority();await f.records.transact(f.scope,{operationId:'fence-submitted-story',
    preconditions:[{namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,version:active.record.version}],
    changes:[{op:'put',namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,immutable:false,value:{...active.record.value,status:'fenced'}}],events:[]});
  const replay=await make(f,{access:{current(){throw Error('No permission needed to acknowledge acceptance.');}}}).run('phase.submit',input);
  assert.equal(replay.status,'retained');assert.equal(replay.revision,first.revision);
});

test('real shared-storage timeouts pass through unchanged and malformed packets are not review evidence',async t=>{
  const f=await namespacePreparationFixture(t);await published(f);const before=await f.head();
  const timeout=Object.assign(new Error('The actual storage request timed out.'),{code:'ETIMEDOUT',timeoutMs:300000});
  await assert.rejects(make(f,{records:{...f.records,async read(){throw timeout;}}}).run('phase.submit',input),e=>e===timeout);
  assert.deepEqual(await f.head(),before);
  await make(f).run('phase.submit',input);const phase=(await capture(f)).workflow.phases.intake;
  const packet=JSON.parse(Buffer.from((await f.content.read(f.scope,phase.namespaceSubmission.record)).data));
  const context={projectId:f.scope.projectId,workId:f.inputs.workId,phaseId:'intake'};
  assert.deepEqual(namespaceSubmissionValue(packet,context),packet);
  for(const mutate of [value=>{value.baseRevision=null;},value=>{value.actor.permissions=['phase.submit'];},value=>{value.publication.generation++;},value=>{value.configuration.key='/another/checkout';}]) {
    const changed=structuredClone(packet);mutate(changed);assert.throws(()=>namespaceSubmissionValue(changed,context),{code:'ENGINE_STORAGE_CORRUPT'});
  }
  assert.throws(()=>namespaceSubmissionValue({...packet,schemaVersion:NAMESPACE_SUBMISSION_SCHEMAS.packet.maximumReadableVersion+1},context),{code:'ENGINE_STORAGE_UNSUPPORTED'});
  assert.throws(()=>namespaceSubmissionBindingValue({...phase.namespaceSubmission,record:{...phase.namespaceSubmission.record,namespace:'local'}}),{code:'ENGINE_STORAGE_CORRUPT'});
  assert.throws(()=>namespaceSubmissionBindingValue({...phase.namespaceSubmission,record:{...phase.namespaceSubmission.record,bytes:0}}),{code:'ENGINE_STORAGE_CORRUPT'});
});
