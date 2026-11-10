import test from 'node:test';
import assert from 'node:assert/strict';
import {namespacePreparationFixture} from './helpers/namespace-preparation-fixture.mjs';
import {createNamespacePublicationEngine} from '../src/engine-storage/namespace-publication.mjs';
import {createNamespaceLifecycleObserver} from '../src/engine-storage/namespace-lifecycle-reader.mjs';
import {hasPublishedPhaseGeneration,phaseInspectionGeneration} from '../src/kernel/phase-policy.mjs';
import {LIFECYCLE_AUTHORITY_KEY} from '../src/engine-storage/namespace-lifecycle-contract.mjs';
import {SingularityFlowError} from '../src/foundation/failures.mjs';
import path from 'node:path';
import {createFilesystemNamespaceStore} from '../src/sda/filesystem-namespace-adapter.mjs';
import {createSqliteContentStore} from '../src/sda/sqlite-content-adapter.mjs';
import {openNativeSqliteDatabase} from '../src/sda/sqlite-native.mjs';
import {createNamespaceLifecycleCommitter} from '../src/engine-storage/namespace-lifecycle-commit.mjs';
import {namespacePublicationValue} from '../src/engine-storage/namespace-publication-contract.mjs';
import {PHASE_PUBLICATION_SCHEMAS} from '../src/foundation/record-schema.mjs';

const input={phaseId:'intake',authored:'governed-agent',channel:'copilot-host'};
function publisher(f,extra={}) {return createNamespacePublicationEngine({records:f.records,content:f.content,localRecords:f.localRecords,localContent:f.localContent,
  scope:f.scope,workId:f.inputs.workId,authority:f.authority,access:f.access,clock:f.clock,sources:f.unit?[f.unit]:[],...extra});}
async function capture(f) {return (await createNamespaceLifecycleObserver({records:f.records,content:f.content,scope:f.scope,
  workId:f.inputs.workId,authority:f.authority}).capture()).snapshot;}
async function authored(f,bytes='# Result\n\nA substantive, observed requirement and its acceptance criteria.') {
  await f.engine.run('phase.prepare');const draft=await f.read(f.engine);
  await f.engine.run('phase.draft.write',{operationId:'author-for-publication',workId:f.inputs.workId,phaseId:'intake',
    expectedRevision:draft.manifest.draft.revision,content:await f.upload(bytes),reason:'Complete the actual artifact before publication.'});
  f.control.permissions.push('phase.publish');return Buffer.from(bytes);
}
for(const backend of ['filesystem','sqlite','application'])test(`${backend}: publish the actual authored primary document and read its canonical retained bytes`,async t=>{
  const f=await namespacePreparationFixture(t,{backend}),bytes=await authored(f),engine=publisher(f);
  const result=await engine.run('phase.publish',{...input,workId:f.inputs.workId}),snapshot=await capture(f),phase=snapshot.workflow.phases.intake;
  assert.equal(result.status,'published');assert.equal(result.generation,1);assert.equal(result.revision,snapshot.revision);
  assert.deepEqual(result.effects,{committed:true,pushed:false});assert.equal(phase.generation,1);assert.equal(phase.status,'in_progress');
  assert.equal(hasPublishedPhaseGeneration(phase),true);assert.equal(phaseInspectionGeneration(snapshot.workflow,phase),1);
  assert.equal(phase.publicationBindings[0].record.namespace,'evidence');assert.deepEqual(phase.generationPublications,[]);
  assert.equal(snapshot.workflow.workItem.branch,null);assert.equal(snapshot.workflow.execution.status,'unbound');
  assert.deepEqual(phase.checks,[]);assert.deepEqual(phase.approvals,[]);assert.equal(phase.authorship[0].kernelModel.invoked,false);
  const review=await engine.run('phase.review',{phaseId:'intake'});assert.equal(review.manifest.generation,1);
  const item=review.manifest.items.find(item=>item.primary);assert.equal(item.integrity,'matched');
  const read=await engine.run('document.read',{reference:item.reference});assert.equal(read.document.content.text,bytes.toString());
  assert.equal((await f.read(engine)).manifest.status,'stale','a publication moves the canonical basis without overwriting the private draft');
  const again=await publisher(f).run('phase.publish',input);
  assert.equal(again.status,'retained');assert.equal(again.retentionReason,'unchanged-document');assert.equal(again.revision,result.revision);
  assert.deepEqual(again.effects,{committed:false,pushed:false});assert.equal((await capture(f)).workflow.phases.intake.generation,1);
});

test('an untouched template and an incomplete required heading never move canonical generation',async t=>{
  const f=await namespacePreparationFixture(t);await f.engine.run('phase.prepare');f.control.permissions.push('phase.publish');const before=await f.head();
  await assert.rejects(publisher(f).run('phase.publish',input),e=>e.code==='ARTIFACT_AUTHORING_INCOMPLETE'&&e.details.findings.some(f=>f.code==='artifact.template.unchanged'));
  assert.deepEqual(await f.head(),before);
  const custom=await namespacePreparationFixture(t,{configure:source=>{source.definition.phases.intake.artifact.validation={requiredHeadings:['Evidence']};}});
  await authored(custom);const original=await custom.head();
  await assert.rejects(publisher(custom).run('phase.publish',input),e=>e.code==='ARTIFACT_AUTHORING_INCOMPLETE'&&e.details.findings.some(f=>f.code==='artifact.heading.missing'));
  assert.deepEqual(await custom.head(),original);
});

test('missing publication permission refuses before a canonical publication is prepared',async t=>{
  const f=await namespacePreparationFixture(t);await authored(f);f.control.permissions=f.control.permissions.filter(value=>value!=='phase.publish');
  const before=await f.head();await assert.rejects(publisher(f).run('phase.publish',input),{code:'ENGINE_AUTHORITY_REQUIRED'});assert.deepEqual(await f.head(),before);
});

test('code and required clarification contracts never become document-only publication success',async t=>{
  const f=await namespacePreparationFixture(t,{code:true});await authored(f);const before=await f.head();
  await assert.rejects(publisher(f).run('phase.publish',input),e=>e.code==='ENGINE_PORT_UNAVAILABLE'&&e.details.required.includes('code-delivery'));
  assert.deepEqual(await f.head(),before);
  const clarifications=await namespacePreparationFixture(t,{configure:source=>{source.definition.phases.intake.clarification={mode:'required'};}});
  await authored(clarifications);const original=await clarifications.head();
  await assert.rejects(publisher(clarifications).run('phase.publish',input),e=>e.code==='CLARIFICATION_REQUIRED'&&e.details.operation==='clarification.record');
  assert.deepEqual(await clarifications.head(),original);
});

test('two concurrent publications reconcile to one original accepted generation and timestamp',async t=>{
  const f=await namespacePreparationFixture(t);await authored(f);let tick=0;const clock={now:()=>new Date(Date.UTC(2026,10,8,0,0,++tick)).toISOString()};
  const [a,b]=await Promise.all([publisher(f,{clock}).run('phase.publish',input),publisher(f,{clock}).run('phase.publish',input)]);
  assert.equal(a.revision,b.revision);const snapshot=await capture(f),phase=snapshot.workflow.phases.intake;
  assert.equal(phase.generation,1);assert.equal(phase.publicationBindings.length,1);
  assert.equal(snapshot.workflow.history.filter(item=>item.event==='phase_generated').length,1);
});

test('a lost final acceptance acknowledgement reopens the original real publication receipt',async t=>{
  const f=await namespacePreparationFixture(t);await authored(f);let once=false;
  const failure=new SingularityFlowError('Actual final publication acknowledgement lost.',{code:'SDA_NAMESPACE_OUTCOME_UNKNOWN',outcomeClass:'OUTCOME_UNKNOWN'});
  const records={...f.records,async transact(scope,transaction,options){const result=await f.records.transact(scope,transaction,options);
    if(!once&&transaction.events.some(event=>event.eventType==='engine.operation-committed')){once=true;throw failure;}return result;}};
  await assert.rejects(publisher(f,{records}).run('phase.publish',input),e=>e===failure);
  const retained=await publisher(f).run('phase.publish',input);assert.equal(retained.status,'retained');assert.equal(retained.generation,1);
  assert.equal((await capture(f)).workflow.history.filter(item=>item.event==='phase_generated').length,1);
});

test('a published receipt remains acknowledgeable after fencing without new authorization or a clock',async t=>{
  const f=await namespacePreparationFixture(t);await authored(f);const first=await publisher(f).run('phase.publish',input),active=await f.readAuthority();
  await f.records.transact(f.scope,{operationId:'fence-after-publication',preconditions:[{namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,version:active.record.version}],
    changes:[{op:'put',namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,immutable:false,value:{...active.record.value,status:'fenced'}}],events:[]});
  const access={current(){throw Error('Accepted receipt inspection cannot authorize a new operation.');}},clock={now(){throw Error('Accepted receipt cannot be restamped.');}};
  const retained=await publisher(f,{access,clock}).run('phase.publish',input);assert.equal(retained.status,'retained');assert.equal(retained.revision,first.revision);
});

test('binary authored bytes stay exact and are exposed as binary metadata after publication',async t=>{
  const f=await namespacePreparationFixture(t),data=Buffer.from([0,255,137,80,78,71,10]);await authored(f,data);const engine=publisher(f);
  await engine.run('phase.publish',{phaseId:'intake',authored:'human'});
  const snapshot=await capture(f),document=snapshot.workflow.namespaceDocuments.find(item=>item.role==='artifact');
  assert.equal(document.encoding,'binary');assert.deepEqual(Buffer.from((await f.content.read(f.scope,document.content)).data),data);
  assert.equal(snapshot.workflow.phases.intake.authorship[0].governedAgentContext,null);
});

test('a fresh device acknowledges an accepted publication without copying or recreating private drafts',async t=>{
  const f=await namespacePreparationFixture(t);await authored(f);const first=await publisher(f).run('phase.publish',input);
  const binding={kind:'machine-local',deviceId:'another-laptop'},root=path.join(f.privateDirectory,'takeover');
  const localRecords=await createFilesystemNamespaceStore({root,binding,create:true}),database=await openNativeSqliteDatabase(path.join(f.privateDirectory,'takeover-content.db'));
  t.after(()=>database.close());const localContent=createSqliteContentStore({database,binding,create:true});
  const engine=publisher(f,{localRecords,localContent,access:{current(){throw Error('Acknowledgement is not new author permission.');}},clock:{now(){throw Error('Cannot restamp the accepted publication.');}}});
  const retained=await engine.run('phase.publish',input);assert.equal(retained.status,'retained');assert.equal(retained.revision,first.revision);
  assert.deepEqual((await localRecords.list(f.scope,'local',{limit:100})).entries,[]);
  assert.equal((await f.head()).record.version,first.revision);assert.equal((await capture(f)).workflow.phases.intake.generation,1);
});

test('a fenced inspection snapshot cannot be used as a lifecycle writer basis',async t=>{
  const f=await namespacePreparationFixture(t),active=await f.readAuthority();
  await f.records.transact(f.scope,{operationId:'fence-before-inspection',preconditions:[{namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,version:active.record.version}],
    changes:[{op:'put',namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,immutable:false,value:{...active.record.value,status:'fenced'}}],events:[]});
  const observer=createNamespaceLifecycleObserver({records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId,authority:f.authority});
  const inspected=await observer.inspect();assert.equal(inspected.snapshot.workflow.phases.intake.generation,0);
  const committer=createNamespaceLifecycleCommitter({records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId,authority:f.authority});
  await assert.rejects(committer.capture(),{code:'ENGINE_AUTHORITY_FENCED'});
  await assert.rejects(committer.prepare(inspected.snapshot,{operationId:'forged-read-basis',operation:'phase.publish',inputsSha256:'a'.repeat(64),state:Buffer.from('{}'),evidence:[]}),{code:'ENGINE_INPUT_INVALID'});
});

test('revoked permission after preparation preserves the original candidate and its timestamp on resume',async t=>{
  const f=await namespacePreparationFixture(t);await authored(f);let calls=0;
  f.control.draftHook=(_count,request)=>{if(request.operation==='phase.publish'&&++calls===3)f.control.permissions=f.control.permissions.filter(value=>value!=='phase.publish');};
  await assert.rejects(publisher(f).run('phase.publish',input),{code:'ENGINE_AUTHORITY_REQUIRED'});
  assert.equal((await capture(f)).workflow.phases.intake.generation,0);
  f.control.permissions.push('phase.publish');f.control.draftHook=()=>{};
  const result=await publisher(f,{clock:{now(){throw Error('The retained candidate cannot be restamped.');}}}).run('phase.publish',input);
  assert.equal(result.status,'published');assert.equal(result.generation,1);
});

test('an edit after the durable candidate is prepared cannot be overwritten by its publication',async t=>{
  const f=await namespacePreparationFixture(t);await authored(f);let changed=false;
  const records={...f.records,async transact(scope,tx,options){const result=await f.records.transact(scope,tx,options);
    if(!changed&&tx.changes.some(change=>change.namespace==='runtime'&&change.key.startsWith('lifecycle/prepared/'))) {
      changed=true;const draft=await f.read(f.engine);
      await f.engine.run('phase.draft.write',{operationId:'edit-during-publication',workId:f.inputs.workId,phaseId:'intake',expectedRevision:draft.manifest.draft.revision,
        content:await f.upload('# A newer preserved document'),reason:'Exercise a real simultaneous author edit.'});
    }return result;}};
  await assert.rejects(publisher(f,{records}).run('phase.publish',input),{code:'ENGINE_CONTEXT_CHANGED'});
  assert.equal((await capture(f)).workflow.phases.intake.generation,0);
  assert.equal((await f.read(f.engine)).manifest.artifact.content.text,'# A newer preserved document');
});

test('required assignment and artifact-set policies cannot be dropped by a generic document publication',async t=>{
  const f=await namespacePreparationFixture(t,{configure:source=>{source.definition.collaboration={assignmentMode:'required'};}});
  await authored(f);const original=await f.head();
  await assert.rejects(publisher(f).run('phase.publish',input),e=>e.code==='ENGINE_ASSIGNMENT_REQUIRED'&&e.details.actions[0].operation==='phase.assign');
  assert.deepEqual(await f.head(),original);
  const set=await namespacePreparationFixture(t,{configure:source=>{
    source.definition.artifactSets={'intake-evidence':{primary:'plan.md',members:[
      {path:'plan.md',role:'requirements',required:true},{path:'evidence/',role:'supporting-evidence',required:true}]}};
    source.definition.phases.intake.artifactSet='intake-evidence';
  }});
  await authored(set);const before=await set.head();
  await assert.rejects(publisher(set).run('phase.publish',input),e=>e.code==='PHASE_ARTIFACT_SET_INCOMPLETE'&&e.details.missing.includes('evidence/'));
  assert.deepEqual(await set.head(),before);
});

test('publication presence uses a real retained reference while malformed and future bindings stay refusals',async t=>{
  const f=await namespacePreparationFixture(t);await authored(f);await publisher(f).run('phase.publish',input);
  const phase=(await capture(f)).workflow.phases.intake,binding=phase.publicationBindings[0];
  assert.equal(hasPublishedPhaseGeneration({...phase,generation:2}),false);
  assert.equal(hasPublishedPhaseGeneration({...phase,generationIntent:{status:'open',generation:2}}),false);
  assert.throws(()=>hasPublishedPhaseGeneration({...phase,publicationBindings:[{...binding,record:{...binding.record,namespace:'local'}}]}),{code:'PUBLICATION_BINDING_INVALID'});
  assert.throws(()=>hasPublishedPhaseGeneration({...phase,publicationBindings:[{...binding,schemaVersion:2}]}),{code:'SCHEMA_VERSION_FUTURE'});
});

test('retained manifest validation rejects invented authorship, revisions, inputs and physical configuration paths',async t=>{
  const f=await namespacePreparationFixture(t);await authored(f);await publisher(f).run('phase.publish',input);
  const binding=(await capture(f)).workflow.phases.intake.publicationBindings[0];
  const record=JSON.parse(Buffer.from((await f.content.read(f.scope,binding.record)).data));
  const context={projectId:f.scope.projectId,workId:f.inputs.workId,phaseId:'intake'};
  assert.deepEqual(namespacePublicationValue(record,context),record);
  const mutations=[
    value=>{value.baseRevision=null;},value=>{value.draft.revision=null;},value=>{value.configuration.key='/another/checkout';},
    value=>{value.actor.permissions=['phase.publish'];},value=>{value.authorship.actor.name='Another author';},
    value=>{value.authorship.kernelModel.invoked=true;},value=>{value.authorship.source={commit:'invented'};},
    value=>{value.inputs=null;},value=>{value.inputs.push(value.inputs[0]);},
    value=>{value.inputs[0].reference.namespace='local';},value=>{value.artifact.fingerprint='sha256:invalid';}
  ];
  for(const mutate of mutations){const changed=structuredClone(record);mutate(changed);assert.throws(()=>namespacePublicationValue(changed,context),{code:'ENGINE_STORAGE_CORRUPT'});}
  assert.throws(()=>namespacePublicationValue({...record,schemaVersion:PHASE_PUBLICATION_SCHEMAS.manifest.maximumReadableVersion+1},context),{code:'ENGINE_STORAGE_UNSUPPORTED'});
});

test('real private-file permission and shared-read timeout failures retain their original identity',async t=>{
  const f=await namespacePreparationFixture(t);await authored(f);const before=await f.head();
  const denied=Object.assign(new Error('The private content file cannot be read.'),{code:'EACCES',syscall:'open',path:'private-content.db'});
  await assert.rejects(publisher(f,{localContent:{...f.localContent,async read(){throw denied;}}}).run('phase.publish',input),error=>error===denied);
  const timeout=Object.assign(new Error('The namespace read exceeded its host deadline.'),{code:'ETIMEDOUT',timeoutMs:300000});
  await assert.rejects(publisher(f,{records:{...f.records,async read(){throw timeout;}}}).run('phase.publish',input),error=>error===timeout);
  assert.deepEqual(await f.head(),before);
});

test('a finish failure preserves the actual accepted receipt and the retry acknowledges that publication',async t=>{
  const f=await namespacePreparationFixture(t);await authored(f);let accepted=false,failed=false;
  const failure=Object.assign(new Error('Reading the accepted intent failed after publication.'),{code:'EACCES'});
  const records={...f.records,async transact(scope,tx,options){const result=await f.records.transact(scope,tx,options);
    if(tx.events.some(event=>event.eventType==='engine.operation-committed'))accepted=true;return result;},
  async read(scope,namespace,key,options){if(accepted&&!failed&&namespace==='runtime'&&key.startsWith('lifecycle/prepared/')){failed=true;throw failure;}
    return f.records.read(scope,namespace,key,options);}};
  await assert.rejects(publisher(f,{records}).run('phase.publish',input),error=>error===failure&&error.enginePublication.status==='committed');
  const retained=await publisher(f).run('phase.publish',input);assert.equal(retained.status,'retained');assert.equal(retained.generation,1);
  assert.equal((await capture(f)).workflow.history.filter(item=>item.event==='phase_generated').length,1);
});
