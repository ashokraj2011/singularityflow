import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {namespaceEngineFixture} from './helpers/namespace-engine-fixture.mjs';
import {namespaceReadFixture,readWorkflow} from './helpers/namespace-read-fixture.mjs';
import {configure} from './helpers/namespace-routing-fixture.mjs';
import {createFilesystemSourceUnit} from '../src/sgos/filesystem-source-unit.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {createNamespaceApprovalEngine} from '../src/engine-storage/namespace-approval.mjs';
import {createNamespacePublicationEngine} from '../src/engine-storage/namespace-publication.mjs';
import {ENGINE_CONTRACT} from '../src/engine-sdk/index.mjs';
import {namespaceStoryReadKey} from '../src/engine-storage/namespace-reader.mjs';

for(const backend of ['filesystem','sqlite','application'])test(`${backend}: one Engine enrolls, configures, creates, authors, publishes, submits and independently approves a real Story`,async t=>{
  const f=await namespaceEngineFixture(t,{backend});assert.equal(f.control.engineCalls,0);
  const {created}=await f.bootstrap();assert.equal(created.subject.id,f.workId);assert.equal(f.engine.contract,ENGINE_CONTRACT);
  const {publication}=await f.author();
  await assert.rejects(f.engine.run('phase.approve',{phaseId:'intake',confirmation:{workId:f.workId,phase:'intake',generation:1,
    reviewPacketSha256:(await f.engine.run('phase.review.resources',{phaseId:'intake'})).manifest.reviewBinding.packetSha256}}),{code:'APPROVAL_SELF_APPROVAL_PROHIBITED'});
  const approved=await f.review(),snapshot=await f.capture();
  assert.equal(approved.result.approval.selfApproval,false);assert.equal(approved.result.currentPhase,null);assert.equal(snapshot.workflow.status,'closed');
  const shared=f.make({working:null,clock:{now(){throw Error('Acknowledgement cannot sample a new clock.');}}});
  assert.deepEqual(await shared.run('phase.approve',{phaseId:'intake',confirmation:approved.confirmation}),approved.result);
  const retained=await shared.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});
  assert.equal(retained.status,'retained');assert.equal(retained.revision,publication.revision);assert.equal(retained.generation,publication.generation);
  assert.equal((await shared.run('decision.context')).manifest.question,null);
});

test('one Engine keeps authors, human route choices and successor phase approval separate',async t=>{
  const f=await namespaceEngineFixture(t,{configure:configure('ask')});await f.bootstrap();await f.author('intake');await f.review('intake');
  const context=await f.engine.run('decision.context'),input={workId:f.workId,expected:context.manifest.question.key,option:'continue',reason:'The human chooses the retained next phase.'};
  const first=await f.engine.run('decision.choose',input);assert.equal(first.currentPhase,'review');
  for(const phaseId of ['review','release']) {await f.author(phaseId);await f.review(phaseId);}
  const snapshot=await f.capture();assert.equal(snapshot.workflow.status,'closed');assert.equal(snapshot.workflow.namespaceRoutingChoiceReceipts.length,1);
  f.control.permissions=[];assert.deepEqual(await f.make({working:null}).run('decision.choose',input),first);
});

test('one Engine applies loop rework and publishes actual successor generations',async t=>{
  const f=await namespaceEngineFixture(t,{configure:configure('loop')});await f.bootstrap();
  await f.author('intake');await f.review('intake');await f.author('review',{verdict:'Repair'});const original=await f.review('review');
  assert.equal(original.result.currentPhase,'intake');
  await f.author('intake');await f.review('intake');await f.author('review',{verdict:'Pass'});await f.review('review');
  await f.author('release');await f.review('release');const snapshot=await f.capture();
  assert.equal(snapshot.workflow.status,'closed');assert.equal(snapshot.workflow.phases.intake.generation,2);
  assert.equal(snapshot.workflow.changeRequests[0].status,'resolved');
  assert.deepEqual(await f.engine.run('phase.approve',{phaseId:'review',confirmation:original.confirmation}),original.result);
});

test('a shared-only Engine cannot invent a private draft or a new publication',async t=>{
  const f=await namespaceEngineFixture(t,{working:false});await f.bootstrap();const before=await f.capture();
  await assert.rejects(f.engine.run('phase.prepare',{phaseId:'intake'}),{code:'ENGINE_PORT_UNAVAILABLE'});
  await assert.rejects(f.engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'}),error=>
    error.code==='ENGINE_PORT_UNAVAILABLE'&&error.details.required.includes('machine-local-working-store'));
  assert.deepEqual(await f.capture(),before);
});

test('capability capture is consistent across owners and never closes application-owned stores',async t=>{
  const f=await namespaceEngineFixture(t),access={...f.access},records={...f.records},content={...f.content},clock={...f.clock};
  const options={...f.options,scope:structuredClone(f.scope),access,records,content,clock},engine=createNamespaceEngine(options);
  access.current=()=>{throw Error('Replaced access owner.');};records.read=()=>{throw Error('Replaced read owner.');};
  records.transact=()=>{throw Error('Replaced write owner.');};content.put=()=>{throw Error('Replaced byte owner.');};clock.now=()=>{throw Error('Replaced clock.');};
  options.scope.projectId='mutated-after-construction';
  const result=await engine.run('project.enroll',{operationId:'captured-capabilities'});
  assert.equal(result.subject.id,'new-project');assert.equal((await f.records.read({projectId:'new-project'},'state','authority/lifecycle')).status,'present');
});

test('the combined Engine rejects foreign work inputs and a foreign read authority',async t=>{
  const f=await namespaceEngineFixture(t);const initial=await f.bootstrap();
  await assert.rejects(f.engine.run('story.create',{...initial.creationInput,operationId:'foreign-story',workId:'another-story'}),{code:'ACTIVE_SUBJECT_MISMATCH'});
  await assert.rejects(f.engine.run('phase.prepare',{workId:'another-story'}),{code:'ACTIVE_SUBJECT_MISMATCH'});
  const foreign=f.make({authority:{id:'another-authority',epoch:1}});
  await assert.rejects(foreign.run('decision.context'),{code:'ENGINE_AUTHORITY_FENCED'});
});

test('an explicit filesystem source unit is captured only when source.bind is requested',async t=>{
  const f=await namespaceEngineFixture(t),root=path.join(f.directory,'checkout');await mkdir(root);await writeFile(path.join(root,'app.mjs'),'export const answer = 42;\n');
  const unit=await createFilesystemSourceUnit({root,id:'composed-checkout',projectId:f.scope.projectId,repositoryId:'app'});let calls=0;
  const source={descriptor:unit.descriptor,capture(...args){calls++;return unit.capture(...args);}},engine=f.make({sources:[source]});
  assert.equal(calls,0);const initial=await f.bootstrap();
  const result=await engine.run('source.bind',{operationId:'bind-source',workId:f.workId,expectedRevision:initial.created.revision,
    repositories:['app'],reason:'Bind the actual selected application source.'});
  assert.equal(calls>0,true);assert.equal(result.repositories[0].id,'app');
});

test('existing host constructors return the same original approval and publication receipts',async t=>{
  const f=await namespaceEngineFixture(t);await f.bootstrap();const authored=await f.author(),approved=await f.review();
  const approval=createNamespaceApprovalEngine({...f.options,localContent:f.local.content});
  assert.deepEqual(await approval.run('phase.approve',{phaseId:'intake',confirmation:approved.confirmation}),approved.result);
  const publication=createNamespacePublicationEngine({...f.options,localRecords:f.local.records,localContent:f.local.content});
  const old=await publication.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});
  const combined=await f.engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});
  assert.deepEqual(combined,old);assert.equal(combined.revision,authored.publication.revision);
});

test('construction performs no implicit enrollment and validates capabilities without selecting installed state',async t=>{
  const f=await namespaceEngineFixture(t,{working:false});
  assert.equal((await f.records.list(f.scope,'state',{limit:100})).entries.length,0);assert.equal(f.control.engineCalls,0);
  const epochTwo=f.make({authority:{...f.authority,epoch:2}});
  await assert.rejects(epochTwo.run('project.enroll',{operationId:'not-a-new-epoch'}),{code:'ENGINE_PORT_UNAVAILABLE'});
  assert.throws(()=>f.make({root:'/implicit/workspace'}),{code:'ENGINE_INPUT_INVALID'});
  assert.throws(()=>f.make({working:{records:f.records,content:f.content}}));
  assert.equal(f.control.engineCalls,0);
  const blocked=()=>{throw Error('Construction must not perform I/O.');};
  assert.doesNotThrow(()=>f.make({records:{...f.records,read:blocked,list:blocked,transact:blocked,inspectOperation:blocked,verify:blocked},
    content:{...f.content,read:blocked,put:blocked},access:{current:blocked},clock:{now:blocked}}));
});

test('a projection remains readable through its read-only host but cannot substitute for the bound Engine authority',async t=>{
  const f=await namespaceReadFixture(t),document=await f.document();await f.seed(readWorkflow(f.workId,document),[document]);
  const before=await f.records.read(f.scope,'state',namespaceStoryReadKey(f.workId));
  const engine=createNamespaceEngine({records:f.records,content:f.content,scope:f.scope,workId:f.workId,authority:{id:'application-authority',epoch:1},
    access:{current(){throw Error('Read-only context must not grant an operation.');}},clock:{now(){throw Error('A query cannot sample a clock.');}}});
  await assert.rejects(engine.run('phase.review',{phaseId:document.phase}),error=>error.code==='ENGINE_PORT_UNAVAILABLE'
    &&error.details.required.includes('canonical-lifecycle-locator'));
  const original=await f.engine.run('phase.review',{phaseId:document.phase});assert.equal(original.manifest.integrity,'matched');
  assert.equal(original.manifest.reviewBinding,null);assert.deepEqual(await f.records.read(f.scope,'state',namespaceStoryReadKey(f.workId)),before);
});

test('shared-only publication recovery preserves an actual immutable-content read failure',async t=>{
  const f=await namespaceEngineFixture(t);await f.bootstrap();await f.author();
  const snapshot=await f.capture(),reference=snapshot.workflow.phases.intake.publicationBindings[0].record;
  const original=Object.assign(new Error('The retained publication could not be read.'),{code:'EACCES',path:'application-object'});
  const content={...f.content,read(scope,ref,options){if(ref.sha256===reference.sha256)throw original;return f.content.read(scope,ref,options);}};
  const shared=f.make({working:null,content});
  await assert.rejects(shared.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'}),error=>error===original);
  assert.deepEqual(await f.capture(),snapshot);
});
