import test from 'node:test';
import assert from 'node:assert/strict';
import {createEngine} from '../src/engine-sdk/index.mjs';
import {createNamespaceReadEngine} from '../src/engine-storage/namespace-reader.mjs';
import {namespaceApprovalFixture} from './helpers/namespace-approval-fixture.mjs';
const configure=source=>{source.definition.workTypes.simple.decisions=[{id:'channel',label:'Channel',after:'intake',kind:'branch',
  inputs:[{name:'channel',values:['Web','Mobile']}],routes:[
    {id:'web',label:'Web',when:{channel:'Web'},to:'end',omits:structuredClone(source.definition.workTypes.simple.omits)},
    {id:'other',label:'Other',to:'end',omits:structuredClone(source.definition.workTypes.simple.omits)}]}];};
const read=(f,content=f.content)=>createNamespaceReadEngine({records:f.records,content,scope:f.scope,workId:f.inputs.workId});

for(const backend of ['filesystem','sqlite','application'])test(`${backend}: issued review resources read the exact routed packet and authored artifact`,async t=>{
  const f=await namespaceApprovalFixture(t,{backend,configure});await f.submit('intake',{channel:'Web'});
  const engine=read(f),before=await engine.run('phase.review',{phaseId:'intake'}),head=await f.head();
  const result=await engine.run('phase.review.resources',{phaseId:'intake'}),manifest=result.manifest;
  assert.equal(result.operation,'phase.review.resources');assert.equal(manifest.contract,'sflow-phase-review-resources/v1');
  assert.deepEqual(manifest.reviewBinding,before.manifest.reviewBinding);assert.equal(manifest.resources.length,2);
  assert.equal(manifest.resources[0].kind,'review-packet');
  for(const item of manifest.resources) {
    const document=await engine.run('document.read',{reference:item.reference});
    assert.deepEqual(document.document.expected,item.expected);assert.equal(document.document.integrity,'matched');
    if(item.kind==='review-packet')assert.deepEqual(JSON.parse(document.document.content.text).routing.record.values,{channel:'Web'});
    else assert.match(document.document.content.text,/# Actual intake result/u);
  }
  assert.deepEqual(result.effects,{committed:false,pushed:false,humanReviewRecorded:false,approvalRecorded:false});
  assert.deepEqual(await f.head(),head);assert.deepEqual(await engine.run('phase.review',{phaseId:'intake'}),before);
  await assert.rejects(engine.run('phase.review.resources',{workId:'another-story',phaseId:'intake'}),{code:'ACTIVE_SUBJECT_MISMATCH'});
});

test('unprepared resources point to preparation and ordinary v1 packets remain readable after real approval',async t=>{
  const f=await namespaceApprovalFixture(t),engine=read(f);
  await assert.rejects(engine.run('phase.review.resources',{phaseId:'intake'}),error=>error.code==='PHASE_GENERATION_REQUIRED'
    &&error.details.actions[0].operation==='phase.prepare');
  await f.submit();const first=await engine.run('phase.review.resources',{phaseId:'intake'});
  assert.equal(JSON.parse((await engine.run('document.read',{reference:first.manifest.resources[0].reference})).document.content.text).schemaVersion,1);
  await f.makeApproval().run('phase.approve',{phaseId:'intake',confirmation:await f.confirmation()});
  const later=await engine.run('phase.review.resources',{phaseId:'intake'});
  assert.equal(later.manifest.reviewBinding,null);assert.deepEqual(later.manifest.resources,first.manifest.resources);
  await assert.rejects(engine.run('phase.review.resources'),{code:'ENGINE_PHASE_SELECTION_REQUIRED'});
});

test('retained resource queries preserve actual packet I/O failures and do not stage another review',async t=>{
  const f=await namespaceApprovalFixture(t,{configure});await f.submit('intake',{channel:'Web'});
  const snapshot=await f.capture(),packet=snapshot.workflow.phases.intake.namespaceSubmission.record,head=await f.head();
  const original=Object.assign(new Error('The retained packet read exceeded its actual deadline.'),{code:'SDA_CONTENT_DEADLINE_EXCEEDED',details:{deadlineMs:4321}});
  const engine=read(f,{...f.content,async read(...args){if(args[1].sha256===packet.sha256)throw original;return f.content.read(...args);}});
  await assert.rejects(engine.run('phase.review.resources',{phaseId:'intake'}),error=>error===original);
  assert.deepEqual(await f.head(),head);
});

test('a moved authority cannot acquire exact resource guidance from an earlier read snapshot',async t=>{
  const f=await namespaceApprovalFixture(t,{configure});await f.submit('intake',{channel:'Web'});
  const snapshot=await f.capture(),packet=snapshot.workflow.phases.intake.namespaceSubmission.record,head=await f.head();
  let fenced=false;
  const engine=read(f,{...f.content,async read(...args){
    if(!fenced&&args[1].sha256===packet.sha256) {
      fenced=true;const authority=await f.records.read(f.scope,'state','authority/lifecycle');
      await f.records.transact(f.scope,{operationId:'fence-review-resources',preconditions:[{namespace:'state',key:authority.record.key,version:authority.record.version}],
        changes:[{op:'put',namespace:'state',key:authority.record.key,immutable:false,value:{...authority.record.value,status:'fenced'}}],events:[]});
    }
    return f.content.read(...args);
  }});
  await assert.rejects(engine.run('phase.review.resources',{phaseId:'intake'}),{code:'ENGINE_CONTEXT_CHANGED'});
  assert.equal(fenced,true);assert.deepEqual(await f.head(),head);
});

test('the registered resources query rejects fake references, crossed bindings and non-JSON facts',async()=>{
  const workflow={workItem:{id:'example'},currentPhase:'intake',phases:{intake:{id:'intake',generation:1,status:'awaiting_approval',artifacts:[],agentBriefs:[]}}};
  const facts={workId:'example',phase:'intake',generation:1,revision:'rev-1',submission:{packetSha256:'a'.repeat(64),sourceRevision:'rev-0'},
    resources:[{id:'issued-review',reference:{kind:'story-document',id:'issued-review',workId:'example'},phase:'intake',generation:1,
      kind:'review-packet',mimeType:'application/json',expected:{sha256:'a'.repeat(64),bytes:10}}],reviewBinding:null};
  const make=value=>createEngine({ports:{phaseReviewResources:{load:async()=>({subject:{kind:'story',id:'example'},workflow}),read:async()=>value}}});
  assert.equal((await make(facts).run('phase.review.resources')).manifest.resources[0].reference.id,'issued-review');
  const empty=structuredClone(facts);
  empty.resources.push({id:'empty-artifact',reference:{kind:'phase-document',id:'issued-empty',workId:'example',phase:'intake',generation:1},
    phase:'intake',generation:1,kind:'custom-report',mimeType:'text/markdown',expected:{sha256:'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',bytes:0}});
  assert.equal((await make(empty).run('phase.review.resources')).manifest.resources[1].expected.bytes,0);
  const decorated=createEngine({ports:{phaseReviewResources:{load:async()=>({subject:{kind:'story',id:'example',hostPrivate:'not-part-of-the-result'},workflow}),read:async()=>facts}}});
  assert.deepEqual((await decorated.run('phase.review.resources')).subject,{kind:'story',id:'example'});
  for(const change of [value=>{value.resources[0].reference={kind:'file',path:'/invented/file.json'};},
    value=>{value.resources[0].reference.workId='other';},value=>{value.resources[0].expected.sha256='b'.repeat(64);},value=>{value.resources[0].expected.bytes=0;},
    value=>{value.resources.push(structuredClone(value.resources[0]));},value=>{value.reviewBinding={};},
    value=>{value.resources[0].reference.toJSON=()=>({kind:'story-document',id:'issued-review',workId:'example'});}]) {
    const changed=structuredClone(facts);change(changed);
    await assert.rejects(make(changed).run('phase.review.resources'),{code:'ENGINE_PORT_RESULT_INVALID'});
  }
  await assert.rejects(createEngine({ports:{phaseReview:{load:async()=>null,read:async()=>null}}}).run('phase.review.resources'),{code:'ENGINE_PORT_UNAVAILABLE'});
});
